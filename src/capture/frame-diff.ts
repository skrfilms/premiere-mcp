/**
 * Numeric frame comparison: the half of the render-truth loop that makes
 * "nothing changed" provable instead of assumed.
 *
 * An agent that captures a frame, changes the edit, captures again and eyeballs
 * two base64 PNGs is guessing. This module puts a number on it: mean and peak
 * absolute luma difference (0-255), plus PSNR and SSIM, computed by ffmpeg over
 * the actual pixels. A verdict of 'identical' here means every pixel matched --
 * which is exactly the evidence needed to say an instruction did nothing.
 *
 * The parsers and the verdict logic are pure, so the thresholds that decide
 * "changed" versus "codec noise" are testable without spawning anything.
 */

import { ffmpegCmd, probeDimensions, runBinary, binaryAvailable, FFMPEG_INSTALL_GUIDANCE } from './ffmpeg.js';
import type { Known } from './types.js';
import { UNKNOWN } from './types.js';

export interface FrameStats {
  /** signalstats frame index within the diff stream. */
  frame: number;
  /** Mean absolute luma difference, 0-255. 0 means every luma sample matched. */
  meanAbsDiff: number;
  /** Peak absolute luma difference, 0-255. */
  maxAbsDiff: number;
}

export interface DiffMetrics {
  meanAbsDiff: Known<number>;
  maxAbsDiff: Known<number>;
  /** 'infinite' when the images are bit-identical; ffmpeg prints inf. */
  psnrAverage: Known<number> | 'infinite';
  ssimAll: Known<number>;
}

export type DiffVerdict = 'identical' | 'near-identical' | 'changed';

export interface DiffThresholds {
  /** Below this mean absolute difference the change is called codec noise. */
  nearIdenticalMeanAbsDiff: number;
  /** A single pixel differing by more than this is a real change regardless of the mean. */
  nearIdenticalMaxAbsDiff: number;
}

export const DEFAULT_DIFF_THRESHOLDS: DiffThresholds = {
  // A re-encode of the same frame typically lands well under 1/255 mean.
  nearIdenticalMeanAbsDiff: 0.5,
  // 8 levels out of 255 is invisible; more than that is something drawn.
  nearIdenticalMaxAbsDiff: 8,
};

/* ------------------------------------------------------------------ *
 * Pure parsers
 * ------------------------------------------------------------------ */

/**
 * Parse `metadata=print` output from a signalstats chain. Blocks look like:
 *   frame:0    pts:0       pts_time:0
 *   lavfi.signalstats.YAVG=11.5963
 *   lavfi.signalstats.YMAX=151
 */
export function parseSignalstatsMetadata(text: string): FrameStats[] {
  const frames: FrameStats[] = [];
  let current: { frame: number; yavg?: number; ymax?: number } | null = null;

  const flush = () => {
    if (current && current.yavg !== undefined && current.ymax !== undefined) {
      frames.push({ frame: current.frame, meanAbsDiff: current.yavg, maxAbsDiff: current.ymax });
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const frameMatch = /^frame:(\d+)\b/.exec(line);
    if (frameMatch) {
      flush();
      current = { frame: Number(frameMatch[1]) };
      continue;
    }
    const kv = /^lavfi\.signalstats\.(YAVG|YMAX)=([-\d.eE+]+)$/.exec(line);
    if (kv && current) {
      const value = Number(kv[2]);
      if (!Number.isFinite(value)) continue;
      if (kv[1] === 'YAVG') current.yavg = value;
      else current.ymax = value;
    }
  }
  flush();
  return frames;
}

/** Parse ffmpeg's psnr summary line. `inf` means bit-identical. */
export function parsePsnrSummary(stderr: string): Known<number> | 'infinite' {
  const m = /PSNR\s+.*?average:([\d.]+|inf)/.exec(stderr);
  if (!m) return UNKNOWN;
  if (m[1] === 'inf') return 'infinite';
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : UNKNOWN;
}

/** Parse ffmpeg's ssim summary line -> the All value (1 = identical). */
export function parseSsimSummary(stderr: string): Known<number> {
  const m = /SSIM\s+.*?All:([\d.]+)/.exec(stderr);
  if (!m) return UNKNOWN;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : UNKNOWN;
}

/**
 * Pure: turn metrics into a verdict. Unknown metrics produce no verdict -- the
 * caller gets 'changed' only when we measured a change, never by default.
 */
export function classifyDifference(
  metrics: DiffMetrics,
  thresholds: DiffThresholds = DEFAULT_DIFF_THRESHOLDS,
): { verdict: DiffVerdict | 'unknown'; reason: string } {
  const { meanAbsDiff, maxAbsDiff } = metrics;
  if (typeof meanAbsDiff !== 'number' || typeof maxAbsDiff !== 'number') {
    return {
      verdict: 'unknown',
      reason: 'The difference could not be measured, so no verdict is given. Do not read this as "unchanged".',
    };
  }
  if (meanAbsDiff === 0 && maxAbsDiff === 0) {
    return {
      verdict: 'identical',
      reason: 'Every luma sample matched (mean and peak difference both 0). These frames are the same picture.',
    };
  }
  if (meanAbsDiff < thresholds.nearIdenticalMeanAbsDiff && maxAbsDiff <= thresholds.nearIdenticalMaxAbsDiff) {
    return {
      verdict: 'near-identical',
      reason: `Mean difference ${meanAbsDiff.toFixed(4)}/255 with a peak of ${maxAbsDiff}/255: consistent with re-encoding the same picture rather than a change to it.`,
    };
  }
  return {
    verdict: 'changed',
    reason: `Mean difference ${meanAbsDiff.toFixed(4)}/255 with a peak of ${maxAbsDiff}/255: the pixels genuinely differ.`,
  };
}

/* ------------------------------------------------------------------ *
 * Real comparisons
 * ------------------------------------------------------------------ */

export interface DiffResult {
  success: boolean;
  metrics?: DiffMetrics | undefined;
  verdict?: DiffVerdict | 'unknown' | undefined;
  reason?: string | undefined;
  error?: string | undefined;
  install?: string | undefined;
  a?: string | undefined;
  b?: string | undefined;
  /** Reported so a caller knows the comparison was pixel-for-pixel, not scaled. */
  dimensions?: { a: string; b: string; matched: boolean } | undefined;
}

/**
 * Compare two stills. Refuses mismatched dimensions rather than scaling one to
 * the other: a resize would invent pixels and every number after it would be
 * about our resampler, not about the edit.
 */
export async function diffFrames(
  aPath: string,
  bPath: string,
  thresholds: DiffThresholds = DEFAULT_DIFF_THRESHOLDS,
): Promise<DiffResult> {
  const ffmpeg = ffmpegCmd();
  if (!(await binaryAvailable(ffmpeg))) {
    return {
      success: false,
      error: `ffmpeg ('${ffmpeg}') was not found, so frames cannot be compared numerically.`,
      install: FFMPEG_INSTALL_GUIDANCE,
      a: aPath,
      b: bPath,
    };
  }

  const [da, db] = await Promise.all([probeDimensions(aPath), probeDimensions(bPath)]);
  const label = (d: { width: Known<number>; height: Known<number> }) =>
    (typeof d.width === 'number' && typeof d.height === 'number') ? `${d.width}x${d.height}` : UNKNOWN;
  const matched = typeof da.width === 'number' && da.width === db.width && da.height === db.height;
  if (!matched) {
    return {
      success: false,
      error: `Cannot compare frames of different (or unreadable) sizes: ${label(da)} vs ${label(db)}. Rescaling one would make the numbers a property of the resampler rather than of the edit.`,
      a: aPath,
      b: bPath,
      dimensions: { a: label(da), b: label(db), matched: false },
    };
  }

  const statsRes = await runBinary(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', aPath, '-i', bPath,
    '-lavfi', '[0:v][1:v]blend=all_mode=difference,format=gray,signalstats,metadata=print:file=-',
    '-f', 'null', '-',
  ], 120_000);

  const frames = parseSignalstatsMetadata(statsRes.stdout + statsRes.stderr);
  const first = frames[0];

  const qualityRes = await runBinary(ffmpeg, [
    '-hide_banner',
    '-i', aPath, '-i', bPath,
    '-lavfi', '[0:v][1:v]psnr',
    '-f', 'null', '-',
  ], 120_000);
  const ssimRes = await runBinary(ffmpeg, [
    '-hide_banner',
    '-i', aPath, '-i', bPath,
    '-lavfi', '[0:v][1:v]ssim',
    '-f', 'null', '-',
  ], 120_000);

  const metrics: DiffMetrics = {
    meanAbsDiff: first ? first.meanAbsDiff : UNKNOWN,
    maxAbsDiff: first ? first.maxAbsDiff : UNKNOWN,
    psnrAverage: parsePsnrSummary(qualityRes.stderr),
    ssimAll: parseSsimSummary(ssimRes.stderr),
  };

  if (!first) {
    return {
      success: false,
      error: `ffmpeg produced no difference statistics for these frames (exit ${statsRes.code}). ${statsRes.stderr.slice(-400)}`.trim(),
      a: aPath,
      b: bPath,
      metrics,
      dimensions: { a: label(da), b: label(db), matched: true },
    };
  }

  const { verdict, reason } = classifyDifference(metrics, thresholds);
  return {
    success: true,
    metrics,
    verdict,
    reason,
    a: aPath,
    b: bPath,
    dimensions: { a: label(da), b: label(db), matched: true },
  };
}

/* ------------------------------------------------------------------ *
 * Motion
 * ------------------------------------------------------------------ */

export interface MotionPair {
  fromIndex: number;
  toIndex: number;
  from: string;
  to: string;
  meanAbsDiff: Known<number>;
  maxAbsDiff: Known<number>;
  verdict: DiffVerdict | 'unknown';
}

export interface MotionSummary {
  /** True only when at least one consecutive pair genuinely differs. */
  moved: boolean;
  /** Pairs whose pixels were identical or near-identical. */
  staticPairs: MotionPair[];
  movingPairs: MotionPair[];
  /** Pairs we could not measure. Never counted as either. */
  unmeasuredPairs: MotionPair[];
  meanOfMeans: Known<number>;
  conclusion: string;
}

/**
 * Pure: aggregate consecutive-pair diffs into a motion verdict. Unmeasured pairs
 * are held separately and never rounded into "static" -- a failed measurement is
 * not evidence of a frozen picture.
 */
export function summarizeMotion(pairs: MotionPair[]): MotionSummary {
  const measured = pairs.filter((p) => p.verdict !== 'unknown');
  const unmeasured = pairs.filter((p) => p.verdict === 'unknown');
  const moving = measured.filter((p) => p.verdict === 'changed');
  const still = measured.filter((p) => p.verdict !== 'changed');
  const means = measured.map((p) => p.meanAbsDiff).filter((v): v is number => typeof v === 'number');
  const meanOfMeans = means.length ? Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 10_000) / 10_000 : UNKNOWN;

  let conclusion: string;
  if (pairs.length === 0) {
    conclusion = 'No consecutive frame pairs were supplied, so nothing can be said about motion.';
  } else if (measured.length === 0) {
    conclusion = `None of the ${pairs.length} frame pair(s) could be measured. This is not evidence that the picture is frozen.`;
  } else if (moving.length === 0) {
    conclusion = `All ${measured.length} measured pair(s) were identical or near-identical: the picture does not change across this range. If motion was expected, it is not there.`;
  } else if (still.length === 0) {
    conclusion = `All ${measured.length} measured pair(s) differ: the picture changes continuously across this range.`;
  } else {
    conclusion = `${moving.length} of ${measured.length} measured pair(s) differ; ${still.length} pair(s) are static (frames ${still.map((p) => `${p.fromIndex}->${p.toIndex}`).join(', ')}). A run of static pairs inside a moving range is where a freeze, a held frame or a missing render would show up.`;
  }
  if (unmeasured.length) {
    conclusion += ` ${unmeasured.length} pair(s) could not be measured and are excluded from the verdict.`;
  }

  return { moved: moving.length > 0, staticPairs: still, movingPairs: moving, unmeasuredPairs: unmeasured, meanOfMeans, conclusion };
}

/**
 * Diff every consecutive pair in an ordered list of stills and summarise it.
 * This is the "did the clip actually move" answer.
 */
export async function analyzeMotion(
  framePaths: string[],
  thresholds: DiffThresholds = DEFAULT_DIFF_THRESHOLDS,
): Promise<{ success: boolean; summary?: MotionSummary; pairs: MotionPair[]; error?: string; install?: string }> {
  if (framePaths.length < 2) {
    return { success: false, pairs: [], error: 'At least two frames are needed to say anything about motion.' };
  }
  const ffmpeg = ffmpegCmd();
  if (!(await binaryAvailable(ffmpeg))) {
    return {
      success: false,
      pairs: [],
      error: `ffmpeg ('${ffmpeg}') was not found, so motion cannot be measured.`,
      install: FFMPEG_INSTALL_GUIDANCE,
    };
  }

  const pairs: MotionPair[] = [];
  for (let i = 0; i < framePaths.length - 1; i += 1) {
    const from = framePaths[i] as string;
    const to = framePaths[i + 1] as string;
    const res = await diffFrames(from, to, thresholds);
    pairs.push({
      fromIndex: i,
      toIndex: i + 1,
      from,
      to,
      meanAbsDiff: res.metrics?.meanAbsDiff ?? UNKNOWN,
      maxAbsDiff: res.metrics?.maxAbsDiff ?? UNKNOWN,
      verdict: res.success ? (res.verdict ?? 'unknown') : 'unknown',
    });
  }

  return { success: true, pairs, summary: summarizeMotion(pairs) };
}
