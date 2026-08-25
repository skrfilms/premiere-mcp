/**
 * End-to-end tests over a real socket.
 *
 * The gate is covered by http-transport.test.ts with synthetic Requests; this suite exists
 * because the node:http <-> web Request/Response adapter in http-server.ts is hand-written
 * (the SDK's own `toNodeHandler` lives in `@modelcontextprotocol/node`, which this package
 * does not depend on) and a hand-written adapter is exactly the thing that should not be
 * trusted without a real socket in front of it.
 *
 * Premiere is never touched: the surface is injected, its bridge stub throws if anything
 * reaches for it, and the bridge probe is stubbed.
 */

import { PremiereProTools } from '../../tools/index.js';
import { PremiereProResources } from '../../resources/index.js';
import { PremiereProPrompts } from '../../prompts/index.js';
import type { PremiereMcpSurface } from '../../server-factory.js';
import { startHttpTransport, type BridgeProbe, type HttpTransportHandle } from '../../http-server.js';

const TOKEN = 'listener-token-abcdefghijkl';

function makeSurface(): PremiereMcpSurface {
  const bridge = {
    executeScript: () => {
      throw new Error('This test must not reach Premiere.');
    },
  } as never;
  return {
    tools: new PremiereProTools(bridge),
    resources: new PremiereProResources(bridge),
    prompts: new PremiereProPrompts(),
  };
}

const connected: BridgeProbe = async () => ({ state: 'connected', checked: true, reason: 'stubbed', heartbeatAgeMs: 80 });
const down: BridgeProbe = async () => ({ state: 'no-heartbeat', checked: true, reason: 'panel closed; click Start Bridge.' });

async function start(argv: string[], probe: BridgeProbe): Promise<HttpTransportHandle> {
  return startHttpTransport({
    argv: ['--port', '0', ...argv],
    env: { PREMIERE_MCP_HTTP_TOKEN: TOKEN, PREMIERE_MCP_PROFILE: 'all' },
    surface: makeSurface(),
    bridgeProbe: probe,
  });
}

describe('HTTP listener over a real socket', () => {
  let handle: HttpTransportHandle;
  let base: string;

  afterEach(async () => {
    if (handle) await handle.close();
  });

  async function boot(argv: string[] = [], probe: BridgeProbe = connected): Promise<void> {
    handle = await start(argv, probe);
    base = `http://127.0.0.1:${handle.address.port}`;
  }

  it('binds loopback and reports the port it actually got', async () => {
    await boot();
    expect(handle.config.host).toBe('127.0.0.1');
    expect(handle.address.port).toBeGreaterThan(0);

    const response = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.bind).toBe(`127.0.0.1:${handle.address.port}`);
    expect(report.premiereReachable).toBeNull();
    expect(report.bridge.state).toBe('connected');
  });

  it('refuses an unauthenticated request on the wire', async () => {
    await boot();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/Bearer/);
  });

  it('answers 413 for an oversized body arriving over the socket', async () => {
    await boot(['--max-body-bytes', '256']);
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(2000) } }),
    });
    expect(response.status).toBe(413);
    expect((await response.json()).error.message).toMatch(/cap is 256/);
  });

  it('answers 429 past the arrival-rate cap', async () => {
    await boot(['--max-per-minute', '1']);
    const request = (): Promise<Response> =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

    const first = await request();
    expect(first.status).toBeLessThan(400);
    await first.text();
    const second = await request();
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('answers 503 with the bridge reason when a tool call needs Premiere and the bridge is down', async () => {
    await boot([], down);
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find_tool', arguments: { query: 'marker' } },
      }),
    });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/Start Bridge/);
    expect(body.error.data.bridge.state).toBe('no-heartbeat');
  });

  it('serves a real tool call over the wire in the MCP result shape', async () => {
    await boot();
    const call = async (message: unknown): Promise<Response> =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(message),
      });

    const init = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    expect(init.status).toBe(200);
    await init.text();

    const response = await call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'find_tool', arguments: { query: 'marker', limit: 2 } },
    });
    expect(response.status).toBe(200);

    const raw = await response.text();
    const payload = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? JSON.parse(
          raw
            .split(/\r?\n/)
            .find((line) => line.startsWith('data:'))!
            .slice(5)
            .trim(),
        )
      : JSON.parse(raw);

    expect(payload.result.content[0].type).toBe('text');
    expect(JSON.parse(payload.result.content[0].text).matches.length).toBeGreaterThan(0);
  }, 30000);

  it('404s an unknown path', async () => {
    await boot();
    const response = await fetch(`${base}/wat`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(404);
  });
});
