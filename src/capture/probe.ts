/**
 * Honest capability probe for the render-truth capture layer.
 *
 * This answers "what can this machine actually see, right now" -- not "what
 * would be nice". The verdicts it returns were arrived at by trying things, and
 * where something is impossible without a compiled native module it says so
 * instead of offering a stub that fails later.
 *
 * What was established on the development machine (macOS 26.5, arm64,
 * ffmpeg 8.1 from a Homebrew-style prefix):
 *   - ffmpeg's ONLY capture input device is `avfoundation`; it exposes
 *     `Capture screen 0..N` alongside cameras, and a one-frame grab succeeded,
 *     so a live SCREEN tap is genuinely reachable with zero new dependencies.
 *   - ffmpeg has no NDI demuxer (libndi_newtek was removed upstream) and no NDI
 *     runtime or Syphon framework is installed. Neither can be received without
 *     building a native addon, so both stay unavailable. Same for Spout, which
 *     is Windows-only regardless.
 *   - Premiere exposes ZERO windows to macOS accessibility, so the Program
 *     monitor's screen rectangle cannot be discovered automatically. A screen
 *     capture of the Program monitor therefore needs a caller-supplied crop
 *     rect; `buildCalibrationArgs` exists to make picking one a look-once job.
 */

import { platform, arch } from 'node:os';
import {
  binaryAvailable,
  ffmpegCmd,
  ffprobeCmd,
  runBinary,
  FFMPEG_INSTALL_GUIDANCE,
  FFPROBE_INSTALL_GUIDANCE,
} from './ffmpeg.js';
import type { TapCapability } from './types.js';

export interface AvfDevice {
  index: number;
  name: string;
}

export interface ScreenCapability {
  available: boolean;
  /** The ffmpeg input device that would be used, or null when none exists. */
  inputFormat: 'avfoundation' | 'gdigrab' | 'x11grab' | null;
  /** All avfoundation video devices seen (macOS only). */
  videoDevices: AvfDevice[];
  /** The subset that are displays -- the ones a screen tap can use. */
  displays: AvfDevice[];
  /**
   * Whether a real one-frame grab was attempted and worked. 'not-tested' when
   * the caller did not opt in (a grab captures the user's screen, so it is
   * never done implicitly).
   */
  permissionVerified: boolean | 'not-tested';
  reason: string;
  install?: string | undefined;
}

export interface WindowGeometryCapability {
  available: boolean;
  reason: string;
  /** What the caller must supply instead. */
  workaround?: string | undefined;
}

export interface CaptureCapabilityReport {
  os: string;
  arch: string;
  ffmpeg: { cmd: string; available: boolean; envOverride: string; install?: string | undefined };
  ffprobe: { cmd: string; available: boolean; envOverride: string; install?: string | undefined };
  screen: ScreenCapability;
  /** Can we locate Premiere's Program monitor on screen by ourselves? */
  programMonitorGeometry: WindowGeometryCapability;
  taps: TapCapability[];
  /**
   * The tap that proves the most about the edit and is actually available.
   * 'render' whenever Premiere is connected, because it is the only reachable
   * tap whose pixels Premiere composited.
   */
  bestCompositedTap: TapCapability['tap'] | null;
  /** The best available tap that can show MOTION over time. */
  bestMotionTap: TapCapability['tap'] | null;
}

/* ------------------------------------------------------------------ *
 * Pure parsers
 * ------------------------------------------------------------------ */

/**
 * Parse `ffmpeg -devices`. The real output opens with a legend that looks just
 * like a device row, which is why the flag-column regex alone is not enough:
 *
 *   Devices:
 *    D. = Demuxing supported
 *    .E = Muxing supported
 *    ---
 *     E audiotoolbox    AudioToolbox output device
 *    D  avfoundation    AVFoundation input device
 *
 * ` D. = Demuxing supported` matches the row shape and yields a "device" called
 * `=`, which is how a first version of this parser managed to conclude that a
 * machine with avfoundation had no screen capture. So: rows are only read after
 * the `---` separator, and a name that is not a plausible identifier is dropped.
 */
export function parseDevicesList(stdout: string): { demuxers: string[]; muxers: string[] } {
  const demuxers: string[] = [];
  const muxers: string[] = [];
  const lines = stdout.split('\n');
  const separator = lines.findIndex((l) => /^\s*-{3,}\s*$/.test(l));
  const rows = separator >= 0 ? lines.slice(separator + 1) : lines;

  for (const raw of rows) {
    // The two flag columns are POSITIONAL and an unsupported direction is a
    // SPACE, not a dot -- ` D  avfoundation` versus `  E audiotoolbox` -- so the
    // leading whitespace cannot simply be trimmed away.
    const m = /^ ?([D. ])([E. ]) +([A-Za-z0-9_][A-Za-z0-9_,+-]*)(?:\s|$)/.exec(raw);
    if (!m) continue;
    const name = m[3] as string;
    if (m[1] === 'D') demuxers.push(name);
    if (m[2] === 'E') muxers.push(name);
  }
  return { demuxers, muxers };
}

/**
 * Parse the device listing avfoundation prints to stderr for
 * `-f avfoundation -list_devices true -i ""`:
 *   [AVFoundation indev @ 0x…] AVFoundation video devices:
 *   [AVFoundation indev @ 0x…] [1] Capture screen 0
 *   [AVFoundation indev @ 0x…] AVFoundation audio devices:
 *   [AVFoundation indev @ 0x…] [0] MacBook Pro Microphone
 */
export function parseAvfoundationDevices(stderr: string): { video: AvfDevice[]; audio: AvfDevice[] } {
  const video: AvfDevice[] = [];
  const audio: AvfDevice[] = [];
  let bucket: 'video' | 'audio' | null = null;
  for (const raw of stderr.split('\n')) {
    const line = raw.replace(/^\[[^\]]*\]\s*/, '').trim();
    if (/^AVFoundation video devices:/i.test(line)) { bucket = 'video'; continue; }
    if (/^AVFoundation audio devices:/i.test(line)) { bucket = 'audio'; continue; }
    const m = /^\[(\d+)\]\s+(.+)$/.exec(line);
    if (!m || !bucket) continue;
    const device = { index: Number(m[1]), name: (m[2] as string).trim() };
    (bucket === 'video' ? video : audio).push(device);
  }
  return { video, audio };
}

/** Pure: which avfoundation video devices are displays rather than cameras. */
export function displaysFrom(video: AvfDevice[]): AvfDevice[] {
  return video.filter((d) => /capture screen/i.test(d.name));
}

/** Pure: the ffmpeg screen-capture input device for an OS, given what it has. */
export function screenInputFormatFor(
  os: string,
  demuxers: string[],
): 'avfoundation' | 'gdigrab' | 'x11grab' | null {
  const has = (name: string) => demuxers.includes(name);
  if (os === 'darwin') return has('avfoundation') ? 'avfoundation' : null;
  if (os === 'win32') return has('gdigrab') ? 'gdigrab' : null;
  if (os === 'linux') return has('x11grab') ? 'x11grab' : null;
  return null;
}

/* ------------------------------------------------------------------ *
 * Tap verdicts
 * ------------------------------------------------------------------ */

/**
 * Pure: the capability rows for every tap, given what the environment probe
 * found. Kept pure so the honesty contract ("an unavailable tap always carries
 * install guidance") is directly testable.
 *
 * `premiereConnected` is passed in rather than probed: this module never talks
 * to the bridge, so the caller states whether Premiere is reachable and the
 * render tap's availability follows from that.
 */
export function tapCapabilities(env: {
  os: string;
  screen: ScreenCapability;
  premiereConnected: boolean;
  ffmpegAvailable: boolean;
  ndiReceiver?: string | undefined;
  syphonReceiver?: string | undefined;
  spoutReceiver?: string | undefined;
}): TapCapability[] {
  const isMac = env.os === 'darwin';
  const isWin = env.os === 'win32';

  return [
    {
      tap: 'render',
      available: env.premiereConnected,
      realtime: false,
      video: true,
      audio: false,
      provenance: 'composited-render',
      composited: 'yes',
      reason: env.premiereConnected
        ? 'Premiere renders the frame through the sequence via its own frame export. Zero dependencies, and the only reachable tap whose pixels Premiere composited.'
        : 'Premiere is not connected, so it cannot be asked to render a frame. Open the CEP bridge panel and start it.',
      install: env.premiereConnected ? undefined : 'Open Premiere > Window > Extensions > MCP Bridge (CEP) and press Start.',
    },
    {
      tap: 'export-file',
      available: env.premiereConnected,
      realtime: false,
      video: true,
      audio: true,
      provenance: 'composited-render',
      composited: 'yes',
      reason: env.premiereConnected
        ? 'A sequence/range export is a composited render on disk; frames read back off it prove motion and timing over a range, not just one instant.'
        : 'Premiere is not connected, so no export can be produced or read back.',
      install: env.premiereConnected ? undefined : 'Open Premiere > Window > Extensions > MCP Bridge (CEP) and press Start.',
    },
    {
      tap: 'screen',
      available: env.screen.available && env.ffmpegAvailable,
      realtime: true,
      video: true,
      audio: false,
      provenance: 'screen-grab',
      composited: 'unverifiable',
      reason: !env.ffmpegAvailable
        ? 'ffmpeg is not runnable, and the screen tap is an ffmpeg capture.'
        : env.screen.reason,
      install: (env.screen.available && env.ffmpegAvailable)
        ? undefined
        : (env.ffmpegAvailable ? env.screen.install : FFMPEG_INSTALL_GUIDANCE),
    },
    {
      tap: 'ndi',
      available: Boolean(env.ndiReceiver),
      realtime: true,
      video: true,
      audio: true,
      provenance: 'screen-grab',
      composited: 'unverifiable',
      requiresNativeModule: !env.ndiReceiver,
      reason: env.ndiReceiver
        ? `NDI receiver advertised via PREMIERE_MCP_NDI_RECEIVER (${env.ndiReceiver}).`
        : 'No NDI receiver. ffmpeg dropped its NDI demuxer (libndi_newtek) years ago, and no NDI runtime is installed, so receiving NDI needs a compiled native addon plus a Transmit-style plugin publishing the Program feed. Not reachable from this server as shipped.',
      install: env.ndiReceiver
        ? undefined
        : 'Install the NDI Tools/runtime (ndi.video) plus a Premiere Transmit plugin that outputs NDI, provide a receiver executable, then set PREMIERE_MCP_NDI_RECEIVER to its command.',
    },
    {
      tap: 'syphon',
      available: isMac && Boolean(env.syphonReceiver),
      realtime: true,
      video: true,
      audio: false,
      provenance: 'screen-grab',
      composited: 'unverifiable',
      requiresNativeModule: isMac && !env.syphonReceiver,
      reason: !isMac
        ? `Syphon is macOS-only; this host is ${env.os}. Use Spout on Windows, or the screen tap.`
        : (env.syphonReceiver
          ? `Syphon receiver advertised via PREMIERE_MCP_SYPHON_RECEIVER (${env.syphonReceiver}).`
          : 'No Syphon receiver. Syphon passes IOSurface GPU textures between processes; there is no ffmpeg input device for it, so receiving it needs a compiled native addon. Not reachable from this server as shipped.'),
      install: isMac && !env.syphonReceiver
        ? 'Install a Syphon-publishing Transmit plugin for Premiere plus a Syphon receiver binary, then set PREMIERE_MCP_SYPHON_RECEIVER to its command.'
        : undefined,
    },
    {
      tap: 'spout',
      available: isWin && Boolean(env.spoutReceiver),
      realtime: true,
      video: true,
      audio: false,
      provenance: 'screen-grab',
      composited: 'unverifiable',
      requiresNativeModule: isWin && !env.spoutReceiver,
      reason: !isWin
        ? `Spout is Windows-only; this host is ${env.os}. Use the screen tap, or NDI with a receiver.`
        : (env.spoutReceiver
          ? `Spout receiver advertised via PREMIERE_MCP_SPOUT_RECEIVER (${env.spoutReceiver}).`
          : 'No Spout receiver. Spout shares DirectX textures between processes; there is no ffmpeg input device for it, so receiving it needs a compiled native addon. Not reachable from this server as shipped.'),
      install: isWin && !env.spoutReceiver
        ? 'Install a Spout-publishing Transmit plugin for Premiere plus a Spout receiver binary, then set PREMIERE_MCP_SPOUT_RECEIVER to its command.'
        : undefined,
    },
  ];
}

/** Pure: pick the most trustworthy available tap, and the best moving one. */
export function recommendTaps(taps: TapCapability[]): {
  bestCompositedTap: TapCapability['tap'] | null;
  bestMotionTap: TapCapability['tap'] | null;
} {
  const available = taps.filter((t) => t.available);
  const composited = available.find((t) => t.composited === 'yes');
  // For motion: a composited export beats a real-time screen grab, because the
  // pixels are Premiere's. Fall back to any available moving tap.
  const motion = available.find((t) => t.composited === 'yes' && t.tap === 'export-file')
    || available.find((t) => t.realtime)
    || null;
  return {
    bestCompositedTap: composited ? composited.tap : null,
    bestMotionTap: motion ? motion.tap : null,
  };
}

/* ------------------------------------------------------------------ *
 * The live probe
 * ------------------------------------------------------------------ */

export interface ProbeOptions {
  /** Whether Premiere is reachable over the bridge. The caller knows; we do not. */
  premiereConnected?: boolean | undefined;
  /**
   * Opt in to actually grabbing one frame off the display to prove the OS grants
   * screen-recording permission. Off by default: it captures the user's screen.
   */
  testScreenGrab?: boolean | undefined;
  /** Display device index to use for the permission test. */
  displayIndex?: number | undefined;
}

/**
 * Probe the machine. Spawns ffmpeg/ffprobe; never touches Premiere.
 */
export async function probeCaptureCapability(options: ProbeOptions = {}): Promise<CaptureCapabilityReport> {
  const os = platform();
  const ffmpeg = ffmpegCmd();
  const ffprobe = ffprobeCmd();
  const [ffmpegOk, ffprobeOk] = await Promise.all([binaryAvailable(ffmpeg), binaryAvailable(ffprobe)]);

  const screen = await probeScreenCapability(os, ffmpegOk, options);

  const taps = tapCapabilities({
    os,
    screen,
    premiereConnected: options.premiereConnected === true,
    ffmpegAvailable: ffmpegOk,
    ndiReceiver: process.env.PREMIERE_MCP_NDI_RECEIVER,
    syphonReceiver: process.env.PREMIERE_MCP_SYPHON_RECEIVER,
    spoutReceiver: process.env.PREMIERE_MCP_SPOUT_RECEIVER,
  });

  return {
    os,
    arch: arch(),
    ffmpeg: {
      cmd: ffmpeg,
      available: ffmpegOk,
      envOverride: 'PREMIERE_MCP_FFMPEG_CMD',
      install: ffmpegOk ? undefined : FFMPEG_INSTALL_GUIDANCE,
    },
    ffprobe: {
      cmd: ffprobe,
      available: ffprobeOk,
      envOverride: 'PREMIERE_MCP_FFPROBE_CMD',
      install: ffprobeOk ? undefined : FFPROBE_INSTALL_GUIDANCE,
    },
    screen,
    programMonitorGeometry: programMonitorGeometryCapability(os),
    taps,
    ...recommendTaps(taps),
  };
}

/**
 * Pure: our verdict on locating the Program monitor on screen automatically.
 *
 * Verified on macOS 26.5 with accessibility already granted: Premiere reports
 * ZERO windows to System Events, so there is no rectangle to read. pyobjc/Quartz
 * (which could enumerate windows) is not installed and adding it is a
 * dependency, not a probe. So the honest answer is no.
 */
export function programMonitorGeometryCapability(os: string): WindowGeometryCapability {
  if (os === 'darwin') {
    return {
      available: false,
      reason: 'Premiere exposes no windows to macOS accessibility (System Events returns an empty window list for it), and no window-enumeration API is reachable without adding a native/pyobjc dependency. The Program monitor\'s screen rectangle cannot be discovered automatically.',
      workaround: 'Pass an explicit crop rect (x, y, width, height) for the Program monitor, or call the calibration frame helper once: it writes a full-display grab with a labelled coordinate grid so the rect can be read off by eye and reused.',
    };
  }
  return {
    available: false,
    reason: `Automatic Program-monitor window geometry is not implemented for ${os}.`,
    workaround: 'Pass an explicit crop rect (x, y, width, height), or use the calibration frame helper to read one off a labelled full-display grab.',
  };
}

async function probeScreenCapability(
  os: string,
  ffmpegOk: boolean,
  options: ProbeOptions,
): Promise<ScreenCapability> {
  const base: ScreenCapability = {
    available: false,
    inputFormat: null,
    videoDevices: [],
    displays: [],
    permissionVerified: 'not-tested',
    reason: '',
  };

  if (!ffmpegOk) {
    return { ...base, reason: `ffmpeg ('${ffmpegCmd()}') is not runnable, so no screen capture is possible.`, install: FFMPEG_INSTALL_GUIDANCE };
  }

  const devicesRes = await runBinary(ffmpegCmd(), ['-hide_banner', '-devices'], 15_000);
  const { demuxers } = parseDevicesList(devicesRes.stdout + devicesRes.stderr);
  const inputFormat = screenInputFormatFor(os, demuxers);

  if (!inputFormat) {
    return {
      ...base,
      reason: `This ffmpeg build has no screen-capture input device for ${os} (devices seen: ${demuxers.join(', ') || 'none'}).`,
      install: 'Install an ffmpeg build with the platform capture device compiled in (macOS: avfoundation; Windows: gdigrab; Linux: x11grab).',
    };
  }

  if (inputFormat !== 'avfoundation') {
    // gdigrab/x11grab take a screen spec rather than an enumerable device list.
    return {
      ...base,
      available: true,
      inputFormat,
      reason: `ffmpeg can capture the screen with '${inputFormat}'. Device enumeration is not applicable to this input; the display is addressed by spec (gdigrab: "desktop"; x11grab: ":0.0").`,
      permissionVerified: 'not-tested',
    };
  }

  // avfoundation prints its device list to stderr and exits non-zero -- expected.
  const listRes = await runBinary(
    ffmpegCmd(),
    ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    20_000,
  );
  const { video } = parseAvfoundationDevices(listRes.stderr);
  const displays = displaysFrom(video);

  if (displays.length === 0) {
    return {
      ...base,
      inputFormat,
      videoDevices: video,
      reason: 'avfoundation is present but lists no "Capture screen" device. On macOS this usually means the host process has not been granted Screen Recording permission, so the display never appears in the device list.',
      install: 'Grant Screen Recording to the process running this server in System Settings > Privacy & Security > Screen Recording, then restart it.',
    };
  }

  const result: ScreenCapability = {
    available: true,
    inputFormat,
    videoDevices: video,
    displays,
    permissionVerified: 'not-tested',
    reason: `avfoundation exposes ${displays.length} display(s): ${displays.map((d) => `[${d.index}] ${d.name}`).join(', ')}. A screen tap is reachable with no new dependencies. Its output is a SCREEN GRAB, never a composited render.`,
  };

  if (options.testScreenGrab) {
    const index = options.displayIndex ?? (displays[0] as AvfDevice).index;
    const verified = await verifyScreenGrab(index);
    result.permissionVerified = verified.ok;
    if (!verified.ok) {
      result.available = false;
      result.reason = `avfoundation lists a display but a one-frame grab failed, so the capture is not actually usable: ${verified.detail}`;
      result.install = 'Grant Screen Recording to the process running this server in System Settings > Privacy & Security > Screen Recording, then restart it.';
    }
  }

  return result;
}

/**
 * Prove screen capture works by grabbing exactly one frame and throwing it away.
 * Writes to a temp file (deleted immediately) so nothing is retained.
 */
export async function verifyScreenGrab(displayIndex: number): Promise<{ ok: boolean; detail: string }> {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { promises: fsp } = await import('node:fs');
  const probePath = join(tmpdir(), `premiere-mcp-screen-probe-${Date.now()}.png`);
  const res = await runBinary(
    ffmpegCmd(),
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'avfoundation', '-capture_cursor', '0', '-pixel_format', 'bgr0',
      '-framerate', '30', '-i', String(displayIndex),
      '-frames:v', '1', '-update', '1', '-y', probePath,
    ],
    30_000,
  );
  let landed = false;
  try {
    landed = (await fsp.stat(probePath)).size > 0;
  } catch { /* nothing written */ }
  try { await fsp.unlink(probePath); } catch { /* best effort */ }
  return landed
    ? { ok: true, detail: 'One frame was captured and discarded.' }
    : { ok: false, detail: (res.stderr || res.spawnError || `ffmpeg exited ${res.code} with no output`).slice(-500) };
}
