#!/usr/bin/env node

import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { Server } from '@modelcontextprotocol/server';
import { PremiereProTools } from './tools/index.js';
import { startupAdvisory } from './tools/catalogue-cost.js';
import { buildPremiereMcpServer } from './server-factory.js';
import { PremiereProResources } from './resources/index.js';
import { PremiereProPrompts } from './prompts/index.js';
import { PremiereProBridge } from './bridge/index.js';
import { Logger } from './utils/logger.js';

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

  /**
   * Both transports build their server from ONE definition.
   *
   * The handler bodies used to live here and were copied into the HTTP transport, which
   * meant two catalogues that would silently drift — a tool visible over stdio and absent
   * over HTTP, or pagination fixed in one place only. `server-factory.ts` holds the single
   * copy; this method exists to pass in the shared surface and ask for the stdio-only
   * notification wiring. It is a move, not a rewrite.
   */
  private buildServer(): Server {
    return buildPremiereMcpServer(
      { tools: this.tools, resources: this.resources, prompts: this.prompts },
      {
        logger: this.logger,
        // stdio is one long-lived connection, so a listener per server is correct here.
        // HTTP builds one server per request and deliberately does NOT wire this: there is
        // no unsubscribe on onExposureChanged, so per-request listeners would leak.
        wireExposureNotifications: true,
      },
    );
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
