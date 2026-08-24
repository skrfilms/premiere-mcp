#!/usr/bin/env node

import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { Server, ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import { z, type ZodTypeAny } from 'zod';
import { PremiereProTools } from './tools/index.js';
import { annotationsFor } from './tools/annotations.js';
import { startupAdvisory } from './tools/catalogue-cost.js';
import { PremiereProResources } from './resources/index.js';
import { PremiereProPrompts } from './prompts/index.js';
import { PremiereProBridge } from './bridge/index.js';
import { Logger } from './utils/logger.js';

type ObjectJsonSchema = Record<string, unknown> & { type: 'object' };

class MCPPremiereProServer {
  private stdioHandle?: StdioServerHandle;
  private tools: PremiereProTools;
  private resources: PremiereProResources;
  private prompts: PremiereProPrompts;
  private bridge: PremiereProBridge;
  private logger: Logger;

  constructor() {
    this.logger = new Logger('MCPPremiereProServer');

    this.bridge = new PremiereProBridge();
    this.tools = new PremiereProTools(this.bridge);
    this.resources = new PremiereProResources(this.bridge);
    this.prompts = new PremiereProPrompts();
  }

  private buildServer(): Server {
    const server = new Server(
      {
        name: 'adobe-premiere-pro-mcp',
        version: '1.2.0',
        description: 'Model Context Protocol tools for Adobe Premiere Pro - AI-powered video editing'
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        // Served on `initialize`, so every client receives the operating manual before
        // its first tool call. The same text remains available as the
        // premiere://config/get_instructions resource, but a resource is opt-in and
        // most callers never attach it — which meant the verification contract, the
        // honest list of what Premiere's scripting API cannot do, and the bridge setup
        // steps were reaching almost nobody.
        instructions: this.resources.getInstructionsText()
      }
    );

    this.setupHandlers(server);
    return server;
  }

  private inputSchemaToJsonSchema(inputSchema: ZodTypeAny): ObjectJsonSchema {
    const jsonSchema = z.toJSONSchema(inputSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
    if (jsonSchema.type !== 'object') {
      return { type: 'object', additionalProperties: true };
    }
    return jsonSchema as ObjectJsonSchema;
  }

  private setupHandlers(server: Server): void {
    // List available tools
    server.setRequestHandler('tools/list', async () => {
      // Behavioural hints per the MCP spec. Clients use these to decide what to
      // auto-approve versus confirm with a human; emitting none (as this server used
      // to) makes get_project_info look exactly as risky as delete_sequence. They are
      // hints describing EXPECTED behaviour, never an authorization boundary —
      // enforcement stays in the handlers and in the tool profile.
      const tools = this.tools.getAvailableTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: this.inputSchemaToJsonSchema(tool.inputSchema as ZodTypeAny),
        annotations: annotationsFor(tool.name)
      }));
      return { tools };
    });

    // Execute tool calls
    server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
        const result = await this.tools.executeTool(name, args || {});
        const toolResult: CallToolResult = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result as Record<string, unknown>,
          isError: result.success === false
        };
        return server.projectCallToolResult(toolResult, undefined);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Tool execution failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to execute tool '${name}': ${errorMessage}`
        );
      }
    });

    // List available resources
    server.setRequestHandler('resources/list', async () => {
      return {
        resources: this.resources.getAvailableResources()
      };
    });

    // Read resource content
    server.setRequestHandler('resources/read', async (request) => {
      const { uri } = request.params;
      
      try {
        const resource = this.resources.getResource(uri);
        if (!resource) {
          throw new Error(`Resource '${uri}' not found`);
        }
        const content = await this.resources.readResource(uri);
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        return {
          contents: [
            {
              uri,
              mimeType: resource.mimeType,
              text
            }
          ]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Resource read failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to read resource '${uri}': ${errorMessage}`
        );
      }
    });

    // List available prompts
    server.setRequestHandler('prompts/list', async () => {
      return {
        prompts: this.prompts.getAvailablePrompts()
      };
    });

    // Get prompt content
    server.setRequestHandler('prompts/get', async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
        const prompt = await this.prompts.getPrompt(name, args || {});
        return {
          description: prompt.description,
          messages: prompt.messages
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Prompt generation failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to generate prompt '${name}': ${errorMessage}`
        );
      }
    });

    // Error handling
    server.onerror = (error) => {
      this.logger.error('Server error:', error);
    };
  }

  async start(): Promise<void> {
    try {
      await this.bridge.initialize();
      this.logger.info('Adobe Premiere Pro bridge initialized');
      
      this.stdioHandle = serveStdio(() => this.buildServer(), {
        onerror: (error) => {
          this.logger.error('Stdio transport error:', error);
        }
      });
      
      this.logger.info('MCP Adobe Premiere Pro Server started successfully');

      // Tell the operator what the active profile actually costs. A catalogue this
      // large degrades tool selection on clients that load every definition up front,
      // and Copilot refuses outright past 128 tools. Silence here would be the same
      // failure as reporting an unverified edit as done. stderr, so it reaches a human
      // without touching the protocol stream.
      try {
        const advisory = startupAdvisory(this.tools.measureCatalogueCost());
        if (advisory) process.stderr.write(`${advisory}\n`);
      } catch {
        // An advisory must never be the reason a server fails to start.
      }
    } catch (error) {
      this.logger.error('Failed to start server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.stdioHandle?.close();
      await this.bridge.cleanup();
      this.logger.info('MCP Adobe Premiere Pro Server stopped');
    } catch (error) {
      this.logger.error('Error stopping server:', error);
      throw error;
    }
  }
}

// Start the server
const server = new MCPPremiereProServer();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.error('\nShutting down MCP Adobe Premiere Pro Server...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\nShutting down MCP Adobe Premiere Pro Server...');
  await server.stop();
  process.exit(0);
});

// Start the server
server.start().catch((error) => {
  console.error('Failed to start MCP Adobe Premiere Pro Server:', error);
  process.exit(1);
}); 
