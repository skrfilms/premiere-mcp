# Feature Comparison

**What this document is:** a survey of every Premiere Pro MCP server — plus the
instructive adjacent Adobe MCPs, the paid non-MCP Premiere tools, and DaVinci Resolve —
at the level of **tools, workflows, agent ergonomics, packaging, docs and safety.**

It is the companion to `docs/BRIDGE-COMPARISON.md` and deliberately does **not** revisit
transport. That question is settled there: everyone reaches Premiere through
`evalScript`, and the interesting differences are above the wire.

**Date of survey:** 2026-08-24. **Our baseline at survey time:** 637 tools (638 after
this document's work), 13 resources, 10 prompts, branch `improve/m1-honesty-and-core-bugs`.

## Evidence standard

- **[CODE]** — the repository was cloned and the file read. Path given.
- **[BINARY]** — extracted from a shipping application binary on this machine.
- **[DOC]** — first-party documentation, quoted.
- **[MEASURED]** — measured on this machine.
- **[CLAIM]** — a README/marketing assertion that could **not** be confirmed in source.
  Treat as unverified.

Clones live under `/tmp/feat-research/` (ephemeral). Where a README claims a feature its
source does not contain, that is called out.

---

## 0. The finding that reframes everything: Adobe already ships a Premiere MCP server

**[BINARY — verified independently on this machine, twice]**

Adobe Premiere Pro **26.3.2** — the build installed here, dated 2026-08-13 — contains a
complete, native, first-party MCP server. This is not in any documentation, Adobe's or
anyone else's. It was found by inspecting the shipping app bundle.

```
$ strings "Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026" | grep dvamcp
dvamcp::RegisterUXPMCPHandler
N6dvamcp10IMCPServerE      N6dvamcp15IMCPToolHandlerE
N6dvamcp11IMCPHandlerE     N6dvamcp17IMCPPromptHandlerE
N6dvamcp12ImageContentE    N6dvamcp19IMCPResourceHandlerE
N6dvamcp14CallToolResultE  N6dvamcp20BlobResourceContentsE
MCP.EnableUXPHandler
MCP.EnableExperimentalTools
```

It is a **Rust** MCP server (`dvamcp::MCPServer`) bridged into the C++ app. There is a new
**Preferences ▸ Agents** panel — `Contents/Settings/EveScripts/AgentsPrefsPanel.adam.eve`,
3,604 bytes — carrying the strings `Model Context Protocol Server`, `Enable MCP server`,
`Require Authentication`, `Copy MCP Configuration`, and the endpoint
**`localhost:3000/premiere/mcp`**.

**36 native tools**, extracted verbatim from the binary's RTTI:

`addEffects` · `addTracksToSequence` · `copyTrackItemAttributes` · `createBins` ·
`createSequences` · `createSubClips` · `createTranscript` · `deleteProjectItems` ·
`deleteTrackItems` · `deleteTracks` · `executeMCPScript` · `getAppliedEffects` ·
`getAvailableEffects` · `getClipInfo` · `getEditingContext` · `getEffectParams` ·
`getMarkers` · `getOpenProjects` · `getProgress` · `getProjectItems` ·
`getSequenceStructure` · `getToolTypings` · `getTrackItemProperties` · `getTranscript` ·
`importFiles` · `insertClipsToSequence` · `interpretFootage` · `manageMarkers` ·
`moveOrCopyProjectItems` · `moveOrCopyTrackItems` · `renameProjectItems` · `renderFrame` ·
`setEffectParameters` · `setLabelColors` · `setTrackItemProperties` · `universalSearch`

What matters about it:

- **It implements more of the MCP spec than we do.** `tools/list`, `tools/call`,
  `prompts/list`, `prompts/get`, `resources/list`, resource *templates*, `resources/read`,
  **`resources/subscribe`**, **`resources/unsubscribe`**, cursor pagination, `outputSchema`,
  `structuredContent`, and all four annotation hints.
- **`getToolTypings` returns TypeScript declarations for its own tools** — progressive
  disclosure baked into the tool surface.
- **`getProgress` + `progressTrackingId`** — a first-party async job convention.
- **`dvamcp::RegisterUXPMCPHandler` + `MCP.EnableUXPHandler`** — third-party UXP plugins can
  **register their own tools into Adobe's server**, with `MCP.callMCPTool` /
  `MCP.listMCPTools` / `MCP.postMCPResponse`.
- Tool granularity is **coarse and plural**: `createBins`, `deleteTrackItems`,
  `moveOrCopyProjectItems`. One call, many objects, batching by parameter.

**Strategic read (opinion, clearly labelled).** Our bridge is not the moat and never was;
this is the second independent signal after Illustrator. But note what Adobe's 36 tools
*do not* include: no verification semantics, no render-truth capture, no lint, no honest
capability wall, no ffmpeg escape hatches, no caption CRUD, no recovery checkpoints. Two
postures are viable and they are not exclusive: differentiate on depth and honesty above
their 36, and/or **register into their server** via `MCP.EnableUXPHandler` and become an
in-app extension rather than a competing bridge. Either way this belongs in TROWEL-PLAN
Tier 0, and the feature flags mean it may be off by default today — **confirm by enabling
`Preferences ▸ Agents` and pointing a client at the endpoint.** Do not treat the tool list
as final; it is a flagged, `0.0.2` surface.

Related **[DOC]**: Adobe's **Illustrator** MCP is the documented sibling. Adobe's help page
says *"You can work with 40 Illustrator tools and actions through this integration"* and
never publishes the names; they were recovered from `MCPToolkit.aip` in stable Illustrator
30.7 — 78 tools, 70 external, **46 default-on**, `PascalCase` `VerbNoun`, **no prompts, no
resources, no annotations, and `outputSchema: {}` on every single tool.** Adobe's own two
servers disagree with each other on all three; Premiere's is the more modern design.

---

## 1. Per-server findings

### 1.1 `leancoderkavy/premiere-pro-mcp` — the real rival (211★, v1.13.0, ships daily)

313 core tools + 50 UXP-gated = 361 max; 311 exposed by default. **[CODE]**
`src/server.ts:253-320`.

**They are ahead of us on four things.**

**(a) Plan → preview → apply, with confirmation tokens. 12 tools, three token schemes.
We have zero dry-run of any kind** (`grep -c dryRun src/tools/*.ts` → 0). **[CODE]**
`src/tools/edit-plans.ts:112-156`:

```ts
export function confirmationToken(plan: EditPlan): string {
  return createHash("sha256").update(canonicalPlan(plan)).digest("hex");
}
```

`preview_edit_plan` needs only the `inspect` capability, touches Premiere not at all, and
returns `{operationId, changes[{index,type,target,destructive}], confirmationToken,
applied:false}`. `apply_edit_plan` re-validates and hard-fails on mismatch: *"Confirmation
token does not match this edit plan; preview it again"* (`:144`). `apply_spot_workflow_plan`
(`src/tools/spot-workflows.ts:476-571`) is the biggest true macro in either codebase — in
one bridge request it asserts the target sequence is active, asserts the target tracks are
**empty**, resolves every asset by nodeId, QE-preflights the transition, inserts each clip
and **reads each placement back within one frame**, writes and re-reads Motion→Scale
keyframes, adds transitions only at *observed*-adjacent cuts, imports the MOGRT and
verifies the title-track count rose.

**(b) 19 `expected_*` stale-state preconditions** — `expected_start_seconds`,
`expected_parent_id`, `expected_checksum`, `expected_sequence_guid`, plus plan-level
`expectedContextRevision` / `expectedTimelineRevision`. Ours are almost all *post-hoc
output* asserts (`expectedMatchName`, `expectedDurationSecs`), not per-call mutation
preconditions. NodeIds go stale after every timeline edit; today we fail confusingly.

**(c) A generated, CI-diffed catalogue.** **[CODE]** `scripts/generate-supported-actions.mjs`
spins up their real server over `InMemoryTransport`, paginates `tools/list`, and writes
`docs/supported-actions.md`; `npm run check` fails the build if the doc drifted. Their
published action list *cannot* go stale. Ours had drifted three different ways (§3).

**(d) A claims registry.** `docs/claims-registry.json` + `tests/claims-registry.test.ts`,
wired into `npm run check`. Every public number is templated from `release-metadata.json`;
**every claim carries a mandatory `boundary` field describing what it does not prove**; and
a `prohibitedUntilEvidenceExists` list bans testimonials, adoption claims, and any
"Adobe affiliation, endorsement, or certification". This is our stated thesis, mechanized,
by someone else.

Also theirs and worth noting: 11 MCP prompts named `premiere-<workflow>` whose template
hard-names a `recommendedTools` chain; 14 resources, **every one explicitly
path-redacted/bounded** (ours are not); `structuredContent` on every result; MCP annotations
on every tool; six required `confirm_*` booleans for non-undoable host ops; a
`VerificationBoundary` union (`static_metadata_only | host_response |
structured_uxp_readback | plan_revalidation | …`) returned per tool by `get_capabilities`;
`--doctor --json` and `--support-bundle` with an explicit `privacy.excludes` list;
localized quickstarts with a CI check that each locale discloses it is a machine-assisted
draft; and four tools registered **solely to say no**, e.g. `import_edl` — *"Unavailable by
design: CMX 3600 EDL import opens Premiere UI that can block the CEP bridge… convert the
EDL to FCP7 XML and use import_fcp_xml."*

**Where they are behind us:** no restore (`recovery.ts:264` reports
`automaticRestoreSupported: false`; we have `restore_recovery_checkpoint`); no auto-undo or
rollback (`atomicRollback: false` declared); their tool descriptions average 106 chars to
our 144; their `VerificationBoundary` is mostly **heuristic**, inferred from name prefixes
and a `/\bQE\b/i` regex over the description, with exactly one tool declaring it explicitly
— an honesty gap inside the honesty machinery. And a real defect: **[CODE]**
`src/server.ts:162-251` — their JSON-Schema→Zod mapper drops `minLength`/`maxLength` (102
uses), `minimum`/`maximum` (70 uses) and `minItems`/`maxItems`, and inverts
`additionalProperties:false` (58 uses) into `.passthrough()`. Their carefully bounded
schemas are not what the client sees.

Their own cracks: README says 14 resources, `release-metadata.json` says 4;
`SECURITY.md:13` points at an abandoned repo; chat-plugin build scripts hardcode
`VERSION="1.0.0"` against a 1.13.0 package.

### 1.2 `ayushozha/AdobePremiereProMCP` — 1,064 registered, 72 exposed (86★)

**The gating mechanism, exactly** **[CODE]** `go-orchestrator/internal/mcp/server.go:41-43`
and `tool_profiles.go:196-265`: register all 1,064, then **delete** what the profile
excludes. Env `MCP_TOOL_PROFILE`, default `standard`, `path.Match` globs. Reproduced
independently: **1,064 registered, exactly 72 survive, zero dead patterns.**

It is architecturally the same static env-selected profile list we already ship — **no
router, no meta-tool proxy, no dynamic registration.** But five things it does that our
`profiles.ts` did not:

1. **An `unsafe` deny-by-default trust class.** Even `MCP_TOOL_PROFILE=all` *subtracts* it
   unless you also name `unsafe`. 31 tools: arbitrary ExtendScript, shell, URL, clipboard,
   external editor, 8 file-I/O. We have `PREMIERE_MCP_EXCLUDE` but no built-in dangerous
   class an operator gets for free.
2. **Profiles are a verification allowlist enforced by tests.** **[CODE]**
   `skill_profiles_test.go:140-166` — `TestVerifiedWorkflowProfilesOmitUnverifiableLegacyTools`
   fails the build if an unverified tool leaks into a named profile.
3. **A written promotion gate.** `docs/workflow-research.md`: admission to `standard`
   requires deterministic preflight, a verified duplicate before mutation, public-DOM
   readback, fixture coverage, **and** a live sweep on every claimed OS/Premiere combo —
   then, verbatim: *"Meeting the first four items is not live certification. Until the fifth
   item is run, the repository calls a workflow 'readback-first' but does not call it
   live-certified."*
4. **Prompts are profile-aware and fail closed** (`prompts.go:16-20`) — a prompt is never
   advertised if the profile culled the tools it references.
5. **`tools/list` is cursor-paginated** (`MCP_PAGE_SIZE=100`). We do not paginate at all.

Two things gating buys them that they do not advertise: **[MEASURED]** exposed-tool
descriptions average 32.1 words, hidden ones 15.1 — gating hides low-quality schemas as
much as it saves tokens. And their host layer has **56 honest `unsupported …` returns**,
each with a cause and a redirect, e.g. `premiere.jsx:12648`: *"unsupported addRectangle: CEP
cannot create and verify an Essential Graphics rectangle layer; use a MOGRT or imported
graphic."* Many "hidden" tools are hidden *declared impossibilities* — a free "do not build
this" map, most valuably that **Essential Graphics text/shape creation is a hard wall via
CEP.**

Their best safety artifact is in CI, not the server: **[CODE]**
`cep-panel/scripts/check-command-coverage.js` runs the real 28,778-line `premiere.jsx`
inside Node's `vm` against hand-built fake Premiere DOM objects and asserts
**fail-and-rollback** — `createSequence` must delete the sequence it just made and return an
error containing `"invalid sequence was deleted"` when `getSettings()` doesn't echo the
requested dimensions. That is our honesty thesis mechanized *without Premiere*, and it is
the strongest single idea in the repo.

Genuine capability we lack, verified as real jsx implementations: **menu/keyboard dispatch**
(`execute_menu_item`, `find_menu_item`, `get_shortcut_conflicts` — `premiere.jsx:24219` is
just `qe.executeCommand(menuItemId)`, and **we already have the private helper** at
`src/tools/expanded.ts:971-981`); **`show_confirm_dialog`/`show_input_dialog`** (a real
human-in-the-loop gate inside Premiere; we have zero `confirm(` in our source);
**`get_effect_parameter_range`** (reads `param.minValue`/`maxValue` — we have zero such
references, and an LLM guessing effect values is a top failure mode); `paste_attributes`,
`group_clips`/`ungroup_clips`; `create_submix`/`solo_audio_track`; `import_aaf`/`import_omf`
(we export both, cannot import); `get_clip_usage_in_sequences` (where-used index);
source-timecode read/offset + `sync_by_timecode`; VR/HDR/bit-depth; media-cache and
auto-save preferences. Plus a **JSON-Schema validator as tool middleware** (`validation.go`)
whose stated rationale is *"centralizing validation here keeps malformed values from being
interpreted as destructive zero/default values by Premiere Pro."*

One over-claim found: the CHANGELOG's "Adobe Stock search integration" returns an empty
result set plus a URL (`media_browser_ops.go:167-172`). Install is their clear weakness —
Go + Rust + Python + Node + protobuf + `just`, no npx, no prebuilt binaries, no doctor,
Windows explicitly partial. **No dry-run, no preview, no confirmation gate in the server.**

### 1.3 `CaYatur/PremiereProMCP` — a second real rival, mis-scoped in the brief

277 tools, verified in code (`server/src/tools/index.ts:26-50`), plus a server-side
orchestration engine. Not a minor project.

**The highest-value single finding in the survey is their playbook tier.** **[CODE]**
`server/src/agent/ops.ts:1727` — `PLAYBOOKS` is
`Record<string, {title, description, quality, build(args) => EditOp[]}>`: **a playbook is a
pure function compiling arguments into an op list.** 37 ops, 14 playbooks (`assemble`,
`youtube`, `social`, `trailer`, `music_video`, `podcast`, `delivery`, `qa_pass`,
`chapters`, …), executed by a `runOp` that never throws and retries once, on TIMEOUT only.
Entry points: `edit_auto {intent, args, dryRun}`, `edit_playbook_run`, `edit_pipeline
{stages[1..8]}`, `edit_run {plan[1..30], throttleMs}`, `edit_quality_pass`, `edit_delivery`,
`edit_verify`. `resolveIntent()` is 12 regexes mapping natural language to a playbook.

`edit_quality_pass` is the best-engineered piece: it grades a *window* of clips, applies
transitions only on the window's internal edges, fades in only when `clipFrom===0` and out
only when `!hasMore`, and returns `{graded, clipFrom, nextClipFrom, hasMore,
largeProjectHint}` so the agent loops. Its description says why: *"Never grades 200 clips in
one shot (Premiere crash)."* That **resumable batch envelope** is directly portable.

Two learned-lesson guards worth copying verbatim: `resolveGainDb` clamps to `[-48,+15]` and
defaults to 0 dB unity *because UXP's linear 0..1 maps 0 dB ≈ 0.178*; and `polish` keeps
normalize opt-in with the comment *"blind Level writes were muting beds/SFX."*

They also have: **inline base64 image content blocks** annotated `[PURE encode]` /
`[full Premiere window]` / `[full desktop fallback]` so the model knows whether it is
looking at a real render or a screen grab; `sequence_qa_loop` (tracks + markers + still in
one call); a `recoveryHint(code, message)` table (`toolDefinition.ts:44-67`) surfaced as
`[CODE] message → recovery`; `compact: true` by default, truncating arrays >12 and strings
>200; `analyze_detect_onsets` (ffmpeg energy-peak beat detection) and
`analyze_suggest_cut_points`; named look packs with baked Lumetri maps; ticks/seconds/frame
conversion helpers; `checkpoint_delete`; and per-item **partial-success arrays**
(`{text: "…3/5 clip(s)", data:{results:[{...clip, ok, error}]}}`) — we fail a whole call on
one bad clip.

**The competitive threat is their README section "Tool status: what's actually tested",**
which splits into "holds up well under real end-to-end testing" (naming a specific
48-second test sequence), "Fix applied, pending a live re-test", "Still broken — confirmed
Adobe platform limitation" (with the literal error string), and "Lower-confidence claims
(from earlier static code analysis, not re-verified)", closing *"static code analysis alone
has already been wrong once here."* `docs/FEATURES.md` adds a six-tag verification legend.
That is our stance, published, and more specific than ours.

Their weaknesses: **zero MCP prompts, zero MCP resources** (five are *specified* in
`docs/FEATURES.md:661-666` and were never built), **zero tool curation**, no undo tool at
all, hard **Windows-only** (WinForms installer, Win32 HWND frame grabs, hardcoded
`C:\Program Files\Adobe\`), and their own `FEATURES.md:631` still says *"this is still a
specification — 0 of these 275 exist as working code today"* alongside 277 shipped tools.
Their most-referenced guidance doc, which `edit_help` orders the model to read, is written
**entirely in Turkish** and is a disk file, not a resource — unreachable by any agent.

### 1.4 `hetpatel-11/Adobe_Premiere_Pro_MCP` — our upstream (488★)

**Nothing to port; we are a strict superset.** 283 tools (`comm -23` against our list →
empty; we add 354+). Prompts and resources **byte-identical** to what we shipped until
today. Their 171 loop-generated tools described as `Premiere Pro expanded operation: <name>`
with `z.record(z.any())` are already fixed by our `expanded-schemas.ts` — our single biggest
ergonomics lead.

What their 488 stars are actually built on: **20 translated READMEs** in a language bar,
an honest `## Real Limits` plus a 14 KB `KNOWN_ISSUES.md`, a big legible number with
receipts, three-command install with `--doctor`, and four client on-ramps each with its own
README section. We inherited all of it.

Their survey value was as a diff target — it surfaced the three regressions in §3.

### 1.5 `Adam-Duchemann/veracut` — the cautionary twin

278 tools, one squashed commit, dead since 2026-07-06. Same honesty thesis, same upstream.
**Zero new capability** (the only name we lack is `import_ae_comps`, a dead stub we have a
regression test pinning out). Prompts and resources byte-identical to ours.

**Their honesty is prose, not machinery.** No `verified` field in their `MCPTool` type, no
test gating registration; `KNOWN_ISSUES.md` is hand-written and validated by nothing. Their
read-back pattern reached **2 of ~183** working tools; we have 239 `verified` sites.
And they have a hole in their own thesis: **[CODE]** `src/tools/expanded.ts:816-830` — 14
tools, including the *write* operation `capture_frame`, return
`{available:true, note:"Read operation completed; this Premiere DOM surface exposes limited
details in ExtendScript."}` with no payload. I audited ours for the same shape: **zero.**

Their last commit message was *"README: market the honest-execution contract."* The lesson
is the whole repo: **their marketing outran their code, and 0 stars in six weeks says a good
README does not win.**

Worth taking: their sweep report already records **skip reasons**
(`'intentionally skipped because it mutates or saves the active project'`) and **nothing
consumes it** — the unclaimed move in the field is to make a live-sweep report the source of
truth behind `get_capabilities`, so honesty becomes *measured* rather than asserted. Also
their `PREMIERE_MATCH_SOURCE_EPR` env override + bounded `.epr` glob, which makes
`export_sequence` zero-config; and negative assertions in the live smoke test (two of five
checks assert a tool *fails honestly*).

### 1.6 The small Premiere servers

- **`MarkelAnthony/uxpplugin-mcpconnector-premierepro`** — 26 tools, and **the best tool
  descriptions in the field.** They do not describe the API; they steer away from silent
  failure and route to siblings. **[CODE]** `mcp-server/index.js:167`: *"**RECOMMENDED over
  create_sequence**… Sequences created with plain create_sequence can end up with mismatched
  settings, which causes scripted edits to **silently fail without any error**."* Plus
  reliability tiers in the description (`apply_effect` — *"EXPERIMENTAL… the tool most likely
  to need debugging"*), version gates (*"requires Premiere 26.3 or newer — on older versions
  it will fail with a clear error rather than working incorrectly"*), and pre-empted wrong
  mental models (`move_clip` — *"moving a clip's video does NOT move its audio counterpart.
  Call this twice."*). Two real gaps for us: **`add_clip_auto_track`** (places on the first
  track *actually free* for the range, with proper interval intersection, returning the
  chosen index) and **inline image `capture_frame`** with a 10 × 300 ms flush-retry loop
  *because Premiere reports export success before the file lands.* Their
  `place_clips_sequentially` measure-then-correct trick is instructive: trimmed clips are
  placed in a scratch area at t=100000s, then `getStartTime()` is re-read and a
  `createMoveAction` shifts them into position — because Premiere's trim API shifts the
  timeline position. Also: every mutation goes through `executeTransaction` with
  **human-readable labels** (`"MCP: Move trimmed clip into final position"`), so the user's
  native Cmd-Z stack stays legible after agent edits. ⚠️ They leak an undeleted
  `__temp_image_convert__*` sequence per call.
- **`nepfaff/premiere-pro-mcp`** — 3 tools, one strategic idea: `execute-script` evals
  against the **native async `premierepro` module**, not ExtendScript
  (`src/plugin/main.js:116`). **We have no path at all to the modern async API** — our UXP
  bridge only tunnels ExtendScript and our validator blocks `eval`/`require`. Worth porting
  as a *separate* `execute_uxp_script` with its own validator, paired with their `get-help`
  cheatsheet (a raw-script tool is unusable without one).
- **`Siddhant704/premiere-pro-mcp`** — 23 tools; two trivial gaps worth taking
  (**`append_clip`** — we have no append verb at all, so an agent must read structure, find
  max end, then overwrite; and **`clear_markers`** — we have 20+ marker tools but only
  singular delete). ⚠️ **Cautionary:** their `list_video_effects` is **fake**, returning a
  hardcoded 10-name array with the comment *"We instead search a small built-in list of
  common effect match-names."* Exactly the dishonesty our positioning attacks. I verified
  ours is a real QE enumeration (`qe.project.getVideoEffectList()`,
  `src/tools/index.ts:16469`).

### 1.7 Adjacent Adobe MCPs — and why the popular ones are popular

- **`mikechambers/adb-mcp` (686★)** — 95 tools across 5 servers, but wildly uneven:
  Premiere 26, Photoshop 62, Illustrator 5, After Effects **1**, InDesign **1**. Its
  philosophy is stated: *"the approach has been to provide lower level tools to give the AI
  the basics to do more complex stuff."* **686 stars on 26 Premiere primitives.** What it
  actually does well: `get_sequence_frame_image` returns an **inline MCP Image** plus the
  status dict; a `config://get_instructions` resource that is a persona + ordering law +
  canonical recipe + gotcha list; a declarative precondition table
  (`uxp/pr/commands/index.js:115-129`); payload truncation as policy
  (`FONT_LIMIT = 1000 # max number of font names to return to AI`); and **the lowest install
  friction in the field** — `uv run mcp install` one-liners, DXT/MCPB bundles, prebuilt
  per-platform proxy binaries, full Windows parity. **Zero MCP prompts.**
- **`Dakkshin/after-effects-mcp` (569★)** — **13 tools.** The README's tool table lists
  eight tools that **are not registered**, and one (`createNullObject`) is not even in the
  `run-script` allowlist, so it is unreachable. `apply-effect` is registered twice under two
  names. Its shipped `.mcp.json` contains a hardcoded foreign path
  `C:\Users\Daniel\Downloads\...`. Last commit 2026-04-01. One good idea:
  `apply-effect-template` supports an `{effects: [...]}` **chain** (`cinematic-look` =
  Curves + Vibrance), i.e. named look packs.

**The evidenced conclusion about both star leaders: distribution and demos beat features.**
Neither has prompts + resources + profiles + undo the way we do; both are far more popular.
Dakkshin's drivers are category monopoly (it *was* the AE MCP), the persistent-listener demo
UX, and discovery channels — a glama.ai badge and an embedded star-history chart.
adb-mcp's are author reach (a long-time Adobe developer-relations figure), a **YouTube
playlist** rather than a screenshot, Claude driving Photoshop's *Firefly* features (an
inherently viral demo on a far larger audience), and five Adobe app names capturing search
traffic the 1-tool servers do not deserve. **Our honesty moat is right but insufficient on
its own** — it needs a video, an `llms.txt`, and a one-command install to convert.

- **`alisaitteke/photoshop-mcp`** — 102 tools, and **the best ergonomics engineering in the
  survey.** Three things to steal outright:
  1. **`suspendHistory` as a transaction boundary** plus a result field
     **`undo_history_states_consumed`** — a machine-readable promise about exactly how much
     rollback one undo buys. Nothing in our 638 tools tells the model how many `undo` calls
     reverse what it just did.
  2. **A retrofit error-envelope wrapper.** `src/errors/envelope.ts` is a closed union of 17
     codes plus an **ordered regex table** mapping raw error text →
     `{code, suggested_next_tool}`, and `enrichErrorResult` **re-classifies legacy prose
     errors without editing those handlers.** ~150 lines gives a uniform error contract
     across a large surface. On the success path `atomicSuccess()` defaults
     `next_suggested_tool = 'photoshop_get_preview'`, nudging verify-after-mutate.
  3. **`verify-photoshop-prompt-coverage.ts`** — 148 lines of `node:assert` run pre-PR that
     asserts exact counts, bidirectional recipe↔prompt parity, *and* that the `instructions`
     string still contains 17 required substrings. You cannot delete a tool or gut the
     guidance blob without CI screaming.

  Their 6-part description grammar is worth adopting (*what · "Users often say" · Use when ·
  Do NOT use when · Returns · Preconditions + Side effects*), and their **triage policy is
  right for us**: only 51/102 tools have `Use when:` — they upgraded only the tools an agent
  must *choose between* and let leaf mutators stay terse. Note they have **zero MCP
  resources** and **zero annotations**; we beat them on both.

### 1.8 After Effects MCPs — three ideas we should take

- **`kumoproductions/mcp-aftereffects`** — 11 MCP tools fronting **198 registered
  operations**. Two standouts. **`ae_catalog` is a policy-filtered discovery tool**, with the
  rationale stated: *"The catalog must never advertise something `ae_do` will refuse,"*
  because *"a model that plans against a filtered-out operation wastes a round trip and,
  worse, may conclude the server is broken rather than restricted."* And a **13-code error
  union** (`AE_NOT_FOUND, TIMEOUT, TRANSPORT, JSX_THROW, OPERATION_FAILED,
  UNKNOWN_OPERATION, FORBIDDEN, …`) with an explicit `RETRYABLE` set, returned as
  `structuredContent` — *"the model can branch on `code` instead of pattern-matching prose"*
  — and `FORBIDDEN` deliberately distinguished from `UNKNOWN_OPERATION` so a disabled feature
  does not read as a typo. Also **"operation twins"**: `comp.info` / `render.frame` exist as
  *operations* purely so mutate→render→re-inspect is one round trip.
- **`JUNKDOGE-JOE/after-effects-mcp`** — dynamic `instructions` that append the *live* tool
  list so they cannot drift; an error→hint regex table; `.aep` checkpoints with
  branch-before-revert; and a single `VERB_ANNOTATIONS` table shared by the tool schemas
  *and* the approval gate *"so panel and client policy classifications cannot drift."*
  (Its repo description claims "30 ae.* tools" and the README lists two that do not exist.)
- **`Engine-Room-Games/after-effects-mcp`** — the only one exposing **both** prompts and
  resources, with the reasoning written down: *"the condensed core goes out in
  `instructions`, which some clients drop on the floor; the full text is exposed as
  resources, which fewer clients support still. Tools are the one thing every MCP client can
  reach"* — so they ship all three. Plus `run_batch` with **`transactional: true` rolling
  back on first error**, real `notifications/progress` for long jobs, a panel version-skew
  gate, and a **persistent issue journal** in `.ae-mcp/` beside the project.

### 1.9 The paid non-MCP tools — what editors actually buy

Two corrections to the brief: there is no `excaliburtools.com` and no vendor "Sherwood"
(Excalibur is by **Knights of the Editing Table**), and **Watchtower is not a QC tool** —
it is a watch-folder/bin-sync extension from the same vendor. The real QC products are
**Sequence Inspector** and **Blackspot**.

**The single most valuable find in this section is Excalibur's own Limitations page** **[DOC]**,
on why apply-preset is the biggest API gap:

> *"When applying video preset with Lumetri Color, color wheels, curves, anything that has
> some kind of graphic interface, **will be set to default**"* … *"influence… for all bezier
> keyframes **will be set to `16.6%`**"*

That is **independent third-party confirmation of the keyframe-ease defect our
`bake_keyframe_ease` exists to fix** — a shipping $120 product ships a known-wrong ease.
And **[DOC]** FireCut's docs concede *"This is a Premiere Pro issue and can happen if you
make too many cuts (i.e. typically **500+ cuts**)… the number of clips on your timeline
increases as cuts are made, slowing down Premiere Pro"* — so our `detect_silence` should
return `estimatedCuts` and warn. Two free credibility wins, both quotable.

Capability ideas worth exposing as tools: `increment_and_save` / `version_up_sequence`
(Excalibur's most-praised commands); relative arithmetic on clip properties; **`sync_bins_to_folders(dryRun)`**
and `refresh_image_sequence` (Watchtower — the latter fixes a real Premiere defect,
directly relevant to VFX render-watch); silence removal split into
`detect_silence` → `apply_silence_edit` with a disposition enum
(*remove / keep / mute / remove-but-keep-spaces*) and J/L-cut offsets; loudness-based
**multicam auto-switching** that emits an *editable* sequence, never a flatten (AutoCut's
own framing: *"AutoCut leaves your original footage untouched and creates a multicam
sequence above the timeline"*); filler-word detection with **`markOnly` as the default**;
and `generate_punch_ins` with correct easing.

The load-bearing API fact, from FireCut's docs: **animated/styled captions are not
achievable via Premiere's caption API** — every vendor renders PNGs externally and inserts
them on a video track. Say that plainly rather than fudging it.

**And the strategic observation:** FireCut hand-built a closed GUI chaining engine
("Workflows") and had to create *"auto variants"* of every feature *"to ensure a workflow
runs smoothly without interruptions."* **An MCP *is* the workflow engine, for free, with
branching and natural-language authoring.** The one thing to copy is their **automatic
per-step sequence checkpointing into a dedicated bin**. The "auto variants" lesson is our
tool-design rule: every tool headless and parameterized, never dialog-driven.

The QC split that should shape `lint_timeline`: structural defects (gaps, non-opaque stacks,
exposed edges, offline, frame-rate mismatch) are **ExtendScript-only and cheap**; pixel and
waveform defects (true black, freezes, dropouts, clipping, OCR) need **ffmpeg on media
paths**, which we already have. Blackspot's honesty line is worth copying verbatim into tool
descriptions: **[DOC]** *"'Will it flag things that are actually fine?' → **Sometimes, by
design. Flags are candidates, not verdicts.**"* Note Sequence Inspector shipped
2026-07-23 at $19.99 — the QC niche is one month old and not locked up.

Also relevant: **MATE for Premiere** ($199) is an MCP **client** inside Premiere, not a
server. It is complementary, and an editor could plausibly point it at our server.

### 1.10 DaVinci Resolve — the workflow ideas Premiere MCPs lack

Resolve's scripting API exposes whole categories Premiere's does not, and
`samuelgursky/davinci-resolve-mcp` (**2.3k★**) is further along on honesty tooling than we
are. It ships 36 grouped tools by default and **353 granular ones behind `--full`** — an
answer to the same problem we have. It also has **14 MCP prompts and resources**, and:

- **`edit_engine`, whose stated contract is *"Every loop is plan → confirm → execute"*** —
  `plan_selects`/`execute_selects`, `plan_tighten`/`execute_tighten` (dead-air lifts from
  transcript-gap *evidence*, returning `audio_accounting` + `structural_diff`).
- **`timeline_versioning`** — `begin_run`/`end_run` threading N destructive calls into **one**
  archive, `diff_timelines`, `rollback`.
- **`resolve_control action="api_truth"`** — a per-build ledger of what the API actually
  does, e.g. a comp that *"rendered on Studio 19.1.3.7 (2026-08-02), but on Studio 21.0.4 …
  delivered renders bit-identical to the no-comp baseline (2026-08-20)."*
- A **"WYSIWYG PROOF RULE"**: a grabbed still or rendered frame is the ONLY acceptable
  visual evidence for a grade claim, because thumbnails decode source media.
- Token-budget caps (`set_caps_preset minimal|standard|generous|unlimited`, `CAPS_REFUSAL`).

`wassermanproductions/unofficial-davinci-mcp` adds a **tier system** (`tier="both"` works on
free Resolve because the work happens in Python/ffmpeg and lands as an interchange file) and
the rule **"every mutating tool defaults to `dry_run=true` and returns a plan; re-run with
`dry_run=false` and `confirm=true`."**

Premiere-feasible ports, in value order: **timeline CSV/TSV/ALE/OTIO export** (Premiere has
*none* — and it is pure DOM-walk + our own serializer, zero API risk, which the tool
description must say); `bulk_match_grade_to_hero` with a confirm token;
`bake_lut_from_reference` (offline numpy/ffmpeg, then `apply_lut` — adds a capability
Premiere lacks); `begin_run`/`end_run`/`rollback_sequence` over our existing checkpoints; a
`knowledge` tool (both leading Resolve MCPs converged on this independently, and it needs no
Premiere connection); `inspect_epr` to make opaque presets legible; and
`contact_sheet_sequence` returning MCP image content.

**Two places Premiere is ahead and every Resolve MCP lacks — market these:**
`projectItem.createSmartBin(name, queryString)` (Resolve's scripting API has **no**
smart-bin call), and **Adobe Media Encoder as a separate render host** (Resolve renders only
what is in a Resolve timeline).

Where Premiere cannot follow, and we should say so rather than fudge: no headless mode, no
node graph, no per-clip grade versions, **no audio auto-sync/merge clips**, and **no in-app
AI surface whatsoever** — no transcription, speaker detection, face ID, magic mask or TTS.

---

## 2. What to steal, ranked by value ÷ effort

| # | Idea | From | Effort | Status |
|---|---|---|---|---|
| 1 | **Plan → preview → apply with a SHA-256 confirmation token** | leancoderkavy, samuelgursky, wasserman | M | **open — biggest gap** |
| 2 | **Inline `{type:"image"}` content blocks on frame capture** | CaYatur, MarkelAnthony, adb-mcp (3 independent) | S | **open** |
| 3 | **`find_tool` — search the catalogue** | nobody has it | S | ✅ **shipped** |
| 4 | **MCP tool annotations** (4 hints + title) | leancoderkavy, **Adobe's own server** | S | ✅ **shipped** |
| 5 | **Measure + publish the catalogue's context cost** | nobody has it | S | ✅ **shipped** |
| 6 | **CI parity-lint: tools ↔ prompts ↔ instructions ↔ README** | leancoderkavy, alisaitteke | S | ✅ **shipped** |
| 7 | **Prompts as tool chains, not essays** | leancoderkavy, ayushozha | S | ✅ **shipped** |
| 8 | **`instructions` on `initialize`**, not only a resource | adb-mcp, alisaitteke, Engine-Room | S | ✅ **shipped** |
| 9 | **Retrofit error envelope**: code union + `retryable` + `hint` + `suggested_next_tool`, applied by one wrapper | alisaitteke, kumoproductions, CaYatur | M | open |
| 10 | **`expected_*` stale-state preconditions** on mutating tools | leancoderkavy (19 params) | M | open |
| 11 | **Fail-and-rollback CI harness** — run our ExtendScript in `vm` against a fake DOM, assert mutations *fail* when Premiere silently ignores them | ayushozha | M | open |
| 12 | **`execute_menu_command` / `find_menu_command`** — we already have the private helper | ayushozha | S | open |
| 13 | **`show_confirm_dialog`** — a real in-Premiere human gate; nobody in Premiere-land has it | ayushozha | S | open |
| 14 | **`get_effect_parameter_range`** (`param.minValue`/`maxValue`) — kills a top LLM failure mode | ayushozha | S | open |
| 15 | **Resumable batch envelope** (`clipFrom`/`hasMore`/`nextClipFrom`) + per-item partial success | CaYatur | S | open |
| 16 | **`undo_steps_consumed`** on every mutation | alisaitteke | S | open |
| 17 | **Deny-by-default `unsafe` tool class** + profile-conformance tests | ayushozha | S | open |
| 18 | **Paginate `tools/list`** | ayushozha, Adobe's own server | S | open |
| 19 | **Timeline CSV/TSV/ALE/OTIO export** — Premiere has none at all | Resolve | M | open |
| 20 | **`append_clip`, `clear_markers`, `checkpoint_delete`, `add_clip_auto_track`** | Siddhant, CaYatur, MarkelAnthony | S | open |
| 21 | **Mutation labels on undo groups** so the user's Cmd-Z stack stays legible | MarkelAnthony | S | open |
| 22 | **Description grammar + sibling routing**, applied only to tools an agent must choose between | MarkelAnthony, alisaitteke, Adobe Illustrator | M | open |
| 23 | **Claims registry with a mandatory `boundary` field**, CI-tested | leancoderkavy | M | open |
| 24 | **Make a live-sweep report the source of truth behind `get_capabilities`** | veracut left it open | M | open |
| 25 | **`execute_uxp_script` against the native async API**, separate validator | nepfaff | M | open |

---

## 3. What we already do better

All verified against the cloned competitors.

1. **MCP resources: 13.** Against 14 (leancoderkavy), 5 (ayushozha), 1 (Dakkshin), 1
   per-server (adb-mcp), and **zero** for CaYatur, MarkelAnthony, nepfaff, Siddhant and
   alisaitteke.
2. **Tool curation.** `profiles.ts` — named profiles plus `PREMIERE_MCP_TOOLS` allowlist and
   `PREMIERE_MCP_EXCLUDE`, reported through `get_capabilities` as
   `{source, name, available, excluded, unknownPatterns}`. ayushozha's is architecturally
   the same but documents itself in a static text file; leancoderkavy's is a *security*
   model, not a context-budget one. **Every other repo surveyed has no runtime gating at
   all.**
3. **Recovery we can actually restore.** `create_recovery_checkpoint` +
   `list_recovery_checkpoints` + **`restore_recovery_checkpoint`**, plus `undo`/`redo`/
   `multiple_undo`. leancoderkavy declares `automaticRestoreSupported: false`; CaYatur has
   checkpoints but **no undo tool at all**; nobody else has either.
4. **Verification breadth.** 239 `verified` sites. veracut — same thesis, same upstream —
   reached 2 of ~183.
5. **Description quality.** Mean 144 / median 111 chars against leancoderkavy's 106 / 80,
   and our `expanded-schemas.ts` closed upstream's 171-tool `z.record(z.any())` hole that
   veracut still carries.
6. **Catalogue breadth is real.** 638 tools against 361 max (leancoderkavy), 277 (CaYatur),
   283 (upstream), 72 exposed (ayushozha), 26 (adb-mcp Premiere), 36 (Adobe's own).
7. **Cross-platform.** macOS + Windows installers and doctors both. CaYatur is hard
   Windows-only; nepfaff is macOS-only; Siddhant and MarkelAnthony are Windows-first.
8. **No hollow returns.** I audited for veracut's `{available:true, note:"…"}` shape and
   Siddhant's hardcoded fake effect list. **Zero of either.** Our
   `list_available_effects` is a real `qe.project.getVideoEffectList()` enumeration.

### And what the survey found wrong with *us*

Four defects in agent-facing text and packaging, all now fixed (commits `084ae2e`, `6ec745c`):

1. **Our plugin manifests installed upstream's server.** Both `.mcp.json` files read
   `npx -y adobe-premiere-pro-mcp@latest`. Anyone installing our Claude Code or Codex plugin
   silently got upstream's 283-tool build, and the manifests still credited hetpatel-11.
2. **`get_instructions` recommended two tools that have never existed** —
   `export_with_custom_preset` and `track_matte_setup` — and the second was the suggested
   *alternative* inside the "what this server CANNOT do" section.
3. **Three different wrong tool counts published at once:** README 309, `get_instructions`
   600, `package.json` 283+, actual 637.
4. **`get_instructions` hid composite tools we ship.** `grep clipPlan src/resources` → 0,
   against 15 real schema references. We had dropped upstream's own guidance.

Also: our **10 MCP prompts were byte-identical to upstream** (`diff` → 0 lines) and named
**none** of our tools, and `doctor-macos.sh` had relaxed upstream's `PREMIERE_TEMP_DIR`
assertion — a known silent-bridge-failure mode our doctor was passing.

---

## 4. The 637-tool problem — the plain answer

**Our tool count is a liability, and until today we were neither mitigating it nor admitting
it. [MEASURED] on this machine:**

| Profile | Tools | Payload | Est. tokens | % of a 200k context |
|---|---|---|---|---|
| `all` (the default) | 638 | 408 KB | **~102,000** | **~51%** |
| `core` | 64 | — | ~14,600 | ~7.3% |

Half a context window consumed before the conversation starts. Against published guidance:

- **[DOC] Anthropic:** *"Claude's ability to pick the right tool degrades once you exceed
  **30–50** available tools."* Their Tool Search measurements: **Opus 4 49% → 74%**,
  **Opus 4.5 79.5% → 88.1%** on large libraries once tools are searched rather than loaded.
- **[DOC] MCP client best practices:** *"Loading every tool definition into the model's
  context window upfront wastes tokens, increases latency, and **degrades model
  performance**"*, recommending a defer threshold of **1–5%** of the window. Claude Code's
  own `ENABLE_TOOL_SEARCH=auto` defers everything at **10%**. We are at 51%.
- **[DOC] VS Code / Copilot:** *"A chat request can have a **maximum of 128 tools enabled at
  a time**."* **Our default profile cannot work there at all.**
- **[DOC] OpenAI:** *"Aim for fewer than 20 functions available at the start of a turn."*
- **[DOC] Anthropic, on the named #1 failure mode:** *"bloated tool sets that cover too much
  functionality or lead to ambiguous decision points about which tool to use. If a human
  engineer can't definitively say which tool should be used in a given situation, an AI agent
  can't be expected to do better."* We have textbook instances: `set_clip_scale` /
  `set_uniform_scale` / `set_scale_to_frame_size` / `set_scale_width_height`.
- **[DOC] LongFuncEval (arXiv:2505.10570):** *"we observe a performance drop of **7% to 85%**
  as the number of tools increases."* **[DOC] RAG-MCP (arXiv:2505.03275):** retrieval
  *"more than triples tool selection accuracy (43.13% vs 13.62%)"*, with success above 90%
  below position ~30. **[DOC] LiveMCPBench (arXiv:2508.01780):** across 527 tools,
  *"retrieval errors account for nearly half of all failures, highlighting retrieval as the
  dominant bottleneck."*
- One **honesty flag:** Anthropic's 49→74% figures come from unpublished *"MCP
  evaluations"*; they never name a public benchmark. Do not attribute them to MCP Atlas.
  And **[DOC]** BFCL V4 explicitly found *"no consistent performance trends"* from prompt
  variation — the widely-circulated "distractor tools cost 1–8%" numbers have no primary
  source and should not be cited.

### The recommendation

**Retrieval, not consolidation, is the first move** — because half of large-catalogue
failures are retrieval failures, and because consolidating 638 verified tools into verb
buckets would throw away our actual lead.

Done today:

1. **`find_tool`** — searches names and descriptions, no host call, always exposed even
   under the tightest profile, and reports profile-hidden matches as `exposed: false` rather
   than dropping them. This is the sanctioned mitigation and **no competitor has it.**
2. **The server measures and publishes its own cost** — `get_capabilities.contextCost`
   plus a one-line stderr advisory at startup naming the number, the Copilot limit, and how
   to curate. A server that refuses to fake a successful edit should not fake a comfortable
   tool budget.
3. **Better failure on a bad name** — a ranked `didYouMean` shortlist and an explicit
   `existsButHiddenByProfile` flag, instead of dumping 638 names.

Still owed, in order:

4. **Change the default profile.** `all` is the wrong default and the evidence is not close.
   `core` is 64 tools at 7.3% of context. This is a user-visible behaviour change, so it is
   flagged rather than done unilaterally — **but the honest reading is that shipping 638
   tools by default is a bug, not a feature.** Recommended: default to `core`, keep
   `PREMIERE_MCP_PROFILE=all` for power users, and say so in the README.
5. **Paginate `tools/list`** (ayushozha does, at 100; so does Adobe's own server).
6. **Deduplicate the overlap clusters** — the four `*scale*` tools are one tool with a mode
   parameter, and there are more. This is the only genuine *consolidation* work worth doing.
7. **`anthropic/alwaysLoad: true`** in `_meta` on 3–5 hot tools
   (`verify_premiere_connection`, `get_full_sequence_info`, `find_tool`) so deferring clients
   keep the entry points resident.
8. **A `response_format: concise|detailed` enum** on the heavy `get_*` readers, and
   `anthropic/maxResultSizeChars` on the big list-returners. adb-mcp's
   `FONT_LIMIT = 1000 # max number of font names to return to AI` is the same instinct.
9. **Profile-conformance tests** (ayushozha's pattern) so an unverified tool cannot leak
   into a named profile.

**One thing to *not* over-apologise for:** Claude Code defers MCP tools by default and
states no per-server cap, so its users are largely unaffected today. The exposure is
non-Claude hosts, and it is real: Copilot rejects our default profile outright.

---

## 5. Verdict — are we feature-ahead?

**On breadth and verification, clearly yes. On agent ergonomics, no — and that is where the
competition actually is.**

- **We are ahead on** catalogue breadth (638 vs 361 next-largest), verification density
  (239 `verified` sites vs veracut's ~10 on the same thesis), resources, runtime tool
  curation, restorable recovery, description quality, cross-platform install, and — now —
  catalogue search, which nobody else has.
- **We are behind on** the plan/preview/apply pattern with confirmation tokens (12 tools at
  leancoderkavy, the same shape independently at two Resolve MCPs, **zero at us**), stale-state
  preconditions, structured error codes with next-step routing, inline image content blocks
  (three repos have them, we return a path), and generated-and-CI-diffed published claims.
- **`leancoderkavy` remains the only Premiere server genuinely ahead of us**, and now on
  features as well as architecture: preview/apply, `expected_*` guards, a generated action
  catalogue, and a claims registry with a mandatory `boundary` field. They are also *behind*
  us on restore, undo, description quality, and a schema mapper that silently drops all their
  numeric bounds. **`CaYatur` is the second real rival** and the brief under-rated it: their
  playbook/intent tier is the best composite design in the field, and their "what's actually
  tested" README section is our own stance published more specifically than we publish it.
- **The star leaders are not the feature leaders.** adb-mcp has 686 stars on 26 Premiere
  primitives and zero prompts; Dakkshin has 569 on 13 tools with a README that lists eight
  that do not exist. Distribution and demos beat features in this niche, and the corollary is
  uncomfortable: our depth will not win on its own.
- **And the honesty stance is no longer differentiating by itself.** samuelgursky ships a
  per-build `api_truth` ledger; kumoproductions ships policy-filtered discovery and a
  `FORBIDDEN`-vs-`UNKNOWN` distinction; ayushozha ships a written promotion gate that
  explicitly refuses to call anything live-certified; CaYatur publishes a four-tier tested
  table; Blackspot ships *"flags are candidates, not verdicts."* **The moat has to be depth
  and rigour of execution, not the stance.**

**The reframe that matters most.** Adobe ships a native MCP server in the build on this
machine — 36 tools, annotations, resources, subscriptions, `getToolTypings`, and a UXP path
for third parties to **register into it**. Our bridge is legacy on a clock we do not control.
What survives that transition is exactly the layer this document is about: verified
primitives, render-truth, the honest wall, lint, recovery, and the ffmpeg escape hatches
Adobe's 36 tools do not have. **Invest above the transport — and evaluate registering into
Adobe's server rather than competing with it.**

---

## Appendix: measurement method

**[MEASURED]** figures in §4 come from serializing the exact `tools/list` payload — name,
description, `z.toJSONSchema(...)` and annotations per tool — and dividing characters by 4
for an order-of-magnitude token estimate. The code is `measureCatalogueCost()` in
`src/tools/index.ts` and `describeCatalogueCost()` in `src/tools/catalogue-cost.ts`, so the
number is reproducible via `get_capabilities` and is recomputed rather than recorded. It is
an estimate, not a tokenizer, and is labelled as such everywhere it is reported.

**[BINARY]** figures in §0 come from `strings` over
`/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026`
(`CFBundleShortVersionString` 26.3.2) and from reading
`Contents/Settings/EveScripts/AgentsPrefsPanel.adam.eve`. The 36 tool names were extracted
from Itanium-mangled RTTI symbols matching `mcp::*Tool`. **No Premiere process was started
and no bridge call was made** — the live host was off-limits for this survey.
