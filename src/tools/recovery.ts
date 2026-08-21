/**
 * Recovery boundary: cheap, explicit snapshots of a sequence before risky work.
 *
 * Premiere's own undo stack is real but shallow and easy to lose — a save, a
 * crash, or a long chain of edits and the state you wanted back is gone. A
 * competitor's headline safety feature is "duplicate the sequence before a
 * batch/destructive operation," and the primitive to do it already exists here
 * (duplicate_sequence). This module makes that a first-class, named boundary:
 *
 *   - create_recovery_checkpoint   — clone the (active or named) sequence, tagged
 *   - list_recovery_checkpoints    — enumerate the tagged clones
 *   - restore_recovery_checkpoint  — clone a checkpoint back to a working sequence
 *
 * A checkpoint is just a duplicated sequence whose name carries a recognizable
 * tag, so it survives save/close/reopen with the project and needs no external
 * store. The name format is the single source of truth both ends agree on:
 *
 *     [recovery] <label> @ <YYYYMMDD-HHMMSS.mmm>
 *
 * Restore is deliberately NON-destructive: it clones the checkpoint into a fresh
 * sequence rather than trying to surgically rewind the original in place (which
 * Premiere offers no safe API for). The snapshot is never consumed, so a restore
 * can be repeated or abandoned freely.
 */

/** Marker every checkpoint sequence name begins with. ASCII, so it round-trips. */
export const RECOVERY_PREFIX = '[recovery]';

/** ` @ ` separates the label from the timestamp; label may contain anything. */
const SEP = ' @ ';

/** `20260820-231804.512` — sortable, local time, millisecond-unique. */
export function formatCheckpointTimestamp(date: Date): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}` +
    `.${p(date.getMilliseconds(), 3)}`
  );
}

/** Build the canonical checkpoint sequence name. */
export function buildRecoveryCheckpointName(label: string, timestamp: string): string {
  const clean = (label || 'checkpoint').trim() || 'checkpoint';
  return `${RECOVERY_PREFIX} ${clean}${SEP}${timestamp}`;
}

/** True when a sequence name is one of ours. */
export function isRecoveryCheckpointName(name: unknown): boolean {
  return typeof name === 'string' && name.indexOf(RECOVERY_PREFIX) === 0;
}

const CHECKPOINT_RE = /^\[recovery\]\s+([\s\S]*?)\s+@\s+(\d{8}-\d{6}(?:\.\d{1,3})?)\s*$/;

/** Parse label + timestamp back out of a checkpoint name, or null if it is not one. */
export function parseRecoveryCheckpointName(
  name: string,
): { label: string; createdAt: string } | null {
  const match = CHECKPOINT_RE.exec(name);
  if (!match) return null;
  return { label: match[1] ?? '', createdAt: match[2] ?? '' };
}

/**
 * Sequence-scoped bulk/destructive operations that opt-in auto-checkpoint guards.
 *
 * Every name here routes through the single expanded-tool dispatch, so the
 * checkpoint that was just taken can be attached to the operation's own result
 * without threading it through the first-class switch. These are the operations
 * that touch many clips at once (batch apply/rename/enable, remove-all-effects,
 * razor-all-tracks) or restructure the timeline (ripple/extract/lift, nest/
 * unnest, move-to-track) — the ones where a single mistake is expensive and the
 * built-in undo is least trustworthy. Single-item, individually-undoable edits
 * are intentionally NOT here; a snapshot per keystroke would only add noise.
 */
export const SEQUENCE_DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'razor_all_tracks',
  'remove_all_effects',
  'batch_apply_effect',
  'batch_rename_clips',
  'batch_enable_disable',
  'ripple_delete',
  'extract_selection',
  'lift_selection',
  'remove_selected_clips',
  'nest_clips',
  'unnest_sequence',
  'move_clip_to_track',
]);

export interface CheckpointEnv {
  PREMIERE_MCP_AUTO_CHECKPOINT?: string;
}

/**
 * Whether to snapshot before a destructive operation. Off by default; a user
 * turns it on with PREMIERE_MCP_AUTO_CHECKPOINT=1 (or true/on/yes).
 */
export function autoCheckpointEnabled(
  env: CheckpointEnv = process.env as CheckpointEnv,
): boolean {
  const value = (env.PREMIERE_MCP_AUTO_CHECKPOINT || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}
