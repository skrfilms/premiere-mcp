#!/usr/bin/env node
/**
 * Crash matrix: run risky tools one at a time against each kind of clip, and survive Premiere
 * dying.
 *
 * The live sweep runs ~650 tools in one pass against one clip, so a crash ends the run and says
 * little about why. This runs each (tool, clip kind) pair on its own fresh sequence, checks the
 * bridge heartbeat afterwards, and if Premiere died, records the crash (with the newest crash
 * report's top frames), relaunches Premiere on the scratch project and carries on. The output
 * is a table of which operation crashes on which kind of material.
 *
 * Scratch project only (refuses anything else), and every case gets its own new sequence.
 *
 * Usage: PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/crash-matrix.mjs [tool ...]
 */
process.env.PREMIERE_MCP_PROFILE ||= 'all';
process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1';
process.env.PREMIERE_TEMP_DIR ||= '/tmp/premiere-mcp-bridge';

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStillScratch, requireScratchProject } from './lib/require-scratch-project.mjs';
import { buildContext, ensureSideFixtures, synthesizeArgs } from './lib/synthesize-args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, '.scratch', 'premiere-mcp-scratch.prproj');
const OUT = join(ROOT, '.scratch', 'crash-matrix');
const BRIDGE = process.env.PREMIERE_TEMP_DIR;
const REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
mkdirSync(OUT, { recursive: true });

// This runs the compiled build, so refuse a dist/ older than src/: a stale build would test code
// that is no longer the code under review.
{
  const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
    const p = join(dir, e.name);
    return Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }, 0);
  const built = existsSync(join(ROOT, 'dist', 'tools', 'index.js')) ? statSync(join(ROOT, 'dist', 'tools', 'index.js')).mtimeMs : 0;
  if (built < newest(join(ROOT, 'src'))) { console.error('crash-matrix: dist/ is older than src/. Run npm run build first.'); process.exit(2); }
}

const { PremiereProBridge } = await import('../dist/bridge/index.js');
const { PremiereProTools } = await import('../dist/tools/index.js');

const heartbeatAge = () => {
  try { return Date.now() - JSON.parse(readFileSync(join(BRIDGE, 'bridge-heartbeat.json'), 'utf8')).ts; } catch { return Infinity; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const premiereRunning = () => spawnSync('pgrep', ['-f', 'Adobe Premiere Pro[^/]*\\.app/Contents/MacOS/']).status === 0;

async function waitAlive(maxMs) {
  for (let t = 0; t < maxMs; t += 2000) { if (heartbeatAge() < 5000) return true; await sleep(2000); }
  return false;
}

/** Newest crash report written since `since`, as its top Premiere frames. */
function crashSince(since) {
  if (!existsSync(REPORTS)) return null;
  const f = readdirSync(REPORTS).filter((n) => /^Adobe Premiere Pro/.test(n) && n.endsWith('.ips'))
    .map((n) => join(REPORTS, n)).filter((p) => statSync(p).mtimeMs > since).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!f) return null;
  try {
    const d = JSON.parse(readFileSync(f, 'utf8').split('\n').slice(1).join('\n'));
    const th = d.threads[d.faultingThread ?? 0];
    const frames = th.frames.map((fr) => fr.symbol).filter((s) => s && !/^(__pthread_kill|pthread_kill|abort|_sigtramp)$/.test(s) && !/SignalHandler|config::Abort/.test(s)).slice(0, 6);
    return { report: basename(f), exception: d.exception?.type, frames };
  } catch { return { report: basename(f) }; }
}

async function relaunch() {
  // Wait for the dying process to go, then reopen the scratch project.
  for (let i = 0; i < 30 && premiereRunning(); i++) await sleep(2000);
  execFileSync('open', ['-a', 'Adobe Premiere Pro 2026', PROJECT]);
  return waitAlive(180_000);
}

let bridge, tools;
async function connect() {
  bridge = new PremiereProBridge();
  await bridge.initialize();
  tools = new PremiereProTools(bridge);
}

await connect();
const pinned = await requireScratchProject(bridge, 'crash-matrix');
ensureSideFixtures();

const q = JSON.stringify;
const itemId = async (name) => (await bridge.executeScript(`(function(){var hit=null;function w(it){for(var i=0;i<it.children.numItems&&!hit;i++){var c=it.children[i];if(String(c.name)===${q(name)})hit=c;else if(c.type===2)w(c);}}w(app.project.rootItem);return JSON.stringify({id:hit?String(hit.nodeId):null});})();`)).id;
const seqItemId = async (name) => (await bridge.executeScript(`(function(){for(var i=0;i<app.project.sequences.numSequences;i++){var s=app.project.sequences[i];if(String(s.name)===${q(name)})return JSON.stringify({id:String(s.projectItem.nodeId)});}return JSON.stringify({id:null});})();`)).id;

// The kinds the reset project does not hold are generated here (ffmpeg) and imported into a
// crash_fixtures bin, so every case has material instead of being skipped as no_fixture.
const CRASH_MEDIA = join(ROOT, '.scratch', 'media', 'crash');
const SIDE = {
  'crash_audio_only.m4a': ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac'],
  'crash_dualmono.mp4': ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  'crash_2997_long.mp4': ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30000/1001:d=60', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
};
mkdirSync(CRASH_MEDIA, { recursive: true });
for (const [name, args] of Object.entries(SIDE)) {
  const out = join(CRASH_MEDIA, name);
  if (!existsSync(out)) execFileSync(process.env.PREMIERE_MCP_FFMPEG_CMD || 'ffmpeg', ['-v', 'error', '-y', ...args, out]);
}
// Also re-run after every relaunch: a crashed Premiere reopens the last SAVED scratch project,
// which may not hold the imports made in this run.
async function importCrashFixtures() {
  const r = await bridge.executeScript(`(function(){
    function has(it, n){ for (var i=0;i<it.children.numItems;i++){ var c=it.children[i]; if (String(c.name)===n) return true; if (c.type===2 && has(c,n)) return true; } return false; }
    var want = ${JSON.stringify(Object.keys(SIDE).map((n) => join(CRASH_MEDIA, n)))}, missing = [];
    for (var i=0;i<want.length;i++){ var n = want[i].split('/').pop(); if (!has(app.project.rootItem, n)) missing.push(want[i]); }
    if (!missing.length) return JSON.stringify({ imported: 0 });
    var bin = null; for (var b=0;b<app.project.rootItem.children.numItems;b++){ var c=app.project.rootItem.children[b]; if (c.type===2 && String(c.name)==='crash_fixtures') bin=c; }
    if (!bin) bin = app.project.rootItem.createBin('crash_fixtures');
    app.project.importFiles(missing, true, bin, false);
    return JSON.stringify({ imported: missing.length });
  })();`);
  console.log(`crash fixtures: ${r?.imported ?? '?'} imported`);
}
await importCrashFixtures();

/** Kinds of material: how to get a project item whose clip lands on V1/A1 of a new sequence. */
const KINDS = {
  'plain video+audio': () => itemId('fixture_a.mp4'),
  'audio only': () => itemId('crash_audio_only.m4a'),
  'nested sequence': () => seqItemId('fixture_seq_a'),
  'multicam source': () => seqItemId('fixture_multicam[1]-fixture_multicam'),
  'still image': () => itemId('fixture_still.png'),
  'dual mono': () => itemId('crash_dualmono.mp4'),
  '29.97 long': () => itemId('crash_2997_long.mp4'),
};

/** Risky operations, each against V1/A1 clip 0 of the case's own sequence. */
const A = 'audio', V = 'video';
const OPS = {
  // Audio effects (the DeNoise crash family first)
  denoise_clip: { kind: A, args: {} },
  dereverb_clip: { kind: A, args: {} },
  apply_audio_effect_qe: { kind: A, args: { effectName: 'DeNoise' } },
  apply_effect_denoise: { tool: 'apply_effect', kind: A, args: { effectName: 'DeNoise' } },
  set_parametric_eq: { kind: A, args: { band: 1, frequency: 1000, gain: 3 } },
  set_compressor: { kind: A, args: { threshold: -20, ratio: 4 } },
  set_limiter: { kind: A, args: { ceiling: -1 } },
  apply_dynamics: { kind: A },
  set_clip_gain: { kind: A },
  normalize_clip_peaks: { kind: A },
  set_clip_pan: { kind: A },
  fade_in_audio: { kind: A },
  // Video effects, grading, motion
  stabilize_clip: { kind: V, args: { smoothness: 30 } },
  apply_effect: { kind: V, args: { effectName: 'Gaussian Blur' } },
  color_correct: { kind: V, args: { exposure: 0.3 } },
  lumetri_basic_set: { kind: V },
  apply_lut: { kind: V },
  crop_clip: { kind: V },
  set_clip_scale: { kind: V },
  ken_burns: { kind: V },
  letterbox: { kind: V },
  flip_horizontal: { kind: V },
  timecode_burn_in: { kind: V },
  fade_in_video: { kind: V },
  add_keyframe: { kind: V },
  // Time
  reverse_clip: { kind: V },
  speed_change: { kind: V },
  set_clip_speed_qe: { kind: V },
  set_time_interpolation: { kind: V },
  set_frame_blend: { kind: V },
  freeze_frame: { kind: V },
  add_transition_to_clip: { kind: V },
};

/**
 * Destructive and long-render tools the sweep never runs (they would wreck its shared timeline).
 * Each case here gets its own throwaway sequence, so they can be exercised safely.
 * `--set destructive` runs these instead of OPS.
 */
const DESTRUCTIVE = {
  delete_track: { kind: V }, delete_empty_tracks: { kind: V }, extract_selection: { kind: V },
  lift_selection: { kind: V }, nest_all_v1_clips: { kind: V }, nest_clips: { kind: V },
  unnest_sequence: { kind: V }, remove_all_effects: { kind: V }, remove_all_effects_qe: { kind: V },
  remove_effect: { kind: V }, remove_effect_at_index: { kind: V }, remove_effect_by_name: { kind: V },
  remove_from_timeline: { kind: V }, remove_keyframe: { kind: V }, remove_keyframe_range: { kind: V },
  remove_selected_clips: { kind: V }, remove_time_remap: { kind: V }, ripple_delete: { kind: V },
  replace_clip: { kind: V }, batch_replace_clips: { kind: V }, render_sequence_previews: { kind: V },
  render_audio: { kind: A }, bake_speed_change: { kind: V }, speed_ramp_bake: { kind: V },
  export_with_burn_ins: { kind: V }, delete_preview_files: { kind: V }, stabilize_clip: { kind: V },
};

const wanted = process.argv.slice(2);
const setAt = process.argv.indexOf('--set');
const SET = setAt >= 0 && process.argv[setAt + 1] === 'destructive' ? DESTRUCTIVE : OPS;
const names = wanted.filter((w, i) => w !== '--set' && process.argv[process.argv.indexOf(w) - 1] !== '--set');
const ops = Object.entries(SET).filter(([n]) => !names.length || names.includes(n));
const results = [];
// Written after every case, so a run that stops early (or dies) keeps what it found.
const file = join(OUT, `crash-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const save = () => writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
const record = (row) => { results.push(row); save(); };
function stop(code, why) {
  console.error(`crash-matrix stopped: ${why}`);
  record({ outcome: 'stopped', detail: why });
  console.log(`results so far: ${file}`);
  process.exit(code);
}
/**
 * This harness crashes Premiere on purpose, so it must only ever act on the pinned scratch
 * project: re-checked before every case, after every relaunch, and right before each tool call
 * (the user may open their own project at any point, and a relaunch may reopen another one).
 */
async function ensureScratch(when) {
  const { ok, reason } = await checkStillScratch(bridge, pinned);
  if (!ok) stop(3, `${when}: ${reason}`);
}
/** Relaunch, reconnect, and re-check the project; stops the run if Premiere does not come back. */
async function recover(when) {
  if (!(await relaunch())) stop(4, `${when}: Premiere did not come back after a relaunch`);
  await connect();
  await ensureScratch(`after relaunch (${when})`);
  await importCrashFixtures();
}
/** Alive, slow or gone: a stale heartbeat with the process still running is a long render, not a crash. */
async function settle() {
  for (let t = 0; t < 120_000; t += 2000) {
    if (heartbeatAge() < 5000) return 'alive';
    if (!premiereRunning()) return 'gone';
    await sleep(2000);
  }
  return premiereRunning() ? 'hung' : 'gone';
}

for (const [op, spec] of ops) {
  for (const [kind, getItem] of Object.entries(KINDS)) {
    if (spec.kind === 'video' && kind === 'audio only') continue;
    if (spec.kind === 'audio' && kind === 'still image') continue;
    const label = `${op} on ${kind}`;
    if (heartbeatAge() > 5000) {
      const state = await settle();
      if (state === 'hung') stop(5, `before ${label}: Premiere is running but its bridge has not answered for 2 minutes`);
      if (state === 'gone') await recover(`before ${label}`);
    }
    await ensureScratch(`before ${label}`);
    const id = await getItem();
    if (!id) { record({ op, kind, outcome: 'no_fixture' }); console.log(`skip  ${label}: no fixture`); continue; }
    const seq = await tools.executeTool('create_sequence_from_clips', { projectItemIds: [id], name: `crash_${op}_${kind.replace(/\W+/g, '_')}` });
    const sid = seq?.sequenceId ?? seq?.data?.sequenceId;
    if (!sid) { record({ op, kind, outcome: 'setup_failed', detail: seq?.error }); continue; }
    await tools.executeTool('set_active_sequence', { sequenceId: sid });
    const clipId = (await bridge.executeScript(`var s=__findSequence(${q(sid)});var t=s.${spec.kind === 'audio' ? 'audioTracks' : 'videoTracks'}[0];return JSON.stringify({id:t.clips.numItems?String(t.clips[0].nodeId):null});`)).id;
    const started = Date.now();
    let r = null, error = null;
    // Arguments: what the sweep would synthesise for this clip, then this case's own.
    const toolName = spec.tool ?? op;
    const def = tools.getAvailableTools().find((x) => x.name === toolName);
    let synth = {};
    try { synth = synthesizeArgs(def, await buildContext(bridge))?.args ?? {}; } catch { /* fall back to the basics */ }
    await ensureScratch(`right before ${label}`);
    try {
      r = await tools.executeTool(toolName, { ...synth, sequenceId: sid, trackIndex: 0, clipIndex: 0, clipId, ...(spec.args ?? {}) }, { allowUnexposed: true });
    } catch (e) { error = String(e?.message ?? e); }
    await sleep(4000);
    const state = heartbeatAge() < 5000 ? 'alive' : await settle();
    if (state === 'hung') stop(5, `after ${label}: Premiere is running but its bridge has not answered for 2 minutes`);
    if (state === 'gone') {
      await sleep(3000);
      const crash = crashSince(started - 1000);
      record({ op, kind, outcome: 'CRASHED', crash, error });
      console.log(`CRASH ${label}: ${crash?.frames?.slice(0, 3).join(' < ') ?? 'no report found'}`);
      await recover(`after the crash in ${label}`);
      continue;
    }
    const ok = r && r.success !== false;
    record({ op, kind, outcome: ok ? 'ok' : 'refused', verified: r?.verified, detail: (r?.error ?? error ?? '').slice(0, 200) });
    console.log(`${ok ? 'ok   ' : 'no   '} ${label}${ok ? '' : `: ${(r?.error ?? error ?? '').slice(0, 120)}`}`);
  }
}

save();
console.log(`\n${results.filter((x) => x.outcome === 'CRASHED').length} crash(es); results: ${file}`);
process.exit(0);
