/**
 * The capability probe is tested against REAL output captured from this machine
 * (ffmpeg 8.1, macOS arm64), because a hand-simplified fixture would not have
 * the log prefixes, the trailing camera devices, or the audio section that the
 * parser has to survive.
 *
 * The invariants that matter are honesty invariants: an unavailable tap always
 * carries install guidance, the taps that need a compiled native module are
 * flagged as such, and nothing claims Premiere is connected on our behalf.
 */

import { spawnSync } from 'node:child_process';
import {
  displaysFrom,
  parseAvfoundationDevices,
  parseDevicesList,
  probeCaptureCapability,
  programMonitorGeometryCapability,
  recommendTaps,
  screenInputFormatFor,
  tapCapabilities,
  type ScreenCapability,
} from '../../capture/probe.js';

/** Verbatim `ffmpeg -hide_banner -devices` output from the dev machine. */
const DEVICES_OUTPUT = `Devices:
 D. = Demuxing supported
 .E = Muxing supported
 ---
  E audiotoolbox    AudioToolbox output device
 D  avfoundation    AVFoundation input device
 D  lavfi           Libavfilter virtual input device
`;

/** Verbatim avfoundation -list_devices stderr from the dev machine. */
const AVF_LIST_STDERR = `[AVFoundation indev @ 0x1507084e0] AVFoundation video devices:
[AVFoundation indev @ 0x1507084e0] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1507084e0] [1] Capture screen 0
[AVFoundation indev @ 0x1507084e0] [2] Capture screen 1
[AVFoundation indev @ 0x1507084e0] [3] Capture screen 2
[AVFoundation indev @ 0x1507084e0] AVFoundation audio devices:
[AVFoundation indev @ 0x1507084e0] [0] ZoomAudioDevice
[AVFoundation indev @ 0x1507084e0] [1] MacBook Pro Microphone
[in#0 @ 0x150708160] Error opening input: Input/output error
Error opening input file .
`;

const availableScreen: ScreenCapability = {
  available: true,
  inputFormat: 'avfoundation',
  videoDevices: [{ index: 1, name: 'Capture screen 0' }],
  displays: [{ index: 1, name: 'Capture screen 0' }],
  permissionVerified: true,
  reason: 'display present',
};

const unavailableScreen: ScreenCapability = {
  available: false,
  inputFormat: 'avfoundation',
  videoDevices: [],
  displays: [],
  permissionVerified: 'not-tested',
  reason: 'no display listed',
  install: 'grant screen recording',
};

describe('parseDevicesList', () => {
  it('separates demuxers from muxers in real ffmpeg output', () => {
    const { demuxers, muxers } = parseDevicesList(DEVICES_OUTPUT);
    expect(demuxers).toEqual(['avfoundation', 'lavfi']);
    expect(muxers).toEqual(['audiotoolbox']);
  });

  it('returns empty lists rather than throwing on unrelated output', () => {
    expect(parseDevicesList('command not found')).toEqual({ demuxers: [], muxers: [] });
  });

  it('does not read the legend rows as devices', () => {
    // ' D. = Demuxing supported' has the shape of a device row; a parser that
    // takes it at face value reports a demuxer called '=' and then concludes
    // this machine has no screen capture.
    const { demuxers, muxers } = parseDevicesList(DEVICES_OUTPUT);
    expect(demuxers).not.toContain('=');
    expect(muxers).not.toContain('=');
  });
});

describe('parseAvfoundationDevices', () => {
  it('reads the video and audio device tables out of the log-prefixed stderr', () => {
    const { video, audio } = parseAvfoundationDevices(AVF_LIST_STDERR);
    expect(video).toEqual([
      { index: 0, name: 'FaceTime HD Camera' },
      { index: 1, name: 'Capture screen 0' },
      { index: 2, name: 'Capture screen 1' },
      { index: 3, name: 'Capture screen 2' },
    ]);
    expect(audio.map((a) => a.name)).toEqual(['ZoomAudioDevice', 'MacBook Pro Microphone']);
  });

  it('does not mistake the trailing error lines for devices', () => {
    const { video, audio } = parseAvfoundationDevices(AVF_LIST_STDERR);
    expect([...video, ...audio].some((d) => /Error opening/.test(d.name))).toBe(false);
  });

  it('picks out only the displays, not the camera', () => {
    const { video } = parseAvfoundationDevices(AVF_LIST_STDERR);
    expect(displaysFrom(video).map((d) => d.index)).toEqual([1, 2, 3]);
  });
});

describe('screenInputFormatFor', () => {
  it('maps each OS onto the device it actually needs', () => {
    expect(screenInputFormatFor('darwin', ['avfoundation', 'lavfi'])).toBe('avfoundation');
    expect(screenInputFormatFor('win32', ['gdigrab'])).toBe('gdigrab');
    expect(screenInputFormatFor('linux', ['x11grab'])).toBe('x11grab');
  });

  it('returns null when the build lacks the device, rather than guessing one', () => {
    // This machine's ffmpeg was configured with --disable-indev=x11grab_xcb.
    expect(screenInputFormatFor('linux', ['avfoundation', 'lavfi'])).toBeNull();
    expect(screenInputFormatFor('darwin', ['lavfi'])).toBeNull();
    expect(screenInputFormatFor('aix', ['avfoundation'])).toBeNull();
  });
});

describe('tapCapabilities — honesty invariants', () => {
  const macAvailable = tapCapabilities({
    os: 'darwin',
    screen: availableScreen,
    premiereConnected: true,
    ffmpegAvailable: true,
  });

  it('every unavailable tap carries install guidance', () => {
    const all = [
      ...macAvailable,
      ...tapCapabilities({
        os: 'darwin',
        screen: unavailableScreen,
        premiereConnected: false,
        ffmpegAvailable: false,
      }),
      ...tapCapabilities({
        os: 'win32',
        screen: unavailableScreen,
        premiereConnected: false,
        ffmpegAvailable: true,
      }),
    ];
    for (const tap of all.filter((t) => !t.available)) {
      // Platform-impossible taps explain themselves in `reason` instead; the rest must say how to fix it.
      const platformImpossible = /only;/.test(tap.reason);
      if (platformImpossible) continue;
      expect(typeof tap.install).toBe('string');
      expect((tap.install as string).length).toBeGreaterThan(10);
    }
  });

  it('flags the GPU/network taps as needing a compiled native module on their own platform', () => {
    const ndi = macAvailable.find((t) => t.tap === 'ndi');
    const syphon = macAvailable.find((t) => t.tap === 'syphon');
    expect(ndi?.available).toBe(false);
    expect(ndi?.requiresNativeModule).toBe(true);
    expect(ndi?.reason).toMatch(/native addon/);
    expect(syphon?.requiresNativeModule).toBe(true);
    const win = tapCapabilities({
      os: 'win32',
      screen: availableScreen,
      premiereConnected: true,
      ffmpegAvailable: true,
    });
    expect(win.find((t) => t.tap === 'spout')?.requiresNativeModule).toBe(true);
  });

  it('does not offer Spout on macOS or Syphon on Windows', () => {
    expect(macAvailable.find((t) => t.tap === 'spout')?.available).toBe(false);
    expect(macAvailable.find((t) => t.tap === 'spout')?.reason).toMatch(/Windows-only/);
    const win = tapCapabilities({
      os: 'win32',
      screen: availableScreen,
      premiereConnected: true,
      ffmpegAvailable: true,
    });
    expect(win.find((t) => t.tap === 'syphon')?.reason).toMatch(/macOS-only/);
  });

  it('honours an advertised receiver env override instead of second-guessing it', () => {
    const withNdi = tapCapabilities({
      os: 'darwin',
      screen: availableScreen,
      premiereConnected: true,
      ffmpegAvailable: true,
      ndiReceiver: '/opt/ndi-recv',
    });
    const ndi = withNdi.find((t) => t.tap === 'ndi');
    expect(ndi?.available).toBe(true);
    expect(ndi?.requiresNativeModule).toBe(false);
    expect(ndi?.install).toBeUndefined();
  });

  it('marks the render and export taps unavailable when Premiere is not connected', () => {
    const offline = tapCapabilities({
      os: 'darwin',
      screen: availableScreen,
      premiereConnected: false,
      ffmpegAvailable: true,
    });
    expect(offline.find((t) => t.tap === 'render')?.available).toBe(false);
    expect(offline.find((t) => t.tap === 'export-file')?.available).toBe(false);
    expect(offline.find((t) => t.tap === 'render')?.install).toMatch(/MCP Bridge/);
  });

  it('kills the screen tap when ffmpeg is missing, and says why', () => {
    const noFfmpeg = tapCapabilities({
      os: 'darwin',
      screen: availableScreen,
      premiereConnected: true,
      ffmpegAvailable: false,
    });
    const screen = noFfmpeg.find((t) => t.tap === 'screen');
    expect(screen?.available).toBe(false);
    expect(screen?.reason).toMatch(/ffmpeg/);
    expect(screen?.install).toMatch(/brew install ffmpeg|PREMIERE_MCP_FFMPEG_CMD/);
  });

  it('never labels a screen or GPU tap as composited, even when available', () => {
    for (const tap of macAvailable.filter((t) =>
      ['screen', 'ndi', 'syphon', 'spout'].includes(t.tap),
    )) {
      expect(tap.composited).toBe('unverifiable');
      expect(tap.provenance).not.toBe('composited-render');
    }
  });
});

describe('recommendTaps', () => {
  it('prefers a composited tap for trust and the export tap for motion', () => {
    const taps = tapCapabilities({
      os: 'darwin',
      screen: availableScreen,
      premiereConnected: true,
      ffmpegAvailable: true,
    });
    const rec = recommendTaps(taps);
    expect(rec.bestCompositedTap).toBe('render');
    expect(rec.bestMotionTap).toBe('export-file');
  });

  it('falls back to the real-time screen tap for motion when Premiere is absent', () => {
    const taps = tapCapabilities({
      os: 'darwin',
      screen: availableScreen,
      premiereConnected: false,
      ffmpegAvailable: true,
    });
    const rec = recommendTaps(taps);
    expect(rec.bestCompositedTap).toBeNull();
    expect(rec.bestMotionTap).toBe('screen');
  });

  it('recommends nothing at all when nothing is available', () => {
    const taps = tapCapabilities({
      os: 'darwin',
      screen: unavailableScreen,
      premiereConnected: false,
      ffmpegAvailable: false,
    });
    expect(recommendTaps(taps)).toEqual({ bestCompositedTap: null, bestMotionTap: null });
  });
});

describe('programMonitorGeometryCapability', () => {
  it("reports that Premiere's Program monitor cannot be located automatically, with the workaround", () => {
    const mac = programMonitorGeometryCapability('darwin');
    expect(mac.available).toBe(false);
    expect(mac.reason).toMatch(/accessibility/);
    expect(mac.workaround).toMatch(/crop rect/);
  });

  it('does not pretend to support other platforms', () => {
    expect(programMonitorGeometryCapability('win32').available).toBe(false);
  });
});

describe('probeCaptureCapability — live', () => {
  const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;
  const maybe = ffmpegAvailable ? it : it.skip;

  maybe(
    'reports what this machine can genuinely capture',
    async () => {
      const report = await probeCaptureCapability();
      expect(report.ffmpeg.available).toBe(true);
      expect(report.ffmpeg.envOverride).toBe('PREMIERE_MCP_FFMPEG_CMD');
      // Premiere connectivity was not asserted, so the composited taps must be off.
      expect(report.taps.find((t) => t.tap === 'render')?.available).toBe(false);
      expect(report.bestCompositedTap).toBeNull();
      if (report.os === 'darwin') {
        expect(report.screen.inputFormat).toBe('avfoundation');
        expect(report.screen.available).toBe(true);
        expect(report.screen.displays.length).toBeGreaterThan(0);
        expect(report.bestMotionTap).toBe('screen');
      }
      // Never claimed as available: they need a native module we do not ship.
      for (const tap of ['ndi', 'syphon', 'spout'] as const) {
        expect(report.taps.find((t) => t.tap === tap)?.available).toBe(false);
      }
      expect(report.programMonitorGeometry.available).toBe(false);
    },
    60_000,
  );

  maybe(
    'does not grab the screen unless asked to',
    async () => {
      const report = await probeCaptureCapability();
      expect(report.screen.permissionVerified).toBe('not-tested');
    },
    60_000,
  );
});
