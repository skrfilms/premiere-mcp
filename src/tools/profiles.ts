/**
 * Tool profiles: a curated, env-selected subset of the full catalogue.
 *
 * The server ships 283 tools. That is a feature for power users and a liability
 * for a model with a small tool budget — a large menu dilutes selection accuracy
 * and burns context on schemas the caller will never use. Other MCP servers solve
 * this by exposing a curated default; here the default stays the FULL catalogue
 * (nothing is hidden unless asked for), and curation is strictly opt-in via env.
 *
 * Selection order (later overrides earlier):
 *   1. PREMIERE_MCP_PROFILE  — a named profile below (default: "all").
 *   2. PREMIERE_MCP_TOOLS    — explicit comma/space list; when set it REPLACES the
 *                              profile entirely (an exact allowlist).
 *   3. PREMIERE_MCP_EXCLUDE  — comma/space list removed from whatever the above chose.
 *
 * A profile is matched against a tool name by any of: exact name, a "prefix_*"
 * glob, or a "*" catch-all. `get_capabilities` is always kept so a client can
 * still discover what the running profile exposes even under the tightest set.
 */

export interface ProfileEnv {
  PREMIERE_MCP_PROFILE?: string;
  PREMIERE_MCP_TOOLS?: string;
  PREMIERE_MCP_EXCLUDE?: string;
}

/** Named tool always retained so clients can introspect the active profile. */
export const ALWAYS_KEPT = ['get_capabilities'] as const;

/**
 * Named profiles. Patterns are exact names, "prefix_*" globs, or "*".
 * Kept intentionally small and legible; add tools to a profile by name/glob.
 * `all` is the default and matches everything, so behaviour is unchanged unless
 * a profile is explicitly selected.
 */
export const PROFILES: Record<string, string[]> = {
  // Everything. The default — no curation.
  all: ['*'],

  // Non-mutating introspection only. Safe to point an untrusted agent at.
  'read-only': [
    'get_*', 'list_*', 'read_*', 'find_*', 'search_*', 'inspect_*',
    'is_*', 'check_*', 'detect_*',
  ],

  // The everyday editorial core: sequences, clips, timeline, bins, markers,
  // plus the read tools you need to drive them. Curated by name so it stays a
  // tight, high-signal menu rather than "most of the catalogue".
  core: [
    // discovery / state
    'get_capabilities', 'get_project_info', 'get_active_sequence', 'set_active_sequence',
    'list_sequences', 'list_sequence_tracks', 'list_project_items', 'get_sequence_settings',
    'get_selected_clips', 'get_clip_at_position', 'get_clip_properties', 'get_playhead_position',
    'set_playhead_position', 'find_project_item_by_name', 'search_project_items',
    // project / media
    'create_project', 'open_project', 'save_project', 'save_project_as',
    'import_media', 'import_folder', 'create_bin', 'move_item_to_bin', 'rename_project_item',
    // sequence
    'create_sequence', 'duplicate_sequence', 'delete_sequence', 'set_sequence_settings',
    // recovery boundary — snapshot before risky edits, list, restore
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    // timeline editing
    'add_to_timeline', 'add_to_timeline_batch', 'remove_from_timeline', 'move_clip',
    'trim_clip', 'split_clip', 'razor_timeline_at_time', 'replace_clip', 'duplicate_clip',
    'enable_disable_clip', 'set_clip_properties', 'speed_change', 'add_track', 'delete_track',
    // markers
    'add_marker', 'update_marker', 'delete_marker', 'list_markers',
    // transitions / effects (light)
    'add_transition', 'apply_effect', 'list_available_effects', 'list_available_transitions',
    // export
    'export_frame', 'export_sequence', 'add_to_render_queue', 'get_render_queue_status',
  ],

  // Audio-focused work.
  audio: [
    'get_capabilities', 'get_active_sequence', 'list_sequence_tracks',
    'adjust_audio_levels', 'add_audio_keyframes', 'apply_audio_effect',
    'apply_audio_effect_to_all_clips', 'list_available_audio_effects',
    'list_available_audio_transitions', 'setup_ducking', 'detect_silence',
    'transcribe_to_srt', 'create_caption_track', 'read_sequence_captions',
    'mute_track', 'lock_track', 'link_audio_video', 'link_selection', 'unlink_selection',
  ],

  // Color / grading.
  color: [
    'get_capabilities', 'get_active_sequence', 'get_selected_clips', 'get_clip_properties',
    'color_correct', 'apply_lut', 'apply_effect', 'set_effect_property',
    'get_color_label', 'set_color_label', 'export_frame',
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
  const requested = (env.PREMIERE_MCP_PROFILE || 'all').trim();
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
  for (const name of ALWAYS_KEPT) keep.add(name);
  return tools.filter((tool) => keep.has(tool.name));
}
