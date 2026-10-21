#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { PremiereProBridge } from '../dist/bridge/index.js';
import { PremiereProTools } from '../dist/tools/index.js';
import { requireScratchProject } from './lib/require-scratch-project.mjs';

process.env.PREMIERE_TEMP_DIR = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';
// Tools run in-process, and persistPrefToFile (src/tools/index.ts) reads this on every call. A
// harness has no business making a change to the user's global Premiere prefs that survives a
// force-quit, so it is refused here before any tool can run.
process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1';

const bridge = new PremiereProBridge();
const tools = new PremiereProTools(bridge);
const runId = Date.now();
const outputDir = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';
const outputPath = path.join(outputDir, 'live-tool-sweep.json');
const sequencePresetPath = process.env.PREMIERE_SEQUENCE_PRESET_PATH;

const results = [];
const executed = new Map();

const mutatingNoArgSkips = new Set([
  'save_project',
  'close_project',
  'undo',
  'redo',
  'multiple_undo',
  'remove_selected_clips',
  'lift_selection',
  'extract_selection',
  'copy_effects_between_clips',
  'copy_effect_values',
  'close_sequence',
  'nest_clips',
  'unnest_sequence',
  'delete_preview_files',
  'scene_edit_detection',
  'start_batch_encode',
  'consolidate_duplicates',
  'consolidate_and_transfer',
]);

const externalFixtureSkips = new Set([
  'create_project',
  'open_project',
  'save_project_as',
  'import_edl',
  'export_aaf',
  'detect_scene_edits',
  'import_mogrt',
  'import_mogrt_from_library',
  'import_sequences_from_project',
]);

/**
 * Tools that put a MODAL dialog on screen, which no script can dismiss.
 *
 * A modal wedges the CEP panel: it stops polling, every subsequent tool call times out, and the
 * dialogs stack up one per call for the rest of the run. Measured on 2026-08-26 — a full-catalogue
 * sweep (PREMIERE_MCP_PROFILE=all) reached export_as_fcp_xml and import_fcp_xml, and Premiere threw
 * a "Translation Report" alert for each, dozens deep, until the sweep was killed by hand.
 *
 * Separate from externalFixtureSkips because the reason differs and so does the remedy: a missing
 * fixture is fixable by supplying one, whereas these two cannot be swept unattended AT ALL. Their
 * coverage is owed to a human sitting in front of Premiere, and the census must say so rather than
 * quietly attempt them.
 */
const modalDialogSkips = new Set([
  // Measured: each of these produced a "Translation Report" alert.
  'export_as_fcp_xml',
  'import_fcp_xml',
  'export_project_as_fcp_xml',
  'open_fcp_xml',
  'open_fcp_xml_project',
  // Not measured — listed on the same reasoning that the FCP pair was reachable at all, which is
  // that the fallback path invokes anything whose schema accepts {}. These write or switch projects,
  // or reach Productions, and all three routes are known to prompt. Listed pre-emptively rather
  // than discovered on someone's screen; the census reports them as owed coverage, not as passing.
  'export_as_project',
  'export_sequence_as_project',
  'share_production',
  'sync_production',
  'convert_project_to_production',
  'import_image_sequence',
  'send_to_after_effects',
]);

/**
 * Tools that change the user's machine rather than the project, so a disposable fixture does not
 * make them safe. The fallback loop calls anything whose schema accepts {}, so they are listed
 * here rather than trusted to need arguments the loop cannot supply.
 */
const userStateSkips = new Set([
  'set_autosave_settings',
  'write_clipboard',
]);

/**
 * The single gate every invocation path must consult.
 *
 * The skip sets used to be checked ONLY in the trailing fallback loop, so any tool that also had
 * curated sample args was invoked regardless — which is exactly how the FCP pair ran despite the
 * sweep already carrying a "can open modal Premiere flows" skip list.
 *
 * @returns {string|null} the reason to skip, or null to proceed
 */
function skipReason(name) {
  if (modalDialogSkips.has(name)) return 'opens a modal Premiere dialog that wedges the panel; needs a human at the keyboard';
  if (externalFixtureSkips.has(name)) return 'requires external project/interchange/MOGRT assets or can open modal Premiere flows';
  if (mutatingNoArgSkips.has(name)) return 'intentionally skipped because it mutates or saves the active project';
  if (userStateSkips.has(name)) return 'changes user state outside the project (global Auto Save prefs or the system clipboard)';
  return null;
}

async function writeTextFixture(fileName, contents) {
  const outputDir = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';
  const filePath = path.join(outputDir, fileName);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(filePath, contents);
  return filePath;
}

function summarize(result) {
  if (result == null || typeof result !== 'object') {
    return result;
  }

  const summary = {};
  const preferredKeys = [
    'success',
    'message',
    'error',
    'count',
    'name',
    'path',
    'projectPath',
    'sequenceName',
    'sequenceId',
    'assetDir',
    'note',
    'skipped',
  ];

  for (const key of preferredKeys) {
    if (key in result) {
      summary[key] = result[key];
    }
  }

  if (Array.isArray(result.sequences)) {
    summary.sequenceCount = result.sequences.length;
  }
  if (Array.isArray(result.items)) {
    summary.itemCount = result.items.length;
  }
  if (Array.isArray(result.bins)) {
    summary.binCount = result.bins.length;
  }
  if (Array.isArray(result.videoTracks)) {
    summary.videoTrackCount = result.videoTracks.length;
  }
  if (Array.isArray(result.audioTracks)) {
    summary.audioTrackCount = result.audioTracks.length;
  }
  if (Array.isArray(result.imported)) {
    summary.importedCount = result.imported.length;
  }
  if (Array.isArray(result.placements)) {
    summary.placementCount = result.placements.length;
  }
  if (Array.isArray(result.transitions)) {
    summary.transitionCount = result.transitions.length;
  }
  if (Array.isArray(result.animations)) {
    summary.animationCount = result.animations.length;
  }
  if (result.sequence && typeof result.sequence === 'object') {
    summary.sequence = {
      id: result.sequence.id,
      name: result.sequence.name,
    };
  }
  if (result.id) {
    summary.id = result.id;
  }

  return summary;
}

function record(name, status, args, result, note) {
  const entry = {
    name,
    status,
    args,
  };

  if (note) {
    entry.note = note;
  }
  if (result !== undefined) {
    entry.result = summarize(result);
  }

  results.push(entry);
  if (status === 'executed' || status === 'runtime_failure') {
    executed.set(name, result);
  }

  writeCheckpoint();
}

function currentCounts() {
  return {
    total: tools.getAvailableTools().length,
    executed: results.filter((entry) => entry.status === 'executed').length,
    schema_validated: results.filter((entry) => entry.status === 'schema_validated').length,
    runtime_failure: results.filter((entry) => entry.status === 'runtime_failure').length,
    skipped: results.filter((entry) => entry.status === 'skipped').length,
  };
}

function writeCheckpoint() {
  try {
    fsSync.mkdirSync(outputDir, { recursive: true });
    fsSync.writeFileSync(outputPath, JSON.stringify({ runId, counts: currentCounts(), results }, null, 2));
  } catch {
    // Best-effort live evidence checkpoint.
  }
}

/**
 * Abort the sweep once the panel stops answering at all.
 *
 * modalDialogSkips names the tools KNOWN to raise a dialog. This is the backstop for the ones that
 * are not on the list yet: a modal wedges the panel, so every remaining call times out, and each
 * one leaves another alert on screen. On 2026-08-26 that meant dozens of stacked "Translation
 * Report" alerts over an editor's session before the run was killed by hand.
 *
 * Consecutive timeouts, not total ones — a single slow tool is normal, three in a row is not a slow
 * tool, it is a host that has stopped listening. Continuing past that point cannot produce coverage
 * anyway: every subsequent result would be a timeout recorded as a runtime_failure, which would
 * read in the census as "the tool is broken" when the truth is "the tool was never reached".
 */
const WEDGE_LIMIT = 3;
let consecutiveTimeouts = 0;

class PanelWedged extends Error {}

function looksLikeTimeout(result) {
  const text = `${result?.error ?? ''} ${result?.message ?? ''}`;
  return result?.success === false && /timed out|timeout|no response from/i.test(text);
}

async function invoke(name, args, note) {
  const result = await tools.executeTool(name, args);
  const errorText = typeof result?.error === 'string' ? result.error : '';

  let status = 'executed';
  if (result?.success === false) {
    if (errorText.includes('Invalid arguments for tool')) {
      status = 'schema_validated';
    } else {
      status = 'runtime_failure';
    }
  }

  record(name, status, args, result, note);

  if (looksLikeTimeout(result)) {
    consecutiveTimeouts += 1;
    if (consecutiveTimeouts >= WEDGE_LIMIT) {
      throw new PanelWedged(
        `${WEDGE_LIMIT} consecutive timeouts, last at "${name}". The panel has stopped answering — ` +
        'most likely a modal dialog is open in Premiere. Dismiss it, add the offending tool to ' +
        'modalDialogSkips, and re-run. Partial results are already on disk.',
      );
    }
  } else {
    consecutiveTimeouts = 0;
  }

  return result;
}

function getTool(name) {
  return tools.getAvailableTools().find((tool) => tool.name === name);
}

async function main() {
  await bridge.initialize();

  // This sweep is intentionally mutating — it creates `Sweep ...` sequences, imports generated
  // assets and exercises destructive tools — and it had NO guard on which project it was pointed
  // at. Run once against an editor's open cut it would have scattered sweep artefacts through it.
  // The guard exits rather than warns, and it runs before the first invoke().
  await requireScratchProject(bridge, 'live-tool-sweep');

  const catalog = tools.getAvailableTools();
  const catalogNames = new Set(catalog.map((tool) => tool.name));

  const baselineProject = await invoke('get_project_info', {}, 'baseline project state');
  await invoke('list_project_items', {}, 'baseline project inventory');
  await invoke('list_sequences', {}, 'baseline sequence inventory');

  for (const name of [
    'list_available_effects',
    'list_available_transitions',
    'list_available_audio_effects',
    'list_available_audio_transitions',
    'get_render_queue_status',
    'get_active_sequence',
    'check_offline_media',
  ]) {
    if (catalogNames.has(name)) {
      await invoke(name, {}, 'safe no-arg execution');
    }
  }

  const demo = await invoke(
    'build_motion_graphics_demo',
    { sequenceName: `Sweep Demo ${runId}` },
    'high-level live workflow using generated assets',
  );

  const assetPaths = Array.isArray(demo?.assets) ? demo.assets.map((asset) => asset.path) : [];
  const firstAssetPath = assetPaths[0];
  const firstAssetName = Array.isArray(demo?.assets) && demo.assets[0] ? demo.assets[0].name.replace(/\.[^.]+$/, '') : undefined;
  const demoSequenceId = demo?.sequence?.id || baselineProject?.activeSequence?.id;
  const demoClipId = Array.isArray(demo?.placements) && demo.placements[0] ? demo.placements[0].id : undefined;
  const demoProjectItemId = Array.isArray(demo?.imported) && demo.imported[0] ? demo.imported[0].id : undefined;
  const demoAssetDir = demo?.assetDir;

  let manualSequenceId;
  let manualProjectItemId;
  let manualClipId;
  let sweepBinId;
  let srtProjectItemId;
  let srtPath;

  if (firstAssetPath) {
    if (sequencePresetPath) {
      const manualSequence = await invoke(
        'create_sequence',
        { name: `Sweep Manual ${runId}`, presetPath: sequencePresetPath },
        'direct sequence creation with an explicit preset to avoid Premiere UI',
      );
      manualSequenceId = manualSequence?.id;
    } else {
      record(
        'create_sequence',
        'skipped',
        {},
        undefined,
        'set PREMIERE_SEQUENCE_PRESET_PATH to exercise non-interactive sequence creation',
      );
    }

    const manualImport = await invoke(
      'import_media',
      { filePath: firstAssetPath },
      'direct media import coverage',
    );
    manualProjectItemId = manualImport?.id;

    if (manualSequenceId && manualProjectItemId) {
      const placement = await invoke(
        'add_to_timeline',
        {
          sequenceId: manualSequenceId,
          projectItemId: manualProjectItemId,
          trackIndex: 0,
          time: 0,
        },
        'direct timeline placement coverage',
      );
      manualClipId = placement?.id;
    }
  }

  const sweepBin = await invoke(
    'create_bin',
    { name: `Sweep Bin ${runId}` },
    'bin fixture for project item management coverage',
  );
  sweepBinId = sweepBin?.id || sweepBin?.binId || sweepBin?.nodeId;

  srtPath = await writeTextFixture(
    `sweep-captions-${runId}.srt`,
    '1\n00:00:00,000 --> 00:00:01,500\nSweep caption one\n\n2\n00:00:01,500 --> 00:00:03,000\nSweep caption two\n',
  );

  const srtImport = await invoke(
    'import_media',
    { filePath: srtPath },
    'caption fixture import coverage',
  );
  srtProjectItemId = srtImport?.id;

  if (demoAssetDir) {
    await invoke(
      'import_folder',
      { folderPath: demoAssetDir, recursive: false },
      'folder import coverage using generated demo assets',
    );
  }

  if (catalogNames.has('assemble_product_spot') && assetPaths.length > 0) {
    await invoke(
      'assemble_product_spot',
      {
        sequenceName: `Sweep Product ${runId}`,
        assetPaths,
        clipDuration: 4,
        motionStyle: 'alternate',
      },
      'high-level workflow using real imported assets',
    );
  }

  if (catalogNames.has('build_brand_spot_from_mogrt_and_assets') && assetPaths.length > 0) {
    await invoke(
      'build_brand_spot_from_mogrt_and_assets',
      {
        sequenceName: `Sweep Brand ${runId}`,
        assetPaths,
      },
      'high-level branded workflow without optional mogrt',
    );
  }

  const sampleArgs = new Map();
  const finalArgs = new Map();

  if (demoSequenceId) {
    sampleArgs.set('list_sequence_tracks', { sequenceId: demoSequenceId });
    sampleArgs.set('set_active_sequence', { sequenceId: demoSequenceId });
    sampleArgs.set('get_sequence_settings', { sequenceId: demoSequenceId });
    sampleArgs.set('get_playhead_position', { sequenceId: demoSequenceId });
    sampleArgs.set('set_playhead_position', { sequenceId: demoSequenceId, time: 1 });
    sampleArgs.set('get_selected_clips', { sequenceId: demoSequenceId });
    sampleArgs.set('list_markers', { sequenceId: demoSequenceId });
    sampleArgs.set('get_work_area', { sequenceId: demoSequenceId });
    sampleArgs.set('set_work_area', { sequenceId: demoSequenceId, inPoint: 0, outPoint: 3 });
    sampleArgs.set('get_sequence_in_out_points', { sequenceId: demoSequenceId });
    sampleArgs.set('set_sequence_in_out_points', { sequenceId: demoSequenceId, inPoint: 0, outPoint: 3 });
    sampleArgs.set('export_frame', {
      sequenceId: demoSequenceId,
      time: 1,
      outputPath: `/tmp/premiere-mcp-bridge/sweep-frame-${runId}.png`,
      format: 'png',
    });
    sampleArgs.set('export_as_fcp_xml', {
      sequenceId: demoSequenceId,
      outputPath: `/tmp/premiere-mcp-bridge/sweep-${runId}.xml`,
    });
    sampleArgs.set('import_fcp_xml', {
      filePath: `/tmp/premiere-mcp-bridge/sweep-${runId}.xml`,
    });
    sampleArgs.set('create_subsequence', {
      sequenceId: demoSequenceId,
      ignoreTrackTargeting: true,
    });
    sampleArgs.set('duplicate_sequence', {
      sequenceId: demoSequenceId,
      newName: `Sweep Duplicate ${runId}`,
    });
    sampleArgs.set('get_clip_at_position', {
      sequenceId: demoSequenceId,
      trackType: 'video',
      trackIndex: 0,
      time: 1,
    });
    sampleArgs.set('razor_timeline_at_time', {
      sequenceId: demoSequenceId,
      time: 2.5,
      videoTrackIndices: [0],
      audioTrackIndices: [],
    });
    sampleArgs.set('mute_track', {
      sequenceId: demoSequenceId,
      trackIndex: 0,
      muted: false,
    });
    sampleArgs.set('add_marker', {
      sequenceId: demoSequenceId,
      time: 0.5,
      name: `Sweep Marker ${runId}`,
      comment: 'live verifier marker',
      color: 'Green',
      duration: 0.25,
    });
    sampleArgs.set('add_track', {
      sequenceId: demoSequenceId,
      trackType: 'video',
      position: 'above',
    });
    sampleArgs.set('delete_track', {
      sequenceId: demoSequenceId,
      trackType: 'video',
      trackIndex: 99,
    });
    sampleArgs.set('lock_track', {
      sequenceId: demoSequenceId,
      trackType: 'video',
      trackIndex: 0,
      locked: false,
    });
    sampleArgs.set('toggle_track_visibility', {
      sequenceId: demoSequenceId,
      trackIndex: 0,
      visible: true,
    });
    sampleArgs.set('set_sequence_settings', {
      sequenceId: demoSequenceId,
      settings: { width: 1920, height: 1080 },
    });
    sampleArgs.set('export_sequence', {
      sequenceId: demoSequenceId,
      outputPath: `/tmp/premiere-mcp-bridge/sweep-export-${runId}.mp4`,
      format: 'h264',
      quality: 'draft',
    });
    sampleArgs.set('add_to_render_queue', {
      sequenceId: demoSequenceId,
      outputPath: `/tmp/premiere-mcp-bridge/sweep-render-queue-${runId}.mp4`,
      startImmediately: false,
    });
    sampleArgs.set('batch_add_transitions', {
      sequenceId: demoSequenceId,
      trackIndex: 0,
      transitionName: 'Cross Dissolve',
      duration: 0.25,
    });
    sampleArgs.set('auto_reframe_sequence', {
      sequenceId: demoSequenceId,
      numerator: 9,
      denominator: 16,
      motionPreset: 'default',
      newName: `Sweep Reframe ${runId}`,
    });
  }

  if (demoClipId) {
    sampleArgs.set('get_clip_properties', { clipId: demoClipId });
    sampleArgs.set('apply_effect', { clipId: demoClipId, effectName: 'Gaussian Blur' });
    sampleArgs.set('remove_effect', { clipId: demoClipId, effectName: 'Gaussian Blur' });
    sampleArgs.set('add_transition_to_clip', {
      clipId: demoClipId,
      transitionName: 'Cross Dissolve',
      position: 'end',
      duration: 0.5,
    });
    sampleArgs.set('color_correct', { clipId: demoClipId, brightness: 2, contrast: 4, saturation: 3 });
    sampleArgs.set('add_keyframe', {
      clipId: demoClipId,
      componentName: 'Motion',
      paramName: 'Scale',
      time: 0.25,
      value: 101,
    });
    sampleArgs.set('remove_keyframe', {
      clipId: demoClipId,
      componentName: 'Motion',
      paramName: 'Scale',
      time: 0.25,
    });
    sampleArgs.set('get_keyframes', {
      clipId: demoClipId,
      componentName: 'Motion',
      paramName: 'Scale',
    });
    sampleArgs.set('duplicate_clip', { clipId: demoClipId, offset: 16 });
    sampleArgs.set('move_clip', { clipId: demoClipId, newTime: 0.75 });
    sampleArgs.set('trim_clip', { clipId: demoClipId, duration: 2.5 });
    sampleArgs.set('split_clip', { clipId: demoClipId, splitTime: 1.25 });
    sampleArgs.set('crop_clip', { clipId: demoClipId, left: 2, right: 2, top: 2, bottom: 2 });
    sampleArgs.set('add_transition', {
      clipId1: demoClipId,
      clipId2: manualClipId || demoClipId,
      transitionName: 'Cross Dissolve',
      duration: 0.25,
    });
    sampleArgs.set('adjust_audio_levels', { clipId: demoClipId, level: -3 });
    sampleArgs.set('add_audio_keyframes', {
      clipId: demoClipId,
      keyframes: [
        { time: 0, level: -6 },
        { time: 1, level: -3 },
      ],
    });
    sampleArgs.set('setup_ducking', {
      clipId: demoClipId,
      baseDb: -18,
      duckingWindows: [{ startTime: 0.25, endTime: 0.75, duckedDb: -30 }],
      fadeSeconds: 0.1,
      clipStartTime: 0,
      clipEndTime: 2,
    });
    sampleArgs.set('link_audio_video', {
      videoClipId: demoClipId,
      audioClipId: demoClipId,
    });
    sampleArgs.set('apply_audio_effect', {
      clipId: demoClipId,
      effectName: 'Parametric Equalizer',
    });
    sampleArgs.set('reverse_clip', { clipId: demoClipId, maintainAudioPitch: true });
    sampleArgs.set('enable_disable_clip', { clipId: demoClipId, enabled: true });
    sampleArgs.set('set_clip_properties', {
      clipId: demoClipId,
      properties: { scale: 102, opacity: 95 },
    });
    sampleArgs.set('stabilize_clip', { clipId: demoClipId, smoothness: 5 });
    sampleArgs.set('speed_change', { clipId: demoClipId, speed: 1, maintainAudio: true });
  }

  if (demoProjectItemId) {
    sampleArgs.set('get_color_label', { projectItemId: demoProjectItemId });
    sampleArgs.set('get_metadata', { projectItemId: demoProjectItemId });
    sampleArgs.set('get_footage_interpretation', { projectItemId: demoProjectItemId });
    sampleArgs.set('get_item_info', { projectItemId: demoProjectItemId });
    sampleArgs.set('get_project_item_info', { projectItemId: demoProjectItemId });
    sampleArgs.set('open_in_source', { projectItemId: demoProjectItemId });
    sampleArgs.set('set_source_in_out', { inPoint: 0, outPoint: 1 });
    sampleArgs.set('insert_from_source', { videoTrackIndex: 0, audioTrackIndex: 0 });
    sampleArgs.set('overwrite_from_source', { videoTrackIndex: 0, audioTrackIndex: 0 });
    sampleArgs.set('clear_item_in_out', { projectItemId: demoProjectItemId });
    sampleArgs.set('set_item_in_out', { projectItemId: demoProjectItemId, inPoint: 0, outPoint: 1 });
    sampleArgs.set('set_color_label', { projectItemId: demoProjectItemId, colorIndex: 4 });
    sampleArgs.set('set_metadata', {
      projectItemId: demoProjectItemId,
      key: 'SweepVerifier',
      value: String(runId),
    });
    sampleArgs.set('set_footage_interpretation', { projectItemId: demoProjectItemId, frameRate: 30 });
    sampleArgs.set('refresh_media', { projectItemId: demoProjectItemId });
    sampleArgs.set('create_subclip', {
      projectItemId: demoProjectItemId,
      name: `Sweep Subclip ${runId}`,
      startTime: 0,
      endTime: 1,
      hasHardBoundaries: false,
    });
    sampleArgs.set('relink_media', { projectItemId: demoProjectItemId, newFilePath: firstAssetPath });
    sampleArgs.set('rename_project_item', {
      projectItemId: demoProjectItemId,
      newName: `Sweep Renamed ${runId}.png`,
    });
    sampleArgs.set('manage_proxies', { projectItemId: demoProjectItemId, action: 'check' });
  }

  if (manualClipId && demoProjectItemId) {
    sampleArgs.set('replace_clip', {
      clipId: manualClipId,
      newProjectItemId: demoProjectItemId,
      preserveEffects: true,
    });
  }

  if (sweepBinId) {
    sampleArgs.set('get_bin_contents', { binId: sweepBinId });
    if (demoProjectItemId) {
      sampleArgs.set('move_item_to_bin', { projectItemId: demoProjectItemId, targetBinId: sweepBinId });
    }
  }

  if (srtProjectItemId && demoSequenceId) {
    sampleArgs.set('create_caption_track', {
      sequenceId: demoSequenceId,
      projectItemId: srtProjectItemId,
      startTime: 0,
    });
  }

  sampleArgs.set('execute_extendscript', {
    script: 'return JSON.stringify({ success: true, message: "execute_extendscript fixture" });',
  });

  if (firstAssetName) {
    sampleArgs.set('find_project_item_by_name', { name: firstAssetName });
  }

  for (const [name, args] of sampleArgs.entries()) {
    if (!catalogNames.has(name) || executed.has(name)) continue;
    const skip = skipReason(name);
    if (skip) {
      record(name, 'skipped', args, undefined, skip);
      continue;
    }
    await invoke(name, args, 'live invocation with discovered test context');
  }

  for (const [name, args] of finalArgs.entries()) {
    if (!catalogNames.has(name) || executed.has(name)) continue;
    const skip = skipReason(name);
    if (skip) {
      record(name, 'skipped', args, undefined, skip);
      continue;
    }
    await invoke(name, args, 'final live invocation after dependent checks');
  }

  for (const tool of catalog) {
    if (results.some((entry) => entry.name === tool.name)) {
      continue;
    }

    const skip = skipReason(tool.name);
    if (skip && !mutatingNoArgSkips.has(tool.name)) {
      record(tool.name, 'skipped', {}, undefined, skip);
      continue;
    }

    if (tool.inputSchema.safeParse({}).success) {
      // The mutating set is only dangerous when the empty object is ACCEPTED. When the schema
      // requires args, an empty call is rejected before the bridge is touched, and that rejection
      // is real coverage of the schema path — recording it as "skipped" would lose it.
      if (skip) {
        record(tool.name, 'skipped', {}, undefined, skip);
        continue;
      }

      await invoke(tool.name, {}, 'fallback no-arg execution');
      continue;
    }

    await invoke(tool.name, {}, 'schema path validation with empty args');
  }

  const counts = currentCounts();

  const report = { runId, counts, results };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ ...report, outputPath }, null, 2));
}

try {
  await main();
} catch (error) {
  // A wedged panel is a real, reportable outcome, not a crash: the checkpoint file already holds
  // every result up to the wedge, and exiting 3 distinguishes it from an ordinary failure so a
  // caller can tell "go dismiss a dialog" from "the sweep is broken".
  if (error instanceof PanelWedged) {
    console.error(`\nSWEEP ABORTED: ${error.message}`);
    console.error(`partial results: ${outputPath}`);
    console.error(JSON.stringify(currentCounts(), null, 2));
    process.exitCode = 3;
  } else {
    throw error;
  }
} finally {
  await bridge.cleanup();
}
