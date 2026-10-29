/**
 * The scripting engine can stall or die while the panel stays healthy. After a script outlives
 * its watchdog the panel must stop feeding the engine, answer new commands at once as NOT RUN,
 * recover when a sentinel script comes back, and call the engine dead if it never does.
 */
import { loadPanel } from '../helpers/panel.js';

function panel() {
  const { bridge } = loadPanel();
  const pending: Array<(r: string) => void> = [];
  const sent: string[] = [];
  bridge.csInterface = {
    getHostEnvironment: () => ({ appVersion: '26.5.2' }),
    evalScript: (script: string, cb: (r: string) => void) => {
      sent.push(script);
      pending.push(cb);
    },
  };
  bridge.validateScript = () => true;
  bridge.commandQueue = [];
  return { bridge, pending, sent };
}

const run = (bridge: Record<string, any>) =>
  new Promise<any>((resolve) => bridge.executeCommand({ id: 'c1', script: 'return 1;' }, resolve));

describe('ExtendScript engine health', () => {
  // The panel's 45s watchdog runs on the sandbox's own timers, which jest cannot fast-forward,
  // so the handler it calls is driven directly; the watchdog->handler wiring is checked live.
  it('a stall keeps exactly one sentinel in flight', () => {
    const { bridge, sent } = panel();
    bridge.markEngineStalled();
    expect(bridge.engineState).toBe('stalled');
    bridge.checkEngine();
    bridge.checkEngine();
    expect(sent.filter((x) => x === '1+1')).toHaveLength(1);
  });

  it('answers commands at once as not run while stalled, without touching the engine', async () => {
    const { bridge, sent } = panel();
    bridge.engineState = 'stalled';
    bridge.engineStalledAt = Date.now();
    const before = sent.length;
    const r = await run(bridge);
    expect(r).toMatchObject({ success: false, code: 'ENGINE_STALLED', notRun: true });
    expect(sent.length).toBe(before);
  });

  it('recovers when the sentinel comes back', async () => {
    const { bridge, pending } = panel();
    bridge.markEngineStalled();
    expect(bridge.engineState).toBe('stalled');
    pending[pending.length - 1]!('2');
    expect(bridge.engineState).toBe('ok');
    const again = run(bridge);
    pending[pending.length - 1]!('{"ok":true}');
    expect((await again).success).toBe(true);
  });

  it('calls the engine dead after a long stall and says to restart Premiere', async () => {
    const { bridge } = panel();
    bridge.markEngineStalled();
    bridge.engineStalledAt = Date.now() - 120_000;
    bridge.checkEngine();
    expect(bridge.engineState).toBe('dead');
    const r = await run(bridge);
    expect(r.code).toBe('ENGINE_DEAD');
    expect(r.error).toMatch(/restart Premiere Pro/);
  });

  it('reports the engine state in the heartbeat', () => {
    const writes: Record<string, string> = {};
    const { bridge } = loadPanel({
      fs: {
        writeFileSync: (p: string, d: string) => {
          writes[p] = d;
        },
        renameSync: (a: string, b: string) => {
          writes[b] = writes[a] as string;
        },
      },
    });
    bridge.getTempDirectory = () => '/tmp/bridge';
    bridge.engineState = 'stalled';
    bridge.writeHeartbeat();
    expect(JSON.parse(writes['/tmp/bridge/bridge-heartbeat.json'] as string).engine).toBe(
      'stalled',
    );
  });
});
