# Trowel Tool Catalogue — The Road to 600

**Goal:** every function an editor performs in Premiere Pro, callable through this MCP —
the most capable, most cohesive, most flexible Premiere MCP on the market.

**Current:** 309 tools shipped. **This draft proposes 302 new tools → 611 total.**

**The contract (cohesion):** every mutating tool verifies its effect (readback,
fingerprint, file-on-disk, or pixel) or returns `verified:false` explicitly. No tool
ever reports `success:true` for an operation that silently did nothing. This is the
moat — competitors call blindly; we prove.

---

## Legend

**Surface** (how the tool is implemented):
| Code | Meaning | Risk |
|---|---|---|
| DOM | Official ExtendScript API | Stable (frozen at 23.0) |
| QE | Undocumented QE DOM (`app.enableQE()`) | Fragile per-build; MUST fingerprint-verify |
| AME | Adobe Media Encoder via `launchEncoder`/batch | Stable |
| FF | ffmpeg sidecar (analysis or bake) | Fully under our control |
| FILE | Direct file read/write (.srt, .prfpset, .prproj XML, .csv, .json) | Fully under our control |
| BR | Bridge/Node-side logic composing other tools | Fully under our control |
| PX | Render-truth: capture frame(s) and verify pixels | Our headline differentiator |

**Verify** (how success is proven): `readback` (DOM getter), `fingerprint` (component/
structure list before/after), `file` (exists + probe), `pixel` (rendered frame check),
`computed` (deterministic local computation — nothing to lie about).

**Tier:** T1 = build first (high value, low risk) · T2 = second wave · T3 = ambitious /
research needed.

---

## 1. Playback, Navigation & Monitors — 12 new

Covered already: `play_timeline`, `stop_playback`, `set_playhead_position`,
`get_playhead_position`, `move_playhead_to_edit`, `play_source_monitor`,
`get_source_monitor_position`, `match_frame`, `open_in_source`, `close_source_monitor`,
`close_all_source_clips`, `get_source_monitor_info`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `step_frames` | Arrow-key stepping (±1, ±5, ±N frames) | DOM | readback | T1 |
| `go_to_next_marker` / `go_to_prev_marker` | Shift+M / Ctrl+Shift+M | DOM | readback | T1 |
| `go_to_in_point` / `go_to_out_point` | Shift+I / Shift+O | DOM | readback | T1 |
| `go_to_sequence_start` / `go_to_sequence_end` | Home / End | DOM | readback | T1 |
| `play_around_playhead` | Shift+K preview (pre/post-roll) | DOM+BR | readback | T2 |
| `play_in_to_out` | Play the marked range | DOM | readback | T2 |
| `loop_playback_range` | Loop a section for review | DOM+BR | readback | T3 |
| `set_source_playhead` | Position source monitor CTI | DOM | readback | T1 |
| `gang_monitors` | Sync source+program position | DOM (BR compose) | readback | T2 |
| `get_playback_state` | Is it playing? speed? direction? | DOM | computed | T1 |

## 2. Source Monitor & Logging — 10 new

Covered already: `set_source_in_out`, `set_item_in_out`, `clear_item_in_out`,
`create_subclip`, `insert_from_source`, `overwrite_from_source`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `open_project_item_in_source_at` | Open + cue to timecode in one call | DOM | readback | T1 |
| `log_clip` | Set in/out + name + comment + label in one pass | DOM | readback | T1 |
| `batch_log_from_csv` | Paper-edit / logging sheet → in/outs + subclips | FILE+DOM | readback per row | T1 |
| `create_subclips_from_markers` | Every marker pair → subclip | DOM | readback | T1 |
| `create_subclips_from_scene_detect` | Scene cuts → subclips | FF+DOM | readback | T2 |
| `storyboard_bin_to_sequence` | Bin order → assembly (storyboard editing) | DOM | structure diff | T1 |
| `get_source_clip_info` | Full info on what's loaded in source | DOM | computed | T1 |
| `set_source_zoom_level`* | Monitor zoom % | — | — | see WALL |
| `audition_clip` | Load clip, play in/out, report duration/audio peaks | DOM+FF | computed | T2 |
| `hover_scrub_frames` | Extract N thumbnails across a clip (visual skim for agents) | FF | file | T1 |
| `compare_takes` | Side-by-side frame strips of 2+ takes | FF | file | T2 |

## 3. Project & Media Management — 24 new

Covered already (large surface): import family (7 tools), bins (create/rename/delete/
move), `search_project_items`, `find_project_item_by_name`, `find_items_by_media_path`,
proxy family, `relink_media`, `refresh_media`, offline media family, duplicate/unused
media reports, `consolidate_and_transfer`, `consolidate_duplicates`, metadata family,
`set_footage_interpretation`, `set_zero_point`, `set_poster_frame`, labels, scratch disks.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `batch_relink_by_pattern` | Relink whole project via path regex/prefix swap | DOM | readback per item | T1 |
| `relink_report` | Dry-run: what WOULD relink where | DOM+BR | computed | T1 |
| `verify_media_online` | Deep check: file exists + probe matches DB | DOM+FF | computed | T1 |
| `verify_media_checksums` | Bit-level media integrity (xxhash) | BR | computed | T2 |
| `generate_proxies` | Create + attach proxies via AME | AME+DOM | file+readback | T1 |
| `set_audio_channel_mapping` | Clip audio channels (mono/stereo/adaptive) | DOM (partial) | readback | T2 |
| `batch_interpret_footage` | Frame rate / PAR / alpha over a bin | DOM | readback | T1 |
| `set_alpha_interpretation` | Premultiplied/straight/ignore alpha | DOM | readback | T2 |
| `sort_bin` | Order bin contents by name/date/duration/label | DOM | structure diff | T2 |
| `flatten_bins` / `auto_bin_by_type` / `auto_bin_by_date` / `auto_bin_by_scene` | Reorganize project tree (4 tools) | DOM | tree diff | T2 |
| `find_unused_sequences` | Sequences never referenced/nested | DOM | computed | T2 |
| `project_stats` | Counts, sizes, codecs, fps mix — one report | DOM+FF | computed | T1 |
| `archive_project` | Consolidate + copy + manifest + checksum | DOM+BR | file | T2 |
| `media_cache_report` / `clean_media_cache` | Cache size/location; purge stale entries | FILE | computed/file | T2 |
| `watch_folder_ingest` | Poll folder → import new media to bin | BR+DOM | readback | T3 |
| `stack_by_content` | Group visually-duplicate media (perceptual hash) | FF+BR | computed | T3 |
| `rename_media_on_disk` | Rename source files + relink (ledgered) | BR+DOM | file+readback | T2 |
| `embed_project_note` | Project-level notes/TODO stored in metadata | DOM | readback | T2 |
| `get_bin_tree` | Full tree as JSON paths (rebuild-safe) | DOM | computed | T1 |
| `import_with_options` | Import + interpret + bin + proxy in one call | DOM+AME | readback | T1 |

## 4. Sequence & Track Structure — 16 new

Covered already: sequence CRUD (create ×4, delete, duplicate, close, settings ×10),
track add/delete/rename/lock/mute/target family, `list_sequence_tracks`,
`get_timeline_gaps`, `nest_clips`, `unnest_sequence`, `create_subsequence`, work area
family, `set_zero_point`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `close_gap_at` / `close_all_gaps` | Remove one/all timeline gaps (ripple) | DOM | gap readback | T1 |
| `insert_gap` | Push everything right by N frames from T | DOM | structure diff | T1 |
| `delete_empty_tracks` | Sequence menu command | DOM | track count | T1 |
| `set_track_sync_lock`* | Sync lock toggles | QE probe | fingerprint | T3 |
| `render_in_to_out` | Build preview renders for a range | DOM | render-status readback | T1 |
| `render_selection` | Render previews under selected clips | DOM | render-status | T2 |
| `delete_render_files_in_range` | Targeted preview purge | DOM | render-status | T2 |
| `sequence_thumbnail_strip` | Filmstrip PNG of whole timeline (agent eyes) | FF/PX | file | T1 |
| `get_edit_point_list` | All cuts on all tracks as timecodes | DOM | computed | T1 |
| `snap_clips_to_grid` | Quantize clip starts to frame/second grid | DOM | readback | T2 |
| `distribute_clips_evenly` | Equal spacing (slideshows) | DOM | readback | T2 |
| `sequence_from_markers` | Chapters/sections → one sequence per range | DOM | structure diff | T2 |
| `conform_sequence_settings` | Copy settings seq→seq, report mismatches | DOM | readback | T1 |
| `detect_settings_mismatch` | Clips whose fps/size fight the sequence | DOM+FF | computed | T1 |
| `count_tracks_used` | Which tracks actually carry content | DOM | computed | T1 |

## 5. Assembly Editing — 16 new

Covered already: `add_to_timeline(_batch)`, `insert_from_source`, `overwrite_from_source`,
`overwrite_clip`, `replace_clip`, `replace_clip_media`, `lift_selection`,
`extract_selection`, `split_clip`, `razor_timeline_at_time`, `razor_all_tracks`,
`remove_from_timeline`, `ripple_delete`, `duplicate_clip`, `move_clip(_to_track)`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `three_point_edit` | Classic 3-point: src in/out → seq in | DOM | structure diff | T1 |
| `four_point_edit` | Fit-to-fill with auto speed change | DOM+QE | structure+speed readback | T1 |
| `backtime_edit` | Align source OUT to sequence point | DOM | structure diff | T1 |
| `insert_at_playhead` / `overwrite_at_playhead` | The bread-and-butter , and . keys | DOM | structure diff | T1 |
| `add_edits_at_markers` | Razor at every sequence marker | DOM | edit-point diff | T1 |
| `add_edits_at_beats` | Audio beat detection → razors/markers | FF+DOM | edit-point diff | T2 |
| `auto_cut_to_music` | Place bin clips cut-to-beat | FF+DOM+BR | structure diff | T2 |
| `replace_with_gap` | Delete clip, leave hole | DOM | structure diff | T1 |
| `replace_from_bin_random` | Swap clip with random/next candidate (variants) | DOM | readback | T2 |
| `swap_clips` | Exchange two clips' positions | DOM | structure diff | T2 |
| `stringout_from_bin` | Classic dailies stringout with slates/gaps | DOM+BR | structure diff | T1 |
| `assemble_from_edl_json` | Full timeline from JSON cut list (agent-native EDL) | DOM | structure diff | T1 |
| `sequence_to_edl_json` | Timeline → same JSON schema (round-trip) | DOM | computed | T1 |
| `insert_slate` | Generated slate card (shot/date/version) at head | BR+FILE+DOM | pixel+structure | T2 |
| `checkerboard_tracks` | Alternate clips across 2 tracks (mix prep) | DOM | structure diff | T3 |

## 6. Trimming — 12 new

Covered already: `trim_clip`, `roll_edit`, `slip_edit`, `slide_edit`, `ripple_delete`,
`set_clip_start_time`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `ripple_trim_in` / `ripple_trim_out` | Q/W-style trim to playhead | DOM | in/out readback | T1 |
| `extend_edit_to_playhead` | E key | DOM | readback | T1 |
| `trim_to_playhead` (head/tail variants) | Opt+Q / Opt+W | DOM | readback | T1 |
| `nudge_clip` | Move selection ±N frames | DOM | readback | T1 |
| `nudge_edit_point` | Roll nearest cut ±N frames | DOM | readback | T1 |
| `asymmetric_trim` | Different deltas per track at one cut | DOM | readback | T3 |
| `slip_to_match_frame` | Slip clip so frame X lands at time T | DOM | readback | T2 |
| `trim_all_heads_tails` | Batch handle trim over selection | DOM | readback | T2 |
| `pad_edit_with_handles_check` | Report available handles at every cut | DOM | computed | T1 |
| `split_and_trim` | Razor + remove one side, one call | DOM | structure diff | T2 |

## 7. Motion & Clip Layout — 18 new

Covered already: position/scale/rotation/anchor/opacity setters (9 tools),
`set_clip_properties(_batch)`, `crop_clip`, `set_blend_mode`,
`set_scale_to_frame_size`, `set_uniform_scale`, `auto_reframe_sequence`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `flip_horizontal` / `flip_vertical` | Transform flip | DOM (effect param) | readback | T1 |
| `fade_in_video` / `fade_out_video` | Opacity ramps (the most common keyframe op) | DOM | keyframe readback | T1 |
| `crossfade_at_cut` | Opacity X-fade OR default transition, chosen honestly | DOM | keyframe/fingerprint | T1 |
| `pip_layout` | Picture-in-picture at preset corner/size | DOM | readback | T1 |
| `grid_layout` | N clips → 2×2/3×3 auto grid | DOM+BR | readback | T1 |
| `split_screen_layout` | 2-up / 3-up vertical or horizontal | DOM+BR | readback | T1 |
| `ken_burns` | Slow push/pan between two framings | DOM | keyframe readback | T1 |
| `align_clips_spatial` | Align/distribute selected clips (left/center/…) | DOM+BR | readback | T2 |
| `keyframe_slide_in` / `keyframe_slide_out` | Slide-on/off screen moves | DOM | keyframe readback | T2 |
| `bounce_in` | Overshoot-and-settle entrance (baked ease) | DOM+BR | keyframe readback | T2 |
| `match_transform` | Copy full motion state clip→clip | DOM | readback | T1 |
| `reset_transform` | Back to defaults | DOM | readback | T1 |
| `drop_shadow` | Configured drop-shadow effect | QE+DOM | fingerprint+readback | T2 |
| `edge_feather` | Soft edges | QE+DOM | fingerprint+readback | T2 |
| `safe_area_check` | Verify titles inside safe margins | PX/BR | pixel | T2 |
| `letterbox` | Cinematic bars (crop or matte) | DOM | readback | T1 |

## 8. Speed & Time — 12 new

Covered already: `speed_change`, `set_clip_speed_qe`, `get_clip_speed`, `reverse_clip`,
`freeze_frame`, `bake_speed_change`, `set_time_interpolation`, `set_frame_blend`,
`set_override_frame_rate`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `rate_stretch_to_fill` | Stretch/squeeze clip to exactly fill a gap | QE | duration+speed readback | T1 |
| `verify_speed_duration` | Confirm on-timeline duration matches speed (closes our known caveat) | DOM | readback | T1 |
| `time_remap_keyframes` | Speed ramps via Time Remap keyframes | DOM (probe) | keyframe readback | T3 |
| `speed_ramp_bake` | Guaranteed speed ramp via ffmpeg bake + replace | FF+DOM | file+pixel | T1 |
| `frame_hold_segment` | Hold N frames mid-clip (razor+freeze composite) | DOM+QE | structure diff | T2 |
| `frame_hold_options` | Hold at in/out/playhead | QE probe | readback | T3 |
| `verify_time_interpolation_rendered` | PIXEL-verify optical flow / frame blend actually rendered (closes honest gap) | PX | pixel | T1 |
| `conform_speed_to_music_section` | Retime clip so action lands on beat | FF+QE | readback | T3 |
| `stutter_effect` | Repeated frame-hold rhythm | DOM+BR | structure diff | T3 |
| `slowmo_quality_report` | Source fps vs target speed: will it judder? | FF | computed | T1 |
| `reverse_with_audio_policy` | Reverse video, mute/keep/reverse audio explicitly | QE+FF | readback | T2 |
| `fit_clip_duration` | Set exact duration (speed or trim, caller chooses) | QE/DOM | readback | T1 |

## 9. Effects & Keying — 22 new

Covered already: apply/remove/copy effect family (10 tools), `list_available_effects`,
`list_clip_effects`, `get_effect_properties`, `set_effect_property`, `set_color_value`,
adjustment layers, transitions family (5 tools), `stabilize_clip`,
`set_anti_alias_quality`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `enable_disable_effect` | fx toggle on one component | DOM (probe `.enabled`) | readback | T1 |
| `save_effect_preset` / `apply_effect_preset_file` | .prfpset save/load | FILE+QE | fingerprint | T2 |
| `effect_recipe_apply` | Named recipes: dreamy, vhs, glitch, security-cam… (JSON-defined stacks) | QE+DOM | fingerprint+readback | T1 |
| `ultra_key_setup` | Green screen: sample color + matte params in one call | QE+DOM | fingerprint+PX | T1 |
| `ultra_key_verify` | PIXEL-check the key actually pulled (alpha sampling) | PX | pixel | T1 |
| `luma_key_setup` / `chroma_key_setup` | Other keyers | QE+DOM | fingerprint | T2 |
| `track_matte_setup` | Assign matte track + key in one call | QE+DOM | fingerprint+readback | T1 |
| `blur_clip` / `sharpen_clip` / `tint_clip` / `posterize_clip` | One-call common effects with amount | QE+DOM | fingerprint+readback | T1 |
| `mosaic_region`* | Privacy blur — NO scriptable masks; honest alternative = crop-duplicate technique, limitation stated | QE+DOM+BR | fingerprint+PX | T2 |
| `set_transition_duration` / `set_transition_alignment` | Modify existing transitions | QE probe | fingerprint | T2 |
| `replace_all_transitions` | Swap every X-dissolve for dip-to-black etc. | QE | fingerprint | T2 |
| `remove_all_transitions` | Strip transitions sequence-wide | QE | fingerprint | T1 |
| `effect_stack_report` | Every effect on every clip, as JSON | DOM | computed | T1 |
| `find_clips_with_effect` | Where is Warp Stabilizer used? | DOM | computed | T1 |
| `copy_effects_to_matching_clips` | Propagate grade/stack to same-source clips | DOM | fingerprint per clip | T1 |
| `verify_effect_rendered` | PIXEL-verify any effect changed the image | PX | pixel | T1 |

## 10. Keyframes & Animation — 12 new

Covered already: `add_keyframe`, `remove_keyframe(_range)`, `get_keyframes`,
`get_value_at_time`, `set_keyframe_interpolation`, `bake_keyframe_ease`,
`add_audio_keyframes`, `evaluate_expression`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `copy_keyframes` | Param→param / clip→clip keyframe transfer | DOM | readback | T1 |
| `keyframes_from_json` / `keyframes_to_json` | Full animation as data (agent-native) | DOM | readback | T1 |
| `offset_keyframes_time` | Shift animation ±N frames | DOM | readback | T1 |
| `scale_keyframes_time` | Stretch animation to new duration | DOM | readback | T1 |
| `mirror_keyframes` | Reverse an animation | DOM | readback | T2 |
| `loop_keyframes` | Repeat a keyframe cycle N times | DOM | readback | T2 |
| `wiggle_bake` | AE-style wiggle as baked keyframes (seeded noise) | DOM+BR | readback | T2 |
| `ease_preset_apply` | ease-in/out/both/overshoot/anticipate named curves (extends bake_keyframe_ease) | DOM+BR | readback | T1 |
| `keyframe_audit` | Every animated param in sequence, as report | DOM | computed | T1 |
| `remove_all_keyframes_for_param` | Clean slate one property | DOM | readback | T1 |
| `snap_keyframes_to_frames` | Fix subframe keyframe drift | DOM | readback | T2 |

## 11. Color — 22 new

Covered already: `color_correct`, `apply_lumetri_preset`, `list_lumetri_presets`,
`apply_lut`, `get_color_space`, scopes (`generate_scope`, `waveform`, `vectorscope`,
`histogram`, `rgb_parade`), `get/set_graphics_white_luminance`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `lumetri_basic_set` | Exposure/contrast/highlights/shadows/whites/blacks/temp/tint numerically | DOM | readback | T1 |
| `lumetri_creative_set` | Look + intensity + faded/sharpen/vibrance/saturation | DOM | readback | T1 |
| `lumetri_wheels_set` | Shadows/mids/highlights wheels numerically | DOM | readback | T2 |
| `lumetri_vignette_set` | Amount/midpoint/roundness/feather | DOM | readback | T1 |
| `lumetri_hsl_secondary_set` | Key a hue range + correct (params exposed; curves opaque — stated) | DOM | readback | T3 |
| `lumetri_report` | Read entire grade state as JSON | DOM | computed | T1 |
| `copy_grade` / `paste_grade_to_clips` | Grade propagation | DOM | readback | T1 |
| `auto_white_balance` | Sample frame → compute temp/tint correction | PX+DOM | pixel+readback | T1 |
| `auto_exposure` | Waveform-driven exposure correction | PX+DOM | pixel+readback | T2 |
| `match_shot_color` | Iterative render-truth loop: grade B until scopes match A | PX+DOM | pixel | T2 |
| `broadcast_safe_check` | Illegal levels report (per-frame scan of range) | PX/FF | computed | T1 |
| `broadcast_safe_fix` | Apply legalizing limiter | QE+DOM | fingerprint+pixel | T2 |
| `grade_consistency_report` | Scope stats per shot across timeline — outliers flagged | PX/FF | computed | T2 |
| `set_color_space_override` | Per-clip color management | DOM (probe) | readback | T2 |
| `sdr_conform_settings` | HDR→SDR export conform | DOM/AME | readback | T3 |
| `false_color_frame` | False-color exposure map of a frame | PX+BR | file | T2 |
| `extract_palette` | Dominant colors of a shot (look refs for gen-AI!) | FF/BR | computed | T1 |
| `apply_lut_to_bin` | Input LUT across all clips in a bin | DOM | readback | T2 |
| `day_night_grade` | Named grade recipes (day-for-night, golden hour…) | DOM | readback+pixel | T2 |
| `grade_snapshot_gallery` | Before/after stills of every graded shot | PX | file | T2 |

## 12. Audio — 26 new

Covered already: `adjust_audio_levels`, `set_clip_volume`, `set_clip_pan`,
`add_audio_keyframes`, `apply_audio_effect(_to_all_clips)`, `normalize_loudness`,
`setup_ducking`, `detect_silence`, `mute_track`, audio transitions list,
`set_sequence_audio_settings`, `link/unlink` family.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `set_clip_gain` | Clip gain (dB) — distinct from volume rubber-band | DOM | readback | T1 |
| `normalize_clip_peaks` | Normalize to peak dBFS per clip | DOM+FF | computed+readback | T1 |
| `fade_in_audio` / `fade_out_audio` | Volume ramps | DOM | keyframe readback | T1 |
| `audio_crossfade_at_cut` | Constant-power at a specific edit | DOM | fingerprint | T1 |
| `batch_audio_crossfades` | All cuts on chosen tracks | DOM | fingerprint | T1 |
| `j_cut` / `l_cut` | Split edits — extend audio under adjacent video | DOM | structure diff | T1 |
| `solo_track` | Mute all others (restorable) | DOM | readback | T1 |
| `mute_clip_audio` | Just this clip | DOM | readback | T1 |
| `loudness_report` | ITU-R BS.1770 LUFS per clip/track/mix | FF | computed | T1 |
| `loudness_conform` | Hit -14/-16/-23 LUFS delivery target | FF+DOM | computed | T1 |
| `parametric_eq_set` / `compressor_set` / `limiter_set` / `deesser_set` | Numeric control of the core chain (4 tools) | DOM | readback | T2 |
| `denoise_clip` | DeNoise effect with amount | QE+DOM | fingerprint | T1 |
| `dereverb_clip` | DeReverb with amount | QE+DOM | fingerprint | T2 |
| `channel_remap_clip` | Swap/route L-R, mono-ize | DOM (probe) | readback | T3 |
| `fill_room_tone` | Loop tone clip under dialogue gaps | DOM+BR | structure diff | T2 |
| `align_audio_by_waveform` | Sync 2 clips by content (our own FF cross-correlation — merged-clip WALL bypassed) | FF+DOM | computed+readback | T1 |
| `music_beat_markers` | Beat-detect → sequence markers | FF+DOM | readback | T1 |
| `audio_peaks_report` | Clipping/peak scan of the mix | FF | computed | T1 |
| `sync_drift_check` | A/V drift detect over long clips | FF | computed | T2 |
| `stem_export` | Dialogue/music/FX stems by track selection | AME/DOM | file | T2 |
| `karaoke_volume_dip` | Dip music under each dialogue clip (static, no keying) | DOM | keyframe readback | T2 |

## 13. Titles, Graphics & MOGRTs — 16 new

Covered already: `add_text_overlay`, `import_mogrt(_from_library)`,
`get_mogrt_component`, `build_motion_graphics_demo`,
`build_brand_spot_from_mogrt_and_assets`, `create_bars_and_tone`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `set_mogrt_text` | Change text in a placed MOGRT | DOM | readback | T1 |
| `set_mogrt_param` | Any exposed MOGRT param (color/number/bool) | DOM | readback | T1 |
| `mogrt_params_report` | What does this MOGRT expose? (incl. honest "opaque JSON" flags) | DOM | computed | T1 |
| `batch_mogrt_from_csv` | Data-driven lower thirds (names list → graphics) | FILE+DOM | readback per row | T1 |
| `style_text_overlay` | Font/size/color/stroke/shadow on our text layers | DOM (probe) | readback | T2 |
| `lower_third_preset` | Positioned, styled name+title card in one call | DOM+BR | readback+pixel | T1 |
| `title_card` | Centered full-screen card w/ in-out fades | DOM+BR | readback | T1 |
| `credits_roll` | Long text + baked position keyframes | DOM+BR | keyframe readback | T2 |
| `countdown_leader` | Universal counting leader | QE | fingerprint | T2 |
| `slate_card` | Rendered slate PNG (show/shot/version/date) imported + placed | BR+FILE+DOM | pixel+structure | T1 |
| `progress_bar_bake` | Animated bar via scaled matte + keyframes | DOM+BR | keyframe readback | T3 |
| `subtitle_style_burn` | Styled open subtitles from SRT as graphics | FILE+DOM | structure diff | T2 |
| `watermark_apply` | Corner bug/logo across timeline | DOM | structure+pixel | T1 |
| `timecode_burn_in` | TC overlay effect on adjustment layer | QE+DOM | fingerprint+pixel | T1 |
| `metadata_burn_in` | Shot name/version burn-ins for review | QE+DOM+BR | fingerprint+pixel | T2 |
| `verify_text_rendered` | PIXEL-check text actually drew (incl. missing-font catch) | PX | pixel | T1 |

## 14. Captions — 14 new

Covered already: `create_caption_track`, `read_sequence_captions`, `transcribe_to_srt`,
plus the SRT file suite (`read/write/validate_srt`, cue CRUD ×3, `shift_srt_timing`).

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `import_srt_to_caption_track` | SRT → captions on a track | DOM | caption readback | T1 |
| `export_captions_to_srt` | Sequence captions → SRT file | DOM+FILE | file | T1 |
| `add_caption_cue` / `update_caption_cue` / `delete_caption_cue` | In-sequence caption CRUD (3 tools; honest partial where DOM blocks text read) | DOM (probe) | readback | T1 |
| `retime_captions` | Shift/stretch caption track | DOM | readback | T1 |
| `caption_style_set` | Font/size/color/position (probe; honest partial) | DOM (probe) | readback | T3 |
| `captions_from_transcript_json` | Whisper JSON → timed captions | FILE+DOM | readback | T1 |
| `caption_qc_report` | Reading speed (CPS), line length, gap/overlap violations | DOM/FILE | computed | T1 |
| `caption_qc_fix` | Auto-split long cues, enforce min gaps | FILE+DOM | readback | T2 |
| `translate_captions_file` | SRT → SRT translation pass-through (external hook) | FILE+BR | file | T3 |
| `captions_to_markers` | Cue times → markers (nav aid) | DOM | readback | T2 |
| `burn_captions_check` | PIXEL-verify captions render in program | PX | pixel | T2 |
| `srt_diff` | Compare two caption files (versions) | FILE | computed | T2 |

## 15. Multicam — 8 new

Covered already: nothing real (a known gap — QE `setMulticam`/`canDoMulticam` verified
present on 26.3.2 but never exercised with real multicam media).

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `create_multicam_from_bin` | Sync by TC → multicam source sequence | DOM/QE | structure readback | T2 |
| `sync_angles_by_audio` | Our FF waveform alignment feeding multicam creation | FF+DOM | computed | T2 |
| `multicam_switch_at` | Cut to angle N at time T | QE | fingerprint | T3 |
| `multicam_cut_list_apply` | JSON angle-switch list → edited timeline | QE+BR | structure diff | T3 |
| `flatten_multicam` | Bake switches to plain clips | QE | structure diff | T3 |
| `multicam_angle_report` | Which angle is live when | DOM/QE | computed | T2 |
| `enable_multicam` / `set_switch_sources` | The verified-present QE toggles, wrapped honestly | QE | fingerprint | T2 |

## 16. Markers — 8 new

Covered already: full CRUD (`add_marker`, `update_marker`, `delete_marker`,
`list_markers`, `get_clip_markers`, `add_marker_to_project_item`,
`get_sequence_markers_by_type`).

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `markers_from_csv` / `markers_to_csv` | Bulk marker I/O (notes from producers) | FILE+DOM | readback | T1 |
| `set_marker_type` | Chapter / weblink / segmentation types | DOM | readback | T1 |
| `duration_marker_add` | Ranged markers | DOM | readback | T1 |
| `markers_from_transcript_search` | "Mark every time she says X" | FILE+DOM | readback | T2 |
| `todo_marker_report` | Open items across project (by color/prefix) | DOM | computed | T1 |
| `chapter_markers_to_youtube` | Chapter text block for upload | DOM | computed | T2 |
| `copy_markers_between_sequences` | Version-to-version marker carry | DOM | readback | T2 |

## 17. Export & Render — 16 new

Covered already: `export_sequence`, `export_frame`, `encode_file`,
`encode_project_item`, `add_to_render_queue`, `start_batch_encode`,
`get_render_queue_status`, `get_encoder_presets`, `validate_project_for_export`,
AAF/OMF/FCPXML exports, `capture_frame`, `capture_program_output`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `export_in_out_range` | Just the marked range | DOM/AME | file+probe | T1 |
| `export_stills_batch` | Frame at every marker / every cut / every N sec | DOM/FF | file | T1 |
| `export_audio_only` | WAV/MP3 mixdown | AME | file+probe | T1 |
| `export_social_preset` | Named recipes: YouTube/Instagram/TikTok/ProResHQ… | AME | file+probe | T1 |
| `export_with_burn_ins` | Review copy: TC + name burns, then export | BR compose | file+pixel | T1 |
| `export_gif` / `export_thumbnail_strip` | Quick-share artifacts | FF | file | T2 |
| `verify_export` | Probe output: duration/fps/size/audio match sequence — no silent bad exports | FF | computed | T1 |
| `export_report` | What was exported when where (ledger) | BR | computed | T1 |
| `queue_watch` | Poll AME until done; report per-item results honestly | AME+BR | readback | T1 |
| `export_per_marker_segments` | Split delivery by chapter | DOM/AME | file per segment | T2 |
| `export_caption_sidecars` | SRT/VTT/SCC alongside master | FILE | file | T2 |
| `archive_master` | Export + checksum + manifest + versioned filename | BR compose | file | T2 |
| `smart_render_check` | Will this export smart-render? codec path report | DOM+FF | computed | T3 |
| `render_and_replace`* | See WALL — honest ffmpeg-bake alternative documented | FF+DOM | file+structure | T2 |

## 18. Interchange & Conform — 12 new

Covered already: `import_edl`, `import_fcp_xml`, `export_as_fcp_xml`, `export_aaf`,
`export_omf`, `export_as_project`, `import_sequences_from_project`, `diff_sequences`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `export_edl` | CMX3600 EDL (via our FCPXML→EDL converter — API has none) | FILE+BR | file | T1 |
| `export_otio` / `import_otio` | OpenTimelineIO via FCPXML bridge — nobody else has this | FILE+BR | file/structure | T2 |
| `change_list_report` | v1→v2 diff as editorial change list (extends diff_sequences) | DOM+BR | computed | T1 |
| `export_ale` | Avid Log Exchange for dailies workflows | FILE | file | T2 |
| `cut_list_csv` | Shot list: source TC, seq TC, name, handles | DOM | computed | T1 |
| `vfx_pull_list` | Per-shot pulls with handles + version fields (our world!) | DOM+BR | computed | T1 |
| `vfx_pull_export` | Actually export each pull with handles | AME+BR | file per shot | T1 |
| `reconform_by_timecode` | Relink recut to new media by TC match | DOM+BR | readback | T3 |
| `resolve_roundtrip_prep` | Flatten/prep sequence for Resolve grade round-trip | DOM+BR | structure diff | T2 |
| `marker_xml_export` | Markers as FCPXML chapter data | FILE | file | T2 |
| `edl_lint` | Validate an EDL before import (drop-frame traps etc.) | FILE | computed | T2 |

## 19. Review & Delivery — 10 new

Covered already: `create_recovery_checkpoint` family, `save_project(_as)`,
`lint_timeline`, `get_used_media_report`.

| Tool | Editor function | Surface | Verify | Tier |
|---|---|---|---|---|
| `assemble_review_reel` | Latest-version clips → gap-free reel (we hand-build these for the project today) | DOM+BR | structure diff | T1 |
| `version_up_sequence` | Duplicate + rename per naming convention + ledger | DOM+BR | readback | T1 |
| `shot_status_report` | Label colors → status board (JSON/CSV) | DOM | computed | T1 |
| `set_shot_status` | Status → label color + metadata, by shot code | DOM | readback | T1 |
| `notes_to_markers` | Review notes CSV (TC + note) → colored markers | FILE+DOM | readback | T1 |
| `markers_to_notes` | Markers → shareable notes doc | DOM | computed | T1 |
| `compare_versions_visual` | Side-by-side frame grid of v1 vs v2 at cuts | PX/FF | file | T2 |
| `delivery_qc` | One-call QC: black/flash frames, silence, illegal levels, offline media, caption QC | PX+FF+DOM | computed | T1 |
| `dailies_process` | Watch folder → import, proxy, LUT, stringout, slate | BR compose | structure diff | T3 |
| `project_bible_export` | Full project state as human-readable doc | DOM+BR | file | T2 |

## 20. Verification, Introspection & Meta — 16 new

Covered already: `verify_premiere_connection`, `ping`, `get_capabilities`,
`reflect_dom_object`, `inspect_dom_object`, `execute_extendscript`,
`get_premiere_state`, `get_version_info`, undo/redo family, recovery checkpoints,
`diff_sequences`, `lint_timeline`.

**This is the moat family — the tools no competitor has because they require the
render-truth loop and per-build QE probing.**

| Tool | Editor function / capability | Surface | Verify | Tier |
|---|---|---|---|---|
| `qe_capability_probe` | Live-test every QE method on THIS build → capability matrix (fragility, solved) | QE+BR | computed | T1 |
| `frame_diff` | Pixel-diff two frames/times (did anything change?) | PX | computed | T1 |
| `black_frame_scan` / `flash_frame_scan` / `freeze_frame_scan` | QC scans across a range (3 tools) | FF/PX | computed | T1 |
| `verify_clip_visible` | Is this clip actually contributing pixels? (occlusion/opacity/track order truth) | PX | pixel | T1 |
| `timeline_fingerprint` | Structural checksum of whole sequence (did anything move?) | DOM | computed | T1 |
| `audio_fingerprint` | Waveform checksum of the mix | FF | computed | T2 |
| `snapshot_state` / `assert_state_unchanged` | Before/after guards around risky ops | DOM+BR | computed | T1 |
| `honesty_selftest` | Run the adversarial per-tool honesty suite on the live host, emit scorecard | BR | computed | T1 |
| `api_surface_report` | Full DOM+QE reflection dump for this build (support/debug artifact) | DOM+QE | computed | T1 |
| `explain_tool` | Per-tool: what it does, surface, verification method, known per-build caveats | BR | computed | T1 |
| `dry_run` | Any mutating tool in describe-don't-do mode | BR | computed | T2 |
| `transaction_group` | Multi-tool op + one checkpoint + rollback on any failure | BR compose | computed | T2 |

---

## THE HONEST WALL — what an editor does that NO script surface reaches

Published limitations, not hidden ones. Each gets a doc entry and, where possible, an
honest alternative. **This list is itself a differentiator — nobody else publishes one.**

| Editor function | Why it's walled | Honest alternative |
|---|---|---|
| **Masks & mask tracking** on effects | Mask objects not exposed in DOM or QE | `mosaic_region` crop-duplicate technique (limits stated); AE round-trip note |
| **Morph Cut** interior params / analysis | Analysis not scriptable | Apply-and-pixel-verify only |
| **Essential Sound panel** auto-tagging/analysis | Panel logic not exposed | Direct effect-chain tools (EQ/compressor/denoise) achieve the same result |
| **Render & Replace** | Not in any API | `render_and_replace` via ffmpeg bake + relink (documented as our workaround) |
| **Productions / Team Projects** | Zero scripting surface | Checkpoint + export_as_project versioning |
| **Clipboard** (copy/paste clips/attributes) | No scripting access | `copy_effects_between_clips`, `match_transform`, `copy_grade` replicate the common cases |
| **Text/graphics advanced styling** (tracking, gradients, shape layers) | Essential Graphics authoring not exposed | MOGRT param control + rendered-PNG import path |
| **Caption full styling** | Caption style objects partially opaque | Probe + honest partial; burn-in path via SRT→styled graphics |
| **UI state** (track heights, panel layout beyond workspaces, monitor zoom) | UI-only | `set_workspace` covers the real need |
| **Speech-to-Text (native)** | Not scriptable | `transcribe_to_srt` (our own Whisper path) — already better |
| **Auto Reframe per-clip adjustments** | Only sequence-level exposed | `auto_reframe_sequence` + manual position keyframes |
| **Merged clips creation** | Not scriptable | `align_audio_by_waveform` + link — same outcome |
| **Effect stack reorder** | Not in DOM; QE unproven | `qe_capability_probe` will test per build; else remove+re-add in order |
| **Time Remap keyframes** | Component exposed but keyframe write unproven | T3 probe; `speed_ramp_bake` guarantees the result today |

---

## Totals

| Domain | New tools |
|---|---|
| 1. Playback & navigation | 12 |
| 2. Source & logging | 10 |
| 3. Project & media | 24 |
| 4. Sequence & tracks | 16 |
| 5. Assembly | 16 |
| 6. Trimming | 12 |
| 7. Motion & layout | 18 |
| 8. Speed & time | 12 |
| 9. Effects & keying | 22 |
| 10. Keyframes | 12 |
| 11. Color | 22 |
| 12. Audio | 26 |
| 13. Graphics & titles | 16 |
| 14. Captions | 14 |
| 15. Multicam | 8 |
| 16. Markers | 8 |
| 17. Export & render | 16 |
| 18. Interchange | 12 |
| 19. Review & delivery | 10 |
| 20. Verification & meta | 16 |
| **New total** | **302** |
| **Existing** | **309** |
| **GRAND TOTAL** | **611** |

Tier counts: **T1 ≈ 150** (build first — DOM-safe or FF/FILE/BR-controlled, immediate
editor value) · **T2 ≈ 110** · **T3 ≈ 42** (research/probe-gated).

## Build order (proposed)

1. **Wave 1 — T1 DOM + FF/FILE/BR** (~110 tools): pure official-API and
   self-controlled surfaces. Fast, safe, each ships with verification built in.
2. **Wave 2 — `qe_capability_probe` + T1 QE tools** (~40): the probe first, so every
   QE tool can gate itself per build and degrade honestly.
3. **Wave 3 — Render-truth family** (Wall-1 capture taps): unlocks every `PX` tool and
   closes the frame-blend/optical-flow honesty gap.
4. **Wave 4 — T2, then T3 probes** (multicam with real media, time-remap keyframes,
   caption styling).

Throughout: every new tool lands with (a) generated-script syntax test, (b) QE-targeting
test where applicable, (c) an entry in the live honesty stress-test suite.
