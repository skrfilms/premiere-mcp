/**
 * Host recovery — turn a dead ExtendScript engine from "the run is over" into a ~90 second pause.
 *
 * On 2026-08-24 the previous session ended because the engine died and clearing it needed a
 * human to force-quit Premiere. Nothing in the scratch project is worth preserving, so that is
 * a solvable problem: detect, kill, relaunch, reopen, rebuild the fixture, carry on.
 *
 * Four things learned the hard way, all encoded here:
 *
 * 1. **Relaunch WITH the project path.** With Premiere running but no project open, the CEP
 *    panel is never instantiated and no heartbeat is ever written. `open -a Premiere` alone
 *    looks like a hung recovery.
 * 2. **Never send an AppleEvent to Premiere.** `tell application "..." to activate` does not
 *    return while Premiere is blocked on a modal — which is exactly when recovery runs. It has
 *    to be killed from the outside and driven with System Events keystrokes only.
 * 3. **Expect a modal on open, and clear it.** Premiere raises Link Media *before* the
 *    workspace loads if any media is missing, so the panel never starts. Escape dismisses it.
 *    A relaunch that stalls on a dialog is a second wedge, not a recovery.
 * 4. **The scratch project must have zero external media** so (3) cannot happen at all.
 *    `reset-scratch.mjs` guarantees this and fails loudly if an offline item survives.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH_PROBE, driftReason } from './require-scratch-project.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

export const SCRATCH_PROJECT = join(REPO, '.scratch', 'premiere-mcp-scratch.prproj');
export const PREMIERE_APP = 'Adobe Premiere Pro 2026';
const TEMP_DIR = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';
const HEARTBEAT = join(TEMP_DIR, 'bridge-heartbeat.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write(`[recovery] ${msg}\n`);

/**
 * Run the dependency-free sentinel and return its verdict object.
 *
 * This process's pid is passed down so the sentinel does not count us as a competing client. Every
 * caller of this module runs a bridge in-process, which holds a `client-<pid>.json` slot, and
 * without the exclusion every verdict came back contended and recovery refused unconditionally.
 * Excluding ourselves is only sound because spawnSync blocks our event loop for the whole probe, so
 * our own bridge cannot touch the directory while the sentinel is reading it.
 */
export function probeEngine(timeoutMs = 12_000) {
  const out = spawnSync(
    process.execPath,
    [join(REPO, 'scripts', 'engine-sentinel.mjs'), '--json', `--timeout=${timeoutMs}`],
    { encoding: 'utf8', env: { ...process.env, PREMIERE_TEMP_DIR: TEMP_DIR, PREMIERE_MCP_SENTINEL_PARENT_PID: String(process.pid) } },
  );
  try {
    return JSON.parse(String(out.stdout).trim().split('\n').pop());
  } catch {
    return { state: 'SENTINEL_ERROR', code: 4, detail: String(out.stderr || out.stdout).slice(0, 300) };
  }
}

/**
 * Why a verdict must not lead to Escape or a restart, or null when acting on it is allowed.
 *
 * Pure, so the policy can be tested without a host. Three refusals:
 *   - CONTENDED: another live client shares the directory and the verdict is one a peer can fake.
 *   - RESPONSE_LOST: the panel answered and something removed the answer. The engine is alive.
 *   - BUSY on a command this process did not issue. Escape goes to whatever app is frontmost, so
 *     it can cancel another client's export or a user's dialog, and a restart kills their work.
 *     BUSY on a command we DID issue is our own wedge — the modal case Escape exists for — so
 *     `ownsCommand` decides; without one, every BUSY is treated as somebody else's.
 *
 * @param {{ state: string, contendedBy?: number[], busyWith?: string }} verdict
 * @param {(id: string) => boolean} [ownsCommand]
 * @returns {string|null}
 */
export function recoveryRefusal(verdict, ownsCommand) {
  if (!verdict || verdict.state === 'HEALTHY') return null;
  if (verdict.state === 'RESPONSE_LOST') {
    return 'Refusing to Escape or restart Premiere: the probe\'s command vanished without a response, '
      + 'which means the panel answered and another client removed the files. The engine is not dead. '
      + `${verdict.detail ?? ''}`.trim();
  }
  if (verdict.state === 'BUSY') {
    const busyWith = verdict.busyWith ?? null;
    if (busyWith && typeof ownsCommand === 'function' && ownsCommand(busyWith)) return null;
    return `Refusing to Escape or restart Premiere: the panel is busy on command ${busyWith ?? '(unnamed)'}, `
      + 'which this process did not issue. It belongs to another client (an agent session, a second '
      + 'server, or the user), and pressing Escape or force-quitting would cancel that work. Re-run '
      + 'when the panel is idle.';
  }
  if (verdict.contendedBy?.length) {
    return `Host looks ${verdict.state}, but ${verdict.contendedBy.length} other bridge client(s) `
      + `(pid ${verdict.contendedBy.join(', ')}) share this temp directory, which can fake that `
      + 'verdict. Refusing to restart Premiere. Re-run with no other client attached to get a '
      + 'trustworthy reading.';
  }
  // Fail closed on everything else. Only a reading that positively says the host is wedged on
  // our own work justifies a keystroke or a restart; SENTINEL_ERROR means health is UNKNOWN (the
  // sentinel crashed or printed something unparseable), and an unrecognised state is the same.
  // Treating either as "dead" force-quit a host nobody had shown to be broken.
  if (verdict.state === 'ENGINE_DEAD' || verdict.state === 'PANEL_DEAD' || verdict.state === 'BUSY') return null;
  return `Refusing to Escape or restart Premiere: host health is unknown (${verdict.state}). `
    + `${verdict.detail ?? ''}`.trim();
}

/**
 * Remember every command id this process's bridge publishes, so a BUSY verdict can be attributed.
 *
 * The heartbeat names the command the panel is inside, and the only way to know whether that is
 * ours is to have seen the id go out. Both transports (socket and file IPC) go through the bridge's
 * publishCommand, so wrapping that one method sees every id. If the method is ever renamed the
 * wrapper installs nothing and the predicate owns nothing, which degrades to "every BUSY is
 * somebody else's" — the refusing direction — instead of silently trusting a guess.
 *
 * @param {object} bridge an initialised PremiereProBridge
 * @param {number} [keep] how many recent ids to remember
 * @returns {(id: string) => boolean}
 */
export function trackOwnCommands(bridge, keep = 64) {
  const seen = [];
  const original = bridge && bridge.publishCommand;
  if (typeof original !== 'function') {
    log('cannot see this bridge\'s command ids; every BUSY verdict will be treated as another client\'s');
    return () => false;
  }
  bridge.publishCommand = function trackedPublishCommand(commandId, ...rest) {
    seen.push(String(commandId));
    if (seen.length > keep) seen.shift();
    return original.call(this, commandId, ...rest);
  };
  return (id) => seen.includes(String(id));
}

/**
 * The ExtendScript that saves the active project only if it is still the one that was verified.
 *
 * Re-checked inside the host, in the same script as the save, so the project cannot change between
 * the node-side verification and the save itself.
 *
 * @param {string} expectedPath the exact `app.project.path` string the verification accepted
 */
export function guardedSaveScript(expectedPath) {
  return `(function(){
  try {
    if (!app.projects || app.projects.numProjects !== 1) return JSON.stringify({ saved: false, reason: 'open project count changed' });
    if (String(app.project.path) !== ${JSON.stringify(String(expectedPath))}) return JSON.stringify({ saved: false, reason: 'active project changed' });
    app.project.save();
    return JSON.stringify({ saved: true });
  } catch (e) { return JSON.stringify({ saved: false, reason: String(e) }); }
})();`;
}

/** The project recovery is allowed to save: the caller's pinned one, else the repo scratch file. */
function savePin(pinned) {
  if (pinned?.realpath) return pinned;
  try { return { realpath: realpathSync(SCRATCH_PROJECT) }; } catch { return null; }
}

function heartbeatTs() {
  try {
    return Number(JSON.parse(readFileSync(HEARTBEAT, 'utf8')).ts);
  } catch {
    return 0;
  }
}

function heartbeatAgeMs() {
  const ts = heartbeatTs();
  return ts ? Date.now() - ts : Infinity;
}

/**
 * Press Escape at the frontmost app.
 *
 * Premiere exposes ZERO windows to the accessibility API (Adobe draws its own UI), so
 * `click button "Offline" of window "Link Media"` can never work. Keystrokes route to the
 * frontmost application without needing window access, which is what makes unattended modal
 * dismissal possible at all. Deliberately does not activate Premiere first: activation is an
 * AppleEvent, and a modal-blocked Premiere will not answer one.
 */
export function pressEscape(times = 2) {
  for (let i = 0; i < times; i++) {
    try {
      execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 53'], {
        timeout: 8000, stdio: 'ignore',
      });
    } catch { /* best effort: a failed keystroke must not abort recovery */ }
  }
}

/**
 * Adobe's crash reporter reads the dying process's memory, which parks the corpse in an
 * uninterruptible-exiting state (`ps` STAT `UE`) where even SIGKILL appears to do nothing —
 * pgrep keeps listing a PID that is already on its way out. Measured directly: an
 * `AdobeCrashReport -p <pid>` process was holding it, and killing the reporter freed it at once.
 * So the reporter has to be reaped too, or every recovery looks like "Premiere would not exit".
 */
function reapCrashReporters() {
  for (const pattern of ['AdobeCrashReport', 'crashpad_handler']) {
    spawnSync('/usr/bin/pkill', ['-9', '-f', pattern], { stdio: 'ignore' });
  }
}

/**
 * True when nothing is left that could still be driving the host. A process already marked
 * exiting (`E`) or zombie (`Z`) is gone for our purposes; waiting for the PID to vanish
 * conflates "still running" with "still being autopsied".
 */
function premiereGone() {
  const r = spawnSync('/bin/ps', ['-o', 'pid=,stat=', '-p', pidsOf(`MacOS/${PREMIERE_APP}`).join(',') || '-1'], { encoding: 'utf8' });
  const lines = String(r.stdout).trim().split('\n').filter(Boolean);
  if (!lines.length) return true;
  return lines.every((l) => /[EZ]/.test(l.trim().split(/\s+/)[1] || ''));
}

function pidsOf(pattern) {
  const r = spawnSync('/usr/bin/pgrep', ['-f', pattern], { encoding: 'utf8' });
  return String(r.stdout).trim().split('\n').filter(Boolean);
}

/**
 * Quit Premiere.
 *
 * Preferred path: if the engine still answers, SAVE first and then SIGTERM. An unsaved scratch
 * project makes SIGTERM raise a "Save changes?" modal, which blocks the quit indefinitely — and
 * escalating to SIGKILL from there produces a crash dump and the `UE` state above. Saving first
 * makes the graceful path actually graceful. Nothing here needs the project's contents; it is
 * saved purely so Premiere has no reason to ask a question.
 *
 * The save is only made into the VERIFIED scratch project. This used to save whatever was active,
 * so a run whose target had drifted onto a real cut would write the sweep's edits into it. When the
 * active project is not the pinned scratch file, this neither saves nor quits: quitting from there
 * means SIGKILL on unsaved work, which discards it. Returns `{ killed, refused?, reason? }`.
 */
async function killPremiere({ engineHealthy, pinned }) {
  if (engineHealthy) {
    try {
      const { PremiereProBridge } = await import('../../dist/bridge/index.js');
      const bridge = new PremiereProBridge();
      await bridge.initialize();
      const pin = savePin(pinned);
      const state = await bridge.executeScript(SCRATCH_PROBE);
      const drift = pin ? driftReason(state, pin) : 'no scratch project was verified for this run';
      if (drift) {
        log(`NOT saving and NOT quitting: ${drift}`);
        return { killed: false, refused: true,
          reason: `Refusing to save or quit Premiere: ${drift}. Nothing was saved or discarded; `
            + 'resolve it in Premiere by hand.' };
      }
      const saved = await bridge.executeScript(guardedSaveScript(state.path));
      if (!(saved && saved.saved)) {
        // The in-host guard refused (the active project changed after driftReason looked) or the
        // save failed. Either way the open project is not known to be the saved scratch file, and
        // the quit below escalates to SIGKILL, which would discard its unsaved work.
        const why = saved?.reason ?? saved?.error ?? 'no answer';
        log(`NOT quitting: scratch project was not saved (${why})`);
        return { killed: false, refused: true,
          reason: `Refusing to quit Premiere: the scratch project could not be saved (${why}). `
            + 'Nothing was discarded; resolve it in Premiere by hand.' };
      }
      log('scratch project saved, so quitting cannot raise a save prompt');
    } catch (error) {
      // Same reasoning: an engine that answered the probe but not the verify-and-save leaves us
      // unable to say what is open, so do not quit it.
      const why = error instanceof Error ? error.message : String(error);
      log(`NOT quitting: could not verify and save before quitting (${why})`);
      return { killed: false, refused: true,
        reason: `Refusing to quit Premiere: could not verify and save the scratch project (${why}).` };
    }
    spawnSync('/usr/bin/pkill', ['-f', `MacOS/${PREMIERE_APP}`], { stdio: 'ignore' });
    const soft = Date.now() + 25_000;
    while (Date.now() < soft && !premiereGone()) spawnSync('/bin/sleep', ['1']);
    if (premiereGone()) { reapCrashReporters(); return { killed: true }; }
    log('graceful quit did not complete — escalating');
  }

  spawnSync('/usr/bin/pkill', ['-9', '-f', `MacOS/${PREMIERE_APP}`], { stdio: 'ignore' });
  const hard = Date.now() + 25_000;
  while (Date.now() < hard && !premiereGone()) {
    reapCrashReporters();
    spawnSync('/bin/sleep', ['1']);
  }
  reapCrashReporters();
  return { killed: premiereGone() };
}

async function launchPremiereWithScratch() {
  if (!existsSync(SCRATCH_PROJECT)) {
    throw new Error(`scratch project missing at ${SCRATCH_PROJECT} — cannot recover without it`);
  }
  spawnSync('/usr/bin/open', ['-a', PREMIERE_APP, SCRATCH_PROJECT], { stdio: 'ignore' });
}

/**
 * Wait for the panel to start writing heartbeats, clearing modals while we wait.
 *
 * The Escape presses are the load-bearing part: if a dialog is up, the heartbeat will never
 * arrive on its own no matter how long the timeout is, so waiting passively is indistinguishable
 * from a failed launch.
 */
async function waitForPanel(timeoutMs = 240_000, notBefore = 0) {
  const deadline = Date.now() + timeoutMs;
  let escapes = 0;
  while (Date.now() < deadline) {
    // The beacon must be NEWER than the relaunch, not merely recent. The killed panel leaves its
    // last heartbeat on disk, and if the quit took under 8s that corpse satisfied an age-only
    // check — so recovery announced "panel heartbeat is live" against a panel that no longer
    // existed, then spent six probe attempts blaming the engine. Observed 2026-08-31.
    if (heartbeatTs() > notBefore && heartbeatAgeMs() < 8000) return true;
    // Premiere takes ~45-90s to be interactive; start clearing dialogs after that and keep
    // doing it periodically, since Link Media can appear late in the open sequence.
    if (Date.now() > deadline - timeoutMs + 45_000 && escapes < 12) {
      pressEscape(1);
      escapes++;
    }
    await sleep(5000);
  }
  return false;
}

/**
 * Bring the host back to a known-good state. Returns a result object rather than throwing, so a
 * sweep can record the failure against the tool that caused it and keep going.
 *
 * `ownsCommand` attributes a BUSY verdict (see recoveryRefusal); `pinned` is the scratch project the
 * caller verified, and the only one this is allowed to save before quitting.
 */
export async function recoverHost({ rebuildFixture = true, ownsCommand, pinned } = {}) {
  const started = Date.now();
  // Ask first: a still-answering engine lets us save and quit cleanly, which avoids both the
  // "Save changes?" modal and the crash dump that SIGKILL leaves behind.
  const pre = probeEngine(6000);
  // Same refusal as ensureHealthy, repeated on this function's OWN probe because it is also called
  // directly and it force-quits Premiere unconditionally from here on. The host may have changed
  // since the caller looked: a panel that has since picked up another client's command reads BUSY
  // here, and killing it would take that client's work down with it.
  const refusal = recoveryRefusal(pre, ownsCommand);
  if (refusal) {
    return { recovered: false, contended: true, busy: pre.state === 'BUSY', elapsedMs: Date.now() - started, error: refusal };
  }
  log(`recovering: host is ${pre.state}; quitting Premiere`);
  const kill = await killPremiere({ engineHealthy: pre.state === 'HEALTHY', pinned });
  if (kill.refused) {
    return { recovered: false, refused: true, elapsedMs: Date.now() - started, error: kill.reason };
  }
  if (!kill.killed) {
    return { recovered: false, elapsedMs: Date.now() - started, error: 'Premiere would not exit even after SIGKILL.' };
  }

  await sleep(3000);
  log(`relaunching with ${SCRATCH_PROJECT}`);
  const relaunchedAt = Date.now();
  await launchPremiereWithScratch();

  if (!(await waitForPanel(240_000, relaunchedAt))) {
    return {
      recovered: false,
      elapsedMs: Date.now() - started,
      // Naming the manual step matters: the CEP panel does NOT come back on its own unless
      // Premiere restores it with the workspace, so an operator reading "never produced a
      // heartbeat" otherwise goes looking for a modal that is not there.
      error: 'Panel never produced a heartbeat after relaunch. Either a modal is still up, or the '
        + 'CEP panel did not reopen — it is a manual step: Window > Extensions > MCP Bridge (CEP).',
    };
  }
  log('panel heartbeat is live; confirming the engine executes');

  // Panel alive is not engine alive — that conflation is the whole reason the sentinel exists.
  let verdict = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    verdict = probeEngine();
    if (verdict.state === 'HEALTHY') break;
    // Another client can start using the relaunched host before we do. Any refusable reading —
    // busy on its command, contended, a vanished response, unknown health — means Escape could
    // land on that work, so wait instead of pressing it.
    if (!recoveryRefusal(verdict, ownsCommand)) pressEscape(1);
    await sleep(5000);
  }
  if (!verdict || verdict.state !== 'HEALTHY') {
    return { recovered: false, elapsedMs: Date.now() - started, error: `Engine still not healthy after relaunch: ${verdict?.state} — ${verdict?.detail}` };
  }

  let fixture = null;
  if (rebuildFixture) {
    log('rebuilding the fixture');
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'reset-scratch.mjs')], {
      encoding: 'utf8', env: { ...process.env, PREMIERE_TEMP_DIR: TEMP_DIR }, timeout: 300_000,
    });
    fixture = r.status === 0 ? 'rebuilt' : `FAILED (${String(r.stdout || r.stderr).slice(-300)})`;
  }

  const elapsedMs = Date.now() - started;
  log(`recovered in ${Math.round(elapsedMs / 1000)}s`);
  return { recovered: true, elapsedMs, rttMs: verdict.rttMs, fixture };
}

/**
 * The guard a sweep calls between tools.
 *
 * `culprit` is the tool that ran immediately before the check. Attributing a recovery to it is
 * the entire value of doing this per-call: the recovery log becomes the engine-killer bug report,
 * which is data no other Premiere bridge collects because nobody else can afford to.
 */
export async function ensureHealthy(culprit, state) {
  let verdict = probeEngine(state.probeTimeoutMs ?? 12_000);
  if (verdict.state === 'HEALTHY') return { ok: true, verdict };

  // One patient re-probe for BUSY: plenty of legitimate host calls outlive a single probe window.
  // The latest reading is the one acted on below, so a panel that has moved on is judged as it is
  // now rather than as it was five seconds ago.
  if (verdict.state === 'BUSY') {
    await sleep(5000);
    verdict = probeEngine(20_000);
    if (verdict.state === 'HEALTHY') return { ok: true, verdict };
  }
  // BUSY on a sentinel probe is not a wedge: it is an earlier probe (often our own, queued while a
  // slow tool was still running) that the panel picked up as soon as it came free. Measured
  // 2026-10-25: export_aaf ran past the harness timeout, the first probe queued behind it, and the
  // re-probe found the panel inside that probe, which was refused as "another client's command"
  // and aborted the sweep on a healthy host. Probes finish in well under a second, so wait them out.
  for (let i = 0; i < 6 && verdict.state === 'BUSY' && /^sentinel-/.test(String(verdict.busyWith ?? '')); i++) {
    await sleep(3000);
    verdict = probeEngine(15_000);
    if (verdict.state === 'HEALTHY') return { ok: true, verdict };
  }

  // REFUSE BEFORE ESCAPE, NOT AFTER. Escape is a keystroke to the frontmost application, not to
  // Premiere's scripting host, so on a host somebody else is using it can cancel their export or
  // dismiss their dialog. Three verdicts say "somebody else is using it": BUSY on a command we did
  // not issue, a contended reading, and a vanished response. Force-quitting is worse still — on
  // 2026-08-31 a contended verdict closed the user's open project on a host that was answering tools
  // normally — so none of the three is grounds for either action.
  const refusal = recoveryRefusal(verdict, state.ownsCommand);
  if (refusal) {
    return { ok: false, verdict, contended: true, busy: verdict.state === 'BUSY', error: refusal };
  }

  // ESCAPE FIRST, KILL SECOND. Most apparent engine deaths are a native modal holding the
  // scripting host, not a dead engine — measured directly: app.project.createNewSequence opens
  // the New Sequence dialog, which produced a 45s timeout, a panel that stopped polling, and a
  // verdict indistinguishable from a real death. Two Escapes cleared it and the engine was
  // healthy again in ~6 seconds, against ~32 seconds for a full relaunch, with no state lost.
  // So a restart is the fallback, not the first move.
  pressEscape(2);
  await sleep(2500);
  const afterEscape = probeEngine(15_000);
  if (afterEscape.state === 'HEALTHY') {
    state.modalsCleared = state.modalsCleared || [];
    state.modalsCleared.push({ culprit, verdictBefore: verdict.state });
    process.stdout.write(`\n[recovery] "${culprit}" left a modal up; Escape cleared it (no restart needed)\n`);
    return { ok: true, verdict: afterEscape, clearedModal: true };
  }
  // The same refusal again on the post-Escape reading: the host may now be answering another
  // client, and that is not a host to restart.
  const refusalAfterEscape = recoveryRefusal(afterEscape, state.ownsCommand);
  if (refusalAfterEscape) {
    return { ok: false, verdict: afterEscape, contended: true, busy: afterEscape.state === 'BUSY', error: refusalAfterEscape };
  }

  state.recoveries = state.recoveries || [];
  if (state.recoveries.length >= (state.maxRecoveries ?? 5)) {
    return { ok: false, verdict, gaveUp: true,
      error: `Recovery cap of ${state.maxRecoveries ?? 5} reached; refusing to keep thrashing the host.` };
  }

  process.stdout.write(`\n[recovery] host is ${verdict.state} after "${culprit}" — recovering\n`);
  const result = await recoverHost({ ownsCommand: state.ownsCommand, pinned: state.pinned });
  state.recoveries.push({ culprit, verdictBefore: verdict.state, detail: verdict.detail, ...result });
  return { ok: result.recovered, verdict, recovery: result };
}
