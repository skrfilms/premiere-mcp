# Transactional editing (`transact_sequence_edits`)

An agent runs a seven-step edit. Step four fails. Every Premiere MCP in the field —
including this one, until now — reports the failure and leaves behind a project nobody
asked for: three of seven steps applied, a grade on the wrong clip, half a rough cut.
The human then has to work out what landed and what did not.

`transact_sequence_edits` is the answer: **plan → snapshot → apply → verify each step →
commit, or roll back to the pre-edit state and prove it.**

It is deliberately ONE tool. It reuses the existing verified primitives rather than
adding new ExtendScript: `create_recovery_checkpoint` (the snapshot), `timeline_fingerprint`
(the state hash), `diff_sequences` (the proof), `restore_recovery_checkpoint` (the rewind),
`delete_sequence` / `rename_project_item` (the optional in-place replace). The orchestrator
(`src/tools/transactions.ts`) is a pure state machine over an injected executor, so every
failure boundary is unit-tested with no Premiere running.

---

## What it does, in order

1. **Classify the plan.** Every step's tool is checked against `classifyTransactionTool`.
   If any step names something a sequence clone cannot put back, **nothing runs and no
   snapshot is taken** — the refusal comes back with the offending step and the reason.
2. **Resolve the sequence.** The transaction always guards the **active** sequence,
   because most tools default to the active sequence when no id is passed. Passing
   `sequenceId` asserts which sequence you believe is active; a mismatch is a refusal.
3. **Fingerprint the pre-state.** No fingerprint, no transaction — without it a rollback
   could not be verified.
4. **Snapshot.** `create_recovery_checkpoint` clones the sequence to
   `[recovery] <label> [txn-…] @ <timestamp>`.
5. **Prove the snapshot.** `diff_sequences(working, checkpoint)` must report `identical`.
   A clone that does not match the source is not a snapshot.
6. **Apply the steps in order**, fingerprinting after each one and verifying each one.
   The first failed or unverifiable step stops the run.
7. **Commit** (report the clip-level diff of snapshot → finished sequence, then drop the
   snapshot) **or roll back** (restore the snapshot, prove it, and report exactly what
   state the project is now in).

---

## Request

```jsonc
{
  "steps": [                                  // 1..40, in order
    {
      "tool": "razor_all_tracks",
      "args": { "time": 5 },
      "id": "cut",                            // optional; defaults to "step_1"…
      "expectFingerprintChanged": true,        // optional structural assertion
      "verify": {                              // optional read-back check
        "tool": "list_clip_effects",
        "args": { "nodeId": "n1" },
        "path": "effects.0.matchName",
        "equals": "AE.ADBE Motion"             // or "contains": "…", or "exists": true
      }
    }
  ],
  "label": "conform reel 1",                   // goes in the checkpoint name
  "sequenceId": "SEQ_A",                       // optional guard: must be the ACTIVE sequence
  "onFailure": "rollback",                     // | "keep_partial"
  "rollbackStrategy": "restore_copy",          // | "replace_original"
  "unverifiableStep": "fail",                  // | "accept"
  "allowPartialRollback": false,
  "keepCheckpointOnCommit": false,
  "dryRun": false                              // classify only; zero calls into Premiere
}
```

Every default is fail-closed, and the defaults are applied by `resolveConfig()` inside the
orchestrator rather than by Zod — the tool layer hands handlers raw args, so relying on
schema defaults would quietly turn "fail" into `undefined`.

## Response

```jsonc
{
  "success": false,
  "transactionId": "txn-20260825-120000.000",
  "began": true,              // did we get as far as taking the snapshot?
  "committed": false,
  "aborted": true,            // true ONLY when the rollback was verified
  "rolledBack": true,
  "rollbackVerified": true,
  "verifiedEndToEnd": false,  // every step ran AND every step was proven
  "sequence":   { "id": "SEQ_A", "name": "Reel 1" },
  "checkpoint": { "sequenceId": "CP_ID", "name": "[recovery] …", "retained": true, "deleted": false },
  "preState":   { "fingerprint": "1a2b3c", "clipCount": 7, "snapshotVerified": true },
  "postState":  { "fingerprint": "9f8e7d", "clipCount": 6 },
  "plan":  [ { "tool": "…", "rollback": "restorable", "category": "sequence_edit", "reason": "…" } ],
  "steps": [ /* the ledger — see below */ ],
  "stoppedAtStep": 2,
  "changes": null,            // on commit: the clip-level diff snapshot → finished sequence
  "rollback": {
    "strategy": "restore_copy",
    "attempted": true,
    "restoredSequenceId": "RESTORED_ID",
    "restoredName": "Reel 1 (rolled back txn-…)",
    "verification": "VERIFIED: the restored sequence is clip-for-clip identical to the pre-edit snapshot.",
    "replacedOriginal": false,
    "originalSequenceDeleted": false,
    "errors": []
  },
  "residualRisk": [],
  "guarantees": { "restores": [ … ], "doesNotRestore": [ … ] },
  "projectStateNow": "ROLLED BACK as a copy. …",
  "error": "Step 2 of 3 (ripple_delete) failed: … — rolled back to the pre-edit state and verified.",
  "note": "…"
}
```

`projectStateNow` is one sentence written to be relayed to a human unedited. It always
names the sequences and checkpoint involved by id.

### The ledger (`steps[]`)

One entry per planned step, **including the ones that never ran**:

| field | meaning |
|---|---|
| `index`, `id`, `tool` | which step this is |
| `rollbackClass` | `restorable` / `partial` as classified before the run |
| `attempted` | false for every step after the failure |
| `attemptedAction` | `"razor_all_tracks {\"time\":5}"` — what was tried, in your own terms |
| `toolSuccess` | the tool's own `success` |
| `verified` | `true` proven, `false` not proven, `null` accepted unproven |
| `verification.basis` | `read_back`, `fingerprint`, `self_verified`, `read_only`, `tool_error`, `read_back_failed`, `fingerprint_unavailable`, `self_unverified`, `unverifiable`, `unverifiable_accepted`, `no_result`, `not_attempted` |
| `verification.reason` | plain-English why, including the offending value |
| `fingerprintBefore` / `fingerprintAfter` / `fingerprintChanged` | sequence state hash around the step |
| `resultDigest` | the scalar fields of the result (`success`, `verified`, `error`, …) |
| `result` | the FULL result, kept only for the step that stopped the run |

### How a step gets to `verified: true`

In priority order — the first applicable rule decides:

1. `verify` read-back tool ran and its expectation held.
2. `expectFingerprintChanged` matched the fingerprint delta.
3. The tool returned `verified: true` (this server's own fail-closed read-back).
4. The tool is read-only, so there was nothing to change.
5. Otherwise the step is **unverifiable** → treated as a **failure** (default), because
   absence of evidence is not evidence. Add a `verify` block, or accept the honesty cost
   with `unverifiableStep: "accept"` — which commits but reports `verifiedEndToEnd: false`
   and never calls the result verified.

---

## The fail-closed matrix

| Failure boundary | What happens | State afterwards |
|---|---|---|
| A step's tool is not classifiable as sequence-scoped | Refuse. `began: false` | Untouched. Zero calls into Premiere — not even the active-sequence lookup |
| A step only *partially* rolls back and `allowPartialRollback` is false | Refuse. `began: false` | Untouched, zero calls |
| No active sequence | Refuse | Untouched |
| `sequenceId` is not the active sequence | Refuse | Untouched. (Otherwise steps that omit an id would edit a sequence we did not snapshot) |
| Pre-state fingerprint fails | Refuse | Untouched. A rollback we could not verify is not a rollback |
| **Snapshot fails** | Refuse. `error` says "NO step was run" | Untouched |
| **Snapshot cannot be proven identical to the source** | Refuse | Untouched except the suspect checkpoint, which is named and retained for manual deletion |
| A step returns `success: false`, throws, or returns nothing | Stop; roll back | See below |
| A step returns `verified: false` | Stop; roll back | Treated exactly like a failure |
| A step is unverifiable (`unverifiableStep: "fail"`) | Stop; roll back | Treated exactly like a failure |
| A step's fingerprint could not be read and it made a structural assertion | Stop; roll back | An assertion that cannot be evaluated counts as failed |
| Rollback: restore call fails | `rolledBack: false`, `rollbackVerified: false`, `aborted: false`, `note: "MANUAL INTERVENTION REQUIRED"` | The half-edited sequence and the checkpoint both exist and are both named by id in `projectStateNow` |
| Rollback: restore ran but **cannot be proven identical** to the snapshot | Same loud failure. **Nothing is deleted** | Half-edited sequence + unproven restore + checkpoint all present and named |
| `replace_original`: restore proven, but the half-edited sequence will not delete | `rolledBack: true`, `replacedOriginal: false`, and the report says both sequences now exist | Pre-edit content is back and proven; the mess is still there under its own name |
| `replace_original`: restore proven, delete verified, rename fails | `rolledBack: true`, `replacedOriginal: true`, and the kept name is reported | One sequence, right content, wrong name |
| Commit: the snapshot will not delete | Still `committed: true` — the edits are fine — with `checkpoint.retained: true` and `cleanupError` | Edits applied, snapshot left behind |
| `onFailure: "keep_partial"` | No rollback attempted. `rolledBack: false`, `projectStateNow` starts "PARTIALLY EDITED, on purpose" | Half-edited sequence + checkpoint, both named |

**The snapshot is never deleted on any failure path.** It is dropped only after a clean
commit, and only if `keepCheckpointOnCommit` is false.

Nothing is ever deleted before the restore has been proven. That ordering is the safety
property: delete-then-verify is unrecoverable, verify-then-delete leaves a mess a human
can fix.

---

## What a rollback genuinely restores

The snapshot is a clone of **one sequence**. It restores:

- the clip layout of that sequence — which clips are on which video/audio track, start
  times, durations, source in/out points;
- per-clip state carried by the sequence clip — enabled/disabled, speed and reverse, clip
  name overrides, label colour, opacity/volume;
- effects and transitions on those clips, with parameter values and keyframes;
- that sequence's track structure as of the snapshot — count, names, lock/mute/target;
- markers on that sequence.

## What it does NOT restore

- **Anything in another sequence.** A nested sequence is referenced, not copied; edits made
  *inside* a nest are not rolled back by restoring the parent.
- **Project-panel state** — media imported, bins created/renamed/moved, project items
  deleted or renamed, labels on project items.
- **New project items created as a side effect** (titles, graphics, adjustment layers,
  subclips, nested sequences). A rollback removes their clips from the timeline and leaves
  the items in the project panel as orphans. This is why those tools are classified
  `partial` and need `allowPartialRollback: true`.
- **Files on disk** — exports, encodes, render/preview files, sidecars, CSV/SRT/EDL/AAF.
- **Media state** — relinks, footage interpretation, proxy attach/detach, offline flags.
- **Application and project preferences**, scratch disks, workspaces, render settings.
- **Premiere's undo stack.** This tool never calls undo/redo. The rollback is a fresh clone,
  so the human's undo history after a rollback does not walk back into the pre-edit state.
- **The sequence ID under `replace_original`** — the content returns under the original
  *name*, as a new sequence with a new ID. Cached sequence IDs go stale.
- **The saved state of the project.** Nothing here saves. Close Premiere without saving and
  the edits and the rollback are lost together.

That list ships in `TRANSACTION_GUARANTEES` and is returned in **every** response, so an
agent that reads only the JSON still learns the boundary.

Because of it, the tool **refuses** to wrap: `import_*`, bin and project-item operations,
`export_*` / `encode_*` / `write_*` / render, project open/save/close, sequence create /
delete / duplicate / settings, media relink and interpretation, `undo` / `redo`,
`execute_extendscript` / `evaluate_expression` / `batch_execute`, the recovery tools
themselves — and **anything it does not recognise**. The classifier is an allowlist; an
unknown tool is refused with `category: "unclassified"` rather than assumed safe.

---

## The two rollback strategies

**`restore_copy` (default, non-destructive).** The pre-edit content comes back as a new
sequence, made active, verified identical to the snapshot. The half-edited sequence is
left in place on purpose — the tool never deletes work it did not create. You end up with:
verified pre-edit copy (active) + half-edited original + snapshot.

**`replace_original` (opt-in).** After the restore is proven, the half-edited sequence is
deleted (verified) and the restored one is renamed to the original name. You end up with
one sequence, with the right content, under the right name — but a **new sequence ID**, and
any other sequence that nested the old one will not follow the swap. Use it when the agent
owns the sequence outright.

---

## Wiring

`runTransaction` takes an executor whose eight methods map 1:1 onto existing verified
handlers, so the tool layer's wiring is a thin adapter (see the report accompanying this
doc for the exact snippet). `runTool` re-enters `executeTool`, so steps go through the
same dispatch, profile filtering and auto-checkpoint behaviour as a direct call.

## Tests

`src/__tests__/tools/transactions.test.ts` — deliberately no count is stated here, because
a stated count drifts and the suite is the source of truth. It covers: classification (accept,
refuse, unknown-tool, partial), all seven pre-flight refusals, the happy-path commit, the
ledger's exact contents, all five ways a step can fail verification, and every rollback
outcome including the two loud ones. Assertions are on **call counts** rather than string
matching, because `runTool` serves both the edit and its read-back and a keyword grep
cannot tell them apart.
