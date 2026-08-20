/**
 * The panel end of the heartbeat: what bridge-cep.js actually writes.
 *
 * The server's fail-fast and timeout diagnosis are only as good as the beacon the
 * panel lays down, so this drives the panel's own writeHeartbeat() rather than
 * restating its shape here. It asserts the payload the server reads back, the
 * atomic write-then-rename (so the server never sees a torn beacon), and that a
 * heartbeat failure is swallowed — a panel must never fall over because it could
 * not write a liveness file.
 */

import { loadPanel } from '../helpers/panel.js';

describe('panel writeHeartbeat', () => {
  const setup = (fsOverrides: Record<string, unknown> = {}) => {
    const writes: Array<[string, string]> = [];
    const renames: Array<[string, string]> = [];
    const fs = {
      writeFileSync: (p: string, data: string) => { writes.push([p, data]); },
      renameSync: (from: string, to: string) => { renames.push([from, to]); },
      ...fsOverrides,
    };
    const { bridge } = loadPanel({ fs });
    bridge.getTempDirectory = () => '/tmp/bridge';
    bridge.isConnected = true;
    bridge.isProcessing = false;
    bridge.currentCommandId = null;
    bridge.currentCommandStartedAt = null;
    bridge.commandQueue = [];
    return { bridge, writes, renames };
  };

  it('writes to a staging name and renames into place', () => {
    const { bridge, writes, renames } = setup();
    bridge.writeHeartbeat();

    expect(writes).toHaveLength(1);
    expect(renames).toHaveLength(1);
    const [stagedPath] = writes[0];
    const [renameFrom, renameTo] = renames[0];
    // The server polls for the final name; it must appear only via the atomic rename.
    expect(stagedPath).toBe('/tmp/bridge/bridge-heartbeat.json.part');
    expect(renameFrom).toBe(stagedPath);
    expect(renameTo).toBe('/tmp/bridge/bridge-heartbeat.json');
  });

  it('reports connection, processing and current-command state the server reads', () => {
    const { bridge, writes } = setup();
    bridge.isConnected = true;
    bridge.isProcessing = true;
    bridge.currentCommandId = 'cmd-42';
    bridge.currentCommandStartedAt = 1700000000000;
    bridge.commandQueue = [{ id: 'cmd-42' }, { id: 'cmd-43' }];

    bridge.writeHeartbeat();

    const payload = JSON.parse(writes[0][1]);
    expect(typeof payload.ts).toBe('number');
    expect(payload.connected).toBe(true);
    expect(payload.isProcessing).toBe(true);
    expect(payload.currentCommandId).toBe('cmd-42');
    expect(payload.currentCommandStartedAt).toBe(1700000000000);
    expect(payload.queueLength).toBe(2);
  });

  it('reports a not-started panel as connected:false', () => {
    const { bridge, writes } = setup();
    bridge.isConnected = false;
    bridge.writeHeartbeat();
    expect(JSON.parse(writes[0][1]).connected).toBe(false);
  });

  it('writes nothing when no temp directory is available', () => {
    const { bridge, writes, renames } = setup();
    bridge.getTempDirectory = () => null;
    bridge.writeHeartbeat();
    expect(writes).toHaveLength(0);
    expect(renames).toHaveLength(0);
  });

  it('never throws when the write fails', () => {
    const { bridge } = setup({
      writeFileSync: () => { throw new Error('ENOSPC'); },
    });
    expect(() => bridge.writeHeartbeat()).not.toThrow();
  });
});
