/**
 * The live harnesses in scripts/ must refuse to run against a real project.
 *
 * These scripts are not testable end-to-end from here — they need a running Premiere — but the
 * thing most worth pinning does not need one. `scripts/live-verify-cleanup.mjs` deletes every
 * sequence outside a two-name allowlist. Pointed at an editor's cut it destroys 100+ sequences,
 * and the harness that produced this project's fixtures ran against a host that also had a real
 * 111-sequence cut open. The only thing preventing that is one guard call, so the guard's presence
 * is asserted rather than assumed.
 *
 * Partly structural: it proves each harness IMPORTS and CALLS the guard. It does not prove the
 * guard runs before the first mutation — nothing here can. The ordering is enforced by review, and
 * by the guard calling process.exit rather than returning a boolean a caller could ignore.
 *
 * The rest is behavioural. The guard's decisions are driven entirely by what the bridge reports, so
 * running it in a child process against a fake bridge exercises the real code with no Premiere: the
 * assertions below are exit codes and refusal messages the shipped module actually produced, not
 * source text that could keep matching after the logic was gutted.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const GUARD = path.join(SCRIPTS, 'lib', 'require-scratch-project.mjs');

/** Every script in scripts/ that mutates the open project. Adding one here is deliberate. */
const MUTATING_HARNESSES = [
  'live-verify-honesty.mjs',
  'live-verify-cleanup.mjs',
  'reset-scratch.mjs',
  // Had no guard of any kind until 2026-08-26, and it is the one the release bar tells people to run.
  'live-tool-sweep.mjs',
  // Had an inline copy of the guard that was missing 'fixture'.
  'live-smoke-sweep.mjs',
  // Had only a name regex, inline — no path pin and no one-project-open rule — while sweeping
  // destructive tools.
  'coverage-sweep.mjs',
];

describe('mutating live harnesses are gated on a scratch project', () => {
  it.each(MUTATING_HARNESSES)('%s imports and calls the shared guard', (name) => {
    const file = path.join(SCRIPTS, name);
    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, 'utf8');
    // The shared helper specifically — an inline copy is how the doctor scripts drifted apart.
    // Other names may be imported alongside it (live-verify-cleanup also pulls in assertStillScratch),
    // so this pins the source module and the symbol, not the exact shape of the import list.
    expect(source).toMatch(/import \{[^}]*\brequireScratchProject\b[^}]*\} from '\.\/lib\/require-scratch-project\.mjs'/);
    expect(source).toMatch(/await requireScratchProject\(bridge, /);
  });

  it('exits the process rather than returning a value a caller can ignore', () => {
    const source = readFileSync(GUARD, 'utf8');
    expect(source).toMatch(/process\.exit\(2\)/);
  });
});

describe('the shipped scratch-name pattern', () => {
  /**
   * Compiled from the literal in the helper, not restated here. A copy of the regex would keep
   * passing after the shipped one was loosened, which is the only failure that matters.
   */
  const pattern = (() => {
    const source = readFileSync(GUARD, 'utf8');
    const match = source.match(/export const SCRATCH_NAME_PATTERN = (\/.+\/[a-z]*);/);
    if (!match) throw new Error('SCRATCH_NAME_PATTERN is no longer a plain regex literal in require-scratch-project.mjs');
    const body = match[1].slice(1, match[1].lastIndexOf('/'));
    const flags = match[1].slice(match[1].lastIndexOf('/') + 1);
    return new RegExp(body, flags);
  })();

  it.each([
    // Shaped like real production cuts: a show project, a dated picture cut, and a shot file.
    'client_feature_v2.prproj',
    '20260101_SHOW_PC_CUT_V30',
    'SHOW_008_0080.prproj',
  ])('refuses %s', (name) => {
    expect(pattern.test(name)).toBe(false);
  });

  it.each([
    'trowel_scratch.prproj',
    'premiere-mcp-scratch.prproj',
    'Untitled',
    'fixture_bed.prproj',
  ])('allows %s', (name) => {
    expect(pattern.test(name)).toBe(true);
  });
});

/**
 * Run the shipped guard in a child process against a bridge that reports `state`.
 *
 * `pinned` non-null exercises assertStillScratch instead of requireScratchProject, which is the
 * mid-run re-check. On a pass the child prints PASS plus the pinned realpath, so a test can tell
 * "allowed" from "refused for a reason I did not expect".
 */
function runGuard(state: unknown, pinned?: { realpath: string }) {
  const guardUrl = pathToFileURL(GUARD).href;
  const src = `
    import { requireScratchProject, assertStillScratch } from ${JSON.stringify(guardUrl)};
    const bridge = { executeScript: async () => (${JSON.stringify(state)}) };
    const pinned = ${JSON.stringify(pinned ?? null)};
    if (pinned) {
      await assertStillScratch(bridge, pinned, 'unit');
      console.log('PASS');
    } else {
      const r = await requireScratchProject(bridge, 'unit');
      console.log('PASS ' + r.realpath);
    }
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** A real, existing file inside the repo — stands in for a scratch .prproj without creating one. */
const IN_REPO_FILE = path.join(__dirname, '..', '..', '..', 'package.json');
const scratch = (over: Record<string, unknown> = {}) => ({
  count: 1,
  name: 'trowel_scratch.prproj',
  path: IN_REPO_FILE,
  open: [{ name: 'trowel_scratch.prproj', path: IN_REPO_FILE }],
  ...over,
});

describe('requireScratchProject (run for real against a fake bridge)', () => {
  it('allows a single in-repo scratch project', () => {
    const r = runGuard(scratch());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  /**
   * The check the original guard was missing, and the shape of the failure that destroyed a
   * 111-sequence cut: the scratch project was active and passed the name test, while the real cut
   * sat open alongside it waiting for any tool call that omitted a target.
   */
  it('refuses when a second project is open, even though the ACTIVE one is scratch', () => {
    const r = runGuard(scratch({
      count: 2,
      open: [
        { name: 'trowel_scratch.prproj', path: IN_REPO_FILE },
        { name: 'client_feature_v2.prproj', path: '/Users/somebody/cuts/client_feature_v2.prproj' },
      ],
    }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/2 projects are open/);
    // The refusal has to name the project at risk, or the operator cannot act on it.
    expect(r.stderr).toContain('client_feature_v2.prproj');
  });

  it('refuses a scratch-NAMED project whose file lives outside the repo', () => {
    const r = runGuard(scratch({ name: 'colour_test.prproj', path: '/etc/hosts' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/outside this repo/);
  });

  it('refuses an in-repo file carrying a real cut name', () => {
    const r = runGuard(scratch({ name: 'client_feature_v2.prproj' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a scratch project name/);
  });

  it('refuses an unsaved project rather than trusting its name', () => {
    const r = runGuard(scratch({ name: 'Untitled', path: '' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/never been saved/);
  });

  it('refuses a path that does not exist on this machine', () => {
    const r = runGuard(scratch({ path: path.join(path.dirname(IN_REPO_FILE), 'no_such_scratch.prproj') }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/does not exist/);
  });

  it('refuses when no project is open', () => {
    const r = runGuard({ count: 0, name: '', path: '', open: [] });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no project is open/);
  });

  it('treats a failed probe as a refusal, not a pass', () => {
    const r = runGuard({ success: false, error: 'panel heartbeat stale' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not read/);
    expect(r.stderr).toContain('panel heartbeat stale');
  });
});

describe('assertStillScratch (the mid-run re-check)', () => {
  it('passes while the pinned project is still the only one open', () => {
    const r = runGuard(scratch(), { realpath: IN_REPO_FILE });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('refuses once the active project has drifted to a different file', () => {
    const r = runGuard(scratch(), { realpath: path.join(path.dirname(IN_REPO_FILE), 'README.md') });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/drifted mid-run/);
  });

  it('refuses once a second project has appeared mid-run', () => {
    const r = runGuard(scratch({ count: 2 }), { realpath: IN_REPO_FILE });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/changed to 2/);
  });
});

describe('the destructive cleanup harness re-pins before every delete', () => {
  /**
   * live-verify-cleanup.mjs deletes sequences in a loop that can run for minutes. A startup-only
   * check cannot speak for the state at delete number twenty, so the re-check has to be INSIDE the
   * loop — pinned here because moving it out would be invisible in review.
   */
  it('calls assertStillScratch inside the delete loop', () => {
    const source = readFileSync(path.join(SCRIPTS, 'live-verify-cleanup.mjs'), 'utf8');
    const loop = source.slice(source.indexOf('for (const s of doomed)'), source.indexOf("delete_sequence', {"));
    expect(loop).toMatch(/await assertStillScratch\(bridge, pinned, /);
  });
});
