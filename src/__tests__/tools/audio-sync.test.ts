import { findOffset } from '../../tools/audio-sync.js';

// mulberry32: exact 32-bit integer maths, so different seeds give independent sequences.
function noise(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let t = seed >>> 0;
  for (let i = 0; i < n; i++) {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    out[i] = (((x ^ (x >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return out;
}

describe('audio sync offset', () => {
  const rate = 1000;
  const base = noise(10 * rate, 3);
  it('finds a positive offset (b starts later in the recording)', () => {
    const a = base.slice(0, 8 * rate),
      b = base.slice(1500, 1500 + 6 * rate);
    const r = findOffset(a, b, rate, 5);
    expect(r.offsetSeconds).toBeCloseTo(1.5, 3);
    expect(r.score).toBeGreaterThan(0.5);
  });
  it('finds a negative offset (b started recording earlier)', () => {
    const a = base.slice(2000, 2000 + 6 * rate),
      b = base.slice(500, 500 + 7 * rate);
    expect(findOffset(a, b, rate, 5).offsetSeconds).toBeCloseTo(-1.5, 3);
  });
  it('scores unrelated audio low', () => {
    expect(findOffset(base.slice(0, 4000), noise(4000, 99), rate, 2).score).toBeLessThan(0.2);
  });
});
