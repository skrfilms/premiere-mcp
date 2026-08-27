/**
 * The live-verification ledger.
 *
 * This project's whole claim is that it does not lie about what it has done, and yet the
 * evidence for "verified against a live Premiere host" lived in commit messages and prose.
 * A sentence cannot be re-read by a machine, cannot say WHICH tools were exercised, cannot
 * say when, and cannot go stale visibly. So the sweep harnesses now write a machine-readable
 * record into `verification/sweeps/`, one file per run, and the human-readable summary in
 * `docs/LIVE-VERIFICATION.md` is GENERATED from those files rather than written by hand.
 *
 * Two properties make that worth something:
 *
 *  1. The report is a pure function of the ledger plus the catalogue. A test regenerates it
 *     and compares, so a hand-edited claim in the doc fails CI. You cannot promote a tool to
 *     "verified" by typing it.
 *  2. Absence is reported. Every tool no sweep has ever RUN is counted as never executed live --
 *     a skip is not evidence, and a sweep files a row for every tool in the catalogue, so
 *     counting only the unmentioned ones would report 0 over a run that executed a quarter of
 *     them. Every skip carries the reason it was skipped. A sweep that covered 27% of the
 *     catalogue must read as 27%, not as a green checkmark.
 *
 * Nothing here touches a host or a bridge; it is text in, text out.
 */

/** What a sweep observed for one tool. Ordered worst-evidence-last for reporting. */
export type ToolOutcome =
  /** Invoked against the live host; the tool reported success. */
  | 'pass'
  /** Invoked against the live host; the tool reported failure or threw. */
  | 'fail'
  /** Not invoked: the harness could not synthesise the required arguments. */
  | 'skipped_args'
  /** Not invoked: destructive, dialog-blocking, long-running or reaches an external service. */
  | 'skipped_unsafe'
  /** Not invoked: mutating, and the sweep ran without --mutate. */
  | 'deferred_mutating';

export const OUTCOMES: ToolOutcome[] = [
  'pass',
  'fail',
  'skipped_args',
  'skipped_unsafe',
  'deferred_mutating',
];

/** Prose for each outcome. Deliberately blunt about the ones that are NOT evidence. */
export const OUTCOME_LABEL: Record<ToolOutcome, string> = {
  pass: 'executed live, reported success',
  fail: 'executed live, FAILED',
  skipped_args: 'not executed — harness could not build arguments',
  skipped_unsafe: 'not executed — unsafe for an unattended sweep',
  deferred_mutating: 'not executed — mutating, sweep was read-only',
};

export interface SweepEnvironment {
  /** UTC ISO-8601, seconds precision. The date the claim is anchored to. */
  ranAt: string;
  /** The harness that produced this file, e.g. "live-smoke-sweep". */
  harness: string;
  /** "read-only" or "mutate". A read-only sweep proves nothing about mutating tools. */
  mode: 'read-only' | 'mutate';
  /** Commit the sweep ran against, and whether the tree had uncommitted changes. */
  gitSha: string;
  gitDirty: boolean;
  /** What the host reported for itself, or null when it could not be asked. */
  premiereVersion: string | null;
  /** Host platform, e.g. "darwin 25.5.0 arm64". */
  platform: string;
  /** Size of the catalogue at the time, so shrinkage or growth is visible. */
  catalogueSize: number;
}

export interface SweepToolRecord {
  name: string;
  outcome: ToolOutcome;
  /** Why it was skipped, or the error for a failure. Absent for a plain pass. */
  detail?: string;
  /**
   * The tool's own `verified` field, when it has one. A tool that returns
   * `verified:false` succeeded as a call and still proved nothing about the host state,
   * which is a distinction the pass/fail axis cannot carry on its own.
   */
  verified?: boolean;
}

export interface Sweep {
  environment: SweepEnvironment;
  tools: SweepToolRecord[];
}

/** Thrown with the offending file named, so a malformed ledger entry is never silently dropped. */
export class LedgerFormatError extends Error {}

const OUTCOME_SET = new Set<string>(OUTCOMES);

/** Validate one parsed sweep file. Rejects rather than coercing: a bad record is not evidence. */
export function validateSweep(value: unknown, source: string): Sweep {
  const fail = (why: string): never => {
    throw new LedgerFormatError(`${source}: ${why}`);
  };
  if (typeof value !== 'object' || value === null) return fail('not an object');
  const raw = value as Record<string, unknown>;
  const env = raw['environment'];
  if (typeof env !== 'object' || env === null) return fail('missing "environment"');
  const e = env as Record<string, unknown>;
  for (const key of ['ranAt', 'harness', 'mode', 'gitSha', 'platform'] as const) {
    if (typeof e[key] !== 'string' || !(e[key] as string)) return fail(`environment.${key} must be a non-empty string`);
  }
  if (e['mode'] !== 'read-only' && e['mode'] !== 'mutate') return fail('environment.mode must be "read-only" or "mutate"');
  if (typeof e['gitDirty'] !== 'boolean') return fail('environment.gitDirty must be a boolean');
  if (typeof e['catalogueSize'] !== 'number') return fail('environment.catalogueSize must be a number');
  if (e['premiereVersion'] !== null && typeof e['premiereVersion'] !== 'string') {
    return fail('environment.premiereVersion must be a string or null');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e['ranAt'] as string)) {
    return fail('environment.ranAt must be UTC ISO-8601 to the second, e.g. 2026-08-27T18:04:00Z');
  }
  const tools = raw['tools'];
  if (!Array.isArray(tools)) return fail('missing "tools" array');
  const seen = new Set<string>();
  const records: SweepToolRecord[] = tools.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) return fail(`tools[${i}] is not an object`);
    const t = entry as Record<string, unknown>;
    if (typeof t['name'] !== 'string' || !t['name']) return fail(`tools[${i}].name must be a non-empty string`);
    if (typeof t['outcome'] !== 'string' || !OUTCOME_SET.has(t['outcome'])) {
      return fail(`tools[${i}].outcome ${JSON.stringify(t['outcome'])} is not one of ${OUTCOMES.join(', ')}`);
    }
    if (seen.has(t['name'])) return fail(`tools[${i}] repeats ${t['name']}`);
    seen.add(t['name']);
    const record: SweepToolRecord = { name: t['name'], outcome: t['outcome'] as ToolOutcome };
    if (typeof t['detail'] === 'string' && t['detail']) record.detail = t['detail'];
    if (typeof t['verified'] === 'boolean') record.verified = t['verified'];
    return record;
  });
  return { environment: e as unknown as SweepEnvironment, tools: records };
}

export interface ToolStanding extends SweepToolRecord {
  /** The sweep this standing came from. */
  ranAt: string;
  harness: string;
  gitSha: string;
}

/**
 * The current standing per tool: the newest sweep that has anything to say about it.
 *
 * Newest wins outright — a later sweep that skipped a tool supersedes an earlier pass,
 * because "we last looked on date X and did not run it" is the true statement. Ranking
 * passes above skips would let an old success mask a tool nobody exercises any more.
 */
export function currentStandings(sweeps: Sweep[]): Map<string, ToolStanding> {
  const byNewest = [...sweeps].sort((a, b) => a.environment.ranAt.localeCompare(b.environment.ranAt));
  const out = new Map<string, ToolStanding>();
  for (const sweep of byNewest) {
    for (const record of sweep.tools) {
      out.set(record.name, {
        ...record,
        ranAt: sweep.environment.ranAt,
        harness: sweep.environment.harness,
        gitSha: sweep.environment.gitSha,
      });
    }
  }
  return out;
}

function countBy(standings: Map<string, ToolStanding>): Record<ToolOutcome, number> {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<ToolOutcome, number>;
  for (const s of standings.values()) counts[s.outcome] += 1;
  return counts;
}

/**
 * Render `docs/LIVE-VERIFICATION.md`.
 *
 * Pure and deterministic: same ledger plus same catalogue gives the same bytes, with no
 * generation timestamp. That is what lets a test regenerate and compare, which in turn is
 * what makes the document unfalsifiable by hand.
 */
export function renderVerificationReport(sweeps: Sweep[], catalogue: string[]): string {
  const standings = currentStandings(sweeps);
  const names = [...catalogue].sort();
  const known = new Set(names);
  // "Never executed live" means no sweep has ever RUN it -- not merely that no sweep mentions
  // it. A sweep records a row for every catalogue tool, most of them skips, so counting only
  // the absent ones would print "never exercised: 0" over a run that executed 27% of the
  // catalogue. Absence from the ledger entirely is a separate, smaller fact.
  const never = names.filter((n) => {
    const s = standings.get(n);
    return !s || (s.outcome !== 'pass' && s.outcome !== 'fail');
  });
  const unmentioned = names.filter((n) => !standings.has(n));
  const counts = countBy(standings);
  const executed = counts.pass + counts.fail;
  const pct = (n: number): string => (names.length ? ((n / names.length) * 100).toFixed(1) : '0.0');
  const newest = [...sweeps].sort((a, b) => b.environment.ranAt.localeCompare(a.environment.ranAt))[0];
  const orphans = [...standings.keys()].filter((n) => !known.has(n)).sort();

  const L: string[] = [];
  L.push('# Live verification ledger');
  L.push('');
  L.push('<!-- GENERATED FILE. Do not edit by hand: `npm run verify:report` rewrites it from');
  L.push('     verification/sweeps/*.json, and a test fails when this file and the ledger disagree.');
  L.push('     To change what it says, run a sweep. -->');
  L.push('');
  L.push('Every claim below comes from a sweep that actually ran against a live Premiere host and');
  L.push('wrote a file. Tools nobody has executed live are counted and named, not omitted.');
  L.push('');
  if (!newest) {
    L.push('**No sweep has ever been recorded.** `verification/sweeps/` is empty, so this build has');
    L.push(`no live evidence for any of its ${names.length} tools.`);
    L.push('');
    return L.join('\n') + '\n';
  }
  L.push('## Newest sweep');
  L.push('');
  L.push(`- ran at: **${newest.environment.ranAt}**`);
  L.push(`- harness: \`${newest.environment.harness}\` (${newest.environment.mode})`);
  L.push(`- commit: \`${newest.environment.gitSha}\`${newest.environment.gitDirty ? ' **with uncommitted changes in the tree**' : ''}`);
  L.push(`- Premiere: ${newest.environment.premiereVersion ?? '_host did not answer_'}`);
  L.push(`- platform: ${newest.environment.platform}`);
  L.push('');
  L.push('## Coverage');
  L.push('');
  L.push(`Catalogue: **${names.length}** tools. Sweeps on record: **${sweeps.length}**.`);
  L.push('');
  L.push('| standing | tools | share of catalogue |');
  L.push('| --- | --- | --- |');
  L.push(`| **executed live** | **${executed}** | **${pct(executed)}%** |`);
  L.push(`| **never executed live** | **${never.length}** | **${pct(never.length)}%** |`);
  L.push('');
  L.push('Broken down. Only the first two rows are evidence about a tool; the rest record that we');
  L.push('looked and did not run it, and why.');
  L.push('');
  L.push('| standing | tools | share of catalogue |');
  L.push('| --- | --- | --- |');
  for (const o of OUTCOMES) {
    L.push(`| ${OUTCOME_LABEL[o]} | ${counts[o]} | ${pct(counts[o])}% |`);
  }
  L.push(`| absent from every sweep | ${unmentioned.length} | ${pct(unmentioned.length)}% |`);
  L.push('');
  const unverified = [...standings.values()].filter((s) => s.outcome === 'pass' && s.verified === false);
  if (unverified.length) {
    L.push(`Of the ${counts.pass} tools that passed, **${unverified.length}** returned \`verified:false\` —`);
    L.push('the call succeeded and the effect was not confirmed, so they are not evidence of an effect:');
    L.push('');
    for (const s of unverified.sort((a, b) => a.name.localeCompare(b.name))) L.push(`- \`${s.name}\``);
    L.push('');
  }
  const failures = [...standings.values()].filter((s) => s.outcome === 'fail');
  L.push('## Failures on record');
  L.push('');
  if (!failures.length) {
    L.push('None in the newest standing for any tool.');
  } else {
    L.push('| tool | last seen | error |');
    L.push('| --- | --- | --- |');
    for (const s of failures.sort((a, b) => a.name.localeCompare(b.name))) {
      L.push(`| \`${s.name}\` | ${s.ranAt} | ${(s.detail ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`);
    }
  }
  L.push('');
  L.push('## Per-tool standing');
  L.push('');
  L.push('| tool | standing | last looked | sweep | note |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const name of names) {
    const s = standings.get(name);
    if (!s) {
      L.push(`| \`${name}\` | absent from every sweep | — | — | |`);
      continue;
    }
    const note = (s.detail ?? '').replace(/\|/g, '\\|').slice(0, 120);
    const verified = s.verified === undefined ? '' : ` (verified:${s.verified})`;
    L.push(`| \`${name}\` | ${OUTCOME_LABEL[s.outcome]}${verified} | ${s.ranAt} | \`${s.harness}\` | ${note} |`);
  }
  L.push('');
  if (orphans.length) {
    L.push('## Ledger entries with no matching tool');
    L.push('');
    L.push('These names appear in a sweep but not in the current catalogue — renamed or removed since.');
    L.push('');
    for (const n of orphans) L.push(`- \`${n}\``);
    L.push('');
  }
  L.push('## Sweeps on record');
  L.push('');
  L.push('| ran at | harness | mode | commit | Premiere | tools recorded |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const s of [...sweeps].sort((a, b) => b.environment.ranAt.localeCompare(a.environment.ranAt))) {
    const e = s.environment;
    L.push(`| ${e.ranAt} | \`${e.harness}\` | ${e.mode} | \`${e.gitSha}\`${e.gitDirty ? ' (dirty)' : ''} | ${e.premiereVersion ?? '—'} | ${s.tools.length} |`);
  }
  L.push('');
  return L.join('\n') + '\n';
}
