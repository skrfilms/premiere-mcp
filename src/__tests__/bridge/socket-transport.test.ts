/**
 * The loopback WebSocket transport, server half.
 *
 * SCOPE, stated first because the other half matters just as much: everything here drives the real
 * `BridgeSocketTransport` against a SIMULATED panel (a `ws` client speaking the wire protocol). It
 * proves the endpoint file, authentication, the version handshake, latency measurement, and — the
 * part that is a correctness requirement rather than a feature — that a command which reached the
 * wire is never reported as un-published.
 *
 * It proves nothing about `cep-plugin/bridge-cep.js` connecting from inside CEF. That needs a live
 * Premiere and is recorded as owed. Premiere is open on this machine with the owner's project, so
 * nothing here touches /tmp/premiere-mcp-bridge: every test builds its own directory.
 */

import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  BridgeSocketTransport,
  BRIDGE_PROTOCOL_VERSION,
  CLOSE_CODES,
  ENDPOINT_FILE,
} from '../../bridge/socket-transport.js';
import { connectSimPanel, readEndpoint, waitFor, type SimPanel } from './socket-panel-sim.js';

const TOKEN = 'a'.repeat(64);
const QUIET = { info() {}, warn() {}, error() {}, debug() {} } as never;

let dir: string;
let transport: BridgeSocketTransport | null = null;
const panels: SimPanel[] = [];

async function startTransport(options: { token?: string | null; authTimeoutMs?: number } = {}) {
  const created = new BridgeSocketTransport({
    tempDir: dir,
    token: options.token === undefined ? TOKEN : options.token,
    sessionId: 'session-under-test',
    logger: QUIET,
    ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
  });
  transport = created;
  const started = await created.start();
  expect(started).not.toBeNull();
  return created;
}

function panel(options: Parameters<typeof connectSimPanel>[1] = {}): SimPanel {
  const created = connectSimPanel(dir, options);
  panels.push(created);
  return created;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'premiere-mcp-socket-'));
});

afterEach(async () => {
  for (const created of panels.splice(0)) created.close();
  if (transport) {
    await transport.stop();
    transport = null;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the endpoint file', () => {
  it('publishes an ephemeral loopback port, owner-readable only', async () => {
    const started = await startTransport();
    const endpointFile = join(dir, ENDPOINT_FILE);
    expect(existsSync(endpointFile)).toBe(true);

    // 0600, for the same reason auth-token.json is: it carries the session token.
    expect(statSync(endpointFile).mode & 0o777).toBe(0o600);

    const payload = JSON.parse(readFileSync(endpointFile, 'utf8'));
    expect(payload.port).toBe(started.listeningPort());
    expect(payload.port).toBeGreaterThan(0);
    expect(payload.token).toBe(TOKEN);
    expect(payload.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(payload.pid).toBe(process.pid);
    expect(typeof payload.startedAt).toBe('string');
  });

  it('reuses the session token rather than minting a second secret', async () => {
    await startTransport();
    // Two secrets would mean two things to rotate and a panel that could be authorised on one
    // channel while rejected on the other.
    expect(readEndpoint(dir).token).toBe(TOKEN);
  });

  it('is published by rename, leaving no staging file behind', async () => {
    await startTransport();
    // The panel polls for this exact name; a plain write would publish the name before the content,
    // and a panel that read a truncated file would not retry (reconnect is on close, not on parse).
    const leftovers = readdirSync(dir).filter((name) => name.startsWith('.bridge-endpoint'));
    expect(leftovers).toEqual([]);
  });

  it('is removed on stop, so no panel dials a dead port', async () => {
    const created = await startTransport();
    await created.stop();
    transport = null;
    expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(false);
  });

  it('is reachable on loopback and NOT on the machine other addresses', async () => {
    const created = await startTransport();
    const port = created.listeningPort() as number;

    const loopback = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => loopback.once('open', () => resolve()));
    expect(loopback.readyState).toBe(WebSocket.OPEN);
    loopback.close();

    // A listener on 0.0.0.0 would expose arbitrary ExtendScript execution to the network, so the
    // bind is tested rather than trusted: every non-loopback IPv4 address on this machine must
    // refuse the connection. On a host with no such interface there is nothing to prove and the
    // assertion below is skipped — stated rather than silently passing.
    const external = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address);

    for (const address of external) {
      const refused = await new Promise<string>((resolve) => {
        const probe = new WebSocket(`ws://${address}:${port}`);
        // A connection to a port bound on this same machine completes in single-digit ms, so a
        // short window is enough: anything slower than this is not a listener answering.
        const timer = setTimeout(() => { probe.terminate(); resolve('timeout'); }, 500);
        probe.once('open', () => { clearTimeout(timer); probe.close(); resolve('CONNECTED'); });
        probe.once('error', () => { clearTimeout(timer); resolve('refused'); });
      });
      expect(refused).not.toBe('CONNECTED');
    }
  });
});

describe('authentication on the first frame', () => {
  it('accepts a panel that presents the session token', async () => {
    const created = await startTransport();
    const sim = panel();
    await sim.ready;
    expect(created.isPanelReady()).toBe(true);
    expect(created.handshake()?.premiereVersion).toBe('26.3.2');
  });

  it('rejects a token mismatch with its own close code', async () => {
    const created = await startTransport();
    const sim = panel({ token: 'b'.repeat(64) });
    const [code] = await sim.closed;
    expect(code).toBe(CLOSE_CODES.AUTH_FAILED);
    expect(created.isPanelReady()).toBe(false);
  });

  it('rejects a hello carrying no token at all', async () => {
    await startTransport();
    const sim = panel({ token: null });
    const [code] = await sim.closed;
    expect(code).toBe(CLOSE_CODES.AUTH_FAILED);
  });

  it('closes a connection that never authenticates', async () => {
    // A socket that opens and says nothing must not be held open indefinitely: it occupies the one
    // panel slot and, if it were ever promoted, would receive commands it cannot run.
    await startTransport({ authTimeoutMs: 120 });
    const sim = panel({ sendHello: false });
    const [code] = await sim.closed;
    expect(code).toBe(CLOSE_CODES.AUTH_TIMEOUT);
  });

  it('refuses a first frame that is not a hello', async () => {
    const created = await startTransport();
    const port = created.listeningPort() as number;
    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => raw.once('open', () => resolve()));
    raw.send(JSON.stringify({ type: 'response', id: 'x', payload: { success: true } }));
    const code = await new Promise<number>((resolve) => raw.once('close', (value) => resolve(value)));
    expect(code).toBe(CLOSE_CODES.BAD_HANDSHAKE);
  });
});

describe('the versioned capability handshake', () => {
  it('records what the panel announced', async () => {
    const created = await startTransport();
    const sim = panel({ features: ['extendscript'] });
    await sim.ready;

    const handshake = created.handshake();
    expect(handshake).not.toBeNull();
    expect(handshake?.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(handshake?.features).toEqual(['extendscript']);
    expect(handshake?.engine).toBe('extendscript');
  });

  it('gates behaviour on the announced features rather than assuming them', async () => {
    const created = await startTransport();
    const sim = panel({ features: ['extendscript'] });
    await sim.ready;

    expect(created.supportsFeature('extendscript')).toBe(true);
    expect(created.supportsFeature('cep_js')).toBe(false);

    // A feature the panel did not announce is not attempted over the socket. It comes back
    // "not-published", which is what lets the caller send it over file IPC instead — one channel,
    // still exactly once.
    const outcome = await created.publish(
      { id: 'cep-1', commandType: 'cep_js', script: 'return 1;' },
      1000,
    );
    expect(outcome.status).toBe('not-published');
    if (outcome.status === 'not-published') expect(outcome.reason).toContain('cep_js');
  });

  it('fails CLOSED on a major version mismatch, naming both versions', async () => {
    const created = await startTransport();
    const sim = panel({ protocolVersion: '2.0' });
    const [code, reason] = await sim.closed;

    expect(code).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);
    // Both versions in the message: "mismatch" alone sends the reader looking in the wrong place.
    expect(reason).toContain(BRIDGE_PROTOCOL_VERSION);
    expect(reason).toContain('2.0');
    // Fails closed: no half-usable connection is left behind.
    expect(created.isPanelReady()).toBe(false);
  });

  it('fails CLOSED when the version is absent or unparseable, never assuming compatibility', async () => {
    const created = await startTransport();

    const silent = panel({ protocolVersion: null });
    expect((await silent.closed)[0]).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);

    const nonsense = panel({ protocolVersion: 'banana' });
    expect((await nonsense.closed)[0]).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);

    expect(created.isPanelReady()).toBe(false);
    expect(created.handshake()).toBeNull();
  });
});

describe('publishing over the socket', () => {
  it('returns the panel result and a measured round trip', async () => {
    const created = await startTransport();
    const sim = panel();
    await sim.ready;

    const outcome = await created.publish(
      { id: 'cmd-1', commandType: 'extendscript', script: 'return 1;' },
      2000,
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.result).toEqual({ echoed: 'cmd-1' });
    // A real measurement, not a claim: monotonic clock, publish to response, including whatever the
    // panel spent executing. Loopback JSON should be well under a poll tick.
    expect(typeof outcome.roundTripMs).toBe('number');
    expect(outcome.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(outcome.roundTripMs).toBeLessThan(250);
  });

  it('reports latency as unmeasured until something has been measured', async () => {
    const created = await startTransport();
    const empty = created.latency();
    expect(empty.samples).toBe(0);
    // Null, not zero. A zero here would read as "sub-millisecond" rather than "never measured".
    expect(empty.lastMs).toBeNull();
    expect(empty.p50Ms).toBeNull();

    const sim = panel();
    await sim.ready;
    for (const id of ['a', 'b', 'c']) {
      await created.publish({ id, commandType: 'extendscript', script: 'return 1;' }, 2000);
    }
    const stats = created.latency();
    expect(stats.samples).toBe(3);
    expect(stats.minMs as number).toBeLessThanOrEqual(stats.p50Ms as number);
    expect(stats.p50Ms as number).toBeLessThanOrEqual(stats.maxMs as number);
    expect(stats.meanMs as number).toBeGreaterThanOrEqual(0);
  });

  it('declines an oversized frame instead of tearing the connection down mid-write', async () => {
    const created = await startTransport();
    const sim = panel();
    await sim.ready;

    // ws would close the socket with 1009 part-way through, which reads as a dropped panel and takes
    // every other pending command with it. Declining before sending leaves file IPC — which has no
    // frame cap — free to carry it, still exactly once.
    const outcome = await created.publish(
      { id: 'cmd-huge', commandType: 'extendscript', script: 'x'.repeat(9 * 1024 * 1024) },
      2000,
    );
    expect(outcome.status).toBe('not-published');
    if (outcome.status === 'not-published') expect(outcome.reason).toContain('byte socket limit');
    expect(sim.commands).toEqual([]);
    expect(created.isPanelReady()).toBe(true);
  });

  it('carries the session token on every command, not only the hello', async () => {
    const created = await startTransport();
    const sim = panel();
    await sim.ready;
    await created.publish({ id: 'cmd-tok', commandType: 'extendscript', script: 'return 1;' }, 2000);
    expect(sim.commands).toHaveLength(1);
    expect(sim.commands[0]?.token).toBe(TOKEN);
  });

  it('passes a panel-reported failure through without inventing a partial-apply warning', async () => {
    const created = await startTransport();
    const sim = panel({ respond: () => ({ ok: false }) });
    await sim.ready;
    // The sim answers with an explicit transport-level failure frame instead of a payload.
    sim.socket.send(JSON.stringify({ type: 'noise' })); // ignored, and must not disturb anything
    const outcome = await created.publish(
      { id: 'cmd-fail', commandType: 'extendscript', script: 'return 1;', mutating: true },
      2000,
    );
    expect(outcome.status).toBe('ok'); // {ok:false} was the PAYLOAD here, not the frame's own ok
    if (outcome.status === 'ok') expect(outcome.result).toEqual({ ok: false });
  });
});

describe('graceful degradation', () => {
  it('declines to publish when no panel ever connects', async () => {
    const created = await startTransport();
    const outcome = await created.publish(
      { id: 'cmd-none', commandType: 'extendscript', script: 'return 1;' },
      500,
    );
    // Nothing reached the wire, which is precisely what allows the caller to use file IPC instead.
    expect(outcome.status).toBe('not-published');
    if (outcome.status === 'not-published') expect(outcome.reason).toContain('no panel');
  });

  it('declines again once the panel has gone away', async () => {
    const created = await startTransport();
    const sim = panel();
    await sim.ready;
    sim.close();
    await waitFor('the transport to notice the panel left', () => !created.isPanelReady());

    const outcome = await created.publish(
      { id: 'cmd-after', commandType: 'extendscript', script: 'return 1;' },
      500,
    );
    expect(outcome.status).toBe('not-published');
  });

  it('retires an older panel rather than racing two', async () => {
    const created = await startTransport();
    const first = panel();
    await first.ready;
    const second = panel();
    await second.ready;

    const [code] = await first.closed;
    expect(code).toBe(CLOSE_CODES.SUPERSEDED);
    // Two panels answering the same pending id would resolve one command twice.
    expect(created.isPanelReady()).toBe(true);
  });
});

describe('no silent recovery after a published command', () => {
  it('says a published mutation MAY HAVE PARTIALLY APPLIED when the socket dies mid-flight', async () => {
    const created = await startTransport();
    // The panel takes the command and then vanishes without answering — a Premiere crash, a panel
    // reload, a closed extension window.
    const sim = panel({ respond: () => null });
    await sim.ready;

    const inFlight = created.publish(
      { id: 'cmd-mutate', commandType: 'extendscript', script: 'track.insertClip(x, 0);', mutating: true },
      5000,
    );
    await sim.nextCommand();
    sim.socket.terminate();

    const outcome = await inFlight;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    // The whole point. The caller must not retry, and must be told why in words a human can act on.
    expect(outcome.mayHavePartiallyApplied).toBe(true);
    expect(outcome.error.message).toMatch(/MAY HAVE PARTIALLY APPLIED/i);
    expect(outcome.error.message).toMatch(/NOT retried over file IPC/i);
    expect(created.inFlight()).toBe(0);
  });

  it('says the same on a timeout, because a published command may still be running', async () => {
    const created = await startTransport();
    const sim = panel({ respond: () => null });
    await sim.ready;

    const outcome = await created.publish(
      { id: 'cmd-slow', commandType: 'extendscript', script: 'return 1;', mutating: true },
      150,
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.mayHavePartiallyApplied).toBe(true);
    expect(outcome.error.message).toContain('WAS published');
  });

  it('answers everything in flight when the transport is stopped', async () => {
    const created = await startTransport();
    const sim = panel({ respond: () => null });
    await sim.ready;

    const inFlight = created.publish(
      { id: 'cmd-shutdown', commandType: 'extendscript', script: 'return 1;', mutating: true },
      5000,
    );
    await sim.nextCommand();
    await created.stop();
    transport = null;

    const outcome = await inFlight;
    // Never left hanging, and never retried: the caller gets the truth about a published command.
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.mayHavePartiallyApplied).toBe(true);
  });

  it('ignores a response that arrives after the caller was already answered', async () => {
    const created = await startTransport();
    let late: ((payload: Record<string, unknown>) => void) | null = null;
    const sim = panel({
      respond: (command) => {
        late = () => sim.socket.send(JSON.stringify({
          type: 'response', id: command.id, payload: { success: true, result: 'too late' },
        }));
        return null;
      },
    });
    await sim.ready;

    const outcome = await created.publish(
      { id: 'cmd-late', commandType: 'extendscript', script: 'return 1;' },
      120,
    );
    expect(outcome.status).toBe('failed');
    // The caller has been told the truth about this command; a late arrival must not overwrite it
    // with a success. Nothing to assert but the absence of a crash and a clean pending map.
    (late as unknown as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(created.inFlight()).toBe(0);
  });
});
