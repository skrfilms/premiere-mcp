/**
 * SRT subtitle CRUD — the honest caption-editing story.
 *
 * Premiere Pro's scripting DOM can INGEST an .srt into a caption track
 * (createCaptionTrack) but exposes NO API to read, enumerate, update, or delete
 * caption tracks or their cues (a long-standing Adobe limitation — see
 * read_sequence_captions' note). So the only truthful place to do caption CRUD
 * is the .srt file itself, on disk, BEFORE (re-)ingest. That is exactly what
 * this module is: a self-contained, host-independent SRT reader/editor/writer.
 *
 * Everything here is a PURE function — no filesystem, no Premiere, no clock — so
 * the parse/serialize/round-trip and every edit is directly unit-testable. The
 * tool handlers in index.ts add the thin I/O shell (read file → operate →
 * verify-after-write) around these.
 *
 * Cue timing is stored as absolute SECONDS (float). SRT on disk uses the
 * `HH:MM:SS,mmm --> HH:MM:SS,mmm` timecode form; parseTimecode/formatTimecode
 * convert both directions and round-trip losslessly at millisecond precision.
 */

/** One subtitle cue. Timing is absolute seconds from the start of the media. */
export interface SrtCue {
  /** Cue start, in seconds. */
  start: number;
  /** Cue end, in seconds. */
  end: number;
  /** Cue text; may contain newlines for multi-line captions. */
  text: string;
}

/** A block the parser could not read, kept so nothing fails silently. */
export interface SrtMalformedBlock {
  /** 1-based ordinal of the block within the file. */
  block: number;
  /** Why it was skipped. */
  reason: string;
  /** The raw text of the offending block (trimmed for reporting). */
  raw: string;
}

/** Result of parsing an SRT document. */
export interface SrtParseResult {
  cues: SrtCue[];
  /** Blocks that were present but unreadable (bad timing line, etc.). */
  malformed: SrtMalformedBlock[];
}

/** A validation finding over a cue list. */
export interface SrtValidationIssue {
  severity: 'error' | 'warning';
  /** 1-based cue number the issue is anchored to (0 when file-level). */
  index: number;
  message: string;
}

/** ms per unit, for exact integer timecode math. */
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * Parse an SRT timecode (`HH:MM:SS,mmm`) to seconds. Lenient about the parts
 * real files vary on: `,` or `.` millisecond separator, 1-3 millisecond digits,
 * 1-2 hour digits, and surrounding whitespace. Returns NaN when the string is
 * not a timecode at all, so callers can distinguish "0:00" from garbage.
 */
export function parseTimecode(tc: string): number {
  if (typeof tc !== 'string') return NaN;
  const m = tc
    .trim()
    .match(/^(\d{1,3}):([0-5]?\d):([0-5]?\d)(?:[,.](\d{1,3}))?$/);
  if (!m) return NaN;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  // Right-pad the fractional part so "5" => 500ms, "05" => 50ms, "005" => 5ms.
  const millis = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return (
    (hours * MS_PER_HOUR +
      minutes * MS_PER_MINUTE +
      seconds * MS_PER_SECOND +
      millis) /
    MS_PER_SECOND
  );
}

/**
 * Format seconds as an SRT timecode (`HH:MM:SS,mmm`). Rounds to the nearest
 * millisecond and clamps negatives to zero (SRT has no negative time). The
 * hours field grows past two digits rather than wrapping, so a >100h cue is
 * still representable and round-trips.
 */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  let totalMs = Math.round(seconds * MS_PER_SECOND);
  const h = Math.floor(totalMs / MS_PER_HOUR);
  totalMs -= h * MS_PER_HOUR;
  const m = Math.floor(totalMs / MS_PER_MINUTE);
  totalMs -= m * MS_PER_MINUTE;
  const s = Math.floor(totalMs / MS_PER_SECOND);
  const ms = totalMs - s * MS_PER_SECOND;
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/**
 * Accept either a number (seconds) or an SRT/`HH:MM:SS` timecode string and
 * return seconds. The edit tools take timing from an LLM that may hand back
 * either form; this normalizes both. Returns NaN when unparseable.
 */
export function coerceSeconds(value: number | string): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const asTc = parseTimecode(value);
    if (!Number.isNaN(asTc)) return asTc;
    const asNum = Number(value.trim());
    return Number.isFinite(asNum) ? asNum : NaN;
  }
  return NaN;
}

/** Matches the `start --> end` timing line, tolerating extra position coords. */
const TIMING_LINE =
  /^\s*(\d{1,3}:[0-5]?\d:[0-5]?\d(?:[,.]\d{1,3})?)\s*-->\s*(\d{1,3}:[0-5]?\d:[0-5]?\d(?:[,.]\d{1,3})?)/;

/**
 * Parse a full SRT document into cues. Robust to the ways real files differ
 * from the spec:
 *   - a UTF-8 BOM at the top,
 *   - CRLF, CR, or LF line endings,
 *   - a missing or non-numeric leading index line (the index is advisory; the
 *     timing line is the anchor),
 *   - WebVTT-style position/alignment tokens after the end timecode (ignored),
 *   - blank lines inside cue text (a block ends only at the next timing line or
 *     a blank line NOT followed by more text of the same block — we split on
 *     blank-line boundaries, the near-universal convention).
 *
 * A block whose timing line cannot be read is not silently dropped: it is
 * recorded in `malformed` so the caller can surface it.
 */
export function parseSrt(text: string): SrtParseResult {
  const cues: SrtCue[] = [];
  const malformed: SrtMalformedBlock[] = [];
  if (typeof text !== 'string' || text.length === 0) {
    return { cues, malformed };
  }

  // Strip BOM and normalize line endings so block-splitting is uniform.
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  // Blocks are separated by one or more blank lines.
  const blocks = normalized.split(/\n[ \t]*\n/);

  let ordinal = 0;
  for (const rawBlock of blocks) {
    const block = rawBlock.replace(/^\n+|\n+$/g, '');
    if (block.trim() === '') continue; // trailing/leading empties, not a cue
    ordinal += 1;

    const lines = block.split('\n');
    // The timing line is the anchor. It's usually line 0 or 1 (after an index).
    let timingIdx = -1;
    for (let i = 0; i < lines.length && i < 2; i++) {
      const ln = lines[i];
      if (ln !== undefined && TIMING_LINE.test(ln)) {
        timingIdx = i;
        break;
      }
    }
    if (timingIdx === -1) {
      malformed.push({
        block: ordinal,
        reason: 'no `HH:MM:SS,mmm --> HH:MM:SS,mmm` timing line found',
        raw: block.slice(0, 200),
      });
      continue;
    }

    const m = (lines[timingIdx] as string).match(TIMING_LINE) as RegExpMatchArray;
    const start = parseTimecode(m[1] as string);
    const end = parseTimecode(m[2] as string);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      malformed.push({
        block: ordinal,
        reason: 'timing line present but a timecode did not parse',
        raw: block.slice(0, 200),
      });
      continue;
    }

    const textLines = lines.slice(timingIdx + 1);
    const cueText = textLines.join('\n').replace(/\s+$/, '');
    cues.push({ start, end, text: cueText });
  }

  return { cues, malformed };
}

/**
 * Serialize cues to a canonical SRT document. Cues are renumbered sequentially
 * from 1 (SRT indices are positional, not identity), timing uses the `,`
 * separator, blocks are separated by a blank line, and the file ends with a
 * single trailing newline. Order is preserved as given — sorting is an explicit
 * edit (see insertCue), never a silent side effect of writing.
 */
export function serializeSrt(cues: SrtCue[]): string {
  if (!Array.isArray(cues) || cues.length === 0) return '';
  const blocks = cues.map((cue, i) => {
    const text = (cue.text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    return `${i + 1}\n${formatTimecode(cue.start)} --> ${formatTimecode(cue.end)}\n${text}`;
  });
  return blocks.join('\n\n') + '\n';
}

/** True when a value is a finite cue with a parseable shape. */
function isCue(c: unknown): c is SrtCue {
  return (
    !!c &&
    typeof c === 'object' &&
    Number.isFinite((c as SrtCue).start) &&
    Number.isFinite((c as SrtCue).end)
  );
}

/**
 * Validate a cue list for the problems that make captions render wrong. Pure,
 * so validate_srt and the write path can both call it. Errors are structural
 * (would produce a broken/rejected file); warnings are quality smells that
 * still render. Cue indices are 1-based to match how tools address cues.
 */
export function validateCues(cues: SrtCue[]): SrtValidationIssue[] {
  const issues: SrtValidationIssue[] = [];
  if (!Array.isArray(cues)) {
    return [{ severity: 'error', index: 0, message: 'cues is not an array' }];
  }
  let prevEnd = -Infinity;
  let prevStart = -Infinity;
  cues.forEach((cue, i) => {
    const n = i + 1;
    if (!isCue(cue)) {
      issues.push({ severity: 'error', index: n, message: 'cue has a non-numeric start or end' });
      return;
    }
    if (cue.start < 0) {
      issues.push({ severity: 'error', index: n, message: 'start time is negative' });
    }
    if (cue.end <= cue.start) {
      issues.push({
        severity: 'error',
        index: n,
        message: `end (${formatTimecode(cue.end)}) is not after start (${formatTimecode(cue.start)}); the cue has zero or negative duration`,
      });
    }
    if (cue.start < prevStart) {
      issues.push({ severity: 'warning', index: n, message: 'cue starts before the previous cue (out of chronological order)' });
    }
    if (cue.start < prevEnd) {
      issues.push({ severity: 'warning', index: n, message: 'cue overlaps the previous cue in time' });
    }
    if (!cue.text || cue.text.trim() === '') {
      issues.push({ severity: 'warning', index: n, message: 'cue text is empty' });
    }
    prevEnd = cue.end;
    prevStart = cue.start;
  });
  return issues;
}

/** Only the `error`-severity issues, for the "is this writable" gate. */
export function cueErrors(cues: SrtCue[]): SrtValidationIssue[] {
  return validateCues(cues).filter((i) => i.severity === 'error');
}

// ---------------------------------------------------------------------------
// Edit operations. Every one is PURE: it returns a NEW cue array and never
// mutates its input. Cue positions are addressed 1-based (matching SRT indices
// and what the tools expose). An out-of-range index throws with a clear message
// so a tool can report it rather than silently no-op.
// ---------------------------------------------------------------------------

/** Guard a 1-based index against the list; throws a caller-facing message. */
function requireIndex(cues: SrtCue[], index1: number): number {
  if (!Number.isInteger(index1) || index1 < 1 || index1 > cues.length) {
    throw new Error(
      `cue index ${index1} is out of range (file has ${cues.length} cue${cues.length === 1 ? '' : 's'}; valid range is 1..${cues.length})`,
    );
  }
  return index1 - 1;
}

/**
 * Insert a cue, keeping the list ordered by start time (then end time). Returns
 * the new array. This is the only op that reorders — captions are meant to be
 * chronological, and an inserted line should land where its timing puts it.
 */
export function insertCue(cues: SrtCue[], cue: SrtCue): SrtCue[] {
  const next = cues.slice();
  // Find the first cue that starts after the new one; insert before it. Stable
  // for equal starts (new cue goes after existing ones at the same time).
  let at = next.length;
  for (let i = 0; i < next.length; i++) {
    if ((next[i] as SrtCue).start > cue.start) {
      at = i;
      break;
    }
  }
  next.splice(at, 0, { start: cue.start, end: cue.end, text: cue.text ?? '' });
  return next;
}

/** Replace fields of one cue (1-based). Omitted fields are left unchanged. */
export function updateCue(
  cues: SrtCue[],
  index1: number,
  patch: Partial<SrtCue>,
): SrtCue[] {
  const i = requireIndex(cues, index1);
  const next = cues.slice();
  const cur = next[i] as SrtCue;
  next[i] = {
    start: patch.start !== undefined ? patch.start : cur.start,
    end: patch.end !== undefined ? patch.end : cur.end,
    text: patch.text !== undefined ? patch.text : cur.text,
  };
  return next;
}

/** Remove one cue (1-based) and return the shortened list. */
export function removeCue(cues: SrtCue[], index1: number): SrtCue[] {
  const i = requireIndex(cues, index1);
  const next = cues.slice();
  next.splice(i, 1);
  return next;
}

/**
 * Shift the timing of cues by a fixed offset (seconds; may be negative to pull
 * earlier). By default shifts every cue; pass a 1-based fromIndex/toIndex to
 * shift a contiguous range only (useful when captions drift after an edit point
 * but the head is in sync). Times are clamped at 0 — SRT has no negative time —
 * and a warning is surfaced by validation if a clamp collapses a cue.
 */
export function shiftCues(
  cues: SrtCue[],
  offsetSeconds: number,
  fromIndex1?: number,
  toIndex1?: number,
): SrtCue[] {
  const from = fromIndex1 === undefined ? 1 : fromIndex1;
  const to = toIndex1 === undefined ? cues.length : toIndex1;
  if (cues.length > 0) {
    requireIndex(cues, from);
    requireIndex(cues, to);
    if (from > to) {
      throw new Error(`fromIndex (${from}) must not be greater than toIndex (${to})`);
    }
  }
  return cues.map((cue, i) => {
    const n = i + 1;
    if (n < from || n > to) return { ...cue };
    return {
      start: Math.max(0, cue.start + offsetSeconds),
      end: Math.max(0, cue.end + offsetSeconds),
      text: cue.text,
    };
  });
}

/**
 * Scale every cue's timing by a factor about t=0. This is the honest fix for a
 * frame-rate mismatch between the transcription source and the sequence (e.g.
 * an SRT cut at 25fps laid over 23.976fps: factor = 25/23.976). Factor must be
 * positive.
 */
export function scaleCues(cues: SrtCue[], factor: number): SrtCue[] {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`scale factor must be a positive number (got ${factor})`);
  }
  return cues.map((cue) => ({
    start: cue.start * factor,
    end: cue.end * factor,
    text: cue.text,
  }));
}
