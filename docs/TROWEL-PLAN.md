# Trowel — Plan of Record

> **Trowel** = the mason's hand tool that lays each brick and strikes the mortar flush and
> **true**. Taken at face value, a Premiere MCP does *automatic mud-brick building* — the
> agent is the autonomous mason; **Trowel** is the instrument that lays each clip (brick)
> into the sequence (wall) and finishes it true. The name carries both halves of the
> product: it **builds** (the automatic mason) and it finishes **true** (verify-after-write /
> render-truth). Fork of `hetpatel-11/Adobe_Premiere_Pro_MCP` (MIT). Owner: `skrfilms`.
> Working branch: `improve/m1-honesty-and-core-bugs`.

This document is the single source of truth for the "make it amazing" effort. It is
decisive on direction; engineering specifics are refined per phase. Nothing here
authorizes external publishing — that stays gated on the owner's explicit go-ahead.

Name **Trowel** chosen 2026-08-21 after a Semantle-style semantic search of "automatic mud
brick building." Lowest same-category collision of the shortlist (npm "trowel" is only an
obscure ECMAScript parsing utility; no trademark). Reversible — nothing is renamed in code
and nothing is published, so a later swap is trivial. (`.mcp.json` server key stays
`premiere-pro` unless an explicit decision changes it.)

---

## 1. North star

**Every other Premiere MCP tells the agent its instruction was received. Trowel
tells it what actually happened to the pixels.**

The defining capability is a **render-truth feedback loop**: capture the actual
*composited* output (pixels + mixed audio) of the Program Monitor and hand it back
to the model, so an AI can see/hear its edit and judge whether it is correct and
good — not merely whether the API call returned. A good mason doesn't trust that the
brick is flush; they strike it and check. Trowel checks.

## 2. The competitive truth (verified from research, 2026-08)

Field-wide flaws in every existing Premiere MCP, and how Trowel answers each:

| # | Flaw (documented, all competitors) | Trowel answer |
|---|---|---|
| 1 | **Silent success** — `success:true` with nothing done (no export file, keyframes ignored at render, track never created). #1 pain, 10+ issues. | Verify-after-write everywhere; refuse to claim unconfirmable success. |
| 2 | **Blind to output** — DOM readback lies too; nobody inspects rendered pixels/audio. | **Render-truth capture** (Wall 1) — verify composited pixels + mix, return the frame to the model. |
| 3 | **Shatter on point releases** — Premiere 26.x broke split/trim/effect-list; they ride undocumented QE internals. | **Capability self-probe** — self-test which tools work on the installed build. |
| 4 | **Denied-API features faked** — speed/time-remap (5-yr denied), MOGRT text (opaque token) return success anyway. | **Honest escape-hatch fallbacks** (ffmpeg bake; verified MOGRT text or honest failure). |
| 5 | **Fragile 3-layer install; non-coders blocked**; some setup scripts destructive. | **One-command, non-destructive `doctor`** with prebuilt binaries, Windows + macOS. |
| 6 | **Wedge on long ops** — sync export/transcribe freezes transport → false failure. | Heartbeat/fail-fast + chunked ops. |
| 7 | **Weak cross-platform; ExtendScript EOL Sept 2026.** | **Dual-backend CEP+UXP, Windows-first.** |

### 2a. The `Adam-Duchemann/veracut` twin (read in full, 2026-08-21)

An independent developer forked the **same upstream** (`hetpatel-11 @ 8bde853`), reached the
**same diagnosis** ("most servers tell your agent an edit succeeded; this one tells the
truth"), even landed on a name we briefly considered — then abandoned it in one day (5
commits all 2026-07-06), never promoted it, 0 stars in six weeks. Takeaways:

- **Corroboration, not competition.** Two strangers converging on this thesis proves it's
  right and the gap is still open (they didn't fill it).
- **Their honesty stops where ours starts.** Their verification is **DOM read-back**
  (re-read `duration`/`speed` via the API after an edit) — the same layer we already have
  (verify-after-write), and the layer that *still lies* when the API reports a keyframe/MOGRT
  change that renders wrong. They have **no pixel/render-truth capture, no NDI/Syphon/Spout,
  no scopes, no transcription, no recovery, no profiles, no remote.** Wall 1 is untouched by
  every known project.
- **We are a maintained full product; they are a one-sitting stub** (278 tool *names*, many
  "not implemented — refuse loudly"). Their 0 stars is the lesson: a good README doesn't win;
  shipping deeper **and distributing** does (see the marketing plan).

## 3. Locked decisions (owner, 2026-08-21)

- **Backend:** Dual — CEP+ExtendScript **and** UXP, with a capability handshake that
  auto-selects the best path per tool. Future-proofs the Sept 2026 ExtendScript EOL.
  (`uxp-plugin/` already exists in-repo — audit + extend it, do not start from zero.)
- **Scope:** Full product — verified primitives **+** creative workflow layer
  (auto silence-cut, captions, montage, edit-by-transcript) **+** hosted/remote (HTTP/SSE).
- **Platforms:** macOS **and Windows** are both first-class. Windows is a hard requirement.
- **Audience:** must be easy for AI agents **and** non-technical humans.
- **Install:** greenlight to install/ship any dependency; installer must be one-command
  and non-destructive (never overwrite user config — the DaVinci settings.json disaster).
- **Name:** **Trowel** — derived from the material/act ("automatic mud-brick building"),
  a wink not a label.
- **Panel aesthetic:** **Apple-style, Liquid Glass** — translucent layered glass, depth,
  vibrancy, specular highlights, continuous-radius corners, over a dark base with a warm
  terracotta/amber accent. A distinct product identity, NOT camouflaged into Premiere's
  chrome (so: not Adobe Spectrum, not Google Material).

## 4. Wall 1 — render-truth capture (the headline subsystem)

Premiere never hands script a framebuffer of the composited program. We receive it
off a different pipe. One abstraction, four taps, runtime auto-selection:

| Tap | macOS | Windows | Video | Audio | Deps | Best at |
|---|---|---|---|---|---|---|
| **Render/export** | ✅ | ✅ | ✅ | ✅ | ffmpeg (present) | Deterministic, headless, zero-dep fallback |
| **NDI** (backbone) | ✅ | ✅ | ✅ | ✅ | NDI runtime + Transmit plugin | Cross-platform real-time; only tap with audio + both OSes |
| **Syphon** | ✅ | — | ✅ | — | native receiver + Transmit plugin | Lowest-latency frame, macOS |
| **Spout** | — | ✅ | ✅ | — | native receiver + Transmit plugin | Lowest-latency frame, Windows |

**Dispatch policy (the "intelligence"):** probe once (OS, which receivers present,
is an NDI/Syphon/Spout source live, is a Transmit plugin enabled), cache it.
- Need audio (mix loudness) → NDI if live, else render/export + `loudnorm`.
- Need one frame fast → Syphon (mac) / Spout (win) → NDI → render/export.
- Headless / CI / no plugin → render/export.
- "Watch N seconds" → NDI (a/v) or Syphon/Spout (v), driving playhead + playback.

**Honesty contract:** always report which tap was used; verify a real frame/audio was
obtained (decodable, non-empty; settle playhead before grab); if none available, fail
with per-OS install guidance — never hang, never fake a frame.

## 4.5 Speed mandate — fast, fast, fast

Latency is a first-class requirement, not a nice-to-have. Sources and fixes:

- **IPC is the floor.** The CEP bridge panel talks over file-polling at a ~250ms tick
  (shared temp dir `/tmp/premiere-mcp-bridge`). Add a **low-latency transport** — a local
  WebSocket (or named pipe) fast-path between server and panel — with file-IPC kept as the
  robust fallback, auto-negotiated. This is already the UXP backend's native pipe (WS), so
  the dual-backend build earns fast IPC on the UXP side by default.
- **Capture speed path = real-time GPU taps.** Syphon/Spout zero-copy textures and NDI are
  the hot path; render/export is the correctness fallback, never the latency path. Use a
  **warm, persistent receiver** — never spawn one per call.
- **Everywhere:** cache the capability probe (TTL); keep connections warm; batch through the
  Live Queue; chunk long ops so nothing blocks the transport.
- **Targets:** sub-100ms for a state read; display-rate (≥ real time) for a capture frame on
  the GPU taps. Measure and report latency — speed is a visible feature.

## 4.6 The panel — "the verification cockpit" (Apple Liquid Glass)

Verified field truth (panel-UX scout, 2026-08-21): **every existing panel shows plumbing
(a status dot + a text log); not one shows the actual composited program frame or proves an
edit landed visually.** Best in the wild: leancoder's "Ready-to-edit check" + in-panel AI
chat; the Resolve dashboard's "Copy prompt" empty states, non-destructive dry-run plans, and
governance ledger. That is the bar to beat — and none of them show pixels.

**Aesthetic:** Apple Liquid Glass — translucent layered glass over a dark base, real depth
(stacked blur planes), vibrancy, soft specular highlights, continuous-radius corners, a
restrained warm terracotta/amber accent. Its own product identity; not native-Premiere mimicry.

**Backend:** hero panel in **CEP** (Chromium/CEF — trivially displays a localhost
MJPEG/WebSocket pixel stream on a `<canvas>`/WebGL and talks to the local Node helper that
owns the NDI/Syphon/Spout tap; UXP's sandbox makes a high-FPS pixel feed far harder). Ship a
thinner **UXP** companion (failover/light client) sharing one design-token file + one state
model so the two are pixel-consistent. CEP = the cockpit; UXP = the forward-compat twin.

**Layout (narrow vertical panel ~380–460px):**
1. **Render-Truth Viewport** (top, 16:9) — live composited Program thumbnail from the tap.
2. **Vitals strip** — dual-backend twin dots (CEP ● / UXP ●) + compact Latency HUD.
3. **Honesty Ledger** (newest on top) — one row per action: ✓ verified / ✗ refused / ⚠ partial,
   a plain-English sentence, an expandable proof read-back, and a freeze-frame thumbnail.
4. **Doctor** button + collapsible Advanced (temp dir, transport, versions) — plumbing hidden.
5. Footer: transport toggle (WS ⇄ file) + version.

**Five signature elements no competitor has:** (1) the Render-Truth Viewport with a
before/after wipe per action; (2) the pixel-verified Honesty Ledger; (3) a Latency HUD
(IPC round-trip ms, tap FPS, WS-vs-file sparkline); (4) one-click non-destructive Doctor with
plain-English Copy-fix cards; (5) dual-backend live twin + visible auto-failover. Plus cheap
delight: human-sentence ledger narration, Copy-prompt empty states, one "Render Tap: connected"
chip that hides the NDI/Syphon/Spout acronyms behind the Doctor.

## 5. Roadmap (phased, each independently shippable)

**Tier 1 — the moat**
1. Wall-1 capture abstraction + probe + **render/export tap** (zero-dep; unlocks
   true-composite scopes, VLM vision, loudness today). ✅ **SHIPPED** as
   `capture_program_output` (2026-08-21): four-tap abstraction, TTL-cached
   `probeCaptureTaps`, render/export tap live (reuses `exportFrame`), active-sequence
   + playhead defaults, honest per-OS install guidance for the not-yet-wired GPU/network
   taps, `probeOnly` mode, receiver env overrides. Next: wire a live NDI/Syphon/Spout
   receiver so the real-time taps flip to available.
2. Timeline **QC/lint** (flash frames, gaps, mixed fps, dupes, level/safe-zone) — the
   "layout lint" half of the feedback loop. ✅ **SHIPPED** as `lint_timeline`
   (2026-08-21): pure, independently tested analyzer over a shared sequence walk;
   flags gaps, flash frames, overlaps, leading gap, mixed frame rates; configurable
   checks/thresholds; read-only.
3. **Capability self-probe** — extend `get_capabilities` to live-test per-tool on the build.
   ✅ **SHIPPED** (2026-08-21): `get_capabilities({probeLocalTools:true})` spawn-probes
   ffmpeg/ffprobe/Whisper + reports the capture taps; each dependency reports command,
   env override, what it unlocks, and install guidance when absent. Off by default (fast
   path, no Premiere request). Next: extend to a per-tool host-verified matrix once a live
   host is wired in CI.
4. **Speed / time-remap** via honest ffmpeg bake-to-clip. ✅ **SHIPPED** as
   `bake_speed_change` (2026-08-21): frame-accurate constant-speed bake (`setpts` +
   chained pitch-preserving `atempo`), verify-after-write, install guidance.
5. NDI tap (adds live audio + monitoring) → Syphon/Spout taps.

**Tier 2 — cheap/novel**
- ElevenLabs TTS; `import_ae_comps`; edit-plan-with-SHA256-token; keyframe easing; frame vision.
- **Caption CRUD.** ✅ **SHIPPED** (2026-08-21) as SRT-file CRUD, the only honest option:
  Premiere's scripting DOM can INGEST an .srt (`create_caption_track`) but exposes NO
  caption read/update/delete API (long-standing Adobe limitation), so all caption editing
  happens on the .srt file itself, on disk, before (re-)ingest. Seven host-independent tools
  (no Premiere request) over a pure parse/serialize/edit module (`src/tools/srt.ts`):
  `read_srt` (the caption READ path Premiere itself can't give — BOM/CRLF/no-index/WebVTT-token
  tolerant, returns cues + validation + malformed blocks), `validate_srt` (QC only), `write_srt`
  (author from cues, refuses structural errors unless `allowInvalid`), `update_srt_cue`,
  `insert_srt_cue` (chronological placement), `remove_srt_cue`, and `shift_srt_timing`
  (offset ± a range, plus a scale factor for frame-rate mismatch). Every write is verified by a
  full read-back **round-trip** (catches silent text corruption a count-only check misses).
  Native `transcribeSequence` (in-Premiere transcription) is NOT offered — Premiere has no such
  scripting API; `transcribe_to_srt` (local Whisper) already fills that gap.
- Local persistent footage index (footage *discovery* is the real bottleneck).
  ✅ **SHIPPED** (2026-08-21) as `index_footage` + `search_footage`: walks a folder,
  ffprobes each media file for real metadata, persists an incremental JSON index
  (unchanged files not re-probed; atomic write + read-back verify), and searches it
  by name/extension/codec/duration/resolution/fps/audio-video-presence — all before
  any import into Premiere. Host-independent; pure scan-planner + query filter, tested.

**Tier 3 — infra/positioning**
- Remote HTTP/SSE + auth; non-destructive self-healing `doctor` (Win + mac);
  loudness normalization (✅ **SHIPPED** as `normalize_loudness`, 2026-08-21:
  two-pass EBU R128 `loudnorm`, returns measured input loudness); sequence/version
  diff (✅ **SHIPPED** early as `diff_sequences`, 2026-08-21: read-only
  added/removed/moved/retimed classification over a shared sequence walk);
  immersive/HDR (Rec2100) delivery.
- The Liquid-Glass panel build (CEP hero + UXP twin).

**Strategic**
- Dual-backend UXP parity build (the EOL hedge); Windows UI-automation escape hatch
  (UIA/AutoHotkey) alongside macOS System Events.

## 6. Self-audits owed on our own catalog
- `add_text_overlay`: ✅ **AUDITED CLEAN** (2026-08-21). The ExtendScript writes the
  Source Text, reads it back, and only marks a field `ok` when the read-back equals
  the requested string; `evaluateTextInjectionResult` then flips the whole result to
  `success:false` when zero fields landed, `partial` (with a warning) when some did,
  `complete` when all did — so the opaque-token no-op reports failure, not fake
  success. A `rollbackOnTextFailure` path removes the imported Graphic. Covered by
  five tests (failed / partial / complete / not_requested / strategy-markers-not-attempts).
  No honesty bug remains.
- Confirm `razor_timeline_at_time` (cut-through-all-layers) + active-sequence defaults
  remain correct — both are explicitly requested elsewhere; keep as strengths.

## 7. Guardrails (non-negotiable)
- Never return fake success (verify-after-write). Every tool has a Zod schema.
- Generated ExtendScript is ES3-safe (`var` only, no arrow fns).
- Commit identity stays `Skry <121132212+skrfilms@users.noreply.github.com>`.
- Live tool sweeps only on a scratch project, never the owner's working edits.
- Do not rename the `.mcp.json` server key without an explicit decision.
- Confirm no live jest run before editing source; verify green by grepping the jest
  summary (`^Tests:` / `^Test Suites:` / `^FAIL `), never trust exit-code notifications.
- External publishing (npm, Show HN, directory PRs, marketplace) is gated on owner go-ahead.
