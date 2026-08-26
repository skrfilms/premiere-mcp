# Agent ergonomics: succeeding on the first try

This server is judged by one thing: how quickly an agent that has never seen it gets a
**correct, verified** edit. Not tool count. An unfamiliar agent handed a huge undifferentiated
catalogue guesses a tool name, calls it with the wrong units, and reports success it never
checked. Everything in this document exists to make that outcome harder to reach than the
correct one.

Three surfaces do the work, and they are deliberately wired to each other:

| surface | question it answers | where it lives |
|---|---|---|
| **task bundles** | which tools do I need for *this* job, including the ones that prove it worked | `src/tools/profiles.ts` (`TASK_BUNDLES`) |
| **recipes** | what do I need to know before acting, so my first call is not the one that fails | `src/resources/index.ts` (`premiere://recipes/*`) |
| **prompts** | in what order, and what do I do when it goes wrong | `src/prompts/index.ts` |

No number in this document is written by hand except where a test re-measures it — see
[Invariants](#invariants-that-keep-this-honest). For anything live, call `get_capabilities`.

---

## The first 90 seconds

The shortest path from "connected" to "one verified edit I can report". Read
`premiere://recipes/first-90-seconds` for the full version; this is the call sequence.

```
 1. ping                          bridge alive?      (timeout => the CEP panel is not running)
 2. get_capabilities              this build's real tool count, active profile, local backends
 3. verify_premiere_connection    engine alive?      (ping can pass while script no longer runs)
 4. get_project_info              is a project open at all
 5. list_sequences                → carry the sequence ID, not the name
 6. get_active_sequence
 7. get_timeline_summary          tracks, clips, duration in one round trip
 8. check_offline_media           offline media fails later in ways that look like tool bugs
 9. add_marker                    THE EDIT — cheapest real mutation: no media, no render
10. list_markers                  THE VERIFICATION — compare name/time/type against step 9
11. delete_marker (or undo)       leave the project as you found it
```

Then report: bridge live, engine live, project, sequence + ID, "marker written and read back
at 1s, then removed". That report is the deliverable — a claim that was actually checked.

Cheapest selection for this path: `PREMIERE_MCP_PROFILE=task-orient`.

Branches:

- step 9 returns `verified:false` → `premiere://recipes/verify-or-refuse`, and do **not** start
  the user's real task yet.
- step 1 or 3 times out or hangs → `premiere://recipes/recovery-first`. Most likely a modal
  dialog: **the bridge cannot advance a dialog**, and a human must press Escape.
- the tool you want is not in your list → `find_tool` → `get_tool_typings` → `call_tool`.
  Curation hides nothing; `find_tool` reports a hidden match as `exposed:false` *with the
  reason*.

---

## Task bundles

The old profiles (`core`, `read-only`, `audio`, `color`) are **size-shaped**: cross-sections of
the catalogue chosen by how big a menu a client can afford. An editor's request is
**task-shaped** — "cut this dialogue", "conform and deliver", "caption this", "grade these
shots", "build a rough cut". A bundle is the tool set for one such task, and it includes:

1. the orientation reads that must happen before the first mutation,
2. the mutating tools,
3. **the verification tools that close the loop**,
4. the recovery path (checkpoint / restore / undo).

> A bundle whose first call forces a profile switch is a failed bundle. That mistake shipped
> once: `apply_effect` was in `core` without `set_effect_property`, so an agent could add
> Gaussian Blur and then had no way to set its blurriness. The pairing rules that prevent it
> are `BUNDLE_REQUIREMENTS`, enforced across **every** profile.

Measured cost is the advertised list — the bundle plus the always-kept discovery/routing tools
— as an estimated token count (chars/4, the same estimate `get_capabilities` publishes) and its
share of a 200k context window. Every bundle sits under the ~50-tool mark where Anthropic
reports selection accuracy degrading, and far under Copilot's hard 128 ceiling.

<!-- BUNDLE-TABLE: re-measured against BUNDLE_BUDGETS by src/__tests__/tools/task-bundles.test.ts -->

| bundle | the request it answers | advertised tools | est. tokens |
|---|---|---|---|
| `task-orient` | connect, orient, make one small verified edit | 26 | 4757 |
| `task-rough-cut` | build a rough cut from a folder of footage | 48 | 10961 |
| `task-cut-dialogue` | cut dialogue: silence, trims, audio smoothing | 50 | 9401 |
| `task-caption` | caption a sequence and prove the track landed | 35 | 8475 |
| `task-grade` | grade shots numerically, read back, propagate | 50 | 10364 |
| `task-motion` | animate clips and dial in effects | 50 | 10768 |
| `task-conform-deliver` | conform, QC, export, verify the file | 50 | 9983 |
| `task-review-notes` | notes ⇄ markers round trip, review reel | 38 | 7664 |
| `core` | the everyday editorial default (size-shaped) | 104 | 21645 |

Select one with `PREMIERE_MCP_PROFILE=<bundle>`. Every bundle is a **cost** curation, so
`call_tool` still reaches the whole catalogue and `activate_tools` promotes a tool into the
advertised list mid-session. Only `read-only`, an exact `PREMIERE_MCP_TOOLS` allowlist, and any
`PREMIERE_MCP_EXCLUDE` veto are **authority** boundaries the router refuses to cross.

Two composition rules worth knowing before adding a bundle:

- **Exact tool names, no globs.** A glob makes a bundle's size — and therefore its measured
  cost — a function of the catalogue rather than of a decision.
- **Nothing known-broken on the verified host build.** A bundle is a recommendation, and
  recommending `audio_crossfade_at_cut` ("Invalid parameter" on 26.3.2) or `match_shot_color`
  (a suspected engine killer that was never cleared) spends an agent's first call on a known
  failure. They stay in the catalogue, findable and callable; they are not what a fresh agent
  is handed first. A test enforces this.

---

## Recipes

Static text, no host request, readable when the bridge is down — which is the point for the
recovery one. Each exists because a specific failure was paid for on a live host and written up.
The bar is *prevents a named failure*, not *sounds like good advice*.

| recipe | the failure it prevents |
|---|---|
| `premiere://recipes/first-90-seconds` | Starting with the user's real edit, then being unable to tell a dead bridge from a bad argument. Also: treating a write's own response as proof. |
| `premiere://recipes/verify-or-refuse` | Reporting `success:true, verified:false` as done. Names the independent check per edit type, and the two traps that make a readback agree with you no matter what. |
| `premiere://recipes/effect-match-names` | Guessing an `AE.`-prefixed matchName, or applying an effect and having no way to set its value. Carries the four verified matchNames and the apply → set → read pattern. |
| `premiere://recipes/time-units` | `Sequence.end` is a **ticks** string while `Sequence.getInPoint()` is a **seconds** string — same type, different unit. Reading `.ticks` off either yields the literal text `undefined`. This silently broke nine tools, three of which reported `verified:true`. Also: `setInPoint` units depend on argument *type*, so a stringified seconds value zeroes the point. |
| `premiere://recipes/qe-fragility` | Calling a QE property that is **fatal to the script** (`setBorderWidth`, `reverse` — note `reversed` is safe), and believing a `try/catch` protects you when the failure is beneath the language. Plus the measured ES3 present/absent table. |
| `premiere://recipes/recovery-first` | Retrying into a modal dialog forever. Distinguishes dialog-blocked / engine-dead / panel-absent, and says plainly that no tool here can advance a dialog and that a relaunch must reopen the *project* (Premiere's Home screen never loads the panel). |
| `premiere://recipes/honest-wall` | Burning calls on something the API cannot express. Every entry names a route out — a wall entry without an alternative just moves the dead end. |
| `premiere://recipes/task-bundles` | Assuming a missing tool means a missing capability. Generated from the live profile table. |

`premiere://config/get_instructions` (also delivered unconditionally in the `initialize`
response) links all of them, so a client that reads nothing else still learns they exist.

---

## Prompts

Each prompt is a tool chain, not an essay: ordered steps, the exact tools per step, the
workflow's real limits, and a shared contract. Every prompt now declares the bundle it was
composed against, and a test asserts its **first step is fully covered by that bundle**.

Prompts added for the paths that were undocumented:

- **`first_verified_edit`** — the 90-seconds path as a prompt. Onboarding had existed only as
  the sentence "orient before editing", which names no calls and no proof.
- **`recover_from_failure`** — classify (dialog / dead engine / refusal), check independently,
  roll back, report. The default behaviour it replaces is retry-then-claim-success.
- **`conform_and_deliver`**, **`caption_sequence`**, **`animate_clip_motion`**,
  **`review_notes_round_trip`** — one per task bundle that previously had no prompt, so every
  bundle is reachable from the prompt surface (asserted).

Every rendered prompt now carries three failure branches, because the happy path was the only
path described:

1. `verified:false` → check with the matching read tool; **do not re-call the tool** (a silent
   no-op will no-op again and look like success twice); roll back and report the limitation.
2. **A call times out or hangs** → Premiere is probably holding a modal dialog. Stop calling
   tools, say so, ask the human to press Escape.
3. **`ping` answers but `verify_premiere_connection` does not** → the engine died while the
   panel lives. Needs a human relaunch, *with the project*. Re-orient before resuming: you may
   now be talking to an older save.

And the reporting rule: **report the evidence, not the call.** "Set opacity to 40 and read back
40 on clip 3" is a report; "applied opacity" is a claim.

---

## Invariants that keep this honest

Tests, not conventions. All pure — no bridge, no Premiere.

- `src/__tests__/tools/task-bundles.test.ts`
  - every bundle entry resolves to a real tool (`resolveProfile` reports unknown patterns;
    asserted empty for every named profile, size-shaped ones included)
  - no globs in a bundle
  - every `BUNDLE_REQUIREMENTS` pairing holds under **every** profile (apply + set-property,
    add-keyframe + ease, export + verify, checkpoint + restore, and the rest)
  - every bundle completes the orientation step, carries a verification tool, and carries `undo`
  - no bundle recommends a known-broken tool
  - the documented tool count is exact; the token estimate is re-measured within tolerance —
    a failure here is a stale number to re-measure, not a bug
  - every bundle stays inside published tool-selection guidance and stays cheaper than `core`
  - discovery and routing stay reachable; bundles classify as `cost`, never `authority`
  - the table in this document matches `BUNDLE_BUDGETS`
- `src/__tests__/resources/recipes.test.ts` — every recipe renders without touching the host,
  names only tools that exist, states no hardcoded tool count, and still contains the specific
  fact it exists for (the matchNames, the ticks/seconds split, the fatal QE property, the modal
  escalation). Every wall entry offers a route out.
- `src/__tests__/prompts/bundle-alignment.test.ts` — every prompt renders with and without
  arguments, its bundle exists and covers step one, every task bundle is named by some prompt,
  every `premiere://` URI a prompt mentions is a real resource, and every prompt carries the
  three failure branches plus the report-the-evidence rule.
- `src/__tests__/tools/docs-drift.test.ts` (pre-existing) — nothing agent-facing may name a tool
  that does not exist, and published tool counts must match the catalogue.
