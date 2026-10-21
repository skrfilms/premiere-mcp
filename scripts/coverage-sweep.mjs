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
import { ensureHealthy, probeEngine, trackOwnCommands } from './lib/host-recovery.mjs';
import { requireScratchProject, checkStillScratch, needsScratchRecheck } from './lib/require-scratch-project.mjs';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT_DIR = join(REPO, '.scratch', 'sweep');
const OUT_JSON = join(OUT_DIR, 'coverage-results.json');

process.env.PREMIERE_TEMP_DIR = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';
// Tools run in-process, and persistPrefToFile (src/tools/index.ts) reads this on every call, so
// setting it here — before the first tool — is enough to stop any tool rewriting Adobe's prefs
// file. Those prefs are the user's, global to every project, and outlive the scratch fixture.
process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1';

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
  create_project: ['host-state', 'opens a second project and makes it active, escaping the scratch guard'],

  // ---- USER-STATE: changes the user's machine, not the project. Disposable fixtures do not help.
  set_autosave_settings: ['user-state', 'rewrites the user\'s global Auto Save preferences'],
  write_clipboard: ['user-state', 'overwrites the user\'s system clipboard'],

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
// Before the first command, so every id this process publishes is known to recovery: a BUSY panel
// on one of ours is this sweep's own wedge, on any other id it is somebody else's work.
const ownsCommand = trackOwnCommands(bridge);

// The shared guard, not the name-only regex this used to carry inline. A name is not an identity,
// and this sweep runs destructive tools: it needs the path pin and the one-project-open rule the
// other harnesses already enforce, and the pinned path for the re-checks below.
const pinned = await requireScratchProject(bridge, 'coverage-sweep');
const state = await bridge.executeScript(
  '(function(){ return JSON.stringify({ project: String(app.project.name), path: String(app.project.path), version: String(app.version) }); })();',
);
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

/**
 * Arguments for a tool, SCHEMA-DRIVEN with live-context overrides.
 *
 * The first version matched on parameter NAME only, and name patterns cannot cover 638 tools:
 * NEEDS_ARGS became the largest bucket in the sweep (150 tools), which is a limit of this harness
 * rather than a fact about the catalogue. This version asks the schema what each field IS —
 * string, number, boolean, enum, array, object, record — supplies a real host id or path when the
 * name is recognisable, and then CHECKS the result against the schema instead of hoping.
 *
 * A field whose seeded value the schema still rejects is reported, so the gap is visible rather
 * than silently becoming "needs args".
 */
const kindOf = (schema) => schema?.constructor?.name ?? '';

/** Unwrap Optional/Nullable/Default to the schema that actually validates. */
function unwrap(schema) {
  let cur = schema, guard = 0;
  while (cur && guard++ < 8) {
    const k = kindOf(cur);
    if (k === 'ZodOptional' || k === 'ZodNullable' || k === 'ZodDefault') {
      cur = typeof cur.unwrap === 'function' ? cur.unwrap() : cur._def?.innerType;
      continue;
    }
    break;
  }
  return cur ?? schema;
}

/** A live value when the parameter name tells us what the host expects. */
function contextValue(key) {
  if (/^(sequenceId|seqId|sourceSequenceId)$/i.test(key)) return ctx.sequenceId;
  if (/^(targetSequenceId|destSequenceId|otherSequenceId|sequenceBId)$/i.test(key)) return ctx.secondSequenceId ?? ctx.sequenceId;
  if (/^(clipId|trackItemId|sourceClipId|clipAId|fromClipId)$/i.test(key)) return ctx.clipId;
  if (/^(targetClipId|clipBId|toClipId|secondClipId)$/i.test(key)) return ctx.clipId2 ?? ctx.clipId;
  if (/^audioClipId$/i.test(key)) return ctx.audioClipId;
  if (/^binId$/i.test(key)) return ctx.binId;
  if (/^(targetProjectItemId|newItemId|newProjectItemId)$/i.test(key)) return ctx.itemId2 ?? ctx.itemId;
  if (/(projectItemId|itemId|nodeId)$/i.test(key)) return ctx.itemId;
  if (/srtPath|captionPath/i.test(key)) return SRT;
  if (/(output|dest|target|save)(File)?Path$/i.test(key)) return join(TMP_OUT, `sweep_${Date.now()}.png`);
  if (/(file|media|clip|source|input|image)Path$/i.test(key)) return ctx.mediaPath;
  if (/^presetPath$/i.test(key)) return undefined; // a real .epr/.sqpreset is not synthesisable
  return undefined;
}

/** Plausible scalars by name, for values where any number would pass the schema but not the tool. */
const NAMED_NUMBERS = {
  trackIndex: 0, videoTrackIndex: 0, audioTrackIndex: 0, clipIndex: 0, index: 0,
  seconds: 0.5, time: 0.5, timeSecs: 0.5, atSeconds: 0.5, startSeconds: 0.5, startSecs: 0.5,
  position: 0.5, playheadSeconds: 0.5,
  duration: 1, durationSeconds: 1, durationSecs: 1, durationSeconds2: 1,
  inPoint: 0, inSeconds: 0, outPoint: 2, outSeconds: 2,
  opacity: 50, value: 50, amount: 50, level: 50, gain: 50, scale: 100,
  rotation: 15, degrees: 15, angle: 15, volumeDb: -6, db: -6, decibels: -6,
  count: 3, limit: 3, maxResults: 3, frames: 48, fps: 24, frameRate: 24, sampleRate: 48000,
  width: 1280, height: 720, bitrate: 8, quality: 80,
};
const NAMED_STRINGS = {
  trackType: 'video', panelName: 'Timeline', effectName: 'Gaussian Blur',
  transitionName: 'Cross Dissolve', presetName: 'SL BLUE STEEL',
  componentName: 'Opacity', propertyName: 'Opacity', paramName: 'Opacity',
  name: 'sweep_probe', newName: 'sweep_renamed', renameTo: 'sweep_renamed',
  text: 'sweep probe', comment: 'sweep probe', label: 'sweep probe',
  colorLabel: 'Blue', color: 'Blue', format: 'H.264', position: 'end',
};

/** A value of the right SHAPE for this schema. */
function seedValue(schema, key, depth = 0) {
  const inner = unwrap(schema);
  const kind = kindOf(inner);

  const fromContext = contextValue(key);
  if (fromContext !== undefined && (kind === 'ZodString' || kind === 'ZodAny' || kind === 'ZodUnknown')) return fromContext;

  switch (kind) {
    case 'ZodString': return NAMED_STRINGS[key] ?? 'sweep_probe';
    case 'ZodNumber': return NAMED_NUMBERS[key] ?? 1;
    case 'ZodBoolean': return true;
    case 'ZodEnum': {
      const opts = inner.options ?? inner._def?.values ?? [];
      return opts.length ? opts[0] : 'sweep_probe';
    }
    case 'ZodLiteral': return inner.value ?? inner._def?.value;
    case 'ZodArray': {
      if (depth > 2) return [];
      const el = inner.element ?? inner._def?.type;
      const single = contextValue(key.replace(/s$/, '')) ?? (el ? seedValue(el, key.replace(/s$/, ''), depth + 1) : 'sweep_probe');
      return [single];
    }
    case 'ZodObject': {
      if (depth > 2) return {};
      const out = {};
      for (const [k, v] of Object.entries(inner.shape ?? {})) out[k] = seedValue(v, k, depth + 1);
      return out;
    }
    case 'ZodRecord': {
      const vt = inner.valueType ?? inner._def?.valueType;
      return { Brightness: vt ? seedValue(vt, 'value', depth + 1) : '1' };
    }
    case 'ZodUnion': {
      const opts = inner.options ?? inner._def?.options ?? [];
      return opts.length ? seedValue(opts[0], key, depth + 1) : 'sweep_probe';
    }
    default:
      return fromContext ?? NAMED_STRINGS[key] ?? 'sweep_probe';
  }
}

function argsFor(tool) {
  const shape = tool.inputSchema?._def?.shape ?? tool.inputSchema?.shape;
  let entries = [];
  try {
    const resolved = typeof shape === 'function' ? shape() : (shape ?? {});
    entries = Object.entries(resolved);
  } catch { entries = []; }

  const args = {};
  const unfillable = [];
  for (const [key, fieldSchema] of entries) {
    const optional = ['ZodOptional', 'ZodDefault', 'ZodNullable'].includes(kindOf(fieldSchema));
    let value = seedValue(fieldSchema, key);
    // A recognised id that the host does not currently have is worse than omitting it: the tool
    // would fail on a null id rather than on its own logic.
    if (value === undefined || value === null) {
      if (!optional) unfillable.push(key);
      continue;
    }
    args[key] = value;
  }

  // Ask the schema whether this is acceptable, rather than assuming. A rejection here is a
  // harness gap and is reported as such.
  let schemaOk = true, schemaError = null;
  try {
    if (typeof tool.inputSchema?.safeParse === 'function') {
      const parsed = tool.inputSchema.safeParse(args);
      schemaOk = parsed.success;
      if (!parsed.success) schemaError = String(parsed.error?.issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')).slice(0, 200);
    }
  } catch (e) { schemaOk = false; schemaError = String(e?.message || e).slice(0, 160); }

  return { args, unfillable, schemaOk, schemaError };
}

const results = [];
let destructiveCount = 0;
const recoveryState = { recoveries: [], maxRecoveries: 6, probeTimeoutMs: 12_000, ownsCommand, pinned };
/** Host calls since the scratch project was last re-pinned. */
let callsSinceScratchCheck = 0;
/** Why the run stopped early because the target moved, or null. */
let scratchDrift = null;

function flush() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const tally = results.reduce((m, r) => { m[r.outcome] = (m[r.outcome] || 0) + 1; return m; }, {});
  writeFileSync(OUT_JSON, JSON.stringify({
    host: state, startedAtIso: STARTED_ISO, tally, scratchDrift,
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

  const { args, unfillable, schemaOk, schemaError } = argsFor(tool);
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
      // Distinguish "the harness could not build valid arguments" from "the tool rejected valid
      // arguments". Collapsing those makes a harness gap look like a tool bug and vice versa.
      if (isArgs) { record.harnessGap = !schemaOk || unfillable.length > 0; record.unfillable = unfillable; record.schemaError = schemaError; }
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
  /** Set when the host was Escaped, relaunched or rebuilt, any of which can change the active project. */
  let hostDisturbed = Boolean(health.clearedModal || health.recovery);
  if (!health.ok) {
    record.engineVerdict = health.verdict?.state;
    // A refusal is not a kill: the host was left alone because someone else is using it. Stop
    // rather than keep sweeping into a panel another client is driving.
    if (health.contended) {
      results.push(record); flush();
      line(`\n!! ${name}: ${health.error}`);
      line('!! Stopping: another client is using this host, so nothing more here is trustworthy or safe.');
      break;
    }
    record.killedEngine = true;
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
      hostDisturbed = true;
    }
    // Re-read after EVERY mutating call. Ids are not stable across edits, and a stale id is
    // indistinguishable in the results from a tool that cannot find its target — six tools
    // reported "Project item not found" in the first run for exactly this reason.
    ctx = await readContext();
  }

  // RE-PIN THE TARGET. The startup guard only speaks for the moment it ran, and this sweep calls
  // hundreds of tools that act on whichever project is ACTIVE. Re-checked every few calls, straight
  // after anything whose name says it touches projects, and after any Escape, relaunch or fixture
  // rebuild. A failed check stops the run with the results already flushed.
  callsSinceScratchCheck++;
  if (hostDisturbed || needsScratchRecheck(name, callsSinceScratchCheck)) {
    const pin = await checkStillScratch(bridge, pinned);
    if (!pin.ok) {
      scratchDrift = pin.reason;
      flush();
      line(`\n!! ${name}: the scratch project is no longer the target.`);
      line(`!! ${pin.reason}`);
      line('!! Nothing further was run. Check Premiere by hand before saving anything.');
      break;
    }
    callsSinceScratchCheck = 0;
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
