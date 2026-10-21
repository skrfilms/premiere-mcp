/**
 * Safety policy of the live harnesses' host recovery, tested without a host.
 *
 * scripts/lib/host-recovery.mjs presses Escape at the frontmost application and force-quits
 * Premiere. Running ensureHealthy() or recoverHost() from a test would do exactly that to whatever
 * is open on the machine running the suite, so nothing here calls them. Instead the decisions they
 * act on are pure helpers, and those are run for real in a child process (the scripts are plain ESM
 * that ts-jest does not load), the same way live-harness-guards.test.ts runs the scratch guard.
 *
 * The remaining assertions are structural: they pin that each harness uses the helpers, because
 * a harness that stops calling them would keep every behavioural test here green.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const RECOVERY = pathToFileURL(path.join(SCRIPTS, 'lib', 'host-recovery.mjs')).href;
const GUARD = pathToFileURL(path.join(SCRIPTS, 'lib', 'require-scratch-project.mjs')).href;
const IN_REPO_FILE = path.join(__dirname, '..', '..', '..', 'package.json');

/** Run `body` as an ES module with the helpers imported, and return what it printed as JSON. */
function run(body: string): any {
  const src = `
    import * as recovery from ${JSON.stringify(RECOVERY)};
    import * as guard from ${JSON.stringify(GUARD)};
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8',
    // Points module-level constants at a directory nothing is watching, in case one is ever read.
    env: { ...process.env, PREMIERE_TEMP_DIR: path.join(tmpdir(), 'pmcp-recovery-test-none') },
  });
  if (res.status !== 0) throw new Error(`child failed (${res.status}): ${res.stderr}`);
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? 'null');
}

describe('recoveryRefusal: when Escape and restart are forbidden', () => {
  const refusal = (verdict: unknown, owned: string[] | null) => run(`
    const owned = ${JSON.stringify(owned)};
    return recovery.recoveryRefusal(${JSON.stringify(verdict)}, owned ? (id) => owned.includes(id) : undefined);
  `);

  it('refuses BUSY on a command this process did not issue', () => {
    // Escape goes to the frontmost app; on a host another client is using it can cancel their export.
    expect(refusal({ state: 'BUSY', busyWith: 'peer-cmd' }, ['mine'])).toMatch(/did not issue/);
  });

  it('refuses every BUSY when the caller cannot say which commands are its own', () => {
    expect(refusal({ state: 'BUSY', busyWith: 'peer-cmd' }, null)).toMatch(/Refusing/);
    expect(refusal({ state: 'BUSY' }, ['mine'])).toMatch(/Refusing/);
  });

  it('allows BUSY on the caller\'s own command, which is the modal case Escape exists for', () => {
    expect(refusal({ state: 'BUSY', busyWith: 'mine' }, ['mine'])).toBeNull();
  });

  it('refuses RESPONSE_LOST even with no live peer, because the engine answered', () => {
    expect(refusal({ state: 'RESPONSE_LOST', contendedBy: [] }, null)).toMatch(/not dead/);
  });

  it('refuses a contended verdict', () => {
    expect(refusal({ state: 'PANEL_DEAD', contendedBy: [4242] }, null)).toMatch(/pid 4242/);
  });

  it('allows an uncontended ENGINE_DEAD, the one verdict recovery is for', () => {
    expect(refusal({ state: 'ENGINE_DEAD' }, null)).toBeNull();
  });

  it.each(['SENTINEL_ERROR', 'SOMETHING_NEW'])('fails closed on %s, where health is unknown rather than dead', (state) => {
    // SENTINEL_ERROR used to fall through to Escape and then a SIGKILL of a host nobody showed was broken.
    expect(refusal({ state }, null)).toMatch(/health is unknown/);
  });
});

describe('trackOwnCommands', () => {
  it('remembers every id the bridge publishes and still forwards the call', () => {
    const r = run(`
      const calls = [];
      const bridge = { publishCommand(id, type) { calls.push([this === bridge, id, type]); return 'sent:' + id; } };
      const owns = recovery.trackOwnCommands(bridge);
      const ret = bridge.publishCommand('cmd-1', 'extendscript');
      return { ret, calls, owns1: owns('cmd-1'), owns2: owns('cmd-2') };
    `);
    expect(r).toEqual({ ret: 'sent:cmd-1', calls: [[true, 'cmd-1', 'extendscript']], owns1: true, owns2: false });
  });

  it('owns nothing when it cannot hook the bridge, which keeps every BUSY refused', () => {
    expect(run(`return recovery.trackOwnCommands({})('anything');`)).toBe(false);
  });
});

describe('guardedSaveScript: recovery saves only the verified scratch project', () => {
  /** Evaluate the generated ExtendScript against a fake `app`; the script is plain ES3. */
  const save = (open: string[], active: string, expected: string) => run(`
    let saved = 0;
    const projects = ${JSON.stringify(open)}.map((p) => ({ path: p }));
    projects.numProjects = projects.length;
    const app = { projects, project: { path: ${JSON.stringify(active)}, save() { saved++; } } };
    const script = recovery.guardedSaveScript(${JSON.stringify(expected)});
    const result = JSON.parse(new Function('app', 'return ' + script.trim().replace(/;$/, ''))(app));
    return { ...result, saveCalls: saved };
  `);

  it('saves when the single open project is the verified one', () => {
    expect(save(['/r/.scratch/s.prproj'], '/r/.scratch/s.prproj', '/r/.scratch/s.prproj')).toEqual({ saved: true, saveCalls: 1 });
  });

  it('does not save once the active project has changed', () => {
    const r = save(['/Users/x/cut.prproj'], '/Users/x/cut.prproj', '/r/.scratch/s.prproj');
    expect(r.saveCalls).toBe(0);
    expect(r.reason).toMatch(/active project changed/);
  });

  it('does not save while a second project is open', () => {
    const r = save(['/r/.scratch/s.prproj', '/Users/x/cut.prproj'], '/r/.scratch/s.prproj', '/r/.scratch/s.prproj');
    expect(r.saveCalls).toBe(0);
  });

  it('survives a path containing quotes rather than producing broken script', () => {
    const odd = "/r/it's \"odd\"/s.prproj";
    expect(save([odd], odd, odd)).toEqual({ saved: true, saveCalls: 1 });
  });
});

describe('scratch re-pinning helpers', () => {
  const scratch = { count: 1, name: 'trowel_scratch.prproj', path: IN_REPO_FILE };

  it('driftReason accepts the pinned project and names every way it can drift', () => {
    const r = run(`
      const pin = { realpath: ${JSON.stringify(IN_REPO_FILE)} };
      return {
        same: guard.driftReason(${JSON.stringify(scratch)}, pin),
        moved: guard.driftReason({ ...${JSON.stringify(scratch)}, path: '/etc/hosts' }, pin),
        two: guard.driftReason({ ...${JSON.stringify(scratch)}, count: 2 }, pin),
        failed: guard.driftReason({ success: false, error: 'wedged' }, pin),
      };
    `);
    expect(r.same).toBeNull();
    expect(r.moved).toMatch(/drifted mid-run/);
    expect(r.two).toMatch(/changed to 2/);
    expect(r.failed).toMatch(/wedged/);
  });

  it('checkStillScratch reports a thrown probe instead of exiting', () => {
    const r = run(`
      const bridge = { executeScript: async () => { throw new Error('bridge gone'); } };
      return guard.checkStillScratch(bridge, { realpath: ${JSON.stringify(IN_REPO_FILE)} });
    `);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bridge gone/);
  });

  it('needsScratchRecheck fires every N calls and straight after project-switching tools', () => {
    const r = run(`
      return {
        quiet: guard.needsScratchRecheck('add_marker', 3),
        periodic: guard.needsScratchRecheck('add_marker', guard.SCRATCH_RECHECK_EVERY),
        tools: ['create_project', 'open_project', 'close_project', 'import_sequences_from_project',
          'open_fcp_xml_project', 'convert_project_to_production', 'save_project_as']
          .map((n) => guard.needsScratchRecheck(n, 1)),
      };
    `);
    expect(r.quiet).toBe(false);
    expect(r.periodic).toBe(true);
    expect(r.tools.every(Boolean)).toBe(true);
  });
});

describe('harnesses use the safety helpers', () => {
  const source = (name: string) => readFileSync(path.join(SCRIPTS, name), 'utf8');

  /**
   * Each of these writes state that outlives the scratch fixture: Adobe's global prefs file, the
   * system clipboard, or a second open project that steals ACTIVE from the scratch guard. The
   * --mutate sweep once filled every optional field of set_autosave_settings and rewrote the
   * user's Auto Save prefs on disk.
   */
  it.each(['set_autosave_settings', 'create_project', 'write_clipboard'])('%s is skipped by both catalogue sweeps', (tool) => {
    const smoke = source('live-smoke-sweep.mjs');
    const skip = smoke.slice(smoke.indexOf('const SKIP = {'), smoke.indexOf('\n};', smoke.indexOf('const SKIP = {')));
    expect(skip).toMatch(new RegExp(`\\n  ${tool}: '`));
    const coverage = source('coverage-sweep.mjs');
    const gate = coverage.slice(coverage.indexOf('const GATE = {'), coverage.indexOf('\n};', coverage.indexOf('const GATE = {')));
    expect(gate).toMatch(new RegExp(`\\n  ${tool}: \\['`));
  });

  /** The env var is read by the in-process handler at call time, so it must be set before any call. */
  it.each([
    'live-smoke-sweep.mjs', 'coverage-sweep.mjs', 'live-tool-sweep.mjs',
    'bisect-hang.mjs', 'live-verify-honesty.mjs', 'live-verify-cleanup.mjs',
  ])('%s refuses prefs-file writes before its first tool call', (name) => {
    const src = source(name);
    const set = src.indexOf("process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1'");
    expect(set).toBeGreaterThan(-1);
    const firstCall = src.indexOf('executeTool(');
    expect(firstCall).toBeGreaterThan(-1);
    expect(set).toBeLessThan(firstCall);
  });

  it.each(['live-smoke-sweep.mjs', 'coverage-sweep.mjs'])('%s re-pins the scratch project inside the tool loop and arms recovery with ownership', (name) => {
    const src = source(name);
    const loop = src.slice(src.search(/for \((const tool of catalogue|let i = 0; i < catalogue\.length)/));
    expect(loop).toMatch(/needsScratchRecheck\(name, callsSinceScratchCheck\)/);
    expect(loop).toMatch(/await checkStillScratch\(bridge, pinned\)/);
    expect(src).toMatch(/const ownsCommand = trackOwnCommands\(bridge\)/);
    expect(src).toMatch(/recoveryState = \{[^}]*ownsCommand, pinned \}/);
  });

  it('ensureHealthy refuses before it presses Escape, not after', () => {
    const src = source(path.join('lib', 'host-recovery.mjs'));
    const fn = src.slice(src.indexOf('export async function ensureHealthy'));
    expect(fn.indexOf('recoveryRefusal(verdict, state.ownsCommand)')).toBeGreaterThan(-1);
    expect(fn.indexOf('recoveryRefusal(verdict, state.ownsCommand)')).toBeLessThan(fn.indexOf('pressEscape('));
  });

  it('recoverHost refuses on its own re-probe before it quits Premiere', () => {
    const src = source(path.join('lib', 'host-recovery.mjs'));
    const fn = src.slice(src.indexOf('export async function recoverHost'));
    expect(fn.indexOf('recoveryRefusal(pre, ownsCommand)')).toBeGreaterThan(-1);
    expect(fn.indexOf('recoveryRefusal(pre, ownsCommand)')).toBeLessThan(fn.indexOf('killPremiere('));
  });

  it('killPremiere refuses to quit when the guarded save did not save, or the verify step threw', () => {
    const src = source(path.join('lib', 'host-recovery.mjs'));
    const fn = src.slice(src.indexOf('async function killPremiere'), src.indexOf('async function launchPremiereWithScratch'));
    const saveAt = fn.indexOf('guardedSaveScript(state.path)');
    const quitAt = fn.indexOf("'/usr/bin/pkill', ['-f'");
    expect(saveAt).toBeGreaterThan(-1);
    // Both refusals sit between the save and the first pkill, so neither path reaches the quit.
    const between = fn.slice(saveAt, quitAt);
    expect(between).toMatch(/if \(!\(saved && saved\.saved\)\)[\s\S]*?refused: true/);
    expect(between).toMatch(/catch \(error\)[\s\S]*?refused: true/);
    expect(between).not.toMatch(/continuing/);
  });

  it('the post-relaunch loop presses Escape only when recoveryRefusal allows it', () => {
    const src = source(path.join('lib', 'host-recovery.mjs'));
    const fn = src.slice(src.indexOf('export async function recoverHost'), src.indexOf('export async function ensureHealthy'));
    expect(fn).toMatch(/if \(!recoveryRefusal\(verdict, ownsCommand\)\) pressEscape\(1\)/);
  });

  it('probeEngine tells the sentinel which pid is its parent', () => {
    const src = source(path.join('lib', 'host-recovery.mjs'));
    expect(src).toMatch(/PREMIERE_MCP_SENTINEL_PARENT_PID: String\(process\.pid\)/);
  });
});
