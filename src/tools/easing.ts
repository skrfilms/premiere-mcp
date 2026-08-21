/**
 * Keyframe easing — the honest escape hatch for a denied Premiere API.
 *
 * Premiere's scripting DOM lets you SET a keyframe interpolation type
 * (`setInterpolationTypeAtKey`) but exposes NO getter to read it back, and it
 * has never exposed the temporal-ease *amount* (the bezier handle influence /
 * velocity) to script at all. So a "set the ease and trust it" tool cannot honor
 * verify-after-write — the value that actually renders is unconfirmable.
 *
 * This module takes the honest path instead: it computes the eased VALUE curve
 * itself (any Penner easing, or a CSS-style cubic-bezier) and samples it into a
 * dense run of keyframes. Those keyframe *values* ARE readable back
 * (`getValueAtKey`), so every written point can be verified. The visible motion
 * is the ease the caller asked for, and the tool can prove it landed.
 *
 * Everything here is pure and host-independent: no Premiere, no I/O. The host
 * tool (see index.ts `bakeKeyframeEase`) consumes `sampleEaseKeyframes` and
 * writes/verifies the result.
 */

export interface EaseKeyframe {
  /** Absolute time in seconds. */
  time: number;
  /** Scalar value at that time. */
  value: number;
}

export interface EaseSampleOptions {
  startTime: number;
  endTime: number;
  startValue: number;
  endValue: number;
  /**
   * Number of segments between start and end. The returned run has
   * `samples + 1` keyframes (both endpoints included). More samples = smoother
   * curve at the cost of more keyframes.
   */
  samples: number;
  /** A named easing from EASING_NAMES. Ignored when `bezier` is provided. */
  easing?: string;
  /** CSS-style cubic-bezier control points [x1, y1, x2, y2]; overrides `easing`. */
  bezier?: [number, number, number, number];
}

/** Highest sample count we will bake in one call (keeps keyframe counts sane). */
export const MAX_EASE_SAMPLES = 500;

/**
 * Penner easing functions, each mapping normalized progress p in [0, 1] to an
 * eased fraction (0 at p=0, 1 at p=1 for the monotone families; the Back/Elastic
 * families intentionally overshoot in between). Kept as a plain record so the
 * catalog and validation can enumerate it.
 */
const c1 = 1.70158; // Back overshoot
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;
const n1 = 7.5625;
const d1 = 2.75;

function bounceOut(p: number): number {
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) {
    const x = p - 1.5 / d1;
    return n1 * x * x + 0.75;
  }
  if (p < 2.5 / d1) {
    const x = p - 2.25 / d1;
    return n1 * x * x + 0.9375;
  }
  const x = p - 2.625 / d1;
  return n1 * x * x + 0.984375;
}

export const EASINGS: Record<string, (p: number) => number> = {
  linear: (p) => p,

  easeInSine: (p) => 1 - Math.cos((p * Math.PI) / 2),
  easeOutSine: (p) => Math.sin((p * Math.PI) / 2),
  easeInOutSine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,

  easeInQuad: (p) => p * p,
  easeOutQuad: (p) => 1 - (1 - p) * (1 - p),
  easeInOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),

  easeInCubic: (p) => p * p * p,
  easeOutCubic: (p) => 1 - Math.pow(1 - p, 3),
  easeInOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),

  easeInQuart: (p) => p * p * p * p,
  easeOutQuart: (p) => 1 - Math.pow(1 - p, 4),
  easeInOutQuart: (p) => (p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2),

  easeInQuint: (p) => Math.pow(p, 5),
  easeOutQuint: (p) => 1 - Math.pow(1 - p, 5),
  easeInOutQuint: (p) => (p < 0.5 ? 16 * Math.pow(p, 5) : 1 - Math.pow(-2 * p + 2, 5) / 2),

  easeInExpo: (p) => (p === 0 ? 0 : Math.pow(2, 10 * p - 10)),
  easeOutExpo: (p) => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  easeInOutExpo: (p) =>
    p === 0
      ? 0
      : p === 1
        ? 1
        : p < 0.5
          ? Math.pow(2, 20 * p - 10) / 2
          : (2 - Math.pow(2, -20 * p + 10)) / 2,

  easeInCirc: (p) => 1 - Math.sqrt(1 - Math.pow(p, 2)),
  easeOutCirc: (p) => Math.sqrt(1 - Math.pow(p - 1, 2)),
  easeInOutCirc: (p) =>
    p < 0.5
      ? (1 - Math.sqrt(1 - Math.pow(2 * p, 2))) / 2
      : (Math.sqrt(1 - Math.pow(-2 * p + 2, 2)) + 1) / 2,

  easeInBack: (p) => c3 * p * p * p - c1 * p * p,
  easeOutBack: (p) => 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2),
  easeInOutBack: (p) =>
    p < 0.5
      ? (Math.pow(2 * p, 2) * ((c2 + 1) * 2 * p - c2)) / 2
      : (Math.pow(2 * p - 2, 2) * ((c2 + 1) * (p * 2 - 2) + c2) + 2) / 2,

  easeInElastic: (p) =>
    p === 0 ? 0 : p === 1 ? 1 : -Math.pow(2, 10 * p - 10) * Math.sin((p * 10 - 10.75) * c4),
  easeOutElastic: (p) =>
    p === 0 ? 0 : p === 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1,
  easeInOutElastic: (p) =>
    p === 0
      ? 0
      : p === 1
        ? 1
        : p < 0.5
          ? -(Math.pow(2, 20 * p - 10) * Math.sin((20 * p - 11.125) * c5)) / 2
          : (Math.pow(2, -20 * p + 10) * Math.sin((20 * p - 11.125) * c5)) / 2 + 1,

  easeInBounce: (p) => 1 - bounceOut(1 - p),
  easeOutBounce: bounceOut,
  easeInOutBounce: (p) =>
    p < 0.5 ? (1 - bounceOut(1 - 2 * p)) / 2 : (1 + bounceOut(2 * p - 1)) / 2,
};

/** All known easing names, sorted, for schema enumeration and validation. */
export const EASING_NAMES: string[] = Object.keys(EASINGS).sort();

/** Returns the easing function for `name`, or undefined if unknown. */
export function getEasing(name: string): ((p: number) => number) | undefined {
  return Object.prototype.hasOwnProperty.call(EASINGS, name) ? EASINGS[name] : undefined;
}

/**
 * Builds a CSS-style cubic-bezier easing function from control points
 * P1=(x1,y1), P2=(x2,y2) with implicit P0=(0,0), P3=(1,1). Given progress p
 * (the x axis), it solves for the bezier parameter t, then returns the y value.
 * x1 and x2 must lie in [0, 1] so the curve is a function of x (CSS's rule).
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (p: number) => number {
  if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) {
    throw new Error('cubic-bezier control points must all be finite numbers');
  }
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new Error('cubic-bezier x control points (x1, x2) must be within [0, 1]');
  }

  // Coefficients for the cubic bezier with P0=0, P3=1 on each axis.
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;

  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number): number => {
    // Newton-Raphson from a good seed, with a bisection fallback for flat slopes.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const xEst = sampleX(t) - x;
      const dx = slopeX(t);
      if (Math.abs(xEst) < 1e-7) return t;
      if (Math.abs(dx) < 1e-7) break;
      t -= xEst / dx;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const xEst = sampleX(t);
      if (Math.abs(xEst - x) < 1e-7) return t;
      if (xEst < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (p: number): number => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return sampleY(solveT(p));
  };
}

/**
 * Samples an eased value curve into a run of keyframes. The endpoints are set to
 * the exact start/end values (no float drift), so the animation begins and ends
 * precisely where asked; intermediate keyframes trace the easing shape.
 *
 * Throws on any invalid input rather than silently coercing — the host tool
 * surfaces these as clean refusals before touching Premiere.
 */
export function sampleEaseKeyframes(opts: EaseSampleOptions): EaseKeyframe[] {
  const { startTime, endTime, startValue, endValue, samples } = opts;

  for (const [label, n] of [
    ['startTime', startTime],
    ['endTime', endTime],
    ['startValue', startValue],
    ['endValue', endValue],
  ] as const) {
    if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number`);
  }
  if (endTime <= startTime) {
    throw new Error(`endTime (${endTime}) must be greater than startTime (${startTime})`);
  }
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error(`samples must be an integer >= 1 (got ${samples})`);
  }
  if (samples > MAX_EASE_SAMPLES) {
    throw new Error(`samples must be <= ${MAX_EASE_SAMPLES} (got ${samples})`);
  }

  let ease: (p: number) => number;
  if (opts.bezier) {
    const b = opts.bezier;
    if (b.length !== 4) throw new Error('bezier must be [x1, y1, x2, y2]');
    ease = cubicBezier(b[0], b[1], b[2], b[3]);
  } else {
    const name = opts.easing ?? 'linear';
    const fn = getEasing(name);
    if (!fn) throw new Error(`unknown easing "${name}"; see EASING_NAMES`);
    ease = fn;
  }

  const span = endValue - startValue;
  const out: EaseKeyframe[] = [];
  for (let i = 0; i <= samples; i++) {
    const p = i / samples;
    const time = startTime + (endTime - startTime) * p;
    // Exact endpoints; eased interior.
    const value = i === 0 ? startValue : i === samples ? endValue : startValue + span * ease(p);
    out.push({ time, value });
  }
  return out;
}
