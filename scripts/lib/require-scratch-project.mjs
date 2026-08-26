/**
 * Refuse to run against anything but a disposable scratch project.
 *
 * Every live harness in `scripts/` mutates the open project: the sweep creates sequences and
 * imports media, the verifier adds markers, the cleanup DELETES every sequence outside its
 * allowlist. Pointed at a real cut, that last one is unrecoverable — the harness never saves, but
 * a human who hits Cmd-S afterwards makes it permanent.
 *
 * The guard is a name test rather than a path allowlist because the scratch project gets rebuilt,
 * renamed and re-saved constantly, and a hardcoded path silently stops guarding the moment it
 * moves. A name test fails CLOSED instead: an unrecognised name is refused, so the failure mode of
 * a renamed fixture is "harness will not start", not "harness edits the wrong project".
 *
 * This pattern was inline in scripts/reset-scratch.mjs first. It lives here so the three harnesses
 * cannot drift apart on what counts as safe, which is precisely the drift docs/WINDOWS-PARITY.md
 * records for the doctor scripts.
 */

/**
 * Names that mark a project as disposable. Deliberately broad on the disposable side: a false
 * refusal costs a rename, a false pass costs someone's edit.
 */
export const SCRATCH_NAME_PATTERN = /test|scratch|untitled|fixture/i;

/**
 * Probe the open project and exit(2) unless it looks disposable.
 *
 * @param {{ executeScript: (body: string) => Promise<any> }} bridge an INITIALISED bridge
 * @param {string} label harness name, used in the refusal message
 * @returns {Promise<{ name: string, path: string }>} the confirmed-scratch project
 */
export async function requireScratchProject(bridge, label) {
  const state = await bridge.executeScript(`(function(){
    return JSON.stringify({ name: String(app.project.name), path: String(app.project.path) });
  })();`);

  // A failed probe is not a pass. Without a name there is nothing to check, so refuse.
  if (!state || state.success === false || !state.name) {
    console.error(`REFUSING (${label}): could not read the open project name — ${state && state.error ? state.error : 'no response from Premiere'}. Nothing was changed.`);
    process.exit(2);
  }

  if (!SCRATCH_NAME_PATTERN.test(String(state.name))) {
    console.error(
      `REFUSING (${label}): "${state.name}" is not a scratch project. Nothing was changed.\n` +
      `  Open the disposable fixture first, then run: node scripts/reset-scratch.mjs`,
    );
    process.exit(2);
  }

  console.log(`${label} target: ${state.name}\n  at ${state.path}\n`);
  return state;
}
