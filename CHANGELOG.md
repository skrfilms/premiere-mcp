# Changelog

All notable changes are documented here. Releases use semantic versioning.

## [Unreleased]

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

Catalogue grew to `296` tools.

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
