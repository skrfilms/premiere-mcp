/**
 * MCP Resources for Adobe Premiere Pro
 * 
 * This module provides resources that give AI agents access to contextual
 * information about Adobe Premiere Pro projects, sequences, and media.
 */

import type { PremiereProTransport } from '../bridge/types.js';
import { Logger } from '../utils/logger.js';
import { BUNDLE_BUDGETS, TASK_BUNDLES } from '../tools/profiles.js';
import { defaultBridgeDir } from '../utils/scratch-paths.js';

/**
 * The temp directory this text tells the reader to type into the CEP panel.
 *
 * It has to be platform-conditional. The panel REJECTS a posix `/tmp…` path when
 * `os.platform() === 'win32'` (`sanitizeTempDirectoryInput` in cep-plugin/bridge-cep.js
 * returns `''`), so `startBridge()` bails — a Windows reader who followed this
 * documentation literally could not start the bridge at all. That was the whole of
 * docs/WINDOWS-PARITY.md P0 #2.
 *
 * EXPANDED, not `%TEMP%\premiere-mcp-bridge`. The panel expands nothing: it hands the
 * string to `path.resolve`, so a literal `%TEMP%` would create a directory actually
 * named `%TEMP%` under Premiere's working directory and the server would poll somewhere
 * else entirely — the same healthy-panel-and-every-call-times-out symptom P0 #3 was.
 *
 * The fallback order (`TEMP` → `TMP` → `C:\Temp`) and the leaf name are the panel's own
 * default, so on the common setup this string is the value already in the field. Where
 * the server's `%TEMP%` differs from the one Premiere inherited the two can still
 * disagree; that is recorded as unverified in docs/WINDOWS-PARITY.md section 3 item 6,
 * and it is why the installer tells the user to type the path rather than trust the
 * default.
 *
 * Exported as a function of (platform, env) rather than read off `process` inline so the
 * win32 branch is reachable from a macOS test: the module-level constant below binds at
 * import time and a test that stubs `process.platform` afterwards would assert nothing.
 */
export function bridgeTempDirForDocs(
  platform: string,
  env: Record<string, string | undefined>,
): string {
  return defaultBridgeDir(platform, env);
}

const DEFAULT_BRIDGE_TEMP_DIR = bridgeTempDirForDocs(process.platform, process.env);

export interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * RECIPES — the operating knowledge that stops a first attempt from failing.
 *
 * Every other resource here is a live projection of the project (sequences, clips,
 * effects). These are different: they are static text, they never touch the bridge, and
 * each one exists because a specific failure was PAID FOR on a live host and written up.
 * The bar for a recipe is that it prevents a named
 * failure. "Read before you write" is advice; "`Sequence.end` is a ticks string while
 * `Sequence.getInPoint()` is a seconds string, and reading `.ticks` off either yields the
 * literal text undefined" is a recipe — that one silently broke nine tools.
 *
 * They are resources rather than instruction text because the instructions are paid for
 * by every client on every connection, while a recipe is read by the one agent about to
 * do that particular job. Splitting them keeps the always-on cost small without hiding
 * the knowledge.
 */
interface Recipe {
  uri: string;
  name: string;
  description: string;
  /** Pure: no host request, no filesystem. Composed at read time so it cannot go stale. */
  render: () => string;
}

const RECIPES: Recipe[] = [
  {
    uri: 'premiere://recipes/first-90-seconds',
    name: 'Recipe: first 90 seconds (connect, orient, one verified edit)',
    description:
      'The exact call sequence for an agent that has never used this server: prove the bridge, orient in the project, make one small edit, verify it by readback, undo it. Read this before your first tool call.',
    render: () =>
      [
        '# First 90 seconds: connect, orient, make ONE verified edit, confirm it',
        '',
        'Prove the whole path — transport, engine, project, mutation, verification — before',
        'attempting the job you were asked to do. An agent that opens with the real edit cannot',
        'tell a dead bridge from a bad argument, and will report the wrong cause.',
        '',
        'Ten calls. Nothing here is destructive, and the mutation is reversed in one call.',
        '',
        '1. ping',
        '   Is the bridge answering at all? A timeout means the CEP panel is not running:',
        '   in Premiere, Window > Extensions > MCP Bridge (CEP), set the temp directory to',
        `   ${DEFAULT_BRIDGE_TEMP_DIR}, Start Bridge. Premiere with NO project open never loads the`,
        '   panel at all, so "the app is running" is not "the bridge is up".',
        '',
        '2. get_capabilities',
        '   This build s real tool count, the active profile, the measured context cost, and which',
        '   local backends exist (ffmpeg, Whisper). Read the count here rather than quoting one from',
        '   any document, including this one.',
        '',
        '3. verify_premiere_connection',
        '   Round-trips a value through ExtendScript. Step 1 proves the file IPC; this proves the',
        '   engine still evaluates script. They fail independently.',
        '',
        '4. get_project_info',
        '   Name, path, modified flag. If no project is open, stop and say so — most tools need one.',
        '',
        '5. list_sequences, then get_active_sequence',
        '   Sequence IDs are stable across sessions; names are not unique. Carry the ID from here on.',
        '',
        '6. get_timeline_summary',
        '   Tracks, clip counts and duration in one round trip, instead of walking tracks yourself.',
        '',
        '7. check_offline_media',
        '   Offline media makes later renders and exports fail in ways that read like tool bugs.',
        '',
        '8. THE SMALL VERIFIED EDIT: add_marker, at about 1 second on the active sequence.',
        '   Markers are the cheapest true mutation here — no media, no render, no re-encode.',
        '',
        '9. list_markers',
        '   THIS is the verification, and it is the step agents skip. Compare what you asked for',
        '   against what exists: name, time, type. Do not treat the response of step 8 as proof;',
        '   treat this comparison as proof.',
        '',
        '10. delete_marker (or undo)',
        '    Leave the project as you found it.',
        '',
        'Then report, in one short paragraph: bridge live, engine live, project name, sequence name',
        'and ID, "added a marker and read it back at 1s", "removed it". That report is the deliverable',
        'of the first 90 seconds — a claim you have actually checked.',
        '',
        'Branches:',
        '- Step 8 returns verified:false -> read premiere://recipes/verify-or-refuse and do NOT start',
        '  the user s task yet.',
        '- Step 1 or 3 times out, or either hangs -> read premiere://recipes/recovery-first.',
        '- A tool you need is not in your tool list -> find_tool with a keyword, then',
        '  get_tool_typings for its exact arguments, then call_tool to run it. Nothing is missing',
        '  just because it is not advertised.',
        '',
        'Cheapest selection for this path: PREMIERE_MCP_PROFILE=task-orient.',
        'See premiere://recipes/task-bundles for the bundle that matches the job you were asked to do.',
      ].join('\n'),
  },
  {
    uri: 'premiere://recipes/verify-or-refuse',
    name: 'Recipe: what to do when a tool returns verified:false',
    description:
      'How this server proves an edit, which verification tool closes which loop, and the exact reporting rule when verification fails or is impossible. Prevents reporting an unconfirmed edit as done.',
    render: () =>
      [
        '# Verified, unverifiable, or failed — and what you are allowed to say',
        '',
        'Every mutating tool here returns both success and verified. They mean different things:',
        '',
        '  success:true, verified:true   The write happened AND a readback confirmed it. Report done.',
        '  success:true, verified:false  The call did not throw and nothing proved the effect. This is',
        '                                NOT done. Say what you attempted and that it is unconfirmed.',
        '  success:false                 It failed, and the error field says why. Read the error before',
        '                                retrying; most of them name the setting or API responsible.',
        '',
        'The failure this rule exists to prevent is real and was shipped once: nine tools reported',
        'verified:true while doing nothing at all, because they never compared a readback. Three of',
        'them moved the playhead to the literal string undefined and called it success.',
        '',
        '## When verified is false, do this in order',
        '',
        '1. Read the error/message/results fields. This build reports partial application as partial:',
        '   "3 of 4 parameters applied" is information, not noise, and names the one that did not.',
        '2. Verify independently rather than retrying blind. A retry of a call that silently no-ops',
        '   produces a second silent no-op and a stronger false belief.',
        '3. If the independent check also says no, stop and report the honest limitation. Do not',
        '   escalate to execute_extendscript to force it unless the user asked for that risk.',
        '4. If you changed anything before the failure, offer undo or restore_recovery_checkpoint.',
        '',
        '## The independent check for each kind of edit',
        '',
        '  effect parameter        get_effect_properties, then verify_effect_rendered',
        '  Lumetri grade           lumetri_report (setValue clamps silently; the report is how you',
        '                          learn a value was rejected), then verify_color_grade',
        '  keyframes               get_keyframes, get_value_at_time',
        '  transform / opacity     get_clip_properties, then verify_clip_visible',
        '  timeline edit           lint_timeline plus get_timeline_gaps; assert_clips_unchanged when',
        '                          you need to prove you did NOT disturb something',
        '  speed change            verify_speed_duration',
        '  captions                read_sequence_captions for the ingested track, validate_srt for the',
        '                          file on disk',
        '  audio level / loudness  loudness_report before and after; the delta is the proof',
        '  export                  verify_export (ffprobe against the sequence), verify_export_file',
        '  media health            check_offline_media, verify_media_online',
        '  anything visual         capture_program_output — the composited Program frame. The DOM can',
        '                          say a property changed while the picture did not.',
        '',
        'export_frame and export_thumbnail are not equivalent to capture_program_output: on this build',
        'the thumbnail path falls back to the SOURCE frame with no effects, no transitions and nothing',
        'from higher tracks. It says so in its response; believe that field rather than the filename.',
        '',
        '## Verification that cannot fail is worse than none',
        '',
        'Two traps that produced convincing false confirmations here:',
        '',
        '- A no-op and a real change read back IDENTICALLY when the target already equals the current',
        '  value. Capture the before value and report whether anything actually changed.',
        '- Assigning to a property that does not exist creates it on the script object, so the readback',
        '  confirms your own write and says nothing about Premiere. enable_disable_effect did exactly',
        '  this before it was fixed. If a readback always agrees with you, distrust it.',
        '',
        'honesty_selftest exercises this server s own verification claims. api_surface_report is the',
        'live version of the capability wall — prefer both over any prose, including this file.',
      ].join('\n'),
  },
  {
    uri: 'premiere://recipes/effect-match-names',
    name: 'Recipe: effects, matchNames, and the apply-then-set pairing',
    description:
      'The verified effect matchNames on this build, why display names fail, and the two-call pattern (apply, then set a property, then read it back). Prevents a silent no-op from a wrong effect identifier.',
    render: () =>
      [
        '# Effects: the identifier that works, and the second call you must make',
        '',
        '## Use matchNames, not display names',
        '',
        'Display names are localized and vary per build. matchNames do not. Verified on 26.3.2:',
        '',
        '  Opacity        AE.ADBE Opacity',
        '  Motion         AE.ADBE Motion',
        '  Lumetri Color  AE.ADBE Lumetri',
        '  Gaussian Blur  AE.Impact_Blur_FX',
        '',
        'Anything else: list_available_effects and read the matchName out of the result. Guessing an',
        'AE.-prefixed string is the single most common cause of an apply call that reports nothing',
        'wrong and changes nothing.',
        '',
        '## One call is never enough',
        '',
        'apply_effect ADDS the effect with default parameters. It cannot set a value. The pattern is:',
        '',
        '  1. list_clip_effects        does the clip already carry it? Applying twice stacks twice.',
        '  2. apply_effect             add it by matchName.',
        '  3. get_effect_properties    learn the REAL parameter names and indices on this build.',
        '  4. set_effect_property      set the value.',
        '  5. get_effect_properties    read it back. This is the verification, not step 4 s response.',
        '  6. capture_program_output   confirm the frame changed, when the effect is meant to be seen.',
        '',
        'This pairing used to be missing from the default profile: an agent could add Gaussian Blur and',
        'then had no way to set its blurriness. Every profile that advertises an apply tool now',
        'advertises the setter and the reader too.',
        '',
        '## Parameter identity is by index, guarded by name',
        '',
        'Lumetri s flat parameter list REPEATS names — Temperature appears at 14 and again at 101,',
        'Contrast at 20 and 103, Saturation at 16, 43 and 105 — so the index is the primary key and the',
        'name is the guard. A hardcoded index that shifts in a future build would write a real value',
        'into the wrong parameter and mis-grade a shot with no error at all, which is why the Lumetri',
        'tools check the name at the index before writing and report which route they used.',
        '',
        'Set Lumetri numerically through lumetri_basic_set, lumetri_creative_set,',
        'lumetri_vignette_set and lumetri_hsl_secondary_set, then read lumetri_report. Attach it with',
        'apply_lumetri_preset; that path is fingerprint-verified and more reliable than adding the',
        'effect by name.',
        '',
        '## Values that are not what they look like',
        '',
        '- Blend Mode is a NUMERIC INDEX, not a name. setValue("Multiply") raises Illegal Parameter',
        '  type. set_blend_mode takes an integer, verifies by readback, and deliberately refuses to',
        '  map names to indices: the ordering is undocumented, and an unverified table would silently',
        '  apply the WRONG mode, which is worse than refusing.',
        '- color_correct maps brightness to Lumetri Exposure, because Lumetri here has no Brightness',
        '  parameter. It rejects hue outright rather than accepting an adjustment it cannot apply.',
        '- A two-value parameter (position, anchor point) needs two values. Passing a scalar reads as',
        '  Illegal Parameter type and looks like a broken tool.',
        '',
        '## Audio effects have a trap of their own',
        '',
        'Some audio effects are obsolete on current builds, and ADDING one opens a modal dialog that',
        'blocks the bridge until a human presses Escape — every queued call stalls behind it. Call',
        'list_available_audio_effects and use what this build actually offers. See',
        'premiere://recipes/recovery-first for what to do once a dialog is already up.',
      ].join('\n'),
  },
  {
    uri: 'premiere://recipes/time-units',
    name: 'Recipe: ticks vs seconds (the trap that broke nine tools)',
    description:
      'Measured units for every Premiere time accessor on 26.3.2, including two that share a type and differ in unit, and the argument-type rule that silently zeroes an in point. Prevents inert edits that report success.',
    render: () =>
      [
        '# Time on this host: same type, different unit',
        '',
        'Measured on Premiere 26.3.2. This table cost nine silently inert tools, three of which',
        'reported verified:true while doing nothing:',
        '',
        '  Sequence.end                              string   TICKS',
        '  Sequence.getInPoint() / getOutPoint()     string   SECONDS',
        '  ProjectItem.getInPoint() / getOutPoint()  Time     use .ticks or .seconds',
        '  TrackItem.start / end / inPoint / outPoint Time    use .ticks or .seconds',
        '',
        'The two Sequence accessors have THE SAME TYPE and DIFFERENT UNITS, with nothing in the value',
        'to tell them apart. Reading .ticks off either one yields undefined, which becomes the literal',
        'string undefined at the playhead setter (the playhead silently does not move) or NaN inside a',
        'duration sum (serialised as null). Nothing throws.',
        '',
        'Consequences worth carrying:',
        '',
        '- Do NOT write a unit-sniffing helper. A magnitude heuristic cannot tell 2 seconds from',
        '  2 ticks, and a wrong guess is undetectable. Convert per accessor, explicitly.',
        '- setInPoint / setOutPoint units depend on the ARGUMENT TYPE: a number is seconds, a string is',
        '  ticks. So setInPoint("1.5") sets 1.5 ticks, which reads back as 0 — a stringified seconds',
        '  value silently zeroes the point.',
        '- An UNSET sequence in/out range reads back as a small NEGATIVE seconds value, about one frame',
        '  below zero. Treat negative as "not set" rather than as a position, or you will try to move',
        '  the playhead to a negative tick.',
        '- For an exact-duration deliverable, use the FRAME count from get_sequence_duration, not the',
        '  seconds value. Seconds round, and a 30.04s spot is a rejected spot.',
        '- The WORK AREA setters are INERT on 26.3.2. They accept a value, throw nothing, and the',
        '  readback never moves, even after enabling the work area. Premiere 2026 deprecated the work',
        '  area bar; use set_sequence_in_out_points and get_sequence_in_out_points instead. set_work_area',
        '  says this rather than reporting a bare mismatch and inviting a retry that cannot succeed.',
        '- Prefer timecode_to_frames / frames_to_timecode over hand-rolled arithmetic, and pass the',
        '  sequence frame rate explicitly when you know it.',
      ].join('\n'),
  },
  {
    uri: 'premiere://recipes/qe-fragility',
    name: 'Recipe: what QE can and cannot do, and which calls kill the script',
    description:
      'The QE-only capabilities, the per-build fragility rule, and the measured list of QE properties that are fatal to read or call on 26.3.2 (a try/catch does not save you). Prevents an opaque bridge failure.',
    render: () =>
      [
        '# QE: the undocumented layer, and where it bites',
        '',
        'QE (qe.project, qe.getActiveSequence, ...) is Adobe s internal scripting layer. It is not in',
        'the official API, it is not guaranteed between builds, and it is the ONLY route to several',
        'things editors ask for: adding an effect to a clip, clip speed, frame blend, time',
        'interpolation, and some proxy and import paths. That is an opportunity and a hazard in one',
        'object.',
        '',
        'Rules:',
        '',
        '1. QE-backed tools verify by READBACK. Trust verified:true, never success:true alone.',
        '2. Expect breakage on a Premiere update, not gradual decay. When a QE tool starts failing after',
        '   an update, that is the expected failure mode, not a regression in this server.',
        '3. Prefer a DOM path when one exists. apply_lumetri_preset over adding Lumetri through QE;',
        '   set_effect_property over poking QE component params.',
        '',
        '## Measured on 26.3.2: calls that kill the whole script',
        '',
        'These do not throw. They terminate the running script beneath JavaScript, and the bridge',
        'reports the generic "ExtendScript execution failed" message that tells a caller nothing:',
        '',
        '  FATAL TO CALL   qeClip.setBorderWidth, setBorderColor, setReverse, setAntiAliasQuality',
        '  FATAL TO READ   qeClip.reverse, borderWidth, borderColor, alignment, antiAliasQuality,',
        '                  startPercent, endPercent, switchSources',
        '  SAFE TO READ    name, type, start, end, duration, mediaType, numComponents, speed,',
        '                  reversed, frameBlend, multicamEnabled, scaleToFrameSize, staticClipGain,',
        '                  timeInterpolationType',
        '  SAFE TO CALL    setFrameBlend, setScaleToFrameSize, setSpeed, addVideoEffect, remove',
        '',
        'The safe setters still need their arguments in full. setScaleToFrameSize() with no argument',
        'throws "Error: Not Enough Parameters" rather than defaulting to true, so pass the boolean',
        'explicitly — measured on 26.3.2. To normalise many clips, set_scale_to_frame_size_batch does a',
        'whole track (or a clip-id list) in one call with a per-clip readback, instead of one round-trip',
        'per clip through set_clip_scale_to_frame_size.',
        '',
        'Note reversed (safe) against reverse (fatal): one letter, and the difference is whether the',
        'script survives. A try/catch around these does NOT help — the failure is beneath the language,',
        'and wrapping them made the code look defended while get_qe_clip_info still failed completely.',
        'That tool no longer reads the fatal properties; it lists them as unreadable with the reason.',
        '',
        'set_clip_reverse, set_clip_border_width and set_clip_border_color therefore refuse up front',
        'with available:false instead of emitting a call that kills the script. For reverse, the route',
        'that does work is set_clip_speed_qe with reverse true.',
        '',
        'These are script-fatal, not engine-fatal: the next command works normally. A different class',
        'of failure is a call that opens a MODAL dialog (createNewSequence used to) — that blocks the',
        'host until a human presses Escape. See premiere://recipes/recovery-first.',
        '',
        '## The engine is ES3-ish, and the shape is not guessable',
        '',
        'Measured, because every rule of thumb about this was wrong in both directions:',
        '',
        '  PRESENT  Array.prototype.map, filter, indexOf, Array.isArray',
        '  ABSENT   forEach, find, findIndex, some, every, reduce, lastIndexOf,',
        '           String.prototype.trim, startsWith, endsWith, includes, padStart, padEnd,',
        '           repeat, Function.prototype.bind, Object.keys, Object.assign, Set, Map',
        '',
        'It has map and filter but not forEach. If you are writing raw script through',
        'execute_extendscript or batch_execute, stay inside the PRESENT column; two tools shipped',
        'broken because they called trim and startsWith.',
      ].join('\n'),
  },
  {
    uri: 'premiere://recipes/recovery-first',
    name: 'Recipe: recovery first (checkpoints, modal dialogs, dead engine)',
    description:
      'The order of operations that keeps a failed edit recoverable, plus the three ways this host stops answering (modal dialog, dead engine, missing panel) and what an agent can and cannot do about each.',
    render: () =>
      [
        '# Recovery first: take the snapshot before you need it',
        '',
        'Order of operations for anything bulk, destructive, or new:',
        '',
        '1. create_recovery_checkpoint before the first mutation. Bulk silence removal, batch replace,',
        '   a conform, a settings change — anything that touches many clips at once.',
        '   list_recovery_checkpoints and restore_recovery_checkpoint are the way back.',
        '   PREMIERE_MCP_AUTO_CHECKPOINT=1 makes this automatic for the operator who wants it.',
        '2. duplicate_sequence (clearContents false) before restructuring a cut a human will want back.',
        '   Sequence IDs are stable, so the copy stays addressable.',
        '3. Prefer undo for a single step and multiple_undo for a short run of them. Undo is cheap and',
        '   exact; a checkpoint is the tool for "I have made twenty changes and one of them was wrong".',
        '4. save_project at a known-good point. Not for the contents — so that Premiere has no unsaved',
        '   changes to ask about later. A Save changes? dialog is itself a way to wedge the host.',
        '',
        '## The host stops answering in three distinguishable ways',
        '',
        'A. A MODAL DIALOG IS UP. Everything queued behind it stalls, and the timeout looks exactly',
        '   like a dead engine. Common causes: Link Media on a project with missing media, an obsolete',
        '   audio effect being added, a New Sequence dialog.',
        '   What you can do: nothing through this bridge. THE BRIDGE CANNOT ADVANCE A DIALOG. Say so',
        '   plainly and ask the human to bring Premiere forward and press Escape, or to answer the',
        '   dialog. Do not retry the call in the meantime; a retry queues another blocked request.',
        '   Do not try to script the UI: Premiere exposes ZERO windows to the accessibility API, so',
        '   clicking a dialog button cannot work, and sending an AppleEvent to a modal-blocked Adobe',
        '   app hangs the sender too — precisely when you want to talk to it, it cannot answer.',
        '   (An operator running unattended has a keystroke-based escape hatch outside this server;',
        '   from inside a conversation, the honest move is to hand it to the human.)',
        '',
        'B. THE ENGINE IS DEAD. The panel is alive, the file IPC accepts requests, and script no longer',
        '   evaluates. ping may still answer while verify_premiere_connection does not — that split is',
        '   the signature. Recovery is a Premiere relaunch, which is a human action, and it must reopen',
        '   THE PROJECT: Premiere on its Home screen never loads the panel, so relaunching the app',
        '   alone leaves the bridge down. Report which project path to reopen.',
        '',
        'C. THE PANEL IS NOT RUNNING. Nothing answers, including ping, and there is no partial state.',
        `   Window > Extensions > MCP Bridge (CEP), temp directory ${DEFAULT_BRIDGE_TEMP_DIR},`,
        '   Start Bridge. If a timeout message blames the temp directory, check that first: the server',
        '   and the panel must agree on the path.',
        '',
        'In all three cases: report the state you observed and the specific human action needed. A',
        'timeout reported as "the edit may have failed" is useless; "the bridge is not answering ping,',
        'so the panel is down, open it from Window > Extensions" is actionable.',
        '',
        '## After any recovery, re-orient before you resume',
        '',
        'get_active_sequence, get_timeline_summary, and the verification tool for whatever you were',
        'mid-way through. A relaunched Premiere may have reopened an older save, and the edit you',
        'believe you made may not be in the project you are now talking to.',
      ].join('\n'),
  },
  {
    uri: 'premiere://recipes/honest-wall',
    name: 'Recipe: what this server cannot do, and the honest alternative',
    description:
      'Editor functions with no scripting surface on this build, each with the route that does work. Prevents burning calls on something the API cannot express. api_surface_report is the live version.',
    render: () =>
      [
        '# The honest wall',
        '',
        'These are not missing features; they are absences in Premiere s scripting surface. Each line',
        'names the alternative, because a wall entry with no route out just moves the dead end.',
        'api_surface_report is the LIVE version of this list, with evidence per entry and a record of',
        'what has since been cracked — prefer it over this text, which is a summary.',
        '',
        '- FREE-DRAW MASKS on an effect (bezier/ellipse geometry in Effect Controls): no DOM or QE API.',
        '  Route: apply_video_effect with Track Matte Key, then set_effect_property to pick the matte',
        '  layer and the luma/alpha mode; or lumetri_hsl_secondary_set for colour-keyed isolation. Mask',
        '  parameters such as feather and inversion ARE reachable through the project XML, but only',
        '  with a save, close and reopen cycle.',
        '- CAPTION READ / UPDATE / DELETE inside Premiere: the DOM can INGEST an .srt and nothing more.',
        '  Route: do all caption editing on the file on disk — read_srt, validate_srt, update_srt_cue,',
        '  insert_srt_cue, remove_srt_cue, shift_srt_timing, write_srt — then create_caption_track, then',
        '  read_sequence_captions to prove the track exists.',
        '- ESSENTIAL SOUND auto-analysis: panel logic, not exposed. Route: apply the effects directly',
        '  (denoise_clip, set_parametric_eq, set_compressor) and set_essential_sound_category to tag the',
        '  clip so a human sees the right panel state.',
        '- PREMIERE S INTERNAL CLIPBOARD: no copy/paste API for clips. read_clipboard and write_clipboard',
        '  are the SYSTEM TEXT clipboard only. Route: copy_effects_between_clips, copy_grade with',
        '  paste_grade_to_clips, or duplicate_clip.',
        '- RENDER AND REPLACE (bake to new source media): not scriptable. Route: bake_speed_change for a',
        '  constant retime, or export and relink.',
        '- MERGED CLIP CREATION: detection only. Route: link_audio_video.',
        '- ESSENTIAL GRAPHICS advanced authoring (gradients, tracking, shape layers): not exposed.',
        '  Route: import_mogrt with set_mogrt_text / set_mogrt_param, or add_text_overlay for something',
        '  simple. MOGRT text writes can no-op on an opaque token, so add_text_overlay reads the source',
        '  text back and reports partial or failed rather than claiming success.',
        '- WORK AREA writes: accepted and inert on 26.3.2. Route: set_sequence_in_out_points.',
        '- POSTER FRAME: no setter exists on this build, and set_poster_frame reports that rather than',
        '  pretending. Route: none through scripting — tell the human to set it in the Project panel',
        '  (right-click the clip, Set Poster Frame). A human action is still an alternative; silence is not.',
        '- BLEND MODE BY NAME: the ordering is undocumented. Route: set_blend_mode with an integer index,',
        '  verified by readback.',
        '- CLIP REVERSE and CLIP BORDERS through QE: the calls are fatal to the script on this build.',
        '  Route: set_clip_speed_qe with reverse true. Borders have no working route; say so.',
        '- BEAT / TEMPO DETECTION: no API and no detector in this build. Route: establish the beat map',
        '  yourself and record it with add_marker, then cut from the markers so the two cannot drift.',
        '',
        'Known-broken on 26.3.2 rather than absent, so do not build a plan on them without checking:',
        'audio_crossfade_at_cut and apply_morph_cut report Invalid parameter, set_sequence_field_type',
        'and version_up_sequence report Illegal Parameter type, and match_shot_color is recorded as a',
        'suspected engine killer that was never cleared. For a crossfade, add_transition with an audio',
        'transition from list_available_audio_transitions is the route that works.',
        '',
        'If you find one of these works now, that is worth reporting: a stale cannot-do list is the same',
        'class of lie as a fake success, because it tells an agent to stop trying something that works.',
      ].join('\n'),
  },
  {
    uri: 'premiere://recipes/task-bundles',
    name: 'Recipe: pick the tool bundle that matches the task',
    description:
      'The task-shaped tool bundles this build ships, their measured context cost, and how to reach anything a bundle omits without restarting. Generated from the live profile table.',
    render: () => {
      const lines: string[] = [
        '# Task bundles: a menu shaped like the request',
        '',
        'The advertised tool list is a CURATED subset chosen to save your context, not the whole',
        'build. Which subset is an operator setting, PREMIERE_MCP_PROFILE, read once at startup.',
        'get_capabilities reports the active one and the full list of names.',
        '',
        'Bundles are composed per TASK, and each one includes the verification tools that task needs,',
        'so the first call cannot force a profile switch. Measured cost below is the advertised list',
        '(the bundle plus the always-kept discovery and routing tools) as an estimated token count and',
        'a share of a 200k context window. The estimate is chars/4, not a tokenizer, and is re-measured',
        'by the test suite so it cannot drift silently.',
        '',
      ];
      const label: Record<string, string> = {
        'task-orient': 'connect, orient, and make one small verified edit',
        'task-rough-cut': 'build a rough cut from a folder of footage',
        'task-cut-dialogue': 'cut dialogue: silence removal, trims, audio smoothing',
        'task-caption': 'caption a sequence, edit the cues, ingest and prove the track',
        'task-grade': 'grade shots numerically, read the values back, propagate',
        'task-motion': 'animate clips and dial in effects with eased keyframes',
        'task-conform-deliver': 'conform settings, QC, export, and verify the file',
        'task-review-notes': 'round-trip review notes and markers, build a review reel',
      };
      for (const name of Object.keys(TASK_BUNDLES)) {
        const budget = BUNDLE_BUDGETS[name];
        const cost = budget
          ? `${budget.tools} advertised tools, about ${budget.approxTokens} estimated tokens (~${
              Math.round((budget.approxTokens / 200_000) * 1000) / 10
            }% of a 200k context)`
          : 'cost not measured';
        lines.push(`  ${name}`);
        lines.push(`    ${label[name] || 'task bundle'}`);
        lines.push(`    ${cost}`);
      }
      lines.push('');
      lines.push('Size-shaped selections also exist: core (the everyday editorial default), read-only');
      lines.push('(non-mutating introspection, safe for an untrusted agent), audio, color, and all.');
      lines.push('');
      lines.push('## A bundle never hides a capability');
      lines.push('');
      lines.push('If the tool you need is not in your list:');
      lines.push('');
      lines.push('  find_tool          searches the WHOLE catalogue by keyword and marks a hidden match');
      lines.push('                     exposed:false with the reason, instead of omitting it.');
      lines.push('  get_tool_typings   gives you that tool s exact argument shape before you call it.');
      lines.push('  call_tool          invokes it, whether or not it is advertised.');
      lines.push('  activate_tools     promotes it into your advertised list for the rest of the session.');
      lines.push('');
      lines.push('The one exception is deliberate: read-only, an exact PREMIERE_MCP_TOOLS allowlist, and');
      lines.push('any PREMIERE_MCP_EXCLUDE veto are AUTHORITY boundaries, and the router refuses to reach');
      lines.push('past them. A refusal names the setting responsible, so treat it as a real boundary and');
      lines.push('report it to the user rather than retrying.');
      return lines.join('\n');
    },
  },
];

export class PremiereProResources {
  private bridge: PremiereProTransport;
  private logger: Logger;

  constructor(bridge: PremiereProTransport) {
    this.bridge = bridge;
    this.logger = new Logger('PremiereProResources');
  }

  getAvailableResources(): MCPResource[] {
    return [
      {
        uri: 'premiere://project/info',
        name: 'Current Project Information',
        description: 'Information about the currently open Premiere Pro project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://project/sequences',
        name: 'Project Sequences',
        description: 'List of all sequences in the current project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://project/media',
        name: 'Project Media',
        description: 'List of all media items in the current project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://project/bins',
        name: 'Project Bins',
        description: 'Organizational structure of bins in the current project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://timeline/clips',
        name: 'Timeline Clips',
        description: 'All clips currently on the timeline',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://timeline/tracks',
        name: 'Timeline Tracks',
        description: 'Information about video and audio tracks',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://timeline/markers',
        name: 'Timeline Markers',
        description: 'Markers and their positions on the timeline',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://effects/available',
        name: 'Available Effects',
        description: 'List of all available effects in Premiere Pro',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://effects/applied',
        name: 'Applied Effects',
        description: 'Effects currently applied to clips',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://transitions/available',
        name: 'Available Transitions',
        description: 'List of all available transitions in Premiere Pro',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://export/presets',
        name: 'Export Presets',
        description: 'Available export presets and their settings',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://project/metadata',
        name: 'Project Metadata',
        description: 'Metadata information for the current project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://config/get_instructions',
        name: 'Premiere Operating Instructions',
        description: 'Attach this before editing to give the model workflow and safety guidance for using the Premiere MCP server',
        mimeType: 'text/plain'
      },
      // Static, host-independent recipes. Listed after the live projections so a client
      // that truncates the list still sees the project state it came for.
      ...RECIPES.map((recipe) => ({
        uri: recipe.uri,
        name: recipe.name,
        description: recipe.description,
        mimeType: 'text/plain',
      })),
    ];
  }

  /** The recipe URIs, for tests and for anything that wants to enumerate them. */
  static recipeUris(): string[] {
    return RECIPES.map((recipe) => recipe.uri);
  }

  async readResource(uri: string): Promise<any> {
    this.logger.info(`Reading resource: ${uri}`);

    // Recipes are pure text and must never reach the host: an agent reading guidance
    // while the bridge is down is the exact case they exist for.
    const recipe = RECIPES.find((candidate) => candidate.uri === uri);
    if (recipe) return recipe.render();

    switch (uri) {
      case 'premiere://project/info':
        return await this.getProjectInfo();
      
      case 'premiere://project/sequences':
        return await this.getProjectSequences();
      
      case 'premiere://project/media':
        return await this.getProjectMedia();
      
      case 'premiere://project/bins':
        return await this.getProjectBins();
      
      case 'premiere://timeline/clips':
        return await this.getTimelineClips();
      
      case 'premiere://timeline/tracks':
        return await this.getTimelineTracks();
      
      case 'premiere://timeline/markers':
        return await this.getTimelineMarkers();
      
      case 'premiere://effects/available':
        return await this.getAvailableEffects();
      
      case 'premiere://effects/applied':
        return await this.getAppliedEffects();
      
      case 'premiere://transitions/available':
        return await this.getAvailableTransitions();
      
      case 'premiere://export/presets':
        return await this.getExportPresets();
      
      case 'premiere://project/metadata':
        return await this.getProjectMetadata();

      case 'premiere://config/get_instructions':
        return this.getInstructions();
      
      default:
        throw new Error(`Resource '${uri}' not found`);
    }
  }

  getResource(uri: string): MCPResource | undefined {
    return this.getAvailableResources().find((resource) => resource.uri === uri);
  }

  private async getProjectInfo(): Promise<any> {
    const script = `
      var project = app.project;
      JSON.stringify({
        id: project.documentID,
        name: project.name,
        path: project.path,
        isModified: project.dirty,
        settings: {
          scratchDiskPath: project.scratchDiskPath,
          captureFormat: project.captureFormat,
          previewFormat: project.previewFormat
        },
        statistics: {
          sequenceCount: project.sequences.numSequences,
          projectItemCount: project.rootItem.children.numItems
        }
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getProjectSequences(): Promise<any> {
    const script = `
      var project = app.project;
      var sequences = [];
      
      for (var i = 0; i < project.sequences.numSequences; i++) {
        var sequence = project.sequences[i];
        sequences.push({
          id: sequence.sequenceID,
          name: sequence.name,
          frameRate: sequence.framerate,
          duration: sequence.end - sequence.zeroPoint,
          videoTracks: sequence.videoTracks.numTracks,
          audioTracks: sequence.audioTracks.numTracks,
          settings: {
            frameSize: {
              width: sequence.frameSizeHorizontal,
              height: sequence.frameSizeVertical
            },
            pixelAspectRatio: sequence.pixelAspectRatio,
            fieldType: sequence.fieldType
          }
        });
      }
      
      JSON.stringify({
        sequences: sequences,
        totalCount: project.sequences.numSequences
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getProjectMedia(): Promise<any> {
    const script = `
      var project = app.project;
      var mediaItems = [];
      
      function traverseProjectItems(item) {
        for (var i = 0; i < item.children.numItems; i++) {
          var child = item.children[i];
          if (child.type === ProjectItemType.CLIP) {
            mediaItems.push({
              id: child.nodeId,
              name: child.name,
              type: child.type,
              mediaPath: child.getMediaPath(),
              duration: child.getOutPoint() - child.getInPoint(),
              frameRate: child.getVideoFrameRate(),
              hasVideo: child.hasVideo(),
              hasAudio: child.hasAudio(),
              metadata: {
                creationTime: child.getCreationTime(),
                modificationTime: child.getModificationTime(),
                fileSize: child.getFileSize()
              }
            });
          } else if (child.type === ProjectItemType.BIN) {
            traverseProjectItems(child);
          }
        }
      }
      
      traverseProjectItems(project.rootItem);
      
      JSON.stringify({
        mediaItems: mediaItems,
        totalCount: mediaItems.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getProjectBins(): Promise<any> {
    const script = `
      var project = app.project;
      var bins = [];
      
      function traverseBins(item, depth = 0) {
        for (var i = 0; i < item.children.numItems; i++) {
          var child = item.children[i];
          if (child.type === ProjectItemType.BIN) {
            bins.push({
              id: child.nodeId,
              name: child.name,
              depth: depth,
              itemCount: child.children.numItems,
              path: child.treePath
            });
            traverseBins(child, depth + 1);
          }
        }
      }
      
      traverseBins(project.rootItem);
      
      JSON.stringify({
        bins: bins,
        totalCount: bins.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getTimelineClips(): Promise<any> {
    const script = `
      var project = app.project;
      var clips = [];
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        // Video tracks
        for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
          var track = sequence.videoTracks[v];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              trackType: 'video',
              trackIndex: v,
              startTime: clip.start,
              endTime: clip.end,
              duration: clip.duration,
              inPoint: clip.inPoint,
              outPoint: clip.outPoint,
              mediaPath: clip.projectItem ? clip.projectItem.getMediaPath() : null,
              effects: clip.components.numItems
            });
          }
        }
        
        // Audio tracks
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var track = sequence.audioTracks[a];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              trackType: 'audio',
              trackIndex: a,
              startTime: clip.start,
              endTime: clip.end,
              duration: clip.duration,
              inPoint: clip.inPoint,
              outPoint: clip.outPoint,
              mediaPath: clip.projectItem ? clip.projectItem.getMediaPath() : null,
              effects: clip.components.numItems
            });
          }
        }
      }
      
      JSON.stringify({
        clips: clips,
        totalCount: clips.length,
        activeSequence: project.activeSequence ? project.activeSequence.name : null
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getTimelineTracks(): Promise<any> {
    const script = `
      var project = app.project;
      var tracks = [];
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        // Video tracks
        for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
          var track = sequence.videoTracks[v];
          tracks.push({
            id: track.id,
            name: track.name,
            type: 'video',
            index: v,
            enabled: track.enabled,
            locked: track.locked,
            muted: track.muted,
            clipCount: track.clips.numItems,
            transitionCount: track.transitions.numItems
          });
        }
        
        // Audio tracks
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var track = sequence.audioTracks[a];
          tracks.push({
            id: track.id,
            name: track.name,
            type: 'audio',
            index: a,
            enabled: track.enabled,
            locked: track.locked,
            muted: track.muted,
            clipCount: track.clips.numItems,
            transitionCount: track.transitions.numItems
          });
        }
      }
      
      JSON.stringify({
        tracks: tracks,
        totalCount: tracks.length,
        activeSequence: project.activeSequence ? project.activeSequence.name : null
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getTimelineMarkers(): Promise<any> {
    const script = `
      var project = app.project;
      var markers = [];
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        for (var i = 0; i < sequence.markers.numMarkers; i++) {
          var marker = sequence.markers[i];
          markers.push({
            id: marker.guid,
            name: marker.name,
            comment: marker.comment,
            startTime: marker.start,
            endTime: marker.end,
            duration: marker.duration,
            type: marker.type,
            color: marker.color
          });
        }
      }
      
      JSON.stringify({
        markers: markers,
        totalCount: markers.length,
        activeSequence: project.activeSequence ? project.activeSequence.name : null
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getAvailableEffects(): Promise<any> {
    const script = `
      var effects = [];
      
      // Get video effects
      var videoEffects = app.getAvailableVideoEffects();
      for (var i = 0; i < videoEffects.length; i++) {
        effects.push({
          name: videoEffects[i].name,
          matchName: videoEffects[i].matchName,
          category: videoEffects[i].category,
          type: 'video'
        });
      }
      
      // Get audio effects
      var audioEffects = app.getAvailableAudioEffects();
      for (var i = 0; i < audioEffects.length; i++) {
        effects.push({
          name: audioEffects[i].name,
          matchName: audioEffects[i].matchName,
          category: audioEffects[i].category,
          type: 'audio'
        });
      }
      
      JSON.stringify({
        effects: effects,
        totalCount: effects.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getAppliedEffects(): Promise<any> {
    const script = `
      var project = app.project;
      var appliedEffects = [];
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        // Check video tracks
        for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
          var track = sequence.videoTracks[v];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            for (var e = 0; e < clip.components.numItems; e++) {
              var effect = clip.components[e];
              appliedEffects.push({
                clipId: clip.nodeId,
                clipName: clip.name,
                effectName: effect.displayName,
                effectMatchName: effect.matchName,
                trackType: 'video',
                trackIndex: v,
                enabled: effect.enabled
              });
            }
          }
        }
        
        // Check audio tracks
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var track = sequence.audioTracks[a];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            for (var e = 0; e < clip.components.numItems; e++) {
              var effect = clip.components[e];
              appliedEffects.push({
                clipId: clip.nodeId,
                clipName: clip.name,
                effectName: effect.displayName,
                effectMatchName: effect.matchName,
                trackType: 'audio',
                trackIndex: a,
                enabled: effect.enabled
              });
            }
          }
        }
      }
      
      JSON.stringify({
        appliedEffects: appliedEffects,
        totalCount: appliedEffects.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getAvailableTransitions(): Promise<any> {
    const script = `
      var transitions = [];
      
      // Get video transitions
      var videoTransitions = app.getAvailableVideoTransitions();
      for (var i = 0; i < videoTransitions.length; i++) {
        transitions.push({
          name: videoTransitions[i].name,
          matchName: videoTransitions[i].matchName,
          category: videoTransitions[i].category,
          type: 'video'
        });
      }
      
      // Get audio transitions
      var audioTransitions = app.getAvailableAudioTransitions();
      for (var i = 0; i < audioTransitions.length; i++) {
        transitions.push({
          name: audioTransitions[i].name,
          matchName: audioTransitions[i].matchName,
          category: audioTransitions[i].category,
          type: 'audio'
        });
      }
      
      JSON.stringify({
        transitions: transitions,
        totalCount: transitions.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getExportPresets(): Promise<any> {
    const script = `
      var presets = [];
      var encoder = app.encoder;
      
      // Get available export presets
      var exportPresets = encoder.getExportPresets();
      for (var i = 0; i < exportPresets.length; i++) {
        presets.push({
          name: exportPresets[i].name,
          matchName: exportPresets[i].matchName,
          category: exportPresets[i].category,
          description: exportPresets[i].description,
          fileExtension: exportPresets[i].fileExtension
        });
      }
      
      JSON.stringify({
        presets: presets,
        totalCount: presets.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getProjectMetadata(): Promise<any> {
    const script = `
      var project = app.project;
      var metadata = {};
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        metadata = {
          project: {
            name: project.name,
            path: project.path,
            creationTime: project.creationTime,
            modificationTime: project.modificationTime
          },
          sequence: {
            name: sequence.name,
            duration: sequence.end - sequence.zeroPoint,
            frameRate: sequence.framerate,
            settings: {
              frameSize: {
                width: sequence.frameSizeHorizontal,
                height: sequence.frameSizeVertical
              },
              pixelAspectRatio: sequence.pixelAspectRatio,
              fieldType: sequence.fieldType
            }
          },
          statistics: {
            totalClips: 0,
            totalEffects: 0,
            totalTransitions: 0
          }
        };
        
        // Count clips, effects, and transitions
        for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
          var track = sequence.videoTracks[v];
          metadata.statistics.totalClips += track.clips.numItems;
          metadata.statistics.totalTransitions += track.transitions.numItems;
          
          for (var c = 0; c < track.clips.numItems; c++) {
            metadata.statistics.totalEffects += track.clips[c].components.numItems;
          }
        }
        
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var track = sequence.audioTracks[a];
          metadata.statistics.totalClips += track.clips.numItems;
          metadata.statistics.totalTransitions += track.transitions.numItems;
          
          for (var c = 0; c < track.clips.numItems; c++) {
            metadata.statistics.totalEffects += track.clips[c].components.numItems;
          }
        }
      }
      
      JSON.stringify(metadata);
    `;
    
    return await this.bridge.executeScript(script);
  }

  /**
   * The operating manual, as a plain string.
   *
   * Public because it is served two ways on purpose. As the
   * `premiere://config/get_instructions` resource it is *opt-in* — the client has to
   * know to attach it, and most callers never do, so the guidance that keeps an agent
   * out of trouble was reaching almost nobody. It is now ALSO returned in the
   * `initialize` response via `ServerOptions.instructions`, which is unconditional:
   * every client gets it before the first tool call. Two competing Adobe MCP servers
   * deliver their instructions this way and it is the better channel; the resource
   * stays so a client can re-attach it mid-session without reconnecting.
   *
   * Pure and host-independent — no bridge request.
   */
  getInstructionsText(): string {
    return this.getInstructions();
  }

  private getInstructions(): string {
    return [
      '# Premiere Pro MCP — Operating Instructions',
      '',
      'You are controlling Adobe Premiere Pro (26.3.x) through a verified MCP server.',
      'Call get_capabilities for the exact tool/resource/prompt counts of THIS build and the active tool',
      'profile -- this text deliberately states no tool count, because a hardcoded one drifts out of date',
      'the moment the catalogue changes and a stale number is a lie the agent cannot detect.',
      'Use find_tool to search the catalogue by keyword instead of guessing a tool name.',
      'The tool list you were given is usually a CURATED subset chosen to save your context, not the',
      'whole build. When find_tool returns a match marked exposed:false, that capability exists and you',
      'can still use it: call_tool({ name, args }) invokes it, get_tool_typings({ only: [name] }) gives',
      'you its exact argument shape first, and activate_tools promotes it into your tool list for the',
      'rest of the session. A refusal from call_tool names the setting responsible — a read-only profile,',
      'an explicit allowlist, or an operator exclusion — so treat that as a real boundary, not a retry.',
      'This server uses fail-closed verification: every mutating tool either confirms its effect with a',
      'readback/fingerprint/pixel check or explicitly returns verified:false. Never assume success from',
      'a tool call — always read the verified field in the response.',
      'If a call timed out or its reply was lost, do NOT simply retry an edit: get_recent_calls shows whether',
      'it ran. Pass a requestId on edits so a retry with the same id returns the first result instead of',
      'running twice. For slow work (exports, renders, transcription) use start_job and poll get_job. These',
      'are reachable through call_tool when they are not in your tool list.',
      '',
      '## If this is your first call, read one resource first',
      'premiere://recipes/first-90-seconds is the exact sequence from connect to one small verified edit.',
      'The other recipes are short, static, and each prevents a specific failure that has actually',
      'happened on this host. Read the one that matches your job before you start it:',
      '  premiere://recipes/task-bundles        which tool bundle fits the task, and how to reach the rest',
      '  premiere://recipes/verify-or-refuse    what to do when a tool returns verified:false',
      '  premiere://recipes/effect-match-names  effect identifiers, and the apply-then-set-then-read pairing',
      '  premiere://recipes/time-units          ticks vs seconds; the trap that made nine tools inert',
      '  premiere://recipes/qe-fragility        QE limits, and the calls that kill the script outright',
      '  premiere://recipes/recovery-first      checkpoints, modal dialogs, and a dead engine',
      '  premiere://recipes/honest-wall         what cannot be done, with the route that works instead',
      '',
      '## Before you start',
      '- The CEP bridge panel must be open in Premiere (Window > Extensions > MCP Bridge (CEP)), started,',
      `  and pointed at ${DEFAULT_BRIDGE_TEMP_DIR}. If tools time out, the bridge is not running.`,
      '- Call get_premiere_state or ping first to confirm the connection.',
      '- Call list_sequences or get_active_sequence to orient before editing.',
      '',
      '## Operating rules',
      '1. Read before writing. Use list_sequences, list_project_items, get_full_sequence_info first.',
      '2. Duplicate sequences before risky changes: duplicate_sequence with clearContents=false.',
      '3. Build in order: clips first → trims/timing → transitions/effects → export.',
      '4. If a tool returns verified:false, do not report success. Report the honest limitation.',
      '5. Use matchNames for effects (not display names — they vary by locale):',
      '   Opacity=AE.ADBE Opacity  Motion=AE.ADBE Motion  Lumetri=AE.ADBE Lumetri',
      '   Gaussian Blur=AE.Impact_Blur_FX  (use list_available_effects for others)',
      '6. Sequence IDs never change. Clip nodeIds persist across sessions. Prefer IDs over names.',
      '7. QE-based tools (speed, frame blend, time interpolation, effect add/remove) are fragile across',
      '   Premiere builds. They verify via readback — trust verified:true, not just success:true.',
      '8. Prefer ONE composite/batch call over N single calls. Every call is a separate bridge round',
      '   trip (~250ms floor), and a composite applies its whole plan in one pass with per-step readback.',
      '9. Cut through every layer with razor_timeline_at_time rather than splitting clip by clip — a',
      '   per-clip loop drifts out of alignment across tracks.',
      '',
      '## Composite tools — reach for these before hand-assembling',
      'For a branded or ad-style assembly, do NOT place clips one at a time. These build a whole',
      'timeline in a single round trip and read every placement back:',
      '  assemble_product_spot — promo timeline from real media. Pass an explicit clipPlan for',
      '    LLM-directed pacing (per-clip duration, transition, motion, trims, effects) instead of',
      '    accepting the template defaults; template mode is only a fallback when you have no plan.',
      '  build_brand_spot_from_mogrt_and_assets — the same, plus a MOGRT title layer.',
      '  build_motion_graphics_demo — a self-contained motion-graphics demo sequence.',
      '  add_to_timeline_batch — many placements in one call. The general-purpose version of the above.',
      '  batch_add_transitions / batch_apply_effect / set_clip_properties_batch — batch the pass, not the clip.',
      '  assemble_review_reel — gap-free reel from a list of sequences (daily review).',
      '  batch_execute — several ExtendScript reads/writes in ONE round trip when no batch tool fits.',
      'Use find_tool to search for a composite before writing a loop of primitives.',
      '',
      '## Effect lookup — use these exact names with apply_video_effect / apply_audio_effect',
      'Video effects are retrieved by display name via QE. Confirmed on 26.3.2:',
      '  Blur & Sharpen: Gaussian Blur, Unsharp Mask',
      '  Color Correction: Lumetri Color (apply via apply_lumetri_preset — more reliable)',
      '  Keying: Ultra Key, Track Matte Key',
      '  Transform: Transform, Mirror, Flip',
      '  Distort: Lens Distortion, Warp Stabilizer',
      '  Generate: 4-Color Gradient, Gradient',
      '  Stylize: Mosaic, Posterize, Emboss',
      '  Time: Posterize Time',
      '  Noise: Median, Noise',
      '  Metadata & Timecode: Metadata & Timecode Burn-in',
      'Audio effects (use with apply_audio_effect):',
      '  Amplitude & Compression: Dynamics Processing, Limiter, Multiband Compressor',
      '  Noise Reduction: Adaptive Noise Reduction, DeHummer, DeReverb',
      '  EQ: Parametric Equalizer, Graphic Equalizer (10 Bands), Graphic Equalizer (20 Bands)',
      '  Delay & Echo: Analog Delay, Convolution Reverb',
      '  Special: DeEsser, Chorus/Flanger, Distortion',
      '',
      '## Lumetri color workflow',
      'For numeric color control (not preset-based):',
      '1. apply_lumetri_preset to add the effect if not present',
      '2. lumetri_basic_set for exposure/contrast/highlights/shadows/whites/blacks/temp/tint/saturation',
      '3. lumetri_creative_set for look intensity, faded film, vibrance',
      '4. lumetri_vignette_set for vignette',
      '5. lumetri_report to read back current state (verified)',
      '6. copy_grade / paste_grade_to_clips to propagate',
      '325 preset names available via get_lumetri_preset_list.',
      '',
      '## Export workflow',
      'Quick path: export_sequence(sequenceId, outputPath, presetPath)',
      'Social: export_social_preset(sequenceId, platform, outputPath) — platforms: youtube, instagram, tiktok, twitter',
      'Custom: create_custom_export_preset writes a .epr and returns its path -- pass that path as the',
      '  presetPath of export_sequence. There is no single-call custom-preset export tool.',
      'Verify output: verify_export(outputPath) — ffprobe checks duration/fps/codec match sequence',
      'Preset files: list_export_presets() for installed .epr paths',
      '',
      '## What this server CANNOT do (the honest wall)',
      'These editor functions have no scripting surface — use the alternatives instead:',
      '- Free-draw shape masks on effects (bezier/ellipse geometry in Effect Controls): no DOM/QE API.',
      '  Alternative: apply_video_effect with "Track Matte Key" (then set_effect_property to pick the matte',
      '  layer and luma/alpha mode), or lumetri_hsl_secondary_set',
      '  (color-keyed isolation). Mask parameters like Feather/Opacity/Inverted ARE scriptable via the',
      '  prproj XML path, but require save+close+reopen cycle.',
      '- Essential Sound auto-analysis: panel logic not exposed. Alternative: apply effects directly',
      '  (denoise_clip, set_parametric_eq, set_compressor) or set_essential_sound_category to tag the clip.',
      '- Clipboard (Premiere internal): no copy/paste clip API. read_clipboard/write_clipboard handle',
      '  system text clipboard only.',
      '- Render & Replace (bake to source media): use bake_speed_change or export+relink instead.',
      '- Merged clips creation: detection only (isMulticamClip/isMergedClip). Use link_audio_video.',
      '- Essential Graphics advanced authoring (gradients, tracking, shape layers).',
      '',
      '## Render status',
      'get_sequence_render_status returns green (rendered) / yellow (needs render) / red (unrendered) / empty bar ranges.',
      'render_sequence_previews triggers renderPreview() — async, check status after.',
      '',
      '## Bridge setup (if tools time out)',
      '1. In Premiere: Window > Extensions > MCP Bridge (CEP)',
      `2. Set Temp Directory to ${DEFAULT_BRIDGE_TEMP_DIR}`,
      '3. Click Start Bridge',
      '4. Confirm with ping or verify_premiere_connection',
    ].join('\n');
  }
}
