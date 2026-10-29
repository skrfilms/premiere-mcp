/**
 * The screen tap: a LIVE view of what Premiere is showing, via ffmpeg's platform
 * screen-capture input device.
 *
 * This is the only real-time tap reachable without compiling a native module, so
 * it is the only way an agent can watch playback rather than inspect a still.
 * It is also the least trustworthy source in the layer, and the code is written
 * to make that impossible to forget: every artifact comes back labelled
 * provenance 'screen-grab' / composited 'unverifiable', carrying the caveats
 * from provenance.ts, and the words "composited render" appear nowhere in its
 * output. If you need to prove the composite, use the render or export tap.
 *
 * Known limits, stated once:
 *   - We cannot find the Program monitor by ourselves (Premiere exposes no
 *     windows to accessibility), so a crop rect must be supplied. Without one
 *     you get the whole display, Premiere's UI included.
 *   - The captured pixels are display-scaled and display-colour-managed.
 *   - Premiere's playback resolution setting (1/2, 1/4) is baked into what the
 *     monitor draws, so a soft screen grab may be the preview being soft, not
 *     the render.
 *   - Time is wall-clock. Any sequence timecode attached to a screen grab is the
 *     caller's assertion, and is labelled as such.
 */

import { promises as fs } from 'node:fs';
import {
  ffmpegCmd,
  fileSize,
  probeDimensions,
  probeFrameCount,
  runBinary,
  binaryAvailable,
  FFMPEG_INSTALL_GUIDANCE,
} from './ffmpeg.js';
import { makeEvidence, timePosition } from './provenance.js';
import type { CaptureEvidence, Known } from './types.js';
import { UNKNOWN } from './types.js';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenInputFormat = 'avfoundation' | 'gdigrab' | 'x11grab';

export interface ScreenTargetSpec {
  inputFormat: ScreenInputFormat;
  /** avfoundation device index, e.g. the index of "Capture screen 0". */
  displayIndex?: number | undefined;
  /** gdigrab/x11grab screen spec, e.g. "desktop" or ":0.0". */
  displaySpec?: string | undefined;
}

/** Pure: reject a crop rect that ffmpeg would silently mangle. */
export function validateCropRect(crop: CropRect): string | null {
  const fields: Array<keyof CropRect> = ['x', 'y', 'width', 'height'];
  for (const f of fields) {
    const v = crop[f];
    if (!Number.isInteger(v))
      return `crop.${f} must be a whole number of pixels (got ${String(v)}).`;
    if (v < 0) return `crop.${f} must not be negative (got ${v}).`;
  }
  if (crop.width < 2 || crop.height < 2)
    return 'crop.width and crop.height must both be at least 2 pixels.';
  return null;
}

/** Pure: the input half of an ffmpeg screen-capture command line. */
export function buildScreenInputArgs(target: ScreenTargetSpec, framerate: number): string[] {
  switch (target.inputFormat) {
    case 'avfoundation':
      return [
        '-f',
        'avfoundation',
        '-capture_cursor',
        '0',
        // avfoundation screen input refuses yuv420p; bgr0 is what it offers.
        '-pixel_format',
        'bgr0',
        '-framerate',
        String(framerate),
        '-i',
        String(target.displayIndex ?? 1),
      ];
    case 'gdigrab':
      return [
        '-f',
        'gdigrab',
        '-framerate',
        String(framerate),
        '-i',
        target.displaySpec || 'desktop',
      ];
    case 'x11grab':
      return ['-f', 'x11grab', '-framerate', String(framerate), '-i', target.displaySpec || ':0.0'];
  }
}

/** Pure: full argv for a single screen still. */
export function buildScreenStillArgs(opts: {
  target: ScreenTargetSpec;
  outputPath: string;
  crop?: CropRect | undefined;
  framerate?: number | undefined;
}): string[] {
  const filters: string[] = [];
  if (opts.crop)
    filters.push(`crop=${opts.crop.width}:${opts.crop.height}:${opts.crop.x}:${opts.crop.y}`);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...buildScreenInputArgs(opts.target, opts.framerate ?? 30),
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-frames:v',
    '1',
    '-update',
    '1',
    '-y',
    opts.outputPath,
  ];
}

/** Pure: full argv for a short screen clip (the live-motion capture). */
export function buildScreenClipArgs(opts: {
  target: ScreenTargetSpec;
  outputPath: string;
  durationSeconds: number;
  framerate?: number | undefined;
  crop?: CropRect | undefined;
  /** Downscale width; height follows the aspect. Keeps the file small for review. */
  scaleWidth?: number | undefined;
}): string[] {
  const filters: string[] = [];
  if (opts.crop)
    filters.push(`crop=${opts.crop.width}:${opts.crop.height}:${opts.crop.x}:${opts.crop.y}`);
  if (opts.scaleWidth) filters.push(`scale=${opts.scaleWidth}:-2`);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...buildScreenInputArgs(opts.target, opts.framerate ?? 30),
    '-t',
    String(opts.durationSeconds),
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-pix_fmt',
    'yuv420p',
    '-y',
    opts.outputPath,
  ];
}

/**
 * Pure: full argv for a CALIBRATION frame -- a full-display grab with a labelled
 * coordinate grid drawn over it. This is the honest substitute for the window
 * geometry macOS will not give us: capture once, read the Program monitor's
 * rectangle off the grid, then pass that crop rect from then on.
 */
export function buildCalibrationArgs(opts: {
  target: ScreenTargetSpec;
  outputPath: string;
  /** Grid pitch in pixels. */
  spacing?: number | undefined;
  /** Path to a .ttf/.ttc. Without one the grid is drawn but not labelled. */
  fontFile?: string | null | undefined;
  /** Display size, needed to know how many labels to draw. */
  displayWidth?: number | undefined;
  displayHeight?: number | undefined;
  framerate?: number | undefined;
}): string[] {
  const spacing = Math.max(50, Math.trunc(opts.spacing ?? 200));
  const filters: string[] = [
    `drawgrid=width=${spacing}:height=${spacing}:thickness=1:color=red@0.5`,
  ];

  if (opts.fontFile) {
    const font = escapeDrawtextValue(opts.fontFile);
    const w = opts.displayWidth ?? 3840;
    const h = opts.displayHeight ?? 2160;
    for (let x = spacing; x < w; x += spacing) {
      filters.push(
        `drawtext=fontfile='${font}':text='x\\=${x}':x=${x + 3}:y=3:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.7`,
      );
    }
    for (let y = spacing; y < h; y += spacing) {
      filters.push(
        `drawtext=fontfile='${font}':text='y\\=${y}':x=3:y=${y + 3}:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.7`,
      );
    }
  }

  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...buildScreenInputArgs(opts.target, opts.framerate ?? 30),
    '-frames:v',
    '1',
    '-vf',
    filters.join(','),
    '-update',
    '1',
    '-y',
    opts.outputPath,
  ];
}

/**
 * Pure: escape a value going inside a single-quoted drawtext option. ffmpeg's
 * filter-graph parser eats ':' and '\' and '''; a Windows font path is full of
 * backslashes and a timecode is full of colons, so this is not cosmetic.
 */
export function escapeDrawtextValue(value: string): string {
  return value.replace(/\\/g, '\\\\\\\\').replace(/'/g, "\\\\'").replace(/:/g, '\\:');
}

/** Font files worth trying, in preference order (monospace first for timecode). */
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Menlo.ttc',
  '/System/Library/Fonts/SFNSMono.ttf',
  '/System/Library/Fonts/Monaco.ttf',
  '/System/Library/Fonts/Courier.ttc',
  '/System/Library/Fonts/Helvetica.ttc',
  'C:\\Windows\\Fonts\\consola.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

/**
 * Find a usable font file for burn-ins, honouring PREMIERE_MCP_CAPTURE_FONT.
 * Returns null when none exists -- callers then skip the burn-in and say they
 * skipped it, rather than shipping an ffmpeg command that will fail.
 */
export async function resolveFontFile(): Promise<string | null> {
  const override = (process.env.PREMIERE_MCP_CAPTURE_FONT || '').trim();
  const candidates = override ? [override, ...FONT_CANDIDATES] : FONT_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

export interface ScreenCaptureResult {
  success: boolean;
  evidence?: CaptureEvidence | undefined;
  error?: string | undefined;
  install?: string | undefined;
  /** The exact argv used, so a human can reproduce or audit the capture. */
  command?: string | undefined;
  /** ffmpeg's stderr tail when something went wrong. */
  ffmpegStderr?: string | undefined;
}

async function runCapture(
  argv: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string; spawnError?: string | undefined; code: number | null }> {
  const res = await runBinary(ffmpegCmd(), argv, timeoutMs);
  return { ok: res.ok, stderr: res.stderr, spawnError: res.spawnError, code: res.code };
}

/** Capture one still off the display. */
export async function captureScreenStill(opts: {
  target: ScreenTargetSpec;
  outputPath: string;
  crop?: CropRect | undefined;
  framerate?: number | undefined;
  /**
   * The sequence time the caller believes was on screen. Recorded, but labelled
   * as an assertion: nothing in a screen grab can confirm it.
   */
  assertedSequenceSeconds?: number | undefined;
  assertedFps?: number | undefined;
  timeoutMs?: number | undefined;
}): Promise<ScreenCaptureResult> {
  if (!(await binaryAvailable(ffmpegCmd()))) {
    return {
      success: false,
      error: `ffmpeg ('${ffmpegCmd()}') was not found. The screen tap is an ffmpeg capture.`,
      install: FFMPEG_INSTALL_GUIDANCE,
    };
  }
  if (opts.crop) {
    const bad = validateCropRect(opts.crop);
    if (bad) return { success: false, error: bad };
  }

  const argv = buildScreenStillArgs(opts);
  const run = await runCapture(argv, opts.timeoutMs ?? 60_000);
  const size = await fileSize(opts.outputPath);
  if (typeof size !== 'number' || size === 0) {
    return {
      success: false,
      error: `No frame was written to ${opts.outputPath}. ${run.spawnError ? `ffmpeg could not start: ${run.spawnError}. ` : ''}On macOS this is usually a missing Screen Recording permission for the process running this server.`,
      install:
        'System Settings > Privacy & Security > Screen Recording: enable the app running this server, then restart it.',
      command: [ffmpegCmd(), ...argv].join(' '),
      ffmpegStderr: run.stderr.slice(-1500),
    };
  }

  const dims = await probeDimensions(opts.outputPath);
  const caveats: string[] = [];
  if (!opts.crop)
    caveats.push(
      "No crop rect was given, so this is the WHOLE display including Premiere's UI, not just the Program monitor.",
    );
  if (typeof opts.assertedSequenceSeconds === 'number') {
    caveats.push(
      'The sequence time on this record was asserted by the caller; a screen grab carries no timecode of its own.',
    );
  } else {
    caveats.push('No sequence time is attached: this frame is located on the wall clock only.');
  }

  return {
    success: true,
    command: [ffmpegCmd(), ...argv].join(' '),
    evidence: makeEvidence({
      tap: 'screen',
      path: opts.outputPath,
      width: dims.width,
      height: dims.height,
      at: timePosition(
        typeof opts.assertedSequenceSeconds === 'number' ? opts.assertedSequenceSeconds : UNKNOWN,
        typeof opts.assertedFps === 'number' ? opts.assertedFps : UNKNOWN,
      ),
      moving: false,
      sizeBytes: size,
      caveats,
    }),
  };
}

/**
 * Capture a short clip off the display: the live tap. This is what lets an agent
 * answer "did playback actually run" and "did the motion look right" instead of
 * inspecting one still -- at the cost of everything in the caveat list.
 */
export async function captureScreenClip(opts: {
  target: ScreenTargetSpec;
  outputPath: string;
  durationSeconds: number;
  framerate?: number | undefined;
  crop?: CropRect | undefined;
  scaleWidth?: number | undefined;
  timeoutMs?: number | undefined;
}): Promise<ScreenCaptureResult & { frameCount?: Known<number> | undefined }> {
  if (!(await binaryAvailable(ffmpegCmd()))) {
    return {
      success: false,
      error: `ffmpeg ('${ffmpegCmd()}') was not found. The screen tap is an ffmpeg capture.`,
      install: FFMPEG_INSTALL_GUIDANCE,
    };
  }
  if (!Number.isFinite(opts.durationSeconds) || opts.durationSeconds <= 0) {
    return { success: false, error: 'durationSeconds must be greater than 0.' };
  }
  if (opts.crop) {
    const bad = validateCropRect(opts.crop);
    if (bad) return { success: false, error: bad };
  }

  const argv = buildScreenClipArgs(opts);
  // Allow the capture its full duration plus encoder/startup slack.
  const timeout = opts.timeoutMs ?? Math.ceil(opts.durationSeconds * 1000) + 30_000;
  const run = await runCapture(argv, timeout);
  const size = await fileSize(opts.outputPath);
  if (typeof size !== 'number' || size === 0) {
    return {
      success: false,
      error: `No clip was written to ${opts.outputPath}. ${run.spawnError ? `ffmpeg could not start: ${run.spawnError}. ` : ''}On macOS this is usually a missing Screen Recording permission for the process running this server.`,
      install:
        'System Settings > Privacy & Security > Screen Recording: enable the app running this server, then restart it.',
      command: [ffmpegCmd(), ...argv].join(' '),
      ffmpegStderr: run.stderr.slice(-1500),
    };
  }

  const [dims, frameCount] = await Promise.all([
    probeDimensions(opts.outputPath),
    probeFrameCount(opts.outputPath),
  ]);

  const caveats: string[] = [
    `Requested ${opts.durationSeconds}s at ${opts.framerate ?? 30}fps; ${typeof frameCount === 'number' ? `${frameCount} frames landed` : 'the frame count could not be read'}. A shortfall means the capture dropped frames, not that the timeline did.`,
  ];
  if (!opts.crop)
    caveats.push(
      "No crop rect was given, so this is the WHOLE display including Premiere's UI, not just the Program monitor.",
    );
  caveats.push(
    'Frames are located on the wall clock. Nothing here maps them to sequence timecodes.',
  );

  return {
    success: true,
    command: [ffmpegCmd(), ...argv].join(' '),
    frameCount,
    evidence: makeEvidence({
      tap: 'screen',
      path: opts.outputPath,
      width: dims.width,
      height: dims.height,
      at: timePosition(UNKNOWN, typeof opts.framerate === 'number' ? opts.framerate : UNKNOWN),
      moving: true,
      sizeBytes: size,
      caveats,
    }),
  };
}

/**
 * Grab one labelled calibration frame of the whole display so a crop rect for
 * the Program monitor can be read off it by eye and reused thereafter.
 */
export async function captureCalibrationFrame(opts: {
  target: ScreenTargetSpec;
  outputPath: string;
  spacing?: number | undefined;
  displayWidth?: number | undefined;
  displayHeight?: number | undefined;
  timeoutMs?: number | undefined;
}): Promise<ScreenCaptureResult & { gridSpacing: number; labelled: boolean }> {
  const spacing = Math.max(50, Math.trunc(opts.spacing ?? 200));
  const fontFile = await resolveFontFile();

  if (!(await binaryAvailable(ffmpegCmd()))) {
    return {
      success: false,
      gridSpacing: spacing,
      labelled: false,
      error: `ffmpeg ('${ffmpegCmd()}') was not found. The screen tap is an ffmpeg capture.`,
      install: FFMPEG_INSTALL_GUIDANCE,
    };
  }

  const argv = buildCalibrationArgs({ ...opts, spacing, fontFile });
  const run = await runCapture(argv, opts.timeoutMs ?? 90_000);
  const size = await fileSize(opts.outputPath);
  if (typeof size !== 'number' || size === 0) {
    return {
      success: false,
      gridSpacing: spacing,
      labelled: Boolean(fontFile),
      error:
        `No calibration frame was written to ${opts.outputPath}. ${run.spawnError ? `ffmpeg could not start: ${run.spawnError}. ` : ''}`.trim(),
      install:
        'System Settings > Privacy & Security > Screen Recording: enable the app running this server, then restart it.',
      command: [ffmpegCmd(), ...argv].join(' '),
      ffmpegStderr: run.stderr.slice(-1500),
    };
  }

  const dims = await probeDimensions(opts.outputPath);
  return {
    success: true,
    gridSpacing: spacing,
    labelled: Boolean(fontFile),
    command: [ffmpegCmd(), ...argv].join(' '),
    evidence: makeEvidence({
      tap: 'screen',
      path: opts.outputPath,
      width: dims.width,
      height: dims.height,
      at: timePosition(UNKNOWN, UNKNOWN),
      moving: false,
      sizeBytes: size,
      caveats: [
        `Calibration aid, not evidence about the edit. Grid pitch ${spacing}px${fontFile ? `, labelled with the font at ${fontFile}` : ' (UNLABELLED: no usable font file was found, so read coordinates by counting cells, or set PREMIERE_MCP_CAPTURE_FONT)'}.`,
        "Coordinates read off this grid are in the captured display's pixel space, which on a scaled Retina display is not the same as macOS point coordinates.",
      ],
    }),
  };
}
