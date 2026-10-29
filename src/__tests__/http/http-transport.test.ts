/**
 * Tests for the remote HTTP transport.
 *
 * Premiere is never touched: the tool used throughout is `find_tool`, which the catalogue
 * documents as making no host request, and the bridge handed to PremiereProTools is a stub
 * whose executeScript throws if anything reaches for it. The one cross-transport test
 * drives a REAL stdio server over in-memory pipes, so "same result over HTTP as over
 * stdio" is measured rather than asserted.
 */

import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { PremiereProTools } from '../../tools/index.js';
import { PremiereProResources } from '../../resources/index.js';
import { PremiereProPrompts } from '../../prompts/index.js';
import { buildPremiereMcpServer, type PremiereMcpSurface } from '../../server-factory.js';
import {
  resolveHttpConfig,
  createHttpGate,
  heartbeatBridgeProbe,
  staticTokenVerifier,
  RequestLimiter,
  jsonRpcMethods,
  HTTP_MCP_PATH,
  HTTP_HEALTH_PATH,
  type BridgeProbe,
  type BridgeStatus,
  type HttpTransportConfig,
} from '../../http-server.js';

const TOKEN = 'test-token-abcdefghijklmnop';
const AUTH = { authorization: `Bearer ${TOKEN}` };

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

const connectedProbe: BridgeProbe = async () => ({
  state: 'connected',
  checked: true,
  reason: 'stubbed connected heartbeat',
  heartbeatAgeMs: 120,
});

function downProbe(state: BridgeStatus['state'], reason: string): BridgeProbe {
  return async () => ({ state, checked: state !== 'unobservable', reason });
}

interface GateOverrides {
  config?: Partial<HttpTransportConfig>;
  probe?: BridgeProbe;
  handlerFetch?: (request: Request, options?: unknown) => Promise<Response>;
  limiter?: RequestLimiter;
  surface?: PremiereMcpSurface;
}

function makeGate(overrides: GateOverrides = {}) {
  const { config } = resolveHttpConfig({ PREMIERE_MCP_HTTP_TOKEN: TOKEN }, []);
  const surface = overrides.surface ?? makeSurface();
  return createHttpGate({
    config: { ...config, ...overrides.config },
    surface,
    handler: {
      fetch:
        overrides.handlerFetch ??
        (async () =>
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: { reached: 'sdk-handler' } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )),
    },
    bridgeProbe: overrides.probe ?? connectedProbe,
    ...(overrides.limiter ? { limiter: overrides.limiter } : {}),
    env: { PREMIERE_MCP_PROFILE: 'all' },
  });
}

function post(body: unknown, headers: Record<string, string> = {}, path = HTTP_MCP_PATH): Request {
  return new Request(`http://127.0.0.1:3941${path}`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3941',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...AUTH,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:3941${path}`, {
    method: 'GET',
    headers: { host: '127.0.0.1:3941', accept: 'application/json', ...AUTH, ...headers },
  });
}

/** Reads a JSON or SSE response body and returns the first JSON-RPC message in it. */
async function readRpc(response: Response): Promise<any> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
    }
    throw new Error(`No data frame in SSE body: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------

describe('resolveHttpConfig', () => {
  it('binds loopback and requires auth by default, generating a token', () => {
    const { config, warnings, errors } = resolveHttpConfig({}, []);
    expect(errors).toEqual([]);
    expect(config.host).toBe('127.0.0.1');
    expect(config.authDisabled).toBe(false);
    expect(config.tokenGenerated).toBe(true);
    expect(config.token).toEqual(expect.any(String));
    expect((config.token ?? '').length).toBeGreaterThanOrEqual(24);
    expect(warnings).toEqual([]);
  });

  it('accepts a supplied token without generating one', () => {
    const { config } = resolveHttpConfig({ PREMIERE_MCP_HTTP_TOKEN: TOKEN }, []);
    expect(config.token).toBe(TOKEN);
    expect(config.tokenGenerated).toBe(false);
  });

  it('rejects a token too short to be worth checking', () => {
    const { errors } = resolveHttpConfig({ PREMIERE_MCP_HTTP_TOKEN: 'short' }, []);
    expect(errors.join(' ')).toMatch(/at least 16/);
  });

  it('has no env var for disabling auth — only the explicit flag', () => {
    const viaEnv = resolveHttpConfig(
      { PREMIERE_MCP_HTTP_ALLOWED_HOSTS: 'x', PREMIERE_MCP_HTTP_TOKEN: TOKEN },
      [],
    );
    expect(viaEnv.config.authDisabled).toBe(false);

    const viaFlag = resolveHttpConfig({}, ['--allow-no-auth']);
    expect(viaFlag.config.authDisabled).toBe(true);
    expect(viaFlag.config.token).toBeNull();
    expect(viaFlag.warnings.join(' ')).toMatch(/AUTHENTICATION IS OFF/);
    // The warning must say what an unauthenticated listener exposes, not just that it is off.
    expect(viaFlag.warnings.join(' ')).toMatch(/execute_extendscript/);
    expect(viaFlag.warnings.join(' ')).toMatch(/arbitrary ExtendScript/);
  });

  it('warns loudly when told to bind off loopback', () => {
    const { config, warnings } = resolveHttpConfig({ PREMIERE_MCP_HTTP_TOKEN: TOKEN }, [
      '--host',
      '0.0.0.0',
    ]);
    expect(config.host).toBe('0.0.0.0');
    expect(warnings.join(' ')).toMatch(/NOT loopback/);
    expect(warnings.join(' ')).toMatch(/cleartext/);
  });

  it('reports a bad numeric limit as a fatal error rather than silently defaulting', () => {
    const { errors } = resolveHttpConfig(
      { PREMIERE_MCP_HTTP_TOKEN: TOKEN, PREMIERE_MCP_HTTP_MAX_CONCURRENT: '0' },
      [],
    );
    expect(errors.join(' ')).toMatch(/positive integer/);
  });
});

describe('bearer auth', () => {
  it('refuses a request with no Authorization header', async () => {
    const gate = makeGate();
    const request = new Request(`http://127.0.0.1:3941${HTTP_HEALTH_PATH}`, {
      method: 'GET',
      headers: { host: '127.0.0.1:3941' },
    });
    const response = await gate.fetch(request);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/Bearer/);
  });

  it('refuses a wrong token', async () => {
    const gate = makeGate();
    const response = await gate.fetch(
      get(HTTP_HEALTH_PATH, { authorization: 'Bearer not-the-token-xxxxxxxx' }),
    );
    expect(response.status).toBe(401);
  });

  it('accepts the configured token', async () => {
    const gate = makeGate();
    const response = await gate.fetch(get(HTTP_HEALTH_PATH));
    expect(response.status).toBe(200);
  });

  it('serves with no token only when auth is explicitly disabled', async () => {
    const gate = makeGate({ config: { token: null, authDisabled: true } });
    const request = new Request(`http://127.0.0.1:3941${HTTP_HEALTH_PATH}`, {
      method: 'GET',
      headers: { host: '127.0.0.1:3941' },
    });
    const response = await gate.fetch(request);
    expect(response.status).toBe(200);
    expect((await response.json()).auth).toBe('disabled');
  });

  it('compares tokens without leaking length through a throw', async () => {
    const verifier = staticTokenVerifier(TOKEN);
    await expect(verifier.verifyAccessToken('x')).rejects.toThrow(/Invalid bearer token/);
    await expect(verifier.verifyAccessToken(`${TOKEN}x`)).rejects.toThrow(/Invalid bearer token/);
    const info = await verifier.verifyAccessToken(TOKEN);
    expect(info.clientId).toBe('premiere-mcp-http');
    // The SDK rejects an AuthInfo with no expiry, so one must be present.
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('host and origin validation', () => {
  it('refuses a Host header outside the allowlist (DNS rebinding)', async () => {
    const gate = makeGate();
    const response = await gate.fetch(get(HTTP_HEALTH_PATH, { host: 'evil.example.com' }));
    expect(response.status).toBe(403);
  });

  it('refuses a cross-origin browser request', async () => {
    const gate = makeGate();
    const response = await gate.fetch(get(HTTP_HEALTH_PATH, { origin: 'http://evil.example.com' }));
    expect(response.status).toBe(403);
  });

  it('allows a localhost origin on any port', async () => {
    const gate = makeGate();
    const response = await gate.fetch(get(HTTP_HEALTH_PATH, { origin: 'http://localhost:5173' }));
    expect(response.status).toBe(200);
  });

  it('rejects before auth, so an unauthenticated rebinding attempt still gets 403', async () => {
    const gate = makeGate();
    const request = new Request(`http://127.0.0.1:3941${HTTP_HEALTH_PATH}`, {
      method: 'GET',
      headers: { host: 'evil.example.com' },
    });
    expect((await gate.fetch(request)).status).toBe(403);
  });
});

describe('body size cap', () => {
  it('answers 413 on a declared oversized body without reading it', async () => {
    const gate = makeGate({ config: { maxBodyBytes: 64 } });
    const request = post(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'content-length': '999999' },
    );
    const response = await gate.fetch(request);
    expect(response.status).toBe(413);
    expect((await response.json()).error.message).toMatch(/cap is 64/);
  });

  it('answers 413 on a measured oversized body', async () => {
    const gate = makeGate({ config: { maxBodyBytes: 64 } });
    const big = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(500) } };
    const response = await gate.fetch(post(big));
    expect(response.status).toBe(413);
    expect((await response.json()).error.message).toMatch(/bytes; the cap is 64/);
  });

  it('lets a body under the cap through to the SDK handler', async () => {
    const gate = makeGate({ config: { maxBodyBytes: 4096 } });
    const response = await gate.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(response.status).toBe(200);
    expect((await response.json()).result).toEqual({ reached: 'sdk-handler' });
  });
});

describe('rate and concurrency caps', () => {
  it('answers 429 with Retry-After past the per-minute cap', async () => {
    const gate = makeGate({ config: { maxPerMinute: 1 } });
    const first = await gate.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(first.status).toBe(200);
    const second = await gate.fetch(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await second.json()).error.message).toMatch(/Rate limit: 1 requests per minute/);
  });

  it('answers 429 past the concurrency cap rather than queueing behind Premiere', async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = makeGate({
      config: { maxConcurrent: 1 },
      handlerFetch: async () => {
        await blocked;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const inFlight = gate.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    // Let the first request reach the handler and occupy the single slot.
    await new Promise((resolve) => setImmediate(resolve));
    const refused = await gate.fetch(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.message).toMatch(/Concurrency limit: 1/);

    release();
    expect((await inFlight).status).toBe(200);
  });

  it('releases the concurrency slot when the handler throws', async () => {
    const limiter = new RequestLimiter(1, 100);
    const gate = makeGate({
      config: { maxConcurrent: 1 },
      limiter,
      handlerFetch: async () => {
        throw new Error('handler exploded');
      },
    });
    await expect(gate.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).rejects.toThrow(
      'handler exploded',
    );
    expect(limiter.stats.inFlight).toBe(0);
  });
});

describe('bridge refusal', () => {
  it('answers 503 for tools/call when the bridge is not observably up, naming the cause', async () => {
    const gate = makeGate({
      probe: downProbe('no-heartbeat', 'No readable heartbeat; click Start Bridge.'),
    });
    const response = await gate.fetch(
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find_tool', arguments: { query: 'marker' } },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = await response.json();
    expect(body.error.message).toMatch(/not available \(no-heartbeat\)/);
    expect(body.error.message).toMatch(/Start Bridge/);
    expect(body.error.data.bridge.state).toBe('no-heartbeat');
    expect(body.error.data.refusedMethods).toEqual(['tools/call']);
  });

  it('answers 503 for resources/read too, and 503 when the bridge is merely unobservable', async () => {
    const gate = makeGate({ probe: downProbe('unobservable', 'PREMIERE_TEMP_DIR is not set.') });
    const response = await gate.fetch(
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'premiere://project/info' },
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.data.bridge.checked).toBe(false);
  });

  it('does not refuse methods that need no Premiere', async () => {
    const gate = makeGate({ probe: downProbe('no-heartbeat', 'panel closed') });
    for (const method of ['initialize', 'tools/list', 'prompts/list', 'resources/list']) {
      const response = await gate.fetch(post({ jsonrpc: '2.0', id: 1, method }));
      expect(response.status).toBe(200);
    }
  });

  it('serves tools/call when the bridge is connected', async () => {
    const gate = makeGate({ probe: connectedProbe });
    const response = await gate.fetch(
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find_tool', arguments: { query: 'marker' } },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('can be told to stop refusing, and then does not', async () => {
    const gate = makeGate({
      config: { refuseWhenBridgeDown: false },
      probe: downProbe('no-heartbeat', 'panel closed'),
    });
    const response = await gate.fetch(
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find_tool', arguments: {} },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('finds the method in a legacy batch array', () => {
    expect(jsonRpcMethods([{ method: 'tools/list' }, { method: 'tools/call' }])).toEqual([
      'tools/list',
      'tools/call',
    ]);
    expect(jsonRpcMethods({ method: 'tools/call' })).toEqual(['tools/call']);
    expect(jsonRpcMethods({ id: 1, result: {} })).toEqual([]);
  });
});

describe('/health honesty', () => {
  it('reports what it observed and refuses to claim Premiere is reachable', async () => {
    const surface = makeSurface();
    const gate = makeGate({ surface, probe: connectedProbe });
    const report = await (await gate.fetch(get(HTTP_HEALTH_PATH))).json();

    expect(report.server).toBe('up');
    expect(report.auth).toBe('bearer-token');
    expect(report.catalogue.exposedTools).toBe(surface.tools.getAvailableTools().length);
    expect(report.catalogue.implementedTools).toBe(surface.tools.getRegisteredTools().length);
    expect(report.catalogue.resources).toBe(surface.resources.getAvailableResources().length);
    expect(report.catalogue.prompts).toBe(surface.prompts.getAvailablePrompts().length);
    expect(report.profile.source).toBe('all');
    expect(report.bridge.state).toBe('connected');
    // The point of the endpoint: a connected bridge is still not proof of reachability.
    expect(report.premiereReachable).toBeNull();
    expect(report.premiereReachableNote).toMatch(/no script was run in Premiere/i);
  });

  it('passes the bridge failure through verbatim instead of flattening it to "down"', async () => {
    const gate = makeGate({
      probe: downProbe('not-started', 'Click Start Bridge in the MCP Bridge (CEP) panel.'),
    });
    const report = await (await gate.fetch(get(HTTP_HEALTH_PATH))).json();
    expect(report.bridge.state).toBe('not-started');
    expect(report.bridge.reason).toMatch(/Start Bridge/);
  });

  it('rejects a non-GET /health', async () => {
    const gate = makeGate();
    const response = await gate.fetch(post({}, {}, HTTP_HEALTH_PATH));
    expect(response.status).toBe(405);
  });

  it('404s an unknown path and says where MCP lives', async () => {
    const gate = makeGate();
    const response = await gate.fetch(get('/nope'));
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toMatch(/\/mcp/);
  });
});

describe('heartbeatBridgeProbe', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'premiere-http-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is unobservable, not "down", when PREMIERE_TEMP_DIR is unset', async () => {
    const status = await heartbeatBridgeProbe({})();
    expect(status.state).toBe('unobservable');
    expect(status.checked).toBe(false);
    expect(status.reason).toMatch(/PREMIERE_TEMP_DIR/);
  });

  it('reports no-heartbeat when the file is absent, and says what to do', async () => {
    const status = await heartbeatBridgeProbe({ PREMIERE_TEMP_DIR: join(dir, 'empty') })();
    expect(status.state).toBe('no-heartbeat');
    expect(status.checked).toBe(true);
    expect(status.reason).toMatch(/Start Bridge/);
  });

  it('reports connected for a fresh started heartbeat', async () => {
    const now = 1_000_000;
    await writeFile(
      join(dir, 'bridge-heartbeat.json'),
      JSON.stringify({ ts: now - 200, connected: true, queueLength: 0 }),
    );
    const status = await heartbeatBridgeProbe({ PREMIERE_TEMP_DIR: dir }, () => now)();
    expect(status.state).toBe('connected');
    expect(status.heartbeatAgeMs).toBe(200);
  });

  it('reports not-started when the panel beats but the bridge is off', async () => {
    const now = 1_000_000;
    await writeFile(
      join(dir, 'bridge-heartbeat.json'),
      JSON.stringify({ ts: now - 200, connected: false }),
    );
    const status = await heartbeatBridgeProbe({ PREMIERE_TEMP_DIR: dir }, () => now)();
    expect(status.state).toBe('not-started');
  });

  it('reports no-heartbeat when the beat has gone stale', async () => {
    const now = 1_000_000;
    await writeFile(
      join(dir, 'bridge-heartbeat.json'),
      JSON.stringify({ ts: now - 30_000, connected: true }),
    );
    const status = await heartbeatBridgeProbe({ PREMIERE_TEMP_DIR: dir }, () => now)();
    expect(status.state).toBe('no-heartbeat');
    expect(status.reason).toMatch(/stale/);
  });

  it('reports a torn write as a torn write', async () => {
    await writeFile(join(dir, 'bridge-heartbeat.json'), '{"ts":10');
    const status = await heartbeatBridgeProbe({ PREMIERE_TEMP_DIR: dir })();
    expect(status.state).toBe('no-heartbeat');
    expect(status.reason).toMatch(/torn write/);
  });
});

describe('same catalogue over HTTP as over stdio', () => {
  /** Drive a real stdio server over in-memory pipes and collect one response per id. */
  async function callOverStdio(surface: PremiereMcpSurface, messages: unknown[]): Promise<any[]> {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const transport = new StdioServerTransport(clientToServer, serverToClient);
    const handle = serveStdio(
      () => buildPremiereMcpServer(surface, { wireExposureNotifications: true }),
      { transport },
    );

    const received: any[] = [];
    let buffer = '';
    const done = new Promise<void>((resolve) => {
      serverToClient.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) {
            const parsed = JSON.parse(line);
            if (parsed.id !== undefined) received.push(parsed);
          }
          index = buffer.indexOf('\n');
        }
        if (received.length >= messages.length) resolve();
      });
    });

    for (const message of messages) clientToServer.write(`${JSON.stringify(message)}\n`);
    await done;
    await handle.close();
    return received;
  }

  it('returns an identical tools/call result over both transports', async () => {
    const surface = makeSurface();
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    };
    const toolCall = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'find_tool', arguments: { query: 'marker', limit: 3 } },
    };

    const stdioMessages = await callOverStdio(surface, [initialize, toolCall]);
    const stdioResult = stdioMessages.find((message) => message.id === 2);
    expect(stdioResult?.result).toBeDefined();

    const handler = createMcpHandler(() =>
      buildPremiereMcpServer(surface, { wireExposureNotifications: false }),
    );
    const { config } = resolveHttpConfig({ PREMIERE_MCP_HTTP_TOKEN: TOKEN }, []);
    const gate = createHttpGate({
      config,
      surface,
      handler,
      bridgeProbe: connectedProbe,
      env: { PREMIERE_MCP_PROFILE: 'all' },
    });

    const initResponse = await gate.fetch(post(initialize));
    expect(initResponse.status).toBe(200);
    const httpResponse = await gate.fetch(post(toolCall));
    expect(httpResponse.status).toBe(200);
    const httpResult = await readRpc(httpResponse);

    expect(httpResult.result).toEqual(stdioResult.result);
    // And the shape is the MCP tool-result shape, not something this transport invented.
    expect(Array.isArray(httpResult.result.content)).toBe(true);
    expect(httpResult.result.content[0].type).toBe('text');
    expect(JSON.parse(httpResult.result.content[0].text).matches.length).toBeGreaterThan(0);

    await handler.close();
  }, 30000);

  it('lists the same tools over HTTP as the shared surface exposes', async () => {
    const surface = makeSurface();
    const handler = createMcpHandler(() =>
      buildPremiereMcpServer(surface, { wireExposureNotifications: false }),
    );
    const { config } = resolveHttpConfig({ PREMIERE_MCP_HTTP_TOKEN: TOKEN }, []);
    const gate = createHttpGate({
      config,
      surface,
      handler,
      bridgeProbe: connectedProbe,
      env: { PREMIERE_MCP_PROFILE: 'all' },
    });

    await gate.fetch(
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    );
    const listed = await readRpc(
      await gate.fetch(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })),
    );
    expect(listed.result.tools.length).toBe(surface.tools.getAvailableTools().length);

    await handler.close();
  }, 30000);
});
