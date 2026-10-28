# Changelog

All notable changes are documented here. Releases use semantic versioning.

## [Unreleased]

### Added: safe retries and editor workflows

- **"Did my last call run?"** Every call is journaled; `get_recent_calls` shows what ran,
  including calls whose reply was lost to a client timeout. A `requestId` on any call makes
  a retry return the first result instead of applying the edit twice.
- **Background jobs and progress.** `start_job` / `get_job` / `list_jobs` run slow tools
  (exports, renders, transcription) without outliving the client's timeout; clients that
  send a progress token get a heartbeat every 5 s.
- **Ask before destroying.** Deleting a bin or item that is used on a timeline, and raw
  scripts that delete or quit, now return `needsConfirmation` with where it is used. Clients
  that support elicitation get a yes/no question; on yes the call runs with `confirm`.
- `where_used`: every sequence and time a project item appears.
- `version_up_shots`: relinks every versioned shot (`SH010_comp_v003` and so on) to the
  newest render on disk, keeping trims and effects. Dry run first.
- `remove_silence`: cuts the pauses out of a talking clip and closes the gaps on every
  track, so music and other audio stay in sync. Asks first; takes a recovery checkpoint.
- `sync_by_audio`: finds the offset between recordings of the same moment by waveform
  (8 kHz FFT cross-correlation, sub-frame) and can build the synced multi-track sequence.
- `look_at_cut`: one image strip of the cut, one labelled frame per shot.
- `stringout_from_transcript`: paper edit from a Whisper `.json` or `.srt`; give the lines
  in cut order and get a sequence of just those moments. Unfound lines are listed, not guessed.
- `scripts/workflow-tests.mjs` W5–W8 run these end to end against live Premiere.

The timeout-safety tools are in `core` and named in the server instructions; under a task
bundle they are reached through `call_tool`, which keeps every bundle at or under 50 tools.

Live sweep against Premiere Pro 26.5.2: 496 tools pass and 61 fail, up from 449 and 111.
New fixtures (a real multicam, a caption track, an AE-authored MOGRT) made 54 more tools
genuinely testable, and running them found the bugs below. Every effect below was checked
against a render, not only an API readback.

### Added

- `create_multicam_cut` builds a finished multicam cut: a new sequence of real multicam
  clips, each on the angle you choose, still switchable in Premiere. ExtendScript can
  neither create a multicam source nor switch angles; an FCP7 XML `<multiclip>` import can.
- `freeze_frame` now works (26.5.2 has no frame-hold call). It extracts the source frame
  with ffmpeg and overwrites it as a still for `durationSecs` (new, default 2) on the
  clip's own track. The held frame is pixel-identical to the source frame.
- `set_clip_pan` sets pan through the QE clip pan component (value passed as a string).
  Hard left measured -91 dB on the right channel.
- `set_clip_gain` and `normalize_clip_peaks` apply gain through an Amplify effect, since
  clip gain itself is read-only from script. +6 dB measured as +6.0 dB.
- `apply_lut` / `apply_lut_to_clip` select the Lumetri Input LUT dropdown entry whose
  render matches ffmpeg's `lut3d` of the ungraded frame (the slot takes an index; a path
  raised "Illegal Parameter type"). An unlisted LUT is refused; `installIfMissing` copies
  it into the user LUT folder.
- `uxp-probe/` and `npm run uxp:install`: a minimal UXP panel, installed as a `.ccx`,
  that runs `premierepro` UXP calls over a private file queue. Groundwork for the calls
  only UXP has (work area, sequence in/out, transitions); not yet wired into tools.

### Workflow tests, and what they found

- `npm run test:workflows` (`scripts/workflow-tests.mjs`) drives five real jobs as chains of
  tools against the scratch project and checks them by what Premiere renders and holds, not
  by tool reports: per-clip version swap, version-up by relink, a review reel of latest
  versions with burn-ins, captions from an SRT, and an audio pass (ducking, stems, loudness).
  All five pass, 45 of 45 steps.
- **`replace_clip` kept nothing.** It took `preserveEffects` and ignored it: the trim, grade
  and reframe were lost and the full-length new version ran over the next shot. It now lays
  the new media into the old slot with the old source range and carries every effect across.
  It never slides a clip past other clips: an intermediate version that did left Premiere's
  track order scrambled, and everything after the moved clip rendered black.
- **`replace_clip_media`** (relink, the usual version-up) verifies the new path and renames the
  bin item and the timeline clips that still carried the old file name, so the timeline no
  longer reads "v001" while playing v002.
- **`import_media` / `import_folder`** create a named destination bin (or `a/b/c` path) that
  does not exist yet, instead of refusing. Ambiguous names and bad ids still refuse.
- **ExtendScript-only syntax errors are now caught in tests.** An unescaped `/` inside a regex
  character class, and an ES3 reserved word (`short`) as a variable name, each broke a whole
  generated script in Premiere while the acorn-based syntax test stayed green. The test now
  rejects both, with self-tests proving it does.

### Installing for a teammate

- `npm run release:installer` builds `Premiere-MCP-Installer-v<version>.zip`: the CEP bridge
  **signed** (so it loads without the CEP debug switch), the UXP helper, and a double-click
  `Install Premiere MCP.command`. The installer uses Adobe's own plugin installer and moves
  any older hand-copied bridge aside first, since two copies with one id would clash. The
  signed package holds only the five runtime files, not the design mockups.
- The self-signed certificate is created under `~/Library/Application Support/premiere-mcp-signing`
  with its password in the macOS Keychain, and names this project as the publisher.

### Finding tools by how an editor asks

- `find_tool` knows editor vocabulary ("black and white", "subtitles", "slow mo", "swap in
  the new render", "dead air"), plain-English aliases on commonly used tools, and ranks a tool
  that does the thing above one that inspects it when the ask is an action. A 42-phrase test
  set (`search-eval.test.ts`) pins it: 16 of the first 31 passed before; all 42 pass now,
  including a second batch written after the first fix.

### Engine stalls are detected, not waited out

- When a script outlives the panel's watchdog, Premiere's scripting engine is still running
  it, and it cannot be cancelled. The panel used to hand the next command straight into that
  queue, so every following call also waited 45 s and failed with the same vague message. Now
  the engine is marked **stalled**, a trivial sentinel script stays in flight, and commands
  that arrive meanwhile are answered at once as **not run** (`code: ENGINE_STALLED`). When
  the sentinel answers, the engine is healthy again. After 90 s with no answer it is reported
  **dead**, with a plain instruction to restart Premiere. The heartbeat carries the state, so
  the server's timeout messages name it too. Measured live: the call after a stall was
  refused in 1 s instead of 45, and the engine recovered on its own when the script finished.

### Fixed (from sorting the remaining live failures)

- **Translation Report pop-ups.** Every transition check exported the sequence as FCP XML to
  count transitions, without `suppressUI`, so each transition or crossfade added left a
  Translation Report dialog on screen. That check and `export_as_fcp_xml` now pass
  `suppressUI`; the report is still written next to the XML file. The dialog guard also keeps
  watching for 8 s after XML, AAF and OMF tools return, because Premiere can raise its
  report just after the call finishes.
- The shared bin check treated every clip as a bin: on 26.5.2 clips also have `createBin()`.
  A bin of camera angles read as empty, and a clip that shared a bin's name made the bin
  name "ambiguous". `get_bin_contents_recursive` crashed on it. The item type now decides.
- `create_sequence_from_bin`, `create_multicam_source_sequence` and
  `create_multicam_from_clips` passed a preset path where `createNewSequenceFromClips` takes
  a destination bin, so all three always failed with "Illegal Parameter type". They report
  `presetPathIgnored` when a preset was given.
- `stem_export` muted and unmuted tracks without exporting anything, and its
  `setMute(true)` threw (`setMute` takes 1/0). It now writes one file per track and puts
  every track's mute state back.
- `compare_takes` was a stub. It now extracts the mid-point frame of each take.
- `set_keyframe_interpolation` is verified when the UXP helper runs: UXP reads the
  keyframe's interpolation back, which ExtendScript cannot. Hold, Bezier and Linear read back
  correctly.
- SRT cue tools say indices are 1-based when one is out of range.
- The UXP helper's queue folder has a Windows path (`%LOCALAPPDATA%\Temp`). It is untested on
  Windows.
- The sweep gives real values where it had placeholders: real tool, effect and LUT names, an
  end time after the start time, a folder where a folder is wanted, Frame.io and ShotGrid
  fixtures, a per-tool copy of the SRT for tools that edit it, and the snapshot
  `snapshot_state` wrote. It no longer writes a footage index into the home directory.

### UXP channel

- The MCP UXP Probe panel is now a second channel next to CEP (`src/bridge/uxp-channel.ts`,
  a private 0700 file queue, no socket). Tools use it only where UXP reaches what
  ExtendScript cannot, always confirm the result through ExtendScript or QE, and behave as
  before when the panel is not installed. Install once with `npm run uxp:install` or by
  double-clicking the `.ccx`; no UXP Developer Tools or developer mode needed.
- `set_work_area` works: it sets through UXP `WorkAreaUtils` and reads back through
  ExtendScript. The ExtendScript setters stay inert on most sequences.
- `add_transition` and `batch_add_transitions` fall back to UXP's `TransitionFactory`
  when the QE route cannot prove the edit, verified by QE's transition list at the cut.

### Runs with no panel open

- The CEP bridge now also ships as an invisible extension that Premiere starts at launch
  (`cep-plugin/background.html`). With **Run in background** on, the default, nothing has to
  be open. A lease file (`bridge-owner.json`) makes the panel and the background copy take
  turns, so a command can never run twice. A copy standing down mid-command keeps a busy
  heartbeat until it finishes. If the background copy dies, the panel takes over within
  about 3 s. The toggle lives in the panel and takes effect immediately.
- The UXP helper polls from the moment Premiere loads it, so its panel can stay closed. The
  panel is now a styled status card that names the last action in plain words.

### CEP panel

- The panel now shows only the status card and the shared folder. "In Premiere now",
  the command queue and the activity log are hidden; nobody used them.
- A stale `bridge-endpoint.json` made the panel retry a dead socket every 2 s and log two
  lines each time. It now backs off to a minute and logs once per endpoint.

### Fixed

- `set_sequence_in_out_points` refuses in >= out. Premiere stores that as a collapsed range
  reading about -400000 s, which the sweep had recorded as a broken API. With a real range,
  every argument form works.
- `fill_room_tone` overwrote the whole source at the gap: an A/V item dropped its video
  onto V1, the gap length was ignored, and an occupied span was overwritten. It now
  refuses an occupied span and lays audio-only subclips cut to fit, looping as needed.
- `create_subclip` passed take-audio and take-video swapped (`createSubClip` takes video
  first), so `takeAudio:false` dropped the video instead.
- `three_point_edit` assigned a timecode string to `Time.seconds`, so any
  `sequenceTimecode` threw "Illegal Parameter type".
- `lower_third_preset`, `title_card`, `batch_mogrt_from_data` and `countdown_leader` called
  `add_text_overlay` without a template and could never succeed. They forward `mogrtPath`,
  which falls back to `PREMIERE_MCP_DEFAULT_MOGRT`; `lower_third_preset` uses one graphic
  with the title in its second text field.
- `create_recovery_checkpoint` left its snapshot as the active sequence, so later calls
  edited the backup. The previously active sequence is restored.
- `enable_multicam` refused a clip that was already multicam; `set_multicam_angle` now
  explains that switching is not scriptable and points to `create_multicam_cut`.

### Changed

- `export_aaf` and `export_aaf_with_settings` no longer render a video mixdown by default
  (`mixDownVideo` now defaults to false). The mixdown rendered the whole sequence first and
  held Premiere for over five minutes on a 40-second sequence with one MOGRT; without it
  the same export takes about three seconds.

### Test harness

- `reset-scratch` builds three synced camera angles, a multicam (via XML), a caption track
  from the fixture SRT, and an AE-authored MOGRT on V3, and turns off the project's
  copy-on-import ingest setting, which had piled ~650 duplicate media files into
  `.scratch/media`. The wipe no longer stops at the first item it cannot delete.
- The sweep re-activates the fixture sequence after any tool that switches it, points
  timeline-overwriting, lock, mute and AAF tools at the second fixture sequence, skips
  `lift_selection`, `extract_selection`, `consolidate_duplicates` and
  `set_transcode_on_ingest`, and waits up to 45s for a busy panel before giving up.
- Argument synthesis aims MOGRT, audio, multicam and caption tools at matching fixtures,
  gives source/target tools two distinct clips or sequences, and picks fixture items by
  name instead of "the first project item".
- Sweep ledgers are written with the repo path as `<repo>` and the home directory as `~`.

## [1.4.0] - 2026-10-25

Fixes from running the catalogue live against Premiere Pro 26.5.2, which changed scripting
behaviour under the server, each verified frame by frame against a frame-counter clip. Live
coverage went from 34.9% to 86.4% of tools executed against a real host.

### Fixed

- 36 tools declared `sequenceId`, forwarded it, and then ignored it, acting on the
  active sequence instead. They now honour the id they are given.
- The shared sequence and bin resolvers no longer fall back to the active sequence
  or the project root when an id does not match. A stale or mistyped id is now an
  error, not a silent retarget. `silent-retarget-audit.test.ts` pins the pattern.
- `copy_effects_between_clips` resolves its source and target clips across every
  sequence, so an effect stack can be lifted from one sequence onto another.

### Fixed against Premiere 26.5.2, verified frame by frame

Measured against a clip whose every frame encodes its own number, read back from
the composited program frame rather than from API readbacks.

- **Security:** about thirty ffmpeg/ffprobe calls ran through a shell with
  caller-supplied paths interpolated, so a crafted `mediaPath` could execute
  commands. All now pass argv arrays (`runFf`); a test bans the pattern.
- **Frame capture:** QE `exportFrame*` takes a timecode; seconds/ticks were
  accepted and exported frame 0. `capture_program_output`, `capture_frame`,
  `export_frame`, `export_thumbnail` and the frame-strip tools all returned frame 0
  whatever time was asked for. They are now frame-exact.
- **Trimming:** `ripple_trim_in/out`, `extend_edit`, `j_cut`, `l_cut`, `trim_clip`
  and `nudge_clip` were built on wrong assumptions about what in/out/start/end
  writes do (in-point writes slip, out-point writes do nothing visible, `move()` is
  relative). Rebuilt on a measured trim library with neighbour rolls, sync-locked
  ripples, media-handle checks, linked audio and rollback.
- **QE addressing:** QE lists sequences in a different order from the DOM, and
  lists gaps and transitions as track items, so QE tools hit the wrong sequence or
  the wrong clip. Resolved by guid and by start time; a sequence QE cannot see is
  opened first.
- **Engine:** a cold 26.5.2 engine lacks `Array.prototype.map/filter/indexOf` and
  `Array.isArray`; the prelude installs them (about twenty tools threw).
- **Modals:** `export_aaf` and FCP XML exports raise blocking report dialogs; on
  macOS the server now dismisses those two named dialogs while a call runs.
- **Reverse and speed:** `reverse_clip`/`set_clip_reverse` reverse with the right
  frames; QE speed changes are miscalibrated on this build, so `speed_change`,
  `set_clip_speed_qe` and `rate_stretch_to_fill` verify rate and duration and undo
  a wrong result. `bake_speed_change` is frame-exact.
- `split_clip`, `duplicate_clip`, `add_to_timeline` (left marks on the item),
  `copy_markers_between_sequences` (hung the host), `create_marker`,
  `duration_marker_add`, `flip_horizontal/vertical`, `close_gap_at`,
  `close_all_gaps`, `get_sequence_gaps`, `delivery_qc`, `match_shot_color`, the
  colour-space tools, `false_color_frame`, `flash_frame_scan`,
  `freeze_frame_scan`, `broadcast_safe_check` and `audio_peaks_report` each had a
  defect that made them fail, act on the wrong thing, or report success without
  doing the work. See the commit log for each.

### Added

- `set_scale_to_frame_size_batch`: scale-to-frame-size for a track, every video
  track, or a list of clip ids in one call, with a per-clip readback.
- `npm run canary` (`scripts/api-canary.mjs`, `docs/API-CANARY.md`): re-measures the 17
  Premiere scripting behaviours the tools depend on, mostly from rendered frames, and diffs each
  run against the last. Run it after every Premiere update.

## [1.3.1] - 2026-10-21

### Fixed

- `move_clip_to_track` no longer overwrites or loses clips. The fallback used to
  delete the source first, then lay the full untrimmed item over the destination,
  which could overwrite a neighbour and lost the clip on any later failure. It now
  refuses an occupied span unless `overwrite:true`, parks a copy on empty space,
  restores in/out and duration, clears sanctioned occupants only right before the
  final slide, and removes the source last. A native move is read back rather than
  trusted. The fallback re-creates the clip (effects, keyframes, speed, static
  property values, markers and name do not carry over), so it now requires
  `allowLossyMove:true`. Ported from upstream edc0b0f.
- `get_encoder_presets` also scans `~/Documents/Adobe/Adobe Media Encoder/<ver>/Presets`,
  where AME saves user presets. Ported from upstream 5528abb.
- `project_file_edit`: replacements apply in one pass, so chained finds can no
  longer interact; markup in `find` is gated like markup in `replace`, and any
  change to the document's tag structure is refused without `allowMarkupEdit`;
  the output is written without ever clobbering an existing file; `wrote` is
  reported accurately on every failure path; the open-in-Premiere check ignores
  case on macOS and Windows; both tools require a `.prproj` path.
- MCP `initialize` reported version 1.2.0; it now reports the package version.

### Live harnesses

- Mutating sweeps skip `set_autosave_settings`, `create_project` and
  `write_clipboard`, and never write Premiere's preferences file. A sweep used to
  set every project's Auto Save to one version every minute.
- Sweeps re-check the scratch project every 10 calls and after any recovery, and
  recovery never saves or quits a project that is not the verified scratch file.
- Recovery fails closed: it never presses Escape or quits Premiere when the panel
  is busy on another client's command, when a peer shares the bridge directory,
  when a response vanished, or when health is unknown. The sentinel no longer
  counts its own parent harness as a peer, which had silently disabled recovery.

## [1.3.0] - 2026-08-27

New capabilities that Premiere's scripting API cannot provide on its own, each
built to the same honesty contract as the rest of the server — probe for the
dependency, return install guidance instead of failing silently, and verify the
result on disk before reporting success:

- Added `transcribe_to_srt`: local OpenAI Whisper speech-to-text that writes an
  `.srt` from a media file, closing the gap before `create_caption_track`
  (Premiere can ingest a subtitle file but cannot generate one, and exposes no
  speech-to-text API). The `whisper` binary is overridable via
  `PREMIERE_MCP_WHISPER_CMD`; a hard timeout kills a runaway run.
- Added `probe_media`: ffprobe-backed ground-truth technical metadata (codec,
  pixel format, color space/range, bit depth, frame rate, sample rate, channel
  layout, duration) for any file on disk, imported or not. Overridable via
  `PREMIERE_MCP_FFPROBE_CMD`.
- Added `generate_scope`: renders a waveform, vectorscope, histogram, or RGB
  parade image from one frame with ffmpeg, because Premiere's Lumetri scopes
  cannot be scripted or exported. Overridable via `PREMIERE_MCP_FFMPEG_CMD`.
- Added `capture_program_output`: captures the actual *composited* Program
  Monitor frame — the real rendered pixels of the sequence, with every clip,
  effect, transition, title and grade baked in — so an agent can **see** what an
  edit renders to rather than trusting that an API call returned. Premiere hands
  script no framebuffer of the program, so the frame is obtained off one of four
  capture "taps" behind a single abstraction: render/export (zero-dependency,
  macOS + Windows, video + audio, always available when Premiere is connected)
  and the real-time NDI, Syphon (macOS) and Spout (Windows) taps, which require a
  Transmit-style plugin and a native receiver. The tap is auto-selected but
  forceable; the tool always reports which tap it used, defaults the sequence to
  the active one and the time to the current playhead, verifies a real frame
  landed on disk before claiming success, and returns per-OS install guidance for
  an unavailable tap instead of faking a frame. Pass `probeOnly:true` to report
  which taps are available on the machine without capturing; a receiver can be
  advertised via `PREMIERE_MCP_NDI_RECEIVER` / `PREMIERE_MCP_SYPHON_RECEIVER` /
  `PREMIERE_MCP_SPOUT_RECEIVER`. This is the first piece of the render-truth
  feedback loop.
- Added `bake_speed_change`: the honest escape hatch for time-remapping.
  Premiere's scripting API has never exposed the time-remap/speed-keyframe graph,
  so agents that set a speed ramp through the DOM get silently ignored keyframes
  at render. This bakes a real, frame-accurate constant-speed clip to disk with
  ffmpeg (video via `setpts`; audio pitch-preserved via a chained `atempo`, or
  dropped) that you then import and place. `speed>1` is faster/shorter, `<1`
  slower/longer. Verifies the output exists and is non-empty before reporting
  success.
- Added `normalize_loudness`: two-pass EBU R128 loudness normalization with
  ffmpeg's `loudnorm` (measure, then apply linear correction seeded with the
  measured values), because Premiere exposes no scriptable loudness measurement
  or normalization. Targets an integrated LUFS / true-peak / LRA (defaults
  `-14 LUFS`, `-1 dBTP`, `11 LU`) and writes a new file, returning the measured
  input loudness so the change is auditable.
- Added `lint_timeline`: automated, read-only timeline QC — the "layout lint"
  half of the render-truth loop. Walks every video and audio track and flags
  gaps (black/silence), flash frames (clips shorter than a frame threshold),
  overlaps, a leading gap before the first clip, and mixed frame rates (a clip
  whose source frame rate differs from the sequence). Each finding carries a
  severity, the track and time, and a plain-English message; the checks and
  thresholds are configurable and the analysis is a pure, independently tested
  function. Changes nothing — it reports.
- Added `diff_sequences`: a read-only version diff. Walks two sequences and
  classifies every difference between them — clips `added`, `removed`, `moved`
  (same clip, new start time) or `retimed` (same clip, new duration) — so an
  agent can *see* exactly what an edit did rather than trusting a call returned.
  Pairs with the recovery checkpoints (diff a restored snapshot against the
  current cut) and with `lint_timeline` (find defects, then attribute them to a
  change). Clips are matched within a track by name with a half-frame tolerance;
  the comparison is a pure, independently tested function.
- Added a local footage index — `index_footage` and `search_footage` — so an
  agent can discover media on disk *before* importing it into Premiere. Premiere
  can only search project items it has already ingested; this walks a folder,
  ffprobes each media file for real technical metadata (codec, resolution, frame
  rate, duration, audio/video stream presence), and persists a JSON index
  (`~/.premiere-mcp/footage-index.json` by default, overridable via
  `PREMIERE_MCP_FOOTAGE_INDEX` or a per-call `indexPath`). The scan is
  incremental — files unchanged by size and mtime are not re-probed — and the
  index is written atomically then read back to confirm it landed before
  reporting success. `search_footage` filters the index by filename substring,
  extension, codec, duration/resolution/frame-rate ranges and audio/video
  presence, all ANDed, capped by `limit` with honest truncation reporting. The
  scan planner and the query filter are pure, independently tested functions.
  Requires `ffprobe`; returns install guidance instead of failing silently when
  it is absent, and rejects a non-absolute or missing `rootPath` before writing.
- Extended `get_capabilities` with an opt-in local-backend self-probe
  (`probeLocalTools: true`): spawn-probes ffmpeg, ffprobe and the Whisper CLI, and
  reports the render-truth capture taps, so an agent or human learns which
  dependency-backed tools will actually work on *this* machine before calling
  them. Each dependency reports its resolved command, env override, what it
  unlocks, and — when absent — per-OS install guidance instead of a mystery
  failure at call time. Off by default so plain capability discovery stays fast
  and makes no Premiere request.
- Added a recovery boundary — `create_recovery_checkpoint`,
  `list_recovery_checkpoints`, `restore_recovery_checkpoint` — that snapshots a
  sequence before risky edits. The automatic checkpoint taken before
  sequence-destructive tools fails **closed**: if the snapshot cannot be made,
  the destructive edit is refused rather than run unprotected.
- Added opt-in tool profiles: `PREMIERE_MCP_PROFILE` (`core`, `read-only`,
  `audio`, `color`) or an explicit `PREMIERE_MCP_TOOLS` allowlist, with
  `PREMIERE_MCP_EXCLUDE` to subtract. The default remains the full catalogue —
  nothing is hidden unless asked for.
- Enriched the expanded-tool catalogue with real input schemas so every
  advertised tool exposes a typed, discoverable argument shape.
- Made the install `doctor` (macOS + Windows) honest and self-checking. It now
  samples the bridge heartbeat to report automatically whether the CEP panel is
  **live and connected**, **stale** (running but not polling), or **not running**
  — replacing the old "go click Test Connection yourself" punt. Adobe CEP debug
  mode now passes when enabled for *any* installed CSXS version instead of
  failing per-version (Premiere 26.x uses CSXS.11/12, so demanding all of
  10/11/12 flagged a correct setup); a missing MCP-client config for a client you
  do not use is now a note, not a failure, and the check covers the Claude Code
  project `.mcp.json` alongside Claude Desktop and VS Code; and it reports which
  optional local backends (ffmpeg/ffprobe/whisper) are present. Blocking failures
  and non-blocking warnings are now tallied separately in the verdict.

- Added `get_autosave_settings` and `set_autosave_settings`, which read and write
  Premiere's autosave interval, copy count and destination folder through the
  preference keys the application itself uses.
- Added `project_file_inspect` and `project_file_edit`: read and edit a `.prproj`
  **on disk**, closing the class of jobs no live API can do (a project nobody has
  open, a path rewrite across a whole archive). The container is gzipped XML, and
  the writer reproduces Premiere's own byte layout, so a round trip with no edit
  is byte-identical. Every edit is refused unless an ObjectUID census before and
  after agrees, and the original is kept.
- Made "verified live" a machine-written artifact instead of a sentence in a
  commit message. A sweep in `scripts/` now files a ledger entry under
  `verification/sweeps/` recording the UTC time, harness and mutate mode, commit
  and dirtiness, the Premiere version the host reported, and one row per tool it
  reached; `docs/LIVE-VERIFICATION.md` is generated from those files and a test
  byte-compares the two, so a tool cannot be promoted to "verified" by editing
  the document. A skip is recorded as a skip and never counted as evidence.
- Added the second, weaker axis alongside it: `docs/TOOL-COVERAGE.md` reports how
  much of the catalogue anything has ever run, measured by instrumenting the
  dispatcher during a test run rather than by grepping test files for tool names
  (a name in a table of expected strings is not a call; a name assembled at
  runtime is never a literal — and both errors are silent). Mock-bridge dispatch
  and live-host execution are printed as separate columns and never merged.
- Split the 21,849-line `src/tools/index.ts` — 55% of all source — into
  `tools/catalogue.ts` (the registrations) and 20 domain classes under
  `tools/domains/`, chained by inheritance in dependency order. `index.ts` keeps
  the dispatcher and the meta tools. All 647 registrations were proven identical
  in name, description and schema, in the same order, before and after.

Catalogue grew to `647` tools.

## [1.2.0] - 2026-08-17

- Fixed `add_marker`, `update_marker`, `delete_marker`, `list_markers`, `lock_track` and
  `toggle_track_visibility` ignoring the required `sequenceId` and always operating on the
  active sequence. They now act on the requested sequence and return a truthful error when the
  ID resolves to nothing, instead of reporting `success: true` against the wrong timeline.
- Fixed `list_sequence_tracks` and `delete_track` silently falling back to the active sequence
  when `sequenceId` did not resolve. `list_sequence_tracks` also no longer echoes the requested
  ID back next to a different sequence's name.
- `delete_track` now works across sequences. Premiere exposes no DOM track-deletion API, so it
  falls through to the QE DOM, which reaches any sequence Premiere has open rather than only the
  active one. A sequence QE cannot address is reported by name instead of having a track deleted
  from whichever timeline is on screen.
- Fixed `create_bin` and `import_folder` resolving a named parent with `children[name]`, which
  never matches: `ProjectItemCollection` is index-only, so the lookup always fell through to the
  project root while the response echoed the requested name back.
- Fixed `add_to_timeline` reporting a pre-existing clip as the one it placed, and removing linked
  audio matched against that clip's start time, whenever the placement could not be confirmed.
- Fixed `insertMode` being accepted and echoed but never applied; `insert` now inserts and shifts
  rather than overwriting.
- Fixed `duplicate_sequence` falling back to the active sequence when the clone could not be
  resolved, then renaming it and, with `clearContents`, emptying it.
- Caller-supplied strings interpolated into generated ExtendScript are now serialised, closing an
  arbitrary-code-execution path and fixing ordinary names containing a double quote.
- Fixed `set_sequence_settings` never writing anything. It compared the requested width and
  height against the current ones, wrote no settings, and reported a match; a caller asking for
  a different frame size got `success: true` and an unchanged sequence. It now applies the
  settings and reports what it wrote. Frame size can be changed after creation — assigned
  through `getSettings()`/`setSettings()` and confirmed by read-back on 26.0.2.
- Fixed the bridge's response serializer silently passing raw control characters through
  instead of escaping them. A single stray control character anywhere in a clip or marker
  name could make the entire tool response unparseable, not just that field. The bridge and
  CEP panel now share a conformant serializer, tested against the platform's own parser plus
  a large generated corpus.
- Added the missing `JSON.parse` read direction to the ExtendScript prelude. The engine ships
  no native `JSON` object; the prelude previously installed only `stringify`, so any generated
  script that needed to *decode* a payload — including `add_text_overlay`'s MOGRT text
  decoding — failed with `JSON.parse is not a function` on every call.
- Made the command/response file handoff between the server and CEP panel atomic (write to a
  scratch name, then rename into place) instead of writing directly to the polled filename.
  Previously a truncated read during a write could permanently fail a command that had
  actually executed, and a slow response could be overwritten before the caller read it.

### Security

- Fixed an ExtendScript injection vulnerability ([GHSA-rc48-rh69-7487](https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP/security/advisories/GHSA-rc48-rh69-7487)):
  a small set of tool arguments (including `clipId` in `split_clip`, `add_transition`, and
  `add_transition_to_clip`) were interpolated unquoted into generated ExtendScript. A value
  containing a double quote could break out of the string literal and execute arbitrary
  ExtendScript, including forging a fake `success: true` tool result. All interpolated values
  are now serialised with `JSON.stringify` at the point of use. Reported and patched by
  [@medazizktata](https://github.com/medazizktata).

### Breaking

- `move_clip` now rejects `newTrackIndex` instead of accepting and ignoring it. The parameter
  never moved a clip between tracks; callers that passed it were silently getting a time-only
  move. Use `move_clip_to_track`, which on this build is a remove-and-reinsert: it can overwrite
  whatever occupies the destination and gives the clip a new id, so it is a separate call rather
  than an option here.
- `add_marker` and `update_marker` now reject a `color` outside the eight-name palette instead of
  silently storing green. Any name Premiere does not have was previously accepted and produced a
  green marker, so a caller asking for `magenta` got green and no error.
- Tools that resolve a `sequenceId` now fail when it does not resolve, where many previously fell
  back to the active sequence and reported success. Callers relying on a bad or stale id to mean
  "use whatever is open" will now see an error; pass no id for that behaviour.

- Sequence-scoped marker and track tools now reject an empty `sequenceId` at the schema layer
  and report the resolved `sequenceId`/`sequenceName` they acted on.

## [1.1.6] - 2026-08-05

- Added `get_capabilities`, a read-only report of local bridge installation, catalog coverage, and optional live connection status.
- Added installable Codex and Claude Code plugin packages that reuse the supported local MCP server and Premiere editing skill.
- Reworked the README entry path around client-specific installation and read-only connection verification.

## [1.1.5] - 2026-08-05

- Added reproducible CEP ZXP signing, verification, and release-upload workflows.
- Added a local macOS helper that creates a private self-signed certificate and stores its password in the macOS Keychain.

## [1.1.4] - 2026-08-05

- Added the official Claude Desktop MCPB bundle to the release artifact workflow.
- Added `verify_premiere_connection`, a read-only CEP bridge and Premiere host readiness check.
- Added release notes and a security policy, and clarified supported CEP, unsigned archive, and experimental UXP status.

## [1.1.3] - 2026-08-05

- Stabilized the release artifact workflow with a clean CI test run.
- Published the first verified unsigned CEP release archive.

## [1.1.2] - 2026-08-05

- Added the public npm package, `premiere-pro-mcp` CLI, CEP installer, and diagnostics command.
- Added package-content verification and npm publishing workflow.

## [1.1.1] - 2026-08-05

- Renamed the published package identifier to `adobe-premiere-pro-mcp`.

## [1.1.0] - 2026-08-05

- Added dialog-safe handling for FCP XML import, sequence creation, EDL import, and Media Encoder availability.
- Migrated the MCP server to the current v2 transport implementation.
