/**
 * The render-truth capture layer.
 *
 * Everything an agent needs to find out what actually happened to the pixels,
 * with the provenance of every artifact attached so a screen grab can never be
 * mistaken for a composited render.
 *
 * The four entry points the tool layer wires up:
 *   - `probeCaptureCapability()`  what this machine can genuinely capture
 *   - `captureFrameStrip()`       a frame-accurate, timecode-burnt range capture
 *   - `captureScreenClip()`       the live tap (screen, honestly labelled)
 *   - `diffFrames()` / `analyzeMotion()`  numeric proof that pixels did or did
 *     not change
 *
 * See docs/RENDER-TRUTH-CAPTURE.md for the labelling scheme and the honest
 * limits of each tap.
 */

export * from './types.js';
export * from './provenance.js';
export * from './ffmpeg.js';
export * from './probe.js';
export * from './screen-tap.js';
export * from './frame-diff.js';
export * from './frame-strip.js';
