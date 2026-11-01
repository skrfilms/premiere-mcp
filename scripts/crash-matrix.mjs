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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireScratchProject } from './lib/require-scratch-project.mjs';
import { buildContext, ensureSideFixtures, synthesizeArgs } from './lib/synthesize-args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, '.scratch', 'premiere-mcp-scratch.prproj');
const OUT = join(ROOT, '.scratch', 'crash-matrix');
const BRIDGE = process.env.PREMIERE_TEMP_DIR;
const REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
mkdirSync(OUT, { recursive: true });

const { PremiereProBridge } = await import('../dist/bridge/index.js');
const { PremiereProTools } = await import('../dist/tools/index.js');

const heartbeatAge = () => {
  try { return Date.now() - JSON.parse(readFileSync(join(BRIDGE, 'bridge-heartbeat.json'), 'utf8')).ts; } catch { return Infinity; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const premiereRunning = () => spawnSync('pgrep', ['-f', 'MacOS/Adobe Premiere Pro 2026$']).status === 0;

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
    return { report: f, exception: d.exception?.type, frames };
  } catch { return { report: f }; }
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
await requireScratchProject(bridge, 'crash-matrix');
ensureSideFixtures();

const q = JSON.stringify;
const itemId = async (name) => (await bridge.executeScript(`(function(){var hit=null;function w(it){for(var i=0;i<it.children.numItems&&!hit;i++){var c=it.children[i];if(String(c.name)===${q(name)})hit=c;else if(c.type===2)w(c);}}w(app.project.rootItem);return JSON.stringify({id:hit?String(hit.nodeId):null});})();`)).id;
const seqItemId = async (name) => (await bridge.executeScript(`(function(){for(var i=0;i<app.project.sequences.numSequences;i++){var s=app.project.sequences[i];if(String(s.name)===${q(name)})return JSON.stringify({id:String(s.projectItem.nodeId)});}return JSON.stringify({id:null});})();`)).id;

/** Kinds of material: how to get a project item whose clip lands on V1/A1 of a new sequence. */
const KINDS = {
  'plain video+audio': () => itemId('fixture_a.mp4'),
  'audio only': () => itemId('dialogue.m4a'),
  'nested sequence': () => seqItemId('fixture_seq_a'),
  'multicam source': () => seqItemId('fixture_multicam[1]-fixture_multicam'),
  'still image': () => itemId('fixture_still.png'),
  'dual mono': () => itemId('bits_dualmono.mp4'),
  '29.97 long': () => itemId('bits_2997_long.mp4'),
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

for (const [op, spec] of ops) {
  for (const [kind, getItem] of Object.entries(KINDS)) {
    if (spec.kind === 'video' && kind === 'audio only') continue;
    if (spec.kind === 'audio' && kind === 'still image') continue;
    const label = `${op} on ${kind}`;
    if (heartbeatAge() > 5000 && !(await relaunch())) { results.push({ op, kind, outcome: 'premiere_unavailable' }); continue; }
    const id = await getItem();
    if (!id) { results.push({ op, kind, outcome: 'no_fixture' }); console.log(`skip  ${label}: no fixture`); continue; }
    const seq = await tools.executeTool('create_sequence_from_clips', { projectItemIds: [id], name: `crash_${op}_${kind.replace(/\W+/g, '_')}` });
    const sid = seq?.sequenceId ?? seq?.data?.sequenceId;
    if (!sid) { results.push({ op, kind, outcome: 'setup_failed', detail: seq?.error }); continue; }
    await tools.executeTool('set_active_sequence', { sequenceId: sid });
    const clipId = (await bridge.executeScript(`var s=__findSequence(${q(sid)});var t=s.${spec.kind === 'audio' ? 'audioTracks' : 'videoTracks'}[0];return JSON.stringify({id:t.clips.numItems?String(t.clips[0].nodeId):null});`)).id;
    const started = Date.now();
    let r = null, error = null;
    // Arguments: what the sweep would synthesise for this clip, then this case's own.
    const toolName = spec.tool ?? op;
    const def = tools.getAvailableTools().find((x) => x.name === toolName);
    let synth = {};
    try { synth = synthesizeArgs(def, await buildContext(bridge))?.args ?? {}; } catch { /* fall back to the basics */ }
    try {
      r = await tools.executeTool(toolName, { ...synth, sequenceId: sid, trackIndex: 0, clipIndex: 0, clipId, ...(spec.args ?? {}) }, { allowUnexposed: true });
    } catch (e) { error = String(e?.message ?? e); }
    await sleep(4000);
    const alive = heartbeatAge() < 5000 && premiereRunning();
    if (!alive) {
      await sleep(3000);
      const crash = crashSince(started - 1000);
      results.push({ op, kind, outcome: 'CRASHED', crash, error });
      console.log(`CRASH ${label}: ${crash?.frames?.slice(0, 3).join(' < ') ?? 'no report found'}`);
      await relaunch();
      await connect();
      continue;
    }
    const ok = r && r.success !== false;
    results.push({ op, kind, outcome: ok ? 'ok' : 'refused', verified: r?.verified, detail: (r?.error ?? error ?? '').slice(0, 200) });
    console.log(`${ok ? 'ok   ' : 'no   '} ${label}${ok ? '' : `: ${(r?.error ?? error ?? '').slice(0, 120)}`}`);
  }
}

const file = join(OUT, `crash-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.filter((x) => x.outcome === 'CRASHED').length} crash(es); results: ${file}`);
process.exit(0);
