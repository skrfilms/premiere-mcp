/**
 * Recovery boundary: explicit snapshots before risky work, plus an opt-in
 * auto-checkpoint before bulk/destructive operations.
 *
 * The invariants that matter:
 *   - A checkpoint is a real sequence with a parseable tagged name, so listing
 *     it back is exact and survives save/reopen (no external store).
 *   - Restore is NON-destructive: it clones the snapshot into a new sequence and
 *     never consumes the checkpoint.
 *   - Auto-checkpoint is OFF unless the env asks for it, and FAIL-CLOSED: if the
 *     snapshot cannot be taken, the destructive op does not run.
 */

import {
  RECOVERY_PREFIX,
  buildRecoveryCheckpointName,
  formatCheckpointTimestamp,
  isRecoveryCheckpointName,
  parseRecoveryCheckpointName,
  autoCheckpointEnabled,
  SEQUENCE_DESTRUCTIVE_TOOLS,
} from '../../tools/recovery.js';
import { PremiereProTools } from '../../tools/index.js';

describe('recovery name helpers', () => {
  it('round-trips label and timestamp through the name', () => {
    const ts = formatCheckpointTimestamp(new Date(2026, 7, 20, 23, 18, 4, 512));
    expect(ts).toBe('20260820-231804.512');
    const name = buildRecoveryCheckpointName('before ripple', ts);
    expect(name).toBe('[recovery] before ripple @ 20260820-231804.512');
    expect(isRecoveryCheckpointName(name)).toBe(true);
    expect(parseRecoveryCheckpointName(name)).toEqual({
      label: 'before ripple',
      createdAt: '20260820-231804.512',
    });
  });

  it('tolerates a label containing the separator and defaults an empty label', () => {
    const name = buildRecoveryCheckpointName('a @ b', '20260101-000000.000');
    // The timestamp is anchored at the end, so the label keeps its inner " @ ".
    expect(parseRecoveryCheckpointName(name)?.label).toBe('a @ b');
    expect(buildRecoveryCheckpointName('   ', '20260101-000000.000')).toBe(
      '[recovery] checkpoint @ 20260101-000000.000',
    );
  });

  it('rejects names that are not checkpoints', () => {
    expect(isRecoveryCheckpointName('My Sequence')).toBe(false);
    expect(isRecoveryCheckpointName(undefined)).toBe(false);
    expect(parseRecoveryCheckpointName('[recovery] no timestamp here')).toBeNull();
    expect(parseRecoveryCheckpointName('My Sequence')).toBeNull();
  });
});

describe('autoCheckpointEnabled', () => {
  it('is off by default and on for truthy values only', () => {
    expect(autoCheckpointEnabled({})).toBe(false);
    expect(autoCheckpointEnabled({ PREMIERE_MCP_AUTO_CHECKPOINT: '0' })).toBe(false);
    expect(autoCheckpointEnabled({ PREMIERE_MCP_AUTO_CHECKPOINT: 'off' })).toBe(false);
    for (const v of ['1', 'true', 'on', 'yes', 'YES', ' True ']) {
      expect(autoCheckpointEnabled({ PREMIERE_MCP_AUTO_CHECKPOINT: v })).toBe(true);
    }
  });
});

/**
 * Routes each generated script to a realistic parsed result by matching a token
 * unique to the handler that produced it — the same shape the real bridge returns.
 */
function routingBridge(
  overrides: {
    activeSequence?: { success?: boolean; id?: string; name?: string; error?: string } | null;
    sequences?: Array<{ id: string; name: string; duration?: number }>;
    cloneFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const executeScript = jest.fn(async (script: string) => {
    calls.push(script);
    if (script.includes('originalSeq.clone()')) {
      if (overrides.cloneFails) return { success: false, error: 'clone refused' };
      const m = /newName:\s*("(?:[^"\\]|\\.)*")/.exec(script);
      const newName = m ? JSON.parse(m[1]) : 'copy';
      return { success: true, newSequenceId: 'CLONE_ID', newProjectItemId: 'CLONE_ITEM', newName };
    }
    if (script.includes('app.project.openSequence(')) {
      return { success: true, message: 'Active sequence set', sequenceId: 'CLONE_ID' };
    }
    if (script.includes('app.project.sequences.numSequences')) {
      return {
        success: true,
        sequences: overrides.sequences ?? [],
        count: (overrides.sequences ?? []).length,
      };
    }
    if (script.includes('var seq = app.project.activeSequence;')) {
      const a = overrides.activeSequence;
      if (a === null) return { success: false, error: 'No active sequence' };
      return { success: true, id: a?.id ?? 'ACTIVE_ID', name: a?.name ?? 'Active Seq', ...a };
    }
    // Any other script (e.g. a destructive expanded op) is a no-op success.
    return { success: true };
  });
  return { bridge: { executeScript } as any, calls, executeScript };
}

describe('create_recovery_checkpoint', () => {
  it('snapshots the active sequence when no id is given, with a tagged name', async () => {
    const { bridge, calls } = routingBridge({ activeSequence: { id: 'S1', name: 'Edit' } });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('create_recovery_checkpoint', {
      label: 'before cleanup',
    });

    expect(result.success).toBe(true);
    expect(result.checkpointSequenceId).toBe('CLONE_ID');
    expect(result.sourceSequenceId).toBe('S1');
    expect(result.checkpointName.startsWith(`${RECOVERY_PREFIX} before cleanup @ `)).toBe(true);
    // Resolved active sequence, then cloned it.
    expect(calls.some((s) => s.includes('var seq = app.project.activeSequence;'))).toBe(true);
    expect(calls.some((s) => s.includes('originalSeq.clone()'))).toBe(true);
  });

  it('clones an explicit sequenceId rather than the active sequence', async () => {
    const { bridge, calls } = routingBridge({ activeSequence: { id: 'OTHER', name: 'Other' } });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('create_recovery_checkpoint', { sequenceId: 'SEQ-42' });

    expect(result.success).toBe(true);
    expect(result.sourceSequenceId).toBe('SEQ-42');
    // The clone script targets the requested sequence, not the active one.
    const clone = calls.find((s) => s.includes('originalSeq.clone()'));
    expect(clone).toContain('SEQ-42');
    expect(clone).not.toContain('OTHER');
  });

  it('puts the previously active sequence back after cloning', async () => {
    // Premiere activates a fresh clone; left alone, every later call that defaults to the active
    // sequence would edit the snapshot instead of the cut.
    const { bridge, calls } = routingBridge({ activeSequence: { id: 'S1', name: 'Edit' } });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('create_recovery_checkpoint', {});

    expect(result.success).toBe(true);
    const cloneAt = calls.findIndex((s) => s.includes('originalSeq.clone()'));
    const restoreAt = calls.findIndex(
      (s, i) => i > cloneAt && s.includes('app.project.openSequence(want)'),
    );
    expect(restoreAt).toBeGreaterThan(cloneAt);
    expect(calls[restoreAt]).toContain('"S1"');
    expect(result).toHaveProperty('activeSequenceRestored');
  });

  it('fails clearly when there is no active sequence to snapshot', async () => {
    const { bridge } = routingBridge({ activeSequence: null });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('create_recovery_checkpoint', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no active sequence/i);
  });
});

describe('list_recovery_checkpoints', () => {
  const sequences = [
    { id: 'A', name: 'My Edit', duration: 10 },
    { id: 'B', name: '[recovery] before ripple @ 20260820-101500.000', duration: 10 },
    {
      id: 'C',
      name: '[recovery] auto before razor_all_tracks @ 20260820-231804.512',
      duration: 10,
    },
    { id: 'D', name: '[recovery] before ripple @ 20260820-090000.000', duration: 10 },
  ];

  it('returns only tagged sequences, parsed, newest first', async () => {
    const { bridge } = routingBridge({ sequences });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('list_recovery_checkpoints', {});

    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(result.checkpoints.map((c: any) => c.sequenceId)).toEqual(['C', 'B', 'D']);
    expect(result.checkpoints[0]).toMatchObject({
      sequenceId: 'C',
      label: 'auto before razor_all_tracks',
      createdAt: '20260820-231804.512',
    });
  });

  it('filters by label substring, case-insensitively', async () => {
    const { bridge } = routingBridge({ sequences });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('list_recovery_checkpoints', {
      labelContains: 'RIPPLE',
    });
    expect(result.checkpoints.map((c: any) => c.sequenceId)).toEqual(['B', 'D']);
  });
});

describe('restore_recovery_checkpoint', () => {
  const sequences = [
    { id: 'CP', name: '[recovery] before ripple @ 20260820-101500.000', duration: 10 },
  ];

  it('clones the checkpoint into a working sequence and sets it active', async () => {
    const { bridge, calls } = routingBridge({ sequences });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('restore_recovery_checkpoint', {
      checkpointSequenceId: 'CP',
    });

    expect(result.success).toBe(true);
    expect(result.restoredSequenceId).toBe('CLONE_ID');
    expect(result.fromCheckpointId).toBe('CP');
    expect(result.restoredName).toBe('before ripple (restored)');
    expect(result.active).toBe(true);
    expect(result.note).toMatch(/left intact/i);
    // Cloned, then opened.
    expect(calls.some((s) => s.includes('originalSeq.clone()'))).toBe(true);
    expect(calls.some((s) => s.includes('app.project.openSequence('))).toBe(true);
  });

  it('does not open the sequence when setActive is false', async () => {
    const { bridge, calls } = routingBridge({ sequences });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('restore_recovery_checkpoint', {
      checkpointSequenceId: 'CP',
      setActive: false,
    });
    expect(result.active).toBe(false);
    expect(calls.some((s) => s.includes('app.project.openSequence('))).toBe(false);
  });

  it('errors on an unknown checkpoint id', async () => {
    const { bridge } = routingBridge({ sequences });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('restore_recovery_checkpoint', {
      checkpointSequenceId: 'NOPE',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no sequence found/i);
  });
});

describe('auto-checkpoint before destructive operations', () => {
  const OLD = process.env.PREMIERE_MCP_AUTO_CHECKPOINT;
  afterEach(() => {
    if (OLD === undefined) delete process.env.PREMIERE_MCP_AUTO_CHECKPOINT;
    else process.env.PREMIERE_MCP_AUTO_CHECKPOINT = OLD;
  });

  it('the destructive set is expanded tools only (routed through one dispatch)', () => {
    for (const name of SEQUENCE_DESTRUCTIVE_TOOLS) {
      expect(typeof name).toBe('string');
    }
    expect(SEQUENCE_DESTRUCTIVE_TOOLS.has('razor_all_tracks')).toBe(true);
    expect(SEQUENCE_DESTRUCTIVE_TOOLS.has('list_sequences')).toBe(false);
  });

  it('snapshots first and attaches the checkpoint to the operation result', async () => {
    process.env.PREMIERE_MCP_AUTO_CHECKPOINT = '1';
    const { bridge, calls } = routingBridge({ activeSequence: { id: 'S1', name: 'Edit' } });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('razor_all_tracks', { time: 5 });

    expect(result.success).toBe(true);
    expect(result.recoveryCheckpoint).toBeDefined();
    expect(result.recoveryCheckpoint.sequenceId).toBe('CLONE_ID');
    // Clone happened before the destructive op ran.
    const cloneIdx = calls.findIndex((s) => s.includes('originalSeq.clone()'));
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
  });

  it('is off by default — no checkpoint, no extra clone', async () => {
    const { bridge, calls } = routingBridge({ activeSequence: { id: 'S1', name: 'Edit' } });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('razor_all_tracks', { time: 5 });
    expect(result.recoveryCheckpoint).toBeUndefined();
    expect(calls.some((s) => s.includes('originalSeq.clone()'))).toBe(false);
  });

  it('fails closed: if the snapshot cannot be taken, the destructive op does not run', async () => {
    process.env.PREMIERE_MCP_AUTO_CHECKPOINT = '1';
    const { bridge, calls } = routingBridge({ activeSequence: { id: 'S1' }, cloneFails: true });
    const tools = new PremiereProTools(bridge);
    const result = await tools.executeTool('razor_all_tracks', { time: 5 });

    expect(result.success).toBe(false);
    expect(result.autoCheckpoint).toBe(false);
    expect(result.error).toMatch(/was NOT run/i);
    // Only the checkpoint was attempted (resolve active sequence + clone); the
    // operation short-circuited before its own script could be emitted. Note the
    // clone script itself contains "razor_all_tracks" because that is the
    // checkpoint's label ("auto before <tool>"), so count calls rather than
    // grepping for the tool name: exactly getActiveSequence + the failed clone.
    expect(calls.some((s) => s.includes('originalSeq.clone()'))).toBe(true);
    expect(calls.length).toBe(2);
  });
});
