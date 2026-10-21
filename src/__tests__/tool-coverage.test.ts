/**
 * docs/TOOL-COVERAGE.md must stay a function of measured data, not of a maintainer's confidence.
 *
 * The number this document exists to publish — how much of a 647-tool catalogue anything has ever
 * actually run — is exactly the kind of claim that rots silently. It was previously answered by
 * grepping test files for tool names, which is wrong in both directions at once: a name sitting in
 * a table of expected strings is not a call, and a name assembled at runtime never appears as a
 * literal. So the suite measures itself (src/__tests__/tool-coverage-probe.ts wraps the dispatcher),
 * the measurement is committed as verification/test-coverage.json, and this suite byte-compares the
 * document against it. Editing the document to say something nicer fails here.
 *
 * Same shape and same reason as verification-ledger.test.ts. No bridge, no host: text in, text out.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CoverageFormatError,
  renderCoverageReport,
  validateTestCoverage,
  type TestCoverage,
} from '../verification/coverage.js';
import { currentStandings, validateSweep, type Sweep } from '../verification/ledger.js';
import { readdirSync } from 'node:fs';
import { PremiereProTools } from '../tools/index.js';

const REPO_ROOT = join(__dirname, '..', '..');
const DATA = join(REPO_ROOT, 'verification', 'test-coverage.json');
const SWEEP_DIR = join(REPO_ROOT, 'verification', 'sweeps');
const DOC = join(REPO_ROOT, 'docs', 'TOOL-COVERAGE.md');

const noBridge = {
  executeScript: async () => {
    throw new Error('coverage tests must not touch the bridge');
  },
} as any;

/** The whole registered catalogue, not the active profile — see the note in ledger.test.ts. */
function catalogueNames(): string[] {
  return new PremiereProTools(noBridge).getRegisteredTools().map((t) => t.name);
}

function loadCoverage(): TestCoverage | null {
  if (!existsSync(DATA)) return null;
  return validateTestCoverage(JSON.parse(readFileSync(DATA, 'utf8')), 'verification/test-coverage.json');
}

function loadSweeps(): Sweep[] {
  if (!existsSync(SWEEP_DIR)) return [];
  return readdirSync(SWEEP_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => validateSweep(JSON.parse(readFileSync(join(SWEEP_DIR, f), 'utf8')), f));
}

/** Only a pass or a fail is evidence a live host ran it. A skip is a row, not a run. */
function executedLive(): Set<string> {
  const out = new Set<string>();
  for (const [name, standing] of currentStandings(loadSweeps())) {
    if (standing.outcome === 'pass' || standing.outcome === 'fail') out.add(name);
  }
  return out;
}

describe('verification/test-coverage.json', () => {
  it('parses and satisfies the schema', () => {
    expect(() => loadCoverage()).not.toThrow();
  });

  it('rejects a malformed file rather than reading it as zero coverage', () => {
    // The dangerous failure is the quiet one: a truncated or renamed field that parses as "no
    // tools measured" would publish a far better-looking number than the truth.
    expect(() => validateTestCoverage(null, 'x')).toThrow(CoverageFormatError);
    expect(() => validateTestCoverage({ tools: [] }, 'x')).toThrow(/catalogueSize/);
    const base = { catalogueSize: 1, testFileCount: 1, gitSha: 'abc', gitDirty: false };
    expect(() => validateTestCoverage({ ...base }, 'x')).toThrow(/tools/);
    expect(() => validateTestCoverage({ ...base, tools: [{ name: 'ping' }] }, 'x')).toThrow(/testFiles/);
    expect(() => validateTestCoverage(
      { ...base, tools: [{ name: 'ping', testFiles: [] }, { name: 'ping', testFiles: [] }] }, 'x',
    )).toThrow(/repeats ping/);
  });

  it('attributes every record to a test file, so a row cannot be evidence of nothing', () => {
    const coverage = loadCoverage();
    if (!coverage) return;
    for (const record of coverage.tools) expect(record.testFiles.length).toBeGreaterThan(0);
  });
});

describe('docs/TOOL-COVERAGE.md', () => {
  it('exists', () => {
    expect(existsSync(DOC)).toBe(true);
  });

  it('is exactly what the coverage data renders — a hand-edited claim fails here', () => {
    // The load-bearing assertion. Regenerate with `npm run coverage:tools`; to change what it
    // says, exercise a tool.
    expect(readFileSync(DOC, 'utf8')).toBe(renderCoverageReport({
      coverage: loadCoverage(),
      executedLive: executedLive(),
      catalogue: catalogueNames(),
    }));
  });

  it('keeps the suite axis and the live axis apart', () => {
    // Collapsing them is the specific overstatement this document exists to prevent: a mock-bridge
    // dispatch proves reachability and nothing whatsoever about Premiere.
    const doc = readFileSync(DOC, 'utf8');
    expect(doc).toContain('| tool | suite | live | test files |');
    expect(doc).toMatch(/says nothing about Premiere/);
  });

  it('names every recorded tool that is not in the catalogue rather than dropping it', () => {
    const coverage = loadCoverage();
    if (!coverage) return;
    const names = new Set(catalogueNames());
    const doc = readFileSync(DOC, 'utf8');
    for (const record of coverage.tools) {
      if (!names.has(record.name)) expect(doc).toContain(`\`${record.name}\``);
    }
  });

  it('labels itself generated, so nobody edits it by hand in good faith', () => {
    expect(readFileSync(DOC, 'utf8')).toMatch(/GENERATED FILE\. Do not edit by hand/);
  });
});
