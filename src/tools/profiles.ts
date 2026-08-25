/**
 * Tool profiles: a curated, env-selected subset of the full catalogue.
 *
 * The server registers 642 tools. Advertising all of them by default was a bug, not a
 * feature, and it was measured rather than argued:
 *
 *   - all  = 642 tools ≈ 103,500 tokens ≈ 52% of a 200k context window, spent before
 *            the user has said anything.
 *   - core = 101 tools ≈ 11% of the same window.
 *
 * Three independent limits agree that 642 is too many. Anthropic's guidance puts tool
 * selection degradation past roughly 30–50 tools; MCP's own client best-practice doc
 * suggests deferring definitions past 1–5% of context; and VS Code / Copilot HARD-ERRORS
 * above 128 tools, meaning the previous default could not run there at all.
 *
 * So the default is now `core`. Nothing is lost, and nothing is hidden silently: both
 * `get_capabilities` and `find_tool` are always kept, and `find_tool` reports a
 * profile-hidden match as `exposed: false` WITH the reason rather than omitting it — so
 * an agent can always discover a capability it cannot currently call, and is told how to
 * widen. That distinction is the whole reason curation is safe here; without it a curated
 * deployment would be indistinguishable from a build where the feature was never written,
 * which is the same class of lie as a fake success.
 *
 * Set PREMIERE_MCP_PROFILE=all for the full catalogue.
 *
 * Curation bounds what is ADVERTISED. It is not, by itself, what is REACHABLE: a cost
 * profile can be routed past via `call_tool`, and tools can be promoted into the
 * advertised list at runtime by `activate_tools`. See router.ts — including which
 * profiles are authority boundaries the router refuses to cross.
 *
 * Selection order (later overrides earlier):
 *   1. PREMIERE_MCP_PROFILE  — a named profile below (default: "core").
 *   2. PREMIERE_MCP_TOOLS    — explicit comma/space list; when set it REPLACES the
 *                              profile entirely (an exact allowlist).
 *   3. PREMIERE_MCP_EXCLUDE  — comma/space list removed from whatever the above chose.
 *
 * A profile is matched against a tool name by any of: exact name, a "prefix_*"
 * glob, or a "*" catch-all.
 */

export interface ProfileEnv {
  PREMIERE_MCP_PROFILE?: string;
  PREMIERE_MCP_TOOLS?: string;
  PREMIERE_MCP_EXCLUDE?: string;
}

/**
 * Named tools always retained so a client can introspect the active profile and
 * still search the catalogue under the tightest set. `find_tool` is kept because
 * curation is only safe if the agent can discover what curation removed — it
 * reports profile-hidden matches as `exposed: false` rather than hiding them.
 */
export const ALWAYS_KEPT = [
  'get_capabilities',
  'find_tool',
  // The schema-on-demand loop. find_tool alone could only ever say "that capability
  // exists and you cannot call it"; these three make the rest of the catalogue
  // reachable without advertising it. Keeping them under every profile is what lets a
  // curated deployment be a context-cost decision rather than a functional downgrade.
  // Each one still refuses to cross an authority boundary — see router.ts.
  'get_tool_typings',
  'call_tool',
  'activate_tools',
  'deactivate_tools',
] as const;

/**
 * Profiles that exist to bound AUTHORITY rather than context cost.
 *
 * `call_tool` will not route past these, and `activate_tools` will not promote a tool
 * they exclude. Everything else (core, audio, color) is a menu-size decision that the
 * router may reach past, because trimming a menu to fit a context window was never a
 * statement about what the deployment is allowed to do.
 */
export const AUTHORITY_PROFILES = new Set<string>(['read-only']);

/**
 * Named profiles. Patterns are exact names, "prefix_*" globs, or "*".
 * Kept intentionally small and legible; add tools to a profile by name/glob.
 * `core` is the default; `all` matches everything and is one env var away.
 */
export const PROFILES: Record<string, string[]> = {
  // Everything, no curation. Opt in with PREMIERE_MCP_PROFILE=all; note that this
  // exceeds VS Code / Copilot's 128-tool ceiling and costs ~51% of a 200k context.
  all: ['*'],

  // Non-mutating introspection only. Safe to point an untrusted agent at.
  'read-only': [
    'get_*', 'list_*', 'read_*', 'find_*', 'search_*', 'inspect_*', 'reflect_*',
    'is_*', 'check_*', 'detect_*',
    // non-mutating media analysis that doesn't fit the verb-prefix globs
    'probe_media', 'capture_program_output', 'lint_timeline', 'diff_sequences',
    'index_footage', 'search_footage',
    // offline caption reading/QC on the .srt file (Premiere's DOM cannot read captions)
    'read_srt', 'validate_srt',
  ],

  // The everyday editorial core: sequences, clips, timeline, bins, markers,
  // plus the read tools you need to drive them. Curated by name so it stays a
  // tight, high-signal menu rather than "most of the catalogue".
  core: [
    // discovery / state
    'get_capabilities', 'get_project_info', 'get_active_sequence', 'set_active_sequence',
    'list_sequences', 'list_sequence_tracks', 'list_project_items', 'get_sequence_settings',
    'get_selected_clips', 'get_clip_at_position', 'get_clip_properties', 'get_playhead_position',
    'lint_timeline',
    'set_playhead_position', 'find_project_item_by_name', 'search_project_items',
    // project / media
    'create_project', 'open_project', 'save_project', 'save_project_as',
    'import_media', 'import_folder', 'create_bin', 'move_item_to_bin', 'rename_project_item',
    // offline footage discovery: index media on disk, then find it before importing
    'index_footage', 'search_footage',
    // sequence
    'create_sequence', 'duplicate_sequence', 'delete_sequence', 'set_sequence_settings',
    // recovery boundary — snapshot before risky edits, list, restore
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    // timeline editing
    'add_to_timeline', 'add_to_timeline_batch', 'remove_from_timeline', 'move_clip',
    'trim_clip', 'split_clip', 'razor_timeline_at_time', 'replace_clip', 'duplicate_clip',
    'enable_disable_clip', 'set_clip_properties', 'speed_change', 'add_track', 'delete_track',
    // honest time-remap escape hatch: bake a constant-speed clip with ffmpeg
    'bake_speed_change',
    // markers
    'add_marker', 'update_marker', 'delete_marker', 'list_markers',
    // transitions / effects. apply_effect WITHOUT set_effect_property was incoherent:
    // an agent could add Gaussian Blur and then had no way to set its blurriness, so
    // the default forced a profile switch on the second call.
    'add_transition', 'apply_effect', 'list_available_effects', 'list_available_transitions',
    'set_effect_property', 'get_effect_properties', 'list_clip_effects', 'remove_effect',
    // keyframes. bake_keyframe_ease shipped in core while add_keyframe did not — the
    // ease-baker was reachable but nothing could create the keyframes it eases.
    'add_keyframe', 'remove_keyframe', 'get_keyframes', 'set_keyframe_interpolation',
    // eased scalar animation (fades/scale/rotation), baked with verifiable values
    'bake_keyframe_ease',
    // transform: the four properties an editor actually reaches for
    'set_clip_scale', 'set_clip_position', 'set_clip_rotation', 'set_clip_opacity',
    // colour, at the reliable entry point (applyLumetriPreset is fingerprint-verified)
    'apply_lumetri_preset', 'list_lumetri_presets',
    // audio basics. A default editorial profile with no level control is not editorial;
    // the deeper repair/loudness set stays in the audio profile.
    'set_clip_volume', 'adjust_audio_levels',
    // tracks
    'mute_track', 'lock_track', 'toggle_track_visibility',
    // selection primitives — get_selected_clips alone left nothing able to SET a selection
    'set_clip_selection', 'select_clips_by_name', 'deselect_all_clips',
    // undo/redo. Their absence was the single most surprising gap in an editing default.
    'undo', 'redo',
    // structure at a glance, and the in/out range everything downstream reads
    'get_sequence_structure', 'get_timeline_summary', 'get_timeline_gaps',
    'set_sequence_in_out_points', 'get_sequence_in_out_points',
    // media health: the questions asked before every session
    'check_offline_media', 'relink_media', 'probe_media', 'verify_premiere_connection',
    // export
    'export_frame', 'export_sequence', 'add_to_render_queue', 'get_render_queue_status',
    // render-truth: capture the composited Program frame for the feedback loop
    'capture_program_output',
  ],

  // Audio-focused work.
  audio: [
    'get_capabilities', 'get_active_sequence', 'list_sequence_tracks',
    'adjust_audio_levels', 'add_audio_keyframes', 'apply_audio_effect',
    'apply_audio_effect_to_all_clips', 'list_available_audio_effects',
    'list_available_audio_transitions', 'setup_ducking', 'detect_silence',
    'transcribe_to_srt', 'create_caption_track', 'read_sequence_captions',
    // SRT subtitle CRUD on disk — read/validate/write/edit captions before ingest
    'read_srt', 'validate_srt', 'write_srt',
    'update_srt_cue', 'insert_srt_cue', 'remove_srt_cue', 'shift_srt_timing',
    'mute_track', 'lock_track', 'link_audio_video', 'link_selection', 'unlink_selection',
    // loudness delivery spec (EBU R128) via ffmpeg two-pass loudnorm
    'normalize_loudness',
  ],

  // Color / grading.
  color: [
    'get_capabilities', 'get_active_sequence', 'get_selected_clips', 'get_clip_properties',
    'color_correct', 'apply_lut', 'apply_effect', 'set_effect_property',
    'get_color_label', 'set_color_label', 'export_frame',
    // QC: ground-truth metadata, signal scopes, and the composited frame for grade checks
    'probe_media', 'generate_scope', 'capture_program_output',
  ],
};

const WORDS = /[\s,]+/;

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(WORDS).map((entry) => entry.trim()).filter(Boolean);
}

/** True when `name` matches a single pattern (exact, "prefix_*", or "*"). */
export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function matchesAny(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchesPattern(name, pattern)) return true;
  }
  return false;
}

export interface ProfileResolution {
  /** The names selected before ALWAYS_KEPT is folded in. */
  selected: string[];
  /** How the selection was made, for get_capabilities / logs. */
  source: 'all' | 'profile' | 'explicit';
  profileName: string | null;
  excluded: string[];
  /** Names in PREMIERE_MCP_TOOLS / PREMIERE_MCP_PROFILE that matched nothing. */
  unknown: string[];
}

/**
 * Resolve which of `allNames` the active profile exposes, and describe how.
 * Pure and deterministic; `env` defaults to process.env so callers can inject
 * a fixture in tests.
 */
export function resolveProfile(
  allNames: string[],
  env: ProfileEnv = process.env as ProfileEnv,
): ProfileResolution {
  const exclude = parseList(env.PREMIERE_MCP_EXCLUDE);
  const explicit = parseList(env.PREMIERE_MCP_TOOLS);

  const known = new Set(allNames);
  const applyExclude = (names: string[]): string[] =>
    exclude.length ? names.filter((name) => !matchesAny(name, exclude)) : names;

  // 2. Explicit allowlist wins over any profile.
  if (explicit.length) {
    const selected = allNames.filter((name) => matchesAny(name, explicit));
    const unknown = explicit.filter(
      (pattern) => !allNames.some((name) => matchesPattern(name, pattern)),
    );
    return {
      selected: applyExclude(selected),
      source: 'explicit',
      profileName: null,
      excluded: exclude,
      unknown,
    };
  }

  // 1. Named profile (default "all").
  const requested = (env.PREMIERE_MCP_PROFILE || 'core').trim();
  const patterns = PROFILES[requested];
  if (!patterns) {
    // Unknown profile name: fail safe to the full catalogue rather than an
    // empty server, but report the miss so it is visible in capabilities/logs.
    return {
      selected: applyExclude(allNames.slice()),
      source: 'all',
      profileName: null,
      excluded: exclude,
      unknown: [requested],
    };
  }

  const selected = allNames.filter((name) => matchesAny(name, patterns));
  // Profile patterns that reference a name we don't have (typo / renamed tool).
  const unknown = patterns
    .filter((p) => !p.endsWith('*') && p !== '*' && !known.has(p));

  return {
    selected: applyExclude(selected),
    source: requested === 'all' ? 'all' : 'profile',
    profileName: requested === 'all' ? null : requested,
    excluded: exclude,
    unknown,
  };
}

/**
 * ALWAYS_KEPT members that YIELD to an explicit exclusion.
 *
 * `get_capabilities` and `find_tool` are read-only introspection and are kept even when
 * an exclusion names them, because losing them makes a curated build indistinguishable
 * from a build missing the feature. The routing trio is different: it is the mechanism
 * that reaches past the advertised list, so an operator who excludes it plainly means
 * "no router here". Forcing it back would be an operator veto that silently did nothing
 * — the same class of dishonesty as a fake success, and worse here because it concerns
 * what the deployment can reach.
 */
export const YIELDS_TO_EXCLUSION = new Set<string>(['call_tool', 'activate_tools', 'deactivate_tools']);

/**
 * Filter a tool list by the active profile. `get_capabilities` (ALWAYS_KEPT) is
 * always retained. Order of the input list is preserved.
 */
export function applyProfile<T extends { name: string }>(
  tools: T[],
  env: ProfileEnv = process.env as ProfileEnv,
): T[] {
  const resolution = resolveProfile(tools.map((tool) => tool.name), env);
  if (resolution.source === 'all' && resolution.excluded.length === 0) {
    return tools; // fast path: unchanged default
  }
  const keep = new Set(resolution.selected);
  for (const name of ALWAYS_KEPT) {
    if (
      YIELDS_TO_EXCLUSION.has(name) &&
      resolution.excluded.some((pattern) => matchesPattern(name, pattern))
    ) {
      continue;
    }
    keep.add(name);
  }
  return tools.filter((tool) => keep.has(tool.name));
}
