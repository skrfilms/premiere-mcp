/**
 * Sequence-RANGE capture: motion evidence, not one still.
 *
 * A single composited frame answers "what does it look like there". It cannot
 * answer "did the clip actually move", "did the transition actually appear",
 * "is the frame at 00:00:04:12 the one the edit implies". Those need several
 * frames from a known time grid, each labelled with the timecode it claims to
 * be, plus a numeric comparison between them.
 *
 * The frames come from an injected FrameSource, so this module never talks to
 * Premiere itself:
 *   - `renderTapFrameSource` wraps the existing render/export tap: each frame is
 *     a composited render. Slow (one Premiere round trip per frame), highest
 *     trust.
 *   - `mediaFileFrameSource` decodes frames out of a file with ffmpeg. Point it
 *     at a Premiere EXPORT of the range and the frames are still composited
 *     renders, obtained in one export instead of N round trips; point it at raw
 *     footage and they are source frames, labelled as such.
 *
 * Diffs are always computed on the RAW frames, never the burnt-in copies -- text
 * drawn over a picture is a pixel change, and measuring it would report motion
 * that is only our own annotation.
 */

import { promises as fs } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import {
  ffmpegCmd,
  fileSize,
  probeDimensions,
  runBinary,
  binaryAvailable,
  FFMPEG_INSTALL_GUIDANCE,
} from './ffmpeg.js';
import { escapeDrawtextValue, resolveFontFile } from './screen-tap.js';
import { makeEvidence, secondsToTimecode, timePosition } from './provenance.js';
import {
  analyzeMotion,
  DEFAULT_DIFF_THRESHOLDS,
  type DiffThresholds,
  type MotionSummary,
} from './frame-diff.js';
import type { CaptureEvidence, CaptureTapKind, Known } from './types.js';
import { UNKNOWN } from './types.js';

/* ------------------------------------------------------------------ *
 * Planning (pure)
 * ------------------------------------------------------------------ */

export interface PlannedFrame {
  index: number;
  /** Frame-snapped time in seconds. */
  seconds: number;
  /** Frame number at fps. */
  frame: number;
  timecode: string;
}

export interface FramePlan {
  frames: PlannedFrame[];
  fps: number;
  warnings: string[];
  error?: string | undefined;
}

/**
 * Pure: work out exactly which frames to capture over a range.
 *
 * Every returned time is snapped onto the frame grid, because a request for
 * t=1.037s on a 24fps timeline is a request for a frame that does not exist and
 * whichever neighbour Premiere returns would silently disagree with the
 * timecode we then burn into it.
 *
 * Supply either `count` (evenly spaced, inclusive of both ends) or
 * `everyNFrames` (a fixed stride). Nothing is defaulted silently: with neither,
 * you get an error.
 */
export function planFrameTimes(opts: {
  startSeconds: number;
  endSeconds: number;
  fps: number;
  count?: number | undefined;
  everyNFrames?: number | undefined;
  /** Cap on how many frames may be planned, to keep a range capture bounded. */
  maxFrames?: number | undefined;
}): FramePlan {
  const warnings: string[] = [];
  const { startSeconds, endSeconds, fps } = opts;
  const maxFrames = opts.maxFrames ?? 64;

  if (!Number.isFinite(fps) || fps <= 0) {
    return {
      frames: [],
      fps: 0,
      warnings,
      error: 'A positive frame rate is required to snap capture times onto real frames.',
    };
  }
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return {
      frames: [],
      fps,
      warnings,
      error: 'startSeconds and endSeconds must both be finite numbers.',
    };
  }
  if (endSeconds < startSeconds) {
    return {
      frames: [],
      fps,
      warnings,
      error: `endSeconds (${endSeconds}) is before startSeconds (${startSeconds}).`,
    };
  }
  if (opts.count === undefined && opts.everyNFrames === undefined) {
    return {
      frames: [],
      fps,
      warnings,
      error:
        'Specify either count (how many frames to sample over the range) or everyNFrames (a fixed frame stride). Neither is defaulted.',
    };
  }

  const startFrame = Math.round(startSeconds * fps);
  const endFrame = Math.round(endSeconds * fps);
  const spanFrames = endFrame - startFrame;

  let frameNumbers: number[] = [];
  if (opts.everyNFrames !== undefined) {
    const stride = Math.trunc(opts.everyNFrames);
    if (!Number.isFinite(stride) || stride < 1) {
      return {
        frames: [],
        fps,
        warnings,
        error: `everyNFrames must be a whole number >= 1 (got ${String(opts.everyNFrames)}).`,
      };
    }
    for (let f = startFrame; f <= endFrame; f += stride) frameNumbers.push(f);
  } else {
    const count = Math.trunc(opts.count as number);
    if (!Number.isFinite(count) || count < 1) {
      return {
        frames: [],
        fps,
        warnings,
        error: `count must be a whole number >= 1 (got ${String(opts.count)}).`,
      };
    }
    if (count === 1) {
      frameNumbers = [startFrame];
    } else if (spanFrames === 0) {
      warnings.push(
        `The range is a single frame (${startFrame}), so ${count} samples collapse to 1.`,
      );
      frameNumbers = [startFrame];
    } else {
      for (let i = 0; i < count; i += 1) {
        frameNumbers.push(startFrame + Math.round((spanFrames * i) / (count - 1)));
      }
    }
  }

  // Snapping can collide when the stride is finer than one frame.
  const deduped = [...new Set(frameNumbers)].sort((a, b) => a - b);
  if (deduped.length !== frameNumbers.length) {
    warnings.push(
      `${frameNumbers.length - deduped.length} requested sample(s) landed on a frame already being captured and were dropped: at ${fps}fps this range only contains ${spanFrames + 1} distinct frame(s).`,
    );
  }

  let final = deduped;
  if (final.length > maxFrames) {
    warnings.push(
      `Plan trimmed from ${final.length} to the ${maxFrames}-frame cap. Raise maxFrames deliberately, or capture a shorter range.`,
    );
    final = final.slice(0, maxFrames);
  }

  return {
    fps,
    warnings,
    frames: final.map((frame, index) => ({
      index,
      frame,
      seconds: Math.round((frame / fps) * 1e6) / 1e6,
      timecode: secondsToTimecode(frame / fps, fps),
    })),
  };
}

/** Pure: choose a contact-sheet grid. Columns first, rows follow. */
export function planContactSheetGrid(
  frameCount: number,
  columns?: number,
): { columns: number; rows: number } {
  const n = Math.max(1, Math.trunc(frameCount));
  const cols = columns && columns > 0 ? Math.trunc(columns) : Math.min(n, Math.ceil(Math.sqrt(n)));
  return { columns: cols, rows: Math.ceil(n / cols) };
}

/* ------------------------------------------------------------------ *
 * ffmpeg argument builders (pure)
 * ------------------------------------------------------------------ */

/** Pure: argv to burn a label into the top-left of a still. */
export function buildBurnInArgs(opts: {
  inputPath: string;
  outputPath: string;
  fontFile: string;
  text: string;
  fontSize?: number | undefined;
}): string[] {
  const size = opts.fontSize ?? 24;
  const filter = [
    `drawtext=fontfile='${escapeDrawtextValue(opts.fontFile)}'`,
    `text='${escapeDrawtextValue(opts.text)}'`,
    `x=${Math.round(size / 2)}`,
    `y=${Math.round(size / 2)}`,
    `fontsize=${size}`,
    'fontcolor=white',
    'box=1',
    'boxcolor=black@0.75',
    `boxborderw=${Math.max(2, Math.round(size / 4))}`,
  ].join(':');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    opts.inputPath,
    '-vf',
    filter,
    '-frames:v',
    '1',
    '-update',
    '1',
    '-y',
    opts.outputPath,
  ];
}

/** Pure: argv to tile a numbered PNG sequence into one contact sheet. */
export function buildContactSheetArgs(opts: {
  /** A printf pattern, e.g. /tmp/x/strip_%04d.png */
  inputPattern: string;
  outputPath: string;
  columns: number;
  rows: number;
  margin?: number | undefined;
  padding?: number | undefined;
}): string[] {
  const margin = opts.margin ?? 6;
  const padding = opts.padding ?? 6;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    '1',
    '-i',
    opts.inputPattern,
    '-vf',
    `tile=${opts.columns}x${opts.rows}:margin=${margin}:padding=${padding}:color=black`,
    '-frames:v',
    '1',
    '-update',
    '1',
    '-y',
    opts.outputPath,
  ];
}

/** Pure: argv to turn a numbered PNG sequence into a reviewable clip. */
export function buildMotionClipArgs(opts: {
  inputPattern: string;
  outputPath: string;
  /** Playback rate of the strip, NOT the sequence's rate. */
  framerate?: number | undefined;
}): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    String(opts.framerate ?? 6),
    '-i',
    opts.inputPattern,
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-pix_fmt',
    'yuv420p',
    '-y',
    opts.outputPath,
  ];
}

/* ------------------------------------------------------------------ *
 * Frame sources
 * ------------------------------------------------------------------ */

export interface FrameRequest {
  index: number;
  seconds: number;
  frame: number;
  timecode: string;
  outputPath: string;
}

export interface FrameSourceResult {
  success: boolean;
  /** Where the frame actually landed (a tap may rewrite the extension). */
  path?: string | undefined;
  error?: string | undefined;
}

export interface FrameSource {
  /** Which tap this source represents -- decides the provenance label. */
  tap: CaptureTapKind;
  /** Human-readable description of where the frames come from. */
  description: string;
  capture(req: FrameRequest): Promise<FrameSourceResult>;
}

/**
 * Wrap the existing render/export tap. `exportFrameFn` is the tool layer's
 * `exportFrame(sequenceId, timeSeconds, outputPath, format)`; passing it in keeps
 * this module free of any dependency on the tool layer or the bridge.
 */
export function renderTapFrameSource(
  exportFrameFn: (
    sequenceId: string,
    time: number,
    outputPath: string,
    format: string,
  ) => Promise<any>,
  sequenceId: string,
  format: 'png' | 'jpg' | 'tiff' = 'png',
): FrameSource {
  return {
    tap: 'render',
    description: `Premiere's own frame export on sequence ${sequenceId} (composited render, one host round trip per frame)`,
    async capture(req) {
      const res = await exportFrameFn(sequenceId, req.seconds, req.outputPath, format);
      if (res && res.success) {
        return { success: true, path: res.outputPath || req.outputPath };
      }
      return {
        success: false,
        error: (res && res.error) || `Premiere returned no frame for t=${req.seconds}s.`,
      };
    },
  };
}

/**
 * Decode frames out of a media file with ffmpeg.
 *
 * `tap` decides what the frames are called, and it matters: pass 'export-file'
 * for a file Premiere exported from the sequence (still a composited render) and
 * 'media-file' for raw footage (a source frame that proves nothing about the
 * timeline). The default is the cautious one.
 */
export function mediaFileFrameSource(
  mediaPath: string,
  tap: 'media-file' | 'export-file' = 'media-file',
): FrameSource {
  return {
    tap,
    description:
      tap === 'export-file'
        ? `Frames decoded from the Premiere export at ${mediaPath} (composited render, read back off disk)`
        : `Frames decoded from the source media at ${mediaPath} (no timeline composite)`,
    async capture(req) {
      const res = await runBinary(
        ffmpegCmd(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          // -ss before -i is the fast seek; ffmpeg then decodes the frame at that
          // point. Accurate for our purposes because we ask for keyframe-accurate
          // decode with -accurate_seek (default when -ss precedes -i for files).
          '-accurate_seek',
          '-ss',
          String(req.seconds),
          '-i',
          mediaPath,
          '-frames:v',
          '1',
          '-update',
          '1',
          '-y',
          req.outputPath,
        ],
        60_000,
      );
      const size = await fileSize(req.outputPath);
      if (typeof size === 'number' && size > 0) return { success: true, path: req.outputPath };
      return {
        success: false,
        error:
          `ffmpeg wrote no frame at t=${req.seconds}s from ${mediaPath} (exit ${res.code}). ${res.stderr.slice(-300)}`.trim(),
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * The range capture
 * ------------------------------------------------------------------ */

export interface FrameStripResult {
  success: boolean;
  error?: string | undefined;
  install?: string | undefined;
  /** The frame plan actually executed. */
  plan?: FramePlan | undefined;
  /** Where the frames came from, in words. */
  source?: string | undefined;
  /** One record per frame, raw (un-annotated) pixels. */
  frames: CaptureEvidence[];
  /** Frames the source failed to produce. Reported, never skipped over. */
  failures: Array<{ index: number; seconds: number; timecode: string; error: string }>;
  /** Contact sheet of the labelled frames. */
  contactSheet?: CaptureEvidence | undefined;
  /** Short clip of the labelled frames, for reviewing the move. */
  motionClip?: CaptureEvidence | undefined;
  /** Numeric proof of whether the picture changes across the range. */
  motion?: MotionSummary | undefined;
  /** True when timecodes were burnt into the sheet/clip frames. */
  burnedIn: boolean;
  notes: string[];
}

/**
 * Capture a range of frames, label each with the timecode it claims to be,
 * assemble a contact sheet and a review clip, and measure whether the picture
 * actually changes between them.
 */
export async function captureFrameStrip(opts: {
  source: FrameSource;
  plan: FramePlan;
  /** Directory for the frames and assembled artifacts. Created if absent. */
  workDir: string;
  /** Basename prefix for the artifacts. */
  prefix?: string | undefined;
  columns?: number | undefined;
  /** Playback rate of the review clip. */
  reviewFps?: number | undefined;
  /** Skip the burn-in (raw frames only). */
  skipBurnIn?: boolean | undefined;
  /** Skip the review clip (contact sheet only). */
  skipMotionClip?: boolean | undefined;
  /** Extra text to burn in alongside the timecode, e.g. a sequence name. */
  label?: string | undefined;
  diffThresholds?: DiffThresholds | undefined;
}): Promise<FrameStripResult> {
  const notes: string[] = [];
  const failures: FrameStripResult['failures'] = [];
  const frames: CaptureEvidence[] = [];

  if (opts.plan.error) {
    return { success: false, error: opts.plan.error, frames, failures, burnedIn: false, notes };
  }
  if (opts.plan.frames.length === 0) {
    return {
      success: false,
      error: 'The frame plan is empty, so there is nothing to capture.',
      frames,
      failures,
      burnedIn: false,
      notes,
    };
  }

  const ffmpeg = ffmpegCmd();
  const ffmpegOk = await binaryAvailable(ffmpeg);
  const prefix = opts.prefix || 'strip';
  await fs.mkdir(opts.workDir, { recursive: true });

  // 1. Capture the raw frames.
  for (const planned of opts.plan.frames) {
    const outPath = join(
      opts.workDir,
      `${prefix}_raw_${String(planned.index).padStart(4, '0')}.png`,
    );
    const res = await opts.source.capture({ ...planned, outputPath: outPath });
    if (!res.success || !res.path) {
      failures.push({
        index: planned.index,
        seconds: planned.seconds,
        timecode: planned.timecode,
        error: res.error || 'The frame source reported no frame and no reason.',
      });
      continue;
    }
    const [dims, size] = await Promise.all([
      ffmpegOk
        ? probeDimensions(res.path)
        : Promise.resolve({ width: UNKNOWN as Known<number>, height: UNKNOWN as Known<number> }),
      fileSize(res.path),
    ]);
    frames.push(
      makeEvidence({
        tap: opts.source.tap,
        path: res.path,
        width: dims.width,
        height: dims.height,
        at: timePosition(planned.seconds, opts.plan.fps),
        moving: false,
        sizeBytes: size,
        caveats: ffmpegOk
          ? []
          : ['Resolution is unknown: ffprobe was not runnable, so the frame was not measured.'],
      }),
    );
  }

  if (frames.length === 0) {
    return {
      success: false,
      error: `The frame source produced no frames at all (${failures.length} attempt(s) failed). First failure: ${failures[0]?.error ?? 'unknown'}`,
      plan: opts.plan,
      source: opts.source.description,
      frames,
      failures,
      burnedIn: false,
      notes,
    };
  }
  if (failures.length) {
    notes.push(
      `${failures.length} of ${opts.plan.frames.length} planned frame(s) failed and are absent from the sheet. The gaps are real, not cosmetic.`,
    );
  }

  // 2. Measure motion on the RAW frames, before anything is drawn on them.
  const rawPaths = frames.map((f) => f.path).filter((p): p is string => typeof p === 'string');
  let motion: MotionSummary | undefined;
  if (rawPaths.length >= 2) {
    const analysis = await analyzeMotion(rawPaths, opts.diffThresholds ?? DEFAULT_DIFF_THRESHOLDS);
    motion = analysis.summary;
    if (!analysis.success) notes.push(`Motion could not be measured: ${analysis.error}`);
  } else {
    notes.push('Only one frame was captured, so motion was not measured.');
  }

  if (!ffmpegOk) {
    return {
      success: true,
      plan: opts.plan,
      source: opts.source.description,
      frames,
      failures,
      motion,
      burnedIn: false,
      notes: [
        ...notes,
        `ffmpeg ('${ffmpeg}') is not runnable, so no burn-in, contact sheet or review clip was produced. The raw frames above are still real.`,
      ],
      install: FFMPEG_INSTALL_GUIDANCE,
    };
  }

  // 3. Burn the timecode in, so a reader can tell WHICH frame they are looking at.
  const fontFile = opts.skipBurnIn ? null : await resolveFontFile();
  let burnedIn = false;
  const sheetInputs: string[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    const evidence = frames[i] as CaptureEvidence;
    const src = evidence.path;
    if (typeof src !== 'string') continue;
    const seqPath = join(opts.workDir, `${prefix}_sheet_${String(i).padStart(4, '0')}.png`);
    if (fontFile) {
      const text = [
        opts.label ? `${opts.label}  ` : '',
        evidence.at.timecode === UNKNOWN ? 'tc unknown' : evidence.at.timecode,
        evidence.at.frame === UNKNOWN ? '' : `  f${evidence.at.frame}`,
      ].join('');
      const res = await runBinary(
        ffmpeg,
        buildBurnInArgs({ inputPath: src, outputPath: seqPath, fontFile, text }),
        60_000,
      );
      const size = await fileSize(seqPath);
      if (res.ok && typeof size === 'number' && size > 0) {
        burnedIn = true;
        sheetInputs.push(seqPath);
        continue;
      }
      notes.push(
        `Burn-in failed for frame ${i} (${evidence.at.timecode}); the unlabelled frame was used instead.`,
      );
    }
    await fs.copyFile(src, seqPath);
    sheetInputs.push(seqPath);
  }
  if (!fontFile && !opts.skipBurnIn) {
    notes.push(
      'No usable font file was found, so the contact sheet is UNLABELLED: the frame order is the plan order, but no timecode is drawn on the pixels. Set PREMIERE_MCP_CAPTURE_FONT to a .ttf/.ttc to get burn-ins.',
    );
  }

  const pattern = join(opts.workDir, `${prefix}_sheet_%04d.png`);

  // 4. Contact sheet.
  let contactSheet: CaptureEvidence | undefined;
  const grid = planContactSheetGrid(sheetInputs.length, opts.columns);
  const sheetPath = join(opts.workDir, `${prefix}_contactsheet.png`);
  const sheetRes = await runBinary(
    ffmpeg,
    buildContactSheetArgs({
      inputPattern: pattern,
      outputPath: sheetPath,
      columns: grid.columns,
      rows: grid.rows,
    }),
    120_000,
  );
  const sheetSize = await fileSize(sheetPath);
  if (typeof sheetSize === 'number' && sheetSize > 0) {
    const dims = await probeDimensions(sheetPath);
    contactSheet = makeEvidence({
      tap: opts.source.tap,
      path: sheetPath,
      width: dims.width,
      height: dims.height,
      at: timePosition((frames[0] as CaptureEvidence).at.seconds, opts.plan.fps),
      moving: false,
      sizeBytes: sheetSize,
      caveats: [
        `Composite of ${sheetInputs.length} frame(s) in a ${grid.columns}x${grid.rows} grid, reading left to right, top to bottom, in ascending sequence time.`,
        burnedIn
          ? 'Each cell carries the timecode of the frame it holds, burnt into the pixels.'
          : 'Cells are NOT labelled: match them to the plan by position only.',
        'The grid layout is ours. Nothing about the spacing of the cells reflects the timeline.',
      ],
    });
  } else {
    notes.push(
      `The contact sheet could not be assembled (ffmpeg exit ${sheetRes.code}): ${sheetRes.stderr.slice(-300)}`,
    );
  }

  // 5. Review clip.
  let motionClip: CaptureEvidence | undefined;
  if (!opts.skipMotionClip && sheetInputs.length >= 2) {
    const clipPath = join(opts.workDir, `${prefix}_review.mp4`);
    const reviewFps = opts.reviewFps ?? 6;
    const clipRes = await runBinary(
      ffmpeg,
      buildMotionClipArgs({ inputPattern: pattern, outputPath: clipPath, framerate: reviewFps }),
      120_000,
    );
    const clipSize = await fileSize(clipPath);
    if (typeof clipSize === 'number' && clipSize > 0) {
      const dims = await probeDimensions(clipPath);
      motionClip = makeEvidence({
        tap: opts.source.tap,
        path: clipPath,
        width: dims.width,
        height: dims.height,
        at: timePosition((frames[0] as CaptureEvidence).at.seconds, opts.plan.fps),
        moving: true,
        sizeBytes: clipSize,
        caveats: [
          `Played back at ${reviewFps}fps from ${sheetInputs.length} sampled frame(s). This is NOT the sequence's real-time motion: the sampling interval and this playback rate together decide how fast it looks.`,
          'Use it to see WHAT changes between the sampled frames, never to judge timing or speed.',
        ],
      });
    } else {
      notes.push(
        `The review clip could not be assembled (ffmpeg exit ${clipRes.code}): ${clipRes.stderr.slice(-300)}`,
      );
    }
  }

  return {
    success: true,
    plan: opts.plan,
    source: opts.source.description,
    frames,
    failures,
    contactSheet,
    motionClip,
    motion,
    burnedIn,
    notes: [...notes, ...opts.plan.warnings],
  };
}

/** Convenience for callers that already have a file path and want its stem. */
export function stemOf(path: string): string {
  return join(dirname(path), basename(path, extname(path)));
}
