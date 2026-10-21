/**
 * The test-coverage ledger: which tools anything has ever actually run.
 *
 * There are two independent ways a tool in this catalogue can be exercised, and collapsing them
 * is how a build starts overstating itself:
 *
 *   - the test suite dispatches it against a MOCK bridge. That proves it is reachable, that its
 *     schema accepts the arguments, and that it emits something. It proves nothing about Premiere.
 *   - a sweep dispatches it against a LIVE host. That is the only evidence about Premiere, and it
 *     lives in verification/sweeps/ (see ./ledger.ts).
 *
 * This module reports both axes side by side and names the intersection that matters: tools that
 * NEITHER the suite nor any sweep has ever run. Those are shipped on the strength of a code review
 * and nothing else, and the number belongs in a document rather than in a maintainer's head.
 *
 * The measurement is instrumented, not grepped. `src/__tests__/tool-coverage-probe.ts` wraps the
 * dispatcher and records real invocations; grepping test files for tool names both over-counts
 * (a name in a table of expected strings is not a call) and under-counts (a name built at runtime
 * never appears as a literal).
 *
 * Pure and deterministic, like ./ledger.ts: same input, same bytes, no timestamps. That is what
 * lets a test regenerate the document and compare, which is what makes it unfalsifiable by hand.
 */

/** One tool's test-suite standing. `testFiles` is sorted and repo-relative. */
export interface ToolTestRecord {
  name: string;
  testFiles: string[];
}

export interface TestCoverage {
  /** Every tool the instrumented run dispatched, sorted by name. */
  tools: ToolTestRecord[];
  /** Catalogue size at measurement time, so shrinkage or growth is visible. */
  catalogueSize: number;
  /** Commit the run measured, and whether the tree was dirty. */
  gitSha: string;
  gitDirty: boolean;
  /** Number of test files that dispatched at least one tool. */
  testFileCount: number;
}

/** Thrown with the source named, so a malformed coverage file is never silently treated as zero. */
export class CoverageFormatError extends Error {}

/** Validate a parsed test-coverage file. Rejects rather than coercing. */
export function validateTestCoverage(value: unknown, source: string): TestCoverage {
  const fail = (why: string): never => {
    throw new CoverageFormatError(`${source}: ${why}`);
  };
  if (typeof value !== 'object' || value === null) return fail('not an object');
  const raw = value as Record<string, unknown>;
  for (const key of ['catalogueSize', 'testFileCount'] as const) {
    if (typeof raw[key] !== 'number') return fail(`${key} must be a number`);
  }
  if (typeof raw['gitSha'] !== 'string' || !raw['gitSha']) return fail('gitSha must be a non-empty string');
  if (typeof raw['gitDirty'] !== 'boolean') return fail('gitDirty must be a boolean');
  const tools = raw['tools'];
  if (!Array.isArray(tools)) return fail('missing "tools" array');
  const seen = new Set<string>();
  const records: ToolTestRecord[] = tools.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) return fail(`tools[${i}] is not an object`);
    const t = entry as Record<string, unknown>;
    if (typeof t['name'] !== 'string' || !t['name']) return fail(`tools[${i}].name must be a non-empty string`);
    if (seen.has(t['name'])) return fail(`tools[${i}] repeats ${t['name']}`);
    seen.add(t['name']);
    const files = t['testFiles'];
    if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
      return fail(`tools[${i}].testFiles must be an array of strings`);
    }
    return { name: t['name'], testFiles: files as string[] };
  });
  return {
    tools: records,
    catalogueSize: raw['catalogueSize'] as number,
    gitSha: raw['gitSha'] as string,
    gitDirty: raw['gitDirty'] as boolean,
    testFileCount: raw['testFileCount'] as number,
  };
}

export interface CoverageInputs {
  coverage: TestCoverage | null;
  /** Tools some sweep has actually EXECUTED live (pass or fail). Skips are not evidence. */
  executedLive: Set<string>;
  /** The whole registered catalogue. */
  catalogue: string[];
}

/**
 * Render `docs/TOOL-COVERAGE.md`.
 *
 * The headline is deliberately the pessimistic number — tools nothing has run — because that is
 * the one a reader cannot get anywhere else and the one a maintainer is tempted to leave out.
 */
export function renderCoverageReport(inputs: CoverageInputs): string {
  const names = [...inputs.catalogue].sort();
  const byTool = new Map<string, string[]>();
  for (const t of inputs.coverage?.tools ?? []) byTool.set(t.name, t.testFiles);

  const inSuite = (n: string): boolean => byTool.has(n);
  const isLive = (n: string): boolean => inputs.executedLive.has(n);
  const neither = names.filter((n) => !inSuite(n) && !isLive(n));
  const both = names.filter((n) => inSuite(n) && isLive(n));
  const suiteOnly = names.filter((n) => inSuite(n) && !isLive(n));
  const liveOnly = names.filter((n) => !inSuite(n) && isLive(n));
  // Names the probe recorded that no longer exist in the catalogue. Some are deliberate negative
  // paths (`unknown_tool`, a misspelling that exercises the did-you-mean suggester); a real one
  // would be a tool deleted since the run. Either way the count must be stated rather than
  // dropped: 650 recorded names against a 647-tool catalogue reads as an arithmetic error unless
  // the difference is on the page.
  const offCatalogue = [...byTool.keys()].filter((n) => !names.includes(n)).sort();
  const pct = (n: number): string => (names.length ? ((n / names.length) * 100).toFixed(1) : '0.0');

  const L: string[] = [];
  L.push('# Tool coverage');
  L.push('');
  L.push('<!-- GENERATED FILE. Do not edit by hand: `npm run coverage:tools` rewrites it from');
  L.push('     verification/test-coverage.json and verification/sweeps/*.json, and a test fails when');
  L.push('     this file and that data disagree. To change what it says, exercise a tool. -->');
  L.push('');
  L.push('Two independent axes, kept apart on purpose:');
  L.push('');
  L.push('- **suite** — the test suite dispatched this tool against a mock bridge. It is reachable,');
  L.push('  its schema accepts arguments, and it emits something. This says nothing about Premiere.');
  L.push('- **live** — a sweep dispatched it against a running Premiere host and recorded a pass or a');
  L.push('  fail. This is the only evidence about Premiere. See [LIVE-VERIFICATION.md](LIVE-VERIFICATION.md).');
  L.push('');
  if (!inputs.coverage) {
    L.push('**No instrumented test run has been recorded.** `verification/test-coverage.json` is');
    L.push('missing, so the suite axis below is empty — that is missing data, not zero coverage.');
    L.push('');
  }
  L.push('## Headline');
  L.push('');
  L.push(`Catalogue: **${names.length}** tools.`);
  L.push('');
  L.push('| standing | tools | share of catalogue |');
  L.push('| --- | --- | --- |');
  L.push(`| **nothing has ever run it** | **${neither.length}** | **${pct(neither.length)}%** |`);
  L.push(`| run by the suite and live | ${both.length} | ${pct(both.length)}% |`);
  L.push(`| run by the suite only (mock host) | ${suiteOnly.length} | ${pct(suiteOnly.length)}% |`);
  L.push(`| run live only | ${liveOnly.length} | ${pct(liveOnly.length)}% |`);
  L.push('');
  L.push('A tool in the first row is shipped on the strength of a code review and a schema. It may');
  L.push('well work; nothing here is evidence that it does.');
  L.push('');
  if (inputs.coverage) {
    L.push('## The measured run');
    L.push('');
    L.push(`- commit: \`${inputs.coverage.gitSha}\`${inputs.coverage.gitDirty ? ' **with uncommitted changes in the tree**' : ''}`);
    L.push(`- catalogue at measurement: ${inputs.coverage.catalogueSize}`);
    L.push(`- test files that dispatched at least one tool: ${inputs.coverage.testFileCount}`);
    L.push('');
    L.push('Measured by instrumenting the dispatcher, not by grepping test files for tool names:');
    L.push('a name in a table of expected strings is not a call, and a name assembled at runtime is');
    L.push('not a literal. Both errors are silent.');
    L.push('');
    if (inputs.coverage.catalogueSize !== names.length) {
      L.push(`The catalogue was **${inputs.coverage.catalogueSize}** tools when this was measured and is`);
      L.push(`**${names.length}** now, so the suite axis is stale. Re-run \`npm run coverage:tools\`.`);
      L.push('');
    }
  }
  L.push('## Tools nothing has ever run');
  L.push('');
  if (!neither.length) {
    L.push('None. Every tool in the catalogue has been dispatched by the suite, by a live sweep, or both.');
  } else {
    for (const n of neither) L.push(`- \`${n}\``);
  }
  L.push('');
  if (offCatalogue.length) {
    L.push('## Recorded names that are not tools in this catalogue');
    L.push('');
    L.push(`The instrumented run dispatched ${offCatalogue.length} name(s) that the catalogue does not`);
    L.push('contain. They are excluded from every count above. Expect deliberate negative paths here');
    L.push('(an unknown name, a misspelling that exercises the suggester); anything else is a tool');
    L.push('that was removed after the run, and the run is stale.');
    L.push('');
    for (const n of offCatalogue) L.push(`- \`${n}\``);
    L.push('');
  }
  L.push('## Per-tool standing');
  L.push('');
  L.push('| tool | suite | live | test files |');
  L.push('| --- | --- | --- | --- |');
  for (const name of names) {
    const files = byTool.get(name);
    const suiteCell = files ? `yes (${files.length})` : 'no';
    const fileCell = files ? files.map((f) => `\`${f}\``).join(', ') : '';
    L.push(`| \`${name}\` | ${suiteCell} | ${isLive(name) ? 'yes' : 'no'} | ${fileCell} |`);
  }
  L.push('');
  return L.join('\n') + '\n';
}
