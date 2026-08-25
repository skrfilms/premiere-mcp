/**
 * Transactional editing: plan, snapshot, apply, verify each step, and on failure
 * roll the sequence back to the pre-edit state — or say loudly that we could not.
 *
 * Why this exists. An agent making a seven-step edit that fails at step four
 * leaves a project nobody asked for: a half-conformed sequence, an effect on the
 * wrong clip, a rough cut with two of five transitions. Every Premiere MCP in the
 * field (this one included, before now) reports the failure and walks away from
 * the mess. Premiere's own undo stack is not a remedy we can trust — it is
 * shallow, it is shared with the human sitting at the machine, and a save or a
 * crash empties it. So the remedy has to be ours: clone the sequence first, and
 * put the clone back if the plan does not finish.
 *
 * The honesty constraints that shape the whole design:
 *
 *   - A sequence clone restores exactly ONE sequence. It does not restore the
 *     project panel, imports, bin moves, files written to disk, relinks, or
 *     preferences. So this module CLASSIFIES every step before it starts and
 *     REFUSES to wrap what it cannot put back. See classifyTransactionTool.
 *   - "Verified" means a positive signal was obtained. A tool that returns no
 *     `verified` field and carries no read-back check is UNVERIFIABLE, and an
 *     unverifiable step is a failure by default, not a success by omission.
 *   - A rollback is only reported as done after the restored sequence has been
 *     diffed against the snapshot and found identical. If that check cannot be
 *     made, or fails, the result says so and names the checkpoint that still
 *     exists so a human can finish the job by hand.
 *
 * The orchestrator here is pure: it talks to an injected TransactionExecutor and
 * generates no ExtendScript of its own, so the whole state machine — including
 * every failure boundary — is testable without Premiere running.
 */

import { z } from 'zod';
import { annotationsFor } from './annotations.js';
import { formatCheckpointTimestamp } from './recovery.js';

/** The single agent-facing tool name this module implements. */
export const TRANSACTION_TOOL_NAME = 'transact_sequence_edits';

/**
 * Steps per transaction. The cap is not about the host — it is about the report:
 * a ledger an agent can actually read, and a rollback window a human can reason
 * about. Split larger plans into several transactions with their own snapshots.
 */
export const TRANSACTION_STEP_LIMIT = 40;

// ── What a sequence snapshot can and cannot put back ────────────────────────

/**
 * The guarantee text is part of the API response, not just the docs. An agent
 * that reads only the JSON must still learn the boundary, because the boundary
 * is where a confident "rolled back" turns into a lie.
 */
export const TRANSACTION_GUARANTEES: {
  restores: string[];
  doesNotRestore: string[];
} = {
  restores: [
    'The clip layout of the one snapshotted sequence: which clips are on which video/audio track, their start times, durations, and source in/out points.',
    'Per-clip state carried by the sequence clip: enabled/disabled, speed and reverse, clip name overrides, label colour, opacity/volume.',
    'Effects and transitions on those clips, with their parameter values and keyframes (Lumetri, Motion, Opacity, audio filters).',
    'That sequence\'s track structure as of the snapshot: track count, track names, lock/mute/target flags.',
    'Markers on that sequence.',
  ],
  doesNotRestore: [
    'Anything in any OTHER sequence. A nested sequence is referenced, not copied — edits made inside a nest are not rolled back by restoring the parent.',
    'Project-panel state: media imported, bins created/renamed/moved, project items deleted or renamed, labels set on project items.',
    'New project items created as a side effect of an edit (titles, graphics, adjustment layers, subclips, nested sequences). After a rollback they remain in the project panel as orphans.',
    'Files on disk: exports, encodes, render/preview files, sidecars, CSV/SRT/EDL/AAF written by a tool.',
    'Media state: relinks, footage interpretation, proxy attach/detach, offline flags.',
    'Application and project preferences, scratch disks, workspaces, render settings.',
    'Premiere\'s undo stack. This transaction never calls undo/redo; the rollback is a fresh clone of the snapshot, so the human\'s undo history after a rollback does not walk back into the pre-edit state.',
    'The sequence ID, when rollbackStrategy is "replace_original": the pre-edit content comes back under the original NAME, but as a new sequence with a new ID. Cached sequence IDs go stale.',
    'The saved state of the project on disk. Nothing here saves; if Premiere is closed without saving, both the edits and the rollback are lost together.',
  ],
};

// ── Step classification ────────────────────────────────────────────────────

export type RollbackClass = 'restorable' | 'partial' | 'unrestorable';

export interface ToolClassification {
  tool: string;
  rollback: RollbackClass;
  /** Coarse bucket, useful for grouping refusals in a report. */
  category: string;
  /** Plain-English reason, safe to show an agent verbatim. */
  reason: string;
  /** True when the tool makes no changes at all (nothing to roll back). */
  readOnly: boolean;
}

type Pattern = string | RegExp;

function matches(name: string, patterns: readonly Pattern[]): boolean {
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    if (p === undefined) continue;
    if (typeof p === 'string') {
      if (name === p) return true;
    } else if (p.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Buckets whose effects outlive a sequence clone. Checked FIRST, so a tool that
 * happens to look read-only by prefix (evaluate_expression) or sequence-scoped by
 * shape (import_sequences) is still refused.
 */
const UNRESTORABLE: Array<{ category: string; reason: string; patterns: readonly Pattern[] }> = [
  {
    category: 'arbitrary_script',
    reason: 'The argument is a program, so nothing here can tell what it will touch — it may reach the project panel, the filesystem, or another sequence.',
    patterns: ['execute_extendscript', 'evaluate_expression', 'batch_execute'],
  },
  {
    category: 'undo_stack',
    reason: 'Driving Premiere\'s undo stack from inside a transaction fights the transaction: the two rewind mechanisms would disagree about the current state.',
    patterns: ['undo', 'redo', 'multiple_undo'],
  },
  {
    category: 'transaction_boundary',
    reason: 'A transaction may not manage its own snapshots or nest inside itself.',
    patterns: [TRANSACTION_TOOL_NAME, /recovery_checkpoints?$/],
  },
  {
    category: 'project_lifecycle',
    reason: 'Opening, saving, closing or converting a project happens outside the snapshotted sequence and cannot be undone by restoring it.',
    patterns: [
      /^save_project/, /^close_project/, /^open_project/, /^open_fcp_xml/, 'create_project',
      'convert_project_to_production', 'share_production', 'sync_production', 'resolve_conflict',
      /^set_project_/, /^set_app_/, /^set_scratch/, 'set_workspace', 'set_location_copy_settings',
      'set_encoder_xmp_options', 'set_renderer', 'set_preview_quality', 'set_render_preview_quality',
      /^set_color_management/, 'set_log_color_management', 'set_graphics_white_luminance',
    ],
  },
  {
    category: 'sequence_lifecycle',
    reason: 'This creates or destroys a sequence. The snapshot covers one existing sequence, so a new sequence is outside it and a deleted one cannot be brought back by restoring a different one.',
    patterns: [
      'delete_sequence', 'duplicate_sequence', /^create_sequence/, 'create_subsequence',
      'create_multicam_from_clips', 'create_multicam_source_sequence', 'version_up_sequence',
      'sequence_from_markers', 'storyboard_bin_to_sequence', 'auto_reframe_sequence',
      /^import_sequences/, 'set_active_sequence', 'close_sequence',
      // Sequence SETTINGS only (frame rate, raster, audio config): changing them
      // invalidates render files on disk, which no clone brings back. In/out
      // points and selection are handled in the restorable list below.
      'conform_sequence_settings', 'set_sequence_settings', 'set_sequence_frame_rate',
      'set_sequence_resolution', 'set_sequence_audio_settings', 'set_sequence_display_format',
      'set_sequence_field_type', 'set_sequence_pixel_aspect_ratio', 'set_sequence_start_timecode',
    ],
  },
  {
    category: 'project_items_and_bins',
    reason: 'Bin and project-item changes live in the project panel, which a sequence clone does not cover — and Premiere offers no verified bin delete to walk them back.',
    patterns: [
      /bin$/, /^create_bin/, /^delete_bin/, 'rename_bin', /^move_item/, /^move_items/,
      /project_item/, /project_items/, 'create_smart_bin', 'consolidate_duplicates',
      'create_subclip', 'create_subclips_from_markers', 'marker_to_subclip', 'log_clip',
      'batch_log_from_csv', 'select_item', 'set_project_panel_selection', 'set_project_panel_columns',
      'set_project_panel_metadata', 'set_item_in_out', 'clear_item_in_out', 'set_item_metadata',
      'set_item_poster_frame', 'set_poster_frame', 'set_item_pixel_aspect_ratio', 'set_metadata',
      'set_xmp_metadata', 'add_custom_metadata_field', 'add_metadata_schema_field',
      'attach_custom_property', 'attach_sequence_custom_property',
    ],
  },
  {
    category: 'media_and_import',
    reason: 'Imports, relinks and interpretation changes are project-wide media state; restoring a sequence does not un-import a file or re-point a relink.',
    patterns: [
      /^import_/, /^batch_relink/, 'relink_media', 'replace_clip_media', 'index_footage',
      'refresh_media', 'set_footage_interpretation', 'set_interpretation_frame_rate',
      'set_override_frame_rate', 'set_override_pixel_aspect_ratio', 'set_offline',
      'manage_proxies', 'create_proxy_qe', 'detach_proxy', 'set_proxies_enabled',
      'set_transcode_on_ingest', 'link_media_qe', 'import_media_qe',
    ],
  },
  {
    category: 'files_on_disk',
    reason: 'This writes outside the project. A rendered, exported or written file stays on disk after any rollback.',
    patterns: [
      /^export_/, /^encode_/, /^write_/, /^start_/, /_to_csv$/, 'stem_export',
      'render_audio', 'render_sequence_previews',
      'add_to_render_queue', 'delete_preview_files', 'archive_master', 'consolidate_and_transfer',
      'transcribe_to_srt', 'capture_frame', 'capture_program_output', 'send_to_after_effects',
      'flush_sequence_cache', 'shift_srt_timing', 'snapshot_state', 'grade_snapshot',
      'shotgrid_status_sync', 'production_sync_status',
    ],
  },
];

/**
 * Sequence-scoped mutations that a clone genuinely puts back. Deliberately an
 * ALLOWLIST: an unrecognised tool is refused rather than assumed safe, because
 * the cost of guessing wrong is a transaction that promises a rollback it cannot
 * perform. Add to this list only after checking that the tool's whole effect
 * lands inside one sequence.
 */
const RESTORABLE: readonly Pattern[] = [
  // Timeline structure and clip placement.
  /^add_to_timeline/, /^move_clip/, /^trim_/, /^ripple_/, /^razor_/, 'roll_edit', 'slip_edit',
  'slide_edit', 'extend_edit', /^lift_/, /^extract_/, 'remove_from_timeline',
  'remove_selected_clips', 'close_gap_at', 'close_all_gaps', 'overwrite_clip',
  'overwrite_from_source', 'insert_from_source', 'three_point_edit', 'duplicate_clip',
  'replace_clip', 'batch_replace_clips', 'split_clip', 'freeze_frame', 'fit_clip_duration',
  'rate_stretch_to_fill', 'nudge_clip', 'distribute_clips_evenly', 'snap_clips_to_grid',
  'align_clips_spatial', 'move_clip_to_track',
  // Clip properties and transforms.
  /^set_clip_/, 'set_start_time', 'set_zero_point', 'set_sequence_zero_point', 'mute_clip_audio',
  'enable_disable_clip', /^batch_enable_disable/, 'rename_timeline_clip', 'batch_rename_clips',
  'set_color_label', 'batch_set_label', 'set_blend_mode', 'set_uniform_scale',
  'toggle_uniform_scale', 'reset_transform', 'reset_motion_to_defaults', 'flip_horizontal',
  'flip_vertical', /^set_scale_/, 'set_scale_to_frame_size', 'match_transform',
  'set_anti_alias_quality',
  // Timing.
  'speed_change', 'set_clip_speed_qe', 'bake_speed_change', 'speed_ramp_bake', 'reverse_clip',
  'set_clip_reverse', 'remove_time_remap', /^set_time_interpolation/, /^set_frame_blend/,
  // Effects and grading.
  /^apply_/, 'batch_apply_effect', /^remove_effect/, /^remove_all_effects/, /^enable_disable_(effect|all_effects)$/,
  'reorder_effects', /^set_effect_/, 'copy_effect_values', 'copy_effects_between_clips',
  /^lumetri_/, 'color_correct', 'copy_grade', 'paste_grade_to_clips', 'match_shot_color',
  'auto_white_balance', 'blur_clip', 'sharpen_clip', 'denoise_clip', 'dereverb_clip',
  'stabilize_clip', 'crop_clip', 'set_clip_crop', 'letterbox', 'watermark_apply', 'ken_burns',
  /^keyframe_zoom_/, 'set_color_value', 'set_color_space_override', 'set_clip_color_space',
  'apply_morph_cut',
  // Keyframes.
  /^add_keyframe/, 'add_audio_keyframes', /^remove_keyframe/, 'set_keyframe_interpolation',
  'bake_keyframe_ease', 'set_track_volume_keyframes',
  // Transitions and fades.
  /^add_transition/, /^batch_add_transition/, 'audio_crossfade_at_cut',
  'batch_add_audio_crossfades', /^fade_(in|out)_(audio|video)$/, 'j_cut', 'l_cut',
  // Audio levels.
  'adjust_audio_levels', 'normalize_clip_peaks', 'normalize_track_peaks', 'normalize_loudness',
  'setup_ducking', 'set_compressor', 'set_limiter', 'set_parametric_eq', 'fill_room_tone',
  'set_essential_sound_category',
  // Tracks (of this sequence).
  /^add_track/, 'add_tracks', 'delete_track', 'delete_empty_tracks', 'rename_track', 'lock_track',
  'sync_lock_track', 'toggle_track_visibility', 'mute_track', 'set_target_track',
  'set_all_tracks_targeted', 'set_track_lock_qe',
  // Sequence markers.
  'add_marker', 'create_marker', 'delete_marker', 'update_marker', 'set_marker_type',
  'duration_marker_add', 'markers_from_csv', 'notes_to_markers', 'captions_to_markers',
  'frame_io_notes_to_markers', 'copy_markers_between_sequences',
  // Selection, playhead and other in-sequence UI state. Nothing to restore, and
  // harmless if a rollback does not restore it.
  /^select_/, 'deselect_all_clips', 'invert_selection', 'set_clip_selection',
  'set_sequence_selection', 'link_selection', 'unlink_selection', 'link_audio_video',
  'set_playhead_position', /^go_to_/, 'step_frames', 'move_playhead_to_edit', 'set_work_area',
  'clear_work_area', 'set_sequence_in_out_points', 'set_sequence_in_out_from_clips',
  'set_sequence_in_out_qe', 'clear_sequence_in_out', 'set_source_in_out', 'set_source_in_out_qe',
  'refresh_ui',
];

/**
 * Allowed, but a rollback leaves litter: these create a project item (a title, a
 * graphic, an adjustment layer, a nest) alongside the timeline edit. Restoring
 * the sequence removes the clip; the item stays in the project panel. Requires
 * the caller to opt in with allowPartialRollback, so nobody learns this from a
 * surprise.
 */
const PARTIAL: Array<{ patterns: readonly Pattern[]; reason: string }> = [
  {
    patterns: [
      'add_adjustment_layer', 'create_adjustment_layer_at', 'add_text_overlay', 'title_card',
      'lower_third_preset', 'countdown_leader', 'create_bars_and_tone', 'timecode_burn_in',
      'import_mogrt', 'import_mogrt_from_library', 'batch_mogrt_from_data',
      'create_caption_track', 'nest_clips', 'unnest_sequence', 'nest_all_v1_clips',
      'flatten_multicam', 'enable_multicam', 'pip_layout', 'grid_layout', 'split_screen_layout',
      'detect_scene_edits', 'scene_edit_detection',
    ],
    reason: 'Creates a new project item (graphic, title, adjustment layer, caption track or nested sequence). Restoring the sequence removes the clip from the timeline but leaves that item in the project panel.',
  },
  {
    patterns: ['set_mogrt_text', 'set_mogrt_param', 'set_mogrt_color', 'remove_mogrt_clip'],
    reason: 'Edits a Motion Graphics template instance. The clip and its parameters come back with the sequence clone, but any .mogrt asset installed into the project stays.',
  },
];

/**
 * Decide whether a transaction can honestly promise to undo a tool.
 *
 * Order matters: unrestorable buckets win over everything (an `import_sequences`
 * must not be read as a sequence edit), then read-only tools are trivially safe,
 * then the restorable allowlist, then the partial list. Anything left over is
 * `unrestorable` with an "unclassified" category — fail closed.
 */
export function classifyTransactionTool(tool: string): ToolClassification {
  const name = String(tool || '');

  for (let i = 0; i < UNRESTORABLE.length; i++) {
    const bucket = UNRESTORABLE[i];
    if (bucket && matches(name, bucket.patterns)) {
      return {
        tool: name,
        rollback: 'unrestorable',
        category: bucket.category,
        reason: bucket.reason,
        readOnly: false,
      };
    }
  }

  // Reuse the annotation layer's read-only determination so there is one source
  // of truth for "this tool does not change anything".
  if (annotationsFor(name).readOnlyHint) {
    return {
      tool: name,
      rollback: 'restorable',
      category: 'read_only',
      reason: 'Read-only: it changes nothing, so there is nothing to roll back.',
      readOnly: true,
    };
  }

  if (matches(name, RESTORABLE)) {
    return {
      tool: name,
      rollback: 'restorable',
      category: 'sequence_edit',
      reason: 'Its whole effect lands inside the snapshotted sequence, which the checkpoint clone restores.',
      readOnly: false,
    };
  }

  for (let i = 0; i < PARTIAL.length; i++) {
    const bucket = PARTIAL[i];
    if (bucket && matches(name, bucket.patterns)) {
      return {
        tool: name,
        rollback: 'partial',
        category: 'sequence_edit_with_residue',
        reason: bucket.reason,
        readOnly: false,
      };
    }
  }

  return {
    tool: name,
    rollback: 'unrestorable',
    category: 'unclassified',
    reason: 'Not on the list of tools whose effect is known to stay inside one sequence. A transaction will not wrap a tool it cannot promise to undo — run it outside the transaction, or take a recovery checkpoint by hand first.',
    readOnly: false,
  };
}

// ── The injected executor ──────────────────────────────────────────────────

export interface SequenceRef {
  success?: boolean;
  id?: string | null;
  name?: string | null;
  error?: string;
}

export interface FingerprintResult {
  success?: boolean;
  fingerprint?: string;
  clipCount?: number;
  error?: string;
}

export interface CheckpointResult {
  success?: boolean;
  checkpointSequenceId?: string | null;
  checkpointName?: string;
  error?: string;
}

export interface DiffResult {
  success?: boolean;
  identical?: boolean;
  changeCount?: number;
  counts?: Record<string, number>;
  added?: unknown[];
  removed?: unknown[];
  moved?: unknown[];
  retimed?: unknown[];
  error?: string;
}

export interface RestoreResult {
  success?: boolean;
  restoredSequenceId?: string | null;
  restoredProjectItemId?: string | null;
  restoredName?: string;
  active?: boolean;
  error?: string;
}

export interface MutationResult {
  success?: boolean;
  verified?: boolean;
  error?: string;
}

/**
 * Everything the orchestrator needs from Premiere, and nothing else. Each method
 * maps 1:1 onto an existing verified handler, so the transaction adds no new
 * ExtendScript and inherits those handlers' fail-closed read-backs.
 */
export interface TransactionExecutor {
  /** The active sequence. The transaction always operates on it (see runTransaction). */
  resolveActiveSequence(): Promise<SequenceRef>;
  /** Structural checksum of a sequence — the ledger's state hash. */
  fingerprint(sequenceId?: string): Promise<FingerprintResult>;
  /** Clone the sequence into a tagged `[recovery] …` snapshot. */
  createCheckpoint(sequenceId: string, label: string): Promise<CheckpointResult>;
  /** Clip-level comparison of two sequences; name-independent, unlike the fingerprint. */
  diffSequences(sequenceIdA: string, sequenceIdB: string): Promise<DiffResult>;
  /** Run one planned edit (or a read-back check) by tool name. */
  runTool(tool: string, args: Record<string, unknown>): Promise<any>;
  /** Clone a checkpoint back into a working sequence. */
  restoreCheckpoint(
    checkpointSequenceId: string,
    newName: string,
    setActive: boolean,
  ): Promise<RestoreResult>;
  /** Verified sequence delete — only used by rollbackStrategy "replace_original". */
  deleteSequence(sequenceId: string): Promise<MutationResult>;
  /** Verified project-item rename — only used by rollbackStrategy "replace_original". */
  renameProjectItem(projectItemId: string, newName: string): Promise<MutationResult>;
}

// ── Input schema ───────────────────────────────────────────────────────────

const stepSchema = z.object({
  tool: z
    .string()
    .describe('The tool to run for this step, e.g. "apply_video_effect". Must be a tool whose whole effect stays inside one sequence; anything else is refused before the transaction starts.'),
  args: z
    .record(z.string(), z.any())
    .optional()
    .describe('Arguments for that tool, exactly as you would pass them normally.'),
  id: z
    .string()
    .optional()
    .describe('Your own label for this step, echoed in the ledger. Defaults to "step_<n>".'),
  expectFingerprintChanged: z
    .boolean()
    .optional()
    .describe('Assert the sequence structure did (true) or did not (false) change as a result of this step. Use true for cuts/moves/inserts. Omit for effect or property edits, which do not move clips.'),
  verify: z
    .object({
      tool: z.string().describe('A read-only tool that reads back what the step was supposed to do.'),
      args: z.record(z.string(), z.any()).optional().describe('Arguments for the read-back tool.'),
      path: z.string().optional().describe('Dot path into the read-back result, e.g. "clip.effects.0.matchName" or "count".'),
      equals: z.any().optional().describe('The value that path must equal (deep-compared).'),
      contains: z.string().optional().describe('Substring that the value at path (stringified) must contain.'),
      exists: z.boolean().optional().describe('Whether the value at path must be present (true) or absent (false).'),
    })
    .optional()
    .describe('An explicit read-back check for this step. Supply one for any tool that does not return verified:true on its own — without it the step is unverifiable, and unverifiable is treated as failure.'),
});

export const transactSequenceEditsSchema = z.object({
  steps: z
    .array(stepSchema)
    .min(1)
    .max(TRANSACTION_STEP_LIMIT)
    .describe('The plan, in order. Every step is classified BEFORE anything runs; if any step names a tool that cannot be rolled back, nothing runs at all.'),
  label: z
    .string()
    .optional()
    .describe('Short description of the edit, used in the checkpoint name. Default "transaction".'),
  sequenceId: z
    .string()
    .optional()
    .describe('Optional guard: the sequence you believe you are editing. It must be the ACTIVE sequence, otherwise the transaction refuses to start (steps that default to the active sequence would otherwise edit the wrong timeline).'),
  onFailure: z
    .enum(['rollback', 'keep_partial'])
    .default('rollback')
    .describe('"rollback" (default) restores the snapshot when a step fails or cannot be verified. "keep_partial" leaves the half-finished edit in place and reports exactly where it stopped — use it only when you intend to fix the state by hand.'),
  rollbackStrategy: z
    .enum(['restore_copy', 'replace_original'])
    .default('restore_copy')
    .describe('"restore_copy" (default, non-destructive): the pre-edit state comes back as a new sequence, made active, and the half-edited sequence is left alone. "replace_original": after verifying the restore, delete the half-edited sequence and give the restored one its original name — the project ends up with one sequence again, but its sequence ID changes.'),
  unverifiableStep: z
    .enum(['fail', 'accept'])
    .default('fail')
    .describe('What to do when a step returns no verifiable signal at all. "fail" (default) treats it as a failure and rolls back. "accept" continues, and the result is reported as committed but NOT verified end to end.'),
  allowPartialRollback: z
    .boolean()
    .default(false)
    .describe('Permit steps that create a project item (titles, graphics, adjustment layers, nests). A rollback removes their clips but leaves the items in the project panel; the residue is listed in the result.'),
  keepCheckpointOnCommit: z
    .boolean()
    .default(false)
    .describe('Keep the snapshot sequence after a successful commit instead of deleting it. The snapshot is ALWAYS kept when a transaction fails.'),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Classify the plan and report what would happen without touching the project — no snapshot, no steps, no calls into Premiere.'),
});

/** What a caller may send. Defaults are NOT assumed applied — see resolveConfig. */
export type TransactionInput = z.input<typeof transactSequenceEditsSchema>;
export type TransactionStep = z.input<typeof stepSchema>;
export type RollbackStrategy = 'restore_copy' | 'replace_original';
export type UnverifiablePolicy = 'fail' | 'accept';

/**
 * The options with defaults resolved. The tool layer hands handlers RAW args (no
 * zod parse), so relying on schema defaults would silently turn "fail closed"
 * into "undefined", i.e. open. Every default is applied here instead.
 */
export interface TransactionConfig {
  onFailure: 'rollback' | 'keep_partial';
  rollbackStrategy: RollbackStrategy;
  unverifiableStep: UnverifiablePolicy;
  allowPartialRollback: boolean;
  keepCheckpointOnCommit: boolean;
  dryRun: boolean;
}

export function resolveConfig(input: TransactionInput): TransactionConfig {
  return {
    onFailure: input.onFailure === 'keep_partial' ? 'keep_partial' : 'rollback',
    rollbackStrategy: input.rollbackStrategy === 'replace_original' ? 'replace_original' : 'restore_copy',
    unverifiableStep: input.unverifiableStep === 'accept' ? 'accept' : 'fail',
    allowPartialRollback: input.allowPartialRollback === true,
    keepCheckpointOnCommit: input.keepCheckpointOnCommit === true,
    dryRun: input.dryRun === true,
  };
}

// ── Ledger ─────────────────────────────────────────────────────────────────

export type VerificationBasis =
  | 'read_back'
  | 'self_verified'
  | 'self_unverified'
  | 'fingerprint'
  | 'read_only'
  | 'tool_error'
  | 'no_result'
  | 'read_back_failed'
  | 'fingerprint_unavailable'
  | 'unverifiable'
  | 'unverifiable_accepted'
  | 'not_attempted';

export interface TransactionLedgerEntry {
  index: number;
  id: string;
  tool: string;
  rollbackClass: RollbackClass;
  attempted: boolean;
  /** What the step was meant to do, in the caller's own terms. */
  attemptedAction: string;
  toolSuccess: boolean | null;
  /** true = proven, false = proven not / could not be proven, null = accepted unproven. */
  verified: boolean | null;
  verification: { basis: VerificationBasis; reason: string };
  fingerprintBefore: string | null;
  fingerprintAfter: string | null;
  fingerprintChanged: boolean | null;
  resultDigest: Record<string, unknown> | null;
  /** Full result, kept only for the step that stopped the transaction. */
  result?: unknown;
  error?: string;
}

// ── Small pure helpers ─────────────────────────────────────────────────────

/**
 * Strip control characters and cap length; the label ends up inside a sequence
 * NAME, which the checkpoint handler then interpolates into ExtendScript. That
 * handler quotes it with JSON.stringify, so this is belt-and-braces rather than
 * the only guard — but a newline or a NUL in a sequence name is worthless to the
 * human who has to find it in the project panel.
 */
export function sanitizeTransactionLabel(label: string | undefined): string {
  const stripped = String(label ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  if (!collapsed) return 'transaction';
  return collapsed.length > 60 ? collapsed.slice(0, 60).replace(/\s+$/, '') : collapsed;
}

/** Read a dot path (with numeric indices) out of a result object. */
export function readPath(source: unknown, path: string): unknown {
  if (!path) return source;
  const parts = path.split('.');
  let current: any = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  return ja === jb;
}

/** The handful of scalar fields worth carrying for every step. */
function digest(result: any): Record<string, unknown> | null {
  if (result === null || result === undefined || typeof result !== 'object') {
    return result === undefined ? null : { value: result as unknown };
  }
  const out: Record<string, unknown> = {};
  const keys = ['success', 'verified', 'message', 'error', 'warning', 'note', 'count'];
  for (const k of keys) {
    if (result[k] !== undefined) out[k] = result[k];
  }
  return out;
}

function describeAction(tool: string, args: Record<string, unknown> | undefined): string {
  let rendered = '';
  try {
    rendered = JSON.stringify(args ?? {});
  } catch {
    rendered = '{unserializable arguments}';
  }
  if (rendered.length > 300) rendered = `${rendered.slice(0, 297)}...`;
  return `${tool} ${rendered}`;
}

// ── The orchestrator ───────────────────────────────────────────────────────

export interface TransactionResult {
  success: boolean;
  tool: string;
  transactionId: string;
  /** Did we get as far as taking the snapshot? */
  began: boolean;
  committed: boolean;
  aborted: boolean;
  rolledBack: boolean;
  rollbackVerified: boolean;
  /** True end-to-end proof: every step ran AND every step was proven. */
  verifiedEndToEnd: boolean;
  sequence: { id: string | null; name: string | null };
  checkpoint: {
    sequenceId: string | null;
    name: string | null;
    retained: boolean;
    deleted: boolean;
    cleanupError?: string;
  } | null;
  preState: { fingerprint: string | null; clipCount: number | null; snapshotVerified: boolean } | null;
  postState: { fingerprint: string | null; clipCount: number | null } | null;
  plan: ToolClassification[];
  steps: TransactionLedgerEntry[];
  stoppedAtStep: number | null;
  changes: DiffResult | null;
  rollback: {
    strategy: RollbackStrategy;
    attempted: boolean;
    restoredSequenceId: string | null;
    restoredName: string | null;
    verification: string;
    replacedOriginal: boolean;
    originalSequenceDeleted: boolean;
    errors: string[];
  } | null;
  residualRisk: string[];
  guarantees: typeof TRANSACTION_GUARANTEES;
  /** One sentence an agent can relay to a human without editing it. */
  projectStateNow: string;
  error?: string;
  note: string;
}

interface RunOptions {
  now?: () => Date;
}

/** The all-negative skeleton every early return starts from. */
function baseResult(transactionId: string, plan: ToolClassification[]): TransactionResult {
  return {
    success: false,
    tool: TRANSACTION_TOOL_NAME,
    transactionId,
    began: false,
    committed: false,
    aborted: false,
    rolledBack: false,
    rollbackVerified: false,
    verifiedEndToEnd: false,
    sequence: { id: null, name: null },
    checkpoint: null,
    preState: null,
    postState: null,
    plan,
    steps: [],
    stoppedAtStep: null,
    changes: null,
    rollback: null,
    residualRisk: [],
    guarantees: TRANSACTION_GUARANTEES,
    projectStateNow:
      'Unchanged. The transaction refused to start, so no snapshot was taken and no step was run.',
    note: 'Refused before any change was made. Fix the plan and call again.',
  };
}

/** A refusal: no snapshot, nothing ran, nothing to clean up. */
function refuse(
  transactionId: string,
  error: string,
  plan: ToolClassification[],
  extra: Partial<TransactionResult> = {},
): TransactionResult {
  return { ...baseResult(transactionId, plan), error, ...extra };
}

/**
 * Plan → snapshot → apply → verify → commit or roll back.
 *
 * The transaction always targets the ACTIVE sequence. That is not a convenience:
 * most tools default to the active sequence when no id is passed, so a
 * transaction snapshotting sequence A while its steps quietly edit sequence B
 * would report a rollback that restored the wrong timeline. Passing `sequenceId`
 * asserts which sequence you think is active and refuses if you are wrong.
 */
export async function runTransaction(
  executor: TransactionExecutor,
  input: TransactionInput,
  options: RunOptions = {},
): Promise<TransactionResult> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = formatCheckpointTimestamp(now());
  const transactionId = `txn-${startedAt}`;
  const cfg = resolveConfig(input);
  const label = sanitizeTransactionLabel(input.label);
  const steps = input.steps ?? [];
  const plan = steps.map((step) => classifyTransactionTool(step.tool));

  // ── Boundary 1: the plan itself. Refuse before touching anything.
  if (steps.length === 0) {
    return refuse(transactionId, 'steps is empty — a transaction needs at least one step.', plan);
  }
  if (steps.length > TRANSACTION_STEP_LIMIT) {
    return refuse(
      transactionId,
      `Too many steps (${steps.length}). The limit is ${TRANSACTION_STEP_LIMIT} per transaction — split the plan and snapshot each part.`,
      plan,
    );
  }

  const blocked: string[] = [];
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    if (entry && entry.rollback === 'unrestorable') {
      blocked.push(`step ${i + 1} (${entry.tool}): ${entry.reason}`);
    }
  }
  if (blocked.length > 0) {
    return refuse(
      transactionId,
      `This transaction cannot promise to undo ${blocked.length} of its ${steps.length} step(s), so nothing was run and no snapshot was taken. ${blocked.join(' | ')}`,
      plan,
    );
  }

  const partialSteps: string[] = [];
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    if (entry && entry.rollback === 'partial') {
      partialSteps.push(`step ${i + 1} (${entry.tool}): ${entry.reason}`);
    }
  }
  if (partialSteps.length > 0 && !cfg.allowPartialRollback) {
    return refuse(
      transactionId,
      `${partialSteps.length} step(s) can only be PARTIALLY rolled back. Pass allowPartialRollback:true to accept the listed residue, or run them outside the transaction. ${partialSteps.join(' | ')}`,
      plan,
    );
  }
  const residualRisk = partialSteps.slice();

  if (cfg.dryRun) {
    return {
      ...baseResult(transactionId, plan),
      success: true,
      residualRisk,
      projectStateNow: 'Unchanged. dryRun only classified the plan; nothing was read or written.',
      note: `Dry run: all ${steps.length} step(s) are wrappable${residualRisk.length ? `, ${residualRisk.length} with residue (see residualRisk)` : ''}. Call again with dryRun:false to execute.`,
    };
  }

  // ── Boundary 2: identify the sequence we are about to guard.
  const active = await executor.resolveActiveSequence();
  if (!active || active.success === false || !active.id) {
    return refuse(
      transactionId,
      `No active sequence, so there is nothing to snapshot and no safe place to run the plan: ${active?.error || 'the host reported no active sequence'}. Open the sequence you want to edit and call again.`,
      plan,
    );
  }
  const sequenceId = String(active.id);
  const sequenceName = active.name ? String(active.name) : null;

  if (input.sequenceId && String(input.sequenceId) !== sequenceId) {
    return refuse(
      transactionId,
      `sequenceId '${input.sequenceId}' is not the active sequence ('${sequenceId}'${sequenceName ? ` — ${sequenceName}` : ''}). Steps that omit a sequence id edit the ACTIVE sequence, so running now would edit a sequence this transaction did not snapshot. Open '${input.sequenceId}' first, or omit sequenceId.`,
      plan,
    );
  }

  // ── Boundary 3: a pre-state we can name. No fingerprint, no transaction.
  const preFp = await executor.fingerprint(sequenceId);
  if (!preFp || preFp.success === false || !preFp.fingerprint) {
    return refuse(
      transactionId,
      `Could not fingerprint '${sequenceName ?? sequenceId}' before starting: ${preFp?.error || 'no fingerprint returned'}. Without a pre-edit state hash a rollback could not be verified, so nothing was run.`,
      plan,
    );
  }
  const preState = {
    fingerprint: preFp.fingerprint,
    clipCount: typeof preFp.clipCount === 'number' ? preFp.clipCount : null,
    snapshotVerified: false,
  };

  // ── Boundary 4: the snapshot. Fail closed — no snapshot, no edits.
  const checkpoint = await executor.createCheckpoint(sequenceId, `${label} [${transactionId}]`);
  if (!checkpoint || checkpoint.success === false || !checkpoint.checkpointSequenceId) {
    return refuse(
      transactionId,
      `Snapshot failed, so NO step was run and the project is untouched: ${checkpoint?.error || 'the checkpoint clone returned no sequence id'}.`,
      plan,
      { preState },
    );
  }
  const checkpointId = String(checkpoint.checkpointSequenceId);
  const checkpointName = checkpoint.checkpointName ?? null;

  // ── Boundary 5: prove the snapshot IS the pre-state. A clone that does not
  // match the source is not a snapshot, and a rollback from it would silently
  // install the wrong content.
  const snapshotDiff = await executor.diffSequences(sequenceId, checkpointId);
  if (!snapshotDiff || snapshotDiff.success === false || snapshotDiff.identical !== true) {
    return refuse(
      transactionId,
      `The snapshot could not be proven to match the pre-edit sequence, so NO step was run: ${
        snapshotDiff?.error ||
        `the clone differs from the source (${snapshotDiff?.changeCount ?? 'unknown'} difference(s))`
      }. The checkpoint sequence '${checkpointName ?? checkpointId}' was created and is still in the project — delete it by hand if you do not want it.`,
      plan,
      {
        preState,
        checkpoint: {
          sequenceId: checkpointId,
          name: checkpointName,
          retained: true,
          deleted: false,
        },
      },
    );
  }
  preState.snapshotVerified = true;

  // ── Apply. One ledger entry per step, always.
  const ledger: TransactionLedgerEntry[] = [];
  let previousFingerprint: string | null = preState.fingerprint;
  let failedIndex: number | null = null;
  let anyUnproven = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const classification = plan[i];
    if (!step || !classification) continue;
    const id = step.id ? String(step.id) : `step_${i + 1}`;
    const entry: TransactionLedgerEntry = {
      index: i + 1,
      id,
      tool: step.tool,
      rollbackClass: classification.rollback,
      attempted: false,
      attemptedAction: describeAction(step.tool, step.args),
      toolSuccess: null,
      verified: false,
      verification: { basis: 'not_attempted', reason: 'The transaction stopped before this step.' },
      fingerprintBefore: previousFingerprint,
      fingerprintAfter: null,
      fingerprintChanged: null,
      resultDigest: null,
    };

    if (failedIndex !== null) {
      ledger.push(entry);
      continue;
    }

    entry.attempted = true;
    let result: any;
    try {
      result = await executor.runTool(step.tool, step.args ?? {});
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    entry.resultDigest = digest(result);
    entry.toolSuccess = result && result.success !== false ? true : false;

    const afterFp = await executor.fingerprint(sequenceId);
    const afterFingerprint =
      afterFp && afterFp.success !== false && afterFp.fingerprint ? afterFp.fingerprint : null;
    entry.fingerprintAfter = afterFingerprint;
    entry.fingerprintChanged =
      afterFingerprint !== null && entry.fingerprintBefore !== null
        ? afterFingerprint !== entry.fingerprintBefore
        : null;

    const verdict = await verifyStep(
      executor,
      step,
      classification,
      result,
      entry,
      cfg.unverifiableStep,
      afterFp,
    );
    entry.verified = verdict.verified;
    entry.verification = { basis: verdict.basis, reason: verdict.reason };
    if (verdict.verified === null) anyUnproven = true;
    if (verdict.verified === false) {
      entry.error = verdict.reason;
      entry.result = result;
      failedIndex = i + 1;
    }

    if (afterFingerprint !== null) previousFingerprint = afterFingerprint;
    ledger.push(entry);
  }

  const postFp = await executor.fingerprint(sequenceId);
  const postState = {
    fingerprint: postFp && postFp.success !== false && postFp.fingerprint ? postFp.fingerprint : null,
    clipCount: postFp && typeof postFp.clipCount === 'number' ? postFp.clipCount : null,
  };

  // ── Failure path.
  if (failedIndex !== null) {
    // failedIndex was set from this loop, so the entry is always present; the
    // fallback exists only to satisfy the compiler's indexed-access checking.
    const failedEntry = ledger[failedIndex - 1];
    const failedTool = failedEntry ? failedEntry.tool : 'unknown';
    const failedReason = failedEntry ? failedEntry.verification.reason : 'no ledger entry was recorded';
    const headline = `Step ${failedIndex} of ${steps.length} (${failedTool}) ${
      failedEntry && failedEntry.toolSuccess ? 'ran but could not be verified' : 'failed'
    }: ${failedReason}`;

    if (cfg.onFailure === 'keep_partial') {
      return {
        success: false,
        tool: TRANSACTION_TOOL_NAME,
        transactionId,
        began: true,
        committed: false,
        aborted: true,
        rolledBack: false,
        rollbackVerified: false,
        verifiedEndToEnd: false,
        sequence: { id: sequenceId, name: sequenceName },
        checkpoint: { sequenceId: checkpointId, name: checkpointName, retained: true, deleted: false },
        preState,
        postState,
        plan,
        steps: ledger,
        stoppedAtStep: failedIndex,
        changes: await safeDiff(executor, checkpointId, sequenceId),
        rollback: {
          strategy: cfg.rollbackStrategy,
          attempted: false,
          restoredSequenceId: null,
          restoredName: null,
          verification: 'Not attempted: onFailure was "keep_partial".',
          replacedOriginal: false,
          originalSequenceDeleted: false,
          errors: [],
        },
        residualRisk,
        guarantees: TRANSACTION_GUARANTEES,
        projectStateNow: `PARTIALLY EDITED, on purpose. Sequence '${sequenceName ?? sequenceId}' still holds the effects of steps 1-${
          failedIndex - 1
        } plus whatever step ${failedIndex} managed to do. No rollback was attempted because onFailure was "keep_partial". The pre-edit snapshot is intact as the sequence named '${
          checkpointName ?? checkpointId
        }' (id ${checkpointId}) — restore it with restore_recovery_checkpoint when you are done inspecting.`,
        error: headline,
        note: 'Left the partial edit in place as instructed. The ledger shows exactly which steps landed.',
      };
    }

    const rollback = await performRollback(
      executor,
      cfg.rollbackStrategy,
      { sequenceId, sequenceName, checkpointId, checkpointName },
      transactionId,
    );

    const stateSentence = rollback.verified
      ? rollback.replacedOriginal
        ? `ROLLED BACK. The pre-edit content is back under the original name '${
            sequenceName ?? sequenceId
          }' as sequence '${rollback.restoredSequenceId}' (a NEW sequence id — the half-edited sequence '${sequenceId}' was deleted). Verified by diffing the restored sequence against the snapshot: identical.`
        : `ROLLED BACK as a copy. The pre-edit content is the now-active sequence '${
            rollback.restoredName ?? rollback.restoredSequenceId
          }' (id ${rollback.restoredSequenceId}), verified identical to the snapshot. The half-edited sequence '${
            sequenceName ?? sequenceId
          }' (id ${sequenceId}) was deliberately left in place — delete it yourself once you have checked it.`
      : `ROLLBACK NOT VERIFIED — treat this project as being in an UNKNOWN state and check it by hand. ${rollback.errors.join(
          ' ',
        )} The half-edited sequence '${sequenceName ?? sequenceId}' (id ${sequenceId}) still exists${
          rollback.restoredSequenceId
            ? `, and an unverified restore attempt produced sequence '${rollback.restoredSequenceId}'`
            : ''
        }. The pre-edit snapshot is intact as the sequence named '${
          checkpointName ?? checkpointId
        }' (id ${checkpointId}) — restore it manually with restore_recovery_checkpoint.`;

    return {
      success: false,
      tool: TRANSACTION_TOOL_NAME,
      transactionId,
      began: true,
      committed: false,
      aborted: rollback.verified,
      rolledBack: rollback.verified,
      rollbackVerified: rollback.verified,
      verifiedEndToEnd: false,
      sequence: { id: sequenceId, name: sequenceName },
      checkpoint: { sequenceId: checkpointId, name: checkpointName, retained: true, deleted: false },
      preState,
      postState,
      plan,
      steps: ledger,
      stoppedAtStep: failedIndex,
      changes: null,
      rollback: {
        strategy: cfg.rollbackStrategy,
        attempted: true,
        restoredSequenceId: rollback.restoredSequenceId,
        restoredName: rollback.restoredName,
        verification: rollback.verification,
        replacedOriginal: rollback.replacedOriginal,
        originalSequenceDeleted: rollback.originalDeleted,
        errors: rollback.errors,
      },
      residualRisk: residualRisk.concat(
        rollback.verified && residualRisk.length > 0
          ? ['The rollback removed the clips those steps added, but the project items they created remain in the project panel.']
          : [],
      ),
      guarantees: TRANSACTION_GUARANTEES,
      projectStateNow: stateSentence,
      error: rollback.verified
        ? `${headline} — rolled back to the pre-edit state and verified.`
        : `${headline} — AND THE ROLLBACK COULD NOT BE VERIFIED. ${rollback.errors.join(' ')}`,
      note: rollback.verified
        ? 'The plan did not complete and the sequence was put back. Read steps[] to see where it stopped.'
        : 'MANUAL INTERVENTION REQUIRED. Do not assume any part of this project is in the state you asked for.',
    };
  }

  // ── Commit path. Report what changed, then drop the snapshot.
  const changes = await safeDiff(executor, checkpointId, sequenceId);
  let cleanupError: string | undefined;
  let deleted = false;
  if (!cfg.keepCheckpointOnCommit) {
    const drop = await executor.deleteSequence(checkpointId);
    deleted = !!drop && drop.success !== false && drop.verified !== false;
    if (!deleted) cleanupError = drop?.error || 'the delete could not be verified';
  }

  const verifiedEndToEnd = !anyUnproven;
  return {
    success: true,
    tool: TRANSACTION_TOOL_NAME,
    transactionId,
    began: true,
    committed: true,
    aborted: false,
    rolledBack: false,
    rollbackVerified: false,
    verifiedEndToEnd,
    sequence: { id: sequenceId, name: sequenceName },
    checkpoint: {
      sequenceId: checkpointId,
      name: checkpointName,
      retained: !deleted,
      deleted,
      ...(cleanupError ? { cleanupError } : {}),
    },
    preState,
    postState,
    plan,
    steps: ledger,
    stoppedAtStep: null,
    changes,
    rollback: null,
    residualRisk,
    guarantees: TRANSACTION_GUARANTEES,
    projectStateNow: `COMMITTED. All ${steps.length} step(s) ran on sequence '${
      sequenceName ?? sequenceId
    }'${verifiedEndToEnd ? ' and every one was verified' : ' but not every one could be proven — see steps[]'}. ${
      deleted
        ? 'The snapshot was deleted.'
        : `The snapshot sequence '${checkpointName ?? checkpointId}' is still in the project${
            cleanupError ? ` (cleanup failed: ${cleanupError})` : ' because keepCheckpointOnCommit was set'
          }.`
    }`,
    note: verifiedEndToEnd
      ? 'Committed. changes[] is a clip-level diff of the snapshot against the finished sequence, so you can see exactly what the plan did.'
      : 'Committed, but NOT verified end to end: at least one step returned no proof and unverifiableStep was "accept". Do not report this edit as verified.',
  };
}

/** diff_sequences, but a failure becomes a reported null rather than an exception. */
async function safeDiff(
  executor: TransactionExecutor,
  a: string,
  b: string,
): Promise<DiffResult | null> {
  try {
    const diff = await executor.diffSequences(a, b);
    if (!diff || diff.success === false) {
      return { success: false, error: diff?.error || 'diff failed' };
    }
    return diff;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── Per-step verification ──────────────────────────────────────────────────

interface StepVerdict {
  verified: boolean | null;
  basis: VerificationBasis;
  reason: string;
}

/**
 * Establish, positively, that a step did what it claimed. Absence of evidence is
 * NOT evidence: a tool that returns neither `verified` nor a read-back check is
 * unverifiable, and by default that is a failure.
 */
async function verifyStep(
  executor: TransactionExecutor,
  step: TransactionStep,
  classification: ToolClassification,
  result: any,
  entry: TransactionLedgerEntry,
  unverifiablePolicy: UnverifiablePolicy,
  fingerprintResult: FingerprintResult | undefined,
): Promise<StepVerdict> {
  if (result === null || result === undefined) {
    return {
      verified: false,
      basis: 'no_result',
      reason: 'The tool returned nothing at all, so there is no evidence it ran.',
    };
  }
  if (result.success === false) {
    return {
      verified: false,
      basis: 'tool_error',
      reason: `The tool reported failure: ${result.error || 'no error message given'}`,
    };
  }

  // 1. An explicit read-back is the strongest signal available, so prefer it.
  if (step.verify) {
    let readBack: any;
    try {
      readBack = await executor.runTool(step.verify.tool, step.verify.args ?? {});
    } catch (error) {
      return {
        verified: false,
        basis: 'read_back_failed',
        reason: `The read-back tool '${step.verify.tool}' threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!readBack || readBack.success === false) {
      return {
        verified: false,
        basis: 'read_back_failed',
        reason: `The read-back tool '${step.verify.tool}' failed, so the step could not be confirmed: ${
          readBack?.error || 'no error message given'
        }`,
      };
    }
    const hasExpectation =
      step.verify.equals !== undefined ||
      step.verify.contains !== undefined ||
      step.verify.exists !== undefined;
    if (!hasExpectation) {
      return {
        verified: true,
        basis: 'read_back',
        reason: `Read-back '${step.verify.tool}' succeeded (no value expectation was given, so only its success was checked).`,
      };
    }
    const path = step.verify.path ?? '';
    const value = readPath(readBack, path);
    if (step.verify.exists !== undefined) {
      const present = value !== undefined && value !== null;
      if (present !== step.verify.exists) {
        return {
          verified: false,
          basis: 'read_back',
          reason: `Read-back '${step.verify.tool}': '${path || '(root)'}' was expected to ${
            step.verify.exists ? 'exist' : 'be absent'
          } but ${present ? 'is present' : 'is missing'}.`,
        };
      }
    }
    if (step.verify.equals !== undefined && !deepEqual(value, step.verify.equals)) {
      return {
        verified: false,
        basis: 'read_back',
        reason: `Read-back '${step.verify.tool}': '${path || '(root)'}' is ${JSON.stringify(
          value,
        )}, expected ${JSON.stringify(step.verify.equals)}.`,
      };
    }
    if (step.verify.contains !== undefined) {
      const asText = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      if (asText.indexOf(step.verify.contains) === -1) {
        return {
          verified: false,
          basis: 'read_back',
          reason: `Read-back '${step.verify.tool}': '${path || '(root)'}' (${asText}) does not contain '${
            step.verify.contains
          }'.`,
        };
      }
    }
    return {
      verified: true,
      basis: 'read_back',
      reason: `Read-back '${step.verify.tool}' confirmed '${path || '(root)'}'.`,
    };
  }

  // 2. A declared structural assertion, checked against the fingerprint.
  if (step.expectFingerprintChanged !== undefined) {
    if (entry.fingerprintAfter === null || entry.fingerprintBefore === null) {
      return {
        verified: false,
        basis: 'fingerprint_unavailable',
        reason: `The step asserted the structure would ${
          step.expectFingerprintChanged ? 'change' : 'stay the same'
        }, but the sequence could not be fingerprinted ${
          entry.fingerprintBefore === null ? 'before' : 'after'
        } it: ${fingerprintResult?.error || 'no fingerprint returned'}. An assertion that cannot be evaluated counts as failed.`,
      };
    }
    const changed = entry.fingerprintAfter !== entry.fingerprintBefore;
    if (changed !== step.expectFingerprintChanged) {
      return {
        verified: false,
        basis: 'fingerprint',
        reason: `The sequence structure ${changed ? 'changed' : 'did not change'} (${
          entry.fingerprintBefore
        } → ${entry.fingerprintAfter}), but the step asserted it would ${
          step.expectFingerprintChanged ? 'change' : 'stay the same'
        }.`,
      };
    }
    return {
      verified: true,
      basis: 'fingerprint',
      reason: `The sequence structure ${changed ? 'changed' : 'stayed the same'} as asserted (${
        entry.fingerprintBefore
      } → ${entry.fingerprintAfter}).`,
    };
  }

  // 3. The tool's own fail-closed read-back.
  if (result.verified === true) {
    return {
      verified: true,
      basis: 'self_verified',
      reason: 'The tool verified its own effect (verified:true).',
    };
  }
  if (result.verified === false) {
    return {
      verified: false,
      basis: 'self_unverified' as VerificationBasis,
      reason: `The tool explicitly could not verify its own effect (verified:false): ${
        result.error || result.note || 'no reason given'
      }`,
    };
  }

  // 4. Nothing to verify, because nothing was changed.
  if (classification.readOnly) {
    return {
      verified: true,
      basis: 'read_only',
      reason: 'Read-only step: it succeeded and had nothing to verify.',
    };
  }

  // 5. No evidence either way.
  const reason = `The tool returned success but no 'verified' field, and the step declared neither a verify read-back nor expectFingerprintChanged. There is no proof it did what was asked${
    entry.fingerprintChanged === false
      ? ' (the sequence structure did not change, which is expected for effect/property edits and therefore proves nothing)'
      : ''
  }. Add a verify block to make this step checkable.`;
  if (unverifiablePolicy === 'accept') {
    return { verified: null, basis: 'unverifiable_accepted', reason: `${reason} Accepted because unverifiableStep was "accept".` };
  }
  return { verified: false, basis: 'unverifiable', reason };
}

// ── Rollback ───────────────────────────────────────────────────────────────

interface RollbackOutcome {
  verified: boolean;
  restoredSequenceId: string | null;
  restoredName: string | null;
  verification: string;
  replacedOriginal: boolean;
  originalDeleted: boolean;
  errors: string[];
}

/**
 * Put the snapshot back, and only claim to have done so once the restored
 * sequence has been diffed against the snapshot and found identical.
 *
 * Ordering is the safety property: nothing is deleted before the restore has
 * been proven. If the proof fails we stop with both sequences and the checkpoint
 * still present, which is recoverable by hand — the alternative (delete first,
 * verify later) is not.
 */
async function performRollback(
  executor: TransactionExecutor,
  strategy: RollbackStrategy,
  ctx: {
    sequenceId: string;
    sequenceName: string | null;
    checkpointId: string;
    checkpointName: string | null;
  },
  transactionId: string,
): Promise<RollbackOutcome> {
  const errors: string[] = [];
  const restoredTargetName = `${ctx.sequenceName ?? 'sequence'} (rolled back ${transactionId})`;

  let restore: RestoreResult | undefined;
  try {
    restore = await executor.restoreCheckpoint(ctx.checkpointId, restoredTargetName, true);
  } catch (error) {
    errors.push(
      `The restore threw: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!restore || restore.success === false || !restore.restoredSequenceId) {
    errors.push(
      `Restoring the snapshot failed: ${restore?.error || 'no restored sequence id was returned'}.`,
    );
    return {
      verified: false,
      restoredSequenceId: restore?.restoredSequenceId ? String(restore.restoredSequenceId) : null,
      restoredName: restore?.restoredName ?? null,
      verification: 'FAILED: the snapshot could not be cloned back, so no rollback happened.',
      replacedOriginal: false,
      originalDeleted: false,
      errors,
    };
  }
  const restoredId = String(restore.restoredSequenceId);

  // Prove it. A restored sequence has a different NAME from the checkpoint, so
  // the fingerprint (which hashes the name) cannot be compared directly — the
  // clip-level diff is the check that actually means something here.
  let diff: DiffResult | undefined;
  try {
    diff = await executor.diffSequences(ctx.checkpointId, restoredId);
  } catch (error) {
    errors.push(
      `The rollback verification diff threw: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!diff || diff.success === false || diff.identical !== true) {
    errors.push(
      `The restored sequence could not be proven identical to the snapshot: ${
        diff?.error || `${diff?.changeCount ?? 'an unknown number of'} difference(s) found`
      }.`,
    );
    return {
      verified: false,
      restoredSequenceId: restoredId,
      restoredName: restore.restoredName ?? restoredTargetName,
      verification:
        'FAILED: a sequence was cloned from the snapshot but it does not verifiably match the snapshot. Nothing was deleted.',
      replacedOriginal: false,
      originalDeleted: false,
      errors,
    };
  }

  if (strategy !== 'replace_original') {
    return {
      verified: true,
      restoredSequenceId: restoredId,
      restoredName: restore.restoredName ?? restoredTargetName,
      verification: 'VERIFIED: the restored sequence is clip-for-clip identical to the pre-edit snapshot.',
      replacedOriginal: false,
      originalDeleted: false,
      errors,
    };
  }

  // replace_original: only now, with the restore proven, is it safe to remove
  // the half-edited sequence and hand its name to the restored one.
  const del = await executor.deleteSequence(ctx.sequenceId);
  const originalDeleted = !!del && del.success !== false && del.verified !== false;
  if (!originalDeleted) {
    errors.push(
      `The half-edited sequence could not be deleted (${
        del?.error || 'the delete could not be verified'
      }), so the project now holds BOTH it and the verified pre-edit copy.`,
    );
    return {
      verified: true,
      restoredSequenceId: restoredId,
      restoredName: restore.restoredName ?? restoredTargetName,
      verification:
        'VERIFIED restore, INCOMPLETE replace: the pre-edit content is back and proven, but the half-edited sequence could not be removed.',
      replacedOriginal: false,
      originalDeleted: false,
      errors,
    };
  }

  let renamedTo: string | null = restore.restoredName ?? restoredTargetName;
  if (ctx.sequenceName && restore.restoredProjectItemId) {
    const rename = await executor.renameProjectItem(
      String(restore.restoredProjectItemId),
      ctx.sequenceName,
    );
    if (rename && rename.success !== false && rename.verified !== false) {
      renamedTo = ctx.sequenceName;
    } else {
      errors.push(
        `The restored sequence kept the name '${renamedTo}' because the rename to '${ctx.sequenceName}' could not be verified (${
          rename?.error || 'no error message given'
        }).`,
      );
    }
  } else if (!restore.restoredProjectItemId) {
    errors.push(
      'The restored sequence could not be renamed to the original name because the host did not return its project item id.',
    );
  }

  return {
    verified: true,
    restoredSequenceId: restoredId,
    restoredName: renamedTo,
    verification:
      'VERIFIED: the restored sequence is clip-for-clip identical to the pre-edit snapshot, the half-edited sequence was deleted (verified), and the restored one carries the original name. Its sequence ID is NEW.',
    replacedOriginal: true,
    originalDeleted: true,
    errors,
  };
}
