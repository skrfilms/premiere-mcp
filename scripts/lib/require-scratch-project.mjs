/**
 * Refuse to run against anything but a disposable scratch project.
 *
 * Every live harness in `scripts/` mutates the open project: the sweep creates sequences and
 * imports media, the verifier adds markers, the cleanup DELETES every sequence outside its
 * allowlist. Pointed at a real cut, that last one is unrecoverable — the harness never saves, but
 * a human who hits Cmd-S afterwards makes it permanent.
 *
 * The first version of this guard tested only `app.project.name` against a regex, and that is how
 * a 111-sequence cut was destroyed on this host on 2026-08-26. Two things were wrong with it, and
 * both are fixed here:
 *
 *   1. A NAME IS NOT AN IDENTITY. Two projects can share a name, a real cut can be called
 *      `colour_test`, and a name says nothing about which file on disk will be written. The primary
 *      check is now the resolved absolute path, and the pinned realpath is returned so the caller
 *      can re-assert it later. The name pattern is kept as a second, independent filter.
 *   2. `app.project` IS THE ACTIVE PROJECT, NOT THE ONLY ONE. Premiere happily holds several open
 *      at once, tools that omit a sequence/project id act on whichever is ACTIVE, and operations
 *      like duplicating a project STEAL active (see docs and the active-target-drift notes). So a
 *      guard that passes at startup says nothing about where mutation number four hundred lands.
 *      More than one open project is now a hard refusal: with exactly one open, drift has nowhere
 *      to go.
 *
 * This pattern was inline in scripts/reset-scratch.mjs first. It lives here so the harnesses cannot
 * drift apart on what counts as safe, which is precisely the drift docs/WINDOWS-PARITY.md records
 * for the doctor scripts.
 */

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, derived from this file rather than hardcoded, so it moves with the checkout. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Names that mark a project as disposable. Deliberately broad on the disposable side: a false
 * refusal costs a rename, a false pass costs someone's edit. This is now a SECOND filter — a
 * matching name alone is no longer enough to pass.
 */
export const SCRATCH_NAME_PATTERN = /test|scratch|untitled|fixture/i;

/** Read the active project plus the full open set. One round trip, so the two cannot disagree. */
const PROBE = `(function(){
  var out = { count: app.projects ? app.projects.numProjects : -1, open: [] };
  out.name = app.project ? String(app.project.name) : '';
  out.path = app.project ? String(app.project.path) : '';
  if (app.projects) {
    for (var i = 0; i < app.projects.numProjects; i++) {
      var p = app.projects[i];
      out.open.push({ name: String(p.name), path: String(p.path) });
    }
  }
  return JSON.stringify(out);
})();`;

/** Refuse loudly and stop. Never returns. */
function refuse(label, message) {
  console.error(`REFUSING (${label}): ${message}\n  Nothing was changed.`);
  process.exit(2);
}

/**
 * Probe Premiere and exit(2) unless exactly one project is open AND it is provably disposable.
 *
 * @param {{ executeScript: (body: string) => Promise<any> }} bridge an INITIALISED bridge
 * @param {string} label harness name, used in the refusal message
 * @returns {Promise<{ name: string, path: string, realpath: string }>} the pinned scratch project
 */
export async function requireScratchProject(bridge, label) {
  const state = await bridge.executeScript(PROBE);

  // A failed probe is not a pass. Without an answer there is nothing to check, so refuse.
  if (!state || state.success === false || typeof state.count !== 'number' || state.count < 0) {
    refuse(label, `could not read Premiere's open projects — ${state && state.error ? state.error : 'no response from Premiere'}.`);
  }

  if (state.count === 0) {
    refuse(label, 'no project is open. Open the disposable fixture first.');
  }

  // The check the old guard was missing. Every tool that omits an explicit target acts on whichever
  // project is ACTIVE, and active can change under the harness mid-run — so "the right one is
  // active right now" is not a safety property. Only "there is nothing else to hit" is.
  if (state.count > 1) {
    const others = (state.open || []).map((p) => `    - ${p.name} (${p.path || 'unsaved'})`).join('\n');
    refuse(
      label,
      `${state.count} projects are open, so a tool call that omits an explicit target could land on\n` +
      `  the wrong one at any point in the run. Close every project except the scratch fixture.\n` +
      `  Currently open:\n${others}`,
    );
  }

  if (!state.name) {
    refuse(label, 'the open project has no name — refusing rather than guessing.');
  }

  // Identity, not label: an absolute path that exists on disk, resolved through any symlink.
  if (!state.path) {
    refuse(label, `"${state.name}" has never been saved, so it has no path to verify. Save it into ${path.join(REPO_ROOT, '.scratch')} first.`);
  }
  if (!existsSync(state.path)) {
    refuse(label, `"${state.name}" reports path ${state.path}, which does not exist on this machine.`);
  }

  const realpath = realpathSync(state.path);

  // A disposable fixture for this repo lives inside this repo. A real cut essentially never does,
  // and the failure mode of an unusual layout is "harness will not start" — the safe direction.
  const inRepo = realpath === REPO_ROOT || realpath.startsWith(REPO_ROOT + path.sep);
  if (!inRepo) {
    refuse(
      label,
      `${realpath}\n  is outside this repo (${REPO_ROOT}), so it is treated as real work.\n` +
      `  Harnesses only run on a fixture under ${path.join(REPO_ROOT, '.scratch')}.`,
    );
  }

  // Kept as an independent second filter: an in-repo file with a real cut's name still refuses.
  if (!SCRATCH_NAME_PATTERN.test(String(state.name))) {
    refuse(
      label,
      `"${state.name}" is not a scratch project name.\n` +
      `  Open the disposable fixture first, then run: node scripts/reset-scratch.mjs`,
    );
  }

  console.log(`${label} target: ${state.name}\n  at ${realpath}\n  (1 project open, pinned by path)\n`);
  return { name: String(state.name), path: String(state.path), realpath };
}

/**
 * Re-assert mid-run that the active project is still the one that was cleared at startup.
 *
 * Call this before any destructive step that runs long after `requireScratchProject`. The startup
 * check cannot cover the whole run: opening, importing or duplicating a project changes which one
 * is ACTIVE, and the tools that omit a target follow it.
 *
 * @param {{ executeScript: (body: string) => Promise<any> }} bridge an INITIALISED bridge
 * @param {{ realpath: string }} pinned the value returned by requireScratchProject
 * @param {string} label harness name, used in the refusal message
 */
export async function assertStillScratch(bridge, pinned, label) {
  const state = await bridge.executeScript(PROBE);
  if (!state || state.success === false || typeof state.count !== 'number') {
    refuse(label, `could not re-read Premiere's open projects to confirm the target had not drifted — ${state && state.error ? state.error : 'no response from Premiere'}.`);
  }
  if (state.count !== 1) {
    refuse(label, `the number of open projects changed to ${state.count} during the run. The active target is no longer pinned.`);
  }
  if (!state.path || !existsSync(state.path) || realpathSync(state.path) !== pinned.realpath) {
    refuse(label, `the active project drifted mid-run.\n  Expected: ${pinned.realpath}\n  Now:      ${state.path || '(unsaved)'}`);
  }
}
