/**
 * The screen tap is the only real-time tap we can reach, and the most dangerous
 * to misread, so these tests are mostly about the command lines and the labels:
 * the avfoundation pixel format it must ask for, the crop rect it must refuse,
 * and the fact that the evidence it returns can never say 'composited-render'.
 *
 * A LIVE grab is deliberately not run by default -- it would capture whatever is
 * on the user's screen. Set PREMIERE_MCP_TEST_SCREEN_GRAB=1 to include it.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCalibrationArgs,
  buildScreenClipArgs,
  buildScreenInputArgs,
  buildScreenStillArgs,
  captureScreenClip,
  captureScreenStill,
  escapeDrawtextValue,
  resolveFontFile,
  validateCropRect,
  type ScreenTargetSpec,
} from '../../capture/screen-tap.js';

const macTarget: ScreenTargetSpec = { inputFormat: 'avfoundation', displayIndex: 1 };

describe('validateCropRect', () => {
  it('accepts a whole-pixel rect', () => {
    expect(validateCropRect({ x: 100, y: 200, width: 640, height: 360 })).toBeNull();
  });

  it('rejects fractional, negative and degenerate rects instead of letting ffmpeg round them', () => {
    expect(validateCropRect({ x: 0.5, y: 0, width: 100, height: 100 })).toMatch(/whole number/);
    expect(validateCropRect({ x: -1, y: 0, width: 100, height: 100 })).toMatch(/must not be negative/);
    expect(validateCropRect({ x: 0, y: 0, width: 1, height: 100 })).toMatch(/at least 2 pixels/);
  });
});

describe('buildScreenInputArgs', () => {
  it('asks avfoundation for bgr0, which is the only format its screen input offers', () => {
    const argv = buildScreenInputArgs(macTarget, 30);
    expect(argv).toEqual(['-f', 'avfoundation', '-capture_cursor', '0', '-pixel_format', 'bgr0', '-framerate', '30', '-i', '1']);
  });

  it('addresses gdigrab and x11grab by spec rather than index', () => {
    expect(buildScreenInputArgs({ inputFormat: 'gdigrab' }, 25)).toContain('desktop');
    expect(buildScreenInputArgs({ inputFormat: 'x11grab' }, 25)).toContain(':0.0');
    expect(buildScreenInputArgs({ inputFormat: 'x11grab', displaySpec: ':1.0' }, 25)).toContain(':1.0');
  });
});

describe('buildScreenStillArgs / buildScreenClipArgs', () => {
  it('writes a single updated image, which is what ffmpeg needs for one PNG', () => {
    const argv = buildScreenStillArgs({ target: macTarget, outputPath: '/tmp/a.png' });
    expect(argv).toContain('-update');
    expect(argv[argv.indexOf('-frames:v') + 1]).toBe('1');
    expect(argv).not.toContain('-vf');
  });

  it('crops to the supplied rect in ffmpeg\'s w:h:x:y order', () => {
    const argv = buildScreenStillArgs({ target: macTarget, outputPath: '/tmp/a.png', crop: { x: 100, y: 50, width: 640, height: 360 } });
    expect(argv[argv.indexOf('-vf') + 1]).toBe('crop=640:360:100:50');
  });

  it('bounds a clip by duration and chains crop before scale', () => {
    const argv = buildScreenClipArgs({
      target: macTarget, outputPath: '/tmp/a.mp4', durationSeconds: 2.5,
      crop: { x: 0, y: 0, width: 1280, height: 720 }, scaleWidth: 640,
    });
    expect(argv[argv.indexOf('-t') + 1]).toBe('2.5');
    expect(argv[argv.indexOf('-vf') + 1]).toBe('crop=1280:720:0:0,scale=640:-2');
    expect(argv[argv.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
  });
});

describe('buildCalibrationArgs', () => {
  it('draws a grid and labels it when a font is available', () => {
    const argv = buildCalibrationArgs({
      target: macTarget, outputPath: '/tmp/cal.png', spacing: 500,
      fontFile: '/System/Library/Fonts/Menlo.ttc', displayWidth: 2560, displayHeight: 1440,
    });
    const filter = argv[argv.indexOf('-vf') + 1] as string;
    expect(filter).toContain('drawgrid=width=500:height=500');
    expect(filter).toContain("text='x\\=500'");
    expect(filter).toContain("text='y\\=1000'");
    // 2560/500 -> x labels at 500..2500 (5), 1440/500 -> y labels at 500,1000 (2)
    expect(filter.split('drawtext').length - 1).toBe(7);
  });

  it('still draws the grid, unlabelled, when no font exists', () => {
    const argv = buildCalibrationArgs({ target: macTarget, outputPath: '/tmp/cal.png', fontFile: null });
    const filter = argv[argv.indexOf('-vf') + 1] as string;
    expect(filter).toContain('drawgrid');
    expect(filter).not.toContain('drawtext');
  });

  it('clamps an absurdly fine grid rather than emitting thousands of labels', () => {
    const argv = buildCalibrationArgs({ target: macTarget, outputPath: '/tmp/cal.png', spacing: 1, fontFile: null });
    expect((argv[argv.indexOf('-vf') + 1] as string)).toContain('width=50:height=50');
  });
});

describe('escapeDrawtextValue', () => {
  it('escapes colons so a timecode survives the filter parser', () => {
    expect(escapeDrawtextValue('00:00:04:12')).toBe('00\\:00\\:04\\:12');
  });

  it('escapes backslashes and quotes', () => {
    expect(escapeDrawtextValue("C:\\Fonts\\a'b.ttf")).toBe("C\\:\\\\\\\\Fonts\\\\\\\\a\\\\'b.ttf");
  });
});

describe('resolveFontFile', () => {
  it('prefers PREMIERE_MCP_CAPTURE_FONT when it points at a real file', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-font-'));
    const fake = join(dir, 'fake.ttf');
    await fs.writeFile(fake, 'not a font, but it exists');
    const prev = process.env.PREMIERE_MCP_CAPTURE_FONT;
    process.env.PREMIERE_MCP_CAPTURE_FONT = fake;
    try {
      expect(await resolveFontFile()).toBe(fake);
    } finally {
      if (prev === undefined) delete process.env.PREMIERE_MCP_CAPTURE_FONT;
      else process.env.PREMIERE_MCP_CAPTURE_FONT = prev;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls through a bad override to a system font, or reports none', async () => {
    const prev = process.env.PREMIERE_MCP_CAPTURE_FONT;
    process.env.PREMIERE_MCP_CAPTURE_FONT = '/definitely/not/here.ttf';
    try {
      const font = await resolveFontFile();
      if (font !== null) await fs.access(font);
    } finally {
      if (prev === undefined) delete process.env.PREMIERE_MCP_CAPTURE_FONT;
      else process.env.PREMIERE_MCP_CAPTURE_FONT = prev;
    }
  });
});

describe('captureScreenStill — input validation before spawning anything', () => {
  const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;
  const maybe = ffmpegAvailable ? it : it.skip;

  maybe('rejects a bad crop rect without capturing', async () => {
    const res = await captureScreenStill({
      target: macTarget,
      outputPath: join(tmpdir(), 'should-not-exist.png'),
      crop: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/at least 2 pixels/);
    expect(res.evidence).toBeUndefined();
  }, 30_000);

  maybe('rejects a non-positive clip duration', async () => {
    const res = await captureScreenClip({ target: macTarget, outputPath: join(tmpdir(), 'no.mp4'), durationSeconds: 0 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/durationSeconds/);
  }, 30_000);
});

/**
 * A real grab of the user's display. Opt-in only.
 */
describe('captureScreenStill / captureScreenClip — live display', () => {
  const optedIn = process.env.PREMIERE_MCP_TEST_SCREEN_GRAB === '1';
  const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;
  const maybe = (optedIn && ffmpegAvailable && process.platform === 'darwin') ? it : it.skip;

  maybe('returns a screen-grab labelled still that never claims to be composited', async () => {
    const out = join(await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-live-')), 'still.png');
    const res = await captureScreenStill({ target: macTarget, outputPath: out, crop: { x: 0, y: 0, width: 640, height: 360 } });
    expect(res.success).toBe(true);
    expect(res.evidence?.provenance).toBe('screen-grab');
    expect(res.evidence?.composited).toBe('unverifiable');
    expect(res.evidence?.width).toBe(640);
    expect(res.evidence?.at.timecode).toBe('unknown');
    await fs.rm(out, { force: true });
  }, 120_000);

  maybe('captures a short moving clip off the display', async () => {
    const out = join(await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-live-')), 'clip.mp4');
    const res = await captureScreenClip({ target: macTarget, outputPath: out, durationSeconds: 1, framerate: 30, scaleWidth: 640 });
    expect(res.success).toBe(true);
    expect(res.evidence?.moving).toBe(true);
    expect(typeof res.frameCount).toBe('number');
    expect(res.frameCount as number).toBeGreaterThan(1);
    expect(res.evidence?.caveats.join(' ')).toMatch(/SCREEN CAPTURE, not a composited render/);
    await fs.rm(out, { force: true });
  }, 120_000);
});
