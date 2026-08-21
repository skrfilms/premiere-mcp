/**
 * diff_sequences: version comparison. The comparison is a pure function
 * (diffTimelineData) over two walked timelines, so these tests drive it
 * directly with fixtures — the same approach as lintTimelineData — and also
 * exercise the tool end-to-end through a routing bridge that returns two
 * synthetic sequence walks keyed by the requested sequence id.
 */

import { PremiereProTools } from '../../tools/index.js';

const noBridge = { executeScript: async () => ({ success: true }) } as never;

/** Reach the pure diff on an instance. */
function diff(
  a: unknown,
  b: unknown,
): { added: any[]; removed: any[]; moved: any[]; retimed: any[] } {
  const tools = new PremiereProTools(noBridge) as unknown as {
    diffTimelineData(a: unknown, b: unknown): { added: any[]; removed: any[]; moved: any[]; retimed: any[] };
  };
  return tools.diffTimelineData(a, b);
}

const track = (index: number, clips: any[]) => ({ index, name: `V${index + 1}`, clips });
const clip = (name: string, startTime: number, duration: number) => ({
  name, startTime, duration, endTime: startTime + duration,
});

describe('diff_sequences — pure analyzer', () => {
  it('reports no changes for identical timelines', () => {
    const seq = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2), clip('B', 2, 2)])], audioTracks: [] };
    const d = diff(seq, JSON.parse(JSON.stringify(seq)));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toEqual([]);
    expect(d.retimed).toEqual([]);
  });

  it('detects an added clip', () => {
    const a = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2)])], audioTracks: [] };
    const b = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2), clip('B', 2, 2)])], audioTracks: [] };
    const d = diff(a, b);
    expect(d.added).toHaveLength(1);
    expect(d.added[0].name).toBe('B');
    expect(d.removed).toEqual([]);
  });

  it('detects a removed clip', () => {
    const a = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2), clip('B', 2, 2)])], audioTracks: [] };
    const b = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2)])], audioTracks: [] };
    const d = diff(a, b);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0].name).toBe('B');
    expect(d.added).toEqual([]);
  });

  it('detects a moved clip (same name, new start time)', () => {
    const a = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2)])], audioTracks: [] };
    const b = { frameRate: 24, videoTracks: [track(0, [clip('A', 5, 2)])], audioTracks: [] };
    const d = diff(a, b);
    expect(d.moved).toHaveLength(1);
    expect(d.moved[0].fromStart).toBe(0);
    expect(d.moved[0].toStart).toBe(5);
    expect(d.moved[0].deltaSeconds).toBe(5);
    expect(d.retimed).toEqual([]);
  });

  it('detects a retimed clip (same name+start, new duration)', () => {
    const a = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2)])], audioTracks: [] };
    const b = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 3)])], audioTracks: [] };
    const d = diff(a, b);
    expect(d.retimed).toHaveLength(1);
    expect(d.retimed[0].fromDuration).toBe(2);
    expect(d.retimed[0].toDuration).toBe(3);
    expect(d.moved).toEqual([]);
  });

  it('does not flag a sub-half-frame jitter as moved or retimed', () => {
    const a = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2)])], audioTracks: [] };
    const jitter = (1 / 24) * 0.4;
    const b = { frameRate: 24, videoTracks: [track(0, [clip('A', jitter, 2 + jitter)])], audioTracks: [] };
    const d = diff(a, b);
    expect(d.moved).toEqual([]);
    expect(d.retimed).toEqual([]);
  });

  it('keeps changes scoped to their own track', () => {
    const a = { frameRate: 24, videoTracks: [track(0, [clip('A', 0, 2)]), track(1, [])], audioTracks: [] };
    const b = { frameRate: 24, videoTracks: [track(0, []), track(1, [clip('A', 0, 2)])], audioTracks: [] };
    // Same clip name but on a different track index: removed from V1, added on V2.
    const d = diff(a, b);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0].trackIndex).toBe(0);
    expect(d.added).toHaveLength(1);
    expect(d.added[0].trackIndex).toBe(1);
    expect(d.moved).toEqual([]);
  });

  it('diffs audio tracks as well as video', () => {
    const a = { frameRate: 24, videoTracks: [], audioTracks: [track(0, [clip('VO', 0, 4)])] };
    const b = { frameRate: 24, videoTracks: [], audioTracks: [track(0, [clip('VO', 1, 4)])] };
    const d = diff(a, b);
    expect(d.moved).toHaveLength(1);
    expect(d.moved[0].trackType).toBe('audio');
  });
});

describe('diff_sequences — end to end via bridge', () => {
  function diffingBridge(): never {
    return {
      executeScript: async (script: string) => {
        // walkSequence stringifies the requested id into the script; key off it.
        if (script.includes('walk(sequence.videoTracks)')) {
          if (script.includes('SEQ-A')) {
            return {
              success: true, sequenceId: 'SEQ-A', sequenceName: 'Original', frameRate: 24,
              videoTracks: [{ index: 0, name: 'V1', clips: [clip('A', 0, 2), clip('B', 2, 2)] }],
              audioTracks: [],
            };
          }
          if (script.includes('SEQ-B')) {
            return {
              success: true, sequenceId: 'SEQ-B', sequenceName: 'Edit', frameRate: 24,
              videoTracks: [{ index: 0, name: 'V1', clips: [clip('A', 0, 2), clip('B', 5, 2), clip('C', 7, 2)] }],
              audioTracks: [],
            };
          }
        }
        return { success: true };
      },
    } as never;
  }

  it('walks both sequences and summarizes the changes', async () => {
    const tools = new PremiereProTools(diffingBridge());
    const result = await tools.executeTool('diff_sequences', { sequenceIdA: 'SEQ-A', sequenceIdB: 'SEQ-B' });
    expect(result.success).toBe(true);
    expect(result.identical).toBe(false);
    expect(result.sequenceA.name).toBe('Original');
    expect(result.sequenceB.name).toBe('Edit');
    expect(result.counts.added).toBe(1); // C
    expect(result.counts.moved).toBe(1); // B moved 2 -> 5
    expect(result.added[0].name).toBe('C');
    expect(result.moved[0].name).toBe('B');
    expect(result.changeCount).toBe(2);
  });

  it('requires both sequence ids (rejected at the schema layer)', async () => {
    const tools = new PremiereProTools(diffingBridge());
    const result = await tools.executeTool('diff_sequences', { sequenceIdA: 'SEQ-A' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/invalid arguments|sequenceIdB/i);
  });

  it('reports a read failure honestly', async () => {
    const errBridge = { executeScript: async () => ({ success: false, error: 'Sequence not found by id: SEQ-X' }) } as never;
    const tools = new PremiereProTools(errBridge);
    const result = await tools.executeTool('diff_sequences', { sequenceIdA: 'SEQ-X', sequenceIdB: 'SEQ-Y' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/could not read/i);
  });
});
