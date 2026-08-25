/**
 * Transactional editing: every failure boundary, asserted.
 *
 * The value of a transaction is entirely in what it does when things go wrong, so
 * these tests spend most of their time there: a step that fails, a step that
 * cannot be proven, a snapshot that cannot be taken, and a rollback that itself
 * fails. The last one matters most — reporting "rolled back" without proof is the
 * exact lie this feature exists to prevent.
 *
 * The orchestrator takes an injected executor, so none of this needs Premiere.
 * Following the recovery suite's lesson, assertions are on CALL COUNTS rather
 * than string-matching, because the same executor method serves several purposes
 * (runTool runs both the edit and its read-back) and a keyword grep cannot tell
 * them apart.
 */

import {
  TRANSACTION_TOOL_NAME,
  TRANSACTION_STEP_LIMIT,
  TRANSACTION_GUARANTEES,
  classifyTransactionTool,
  sanitizeTransactionLabel,
  readPath,
  resolveConfig,
  runTransaction,
  transactSequenceEditsSchema,
  type TransactionExecutor,
  type TransactionInput,
} from '../../tools/transactions.js';
import { SEQUENCE_DESTRUCTIVE_TOOLS } from '../../tools/recovery.js';

// ── A scriptable fake host ─────────────────────────────────────────────────

interface FakeOptions {
  /** null = no active sequence at all. */
  active?: { id?: string; name?: string; success?: boolean; error?: string } | null;
  /** Fixed fingerprint values, cycled; omit for a fresh value on every call. */
  fingerprints?: string[];
  fingerprintFails?: boolean;
  checkpointFails?: boolean;
  /** The begin-time proof that the clone matches the source. */
  snapshotIdentical?: boolean;
  restoreFails?: boolean;
  /** The rollback-time proof that the restore matches the snapshot. */
  restoreIdentical?: boolean;
  restoreProjectItemId?: string | null;
  deleteFails?: boolean;
  renameFails?: boolean;
  /** Per-tool results; anything unlisted returns a self-verified success. */
  results?: Record<string, any>;
  /** Overrides results for the Nth runTool call (1-based). */
  resultByCall?: Record<number, any>;
}

function fake(options: FakeOptions = {}) {
  const fpQueue = options.fingerprints ? options.fingerprints.slice() : null;
  let fpCounter = 0;
  let runToolCalls = 0;
  let diffCalls = 0;

  const resolveActiveSequence = jest.fn(async () => {
    if (options.active === null) return { success: false, error: 'No active sequence' };
    return {
      success: true,
      id: options.active?.id ?? 'SEQ_A',
      name: options.active?.name ?? 'Reel 1',
      ...(options.active ?? {}),
    };
  });

  const fingerprint = jest.fn(async (_sequenceId?: string) => {
    if (options.fingerprintFails) return { success: false, error: 'sequence could not be read' };
    if (fpQueue && fpQueue.length > 0) {
      const next = fpQueue.length > 1 ? (fpQueue.shift() as string) : (fpQueue[0] as string);
      return { success: true, fingerprint: next, clipCount: 7 };
    }
    fpCounter += 1;
    return { success: true, fingerprint: `fp${fpCounter}`, clipCount: 7 };
  });

  const createCheckpoint = jest.fn(async (_sequenceId: string, label: string) => {
    if (options.checkpointFails) return { success: false, error: 'clone refused' };
    return {
      success: true,
      checkpointSequenceId: 'CP_ID',
      checkpointName: `[recovery] ${label} @ 20260825-120000.000`,
    };
  });

  // First diff = the begin-time snapshot proof; later diffs = rollback proof or
  // the commit's change report.
  const diffSequences = jest.fn(async (_a: string, _b: string) => {
    diffCalls += 1;
    if (diffCalls === 1) {
      return options.snapshotIdentical === false
        ? { success: true, identical: false, changeCount: 2 }
        : { success: true, identical: true, changeCount: 0 };
    }
    if (options.restoreIdentical === false) {
      return { success: true, identical: false, changeCount: 5 };
    }
    return {
      success: true,
      identical: true,
      changeCount: 0,
      counts: { added: 0, removed: 0, moved: 0, retimed: 0 },
    };
  });

  const runTool = jest.fn(async (tool: string, _args: Record<string, unknown>) => {
    runToolCalls += 1;
    if (options.resultByCall && options.resultByCall[runToolCalls] !== undefined) {
      return options.resultByCall[runToolCalls];
    }
    if (options.results && options.results[tool] !== undefined) return options.results[tool];
    return { success: true, verified: true };
  });

  const restoreCheckpoint = jest.fn(async (_cp: string, newName: string, _active: boolean) => {
    if (options.restoreFails) return { success: false, error: 'restore clone refused' };
    return {
      success: true,
      restoredSequenceId: 'RESTORED_ID',
      restoredProjectItemId:
        options.restoreProjectItemId === undefined ? 'RESTORED_ITEM' : options.restoreProjectItemId,
      restoredName: newName,
      active: true,
    };
  });

  const deleteSequence = jest.fn(async (_id: string) =>
    options.deleteFails
      ? { success: false, verified: false, error: 'Premiere did not delete the sequence' }
      : { success: true, verified: true },
  );

  const renameProjectItem = jest.fn(async (_item: string, _name: string) =>
    options.renameFails
      ? { success: false, verified: false, error: 'rename did not stick' }
      : { success: true, verified: true },
  );

  const executor: TransactionExecutor = {
    resolveActiveSequence,
    fingerprint,
    createCheckpoint,
    diffSequences,
    runTool,
    restoreCheckpoint,
    deleteSequence,
    renameProjectItem,
  };

  return {
    executor,
    resolveActiveSequence,
    fingerprint,
    createCheckpoint,
    diffSequences,
    runTool,
    restoreCheckpoint,
    deleteSequence,
    renameProjectItem,
  };
}

const CLOCK = { now: (): Date => new Date(2026, 7, 25, 12, 0, 0, 0) };

function input(over: Partial<TransactionInput> = {}): TransactionInput {
  return {
    steps: [{ tool: 'razor_all_tracks', args: { time: 5 }, expectFingerprintChanged: true }],
    label: 'test edit',
    ...over,
  } as TransactionInput;
}

// ── Schema and helpers ─────────────────────────────────────────────────────

describe('schema', () => {
  it('is a real Zod schema with fail-closed defaults', () => {
    const parsed = transactSequenceEditsSchema.parse({ steps: [{ tool: 'split_clip' }] });
    expect(parsed.onFailure).toBe('rollback');
    expect(parsed.rollbackStrategy).toBe('restore_copy');
    expect(parsed.unverifiableStep).toBe('fail');
    expect(parsed.allowPartialRollback).toBe(false);
    expect(parsed.keepCheckpointOnCommit).toBe(false);
    expect(parsed.dryRun).toBe(false);
    expect(() => transactSequenceEditsSchema.parse({ steps: [] })).toThrow();
    expect(() =>
      transactSequenceEditsSchema.parse({
        steps: new Array(TRANSACTION_STEP_LIMIT + 1).fill({ tool: 'split_clip' }),
      }),
    ).toThrow();
  });

  it('resolveConfig applies the same defaults to RAW args, since the tool layer does not parse', () => {
    expect(resolveConfig({ steps: [{ tool: 'split_clip' }] })).toEqual({
      onFailure: 'rollback',
      rollbackStrategy: 'restore_copy',
      unverifiableStep: 'fail',
      allowPartialRollback: false,
      keepCheckpointOnCommit: false,
      dryRun: false,
    });
  });

  it('sanitizes a label down to something usable in a sequence name', () => {
    expect(sanitizeTransactionLabel(undefined)).toBe('transaction');
    expect(sanitizeTransactionLabel('   ')).toBe('transaction');
    expect(sanitizeTransactionLabel('conform\n\treel  1')).toBe('conform reel 1');
    expect(sanitizeTransactionLabel('x'.repeat(200)).length).toBe(60);
  });

  it('readPath walks dotted paths including array indices', () => {
    const source = { effects: [{ matchName: 'AE.ADBE Motion' }], count: 0 };
    expect(readPath(source, 'effects.0.matchName')).toBe('AE.ADBE Motion');
    expect(readPath(source, 'count')).toBe(0);
    expect(readPath(source, 'effects.9.matchName')).toBeUndefined();
    expect(readPath(source, '')).toBe(source);
  });
});

// ── Classification ─────────────────────────────────────────────────────────

describe('classifyTransactionTool', () => {
  it('accepts sequence-scoped edits', () => {
    for (const tool of [
      'razor_all_tracks', 'ripple_delete', 'apply_video_effect', 'set_clip_opacity',
      'add_transition', 'move_clip_to_track', 'add_keyframe', 'bake_keyframe_ease',
      'delete_track', 'add_marker', 'speed_change', 'lumetri_basic_set',
    ]) {
      expect(classifyTransactionTool(tool).rollback).toBe('restorable');
    }
  });

  it('treats read-only tools as trivially restorable', () => {
    const verdict = classifyTransactionTool('get_full_sequence_info');
    expect(verdict.rollback).toBe('restorable');
    expect(verdict.readOnly).toBe(true);
  });

  it('refuses what a sequence clone cannot put back', () => {
    const cases: Array<[string, string]> = [
      ['import_media', 'media_and_import'],
      ['create_bin', 'project_items_and_bins'],
      ['move_item_to_bin', 'project_items_and_bins'],
      ['export_sequence', 'files_on_disk'],
      ['add_to_render_queue', 'files_on_disk'],
      ['save_project', 'project_lifecycle'],
      ['delete_sequence', 'sequence_lifecycle'],
      ['create_sequence_from_clips', 'sequence_lifecycle'],
      ['execute_extendscript', 'arbitrary_script'],
      ['batch_execute', 'arbitrary_script'],
      ['undo', 'undo_stack'],
      ['relink_media', 'media_and_import'],
      ['restore_recovery_checkpoint', 'transaction_boundary'],
      [TRANSACTION_TOOL_NAME, 'transaction_boundary'],
    ];
    for (const [tool, category] of cases) {
      const verdict = classifyTransactionTool(tool);
      expect(verdict.rollback).toBe('unrestorable');
      expect(verdict.category).toBe(category);
    }
  });

  it('fails closed on a tool it has never heard of', () => {
    const verdict = classifyTransactionTool('frobnicate_the_widget');
    expect(verdict.rollback).toBe('unrestorable');
    expect(verdict.category).toBe('unclassified');
  });

  it('has an opinion about every tool the recovery module already calls destructive', () => {
    // Cross-module invariant: anything worth an auto-checkpoint is exactly the kind
    // of operation an agent will want to wrap, so none of them may fall through to
    // "unclassified". nest/unnest are legitimately `partial` (they leave a nested
    // sequence in the project panel), which is why this asserts on the set, not on
    // one value.
    for (const tool of SEQUENCE_DESTRUCTIVE_TOOLS) {
      const verdict = classifyTransactionTool(tool);
      expect(verdict.category).not.toBe('unclassified');
      expect(['restorable', 'partial']).toContain(verdict.rollback);
    }
  });

  it('flags item-creating edits as only partially rollbackable', () => {
    for (const tool of ['add_adjustment_layer', 'add_text_overlay', 'nest_clips', 'title_card']) {
      expect(classifyTransactionTool(tool).rollback).toBe('partial');
    }
  });
});

// ── Refusals: nothing runs, nothing is snapshotted ─────────────────────────

describe('refusing before anything happens', () => {
  it('refuses a plan containing a tool it cannot undo, without touching the host', async () => {
    const host = fake();
    const result = await runTransaction(
      host.executor,
      input({ steps: [{ tool: 'split_clip' }, { tool: 'export_sequence' }] }),
      CLOCK,
    );

    expect(result.success).toBe(false);
    expect(result.began).toBe(false);
    expect(result.error).toContain('cannot promise to undo');
    // Not a single call into Premiere: not even the active-sequence lookup.
    expect(host.resolveActiveSequence).toHaveBeenCalledTimes(0);
    expect(host.createCheckpoint).toHaveBeenCalledTimes(0);
    expect(host.runTool).toHaveBeenCalledTimes(0);
    expect(result.plan[1]?.rollback).toBe('unrestorable');
  });

  it('refuses partial-rollback steps unless the caller opts in', async () => {
    const host = fake();
    const denied = await runTransaction(
      host.executor,
      input({ steps: [{ tool: 'add_adjustment_layer', args: { trackIndex: 2 } }] }),
      CLOCK,
    );
    expect(denied.success).toBe(false);
    expect(denied.began).toBe(false);
    expect(host.createCheckpoint).toHaveBeenCalledTimes(0);

    const allowed = await runTransaction(
      host.executor,
      input({
        steps: [{ tool: 'add_adjustment_layer', args: { trackIndex: 2 } }],
        allowPartialRollback: true,
      }),
      CLOCK,
    );
    expect(allowed.success).toBe(true);
    expect(allowed.residualRisk.length).toBe(1);
    expect(host.createCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('dryRun classifies the plan and makes zero calls', async () => {
    const host = fake();
    const result = await runTransaction(
      host.executor,
      input({ steps: [{ tool: 'split_clip' }, { tool: 'add_transition' }], dryRun: true }),
      CLOCK,
    );
    expect(result.success).toBe(true);
    expect(result.began).toBe(false);
    expect(result.plan.length).toBe(2);
    expect(host.resolveActiveSequence).toHaveBeenCalledTimes(0);
    expect(host.fingerprint).toHaveBeenCalledTimes(0);
    expect(host.createCheckpoint).toHaveBeenCalledTimes(0);
    expect(host.runTool).toHaveBeenCalledTimes(0);
  });

  it('refuses when there is no active sequence to guard', async () => {
    const host = fake({ active: null });
    const result = await runTransaction(host.executor, input(), CLOCK);
    expect(result.success).toBe(false);
    expect(result.began).toBe(false);
    expect(result.error).toMatch(/no active sequence/i);
    expect(host.createCheckpoint).toHaveBeenCalledTimes(0);
    expect(host.runTool).toHaveBeenCalledTimes(0);
  });

  it('refuses when the caller names a sequence that is not the active one', async () => {
    const host = fake({ active: { id: 'SEQ_A', name: 'Reel 1' } });
    const result = await runTransaction(host.executor, input({ sequenceId: 'SEQ_B' }), CLOCK);
    expect(result.success).toBe(false);
    expect(result.began).toBe(false);
    expect(result.error).toContain('SEQ_B');
    expect(host.fingerprint).toHaveBeenCalledTimes(0);
    expect(host.createCheckpoint).toHaveBeenCalledTimes(0);
    expect(host.runTool).toHaveBeenCalledTimes(0);
  });

  it('refuses when the pre-edit state cannot be fingerprinted', async () => {
    const host = fake({ fingerprintFails: true });
    const result = await runTransaction(host.executor, input(), CLOCK);
    expect(result.success).toBe(false);
    expect(result.began).toBe(false);
    expect(result.error).toMatch(/could not fingerprint/i);
    expect(host.createCheckpoint).toHaveBeenCalledTimes(0);
    expect(host.runTool).toHaveBeenCalledTimes(0);
  });

  it('FAIL CLOSED: a snapshot that cannot be taken stops the transaction dead', async () => {
    const host = fake({ checkpointFails: true });
    const result = await runTransaction(
      host.executor,
      input({ steps: [{ tool: 'razor_all_tracks', args: { time: 5 } }, { tool: 'ripple_delete' }] }),
      CLOCK,
    );

    expect(result.success).toBe(false);
    expect(result.began).toBe(false);
    expect(result.error).toContain('NO step was run');
    expect(result.preState?.fingerprint).toBe('fp1');
    // The snapshot was attempted exactly once and no step ever ran.
    expect(host.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(host.runTool).toHaveBeenCalledTimes(0);
    expect(result.steps.length).toBe(0);
  });

  it('FAIL CLOSED: a snapshot that cannot be proven equal to the source stops the transaction', async () => {
    const host = fake({ snapshotIdentical: false });
    const result = await runTransaction(host.executor, input(), CLOCK);

    expect(result.success).toBe(false);
    expect(result.began).toBe(false);
    expect(result.error).toContain('NO step was run');
    expect(result.checkpoint?.sequenceId).toBe('CP_ID');
    expect(result.checkpoint?.retained).toBe(true);
    expect(host.diffSequences).toHaveBeenCalledTimes(1);
    expect(host.runTool).toHaveBeenCalledTimes(0);
  });
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe('commit', () => {
  it('runs every step, verifies each one, reports the diff and drops the snapshot', async () => {
    const host = fake({
      results: {
        list_clip_effects: { success: true, effects: [{ matchName: 'AE.ADBE Motion' }] },
      },
    });
    const result = await runTransaction(
      host.executor,
      input({
        label: 'conform reel 1',
        steps: [
          { id: 'cut', tool: 'razor_all_tracks', args: { time: 5 }, expectFingerprintChanged: true },
          { id: 'grade', tool: 'apply_video_effect', args: { nodeId: 'n1', matchName: 'AE.ADBE Motion' },
            verify: { tool: 'list_clip_effects', args: { nodeId: 'n1' }, path: 'effects.0.matchName', equals: 'AE.ADBE Motion' } },
          { id: 'fade', tool: 'fade_in_video', args: { nodeId: 'n1', durationSeconds: 1 } },
        ],
      }),
      CLOCK,
    );

    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.verifiedEndToEnd).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.stoppedAtStep).toBeNull();
    expect(result.tool).toBe(TRANSACTION_TOOL_NAME);
    expect(result.transactionId).toBe('txn-20260825-120000.000');

    // 3 steps + 1 read-back = 4 runTool calls, in that order.
    expect(host.runTool).toHaveBeenCalledTimes(4);
    expect(host.runTool.mock.calls.map((c) => c[0])).toEqual([
      'razor_all_tracks', 'apply_video_effect', 'list_clip_effects', 'fade_in_video',
    ]);
    // Snapshot taken once, before any step.
    expect(host.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(host.createCheckpoint.mock.calls[0]?.[1]).toContain('conform reel 1');
    // Snapshot proof + commit change report = 2 diffs; no rollback.
    expect(host.diffSequences).toHaveBeenCalledTimes(2);
    expect(host.restoreCheckpoint).toHaveBeenCalledTimes(0);
    // The snapshot is dropped on a clean commit, and only then.
    expect(host.deleteSequence).toHaveBeenCalledTimes(1);
    expect(host.deleteSequence.mock.calls[0]?.[0]).toBe('CP_ID');
    expect(result.checkpoint?.deleted).toBe(true);
    expect(result.checkpoint?.retained).toBe(false);
    expect(result.changes?.identical).toBe(true);
  });

  it('keeps the snapshot when asked, and stays honest when the cleanup fails', async () => {
    const kept = fake();
    const keptResult = await runTransaction(
      kept.executor,
      input({ keepCheckpointOnCommit: true }),
      CLOCK,
    );
    expect(keptResult.committed).toBe(true);
    expect(kept.deleteSequence).toHaveBeenCalledTimes(0);
    expect(keptResult.checkpoint?.retained).toBe(true);

    const stuck = fake({ deleteFails: true });
    const stuckResult = await runTransaction(stuck.executor, input(), CLOCK);
    expect(stuckResult.committed).toBe(true);
    expect(stuckResult.checkpoint?.deleted).toBe(false);
    expect(stuckResult.checkpoint?.retained).toBe(true);
    expect(stuckResult.checkpoint?.cleanupError).toBeDefined();
  });

  it('every response carries the guarantee boundary, committed or not', async () => {
    const host = fake();
    const result = await runTransaction(host.executor, input(), CLOCK);
    expect(result.guarantees).toBe(TRANSACTION_GUARANTEES);
    expect(result.guarantees.restores.length).toBeGreaterThan(3);
    expect(result.guarantees.doesNotRestore.length).toBeGreaterThan(5);

    const refused = await runTransaction(host.executor, input({ dryRun: true }), CLOCK);
    expect(refused.guarantees.doesNotRestore.length).toBeGreaterThan(5);
  });
});

// ── The ledger ─────────────────────────────────────────────────────────────

describe('the ledger', () => {
  it('records per step what was attempted, whether it was proven, and the resulting fingerprint', async () => {
    const host = fake({
      fingerprints: ['pre', 'afterA', 'afterB', 'post'],
      resultByCall: { 2: { success: false, error: 'no clip at that time' } },
    });
    const result = await runTransaction(
      host.executor,
      input({
        onFailure: 'keep_partial',
        steps: [
          { id: 'first', tool: 'razor_all_tracks', args: { time: 5 }, expectFingerprintChanged: true },
          { id: 'second', tool: 'ripple_delete', args: { trackIndex: 0, time: 9 } },
          { id: 'third', tool: 'add_transition', args: { nodeId: 'n2' } },
        ],
      }),
      CLOCK,
    );

    expect(result.steps.length).toBe(3);

    const [one, two, three] = result.steps;
    expect(one?.id).toBe('first');
    expect(one?.attempted).toBe(true);
    expect(one?.verified).toBe(true);
    expect(one?.verification.basis).toBe('fingerprint');
    expect(one?.fingerprintBefore).toBe('pre');
    expect(one?.fingerprintAfter).toBe('afterA');
    expect(one?.fingerprintChanged).toBe(true);
    expect(one?.attemptedAction).toBe('razor_all_tracks {"time":5}');
    expect(one?.resultDigest).toEqual({ success: true, verified: true });

    expect(two?.id).toBe('second');
    expect(two?.attempted).toBe(true);
    expect(two?.toolSuccess).toBe(false);
    expect(two?.verified).toBe(false);
    expect(two?.verification.basis).toBe('tool_error');
    expect(two?.verification.reason).toContain('no clip at that time');
    // The full result is kept for the step that stopped the run.
    expect(two?.result).toEqual({ success: false, error: 'no clip at that time' });

    expect(three?.id).toBe('third');
    expect(three?.attempted).toBe(false);
    expect(three?.verification.basis).toBe('not_attempted');
    expect(three?.fingerprintAfter).toBeNull();

    expect(result.stoppedAtStep).toBe(2);
    // Steps 1 and 2 ran; step 3 never did.
    expect(host.runTool).toHaveBeenCalledTimes(2);
  });

  it('defaults step ids and records the classification of each step', async () => {
    // The read-only step returns no `verified` field, as most read tools do — it
    // counts as verified because it changed nothing, not because it said so.
    const host = fake({ results: { get_timeline_summary: { success: true, clipCount: 4 } } });
    const result = await runTransaction(
      host.executor,
      input({ steps: [{ tool: 'split_clip' }, { tool: 'get_timeline_summary' }] }),
      CLOCK,
    );
    expect(result.steps.map((s) => s.id)).toEqual(['step_1', 'step_2']);
    expect(result.steps.map((s) => s.rollbackClass)).toEqual(['restorable', 'restorable']);
    expect(result.steps[1]?.verification.basis).toBe('read_only');
  });
});

// ── Verification boundaries ────────────────────────────────────────────────

describe('a step that cannot be verified is a failure', () => {
  const unverifiablePlan = (): TransactionInput =>
    input({
      steps: [
        { tool: 'set_clip_opacity', args: { nodeId: 'n1', opacity: 0.5 } },
        { tool: 'add_transition', args: { nodeId: 'n1' } },
      ],
    });

  it('rolls back when a tool returns success but no proof', async () => {
    const host = fake({ results: { set_clip_opacity: { success: true } } });
    const result = await runTransaction(host.executor, unverifiablePlan(), CLOCK);

    expect(result.success).toBe(false);
    expect(result.stoppedAtStep).toBe(1);
    expect(result.steps[0]?.toolSuccess).toBe(true);
    expect(result.steps[0]?.verified).toBe(false);
    expect(result.steps[0]?.verification.basis).toBe('unverifiable');
    expect(result.rolledBack).toBe(true);
    // Step 2 never ran, and the rollback did.
    expect(host.runTool).toHaveBeenCalledTimes(1);
    expect(host.restoreCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('continues under unverifiableStep:"accept" but refuses to call the result verified', async () => {
    const host = fake({ results: { set_clip_opacity: { success: true } } });
    const result = await runTransaction(
      host.executor,
      { ...unverifiablePlan(), unverifiableStep: 'accept' },
      CLOCK,
    );

    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.verifiedEndToEnd).toBe(false);
    expect(result.steps[0]?.verified).toBeNull();
    expect(result.steps[0]?.verification.basis).toBe('unverifiable_accepted');
    expect(result.note).toContain('NOT verified');
    expect(host.runTool).toHaveBeenCalledTimes(2);
    expect(host.restoreCheckpoint).toHaveBeenCalledTimes(0);
  });

  it('treats verified:false as a failure even when success is true', async () => {
    const host = fake({ results: { set_clip_opacity: { success: true, verified: false, error: 'QE readback empty' } } });
    const result = await runTransaction(host.executor, unverifiablePlan(), CLOCK);
    expect(result.success).toBe(false);
    expect(result.steps[0]?.verification.basis).toBe('self_unverified');
    expect(result.rolledBack).toBe(true);
  });

  it('fails a step whose read-back contradicts it', async () => {
    const host = fake({
      results: { list_clip_effects: { success: true, effects: [{ matchName: 'AE.ADBE Opacity' }] } },
    });
    const result = await runTransaction(
      host.executor,
      input({
        steps: [
          {
            tool: 'apply_video_effect',
            args: { nodeId: 'n1', matchName: 'AE.ADBE Motion' },
            verify: { tool: 'list_clip_effects', path: 'effects.0.matchName', equals: 'AE.ADBE Motion' },
          },
        ],
      }),
      CLOCK,
    );
    expect(result.success).toBe(false);
    expect(result.steps[0]?.verification.basis).toBe('read_back');
    expect(result.steps[0]?.verification.reason).toContain('AE.ADBE Opacity');
    expect(result.rolledBack).toBe(true);
  });

  it('fails a step whose read-back tool itself fails', async () => {
    const host = fake({ results: { list_clip_effects: { success: false, error: 'clip not found' } } });
    const result = await runTransaction(
      host.executor,
      input({
        steps: [
          {
            tool: 'apply_video_effect',
            args: { nodeId: 'n1' },
            verify: { tool: 'list_clip_effects', path: 'effects.0.matchName', equals: 'AE.ADBE Motion' },
          },
        ],
      }),
      CLOCK,
    );
    expect(result.success).toBe(false);
    expect(result.steps[0]?.verification.basis).toBe('read_back_failed');
  });

  it('fails a structural assertion the fingerprint contradicts', async () => {
    const host = fake({ fingerprints: ['same'] });
    const result = await runTransaction(
      host.executor,
      input({ steps: [{ tool: 'razor_all_tracks', args: { time: 5 }, expectFingerprintChanged: true }] }),
      CLOCK,
    );
    expect(result.success).toBe(false);
    expect(result.steps[0]?.verification.basis).toBe('fingerprint');
    expect(result.steps[0]?.fingerprintChanged).toBe(false);
    expect(result.rolledBack).toBe(true);
  });

  it('treats a step whose fingerprint could not be read as unverifiable, not as fine', async () => {
    let call = 0;
    const host = fake();
    // Pre-state fingerprint succeeds; everything after it fails.
    (host.fingerprint as jest.Mock).mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { success: true, fingerprint: 'pre', clipCount: 7 }
        : { success: false, error: 'sequence went away' };
    });
    const result = await runTransaction(
      host.executor,
      input({ steps: [{ tool: 'razor_all_tracks', args: { time: 5 }, expectFingerprintChanged: true }] }),
      CLOCK,
    );
    expect(result.success).toBe(false);
    expect(result.steps[0]?.verification.basis).toBe('fingerprint_unavailable');
    expect(result.rolledBack).toBe(true);
  });

  it('a thrown executor call is a failed step, not a crashed transaction', async () => {
    const host = fake();
    (host.runTool as jest.Mock).mockImplementation(async () => {
      throw new Error('bridge timed out');
    });
    const result = await runTransaction(host.executor, input(), CLOCK);
    expect(result.success).toBe(false);
    expect(result.steps[0]?.verification.reason).toContain('bridge timed out');
    expect(result.rolledBack).toBe(true);
  });
});

// ── Rollback ───────────────────────────────────────────────────────────────

describe('rollback', () => {
  const failingPlan = (over: Partial<TransactionInput> = {}): TransactionInput =>
    input({
      steps: [
        { id: 'a', tool: 'razor_all_tracks', args: { time: 5 } },
        { id: 'b', tool: 'ripple_delete', args: { trackIndex: 0, time: 9 } },
        { id: 'c', tool: 'add_transition', args: { nodeId: 'n3' } },
      ],
      ...over,
    });

  it('restores the snapshot and only claims success once the restore is proven', async () => {
    const host = fake({ resultByCall: { 2: { success: false, error: 'nothing to ripple' } } });
    const result = await runTransaction(host.executor, failingPlan(), CLOCK);

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.rollbackVerified).toBe(true);
    expect(result.stoppedAtStep).toBe(2);

    expect(host.restoreCheckpoint).toHaveBeenCalledTimes(1);
    expect(host.restoreCheckpoint.mock.calls[0]?.[0]).toBe('CP_ID');
    // Snapshot proof + rollback proof = 2 diffs.
    expect(host.diffSequences).toHaveBeenCalledTimes(2);
    // restore_copy never deletes anything: not the half-edited sequence, not the snapshot.
    expect(host.deleteSequence).toHaveBeenCalledTimes(0);
    expect(result.checkpoint?.retained).toBe(true);
    expect(result.rollback?.replacedOriginal).toBe(false);
    expect(result.projectStateNow).toContain('ROLLED BACK');
    expect(result.projectStateNow).toContain('RESTORED_ID');
    // The half-edited sequence is named, not hidden.
    expect(result.projectStateNow).toContain('SEQ_A');
  });

  it('LOUD: a restore that cannot be performed is never reported as a clean abort', async () => {
    const host = fake({
      restoreFails: true,
      resultByCall: { 2: { success: false, error: 'nothing to ripple' } },
    });
    const result = await runTransaction(host.executor, failingPlan(), CLOCK);

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.rollbackVerified).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.error).toContain('ROLLBACK COULD NOT BE VERIFIED');
    expect(result.projectStateNow).toContain('UNKNOWN state');
    // It names the checkpoint that still exists so a human can finish by hand.
    expect(result.projectStateNow).toContain('CP_ID');
    expect(result.note).toContain('MANUAL INTERVENTION REQUIRED');
    expect(result.checkpoint?.retained).toBe(true);
    expect(host.deleteSequence).toHaveBeenCalledTimes(0);
  });

  it('LOUD: a restore that cannot be PROVEN identical is not a rollback, and deletes nothing', async () => {
    const host = fake({
      restoreIdentical: false,
      resultByCall: { 2: { success: false, error: 'nothing to ripple' } },
    });
    const result = await runTransaction(
      host.executor,
      failingPlan({ rollbackStrategy: 'replace_original' }),
      CLOCK,
    );

    expect(result.rolledBack).toBe(false);
    expect(result.rollbackVerified).toBe(false);
    expect(result.rollback?.restoredSequenceId).toBe('RESTORED_ID');
    expect(result.rollback?.verification).toContain('Nothing was deleted');
    // Crucially: the half-edited sequence was NOT deleted on an unproven restore.
    expect(host.deleteSequence).toHaveBeenCalledTimes(0);
    expect(result.projectStateNow).toContain('UNKNOWN state');
  });

  it('replace_original deletes the half-edited sequence and renames the restore, in that order', async () => {
    const host = fake({ resultByCall: { 2: { success: false, error: 'nothing to ripple' } } });
    const result = await runTransaction(
      host.executor,
      failingPlan({ rollbackStrategy: 'replace_original' }),
      CLOCK,
    );

    expect(result.rolledBack).toBe(true);
    expect(result.rollbackVerified).toBe(true);
    expect(result.rollback?.replacedOriginal).toBe(true);
    expect(result.rollback?.originalSequenceDeleted).toBe(true);
    // The delete targeted the working sequence, never the checkpoint.
    expect(host.deleteSequence).toHaveBeenCalledTimes(1);
    expect(host.deleteSequence.mock.calls[0]?.[0]).toBe('SEQ_A');
    expect(host.renameProjectItem).toHaveBeenCalledTimes(1);
    expect(host.renameProjectItem.mock.calls[0]).toEqual(['RESTORED_ITEM', 'Reel 1']);
    expect(result.checkpoint?.retained).toBe(true);
    // The ID change is stated, not buried.
    expect(result.projectStateNow).toContain('NEW sequence id');
  });

  it('replace_original that cannot delete the original says both sequences now exist', async () => {
    const host = fake({
      deleteFails: true,
      resultByCall: { 2: { success: false, error: 'nothing to ripple' } },
    });
    const result = await runTransaction(
      host.executor,
      failingPlan({ rollbackStrategy: 'replace_original' }),
      CLOCK,
    );

    expect(result.rolledBack).toBe(true);
    expect(result.rollbackVerified).toBe(true);
    expect(result.rollback?.replacedOriginal).toBe(false);
    expect(result.rollback?.errors.join(' ')).toContain('BOTH');
    expect(host.renameProjectItem).toHaveBeenCalledTimes(0);
  });

  it('keep_partial leaves the mess in place and says exactly where it stopped', async () => {
    const host = fake({ resultByCall: { 2: { success: false, error: 'nothing to ripple' } } });
    const result = await runTransaction(
      host.executor,
      failingPlan({ onFailure: 'keep_partial' }),
      CLOCK,
    );

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.stoppedAtStep).toBe(2);
    expect(result.projectStateNow).toContain('PARTIALLY EDITED');
    expect(result.projectStateNow).toContain('CP_ID');
    expect(host.restoreCheckpoint).toHaveBeenCalledTimes(0);
    expect(host.deleteSequence).toHaveBeenCalledTimes(0);
    expect(result.checkpoint?.retained).toBe(true);
  });
});
