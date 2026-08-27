#!/usr/bin/env node
/**
 * Regenerate docs/LIVE-VERIFICATION.md from verification/sweeps/*.json.
 *
 *   node scripts/build-verification-report.mjs           rewrite the doc
 *   node scripts/build-verification-report.mjs --check    exit 1 if the doc is out of date
 *
 * --check is the CI form. It also prints how far the tool source has moved since the newest
 * sweep, because a ledger that is internally consistent can still be describing code that no
 * longer exists — and that drift is a fact worth stating out loud rather than a warning to
 * bury. It does not fail the build on staleness; the build cannot know whether a host was
 * available. It fails only on a doc that disagrees with the ledger.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderVerificationReport, validateSweep } from '../dist/verification/ledger.js';
import { PremiereProTools } from '../dist/tools/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP_DIR = join(REPO_ROOT, 'verification', 'sweeps');
const DOC = join(REPO_ROOT, 'docs', 'LIVE-VERIFICATION.md');
const CHECK = process.argv.includes('--check');

const sweeps = existsSync(SWEEP_DIR)
  ? readdirSync(SWEEP_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => validateSweep(JSON.parse(readFileSync(join(SWEEP_DIR, f), 'utf8')), f))
  : [];

// A stub transport: generating a document must never reach a host.
const noBridge = { executeScript: async () => { throw new Error('report generation must not touch the bridge'); } };
// getRegisteredTools(), not getAvailableTools(): the denominator is the WHOLE catalogue, not
// whatever the active tool profile happens to expose. A profile-sized denominator would report a
// sweep of 104 core tools as full coverage of a 647-tool build.
const catalogue = new PremiereProTools(noBridge).getRegisteredTools().map((t) => t.name);
const rendered = renderVerificationReport(sweeps, catalogue);

if (CHECK) {
  const current = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
  if (current !== rendered) {
    console.error('docs/LIVE-VERIFICATION.md is out of date. Run: npm run verify:report');
    process.exit(1);
  }
  console.log(`docs/LIVE-VERIFICATION.md matches the ledger (${sweeps.length} sweep(s), ${catalogue.length} tools).`);
  const newest = sweeps.map((s) => s.environment).sort((a, b) => b.ranAt.localeCompare(a.ranAt))[0];
  if (newest && newest.gitSha !== 'unknown') {
    try {
      const since = execFileSync('git', ['log', '--oneline', `${newest.gitSha}..HEAD`, '--', 'src/tools'],
        { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      const n = since ? since.split('\n').length : 0;
      console.log(n === 0
        ? `Tool source is unchanged since the newest sweep (${newest.ranAt}).`
        : `NOTE: ${n} commit(s) have touched src/tools since the newest sweep (${newest.ranAt}, ${newest.gitSha.slice(0, 7)}). The ledger describes older code.`);
    } catch {
      console.log(`NOTE: could not compare HEAD against the newest sweep's commit ${newest.gitSha.slice(0, 7)}.`);
    }
  }
  process.exit(0);
}

writeFileSync(DOC, rendered);
console.log(`wrote ${DOC} from ${sweeps.length} sweep(s) over ${catalogue.length} tools`);
