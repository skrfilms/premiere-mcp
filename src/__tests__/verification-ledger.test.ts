/**
 * The live-verification ledger must stay the only source of a "verified live" claim.
 *
 * Before this suite, "verified live against Premiere 26.3" existed only in commit messages and
 * prose. Nothing could check it, nothing recorded WHICH tools were exercised, and nothing made
 * it go stale visibly — which is the same failure mode as a hardcoded tool count, one layer up:
 * a claim the agent (and the reader) cannot verify and cannot detect the rot in.
 *
 * So: sweeps write files, docs/LIVE-VERIFICATION.md is generated from those files, and these
 * tests fail if the document and the ledger ever disagree. You cannot promote a tool to
 * "verified" by editing the doc.
 *
 * No bridge, no host. Text in, text out.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LedgerFormatError,
  OUTCOMES,
  OUTCOME_LABEL,
  currentStandings,
  renderVerificationReport,
  validateSweep,
  type Sweep,
} from '../verification/ledger.js';
import { PremiereProTools } from '../tools/index.js';

const REPO_ROOT = join(__dirname, '..', '..');
const SWEEP_DIR = join(REPO_ROOT, 'verification', 'sweeps');
const DOC = join(REPO_ROOT, 'docs', 'LIVE-VERIFICATION.md');

const noBridge = {
  executeScript: async () => {
    throw new Error('ledger tests must not touch the bridge');
  },
} as any;

/**
 * The whole catalogue, not the active profile's slice of it. The profile decides what an agent
 * sees; it has nothing to do with what has been verified, and using it as the denominator would
 * turn a sweep of the 104 core tools into "full coverage" of a 647-tool build.
 */
function catalogueNames(): string[] {
  return new PremiereProTools(noBridge).getRegisteredTools().map((t) => t.name);
}

function sweepFiles(): string[] {
  return existsSync(SWEEP_DIR)
    ? readdirSync(SWEEP_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
}

function loadSweeps(): Sweep[] {
  return sweepFiles().map((f) =>
    validateSweep(JSON.parse(readFileSync(join(SWEEP_DIR, f), 'utf8')), f),
  );
}

describe('verification ledger files', () => {
  it('every sweep file parses and satisfies the schema', () => {
    // validateSweep throws with the filename, so a malformed entry names itself.
    expect(() => loadSweeps()).not.toThrow();
  });

  it('rejects a sweep that invents an outcome, so a typo cannot become evidence', () => {
    const bad = { environment: null, tools: [] };
    expect(() => validateSweep(bad, 'bad.json')).toThrow(LedgerFormatError);
    const env = {
      ranAt: '2026-08-27T00:00:00Z',
      harness: 'h',
      mode: 'read-only',
      gitSha: 'abc',
      gitDirty: false,
      premiereVersion: null,
      platform: 'darwin',
      catalogueSize: 1,
    };
    expect(() =>
      validateSweep(
        { environment: env, tools: [{ name: 'ping', outcome: 'probably_fine' }] },
        'x.json',
      ),
    ).toThrow(/is not one of/);
    expect(() =>
      validateSweep({ environment: { ...env, ranAt: 'yesterday' }, tools: [] }, 'x.json'),
    ).toThrow(/ranAt/);
    expect(() =>
      validateSweep({ environment: { ...env, mode: 'sort-of' }, tools: [] }, 'x.json'),
    ).toThrow(/mode/);
  });

  it('the newest sweep wins per tool, even when it is a skip', () => {
    const env = (ranAt: string) => ({
      ranAt,
      harness: 'h',
      mode: 'read-only' as const,
      gitSha: 'abc',
      gitDirty: false,
      premiereVersion: null,
      platform: 'darwin',
      catalogueSize: 1,
    });
    const standings = currentStandings([
      { environment: env('2026-08-01T00:00:00Z'), tools: [{ name: 'ping', outcome: 'pass' }] },
      {
        environment: env('2026-08-20T00:00:00Z'),
        tools: [{ name: 'ping', outcome: 'skipped_unsafe', detail: 'r' }],
      },
    ]);
    // "We last looked on the 20th and did not run it" is the true statement; an older pass
    // must not mask a tool nobody exercises any more.
    expect(standings.get('ping')?.outcome).toBe('skipped_unsafe');
    expect(standings.get('ping')?.ranAt).toBe('2026-08-20T00:00:00Z');
  });

  it('names every sweep tool that is not in the catalogue rather than dropping it', () => {
    const names = new Set(catalogueNames());
    const orphans = new Set<string>();
    for (const sweep of loadSweeps()) {
      for (const t of sweep.tools) if (!names.has(t.name)) orphans.add(t.name);
    }
    // Orphans are allowed (a tool can be renamed after a sweep) but must be surfaced in the doc.
    if (orphans.size && existsSync(DOC)) {
      const doc = readFileSync(DOC, 'utf8');
      for (const name of orphans) expect(doc).toContain(`\`${name}\``);
    }
  });
});

describe('docs/LIVE-VERIFICATION.md', () => {
  it('exists', () => {
    expect(existsSync(DOC)).toBe(true);
  });

  it('is exactly what the ledger renders — a hand-edited claim fails here', () => {
    // This is the load-bearing assertion of the whole mechanism: the document is a pure
    // function of verification/sweeps/*.json plus the catalogue, so it cannot say anything a
    // sweep did not observe. Regenerate with `npm run verify:report`.
    expect(readFileSync(DOC, 'utf8')).toBe(
      renderVerificationReport(loadSweeps(), catalogueNames()),
    );
  });

  it('reports the never-exercised count instead of only what passed', () => {
    const doc = readFileSync(DOC, 'utf8');
    const sweeps = loadSweeps();
    if (!sweeps.length) {
      expect(doc).toMatch(/No sweep has ever been recorded/);
      return;
    }
    // Never EXECUTED, not merely never mentioned: a sweep files a row for every catalogue tool,
    // so counting the absent ones would print 0 over a run that executed 27% of the catalogue.
    const standings = currentStandings(sweeps);
    const never = catalogueNames().filter((n) => {
      const s = standings.get(n);
      return !s || (s.outcome !== 'pass' && s.outcome !== 'fail');
    }).length;
    expect(doc).toContain(`| **never executed live** | **${never}** |`);
  });

  it('claims a live standing only for tools a sweep actually recorded', () => {
    const doc = readFileSync(DOC, 'utf8');
    const standings = currentStandings(loadSweeps());
    const rows = [...doc.matchAll(/^\| `([a-z0-9_]+)` \| ([^|]+) \|/gm)];
    const claimed = rows
      .filter((m) => !m[2]!.includes('absent from every sweep'))
      .map((m) => m[1]!);
    for (const name of claimed) expect(standings.has(name)).toBe(true);
  });

  it('labels itself generated, so nobody edits it by hand in good faith', () => {
    expect(readFileSync(DOC, 'utf8')).toMatch(/GENERATED FILE\. Do not edit by hand/);
  });
});

describe('outcome vocabulary', () => {
  it('keeps the not-executed outcomes distinguishable from a pass', () => {
    // Collapsing skips into "pass" or dropping them entirely is how a 40%-coverage sweep
    // starts reading as a green checkmark.
    expect(OUTCOMES).toEqual([
      'pass',
      'fail',
      'skipped_args',
      'skipped_unsafe',
      'skipped_wedged',
      'deferred_mutating',
    ]);
  });

  it('does not count a wedge-rejected tool as evidence about that tool', () => {
    // A wedged panel rejects a call without running it and says so. Filing that as `fail` turned
    // one wedge into 347 fabricated failures on 2026-08-31, so `skipped_wedged` must stay on the
    // not-executed side of the ledger — never `pass`, and never `fail`.
    expect(OUTCOMES).toContain('skipped_wedged');
    expect(OUTCOME_LABEL.skipped_wedged).toMatch(/not executed/);
  });
});
