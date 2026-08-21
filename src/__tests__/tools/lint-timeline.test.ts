/**
 * lint_timeline: automated timeline QC. The analysis is a pure function
 * (lintTimelineData) over walked track data, so these tests drive it directly
 * with fixtures — the same approach as parseSilenceIntervals — and additionally
 * exercise the tool end-to-end through a routing bridge that returns a synthetic
 * sequence walk.
 */

import { PremiereProTools } from '../../tools/index.js';

const noBridge = { executeScript: async () => ({ success: true }) } as never;

/** Reach the pure analyzer on an instance. */
function lint(
  data: unknown,
  flash?: number,
  gap?: number,
  checks?: string[],
): Array<Record<string, unknown>> {
  const tools = new PremiereProTools(noBridge) as unknown as {
    lintTimelineData(d: unknown, f?: number, g?: number, c?: string[]): Array<Record<string, unknown>>;
  };
  return tools.lintTimelineData(data, flash, gap, checks);
}

describe('lint_timeline — pure analyzer', () => {
  it('reports a clean timeline as no findings', () => {
    const data = {
      frameRate: 24,
      videoTracks: [{ index: 0, clips: [
        { name: 'A', startTime: 0, endTime: 2, duration: 2 },
        { name: 'B', startTime: 2, endTime: 4, duration: 2 },
      ] }],
      audioTracks: [],
    };
    expect(lint(data)).toEqual([]);
  });

  it('flags a gap between two clips', () => {
    const data = {
      frameRate: 24,
      videoTracks: [{ index: 0, clips: [
        { name: 'A', startTime: 0, endTime: 2, duration: 2 },
        { name: 'B', startTime: 3, endTime: 5, duration: 2 }, // 1s = 24-frame gap
      ] }],
    };
    const findings = lint(data);
    const gap = findings.find((f) => f.type === 'gap');
    expect(gap).toBeDefined();
    expect(gap!.gapFrames).toBe(24);
    expect(gap!.trackType).toBe('video');
    expect(String(gap!.message)).toMatch(/gap between/i);
  });

  it('flags a flash frame shorter than the threshold', () => {
    const data = {
      frameRate: 24,
      videoTracks: [{ index: 0, clips: [
        { name: 'flash', startTime: 0, endTime: 1 / 24, duration: 1 / 24 }, // 1 frame
        { name: 'B', startTime: 1 / 24, endTime: 2, duration: 2 - 1 / 24 },
      ] }],
    };
    const findings = lint(data, 2);
    const flash = findings.find((f) => f.type === 'flash_frame');
    expect(flash).toBeDefined();
    expect(flash!.clipName).toBe('flash');
  });

  it('flags an overlap and does not also call it a gap', () => {
    const data = {
      frameRate: 24,
      videoTracks: [{ index: 0, clips: [
        { name: 'A', startTime: 0, endTime: 2, duration: 2 },
        { name: 'B', startTime: 1.5, endTime: 3.5, duration: 2 }, // starts 0.5s before A ends
      ] }],
    };
    const findings = lint(data);
    expect(findings.some((f) => f.type === 'overlap')).toBe(true);
    expect(findings.some((f) => f.type === 'gap')).toBe(false);
  });

  it('flags a leading gap before the first clip', () => {
    const data = {
      frameRate: 24,
      videoTracks: [{ index: 0, clips: [
        { name: 'A', startTime: 1, endTime: 3, duration: 2 },
      ] }],
    };
    const findings = lint(data);
    const lead = findings.find((f) => f.type === 'leading_gap');
    expect(lead).toBeDefined();
    expect(lead!.gapFrames).toBe(24);
  });

  it('flags a mixed-frame-rate clip', () => {
    const data = {
      frameRate: 24,
      videoTracks: [{ index: 0, clips: [
        { name: '30p clip', startTime: 0, endTime: 2, duration: 2, sourceFrameRate: 30 },
      ] }],
    };
    const findings = lint(data);
    const mixed = findings.find((f) => f.type === 'mixed_frame_rate');
    expect(mixed).toBeDefined();
    expect(mixed!.sourceFrameRate).toBe(30);
    expect(mixed!.sequenceFrameRate).toBe(24);
  });

  it('does not flag matching frame rates as mixed', () => {
    const data = {
      frameRate: 23.976,
      videoTracks: [{ index: 0, clips: [
        { name: 'match', startTime: 0, endTime: 2, duration: 2, sourceFrameRate: 23.976 },
      ] }],
    };
    expect(lint(data).some((f) => f.type === 'mixed_frame_rate')).toBe(false);
  });

  it('does not treat a sub-half-frame boundary jitter as a gap', () => {
    const data = {
      frameRate: 24,
      videoTracks: [{ index: 0, clips: [
        { name: 'A', startTime: 0, endTime: 2, duration: 2 },
        { name: 'B', startTime: 2 + (1 / 24) * 0.4, endTime: 4, duration: 2 }, // 0.4 frame later
      ] }],
    };
    expect(lint(data).some((f) => f.type === 'gap')).toBe(false);
  });

  it('honours the checks subset', () => {
    const data = {
      frameRate: 24,
      videoTracks: [{ index: 0, clips: [
        { name: 'A', startTime: 0, endTime: 2, duration: 2 },
        { name: 'B', startTime: 3, endTime: 5, duration: 2 }, // gap
      ] }],
    };
    // Only ask for flash frames — the gap must not be reported.
    expect(lint(data, 2, 1, ['flash_frames'])).toEqual([]);
    // Ask for gaps — it comes back.
    expect(lint(data, 2, 1, ['gaps']).some((f) => f.type === 'gap')).toBe(true);
  });
});

describe('lint_timeline — end to end via bridge', () => {
  function walkingBridge(): never {
    return {
      executeScript: async (script: string) => {
        if (script.includes('walk(sequence.videoTracks)')) {
          return {
            success: true,
            sequenceId: 'SEQ-1',
            sequenceName: 'Edit',
            frameRate: 24,
            videoTracks: [{ index: 0, name: 'V1', clips: [
              { name: 'A', startTime: 0, endTime: 2, duration: 2 },
              { name: 'B', startTime: 3, endTime: 5, duration: 2 },
            ] }],
            audioTracks: [],
          };
        }
        return { success: true };
      },
    } as never;
  }

  it('walks the sequence and returns findings with a summary', async () => {
    const tools = new PremiereProTools(walkingBridge());
    const result = await tools.executeTool('lint_timeline', {});
    expect(result.success).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.findingCount).toBeGreaterThanOrEqual(1);
    expect(result.sequenceName).toBe('Edit');
    expect(result.findings.some((f: { type: string }) => f.type === 'gap')).toBe(true);
  });

  it('reports the bridge error honestly when the sequence cannot be read', async () => {
    const errBridge = { executeScript: async () => ({ success: false, error: 'No active sequence to lint' }) } as never;
    const tools = new PremiereProTools(errBridge);
    const result = await tools.executeTool('lint_timeline', {});
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/no active sequence/i);
  });
});
