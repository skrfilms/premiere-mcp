/**
 * Keyframe easing — the honest, verifiable ease path.
 *
 * The math is pure (../../tools/easing) and is driven directly here. The host
 * tool (bake_keyframe_ease) is then exercised through a mock bridge that stands
 * in for Premiere: it echoes the baked values back so the success path proves
 * verify-after-write, and it can perturb the read-back to prove the tool refuses
 * to claim success when a value did not land (e.g. Premiere clamped it).
 */

import { PremiereProTools } from '../../tools/index.js';
import {
  EASINGS,
  EASING_NAMES,
  MAX_EASE_SAMPLES,
  getEasing,
  cubicBezier,
  sampleEaseKeyframes,
} from '../../tools/easing.js';

describe('easing — named curves', () => {
  it('exposes a sorted, de-duplicated name list that matches the table', () => {
    expect(EASING_NAMES).toEqual([...EASING_NAMES].sort());
    expect(new Set(EASING_NAMES).size).toBe(EASING_NAMES.length);
    expect(EASING_NAMES).toContain('linear');
    expect(EASING_NAMES).toContain('easeInOutCubic');
    expect(EASING_NAMES).toContain('easeOutBounce');
    expect(EASING_NAMES.length).toBe(Object.keys(EASINGS).length);
  });

  it('getEasing resolves known names and rejects unknown ones', () => {
    expect(typeof getEasing('linear')).toBe('function');
    expect(getEasing('nope')).toBeUndefined();
    // must not resolve inherited Object props as easings
    expect(getEasing('toString')).toBeUndefined();
    expect(getEasing('hasOwnProperty')).toBeUndefined();
  });

  it('every easing pins its endpoints at 0 and 1', () => {
    for (const name of EASING_NAMES) {
      const fn = getEasing(name)!;
      expect(fn(0)).toBeCloseTo(0, 6);
      expect(fn(1)).toBeCloseTo(1, 6);
    }
  });

  it('linear is the identity', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) expect(EASINGS.linear!(p)).toBeCloseTo(p, 6);
  });

  it('quad/cubic in-curves match their closed forms at the midpoint', () => {
    expect(EASINGS.easeInQuad!(0.5)).toBeCloseTo(0.25, 6);
    expect(EASINGS.easeOutQuad!(0.5)).toBeCloseTo(0.75, 6);
    expect(EASINGS.easeInCubic!(0.5)).toBeCloseTo(0.125, 6);
    expect(EASINGS.easeInOutQuad!(0.5)).toBeCloseTo(0.5, 6);
  });

  it('the Back family overshoots past the [0,1] band in its interior', () => {
    expect(EASINGS.easeOutBack!(0.5)).toBeGreaterThan(1); // overshoots high before settling
    expect(EASINGS.easeInBack!(0.5)).toBeLessThan(0); // dips low first
  });
});

describe('easing — cubic-bezier', () => {
  it('a straight-diagonal bezier is (near) identity', () => {
    const f = cubicBezier(0, 0, 1, 1);
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) expect(f(p)).toBeCloseTo(p, 3);
  });

  it('a symmetric ease-in-out bezier passes through (0.5, 0.5)', () => {
    const f = cubicBezier(0.42, 0, 0.58, 1); // CSS ease-in-out
    expect(f(0.5)).toBeCloseTo(0.5, 3);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
  });

  it('solves x->t accurately for a steep curve', () => {
    const f = cubicBezier(0.9, 0, 0.1, 1); // very steep S
    // monotonic and bounded
    let prev = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const y = f(Math.min(p, 1));
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(1 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });

  it('rejects out-of-range x control points and non-finite inputs', () => {
    expect(() => cubicBezier(-0.1, 0, 0.5, 1)).toThrow(/within \[0, 1\]/);
    expect(() => cubicBezier(0, 0, 1.2, 1)).toThrow(/within \[0, 1\]/);
    expect(() => cubicBezier(NaN, 0, 0.5, 1)).toThrow(/finite/);
  });
});

describe('easing — sampleEaseKeyframes', () => {
  const base = { startTime: 0, endTime: 2, startValue: 0, endValue: 100 };

  it('returns samples+1 keyframes with exact endpoints', () => {
    const kf = sampleEaseKeyframes({ ...base, samples: 4, easing: 'easeInOutCubic' });
    expect(kf).toHaveLength(5);
    expect(kf[0]).toEqual({ time: 0, value: 0 });
    expect(kf[4]).toEqual({ time: 2, value: 100 });
  });

  it('spaces times evenly across the span', () => {
    const kf = sampleEaseKeyframes({ ...base, samples: 4, easing: 'linear' });
    expect(kf.map((k) => k.time)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('linear easing produces a straight value ramp', () => {
    const kf = sampleEaseKeyframes({ ...base, samples: 4, easing: 'linear' });
    expect(kf.map((k) => k.value)).toEqual([0, 25, 50, 75, 100]);
  });

  it('eases from a higher to a lower value (fade out)', () => {
    const kf = sampleEaseKeyframes({ startTime: 1, endTime: 2, startValue: 100, endValue: 0, samples: 2, easing: 'linear' });
    expect(kf.map((k) => k.value)).toEqual([100, 50, 0]);
  });

  it('bezier overrides a named easing', () => {
    const kf = sampleEaseKeyframes({ ...base, samples: 2, easing: 'easeOutBounce', bezier: [0, 0, 1, 1] });
    expect(kf[1]!.value).toBeCloseTo(50, 3); // straight bezier, not bounce
  });

  it('defaults to linear when no easing or bezier is given', () => {
    const kf = sampleEaseKeyframes({ ...base, samples: 2 });
    expect(kf[1]!.value).toBeCloseTo(50, 6);
  });

  it('rejects a non-increasing time span', () => {
    expect(() => sampleEaseKeyframes({ ...base, endTime: 0, samples: 2 })).toThrow(/greater than/);
    expect(() => sampleEaseKeyframes({ ...base, endTime: -1, samples: 2 })).toThrow(/greater than/);
  });

  it('rejects bad sample counts', () => {
    expect(() => sampleEaseKeyframes({ ...base, samples: 0 })).toThrow(/>= 1/);
    expect(() => sampleEaseKeyframes({ ...base, samples: 2.5 })).toThrow(/integer/);
    expect(() => sampleEaseKeyframes({ ...base, samples: MAX_EASE_SAMPLES + 1 })).toThrow(/<=/);
  });

  it('rejects an unknown easing and a malformed bezier', () => {
    expect(() => sampleEaseKeyframes({ ...base, samples: 2, easing: 'wobble' })).toThrow(/unknown easing/);
    expect(() => sampleEaseKeyframes({ ...base, samples: 2, bezier: [0, 0, 1] as never })).toThrow(/\[x1, y1, x2, y2\]/);
  });

  it('rejects non-finite start/end values', () => {
    expect(() => sampleEaseKeyframes({ ...base, startValue: NaN, samples: 2 })).toThrow(/finite/);
  });
});

describe('bake_keyframe_ease — host tool (mock bridge)', () => {
  // Extracts the values[] the tool embedded in the ExtendScript, so the mock can
  // echo them (or perturb them) as if Premiere had read them back.
  function bakedValues(script: string): number[] {
    const m = script.match(/var values = (\[[^\]]*\]);/);
    if (!m) throw new Error('script did not embed a values array');
    return JSON.parse(m[1]!);
  }

  function toolsWith(respond: (script: string) => any) {
    const executeScript = jest.fn(async (script: string) => respond(script));
    return { tools: new PremiereProTools({ executeScript } as never), executeScript };
  }

  const good = {
    clipId: 'clip-1',
    componentName: 'Opacity',
    paramName: 'Opacity',
    startTime: 0,
    endTime: 1,
    startValue: 0,
    endValue: 100,
    easing: 'easeInOutCubic',
    samples: 8,
  };

  it('bakes and verifies when every value reads back (echo bridge)', async () => {
    const { tools, executeScript } = toolsWith((script) =>
      JSON.stringify({ success: true, readback: bakedValues(script), keyCount: bakedValues(script).length }),
    );
    const res = await tools.executeTool('bake_keyframe_ease', good);
    expect(res.success).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.keyCount).toBe(9);
    expect(res.verifiedCount).toBe(9);
    expect(res.startValue).toBe(0);
    expect(res.endValue).toBe(100);
    expect(executeScript).toHaveBeenCalledTimes(1);
    // the embedded script must set time-varying and add keys
    expect(executeScript.mock.calls[0][0]).toContain('setValueAtKey');
  });

  it('refuses to claim success when a value did not land (simulated clamp)', async () => {
    const { tools } = toolsWith((script) => {
      const v = bakedValues(script);
      v[2] = (v[2] ?? 0) + 5; // Premiere "clamped"/moved one keyframe
      return JSON.stringify({ success: true, readback: v, keyCount: v.length });
    });
    const res = await tools.executeTool('bake_keyframe_ease', good);
    expect(res.success).toBe(false);
    expect(res.verified).toBe(false);
    expect(res.mismatches.length).toBeGreaterThan(0);
    expect(res.error).toMatch(/did not read back/);
  });

  it('passes through a host-side scalar refusal', async () => {
    const { tools } = toolsWith(() =>
      JSON.stringify({ success: false, error: "bake_keyframe_ease supports scalar parameters only; 'Position' is not scalar (its value is object)." }),
    );
    const res = await tools.executeTool('bake_keyframe_ease', { ...good, paramName: 'Position' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/scalar/);
  });

  it('passes through a clip-not-found refusal', async () => {
    const { tools } = toolsWith(() => JSON.stringify({ success: false, error: 'Clip not found' }));
    const res = await tools.executeTool('bake_keyframe_ease', good);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Clip not found/);
  });

  it('rejects an invalid time span before touching the bridge', async () => {
    const { tools, executeScript } = toolsWith(() => JSON.stringify({ success: true, readback: [] }));
    const res = await tools.executeTool('bake_keyframe_ease', { ...good, endTime: 0 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/greater than/);
    expect(executeScript).not.toHaveBeenCalled();
  });
});
