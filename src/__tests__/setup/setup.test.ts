/**
 * premiere-mcp setup: finds the AI apps, adds the server without disturbing anything else, and
 * starts the server the way that keeps working (pinned npx from a cache, absolute path otherwise).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectClients,
  launchFor,
  mergeServerEntry,
  runSetup,
  sharedBridgeDir,
  type Env,
} from '../../setup/setup.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'setup-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const mac = (): Env => ({ platform: 'darwin', home });

describe('setup', () => {
  it('pins the version when run through npx, and uses this exact node otherwise', () => {
    expect(
      launchFor(
        '/Users/a/.npm/_npx/abc/node_modules/premiere-mcp',
        '1.5.0',
        '/usr/bin/node',
        '/tmp/b',
      ),
    ).toEqual({
      command: 'npx',
      args: ['-y', 'premiere-mcp@1.5.0'],
      env: { PREMIERE_TEMP_DIR: '/tmp/b' },
    });
    expect(
      launchFor(
        '/opt/homebrew/lib/node_modules/premiere-mcp',
        '1.5.0',
        '/opt/homebrew/bin/node',
        '/tmp/b',
      ).args[0],
    ).toBe(join('/opt/homebrew/lib/node_modules/premiere-mcp', 'dist', 'index.js'));
  });

  it('uses the folder the bridge in Premiere watches', () => {
    expect(sharedBridgeDir(mac())).toBe('/tmp/premiere-mcp-bridge');
    mkdirSync(join(home, '.premiere-mcp-bridge'));
    writeFileSync(
      join(home, '.premiere-mcp-bridge', 'config.json'),
      JSON.stringify({ tempDirectory: '/Volumes/fast/bridge' }),
    );
    expect(sharedBridgeDir(mac())).toBe('/Volumes/fast/bridge');
  });

  it('adds or replaces only its own entry and keeps the other servers', () => {
    const launch = {
      command: 'node',
      args: ['/x/dist/index.js'],
      env: { PREMIERE_TEMP_DIR: '/tmp/b' },
    };
    const before = JSON.stringify({
      mcpServers: {
        blender: { command: 'uvx', args: ['mcp-for-blender'] },
        'premiere-pro': { command: 'old' },
      },
      theme: 'dark',
    });
    const after = JSON.parse(mergeServerEntry(before, 'mcpServers', launch));
    expect(after.mcpServers.blender).toEqual({ command: 'uvx', args: ['mcp-for-blender'] });
    expect(after.mcpServers['premiere-pro']).toEqual(launch);
    expect(after.theme).toBe('dark');
    expect(JSON.parse(mergeServerEntry(null, 'servers', launch)).servers['premiere-pro'].type).toBe(
      'stdio',
    );
    expect(() => mergeServerEntry('[1,2]', 'mcpServers', launch)).toThrow();
  });

  it('finds apps by their config folder or CLI', () => {
    mkdirSync(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    mkdirSync(join(home, '.cursor'));
    const ids = detectClients(mac(), (bin) => bin === 'codex').map((c) => c.id);
    expect(ids).toEqual(['claude-desktop', 'codex', 'cursor']);
  });

  it('writes the config with a backup, and a dry run writes nothing', () => {
    const dir = join(home, 'Library', 'Application Support', 'Claude');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'claude_desktop_config.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const dry = runSetup(
      '/pkg',
      '1.5.0',
      { dryRun: true, skipPlugins: true, clients: ['claude-desktop'] },
      mac(),
    );
    expect(dry.results[0]).toMatchObject({ ok: true, detail: `would write ${file}` });
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers['premiere-pro']).toBeUndefined();
    const real = runSetup(
      '/pkg',
      '1.5.0',
      { skipPlugins: true, clients: ['claude-desktop'] },
      mac(),
    );
    expect(real.results[0]!.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(cfg.mcpServers['premiere-pro'].env.PREMIERE_TEMP_DIR).toBe('/tmp/premiere-mcp-bridge');
    expect(real.results[0]!.detail).toMatch(/backup: .*\.bak-/);
  });

  it('says plainly when the signed plugins are missing from this copy', () => {
    const r = runSetup(home, '1.5.0', { dryRun: true, skipClients: true }, mac());
    expect(r.results[0]).toMatchObject({ ok: false });
    expect(r.results[0]!.detail).toMatch(/release:installer/);
  });
});
