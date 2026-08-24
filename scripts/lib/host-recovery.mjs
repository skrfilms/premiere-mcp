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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

export const SCRATCH_PROJECT = join(REPO, '.scratch', 'premiere-mcp-scratch.prproj');
export const PREMIERE_APP = 'Adobe Premiere Pro 2026';
const TEMP_DIR = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';
const HEARTBEAT = join(TEMP_DIR, 'bridge-heartbeat.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write(`[recovery] ${msg}\n`);

/** Run the dependency-free sentinel and return its verdict object. */
export function probeEngine(timeoutMs = 12_000) {
  const out = spawnSync(
    process.execPath,
    [join(REPO, 'scripts', 'engine-sentinel.mjs'), '--json', `--timeout=${timeoutMs}`],
    { encoding: 'utf8', env: { ...process.env, PREMIERE_TEMP_DIR: TEMP_DIR } },
  );
  try {
    return JSON.parse(String(out.stdout).trim().split('\n').pop());
  } catch {
    return { state: 'SENTINEL_ERROR', code: 4, detail: String(out.stderr || out.stdout).slice(0, 300) };
  }
}

function heartbeatAgeMs() {
  try {
    return Date.now() - Number(JSON.parse(readFileSync(HEARTBEAT, 'utf8')).ts);
  } catch {
    return Infinity;
  }
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
 */
async function killPremiere({ engineHealthy }) {
  if (engineHealthy) {
    try {
      const { PremiereProBridge } = await import('../../dist/bridge/index.js');
      const bridge = new PremiereProBridge();
      await bridge.initialize();
      await bridge.executeScript(`(function(){ try { app.project.save(); } catch(e){} return JSON.stringify({saved:true}); })();`);
      log('project saved, so quitting cannot raise a save prompt');
    } catch { log('could not save before quitting; continuing'); }
    spawnSync('/usr/bin/pkill', ['-f', `MacOS/${PREMIERE_APP}`], { stdio: 'ignore' });
    const soft = Date.now() + 25_000;
    while (Date.now() < soft && !premiereGone()) spawnSync('/bin/sleep', ['1']);
    if (premiereGone()) { reapCrashReporters(); return true; }
    log('graceful quit did not complete — escalating');
  }

  spawnSync('/usr/bin/pkill', ['-9', '-f', `MacOS/${PREMIERE_APP}`], { stdio: 'ignore' });
  const hard = Date.now() + 25_000;
  while (Date.now() < hard && !premiereGone()) {
    reapCrashReporters();
    spawnSync('/bin/sleep', ['1']);
  }
  reapCrashReporters();
  return premiereGone();
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
async function waitForPanel(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let escapes = 0;
  while (Date.now() < deadline) {
    if (heartbeatAgeMs() < 8000) return true;
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
 */
export async function recoverHost({ rebuildFixture = true } = {}) {
  const started = Date.now();
  // Ask first: a still-answering engine lets us save and quit cleanly, which avoids both the
  // "Save changes?" modal and the crash dump that SIGKILL leaves behind.
  const pre = probeEngine(6000);
  log(`recovering: host is ${pre.state}; quitting Premiere`);
  const killed = await killPremiere({ engineHealthy: pre.state === 'HEALTHY' });
  if (!killed) {
    return { recovered: false, elapsedMs: Date.now() - started, error: 'Premiere would not exit even after SIGKILL.' };
  }

  await sleep(3000);
  log(`relaunching with ${SCRATCH_PROJECT}`);
  await launchPremiereWithScratch();

  if (!(await waitForPanel())) {
    return { recovered: false, elapsedMs: Date.now() - started, error: 'Panel never produced a heartbeat after relaunch (a modal may still be up).' };
  }
  log('panel heartbeat is live; confirming the engine executes');

  // Panel alive is not engine alive — that conflation is the whole reason the sentinel exists.
  let verdict = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    verdict = probeEngine();
    if (verdict.state === 'HEALTHY') break;
    pressEscape(1);
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
  const verdict = probeEngine(state.probeTimeoutMs ?? 12_000);
  if (verdict.state === 'HEALTHY') return { ok: true, verdict };

  if (verdict.state === 'BUSY') {
    await sleep(5000);
    const second = probeEngine(20_000);
    if (second.state === 'HEALTHY') return { ok: true, verdict: second };
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

  state.recoveries = state.recoveries || [];
  if (state.recoveries.length >= (state.maxRecoveries ?? 5)) {
    return { ok: false, verdict, gaveUp: true,
      error: `Recovery cap of ${state.maxRecoveries ?? 5} reached; refusing to keep thrashing the host.` };
  }

  process.stdout.write(`\n[recovery] host is ${verdict.state} after "${culprit}" — recovering\n`);
  const result = await recoverHost();
  state.recoveries.push({ culprit, verdictBefore: verdict.state, detail: verdict.detail, ...result });
  return { ok: result.recovered, verdict, recovery: result };
}
