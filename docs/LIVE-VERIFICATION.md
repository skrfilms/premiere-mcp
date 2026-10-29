# Live verification ledger

<!-- GENERATED FILE. Do not edit by hand: `npm run verify:report` rewrites it from
     verification/sweeps/*.json, and a test fails when this file and the ledger disagree.
     To change what it says, run a sweep. -->

Every claim below comes from a sweep that actually ran against a live Premiere host and
wrote a file. Tools nobody has executed live are counted and named, not omitted.

## Newest sweep

- ran at: **2026-10-28T17:13:03Z**
- harness: `live-smoke-sweep` (mutate)
- commit: `7352a3003458cd5713c5323b67dce31790c8521e` **with uncommitted changes in the tree**
- Premiere: 26.5.2 (build 5)
- platform: darwin 25.6.0 arm64

## Coverage

Catalogue: **663** tools. Sweeps on record: **15**.

| standing | tools | share of catalogue |
| --- | --- | --- |
| **executed live** | **556** | **83.9%** |
| **never executed live** | **107** | **16.1%** |

Broken down. Only the first two rows are evidence about a tool; the rest record that we
looked and did not run it, and why.

| standing | tools | share of catalogue |
| --- | --- | --- |
| executed live, reported success | 521 | 78.6% |
| executed live, FAILED | 35 | 5.3% |
| not executed — harness could not build arguments | 4 | 0.6% |
| not executed — unsafe for an unattended sweep | 88 | 13.3% |
| not executed — panel was wedged by an earlier tool | 1 | 0.2% |
| not executed — mutating, sweep was read-only | 0 | 0.0% |
| absent from every sweep | 14 | 2.1% |

Of the 521 tools that passed, **16** returned `verified:false` —
the call succeeded and the effect was not confirmed, so they are not evidence of an effect:

- `add_transition_to_clip`
- `attach_sequence_custom_property`
- `create_proxy_qe`
- `pause_growing_file`
- `refresh_media`
- `refresh_ui`
- `set_encoder_xmp_options`
- `set_essential_sound_category`
- `set_item_pixel_aspect_ratio`
- `set_location_copy_settings`
- `set_log_color_management`
- `set_metadata`
- `set_preview_quality`
- `set_project_panel_columns`
- `set_renderer`
- `verify_color_grade`

## Failures on record

| tool | last seen | error |
| --- | --- | --- |
| `apply_audio_effect` | 2026-10-28T17:13:03Z | Effect add did not create a new component on the target clip |
| `apply_lut` | 2026-10-28T17:13:03Z | This LUT is not in Premiere's Input LUT list (no dropdown entry renders like it), so it cannot be selected from script. Pass installIfMissing:true to copy it in |
| `apply_lut_to_clip` | 2026-10-28T17:13:03Z | This LUT is not in Premiere's Input LUT list (no dropdown entry renders like it), so it cannot be selected from script. Pass installIfMissing:true to copy it in |
| `batch_add_audio_crossfades` | 2026-10-28T17:13:03Z | No crossfade could be added at any of the 1 audio cuts. See failures[]. |
| `batch_add_transitions` | 2026-10-28T17:13:03Z | 1 of 1 cuts did not take a transition. |
| `close_gap_at` | 2026-10-28T17:13:03Z | There is no gap across all tracks at 1s. Something occupies that time on at least one video or audio track, and closing a gap on one track alone would break syn |
| `create_custom_export_preset` | 2026-10-28T17:13:03Z | create_custom_export_preset requires the AME bridge (app.encoder). Use execute_extendscript with: var exp = app.encoder.getExporters(); then find your format, c |
| `duplicate_clip` | 2026-10-28T17:13:03Z | The destination 2s-3s is occupied on Video 1 by 'synth_name' (2s-4.91666666666667s). overwriteClip() would replace it, so nothing was placed. Pass an offset tha |
| `enable_disable_all_effects` | 2026-10-28T17:13:03Z | PARTIALLY APPLIED: 1 of 6 user effects were toggled; the rest are unchanged, so the clip is in a mixed state. See notToggleable[]. |
| `enable_disable_effect` | 2026-10-28T17:13:03Z | Matched 1 component(s), but none could be toggled. On this build an effect is enabled/disabled through its "Active" parameter; effects without one cannot be tog |
| `export_captions_to_srt` | 2026-10-28T17:13:03Z | No caption tracks found |
| `extend_edit` | 2026-10-28T17:13:03Z | V1 "fixture_b.mp4" at 3.91666666666667s has only 0s of media before its in-point, so the edit cannot roll 1.83333333333333s earlier. A1 "fixture_b.mp4" at 3.916 |
| `fill_room_tone` | 2026-10-28T17:13:03Z | A1 is not empty between 1s and 2s: "fixture_a.mp4" covers 1s-3.91666666666667s. Nothing was placed. |
| `fit_clip_duration` | 2026-10-28T17:13:03Z | Undone; the clip is unchanged. Clip speed reads 1.46938775510204 instead of the requested 1.95833333333333, so the clip was not rate stretched to fill 2s. QE sp |
| `get_clip_links` | 2026-10-28T17:13:03Z | Clip not found |
| `go_to_next_marker` | 2026-10-28T17:13:03Z | No next marker |
| `insert_from_source` | 2026-10-28T17:13:03Z | Need active sequence and source monitor item |
| `j_cut` | 2026-10-28T17:13:03Z | A1 "fixture_a.mp4" at 0s cannot start before 0. Nothing was changed. |
| `l_cut` | 2026-10-28T17:13:03Z | A1 "fixture_a.mp4" at 0s has only 0s of media after its out-point; extending it 0.08333333333333s would play black. Nothing was changed. |
| `nudge_clip` | 2026-10-28T17:13:03Z | V1 "fixture_b.mp4" at 3.91666666666667s is in the way of V1 "fixture_a.mp4" at 0s. Nothing was changed. |
| `open_item_in_source_qe` | 2026-10-28T17:13:03Z | The Source Monitor holds "synth_name", not the requested "synth_name", so openInSource() did not take. |
| `overwrite_clip` | 2026-10-28T17:13:03Z | Premiere reported overwriteClip() but 'synth_name' is not the clip covering 0s on the target track. |
| `overwrite_from_source` | 2026-10-28T17:13:03Z | Need active sequence and source monitor item |
| `project_file_edit` | 2026-10-28T17:13:03Z | Project-file surgery is disabled. It rewrites a .prproj outside Premiere, so it is opt-in: set PREMIERE_MCP_ALLOW_PROJECT_FILE_SURGERY=1 in the server's environ |
| `ripple_trim_out` | 2026-10-28T17:13:03Z | A ripple from 3.91666666666667s back to 2.08333333333333s would land later clips on V2 "fixture_c.mp4" at 0s, A2 "fixture_c.mp4" at 0s, on another track, and br |
| `set_app_property` | 2026-10-28T17:13:03Z | The property reads back as "" rather than the requested value. Many app properties are read-only or coerce the value they are given. |
| `set_clip_border_color` | 2026-10-28T17:13:03Z | qeClip.setBorderColor terminates the ExtendScript engine on this build (26.3.2), so this tool cannot run. No scripted alternative exists for clip borders; set t |
| `set_clip_border_width` | 2026-10-28T17:13:03Z | qeClip.setBorderWidth terminates the ExtendScript engine on this build (26.3.2), so this tool cannot run. No scripted alternative exists for clip borders; set t |
| `set_limiter` | 2026-10-28T17:13:03Z | No limiter component found. Add a Limiter or Dynamics Processing effect first. |
| `set_multicam_angle` | 2026-10-28T17:13:03Z | Premiere refused the angle switch (qeClip.setSwitchSources: Error: Unknown error exception). On 26.5.2 an existing multicam clip cannot be switched from script; |
| `set_poster_frame` | 2026-10-28T17:13:03Z | None of these methods are available: setPosterFrame |
| `set_project_property` | 2026-10-28T17:13:03Z | Error: Invalid parameter. |
| `set_source_in_out` | 2026-10-28T17:13:03Z | Project item not found |
| `slide_edit` | 2026-10-28T17:13:03Z | A slide needs clips directly before and after V1 "synth_name" at 1s on the same track. Nothing was changed. |
| `update_marker` | 2026-10-28T17:13:03Z | unknown |

## Per-tool standing

| tool | standing | last looked | sweep | note |
| --- | --- | --- | --- | --- |
| `activate_tools` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_adjustment_layer` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_audio_keyframes` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_custom_metadata_field` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_keyframe` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_marker` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_marker_to_project_item` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_metadata_schema_field` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_project_note` | absent from every sweep | — | — | |
| `add_text_overlay` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_to_render_queue` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | launches AME |
| `add_to_timeline` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_to_timeline_batch` | not executed — harness could not build arguments | 2026-10-28T17:13:03Z | `live-smoke-sweep` | clips[0] has no time; time is required in "absolute" mode (use mode:"append" to chain clips end-to-end). |
| `add_track` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_tracks` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_transition` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `add_transition_to_clip` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `adjust_audio_levels` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `align_clips_spatial` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `api_surface_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `apply_audio_effect` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Effect add did not create a new component on the target clip |
| `apply_audio_effect_qe` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `apply_audio_effect_to_all_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `apply_dynamics` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `apply_effect` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `apply_lumetri_preset` | not executed — harness could not build arguments | 2026-10-28T17:13:03Z | `live-smoke-sweep` | preset_name is required. Use list_lumetri_presets to see available presets. |
| `apply_lut` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | This LUT is not in Premiere's Input LUT list (no dropdown entry renders like it), so it cannot be selected from script.  |
| `apply_lut_to_clip` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | This LUT is not in Premiere's Input LUT list (no dropdown entry renders like it), so it cannot be selected from script.  |
| `apply_morph_cut` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `apply_video_effect` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `archive_master` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | copies media on disk |
| `assemble_product_spot` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `assemble_review_reel` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `assert_clips_unchanged` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `attach_custom_property` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `attach_sequence_custom_property` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `audio_crossfade_at_cut` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `audio_peaks_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `audio_silence_scan` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `auto_reframe_sequence` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long-running, creates sequences |
| `auto_white_balance` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `bake_keyframe_ease` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `bake_speed_change` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long ffmpeg render |
| `batch_add_audio_crossfades` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | No crossfade could be added at any of the 1 audio cuts. See failures[]. |
| `batch_add_transitions` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | 1 of 1 cuts did not take a transition. |
| `batch_apply_effect` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `batch_enable_disable` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `batch_enable_disable_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `batch_execute` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | arbitrary code; tested separately |
| `batch_export_sequences` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | launches AME repeatedly |
| `batch_log_from_csv` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `batch_mogrt_from_data` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `batch_relink_by_pattern` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | rewrites media links in bulk |
| `batch_relink_by_prefix` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | rewrites media links in bulk |
| `batch_rename_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `batch_rename_project_items` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `batch_replace_clips` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive swap |
| `batch_set_label` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `black_frame_scan` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `blur_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `broadcast_safe_check` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `build_brand_spot_from_mogrt_and_assets` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `build_motion_graphics_demo` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `call_tool` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `caption_qc_fix` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `caption_qc_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `captions_from_transcript_json` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `captions_to_markers` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `capture_frame` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `capture_program_output` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `change_list_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `channel_remap_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `chapter_markers_to_youtube` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `check_offline_media` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `clear_item_in_out` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `clear_sequence_in_out` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `clear_work_area` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `close_all_gaps` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `close_all_source_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `close_gap_at` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | There is no gap across all tracks at 1s. Something occupies that time on at least one video or audio track, and closing  |
| `close_project` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | closes the project out from under the sweep |
| `close_sequence` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `close_source_monitor` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `color_correct` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `compare_takes` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `conform_sequence_settings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `consolidate_and_transfer` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | copies media on disk |
| `consolidate_duplicates` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long-running: outlived the 25s budget and held the panel past the drain window (2026-10-27) |
| `convert_project_to_production` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | mutates Creative Cloud production state |
| `copy_effect_values` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `copy_effects_between_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `copy_grade` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `copy_markers_between_sequences` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `count_tracks_used` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `countdown_leader` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | dialog: newUniversalCountingLeader prompts |
| `create_adjustment_layer_at` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | dialog: newTransparentVideo prompts |
| `create_bars_and_tone` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | dialog: newBarsAndTone prompts |
| `create_bin` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_bin_qe` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_caption_track` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_custom_export_preset` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | create_custom_export_preset requires the AME bridge (app.encoder). Use execute_extendscript with: var exp = app.encoder. |
| `create_marker` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_multicam_cut` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_multicam_from_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_multicam_source_sequence` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_project` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | opens a second project and makes it active, escaping the scratch guard |
| `create_proxy_qe` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_recovery_checkpoint` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_sequence` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_sequence_from_bin` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_sequence_from_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_sequence_from_preset` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_smart_bin` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_subclip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_subclips_from_markers` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `create_subsequence` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `crop_clip` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `cut_list_csv` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `deactivate_tools` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `delete_bin` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `delete_empty_tracks` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive (removes tracks) |
| `delete_marker` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `delete_multiple_project_items` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `delete_preview_files` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive (throws away renders) |
| `delete_project_item` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `delete_sequence` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `delete_track` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `delivery_qc` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `denoise_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `dereverb_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `deselect_all_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `detach_proxy` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | mutates proxy attachment |
| `detect_scene_edits` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long-running analysis |
| `detect_settings_mismatch` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `detect_silence` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `diff_sequences` | not executed — panel was wedged by an earlier tool | 2026-10-28T17:13:03Z | `live-smoke-sweep` | nothing ran: panel was executing 72f64aa4-f424-4607-8fb4-fa1700220ad3 |
| `distribute_clips_evenly` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `duplicate_clip` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | The destination 2s-3s is occupied on Video 1 by 'synth_name' (2s-4.91666666666667s). overwriteClip() would replace it, s |
| `duplicate_sequence` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `duration_marker_add` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `effect_stack_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `enable_disable_all_effects` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | PARTIALLY APPLIED: 1 of 6 user effects were toggled; the rest are unchanged, so the clip is in a mixed state. See notTog |
| `enable_disable_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `enable_disable_effect` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Matched 1 component(s), but none could be toggled. On this build an effect is enabled/disabled through its "Active" para |
| `enable_multicam` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `encode_file` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | launches AME |
| `encode_project_item` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | launches AME |
| `evaluate_expression` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | arbitrary code; tested separately |
| `execute_extendscript` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | arbitrary code; tested separately |
| `export_aaf` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_aaf_with_settings` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_as_fcp_xml` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_as_project` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_audio_only` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_captions_to_srt` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | No caption tracks found |
| `export_edl` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_frame` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_gif` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_in_out_range` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_omf` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_omf_with_settings` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_per_marker_range` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | many long exports |
| `export_per_marker_segments` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | many long exports |
| `export_project_as_fcp_xml` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_sequence` | not executed — harness could not build arguments | 2026-10-28T17:13:03Z | `live-smoke-sweep` | presetPath or presetName required — Adobe encodeSequence requires an absolute .epr preset file. |
| `export_sequence_as_project` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_social_preset` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_stills_batch` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_thumbnail` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `export_with_burn_ins` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long render + mutates then restores effects |
| `extend_edit` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | V1 "fixture_b.mp4" at 3.91666666666667s has only 0s of media before its in-point, so the edit cannot roll 1.833333333333 |
| `extract_palette` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `extract_selection` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive (ripple-removes the selected clips, which are the fixture's) |
| `fade_in_audio` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `fade_in_video` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `fade_out_audio` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `fade_out_video` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `false_color_frame` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `fill_room_tone` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | A1 is not empty between 1s and 2s: "fixture_a.mp4" covers 1s-3.91666666666667s. Nothing was placed. |
| `find_clips_by_source` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `find_clips_with_effect` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `find_items_by_media_path` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `find_items_matching_media_path` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `find_keyframe_near_time` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `find_project_item_by_name` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `find_tool` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `find_unused_sequences` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `fit_clip_duration` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Undone; the clip is unchanged. Clip speed reads 1.46938775510204 instead of the requested 1.95833333333333, so the clip  |
| `flash_frame_scan` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `flatten_multicam` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `flip_horizontal` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `flip_vertical` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `flush_sequence_cache` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `frame_diff` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `frame_io_notes_to_markers` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `frames_to_timecode` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `freeze_frame` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `freeze_frame_scan` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `generate_scope` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_active_sequence` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_all_clip_effects` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_all_markers` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_all_project_paths` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_app_property` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_app_state` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_autosave_settings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_bin_contents` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_bin_contents_recursive` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_bin_tree` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_capabilities` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_adjustment_layer` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_at_playhead` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_at_position` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_color_space` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_flags` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_info_extended` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_links` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Clip not found |
| `get_clip_markers` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_properties` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_speed` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_clip_speed_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_cloud_queue_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_color_label` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_color_management_options` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_color_space` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_conflicts` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_duplicate_media` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_ea_login_status` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_ea_status` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_ea_user_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_edit_point_list` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_effect_properties` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_encoder_presets` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_encoder_state` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_export_file_extension` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_export_progress` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_footage_interpretation` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_full_clip_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_full_project_overview` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_full_sequence_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_graphics_white_luminance` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_insertion_bin` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_item_color_management` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_item_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_item_metadata_columns` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_item_treepath` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_item_video_components` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_item_xmp_metadata` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_job` | absent from every sweep | — | — | |
| `get_keyframes` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_linked_items` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_location_copy_settings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_lumetri_preset_list` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_media_processing_status` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_metadata` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_mogrt_component` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_mogrt_text_all` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_multicam_angle_count` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_next_edit_point` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_offline_media` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_open_project_count` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_panel_visibility` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_playback_state` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_playhead_position` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_premiere_state` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_production_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_production_list` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_item_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_item_info_extended` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_notes` | absent from every sweep | — | — | |
| `get_project_panel_columns` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_panel_metadata` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_panel_selection` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_property` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_scratch_disks` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_project_stats` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_proxies_enabled` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_proxy_status` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_qe_clip_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_qe_clip_settings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_qe_component_params` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_qe_project_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_qe_sequence_props` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_qe_sequence_settings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_recent_calls` | absent from every sweep | — | — | |
| `get_render_queue_status` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_renderer_names` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_selected_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_count` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_duration` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_gaps` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_in_out_points` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_info_extended` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_markers_by_type` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_render_status` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_selection` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_settings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_sequence_structure` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_source_clip_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_source_clip_info_qe` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_source_monitor_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_source_monitor_position` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_source_position` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_target_tracks` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_timeline_gaps` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_timeline_render_status` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_timeline_summary` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_tool_typings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_total_clip_count` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_track_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_unused_media` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_used_media_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_value_at_time` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_version_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_work_area` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_workspaces` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `get_xmp_metadata` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `go_to_in_point` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `go_to_next_marker` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | No next marker |
| `go_to_out_point` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `go_to_prev_marker` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `go_to_sequence_end` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `go_to_sequence_start` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `go_to_timecode` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `grade_snapshot` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `grid_layout` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `has_proxy` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `honesty_selftest` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | would recurse into this sweep |
| `hover_scrub_frames` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `import_edl` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | dialog: EDL import prompts for sequence/source media |
| `import_fcp_xml` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `import_folder` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `import_image_sequence` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `import_media` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `import_media_qe` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `import_mogrt` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | dialog risk + writes to project |
| `import_mogrt_from_library` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | dialog risk + writes to project |
| `import_project_items` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | mutates project structure |
| `import_sequences` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `import_sequences_from_project` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `index_footage` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `insert_from_source` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Need active sequence and source monitor item |
| `insert_srt_cue` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `inspect_dom_object` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `invert_selection` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `is_work_area_enabled` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `j_cut` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | A1 "fixture_a.mp4" at 0s cannot start before 0. Nothing was changed. |
| `ken_burns` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `keyframe_zoom_in` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `keyframe_zoom_out` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `l_cut` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | A1 "fixture_a.mp4" at 0s has only 0s of media after its out-point; extending it 0.08333333333333s would play black. Noth |
| `letterbox` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lift_selection` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive (removes the selected clips, which are the fixture's) |
| `link_audio_video` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `link_media_qe` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `link_selection` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lint_timeline` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_all_encoder_presets` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_audio_effects_on_clip` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_audio_transitions` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_available_audio_effects` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_available_audio_transitions` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_available_effects` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_available_transitions` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_clip_effects` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_effects_on_clip_qe` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_export_presets` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_jobs` | absent from every sweep | — | — | |
| `list_lumetri_presets` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_markers` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_open_projects` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_project_items` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_recent_projects` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_recovery_checkpoints` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_sequence_tracks` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_sequences` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_sequences_by_name` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `list_video_transitions` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lock_track` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `log_clip` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `look_at_cut` | absent from every sweep | — | — | |
| `loudness_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lower_third_preset` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lumetri_basic_set` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lumetri_creative_set` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lumetri_hsl_secondary_set` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lumetri_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `lumetri_vignette_set` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `manage_proxies` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | mutates proxy attachment |
| `marker_to_subclip` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `markers_from_csv` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `markers_to_csv` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `markers_to_notes` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `match_frame` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `match_shot_color` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `match_transform` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `mogrt_params_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `move_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `move_clip_to_track` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `move_item_to_bin` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `move_items_to_bin` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `move_playhead_to_edit` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `multicam_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `multiple_undo` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | rewinds the sweep |
| `mute_clip_audio` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `mute_track` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `nest_all_v1_clips` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive restructure |
| `nest_clips` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive restructure |
| `normalize_clip_peaks` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `normalize_loudness` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `normalize_track_peaks` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `notes_to_markers` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `nudge_clip` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | V1 "fixture_b.mp4" at 3.91666666666667s is in the way of V1 "fixture_a.mp4" at 0s. Nothing was changed. |
| `open_fcp_xml` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | swaps/creates project state |
| `open_fcp_xml_project` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | swaps/creates project state |
| `open_file_in_source` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `open_in_source` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `open_item_in_source_qe` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | The Source Monitor holds "synth_name", not the requested "synth_name", so openInSource() did not take. |
| `open_project` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | swaps the project mid-sweep |
| `open_project_item_in_source` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `overwrite_clip` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Premiere reported overwriteClip() but 'synth_name' is not the clip covering 0s on the target track. |
| `overwrite_from_source` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Need active sequence and source monitor item |
| `paste_grade_to_clips` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `pause_growing_file` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `ping` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `pip_layout` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `play_in_to_out` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | starts playback |
| `play_source_monitor` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | starts playback |
| `play_timeline` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | starts playback |
| `probe_media` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `production_sync_status` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `project_file_edit` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Project-file surgery is disabled. It rewrites a .prproj outside Premiere, so it is opt-in: set PREMIERE_MCP_ALLOW_PROJEC |
| `project_file_inspect` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `project_media_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `qe_sequence_info` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `rate_stretch_to_fill` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `razor_all_tracks` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `razor_timeline_at_time` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `read_clipboard` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `read_sequence_captions` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `read_srt` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `redo` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | replays unknown state |
| `reflect_dom_object` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `refresh_media` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `refresh_ui` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `relink_media` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | rewrites media links |
| `remove_all_effects` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_all_effects_qe` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_effect` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_effect_at_index` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_effect_by_name` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_from_timeline` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_keyframe` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_keyframe_range` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_mogrt_clip` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_selected_clips` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `remove_silence` | absent from every sweep | — | — | |
| `remove_srt_cue` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive to file |
| `remove_time_remap` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `rename_bin` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `rename_clip` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `rename_project_item` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `rename_timeline_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `rename_track` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `render_audio` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long render |
| `render_needs_preview` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `render_sequence_previews` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long render |
| `reorder_effects` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `replace_clip` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive swap |
| `replace_clip_media` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive swap |
| `reset_motion_to_defaults` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `reset_transform` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `resolve_conflict` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | mutates shared production |
| `restore_recovery_checkpoint` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | replaces sequence state |
| `reverse_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `revert_last_call` | absent from every sweep | — | — | |
| `ripple_delete` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive |
| `ripple_trim_in` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `ripple_trim_out` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | A ripple from 3.91666666666667s back to 2.08333333333333s would land later clips on V2 "fixture_c.mp4" at 0s, A2 "fixtur |
| `roll_edit` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `safe_area_check` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `save_project` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `save_project_as` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | writes a new project file |
| `scene_edit_detection` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long-running analysis |
| `scrub_source_to` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `search_footage` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `search_project_items` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `select_all_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `select_all_on_track` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `select_clips_by_color` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `select_clips_by_name` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `select_clips_in_range` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `select_clips_in_time_range` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `select_disabled_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `select_item` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `send_to_after_effects` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `sequence_from_markers` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `sequence_thumbnail_strip` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_active_sequence` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | moves the target out from under later probes |
| `set_all_tracks_targeted` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_anti_alias_quality` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_app_property` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | The property reads back as "" rather than the requested value. Many app properties are read-only or coerce the value the |
| `set_autosave_settings` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | rewrites the user's global Auto Save preferences |
| `set_blend_mode` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_anchor_point` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_border_color` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | qeClip.setBorderColor terminates the ExtendScript engine on this build (26.3.2), so this tool cannot run. No scripted al |
| `set_clip_border_width` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | qeClip.setBorderWidth terminates the ExtendScript engine on this build (26.3.2), so this tool cannot run. No scripted al |
| `set_clip_color_space` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_crop` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_gain` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_opacity` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_pan` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_position` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_properties` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_properties_batch` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_reverse` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_rotation` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_scale` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_scale_to_frame_size` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_selection` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_speed_qe` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_start_time` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_clip_volume` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_color_label` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_color_space_override` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_color_value` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_compressor` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_effect_property` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_encoder_xmp_options` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_essential_sound_category` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_footage_interpretation` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_frame_blend` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_frame_blend_qe` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_graphics_white_luminance` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_interpretation_frame_rate` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_item_in_out` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_item_metadata` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_item_pixel_aspect_ratio` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_item_poster_frame` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_keyframe_interpolation` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_limiter` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | No limiter component found. Add a Limiter or Dynamics Processing effect first. |
| `set_location_copy_settings` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_log_color_management` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_lut_interpolation` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_marker_type` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_metadata` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_mogrt_color` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_mogrt_param` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_mogrt_text` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_multicam_angle` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Premiere refused the angle switch (qeClip.setSwitchSources: Error: Unknown error exception). On 26.5.2 an existing multi |
| `set_offline` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | breaks media links |
| `set_override_frame_rate` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_override_pixel_aspect_ratio` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_parametric_eq` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_playhead_position` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_poster_frame` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | None of these methods are available: setPosterFrame |
| `set_preview_quality` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_project_panel_columns` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_project_panel_metadata` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_project_panel_selection` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_project_property` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Error: Invalid parameter. |
| `set_project_scratch_disk` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_proxies_enabled` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_qe_component_param` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_render_preview_quality` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_renderer` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_scale_to_frame_size` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_scale_to_frame_size_batch` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_scale_width_height` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_scratch_disk_path` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_audio_settings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_display_format` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_field_type` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_frame_rate` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_in_out_from_clips` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_in_out_points` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_in_out_qe` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_pixel_aspect_ratio` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_resolution` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_selection` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_settings` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_start_timecode` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_sequence_zero_point` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_source_in_out` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | Project item not found |
| `set_source_in_out_qe` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_start_time` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_target_track` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_time_interpolation` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_time_interpolation_type` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_track_lock_qe` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_track_volume_keyframes` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_transcode_on_ingest` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | turns on copy-on-import for the project, so every later import duplicates media on disk |
| `set_uniform_scale` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_work_area` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_workspace` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | rearranges the UI |
| `set_xmp_metadata` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `set_zero_point` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `setup_ducking` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `share_production` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | publishes to team |
| `sharpen_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `shift_srt_timing` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `shot_status_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `shotgrid_status_sync` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `slide_edit` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | A slide needs clips directly before and after V1 "synth_name" at 1s on the same track. Nothing was changed. |
| `slip_edit` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `slowmo_quality_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `snap_clips_to_grid` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `snapshot_state` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `speed_change` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `speed_ramp_bake` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long ffmpeg render |
| `split_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `split_screen_layout` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `srt_diff` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `stabilize_clip` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long-running warp analysis |
| `start_batch_encode` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | launches AME |
| `start_encode_and_monitor` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | launches AME |
| `start_job` | absent from every sweep | — | — | |
| `stem_export` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `step_frames` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `step_source_monitor` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `stop_playback` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `stop_source_monitor` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `storyboard_bin_to_sequence` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `stringout_from_transcript` | absent from every sweep | — | — | |
| `sync_by_audio` | absent from every sweep | — | — | |
| `sync_lock_track` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `sync_production` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | syncs to server |
| `three_point_edit` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `timecode_burn_in` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `timecode_to_frames` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `timeline_fingerprint` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `title_card` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `todo_marker_report` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `toggle_track_visibility` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `toggle_uniform_scale` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `transact_sequence_edits` | not executed — harness could not build arguments | 2026-10-28T17:13:03Z | `live-smoke-sweep` | could not synthesise: steps (steps: Invalid input: expected array, received undefined) |
| `transcribe_to_srt` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | long-running ML transcription |
| `trim_clip` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `undo` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | rewinds the sweep |
| `unlink_selection` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `unnest_sequence` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | destructive restructure |
| `update_marker` | executed live, FAILED | 2026-10-28T17:13:03Z | `live-smoke-sweep` | unknown |
| `update_srt_cue` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `validate_project_for_export` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `validate_srt` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `verify_clip_visible` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `verify_color_grade` | executed live, reported success (verified:false) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `verify_effect_rendered` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `verify_export` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `verify_export_file` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `verify_media_online` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `verify_premiere_connection` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `verify_speed_duration` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `version_up_sequence` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `version_up_shots` | absent from every sweep | — | — | |
| `vfx_pull_list` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `watermark_apply` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `what_changed` | absent from every sweep | — | — | |
| `where_used` | absent from every sweep | — | — | |
| `write_clipboard` | not executed — unsafe for an unattended sweep | 2026-10-28T17:13:03Z | `live-smoke-sweep` | overwrites the user's system clipboard |
| `write_sidecar_file` | executed live, reported success | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |
| `write_srt` | executed live, reported success (verified:true) | 2026-10-28T17:13:03Z | `live-smoke-sweep` |  |

## Sweeps on record

| ran at | harness | mode | commit | Premiere | tools recorded |
| --- | --- | --- | --- | --- | --- |
| 2026-10-28T17:13:03Z | `live-smoke-sweep` | mutate | `7352a3003458cd5713c5323b67dce31790c8521e` (dirty) | 26.5.2 (build 5) | 649 |
| 2026-10-27T23:51:02Z | `live-smoke-sweep` | mutate | `94a2637831d4db1c6ae89cab04011f79a749fb7c` (dirty) | 26.5.2 (build 5) | 649 |
| 2026-10-27T23:28:26Z | `live-smoke-sweep` | mutate | `94a2637831d4db1c6ae89cab04011f79a749fb7c` (dirty) | 26.5.2 (build 5) | 648 |
| 2026-10-27T23:23:00Z | `live-smoke-sweep` | mutate | `94a2637831d4db1c6ae89cab04011f79a749fb7c` (dirty) | 26.5.2 (build 5) | 648 |
| 2026-10-27T23:16:25Z | `live-smoke-sweep` | mutate | `94a2637831d4db1c6ae89cab04011f79a749fb7c` (dirty) | — | 449 |
| 2026-10-27T22:58:23Z | `live-smoke-sweep` | mutate | `94a2637831d4db1c6ae89cab04011f79a749fb7c` (dirty) | 26.5.2 (build 5) | 648 |
| 2026-10-27T22:52:47Z | `live-smoke-sweep` | mutate | `94a2637831d4db1c6ae89cab04011f79a749fb7c` (dirty) | 26.5.2 (build 5) | 648 |
| 2026-10-27T22:47:20Z | `live-smoke-sweep` | mutate | `94a2637831d4db1c6ae89cab04011f79a749fb7c` (dirty) | — | 390 |
| 2026-10-27T22:41:34Z | `live-smoke-sweep` | mutate | `94a2637831d4db1c6ae89cab04011f79a749fb7c` (dirty) | — | 389 |
| 2026-10-26T01:29:14Z | `live-smoke-sweep` | mutate | `a1f1c143d0102eac4ff2840a98fe27fedf9ec594` (dirty) | 26.5.2 (build 5) | 648 |
| 2026-10-26T00:59:58Z | `live-smoke-sweep` | mutate | `f78e25622ce59fc1e31981441800112dea570aa2` (dirty) | 26.5.2 (build 5) | 648 |
| 2026-10-26T00:11:30Z | `live-smoke-sweep` | mutate | `feb6b9797561156eee7632999935f5ce761881fc` (dirty) | — | 389 |
| 2026-10-25T23:26:05Z | `live-smoke-sweep` | mutate | `4daf6ca6334055e6011093a2ba6054bd1dd54afd` | — | 190 |
| 2026-08-27T18:07:14Z | `live-smoke-sweep` | mutate | `05766235e796f35942b60c25e2fdcb2601866b5d` | — | 195 |
| 2026-08-27T18:02:09Z | `live-smoke-sweep` | read-only | `2259e06518c141c338cdf4459e922315591c9a6b` | 26.3.2 (build 2) | 647 |

