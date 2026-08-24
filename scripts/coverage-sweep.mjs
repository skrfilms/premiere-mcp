#!/usr/bin/env node
/**
 * Coverage sweep — execute as much of the catalogue as possible against a live host and record
 * what actually happened, tool by tool.
 *
 * Supersedes live-smoke-sweep.mjs, which conflated two unrelated reasons for skipping a tool
 * under one "unsafe" label:
 *
 *   - DESTRUCTIVE (deletes sequences, wipes tracks, sets media offline). This is no longer a
 *     reason to skip anything. The scratch project is disposable and reset-scratch.mjs rebuilds
 *     it from nothing, so destructive tools are swept and the fixture is rebuilt afterwards.
 *   - BLOCKS or COSTS (opens a native modal, launches AME, minutes per call, reaches Creative
 *     Cloud, or writes outside the scratch dir). Still gated, for reasons that have nothing to do
 *     with the project being disposable.
 *
 * Every gate now carries its own reason code, so "how many are still untested and precisely why"
 * is answerable from the output instead of being a single opaque number.
 *
 * Honesty rules this harness follows:
 *   - A skipped tool is reported as UNTESTED, by name and reason. It is never counted as passing.
 *   - `success: true` with `verified: false` is recorded as UNVERIFIED, not as a pass. That
 *     distinction is the whole point of the exercise.
 *   - A tool that could not be given the arguments it requires is NEEDS_ARGS, not a failure.
 *   - Results are flushed to disk after every call, so a hang costs one tool, not the run.
 *
 * Usage:
 *   PREMIERE_MCP_PROFILE=all node scripts/coverage-sweep.mjs [--destructive] [--limit=N] [--only=re]
 */
import { PremiereProBridge } from '../dist/bridge/index.js';
import { PremiereProTools } from '../dist/tools/index.js';
import { ensureHealthy, probeEngine } from './lib/host-recovery.mjs';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT_DIR = join(REPO, '.scratch', 'sweep');
const OUT_JSON = join(OUT_DIR, 'coverage-results.json');

process.env.PREMIERE_TEMP_DIR = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';

const ALLOW_DESTRUCTIVE = process.argv.includes('--destructive');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0);
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
/** Rebuild the fixture after this many destructive calls, so later tools still have material. */
const RESET_EVERY = 20;

/**
 * Gates, by reason. `destructive` is swept unless --destructive is omitted; everything else is
 * held back for a reason that survives the project being disposable.
 */
const GATE = {
  // ---- MODAL: opens a native dialog. We can now clear one with Escape (see host-recovery),
  // but a dialog mid-sweep still blocks every queued call, so these get their own pass.
  countdown_leader: ['modal', 'newUniversalCountingLeader prompts for name/settings'],
  create_adjustment_layer_at: ['modal', 'newTransparentVideo prompts'],
  create_bars_and_tone: ['modal', 'newBarsAndTone prompts'],
  create_color_matte: ['modal', 'newColorMatte opens a colour picker and a name prompt'],
  import_edl: ['modal', 'EDL import prompts for sequence/source media'],
  import_mogrt: ['modal', 'file prompt'],
  import_mogrt_from_library: ['modal', 'library prompt'],
  denoise_clip: ['modal', 'obsolete-effect remap can raise Audio Effects Replacement'],

  // ---- CLOUD: reaches Creative Cloud / a shared production. Outward-facing; not ours to poke.
  convert_project_to_production: ['cloud', 'mutates Creative Cloud production state'],
  create_production_qe: ['cloud', 'creates a cloud production'],
  share_production: ['cloud', 'publishes to a team'],
  sync_production: ['cloud', 'syncs to a server'],
  resolve_conflict: ['cloud', 'mutates shared production state'],

  // ---- SLOW: minutes per call, or hands work to Adobe Media Encoder.
  transcribe_to_srt: ['slow', 'local Whisper transcription'],
  stabilize_clip: ['slow', 'warp stabiliser analysis'],
  auto_reframe_sequence: ['slow', 'reframe analysis, creates sequences'],
  speed_ramp_bake: ['slow', 'ffmpeg render'],
  bake_speed_change: ['slow', 'ffmpeg render'],
  scene_edit_detection: ['slow', 'shot detection over the whole sequence'],
  detect_scene_edits: ['slow', 'shot detection'],
  start_batch_encode: ['slow', 'launches AME'],
  add_to_render_queue: ['slow', 'launches AME'],
  start_encode_and_monitor: ['slow', 'launches AME'],
  encode_file: ['slow', 'launches AME'],
  encode_project_item: ['slow', 'launches AME'],
  batch_export_sequences: ['slow', 'launches AME repeatedly'],
  render_sequence_previews: ['slow', 'full preview render'],
  render_audio: ['slow', 'full audio render'],
  export_with_burn_ins: ['slow', 'render plus effect mutate/restore'],
  export_per_marker_range: ['slow', 'one export per marker'],
  export_per_marker_segments: ['slow', 'one export per marker'],
  export_sequence: ['slow', 'full sequence export'],
  index_footage: ['slow', 'walks and probes a media tree'],

  // ---- OUTSIDE: writes or copies files beyond the scratch directory.
  consolidate_and_transfer: ['outside', 'copies media on disk'],
  archive_master: ['outside', 'copies media on disk'],
  set_scratch_disk_path: ['outside', 'repoints Premiere scratch disks globally'],
  set_project_scratch_disk: ['outside', 'repoints scratch disks'],

  // ---- HOST-STATE: would move the ground under the sweep itself.
  close_project: ['host-state', 'closes the project the sweep is driving'],
  open_project: ['host-state', 'swaps the project mid-sweep'],
  open_fcp_xml: ['host-state', 'swaps/creates project state'],
  open_fcp_xml_project: ['host-state', 'swaps/creates project state'],
  set_workspace: ['host-state', 'rearranges the UI the panel lives in'],
  quit_premiere: ['host-state', 'ends the run'],

  // ---- PLAYBACK: starts audio on an unattended machine at night.
  play_timeline: ['playback', 'starts playback'],
  play_source_monitor: ['playback', 'starts playback'],
  play_in_to_out: ['playback', 'starts playback'],

  // ---- ARBITRARY: the argument IS a program. Covered by the injection-guard suite instead.
  execute_extendscript: ['arbitrary', 'arbitrary code; covered by unit suites'],
  evaluate_expression: ['arbitrary', 'arbitrary code; covered by unit suites'],
  batch_execute: ['arbitrary', 'arbitrary code; covered by unit suites'],
  honesty_selftest: ['arbitrary', 'would recurse into this sweep'],
};

/** Tools that change project state. Swept when --destructive; the fixture is rebuilt after. */
const DESTRUCTIVE = /^(delete|remove|clear|ripple_delete|set_offline|relink|batch_relink|detach_proxy|manage_proxies|replace_clip|batch_replace|unnest|nest_|undo|redo|multiple_undo|save_project_as|restore_recovery|razor|split|trim|extract_selection|lift_selection)/;

const READ_ONLY = new RegExp(
  '^(get|list|is|has|find|search|count|probe|verify|inspect|reflect|read|detect_silence|api_surface|ping|' +
  'qe_sequence_info|caption_qc_report|srt_diff|slowmo_quality_report|safe_area_check|timeline_fingerprint|' +
  'timecode_to_frames|frames_to_timecode|extract_palette|broadcast_safe_check|audio_peaks_report|' +
  'loudness_report|effect_stack_report|shot_status_report|channel_remap_report|todo_marker_report|' +
  'project_media_report|mogrt_params_report|multicam_info|production_sync_status|' +
  'chapter_markers_to_youtube|cut_list_csv|vfx_pull_list|delivery_qc|change_list_report|diff_sequences|' +
  'lint_timeline|validate_srt|capture_program_output|generate_scope)',
);

const line = (s) => process.stdout.write(s + '\n');

function resetFixture(why) {
  line(`\n  [fixture] rebuilding (${why})`);
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'reset-scratch.mjs')], {
    encoding: 'utf8', env: process.env, timeout: 300_000,
  });
  const ok = r.status === 0;
  line(`  [fixture] ${ok ? 'rebuilt' : 'REBUILD FAILED: ' + String(r.stdout || r.stderr).slice(-240)}`);
  return ok;
}

const bridge = new PremiereProBridge();
await bridge.initialize();
const tools = new PremiereProTools(bridge);

const state = await bridge.executeScript(
  '(function(){ return JSON.stringify({ project: String(app.project.name), path: String(app.project.path), version: String(app.version) }); })();',
);
if (!/test|scratch|untitled|fixture/i.test(String(state.project))) {
  line(`REFUSING: "${state.project}" is not a scratch project. Nothing was run.`);
  process.exit(2);
}
line(`host: Premiere ${state.version}`);
line(`project: ${state.project}`);
line(`destructive tier: ${ALLOW_DESTRUCTIVE ? 'ENABLED' : 'disabled (pass --destructive)'}`);

/** Live facts, refreshed after every fixture rebuild so ids stay valid. */
async function readContext() {
  return bridge.executeScript(`(function(){
    var out = { sequenceId:null, sequenceName:null, secondSequenceId:null, itemId:null, itemId2:null,
                binId:null, mediaPath:null, trackCount:0, clipCount:0, markerName:null, effectName:null,
                clipId:null, clipId2:null, audioClipId:null };
    try {
      var seq = app.project.activeSequence;
      if (seq) {
        out.sequenceId = String(seq.sequenceID); out.sequenceName = String(seq.name);
        out.trackCount = seq.videoTracks.numTracks;
        if (seq.videoTracks.numTracks > 0) out.clipCount = seq.videoTracks[0].clips.numItems;
        if (out.clipCount > 0) {
          var c = seq.videoTracks[0].clips[0];
          // TWO DIFFERENT IDS, and conflating them cost 45 tools a fair test in the first run:
          //   TrackItem.nodeId   -> identifies the clip ON THE TIMELINE  (clipId)
          //   ProjectItem.nodeId -> identifies the master item IN THE BIN (projectItemId)
          // Passing the project-item id where a clip id was wanted produced "Clip not found"
          // for a third of the catalogue, which read as 45 broken tools rather than one
          // broken harness.
          out.clipId = String(c.nodeId);
          out.itemId = String(c.projectItem.nodeId);
          try { out.mediaPath = String(c.projectItem.getMediaPath()); } catch (e1) {}
          if (c.components.numItems > 0) out.effectName = String(c.components[c.components.numItems-1].displayName);
          // A second clip so copy/compare tools get two distinct, valid targets.
          if (out.clipCount > 1) {
            var c2 = seq.videoTracks[0].clips[1];
            out.clipId2 = String(c2.nodeId);
            out.itemId2 = String(c2.projectItem.nodeId);
          }
          // Select it, so the selection-driven tools have something to act on.
          try { seq.setSelection([c]); } catch (eSel) {}
        }
        if (seq.audioTracks.numTracks > 0 && seq.audioTracks[0].clips.numItems > 0) {
          out.audioClipId = String(seq.audioTracks[0].clips[0].nodeId);
        }
        if (seq.markers.numMarkers > 0) out.markerName = String(seq.markers.getFirstMarker().name);
      }
      for (var i=0;i<app.project.sequences.numSequences;i++) {
        var s = app.project.sequences[i];
        if (String(s.sequenceID) !== out.sequenceId) { out.secondSequenceId = String(s.sequenceID); break; }
      }
      var root = app.project.rootItem;
      for (var j=0;j<root.children.numItems;j++) if (root.children[j].type === 2) { out.binId = String(root.children[j].nodeId); break; }
    } catch (e) { out.error = e.toString(); }
    return JSON.stringify(out);
  })();`);
}

let ctx = await readContext();
line(`context: seq=${ctx.sequenceName} tracks=${ctx.trackCount} clips=${ctx.clipCount} item=${ctx.itemId ? 'yes' : 'no'}`);

const SRT = join(REPO, '.scratch', 'fixture-captions.srt');
const TMP_OUT = join(REPO, '.scratch', 'sweep', 'out');
if (!existsSync(TMP_OUT)) mkdirSync(TMP_OUT, { recursive: true });

/** Best-effort arguments by parameter name. Missing a required arg is NEEDS_ARGS, not failure. */
function argsFor(tool) {
  const shape = tool.inputSchema?._def?.shape ?? tool.inputSchema?.shape;
  let keys = [];
  try { keys = Object.keys(typeof shape === 'function' ? shape() : (shape ?? {})); } catch { keys = []; }
  const a = {};
  for (const k of keys) {
    if (/^(sequenceId|seqId|sourceSequenceId)$/i.test(k)) a[k] = ctx.sequenceId ?? undefined;
    else if (/^(targetSequenceId|destSequenceId|otherSequenceId|sequenceBId)$/i.test(k)) a[k] = ctx.secondSequenceId ?? undefined;
    else if (/^(clipId|trackItemId)$/i.test(k)) a[k] = ctx.clipId ?? undefined;
    else if (/^(sourceClipId|clipAId|fromClipId)$/i.test(k)) a[k] = ctx.clipId ?? undefined;
    else if (/^(targetClipId|clipBId|toClipId|secondClipId)$/i.test(k)) a[k] = ctx.clipId2 ?? ctx.clipId ?? undefined;
    else if (/^audioClipId$/i.test(k)) a[k] = ctx.audioClipId ?? undefined;
    else if (/^(sourceProjectItemId|oldItemId)$/i.test(k)) a[k] = ctx.itemId ?? undefined;
    else if (/^(targetProjectItemId|newItemId|newProjectItemId)$/i.test(k)) a[k] = ctx.itemId2 ?? ctx.itemId ?? undefined;
    else if (/(projectItemId|itemId|nodeId)$/i.test(k)) a[k] = ctx.itemId ?? undefined;
    else if (/clipIds$/i.test(k)) a[k] = ctx.clipId ? [ctx.clipId] : undefined;
    else if (/^binId$/i.test(k)) a[k] = ctx.binId ?? undefined;
    else if (/srtPath|captionPath/i.test(k)) a[k] = SRT;
    else if (/(output|dest|target|save)(File)?Path$/i.test(k)) a[k] = join(TMP_OUT, `sweep_${Date.now()}.png`);
    else if (/(file|media|clip|source|input|image)Path$/i.test(k)) a[k] = ctx.mediaPath ?? undefined;
    else if (/^(trackIndex|videoTrackIndex|audioTrackIndex)$/i.test(k)) a[k] = 0;
    else if (/^clipIndex$/i.test(k)) a[k] = 0;
    else if (/^(count|limit|maxResults)$/i.test(k)) a[k] = 3;
    else if (/^(seconds|time|atSeconds|startSeconds|position)$/i.test(k)) a[k] = 0.5;
    else if (/^(durationSeconds|duration)$/i.test(k)) a[k] = 1;
    else if (/^(inPoint|inSeconds)$/i.test(k)) a[k] = 0;
    else if (/^(outPoint|outSeconds)$/i.test(k)) a[k] = 2;
    else if (/^trackType$/i.test(k)) a[k] = 'video';
    else if (/panelName/i.test(k)) a[k] = 'Timeline';
    else if (/effectName/i.test(k)) a[k] = 'Gaussian Blur';
    else if (/transitionName/i.test(k)) a[k] = 'Cross Dissolve';
    else if (/presetName|lumetriPreset/i.test(k)) a[k] = 'SL BLUE STEEL';
    else if (/markerName/i.test(k)) a[k] = ctx.markerName ?? 'fixture_comment';
    else if (/^name$/i.test(k)) a[k] = 'sweep_probe';
    // Real values that exist on the fixture clip. 'Blurriness' only exists if Gaussian Blur was
    // applied, so it produced "Property not found" rather than testing anything; Opacity is on
    // every clip and is a plain scalar, which also avoids the multi-value Position trap.
    else if (/^(componentName|effectComponent)$/i.test(k)) a[k] = 'Opacity';
    else if (/^(propertyName|paramName)$/i.test(k)) a[k] = 'Opacity';
    else if (/^(enabled|enable|visible|locked|muted|reverse|recursive|selected|targeted|suppressUI|includeAudio|maintainAudioPitch)$/i.test(k)) a[k] = true;
    else if (/^(value|amount|level|gain|opacityValue)$/i.test(k)) a[k] = 50;
    else if (/^(scale|scaleValue)$/i.test(k)) a[k] = 100;
    else if (/^(rotation|degrees|angle)$/i.test(k)) a[k] = 15;
    else if (/^(volumeDb|db|decibels)$/i.test(k)) a[k] = -6;
    else if (/^(text|comment|label|note)$/i.test(k)) a[k] = 'sweep probe';
    else if (/^(newName|renameTo)$/i.test(k)) a[k] = 'sweep_renamed';
    else if (/^(colorLabel|color)$/i.test(k)) a[k] = 'Blue';
  }
  for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
  return { args: a, keys };
}

const results = [];
let destructiveCount = 0;
const recoveryState = { recoveries: [], maxRecoveries: 6, probeTimeoutMs: 12_000 };

function flush() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const tally = results.reduce((m, r) => { m[r.outcome] = (m[r.outcome] || 0) + 1; return m; }, {});
  writeFileSync(OUT_JSON, JSON.stringify({
    host: state, startedAtIso: STARTED_ISO, tally,
    recoveries: recoveryState.recoveries, results,
  }, null, 2));
}
const STARTED_ISO = new Date().toISOString();

let catalogue = tools.getAvailableTools();
if (ONLY) catalogue = catalogue.filter((t) => new RegExp(ONLY).test(t.name));
if (LIMIT) catalogue = catalogue.slice(0, LIMIT);
line(`sweeping ${catalogue.length} tools\n`);

for (let i = 0; i < catalogue.length; i++) {
  const tool = catalogue[i];
  const name = tool.name;

  if (GATE[name]) {
    results.push({ name, outcome: 'GATED', reason: GATE[name][0], detail: GATE[name][1] });
    continue;
  }

  const destructive = DESTRUCTIVE.test(name) || !READ_ONLY.test(name);
  if (destructive && !ALLOW_DESTRUCTIVE) {
    results.push({ name, outcome: 'GATED', reason: 'destructive', detail: 'run with --destructive' });
    continue;
  }

  const { args, keys } = argsFor(tool);
  const startedAt = Date.now();
  let record;
  try {
    const r = await tools.executeTool(name, args);
    const ms = Date.now() - startedAt;
    if (r && r.success === false) {
      const err = String(r.error || '').slice(0, 300);
      // A schema rejection means the harness could not supply the arguments, which is a gap in
      // the harness rather than evidence about the tool.
      const isArgs = /Invalid arguments|expected|required|not found by id|Sequence not found/i.test(err);
      record = { name, outcome: isArgs ? 'NEEDS_ARGS' : 'FAIL', ms, error: err, argKeys: Object.keys(args) };
    } else if (r && r.verified === false) {
      record = { name, outcome: 'UNVERIFIED', ms, note: String(r.error || r.note || '').slice(0, 300) };
    } else {
      record = { name, outcome: r && r.verified === true ? 'PASS_VERIFIED' : 'PASS', ms };
    }
  } catch (e) {
    record = { name, outcome: 'THREW', ms: Date.now() - startedAt, error: String(e?.message || e).slice(0, 300) };
  }

  // The health check runs after EVERY call so a wedge is attributed to the tool that caused it
  // rather than to the next innocent one — the single most common misdiagnosis in this project.
  const health = await ensureHealthy(name, recoveryState);
  if (!health.ok) {
    record.killedEngine = true;
    record.engineVerdict = health.verdict?.state;
    if (health.gaveUp) {
      results.push(record); flush();
      line(`\n!! ${name}: ${health.error}`);
      line('!! Stopping the host lane rather than thrashing Premiere.');
      break;
    }
  } else if (health.recovery) {
    record.killedEngine = true;
    record.recoveredInMs = health.recovery.elapsedMs;
    ctx = await readContext();
  }

  results.push(record);
  const mark = { PASS_VERIFIED: 'v', PASS: '.', UNVERIFIED: '?', NEEDS_ARGS: '-', FAIL: 'F', THREW: 'X' }[record.outcome] || '.';
  process.stdout.write(mark + (record.killedEngine ? `[KILLED:${name}]` : ''));
  if ((i + 1) % 80 === 0) process.stdout.write(`  ${i + 1}/${catalogue.length}\n`);

  if (destructive) {
    destructiveCount++;
    if (destructiveCount % RESET_EVERY === 0) {
      resetFixture(`after ${RESET_EVERY} destructive calls`);
    }
    // Re-read after EVERY mutating call. Ids are not stable across edits, and a stale id is
    // indistinguishable in the results from a tool that cannot find its target — six tools
    // reported "Project item not found" in the first run for exactly this reason.
    ctx = await readContext();
  }
  flush();
}

flush();

const tally = results.reduce((m, r) => { m[r.outcome] = (m[r.outcome] || 0) + 1; return m; }, {});
line('\n\n=== COVERAGE SWEEP ===');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) line(`  ${k.padEnd(14)} ${v}`);
const executed = results.filter((r) => r.outcome !== 'GATED' && r.outcome !== 'NEEDS_ARGS').length;
line(`\n  executed against the host: ${executed}`);
line(`  engine kills: ${results.filter((r) => r.killedEngine).length}`);
if (recoveryState.recoveries.length) {
  line('\n  recoveries (each names the tool that ran immediately before):');
  for (const r of recoveryState.recoveries) line(`    ${r.culprit} -> ${r.verdictBefore}, recovered=${r.recovered}`);
}
const gates = results.filter((r) => r.outcome === 'GATED')
  .reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {});
line('\n  still untested, by reason:');
for (const [k, v] of Object.entries(gates).sort((a, b) => b[1] - a[1])) line(`    ${k.padEnd(12)} ${v}`);
line(`\n  full results: ${OUT_JSON}`);
process.exit(0);
