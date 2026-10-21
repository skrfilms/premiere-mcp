/**
 * Write one sweep into the repo's live-verification ledger.
 *
 * Harnesses call `recordSweep()` at the end of a run. The file it writes is the ONLY thing
 * that makes "verified live" a durable claim — `docs/LIVE-VERIFICATION.md` is generated from
 * these files, so a sweep that does not write one leaves no evidence behind, and a claim with
 * no sweep behind it cannot survive the drift test.
 *
 * See src/verification/ledger.ts for the schema and the reasoning.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SWEEP_DIR = join(REPO_ROOT, 'verification', 'sweeps');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Collect the environment a sweep ran in.
 *
 * `premiereVersion` is asked of the host rather than assumed, and stays null when the host
 * does not answer — a sweep against a host we could not identify is still a real sweep, and
 * inventing a version number would be exactly the kind of lie this ledger exists to prevent.
 */
export async function collectEnvironment({ tools, harness, mode }) {
  let premiereVersion = null;
  try {
    // get_version_info answers under `data`; the fallbacks are there so a future shape change
    // degrades to null rather than to a wrong version number.
    const info = await tools.executeTool('get_version_info', {});
    const v = info?.data?.version ?? info?.version ?? info?.premiereVersion ?? null;
    const build = info?.data?.build;
    premiereVersion = v == null ? null : build ? `${v} (build ${build})` : String(v);
  } catch {
    premiereVersion = null;
  }
  return {
    ranAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    harness,
    mode,
    gitSha: git(['rev-parse', 'HEAD']) || 'unknown',
    gitDirty: git(['status', '--porcelain']).length > 0,
    premiereVersion,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    catalogueSize: tools.getRegisteredTools().length,
  };
}

/** Write the sweep file. Returns its absolute path. */
export function recordSweep({ environment, tools }) {
  mkdirSync(SWEEP_DIR, { recursive: true });
  const stamp = environment.ranAt.replace(/[:]/g, '').replace(/-/g, '');
  const path = join(SWEEP_DIR, `${stamp}-${environment.harness}.json`);
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(path, JSON.stringify({ environment, tools: sorted }, null, 2) + '\n');
  return path;
}
