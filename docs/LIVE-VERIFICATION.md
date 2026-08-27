# Live verification ledger

<!-- GENERATED FILE. Do not edit by hand: `npm run verify:report` rewrites it from
     verification/sweeps/*.json, and a test fails when this file and the ledger disagree.
     To change what it says, run a sweep. -->

Every claim below comes from a sweep that actually ran against a live Premiere host and
wrote a file. Tools nobody has executed live are counted and named, not omitted.

## Newest sweep

- ran at: **2026-08-27T18:07:14Z**
- harness: `live-smoke-sweep` (mutate)
- commit: `05766235e796f35942b60c25e2fdcb2601866b5d`
- Premiere: _host did not answer_
- platform: darwin 25.5.0 arm64

## Coverage

Catalogue: **647** tools. Sweeps on record: **2**.

| standing | tools | share of catalogue |
| --- | --- | --- |
| **executed live** | **226** | **34.9%** |
| **never executed live** | **421** | **65.1%** |

Broken down. Only the first two rows are evidence about a tool; the rest record that we
looked and did not run it, and why.

| standing | tools | share of catalogue |
| --- | --- | --- |
| executed live, reported success | 207 | 32.0% |
| executed live, FAILED | 19 | 2.9% |
| not executed — harness could not build arguments | 93 | 14.4% |
| not executed — unsafe for an unattended sweep | 81 | 12.5% |
| not executed — mutating, sweep was read-only | 247 | 38.2% |
| absent from every sweep | 0 | 0.0% |

## Failures on record

| tool | last seen | error |
| --- | --- | --- |
| `apply_audio_effect_qe` | 2026-08-27T18:07:14Z | Effect not found on this build: Gaussian Blur |
| `batch_add_audio_crossfades` | 2026-08-27T18:07:14Z | No crossfade could be added at any of the 3 audio cuts. See failures[]. |
| `copy_markers_between_sequences` | 2026-08-27T18:07:14Z | harness timeout 25s |
| `extend_edit` | 2026-08-27T18:07:14Z | The in edge did not move. The playhead may already be at that edge, or the clip has no room to extend in that direction (check the adjacent clip and available s |
| `flip_horizontal` | 2026-08-27T18:07:14Z | The Transform effect was ADDED to this clip but exposes no horizontal flip parameter, so the clip now carries an inert effect and is not flipped. Parameters pre |
| `flip_vertical` | 2026-08-27T18:07:14Z | The Transform effect was ADDED to this clip but exposes no vertical flip parameter, so the clip now carries an inert effect and is not flipped. Parameters prese |
| `get_bin_contents` | 2026-08-27T18:02:09Z | Bin not found |
| `get_export_progress` | 2026-08-27T18:07:14Z | harness timeout 25s |
| `get_item_info` | 2026-08-27T18:02:09Z | Project item not found |
| `get_project_item_info` | 2026-08-27T18:02:09Z | Project item not found |
| `get_value_at_time` | 2026-08-27T18:02:09Z | get_value_at_time requires clipId. |
| `lumetri_basic_set` | 2026-08-27T18:07:14Z | No Lumetri basic parameters provided. Supply at least one of: temperature, tint, saturation, exposure, contrast, highlights, shadows, whites, blacks. |
| `lumetri_creative_set` | 2026-08-27T18:07:14Z | No Lumetri creative parameters provided. Supply at least one of: fadedFilm, sharpen, vibrance, saturation. |
| `lumetri_vignette_set` | 2026-08-27T18:07:14Z | No Lumetri vignette parameters provided. Supply at least one of: amount, midpoint, roundness, feather. |
| `mogrt_params_report` | 2026-08-27T18:07:14Z | Clip is not a MOGRT — check isMGT() |
| `normalize_clip_peaks` | 2026-08-27T18:07:14Z | Gain param not found |
| `ripple_trim_in` | 2026-08-27T18:07:14Z | The source in-point moved but the clip did not ripple on the timeline, so this edit is half-applied: clip.inPoint is now 508032000000 ticks while clip.start is  |
| `ripple_trim_out` | 2026-08-27T18:07:14Z | The source out-point moved but the clip end did not change on the timeline, so this edit is half-applied: clip.outPoint is now 508032000000 ticks while clip.end |
| `search_footage` | 2026-08-27T18:02:09Z | No footage index found at /Users/kahanben/.premiere-mcp/footage-index.json. Build one first with index_footage (pass the folder as rootPath), or point indexPath |

## Per-tool standing

| tool | standing | last looked | sweep | note |
| --- | --- | --- | --- | --- |
| `activate_tools` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_adjustment_layer` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_audio_keyframes` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_custom_metadata_field` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_keyframe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_marker` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_marker_to_project_item` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_metadata_schema_field` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'add_metadata_schema_field': [
  {
    "expected": "string",
    "code": "invalid_type",
     |
| `add_text_overlay` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_to_render_queue` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | launches AME |
| `add_to_timeline` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_to_timeline_batch` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_track` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_tracks` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_transition` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `add_transition_to_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `adjust_audio_levels` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `align_clips_spatial` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'align_clips_spatial': [
  {
    "expected": "array",
    "code": "invalid_type",
    "path": |
| `api_surface_report` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `apply_audio_effect` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `apply_audio_effect_qe` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Effect not found on this build: Gaussian Blur |
| `apply_audio_effect_to_all_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `apply_dynamics` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `apply_effect` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `apply_lumetri_preset` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `apply_lut` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `apply_lut_to_clip` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'apply_lut_to_clip': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path":  |
| `apply_morph_cut` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `apply_video_effect` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `archive_master` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | copies media on disk |
| `assemble_product_spot` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'assemble_product_spot': [
  {
    "expected": "string",
    "code": "invalid_type",
    "pat |
| `assemble_review_reel` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'assemble_review_reel': [
  {
    "expected": "array",
    "code": "invalid_type",
    "path" |
| `assert_clips_unchanged` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `attach_custom_property` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `attach_sequence_custom_property` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `audio_crossfade_at_cut` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `audio_peaks_report` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `audio_silence_scan` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `auto_reframe_sequence` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | long-running, creates sequences |
| `auto_white_balance` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `bake_keyframe_ease` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `bake_speed_change` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | long ffmpeg render |
| `batch_add_audio_crossfades` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | No crossfade could be added at any of the 3 audio cuts. See failures[]. |
| `batch_add_transitions` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `batch_apply_effect` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `batch_enable_disable` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `batch_enable_disable_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `batch_execute` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | arbitrary code; tested separately |
| `batch_export_sequences` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | launches AME repeatedly |
| `batch_log_from_csv` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `batch_mogrt_from_data` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `batch_relink_by_pattern` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | rewrites media links in bulk |
| `batch_relink_by_prefix` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | rewrites media links in bulk |
| `batch_rename_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `batch_rename_project_items` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'batch_rename_project_items': [
  {
    "expected": "array",
    "code": "invalid_type",
     |
| `batch_replace_clips` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive swap |
| `batch_set_label` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'batch_set_label': [
  {
    "expected": "array",
    "code": "invalid_type",
    "path": [
  |
| `black_frame_scan` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `blur_clip` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'blur_clip': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
       |
| `broadcast_safe_check` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `build_brand_spot_from_mogrt_and_assets` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'build_brand_spot_from_mogrt_and_assets': [
  {
    "expected": "string",
    "code": "invali |
| `build_motion_graphics_demo` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `call_tool` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `caption_qc_fix` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'caption_qc_fix': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
  |
| `caption_qc_report` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'caption_qc_report': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path":  |
| `captions_from_transcript_json` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'captions_from_transcript_json': [
  {
    "expected": "string",
    "code": "invalid_type",
 |
| `captions_to_markers` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'captions_to_markers': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path" |
| `capture_frame` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `capture_program_output` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `change_list_report` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `channel_remap_report` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `chapter_markers_to_youtube` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `check_offline_media` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `clear_item_in_out` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `clear_sequence_in_out` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `clear_work_area` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `close_all_gaps` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `close_all_source_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `close_gap_at` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'close_gap_at': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
    |
| `close_project` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | closes the project out from under the sweep |
| `close_sequence` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `close_source_monitor` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `color_correct` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `compare_takes` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `conform_sequence_settings` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `consolidate_and_transfer` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | copies media on disk |
| `consolidate_duplicates` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `convert_project_to_production` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | mutates Creative Cloud production state |
| `copy_effect_values` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `copy_effects_between_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `copy_grade` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `copy_markers_between_sequences` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | harness timeout 25s |
| `count_tracks_used` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `countdown_leader` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | dialog: newUniversalCountingLeader prompts |
| `create_adjustment_layer_at` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | dialog: newTransparentVideo prompts |
| `create_bars_and_tone` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | dialog: newBarsAndTone prompts |
| `create_bin` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_bin_qe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_caption_track` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_custom_export_preset` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'create_custom_export_preset': [
  {
    "expected": "string",
    "code": "invalid_type",
   |
| `create_marker` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'create_marker': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
   |
| `create_multicam_from_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_multicam_source_sequence` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_project` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'create_project': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
  |
| `create_proxy_qe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_recovery_checkpoint` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_sequence` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_sequence_from_bin` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_sequence_from_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_sequence_from_preset` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_smart_bin` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_subclip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_subclips_from_markers` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `create_subsequence` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `crop_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `cut_list_csv` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'cut_list_csv': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
    |
| `deactivate_tools` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `delete_bin` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `delete_empty_tracks` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | destructive (removes tracks) |
| `delete_marker` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `delete_multiple_project_items` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `delete_preview_files` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive (throws away renders) |
| `delete_project_item` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `delete_sequence` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `delete_track` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `delivery_qc` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `denoise_clip` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `dereverb_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `deselect_all_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `detach_proxy` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | mutates proxy attachment |
| `detect_scene_edits` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | long-running analysis |
| `detect_settings_mismatch` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `detect_silence` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `diff_sequences` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `distribute_clips_evenly` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'distribute_clips_evenly': [
  {
    "expected": "array",
    "code": "invalid_type",
    "pa |
| `duplicate_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `duplicate_sequence` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `duration_marker_add` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'duration_marker_add': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path" |
| `effect_stack_report` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `enable_disable_all_effects` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'enable_disable_all_effects': [
  {
    "expected": "boolean",
    "code": "invalid_type",
   |
| `enable_disable_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `enable_disable_effect` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'enable_disable_effect': [
  {
    "expected": "boolean",
    "code": "invalid_type",
    "pa |
| `enable_multicam` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `encode_file` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | launches AME |
| `encode_project_item` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | launches AME |
| `evaluate_expression` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | arbitrary code; tested separately |
| `execute_extendscript` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | arbitrary code; tested separately |
| `export_aaf` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_aaf_with_settings` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_as_fcp_xml` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_as_project` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_audio_only` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'export_audio_only': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path":  |
| `export_captions_to_srt` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'export_captions_to_srt': [
  {
    "expected": "string",
    "code": "invalid_type",
    "pa |
| `export_edl` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_frame` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_gif` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'export_gif': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
      |
| `export_in_out_range` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'export_in_out_range': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path" |
| `export_omf` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_omf_with_settings` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_per_marker_range` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | many long exports |
| `export_per_marker_segments` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | many long exports |
| `export_project_as_fcp_xml` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_sequence` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `export_sequence_as_project` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'export_sequence_as_project': [
  {
    "expected": "string",
    "code": "invalid_type",
    |
| `export_social_preset` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'export_social_preset': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path |
| `export_stills_batch` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'export_stills_batch': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path" |
| `export_thumbnail` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'export_thumbnail': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [ |
| `export_with_burn_ins` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | long render + mutates then restores effects |
| `extend_edit` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | The in edge did not move. The playhead may already be at that edge, or the clip has no room to extend in that direction  |
| `extract_palette` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `extract_selection` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `fade_in_audio` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'fade_in_audio': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
   |
| `fade_in_video` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'fade_in_video': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
   |
| `fade_out_audio` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'fade_out_audio': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
  |
| `fade_out_video` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'fade_out_video': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
  |
| `false_color_frame` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'false_color_frame': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path":  |
| `fill_room_tone` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `find_clips_by_source` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `find_clips_with_effect` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `find_items_by_media_path` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `find_items_matching_media_path` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'find_items_matching_media_path': [
  {
    "expected": "string",
    "code": "invalid_type", |
| `find_keyframe_near_time` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'find_keyframe_near_time': [
  {
    "expected": "number",
    "code": "invalid_type",
    "p |
| `find_project_item_by_name` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'find_project_item_by_name': [
  {
    "expected": "string",
    "code": "invalid_type",
     |
| `find_tool` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'find_tool': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
       |
| `find_unused_sequences` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `fit_clip_duration` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'fit_clip_duration': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path":  |
| `flash_frame_scan` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `flatten_multicam` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `flip_horizontal` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | The Transform effect was ADDED to this clip but exposes no horizontal flip parameter, so the clip now carries an inert e |
| `flip_vertical` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | The Transform effect was ADDED to this clip but exposes no vertical flip parameter, so the clip now carries an inert eff |
| `flush_sequence_cache` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `frame_diff` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `frame_io_notes_to_markers` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `frames_to_timecode` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'frames_to_timecode': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": |
| `freeze_frame` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `freeze_frame_scan` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `generate_scope` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_active_sequence` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_all_clip_effects` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_all_markers` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_all_project_paths` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_app_property` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'get_app_property': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [ |
| `get_app_state` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_autosave_settings` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_bin_contents` | executed live, FAILED | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Bin not found |
| `get_bin_contents_recursive` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_bin_tree` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_capabilities` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_clip_adjustment_layer` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_clip_at_playhead` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_clip_at_position` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'get_clip_at_position': [
  {
    "code": "invalid_value",
    "values": [
      "video",
    |
| `get_clip_color_space` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_clip_flags` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_clip_info_extended` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_clip_links` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_clip_markers` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_clip_properties` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'get_clip_properties': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path" |
| `get_clip_speed` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_clip_speed_info` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_cloud_queue_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_color_label` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_color_management_options` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_color_space` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_conflicts` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_duplicate_media` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_ea_login_status` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_ea_status` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_ea_user_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_edit_point_list` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_effect_properties` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_encoder_presets` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_encoder_state` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_export_file_extension` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_export_progress` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | harness timeout 25s |
| `get_footage_interpretation` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_full_clip_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_full_project_overview` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_full_sequence_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_graphics_white_luminance` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_insertion_bin` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_item_color_management` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_item_info` | executed live, FAILED | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Project item not found |
| `get_item_metadata_columns` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_item_treepath` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_item_video_components` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_item_xmp_metadata` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_keyframes` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'get_keyframes': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
   |
| `get_linked_items` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_location_copy_settings` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_lumetri_preset_list` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_media_processing_status` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_metadata` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_mogrt_component` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_mogrt_text_all` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_multicam_angle_count` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_next_edit_point` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_offline_media` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_open_project_count` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_panel_visibility` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_playback_state` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_playhead_position` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_premiere_state` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_production_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_production_list` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_project_info` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_project_item_info` | executed live, FAILED | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Project item not found |
| `get_project_item_info_extended` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_project_panel_columns` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_project_panel_metadata` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_project_panel_selection` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_project_property` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'get_project_property': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path |
| `get_project_scratch_disks` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_project_stats` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_proxies_enabled` | executed live, reported success (verified:true) | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_proxy_status` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_qe_clip_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_qe_clip_settings` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_qe_component_params` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'get_qe_component_params': [
  {
    "expected": "number",
    "code": "invalid_type",
    "p |
| `get_qe_project_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_qe_sequence_props` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_qe_sequence_settings` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_render_queue_status` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_renderer_names` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_selected_clips` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_sequence_count` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_sequence_duration` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_sequence_gaps` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_sequence_in_out_points` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_sequence_info_extended` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_sequence_markers_by_type` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_sequence_render_status` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_sequence_selection` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `get_sequence_settings` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_sequence_structure` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_source_clip_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_source_clip_info_qe` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_source_monitor_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_source_monitor_position` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_source_position` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_target_tracks` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_timeline_gaps` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_timeline_render_status` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_timeline_summary` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_tool_typings` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_total_clip_count` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_track_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_unused_media` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_used_media_report` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_value_at_time` | executed live, FAILED | 2026-08-27T18:02:09Z | `live-smoke-sweep` | get_value_at_time requires clipId. |
| `get_version_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_work_area` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_workspaces` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `get_xmp_metadata` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `go_to_in_point` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `go_to_next_marker` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `go_to_out_point` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `go_to_prev_marker` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `go_to_sequence_end` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `go_to_sequence_start` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `go_to_timecode` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'go_to_timecode': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
  |
| `grade_snapshot` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'grade_snapshot': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
  |
| `grid_layout` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'grid_layout': [
  {
    "expected": "array",
    "code": "invalid_type",
    "path": [
      |
| `has_proxy` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `honesty_selftest` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | would recurse into this sweep |
| `hover_scrub_frames` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `import_edl` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | dialog: EDL import prompts for sequence/source media |
| `import_fcp_xml` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `import_folder` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `import_image_sequence` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `import_media` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `import_media_qe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `import_mogrt` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | dialog risk + writes to project |
| `import_mogrt_from_library` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | dialog risk + writes to project |
| `import_project_items` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | mutates project structure |
| `import_sequences` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `import_sequences_from_project` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `index_footage` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `insert_from_source` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `insert_srt_cue` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `inspect_dom_object` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `invert_selection` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `is_work_area_enabled` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `j_cut` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'j_cut': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
      "fra |
| `ken_burns` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `keyframe_zoom_in` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `keyframe_zoom_out` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `l_cut` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'l_cut': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
      "fra |
| `letterbox` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `lift_selection` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `link_audio_video` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `link_media_qe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `link_selection` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `lint_timeline` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_all_encoder_presets` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_audio_effects_on_clip` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_audio_transitions` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_available_audio_effects` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_available_audio_transitions` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_available_effects` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_available_transitions` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_clip_effects` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_effects_on_clip_qe` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_export_presets` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_lumetri_presets` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_markers` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_open_projects` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_project_items` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_recent_projects` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_recovery_checkpoints` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `list_sequence_tracks` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_sequences` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `list_sequences_by_name` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'list_sequences_by_name': [
  {
    "expected": "string",
    "code": "invalid_type",
    "pa |
| `list_video_transitions` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `lock_track` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `log_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `loudness_report` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `lower_third_preset` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `lumetri_basic_set` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | No Lumetri basic parameters provided. Supply at least one of: temperature, tint, saturation, exposure, contrast, highlig |
| `lumetri_creative_set` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | No Lumetri creative parameters provided. Supply at least one of: fadedFilm, sharpen, vibrance, saturation. |
| `lumetri_hsl_secondary_set` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `lumetri_report` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `lumetri_vignette_set` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | No Lumetri vignette parameters provided. Supply at least one of: amount, midpoint, roundness, feather. |
| `manage_proxies` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | mutates proxy attachment |
| `marker_to_subclip` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'marker_to_subclip': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path":  |
| `markers_from_csv` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'markers_from_csv': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [ |
| `markers_to_csv` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'markers_to_csv': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
  |
| `markers_to_notes` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'markers_to_notes': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [ |
| `match_frame` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `match_shot_color` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `match_transform` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'match_transform': [
  {
    "expected": "array",
    "code": "invalid_type",
    "path": [
  |
| `mogrt_params_report` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Clip is not a MOGRT — check isMGT() |
| `move_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `move_clip_to_track` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `move_item_to_bin` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `move_items_to_bin` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `move_playhead_to_edit` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `multicam_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `multiple_undo` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | rewinds the sweep |
| `mute_clip_audio` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `mute_track` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `nest_all_v1_clips` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive restructure |
| `nest_clips` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive restructure |
| `normalize_clip_peaks` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Gain param not found |
| `normalize_loudness` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `normalize_track_peaks` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `notes_to_markers` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'notes_to_markers': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [ |
| `nudge_clip` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'nudge_clip': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
      |
| `open_fcp_xml` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | swaps/creates project state |
| `open_fcp_xml_project` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | swaps/creates project state |
| `open_file_in_source` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `open_in_source` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `open_item_in_source_qe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `open_project` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | swaps the project mid-sweep |
| `open_project_item_in_source` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `overwrite_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `overwrite_from_source` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `paste_grade_to_clips` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'paste_grade_to_clips': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path |
| `pause_growing_file` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `ping` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `pip_layout` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `play_in_to_out` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | starts playback |
| `play_source_monitor` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | starts playback |
| `play_timeline` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | starts playback |
| `probe_media` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `production_sync_status` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `project_file_edit` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `project_file_inspect` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `project_media_report` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `qe_sequence_info` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `rate_stretch_to_fill` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `razor_all_tracks` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `razor_timeline_at_time` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `read_clipboard` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `read_sequence_captions` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `read_srt` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'read_srt': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
      " |
| `redo` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | replays unknown state |
| `reflect_dom_object` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `refresh_media` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `refresh_ui` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `relink_media` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | rewrites media links |
| `remove_all_effects` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `remove_all_effects_qe` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | destructive |
| `remove_effect` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `remove_effect_at_index` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | destructive |
| `remove_effect_by_name` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `remove_from_timeline` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `remove_keyframe` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `remove_keyframe_range` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `remove_mogrt_clip` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `remove_selected_clips` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `remove_srt_cue` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive to file |
| `remove_time_remap` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | destructive |
| `rename_bin` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `rename_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `rename_project_item` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `rename_timeline_clip` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'rename_timeline_clip': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path |
| `rename_track` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `render_audio` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | long render |
| `render_needs_preview` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `render_sequence_previews` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | long render |
| `reorder_effects` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'reorder_effects': [
  {
    "expected": "array",
    "code": "invalid_type",
    "path": [
  |
| `replace_clip` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive swap |
| `replace_clip_media` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive swap |
| `reset_motion_to_defaults` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `reset_transform` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `resolve_conflict` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | mutates shared production |
| `restore_recovery_checkpoint` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | replaces sequence state |
| `reverse_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `ripple_delete` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive |
| `ripple_trim_in` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | The source in-point moved but the clip did not ripple on the timeline, so this edit is half-applied: clip.inPoint is now |
| `ripple_trim_out` | executed live, FAILED | 2026-08-27T18:07:14Z | `live-smoke-sweep` | The source out-point moved but the clip end did not change on the timeline, so this edit is half-applied: clip.outPoint  |
| `roll_edit` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `safe_area_check` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `save_project` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `save_project_as` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | writes a new project file |
| `scene_edit_detection` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | long-running analysis |
| `scrub_source_to` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `search_footage` | executed live, FAILED | 2026-08-27T18:02:09Z | `live-smoke-sweep` | No footage index found at /Users/kahanben/.premiere-mcp/footage-index.json. Build one first with index_footage (pass the |
| `search_project_items` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `select_all_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `select_all_on_track` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `select_clips_by_color` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `select_clips_by_name` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `select_clips_in_range` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `select_clips_in_time_range` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `select_disabled_clips` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `select_item` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `send_to_after_effects` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `sequence_from_markers` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `sequence_thumbnail_strip` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `set_active_sequence` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | moves the target out from under later probes |
| `set_all_tracks_targeted` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_anti_alias_quality` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_app_property` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_autosave_settings` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_blend_mode` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_anchor_point` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_border_color` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_clip_border_color': [
  {
    "expected": "number",
    "code": "invalid_type",
    "pat |
| `set_clip_border_width` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_clip_border_width': [
  {
    "expected": "number",
    "code": "invalid_type",
    "pat |
| `set_clip_color_space` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_clip_color_space': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path |
| `set_clip_crop` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `set_clip_gain` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_clip_gain': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
   |
| `set_clip_opacity` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_pan` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_position` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_properties` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_properties_batch` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_reverse` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_clip_reverse': [
  {
    "expected": "boolean",
    "code": "invalid_type",
    "path":  |
| `set_clip_rotation` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_scale` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_scale_to_frame_size` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `set_clip_selection` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_speed_qe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_start_time` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_clip_volume` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_color_label` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_color_space_override` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_color_space_override': [
  {
    "expected": "string",
    "code": "invalid_type",
    " |
| `set_color_value` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_compressor` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_effect_property` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_encoder_xmp_options` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_essential_sound_category` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_essential_sound_category': [
  {
    "code": "invalid_value",
    "values": [
      "dia |
| `set_footage_interpretation` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_frame_blend` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_frame_blend_qe` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_frame_blend_qe': [
  {
    "expected": "boolean",
    "code": "invalid_type",
    "path" |
| `set_graphics_white_luminance` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_interpretation_frame_rate` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_item_in_out` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_item_metadata` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_item_metadata': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path":  |
| `set_item_pixel_aspect_ratio` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_item_poster_frame` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_item_poster_frame': [
  {
    "expected": "number",
    "code": "invalid_type",
    "pat |
| `set_keyframe_interpolation` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_limiter` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_location_copy_settings` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_log_color_management` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_lut_interpolation` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_lut_interpolation': [
  {
    "expected": "number",
    "code": "invalid_type",
    "pat |
| `set_marker_type` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_marker_type': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
 |
| `set_metadata` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_mogrt_color` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_mogrt_param` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_mogrt_param': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
 |
| `set_mogrt_text` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_mogrt_text': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
  |
| `set_multicam_angle` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_offline` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | breaks media links |
| `set_override_frame_rate` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_override_pixel_aspect_ratio` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_parametric_eq` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_playhead_position` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_poster_frame` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_preview_quality` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_project_panel_columns` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_project_panel_metadata` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_project_panel_selection` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_project_property` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_project_scratch_disk` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_proxies_enabled` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_qe_component_param` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_qe_component_param': [
  {
    "expected": "number",
    "code": "invalid_type",
    "pa |
| `set_render_preview_quality` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `set_renderer` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_renderer': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
    |
| `set_scale_to_frame_size` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_scale_width_height` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_scratch_disk_path` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_audio_settings` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_display_format` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_field_type` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_frame_rate` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_in_out_from_clips` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `set_sequence_in_out_points` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_in_out_qe` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `set_sequence_pixel_aspect_ratio` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_resolution` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_selection` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_sequence_selection': [
  {
    "expected": "array",
    "code": "invalid_type",
    "pat |
| `set_sequence_settings` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_start_timecode` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_sequence_zero_point` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_source_in_out` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_source_in_out_qe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_start_time` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_target_track` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_time_interpolation` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_time_interpolation_type` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_time_interpolation_type': [
  {
    "expected": "number",
    "code": "invalid_type",
   |
| `set_track_lock_qe` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_track_volume_keyframes` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'set_track_volume_keyframes': [
  {
    "expected": "array",
    "code": "invalid_type",
     |
| `set_transcode_on_ingest` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_uniform_scale` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_work_area` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_workspace` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | rearranges the UI |
| `set_xmp_metadata` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `set_zero_point` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `setup_ducking` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `share_production` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | publishes to team |
| `sharpen_clip` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `shift_srt_timing` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `shot_status_report` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `shotgrid_status_sync` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `slide_edit` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `slip_edit` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `slowmo_quality_report` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'slowmo_quality_report': [
  {
    "expected": "number",
    "code": "invalid_type",
    "pat |
| `snap_clips_to_grid` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `snapshot_state` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `speed_change` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `speed_ramp_bake` | not executed — unsafe for an unattended sweep | 2026-08-27T18:07:14Z | `live-smoke-sweep` | long ffmpeg render |
| `split_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `split_screen_layout` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'split_screen_layout': [
  {
    "expected": "array",
    "code": "invalid_type",
    "path": |
| `srt_diff` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'srt_diff': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
      " |
| `stabilize_clip` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | long-running warp analysis |
| `start_batch_encode` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | launches AME |
| `start_encode_and_monitor` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | launches AME |
| `stem_export` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `step_frames` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'step_frames': [
  {
    "expected": "number",
    "code": "invalid_type",
    "path": [
     |
| `step_source_monitor` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `stop_playback` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `stop_source_monitor` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `storyboard_bin_to_sequence` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `sync_lock_track` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'sync_lock_track': [
  {
    "code": "invalid_value",
    "values": [
      "video",
      "a |
| `sync_production` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | syncs to server |
| `three_point_edit` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `timecode_burn_in` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `timecode_to_frames` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'timecode_to_frames': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": |
| `timeline_fingerprint` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `title_card` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `todo_marker_report` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `toggle_track_visibility` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `toggle_uniform_scale` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'toggle_uniform_scale': [
  {
    "expected": "boolean",
    "code": "invalid_type",
    "pat |
| `transact_sequence_edits` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `transcribe_to_srt` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | long-running ML transcription |
| `trim_clip` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `undo` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | rewinds the sweep |
| `unlink_selection` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `unnest_sequence` | not executed — unsafe for an unattended sweep | 2026-08-27T18:02:09Z | `live-smoke-sweep` | destructive restructure |
| `update_marker` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `update_srt_cue` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `validate_project_for_export` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `validate_srt` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `verify_clip_visible` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `verify_color_grade` | not executed — harness could not build arguments | 2026-08-27T18:02:09Z | `live-smoke-sweep` | Invalid arguments for tool 'verify_color_grade': [
  {
    "expected": "object",
    "code": "invalid_type",
    "path": |
| `verify_effect_rendered` | executed live, reported success (verified:true) | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `verify_export` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `verify_export_file` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `verify_media_online` | executed live, reported success | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `verify_premiere_connection` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `verify_speed_duration` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `version_up_sequence` | executed live, reported success (verified:true) | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `vfx_pull_list` | executed live, reported success | 2026-08-27T18:07:14Z | `live-smoke-sweep` |  |
| `watermark_apply` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |
| `write_clipboard` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'write_clipboard': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
 |
| `write_sidecar_file` | not executed — harness could not build arguments | 2026-08-27T18:07:14Z | `live-smoke-sweep` | Invalid arguments for tool 'write_sidecar_file': [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": |
| `write_srt` | not executed — mutating, sweep was read-only | 2026-08-27T18:02:09Z | `live-smoke-sweep` |  |

## Sweeps on record

| ran at | harness | mode | commit | Premiere | tools recorded |
| --- | --- | --- | --- | --- | --- |
| 2026-08-27T18:07:14Z | `live-smoke-sweep` | mutate | `05766235e796f35942b60c25e2fdcb2601866b5d` | — | 195 |
| 2026-08-27T18:02:09Z | `live-smoke-sweep` | read-only | `2259e06518c141c338cdf4459e922315591c9a6b` | 26.3.2 (build 2) | 647 |

