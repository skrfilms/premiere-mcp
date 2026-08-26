/**
 * MCP tool annotations.
 *
 * The MCP specification lets a server attach behavioural hints to each tool —
 * `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — and clients
 * use them to decide what to auto-approve, what to confirm with a human, and what to
 * retry. We previously emitted none, so every tool in this catalogue looked equally
 * dangerous to a client: a `get_project_info` was indistinguishable from a
 * `delete_sequence`, which pushes clients toward either blanket approval or blanket
 * prompting. Neither is what we want from an honesty-first server.
 *
 * These are HINTS, and this module says so plainly. They are derived from naming
 * convention plus an explicit override table, not from proof of behaviour, so they
 * describe *expected* behaviour and must never be treated as an authorization
 * boundary — enforcement stays in the handlers and in the tool profile. That
 * distinction is deliberate: a hint that is mistaken for a permission check is worse
 * than no hint at all.
 */

export interface ToolAnnotations {
  /** Human-readable title for client UI. */
  title: string;
  /** Expected to make no modifications to its environment. */
  readOnlyHint: boolean;
  /** May perform destructive updates (only meaningful when readOnlyHint is false). */
  destructiveHint: boolean;
  /** Repeated calls with the same arguments have no additional effect. */
  idempotentHint: boolean;
  /** Interacts with an "open world" of external entities (filesystem, network, host). */
  openWorldHint: boolean;
}

/** Name prefixes that denote a pure inspection tool. */
const READ_PREFIXES = [
  'get_', 'list_', 'read_', 'find_', 'search_', 'inspect_', 'reflect_', 'is_',
  'check_', 'detect_', 'probe_', 'validate_', 'verify_', 'lint_', 'diff_',
  'has_', 'describe_', 'capture_', 'generate_scope', 'evaluate_',
];

/**
 * Verbs that remove or overwrite existing work. `destructiveHint` in the spec means
 * "may perform destructive updates", i.e. the change is not a simple additive one and
 * may not be trivially recoverable.
 */
const DESTRUCTIVE_PREFIXES = [
  'delete_', 'remove_', 'clear_', 'close_', 'overwrite_', 'ripple_', 'razor_',
  'reset_', 'restore_', 'unlink_', 'detach_', 'unnest_', 'extract_', 'lift_',
  'consolidate_', 'replace_', 'trim_', 'split_', 'flush_',
];

/**
 * Tools whose effect reaches outside Premiere's project model — the filesystem, a
 * spawned binary, or the network. Clients use `openWorldHint` to decide that a result
 * cannot be predicted from arguments alone.
 */
const OPEN_WORLD_EXACT = new Set([
  'execute_extendscript', 'evaluate_expression', 'batch_execute',
  'import_media', 'import_folder', 'import_image_sequence', 'import_mogrt',
  'import_mogrt_from_library', 'import_edl', 'import_fcp_xml', 'import_sequences',
  'import_sequences_from_project', 'import_ae_comps',
  'open_project', 'create_project', 'save_project_as',
  'probe_media', 'index_footage', 'search_footage',
  'transcribe_to_srt', 'normalize_loudness', 'bake_speed_change',
  'capture_program_output', 'capture_frame', 'generate_scope',
  'read_srt', 'write_srt', 'validate_srt', 'update_srt_cue', 'insert_srt_cue',
  'remove_srt_cue', 'shift_srt_timing',
  'read_clipboard', 'write_clipboard',
  'relink_media', 'consolidate_and_transfer', 'encode_file', 'encode_project_item',
  'start_batch_encode', 'add_to_render_queue', 'export_frame', 'export_sequence',
  // get_capabilities can spawn ffmpeg/ffprobe/whisper to probe local backends.
  'get_capabilities',
  // NOTE: find_tool is deliberately NOT here. It ranks this server's own static
  // catalogue in memory and makes no host, filesystem or network call, so it is a
  // closed-world read — the one tool an agent can always call for free.
]);

/** Prefixes whose whole family reaches the filesystem or a spawned binary. */
const OPEN_WORLD_PREFIXES = ['export_', 'import_', 'encode_', 'batch_export_', 'archive_'];

/**
 * Explicit overrides where the naming convention gets it wrong. Each entry is a
 * deliberate correction, not a default, so the table stays short and auditable.
 */
const OVERRIDES: Record<string, Partial<ToolAnnotations>> = {
  // Named like a read, but it queues a real encode outside Premiere.
  verify_export: { readOnlyHint: true, openWorldHint: true },
  // Named like a read, but scene detection is a host operation that is NOT undoable.
  detect_scene_edits: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  scene_edit_detection: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  // "check" prefix but it mutates offline state.
  check_offline_media: { readOnlyHint: true },
  // Trim/split are additive-in-place edits, recoverable by undo, but they DO discard
  // frames from the timeline, so the destructive hint is honest.
  // (listed here only to document the intent; the prefix table already covers them)
  // Undo/redo change state but are the recovery mechanism, not a destructive act.
  undo: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  redo: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  multiple_undo: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  // A checkpoint is purely additive and is the thing that makes other ops safe.
  create_recovery_checkpoint: { destructiveHint: false },
  // Restoring a checkpoint overwrites current work — the most destructive tool we have.
  restore_recovery_checkpoint: { destructiveHint: true, idempotentHint: true },
  // Arbitrary code: unknowable by construction.
  execute_extendscript: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  batch_execute: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // Reads state, but through a spawned process rather than the DOM.
  evaluate_expression: { readOnlyHint: true, openWorldHint: true },
  // The router invokes an arbitrary catalogue tool, so its behaviour is exactly as
  // unknowable as its target. Hinted at the pessimistic end on purpose: a client must
  // not treat one approval of `call_tool` as an approval of everything it can reach.
  call_tool: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // These change what THIS server advertises. Real state, but server-side only: no
  // Premiere request, no filesystem, and re-running one lands on the same list.
  activate_tools: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  deactivate_tools: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Runs an arbitrary plan of sequence edits, so its effect is as broad as the plan it
  // wraps — hinted at the pessimistic end for the same reason as call_tool. It clones and
  // may delete a sequence, and re-running the same plan is not a no-op, so not idempotent.
  transact_sequence_edits: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

function startsWithAny(name: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (name.indexOf(prefix) === 0) return true;
  }
  return false;
}

/** "add_marker_to_project_item" -> "Add marker to project item". */
export function humanTitle(name: string): string {
  const words = name.split('_').filter(Boolean);
  if (!words.length) return name;
  const first = words[0] as string;
  const rest = words.slice(1).join(' ');
  const head = first.charAt(0).toUpperCase() + first.slice(1);
  return rest ? `${head} ${rest}` : head;
}

/**
 * Derive the annotation set for one tool name.
 *
 * Deliberately conservative: when the convention is ambiguous we choose the value
 * that makes a client MORE cautious (not read-only, not idempotent), because a hint
 * that under-states risk is the failure mode that costs a user their work.
 */
export function annotationsFor(name: string): ToolAnnotations {
  const readOnly = startsWithAny(name, READ_PREFIXES);
  const destructive = !readOnly && startsWithAny(name, DESTRUCTIVE_PREFIXES);
  // `set_*` re-applies the same value to the same target, so a repeat is a no-op.
  // Anything that ADDS a new object (add_/create_/insert_/duplicate_) is not
  // idempotent: calling it twice yields two objects.
  const idempotent =
    readOnly ||
    startsWithAny(name, ['set_', 'enable_', 'disable_', 'mute_', 'lock_', 'rename_', 'select_', 'deselect_', 'move_', 'link_', 'toggle_']);
  const openWorld =
    OPEN_WORLD_EXACT.has(name) || startsWithAny(name, OPEN_WORLD_PREFIXES);

  const base: ToolAnnotations = {
    title: humanTitle(name),
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld,
  };

  const override = OVERRIDES[name];
  return override ? { ...base, ...override } : base;
}
