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
| 7 | **Weak cross-platform.** (An "ExtendScript EOL Sept 2026" claim appeared here and was WRONG — corrected 2026-08-24: no Adobe statement sets that date; Adobe's on-record line is "no definitive end date… side-by-side for many years.") | **Dual-backend CEP+UXP, Windows-first — as a capability play, not deadline work.** |

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
  auto-selects the best path per tool. NOT deadline-driven: the "Sept 2026 ExtendScript EOL"
  was a phantom (see §2). UXP earns its place only where it unlocks capability CEP cannot.
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

### Tier 0 PRIME — Adobe ships its own MCP server. Read `docs/ADOBE-NATIVE-MCP.md` first.

Verified first-hand from the app bundle on 2026-08-24 (not from docs — Adobe has published
nothing): **Premiere Pro 2026 contains a first-party MCP server.** `Preferences ▸ Agents`,
endpoint `http://localhost:3000/premiere/mcp`, token auth, a Rust `dvamcp::MCPServer`, prompts +
resources + resource templates, the full MCP content model, input **and** output schema
validation, and ~30 tools. Off by default.

This outranks everything else in this document because it changes what we are building.

1. **The bridge is on a clock we do not control.** A first-party server with Adobe's transport,
   auth and validation will out-reliable a third-party CEP file-IPC bridge eventually. Stop
   treating the transport as the moat. Do not start the WebSocket work (Tier 0 #5) on the
   assumption that our transport has a long future — it is now a maintenance question, not a
   strategic one.
2. **Do not compete on primitives.** Their ~30 tools are project/bin/sequence/track/clip CRUD,
   effect parameters, markers, labels, transcript, search. They will win those and should.
3. **Compete above the primitives, which is where we already are.** Nothing in their surface
   touches export/encode, render-truth, Lumetri, audio (loudness/ducking/normalisation),
   captions, proxies, MOGRT, keyframe interpolation (`bake_keyframe_ease` specifically), the
   QE-only capabilities (Morph Cut, effect-stack reorder, speed), scene edit detection, Project
   Manager, EDL/AAF/OMF/FCP XML, multicam, stabilisation, timeline linting, or recovery
   checkpoints.
4. **Verification is worth MORE now, not less.** Schema validation in and out is *argument*
   checking. Nothing in their symbol table suggests a readback, fingerprint or pixel check, and
   QE remains the only route to several capabilities where silent no-ops are normal.
5. **Evaluate `RegisterUXPMCPHandler` seriously — it may be the distribution answer.** A
   third-party UXP plugin can register tools *into* Adobe's server, inheriting their transport,
   auth, schema validation and timeouts, and letting us drop the most fragile thing we own.
   "Register into it" plausibly beats "compete with it".
6. **Steal two ideas immediately, both cheap:** `getToolTypings` (a TypeScript `.d.ts` describing
   every registered tool — a strictly better answer to the discovery problem than prose tool
   descriptions), and their instruction to fetch typings *before* calling a tool.
7. **Open question worth one experiment, needs owner go-ahead** (it opens a network listener):
   does *enabling* their server register `MCPScriptingExtensibilityAPIObject` into the
   ExtendScript context? Probed with it disabled: `typeof MCP` is `undefined`, nothing on `app`,
   nothing in `$.global`. If enabling exposes it, our existing bridge could call Adobe's native
   tools with no new transport at all. Repro in `ADOBE-NATIVE-MCP.md` §4.

### Tier 0 — CLOSED overnight 2026-08-24

Recorded so the list below is not re-worked. Evidence in `docs/RUN-LOG-2026-08-24.md`.

- **Dead-engine detection (was Tier 0a #1, "the most important thing in this document") — DONE.**
  `scripts/engine-sentinel.mjs` distinguishes HEALTHY / ENGINE_DEAD / PANEL_DEAD / BUSY,
  dependency-free so it works when the TypeScript build is broken. Classifies on whether the
  panel *consumed* the command, which is the "never ran" vs "may have run" distinction.
- **Auto-recovery — DONE and measured at ~32s** (`scripts/lib/host-recovery.mjs`). Engine death
  is no longer fatal to an unattended run.
- **Modal resilience (Tier 0 #2) — mostly DONE, and better than planned.** We can now *clear* a
  modal unattended, not merely detect one: Premiere exposes zero windows to the accessibility
  API, but System Events **keystrokes** reach the frontmost app, and Escape dismisses Link Media.
  Still owed: the typed `-32006 MODAL_REQUIRED` error code.
- **Clip Mismatch Warning blocking fixture construction (Tier 0 #2c) — DONE by removing the
  cause.** `scripts/reset-scratch.mjs` generates format-identical media with ffmpeg, so the
  mismatch dialog cannot arise. No preference hunt was needed.
- **`sequenceId` inconsistency — DONE.** Optional on 28 more tools; `__findSequence` falls back to
  the active sequence.
- **The 638-tool default — DONE.** Default profile is now `core` (97 tools). See the run log for
  the measurement; `all` cost ~51% of a 200k context and could not run in VS Code at all.

### Tier 0 — ADDED overnight 2026-08-24

1. **A stale "cannot do" list is a lie in the same class as a fake success.** `api_surface_report`
   was publishing a hardcoded `total_tools: 600` against a 638-tool build, and still listed the
   system clipboard as impossible after we cracked it. Counts are now computed and the wall
   entries carry their evidence, with a `cracked_since` field. **Owed: a test that fails when a
   `confirmed_wall` entry names a capability a passing live test exercises.**
2. **Half-applied edits must be reported as such.** Three trim tools returned `success: true,
   verified: false` with an *empty* reason. Worse, when `inPoint` moved but the clip did not
   ripple, the project was left in a state the caller never asked for and the tool still claimed
   success. Fixed for `ripple_trim_in`/`out` and `extend_edit`; **audit the rest of the catalogue
   for `verified:` computed as a bare inequality with no accompanying explanation.**
3. **Verification cannot distinguish "changed it" from "was already correct".** `clear_work_area`
   passed its own check because its target already equalled the current state. Every
   verify-after-write must capture `before` and report `changed` separately from `onTarget`.
4. **`NEEDS_ARGS` is the coverage ceiling, and it is our harness's fault, not the tools'.** In the
   overnight sweep it was the single largest bucket. Argument synthesis by parameter-name pattern
   is the limiting factor on live coverage — invest there next, not in more gates.
5. **Real bugs found and not yet fixed:** `rename_timeline_clip` fails with a host-side
   evalScript error; `version_up_sequence` throws "Illegal Parameter type";
   `audio_crossfade_at_cut` returns "Invalid parameter".

**Tier 0 — hardening owed from the 2026-08-24 live-testing session.** Everything here was
found by actually running the catalogue against a live host, or by reading eight competing
bridges' source. Ordered by severity, not effort.

1. **AUTH ON THE BRIDGE — security hole, do this first.** There is no authentication on the
   file IPC. Any local process that can write to `/tmp/premiere-mcp-bridge/` can drop a
   `command-*.json` and execute arbitrary ExtendScript inside Premiere: full project access,
   and filesystem reach through the `cep_js` path. Of eight bridges whose source was read,
   only two have auth (leancoderkavy: token in the WS upgrade query, `timingSafeEqual`,
   loopback-only bind, min 16 chars; adobepy: per-session broker token in a `hello` frame).
   We are in the majority and the majority is wrong. Minimum viable fix: a per-session token
   written to a `0600` file that the panel must echo in every command, plus a mode bit on the
   temp dir.
2. **Modal-dialog resilience.** A native modal blocks the CEP bridge until a human clicks it,
   and every queued command then stalls to its timeout — the server looks hung. Confirmed
   dialog sources so far: the QE synthetic-media constructors
   (`newColorMatte`/`newBlackVideo`/`newBarsAndTone`/`newTransparentVideo`/`newUniversalCountingLeader`),
   adding an **obsolete** audio effect (`Adaptive Noise Reduction` on 26.3.2 → "Audio Effects
   Replacement"), `Track.overwriteClip` with mismatched media → "Clip Mismatch Warning", and
   EDL import. Owed: (a) a typed error code for this state — adobepy already models it as
   `-32006 MODAL_REQUIRED` and we should match; (b) a maintained denylist of dialog-opening
   calls with the modern replacement where one exists (the obsolete-effect remap is done);
   (c) investigate whether the mismatch warning can be suppressed via a preference, since it
   currently blocks fixture construction.
3. **Finish live coverage.** 604 tools; **231 have ever executed against a host (~38%)**. The
   unit suites prove generated ExtendScript parses and names no undefined identifiers — they
   cannot prove the host accepts a call. Today's sweep found bugs no static check could:
   every `require()` dead under ESM, `TrackItem.setInPoint` not existing, `new Set()` in ES3,
   a `====` typo, a per-frame `palettegen`. Blockers to finish: ~82 tools need fixture
   material that doesn't exist yet, ~95 are genuinely unsafe to sweep unattended, and the
   fixture build itself trips the mismatch dialog (see 2c). Harness is
   `scripts/live-smoke-sweep.mjs` (tiers READ/MUTATE/SKIP, refuses non-scratch projects,
   aborts naming the culprit if the bridge stays busy >12s); fixture builder is
   `scripts/build-test-fixture.mjs`; single-tool bisect is `scripts/bisect-hang.mjs`.
4. **Diagnose `match_shot_color`.** It wedged the ExtendScript engine so hard that a graceful
   Premiere quit could not complete — only a force-kill cleared it. Cause not yet known. It
   is the one confirmed engine-killer in the catalogue and must be understood before the
   mutate tier can be swept unattended.
5. **Transport: evaluate WebSocket push.** Ours is a 250 ms file poll, which sets a latency
   floor per call; six of eight bridges read use WS push. Do **not** naively move the
   listener into the MCP server: CaYatur documents why (`docs/ARCHITECTURE.md`) — MCP servers
   are launched per-session over stdio, so an in-process listener drops the plugin on every
   session restart and concurrent sessions fight the port. A separate relay daemon is the
   pattern that survives. Adopt alongside it: reconnect on `close` only and never on `error`
   (avoids reconnect storms), payload caps with a typed too-large error rather than silent
   truncation, and a `pending` Map keyed by UUID for real multiplexing. Keep file IPC as the
   fallback — it needs no ports and no firewall prompt.
6. **Bounded queue semantics — DONE, keep the lesson.** The panel's `commandQueue` was
   push-only: nothing was ever removed, so `heartbeat.queueLength` reported a lifetime total
   rather than outstanding work, and an idle healthy panel advertised a queue in the hundreds.
   I misread that field as evidence of a wedged queue during this session. Fixed. Any future
   heartbeat field must be checked for the same "means something other than its name" failure.

### Tier 0a — the ten bridge bugs (from `docs/BRIDGE-COMPARISON.md` §5, all evidenced)

Ordered by severity. #1 is the most important thing in this document.

1. **A DEAD EXTENDSCRIPT ENGINE READS AS HEALTHY — the moat has a hole in it.** [MEASURED]
   The engine can die such that every call times out *permanently* while the heartbeat
   reports `connected: true, isProcessing: false`, age ~90 ms. Our heartbeat proves the
   **panel** is alive; it says nothing about the **engine**. This is the single root cause of
   most of the confusion in the 2026-08-24 session: I repeatedly diagnosed "stale queue" or
   blamed innocent tools when the real state was a dead engine behind a healthy-looking
   beacon. **No Premiere MCP in the field detects this.** Fix = a **drain sentinel** (a
   trivial round-trip probe whose failure is unambiguous), and after N consecutive failures
   say plainly *"restart Premiere Pro"*. The pattern is proven in JUNKDOGE's After Effects
   bridge and ports verbatim. Closing this makes us the only Premiere bridge that can tell an
   agent *"your edit may or may not have applied, and here is which"* — worth more than any
   latency work.
2. **Timeouts throw away the one fact that matters:** whether the command was *consumed*. The
   `finally` unlink already computes it (`index.ts:731-733`) and discards it. Near-free, and
   the biggest honesty win available: "never ran" vs "may have run" is the difference between
   safe retry and double-applying an edit.
3. **Spurious "panel stopped responding".** [MEASURED] A *single* transient heartbeat
   `ENOENT` — observed on a live, healthy panel — trips the death verdict
   (`index.ts:871-883`). Require 2–3 consecutive stale/missing reads.
4. **No depth cap or cycle detection in `__mcpStringify`** (`index.ts:79-173`), against a DOM
   full of parent/child back-references. Plausibly a *cause* of the engine death in #1. Add a
   depth cap, a `seen` set, and an actionable overflow message.
5. **The prelude ships twice per call** (~20 KB of pure overhead on a size-capped channel),
   and the denylist scans both copies (`index.ts:619-638`, `bridge-cep.js:499`). Load helpers
   once via a content-hashed `$.evalFile`.
6. **The 45 s panel watchdog is a floor that cannot be lowered** — `timeoutMs` only ever
   raises it (`bridge-cep.js:503-506`) — so one bad script wedges the bridge for 45 s no
   matter what the caller asked for. Every probe in the survey cost exactly ~45 s. Honour a
   *lower* requested timeout above a sane floor.
7. **No startup sweep, and no ownership check on a pre-existing temp dir**
   (`index.ts:1855-1858`). A leftover `command-*.json` **executes when the panel next
   starts.** Combined with Tier 0 #1 (no auth) this is a persistence vector, not just
   untidiness.
8. **No cross-process mutual exclusion.** Two server instances sharing the dir have no lock;
   `isProcessing` is per-panel. `kumoproductions` solves it with `open("wx")`.
9. **`uxp-plugin/` cannot work as written** — `require('premiere')` is the wrong module and it
   depends on non-existent `app.executeExtendScript`/`app.evalScript`
   (`uxp-plugin/bridge.js:11, 144-174`). Rebuild against native `premierepro` or delete it;
   shipping a plausible-looking dead plugin is worse than not shipping one.
10. **`queueLength` was a lifetime counter** — fixed this session, listed for completeness.

### Tier 0b — the one rival genuinely ahead of us

**`leancoderkavy/premiere-pro-mcp`** (211★, 284 commits, pushed the day of the survey) is the
only Premiere server ahead of us architecturally, and only in specific places: three
transports instead of one, `fs.watch` **push** on the response edge, helpers loaded **once**
via content-hashed `$.evalFile`, an atomic rename-claim ownership protocol, stricter temp-dir
ownership, and — the part that matters — **a working native-UXP plugin with per-command
capability negotiation.** That last item is our stated moat implemented at the transport
layer, by someone else, today.

They are *behind* us on JSON safety in a way that will silently corrupt real responses (they
escape only `\\ " \n` and ship **no `JSON.parse` at all**) and on liveness granularity. Read
their `src/bridge/uxp-websocket-bridge.ts` and `uxp-plugin/index.cjs` before building ours.

**`ayushozha` is not the threat its README implies.** The gRPC/Rust is real but sits behind
its own MCP server; their own `.proto` admits the last hop is CEP `evalScript`, and their
audit concedes *"Live CEP/Premiere execution was not performed."* Their genuine lead is
transport **auth** (see Tier 0 #1).

**Tier 0 — strategic risks surfaced by the bridge survey**

- **Adobe may obsolete this entire transport layer.** Illustrator (Beta) ships a **native
  in-app HTTP listener** — `localhost:18412/v1/mcp`, streamable HTTP, `Authorization: Bearer
  ilst_<64hex>`, enabled from an in-app "MCP & Tools" menu, with presets for Cursor/Claude
  Code/Codex. Adobe's answer to "UXP cannot listen" was to skip the extension layer entirely.
  [DOC CLAIM — the endpoint shape is from Adobe help pages; tool surface and limits are
  unverified because the pages timed out. Resolve by pointing a client at that endpoint in
  Illustrator Beta and reading `tools/list`.] If this reaches Premiere, our CEP bridge becomes
  legacy. Our differentiators (verify-after-write, render-truth, honest wall) survive the
  transport change; the bridge does not. Track it.
- **UXP cannot listen — plugins must dial out.** `AdobeDocs/uxp-premiere-pro-samples` contains
  zero `WebSocket` or `fetch(` hits: Adobe ships no networking sample for Premiere UXP. Any
  UXP parity build inherits dial-out plus a relay.
- **UXP 26.3 `lockedAccess` is synchronous.** 26.3 made wrapping `create*Action()` in
  `lockedAccess(callback: () => void)` mandatory, so every async lookup must resolve *before*
  entering the lock. CaYatur hit this live: `CompoundAction#addAction()` throws synchronously
  for actions from collection-level factories (SequenceEditor, Markers) while
  TrackItem/ComponentParam-sourced ones work. Adobe ships `@adobe/eslint-plugin-premierepro`
  to catch it. Budget for this in the UXP hedge.
- **Windows WS instability in a peer bridge.** adb-mcp #32: the whole Premiere process dies on
  the first inbound command over the socket.io `websocket` transport (Win10 26100, French
  locale, Premiere 26.3.0.93); their fix flips Windows to `["polling"]`. **ASSERTED, NOT
  VERIFIED** — the reporter never confirmed, the maintainer could not reproduce, and locale
  was never eliminated. Treat as a reason to make transport **configurable**, not as an
  established root cause. Relevant if we adopt WS.

**Tier 0 — what the survey says we should keep and can claim**

- **App-level heartbeat: unique to us.** `grep -rn "heartbeat|ping|pong"` across every
  competing plugin returned **zero**. No other bridge can distinguish a host wedged behind a
  modal from a healthy idle one; they all wait out a timeout. leancoderkavy documents theirs
  as unbuilt. This is the single clearest architectural lead we have.
- **Panel-context code execution (`cep_js`) is rare.** Only one *working* peer has a generic
  eval path (nepfaff, file IPC, 3★, zero validation); adobepy's is almost certainly broken
  because `allowCodeGenerationFromStrings` is never declared in its manifest. Every
  socket-based bridge with real usage chose a strict allowlist instead. Ours should stay
  gated, not become a generic eval endpoint.
- **Atomic command publish.** We write `.tmp-<uuid>.json` then `rename()` into place because
  the panel polls for `command-*.json` and a plain write publishes a truncated file the panel
  would fail to parse — turning a transient race into a permanent failure. Keep.

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
- Generated ExtendScript is ES3-safe (`var` only, no arrow fns). **This means no `Set`, no
  `Map`, no `Array.prototype.indexOf`/`forEach`, no `let`/`const`.** A `new Set()` shipped
  undetected until the syntax suite was finally run against the grown catalogue.
- **Node-side tool code is ESM — never `require()`.** `package.json` is `type: module`, so
  the compiled dist has no `require`. All 58 `require()` calls were dead in production while
  appearing to work under `node -e` (which runs as CJS and leaks `require` as a global). Use
  the top-of-file `execSync` / `fsSync` / `pathSync` / `osSync` imports. Verify Node-side
  tools with `node --input-type=module`, never bare `node -e`.
- **Prefer live reflection over documentation** for API facts, and record it in
  `docs/VERIFIED-API-SURFACE.md`. Docs said nothing useful about
  `TrackItem` lacking `setInPoint`, and six tools shipped calling that nonexistent method.
- **Before adding a tool family, diff the API surface against the catalogue.** The proxy miss
  (four attachment tools, no `getEnableProxies`) was a mechanical gap that a diff catches and
  a docs read does not. `docs/API-COVERAGE-MATRIX.md` is the artifact.
- **Passing unit suites are not evidence a tool works.** They prove the emitted ExtendScript
  parses and names no undefined identifiers. Only a live host call proves behaviour; report
  coverage as "executed against a host", not "tests green".
- Commit identity stays `Skry <121132212+skrfilms@users.noreply.github.com>`.
- Live tool sweeps only on a scratch project, never the owner's working edits.
- Do not rename the `.mcp.json` server key without an explicit decision.
- Confirm no live jest run before editing source; verify green by grepping the jest
  summary (`^Tests:` / `^Test Suites:` / `^FAIL `), never trust exit-code notifications.
- External publishing (npm, Show HN, directory PRs, marketplace) is gated on owner go-ahead.
