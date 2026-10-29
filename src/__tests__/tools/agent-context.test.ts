/**
 * Keeping the assistant's picture of the project right: what changed, how big a reply may be,
 * and the project's own conventions.
 */
import { capResult, maxResultChars } from '../../tools/result-size.js';
import { diffStates, describeDiff, type TimelineState } from '../../tools/timeline-state.js';
import { join } from 'node:path';
import { addNote, notesPathFor } from '../../tools/project-notes.js';

const state = (hash: string, clips: TimelineState['clips'], extra: Partial<TimelineState> = {}): TimelineState => ({
  sequenceId: 's', sequenceName: 'Cut', hash, tracks: { video: 2, audio: 2 }, clips, markers: 0, project: { sequences: 3, items: 10 }, capturedAt: '', ...extra,
});

describe('what_changed diff', () => {
  const a = state('a', [
    { id: '1', track: 'V1', name: 'SH010', start: 0, end: 2, inPoint: 0 },
    { id: '2', track: 'V1', name: 'SH020', start: 2, end: 4, inPoint: 0 },
    { id: '3', track: 'V1', name: 'SH030', start: 4, end: 6, inPoint: 0 },
  ]);

  it('reports added, removed, trimmed and renamed clips by id', () => {
    const b = state('b', [
      { id: '1', track: 'V1', name: 'SH010', start: 0, end: 1.5, inPoint: 0 },
      { id: '2', track: 'V1', name: 'SH020_v2', start: 2, end: 4, inPoint: 0 },
      { id: '9', track: 'V2', name: 'title', start: 0, end: 3, inPoint: 0 },
    ], { markers: 2 });
    const d = diffStates(a, b);
    expect(d.added.map((c) => c.id)).toEqual(['9']);
    expect(d.removed.map((c) => c.id)).toEqual(['3']);
    expect(d.moved.map((m) => m.id)).toEqual(['1']);
    expect(d.renamed).toEqual([{ id: '2', from: 'SH020', to: 'SH020_v2' }]);
    expect(describeDiff(d)).toBe('1 clip added, 1 removed, 1 moved or trimmed, 1 renamed, markers 0 -> 2.');
  });

  it('follows a clip moved to another track', () => {
    const b = state('b', [{ ...a.clips[0]!, track: 'V2' }, a.clips[1]!, a.clips[2]!]);
    const d = diffStates(a, b);
    expect(d.added).toEqual([]);
    expect(d.moved[0]).toMatchObject({ id: '1', from: { track: 'V1' }, to: { track: 'V2' } });
  });

  it('says nothing changed when the hash is the same', () => {
    expect(describeDiff(diffStates(a, a))).toBe('Nothing changed.');
  });
});

describe('result size cap', () => {
  it('leaves a small result alone', () => {
    const r = { success: true, items: [1, 2, 3] };
    expect(capResult(r, 1000).value).toBe(r);
  });

  it('halves the longest list until it fits and says what was cut', () => {
    const items = Array.from({ length: 4000 }, (_, i) => ({ id: String(i), name: `clip_${i}`, path: `/renders/sh${i}/clip_${i}.mov` }));
    const { value, cuts } = capResult({ success: true, items, bins: [{ name: 'a' }] }, 40000);
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(40000);
    expect(cuts).toEqual([{ path: 'items', total: 4000, kept: (value as any).items.length }]);
    expect((value as any).items[0].id).toBe('0');
    expect((value as any).bins).toHaveLength(1);
  });

  it('clips a huge string when there is no list to shorten', () => {
    const { value } = capResult({ success: true, log: 'x'.repeat(100000) }, 5000);
    expect(JSON.stringify(value).length).toBeLessThan(5000);
    expect((value as any).log).toMatch(/more characters cut/);
  });

  it('per-call size can be raised, never past the hard limit', () => {
    expect(maxResultChars(undefined, {})).toBe(40000);
    expect(maxResultChars(100000, {})).toBe(100000);
    expect(maxResultChars(5e6, {})).toBe(400000);
    expect(maxResultChars(undefined, { PREMIERE_MCP_MAX_RESULT_CHARS: '20000' })).toBe(20000);
  });
});

describe('project notes', () => {
  it('live next to the project file', () => {
    // Native separators, like the project path Premiere reports on each platform.
    expect(notesPathFor(join('/shows', 'SPHE', 'SPHE_SQ05.prproj'))).toBe(join('/shows', 'SPHE', 'SPHE_SQ05.mcp-notes.md'));
  });

  it('start a file, add under a section, and keep sections apart', () => {
    const d = new Date('2026-10-29T12:00:00Z');
    let t = addNote('', 'Shots are SPHE_<seq>_<shot>', 'Conventions', d);
    t = addNote(t, 'Deliver ProRes 4444', 'Delivery', d);
    t = addNote(t, 'Comps land in /renders/<shot>/', 'Conventions', d);
    expect(t.startsWith('# Project notes')).toBe(true);
    const conv = t.split('## Conventions')[1]!.split('## Delivery')[0]!;
    expect(conv).toContain('SPHE_<seq>_<shot>');
    expect(conv).toContain('/renders/<shot>/');
    expect(t.split('## Delivery')[1]).toContain('ProRes 4444');
  });
});
