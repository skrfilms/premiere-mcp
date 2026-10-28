/**
 * One bridge at a time. The same bridge-cep.js runs as the panel and as the background extension;
 * the lease in bridge-owner.json decides which executes commands. These drive the real updateRole
 * against a fake filesystem.
 */
import { loadPanel } from '../helpers/panel.js';

const DIR = '/tmp/bridge';
const LEASE = `${DIR}/bridge-owner.json`;
const HB = `${DIR}/bridge-heartbeat.json`;

function instance(files: Record<string, string>, role: 'panel' | 'background', settings: Record<string, unknown> = {}) {
  const fs = {
    existsSync: (p: string) => files[p] !== undefined || p.endsWith('.premiere-mcp-bridge'),
    readFileSync: (p: string) => {
      if (p.endsWith('.premiere-mcp-bridge/config.json')) return JSON.stringify(settings);
      if (files[p] === undefined) throw new Error('ENOENT');
      return files[p];
    },
    writeFileSync: (p: string, data: string) => { files[p] = data; },
    renameSync: (a: string, b: string) => { files[b] = files[a] as string; delete files[a]; },
    unlinkSync: (p: string) => { delete files[p]; },
    mkdirSync: () => {},
    readdirSync: () => [],
  };
  const { bridge } = loadPanel({ fs });
  bridge.getTempDirectory = () => DIR;
  bridge.role = role;
  bridge.headless = role === 'background';
  bridge.instanceId = `${role}-1`;
  bridge.active = false;
  bridge.leaseTakenAt = 0;
  bridge.isProcessing = false;
  const started: string[] = [];
  bridge.startBridge = () => { started.push(role); bridge.isConnected = true; };
  bridge.disconnectSocket = () => {};
  bridge.updateUI = () => {};
  return { bridge, started };
}

const lease = (files: Record<string, string>) => JSON.parse(files[LEASE] as string);
const settle = (b: Record<string, any>) => { b.updateRole(); b.leaseTakenAt -= 1000; b.updateRole(); };

describe('bridge run lease', () => {
  it('a lone panel takes the free lease and starts after confirming it', () => {
    const files: Record<string, string> = {};
    const { bridge, started } = instance(files, 'panel');
    bridge.updateRole();
    expect(bridge.active).toBe(false); // took it, not yet confirmed
    bridge.leaseTakenAt -= 1000;
    bridge.updateRole();
    expect(bridge.active).toBe(true);
    expect(started).toEqual(['panel']);
    expect(lease(files).id).toBe('panel-1');
  });

  it('a panel stands by while the background bridge holds a fresh lease', () => {
    const files: Record<string, string> = { [LEASE]: JSON.stringify({ id: 'background-9', role: 'background', ts: Date.now(), busy: false }) };
    const { bridge, started } = instance(files, 'panel');
    settle(bridge);
    expect(bridge.active).toBe(false);
    expect(started).toEqual([]);
    expect(lease(files).id).toBe('background-9');
  });

  it('the panel takes over once the background lease goes stale', () => {
    const files: Record<string, string> = { [LEASE]: JSON.stringify({ id: 'background-9', role: 'background', ts: Date.now() - 10_000, busy: false }) };
    const { bridge } = instance(files, 'panel');
    settle(bridge);
    expect(bridge.active).toBe(true);
  });

  it('the background bridge takes over from an idle panel when enabled, never from a busy one', () => {
    const files: Record<string, string> = { [LEASE]: JSON.stringify({ id: 'panel-7', role: 'panel', ts: Date.now(), busy: true }) };
    const { bridge } = instance(files, 'background');
    settle(bridge);
    expect(bridge.active).toBe(false);
    files[LEASE] = JSON.stringify({ id: 'panel-7', role: 'panel', ts: Date.now(), busy: false });
    settle(bridge);
    expect(bridge.active).toBe(true);
    expect(lease(files).id).toBe('background-1');
  });

  it('a new holder does not activate while the previous holder is still finishing a command', () => {
    const files: Record<string, string> = {
      [HB]: JSON.stringify({ ts: Date.now(), isProcessing: true, owner: 'panel-7' }),
    };
    const { bridge } = instance(files, 'background');
    settle(bridge);
    expect(bridge.active).toBe(false);
    files[HB] = JSON.stringify({ ts: Date.now(), isProcessing: false, owner: 'panel-7' });
    bridge.updateRole();
    expect(bridge.active).toBe(true);
  });

  it('the background bridge does nothing, and releases its lease, when the toggle is off', () => {
    const files: Record<string, string> = {};
    const { bridge, started } = instance(files, 'background', { runInBackground: false });
    files[LEASE] = JSON.stringify({ id: 'background-1', role: 'background', ts: Date.now(), busy: false });
    settle(bridge);
    expect(bridge.active).toBe(false);
    expect(started).toEqual([]);
    expect(files[LEASE]).toBeUndefined();
  });

  it('background is on by default', () => {
    const files: Record<string, string> = {};
    const { bridge } = instance(files, 'background', {});
    settle(bridge);
    expect(bridge.active).toBe(true);
  });
});
