/**
 * The vocabulary of the render-truth capture layer.
 *
 * Everything this layer produces is EVIDENCE about pixels, and evidence is only
 * worth anything if the consumer knows where it came from. A frame decoded out
 * of a source .mov and a frame rendered by Premiere with three effects and a
 * title on top of it look equally like "a frame" to a model; one of them proves
 * the edit works and the other proves nothing about the edit at all. So every
 * artifact this layer writes carries its provenance, and no field is ever
 * defaulted: if we do not know the resolution or the timecode we say
 * 'unknown' rather than guessing zero.
 */

/** A value we may genuinely not know. Never silently defaulted. */
export type Known<T> = T | 'unknown';

export const UNKNOWN = 'unknown' as const;

/**
 * WHERE the pixels came from. Ordered roughly by how much it proves about the
 * edit -- the first two are the only ones that prove anything about the
 * composite, and the difference between them is only latency.
 */
export type CaptureProvenance =
  /**
   * Premiere itself rendered these pixels through the sequence: a frame export
   * or a full sequence/range export. Everything the timeline contributes is
   * baked in -- upper tracks, effects, transitions, grades, titles, opacity.
   * This is the only provenance that can settle "did the transition appear".
   */
  | 'composited-render'
  /**
   * Decoded from a source media file on disk with ffmpeg. Ground truth about
   * that FILE, and nothing at all about the timeline: no effects, no upper
   * tracks, no transitions. Useful as a baseline to diff a render against.
   */
  | 'source-frame'
  /**
   * Scraped off the display with a screen capture. What was on screen at that
   * moment, which is usually Premiere's Program monitor showing the composite
   * -- but that is an assumption we cannot verify from the pixels: another
   * window may have been in front, the monitor may have been scrolled, scaled,
   * showing a different sequence, at reduced playback resolution, or colour
   * managed by the display. Real-time, low trust.
   */
  | 'screen-grab'
  /** Provenance could not be established. Treat the artifact as untrusted. */
  | 'unknown';

/** WHICH mechanism produced the artifact. */
export type CaptureTapKind =
  /** Premiere's own single-frame export, via the bridge (the existing render tap). */
  | 'render'
  /** A file Premiere exported (sequence/range export), read back off disk. */
  | 'export-file'
  /** A media file on disk decoded with ffmpeg. */
  | 'media-file'
  /** macOS avfoundation / Windows gdigrab style display capture, via ffmpeg. */
  | 'screen'
  /** Real-time GPU/network taps. Not reachable here -- see probeCaptureCapability(). */
  | 'ndi'
  | 'syphon'
  | 'spout';

/**
 * Did Premiere composite these pixels through the sequence?
 * 'unverifiable' is a first-class answer, not a failure: a screen grab may well
 * show the composite, but nothing in the artifact proves it did.
 */
export type CompositedVerdict = 'yes' | 'no' | 'unverifiable';

/** Where an artifact sits in time, as far as we can establish it. */
export interface CaptureTimePosition {
  /** Seconds into the sequence/clip. */
  seconds: Known<number>;
  /** Frame number at `fps`, floor(seconds * fps). */
  frame: Known<number>;
  /** HH:MM:SS:FF at `fps`. */
  timecode: Known<string>;
  /** Frame rate the frame/timecode were computed at. */
  fps: Known<number>;
}

/** One captured artifact plus everything needed to judge how much it proves. */
export interface CaptureEvidence {
  /** Absolute path of the image/video written, or 'unknown' if nothing landed. */
  path: Known<string>;
  tap: CaptureTapKind;
  provenance: CaptureProvenance;
  composited: CompositedVerdict;
  width: Known<number>;
  height: Known<number>;
  /** Time position within the source (sequence time for renders). */
  at: CaptureTimePosition;
  /** True for video artifacts (a clip/strip), false for single stills. */
  moving: boolean;
  /** Bytes on disk, or 'unknown' when it could not be stat'ed. */
  sizeBytes: Known<number>;
  /**
   * Everything a consumer must hold against this artifact before believing it.
   * Never empty for 'screen-grab'.
   */
  caveats: string[];
}

/** A capability verdict for one tap on THIS machine. Honest or nothing. */
export interface TapCapability {
  tap: CaptureTapKind;
  available: boolean;
  /** Can it deliver a continuous stream, or only discrete stills? */
  realtime: boolean;
  video: boolean;
  audio: boolean;
  /** What this tap's output would be labelled as if used. */
  provenance: CaptureProvenance;
  composited: CompositedVerdict;
  /** Why it is (un)available, in plain terms. */
  reason: string;
  /** How to make it available. Undefined when it already is. */
  install?: string | undefined;
  /**
   * True when making this tap work needs a compiled native module (an SDK, a
   * framework, an addon build). We do not ship a compiler, so these stay
   * unavailable and we say so rather than stubbing them.
   */
  requiresNativeModule?: boolean | undefined;
}
