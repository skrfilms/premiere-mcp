/**
 * The provenance labelling scheme, in one place, as pure functions.
 *
 * The rule this file exists to enforce: a screen grab must never be able to
 * present itself as a composited render. Callers do not get to pass a
 * provenance string of their choosing alongside a tap -- they name the tap and
 * the label follows from it, together with the caveats that tap can never shake
 * off.
 */

import type {
  CaptureEvidence,
  CaptureProvenance,
  CaptureTapKind,
  CaptureTimePosition,
  CompositedVerdict,
  Known,
} from './types.js';
import { UNKNOWN } from './types.js';

/** The single source of truth for tap -> provenance. Not overridable. */
const TAP_PROVENANCE: Record<CaptureTapKind, CaptureProvenance> = {
  render: 'composited-render',
  'export-file': 'composited-render',
  'media-file': 'source-frame',
  screen: 'screen-grab',
  ndi: 'screen-grab', // a Transmit-style feed is the program feed, but see caveats
  syphon: 'screen-grab',
  spout: 'screen-grab',
};

const TAP_COMPOSITED: Record<CaptureTapKind, CompositedVerdict> = {
  render: 'yes',
  'export-file': 'yes',
  'media-file': 'no',
  screen: 'unverifiable',
  ndi: 'unverifiable',
  syphon: 'unverifiable',
  spout: 'unverifiable',
};

/**
 * The caveats a tap can never shed, regardless of how the capture went. These
 * are appended to whatever the caller reports, so a screen grab is always
 * carrying its warning label.
 */
const TAP_INHERENT_CAVEATS: Record<CaptureTapKind, string[]> = {
  render: [
    "Rendered by Premiere at export quality, which can differ from the Program monitor's playback-resolution preview.",
  ],
  'export-file': [
    "These are the pixels of the exported FILE. If the export preset scaled, cropped or re-encoded the sequence, the difference from the timeline is the preset's, not the edit's.",
  ],
  'media-file': [
    'Decoded from a source file: no timeline composite. Nothing here reflects effects, transitions, opacity, or clips on higher tracks.',
  ],
  screen: [
    "SCREEN CAPTURE, not a composited render. Nothing in these pixels proves they came from Premiere's Program monitor.",
    'Another window may have been in front, the panel may have been scrolled or resized, and the monitor may have been at reduced playback resolution.',
    "Scaled by the display and subject to the display's colour management, so it is not colour-accurate evidence.",
    'The frame time is the moment of capture on the wall clock, not a sequence timecode, unless one was supplied by the caller.',
  ],
  ndi: [
    'Real-time network feed via a Transmit-style plugin. Whether it carries the Program feed (and at what quality) is decided by that plugin, not by us.',
  ],
  syphon: [
    'Real-time GPU texture feed. Whether it carries the Program feed is decided by the publishing plugin, not by us.',
  ],
  spout: [
    'Real-time GPU texture feed. Whether it carries the Program feed is decided by the publishing plugin, not by us.',
  ],
};

export function provenanceForTap(tap: CaptureTapKind): CaptureProvenance {
  return TAP_PROVENANCE[tap] ?? 'unknown';
}

export function compositedForTap(tap: CaptureTapKind): CompositedVerdict {
  return TAP_COMPOSITED[tap] ?? 'unverifiable';
}

export function inherentCaveats(tap: CaptureTapKind): string[] {
  return [
    ...(TAP_INHERENT_CAVEATS[tap] ?? ['Unrecognised tap: treat this artifact as untrusted.']),
  ];
}

/** One line an agent can put in front of a human without misleading them. */
export function describeProvenance(
  evidence: Pick<CaptureEvidence, 'provenance' | 'composited' | 'tap'>,
): string {
  switch (evidence.provenance) {
    case 'composited-render':
      return `Composited render from the '${evidence.tap}' tap: Premiere rendered these pixels through the sequence, so effects, transitions and upper tracks are included.`;
    case 'source-frame':
      return `Source frame from the '${evidence.tap}' tap: decoded straight from a media file, so it shows NOTHING the timeline adds.`;
    case 'screen-grab':
      return `Screen grab from the '${evidence.tap}' tap: whatever was on the display. Composited by Premiere: ${evidence.composited}. Do not treat as a render.`;
    default:
      return `Unknown provenance from the '${evidence.tap}' tap: treat as untrusted.`;
  }
}

/** Zero-pad to a fixed width. */
function pad(n: number, width: number): string {
  return String(Math.abs(Math.trunc(n))).padStart(width, '0');
}

/**
 * Seconds -> HH:MM:SS:FF at `fps`, non-drop-frame.
 *
 * Deliberately NDF only: drop-frame renumbering would need the sequence's own
 * display format, which lives in Premiere, and inventing it here would be
 * exactly the kind of quiet default this layer exists to avoid. For 29.97/59.94
 * timelines displayed as drop-frame the numbers here are the NDF equivalents,
 * and `timecodeIsDropFrame` reports false so a caller can tell.
 */
export function secondsToTimecode(seconds: number, fps: number): string {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0) return UNKNOWN;
  const totalFrames = Math.round(seconds * fps);
  return framesToTimecode(totalFrames, fps);
}

/** Frame number -> HH:MM:SS:FF at `fps`, non-drop-frame. */
export function framesToTimecode(frames: number, fps: number): string {
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || fps <= 0) return UNKNOWN;
  // A fractional rate (23.976, 29.97) still numbers frames 0..ceil(fps)-1.
  const framesPerSecond = Math.round(fps);
  const sign = frames < 0 ? '-' : '';
  const f = Math.abs(Math.trunc(frames));
  const ff = f % framesPerSecond;
  const totalSeconds = Math.floor(f / framesPerSecond);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return `${sign}${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}:${pad(ff, 2)}`;
}

/** HH:MM:SS:FF -> frame number at `fps`, non-drop-frame. Returns undefined on junk. */
export function timecodeToFrames(timecode: string, fps: number): number | undefined {
  if (!Number.isFinite(fps) || fps <= 0) return undefined;
  const m = /^(-)?(\d{1,3}):([0-5]?\d):([0-5]?\d)[:;](\d{1,3})$/.exec(timecode.trim());
  if (!m) return undefined;
  const framesPerSecond = Math.round(fps);
  const ff = Number(m[5]);
  if (ff >= framesPerSecond) return undefined;
  const frames = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * framesPerSecond + ff;
  return m[1] ? -frames : frames;
}

/** Build a fully-populated time position, marking anything unknowable. */
export function timePosition(seconds: Known<number>, fps: Known<number>): CaptureTimePosition {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return {
      seconds: UNKNOWN,
      frame: UNKNOWN,
      timecode: UNKNOWN,
      fps: typeof fps === 'number' ? fps : UNKNOWN,
    };
  }
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    // We know when, but not in what frame grid -- so frame and timecode stay unknown.
    return { seconds, frame: UNKNOWN, timecode: UNKNOWN, fps: UNKNOWN };
  }
  return {
    seconds,
    frame: Math.round(seconds * fps),
    timecode: secondsToTimecode(seconds, fps),
    fps,
  };
}

/**
 * Assemble a CaptureEvidence record. Provenance, the composited verdict and the
 * inherent caveats are derived from the tap -- a caller cannot dress one tap up
 * as another. Anything genuinely unknown must be passed as 'unknown'.
 */
export function makeEvidence(input: {
  tap: CaptureTapKind;
  path: Known<string>;
  width: Known<number>;
  height: Known<number>;
  at: CaptureTimePosition;
  moving: boolean;
  sizeBytes: Known<number>;
  /** Capture-specific caveats, appended after the tap's inherent ones. */
  caveats?: string[];
}): CaptureEvidence {
  return {
    path: input.path,
    tap: input.tap,
    provenance: provenanceForTap(input.tap),
    composited: compositedForTap(input.tap),
    width: input.width,
    height: input.height,
    at: input.at,
    moving: input.moving,
    sizeBytes: input.sizeBytes,
    caveats: [...inherentCaveats(input.tap), ...(input.caveats ?? [])],
  };
}
