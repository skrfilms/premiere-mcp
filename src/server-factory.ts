/**
 * One MCP surface, many transports.
 *
 * The request handlers below were the stdio entry point's private `buildServer()`. They
 * live here now because a second transport (HTTP, see http-server.ts) has to serve the
 * SAME catalogue, and the only way two transports can be trusted not to drift is for
 * there to be one definition of the surface rather than two copies that happen to agree
 * on the day they were written.
 *
 * Nothing about tool behaviour is decided here. `PremiereProTools`, `PremiereProResources`
 * and `PremiereProPrompts` are passed in and used exactly as the stdio server uses them,
 * so a tool called over HTTP runs the same code, against the same bridge, and returns the
 * same result shape as the same tool called over stdio.
 *
 * NOTE for whoever owns src/index.ts: index.ts still carries its own copy of this wiring.
 * Until it calls `buildPremiereMcpServer` the two copies CAN drift, and this comment is
 * the only thing warning you about it. See docs/HTTP-TRANSPORT.md ("Change needed in
 * src/index.ts").
 */

import {
  Server,
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { z, type ZodTypeAny } from 'zod';
import type { PremiereProTools } from './tools/index.js';
import { annotationsFor } from './tools/annotations.js';
import { cursorFromParams, paginate, resolvePageSize } from './tools/router.js';
import { attachImageForResult } from './tools/image-content.js';
import type { PremiereProResources } from './resources/index.js';
import type { PremiereProPrompts } from './prompts/index.js';
import { Logger } from './utils/logger.js';

type ObjectJsonSchema = Record<string, unknown> & { type: 'object' };

/** The three catalogue objects a transport needs. Shared instances, never copies. */
export interface PremiereMcpSurface {
  tools: PremiereProTools;
  resources: PremiereProResources;
  prompts: PremiereProPrompts;
}

export interface BuildServerOptions {
  /** Reported in `initialize`. Defaults to the values the stdio server has always sent. */
  name?: string;
  version?: string;
  logger?: Logger;
  /**
   * Wire `activate_tools` -> `notifications/tools/list_changed`.
   *
   * TRUE for a long-lived connection (stdio): the client holds one session and must be
   * told when the advertised list changes under it.
   *
   * FALSE for a per-request instance (createMcpHandler builds one Server per HTTP
   * request): there is no stream to push a notification onto after the response is sent,
   * and `PremiereProTools.onExposureChanged` has no unsubscribe — so registering per
   * request would grow an unbounded listener array for notifications nobody receives.
   * The activation itself still takes effect, because the tools instance is shared; an
   * HTTP client must re-list to see it. Stated plainly in docs/HTTP-TRANSPORT.md.
   */
  wireExposureNotifications?: boolean;
}

function inputSchemaToJsonSchema(inputSchema: ZodTypeAny): ObjectJsonSchema {
  const jsonSchema = z.toJSONSchema(inputSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
  if (jsonSchema.type !== 'object') {
    return { type: 'object', additionalProperties: true };
  }
  return jsonSchema as ObjectJsonSchema;
}

/**
 * Methods that cannot be answered without reaching Premiere.
 *
 * The HTTP transport uses this to refuse with a 503 up front when the bridge is not
 * observably up, instead of accepting the request and letting it queue behind a wedged
 * Premiere. Kept next to the handlers so it stays in step with what they actually do:
 * `tools/call` runs ExtendScript, and most resources read live project state.
 */
export const BRIDGE_BACKED_METHODS: ReadonlySet<string> = new Set(['tools/call', 'resources/read']);

/**
 * Build a fully wired MCP `Server` over the shared catalogue.
 *
 * Call once per connection (stdio) or once per request (HTTP) — the handlers hold no
 * per-instance state of their own; all state lives on the passed-in surface objects.
 */
export function buildPremiereMcpServer(
  surface: PremiereMcpSurface,
  options: BuildServerOptions = {},
): Server {
  const logger = options.logger ?? new Logger('PremiereMcpServer');
  const { tools, resources, prompts } = surface;

  const server = new Server(
    {
      name: options.name ?? 'adobe-premiere-pro-mcp',
      version: options.version ?? '1.2.0',
      description: 'Model Context Protocol tools for Adobe Premiere Pro - AI-powered video editing',
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: {},
        prompts: {},
      },
      // Served on `initialize`, so every client receives the operating manual before its
      // first tool call — including the honest list of what Premiere's scripting API
      // cannot do, and the bridge setup steps.
      instructions: resources.getInstructionsText(),
    },
  );

  server.setRequestHandler('tools/list', async (request) => {
    const listed = tools.getAvailableTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: inputSchemaToJsonSchema(tool.inputSchema as ZodTypeAny),
      annotations: annotationsFor(tool.name),
    }));

    const pageSize = resolvePageSize();
    const paged = paginate(listed, cursorFromParams(request.params), pageSize);
    if (paged.invalidCursor) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Invalid tools/list cursor. Cursors are opaque and only valid for this server; omit it to start from the first page.',
      );
    }
    return paged.nextCursor !== undefined
      ? { tools: paged.page, nextCursor: paged.nextCursor }
      : { tools: paged.page };
  });

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await tools.executeTool(name, args || {});

      const image = attachImageForResult(result);
      const enriched = image.reason
        ? { ...(result as Record<string, unknown>), inlineImage: { attached: false, reason: image.reason } }
        : image.attachment
          ? {
              ...(result as Record<string, unknown>),
              inlineImage: {
                attached: true,
                sourcePath: image.attachment.sourcePath,
                bytes: image.attachment.bytes,
                mimeType: image.attachment.block.mimeType,
              },
            }
          : (result as Record<string, unknown>);

      const content: CallToolResult['content'] = [
        {
          type: 'text' as const,
          text: JSON.stringify(enriched, null, 2),
        },
      ];
      if (image.attachment) content.push(image.attachment.block);

      const toolResult: CallToolResult = {
        content,
        structuredContent: enriched,
        isError: result.success === false,
      };
      return server.projectCallToolResult(toolResult, undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Tool execution failed: ${errorMessage}`);

      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Failed to execute tool '${name}': ${errorMessage}`,
      );
    }
  });

  server.setRequestHandler('resources/list', async () => {
    return { resources: resources.getAvailableResources() };
  });

  server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;

    try {
      const resource = resources.getResource(uri);
      if (!resource) {
        throw new Error(`Resource '${uri}' not found`);
      }
      const content = await resources.readResource(uri);
      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      return {
        contents: [{ uri, mimeType: resource.mimeType, text }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Resource read failed: ${errorMessage}`);

      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Failed to read resource '${uri}': ${errorMessage}`,
      );
    }
  });

  server.setRequestHandler('prompts/list', async () => {
    return { prompts: prompts.getAvailablePrompts() };
  });

  server.setRequestHandler('prompts/get', async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const prompt = await prompts.getPrompt(name, args || {});
      return { description: prompt.description, messages: prompt.messages };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Prompt generation failed: ${errorMessage}`);

      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Failed to generate prompt '${name}': ${errorMessage}`,
      );
    }
  });

  server.onerror = (error) => {
    logger.error('Server error:', error);
  };

  if (options.wireExposureNotifications) {
    tools.onExposureChanged(() => {
      void server.notification({ method: 'notifications/tools/list_changed' }).catch((error: unknown) => {
        logger.error('Failed to send tools/list_changed:', error);
      });
    });
  }

  return server;
}
