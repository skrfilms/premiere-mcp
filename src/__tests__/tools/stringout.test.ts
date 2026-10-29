/**
 * Rough cut from a transcript: quotes found by their words, ranges planned end to end.
 */
import {
  findQuote,
  planStringout,
  tokenize,
  wordsFromSrt,
  wordsFromWhisperJson,
} from '../../tools/stringout.js';

const SRT = `1
00:00:01,000 --> 00:00:04,000
We never planned to go back.

2
00:00:05,000 --> 00:00:07,000
The engine was already dead,

3
00:00:07,000 --> 00:00:09,000
so we drifted for a week.
`;

describe('stringout from transcript', () => {
  it('normalises case, punctuation and accents', () => {
    expect(tokenize('Café, "Déjà" vu -- it\'s!')).toEqual(['cafe', 'deja', 'vu', "it's"]);
  });

  it('spreads srt words through their cue by character position', () => {
    const w = wordsFromSrt(SRT);
    expect(w[0]).toMatchObject({ word: 'we', start: 1 });
    expect(w[5]!.end).toBeCloseTo(4, 5);
    expect(w.map((x) => x.word).slice(0, 6)).toEqual([
      'we',
      'never',
      'planned',
      'to',
      'go',
      'back',
    ]);
  });

  it('finds an exact quote, across cues too', () => {
    const w = wordsFromSrt(SRT);
    const m = findQuote(w, 'we never planned to go back')!;
    expect(m.score).toBe(1);
    expect(m.start).toBe(1);
    expect(m.end).toBeCloseTo(4, 5);
    const across = findQuote(w, 'already dead so we drifted')!;
    expect(across.start).toBeGreaterThan(5);
    expect(across.end).toBeGreaterThan(7);
    expect(across.end).toBeLessThan(9);
  });

  it('accepts a near-miss with its score and refuses a quote that is not there', () => {
    const w = wordsFromSrt(SRT);
    const near = findQuote(w, 'the engine is already dead')!;
    expect(near.score).toBe(0.8);
    expect(findQuote(w, 'nothing like this was said')).toBeNull();
  });

  it('uses whisper word timestamps when present', () => {
    const w = wordsFromWhisperJson({
      segments: [
        {
          start: 0,
          end: 2,
          text: ' Hello there',
          words: [
            { word: ' Hello', start: 0.2, end: 0.6 },
            { word: ' there.', start: 0.7, end: 1.1 },
          ],
        },
      ],
    });
    expect(findQuote(w, 'hello there')).toMatchObject({ start: 0.2, end: 1.1, score: 1 });
  });

  it('plans ranges with handles, frame snapped, clamped, laid end to end', () => {
    const plan = planStringout(
      [
        { label: 'a', start: 5, end: 7 },
        { label: 'b', start: 0.05, end: 1 },
        { label: 'c', start: 9.5, end: 12 },
      ],
      0.15,
      24,
      10,
    );
    expect(plan[0]).toMatchObject({ sourceIn: 4.833, sourceOut: 7.167, recordIn: 0 });
    expect(plan[1]).toMatchObject({ sourceIn: 0, recordIn: 2.333 });
    expect(plan[2]!.sourceOut).toBe(10);
  });
});
