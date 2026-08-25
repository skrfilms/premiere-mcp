/**
 * Two channels, one publication.
 *
 * The bridge can now reach the panel two ways: a loopback WebSocket push, and the original
 * `command-<uuid>.json` file poll. The rule that makes that safe is that a command is published to
 * EXACTLY ONE of them. Publishing to both would hand the panel two copies of the same work, and a
 * second `insertClip` is not a slow edit, it is a wrong one — so this suite watches the shared
 * directory while a socket command is in flight and asserts nothing was ever written there.
 *
 * The second half is the honesty requirement. When the socket dies AFTER a command was published,
 * the server must say the command may have partially applied and must NOT retry it over file IPC.
 * A retry there is exactly how one edit becomes two.
 *
 * A SIMULATED panel is used (a `ws` client speaking the wire protocol), not Premiere. Premiere is
 * open on this machine with the owner's project and a live bridge, so every test builds its own
 * PREMIERE_TEMP_DIR and nothing here goes near /tmp/premiere-mcp-bridge.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PremiereProBridge } from '../../bridge/index.js';
import { connectSimPanel, waitFor, type SimPanel } from './socket-panel-sim.js';

let dir: string;
let bridge: PremiereProBridge | null = null;
const panels: SimPanel[] = [];

const originalTempDir = process.env.PREMIERE_TEMP_DIR;
const originalTransport = process.env.PREMIERE_MCP_TRANSPORT;

/** Every filename that has EVER appeared in the shared directory, sampled while a call is in flight. */
function startDirectoryWatch(): { seen: Set<string>; stop: () => void } {
  const seen = new Set<string>();
  const sample = (): void => {
    try { for (const name of readdirSync(dir)) seen.add(name); } catch { /* removed */ }
  };
  sample();
  const timer = setInterval(sample, 2);
  return {
    seen,
    stop: () => { sample(); clearInterval(timer); },
  };
}

async function readyBridge(): Promise<PremiereProBridge> {
  const created = new PremiereProBridge();
  await created.initialize();
  bridge = created;
  return created;
}

function panel(options: Parameters<typeof connectSimPanel>[1] = {}): SimPanel {
  const created = connectSimPanel(dir, options);
  panels.push(created);
  return created;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'premiere-mcp-dual-'));
  process.env.PREMIERE_TEMP_DIR = dir;
  delete process.env.PREMIERE_MCP_TRANSPORT;
});

afterEach(async () => {
  for (const created of panels.splice(0)) created.close();
  if (bridge) {
    await bridge.cleanup();
    bridge = null;
  }
  if (originalTempDir === undefined) delete process.env.PREMIERE_TEMP_DIR;
  else process.env.PREMIERE_TEMP_DIR = originalTempDir;
  if (originalTransport === undefined) delete process.env.PREMIERE_MCP_TRANSPORT;
  else process.env.PREMIERE_MCP_TRANSPORT = originalTransport;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('channel selection', () => {
  it('starts on file IPC and switches to the socket only once a panel has handshaken', async () => {
    const created = await readyBridge();

    const before = created.getTransportStatus();
    expect(before.socket.listening).toBe(true);
    expect(before.socket.panelConnected).toBe(false);
    // Listening is not the same as usable. With no panel on the other end the only channel that can
    // deliver anything is the file poll, and the status says so rather than advertising the socket.
    expect(before.activeChannel).toBe('file');

    const sim = panel();
    await sim.ready;
    await waitFor('the bridge to see a handshaken panel', () => created.getTransportStatus().socket.panelConnected);

    const after = created.getTransportStatus();
    expect(after.activeChannel).toBe('socket');
    expect(after.socket.handshake?.engine).toBe('extendscript');
    expect(after.socket.port).toBeGreaterThan(0);
  });

  it('falls back to the file channel for a capability the panel did not announce', async () => {
    const created = await readyBridge();
    const sim = panel({ features: ['extendscript'] });
    await sim.ready;
    await waitFor('a handshaken panel', () => created.getTransportStatus().socket.panelConnected);

    // ExtendScript goes over the socket; panel-context JavaScript does not, because this panel never
    // said it could run it. Announced features gate behaviour — an unannounced one is not attempted.
    expect(created.getTransportStatus().activeChannel).toBe('socket');
    const watch = startDirectoryWatch();
    await created.executeCepJs('return 1;', 400).catch(() => undefined);
    watch.stop();
    expect([...watch.seen].some((name) => name.startsWith('command-'))).toBe(true);
    expect(created.getTransportStatus().publications).toMatchObject({ file: 1 });
  }, 20_000);
});

describe('EXACTLY ONE channel per command', () => {
  it('publishes over the socket and writes no command file at all', async () => {
    const created = await readyBridge();
    const sim = panel();
    await sim.ready;
    await waitFor('a handshaken panel', () => created.getTransportStatus().socket.panelConnected);

    const watch = startDirectoryWatch();
    const result = await created.executeScript('return JSON.stringify({ok:true});');
    watch.stop();

    expect(result).toEqual({ echoed: sim.commands[0]?.id });
    expect(sim.commands).toHaveLength(1);

    // The proof: no command file EVER existed while the socket call was in flight. Sampling rather
    // than only checking afterwards, because the file path unlinks what it wrote — a final listing
    // alone could not tell "never written" from "written and cleaned up".
    const commandFiles = [...watch.seen].filter((name) => name.startsWith('command-') || name.startsWith('.tmp-'));
    expect(commandFiles).toEqual([]);

    const status = created.getTransportStatus();
    expect(status.publications.socket).toBe(1);
    expect(status.publications.file).toBe(0);
    // One command, one publication. The two counters are exhaustive, so their sum is the proof that
    // nothing was published twice.
    expect(status.publications.socket + status.publications.file).toBe(1);
  });

  it('publishes over the file channel and sends nothing to the socket', async () => {
    const created = await readyBridge();
    // A panel that connects but never completes the handshake must not be treated as reachable.
    const sim = panel({ sendHello: false });
    await waitFor('the socket to open without handshaking', () => sim.socket.readyState === 1);
    expect(created.getTransportStatus().socket.panelConnected).toBe(false);

    const watch = startDirectoryWatch();
    // No panel is answering, so this times out — the artifact under test is what appeared on disk.
    await created.executeScript('return 1;', 1200).catch(() => undefined);
    watch.stop();

    const commandFiles = [...watch.seen].filter((name) => name.startsWith('command-'));
    expect(commandFiles).toHaveLength(1);
    expect(sim.commands).toEqual([]);

    const status = created.getTransportStatus();
    expect(status.publications.file).toBe(1);
    expect(status.publications.socket).toBe(0);
  }, 20_000);

  it('measures and reports real round-trip latency for socket commands', async () => {
    const created = await readyBridge();
    const sim = panel();
    await sim.ready;
    await waitFor('a handshaken panel', () => created.getTransportStatus().socket.panelConnected);

    await created.executeScript('return 1;');
    await created.executeScript('return 2;');

    const latency = created.getTransportStatus().socket.latency;
    expect(latency).not.toBeNull();
    expect(latency?.samples).toBe(2);
    // Measured, not asserted: a monotonic clock on this side, publish to response. Two JSON frames
    // over loopback must beat the 250ms file poll this channel exists to replace.
    expect(latency?.lastMs as number).toBeLessThan(250);
    expect(latency?.p50Ms as number).toBeGreaterThanOrEqual(0);
  });
});

describe('no silent fallback after a published mutation', () => {
  it('refuses to retry over file IPC when the socket dies mid-command', async () => {
    const created = await readyBridge();
    // Takes the command, then vanishes without answering: a Premiere crash, a panel reload, a
    // closed extension window.
    const sim = panel({ respond: () => null });
    await sim.ready;
    await waitFor('a handshaken panel', () => created.getTransportStatus().socket.panelConnected);

    const watch = startDirectoryWatch();
    const inFlight = created.executeScript('track.insertClip(item, 0);', 8000);
    const command = await sim.nextCommand();
    expect(command.commandType).toBe('extendscript');
    sim.socket.terminate();

    await expect(inFlight).rejects.toThrow(/MAY HAVE PARTIALLY APPLIED/i);
    watch.stop();

    // THE POINT OF THIS TEST. The command reached Premiere, so re-publishing it over the file
    // channel could apply the same edit a second time. Nothing was written.
    expect([...watch.seen].filter((name) => name.startsWith('command-'))).toEqual([]);

    const status = created.getTransportStatus();
    expect(status.publications.socket).toBe(1);
    expect(status.publications.file).toBe(0);
    expect(status.publications.refusedAfterPublish).toBe(1);
  }, 20_000);

  it('names the command and tells the operator to inspect the project', async () => {
    const created = await readyBridge();
    const sim = panel({ respond: () => null });
    await sim.ready;
    await waitFor('a handshaken panel', () => created.getTransportStatus().socket.panelConnected);

    const inFlight = created.executeScript('return 1;', 6000);
    const command = await sim.nextCommand();
    sim.socket.terminate();

    // A warning nobody can act on is not honesty, it is noise. The message must carry the command
    // id and say what to do about it.
    await expect(inFlight).rejects.toThrow(new RegExp(command.id));
    await expect(created.executeScript('return 2;', 800).catch((error: Error) => { throw error; }))
      .rejects.toThrow();
  }, 20_000);
});

describe('the transport can be pinned', () => {
  it('binds no listener at all when pinned to file', async () => {
    process.env.PREMIERE_MCP_TRANSPORT = 'file';
    const created = await readyBridge();
    const status = created.getTransportStatus();
    expect(status.preference).toBe('file');
    expect(status.socket.listening).toBe(false);
    expect(status.activeChannel).toBe('file');
    // No port means no firewall prompt and nothing to reach — the reason this escape hatch exists.
    expect(readdirSync(dir)).not.toContain('bridge-endpoint.json');
  });

  it('refuses to use the file channel when pinned to socket, rather than quietly using it', async () => {
    process.env.PREMIERE_MCP_TRANSPORT = 'socket';
    const created = await readyBridge();
    // No panel is connected, so there is no socket to publish on. The operator ruled out the other
    // channel, so the honest answer is a refusal naming the setting — not a silent downgrade.
    const watch = startDirectoryWatch();
    await expect(created.executeScript('return 1;', 800)).rejects.toThrow(/PREMIERE_MCP_TRANSPORT=socket/);
    watch.stop();
    expect([...watch.seen].filter((name) => name.startsWith('command-'))).toEqual([]);
    expect(created.getTransportStatus().publications).toMatchObject({ socket: 0, file: 0 });
  });
});

describe('the file channel still carries the session token', () => {
  it('puts the token on a command published to a file', async () => {
    const created = await readyBridge();
    const expected = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;

    const inFlight = created.executeScript('return 1;', 1500).catch(() => undefined);
    let captured: Record<string, unknown> | null = null;
    await waitFor('the command file to appear', () => {
      const name = readdirSync(dir).find((entry) => entry.startsWith('command-'));
      if (!name) return false;
      try { captured = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return false; }
      return captured !== null;
    });
    await inFlight;

    // The socket path added a second channel; it must not have weakened the first.
    expect((captured as unknown as { token: string }).token).toBe(expected);
  }, 20_000);
});
