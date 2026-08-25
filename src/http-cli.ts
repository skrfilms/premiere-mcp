#!/usr/bin/env node
/**
 * Entry point for the remote HTTP transport.
 *
 * Separate from http-server.ts so that importing the transport (in tests, or from another
 * entry point) never starts a listener as a side effect. Everything with a side effect
 * lives below, and nothing here decides policy — see http-server.ts for that.
 *
 * Nothing is written to stdout: the stdio server's JSON-RPC framing owns stdout, and both
 * transports may be running against the same Premiere.
 */

import { startHttpTransport, httpDoctor, DEFAULT_HTTP_PORT, HTTP_MCP_PATH, HTTP_HEALTH_PATH } from './http-server.js';

function printHelp(): void {
  process.stderr.write(`Premiere MCP — HTTP transport

Serves the same tool catalogue as the stdio server over HTTP, so an agent on another
machine (or a browser-based client) can drive the Premiere running on this one.

Usage:
  premiere-mcp-http [options]
  premiere-mcp-http --doctor          Report server/bridge/profile/catalogue state and exit

Options:
  --host <addr>            Bind address (default 127.0.0.1). Anything other than loopback
                           makes this reachable from the network and is logged as such.
  --port <n>               Bind port (default ${DEFAULT_HTTP_PORT}).
  --allow-no-auth          Serve with NO authentication. Explicit flag only; there is no
                           env var for it and no silent fallback.
  --allow-host <names>     Extra hostnames accepted in the Host header (comma separated).
  --allow-origin <names>   Extra hostnames accepted in the Origin header (comma separated).
  --max-body-bytes <n>     Request body cap; over it answers 413.
  --max-concurrent <n>     In-flight request cap; over it answers 429.
  --max-per-minute <n>     Arrival-rate cap; over it answers 429.
  --allow-bridge-down      Do NOT refuse tool calls when the bridge is unobservable.
                           Off by default: a request accepted while Premiere is unreachable
                           just waits for a timeout instead of being told why.
  --help                   This text.

Environment:
  PREMIERE_MCP_HTTP_TOKEN          The bearer token. When unset, one is generated and
                                   printed to stderr at startup.
  PREMIERE_MCP_HTTP_HOST/PORT      As --host / --port.
  PREMIERE_MCP_HTTP_MAX_BODY_BYTES, _MAX_CONCURRENT, _MAX_PER_MINUTE
  PREMIERE_MCP_HTTP_ALLOWED_HOSTS, _ALLOWED_ORIGINS
  PREMIERE_TEMP_DIR                The CEP panel's Temp Directory. Required for bridge
                                   state to be observable at all — without it ${HTTP_HEALTH_PATH}
                                   reports the bridge as 'unobservable' rather than guessing.
  PREMIERE_MCP_PROFILE             Same tool profile as the stdio server.

Endpoints:
  POST ${HTTP_MCP_PATH}     MCP (2026-07-28, with stateless 2025-era fallback)
  GET  ${HTTP_HEALTH_PATH}  Health report (bearer token required)

What this protects against: off-machine reachability (loopback default), unauthenticated
callers (bearer token), DNS rebinding and browser cross-origin requests (Host/Origin
allowlists), oversized bodies, floods, and pile-ups behind a busy Premiere.

What it does not: a caller holding the token can run arbitrary ExtendScript in whatever
project is open in Premiere. Traffic is plain HTTP — put TLS in front of it if it leaves
the machine.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  if (argv.includes('--doctor')) {
    const { report, warnings, errors } = await httpDoctor({ argv });
    for (const warning of warnings) process.stderr.write(`[premiere-mcp-http] WARNING: ${warning}\n`);
    for (const error of errors) process.stderr.write(`[premiere-mcp-http] ERROR: ${error}\n`);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    // A doctor run that could not observe the bridge is not a healthy result, and saying
    // so in the exit code is the difference between a check and a decoration.
    process.exitCode = errors.length > 0 || report.bridge.state !== 'connected' ? 1 : 0;
    return;
  }

  const handle = await startHttpTransport({ argv });

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n[premiere-mcp-http] ${signal} — shutting down\n`);
    await handle.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`[premiere-mcp-http] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
