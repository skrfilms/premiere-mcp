/**
 * Tool profiles: a curated, env-selected subset of the full catalogue.
 *
 * Advertising the whole catalogue by default was a bug, not a feature, and it was
 * measured rather than argued: the full list costs about half of a 200k context window
 * before the user has said anything, while `core` costs roughly a tenth of it. Every
 * number in this file lives in `BUNDLE_BUDGETS` below and is re-measured by
 * `src/__tests__/tools/task-bundles.test.ts`, so a figure here cannot drift silently —
 * which is why no count is written into the prose.
 *
 * Three independent limits agree that the full catalogue is too many. Anthropic's guidance puts tool
 * selection degradation past roughly 30–50 tools; MCP's own client best-practice doc
 * suggests deferring definitions past 1–5% of context; and VS Code / Copilot HARD-ERRORS
 * above 128 tools, meaning the previous default could not run there at all.
 *
 * TWO KINDS OF SELECTION LIVE HERE, and conflating them is what made the first round of
 * curation awkward to use:
 *
 *   - SIZE-SHAPED profiles (`core`, `read-only`, `audio`, `color`) answer "how big a menu
 *     can this client afford?". They are cross-sections of the catalogue.
 *   - TASK BUNDLES (`task-*`, below) answer the question an editor actually asks: "cut
 *     this dialogue", "conform and deliver", "caption this", "grade these shots", "build
 *     a rough cut". A bundle carries the tools one task genuinely needs *including its
 *     verification tools*, so the first call cannot force a profile switch. That mistake
 *     was already made once: `apply_effect` shipped in `core` without
 *     `set_effect_property`, so an agent could add Gaussian Blur and then had no way to
 *     set its blurriness. `BUNDLE_REQUIREMENTS` encodes that class of pairing as a
 *     testable rule rather than a thing to remember.
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
  // get_recent_calls / start_job / get_job / list_jobs are NOT here: four more always-on tools
  // would push every task bundle past the ~50-tool selection guidance. They are in `core`, and
  // the server instructions name them, so under a task bundle they are one call_tool away.
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
 * TASK BUNDLES — the menu shaped like the request, not like the catalogue.
 *
 * Each bundle is the tool set for ONE editorial task, and each deliberately includes:
 *
 *   1. the orientation reads that must happen before the first mutation,
 *   2. the mutating tools the task needs,
 *   3. the VERIFICATION tools that close the loop (readback, lint, scope, pixel check) —
 *      a bundle that can perform an edit but not prove it happened is worse than useless
 *      on a server whose whole claim is fail-closed verification,
 *   4. the recovery path (`create_recovery_checkpoint` / `restore_recovery_checkpoint` /
 *      `undo`), because the honest response to a `verified:false` is usually to roll back.
 *
 * Rules followed when composing these, all of them learned the expensive way:
 *
 *   - EXACT NAMES ONLY, no globs. A glob makes a bundle's size and content drift as the
 *     catalogue grows, which would make the measured budget below a lie.
 *   - No tool that is known-broken on the verified host build (Premiere 26.3.2). A bundle
 *     is a recommendation; recommending `audio_crossfade_at_cut` ("Invalid parameter" on
 *     26.3.2) or `match_shot_color` (the run of 2026-08-24 lists it as a suspected engine
 *     killer, never cleared) would spend an agent's first call on a known failure. Both
 *     remain in the catalogue, findable by `find_tool` and callable via `call_tool`; they
 *     are simply not what a fresh agent should be handed first.
 *   - EVERY bundle carries the same four orientation tools —
 *     `verify_premiere_connection`, `get_project_info`, `list_sequences`,
 *     `get_active_sequence`. Every MCP prompt in this build opens with exactly that step,
 *     and a bundle that cannot complete step one is a bundle that fails on its first call.
 *   - Nothing here bounds AUTHORITY. A bundle is a cost curation, so `call_tool` still
 *     reaches the rest of the catalogue (see router.ts) and `activate_tools` can promote
 *     any tool into the advertised list mid-session.
 */
export const TASK_BUNDLES: Record<string, string[]> = {
  // "I just connected — what is here, and can I make one safe edit?"
  // The cheapest bundle, and the one the first-90-seconds path in
  // `premiere://recipes/first-90-seconds` is written against: connect, orient, place a
  // marker, read it back, undo it.
  'task-orient': [
    'ping', 'verify_premiere_connection', 'get_premiere_state', 'honesty_selftest',
    'get_project_info', 'list_sequences', 'get_active_sequence', 'set_active_sequence',
    'get_timeline_summary', 'get_sequence_structure', 'list_sequence_tracks',
    'list_project_items', 'get_playhead_position', 'set_playhead_position',
    'check_offline_media', 'lint_timeline',
    // the one small verified edit, its readback, and the way back out
    'add_marker', 'list_markers', 'delete_marker', 'undo',
  ],

  // "Build me a rough cut from this footage."
  'task-rough-cut': [
    // find the material before importing it — importing everything is the usual mistake
    'index_footage', 'search_footage', 'probe_media',
    'import_media', 'import_folder', 'list_project_items', 'get_project_item_info',
    'find_project_item_by_name', 'search_project_items',
    'create_bin', 'move_items_to_bin', 'rename_project_item', 'set_color_label',
    'verify_premiere_connection', 'get_project_info',
    'create_sequence', 'get_sequence_settings', 'list_sequences', 'get_active_sequence',
    'set_active_sequence',
    // one batch call, not one call per clip
    'add_to_timeline_batch', 'add_to_timeline', 'three_point_edit',
    'move_clip', 'trim_clip', 'split_clip', 'razor_timeline_at_time',
    'ripple_delete', 'remove_from_timeline',
    'add_marker', 'list_markers',
    // proof
    'lint_timeline', 'get_timeline_gaps', 'get_timeline_summary', 'get_sequence_structure',
    'get_sequence_duration', 'capture_program_output',
    // recovery + persistence
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    'undo', 'save_project',
  ],

  // "Cut this dialogue." Silence removal, trims, and the audio smoothing that follows.
  'task-cut-dialogue': [
    'verify_premiere_connection', 'get_project_info', 'list_sequences',
    'get_active_sequence', 'list_sequence_tracks',
    'get_timeline_summary', 'get_selected_clips',
    'get_clip_at_position', 'get_clip_properties', 'get_playhead_position',
    'set_playhead_position',
    // measure the dead air rather than guessing at it
    'detect_silence', 'loudness_report',
    // the cut itself. razor_timeline_at_time cuts every track in one pass; a per-clip
    // loop drifts out of alignment across tracks.
    'razor_timeline_at_time', 'split_clip', 'ripple_delete', 'remove_from_timeline',
    'trim_clip', 'ripple_trim_in', 'ripple_trim_out', 'roll_edit', 'slip_edit',
    'move_clip', 'close_gap_at', 'close_all_gaps', 'l_cut', 'j_cut',
    // smoothing. audio_crossfade_at_cut is deliberately absent (see the note above);
    // add_transition with an audio crossfade is the route that works on 26.3.2.
    'add_transition', 'list_available_transitions', 'list_available_audio_transitions',
    'fade_in_audio', 'fade_out_audio',
    'set_clip_volume', 'adjust_audio_levels',
    // proof
    'lint_timeline', 'get_timeline_gaps', 'get_sequence_duration',
    'assert_clips_unchanged', 'capture_program_output',
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    'undo', 'redo',
  ],

  // "Caption this." Note the shape: Premiere can INGEST an .srt but exposes no caption
  // update/delete API, so the whole editing loop is on the file on disk. A bundle without
  // the srt family would strand an agent after its first transcription.
  'task-caption': [
    'verify_premiere_connection', 'get_project_info', 'list_sequences',
    'get_active_sequence', 'list_sequence_tracks',
    'get_sequence_duration', 'probe_media',
    'transcribe_to_srt', 'captions_from_transcript_json',
    'read_srt', 'validate_srt', 'write_srt', 'update_srt_cue', 'insert_srt_cue',
    'remove_srt_cue', 'shift_srt_timing', 'srt_diff',
    'create_caption_track', 'read_sequence_captions', 'export_captions_to_srt',
    'caption_qc_report', 'caption_qc_fix', 'captions_to_markers',
    'lint_timeline', 'capture_program_output',
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    'undo',
  ],

  // "Grade these shots." Numeric Lumetri, read back, then propagated.
  'task-grade': [
    'verify_premiere_connection', 'get_project_info', 'list_sequences',
    'get_active_sequence', 'get_selected_clips', 'set_clip_selection', 'select_clips_by_name',
    'get_clip_properties', 'get_clip_at_position', 'set_playhead_position',
    // ground truth before treatment
    'probe_media', 'get_color_space', 'get_clip_color_space', 'get_footage_interpretation',
    // attach, then set numerically
    'apply_lumetri_preset', 'list_lumetri_presets', 'get_lumetri_preset_list', 'apply_lut',
    'apply_effect', 'set_effect_property', 'get_effect_properties', 'list_clip_effects',
    'remove_effect',
    'lumetri_basic_set', 'lumetri_creative_set', 'lumetri_vignette_set',
    'lumetri_hsl_secondary_set', 'color_correct', 'auto_white_balance',
    // read back — setValue clamps silently, so lumetri_report is how you learn a value
    // was rejected
    'lumetri_report', 'grade_snapshot', 'verify_color_grade',
    'copy_grade', 'paste_grade_to_clips',
    // measure the signal, then look at the actual composited pixels
    'generate_scope', 'false_color_frame', 'broadcast_safe_check',
    'capture_program_output', 'export_frame',
    'set_color_label',
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    'undo',
  ],

  // "Animate this / dial in an effect." The bundle that the apply-without-set-property
  // bug came from, so both halves of every pair are here on purpose.
  'task-motion': [
    'verify_premiere_connection', 'get_project_info', 'list_sequences',
    'get_active_sequence', 'get_selected_clips', 'get_clip_at_position',
    'get_clip_properties', 'set_playhead_position',
    'apply_effect', 'apply_video_effect', 'list_available_effects',
    'set_effect_property', 'get_effect_properties', 'list_clip_effects',
    'effect_stack_report', 'remove_effect', 'enable_disable_effect',
    'copy_effects_between_clips',
    'add_keyframe', 'get_keyframes', 'remove_keyframe', 'remove_keyframe_range',
    'set_keyframe_interpolation', 'bake_keyframe_ease', 'find_keyframe_near_time',
    'get_value_at_time',
    'set_clip_scale', 'set_clip_position', 'set_clip_rotation', 'set_clip_opacity',
    'set_clip_anchor_point', 'reset_transform', 'set_blend_mode',
    'fade_in_video', 'fade_out_video', 'ken_burns',
    // proof: the DOM says the property changed; these say the frame did
    'verify_effect_rendered', 'verify_clip_visible', 'capture_program_output', 'export_frame',
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    'undo',
  ],

  // "Conform and deliver." Settings first, media health second, QC third, and the file
  // is not delivered until ffprobe agrees it matches the sequence.
  'task-conform-deliver': [
    'verify_premiere_connection', 'get_project_info',
    'get_active_sequence', 'list_sequences', 'get_sequence_settings',
    'get_sequence_duration', 'get_sequence_structure',
    'detect_settings_mismatch', 'conform_sequence_settings', 'set_sequence_settings',
    'set_sequence_resolution', 'set_sequence_frame_rate',
    'get_footage_interpretation', 'set_footage_interpretation',
    'check_offline_media', 'get_offline_media', 'relink_media', 'verify_media_online',
    'probe_media',
    'validate_project_for_export', 'lint_timeline', 'get_timeline_gaps', 'delivery_qc',
    'broadcast_safe_check', 'safe_area_check', 'black_frame_scan', 'flash_frame_scan',
    'loudness_report', 'normalize_loudness',
    // a conform rewrites sequence settings, so the safest first move is a copy of the
    // master; the social/cutdown prompt opens with exactly this call
    'duplicate_sequence',
    'list_export_presets', 'create_custom_export_preset', 'export_sequence',
    'add_to_render_queue', 'get_render_queue_status',
    'get_export_progress',
    'verify_export', 'verify_export_file', 'capture_program_output',
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    'undo', 'save_project',
  ],

  // "Turn these notes into markers / cut me a review reel." The round trip between a
  // review tool and the timeline, in both directions.
  'task-review-notes': [
    'verify_premiere_connection', 'get_project_info',
    'get_active_sequence', 'list_sequences', 'get_timeline_summary',
    'notes_to_markers', 'markers_from_csv', 'frame_io_notes_to_markers',
    'markers_to_csv', 'markers_to_notes',
    'add_marker', 'update_marker', 'delete_marker', 'list_markers', 'get_all_markers',
    'get_sequence_markers_by_type', 'set_marker_type', 'captions_to_markers',
    'chapter_markers_to_youtube', 'todo_marker_report',
    'create_subclips_from_markers', 'marker_to_subclip', 'export_per_marker_range',
    'assemble_review_reel', 'sequence_thumbnail_strip',
    'lint_timeline', 'capture_program_output',
    'create_recovery_checkpoint', 'list_recovery_checkpoints', 'restore_recovery_checkpoint',
    'undo', 'save_project',
  ],
};

/**
 * Self-sufficiency rules: "if a selection advertises X, it must also advertise Y".
 *
 * These are not style preferences. Each one is a place where advertising half a pair
 * forces a profile switch, a guess, or an unverifiable claim on the very next call.
 * `src/__tests__/tools/task-bundles.test.ts` enforces them across every named profile,
 * so the `apply_effect`-without-`set_effect_property` shape of bug cannot come back in a
 * new bundle written by someone who never read this file.
 */
export const BUNDLE_REQUIREMENTS: Array<{ needs: string; alsoNeeds: string[]; why: string }> = [
  {
    needs: 'apply_effect',
    alsoNeeds: ['set_effect_property', 'get_effect_properties'],
    why: 'Adding an effect with no way to set or read its parameters is a dead end — the original curation bug.',
  },
  {
    needs: 'apply_video_effect',
    alsoNeeds: ['set_effect_property', 'get_effect_properties'],
    why: 'Same pairing as apply_effect: the QE add path still needs the parameter setter and its readback.',
  },
  {
    needs: 'add_keyframe',
    alsoNeeds: ['get_keyframes', 'set_keyframe_interpolation', 'bake_keyframe_ease'],
    why: 'Keyframes without readback are unverifiable, and without easing every move is a linear ramp.',
  },
  {
    needs: 'bake_keyframe_ease',
    alsoNeeds: ['add_keyframe', 'get_keyframes'],
    why: 'The ease baker shipped in core while add_keyframe did not: nothing could create the keyframes it eases.',
  },
  {
    needs: 'apply_lumetri_preset',
    alsoNeeds: ['lumetri_report'],
    why: 'Lumetri setValue clamps silently. lumetri_report is how an agent learns a value was rejected.',
  },
  {
    needs: 'lumetri_basic_set',
    alsoNeeds: ['lumetri_report'],
    why: 'Same reason: a numeric grade with no readback cannot be reported as verified.',
  },
  {
    needs: 'copy_grade',
    alsoNeeds: ['paste_grade_to_clips'],
    why: 'A copied grade with nowhere to paste it is half a workflow.',
  },
  {
    needs: 'apply_lut',
    alsoNeeds: ['verify_color_grade'],
    why: 'A LUT changes pixels, not a readable numeric parameter; verification has to come from the grade check.',
  },
  {
    needs: 'transcribe_to_srt',
    alsoNeeds: ['read_srt', 'validate_srt'],
    why: 'A transcript nobody reads back is unverified, and malformed cue timing only shows up in validation.',
  },
  {
    needs: 'write_srt',
    alsoNeeds: ['read_srt', 'validate_srt'],
    why: 'Caption editing happens on the file on disk; writing without validating ingests broken cues.',
  },
  {
    needs: 'create_caption_track',
    alsoNeeds: ['read_sequence_captions'],
    why: 'Ingest is the one caption operation Premiere exposes; reading the track back is the only proof it landed.',
  },
  {
    needs: 'export_sequence',
    alsoNeeds: ['verify_export'],
    why: 'An export is not delivered until ffprobe agrees its duration/fps/codec match the sequence.',
  },
  {
    needs: 'normalize_loudness',
    alsoNeeds: ['loudness_report'],
    why: 'A loudness target with no measurement is a claim, not a delivery spec.',
  },
  {
    needs: 'relink_media',
    alsoNeeds: ['check_offline_media'],
    why: 'Relinking without re-checking offline status is how an agent reports a fix it did not make.',
  },
  {
    needs: 'conform_sequence_settings',
    alsoNeeds: ['detect_settings_mismatch', 'get_sequence_settings'],
    why: 'Conform blind and you may "fix" settings that were already right, with no before/after to show.',
  },
  {
    needs: 'add_to_timeline_batch',
    alsoNeeds: ['lint_timeline'],
    why: 'Batch placement is exactly where gaps and overlaps appear; lint is the cheap proof it did not.',
  },
  {
    needs: 'add_transition',
    alsoNeeds: ['list_available_transitions'],
    why: 'Transitions are addressed by name and the names vary by build, so the list call is not optional.',
  },
  {
    needs: 'ripple_delete',
    alsoNeeds: ['get_timeline_gaps', 'lint_timeline'],
    why: 'Ripple edits move everything downstream; a gap check is how an agent proves sync survived.',
  },
  {
    needs: 'add_marker',
    alsoNeeds: ['list_markers'],
    why: 'Markers are the cheapest verified edit on this server — but only if the readback is in the same bundle.',
  },
  {
    needs: 'create_recovery_checkpoint',
    alsoNeeds: ['list_recovery_checkpoints', 'restore_recovery_checkpoint'],
    why: 'A snapshot with no restore path is theatre: it looks like safety and cannot undo anything.',
  },
  {
    needs: 'speed_change',
    alsoNeeds: ['verify_speed_duration'],
    why: 'Speed changes are QE-backed and fragile per build; the duration check is what distinguishes done from claimed.',
  },
];

/**
 * MEASURED context cost per curated selection. Advertised list = the profile's own tools
 * PLUS `ALWAYS_KEPT`, because that is what the client is actually billed for.
 *
 * Measured with the same code path `get_capabilities` publishes
 * (`PremiereProTools.measureCatalogueCost`, chars/4 estimate) on 2026-08-25 against this
 * build. `task-bundles.test.ts` re-measures and fails if a count moves or an estimate
 * drifts more than the stated tolerance — the tolerance exists because a sibling editing
 * one tool's *description* legitimately shifts the estimate by a few hundred characters,
 * while adding or dropping a tool changes the count and must be re-measured deliberately.
 *
 * `read-only`, `audio`, `color` and `all` are intentionally absent: they use globs (or
 * everything), so their size is a function of the catalogue rather than of a decision
 * made here, and a pinned number for them would be stale the moment a tool is added.
 */
export const BUNDLE_BUDGETS: Record<string, { tools: number; approxTokens: number }> = {
  // the everyday editorial default: broad, and the only curated selection past the
  // ~50-tool mark where Anthropic reports selection accuracy starting to slip
  core: { tools: 112, approxTokens: 23683 },
  // every task bundle stays under 50 advertised tools and under ~5.5% of a 200k window,
  // which puts all of them inside published guidance and far under Copilot's 128 ceiling
  'task-orient': { tools: 26, approxTokens: 4757 },
  'task-rough-cut': { tools: 48, approxTokens: 10961 },
  'task-cut-dialogue': { tools: 50, approxTokens: 9401 },
  'task-caption': { tools: 35, approxTokens: 8475 },
  'task-grade': { tools: 50, approxTokens: 10364 },
  'task-motion': { tools: 50, approxTokens: 10768 },
  'task-conform-deliver': { tools: 50, approxTokens: 9983 },
  'task-review-notes': { tools: 38, approxTokens: 7664 },
};

/** Tolerance for the token ESTIMATE, not the tool count. See BUNDLE_BUDGETS. */
export const BUNDLE_BUDGET_TOLERANCE = 0.15;

/**
 * Named profiles. Patterns are exact names, "prefix_*" globs, or "*".
 * Kept intentionally small and legible; add tools to a profile by name/glob.
 * `core` is the default; `all` matches everything and is one env var away.
 * The `task-*` entries come from TASK_BUNDLES above.
 */
export const PROFILES: Record<string, string[]> = {
  ...TASK_BUNDLES,
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
    // safety under timeouts: "did my last call run?" and background jobs for slow tools
    'get_recent_calls', 'start_job', 'get_job', 'list_jobs', 'revert_last_call', 'what_changed',
    'get_project_notes', 'add_project_note',
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
    // speed_change is QE-backed and fragile per build; without the duration check an
    // agent can only report that the call returned, not that the clip retimed.
    'verify_speed_duration',
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
    // colour, at the reliable entry point (applyLumetriPreset is fingerprint-verified).
    // lumetri_report ships alongside it because Lumetri's setValue clamps silently: the
    // readback is the only way to learn a value was rejected.
    'apply_lumetri_preset', 'list_lumetri_presets', 'lumetri_report',
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
    // export. verify_export is not optional: an export nobody probed is a claim, and
    // shipping export_sequence without it repeated the apply-without-set-property mistake
    // in the one place a wrong answer reaches a client.
    'export_frame', 'export_sequence', 'verify_export',
    'add_to_render_queue', 'get_render_queue_status',
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
    // loudness delivery spec (EBU R128) via ffmpeg two-pass loudnorm, plus the
    // measurement that makes the target checkable instead of asserted
    'normalize_loudness', 'loudness_report',
  ],

  // Color / grading.
  color: [
    'get_capabilities', 'get_active_sequence', 'get_selected_clips', 'get_clip_properties',
    'color_correct', 'apply_lut', 'apply_effect', 'set_effect_property',
    // a LUT changes pixels rather than a readable numeric parameter, so the grade check
    // is the only verification available; get_effect_properties reads the rest back
    'verify_color_grade', 'get_effect_properties',
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
