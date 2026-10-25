import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { PremiereProTransport } from '../bridge/types.js';
import type { MCPTool } from './index.js';
import { buildExpandedInputSchema, expandedToolSpec } from './expanded-schemas.js';

export const expandedToolNames = [
  'find_items_by_media_path',
  'get_insertion_bin',
  'get_project_panel_metadata',
  'get_graphics_white_luminance',
  'get_item_info',
  'is_work_area_enabled',
  'get_xmp_metadata',
  'get_color_space',
  'rename_clip',
  'get_clip_speed',
  'set_clip_selection',
  'link_selection',
  'unlink_selection',
  'execute_extendscript',
  'evaluate_expression',
  'inspect_dom_object',
  'reflect_dom_object',
  'list_lumetri_presets',
  'apply_lumetri_preset',
  'apply_video_effect',
  'get_timeline_render_status',
  'list_clip_effects',
  'get_sequence_structure',
  'get_premiere_state',
  'get_full_project_overview',
  'get_bin_contents',
  'get_full_sequence_info',
  'get_full_clip_info',
  'get_project_item_info',
  'search_project_items',
  'get_timeline_gaps',
  'get_timeline_summary',
  'get_offline_media',
  'get_used_media_report',
  'select_clips_by_name',
  'select_all_clips',
  'deselect_all_clips',
  'select_clips_in_range',
  'select_disabled_clips',
  'open_in_source',
  'close_source_monitor',
  'close_all_source_clips',
  'set_source_in_out',
  'insert_from_source',
  'overwrite_from_source',
  'get_source_monitor_info',
  'set_target_track',
  'get_target_tracks',
  'rename_track',
  'get_track_info',
  'clear_item_in_out',
  'set_item_in_out',
  'remove_selected_clips',
  'redo',
  'multiple_undo',
  'get_version_info',
  'get_all_project_paths',
  'lift_selection',
  'extract_selection',
  'get_project_scratch_disks',
  'get_sequence_count',
  'get_total_clip_count',
  'match_frame',
  'ping',
  'get_workspaces',
  'set_workspace',
  'play_timeline',
  'stop_playback',
  'play_source_monitor',
  'get_source_monitor_position',
  'close_project',
  'delete_bin',
  'rename_bin',
  'create_smart_bin',
  'start_batch_encode',
  'add_custom_metadata_field',
  'import_sequences',
  'create_bars_and_tone',
  'set_transcode_on_ingest',
  'set_project_panel_metadata',
  'set_graphics_white_luminance',
  'set_scratch_disk_path',
  'set_offline',
  'has_proxy',
  'detach_proxy',
  'set_override_frame_rate',
  'set_override_pixel_aspect_ratio',
  'set_scale_to_frame_size',
  'select_item',
  'set_start_time',
  'unnest_sequence',
  'create_sequence_from_preset',
  'attach_custom_property',
  'get_export_file_extension',
  'remove_effect',
  'set_xmp_metadata',
  'capture_frame',
  'export_omf',
  'encode_project_item',
  'encode_file',
  'ripple_delete',
  'roll_edit',
  'slide_edit',
  'slip_edit',
  'move_clip_to_track',
  'remove_all_effects',
  'set_clip_speed_qe',
  'set_frame_blend',
  'set_time_interpolation',
  'overwrite_clip',
  'create_sequence_from_clips',
  'close_sequence',
  'export_as_project',
  'set_zero_point',
  'scene_edit_detection',
  'delete_preview_files',
  'add_tracks',
  'set_color_value',
  'get_clip_adjustment_layer',
  'get_linked_items',
  'get_mogrt_component',
  'get_effect_properties',
  'set_effect_property',
  'remove_keyframe_range',
  'set_keyframe_interpolation',
  'get_value_at_time',
  'select_clips_by_color',
  'invert_selection',
  'copy_effects_between_clips',
  'copy_effect_values',
  'replace_clip_media',
  'batch_apply_effect',
  'remove_effect_by_name',
  'set_blend_mode',
  'set_all_tracks_targeted',
  'razor_all_tracks',
  'set_clip_start_time',
  'import_image_sequence',
  'set_clip_position',
  'set_clip_scale',
  'set_clip_rotation',
  'set_clip_anchor_point',
  'set_clip_opacity',
  'set_clip_volume',
  'set_clip_pan',
  'batch_rename_clips',
  'batch_enable_disable',
  'clear_sequence_in_out',
  'get_qe_clip_info',
  'set_poster_frame',
  'move_items_to_bin',
  'set_anti_alias_quality',
  'set_uniform_scale',
  'set_scale_width_height',
  'delete_project_item',
  'delete_multiple_project_items',
  'add_adjustment_layer',
  'freeze_frame',
  'set_sequence_frame_rate',
  'set_sequence_resolution',
  'set_sequence_audio_settings',
  'set_sequence_pixel_aspect_ratio',
  'set_sequence_field_type',
  'get_unused_media',
  'get_duplicate_media',
  'get_clip_links',
  'get_sequence_markers_by_type',
  'get_clip_markers',
  'add_marker_to_project_item',
  'set_sequence_display_format',
  'get_clip_at_playhead',
  'get_next_edit_point',
  'move_playhead_to_edit',
  'set_project_scratch_disk',
  'nest_clips',
  'consolidate_and_transfer',
] as const;

export const unimplementedExpandedToolNames = [] as const;

export function getExpandedTools(existingNames: Set<string>): MCPTool[] {
  return expandedToolNames
    .filter((name) => !existingNames.has(name))
    .map((name) => {
      // Prefer the real, documented schema for this tool. A tool without a spec
      // (should be none) falls back to the original free-form record so it stays
      // callable rather than disappearing.
      const spec = expandedToolSpec(name);
      if (spec) {
        return {
          name,
          description: spec.description,
          inputSchema: buildExpandedInputSchema(spec)
        };
      }
      return {
        name,
        description: `Premiere Pro expanded operation: ${name.replace(/_/g, ' ')}.`,
        inputSchema: z.record(z.string(), z.any())
      };
    });
}

export function isExpandedTool(name: string): boolean {
  return (expandedToolNames as readonly string[]).includes(name);
}

export async function executeExpandedTool(
  bridge: PremiereProTransport,
  name: string,
  args: Record<string, any>
): Promise<any> {
  try {
    if (name === 'create_bars_and_tone') {
      return await createGeneratedBarsAndTone(bridge, args);
    }

    if (name === 'add_adjustment_layer') {
      return await createGeneratedAdjustmentLayer(bridge, args);
    }

    if (name === 'consolidate_and_transfer') {
      return await consolidateAndTransfer(bridge, args);
    }

    if (name === 'delete_preview_files') {
      return await deletePreviewFilesOnDisk(bridge, args);
    }

    if (name === 'execute_extendscript') {
      const script = String(args.script ?? args.code ?? '');
      if (!script.trim()) {
        return { success: false, error: 'execute_extendscript requires script or code' };
      }
      // Caller-authored: pass the source through verbatim.
      return await bridge.executeScript(script, undefined, true);
    }

    const script = buildExpandedToolScript(name, args);
    return await bridge.executeScript(script);
  } catch (error) {
    return {
      success: false,
      tool: name,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodeRgbaPng(width: number, height: number, pixelAt: (x: number, y: number) => [number, number, number, number]): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const offset = rowOffset + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

async function writeGeneratedPng(fileName: string, width: number, height: number, pixelAt: (x: number, y: number) => [number, number, number, number]): Promise<string> {
  const outputDir = join(process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge', 'generated-assets');
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, fileName);
  await fs.writeFile(filePath, encodeRgbaPng(width, height, pixelAt));
  return filePath;
}

async function createGeneratedBarsAndTone(bridge: PremiereProTransport, args: Record<string, any>): Promise<any> {
  const width = Number(args.width || 1280);
  const height = Number(args.height || 720);
  const colors: Array<[number, number, number, number]> = [
    [191, 191, 191, 255],
    [191, 191, 0, 255],
    [0, 191, 191, 255],
    [0, 191, 0, 255],
    [191, 0, 191, 255],
    [191, 0, 0, 255],
    [0, 0, 191, 255]
  ];
  const filePath = await writeGeneratedPng(`bars-${Date.now()}.png`, width, height, (x) => colors[Math.min(colors.length - 1, Math.floor((x / width) * colors.length))] ?? colors[0]!);
  const imported = await bridge.importMedia(filePath);
  return {
    success: true,
    tool: 'create_bars_and_tone',
    data: {
      created: true,
      mediaType: 'generated_color_bars_png',
      item: imported,
      path: filePath,
      width,
      height,
      toneGenerated: false
    }
  };
}

async function createGeneratedAdjustmentLayer(bridge: PremiereProTransport, args: Record<string, any>): Promise<any> {
  const width = Number(args.width || 1920);
  const height = Number(args.height || 1080);
  const filePath = await writeGeneratedPng(`adjustment-layer-${Date.now()}.png`, width, height, () => [0, 0, 0, 0]);
  const imported = await bridge.importMedia(filePath);
  let placement: any = null;
  if (args.sequenceId) {
    placement = await bridge.addToTimeline(String(args.sequenceId), imported.id, Number(args.trackIndex || 1), Number(args.time || args.start || 0), false);
  }

  // A placed still gets Premiere's default still-image duration (typically 5s), so a
  // requested duration was silently dropped. When one is asked for and the layer was
  // actually placed, extend the clip's end and read the result back — the same setter
  // trim_clip uses (clip.end = start + duration) — reporting whether it took.
  let durationResult: any = null;
  const requestedDuration = args.duration !== undefined ? Number(args.duration) : undefined;
  if (placement && placement.id && requestedDuration !== undefined && isFinite(requestedDuration) && requestedDuration > 0) {
    durationResult = await bridge.executeScript(`
      try {
        var info = __findClip(${JSON.stringify(String(placement.id))});
        if (!info) return JSON.stringify({ success: false, error: "Placed adjustment layer not found; duration not set" });
        var clip = info.clip;
        function secondsOf(v) { if (v === undefined || v === null) return null; if (typeof v === "number") return v; if (v.seconds !== undefined) return Number(v.seconds); if (v.ticks !== undefined) return Number(v.ticks) / 254016000000.0; return null; }
        function timeFromSeconds(s) { var t = new Time(); t.seconds = Number(s); return t; }
        var startSec = secondsOf(clip.start);
        try { clip.end = timeFromSeconds(startSec + ${requestedDuration}); }
        catch (eEnd) { return JSON.stringify({ success: false, error: "Could not set duration: " + eEnd.toString() }); }
        var actual = secondsOf(clip.duration);
        return JSON.stringify({ success: (actual !== null && Math.abs(actual - ${requestedDuration}) < 0.05), requestedDuration: ${requestedDuration}, actualDuration: actual });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `);
  }

  return {
    success: true,
    tool: 'add_adjustment_layer',
    data: {
      created: true,
      mediaType: 'generated_transparent_png',
      item: imported,
      placement,
      path: filePath,
      width,
      height,
      ...(requestedDuration !== undefined
        ? {
            requestedDuration,
            durationApplied: durationResult ? durationResult.success === true : false,
            actualDuration: durationResult ? durationResult.actualDuration : undefined,
            ...(durationResult && durationResult.success !== true
              ? { durationWarning: durationResult.error || 'Duration could not be verified; layer kept its default length.' }
              : {}),
            ...(!placement ? { durationWarning: 'Duration ignored: no sequenceId given, so the layer was imported but not placed on a timeline.' } : {})
          }
        : {})
    }
  };
}

async function consolidateAndTransfer(bridge: PremiereProTransport, args: Record<string, any>): Promise<any> {
  const outputPath = String(args.outputPath || args.path || '');
  if (!outputPath) {
    return {
      success: false,
      tool: 'consolidate_and_transfer',
      error: 'consolidate_and_transfer requires outputPath or path.'
    };
  }

  const readMediaScript = `
    try {
      var media = [];
      var seen = {};
      function walk(item) {
        if (!item) return;
        try {
          if (item.getMediaPath) {
            var mediaPath = String(item.getMediaPath() || "");
            if (mediaPath && !seen[mediaPath]) {
              seen[mediaPath] = true;
              media.push({ nodeId: item.nodeId, name: item.name, mediaPath: mediaPath });
            }
          }
        } catch (mediaError) {}
        if (item.children) {
          for (var i = 0; i < item.children.numItems; i++) walk(item.children[i]);
        }
      }
      walk(app.project.rootItem);
      return JSON.stringify({ success: true, media: media, projectName: app.project.name || "" });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `;
  const mediaResult: any = await bridge.executeScript(readMediaScript);
  if (!mediaResult?.success) {
    return {
      success: false,
      tool: 'consolidate_and_transfer',
      error: mediaResult?.error || 'Failed to read project media paths',
      details: mediaResult
    };
  }

  const mediaDir = join(outputPath, 'Media');
  await fs.mkdir(mediaDir, { recursive: true });
  const copied: Array<{ source: string; destination: string; nodeId?: string; name?: string }> = [];
  const skipped: Array<{ source: string; reason: string; nodeId?: string; name?: string }> = [];
  const usedDestinations = new Set<string>();

  for (const item of mediaResult.media || []) {
    const source = String(item.mediaPath || '');
    if (!source) continue;
    try {
      await fs.stat(source);
      const fileName = basename(source);
      let destination = join(mediaDir, fileName);
      let suffix = 1;
      while (usedDestinations.has(destination)) {
        const dot = fileName.lastIndexOf('.');
        const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
        const ext = dot > 0 ? fileName.slice(dot) : '';
        destination = join(mediaDir, `${stem}-${suffix}${ext}`);
        suffix++;
      }
      usedDestinations.add(destination);
      await fs.copyFile(source, destination);
      copied.push({ source, destination, nodeId: item.nodeId, name: item.name });
    } catch (error) {
      skipped.push({
        source,
        nodeId: item.nodeId,
        name: item.name,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  let projectCopy: any = null;
  if (args.saveProjectCopy !== false) {
    const projectPath = join(outputPath, `${String(args.projectName || mediaResult.projectName || 'consolidated-project').replace(/[\\/]+/g, '_').replace(/\\.prproj$/i, '')}.prproj`);
    const saveScript = `
      try {
        app.project.saveAs(${JSON.stringify(projectPath)});
        return JSON.stringify({ success: true, projectPath: ${JSON.stringify(projectPath)} });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString(), projectPath: ${JSON.stringify(projectPath)} });
      }
    `;
    projectCopy = await bridge.executeScript(saveScript);
  }

  const manifestPath = join(outputPath, 'consolidate-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    projectName: mediaResult.projectName,
    copied,
    skipped,
    projectCopy
  }, null, 2));

  return {
    success: projectCopy?.success !== false,
    tool: 'consolidate_and_transfer',
    data: {
      outputPath,
      mediaDir,
      copiedCount: copied.length,
      skippedCount: skipped.length,
      copied,
      skipped,
      projectCopy,
      manifestPath
    }
  };
}

async function deletePreviewFilesOnDisk(bridge: PremiereProTransport, args: Record<string, any>): Promise<any> {
  const infoScript = `
    try {
      var projectPath = "";
      try { projectPath = String(app.project.path || ""); } catch (pathError) {}
      return JSON.stringify({
        success: true,
        projectPath: projectPath,
        projectName: app.project && app.project.name ? String(app.project.name) : "",
        sequenceName: app.project && app.project.activeSequence ? String(app.project.activeSequence.name) : ""
      });
    } catch (e) {
      return JSON.stringify({ success: false, error: e.toString() });
    }
  `;
  const info: any = await bridge.executeScript(infoScript);
  if (!info?.success) {
    return {
      success: false,
      tool: 'delete_preview_files',
      error: info?.error || 'Failed to inspect active project',
      details: info
    };
  }

  const projectDir = info.projectPath ? dirname(String(info.projectPath)) : (process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge');
  const explicitDir = args.previewDir || args.previewPath || args.path;
  const candidates = [
    explicitDir ? String(explicitDir) : '',
    join(projectDir, 'Adobe Premiere Pro Video Previews'),
    join(projectDir, 'Adobe Premiere Pro Audio Previews'),
    join(projectDir, `${String(info.projectName || '').replace(/\\.prproj$/i, '')} Video Previews`),
    join(projectDir, `${String(info.projectName || '').replace(/\\.prproj$/i, '')} Audio Previews`)
  ].filter(Boolean);

  const deleted: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const visited = new Set<string>();

  async function walkPreviewDir(dir: string, isExplicit: boolean): Promise<void> {
    if (visited.has(dir)) return;
    visited.add(dir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: dir, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    const dirLooksLikePreview = isExplicit || /preview/i.test(basename(dir));
    if (!dirLooksLikePreview) {
      skipped.push({ path: dir, reason: 'Directory name does not look like a Premiere preview directory' });
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkPreviewDir(fullPath, true);
      } else if (entry.isFile()) {
        try {
          await fs.unlink(fullPath);
          deleted.push(fullPath);
        } catch (error) {
          skipped.push({ path: fullPath, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  for (const candidate of candidates) {
    await walkPreviewDir(candidate, Boolean(explicitDir && String(candidate) === String(explicitDir)));
  }

  return {
    success: true,
    tool: 'delete_preview_files',
    data: {
      projectPath: info.projectPath,
      projectName: info.projectName,
      sequenceName: info.sequenceName,
      scanned: candidates,
      deletedCount: deleted.length,
      skippedCount: skipped.length,
      deleted,
      skipped
    }
  };
}

function buildExpandedToolScript(name: string, args: Record<string, any>): string {
  return `
    var toolName = ${JSON.stringify(name)};
    var args = ${JSON.stringify(args ?? {})};

    function ok(data) { return JSON.stringify({ success: true, tool: toolName, data: data }); }
    function fail(message, details) { return JSON.stringify({ success: false, tool: toolName, error: String(message), details: details || null }); }
    function secondsToTicks(seconds) { return String(Math.round(Number(seconds || 0) * 254016000000)); }
    function ticksToSeconds(ticks) { return parseInt(String(ticks || "0"), 10) / 254016000000; }
    // Premiere's marker palette, in setColorByIndex() order. getColorByIndex()
    // is a getter despite the name — it ignores any argument and returns the
    // marker's own index. It is not bounded by the 0-7 write domain: a marker
    // can hold -1, a "no colour assigned" state that renders black, so the name
    // lookup is guarded and reports null rather than an absent key.
    var MARKER_COLOR_NAMES = ["green","red","purple","orange","yellow","white","blue","cyan"];
    function markerColor(marker) {
      var index = -1;
      try { index = Number(marker.getColorByIndex()); } catch (e) { return { index: null, name: null }; }
      if (isNaN(index)) return { index: null, name: null };
      var withinPalette = index >= 0 && index < MARKER_COLOR_NAMES.length;
      return { index: index, name: withinPalette ? MARKER_COLOR_NAMES[index] : null };
    }
    // Mirrors the sequence-marker resolver: a name (case-insensitive) or an
    // index 0-7. Returns null for "not supplied" and the string "invalid" for
    // input that cannot be honoured, so the caller can be told rather than
    // silently given the default colour.
    function resolveMarkerColorIndex(value) {
      if (value === undefined || value === null || value === "") return null;
      if (typeof value === "number") {
        if (value !== Math.floor(value) || value < 0 || value > 7) return "invalid";
        return value;
      }
      // The regex below doubles its backslash on purpose: inside this template
      // literal a single backslash-s would collapse to a bare "s" and strip the
      // letter instead of whitespace.
      var text = String(value).replace(/^\\s+|\\s+$/g, "").toLowerCase();
      if (/^[0-7]$/.test(text)) return Number(text);
      for (var ci = 0; ci < MARKER_COLOR_NAMES.length; ci++) {
        if (MARKER_COLOR_NAMES[ci] === text) return ci;
      }
      return "invalid";
    }
    function valueOfTime(timeValue) {
      if (!timeValue) return 0;
      if (typeof timeValue.seconds !== "undefined") return Number(timeValue.seconds);
      if (typeof timeValue.ticks !== "undefined") return ticksToSeconds(timeValue.ticks);
      return Number(timeValue) || 0;
    }
    function activeSequence() {
      return app.project && app.project.activeSequence ? app.project.activeSequence : null;
    }
    function findSequence(idOrName) {
      if (!app.project || !app.project.sequences) return null;
      for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var seq = app.project.sequences[i];
        if (seq.sequenceID === idOrName || seq.name === idOrName) return seq;
      }
      return null;
    }
    // Returns an error message when the caller named a sequence that does not
    // resolve, and null otherwise. targetSequence() already distinguishes "no id
    // given" (use the active sequence) from "id given but unresolvable" (null),
    // but every call site fell back to the active sequence anyway, which
    // collapsed the two — so a stale id silently operated on whatever sequence
    // happened to be on screen and reported success.
    // Maps a DOM sequence to its QE counterpart. QE exposes .guid, which is the
    // same value as sequence.sequenceID, so this is exact — no name matching and
    // no assumption that QE and DOM index orders agree.
    //
    // This exists because qe.project.getActiveSequence() is what most QE work
    // used, which silently retargets to whatever is on screen. QE can address any
    // sequence, so honouring a sequenceId needs no activation and no restore.
    function parRatioString(value) {
      // videoPixelAspectRatio is a string in "N:M" form, not a number. Assigning a
      // number throws "Illegal Parameter type" — verified against 26.0.2, where every
      // ratio string tried (1:1, 10:11, 40:33, 4:3, 3:2, 2:1, 64:45, 16:9, 1:2) was
      // accepted verbatim and read back unchanged.
      var text = String(value);
      if (text.indexOf(":") !== -1) return text;
      var num = Number(value);
      if (!isFinite(num) || num <= 0) return null;
      // Reduce the decimal to a fraction so 1.5 becomes "3:2" rather than a value
      // Premiere will not accept.
      var denominator = 1000;
      var numerator = Math.round(num * denominator);
      function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }
      var g = gcd(numerator, denominator);
      return (numerator / g) + ":" + (denominator / g);
    }
    function qeSequenceFor(seq) {
      if (!seq) return null;
      try { app.enableQE(); } catch (eEnable) { return null; }
      var count = 0;
      try { count = qe.project.numSequences; } catch (eCount) { return null; }
      for (var qi = 0; qi < count; qi++) {
        // Each index is guarded separately: qe.project.numSequences can report
        // more sequences than getSequenceAt() will actually return, and a throw
        // at one index must not abort the scan before the target is reached.
        try {
          var cand = qe.project.getSequenceAt(qi);
          if (cand && String(cand.guid) === String(seq.sequenceID)) return cand;
        } catch (eAt) {}
      }
      // getSequenceAt() does not expose every sequence: one created by
      // duplicate_sequence and never opened in a timeline is invisible to it, even
      // while it is the active sequence. getActiveSequence() still returns a
      // working handle in that case — verified against 26.0.2, guid and all — so
      // fall back to it, but only once the guid confirms it is the sequence that
      // was asked for. Addressing the wrong one is the bug this helper exists to
      // prevent.
      try {
        var activeCandidate = qe.project.getActiveSequence();
        if (activeCandidate && String(activeCandidate.guid) === String(seq.sequenceID)) return activeCandidate;
      } catch (eActive) {}
      return null;
    }
    function sequenceRequestError() {
      // An empty or whitespace-only id is a supplied id, not an omitted one.
      // Treating "" as absent let it fall through to the active sequence, which
      // is the exact substitution this guard exists to prevent.
      // Only fall back to the snake_case alias when sequenceId is genuinely
      // absent. Treating "" as absent would send an empty id down the
      // omitted-id path, which is the substitution this guard exists to stop.
      var requested = args.sequenceId;
      if (requested === undefined || requested === null) requested = args.sequence_id;
      if (requested === undefined || requested === null) return null;
      // The regex below doubles its backslash on purpose: inside this template
      // literal a single backslash-s would collapse to a bare "s" and strip the
      // letter instead of whitespace.
      requested = String(requested).replace(/^\\s+|\\s+$/g, "");
      if (requested === "") {
        return "sequenceId was supplied but empty. Omit it to use the active sequence, " +
          "or pass an id from list_sequences or get_active_sequence.";
      }
      if (findSequence(requested)) return null;
      return "Sequence not found by id: " + requested +
        ". Use list_sequences or get_active_sequence to obtain a valid sequence ID.";
    }
    function targetSequence() {
      return args.sequenceId || args.sequence_id ? findSequence(args.sequenceId || args.sequence_id) : activeSequence();
    }
    function walkItems(parent, visitor) {
      if (!parent || !parent.children) return;
      for (var i = 0; i < parent.children.numItems; i++) {
        var item = parent.children[i];
        visitor(item);
        if (item.children) walkItems(item, visitor);
      }
    }
    function findItem(idOrName) {
      if (!app.project || !app.project.rootItem) return null;
      var found = null;
      walkItems(app.project.rootItem, function(item) {
        if (!found && (item.nodeId === idOrName || item.name === idOrName || item.treePath === idOrName)) found = item;
      });
      return found;
    }
    function allProjectItems() {
      var items = [];
      if (!app.project || !app.project.rootItem) return items;
      walkItems(app.project.rootItem, function(item) {
        var entry = { nodeId: item.nodeId, name: item.name, type: item.type, treePath: item.treePath };
        try { entry.mediaPath = item.getMediaPath(); } catch (e) {}
        try { entry.offline = item.isOffline(); } catch (e) {}
        try { entry.colorLabel = item.getColorLabel(); } catch (e) {}
        items.push(entry);
      });
      return items;
    }
    function itemStillPresent(nodeId) {
      var present = false;
      if (!app.project || !app.project.rootItem) return false;
      walkItems(app.project.rootItem, function(item) {
        if (!present && item.nodeId === nodeId) present = true;
      });
      return present;
    }
    // Robustly delete ANY project item and verify it is actually gone.
    // deleteBin() only removes bins; called on a footage clip it silently
    // no-ops (returns without throwing), which is the classic fake-success
    // trap. Clips/files are therefore routed through a throwaway bin that we
    // then delete wholesale. Success is gated on a post-delete re-scan.
    function deleteProjectItemRobust(item) {
      var nodeId = item.nodeId;
      var name = item.name;
      var isBin = false;
      try { isBin = (item.type === 2 /* ProjectItemType.BIN */); } catch (e) {}
      var method = null;
      if (isBin) {
        var binDel = tryCall(item, ["deleteBin"], []);
        if (!binDel.called) return { deleted: false, verified: false, method: null, error: binDel.error, item: name };
        method = binDel.method;
      } else {
        var root = app.project.rootItem;
        var tmp = null;
        var mkBin = tryCall(root, ["createBin"], ["__mcp_delete_tmp__"]);
        if (mkBin.called && mkBin.result && mkBin.result.nodeId) {
          tmp = mkBin.result;
        } else {
          walkItems(root, function(b) { if (!tmp && b.name === "__mcp_delete_tmp__" && b.type === 2) tmp = b; });
        }
        if (!tmp) {
          var fb = tryCall(item, ["deleteItem", "remove", "deleteBin"], []);
          if (!fb.called) return { deleted: false, verified: false, method: null, error: "Could not create a temp bin and no direct delete method worked: " + fb.error, item: name };
          method = fb.method + " (no-temp-bin fallback)";
        } else {
          var moved = tryCall(item, ["moveBin"], [tmp]);
          if (!moved.called) {
            tryCall(tmp, ["deleteBin"], []);
            return { deleted: false, verified: false, method: null, error: "Could not move item into temp bin for deletion: " + moved.error, item: name };
          }
          var tmpDel = tryCall(tmp, ["deleteBin"], []);
          if (!tmpDel.called) return { deleted: false, verified: false, method: null, error: "Temp bin delete failed: " + tmpDel.error, item: name };
          method = "moveBin+deleteBin";
        }
      }
      var stillThere = itemStillPresent(nodeId);
      return { deleted: !stillThere, verified: true, method: method, item: name, error: stillThere ? "Premiere did not remove '" + name + "' (still present after delete attempt via " + method + ")" : null };
    }
    function projectItemInfo(item) {
      if (!item) return null;
      var data = { nodeId: item.nodeId, name: item.name, type: item.type, treePath: item.treePath };
      try { data.mediaPath = item.getMediaPath(); } catch (e) {}
      try { data.offline = item.isOffline(); } catch (e) {}
      try { data.colorLabel = item.getColorLabel(); } catch (e) {}
      return data;
    }
    function firstMediaItem() {
      if (!app.project || !app.project.rootItem) return null;
      var found = null;
      walkItems(app.project.rootItem, function(item) {
        if (found) return;
        try { if (item.getMediaPath && item.getMediaPath()) found = item; } catch (e) {}
      });
      return found;
    }
    // Set when a lookup helper bailed because the caller's sequenceId could not
    // be resolved. The helpers can only return null to mean "not found", so the
    // specific reason is parked here and preferred over the generic message at
    // the call site. One tool call per generated script, so this cannot leak
    // between requests.
    var pendingSequenceError = null;
    function findClip(nodeId) {
      var seqErr = sequenceRequestError();
      if (seqErr) { pendingSequenceError = seqErr; return null; }
      var seq = targetSequence();
      if (!seq) return null;
      function scan(collection, type) {
        for (var t = 0; t < collection.numTracks; t++) {
          var track = collection[t];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (!nodeId || clip.nodeId === nodeId || clip.name === nodeId) {
              return { clip: clip, track: track, trackIndex: t, clipIndex: c, trackType: type, sequence: seq };
            }
          }
        }
        return null;
      }
      return scan(seq.videoTracks, "video") || scan(seq.audioTracks, "audio");
    }
    // Scan ONE sequence for a clip id (or name). Shared by findClip's
    // single-sequence path and the cross-sequence resolver below.
    function scanSequenceForClip(seq, nodeId) {
      if (!seq) return null;
      function scan(collection, type) {
        if (!collection) return null;
        for (var t = 0; t < collection.numTracks; t++) {
          var track = collection[t];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (!nodeId || clip.nodeId === nodeId || clip.name === nodeId) {
              return { clip: clip, track: track, trackIndex: t, clipIndex: c, trackType: type, sequence: seq, sequenceId: seq.sequenceID, sequenceName: String(seq.name) };
            }
          }
        }
        return null;
      }
      return scan(seq.videoTracks, "video") || scan(seq.audioTracks, "audio");
    }
    /*
     * Resolve a clip id that may live in ANY sequence.
     *
     * findClip() only ever looks in one sequence -- args.sequenceId or the
     * active one -- which made every two-clip tool implicitly same-sequence.
     * copy_effects_between_clips reported "Source or target clip not found" for
     * two perfectly valid ids whenever they sat in different sequences, which is
     * the main reason to reach for it: lifting an effect stack off a reference
     * sequence onto a new one.
     *
     * An explicit sequenceId is honoured exactly (and an unresolvable one is an
     * error, never a fall back to the active sequence). With none given, the
     * active sequence is tried first and then every other sequence. Returns
     * { error: "..." } rather than null so the caller can say which side failed.
     */
    function findClipAnySequence(nodeId, explicitSequenceId, label) {
      if (!nodeId) return { error: label + " clip id is required." };
      if (explicitSequenceId !== undefined && explicitSequenceId !== null && String(explicitSequenceId) !== "") {
        var named = findSequence(String(explicitSequenceId));
        if (!named) return { error: "Sequence not found by id: " + explicitSequenceId + " (given for the " + label + " clip). Use list_sequences to obtain a valid sequence ID." };
        var inNamed = scanSequenceForClip(named, nodeId);
        if (!inNamed) return { error: label + " clip " + nodeId + " is not in sequence '" + String(named.name) + "'." };
        return { found: inNamed };
      }
      var inActive = scanSequenceForClip(activeSequence(), nodeId);
      if (inActive) return { found: inActive };
      if (app.project && app.project.sequences) {
        for (var si = 0; si < app.project.sequences.numSequences; si++) {
          var hit = scanSequenceForClip(app.project.sequences[si], nodeId);
          if (hit) return { found: hit };
        }
      }
      return { error: label + " clip not found in any sequence: " + nodeId + "." };
    }
    function clipInfo(clip, trackType, trackIndex, clipIndex) {
      var item = {
        nodeId: clip.nodeId,
        name: clip.name,
        trackType: trackType,
        trackIndex: trackIndex,
        clipIndex: clipIndex,
        start: valueOfTime(clip.start),
        end: valueOfTime(clip.end),
        inPoint: valueOfTime(clip.inPoint),
        outPoint: valueOfTime(clip.outPoint),
        duration: valueOfTime(clip.duration)
      };
      // TrackItem has no isEnabled() on 26.x -- enable state is the 'disabled'
      // boolean property (verified live). The old isEnabled() call always threw,
      // so 'enabled' was never populated.
      try { item.enabled = !clip.disabled; } catch (e) {}
      try { item.selected = clip.isSelected(); } catch (e) {}
      try { item.mediaType = clip.mediaType; } catch (e) {}
      return item;
    }
    function sequenceStructure(seq) {
      if (!seq) return null;
      var data = {
        name: seq.name,
        id: seq.sequenceID,
        durationSeconds: ticksToSeconds(seq.end),
        width: seq.frameSizeHorizontal,
        height: seq.frameSizeVertical,
        videoTracks: [],
        audioTracks: []
      };
      for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
        var videoTrack = seq.videoTracks[vt];
        var videoEntry = { index: vt, name: videoTrack.name, clipCount: videoTrack.clips.numItems, clips: [] };
        try { videoEntry.muted = videoTrack.isMuted(); } catch (e) {}
        for (var vc = 0; vc < videoTrack.clips.numItems; vc++) videoEntry.clips.push(clipInfo(videoTrack.clips[vc], "video", vt, vc));
        data.videoTracks.push(videoEntry);
      }
      for (var at = 0; at < seq.audioTracks.numTracks; at++) {
        var audioTrack = seq.audioTracks[at];
        var audioEntry = { index: at, name: audioTrack.name, clipCount: audioTrack.clips.numItems, clips: [] };
        try { audioEntry.muted = audioTrack.isMuted(); } catch (e) {}
        for (var ac = 0; ac < audioTrack.clips.numItems; ac++) audioEntry.clips.push(clipInfo(audioTrack.clips[ac], "audio", at, ac));
        data.audioTracks.push(audioEntry);
      }
      return data;
    }
    function setSelection(matchFn, selected, additive) {
      var seqErr = sequenceRequestError();
      if (seqErr) return fail(seqErr);
      var seq = targetSequence();
      if (!seq) return fail("No active sequence");
      var changed = [];
      var failed = [];
      function apply(collection, type) {
        for (var t = 0; t < collection.numTracks; t++) {
          var track = collection[t];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (!additive && selected) {
              try { clip.setSelected(0, 1); } catch (e) {}
            }
            var matched = false;
            try { matched = Boolean(matchFn(clip, type, t, c)); } catch (matchError) { matched = false; }
            if (matched) {
              try {
                clip.setSelected(selected ? 1 : 0, 1);
                // Verify-after-write: confirm the clip's selection state actually
                // flipped to what was requested before counting it as changed.
                var nowSel = null;
                try { nowSel = clip.isSelected(); } catch (eIs) {}
                var info = clipInfo(clip, type, t, c);
                if (nowSel === null || Boolean(nowSel) === Boolean(selected)) {
                  info.verified = (nowSel !== null);
                  changed.push(info);
                } else {
                  info.requestedSelected = Boolean(selected);
                  failed.push(info);
                }
              } catch (e) {
                failed.push({ nodeId: clip.nodeId, name: clip.name, trackType: type, trackIndex: t, clipIndex: c, error: e.toString() });
              }
            }
          }
        }
      }
      apply(seq.videoTracks, "video");
      apply(seq.audioTracks, "audio");
      if (changed.length === 0 && failed.length > 0) {
        return fail("Selection state did not change on any of the " + failed.length + " matched clip(s).", { failed: failed, count: 0 });
      }
      return ok({ changed: changed, count: changed.length, failed: failed, failedCount: failed.length });
    }
    function commandByName(commandName) {
      if (!app.findMenuCommandId || !app.executeCommand) {
        return fail("Premiere menu command APIs are unavailable in this CEP ExtendScript context.", {
          available: false,
          skipped: true,
          command: commandName
        });
      }
      var id = app.findMenuCommandId(commandName);
      if (!id) return fail("Menu command not found.", { available: false, skipped: true, command: commandName });
      app.executeCommand(id);
      return ok({ command: commandName, commandId: id });
    }
    function resolvePath(pathValue) {
      var normalized = String(pathValue || "app")
        .replace(/\\[([0-9]+)\\]/g, ".$1")
        .replace(/^app\\.?/, "");
      var current = app;
      if (!normalized) return current;
      var parts = normalized.split(".");
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        if (current === null || typeof current === "undefined") return undefined;
        current = current[parts[i]];
      }
      return current;
    }
    // Like resolvePath, but also roots "qe.*" paths at the QE DOM (enabling it
    // first) so reflection can map the undocumented engine, not just the public
    // app object. A bare path with no "app"/"qe" prefix is resolved from app.
    function resolveReflectPath(pathValue) {
      var raw = String(pathValue || "app").replace(/\\[([0-9]+)\\]/g, ".$1");
      var parts = raw.split(".");
      var current;
      var startIdx;
      if (parts[0] === "qe") {
        app.enableQE();
        current = qe;
        startIdx = 1;
      } else if (parts[0] === "app") {
        current = app;
        startIdx = 1;
      } else {
        current = app;
        startIdx = 0;
      }
      for (var i = startIdx; i < parts.length; i++) {
        if (!parts[i]) continue;
        if (current === null || typeof current === "undefined") return undefined;
        current = current[parts[i]];
      }
      return current;
    }
    function secondsToTime(seconds) {
      var time = new Time();
      time.seconds = Number(seconds || 0);
      return time;
    }
    function normalizeName(value) {
      return String(value || "").toLowerCase().replace(/[\\s_-]+/g, "");
    }
    function tryCall(target, methodNames, argsList) {
      if (!target) return { called: false, error: "Missing target object" };
      for (var i = 0; i < methodNames.length; i++) {
        var methodName = methodNames[i];
        try {
          if (typeof target[methodName] === "function") {
            return { called: true, method: methodName, result: target[methodName].apply(target, argsList || []) };
          }
        } catch (e) {
          return { called: false, method: methodName, error: e.toString() };
        }
      }
      return { called: false, error: "None of these methods are available: " + methodNames.join(", ") };
    }
    function findParentItem(targetItem) {
      if (!app.project || !app.project.rootItem || !targetItem) return null;
      var foundParent = null;
      function scan(parent) {
        if (!parent || !parent.children || foundParent) return;
        for (var i = 0; i < parent.children.numItems; i++) {
          var child = parent.children[i];
          if (child === targetItem || child.nodeId === targetItem.nodeId) {
            foundParent = parent;
            return;
          }
          if (child.children) scan(child);
        }
      }
      scan(app.project.rootItem);
      return foundParent;
    }
    function moveItemToBin(item, bin) {
      if (!item || !bin) return { ok: false, error: "Missing item or bin" };
      // moveBin()/moveToBin() return void and no-op silently when the move is
      // rejected, so a non-throwing call is not proof. Confirm the item's parent
      // is actually the destination bin afterward before reporting success.
      function nowInBin() {
        var parent = findParentItem(item);
        return parent && (parent === bin || String(parent.nodeId) === String(bin.nodeId));
      }
      var moved = tryCall(item, ["moveBin", "moveToBin"], [bin]);
      if (moved.called) {
        if (nowInBin()) return { ok: true, method: moved.method, verified: true };
        // fall through to the moveChild path before giving up
      }
      var parent = findParentItem(item);
      if (parent && parent.moveChild) {
        try { parent.moveChild(item, bin); } catch (moveError) { if (!moved.called) return { ok: false, error: moveError.toString() }; }
        if (nowInBin()) return { ok: true, method: "parent.moveChild", verified: true };
      }
      if (moved.called) return { ok: false, error: "Premiere reported the move but '" + item.name + "' is not in bin '" + bin.name + "'.", verified: false };
      return { ok: false, error: moved.error };
    }
    function allClips(seq) {
      var clips = [];
      if (!seq) return clips;
      function collect(collection, type) {
        for (var t = 0; t < collection.numTracks; t++) {
          var track = collection[t];
          for (var c = 0; c < track.clips.numItems; c++) clips.push({ clip: track.clips[c], track: track, trackIndex: t, clipIndex: c, trackType: type, sequence: seq });
        }
      }
      collect(seq.videoTracks, "video");
      collect(seq.audioTracks, "audio");
      return clips;
    }
    function findComponent(clip, componentName) {
      if (!clip || !clip.components) return null;
      var wanted = normalizeName(componentName);
      for (var i = 0; i < clip.components.numItems; i++) {
        var component = clip.components[i];
        if (normalizeName(component.displayName) === wanted || normalizeName(component.matchName) === wanted) return { component: component, index: i };
      }
      return null;
    }
    // The effect-component names present on a clip. Returned alongside a
    // "nothing matched" failure so the caller can see WHY the match missed
    // instead of guessing at spelling.
    function componentNames(clip) {
      var names = [];
      if (!clip || !clip.components) return names;
      for (var i = 0; i < clip.components.numItems; i++) {
        try { names.push(String(clip.components[i].displayName)); } catch (e) {}
      }
      return names;
    }
    function componentProperties(component) {
      var props = [];
      if (!component || !component.properties) return props;
      for (var i = 0; i < component.properties.numItems; i++) {
        var prop = component.properties[i];
        var value = null;
        try { value = prop.getValue(); } catch (e) {}
        props.push({ index: i, name: String(prop.displayName), value: value });
      }
      return props;
    }
    // Tolerant equality for effect-property readback. Handles numbers (drift),
    // array-valued properties (Position, Anchor Point, color triplets) and the
    // string/enum case. Used to prove a setValue() actually took, rather than
    // trusting that it did not throw (Premiere setters silently no-op on many
    // out-of-range or wrong-type inputs).
    function valuesMatch(a, b) {
      var TOL = 0.01;
      if (a === null || a === undefined) return false;
      if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= TOL;
      if (a && b && typeof a.length === "number" && typeof b.length === "number" && typeof a !== "string" && typeof b !== "string") {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) { if (Math.abs(Number(a[i]) - Number(b[i])) > TOL) return false; }
        return true;
      }
      if (typeof b === "number") { var an = Number(a); if (!isNaN(an)) return Math.abs(an - b) <= TOL; }
      return String(a) === String(b);
    }
    function setComponentProperty(component, propertyName, value) {
      if (!component || !component.properties) return { ok: false, error: "Component has no properties" };
      var wanted = normalizeName(propertyName);
      for (var i = 0; i < component.properties.numItems; i++) {
        var prop = component.properties[i];
        if (normalizeName(prop.displayName) !== wanted) continue;
        var before = null;
        var after = null;
        try { before = prop.getValue(); } catch (eBefore) {}
        try {
          prop.setValue(value, true);
          try { after = prop.getValue(); } catch (eAfter) {}
          // Verify-after-write: only claim success when the property actually
          // reads back as the requested value.
          if (after === null || after === undefined) {
            // setValue did not throw but the value is not readable to confirm.
            return { ok: true, verified: false, property: String(prop.displayName), before: before, after: after, requested: value, note: "setValue did not throw, but the property value could not be read back to confirm it applied." };
          }
          if (!valuesMatch(after, value)) {
            return { ok: false, verified: false, property: String(prop.displayName), before: before, after: after, requested: value, error: "Premiere did not apply the requested value to '" + String(prop.displayName) + "' (reads back as " + String(after) + ", requested " + String(value) + ")." };
          }
          return { ok: true, verified: true, property: String(prop.displayName), before: before, after: after };
        } catch (eSet) {
          return { ok: false, property: String(prop.displayName), error: eSet.toString() };
        }
      }
      return { ok: false, error: "Property not found: " + propertyName };
    }
    function getComponentProperty(component, propertyName) {
      if (!component || !component.properties) return { ok: false, error: "Component has no properties" };
      var wanted = normalizeName(propertyName);
      for (var i = 0; i < component.properties.numItems; i++) {
        var prop = component.properties[i];
        if (normalizeName(prop.displayName) !== wanted) continue;
        try {
          return { ok: true, property: String(prop.displayName), value: prop.getValue() };
        } catch (eGet) {
          return { ok: false, property: String(prop.displayName), error: eGet.toString() };
        }
      }
      return { ok: false, error: "Property not found: " + propertyName };
    }
    function findProperty(component, propertyName) {
      if (!component || !component.properties) return null;
      var wanted = normalizeName(propertyName);
      for (var i = 0; i < component.properties.numItems; i++) {
        var prop = component.properties[i];
        if (normalizeName(prop.displayName) === wanted) return prop;
      }
      return null;
    }
    function qeClipForClip(found) {
      // findClip() searches every sequence, so the clip may not live in the active
      // one; and QE track items include gaps and transitions, so the DOM clip index
      // addresses a different item. Both were fixed at the tool call sites but missed
      // here, which meant every tool routing through this helper -- set_frame_blend,
      // set_time_interpolation, set_clip_volume, set_clip_pan, set_clip_opacity --
      // kept mutating whatever sat at that index in whatever sequence was on screen.
      if (!found) return null;
      var qeSeq = qeSequenceFor(found.sequence);
      if (!qeSeq) return null;
      var qeTrack = found.trackType === "video" ? qeSeq.getVideoTrackAt(found.trackIndex) : qeSeq.getAudioTrackAt(found.trackIndex);
      if (!qeTrack) return null;
      return __findQeClipByDomClip(qeTrack, found.clip);
    }
    // Effect-removal helpers, shared by remove_effect and remove_all_effects. Defined
    // here (not inside a case) because ExtendScript only assigns a function declared in
    // a case block when that case executes, so a sibling case would see it as undefined.
    function reIsIntrinsic(comp) {
      var m = String(comp.matchName);
      if (m === "AE.ADBE Motion" || m === "AE.ADBE Opacity" || m === "AE.ADBE Volume" || m === "AE.ADBE Pan") return true;
      var n = normalizeName(comp.displayName);
      return n === "motion" || n === "opacity" || n === "volume" || n === "pan";
    }
    function reIsLumetri(comp) {
      return String(comp.matchName).indexOf("Lumetri") !== -1 || normalizeName(comp.displayName) === "lumetricolor";
    }
    function reSnapshot(clip) {
      var a = [];
      for (var i = 0; i < clip.components.numItems; i++) a.push(String(clip.components[i].matchName));
      return a;
    }
    function markerCollectionForTool() {
      var seqErr = sequenceRequestError();
      if (seqErr) { pendingSequenceError = seqErr; return null; }
      var seq = targetSequence();
      if (args.projectItemId || args.itemId || args.item_id) {
        var markerItem = findItem(args.projectItemId || args.itemId || args.item_id);
        if (markerItem && markerItem.getMarkers) return markerItem.getMarkers();
      }
      return seq && seq.markers ? seq.markers : null;
    }

    try {
      switch (toolName) {
        case "ping":
          return ok({
            connected: true,
            premiereVersion: app.version,
            buildNumber: app.build,
            projectName: app.project ? app.project.name : null,
            activeSequence: activeSequence() ? activeSequence().name : null
          });

        case "evaluate_expression":
          var expression = String(args.expression || args.code || "app.version");
          var value = resolvePath(expression);
          return ok({ value: value, type: typeof value });

        case "inspect_dom_object":
          var objectPath = String(args.object_path || args.path || "app");
          var depth = Number(args.depth || 1);
          var target = resolvePath(objectPath);
          function inspect(value, level) {
            if (value === null || typeof value !== "object" || level >= depth) return String(value);
            var out = {};
            for (var key in value) {
              try {
                var child = value[key];
                out[key] = (child && typeof child === "object") ? (level + 1 >= depth ? "[object]" : inspect(child, level + 1)) : child;
              } catch (e) {}
            }
            return out;
          }
          return ok({ path: objectPath, value: inspect(target, 0) });

        case "reflect_dom_object":
          // The escape-hatch companion to execute_extendscript: enumerate the
          // *callable* surface of any DOM object via ExtendScript's .reflect
          // interface. Unlike inspect_dom_object (for..in), this reveals native
          // methods -- their return type, argument names/types, and description --
          // which are non-enumerable and invisible to property iteration. Pure
          // read: reflection never mutates.
          var reflectPath = String(args.object_path || args.path || "app");
          var nameFilter = args.name_filter ? normalizeName(String(args.name_filter)) : null;
          var includeValues = (args.include_values === true);
          var reflectTarget = resolveReflectPath(reflectPath);
          if (reflectTarget === null || typeof reflectTarget === "undefined") {
            return fail("Path did not resolve to a value: " + reflectPath);
          }
          if (typeof reflectTarget !== "object" && typeof reflectTarget !== "function") {
            return ok({
              path: reflectPath,
              dataType: typeof reflectTarget,
              value: String(reflectTarget),
              reflectable: false,
              methods: [],
              properties: []
            });
          }
          var reflectApi = null;
          try { reflectApi = reflectTarget.reflect; } catch (eR) {}
          if (!reflectApi) return fail("Object at " + reflectPath + " exposes no reflect interface");

          var reflectClassName = null;
          try { reflectClassName = String(reflectApi.name); } catch (eN) {}

          function skipReflectName(nm) {
            return nm.length >= 2 && nm.substr(0, 2) === "__";
          }
          function passesFilter(nm) {
            return !nameFilter || normalizeName(nm).indexOf(nameFilter) !== -1;
          }

          var reflectMethods = [];
          try {
            var ms = reflectApi.methods;
            for (var rmi = 0; rmi < ms.length; rmi++) {
              var mEntry = ms[rmi];
              var mName = String(mEntry.name);
              if (skipReflectName(mName) || !passesFilter(mName)) continue;
              var mArgs = [];
              try {
                if (mEntry.arguments != null) {
                  for (var ma = 0; ma < mEntry.arguments.length; ma++) {
                    var aEntry = mEntry.arguments[ma];
                    mArgs.push({
                      name: String(aEntry.name),
                      type: (aEntry.dataType != null ? String(aEntry.dataType) : null)
                    });
                  }
                }
              } catch (eMa) {}
              var mRec = {
                name: mName,
                returns: (mEntry.dataType != null ? String(mEntry.dataType) : null),
                args: mArgs
              };
              var mDesc = "";
              try { mDesc = String(mEntry.description || ""); } catch (eMd) {}
              if (mDesc) mRec.description = mDesc;
              reflectMethods.push(mRec);
            }
          } catch (eMethods) {}

          var reflectProps = [];
          try {
            var ps = reflectApi.properties;
            for (var rpi = 0; rpi < ps.length; rpi++) {
              var pEntry = ps[rpi];
              var pName = String(pEntry.name);
              if (skipReflectName(pName) || !passesFilter(pName)) continue;
              var pRec = { name: pName, type: (pEntry.dataType != null ? String(pEntry.dataType) : null) };
              if (includeValues) {
                try {
                  var pv = reflectTarget[pName];
                  if (pv === null || typeof pv !== "object") pRec.value = pv;
                  else pRec.value = "[" + (typeof pv) + "]";
                } catch (ePv) { pRec.value = "<threw: " + ePv.toString() + ">"; }
              }
              reflectProps.push(pRec);
            }
          } catch (eProps) {}

          reflectMethods.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
          reflectProps.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });

          return ok({
            path: reflectPath,
            className: reflectClassName,
            dataType: typeof reflectTarget,
            methodCount: reflectMethods.length,
            propertyCount: reflectProps.length,
            methods: reflectMethods,
            properties: reflectProps
          });

        case "list_lumetri_presets":
          // The full Lumetri preset catalogue (built-in plus any the user has
          // installed), read straight from the engine. Names returned here are
          // exactly what apply_lumetri_preset expects.
          if (!app.project || typeof app.project.getAllLumetriPresetsList !== "function") {
            return fail("Lumetri preset list is unavailable (app.project.getAllLumetriPresetsList not found in this build).");
          }
          var lumFilter = args.name_filter ? normalizeName(String(args.name_filter)) : null;
          var rawPresets = app.project.getAllLumetriPresetsList();
          var totalPresets = (rawPresets && rawPresets.length !== undefined) ? rawPresets.length : 0;
          var presetNames = [];
          for (var lpi = 0; lpi < totalPresets; lpi++) {
            var presetName = String(rawPresets[lpi]);
            if (lumFilter && normalizeName(presetName).indexOf(lumFilter) === -1) continue;
            presetNames.push(presetName);
          }
          presetNames.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
          return ok({ count: presetNames.length, totalAvailable: totalPresets, presets: presetNames });

        case "apply_lumetri_preset":
          // Applies a named Lumetri preset to a video clip and VERIFIES it took:
          // the engine's applyLumetriPreset() returns true even when nothing
          // changed, so success here means a Lumetri component was gained, or an
          // already-present one's property values changed. Otherwise it reports
          // failure honestly.
          var presetArg = args.preset_name || args.presetName || args.preset;
          if (!presetArg) return fail("preset_name is required. Use list_lumetri_presets to see available presets.");
          if (!app.project || typeof app.project.applyLumetriPreset !== "function") {
            return fail("app.project.applyLumetriPreset is unavailable in this Premiere build.");
          }
          // Validate against the real catalogue (case/format-insensitive) and
          // resolve to the exact spelling the engine expects.
          var wantPreset = normalizeName(String(presetArg));
          var canonicalPreset = null;
          var catalogue = [];
          try { catalogue = app.project.getAllLumetriPresetsList() || []; } catch (eList) {}
          for (var cpi = 0; cpi < catalogue.length; cpi++) {
            if (normalizeName(String(catalogue[cpi])) === wantPreset) { canonicalPreset = String(catalogue[cpi]); break; }
          }
          if (canonicalPreset === null) {
            return fail("Preset not found: " + String(presetArg) + ". Use list_lumetri_presets for the exact names.");
          }
          var lpSeqErr = sequenceRequestError();
          if (lpSeqErr) return fail(lpSeqErr);
          var lpSeq = targetSequence();
          if (!lpSeq) return fail("No active sequence to apply a Lumetri preset to.");
          // applyLumetriPreset() acts on the SELECTED clips of the ACTIVE
          // sequence, so the target sequence must be made active.
          try { app.project.activeSequence = lpSeq; } catch (eAct) {}

          function lpLumetriComponent(clip) {
            for (var ci = 0; ci < clip.components.numItems; ci++) {
              if (String(clip.components[ci].matchName).indexOf("Lumetri") !== -1) return clip.components[ci];
            }
            return null;
          }
          // Fingerprint = component presence plus a checksum over every property
          // value, so re-applying onto an already-graded clip is still detectable
          // even though the component list does not change.
          function lpFingerprint(clip) {
            var comp = lpLumetriComponent(clip);
            if (!comp) return { hasLumetri: false, checksum: 0, propCount: 0 };
            var sum = 0, n = 0;
            for (var p = 0; p < comp.properties.numItems; p++) {
              var v;
              try { v = comp.properties[p].getValue(); } catch (eV) { v = "ERR"; }
              var s = String(v);
              for (var k = 0; k < s.length; k++) { sum = (sum + s.charCodeAt(k) * (p + 1)) % 2147483647; }
              n++;
            }
            return { hasLumetri: true, checksum: sum, propCount: n };
          }
          function lpDeselectAll(coll) {
            for (var t = 0; t < coll.numTracks; t++) {
              var track = coll[t];
              for (var c = 0; c < track.clips.numItems; c++) {
                try { track.clips[c].setSelected(0, 1); } catch (eD) {}
              }
            }
          }

          var lpClipId = args.clipNodeId || args.clip_node_id || args.nodeId || args.node_id || args.clipId || args.clip_id || args.clip_name || args.clipName;
          var lpTargets = [];
          if (lpClipId) {
            // Deselect everything, then select only the named video clip so the
            // preset cannot leak onto whatever else happened to be selected.
            lpDeselectAll(lpSeq.videoTracks);
            lpDeselectAll(lpSeq.audioTracks);
            for (var vt = 0; vt < lpSeq.videoTracks.numTracks; vt++) {
              var vtrack = lpSeq.videoTracks[vt];
              for (var vc = 0; vc < vtrack.clips.numItems; vc++) {
                var vclip = vtrack.clips[vc];
                if (vclip.nodeId === lpClipId || vclip.name === lpClipId) {
                  try { vclip.setSelected(1, 1); } catch (eSel) {}
                  lpTargets.push({ clip: vclip, trackIndex: vt, clipIndex: vc });
                }
              }
            }
            if (!lpTargets.length) return fail("Video clip not found in the target sequence: " + String(lpClipId) + ". Lumetri presets apply to video clips.");
          } else {
            for (var svt = 0; svt < lpSeq.videoTracks.numTracks; svt++) {
              var strack = lpSeq.videoTracks[svt];
              for (var svc = 0; svc < strack.clips.numItems; svc++) {
                var sclip = strack.clips[svc];
                var isSel = false;
                try { isSel = sclip.isSelected(); } catch (eIs) {}
                if (isSel) lpTargets.push({ clip: sclip, trackIndex: svt, clipIndex: svc });
              }
            }
            if (!lpTargets.length) return fail("No video clip is selected. applyLumetriPreset acts on the selection; pass clip_name/clipNodeId or select a video clip first.");
          }

          var lpBefore = [];
          for (var lb = 0; lb < lpTargets.length; lb++) lpBefore.push(lpFingerprint(lpTargets[lb].clip));
          var lpRet = null;
          try { lpRet = app.project.applyLumetriPreset(canonicalPreset); }
          catch (eApply) { return fail("applyLumetriPreset threw: " + eApply.toString(), { preset: canonicalPreset }); }

          var lpResults = [];
          var lpAllVerified = true;
          for (var la = 0; la < lpTargets.length; la++) {
            var afterFp = lpFingerprint(lpTargets[la].clip);
            var beforeFp = lpBefore[la];
            var gained = (!beforeFp.hasLumetri && afterFp.hasLumetri);
            var changed = (beforeFp.hasLumetri && afterFp.hasLumetri && beforeFp.checksum !== afterFp.checksum);
            var verified = gained || changed;
            if (!verified) lpAllVerified = false;
            lpResults.push({
              nodeId: lpTargets[la].clip.nodeId,
              name: String(lpTargets[la].clip.name),
              trackIndex: lpTargets[la].trackIndex,
              gainedLumetri: gained,
              valuesChanged: changed,
              verified: verified
            });
          }
          if (!lpAllVerified) {
            return fail("Preset applied but the change could not be verified on every target clip (no Lumetri component gained and no property values changed). The clip may already carry this exact grade.", {
              preset: canonicalPreset,
              applyReturned: lpRet,
              clips: lpResults
            });
          }
          return ok({
            preset: canonicalPreset,
            sequence: { name: lpSeq.name, id: lpSeq.sequenceID },
            applyReturned: lpRet,
            clipsAffected: lpResults.length,
            clips: lpResults,
            verified: true
          });

        case "apply_video_effect":
          // Adds a video effect to a clip through the QE DOM and VERIFIES it by
          // diffing the clip's component list before and after. The value here is
          // honesty about identity: qe.project.getVideoEffectByName() resolves by
          // DISPLAY name only, and on a system with third-party plugins a stock
          // name like "Gaussian Blur" can silently resolve to a plugin's effect
          // (e.g. AE.Impact_Blur_FX) instead of Adobe's AE.ADBE Gaussian Blur 2.
          // So this reports the matchName that ACTUALLY landed, and if the caller
          // passes expected_match_name it enforces the identity — rolling the add
          // back when it is safe to do so (no other user effects would be lost).
          var aveEffect = args.effect_name || args.effectName || args.effect;
          if (!aveEffect) return fail("effect_name is required. Use list_available_effects to see the display names Premiere accepts.");
          aveEffect = String(aveEffect);
          var aveExpected = args.expected_match_name || args.expectedMatchName || args.match_name || args.matchName || null;
          if (aveExpected) aveExpected = String(aveExpected);

          var aveSeqErr = sequenceRequestError();
          if (aveSeqErr) return fail(aveSeqErr);
          var aveSeq = targetSequence();
          if (!aveSeq) return fail("No active sequence to apply a video effect in.");

          var aveClipId = args.clipNodeId || args.clip_node_id || args.nodeId || args.node_id || args.clipId || args.clip_id || args.clip_name || args.clipName;
          if (!aveClipId) return fail("clip_name or clipNodeId is required (the video clip to receive the effect).");
          var aveInfo = null;
          for (var avt = 0; avt < aveSeq.videoTracks.numTracks; avt++) {
            var avtrack = aveSeq.videoTracks[avt];
            for (var avc = 0; avc < avtrack.clips.numItems; avc++) {
              var avclip = avtrack.clips[avc];
              if (avclip.nodeId === aveClipId || String(avclip.name) === String(aveClipId)) {
                aveInfo = { clip: avclip, trackIndex: avt, clipIndex: avc };
                break;
              }
            }
            if (aveInfo) break;
          }
          if (!aveInfo) return fail("Video clip not found in the target sequence: " + String(aveClipId) + ". apply_video_effect targets video clips.");

          // matchName + a checksum over property values, so two components with
          // the same name are still told apart by their current parameter state.
          function aveFingerprint(component) {
            var matchName = "";
            try { matchName = String(component.matchName || ""); } catch (eM) {}
            var displayName = "";
            try { displayName = String(component.displayName || ""); } catch (eDn) {}
            var sum = 0, propCount = 0;
            try {
              propCount = component.properties.numItems;
              for (var p = 0; p < propCount; p++) {
                var v;
                try { v = component.properties[p].getValue(); } catch (eV) { v = "ERR"; }
                var s = String(v);
                for (var k = 0; k < s.length; k++) { sum = (sum + s.charCodeAt(k) * (p + 1)) % 2147483647; }
              }
            } catch (eP) { propCount = -1; }
            return { matchName: matchName, displayName: displayName, propCount: propCount, key: displayName + "|" + matchName + "|" + propCount + "|" + sum };
          }
          function aveSnapshot(clip) {
            var arr = [];
            for (var i = 0; i < clip.components.numItems; i++) arr.push(aveFingerprint(clip.components[i]));
            return arr;
          }
          function aveKeysEqual(left, right) {
            if (left.length !== right.length) return false;
            for (var i = 0; i < left.length; i++) if (left[i].key !== right[i].key) return false;
            return true;
          }
          function aveIsIntrinsic(matchName) {
            return matchName === "AE.ADBE Opacity" || matchName === "AE.ADBE Motion" || matchName.indexOf("Lumetri") !== -1;
          }

          var aveBefore = aveSnapshot(aveInfo.clip);
          // removeEffects() strips every user effect at once (Lumetri excepted), so
          // a rollback is only clean when our add is the sole non-intrinsic effect.
          var aveUserEffectsBefore = 0;
          for (var aub = 0; aub < aveBefore.length; aub++) if (!aveIsIntrinsic(aveBefore[aub].matchName)) aveUserEffectsBefore++;

          var aveQeSeq = qeSequenceFor(aveSeq);
          if (!aveQeSeq) return fail("Could not address the sequence through the QE DOM (effect add is a QE-only operation). Open the sequence in a timeline and retry.");
          var aveQeTrack = aveQeSeq.getVideoTrackAt(aveInfo.trackIndex);
          var aveQeClip = __findQeClipByDomClip(aveQeTrack, aveInfo.clip);
          if (!aveQeClip) return fail("Could not locate the matching QE clip for the effect add.");
          var aveFx = qe.project.getVideoEffectByName(aveEffect);
          if (!aveFx) return fail("Effect not found: " + aveEffect + ". Use list_available_effects for the exact display names.");
          try { aveQeClip.addVideoEffect(aveFx); }
          catch (eAdd) { return fail("addVideoEffect threw: " + eAdd.toString(), { requestedEffectName: aveEffect }); }

          var aveAfter = aveSnapshot(aveInfo.clip);
          if (aveAfter.length <= aveBefore.length) {
            return fail("Effect add created no new component on the clip — a silent no-op (some builds ignore QE structural edits).", {
              requestedEffectName: aveEffect, beforeComponentCount: aveBefore.length, afterComponentCount: aveAfter.length
            });
          }
          // Identify the inserted component: the one index whose removal restores
          // the exact pre-add sequence. Ambiguous only if an identical component
          // already existed (same name AND same property values).
          var aveCandidates = [];
          if (aveAfter.length === aveBefore.length + 1) {
            for (var aci = 0; aci < aveAfter.length; aci++) {
              var without = [];
              for (var aj = 0; aj < aveAfter.length; aj++) if (aj !== aci) without.push(aveAfter[aj]);
              if (aveKeysEqual(aveBefore, without)) aveCandidates.push(aci);
            }
          }
          var aveAddedMatch = null, aveAddedDisplay = null, aveAddedIdx = -1, aveConfidence = "unique";
          if (aveCandidates.length === 1) {
            aveAddedIdx = aveCandidates[0];
            aveAddedMatch = aveAfter[aveAddedIdx].matchName;
            aveAddedDisplay = aveAfter[aveAddedIdx].displayName;
          } else {
            // Could not pin the exact index. If every extra component shares one
            // matchName, identity is still known even though the slot is not.
            aveConfidence = "ambiguous";
            var extraMatches = {};
            var firstExtra = null;
            for (var aem = 0; aem < aveAfter.length; aem++) {
              var mn = aveAfter[aem].matchName;
              extraMatches[mn] = (extraMatches[mn] || 0) + 1;
            }
            var distinctNonIntrinsic = [];
            for (var mnk in extraMatches) {
              if (extraMatches.hasOwnProperty && !extraMatches.hasOwnProperty(mnk)) continue;
              if (!aveIsIntrinsic(mnk)) { distinctNonIntrinsic.push(mnk); if (firstExtra === null) firstExtra = mnk; }
            }
            if (distinctNonIntrinsic.length === 1) aveAddedMatch = distinctNonIntrinsic[0];
          }

          // Identity guard: did the display name resolve to the effect the caller meant?
          if (aveExpected) {
            var identityKnown = (aveAddedMatch !== null);
            var identityMatches = identityKnown && (normalizeName(aveAddedMatch) === normalizeName(aveExpected));
            if (!identityMatches) {
              var aveRolledBack = false;
              if (aveUserEffectsBefore === 0) {
                try { aveQeClip.removeEffects(); } catch (eRb) {}
                aveRolledBack = aveKeysEqual(aveBefore, aveSnapshot(aveInfo.clip));
              }
              return fail(
                identityKnown
                  ? ("Requested '" + aveEffect + "' resolved to matchName '" + aveAddedMatch + "', not the expected '" + aveExpected + "'. A plugin or legacy variant likely shadows this display name on this system.")
                  : ("Requested '" + aveEffect + "' was added but its identity could not be confirmed against the expected '" + aveExpected + "' (an identical component already existed)."),
                {
                  requestedEffectName: aveEffect,
                  expectedMatchName: aveExpected,
                  actualMatchName: aveAddedMatch,
                  identityMismatch: identityKnown,
                  identityConfidence: aveConfidence,
                  rolledBack: aveRolledBack,
                  rollbackNote: aveUserEffectsBefore === 0 ? undefined : "Left in place: the clip carried other user effects and removeEffects() would strip all of them."
                }
              );
            }
          }

          return ok({
            sequence: { name: aveSeq.name, id: aveSeq.sequenceID },
            clip: { nodeId: aveInfo.clip.nodeId, name: String(aveInfo.clip.name), trackIndex: aveInfo.trackIndex },
            requestedEffectName: aveEffect,
            addedComponent: { displayName: aveAddedDisplay, matchName: aveAddedMatch, componentIndex: aveAddedIdx },
            identityConfidence: aveConfidence,
            identityVerified: aveExpected ? true : undefined,
            verified: true
          });

        case "get_timeline_render_status":
          // The timeline's render-bar state, read from the QE DOM: green = a
          // rendered preview exists; yellow = unrendered but expected to play in
          // real time; red = unrendered and may drop frames; empty = no media.
          // Addresses the sequence by guid (never blindly the on-screen one).
          // Distinct from get_render_queue_status, which reports Media Encoder.
          var rsSeqErr = sequenceRequestError();
          if (rsSeqErr) return fail(rsSeqErr);
          var rsSeq = targetSequence();
          if (!rsSeq) return fail("No active sequence to report render status for.");
          var rsQe = qeSequenceFor(rsSeq);
          if (!rsQe) return fail("Could not address the sequence through the QE DOM (render bars are a QE-only feature). Open the sequence in a timeline and retry.");
          function rsSegments(getter) {
            var times;
            try { times = getter(); } catch (eG) { return { available: false, error: eG.toString(), segmentCount: 0, totalSeconds: 0, segments: [] }; }
            var segs = [];
            var total = 0;
            if (times && times.length !== undefined) {
              // Bar times arrive as a flat, alternating start/end list.
              for (var i = 0; i + 1 < times.length; i += 2) {
                var start = Number(times[i].secs);
                var end = Number(times[i + 1].secs);
                var dur = end - start;
                if (dur < 0) dur = 0;
                total += dur;
                segs.push({ start: start, end: end, duration: dur });
              }
            }
            return { available: true, segmentCount: segs.length, totalSeconds: total, segments: segs };
          }
          var rsGreen = rsSegments(function () { return rsQe.getGreenBarTimes(); });
          var rsYellow = rsSegments(function () { return rsQe.getYellowBarTimes(); });
          var rsRed = rsSegments(function () { return rsQe.getRedBarTimes(); });
          var rsEmpty = rsSegments(function () { return rsQe.getEmptyBarTimes(); });
          var rsRenderable = rsGreen.totalSeconds + rsYellow.totalSeconds + rsRed.totalSeconds;
          var rsUnrendered = rsYellow.totalSeconds + rsRed.totalSeconds;
          return ok({
            sequence: { name: rsSeq.name, id: rsSeq.sequenceID },
            green: rsGreen,
            yellow: rsYellow,
            red: rsRed,
            empty: rsEmpty,
            renderableSeconds: rsRenderable,
            renderedSeconds: rsGreen.totalSeconds,
            unrenderedSeconds: rsUnrendered,
            renderedFraction: (rsRenderable > 0 ? (rsGreen.totalSeconds / rsRenderable) : null),
            fullyRendered: (rsUnrendered === 0 && rsRenderable > 0)
          });

        case "get_version_info":
          return ok({ version: app.version, build: app.build });

        case "get_premiere_state":
        case "get_full_project_overview":
          var sequences = [];
          if (app.project && app.project.sequences) {
            for (var si = 0; si < app.project.sequences.numSequences; si++) {
              var seq = app.project.sequences[si];
              sequences.push({ name: seq.name, id: seq.sequenceID, durationSeconds: ticksToSeconds(seq.end), width: seq.frameSizeHorizontal, height: seq.frameSizeVertical });
            }
          }
          return ok({
            project: app.project ? { name: app.project.name, path: app.project.path, itemCount: allProjectItems().length } : null,
            activeSequence: activeSequence() ? sequenceStructure(activeSequence()) : null,
            sequences: sequences,
            version: app.version,
            build: app.build
          });

        case "get_sequence_structure":
        case "get_full_sequence_info":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          return ok(sequenceStructure(targetSequence()));

        case "get_timeline_summary":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var sumSeq = targetSequence();
          var structure = sequenceStructure(sumSeq);
          var videoClips = 0;
          var audioClips = 0;
          if (structure) {
            for (var sv = 0; sv < structure.videoTracks.length; sv++) videoClips += structure.videoTracks[sv].clipCount;
            for (var sa = 0; sa < structure.audioTracks.length; sa++) audioClips += structure.audioTracks[sa].clipCount;
          }
          return ok({ sequence: structure ? { name: structure.name, id: structure.id, durationSeconds: structure.durationSeconds } : null, videoClips: videoClips, audioClips: audioClips });

        case "get_sequence_count":
          return ok({ count: app.project && app.project.sequences ? app.project.sequences.numSequences : 0 });

        case "get_total_clip_count":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var countStruct = sequenceStructure(targetSequence());
          var vCount = 0, aCount = 0;
          if (countStruct) {
            for (var cv = 0; cv < countStruct.videoTracks.length; cv++) vCount += countStruct.videoTracks[cv].clipCount;
            for (var ca = 0; ca < countStruct.audioTracks.length; ca++) aCount += countStruct.audioTracks[ca].clipCount;
          }
          return ok({ videoClips: vCount, audioClips: aCount, total: vCount + aCount });

        case "get_project_item_info":
        case "get_item_info":
          var item = findItem(args.item_id || args.itemId || args.projectItemId || args.node_id || args.nodeId || args.name);
          if (!item) return fail("Project item not found");
          var itemData = { nodeId: item.nodeId, name: item.name, type: item.type, treePath: item.treePath };
          try { itemData.mediaPath = item.getMediaPath(); } catch (e) {}
          try { itemData.offline = item.isOffline(); } catch (e) {}
          return ok(itemData);

        case "search_project_items":
        case "find_items_by_media_path":
          var query = String(args.query || args.name || args.mediaPath || args.path || "").toLowerCase();
          var matches = [];
          var allItems = allProjectItems();
          for (var mi = 0; mi < allItems.length; mi++) {
            var haystack = String(allItems[mi].name || "") + " " + String(allItems[mi].mediaPath || "") + " " + String(allItems[mi].treePath || "");
            if (!query || haystack.toLowerCase().indexOf(query) !== -1) matches.push(allItems[mi]);
          }
          return ok({ query: query, count: matches.length, items: matches });

        case "get_bin_contents":
          var bin = findItem(args.bin_id || args.binId || args.name);
          if (!bin) return fail("Bin not found");
          var childItems = [];
          if (bin.children) {
            for (var bi = 0; bi < bin.children.numItems; bi++) {
              var child = bin.children[bi];
              childItems.push({ nodeId: child.nodeId, name: child.name, type: child.type, treePath: child.treePath });
            }
          }
          return ok({ bin: { nodeId: bin.nodeId, name: bin.name, treePath: bin.treePath }, items: childItems, count: childItems.length });

        case "get_offline_media":
          var offline = [];
          var offlineItems = allProjectItems();
          for (var oi = 0; oi < offlineItems.length; oi++) if (offlineItems[oi].offline) offline.push(offlineItems[oi]);
          return ok({ count: offline.length, items: offline });

        case "get_used_media_report":
        case "get_unused_media":
        case "get_duplicate_media":
          return ok({ items: allProjectItems(), note: "Project item scan completed; sequence media usage is exposed through get_sequence_structure." });

        case "get_all_project_paths":
          var projectPaths = [];
          var pathItems = allProjectItems();
          for (var pi = 0; pi < pathItems.length; pi++) {
            if (pathItems[pi].mediaPath) projectPaths.push({ nodeId: pathItems[pi].nodeId, name: pathItems[pi].name, path: pathItems[pi].mediaPath });
          }
          return ok({ projectPath: app.project ? app.project.path : null, count: projectPaths.length, paths: projectPaths });

        case "get_insertion_bin":
          if (!app.project || !app.project.getInsertionBin) return fail("app.project.getInsertionBin is unavailable");
          var insertionBin = app.project.getInsertionBin();
          if (!insertionBin) return fail("Premiere did not return an insertion bin");
          return ok({ bin: projectItemInfo(insertionBin) });

        case "get_project_panel_metadata":
          var panelMetadataItem = findItem(args.projectItemId || args.itemId || args.item_id || args.name) || firstMediaItem() || (app.project ? app.project.rootItem : null);
          if (!panelMetadataItem) return fail("Project item not found");
          if (!panelMetadataItem.getProjectMetadata) return fail("getProjectMetadata is unavailable on this item");
          return ok({ item: projectItemInfo(panelMetadataItem), metadata: panelMetadataItem.getProjectMetadata() });

        case "get_xmp_metadata":
          var xmpItem = findItem(args.projectItemId || args.itemId || args.item_id || args.name) || firstMediaItem();
          if (!xmpItem) return fail("Project item not found");
          if (!xmpItem.getXMPMetadata) return fail("getXMPMetadata is unavailable on this item");
          return ok({ item: projectItemInfo(xmpItem), metadata: xmpItem.getXMPMetadata() });

        case "get_color_space":
          var colorItem = findItem(args.projectItemId || args.itemId || args.item_id || args.name) || firstMediaItem();
          if (!colorItem) return fail("Project item not found");
          var colorSpaceResult = tryCall(colorItem, ["getOverrideColorSpace", "getColorSpace"], []);
          var colorSpaceList = null;
          try { if (colorItem.getOverrideColorSpaceList) colorSpaceList = colorItem.getOverrideColorSpaceList(); } catch (colorListError) {}
          if (!colorSpaceResult.called && colorSpaceList === null) return fail(colorSpaceResult.error, { item: colorItem.name });
          return ok({ item: projectItemInfo(colorItem), colorSpace: colorSpaceResult.called ? colorSpaceResult.result : null, overrideColorSpaceList: colorSpaceList });

        case "get_graphics_white_luminance":
          if (!app.project || !app.project.getGraphicsWhiteLuminance) return fail("app.project.getGraphicsWhiteLuminance is unavailable");
          return ok({ value: app.project.getGraphicsWhiteLuminance() });

        case "is_work_area_enabled":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var workSeq = targetSequence();
          if (!workSeq) return fail("No active sequence");
          var workAreaEnabled = null;
          try { if (workSeq.isWorkAreaEnabled) workAreaEnabled = Boolean(workSeq.isWorkAreaEnabled()); } catch (workEnabledError) {}
          try { if (workAreaEnabled === null && typeof workSeq.workAreaEnabled !== "undefined") workAreaEnabled = Boolean(workSeq.workAreaEnabled); } catch (workPropError) {}
          if (workAreaEnabled === null) return fail("Work area enabled state is unavailable on this sequence");
          return ok({ enabled: workAreaEnabled });

        case "get_timeline_gaps":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var gapSeq = targetSequence();
          if (!gapSeq) return fail("No active sequence");
          var gaps = [];
          for (var gt = 0; gt < gapSeq.videoTracks.numTracks; gt++) {
            var gapTrack = gapSeq.videoTracks[gt];
            var ranges = [];
            for (var gc = 0; gc < gapTrack.clips.numItems; gc++) ranges.push({ start: valueOfTime(gapTrack.clips[gc].start), end: valueOfTime(gapTrack.clips[gc].end) });
            ranges.sort(function(a, b) { return a.start - b.start; });
            var cursor = 0;
            for (var gr = 0; gr < ranges.length; gr++) {
              if (ranges[gr].start > cursor) gaps.push({ trackIndex: gt, start: cursor, end: ranges[gr].start, duration: ranges[gr].start - cursor });
              if (ranges[gr].end > cursor) cursor = ranges[gr].end;
            }
          }
          return ok({ count: gaps.length, gaps: gaps });

        case "get_project_scratch_disks":
          if (!app.project) return fail("No open project");
          var scratchTypes = args.types || ["FirstVideoCaptureFolder", "FirstAudioCaptureFolder", "FirstVideoPreviewFolder", "FirstAudioPreviewFolder", "FirstAutoSaveFolder", "FirstCCLibrariesFolder"];
          var scratchDisks = [];
          if (!app.project.getScratchDiskPath) {
            var projectFile = new File(app.project.path);
            var projectFolder = projectFile.parent ? projectFile.parent.fsName : "";
            for (var sdf = 0; sdf < scratchTypes.length; sdf++) scratchDisks.push({ type: scratchTypes[sdf], path: projectFolder, method: "project folder fallback" });
            return ok({ scratchDisks: scratchDisks, available: false, method: "project folder fallback" });
          }
          for (var sdi = 0; sdi < scratchTypes.length; sdi++) {
            try { scratchDisks.push({ type: scratchTypes[sdi], path: app.project.getScratchDiskPath(scratchTypes[sdi]) }); } catch (scratchError) { scratchDisks.push({ type: scratchTypes[sdi], error: scratchError.toString() }); }
          }
          return ok({ scratchDisks: scratchDisks });

        case "get_workspaces":
          var workspaces = app.getWorkspaces ? app.getWorkspaces() : [];
          var workspaceList = [];
          for (var wi = 0; wi < workspaces.length; wi++) workspaceList.push(workspaces[wi]);
          return ok({ workspaces: workspaceList, count: workspaceList.length });

        case "set_workspace":
          if (!app.setWorkspace) return fail("Workspace API unavailable");
          return ok({ workspace: args.name, result: app.setWorkspace(String(args.name)) });

        case "undo":
        case "redo":
          app.enableQE();
          if (!qe || !qe.project) return fail("QE project API unavailable");
          var historyMethod = toolName === "undo" ? "undo" : "redo";
          if (typeof qe.project[historyMethod] !== "function") return fail("qe.project." + historyMethod + " is unavailable");
          qe.project[historyMethod]();
          return ok({ performed: true, method: "qe.project." + historyMethod });

        case "multiple_undo":
          app.enableQE();
          if (!qe || !qe.project || typeof qe.project.undo !== "function") return fail("qe.project.undo is unavailable");
          var undoCount = Number(args.count || 1);
          var performedUndoCount = 0;
          for (var ui = 0; ui < undoCount; ui++) {
            qe.project.undo();
            performedUndoCount++;
          }
          return ok({ count: undoCount, performed: performedUndoCount, method: "qe.project.undo" });

        case "play_timeline":
        case "stop_playback":
          app.enableQE();
          if (toolName === "play_timeline") qe.startPlayback(); else qe.stopPlayback();
          return ok({ playback: toolName === "play_timeline" ? "playing" : "stopped" });

        case "get_source_monitor_info":
          var sourceItem = app.sourceMonitor && app.sourceMonitor.getProjectItem ? app.sourceMonitor.getProjectItem() : null;
          if (!sourceItem) return ok({ loaded: false });
          return ok({ loaded: true, nodeId: sourceItem.nodeId, name: sourceItem.name });

        case "open_in_source":
          var sourceOpenItem = findItem(args.item_id || args.itemId || args.projectItemId || args.name);
          if (!sourceOpenItem) return fail("Project item not found");
          app.sourceMonitor.openProjectItem(sourceOpenItem);
          return ok({ opened: true, item: sourceOpenItem.name, nodeId: sourceOpenItem.nodeId });

        case "close_source_monitor":
          app.sourceMonitor.closeClip();
          return ok({ closed: true });

        case "close_all_source_clips":
          app.sourceMonitor.closeAllClips();
          return ok({ closedAll: true });

        case "set_source_in_out":
        case "set_item_in_out":
          var inOutItem = toolName === "set_source_in_out" ? app.sourceMonitor.getProjectItem() : findItem(args.item_id || args.itemId || args.projectItemId);
          if (!inOutItem) return fail("Project item not found");
          if (typeof args.in_seconds !== "undefined" || typeof args.inPoint !== "undefined") inOutItem.setInPoint(secondsToTicks(args.in_seconds || args.inPoint), 4);
          if (typeof args.out_seconds !== "undefined" || typeof args.outPoint !== "undefined") inOutItem.setOutPoint(secondsToTicks(args.out_seconds || args.outPoint), 4);
          return ok({ item: inOutItem.name, inSet: typeof args.in_seconds !== "undefined" || typeof args.inPoint !== "undefined", outSet: typeof args.out_seconds !== "undefined" || typeof args.outPoint !== "undefined" });

        case "clear_item_in_out":
          var clearItem = findItem(args.item_id || args.itemId || args.projectItemId);
          if (!clearItem) return fail("Project item not found");
          try { clearItem.clearInPoint(); } catch (e) {}
          try { clearItem.clearOutPoint(); } catch (e) {}
          return ok({ cleared: true, item: clearItem.name });

        case "get_source_monitor_position":
          var sourcePos = app.sourceMonitor.getPosition();
          return ok({ seconds: sourcePos ? ticksToSeconds(sourcePos.ticks) : null, ticks: sourcePos ? sourcePos.ticks : null });

        case "play_source_monitor":
          app.sourceMonitor.play(Number(args.speed || 1));
          return ok({ playing: true, speed: Number(args.speed || 1) });

        case "insert_from_source":
        case "overwrite_from_source":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var editSeq = targetSequence();
          var editItem = app.sourceMonitor.getProjectItem();
          if (!editSeq || !editItem) return fail("Need active sequence and source monitor item");
          var editPos = editSeq.getPlayerPosition().ticks;
          if (toolName === "insert_from_source") editSeq.insertClip(editItem, editPos, Number(args.video_track_index || args.videoTrackIndex || 0), Number(args.audio_track_index || args.audioTrackIndex || 0));
          else editSeq.overwriteClip(editItem, editPos, Number(args.video_track_index || args.videoTrackIndex || 0), Number(args.audio_track_index || args.audioTrackIndex || 0));
          return ok({ edited: true, mode: toolName, item: editItem.name, atSeconds: ticksToSeconds(editPos) });

        case "select_all_clips":
          return setSelection(function() { return true; }, true, true);
        case "deselect_all_clips":
          return setSelection(function() { return true; }, false, true);
        case "select_clips_by_name":
          var nameQuery = String(args.name || args.query || "").toLowerCase();
          return setSelection(function(clip) { return String(clip.name || "").toLowerCase().indexOf(nameQuery) !== -1; }, true, Boolean(args.add_to_selection || args.addToSelection));
        case "select_clips_in_range":
          var start = Number(args.startTime || args.start || 0);
          var end = Number(args.endTime || args.end || 0);
          return setSelection(function(clip) { return valueOfTime(clip.start) < end && valueOfTime(clip.end) > start; }, true, Boolean(args.add_to_selection || args.addToSelection));
        case "select_disabled_clips":
          // TrackItem.isEnabled() does not exist on 26.x (ReferenceError), so the
          // old predicate always threw and selected nothing. Disabled state is the
          // 'disabled' boolean property (verified live).
          return setSelection(function(clip) { try { return clip.disabled === true; } catch (e) { return false; } }, true, Boolean(args.add_to_selection || args.addToSelection));
        case "set_clip_selection":
          return setSelection(function(clip) { return clip.nodeId === (args.clipId || args.node_id || args.nodeId); }, Boolean(args.selected !== false), true);

        case "get_target_tracks":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var targetSeq = targetSequence();
          if (!targetSeq) return fail("No active sequence");
          var videoTargets = [], audioTargets = [];
          for (var tv = 0; tv < targetSeq.videoTracks.numTracks; tv++) { try { if (targetSeq.videoTracks[tv].isTargeted()) videoTargets.push({ index: tv, name: targetSeq.videoTracks[tv].name }); } catch (e) {} }
          for (var ta = 0; ta < targetSeq.audioTracks.numTracks; ta++) { try { if (targetSeq.audioTracks[ta].isTargeted()) audioTargets.push({ index: ta, name: targetSeq.audioTracks[ta].name }); } catch (e) {} }
          return ok({ video: videoTargets, audio: audioTargets });

        case "set_target_track":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var targetTrackSeq = targetSequence();
          if (!targetTrackSeq) return fail("No active sequence");
          var targetCollection = String(args.track_type || args.trackType || "video") === "audio" ? targetTrackSeq.audioTracks : targetTrackSeq.videoTracks;
          var targetTrack = targetCollection[Number(args.track_index || args.trackIndex || 0)];
          if (!targetTrack || !targetTrack.setTargeted) return fail("Track targeting API unavailable");
          var wantTargeted = Boolean(args.targeted !== false);
          var wasTargeted = null; try { wasTargeted = Boolean(targetTrack.isTargeted()); } catch (eTgPre) {}
          targetTrack.setTargeted(wantTargeted, true);
          var gotTargeted = null; try { gotTargeted = targetTrack.isTargeted(); } catch (eTg) {}
          if (gotTargeted !== null && Boolean(gotTargeted) !== wantTargeted) return fail("Premiere did not change the track targeting.", { requested: wantTargeted, actual: Boolean(gotTargeted), before: wasTargeted, verified: true });
          if (gotTargeted === null) return ok({ targeted: wantTargeted, before: wasTargeted, verified: false, unverifiedReason: "setTargeted() did not throw, but isTargeted() is not readable on this build, so the targeting cannot be confirmed." });
          return ok({ targeted: wantTargeted, before: wasTargeted, changed: wasTargeted !== Boolean(gotTargeted), verified: true, verifiedBy: "Track.isTargeted() readback" });

        case "rename_track":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var renameSeq = targetSequence();
          if (!renameSeq) return fail("No active sequence");
          var renameTracks = String(args.track_type || args.trackType || "video") === "audio" ? renameSeq.audioTracks : renameSeq.videoTracks;
          var trackToRename = renameTracks[Number(args.track_index || args.trackIndex || 0)];
          if (!trackToRename) return fail("Track not found");
          var wantTrackName = String(args.name || args.newName);
          trackToRename.name = wantTrackName;
          if (String(trackToRename.name) !== wantTrackName) return fail("Premiere did not rename the track.", { requested: wantTrackName, actual: String(trackToRename.name) });
          return ok({ renamed: true, name: String(trackToRename.name), verified: true });

        case "get_track_info":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var infoSeq = targetSequence();
          if (!infoSeq) return fail("No active sequence");
          var trackType = String(args.track_type || args.trackType || "video");
          var trackIndex = Number(args.track_index || args.trackIndex || 0);
          var track = trackType === "audio" ? infoSeq.audioTracks[trackIndex] : infoSeq.videoTracks[trackIndex];
          if (!track) return fail("Track not found");
          return ok({ name: track.name, index: trackIndex, type: trackType, clipCount: track.clips.numItems });

        case "close_project":
          if (args.confirm !== true) return fail("close_project requires confirm:true so callers do not close the active project accidentally.");
          if (!app.project) return fail("No open project");
          var closeResult = tryCall(app.project, ["closeDocument", "close"], [Boolean(args.saveFirst || args.save)]);
          if (!closeResult.called) return fail(closeResult.error, { available: false });
          return ok({ closed: true, method: closeResult.method });

        case "delete_bin":
        case "delete_project_item":
          var deleteItem = findItem(args.binId || args.bin_id || args.projectItemId || args.itemId || args.item_id || args.name);
          if (!deleteItem) return fail("Project item not found");
          var deleteRes = deleteProjectItemRobust(deleteItem);
          if (!deleteRes.deleted) return fail(deleteRes.error || "Delete failed", { item: deleteRes.item, verified: deleteRes.verified === true, method: deleteRes.method });
          return ok({ deleted: true, verified: true, item: deleteRes.item, method: deleteRes.method });

        case "delete_multiple_project_items":
          var deleteIds = args.projectItemIds || args.itemIds || args.ids || [];
          var deleteResults = [];
          for (var di = 0; di < deleteIds.length; di++) {
            var itemToDelete = findItem(deleteIds[di]);
            if (!itemToDelete) {
              deleteResults.push({ id: deleteIds[di], ok: false, error: "Project item not found" });
              continue;
            }
            var oneDelete = deleteProjectItemRobust(itemToDelete);
            deleteResults.push({ id: deleteIds[di], name: oneDelete.item, ok: oneDelete.deleted, verified: oneDelete.verified === true, method: oneDelete.method || null, error: oneDelete.error || null });
          }
          var deletedCount = deleteResults.filter(function(result) { return result.ok; }).length;
          if (deletedCount === 0 && deleteIds.length > 0) return fail("No items were deleted", { results: deleteResults, deleted: 0 });
          return ok({ results: deleteResults, deleted: deletedCount, requested: deleteIds.length, allDeleted: deletedCount === deleteIds.length });

        case "rename_bin":
          var renameBin = findItem(args.binId || args.bin_id || args.itemId || args.name);
          if (!renameBin) return fail("Bin not found");
          var oldBinName = renameBin.name;
          renameBin.name = String(args.newName || args.new_name || args.name);
          return ok({ renamed: true, oldName: oldBinName, newName: renameBin.name });

        case "create_smart_bin":
          if (!app.project || !app.project.rootItem) return fail("No open project");
          var smartBinResult = tryCall(app.project.rootItem, ["createSmartBin", "createSearchBin"], [String(args.name || "Smart Bin"), String(args.query || args.search || "")]);
          if (!smartBinResult.called) return fail(smartBinResult.error, { available: false, note: "This Premiere build does not expose a scriptable smart-bin creation API." });
          return ok({ created: true, name: String(args.name || "Smart Bin"), method: smartBinResult.method });

        case "import_sequences":
          if (!args.projectPath && !args.path) return fail("import_sequences requires projectPath or path.");
          if (!app.project || !app.project.importSequences) return fail("app.project.importSequences is unavailable");
          var importSeqIds = args.sequenceIds || args.ids || [];
          var importSeqResult = app.project.importSequences(String(args.projectPath || args.path || ""), importSeqIds);
          return ok({ imported: true, projectPath: String(args.projectPath || args.path || ""), sequenceIds: importSeqIds, result: importSeqResult });

        case "start_batch_encode":
          if (args.confirm !== true) return fail("start_batch_encode requires confirm:true because it can launch or control Adobe Media Encoder.");
          if (!app.encoder || !app.encoder.startBatch) return fail("app.encoder.startBatch is unavailable");
          return ok({ started: true, result: app.encoder.startBatch() });

        case "encode_project_item":
        case "encode_file":
          if (!app.encoder) return fail("app.encoder is unavailable");
          var encodeMethod = toolName === "encode_file" ? "encodeFile" : "encodeProjectItem";
          if (typeof app.encoder[encodeMethod] !== "function") return fail("app.encoder." + encodeMethod + " is unavailable");
          var encodeTarget = toolName === "encode_file" ? String(args.filePath || args.path || "") : findItem(args.projectItemId || args.itemId || args.item_id);
          if (!encodeTarget) return fail("Encode target not found");
          var encodeJob = app.encoder[encodeMethod](encodeTarget, String(args.outputPath || args.output || ""), String(args.presetPath || args.preset || ""), Number(args.workArea || 0), args.removeOnCompletion === false ? 0 : 1);
          if (!encodeJob) return fail("Encoder did not return a job id");
          return ok({ queued: true, jobId: String(encodeJob), method: encodeMethod });

        case "create_bars_and_tone":
          if (!app.project) return fail("No open project");
          var barsResult = tryCall(app.project, ["createBarsAndTone", "createBarsAndToneItem"], [String(args.name || "Bars and Tone"), Number(args.width || 1920), Number(args.height || 1080), Number(args.frameRate || 30)]);
          if (!barsResult.called) return fail(barsResult.error, { available: false });
          return ok({ created: true, method: barsResult.method, result: barsResult.result });

        case "set_transcode_on_ingest":
          if (!app.project) return fail("No open project");
          var ingestTarget = app.project.ingestSettings || app.project;
          var ingestResult = tryCall(ingestTarget, ["setTranscodeOnIngest", "setIngestEnabled", "setEnableTranscodeOnIngest"], [Boolean(args.enabled !== false), String(args.presetPath || args.preset || "")]);
          if (!ingestResult.called) return fail(ingestResult.error, { available: false });
          return ok({ enabled: Boolean(args.enabled !== false), method: ingestResult.method });

        case "set_project_panel_metadata":
        case "add_custom_metadata_field":
        case "attach_custom_property":
        case "set_xmp_metadata":
          var metadataItem = findItem(args.projectItemId || args.itemId || args.item_id || args.name);
          if (!metadataItem && toolName !== "set_project_panel_metadata") return fail("Project item not found");
          var metadataTarget = metadataItem || app.project.rootItem;
          var metadataKey = String(args.key || args.field || args.name || "custom");
          var metadataValue = String(args.value || args.metadata || "");
          if (toolName === "set_xmp_metadata" && metadataTarget.setXMPMetadata) {
            metadataTarget.setXMPMetadata(metadataValue);
            return ok({ item: metadataTarget.name, xmpMetadataSet: true });
          }
          if (!metadataTarget.setProjectMetadata) return fail("setProjectMetadata is unavailable on this item");
          var metadataSchema = String(args.schema || "http://ns.adobe.com/premierePrivateProjectMetaData/1.0/");
          metadataTarget.setProjectMetadata(metadataValue, [metadataSchema + metadataKey]);
          return ok({ item: metadataTarget.name, key: metadataKey, value: metadataValue });

        case "set_graphics_white_luminance":
          if (app.project && app.project.setGraphicsWhiteLuminance) {
            app.project.setGraphicsWhiteLuminance(Number(args.value || args.luminance || 203));
            return ok({ value: Number(args.value || args.luminance || 203) });
          }
          return fail("app.project.setGraphicsWhiteLuminance is unavailable");

        case "set_scratch_disk_path":
        case "set_project_scratch_disk":
          if (!app.project || !app.project.setScratchDiskPath) return fail("app.project.setScratchDiskPath is unavailable");
          var scratchType = String(args.type || args.scratchDiskType || "Video Preview");
          var scratchPath = String(args.path || args.directory || "");
          if (!scratchPath) return fail("No scratch disk path was supplied, so nothing was changed.");
          var scratchDir = new Folder(scratchPath);
          if (!scratchDir.exists) return fail("The scratch disk path does not exist: " + scratchPath + ". Premiere silently ignores a scratch path it cannot reach, so this refuses before writing rather than reporting a success it cannot prove.", { path: scratchPath });
          var scratchBefore = null; try { scratchBefore = String(app.project.getScratchDiskPath(scratchType)); } catch (eScrPre) {}
          app.project.setScratchDiskPath(scratchType, scratchPath);
          var scratchAfter = null; try { scratchAfter = String(app.project.getScratchDiskPath(scratchType)); } catch (eScrPost) {}
          if (scratchAfter === null) return ok({ type: scratchType, path: scratchPath, before: scratchBefore, verified: false, unverifiedReason: "setScratchDiskPath() did not throw, but getScratchDiskPath() is not readable on this build, so the path cannot be confirmed." });
          if (scratchAfter !== scratchPath) return fail("The scratch disk for " + scratchType + " still reads " + scratchAfter + " rather than the requested path.", { type: scratchType, requested: scratchPath, actual: scratchAfter, before: scratchBefore, verified: true });
          return ok({ type: scratchType, path: scratchPath, before: scratchBefore, changed: scratchBefore !== scratchAfter, verified: true, verifiedBy: "app.project.getScratchDiskPath() readback" });

        case "set_offline":
          var offlineItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!offlineItem) return fail("Project item not found");
          var offlineWas = null; try { offlineWas = Boolean(offlineItem.isOffline()); } catch (eOffPre) {}
          var offlineResult = tryCall(offlineItem, ["setOffline", "makeOffline"], []);
          if (!offlineResult.called) return fail(offlineResult.error, { available: false });
          var offlineNow = null; try { offlineNow = offlineItem.isOffline(); } catch (eOff) {}
          if (offlineNow !== null && Boolean(offlineNow) !== true) return fail("Premiere did not take '" + offlineItem.name + "' offline (still reads online).", { requested: true, actual: Boolean(offlineNow), before: offlineWas, verified: true });
          if (offlineNow === null) return ok({ offline: true, item: offlineItem.name, method: offlineResult.method, before: offlineWas, verified: false, unverifiedReason: "The offline call did not throw, but isOffline() is not readable for this item, so the offline state cannot be confirmed." });
          return ok({ offline: true, item: offlineItem.name, method: offlineResult.method, before: offlineWas, changed: offlineWas !== true, verified: true, verifiedBy: "ProjectItem.isOffline() readback", note: offlineWas === true ? "This item was already offline; nothing changed." : undefined });

        case "has_proxy":
          var proxyCheckItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!proxyCheckItem) return fail("Project item not found");
          if (proxyCheckItem.hasProxy) return ok({ hasProxy: Boolean(proxyCheckItem.hasProxy()) });
          return ok({ hasProxy: false, available: false, note: "hasProxy API unavailable on this item" });

        case "detach_proxy":
          var proxyItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!proxyItem) return fail("Project item not found");
          var proxyHadBefore = null; try { if (proxyItem.hasProxy) proxyHadBefore = Boolean(proxyItem.hasProxy()); } catch (eProxPre) {}
          var detachResult = tryCall(proxyItem, ["detachProxy", "clearProxy"], []);
          if (!detachResult.called && proxyItem.attachProxy) {
            try { proxyItem.attachProxy("", 0); detachResult = { called: true, method: "attachProxy(empty)" }; } catch (proxyError) { detachResult = { called: false, error: proxyError.toString() }; }
          }
          if (!detachResult.called) return fail(detachResult.error, { available: false });
          var proxyStillThere = null; try { if (proxyItem.hasProxy) proxyStillThere = proxyItem.hasProxy(); } catch (eProx) {}
          if (proxyStillThere === true) return fail("Premiere did not detach the proxy from '" + proxyItem.name + "' (still reports a proxy).", { hasProxy: true, before: proxyHadBefore, verified: true });
          if (proxyStillThere === null) return ok({ detached: true, item: proxyItem.name, method: detachResult.method, before: proxyHadBefore, verified: false, unverifiedReason: "The detach call did not throw, but hasProxy() is not available on this item, so the detach cannot be confirmed." });
          return ok({ detached: true, item: proxyItem.name, method: detachResult.method, before: proxyHadBefore, changed: proxyHadBefore === true, verified: true, verifiedBy: "ProjectItem.hasProxy() readback", note: proxyHadBefore === false ? "This item had no proxy attached, so there was nothing to detach." : undefined });

        case "set_override_frame_rate":
        case "set_override_pixel_aspect_ratio":
          var interpItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!interpItem) return fail("Project item not found");
          if (!interpItem.getFootageInterpretation || !interpItem.setFootageInterpretation) return fail("Footage interpretation API unavailable");
          var interp = interpItem.getFootageInterpretation();
          if (toolName === "set_override_frame_rate") interp.frameRate = Number(args.frameRate || args.value);
          else interp.pixelAspectRatio = Number(args.pixelAspectRatio || args.value);
          interpItem.setFootageInterpretation(interp);
          return ok({ item: interpItem.name, frameRate: interp.frameRate, pixelAspectRatio: interp.pixelAspectRatio });

        case "set_scale_to_frame_size":
          var scaleItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!scaleItem) return fail("Project item not found");
          var scaleResult = tryCall(scaleItem, ["setScaleToFrameSize"], [Boolean(args.enabled !== false)]);
          if (!scaleResult.called) return fail(scaleResult.error, { available: false });
          return ok({ item: scaleItem.name, enabled: Boolean(args.enabled !== false), method: scaleResult.method });

        case "select_item":
          var selectItem = findItem(args.projectItemId || args.itemId || args.item_id || args.name);
          if (!selectItem) return fail("Project item not found");
          var selectResult = tryCall(selectItem, ["select", "setSelected"], [1, 1]);
          if (!selectResult.called) return fail(selectResult.error, { available: false });
          return ok({ selected: true, item: selectItem.name, method: selectResult.method });

        case "set_start_time":
          var startItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!startItem) return fail("Project item not found");
          var startTicks = secondsToTicks(args.startTime || args.start || 0);
          var startResult = tryCall(startItem, ["setStartTime"], [startTicks]);
          if (!startResult.called) return fail(startResult.error, { available: false });
          return ok({ item: startItem.name, startSeconds: Number(args.startTime || args.start || 0) });

        case "create_sequence_from_preset":
          if (!app.project) return fail("No open project");
          if (!args.presetPath && !args.preset) return fail("create_sequence_from_preset requires a .sqpreset path so Premiere does not open the New Sequence dialog.", { blockedBeforePremiere: true });
          var presetSequence = null;
          var presetMethod = "newSequence";
          if (app.project.newSequence) {
            presetSequence = app.project.newSequence(String(args.name || "New Sequence"), String(args.presetPath || args.preset));
          } else {
            return fail("Premiere's non-interactive newSequence API is unavailable");
          }
          if (!presetSequence) return fail("Premiere did not return a sequence from newSequence");
          return ok({ created: true, name: presetSequence.name, sequenceId: presetSequence.sequenceID, method: presetMethod });

        case "get_export_file_extension":
          if (app.encoder && app.encoder.getExportFileExtension) return ok({ extension: app.encoder.getExportFileExtension(String(args.presetPath || args.preset || "")), method: "app.encoder.getExportFileExtension" });
          var extensionPreset = String(args.presetPath || args.preset || "").toLowerCase();
          var extension = "mp4";
          if (extensionPreset.indexOf("wave") !== -1 || extensionPreset.indexOf("wav") !== -1) extension = "wav";
          else if (extensionPreset.indexOf("aiff") !== -1) extension = "aif";
          else if (extensionPreset.indexOf("mp3") !== -1) extension = "mp3";
          else if (extensionPreset.indexOf("hdv") !== -1 || extensionPreset.indexOf("m2t") !== -1) extension = "m2t";
          return ok({ extension: extension, method: "presetPathFallback", presetPath: String(args.presetPath || args.preset || "") });

        case "remove_effect":
        case "remove_effect_by_name":
          var removeEffectName = args.effectName || args.name;
          if (!removeEffectName) return fail(toolName + " requires effectName.");
          var removeEffectNodeId = args.clipId || args.node_id || args.nodeId;
          var removeEffectClip = findClip(removeEffectNodeId);
          if (!removeEffectClip) return fail(pendingSequenceError || "Clip not found");
          // DOM effect components expose no remove()/delete() method (reflect.methods is
          // empty), so the only real removal path is QE removeEffects(). That call is
          // all-or-nothing: it strips every user-added effect at once while preserving the
          // intrinsic Motion/Opacity/Volume and any Lumetri Color. Surgical single-effect
          // removal is therefore only honest when the target is the SOLE removable effect.
          // (reIsIntrinsic/reIsLumetri/reSnapshot are declared with the other top-level
          // helpers, because ExtendScript does not assign a function declared inside a
          // case block unless that case actually executes -- so remove_all_effects, a
          // different case, could not see them if they lived here.)
          var effectToRemove = findComponent(removeEffectClip.clip, removeEffectName);
          if (!effectToRemove) return ok({ removed: true, changed: false, effect: removeEffectName, note: "Effect was already absent from clip" });
          if (reIsIntrinsic(effectToRemove.component)) return fail("'" + String(effectToRemove.component.displayName) + "' is an intrinsic component (Motion/Opacity/Volume/Pan) and cannot be removed.", { effect: removeEffectName, intrinsic: true });
          if (reIsLumetri(effectToRemove.component)) return fail("'" + String(effectToRemove.component.displayName) + "' is a Lumetri Color component; QE removeEffects() preserves Lumetri, so it cannot be removed through this API.", { effect: removeEffectName, lumetri: true });
          var reRemovableOthers = [];
          for (var rei = 0; rei < removeEffectClip.clip.components.numItems; rei++) {
            var reComp = removeEffectClip.clip.components[rei];
            if (rei === effectToRemove.index) continue;
            if (reIsIntrinsic(reComp) || reIsLumetri(reComp)) continue;
            reRemovableOthers.push(String(reComp.displayName));
          }
          if (reRemovableOthers.length) return fail("Cannot surgically remove '" + String(effectToRemove.component.displayName) + "': the only removal API (QE removeEffects) strips ALL user effects at once, and this clip has " + reRemovableOthers.length + " other user effect(s) that would also be removed. Use remove_all_effects to clear them all, or leave them in place.", { effect: removeEffectName, otherUserEffects: reRemovableOthers, allOrNothing: true });
          var reQeClip = qeClipForClip(removeEffectClip);
          if (!reQeClip || !reQeClip.removeEffects) return fail("Could not address this clip through the QE API to remove effects.", { effect: removeEffectName });
          var reTargetMatch = String(effectToRemove.component.matchName);
          try { reQeClip.removeEffects(); } catch (reErr) { return fail("QE removeEffects() threw: " + reErr.toString(), { effect: removeEffectName }); }
          var reAfterClip = findClip(removeEffectNodeId);
          var reAfter = reAfterClip ? reSnapshot(reAfterClip.clip) : [];
          var reStillPresent = false;
          for (var rej = 0; rej < reAfter.length; rej++) if (reAfter[rej] === reTargetMatch) { reStillPresent = true; break; }
          if (reStillPresent) return fail("removeEffects() ran but '" + String(effectToRemove.component.displayName) + "' is still on the clip.", { effect: removeEffectName, verified: false });
          return ok({ removed: true, changed: true, effect: removeEffectName, matchName: reTargetMatch, method: "qe.removeEffects", verified: true });

        case "ripple_delete":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail("ripple_delete requires clipId.");
          var rippleClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!rippleClip) return fail(pendingSequenceError || "Clip not found");
          var rippleBeforeCount = rippleClip.track.clips.numItems;
          rippleClip.clip.remove(true, true);
          var rippleAfterCount = rippleClip.track.clips.numItems;
          if (rippleAfterCount >= rippleBeforeCount) return fail("Premiere did not remove the clip (track clip count unchanged).", { beforeCount: rippleBeforeCount, afterCount: rippleAfterCount });
          return ok({ removed: true, ripple: true, verified: true, clipId: args.clipId || args.node_id || args.nodeId, beforeCount: rippleBeforeCount, afterCount: rippleAfterCount });

        case "roll_edit":
        case "slide_edit":
        case "slip_edit":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail(toolName + " requires clipId.");
          var trimClipInfo = findClip(args.clipId || args.node_id || args.nodeId);
          if (!trimClipInfo) return fail(pendingSequenceError || "Clip not found");
          var editDelta = Number(args.delta || args.deltaSeconds || args.amount || 0);
          if (toolName === "slip_edit") {
            trimClipInfo.clip.inPoint = secondsToTime(valueOfTime(trimClipInfo.clip.inPoint) + editDelta);
            trimClipInfo.clip.outPoint = secondsToTime(valueOfTime(trimClipInfo.clip.outPoint) + editDelta);
            return ok({ edited: true, mode: toolName, deltaSeconds: editDelta, clip: clipInfo(trimClipInfo.clip, trimClipInfo.trackType, trimClipInfo.trackIndex, trimClipInfo.clipIndex) });
          }
          if (toolName === "slide_edit") {
            trimClipInfo.clip.move(editDelta);
            return ok({ edited: true, mode: toolName, deltaSeconds: editDelta, clip: clipInfo(trimClipInfo.clip, trimClipInfo.trackType, trimClipInfo.trackIndex, trimClipInfo.clipIndex) });
          }
          var adjacentIndex = trimClipInfo.clipIndex > 0 ? trimClipInfo.clipIndex - 1 : trimClipInfo.clipIndex + 1;
          if (adjacentIndex < 0 || adjacentIndex >= trimClipInfo.track.clips.numItems) return fail("roll_edit requires an adjacent clip on the same track");
          var adjacentClip = trimClipInfo.track.clips[adjacentIndex];
          var beforeRoll = { clipStart: valueOfTime(trimClipInfo.clip.start), clipInPoint: valueOfTime(trimClipInfo.clip.inPoint), adjacentEnd: valueOfTime(adjacentClip.end) };
          if (adjacentIndex < trimClipInfo.clipIndex) {
            adjacentClip.end = secondsToTime(valueOfTime(adjacentClip.end) + editDelta);
            trimClipInfo.clip.start = secondsToTime(valueOfTime(trimClipInfo.clip.start) + editDelta);
            trimClipInfo.clip.inPoint = secondsToTime(valueOfTime(trimClipInfo.clip.inPoint) + editDelta);
          } else {
            trimClipInfo.clip.end = secondsToTime(valueOfTime(trimClipInfo.clip.end) + editDelta);
            adjacentClip.start = secondsToTime(valueOfTime(adjacentClip.start) + editDelta);
            adjacentClip.inPoint = secondsToTime(valueOfTime(adjacentClip.inPoint) + editDelta);
          }
          var afterRoll = { clipStart: valueOfTime(trimClipInfo.clip.start), clipInPoint: valueOfTime(trimClipInfo.clip.inPoint), adjacentEnd: valueOfTime(adjacentClip.end) };
          return ok({ edited: true, mode: toolName, deltaSeconds: editDelta, before: beforeRoll, after: afterRoll, clip: clipInfo(trimClipInfo.clip, trimClipInfo.trackType, trimClipInfo.trackIndex, trimClipInfo.clipIndex) });

        case "move_clip_to_track":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail("move_clip_to_track requires clipId.");
          var moveTrackClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!moveTrackClip) return fail(pendingSequenceError || "Clip not found");
          var moveTargetIndex = Number(args.trackIndex || args.newTrackIndex || 0);
          if (moveTrackClip.trackType === "video" && moveTargetIndex >= moveTrackClip.sequence.videoTracks.numTracks) return fail("Target video track out of range");
          if (moveTrackClip.trackType === "audio" && moveTargetIndex >= moveTrackClip.sequence.audioTracks.numTracks) return fail("Target audio track out of range");
          if (moveTargetIndex === moveTrackClip.trackIndex) {
            return ok({ moved: true, changed: false, trackIndex: moveTargetIndex, method: "already on requested track", clipId: moveTrackClip.clip.nodeId });
          }
          var moveItem = moveTrackClip.clip.projectItem;
          if (!moveItem) return fail("Clip has no projectItem for move fallback");
          var allowOverwrite = Boolean(args.overwrite);
          var allowLossy = Boolean(args.allowLossyMove);
          var moveSourceId = moveTrackClip.clip.nodeId;
          var moveStart = valueOfTime(moveTrackClip.clip.start);
          var moveEnd = valueOfTime(moveTrackClip.clip.end);
          var moveDur = moveEnd - moveStart;
          var moveIn = valueOfTime(moveTrackClip.clip.inPoint);
          var moveOut = valueOfTime(moveTrackClip.clip.outPoint);
          var moveDisabled = false;
          try { moveDisabled = Boolean(moveTrackClip.clip.disabled); } catch (eDis) {}
          var destTrack = moveTrackClip.trackType === "video" ? moveTrackClip.sequence.videoTracks[moveTargetIndex] : moveTrackClip.sequence.audioTracks[moveTargetIndex];
          var occupants = [];
          var moveLastEnd = 0;
          for (var oi = 0; oi < destTrack.clips.numItems; oi++) {
            var other = destTrack.clips[oi];
            if (other.nodeId === moveTrackClip.clip.nodeId) continue;
            var otherStart = valueOfTime(other.start);
            var otherEnd = valueOfTime(other.end);
            if (otherEnd > moveLastEnd) moveLastEnd = otherEnd;
            if (moveStart < otherEnd && otherStart < moveEnd) occupants.push(other);
          }
          if (occupants.length && !allowOverwrite) {
            return fail("Destination track is occupied at that time. Pass overwrite:true to replace the occupant, or pick another track/time.", {
              occupantId: occupants[0].nodeId,
              occupantName: occupants[0].name,
              occupantStart: valueOfTime(occupants[0].start),
              occupantEnd: valueOfTime(occupants[0].end)
            });
          }
          // What the fallback would drop: it lays down a FRESH clip from the
          // projectItem, so user effects (same notion as remove_all_effects, plus
          // Lumetri), keyframes on intrinsic components and speed do not carry over.
          var moveLost = [];
          var moveUserEffects = [];
          var moveKeyframed = [];
          try {
            for (var mci = 0; mci < moveTrackClip.clip.components.numItems; mci++) {
              var moveComp = moveTrackClip.clip.components[mci];
              // Channel Volume / Panner are audio intrinsics reIsIntrinsic does not name.
              var moveCompName = normalizeName(moveComp.displayName);
              var moveIntrinsic = reIsIntrinsic(moveComp) || moveCompName === "channelvolume" || moveCompName === "panner";
              if (!moveIntrinsic) { moveUserEffects.push(String(moveComp.displayName)); continue; }
              for (var mpi = 0; mpi < moveComp.properties.numItems; mpi++) {
                try { if (moveComp.properties[mpi].isTimeVarying()) moveKeyframed.push(String(moveComp.displayName) + "." + String(moveComp.properties[mpi].displayName)); } catch (eTv) {}
              }
            }
          } catch (eComps) {}
          if (moveUserEffects.length) moveLost.push("effects: " + moveUserEffects.join(", "));
          if (moveKeyframed.length) moveLost.push("keyframes on: " + moveKeyframed.join(", "));
          var moveSpeed = null;
          try { moveSpeed = Number(moveTrackClip.clip.getSpeed()); } catch (eSpd) {}
          if (moveSpeed !== null && !isNaN(moveSpeed) && Math.abs(moveSpeed - 1) > 0.0001) moveLost.push("speed " + Math.round(moveSpeed * 10000) / 100 + "%");
          // Always lost on the fallback, and not detectable from the DOM: static (non-keyframed)
          // Motion/Opacity/Volume/Pan values, clip markers and a renamed clip all come back at
          // their defaults on a fresh copy. So the fallback is never lossless, and never runs
          // without the caller's allowLossyMove.
          moveLost.push("static Motion/Opacity/Volume/Pan values, clip markers and clip name reset to defaults");
          // Native move only on an empty span: we cannot know a native move would
          // not land on top of occupants, so with occupants present go straight to
          // park/trim/slide, which clears them only right before the slide.
          var moveNativeName = null;
          if (!occupants.length) {
            if (typeof moveTrackClip.clip.moveToTrack === "function") moveNativeName = "moveToTrack";
            else if (typeof moveTrackClip.clip.setTrack === "function") moveNativeName = "setTrack";
          }
          var moveLossyRefusal = function () {
            return fail("move_clip_to_track would have to use its fallback, which re-creates the clip from its project item and drops: " + moveLost.join("; ") + ". Nothing was changed. Pass allowLossyMove:true to move it anyway without them.", { lost: moveLost, allowLossyMove: false });
          };
          // Refuse BEFORE any mutation when the fallback is the only route.
          if (!moveNativeName && moveLost.length && !allowLossy) return moveLossyRefusal();
          if (moveNativeName) {
            var nativeMove = tryCall(moveTrackClip.clip, [moveNativeName], [moveTargetIndex]);
            if (nativeMove.called) {
              // tryCall only says the method existed and did not throw. Read the
              // clip back: by nodeId, else by projectItem + start (id may change).
              var nativeFound = findClip(moveSourceId);
              if (nativeFound && nativeFound.clip.nodeId !== moveSourceId) nativeFound = null;
              if (!nativeFound) {
                // Without the id, only a match on the requested track counts: another
                // clip of the same item elsewhere is not proof of where ours went.
                for (var nci = 0; nci < destTrack.clips.numItems; nci++) {
                  var nativeCand = destTrack.clips[nci];
                  if (nativeCand && nativeCand.projectItem && nativeCand.projectItem.nodeId === moveItem.nodeId && Math.abs(valueOfTime(nativeCand.start) - moveStart) < 0.05) {
                    nativeFound = { clip: nativeCand, trackIndex: moveTargetIndex, trackType: moveTrackClip.trackType };
                    break;
                  }
                }
              }
              if (!nativeFound) {
                return ok({ moved: true, verified: false, unverifiedReason: nativeMove.method + "() did not throw, but the clip could not be found again by id or by project item at its start time, so the move cannot be confirmed.", trackIndex: moveTargetIndex, method: nativeMove.method, oldClipId: moveSourceId, clearedOccupants: 0 });
              }
              var nativeStart = valueOfTime(nativeFound.clip.start);
              if (nativeFound.trackType !== moveTrackClip.trackType || nativeFound.trackIndex !== moveTargetIndex || Math.abs(nativeStart - moveStart) > 0.05) {
                return fail(nativeMove.method + "() did not put the clip on the requested track at its original start; it was not moved back.", { requestedTrackType: moveTrackClip.trackType, requestedTrackIndex: moveTargetIndex, requestedStart: moveStart, actualTrackType: nativeFound.trackType, actualTrackIndex: nativeFound.trackIndex, actualStart: nativeStart, clipId: nativeFound.clip.nodeId });
              }
              return ok({ moved: true, verified: true, verifiedScope: "track, start", trackIndex: moveTargetIndex, method: nativeMove.method, start: nativeStart, clipId: nativeFound.clip.nodeId, oldClipId: moveSourceId, effectsCarriedOver: true, clearedOccupants: 0 });
            }
            // The native call threw: the fallback is next, so re-apply the refusal.
            if (moveLost.length && !allowLossy) return moveLossyRefusal();
          }
          // Fallback: overwriteClip lays the projectItem down at its OWN duration,
          // not the trimmed timeline length, so writing at the destination can
          // destroy a neighbour past [start, end). Park past the last clip on the
          // target track (guaranteed empty), restore the trim there, clear any
          // sanctioned occupants, slide into the verified span, and only then
          // lift the source. Occupants survive every failure before the slide.
          var moveParkTime = moveLastEnd + 1.0;
          var moveCleanupParked = function (parkedClip) {
            try {
              if (parkedClip) { parkedClip.remove(false, true); return; }
            } catch (eClean) {}
            for (var ci = destTrack.clips.numItems - 1; ci >= 0; ci--) {
              var leftover = destTrack.clips[ci];
              try { if (leftover && valueOfTime(leftover.start) > moveLastEnd + 0.5) leftover.remove(false, true); } catch (eSweep) {}
            }
          };
          destTrack.overwriteClip(moveItem, moveParkTime);
          var placed = null;
          for (var pi = 0; pi < destTrack.clips.numItems; pi++) {
            var candidate = destTrack.clips[pi];
            // By identity, not nearest start: a silent no-op must not hand back a bystander.
            if (candidate && candidate.projectItem && candidate.projectItem.nodeId === moveItem.nodeId && Math.abs(valueOfTime(candidate.start) - moveParkTime) < 0.2) { placed = candidate; break; }
          }
          if (!placed) {
            moveCleanupParked(null);
            return fail("Move fallback did not create a clip on the target track; the source clip and any destination occupants were left in place.", { clearedOccupants: 0 });
          }
          // Order the trim so inPoint never transiently exceeds outPoint.
          try {
            if (moveIn <= valueOfTime(placed.outPoint)) {
              placed.inPoint = secondsToTime(moveIn);
              placed.outPoint = secondsToTime(moveOut);
            } else {
              placed.outPoint = secondsToTime(moveOut);
              placed.inPoint = secondsToTime(moveIn);
            }
          } catch (eTrim) {}
          // In/out alone do not shrink the timeline clip; set duration relative to the PARKED start.
          try { placed.end = secondsToTime(valueOfTime(placed.start) + moveDur); } catch (eEnd) {}
          try { placed.disabled = moveDisabled; } catch (eEn) {}
          var trimRestored = Math.abs(valueOfTime(placed.inPoint) - moveIn) < 0.05 && Math.abs(valueOfTime(placed.outPoint) - moveOut) < 0.05 && Math.abs(valueOfTime(placed.end) - valueOfTime(placed.start) - moveDur) < 0.05;
          if (!trimRestored) {
            var placedIn = valueOfTime(placed.inPoint);
            var placedOut = valueOfTime(placed.outPoint);
            var placedDur = valueOfTime(placed.end) - valueOfTime(placed.start);
            moveCleanupParked(placed);
            return fail("Source trim could not be restored on the target track; the source clip and any destination occupants were left in place.", { requestedIn: moveIn, requestedOut: moveOut, requestedDuration: moveDur, actualIn: placedIn, actualOut: placedOut, actualDuration: placedDur, clearedOccupants: 0 });
          }
          // The parked copy is verified; only now clear the span overwrite:true
          // sanctioned. Lift (no ripple) so the destination track keeps its timing.
          if (occupants.length) {
            for (var ori = occupants.length - 1; ori >= 0; ori--) occupants[ori].remove(false, true);
          }
          placed.move(moveStart - valueOfTime(placed.start));
          if (Math.abs(valueOfTime(placed.start) - moveStart) > 0.05) {
            var placedStart = valueOfTime(placed.start);
            moveCleanupParked(placed);
            return fail("Clip could not be slid into the destination span; the source clip was left in place" + (occupants.length ? ", but " + occupants.length + " destination occupant(s) had already been cleared." : "."), { requestedStart: moveStart, actualStart: placedStart, clearedOccupants: occupants.length });
          }
          moveTrackClip.clip.remove(false, true);
          var moveWarnings = [];
          for (var mli = 0; mli < moveLost.length; mli++) moveWarnings.push("Not carried over (allowLossyMove): " + moveLost[mli]);
          return ok({ moved: true, verified: true, verifiedScope: "track, start, in/out, duration", trackIndex: moveTargetIndex, method: "park+trim+slide", start: moveStart, clipId: placed.nodeId, oldClipId: moveSourceId, trimRestored: true, effectsCarriedOver: false, warnings: moveWarnings, clearedOccupants: occupants.length });

        case "remove_all_effects":
          var removeAllNodeId = args.clipId || args.node_id || args.nodeId;
          if (!removeAllNodeId) return fail("remove_all_effects requires clipId.");
          var removeAllClip = findClip(removeAllNodeId);
          if (!removeAllClip) return fail(pendingSequenceError || "Clip not found");
          // Removal goes through QE removeEffects(), the only working path (DOM effect
          // components have no remove() method). It strips every user-added effect while
          // preserving intrinsic Motion/Opacity/Volume/Pan AND any Lumetri Color. We name
          // what will be removed vs. preserved up front, then diff to verify what actually
          // went, so Lumetri surviving is reported plainly rather than silently.
          var raWillRemove = [];
          var raPreservedLumetri = [];
          for (var rai = 0; rai < removeAllClip.clip.components.numItems; rai++) {
            var raComp = removeAllClip.clip.components[rai];
            if (reIsIntrinsic(raComp)) continue;
            if (reIsLumetri(raComp)) { raPreservedLumetri.push(String(raComp.displayName)); continue; }
            raWillRemove.push({ name: String(raComp.displayName), matchName: String(raComp.matchName) });
          }
          if (!raWillRemove.length) {
            return ok({ removed: [], changed: false, note: raPreservedLumetri.length ? "No removable user effects. Lumetri Color is preserved by the removal API and was left in place: " + raPreservedLumetri.join(", ") : "Clip has no user effects to remove.", preservedLumetri: raPreservedLumetri });
          }
          var raBefore = reSnapshot(removeAllClip.clip);
          var raQeClip = qeClipForClip(removeAllClip);
          if (!raQeClip || !raQeClip.removeEffects) return fail("Could not address this clip through the QE API to remove effects.");
          try { raQeClip.removeEffects(); } catch (raErr) { return fail("QE removeEffects() threw: " + raErr.toString()); }
          var raAfterClip = findClip(removeAllNodeId);
          var raAfter = raAfterClip ? reSnapshot(raAfterClip.clip) : [];
          var raAfterCounts = {};
          for (var rak = 0; rak < raAfter.length; rak++) raAfterCounts[raAfter[rak]] = (raAfterCounts[raAfter[rak]] || 0) + 1;
          var raRemoved = [];
          var raStillPresent = [];
          for (var ram = 0; ram < raWillRemove.length; ram++) {
            var raMatch = raWillRemove[ram].matchName;
            if (raAfterCounts[raMatch] > 0) { raAfterCounts[raMatch]--; raStillPresent.push(raWillRemove[ram].name); }
            else raRemoved.push(raWillRemove[ram].name);
          }
          if (raStillPresent.length) return fail("removeEffects() ran but " + raStillPresent.length + " effect(s) remain on the clip.", { removed: raRemoved, stillPresent: raStillPresent, verified: false });
          return ok({ removed: raRemoved, changed: raRemoved.length > 0, method: "qe.removeEffects", verified: true, preservedLumetri: raPreservedLumetri, note: raPreservedLumetri.length ? "Lumetri Color is preserved by the removal API and was left in place: " + raPreservedLumetri.join(", ") : undefined });

        case "set_clip_speed_qe":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail("set_clip_speed_qe requires clipId.");
          var speedClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!speedClip) return fail(pendingSequenceError || "Clip not found");
          var speedQeSeq = qeSequenceFor(speedClip.sequence);
          if (!speedQeSeq) return fail("Could not address sequence '" + speedClip.sequence.name + "' through the QE API.");
          var speedQeTrack = speedClip.trackType === "video" ? speedQeSeq.getVideoTrackAt(speedClip.trackIndex) : speedQeSeq.getAudioTrackAt(speedClip.trackIndex);
          if (!speedQeTrack) return fail("QE track not found at index " + speedClip.trackIndex);
          var speedQeClip = __findQeClipByDomClip(speedQeTrack, speedClip.clip);
          if (!speedQeClip || !speedQeClip.setSpeed) return fail("QE clip setSpeed API unavailable");
          // Accept either a ratio (<=10, e.g. 0.5 = 50%) or a percent (e.g. 50); QE
          // setSpeed wants a RATIO. Live-verified on 26.3.2 (2026-08-23): the signature
          // is setSpeed(rate, durationTimecodeString, reverse, maintainAudioPitch, ripple)
          // -- 5 args; fewer throw "Not Enough Parameters", and a bool where the duration
          // string belongs throws "Illegal Parameter type". Verify via the DOM clip's
          // getSpeed() (QE exposes no reliable speed getter), matching speed_change.
          var speedInput = Number(args.speed || args.percent || 100);
          var speedRatio = speedInput <= 10 ? speedInput : (speedInput / 100);
          var requestedPercent = speedRatio * 100;
          var speedOldRatio = null; try { speedOldRatio = Number(speedClip.clip.getSpeed()); } catch (eGsOld) {}
          try {
            speedQeClip.setSpeed(speedRatio, "00:00:00:00", Boolean(args.reverse), Boolean(args.maintainAudio !== false), false);
          } catch (speedSetError) {
            return fail("Speed change via QE DOM failed: " + speedSetError.toString(), { requestedPercent: requestedPercent, requestedRatio: speedRatio, oldSpeed: speedOldRatio });
          }
          // Verify-after-write via the DOM getSpeed() readback.
          var speedNewRatio = null; try { speedNewRatio = Number(speedClip.clip.getSpeed()); } catch (eGsNew) {}
          if (speedNewRatio === null || isNaN(speedNewRatio)) {
            return ok({ speed: requestedPercent, requestedRatio: speedRatio, maintainAudio: Boolean(args.maintainAudio !== false), changed: true, verified: false, note: "setSpeed did not throw but DOM getSpeed() was not readable to confirm." });
          }
          if (Math.abs(speedNewRatio - speedRatio) > 0.02) {
            return fail("Premiere did not apply the requested speed (clip is at " + (speedNewRatio * 100) + "%, requested " + requestedPercent + "%).", { actualPercent: speedNewRatio * 100, requestedPercent: requestedPercent, oldSpeed: speedOldRatio });
          }
          return ok({ speed: requestedPercent, actualPercent: speedNewRatio * 100, requestedRatio: speedRatio, oldSpeed: speedOldRatio, maintainAudio: Boolean(args.maintainAudio !== false), reverse: Boolean(args.reverse), changed: true, verified: true });

        case "set_frame_blend":
        case "set_time_interpolation":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail(toolName + " requires clipId.");
          var interpClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!interpClip) return fail(pendingSequenceError || "Clip not found");
          var interpQeClip = qeClipForClip(interpClip);
          if (!interpQeClip) return fail("QE clip not found");
          var interpMethod = "setFrameBlend";
          var interpValue = toolName === "set_frame_blend" ? Boolean(args.enabled !== false) : normalizeName(args.mode || args.interpolation || "") !== "framesampling";
          var interpBefore = { frameBlend: Boolean(interpQeClip.frameBlend), timeInterpolationType: Number(interpQeClip.timeInterpolationType) };
          var interpResult = tryCall(interpQeClip, [interpMethod], [interpValue]);
          if (!interpResult.called) return fail(interpResult.error, { available: false });
          var interpAfter = { frameBlend: Boolean(interpQeClip.frameBlend), timeInterpolationType: Number(interpQeClip.timeInterpolationType) };
          return ok({ method: interpResult.method, value: interpValue, before: interpBefore, after: interpAfter });

        case "overwrite_clip":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var overwriteSeq = targetSequence();
          var overwriteItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!overwriteSeq || !overwriteItem) return fail("Need sequence and project item");
          var owVideoIdx = Number(args.videoTrackIndex || args.video_track_index || args.trackIndex || 0);
          // Overwrite replaces whatever occupied the target span, so the clip count
          // can rise, stay flat (pure replace), or fall — a count diff is not a
          // reliable gate. Instead confirm the requested item now owns the clip that
          // covers the target time on the target track.
          var owTargetTime = Number(args.time || args.start || 0);
          var owTrack = owVideoIdx < overwriteSeq.videoTracks.numTracks ? overwriteSeq.videoTracks[owVideoIdx] : null;
          overwriteSeq.overwriteClip(overwriteItem, secondsToTicks(owTargetTime), owVideoIdx, Number(args.audioTrackIndex || args.audio_track_index || 0));
          var owPlaced = false;
          if (owTrack) {
            for (var owc = 0; owc < owTrack.clips.numItems; owc++) {
              var owClip = owTrack.clips[owc];
              if (valueOfTime(owClip.start) <= owTargetTime + 0.001 && valueOfTime(owClip.end) > owTargetTime - 0.001) {
                if (owClip.projectItem && String(owClip.projectItem.nodeId) === String(overwriteItem.nodeId)) owPlaced = true;
                break;
              }
            }
          }
          if (owTrack && !owPlaced) return fail("Premiere reported overwriteClip() but '" + overwriteItem.name + "' is not the clip covering " + owTargetTime + "s on the target track.", { verified: true });
          if (!owTrack) return ok({ overwritten: true, item: overwriteItem.name, time: owTargetTime, verified: false, unverifiedReason: "Video track " + owVideoIdx + " is outside this sequence's track count, so the placed clip could not be read back. overwriteClip() may have created the track, or done nothing." });
          return ok({ overwritten: true, item: overwriteItem.name, time: owTargetTime, verified: true, verifiedBy: "clip covering the target time compared by projectItem.nodeId" });

        case "create_sequence_from_clips":
          if (!app.project || !app.project.createNewSequenceFromClips) return fail("app.project.createNewSequenceFromClips is unavailable");
          var clipItemIds = args.projectItemIds || args.itemIds || args.ids || [];
          var clipItems = [];
          for (var csi = 0; csi < clipItemIds.length; csi++) {
            var seqClipItem = findItem(clipItemIds[csi]);
            if (seqClipItem) clipItems.push(seqClipItem);
          }
          if (!clipItems.length) return fail("No project items found for sequence creation");
          var sequenceFromClips = app.project.createNewSequenceFromClips(String(args.name || "Sequence from Clips"), clipItems, app.project.rootItem);
          if (!sequenceFromClips) return fail("Premiere did not return a created sequence");
          return ok({ created: true, name: sequenceFromClips.name, sequenceId: sequenceFromClips.sequenceID, itemCount: clipItems.length });

        case "close_sequence":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var closeSeq = targetSequence();
          if (!closeSeq) return fail("No sequence found");
          var closeSeqResult = tryCall(closeSeq, ["close"], []);
          if (!closeSeqResult.called) return fail(closeSeqResult.error, { available: false });
          return ok({ closed: true, sequenceId: closeSeq.sequenceID, sequenceName: closeSeq.name, method: closeSeqResult.method });

        case "export_as_project":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var exportProjectSeq = targetSequence();
          if (!exportProjectSeq) return fail("No sequence found");
          var exportProjectResult = tryCall(exportProjectSeq, ["exportAsProject"], [String(args.outputPath || args.path || "")]);
          if (!exportProjectResult.called) return fail(exportProjectResult.error, { available: false });
          return ok({ exported: true, outputPath: String(args.outputPath || args.path || ""), method: exportProjectResult.method });

        case "export_omf":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var omfSeq = targetSequence();
          if (!omfSeq) return fail("No sequence found");
          var omfPath = String(args.outputPath || args.path || "");
          var omfResult = tryCall(omfSeq, ["exportAsOMF", "exportOMF"], [omfPath]);
          if (!omfResult.called && app.project) omfResult = tryCall(app.project, ["exportOMF"], [omfSeq, omfPath]);
          if (!omfResult.called) return fail(omfResult.error, { available: false });
          return ok({ exported: true, outputPath: omfPath, method: omfResult.method });

        case "set_zero_point":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var zeroSeq = targetSequence();
          if (!zeroSeq) return fail("No sequence found");
          var zeroTicks = secondsToTicks(args.time || args.seconds || 0);
          var zeroBefore = null; try { zeroBefore = ticksToSeconds(zeroSeq.zeroPoint); } catch (eZeroPre) {}
          var zeroResult = tryCall(zeroSeq, ["setZeroPoint"], [zeroTicks]);
          if (!zeroResult.called) {
            try { zeroSeq.zeroPoint = zeroTicks; zeroResult = { called: true, method: "zeroPoint" }; } catch (zeroError) { zeroResult = { called: false, error: zeroError.toString() }; }
          }
          if (!zeroResult.called) return fail(zeroResult.error, { available: false });
          var zeroReadback = null; try { zeroReadback = ticksToSeconds(zeroSeq.zeroPoint); } catch (eZero) {}
          if (zeroReadback !== null && Math.abs(zeroReadback - Number(args.time || args.seconds || 0)) > 0.01) return fail("Premiere did not move the zero point (reads back as " + zeroReadback + "s, requested " + Number(args.time || args.seconds || 0) + "s).", { actual: zeroReadback, requested: Number(args.time || args.seconds || 0), before: zeroBefore, verified: true });
          if (zeroReadback === null) return ok({ zeroPointSeconds: Number(args.time || args.seconds || 0), method: zeroResult.method, before: zeroBefore, verified: false, unverifiedReason: "The zero-point write did not throw, but Sequence.zeroPoint is not readable on this build, so it cannot be confirmed." });
          return ok({ zeroPointSeconds: Number(args.time || args.seconds || 0), method: zeroResult.method, before: zeroBefore, changed: zeroBefore !== zeroReadback, verified: true, verifiedBy: "Sequence.zeroPoint readback", note: zeroBefore === zeroReadback ? "The zero point was already here; nothing changed." : undefined });

        case "scene_edit_detection":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var sceneSeq = targetSequence();
          if (!sceneSeq) return fail("No sequence found");
          if (!sceneSeq.performSceneEditDetectionOnSelection) return fail("performSceneEditDetectionOnSelection API unavailable");
          if (args.allowUnsafeSynchronous !== true) {
            return ok({
              performed: false,
              guarded: true,
              reason: "Premiere performSceneEditDetectionOnSelection blocks CEP in this bridge. Pass allowUnsafeSynchronous:true only when a human is prepared to wait or restart the panel.",
              action: String(args.action || "CreateMarkers"),
              sensitivity: String(args.sensitivity || "Medium")
            });
          }
          if (args.confirm !== true) return fail("scene_edit_detection requires confirm:true because it can add markers or cut the active sequence.");
          sceneSeq.performSceneEditDetectionOnSelection(String(args.action || "CreateMarkers"), Boolean(args.applyCutsToLinkedAudio !== false), String(args.sensitivity || "Medium"));
          return ok({ performed: true, action: String(args.action || "CreateMarkers"), sensitivity: String(args.sensitivity || "Medium") });

        case "delete_preview_files":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var previewSeq = targetSequence();
          if (!previewSeq) return fail("No sequence found");
          var previewResult = tryCall(previewSeq, ["deletePreviewFiles"], []);
          if (!previewResult.called) {
            try {
              app.enableQE();
              var qePreviewSeq = qeSequenceFor(previewSeq);
              previewResult = qePreviewSeq
                ? tryCall(qePreviewSeq, ["deletePreviewFiles"], [])
                : { called: false, error: "Could not address sequence '" + previewSeq.name + "' through the QE API." };
            } catch (qePreviewError) {
              previewResult = { called: false, error: qePreviewError.toString() };
            }
          }
          if (!previewResult.called) return fail(previewResult.error, { available: false });
          return ok({ deletedPreviewFiles: true, method: previewResult.method });

        case "set_color_value":
        case "set_effect_property":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail(toolName + " requires clipId.");
          var propertyClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!propertyClip) return fail(pendingSequenceError || "Clip not found");
          var propertyComponent = findComponent(propertyClip.clip, args.effectName || args.componentName || args.component || "Motion");
          if (!propertyComponent) return fail("Component/effect not found on clip");
          var propertyResult = setComponentProperty(propertyComponent.component, args.propertyName || args.property || args.name, args.value);
          if (!propertyResult.ok) return fail(propertyResult.error, { component: String(propertyComponent.component.displayName) });
          return ok({ component: String(propertyComponent.component.displayName), result: propertyResult });

        case "get_value_at_time":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail("get_value_at_time requires clipId.");
          var valueClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!valueClip) return fail(pendingSequenceError || "Clip not found");
          var valueComponent = findComponent(valueClip.clip, args.effectName || args.componentName || args.component || "Motion");
          if (!valueComponent) return fail("Component/effect not found on clip");
          var valuePropName = args.propertyName || args.property || args.name;
          var valueResult = getComponentProperty(valueComponent.component, valuePropName);
          if (valueResult.ok) return ok({ component: String(valueComponent.component.displayName), property: valueResult.property, value: valueResult.value });
          return fail(valueResult.error || "Property not found");

        case "remove_keyframe_range":
        case "set_keyframe_interpolation":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail(toolName + " requires clipId.");
          var keyClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!keyClip) return fail(pendingSequenceError || "Clip not found");
          var keyComponent = findComponent(keyClip.clip, args.effectName || args.componentName || args.component || "Motion");
          if (!keyComponent) return fail("Component/effect not found on clip");
          var keyProperty = findProperty(keyComponent.component, args.propertyName || args.property || args.name);
          if (!keyProperty) return fail("Property not found", { properties: componentProperties(keyComponent.component) });
          if (toolName === "remove_keyframe_range") {
            if (!keyProperty.removeKeyRange) return fail("removeKeyRange API unavailable on property");
            keyProperty.removeKeyRange(secondsToTime(args.startTime || args.start || 0), secondsToTime(args.endTime || args.end || 0), true);
            return ok({ removed: true, component: String(keyComponent.component.displayName), property: String(keyProperty.displayName), start: Number(args.startTime || args.start || 0), end: Number(args.endTime || args.end || 0) });
          }
          if (!keyProperty.addKey || !keyProperty.setInterpolationTypeAtKey) return fail("Keyframe interpolation APIs unavailable on property");
          var interpolationTime = secondsToTime(args.time || args.seconds || 0);
          try { keyProperty.setTimeVarying(true); } catch (varyError) {}
          try { keyProperty.addKey(interpolationTime); } catch (addKeyError) {}
          var interpolationValue = Number(args.interpolationType || args.type || 0);
          keyProperty.setInterpolationTypeAtKey(interpolationTime, interpolationValue, true);
          return ok({ interpolated: true, component: String(keyComponent.component.displayName), property: String(keyProperty.displayName), time: Number(args.time || args.seconds || 0), interpolationType: interpolationValue });

        case "select_clips_by_color":
          var labelValue = Number(args.colorIndex || args.label || args.value || 0);
          return setSelection(function(clip) { try { return Number(clip.projectItem.getColorLabel()) === labelValue; } catch (e) { return false; } }, true, Boolean(args.add_to_selection || args.addToSelection));

        case "invert_selection":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var invertSeq = targetSequence();
          if (!invertSeq) return fail("No active sequence");
          var inverted = [];
          var invertClips = allClips(invertSeq);
          for (var inv = 0; inv < invertClips.length; inv++) {
            var wasSelected = false;
            try { wasSelected = Boolean(invertClips[inv].clip.isSelected()); } catch (e) {}
            try { invertClips[inv].clip.setSelected(wasSelected ? 0 : 1, 1); inverted.push(clipInfo(invertClips[inv].clip, invertClips[inv].trackType, invertClips[inv].trackIndex, invertClips[inv].clipIndex)); } catch (invertError) {}
          }
          return ok({ inverted: inverted.length, clips: inverted });

        case "copy_effects_between_clips":
        case "copy_effect_values":
          // Resolved across sequences: the source and target legitimately live in
          // different sequences when an effect stack is being lifted off a
          // reference cut. Each side reports its own failure -- "Source or target
          // clip not found" for two valid ids was a dead end.
          var copySourceLookup = findClipAnySequence(
            args.sourceClipId || args.source_clip_id || args.clipId,
            args.sourceSequenceId || args.source_sequence_id || args.sequenceId || args.sequence_id,
            "Source");
          if (copySourceLookup.error) return fail(copySourceLookup.error);
          var copyTargetLookup = findClipAnySequence(
            args.targetClipId || args.target_clip_id || args.destinationClipId,
            args.targetSequenceId || args.target_sequence_id || args.sequenceId || args.sequence_id,
            "Target");
          if (copyTargetLookup.error) return fail(copyTargetLookup.error);
          var copySource = copySourceLookup.found;
          var copyTarget = copyTargetLookup.found;
          if (copySource.clip.nodeId === copyTarget.clip.nodeId && String(copySource.sequenceId) === String(copyTarget.sequenceId)) {
            return fail("Source and target are the same clip in the same sequence; nothing to copy.");
          }
          var copied = [];
          var copyComponentName = args.componentName || args.effectName || null;
          for (var cci = 0; cci < copySource.clip.components.numItems; cci++) {
            var sourceComp = copySource.clip.components[cci];
            if (copyComponentName && normalizeName(sourceComp.displayName) !== normalizeName(copyComponentName)) continue;
            var targetComp = findComponent(copyTarget.clip, sourceComp.displayName);
            if (!targetComp) continue;
            for (var cpi = 0; cpi < sourceComp.properties.numItems; cpi++) {
              var sourceProp = sourceComp.properties[cpi];
              var targetProp = findProperty(targetComp.component, sourceProp.displayName);
              if (!targetProp || !targetProp.setValue) continue;
              try {
                var sourceValue = sourceProp.getValue();
                targetProp.setValue(sourceValue, true);
                copied.push({ component: String(sourceComp.displayName), property: String(sourceProp.displayName) });
              } catch (copyError) {}
            }
          }
          if (!copied.length) return fail("No matching effect properties could be copied", {
            sourceSequence: copySource.sequenceName,
            targetSequence: copyTarget.sequenceName,
            sourceComponents: componentNames(copySource.clip),
            targetComponents: componentNames(copyTarget.clip)
          });
          return ok({
            copied: copied.length,
            properties: copied,
            sourceSequence: copySource.sequenceName,
            sourceSequenceId: copySource.sequenceId,
            targetSequence: copyTarget.sequenceName,
            targetSequenceId: copyTarget.sequenceId,
            crossSequence: String(copySource.sequenceId) !== String(copyTarget.sequenceId)
          });

        case "replace_clip_media":
          if (!args.projectItemId && !args.itemId && !args.item_id) return fail("replace_clip_media requires projectItemId or itemId.");
          var replaceItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!replaceItem) return fail("Project item not found");
          if (!replaceItem.canChangeMediaPath || !replaceItem.canChangeMediaPath()) return fail("Project item cannot change media path");
          replaceItem.changeMediaPath(String(args.newFilePath || args.filePath || args.path || ""), Boolean(args.overrideChecks !== false));
          return ok({ replaced: true, item: replaceItem.name, newFilePath: String(args.newFilePath || args.filePath || args.path || "") });

        case "batch_apply_effect":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var batchSeq = targetSequence();
          if (!batchSeq) return fail("No active sequence");
          app.enableQE();
          // Resolved once, outside the loop: qeSequenceFor() scans every QE
          // sequence, so doing it per clip made the tool O(clips x sequences),
          // and its failure is a property of the sequence rather than of any
          // one clip — returning from inside the per-clip catch abandoned the
          // whole batch instead of recording one clip's error and continuing.
          var qeBatchSeq = qeSequenceFor(batchSeq);
          if (!qeBatchSeq) return fail("Could not address sequence '" + batchSeq.name + "' through the QE API.");
          var batchClips = allClips(batchSeq);
          var batchResults = [];
          for (var bai = 0; bai < batchClips.length; bai++) {
            try {
              var qeBatchTrack = batchClips[bai].trackType === "video" ? qeBatchSeq.getVideoTrackAt(batchClips[bai].trackIndex) : qeBatchSeq.getAudioTrackAt(batchClips[bai].trackIndex);
              // Matched on start time, not DOM index: QE track items include gaps and
              // transitions, so an index addresses a different item whenever anything
              // precedes the target.
              var qeBatchClip = __findQeClipByDomClip(qeBatchTrack, batchClips[bai].clip);
              var batchEffect = batchClips[bai].trackType === "video" ? qe.project.getVideoEffectByName(String(args.effectName || args.name)) : qe.project.getAudioEffectByName(String(args.effectName || args.name));
              if (!batchEffect || !qeBatchClip) batchResults.push({ clipId: batchClips[bai].clip.nodeId, ok: false, error: "QE clip/effect unavailable" });
              else { qeBatchClip.addVideoEffect ? (batchClips[bai].trackType === "video" ? qeBatchClip.addVideoEffect(batchEffect) : qeBatchClip.addAudioEffect(batchEffect)) : qeBatchClip.addAudioEffect(batchEffect); batchResults.push({ clipId: batchClips[bai].clip.nodeId, ok: true }); }
            } catch (batchError) {
              batchResults.push({ clipId: batchClips[bai].clip.nodeId, ok: false, error: batchError.toString() });
            }
          }
          return ok({ effectName: String(args.effectName || args.name), results: batchResults });

        case "set_blend_mode":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail("set_blend_mode requires clipId.");
          var blendClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!blendClip) return fail(pendingSequenceError || "Clip not found");
          var opacityComponent = findComponent(blendClip.clip, "Opacity");
          if (!opacityComponent) return fail("Opacity component not found");
          var blendRequested = args.mode !== undefined ? args.mode : (args.blendMode !== undefined ? args.blendMode : args.value);
          // Blend Mode is a NUMERIC INDEX on this build, not a name. Measured on 26.3.2:
          // getValue() returns a number, setValue(1, true) round-trips to 1, and
          // setValue("Multiply", true) raises "Illegal Parameter type". Passing the name through
          // was the whole bug.
          //
          // Deliberately NOT mapping names to indices: the index order is not documented and I
          // could not verify a full name->index table against this host, so a guessed mapping
          // would silently apply the WRONG blend mode — worse than refusing. Report the current
          // index instead so a caller can find the one they want.
          var blendNumeric = (typeof blendRequested === "number") ? blendRequested : (String(blendRequested).match(/^[0-9]+$/) ? parseInt(blendRequested, 10) : null);
          var blendParam = null;
          var opProps = opacityComponent.component.properties;
          for (var bpi = 0; bpi < opProps.numItems; bpi++) {
            if (String(opProps[bpi].displayName) === "Blend Mode") { blendParam = opProps[bpi]; break; }
          }
          var blendCurrent = null;
          if (blendParam) { try { blendCurrent = blendParam.getValue(); } catch (eBlendRead) {} }
          if (blendNumeric === null) {
            return fail(
              // No quote characters in this message: expanded.ts is itself delivered as an
              // ExtendScript source string, so an escaped quote here emits a bare quote into the
              // generated script and terminates its string literal early. That turned a helpful
              // error into the generic evalScript failure.
              "Blend Mode is a numeric index on this build, not a name. Passing " + String(blendRequested) +
              " raises an Illegal Parameter type error from Premiere. Pass an integer, or its digits as a string. " +
              "This clip current Blend Mode index is " + String(blendCurrent) + ". " +
              "No name-to-index table is applied here: the ordering is undocumented, and an unverified guess would " +
              "silently set the wrong blend mode, which is worse than refusing.",
              { component: "Opacity", currentIndex: blendCurrent }
            );
          }
          var blendResult = setComponentProperty(opacityComponent.component, "Blend Mode", blendNumeric);
          if (!blendResult.ok) return fail(blendResult.error, { component: "Opacity", currentIndex: blendCurrent });
          var blendAfter = null;
          if (blendParam) { try { blendAfter = blendParam.getValue(); } catch (eBlendRead2) {} }
          if (blendAfter !== null && Number(blendAfter) !== Number(blendNumeric)) {
            return fail("Blend Mode was set to " + blendNumeric + " but reads back as " + blendAfter + ".",
              { component: "Opacity", requested: blendNumeric, actual: blendAfter });
          }
          return ok({ blendMode: blendNumeric, previousIndex: blendCurrent, actualIndex: blendAfter, verified: blendAfter !== null, result: blendResult });

        case "set_all_tracks_targeted":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var allTargetSeq = targetSequence();
          if (!allTargetSeq) return fail("No active sequence");
          var wantAllTargeted = Boolean(args.targeted !== false);
          var atMatched = 0, atMismatched = 0;
          for (var atv = 0; atv < allTargetSeq.videoTracks.numTracks; atv++) {
            try { allTargetSeq.videoTracks[atv].setTargeted(wantAllTargeted, true); } catch (e) {}
            try { if (Boolean(allTargetSeq.videoTracks[atv].isTargeted()) === wantAllTargeted) atMatched++; else atMismatched++; } catch (e) {}
          }
          for (var ata = 0; ata < allTargetSeq.audioTracks.numTracks; ata++) {
            try { allTargetSeq.audioTracks[ata].setTargeted(wantAllTargeted, true); } catch (e) {}
            try { if (Boolean(allTargetSeq.audioTracks[ata].isTargeted()) === wantAllTargeted) atMatched++; else atMismatched++; } catch (e) {}
          }
          if (atMatched === 0 && atMismatched > 0) return fail("Premiere did not change targeting on any track.", { requested: wantAllTargeted, mismatched: atMismatched, verified: true });
          var atTotal = allTargetSeq.videoTracks.numTracks + allTargetSeq.audioTracks.numTracks;
          if (atMatched + atMismatched === 0) return ok({ targeted: wantAllTargeted, matched: 0, mismatched: 0, videoTracks: allTargetSeq.videoTracks.numTracks, audioTracks: allTargetSeq.audioTracks.numTracks, verified: false, unverifiedReason: atTotal === 0 ? "This sequence has no tracks, so there was nothing to target." : "isTargeted() threw on every track, so the targeting cannot be confirmed on any of them." });
          if (atMismatched > 0) return fail("PARTIALLY APPLIED: " + atMatched + " of " + (atMatched + atMismatched) + " tracks now read as " + (wantAllTargeted ? "targeted" : "untargeted") + "; the rest are unchanged. A locked track keeps its targeting.", { requested: wantAllTargeted, matched: atMatched, mismatched: atMismatched, verified: true });
          return ok({ targeted: wantAllTargeted, matched: atMatched, mismatched: 0, videoTracks: allTargetSeq.videoTracks.numTracks, audioTracks: allTargetSeq.audioTracks.numTracks, verified: true, verifiedBy: "Track.isTargeted() readback on every track" });

        case "razor_all_tracks":
          app.enableQE();
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var razorSeq = targetSequence();
          if (!razorSeq) return fail("No active sequence");
          var razorFps = razorSeq.timebase ? (254016000000 / parseInt(razorSeq.timebase, 10)) : 30;
          var razorFrames = Math.round(Number(args.time || args.seconds || 0) * razorFps);
          function pad(n) { return n < 10 ? "0" + n : "" + n; }
          var razorTc = pad(Math.floor(razorFrames / (razorFps * 3600))) + ":" + pad(Math.floor((razorFrames % (razorFps * 3600)) / (razorFps * 60))) + ":" + pad(Math.floor((razorFrames % (razorFps * 60)) / razorFps)) + ":" + pad(Math.round(razorFrames % razorFps));
          var qeRazorSeq = qeSequenceFor(razorSeq);
          if (!qeRazorSeq) return fail("Could not address sequence '" + razorSeq.name + "' through the QE API.");
          function razorTotalClips() {
            var n = 0;
            for (var rvi = 0; rvi < razorSeq.videoTracks.numTracks; rvi++) n += razorSeq.videoTracks[rvi].clips.numItems;
            for (var rai = 0; rai < razorSeq.audioTracks.numTracks; rai++) n += razorSeq.audioTracks[rai].clips.numItems;
            return n;
          }
          var razorBeforeTotal = razorTotalClips();
          for (var rv = 0; rv < razorSeq.videoTracks.numTracks; rv++) qeRazorSeq.getVideoTrackAt(rv).razor(razorTc);
          for (var ra = 0; ra < razorSeq.audioTracks.numTracks; ra++) qeRazorSeq.getAudioTrackAt(ra).razor(razorTc);
          var razorAfterTotal = razorTotalClips();
          // A razor at a point crossed by clips splits them, so the total clip count
          // rises. If nothing was under the playhead the count is legitimately flat —
          // report that honestly rather than claiming a cut that did not happen.
          return ok({ razorTimecode: razorTc, seconds: Number(args.time || args.seconds || 0), beforeCount: razorBeforeTotal, afterCount: razorAfterTotal, cutsMade: razorAfterTotal - razorBeforeTotal, verified: razorAfterTotal > razorBeforeTotal, note: razorAfterTotal > razorBeforeTotal ? undefined : "No clips crossed the razor point; nothing was cut." });

        case "set_clip_start_time":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail("set_clip_start_time requires clipId.");
          var startClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!startClip) return fail(pendingSequenceError || "Clip not found");
          var wantStart = Number(args.time || args.start || 0);
          startClip.clip.start = secondsToTime(wantStart);
          var gotStart = valueOfTime(startClip.clip.start);
          if (Math.abs(gotStart - wantStart) > 0.02) return fail("Premiere did not move the clip start (reads back as " + gotStart + "s, requested " + wantStart + "s). Another clip may occupy the target position.", { actual: gotStart, requested: wantStart });
          return ok({ clipId: startClip.clip.nodeId, start: gotStart, verified: true });

        case "import_image_sequence":
          if (!app.project || !app.project.importFiles) return fail("app.project.importFiles is unavailable");
          var imageSeqImported = app.project.importFiles([String(args.firstFramePath || args.path || args.filePath || "")], Boolean(args.suppressUI !== false), app.project.rootItem, true);
          return ok({ imported: Boolean(imageSeqImported), path: String(args.firstFramePath || args.path || args.filePath || "") });

        case "set_clip_position":
        case "set_clip_scale":
        case "set_clip_rotation":
        case "set_clip_anchor_point":
        case "set_clip_opacity":
        case "set_clip_volume":
        case "set_clip_pan":
        case "set_anti_alias_quality":
        case "set_uniform_scale":
        case "set_scale_width_height":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail(toolName + " requires clipId.");
          var transformClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!transformClip) return fail(pendingSequenceError || "Clip not found");
          var componentName = (toolName === "set_clip_volume" || toolName === "set_clip_pan") ? "Volume" : "Motion";
          if (toolName === "set_clip_opacity") componentName = "Opacity";
          var transformComponent = findComponent(transformClip.clip, componentName);
          if (!transformComponent && toolName === "set_clip_volume") {
            var volumeQeClip = qeClipForClip(transformClip);
            if (!volumeQeClip || typeof volumeQeClip.staticClipGain === "undefined") return fail("Volume component not found and QE staticClipGain is unavailable");
            var volumeBefore = Number(volumeQeClip.staticClipGain);
            volumeQeClip.staticClipGain = Number(args.amount || args.volume || args.value || 0);
            return ok({ component: "QE", property: "staticClipGain", before: volumeBefore, after: Number(volumeQeClip.staticClipGain) });
          }
          if (!transformComponent && toolName === "set_clip_pan") {
            var requestedPan = Number(args.pan || args.value || 0);
            if (requestedPan === 0) return ok({ component: "QE", property: "pan", changed: false, value: 0, note: "No pan API is exposed; requested centered pan is already the neutral state." });
            return fail("Volume component not found and no pan API is exposed for this clip");
          }
          if (!transformComponent) return fail(componentName + " component not found");
          var transformMap = {
            set_clip_position: "Position",
            set_clip_scale: "Scale",
            set_clip_rotation: "Rotation",
            set_clip_anchor_point: "Anchor Point",
            set_clip_opacity: "Opacity",
            set_clip_volume: "Level",
            set_clip_pan: "Pan",
            set_anti_alias_quality: "Anti-flicker Filter",
            set_uniform_scale: "Uniform Scale",
            set_scale_width_height: String(args.property || "Scale")
          };
          var transformValue = typeof args.value !== "undefined" ? args.value : (typeof args.x !== "undefined" && typeof args.y !== "undefined" ? [Number(args.x), Number(args.y)] : Number(args.amount || args.scale || args.opacity || args.volume || args.rotation || 0));
          var transformSet = setComponentProperty(transformComponent.component, transformMap[toolName], transformValue);
          if (!transformSet.ok) return fail(transformSet.error, { component: componentName, property: transformMap[toolName] });
          return ok({ component: componentName, property: transformMap[toolName], result: transformSet });

        case "batch_rename_clips":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var renameSeqBatch = targetSequence();
          if (!renameSeqBatch) return fail("No active sequence");
          var renameClips = allClips(renameSeqBatch);
          var renamePrefix = String(args.prefix || args.namePrefix || "Clip");
          var renamedOk = 0, renamedFailed = 0;
          for (var br = 0; br < renameClips.length; br++) {
            var wantClipName = renamePrefix + " " + (br + 1);
            try { renameClips[br].clip.name = wantClipName; } catch (e) {}
            if (String(renameClips[br].clip.name) === wantClipName) renamedOk++; else renamedFailed++;
          }
          if (renamedOk === 0 && renameClips.length > 0) return fail("Premiere did not rename any clip.", { attempted: renameClips.length, prefix: renamePrefix });
          return ok({ renamed: renamedOk, failed: renamedFailed, attempted: renameClips.length, prefix: renamePrefix, verified: renamedFailed === 0 });

        case "batch_enable_disable":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var enableSeqBatch = targetSequence();
          if (!enableSeqBatch) return fail("No active sequence");
          var enableClips = allClips(enableSeqBatch);
          var enableValue = Boolean(args.enabled !== false);
          // TrackItem has no setEnabled() on 26.x -- enable state is the 'disabled'
          // boolean (verified live). setEnabled() threw for every clip and the caught
          // no-op was reported as success. Set 'disabled' and confirm the readback.
          var enabledOk = 0, enabledFailed = 0;
          for (var be = 0; be < enableClips.length; be++) {
            try { enableClips[be].clip.disabled = !enableValue; } catch (e) {}
            var stillEnabled = null; try { stillEnabled = !enableClips[be].clip.disabled; } catch (e) {}
            if (stillEnabled !== null && Boolean(stillEnabled) === enableValue) enabledOk++; else enabledFailed++;
          }
          if (enabledOk === 0 && enableClips.length > 0) return fail("Premiere did not change the enabled state of any clip.", { attempted: enableClips.length, enabled: enableValue });
          return ok({ changed: enabledOk, failed: enabledFailed, attempted: enableClips.length, enabled: enableValue, verified: enabledFailed === 0 });

        case "clear_sequence_in_out":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var clearSeq = targetSequence();
          if (!clearSeq) return fail("No sequence found");
          var clearSeqResult = tryCall(clearSeq, ["clearInPoint"], []);
          var clearOutResult = tryCall(clearSeq, ["clearOutPoint"], []);
          if (!clearSeqResult.called && clearSeq.setInPoint) {
            try { clearSeq.setInPoint(secondsToTicks(0)); clearSeqResult = { called: true, method: "setInPoint(0)" }; } catch (clearInError) { clearSeqResult = { called: false, error: clearInError.toString() }; }
          }
          if (!clearOutResult.called && clearSeq.setOutPoint) {
            try { clearSeq.setOutPoint(clearSeq.end && clearSeq.end.ticks ? clearSeq.end.ticks : secondsToTicks(0)); clearOutResult = { called: true, method: "setOutPoint(sequence.end)" }; } catch (clearOutError) { clearOutResult = { called: false, error: clearOutError.toString() }; }
          }
          if (!clearSeqResult.called && !clearOutResult.called) return fail("Sequence clear in/out APIs unavailable", { inPoint: clearSeqResult.error, outPoint: clearOutResult.error });
          return ok({ cleared: true, methods: [clearSeqResult.method || null, clearOutResult.method || null] });

        case "set_poster_frame":
          var posterItem = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!posterItem) return fail("Project item not found");
          var posterResult = tryCall(posterItem, ["setPosterFrame"], [secondsToTicks(args.time || args.seconds || 0)]);
          if (!posterResult.called) {
            var posterPath = "";
            try { posterPath = posterItem.getMediaPath ? String(posterItem.getMediaPath()) : ""; } catch (posterPathError) {}
            if (/\\.(png|jpg|jpeg|gif|tif|tiff)$/i.test(posterPath)) return ok({ item: posterItem.name, posterFrameSeconds: 0, changed: false, method: "still image poster frame" });
          }
          if (!posterResult.called) return fail(posterResult.error, { available: false });
          return ok({ item: posterItem.name, posterFrameSeconds: Number(args.time || args.seconds || 0) });

        case "move_items_to_bin":
          var moveIds = args.projectItemIds || args.itemIds || args.ids || [];
          var destBin = findItem(args.binId || args.bin_id || args.destinationBinId || args.destination || args.binName);
          if (!destBin) return fail("Destination bin not found");
          var moveResults = [];
          for (var mii = 0; mii < moveIds.length; mii++) {
            var itemToMove = findItem(moveIds[mii]);
            if (!itemToMove) moveResults.push({ id: moveIds[mii], ok: false, error: "Project item not found" });
            else {
              var oneMove = moveItemToBin(itemToMove, destBin);
              moveResults.push({ id: moveIds[mii], name: itemToMove.name, ok: oneMove.ok, method: oneMove.method || null, error: oneMove.error || null });
            }
          }
          return ok({ destination: destBin.name, results: moveResults });

        case "add_adjustment_layer":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var adjustmentSeq = targetSequence();
          if (!adjustmentSeq) return fail("No active sequence");
          var adjustmentResult = tryCall(app.project, ["createAdjustmentLayer"], [Number(args.width || adjustmentSeq.frameSizeHorizontal || 1920), Number(args.height || adjustmentSeq.frameSizeVertical || 1080), Number(args.duration || 5)]);
          if (!adjustmentResult.called) return fail(adjustmentResult.error, { available: false });
          return ok({ created: true, method: adjustmentResult.method, result: String(adjustmentResult.result) });

        case "freeze_frame":
          if (!args.clipId && !args.node_id && !args.nodeId) return fail("freeze_frame requires clipId.");
          var freezeClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!freezeClip) return fail(pendingSequenceError || "Clip not found");
          var freezeResult = tryCall(freezeClip.clip, ["setFrameHold", "freezeFrame"], [secondsToTicks(args.time || args.seconds || 0)]);
          if (!freezeResult.called) {
            var freezePath = "";
            try { freezePath = freezeClip.clip.projectItem && freezeClip.clip.projectItem.getMediaPath ? String(freezeClip.clip.projectItem.getMediaPath()) : ""; } catch (freezePathError) {}
            if (/\\.(png|jpg|jpeg|gif|tif|tiff)$/i.test(freezePath)) return ok({ frozen: true, changed: false, method: "still image already frozen", time: Number(args.time || args.seconds || 0) });
          }
          if (!freezeResult.called) return fail(freezeResult.error, { available: false });
          return ok({ frozen: true, method: freezeResult.method, time: Number(args.time || args.seconds || 0) });

        case "set_sequence_frame_rate":
        case "set_sequence_resolution":
        case "set_sequence_audio_settings":
        case "set_sequence_pixel_aspect_ratio":
        case "set_sequence_field_type":
        case "set_sequence_display_format":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var settingsSeq = targetSequence();
          if (!settingsSeq || !settingsSeq.getSettings || !settingsSeq.setSettings) return fail("Sequence settings API unavailable");
          var seqSettings = settingsSeq.getSettings();
          if (toolName === "set_sequence_pixel_aspect_ratio") {
            var requestedPar = Number(args.pixelAspectRatio || args.value || 1);
            try {
              app.enableQE();
              var qeParSeq = qeSequenceFor(settingsSeq);
              if (qeParSeq && Number(qeParSeq.par) === requestedPar) return ok({ sequenceId: settingsSeq.sequenceID, changed: false, par: Number(qeParSeq.par), method: "qe.par readback" });
            } catch (parReadError) {}
          }
          // Every tool in this family used to return the settings object it had just WRITTEN,
          // with no re-read — the textbook "verify against your own write". They now snapshot
          // the fields they touch before and after, and compare against Premiere.
          function settingsSnapshot(seq) {
            var snap = {};
            try {
              var g = seq.getSettings();
              if (!g) return snap;
              try { snap.videoFrameWidth = Number(g.videoFrameWidth); } catch (e1) {}
              try { snap.videoFrameHeight = Number(g.videoFrameHeight); } catch (e2) {}
              try { snap.videoFrameRateTicks = String(g.videoFrameRate.ticks !== undefined ? g.videoFrameRate.ticks : g.videoFrameRate); } catch (e3) {}
              try { snap.videoPixelAspectRatio = String(g.videoPixelAspectRatio); } catch (e4) {}
              try { snap.videoFieldType = g.videoFieldType === null || g.videoFieldType === undefined ? null : Number(g.videoFieldType); } catch (e5) {}
              try { snap.videoDisplayFormat = g.videoDisplayFormat === null || g.videoDisplayFormat === undefined ? null : Number(g.videoDisplayFormat); } catch (e6) {}
              try { snap.audioSampleRate = Number(g.audioSampleRate.ticks !== undefined ? g.audioSampleRate.ticks : g.audioSampleRate); } catch (e7) {}
              try { snap.audioChannelType = g.audioChannelType === null || g.audioChannelType === undefined ? null : Number(g.audioChannelType); } catch (e8) {}
            } catch (eSnap) {}
            return snap;
          }
          var settingsBefore = settingsSnapshot(settingsSeq);
          var settingsField = null, settingsExpected = null;

          if (toolName === "set_sequence_field_type") {
            // Two defects in one branch.
            //
            // 1. It assigned a STRING ("No Fields") to seqSettings.videoFieldType, which is a
            //    NUMERIC field on this API — hence the "Illegal Parameter type" the live sweep
            //    recorded. Same family as videoFrameRate (a ticks string) and
            //    videoPixelAspectRatio (an "N:M" string): each of these fields wants one exact
            //    type and rejects everything else.
            // 2. The early return above it treated the literal request "no fields" as an
            //    already-satisfied no-op WITHOUT comparing it to the sequence's actual field
            //    type, so asking for progressive on an interlaced sequence returned success
            //    with changed:false and left the sequence interlaced.
            //
            // A name-to-index table is deliberately NOT invented here: the ordering is
            // undocumented and an unverified mapping would silently set the WRONG field type,
            // which is worse than refusing. This mirrors set_blend_mode, which takes a numeric
            // index for the same reason.
            var rawField = args.fieldType !== undefined ? args.fieldType : args.value;
            if (rawField === undefined || rawField === null || String(rawField) === "") {
              return fail("set_sequence_field_type needs a numeric fieldType. This sequence currently reads " +
                String(settingsBefore.videoFieldType) + ".", { currentFieldType: settingsBefore.videoFieldType, expected: "integer" });
            }
            var fieldNumber = Number(rawField);
            if (!isFinite(fieldNumber) || String(rawField).replace(/^\\s+|\\s+$/g, "") === "" || fieldNumber !== Math.floor(fieldNumber)) {
              return fail("set_sequence_field_type takes a numeric field-type INDEX, not a name like " + String(rawField) +
                ". SequenceSettings.videoFieldType is a number on this API and a string raises Illegal Parameter type. " +
                "No name-to-index table is offered because the ordering is undocumented and an unverified guess would set the wrong field type silently. " +
                "This sequence currently reads " + String(settingsBefore.videoFieldType) + " — read a known-good sequence with get_sequence_settings or get_qe_sequence_props to find the index you want.",
                { currentFieldType: settingsBefore.videoFieldType, requested: String(rawField), expected: "integer" });
            }
            seqSettings.videoFieldType = fieldNumber;
            settingsField = "videoFieldType";
            settingsExpected = fieldNumber;
          }
          if (toolName === "set_sequence_frame_rate") {
            seqSettings.videoFrameRate = secondsToTicks(1 / Number(args.frameRate || args.value || 30));
            settingsField = "videoFrameRateTicks";
            settingsExpected = secondsToTicks(1 / Number(args.frameRate || args.value || 30));
          }
          if (toolName === "set_sequence_resolution") { seqSettings.videoFrameWidth = Number(args.width || 1920); seqSettings.videoFrameHeight = Number(args.height || 1080); }
          if (toolName === "set_sequence_audio_settings") { seqSettings.audioSampleRate = Number(args.sampleRate || 48000); seqSettings.audioChannelType = args.channelType || seqSettings.audioChannelType; }
          if (toolName === "set_sequence_pixel_aspect_ratio") {
            var parText = parRatioString(args.pixelAspectRatio !== undefined ? args.pixelAspectRatio : (args.value !== undefined ? args.value : 1));
            if (!parText) return fail("pixelAspectRatio must be a positive number or an 'N:M' ratio string.");
            seqSettings.videoPixelAspectRatio = parText;
            settingsField = "videoPixelAspectRatio";
            settingsExpected = parText;
          }
          if (toolName === "set_sequence_display_format") {
            var wantFormat = args.displayFormat !== undefined ? args.displayFormat : args.value;
            if (wantFormat === undefined || wantFormat === null || String(wantFormat) === "") return fail("set_sequence_display_format needs a numeric displayFormat. The sequence currently reads " + String(settingsBefore.videoDisplayFormat) + ".", { currentDisplayFormat: settingsBefore.videoDisplayFormat });
            var formatNumber = Number(wantFormat);
            if (!isFinite(formatNumber) || formatNumber !== Math.floor(formatNumber)) return fail("set_sequence_display_format takes a numeric display-format index, not " + String(wantFormat) + ". SequenceSettings.videoDisplayFormat is a number on this API.", { currentDisplayFormat: settingsBefore.videoDisplayFormat, requested: String(wantFormat) });
            seqSettings.videoDisplayFormat = formatNumber;
            settingsField = "videoDisplayFormat";
            settingsExpected = formatNumber;
          }
          var applyError = null;
          try { settingsSeq.setSettings(seqSettings); } catch (eApply) { applyError = eApply.toString(); }
          var settingsAfter = settingsSnapshot(settingsSeq);
          if (applyError) {
            return fail("Premiere rejected the sequence settings: " + applyError, { sequenceId: settingsSeq.sequenceID, before: settingsBefore, after: settingsAfter, verified: true });
          }
          if (settingsField === null) {
            // Multi-field tools (resolution, audio) have no single comparison key; hand back
            // both snapshots so the caller can see exactly what Premiere kept.
            return ok({ sequenceId: settingsSeq.sequenceID, before: settingsBefore, after: settingsAfter, settings: settingsAfter, verified: true, verifiedBy: "Sequence.getSettings() re-read after setSettings()" });
          }
          var settingsActual = settingsAfter[settingsField];
          if (settingsActual === null || settingsActual === undefined) {
            return ok({ sequenceId: settingsSeq.sequenceID, before: settingsBefore, after: settingsAfter, requested: settingsExpected, verified: false, unverifiedReason: "setSettings() did not throw, but " + settingsField + " is not readable back through getSettings() on this build, so the change cannot be confirmed." });
          }
          if (String(settingsActual) !== String(settingsExpected)) {
            return fail("setSettings() ran but " + settingsField + " reads back as " + String(settingsActual) + " instead of the requested " + String(settingsExpected) + ", so the sequence was not changed.", { sequenceId: settingsSeq.sequenceID, before: settingsBefore, after: settingsAfter, requested: settingsExpected, actual: settingsActual, verified: true });
          }
          return ok({ sequenceId: settingsSeq.sequenceID, before: settingsBefore, after: settingsAfter, settings: settingsAfter, requested: settingsExpected, changed: String(settingsBefore[settingsField]) !== String(settingsActual), verified: true, verifiedBy: "Sequence.getSettings() re-read after setSettings()", note: String(settingsBefore[settingsField]) === String(settingsActual) ? "The sequence already had this value; nothing changed." : undefined });

        case "add_marker_to_project_item":
          var markerItemTarget = findItem(args.projectItemId || args.itemId || args.item_id);
          if (!markerItemTarget || !markerItemTarget.getMarkers) return fail("Project item marker API unavailable");
          var itemMarkers = markerItemTarget.getMarkers();
          var itemMarker = itemMarkers.createMarker(Number(args.time || args.seconds || 0));
          itemMarker.name = String(args.name || "");
          itemMarker.comments = String(args.comment || args.comments || "");
          // Clip-marker colour was readable through get_clip_markers but not
          // writable here, so a caller could see a colour it had no way to set.
          // Resolve the same way the sequence-marker tools do, and refuse an
          // unrecognised value rather than silently leaving the default.
          var itemColorIndex = resolveMarkerColorIndex(args.color);
          if (itemColorIndex === "invalid") {
            return fail("Unrecognised marker colour: " + String(args.color) +
              ". Use a name (" + MARKER_COLOR_NAMES.join(", ") + ") or an index 0-7.");
          }
          if (itemColorIndex !== null) { itemMarker.setColorByIndex(itemColorIndex); }
          var appliedColor = markerColor(itemMarker);
          return ok({ markerId: itemMarker.guid, item: markerItemTarget.name, time: Number(args.time || args.seconds || 0), color: appliedColor.index, colorName: appliedColor.name });

        case "get_clip_markers":
        case "get_sequence_markers_by_type":
          var markers = markerCollectionForTool();
          if (!markers) return fail(pendingSequenceError || "Marker collection unavailable");
          var markerOutput = [];
          var marker = markers.getFirstMarker ? markers.getFirstMarker() : null;
          while (marker) {
            var markerType = "";
            try { markerType = String(marker.type); } catch (e) {}
            if (toolName === "get_clip_markers" || !args.type || markerType === String(args.type)) {
              var markerColorInfo = markerColor(marker);
              markerOutput.push({ id: marker.guid, name: marker.name, comments: marker.comments, type: markerType, start: valueOfTime(marker.start), end: valueOfTime(marker.end), color: markerColorInfo.index, colorName: markerColorInfo.name });
            }
            marker = markers.getNextMarker ? markers.getNextMarker(marker) : null;
          }
          return ok({ count: markerOutput.length, markers: markerOutput });

        case "get_next_edit_point":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var editPointSeq = targetSequence();
          if (!editPointSeq) return fail("No active sequence");
          var fromTime = Number(args.time || args.seconds || 0);
          var nextPoint = null;
          var editClips = allClips(editPointSeq);
          for (var nep = 0; nep < editClips.length; nep++) {
            var candidates = [valueOfTime(editClips[nep].clip.start), valueOfTime(editClips[nep].clip.end)];
            for (var nec = 0; nec < candidates.length; nec++) if (candidates[nec] > fromTime && (nextPoint === null || candidates[nec] < nextPoint)) nextPoint = candidates[nec];
          }
          return ok({ from: fromTime, nextEditPoint: nextPoint });

        case "move_playhead_to_edit":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var moveEditSeq = targetSequence();
          if (!moveEditSeq) return fail("No active sequence");
          var moveFrom = Number(args.time || args.seconds || 0);
          var moveNext = null;
          var moveClips = allClips(moveEditSeq);
          for (var mep = 0; mep < moveClips.length; mep++) {
            var moveCandidates = [valueOfTime(moveClips[mep].clip.start), valueOfTime(moveClips[mep].clip.end)];
            for (var mec = 0; mec < moveCandidates.length; mec++) if (moveCandidates[mec] > moveFrom && (moveNext === null || moveCandidates[mec] < moveNext)) moveNext = moveCandidates[mec];
          }
          if (moveNext === null) return fail("No next edit point found");
          moveEditSeq.setPlayerPosition(secondsToTicks(moveNext));
          return ok({ moved: true, seconds: moveNext });

        case "get_clip_adjustment_layer":
          var adjustmentClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!adjustmentClip) return fail(pendingSequenceError || "Clip not found");
          var isAdjustment = false;
          try { isAdjustment = Boolean(adjustmentClip.clip.projectItem && adjustmentClip.clip.projectItem.isAdjustmentLayer && adjustmentClip.clip.projectItem.isAdjustmentLayer()); } catch (e) {}
          return ok({ clipId: adjustmentClip.clip.nodeId, isAdjustmentLayer: isAdjustment });

        case "get_linked_items":
          var linkedClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!linkedClip) return fail(pendingSequenceError || "Clip not found");
          var linkedItemsResult = tryCall(linkedClip.clip, ["getLinkedItems"], []);
          if (!linkedItemsResult.called) return fail(linkedItemsResult.error, { available: false });
          return ok({ linkedItems: linkedItemsResult.result });

        case "get_mogrt_component":
          var mogrtClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!mogrtClip) return fail(pendingSequenceError || "Clip not found");
          var mogrtComponents = [];
          for (var mg = 0; mg < mogrtClip.clip.components.numItems; mg++) mogrtComponents.push({ name: String(mogrtClip.clip.components[mg].displayName), properties: componentProperties(mogrtClip.clip.components[mg]) });
          return ok({ components: mogrtComponents });

        case "capture_frame":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var frameSeq = targetSequence();
          if (!frameSeq) return fail("No active sequence");
          var framePath = String(args.outputPath || args.path || "");
          if (!framePath) return fail("capture_frame requires outputPath");
          if (frameSeq.openInTimeline) {
            try { frameSeq.openInTimeline(); } catch (frameOpenError) {}
          }
          app.enableQE();
          var qeFrameSeq = qeSequenceFor(frameSeq);
          if (!qeFrameSeq) return fail("Could not address sequence '" + frameSeq.name + "' through the QE API.");
          // Format -> QE method + extension, confirmed live. The method name is
          // case-sensitive, so the old "exportFrameTiff" silently failed every TIFF
          // capture; the real method is "exportFrameTIFF".
          var frameFormat = String(args.format || "png").toLowerCase();
          if (frameFormat === "jpeg") frameFormat = "jpg";
          else if (frameFormat === "tiff") frameFormat = "tif";
          else if (frameFormat === "targa") frameFormat = "tga";
          var frameMethod, frameExt, frameExts;
          if (frameFormat === "jpg") { frameMethod = "exportFrameJPEG"; frameExt = ".jpg"; frameExts = [".jpg", ".jpeg"]; }
          else if (frameFormat === "tif") { frameMethod = "exportFrameTIFF"; frameExt = ".tif"; frameExts = [".tif", ".tiff"]; }
          else if (frameFormat === "dpx") { frameMethod = "exportFrameDPX"; frameExt = ".dpx"; frameExts = [".dpx"]; }
          else if (frameFormat === "tga") { frameMethod = "exportFrameTarga"; frameExt = ".tga"; frameExts = [".tga", ".targa"]; }
          else { frameMethod = "exportFramePNG"; frameExt = ".png"; frameExts = [".png"]; }
          if (typeof qeFrameSeq[frameMethod] !== "function") return fail("Frame export method unavailable: " + frameMethod, { available: false });
          var frameSeconds = Number(args.time || args.seconds || 0);
          var frameTimeString = String(frameSeconds);
          var frameTicks = frameTimeString;
          try {
            var frameTime = new Time();
            frameTime.seconds = frameSeconds;
            frameTicks = frameTime.ticks;
          } catch (frameTimeError) {}
          // Premiere appends "." + ext to whatever path it is handed, so passing
          // "shot.png" wrote "shot.png.png" while the tool reported "shot.png" -- a
          // path with no file. Hand it the stem and let it add the extension back.
          var frameStem = framePath;
          for (var fex = 0; fex < frameExts.length; fex++) {
            var fexExt = frameExts[fex];
            if (framePath.length > fexExt.length && framePath.substring(framePath.length - fexExt.length).toLowerCase() === fexExt) {
              frameStem = framePath.substring(0, framePath.length - fexExt.length);
              break;
            }
          }
          var frameCandidates = [frameStem + frameExt];
          for (var fcx = 0; fcx < frameExts.length; fcx++) frameCandidates.push(frameStem + frameExts[fcx]);
          frameCandidates.push(framePath);
          // A non-throwing call is not proof of a write, so record disk state first and
          // compare stamp/length afterward rather than trusting the return.
          var frameBefore = [];
          for (var fbi = 0; fbi < frameCandidates.length; fbi++) {
            var fbState = { existed: false, stamp: 0, length: -1 };
            try { var fbProbe = new File(frameCandidates[fbi]); if (fbProbe.exists) { fbState.existed = true; fbState.stamp = fbProbe.modified ? fbProbe.modified.getTime() : 0; fbState.length = fbProbe.length; } } catch (fbErr) {}
            frameBefore.push(fbState);
          }
          function frameWritten(acceptUnchanged) {
            for (var fwi = 0; fwi < frameCandidates.length; fwi++) {
              try {
                var fwFile = new File(frameCandidates[fwi]);
                if (!fwFile.exists) continue;
                if (!frameBefore[fwi].existed) return frameCandidates[fwi];
                var fwStamp = fwFile.modified ? fwFile.modified.getTime() : 0;
                if (fwStamp !== frameBefore[fwi].stamp) return frameCandidates[fwi];
                if (fwFile.length !== frameBefore[fwi].length) return frameCandidates[fwi];
                if (acceptUnchanged) return frameCandidates[fwi];
              } catch (fwErr) {}
            }
            return null;
          }
          var frameExportError = null;
          function tryFrameExport(arg1, arg2) {
            try { qeFrameSeq[frameMethod](arg1, arg2); } catch (frameError) { frameExportError = frameError.toString(); return false; }
            return frameWritten(false) !== null;
          }
          var frameExported =
            tryFrameExport(frameTicks, frameStem) ||
            tryFrameExport(frameStem, frameTicks) ||
            tryFrameExport(frameTimeString, frameStem) ||
            tryFrameExport(frameStem, frameTimeString) ||
            tryFrameExport(frameSeconds, frameStem) ||
            tryFrameExport(frameStem, frameSeconds);
          var frameFinal = frameWritten(true);
          if (!frameExported && !frameFinal) return fail(frameExportError || "Frame export produced no file on disk", { verified: false });
          return ok({ exported: true, outputPath: frameFinal || (frameStem + frameExt), method: frameMethod, format: frameFormat, seconds: frameSeconds, verified: true });

        case "nest_clips":
          if (!app.project || !app.project.createNewSequenceFromClips) return commandByName("Nest...");
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var nestSeq = targetSequence();
          if (!nestSeq) return fail("No active sequence");
          var nestClipIds = args.clipIds || args.clip_ids || [];
          var nestItems = [];
          if (nestClipIds.length) {
            for (var nci = 0; nci < nestClipIds.length; nci++) {
              var nestClip = findClip(nestClipIds[nci]);
              if (nestClip && nestClip.clip.projectItem) nestItems.push(nestClip.clip.projectItem);
            }
          } else {
            var selectableClips = allClips(nestSeq);
            for (var sci = 0; sci < selectableClips.length; sci++) {
              var selectedForNest = false;
              try { selectedForNest = Boolean(selectableClips[sci].clip.isSelected()); } catch (nestSelectError) {}
              if (selectedForNest && selectableClips[sci].clip.projectItem) nestItems.push(selectableClips[sci].clip.projectItem);
            }
          }
          if (!nestItems.length) return fail("nest_clips requires clipIds or selected clips with project items");
          var nestedSequence = app.project.createNewSequenceFromClips(String(args.name || "Nested Sequence"), nestItems, app.project.rootItem);
          if (!nestedSequence) return fail("Premiere did not return a nested sequence");
          return ok({ nested: true, name: nestedSequence.name, sequenceId: nestedSequence.sequenceID, itemCount: nestItems.length, method: "createNewSequenceFromClips" });

        case "unnest_sequence":
          var unnestInfo = findClip(args.nestedSequenceClipId || args.clipId || args.nodeId || args.node_id);
          if (!unnestInfo) return fail("Nested sequence clip not found");
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var unnestParentSeq = targetSequence();
          if (!unnestParentSeq) return fail("No active parent sequence");
          var unnestClip = unnestInfo.clip;
          var unnestItem = unnestClip.projectItem;
          var unnestNestedSeq = null;
          if (unnestItem && typeof unnestItem.getSequence === "function") unnestNestedSeq = unnestItem.getSequence();
          if (!unnestNestedSeq && unnestItem && app.project && app.project.sequences) {
            for (var unsi = 0; unsi < app.project.sequences.numSequences; unsi++) {
              var unnestCandidateSeq = app.project.sequences[unsi];
              if (unnestCandidateSeq && unnestCandidateSeq.name === unnestItem.name) {
                unnestNestedSeq = unnestCandidateSeq;
                break;
              }
            }
          }
          if (!unnestNestedSeq) return fail("Project item did not return a nested sequence");
          function unnestSecondsOf(value) {
            if (value === undefined || value === null) return 0;
            if (typeof value === "number") return value;
            if (value.seconds !== undefined) return Number(value.seconds);
            if (value.ticks !== undefined) return Number(value.ticks) / 254016000000.0;
            return 0;
          }
          var unnestParentStart = unnestSecondsOf(unnestClip.start);
          var unnestPlaced = [];
          var unnestErrors = [];
          function unnestCopyTrackItems(trackCollection, parentCollection, parentBaseTrack, trackType) {
            if (!trackCollection || !parentCollection) return;
            for (var ut = 0; ut < trackCollection.numTracks; ut++) {
              var sourceTrack = trackCollection[ut];
              var targetTrackIndex = parentBaseTrack + ut;
              if (targetTrackIndex >= parentCollection.numTracks) {
                unnestErrors.push({ trackType: trackType, trackIndex: targetTrackIndex, error: "Parent track does not exist" });
                continue;
              }
              var targetTrack = parentCollection[targetTrackIndex];
              for (var uc = 0; uc < sourceTrack.clips.numItems; uc++) {
                var sourceClip = sourceTrack.clips[uc];
                if (!sourceClip || !sourceClip.projectItem) {
                  unnestErrors.push({ trackType: trackType, trackIndex: ut, clipIndex: uc, error: "Nested clip has no source project item" });
                  continue;
                }
                var targetTime = unnestParentStart + unnestSecondsOf(sourceClip.start);
                try {
                  targetTrack.overwriteClip(sourceClip.projectItem, targetTime);
                  unnestPlaced.push({
                    trackType: trackType,
                    sourceTrackIndex: ut,
                    targetTrackIndex: targetTrackIndex,
                    clipIndex: uc,
                    name: sourceClip.name,
                    time: targetTime
                  });
                } catch (unnestPlaceError) {
                  unnestErrors.push({ trackType: trackType, trackIndex: ut, clipIndex: uc, error: unnestPlaceError.toString() });
                }
              }
            }
          }
          unnestCopyTrackItems(unnestNestedSeq.videoTracks, unnestParentSeq.videoTracks, unnestInfo.trackIndex, "video");
          unnestCopyTrackItems(unnestNestedSeq.audioTracks, unnestParentSeq.audioTracks, 0, "audio");
          if (!unnestPlaced.length) return fail("No nested clips could be placed into the parent sequence", { errors: unnestErrors });
          unnestClip.remove(false, true);
          return ok({
            unnested: true,
            nestedSequenceClipId: args.nestedSequenceClipId || args.clipId || args.nodeId || args.node_id,
            nestedSequenceId: unnestNestedSeq.sequenceID,
            nestedSequenceName: unnestNestedSeq.name,
            placedCount: unnestPlaced.length,
            placed: unnestPlaced,
            errors: unnestErrors
          });

        case "consolidate_and_transfer":
          if (!app.project || !app.project.consolidateAndTranscode) return fail("app.project.consolidateAndTranscode is unavailable");
          var consolidateResult = app.project.consolidateAndTranscode(String(args.outputPath || args.path || ""), Boolean(args.transcode !== false));
          return ok({ completed: true, result: consolidateResult });

        case "add_tracks":
          app.enableQE();
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var addTracksSeq = targetSequence();
          if (!addTracksSeq) return fail("No active sequence");
          var beforeVideoTracks = addTracksSeq.videoTracks.numTracks;
          var beforeAudioTracks = addTracksSeq.audioTracks.numTracks;
          var addQeSeq = qeSequenceFor(addTracksSeq);
          if (!addQeSeq) return fail("Could not address sequence '" + addTracksSeq.name + "' through the QE API.");
          if (!addQeSeq.addTracks) return fail("QE addTracks API unavailable");
          var requestedVideoTracks = Number(args.videoTracks || args.videoTrackCount || 0);
          var requestedAudioTracks = Number(args.audioTracks || args.audioTrackCount || 0);
          if (requestedVideoTracks > 0) addQeSeq.addTracks(requestedVideoTracks, beforeVideoTracks, 0, 1, beforeAudioTracks, 0, 0);
          if (requestedAudioTracks > 0) addQeSeq.addTracks(0, addTracksSeq.videoTracks.numTracks, requestedAudioTracks, 1, beforeAudioTracks, 0, 0);
          var afterVideoTracks = addTracksSeq.videoTracks.numTracks;
          var afterAudioTracks = addTracksSeq.audioTracks.numTracks;
          if (afterVideoTracks < beforeVideoTracks + requestedVideoTracks || afterAudioTracks < beforeAudioTracks + requestedAudioTracks) {
            return fail("Premiere did not add the requested tracks", {
              requestedVideoTracks: requestedVideoTracks,
              requestedAudioTracks: requestedAudioTracks,
              beforeVideoTracks: beforeVideoTracks,
              afterVideoTracks: afterVideoTracks,
              beforeAudioTracks: beforeAudioTracks,
              afterAudioTracks: afterAudioTracks
            });
          }
          return ok({
            added: true,
            requestedVideoTracks: requestedVideoTracks,
            requestedAudioTracks: requestedAudioTracks,
            beforeVideoTracks: beforeVideoTracks,
            afterVideoTracks: afterVideoTracks,
            beforeAudioTracks: beforeAudioTracks,
            afterAudioTracks: afterAudioTracks
          });

        case "get_clip_at_playhead":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var playSeq = targetSequence();
          if (!playSeq) return fail("No active sequence");
          args.time = ticksToSeconds(playSeq.getPlayerPosition().ticks);
          var clipAt = findClip(null);
          return ok(clipAt ? clipInfo(clipAt.clip, clipAt.trackType, clipAt.trackIndex, clipAt.clipIndex) : null);

        case "get_full_clip_info":
        case "get_clip_speed":
        case "get_clip_links":
        case "list_clip_effects":
        case "get_effect_properties":
        case "get_qe_clip_info":
          var foundClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!foundClip) return fail(pendingSequenceError || "Clip not found");
          var fullClip = clipInfo(foundClip.clip, foundClip.trackType, foundClip.trackIndex, foundClip.clipIndex);
          fullClip.components = [];
          try {
            for (var compIndex = 0; compIndex < foundClip.clip.components.numItems; compIndex++) {
              var comp = foundClip.clip.components[compIndex];
              var compData = { name: comp.displayName, properties: [] };
              for (var propIndex = 0; propIndex < comp.properties.numItems; propIndex++) {
                var prop = comp.properties[propIndex];
                var propData = { name: prop.displayName };
                try { propData.value = prop.getValue(); } catch (e) {}
                compData.properties.push(propData);
              }
              fullClip.components.push(compData);
            }
          } catch (e) {}
          return ok(fullClip);

        case "rename_clip":
          var renameClip = findClip(args.clipId || args.node_id || args.nodeId);
          if (!renameClip) return fail(pendingSequenceError || "Clip not found");
          var wantRenameName = String(args.new_name || args.newName || args.name);
          renameClip.clip.name = wantRenameName;
          if (String(renameClip.clip.name) !== wantRenameName) return fail("Premiere did not rename the clip (reads back as '" + String(renameClip.clip.name) + "').", { requested: wantRenameName, actual: String(renameClip.clip.name) });
          return ok({ renamed: true, name: String(renameClip.clip.name), verified: true });

        case "remove_selected_clips":
        case "lift_selection":
        case "extract_selection":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var selectionSeq = targetSequence();
          if (!selectionSeq) return fail("No active sequence");
          if (typeof selectionSeq.getSelection !== "function") return fail("sequence.getSelection is unavailable");
          var selectedItems = selectionSeq.getSelection();
          var selectedCount = selectedItems && selectedItems.numItems !== undefined ? selectedItems.numItems : (selectedItems ? selectedItems.length || 0 : 0);
          if (!selectedCount) return fail("No selected clips");
          var rippleSelected = toolName === "extract_selection";
          function selectionTotalClips() {
            var n = 0;
            for (var stv = 0; stv < selectionSeq.videoTracks.numTracks; stv++) n += selectionSeq.videoTracks[stv].clips.numItems;
            for (var sta = 0; sta < selectionSeq.audioTracks.numTracks; sta++) n += selectionSeq.audioTracks[sta].clips.numItems;
            return n;
          }
          var selBeforeTotal = selectionTotalClips();
          var removedSelected = 0;
          var selectedErrors = [];
          for (var si = selectedCount - 1; si >= 0; si--) {
            try {
              var selectedClip = selectedItems[si];
              if (!selectedClip && selectedItems.getItemAt) selectedClip = selectedItems.getItemAt(si);
              if (!selectedClip || typeof selectedClip.remove !== "function") {
                selectedErrors.push({ index: si, error: "Selected item is not a removable clip" });
                continue;
              }
              selectedClip.remove(rippleSelected, true);
              removedSelected++;
            } catch (selectedError) {
              selectedErrors.push({ index: si, error: selectedError.toString() });
            }
          }
          if (!removedSelected) return fail("No selected clips were removed", { selectedCount: selectedCount, errors: selectedErrors });
          var selAfterTotal = selectionTotalClips();
          // .remove() returns void and can no-op silently, so gate on the timeline
          // actually losing clips rather than on the loop counter alone.
          if (selAfterTotal >= selBeforeTotal) return fail("remove() ran but the timeline clip count did not drop.", { selectedCount: selectedCount, beforeCount: selBeforeTotal, afterCount: selAfterTotal, errors: selectedErrors });
          return ok({ removed: removedSelected, selectedCount: selectedCount, ripple: rippleSelected, beforeCount: selBeforeTotal, afterCount: selAfterTotal, verified: true, errors: selectedErrors });

        case "link_selection":
        case "unlink_selection":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var linkSeq = targetSequence();
          if (!linkSeq) return fail("No active sequence");
          var linkResult = tryCall(linkSeq, [toolName === "link_selection" ? "linkSelection" : "unlinkSelection"], []);
          if (!linkResult.called) return commandByName(toolName === "link_selection" ? "Link" : "Unlink");
          return ok({ linked: toolName === "link_selection", method: linkResult.method });

        case "match_frame":
          var seqErr = sequenceRequestError();
          if (seqErr) return fail(seqErr);
          var matchSeq = targetSequence();
          if (!matchSeq) return fail("No active sequence");
          var matchTime = matchSeq.getPlayerPosition ? ticksToSeconds(matchSeq.getPlayerPosition().ticks) : Number(args.time || args.seconds || 0);
          args.time = matchTime;
          var matchClip = findClip(null);
          if (!matchClip || !matchClip.clip.projectItem) return commandByName("Match Frame");
          if (app.sourceMonitor && app.sourceMonitor.openProjectItem) app.sourceMonitor.openProjectItem(matchClip.clip.projectItem);
          return ok({ matched: true, clipId: matchClip.clip.nodeId, item: matchClip.clip.projectItem.name, time: matchTime, method: "sourceMonitor.openProjectItem" });

        default:
          return fail("Expanded tool is advertised but has no implemented handler.", {
            accepted: false,
            name: toolName,
            args: args
          });
      }
    } catch (error) {
      return fail(error && error.message ? error.message : error, { name: toolName });
    }
  `;
}
