#!/usr/bin/env node
/**
 * Live smoke sweep — exercises the tool catalogue against a running Premiere host.
 *
 * The catalogue grew from 309 to ~600 tools largely through generated code. The unit
 * suites prove those tools EMIT parseable ExtendScript with no undefined identifiers;
 * they cannot prove the host accepts the calls. This sweep closes that gap by actually
 * invoking tools and recording what the host said.
 *
 * Tools are split into three tiers, and the tier assignment is the safety mechanism:
 *
 *   READ   - observational. Invoked with best-effort arguments. A failure here is a real
 *            defect (bad signature, wrong property name, ES3 violation the parser missed).
 *   MUTATE - changes the project. NOT invoked by default; --mutate opts in, and only ever
 *            against a scratch project.
 *   SKIP   - never invoked by this harness, for one of three reasons recorded per tool:
 *            (a) destructive/irreversible, (b) known to open a BLOCKING native dialog
 *            that hangs the CEP bridge (the newColorMatte/newBlackVideo family cost us
 *            several bridge restarts), (c) long-running or reaches an external service.
 *
 * SKIP is not "assumed working". Skipped tools are reported as untested, by name and
 * reason, so the summary never overstates coverage.
 *
 * Usage:
 *   PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/live-smoke-sweep.mjs
 *   PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/live-smoke-sweep.mjs --mutate
 */
import { PremiereProBridge } from '../dist/bridge/index.js';
import { PremiereProTools } from '../dist/tools/index.js';
import { writeFileSync } from 'node:fs';
import { requireScratchProject } from './lib/require-scratch-project.mjs';
import { collectEnvironment, recordSweep } from './lib/verification-ledger.mjs';

const ALLOW_MUTATE = process.argv.includes('--mutate');

/** How long one tool gets before the harness gives up on it and records a failure. */
const TOOL_TIMEOUT_MS = 25_000;
/**
 * How long the panel may report "processing" before the sweep calls it wedged and aborts.
 * Must exceed TOOL_TIMEOUT_MS with margin, or a slow tool aborts the whole run (see below).
 */
const WEDGE_MS = 40_000;
const REPORT_PATH = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/tmp/live-smoke-report.json';

/** Never invoked. Each entry carries the reason it is unsafe for an unattended sweep. */
const SKIP = {
  // (b) BLOCKING NATIVE DIALOG — these hang the CEP bridge until a human dismisses them.
  //     Learned the hard way: newColorMatte opened a colour picker + name prompt and the
  //     bridge had to be restarted.
  countdown_leader: 'dialog: newUniversalCountingLeader prompts',
  create_adjustment_layer_at: 'dialog: newTransparentVideo prompts',
  import_edl: 'dialog: EDL import prompts for sequence/source media',
  import_mogrt: 'dialog risk + writes to project',
  import_mogrt_from_library: 'dialog risk + writes to project',
  create_bars_and_tone: 'dialog: newBarsAndTone prompts',

  // (a) DESTRUCTIVE / IRREVERSIBLE
  close_project: 'closes the project out from under the sweep',
  delete_sequence: 'destructive',
  delete_project_item: 'destructive',
  delete_multiple_project_items: 'destructive',
  delete_bin: 'destructive',
  delete_track: 'destructive',
  delete_empty_tracks: 'destructive (removes tracks)',
  delete_preview_files: 'destructive (throws away renders)',
  remove_from_timeline: 'destructive',
  remove_selected_clips: 'destructive',
  remove_all_effects: 'destructive',
  remove_all_effects_qe: 'destructive',
  remove_effect: 'destructive',
  remove_effect_by_name: 'destructive',
  remove_effect_at_index: 'destructive',
  remove_mogrt_clip: 'destructive',
  remove_time_remap: 'destructive',
  remove_keyframe: 'destructive',
  remove_keyframe_range: 'destructive',
  remove_srt_cue: 'destructive to file',
  ripple_delete: 'destructive',
  set_offline: 'breaks media links',
  relink_media: 'rewrites media links',
  batch_relink_by_pattern: 'rewrites media links in bulk',
  batch_relink_by_prefix: 'rewrites media links in bulk',
  detach_proxy: 'mutates proxy attachment',
  manage_proxies: 'mutates proxy attachment',
  consolidate_and_transfer: 'copies media on disk',
  archive_master: 'copies media on disk',
  save_project_as: 'writes a new project file',
  batch_replace_clips: 'destructive swap',
  replace_clip: 'destructive swap',
  replace_clip_media: 'destructive swap',
  unnest_sequence: 'destructive restructure',
  nest_clips: 'destructive restructure',
  nest_all_v1_clips: 'destructive restructure',

  // (a) STATE CONFUSION — would invalidate the sweep's own assumptions mid-run
  undo: 'rewinds the sweep',
  redo: 'replays unknown state',
  multiple_undo: 'rewinds the sweep',
  open_project: 'swaps the project mid-sweep',
  open_fcp_xml: 'swaps/creates project state',
  open_fcp_xml_project: 'swaps/creates project state',
  import_project_items: 'mutates project structure',
  set_active_sequence: 'moves the target out from under later probes',
  set_workspace: 'rearranges the UI',
  restore_recovery_checkpoint: 'replaces sequence state',

  // (c) EXTERNAL SERVICE / CLOUD — reaches Creative Cloud or a team production
  convert_project_to_production: 'mutates Creative Cloud production state',
  create_production_qe: 'creates cloud production',
  share_production: 'publishes to team',
  sync_production: 'syncs to server',
  resolve_conflict: 'mutates shared production',

  // (c) LONG-RUNNING — minutes, or launches AME
  transcribe_to_srt: 'long-running ML transcription',
  stabilize_clip: 'long-running warp analysis',
  auto_reframe_sequence: 'long-running, creates sequences',
  speed_ramp_bake: 'long ffmpeg render',
  bake_speed_change: 'long ffmpeg render',
  scene_edit_detection: 'long-running analysis',
  detect_scene_edits: 'long-running analysis',
  start_batch_encode: 'launches AME',
  add_to_render_queue: 'launches AME',
  start_encode_and_monitor: 'launches AME',
  encode_file: 'launches AME',
  encode_project_item: 'launches AME',
  batch_export_sequences: 'launches AME repeatedly',
  render_sequence_previews: 'long render',
  render_audio: 'long render',
  export_with_burn_ins: 'long render + mutates then restores effects',
  export_per_marker_range: 'many long exports',
  export_per_marker_segments: 'many long exports',

  // (a) PLAYBACK — starts audio/video playing on the user's machine
  play_timeline: 'starts playback',
  play_source_monitor: 'starts playback',
  play_in_to_out: 'starts playback',

  // arbitrary code execution / recursion — tested separately and deliberately
  execute_extendscript: 'arbitrary code; tested separately',
  evaluate_expression: 'arbitrary code; tested separately',
  batch_execute: 'arbitrary code; tested separately',
  honesty_selftest: 'would recurse into this sweep',
};

/** Read-only if it only observes. Anything not matched here and not skipped is MUTATE. */
function isReadOnly(name) {
  return (
    /^(get|list|is|has|find|search|count|probe|verify|inspect|reflect|read|detect|api|qe_sequence_info|caption_qc_report|srt_diff|slowmo_quality_report|safe_area_check|timeline_fingerprint|timecode_to_frames|frames_to_timecode|extract_palette|broadcast_safe_check|audio_peaks_report|loudness_report|effect_stack_report|shot_status_report|channel_remap_report|todo_marker_report|project_media_report|mogrt_params_report|multicam_info|production_sync_status|chapter_markers_to_youtube|cut_list_csv|vfx_pull_list|delivery_qc|change_list_report|diff_sequences|lint_timeline|ping)/.test(name) &&
    !/^(get_?)?(set|delete|remove|clear)/.test(name)
  );
}

const line = (s) => process.stdout.write(s + '\n');

async function main() {
  const bridge = new PremiereProBridge();
  await bridge.initialize();
  const tools = new PremiereProTools(bridge);

  // Confirm we are pointed at a scratch project before anything else runs. Via the shared helper,
  // not the inline copy this used to carry: that copy was missing 'fixture', so it refused a
  // project the other three harnesses accept, and nothing would have caught the divergence.
  await requireScratchProject(bridge, 'live-smoke-sweep');
  const version = await bridge.executeScript('return JSON.stringify({ version: String(app.version) });');
  line(`host: Premiere ${version.version}`);
  line(`mutating tools: ${ALLOW_MUTATE ? 'ENABLED (--mutate)' : 'disabled'}`);
  line('');

  // Real ids/paths so read tools get plausible arguments instead of undefined.
  const ctx = await bridge.executeScript(`
    var out = { sequenceId: null, itemId: null, mediaPath: null, trackCount: 0, clipCount: 0 };
    try {
      var seq = app.project.activeSequence;
      if (seq) {
        out.sequenceId = String(seq.sequenceID);
        out.trackCount = seq.videoTracks.numTracks;
        if (seq.videoTracks.numTracks > 0) out.clipCount = seq.videoTracks[0].clips.numItems;
        if (out.clipCount > 0) {
          var c = seq.videoTracks[0].clips[0];
          out.itemId = String(c.projectItem.nodeId);
          out.mediaPath = String(c.projectItem.getMediaPath());
        }
      }
    } catch (e) { out.error = e.toString(); }
    return JSON.stringify(out);
  `);
  line(`context: seq=${ctx.sequenceId} tracks=${ctx.trackCount} clips=${ctx.clipCount}`);
  line('');

  // Best-effort arguments by parameter name. A read tool that needs an id it cannot be
  // given is reported as skipped-for-args rather than counted as a failure.
  function argsFor(tool) {
    const shape = tool.inputSchema?._def?.shape ?? tool.inputSchema?.shape;
    let keys = [];
    try { keys = Object.keys(typeof shape === 'function' ? shape() : (shape ?? {})); } catch { keys = []; }
    const a = {};
    for (const k of keys) {
      if (/sequenceId|seqId/i.test(k)) a[k] = ctx.sequenceId ?? undefined;
      else if (/projectItemId|itemId/i.test(k)) a[k] = ctx.itemId ?? undefined;
      else if (/(file|media|clip|source|input)Path$/i.test(k)) a[k] = ctx.mediaPath ?? undefined;
      else if (/trackIndex/i.test(k)) a[k] = 0;
      else if (/clipIndex/i.test(k)) a[k] = 0;
      else if (/^(count|limit)$/i.test(k)) a[k] = 3;
      else if (/panelName/i.test(k)) a[k] = 'Timeline';
      else if (/effectName/i.test(k)) a[k] = 'Gaussian Blur';
    }
    for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
    return { args: a, required: keys };
  }

  const catalogue = tools.getAvailableTools();
  const results = { pass: [], fail: [], skipped: [], noArgs: [], mutateDeferred: [], abortedAfter: null };
  /** name -> the tool's own `verified` field, for tools that report one. Fed to the ledger. */
  const verifiedFlag = new Map();

  // A tool that opens a modal dialog wedges the ExtendScript engine until a human
  // clicks it. Without this check the sweep keeps firing and every later call piles up
  // behind the modal — one run reached 398 queued commands and reported nothing useful,
  // because the tool left "currently executing" was simply the first one stuck in line,
  // not the one that opened the dialog. Reading the panel heartbeat between calls turns
  // that into an immediate abort that names the actual culprit.
  //
  // WEDGE_MS must stay comfortably ABOVE TOOL_TIMEOUT_MS. When it was below (12s vs 25s), any
  // legitimately slow tool tripped the detector before its own timeout could resolve, and the
  // sweep aborted on a bridge that was working fine: a --mutate run stopped after 100 of 647
  // tools blaming get_export_progress, which was simply waiting on the encoder and drained on
  // its own ~45s later. A false abort is worse than a late one — it reads as a wedged host and
  // silently costs the other 547 tools their coverage.
  const heartbeatPath = `${process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge'}/bridge-heartbeat.json`;
  const { readFileSync } = await import('node:fs');
  let stuckSince = null;
  function bridgeWedged() {
    try {
      const hb = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
      if (hb.isProcessing) {
        stuckSince = stuckSince ?? Date.now();
        return Date.now() - stuckSince > WEDGE_MS;
      }
      stuckSince = null;
      return false;
    } catch { return false; }
  }

  let lastInvoked = null;
  for (const tool of catalogue) {
    const name = tool.name;

    if (bridgeWedged()) {
      line('');
      line('');
      line(`!! ABORTED: the CEP bridge has been busy >${WEDGE_MS / 1000}s and is not draining.`);
      line(`!! The tool that most likely opened a modal dialog is: ${lastInvoked}`);
      line('!! Dismiss the dialog in Premiere, add that tool to SKIP (or fix it), and re-run.');
      results.abortedAfter = lastInvoked;
      break;
    }

    if (SKIP[name]) { results.skipped.push({ name, reason: SKIP[name] }); continue; }

    const readOnly = isReadOnly(name);
    if (!readOnly && !ALLOW_MUTATE) { results.mutateDeferred.push(name); continue; }

    const { args } = argsFor(tool);
    lastInvoked = name;
    try {
      const r = await Promise.race([
        tools.executeTool(name, args),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`harness timeout ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)),
      ]);
      if (r && r.success === false) {
        const err = String(r.error ?? 'unknown');
        // Missing-required-argument is the harness's shortcoming, not the tool's.
        if (/Invalid arguments|expected .*received undefined|required/i.test(err)) {
          results.noArgs.push({ name, error: err.slice(0, 140) });
          process.stdout.write('·');
        } else {
          results.fail.push({ name, error: err.slice(0, 240) });
          process.stdout.write('F');
        }
      } else {
        results.pass.push(name);
        if (r && typeof r.verified === 'boolean') verifiedFlag.set(name, r.verified);
        process.stdout.write('.');
      }
    } catch (e) {
      results.fail.push({ name, error: String(e.message).slice(0, 240) });
      process.stdout.write('F');
    }
  }

  line('');
  line('');
  line('================ LIVE SMOKE SWEEP ================');
  line(`catalogue:            ${catalogue.length}`);
  line(`invoked & passed:     ${results.pass.length}`);
  line(`invoked & FAILED:     ${results.fail.length}`);
  line(`skipped (unsafe):     ${results.skipped.length}  <- NOT tested`);
  line(`skipped (needs args): ${results.noArgs.length}  <- NOT tested`);
  if (!ALLOW_MUTATE) line(`deferred (mutating):  ${results.mutateDeferred.length}  <- NOT tested`);
  const attempted = results.pass.length + results.fail.length;
  line('');
  line(`real coverage: ${attempted}/${catalogue.length} tools actually executed (${((attempted / catalogue.length) * 100).toFixed(1)}%)`);

  if (results.fail.length) {
    line('');
    line('--- FAILURES (real defects) ---');
    for (const f of results.fail) line(`  ${f.name}\n      ${f.error}`);
  }

  writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));
  line('');
  line(`full report: ${REPORT_PATH}`);

  // Record the run in the repo's ledger. The /tmp report above is for this run's operator;
  // this is the durable claim, and docs/LIVE-VERIFICATION.md is generated from it. An aborted
  // sweep is still recorded — it covered fewer tools, which is a fact, not a reason to file
  // nothing. Only the tools this run actually reached are written; anything untouched stays
  // absent, and absence is reported as "never exercised live".
  const ledgerTools = [
    ...results.pass.map((name) => {
      const rec = { name, outcome: 'pass' };
      if (verifiedFlag.has(name)) rec.verified = verifiedFlag.get(name);
      return rec;
    }),
    ...results.fail.map((f) => ({ name: f.name, outcome: 'fail', detail: f.error })),
    ...results.noArgs.map((f) => ({ name: f.name, outcome: 'skipped_args', detail: f.error })),
    ...results.skipped.map((f) => ({ name: f.name, outcome: 'skipped_unsafe', detail: f.reason })),
    ...results.mutateDeferred.map((name) => ({ name, outcome: 'deferred_mutating' })),
  ];
  const environment = await collectEnvironment({
    tools,
    harness: 'live-smoke-sweep',
    mode: ALLOW_MUTATE ? 'mutate' : 'read-only',
  });
  const ledgerPath = recordSweep({ environment, tools: ledgerTools });
  line(`ledger entry:  ${ledgerPath}`);
  line('regenerate the summary with: npm run verify:report');
  process.exit(0);
}

main().catch((e) => { console.error('sweep aborted:', e.message); process.exit(1); });
