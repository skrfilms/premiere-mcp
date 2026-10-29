import { planSilenceCuts, toTimecode } from '../../tools/silence.js';

describe('remove_silence planning', () => {
  const clip = { start: 10, end: 16, inPoint: 0, speed: 1 };
  it('maps source silences onto the timeline with padding, snapped to frames', () => {
    const cuts = planSilenceCuts(
      [
        { start: 1, end: 2 },
        { start: 3.5, end: 4.3 },
      ],
      clip,
      0.1,
      0.5,
      24,
    );
    expect(cuts).toHaveLength(2);
    expect(cuts[0]!.start).toBeCloseTo(11.083, 2); // 11.1 snapped to frame 266
    expect(cuts[0]!.end).toBeCloseTo(11.917, 2);
    expect(cuts[1]!.start).toBeCloseTo(13.583, 2);
  });
  it('honours the in point and speed', () => {
    const cuts = planSilenceCuts(
      [{ start: 5, end: 7 }],
      { start: 0, end: 4, inPoint: 4, speed: 2 },
      0,
      0.1,
      24,
    );
    expect(cuts[0]).toMatchObject({ start: 0.5, end: 1.5 });
  });
  it('drops pauses that are too short once padded, and anything outside the clip', () => {
    expect(
      planSilenceCuts(
        [
          { start: 1, end: 1.5 },
          { start: 20, end: 22 },
        ],
        clip,
        0.2,
        0.5,
        24,
      ),
    ).toEqual([]);
  });
  it('formats QE timecodes at the nominal rate', () => {
    expect(toTimecode(61.5, 24)).toBe('00:01:01:12');
    expect(toTimecode(1, 29.97)).toBe('00:00:01:00');
  });
});
