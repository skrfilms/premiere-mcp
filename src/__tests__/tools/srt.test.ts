/**
 * SRT subtitle CRUD — the honest caption read/edit path.
 *
 * Premiere's DOM cannot read/update/delete caption tracks, so caption editing
 * happens on the .srt file. The logic that matters is pure (parse/serialize/
 * validate + the edit ops in ../../tools/srt) and is driven directly here, then
 * the file-based tools (read_srt/write_srt/update_srt_cue/insert_srt_cue/
 * remove_srt_cue/shift_srt_timing/validate_srt) are exercised end-to-end against
 * real temp files, asserting the verify-after-write and the honest refusals.
 */

import { PremiereProTools } from '../../tools/index.js';
import {
  parseTimecode,
  formatTimecode,
  coerceSeconds,
  parseSrt,
  serializeSrt,
  validateCues,
  cueErrors,
  insertCue,
  updateCue,
  removeCue,
  shiftCues,
  scaleCues,
  type SrtCue,
} from '../../tools/srt.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noBridge = { executeScript: async () => ({ success: true }) } as never;
function priv(): any {
  return new PremiereProTools(noBridge) as unknown as any;
}

const cue = (start: number, end: number, text: string): SrtCue => ({ start, end, text });

const SAMPLE = [
  '1',
  '00:00:01,000 --> 00:00:02,500',
  'Hello there.',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,000',
  'General Kenobi.',
  'You are a bold one.',
  '',
].join('\n');

describe('srt — timecode parsing/formatting', () => {
  it('parses standard HH:MM:SS,mmm', () => {
    expect(parseTimecode('01:02:03,500')).toBeCloseTo(3723.5, 6);
  });
  it('accepts a dot millisecond separator', () => {
    expect(parseTimecode('00:00:01.250')).toBeCloseTo(1.25, 6);
  });
  it('right-pads short millisecond fields', () => {
    expect(parseTimecode('00:00:00,5')).toBeCloseTo(0.5, 6);
    expect(parseTimecode('00:00:00,05')).toBeCloseTo(0.05, 6);
  });
  it('allows a missing millisecond field', () => {
    expect(parseTimecode('00:00:07')).toBeCloseTo(7, 6);
  });
  it('returns NaN for non-timecodes', () => {
    expect(Number.isNaN(parseTimecode('not a time'))).toBe(true);
    expect(Number.isNaN(parseTimecode('12:99:00,000'))).toBe(true); // minutes out of range
  });
  it('formats seconds to HH:MM:SS,mmm and clamps negatives', () => {
    expect(formatTimecode(3723.5)).toBe('01:02:03,500');
    expect(formatTimecode(-5)).toBe('00:00:00,000');
  });
  it('does not wrap hours past two digits', () => {
    expect(formatTimecode(100 * 3600 + 1)).toBe('100:00:01,000');
  });
  it('round-trips parse <-> format at ms precision', () => {
    for (const t of ['00:00:00,000', '00:00:01,001', '01:59:59,999', '10:00:00,500']) {
      expect(formatTimecode(parseTimecode(t))).toBe(t);
    }
  });
});

describe('srt — coerceSeconds', () => {
  it('passes finite numbers through', () => {
    expect(coerceSeconds(2.5)).toBe(2.5);
  });
  it('parses timecode strings', () => {
    expect(coerceSeconds('00:00:02,500')).toBeCloseTo(2.5, 6);
  });
  it('parses numeric strings', () => {
    expect(coerceSeconds('3.25')).toBeCloseTo(3.25, 6);
  });
  it('returns NaN for garbage', () => {
    expect(Number.isNaN(coerceSeconds('banana'))).toBe(true);
    expect(Number.isNaN(coerceSeconds(Infinity))).toBe(true);
  });
});

describe('srt — parse', () => {
  it('parses a well-formed multi-cue document', () => {
    const { cues, malformed } = parseSrt(SAMPLE);
    expect(malformed).toHaveLength(0);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual(cue(1, 2.5, 'Hello there.'));
    expect(cues[1].text).toBe('General Kenobi.\nYou are a bold one.');
  });
  it('strips a UTF-8 BOM and tolerates CRLF endings', () => {
    const withBom = '﻿' + SAMPLE.replace(/\n/g, '\r\n');
    const { cues } = parseSrt(withBom);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('Hello there.');
  });
  it('parses a cue with no leading index line (timing on line 0)', () => {
    const doc = '00:00:01,000 --> 00:00:02,000\nNo index here.\n';
    const { cues, malformed } = parseSrt(doc);
    expect(malformed).toHaveLength(0);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual(cue(1, 2, 'No index here.'));
  });
  it('ignores WebVTT-style position tokens after the end timecode', () => {
    const doc = '1\n00:00:01,000 --> 00:00:02,000 X1:40 X2:600\nPositioned.\n';
    const { cues } = parseSrt(doc);
    expect(cues[0]).toEqual(cue(1, 2, 'Positioned.'));
  });
  it('records a block with no timing line as malformed instead of dropping it', () => {
    const doc = SAMPLE + '\n3\nthis block has no timing line\n';
    const { cues, malformed } = parseSrt(doc);
    expect(cues).toHaveLength(2);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].block).toBe(3);
    expect(malformed[0].reason).toMatch(/timing line/i);
  });
  it('returns empty for empty input', () => {
    expect(parseSrt('')).toEqual({ cues: [], malformed: [] });
  });
});

describe('srt — serialize + round-trip', () => {
  it('renumbers sequentially from 1 and uses comma timecodes', () => {
    const out = serializeSrt([cue(5, 6, 'b'), cue(1, 2, 'a')]);
    expect(out).toBe(
      '1\n00:00:05,000 --> 00:00:06,000\nb\n\n2\n00:00:01,000 --> 00:00:02,000\na\n',
    );
  });
  it('serializes an empty list to an empty string', () => {
    expect(serializeSrt([])).toBe('');
  });
  it('round-trips parse(serialize(x)) preserving timing and text', () => {
    const cues = [cue(1, 2.5, 'one'), cue(3, 4, 'two\nlines')];
    const back = parseSrt(serializeSrt(cues)).cues;
    expect(back).toEqual(cues);
  });
  it('is idempotent under serialize(parse(serialize(x)))', () => {
    const doc = serializeSrt([cue(0, 1, 'a'), cue(1, 2, 'b\nc')]);
    expect(serializeSrt(parseSrt(doc).cues)).toBe(doc);
  });
});

describe('srt — validation', () => {
  it('flags zero/negative-duration cues as errors', () => {
    const issues = validateCues([cue(5, 5, 'x'), cue(10, 8, 'y')]);
    expect(cueErrors([cue(5, 5, 'x')])).toHaveLength(1);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(2);
  });
  it('flags negative start as an error', () => {
    expect(cueErrors([cue(-1, 1, 'x')]).some((i) => /negative/.test(i.message))).toBe(true);
  });
  it('warns on overlap and out-of-order starts', () => {
    const issues = validateCues([cue(0, 5, 'a'), cue(3, 6, 'b')]); // b overlaps a
    expect(issues.some((i) => i.severity === 'warning' && /overlap/.test(i.message))).toBe(true);
  });
  it('warns on empty text', () => {
    expect(validateCues([cue(0, 1, '   ')]).some((i) => /empty/.test(i.message))).toBe(true);
  });
  it('passes a clean list', () => {
    expect(cueErrors([cue(0, 1, 'a'), cue(1, 2, 'b')])).toHaveLength(0);
  });
});

describe('srt — pure edit ops', () => {
  const base = [cue(0, 1, 'a'), cue(2, 3, 'c'), cue(4, 5, 'e')];

  it('insertCue places a cue in chronological order', () => {
    const out = insertCue(base, cue(2.5, 2.9, 'd'));
    expect(out.map((c) => c.text)).toEqual(['a', 'c', 'd', 'e']);
  });
  it('insertCue with equal start lands after existing same-start cues', () => {
    const out = insertCue([cue(2, 3, 'x')], cue(2, 2.5, 'y'));
    expect(out.map((c) => c.text)).toEqual(['x', 'y']);
  });
  it('insertCue does not mutate its input', () => {
    const copy = base.slice();
    insertCue(base, cue(9, 10, 'z'));
    expect(base).toEqual(copy);
  });
  it('updateCue patches only the given fields', () => {
    const out = updateCue(base, 2, { text: 'C!' });
    expect(out[1]).toEqual(cue(2, 3, 'C!'));
    expect(out[0]).toEqual(base[0]);
  });
  it('updateCue throws on an out-of-range index', () => {
    expect(() => updateCue(base, 9, { text: 'x' })).toThrow(/out of range/);
    expect(() => updateCue(base, 0, { text: 'x' })).toThrow(/out of range/);
  });
  it('removeCue drops the addressed cue', () => {
    expect(removeCue(base, 2).map((c) => c.text)).toEqual(['a', 'e']);
  });
  it('shiftCues offsets every cue and clamps at 0', () => {
    const out = shiftCues([cue(1, 2, 'a')], -5);
    expect(out[0]).toEqual(cue(0, 0, 'a'));
  });
  it('shiftCues can offset a sub-range only', () => {
    const out = shiftCues(base, 10, 2, 3);
    expect(out[0]).toEqual(cue(0, 1, 'a')); // untouched
    expect(out[1]).toEqual(cue(12, 13, 'c'));
    expect(out[2]).toEqual(cue(14, 15, 'e'));
  });
  it('shiftCues rejects fromIndex > toIndex', () => {
    expect(() => shiftCues(base, 1, 3, 2)).toThrow(/must not be greater/);
  });
  it('scaleCues multiplies timing and rejects a non-positive factor', () => {
    expect(scaleCues([cue(2, 4, 'a')], 1.5)[0]).toEqual(cue(3, 6, 'a'));
    expect(() => scaleCues([cue(0, 1, 'a')], 0)).toThrow(/positive/);
  });
});

describe('srt — file tools (E2E on real temp files)', () => {
  let dir: string;
  let srtPath: string;
  const tools = priv();

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'srt-test-'));
    srtPath = join(dir, 'captions.srt');
    await fs.writeFile(srtPath, SAMPLE, 'utf8');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('read_srt returns parsed cues with timecodes + validation', async () => {
    const res = await tools.readSrtFile(srtPath);
    expect(res.success).toBe(true);
    expect(res.cueCount).toBe(2);
    expect(res.cues[0]).toMatchObject({
      index: 1,
      start: 1,
      end: 2.5,
      startTimecode: '00:00:01,000',
      text: 'Hello there.',
    });
    expect(res.validation.errorCount).toBe(0);
  });

  it('read_srt rejects a relative path and a missing file', async () => {
    expect((await tools.readSrtFile('captions.srt')).error).toMatch(/absolute path/);
    const miss = await tools.readSrtFile(join(dir, 'nope.srt'));
    expect(miss.success).toBe(false);
    expect(miss.error).toMatch(/No file at/);
  });

  it('write_srt creates a verified file from cues (numbers + timecodes)', async () => {
    const out = join(dir, 'new.srt');
    const res = await tools.writeSrtFile(out, [
      { start: 0, end: 1.5, text: 'first' },
      { start: '00:00:02,000', end: '00:00:03,000', text: 'second' },
    ]);
    expect(res.success).toBe(true);
    expect(res.verified).toBe(true);
    const back = parseSrt(await fs.readFile(out, 'utf8')).cues;
    expect(back).toHaveLength(2);
    expect(back[1]).toEqual(cue(2, 3, 'second'));
  });

  it('write_srt refuses structurally-invalid cues unless allowInvalid', async () => {
    const out = join(dir, 'bad.srt');
    const refused = await tools.writeSrtFile(out, [{ start: 5, end: 5, text: 'zero-length' }]);
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/structural error/);
    await expect(fs.readFile(out, 'utf8')).rejects.toBeTruthy(); // nothing written
    const forced = await tools.writeSrtFile(out, [{ start: 5, end: 5, text: 'zero-length' }], true);
    expect(forced.success).toBe(true);
    expect(forced.validation.errorCount).toBe(1);
  });

  it('write_srt reports NaN timing rather than writing garbage', async () => {
    const res = await tools.writeSrtFile(join(dir, 'x.srt'), [
      { start: 'banana', end: 2, text: 'x' },
    ]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/cue 1/);
  });

  it('write_srt refuses a cue whose text has an interior blank line (unrepresentable)', async () => {
    const out = join(dir, 'blank.srt');
    const res = await tools.writeSrtFile(out, [{ start: 0, end: 1, text: 'line1\n\nline2' }]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/round-trip|blank line/i);
  });

  it('update_srt_cue edits one cue and reports before/after', async () => {
    const res = await tools.updateSrtCue(srtPath, 1, { end: '00:00:02,000', text: 'Hi.' });
    expect(res.success).toBe(true);
    expect(res.before.text).toBe('Hello there.');
    expect(res.after).toMatchObject({ index: 1, end: 2, text: 'Hi.' });
    const back = parseSrt(await fs.readFile(srtPath, 'utf8')).cues;
    expect(back[0]).toEqual(cue(1, 2, 'Hi.'));
  });

  it('update_srt_cue requires at least one field and validates the index', async () => {
    expect((await tools.updateSrtCue(srtPath, 1, {})).error).toMatch(/at least one/);
    expect((await tools.updateSrtCue(srtPath, 99, { text: 'x' })).error).toMatch(/out of range/);
  });

  it('insert_srt_cue places a cue chronologically and renumbers on disk', async () => {
    const res = await tools.insertSrtCue(srtPath, '00:00:02,600', '00:00:02,900', 'Wait.');
    expect(res.success).toBe(true);
    expect(res.insertedIndex).toBe(2);
    const back = parseSrt(await fs.readFile(srtPath, 'utf8')).cues;
    expect(back.map((c) => c.text)).toEqual([
      'Hello there.',
      'Wait.',
      'General Kenobi.\nYou are a bold one.',
    ]);
  });

  it('remove_srt_cue deletes the addressed cue and renumbers', async () => {
    const res = await tools.removeSrtCue(srtPath, 1);
    expect(res.success).toBe(true);
    expect(res.removed.text).toBe('Hello there.');
    const back = parseSrt(await fs.readFile(srtPath, 'utf8')).cues;
    expect(back).toHaveLength(1);
    expect(back[0].text).toBe('General Kenobi.\nYou are a bold one.');
  });

  it('shift_srt_timing offsets all cues and writes back verified', async () => {
    const res = await tools.shiftSrtTiming(srtPath, 1.5);
    expect(res.success).toBe(true);
    const back = parseSrt(await fs.readFile(srtPath, 'utf8')).cues;
    expect(back[0]).toEqual(cue(2.5, 4, 'Hello there.'));
    expect(back[1].start).toBeCloseTo(4.5, 6);
  });

  it('shift_srt_timing applies a scale factor before the offset', async () => {
    const res = await tools.shiftSrtTiming(srtPath, 0, 2);
    expect(res.success).toBe(true);
    const back = parseSrt(await fs.readFile(srtPath, 'utf8')).cues;
    expect(back[0]).toEqual(cue(2, 5, 'Hello there.')); // 1..2.5 scaled x2
  });

  it('shift_srt_timing applies a collapsing negative shift but reports the errors (no misleading refusal)', async () => {
    const res = await tools.shiftSrtTiming(srtPath, -100);
    expect(res.success).toBe(true); // the transform applied
    expect(res.validation.errorCount).toBeGreaterThan(0); // ...and is honestly flagged
    expect(res.note).toMatch(/structural error/);
    const back = parseSrt(await fs.readFile(srtPath, 'utf8')).cues;
    expect(back[0]).toEqual(cue(0, 0, 'Hello there.')); // clamped at 0
  });

  it('shift_srt_timing on an empty file is a no-op success', async () => {
    const empty = join(dir, 'empty.srt');
    await fs.writeFile(empty, '', 'utf8');
    const res = await tools.shiftSrtTiming(empty, 5);
    expect(res.success).toBe(true);
    expect(res.cueCount).toBe(0);
  });

  it('validate_srt reports errors on a bad file without modifying it', async () => {
    const bad = join(dir, 'bad.srt');
    await fs.writeFile(bad, '1\n00:00:05,000 --> 00:00:04,000\nbackwards\n', 'utf8');
    const res = await tools.validateSrtFile(bad);
    expect(res.success).toBe(true);
    expect(res.valid).toBe(false);
    expect(res.errorCount).toBeGreaterThan(0);
    // untouched
    expect(await fs.readFile(bad, 'utf8')).toBe('1\n00:00:05,000 --> 00:00:04,000\nbackwards\n');
  });
});
