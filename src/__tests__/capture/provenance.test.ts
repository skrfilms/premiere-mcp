/**
 * The provenance scheme is the honesty contract of the capture layer, so it is
 * tested as a contract rather than as a set of getters: a screen grab must never
 * be able to claim it was composited, a tap must never lose its caveats, and an
 * unknown time must stay unknown instead of collapsing to zero.
 */

import {
  compositedForTap,
  describeProvenance,
  framesToTimecode,
  inherentCaveats,
  makeEvidence,
  provenanceForTap,
  secondsToTimecode,
  timePosition,
  timecodeToFrames,
} from '../../capture/provenance.js';
import type { CaptureTapKind } from '../../capture/types.js';

const ALL_TAPS: CaptureTapKind[] = ['render', 'export-file', 'media-file', 'screen', 'ndi', 'syphon', 'spout'];

describe('provenance labelling', () => {
  it('labels only Premiere-rendered taps as composited renders', () => {
    expect(provenanceForTap('render')).toBe('composited-render');
    expect(provenanceForTap('export-file')).toBe('composited-render');
    expect(compositedForTap('render')).toBe('yes');
    expect(compositedForTap('export-file')).toBe('yes');
  });

  it('never lets a screen or GPU/network tap claim it was composited', () => {
    for (const tap of ['screen', 'ndi', 'syphon', 'spout'] as CaptureTapKind[]) {
      expect(provenanceForTap(tap)).not.toBe('composited-render');
      expect(compositedForTap(tap)).toBe('unverifiable');
    }
  });

  it('labels a decoded media frame as a source frame that is explicitly not composited', () => {
    expect(provenanceForTap('media-file')).toBe('source-frame');
    expect(compositedForTap('media-file')).toBe('no');
  });

  it('gives every tap at least one inherent caveat', () => {
    for (const tap of ALL_TAPS) {
      expect(inherentCaveats(tap).length).toBeGreaterThan(0);
    }
  });

  it('warns in the screen tap caveats that the pixels are not a render', () => {
    const caveats = inherentCaveats('screen').join(' ');
    expect(caveats).toMatch(/SCREEN CAPTURE, not a composited render/);
    expect(caveats).toMatch(/Program monitor/);
  });

  it('returns a fresh caveat array each time, so a caller cannot mutate the table', () => {
    const first = inherentCaveats('screen');
    first.push('mine');
    expect(inherentCaveats('screen')).not.toContain('mine');
  });

  it('describes an unrecognised tap as untrusted rather than guessing', () => {
    const tap = 'holodeck' as unknown as CaptureTapKind;
    expect(provenanceForTap(tap)).toBe('unknown');
    expect(inherentCaveats(tap)[0]).toMatch(/untrusted/);
  });
});

describe('makeEvidence', () => {
  const at = timePosition(2, 24);

  it('derives provenance from the tap, so a screen grab cannot be dressed up', () => {
    const evidence = makeEvidence({
      tap: 'screen',
      path: '/tmp/x.png',
      width: 1920,
      height: 1080,
      at,
      moving: false,
      sizeBytes: 100,
    });
    expect(evidence.provenance).toBe('screen-grab');
    expect(evidence.composited).toBe('unverifiable');
    expect(evidence.caveats.length).toBeGreaterThan(0);
    expect(describeProvenance(evidence)).toMatch(/Do not treat as a render/);
  });

  it('keeps caller caveats and puts the inherent ones first', () => {
    const evidence = makeEvidence({
      tap: 'render',
      path: '/tmp/x.png',
      width: 1920,
      height: 1080,
      at,
      moving: false,
      sizeBytes: 100,
      caveats: ['caller note'],
    });
    expect(evidence.caveats[0]).toMatch(/Rendered by Premiere/);
    expect(evidence.caveats).toContain('caller note');
  });

  it('carries unknowns through instead of defaulting them', () => {
    const evidence = makeEvidence({
      tap: 'render',
      path: 'unknown',
      width: 'unknown',
      height: 'unknown',
      at: timePosition('unknown', 'unknown'),
      moving: false,
      sizeBytes: 'unknown',
    });
    expect(evidence.width).toBe('unknown');
    expect(evidence.at.timecode).toBe('unknown');
    expect(evidence.at.frame).toBe('unknown');
  });
});

describe('timePosition', () => {
  it('computes frame and timecode when both time and rate are known', () => {
    expect(timePosition(2, 24)).toEqual({ seconds: 2, frame: 48, timecode: '00:00:02:00', fps: 24 });
  });

  it('keeps frame and timecode unknown when the frame rate is not known', () => {
    const pos = timePosition(2, 'unknown');
    expect(pos.seconds).toBe(2);
    expect(pos.frame).toBe('unknown');
    expect(pos.timecode).toBe('unknown');
    expect(pos.fps).toBe('unknown');
  });

  it('keeps everything but the rate unknown when the time is not known', () => {
    const pos = timePosition('unknown', 24);
    expect(pos.seconds).toBe('unknown');
    expect(pos.frame).toBe('unknown');
    expect(pos.timecode).toBe('unknown');
    expect(pos.fps).toBe(24);
  });

  it('refuses a nonsense frame rate rather than dividing by it', () => {
    expect(timePosition(2, 0).timecode).toBe('unknown');
    expect(timePosition(2, -24).frame).toBe('unknown');
  });
});

describe('timecode conversion', () => {
  it('formats whole and part seconds at 24fps', () => {
    expect(secondsToTimecode(0, 24)).toBe('00:00:00:00');
    expect(secondsToTimecode(1, 24)).toBe('00:00:01:00');
    expect(secondsToTimecode(4.5, 24)).toBe('00:00:04:12');
    expect(secondsToTimecode(3661, 24)).toBe('01:01:01:00');
  });

  it('numbers frames 0..round(fps)-1 on a fractional rate', () => {
    expect(framesToTimecode(23, 23.976)).toBe('00:00:00:23');
    expect(framesToTimecode(24, 23.976)).toBe('00:00:01:00');
    expect(framesToTimecode(29, 29.97)).toBe('00:00:00:29');
    expect(framesToTimecode(30, 29.97)).toBe('00:00:01:00');
  });

  it('round-trips a timecode back to a frame number', () => {
    expect(timecodeToFrames('00:00:04:12', 24)).toBe(108);
    expect(timecodeToFrames('01:00:00:00', 24)).toBe(86_400);
    expect(timecodeToFrames(framesToTimecode(12_345, 25), 25)).toBe(12_345);
  });

  it('rejects a timecode whose frame field cannot exist at that rate', () => {
    expect(timecodeToFrames('00:00:00:24', 24)).toBeUndefined();
    expect(timecodeToFrames('not a timecode', 24)).toBeUndefined();
  });

  it('reports unknown rather than NaN for junk input', () => {
    expect(secondsToTimecode(Number.NaN, 24)).toBe('unknown');
    expect(framesToTimecode(10, 0)).toBe('unknown');
  });
});
