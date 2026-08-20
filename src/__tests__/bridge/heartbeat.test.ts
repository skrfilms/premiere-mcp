/**
 * Panel liveness heartbeat and the fail-fast / diagnostic behaviour it enables.
 *
 * Before this, every way the bridge could fail to answer — panel never started,
 * panel wedged behind a modal dialog, panel crashed mid-command, or a host-side
 * script that died without writing a response — produced the SAME generic timeout
 * after the caller had blocked for the full duration. The panel now writes a
 * heartbeat file every poll tick, and the server uses it to (a) fail fast when a
 * once-live panel stops ticking and (b) name the actual cause when it does time out.
 *
 * Fake timers make Date.now() deterministic, so the 3s grace / 4s stale thresholds
 * and the poll clock are exact instead of wall-clock-dependent and slow.
 */

import { PremiereProBridge } from '../../bridge/index.js';
import { promises as fs } from 'fs';
import path from 'path';

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    access: jest.fn(),
    readdir: jest.fn(),
    writeFile: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
    rename: jest.fn(),
    rm: jest.fn(),
  }
}));

jest.mock('node:crypto', () => ({
  randomUUID: jest.fn(() => 'test-uuid-1234')
}));

describe('bridge panel heartbeat', () => {
  const mockFs = fs as jest.Mocked<typeof fs>;
  const dir = '/tmp/premiere-mcp-bridge-test';

  // Set per-test: what the heartbeat file contains (or a rejection to simulate its
  // absence). Everything else — the response file — is treated as never-arriving.
  let heartbeat: (() => Promise<string>) | null;

  const enoent = () => Promise.reject(new Error('ENOENT'));

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.PREMIERE_TEMP_DIR = dir;
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.access.mockRejectedValue(new Error('Not found'));
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);

    heartbeat = null; // default: no heartbeat file (older panel)
    mockFs.readFile.mockImplementation((p: any) => {
      const name = path.basename(String(p));
      if (name === 'bridge-heartbeat.json') {
        return heartbeat ? heartbeat() : enoent();
      }
      // The response file never arrives in these tests; we are exercising the wait.
      return enoent();
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.PREMIERE_TEMP_DIR;
  });

  const readyBridge = async (): Promise<PremiereProBridge> => {
    const bridge = new PremiereProBridge();
    await bridge.initialize();
    return bridge;
  };

  // A heartbeat frozen at the moment of capture: as fake time advances it ages,
  // so it starts fresh and eventually goes stale on its own.
  const frozenBeat = (extra: Record<string, unknown> = {}) => {
    const ts = Date.now();
    return () => Promise.resolve(JSON.stringify({ ts, connected: true, isProcessing: false, ...extra }));
  };

  // A heartbeat that re-stamps itself on every read: always fresh (a live panel).
  const liveBeat = (extra: Record<string, unknown> = {}) =>
    () => Promise.resolve(JSON.stringify({ ts: Date.now(), connected: true, isProcessing: false, ...extra }));

  describe('fail fast', () => {
    it('gives up early when a once-live panel stops ticking', async () => {
      heartbeat = frozenBeat(); // fresh now, ages out as time advances
      const bridge = await readyBridge();

      const call = bridge.executeScript('return 1;', 60000);
      const assertion = expect(call).rejects.toThrow(/stopped responding/i);
      // Past the 3s grace and 4s stale window, but nowhere near the 60s timeout.
      await jest.advanceTimersByTimeAsync(6000);
      await assertion;
    });

    it('does NOT fail fast for an older panel that never writes a heartbeat', async () => {
      heartbeat = null; // readFile rejects for the heartbeat path
      const bridge = await readyBridge();

      const call = bridge.executeScript('return 1;', 6000);
      const assertion = expect(call).rejects.toThrow(/No panel heartbeat was seen/);
      // Runs the full timeout instead of bailing at the grace boundary.
      await jest.advanceTimersByTimeAsync(6500);
      await assertion;
    });

    it('does not fail fast while the panel keeps beating (long-running op)', async () => {
      heartbeat = liveBeat({ isProcessing: true, currentCommandId: 'test-uuid-1234' });
      const bridge = await readyBridge();

      const call = bridge.executeScript('return 1;', 8000);
      // A live-but-busy panel must be allowed to run to the caller's own timeout,
      // not be killed at the grace boundary.
      const assertion = expect(call).rejects.toThrow(/still processing this command/);
      await jest.advanceTimersByTimeAsync(8500);
      await assertion;
    });
  });

  describe('timeout diagnosis', () => {
    const runToTimeout = async (bridge: PremiereProBridge, pattern: RegExp) => {
      const call = bridge.executeScript('return 1;', 1000); // under the 3s grace
      const assertion = expect(call).rejects.toThrow(pattern);
      await jest.advanceTimersByTimeAsync(1300);
      await assertion;
    };

    it('names a modal-dialog wedge (busy on another command)', async () => {
      heartbeat = liveBeat({ isProcessing: true, currentCommandId: 'someone-elses-command' });
      const bridge = await readyBridge();
      await runToTimeout(bridge, /busy: the panel has been processing another command/);
    });

    it('tells the caller to raise the timeout for a long op on this command', async () => {
      heartbeat = liveBeat({ isProcessing: true, currentCommandId: 'test-uuid-1234' });
      const bridge = await readyBridge();
      await runToTimeout(bridge, /still processing this command/);
    });

    it('tells the caller to click Start Bridge when the panel is not started', async () => {
      heartbeat = liveBeat({ connected: false });
      const bridge = await readyBridge();
      await runToTimeout(bridge, /Click Start Bridge/);
    });

    it('reports a silent host-side failure when the panel is idle with no response', async () => {
      heartbeat = liveBeat({ connected: true, isProcessing: false });
      const bridge = await readyBridge();
      await runToTimeout(bridge, /alive and idle .* wrote no response/);
    });

    it('falls back to the full setup checklist when there is no heartbeat at all', async () => {
      heartbeat = null;
      const bridge = await readyBridge();
      await runToTimeout(bridge, /Ensure Premiere Pro is open/);
    });
  });

  describe('happy path is unaffected', () => {
    it('returns the result and never consults the heartbeat when a response arrives', async () => {
      heartbeat = liveBeat();
      mockFs.readFile.mockImplementation((p: any) => {
        const name = path.basename(String(p));
        if (name === 'bridge-heartbeat.json') return heartbeat!();
        return Promise.resolve(JSON.stringify({ result: { ok: true } }));
      });
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;')).resolves.toEqual({ ok: true });
    });
  });
});
