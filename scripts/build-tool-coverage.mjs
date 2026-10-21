#!/usr/bin/env node
/**
 * Aggregate an instrumented test run into verification/test-coverage.json and regenerate
 * docs/TOOL-COVERAGE.md.
 *
 * Two modes:
 *   --aggregate   read .tool-coverage/worker-*.jsonl (written by the probe during a test run),
 *                 collapse it into verification/test-coverage.json, then render the document.
 *   (default)     render the document from the committed data only. Safe to run any time.
 *   --check       render and compare; exit 1 on drift. This is what CI and the drift test use.
 *
 * The raw .jsonl files are scratch and gitignored; the aggregated JSON is the committed artifact,
 * for the same reason sweeps are: it is the thing a document can be checked against.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(REPO_ROOT, '.tool-coverage');
const DATA = join(REPO_ROOT, 'verification', 'test-coverage.json');
const DOC = join(REPO_ROOT, 'docs', 'TOOL-COVERAGE.md');
const SWEEP_DIR = join(REPO_ROOT, 'verification', 'sweeps');

const { validateTestCoverage, renderCoverageReport } = await import(join(REPO_ROOT, 'dist', 'verification', 'coverage.js'));
const { validateSweep, currentStandings } = await import(join(REPO_ROOT, 'dist', 'verification', 'ledger.js'));
const { PremiereProTools } = await import(join(REPO_ROOT, 'dist', 'tools', 'index.js'));

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * The whole registered catalogue, not the active profile. A profile-sized denominator would turn
 * coverage of the core tools into "full coverage" of a much larger build.
 */
function catalogueNames() {
  const noBridge = {
    executeScript: async () => {
      throw new Error('coverage report must not touch the bridge');
    },
  };
  return new PremiereProTools(noBridge).getRegisteredTools().map((t) => t.name);
}

/** Tools some sweep actually EXECUTED live. A skip is not evidence, so only pass/fail counts. */
function executedLive() {
  if (!existsSync(SWEEP_DIR)) return new Set();
  const sweeps = readdirSync(SWEEP_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => validateSweep(JSON.parse(readFileSync(join(SWEEP_DIR, f), 'utf8')), f));
  const out = new Set();
  for (const [name, standing] of currentStandings(sweeps)) {
    if (standing.outcome === 'pass' || standing.outcome === 'fail') out.add(name);
  }
  return out;
}

function aggregate() {
  if (!existsSync(RAW_DIR)) {
    console.error(
      `no ${relative(REPO_ROOT, RAW_DIR)}/ — run the suite with instrumentation first:\n` +
      '  PREMIERE_MCP_TOOL_COVERAGE=1 npm test -- --runInBand',
    );
    process.exit(1);
  }
  const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.jsonl'));
  const byTool = new Map();
  const testFiles = new Set();
  let lines = 0;
  let malformed = 0;
  for (const f of files) {
    for (const line of readFileSync(join(RAW_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        // A worker killed mid-append can leave a torn final line. Counted and reported rather
        // than swallowed, so a systematically broken probe cannot look like light coverage.
        malformed += 1;
        continue;
      }
      if (typeof rec?.tool !== 'string') { malformed += 1; continue; }
      const rel = typeof rec.testFile === 'string' && rec.testFile !== 'unknown'
        ? relative(REPO_ROOT, rec.testFile)
        : 'unknown';
      if (!byTool.has(rec.tool)) byTool.set(rec.tool, new Set());
      byTool.get(rec.tool).add(rel);
      testFiles.add(rel);
    }
  }
  if (!byTool.size) {
    console.error(
      `${lines} line(s) across ${files.length} file(s) but no usable records. The probe is not ` +
      'recording; do not commit this as "zero coverage".',
    );
    process.exit(1);
  }
  const data = {
    tools: [...byTool.keys()].sort().map((name) => ({
      name,
      testFiles: [...byTool.get(name)].sort(),
    })),
    catalogueSize: catalogueNames().length,
    gitSha: git(['rev-parse', 'HEAD']) || 'unknown',
    gitDirty: git(['status', '--porcelain']).length > 0,
    testFileCount: testFiles.size,
  };
  writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
  console.log(
    `aggregated ${lines} invocation record(s) from ${files.length} worker file(s): ` +
    `${data.tools.length} distinct names across ${data.testFileCount} test file(s)` +
    (malformed ? `, ${malformed} malformed line(s) skipped` : ''),
  );
  rmSync(RAW_DIR, { recursive: true, force: true });
  return data;
}

const coverage = existsSync(DATA)
  ? validateTestCoverage(JSON.parse(readFileSync(DATA, 'utf8')), relative(REPO_ROOT, DATA))
  : null;

const data = process.argv.includes('--aggregate') ? validateTestCoverage(aggregate(), 'aggregated') : coverage;

const rendered = renderCoverageReport({
  coverage: data,
  executedLive: executedLive(),
  catalogue: catalogueNames(),
});

if (process.argv.includes('--check')) {
  const current = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
  if (current === rendered) {
    console.log(`${relative(REPO_ROOT, DOC)} matches the coverage data`);
    process.exit(0);
  }
  console.error(
    `${relative(REPO_ROOT, DOC)} does not match verification/test-coverage.json plus the sweep ` +
    'ledger. Run `npm run coverage:tools` — do not hand-edit the document.',
  );
  process.exit(1);
}

writeFileSync(DOC, rendered);
console.log(`wrote ${DOC} (${data ? data.tools.length : 0} names recorded by the suite)`);
