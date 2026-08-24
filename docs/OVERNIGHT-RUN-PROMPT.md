# Premiere MCP — long-run autonomous prompt

Paste the block in **§3** as a single message to start a 6–8 hour unattended run.
Read §1 and §2 first — they are the two things that decide whether the run lasts eight hours
or dies in twenty minutes.

---

## 1. What actually makes a run last 8 hours

I do not run on a wall clock. I run until I stop having work, or until something makes me
stop and wait. So a long run is not produced by asking for one — it is produced by removing
every reason to stop. There are exactly five, and four are in your hands:

1. **Permission prompts.** Every unapproved Bash command or file write halts the run until
   you return. This is the #1 killer. Start the session with permissions pre-granted
   (`--dangerously-skip-permissions`, or an accept-edits/bypass mode) or the run will stall
   on the first unapproved command and sit there for six hours doing nothing.
2. **The Mac sleeping.** `caffeinate` (built into macOS — nothing to install). Command in §2.
3. **A native Premiere modal.** One dialog blocks the CEP bridge until a human clicks it, and
   every queued command then stalls to its timeout. Unattended, that is the end of the host
   lane. The prompt handles this by making the modal denylist and the typed modal error
   *Phase 1 work, before any sweeping*.
4. **A dead ExtendScript engine reading as healthy.** This one burned most of the 2026-08-24
   session: the heartbeat reports `connected: true, isProcessing: false` while every call
   times out forever, and I repeatedly blamed innocent tools. Until the drain sentinel exists,
   a long unattended run will spend hours misdiagnosing itself. That is why it is the very
   first build task and not a Tier-0a line item. **Because the scratch project is disposable,
   this one moves out of your hands and into mine** — detect the death, force-quit, relaunch,
   reopen, resume. That is Phase 1.0, and it is what turns "the run ended at 1am" into "the run
   paused for 90 seconds at 1am." Yesterday the first engine kill came inside the first hour.
5. **Context compaction.** An 8-hour run will compact several times. Anything not written to
   disk is gone. Hence the mandatory state file — the prompt makes it the first artifact and
   requires an append after every task.

**And the one that is a genuine either/or:** the host lane needs Premiere Pro open, the bridge
running, and **nobody touching it** — the run will also force-quit and relaunch Premiere
repeatedly, so the machine is genuinely unusable for editing while it goes. Owner confirmed
2026-08-24: Lane A, disposable scratch project, destroy anything. Decide before you start:

- **Lane A (host):** you're done in Premiere for the night → I get the machine, and live
  coverage moves from ~38% toward complete. This is the higher-value lane by a wide margin,
  because the last session proved static tests structurally cannot catch these bugs.
- **Lane B (offline):** you need Premiere → I do the security fix, the bridge bugs, prompts,
  docs, and the competitive gaps, and touch the host not once.

The prompt below runs whichever lane the preflight discovers, and says which one it picked.

---

## 2. Before you paste

```bash
# Keep the machine awake for 9 hours (display, disk, system, and idle-sleep).
# Display stays on deliberately: a slept display has been observed to stall CEP panel work.
caffeinate -dimsu -t 32400 &
```

Then, for Lane A only: **restart Premiere Pro**, open the **scratch** project (never
`graveyard_chase.prproj` or any working edit), and start the bridge panel.

---

## 3. The prompt

```
Mission: make Premiere MCP the best Premiere Pro MCP that exists — most capable, most cohesive,
most flexible — and prove it rather than claim it. You have the machine for the next 6-8
hours. Work continuously and autonomously until the queue in this prompt is empty or you are
genuinely blocked on something only I can do.

PRIME DIRECTIVE
Never idle, never ask. Where you would normally stop to ask me a question, instead: pick the
option a careful editor would pick, write the decision and its rationale into the state file,
and keep going. Reserve questions for things that are unsafe to guess, and even then, park
the question in the state file and move to the next task rather than stopping the run. If you
finish the whole queue, do not stop — go to STANDING WORK at the bottom.

HARD INVARIANTS — these do not bend, and violating one ends the run
1. Live tools run ONLY against the disposable scratch project at the SCRATCH PATH below, which
   contains nothing worth preserving. Inside it you may destroy freely: delete sequences, nuke
   tracks, corrupt the timeline, leave it in any state. Before any mutating call, read the
   project name and refuse anything that is not /test|scratch|untitled|fixture/i. If a working
   edit is open instead, do not "just be careful" — close it or abandon the host lane.
   Corollary: because there is nothing to lose, you may force-quit and relaunch Premiere
   without asking (see Phase 1.0). Do not extend that latitude to any other project.
2. Never return fake success. Every tool verifies by readback, DOM fingerprint, or pixel
   proof. A tool that cannot verify reports verified:false with the reason. This is the moat;
   nothing in this run is worth weakening it.
3. Generated ExtendScript is ES3: no let/const/arrow/Set/Map/forEach/indexOf, no native JSON.
   Node-side code is ESM: never require(). Both classes of bug shipped silently before — grep
   for them after every edit, do not trust review.
4. Commit identity stays Skry <121132212+skrfilms@users.noreply.github.com>. Commit to the
   working branch in small, coherent, self-describing units. Push freely. Do NOT publish
   outward — no npm, no marketplace, no directory PRs, no Show HN — that is gated on me.
5. Do not delete or rewrite my project files outside tools/premiere-mcp.

STATE FILE — do this first, it is what survives compaction
Create docs/RUN-LOG-2026-08-24.md and append to it after EVERY task, one block each:
task, lane, what changed (files+lines), how it was verified, result, decisions made, and
anything discovered that a future session must know. Keep a live scoreboard at the top:
tools registered / ever-executed-live / verified-with-readback, and the current queue
position. Assume you will lose your memory several times tonight; write for the version of
you that wakes up with only this file.

PHASE 0 — PREFLIGHT (≤15 min)
- npm run build && run the unit suites. Fix anything red before touching the host.
- SCRATCH PATH: /Users/testuser/Documents/ProjectRoot/tools/premiere-mcp/.scratch/premiere-mcp-scratch.prproj
  No scratch project exists on disk yet — create it, at exactly that path, and treat the path as
  load-bearing: auto-recovery reopens it by path after every relaunch, so it must be stable and
  it must be reproducible from a script. Write a scripts/reset-scratch.mjs that builds it from
  nothing (project + sequence + fixture material) so any destroyed state is one command from
  clean. Source media: the plates under 01_MyShots/_unsorted_renders/ — read them, never write
  to them.
- Determine the lane: is Premiere running, is the bridge heartbeat fresh, and — separately —
  does the ENGINE round-trip? A fresh heartbeat proves only that the panel is alive; the engine
  was last seen wedged on 2026-08-24 and may still be. If the engine is dead, recover it via
  Phase 1.0 rather than reporting the host lane unavailable. Announce LANE A or LANE B in the
  state file with the evidence for each of the three checks separately.
- If any of the 11 background survey agents from earlier are still running, collect their
  output and fold it into docs/FEATURE-COMPARISON.md before starting Phase 2 — do not
  re-survey ground they already covered.

PHASE 1 — HONESTY INFRASTRUCTURE (build these before any sweeping; they are what make an
unattended sweep interpretable instead of a source of false conclusions)
0. AUTO-RECOVERY — build this first, it is what makes the run survive the night. Yesterday the
   session ended because the ExtendScript engine died and clearing it needed a human. Nothing
   in the scratch project is worth preserving, so that is now a solvable problem: when the
   drain sentinel (item 1 below) reports a dead engine, escalate automatically —
   pkill the Premiere process, relaunch with `open -a "Adobe Premiere Pro 2026" <SCRATCH PATH>`,
   poll for a fresh heartbeat, confirm the engine round-trips, rebuild the fixture, and resume
   the sweep from the state file's queue position. The panel already autostarts on launch
   (built 2026-08-23) so no human click is required. Log every recovery with the tool that
   triggered it — the recovery log IS the engine-killer bug report, and it is data no other
   Premiere MCP has ever collected. Cap consecutive recoveries (e.g. 5) and if you blow the cap,
   stop the host lane, write why, and continue offline rather than thrashing.
   This converts every engine death from "run over" into a ~90-second pause. It is the single
   highest-leverage item in this document, ahead of anything on the roadmap.
1. Drain sentinel — dead-engine detection. Tier 0a #1. A round-trip probe whose failure is
   unambiguous, distinguishing "panel alive but engine dead" from "panel dead" from "healthy".
   After N consecutive failures every tool says plainly: restart Premiere Pro. No Premiere MCP
   in the field does this. Wire it into the bridge so every timeout consults it.
2. Timeout honesty — Tier 0a #2. The finally-unlink at bridge index.ts:731-733 already knows
   whether the command was consumed and throws it away. Surface it: "never ran" (safe to
   retry) vs "may have run" (do not double-apply). Near-free, biggest honesty win available.
3. Typed modal error. Match adobepy's -32006 MODAL_REQUIRED. Maintain the denylist of
   dialog-opening calls (QE synthetic-media constructors, obsolete audio effects,
   overwriteClip with mismatched media, EDL import) with the modern replacement where one
   exists. Then investigate whether the Clip Mismatch Warning can be suppressed by preference
   — it currently blocks fixture construction, which blocks ~82 tools from ever being tested.
4. __mcpStringify depth cap + cycle detection (Tier 0a #4). The DOM is full of parent/child
   back-references and this is a plausible cause of the engine deaths.
5. Spurious-death fix (Tier 0a #3): require 2-3 consecutive stale heartbeat reads, not one
   transient ENOENT.
6. Bridge auth (Tier 0 #1) — real security hole: any local process that can write to
   /tmp/premiere-mcp-bridge/ executes arbitrary ExtendScript inside Premiere, with filesystem
   reach via cep_js. Per-session token in a 0600 file, echoed in every command; mode-bit the
   temp dir; sweep and refuse pre-existing unowned command files at startup (Tier 0a #7 — a
   leftover command file currently executes when the panel next starts).

PHASE 2 — COMPETITIVE PARITY, then past it
Finish docs/FEATURE-COMPARISON.md and implement every clear win. Specifically:
- leancoderkavy is the one rival genuinely ahead architecturally. Port what is real:
  helpers loaded ONCE via content-hashed $.evalFile (we ship ~20KB of prelude twice per
  call), fs.watch push on the response edge, atomic rename-claim ownership, honour a LOWER
  requested timeout above a sane floor (Tier 0a #6 — one bad script currently wedges us for
  45s regardless of what the caller asked). Do NOT move a WS listener into the MCP server
  process; CaYatur documents why. Keep file IPC as fallback.
- MCP prompts: we expose 637 tools, 13 resources, and ZERO prompts. Prompts are the right
  primitive for composite workflows. Author a real set for the workflows an editor actually
  runs, and make each one honest about what it verified.
- Then answer the question I care about, with evidence and no hedging: does a 637-tool
  catalogue degrade a model's ability to pick the right tool? If it does, fix it — profiles,
  lazy exposure, tool search, grouping — and write down the measurement that convinced you.
  If our tool count is a liability rather than an achievement, say so plainly. I would rather
  learn that tonight than keep adding.

PHASE 3 — COVERAGE (Lane A only; skip cleanly to Phase 4 in Lane B)
604 tools, 231 ever executed. Close the gap. The SKIP tier must be re-derived rather than
inherited: it was built for a session where destroying material mattered, and it conflated two
different reasons for skipping. Separate them honestly.
  - Skipped because DESTRUCTIVE (deletes sequences, wipes tracks, sets media offline, overwrites
    project files): no longer a reason. Sweep all of it. Reset the scratch project between
    destructive batches with scripts/reset-scratch.mjs rather than trying to preserve state.
  - Skipped because it BLOCKS or COSTS (opens a native modal, launches AME, minutes per call,
    or reaches outside the project to touch real files): still gated, for a reason that has
    nothing to do with the project being disposable. Handle these deliberately — modal-openers
    behind the Phase 1.3 denylist with a typed error, AME/export tools in a small timeboxed
    batch late in the run, and anything that writes outside tools/premiere-mcp and the scratch
    dir left alone entirely.
  Say in the state file how many tools moved from SKIP to swept because of this reclassification,
  and how many are still skipped and precisely why. Do not let "unsafe" keep meaning two things.
- Get scripts/build-test-fixture.mjs to complete — it is blocked on the mismatch dialog from
  Phase 1.3, and ~82 tools have never been testable because the material does not exist. Fold
  it into reset-scratch.mjs so the fixture is regenerable, not a one-shot artifact.
- Sweep in tiers with the drain sentinel checked between every call, so a wedge is attributed
  to the tool that caused it instead of the next innocent one. Commit results incrementally;
  never lose a night's findings to one hang.
- Verify by name the six trim tools rewritten from the nonexistent TrackItem.setInPoint
  (ripple_trim_in/out, extend_edit, j_cut, l_cut, fit_clip_duration), plus
  get_proxies_enabled / set_proxies_enabled.
- Diagnose match_shot_color, the one confirmed engine-killer. Bisect it in isolation with
  scripts/bisect-hang.mjs, on the assumption you will kill the engine doing it — that is
  fine tonight, it is a scratch project and nobody is waiting on the host.
- Reflect ProjectManagerOptions to unlock projectManager.process() (Project Manager:
  consolidate / transcode / trim) — the highest-value item still PENDING in
  docs/VERIFIED-API-SURFACE.md.
- Every tool that executes gets its status recorded. A tool that cannot be verified is marked
  unverified, not passing. Update docs/API-COVERAGE-MATRIX.md as you go.

PHASE 4 — CLOSE THE LOOP
- Remaining Tier 0a bugs: #8 cross-process mutual exclusion (kumoproductions solves it with
  open("wx")), #9 uxp-plugin/ cannot work as written — rebuild it against native premierepro
  or delete it; shipping a plausible-looking dead plugin is worse than shipping none.
- Reconcile every doc against what you actually proved tonight: INTERNAL-PLAN.md,
  TOOL-CATALOGUE-600.md, VERIFIED-API-SURFACE.md, API-COVERAGE-MATRIX.md,
  BRIDGE-COMPARISON.md. Delete claims the evidence no longer supports. If something I
  believe turns out to be wrong, correct it in writing and tell me in the morning report.
- Write the memory files worth keeping under my memory dir, with MEMORY.md pointers.

STANDING WORK — if the queue empties, do not stop
In priority order: (a) raise verified-with-readback coverage, which is the number that
actually measures the moat; (b) hunt for defects of the classes that already shipped twice —
ES3 violations, ESM require(), duplicate tool registrations that silently shadow, typos that
make a tool unrunnable, tools that report success without proving anything; (c) probe the
remaining PENDING API symbols and the never-explored qe.tqm; (d) fix what your own
adversarial review finds. Keep going until I come back.

THE MORNING REPORT
Leave docs/RUN-LOG-2026-08-24.md ending in a report I can read in two minutes: what got
better with numbers before and after, what broke and whether it is fixed, the decisions you
made on my behalf, what you learned that changes the plan, and the shortest list of things
that need me. Be blunt about what did not work. A run that honestly reports three failures
is worth more to me than one that claims eight successes.
```

---

## 4. Notes on why the prompt is shaped this way

- **Phase 1 before Phase 3 is not negotiable.** Sweeping 604 tools without dead-engine
  detection produces a log full of confident wrong attributions — that is exactly what
  happened on 2026-08-24, where innocent tools got blamed for a wedge caused by an earlier
  one. The infrastructure is what makes the coverage number mean anything.
- **The state file is load-bearing.** Compaction over 8 hours is certain, and the failure mode
  is not forgetting *code* (that's on disk) but forgetting *decisions* and re-litigating them.
- **"Never idle, never ask" is deliberately in tension with your standing preference** to be
  asked before non-trivial changes. It applies only inside this run, only inside
  `tools/premiere-mcp`, and it is paid for by requiring every judgement call to be logged so
  you can reverse any of them in the morning.
- **The 637-tool question is in the prompt as a real question, not a rhetorical one.** If the
  honest answer is that we over-built, the run should surface that rather than protect the
  work.
