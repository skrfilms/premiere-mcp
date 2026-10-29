/**
 * The range capture is the answer to "did the clip actually move" and "is the
 * frame at 00:00:04:12 what the edit implies", so the tests are about those two
 * questions: the plan must land on real frames with the right timecodes, and the
 * assembled artifacts must come back labelled with a provenance that matches
 * where the frames came from.
 *
 * The end-to-end runs synthesise their own media with ffmpeg -- a moving clip and
 * a frozen one -- so the motion verdict is checked in both directions. Nothing
 * here touches Premiere; the render tap is exercised through an injected stub,
 * which is also how the failure path (a frame Premiere refuses to give) is
 * tested.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBurnInArgs,
  buildContactSheetArgs,
  buildMotionClipArgs,
  captureFrameStrip,
  mediaFileFrameSource,
  planContactSheetGrid,
  planFrameTimes,
  renderTapFrameSource,
  type FrameSource,
} from '../../capture/frame-strip.js';

describe('planFrameTimes', () => {
  it('spreads count samples across the range, inclusive of both ends, snapped to frames', () => {
    const plan = planFrameTimes({ startSeconds: 0, endSeconds: 1, fps: 24, count: 5 });
    expect(plan.error).toBeUndefined();
    expect(plan.frames.map((f) => f.frame)).toEqual([0, 6, 12, 18, 24]);
    expect(plan.frames.map((f) => f.timecode)).toEqual([
      '00:00:00:00',
      '00:00:00:06',
      '00:00:00:12',
      '00:00:00:18',
      '00:00:01:00',
    ]);
  });

  it('snaps a between-frames request onto a real frame rather than asking for one that does not exist', () => {
    const plan = planFrameTimes({ startSeconds: 1.037, endSeconds: 1.037, fps: 24, count: 1 });
    expect(plan.frames).toHaveLength(1);
    expect(plan.frames[0]?.frame).toBe(25);
    expect(plan.frames[0]?.seconds).toBeCloseTo(25 / 24, 6);
    expect(plan.frames[0]?.timecode).toBe('00:00:01:01');
  });

  it('walks a fixed stride when given everyNFrames', () => {
    const plan = planFrameTimes({ startSeconds: 0, endSeconds: 0.5, fps: 24, everyNFrames: 4 });
    expect(plan.frames.map((f) => f.frame)).toEqual([0, 4, 8, 12]);
  });

  it('refuses to invent a sampling strategy when neither count nor stride is given', () => {
    const plan = planFrameTimes({ startSeconds: 0, endSeconds: 1, fps: 24 });
    expect(plan.frames).toEqual([]);
    expect(plan.error).toMatch(/Neither is defaulted/);
  });

  it('rejects a backwards range and a nonsense frame rate', () => {
    expect(planFrameTimes({ startSeconds: 2, endSeconds: 1, fps: 24, count: 3 }).error).toMatch(
      /before startSeconds/,
    );
    expect(planFrameTimes({ startSeconds: 0, endSeconds: 1, fps: 0, count: 3 }).error).toMatch(
      /positive frame rate/,
    );
  });

  it('collapses duplicate samples and says it did, instead of capturing the same frame twice', () => {
    const plan = planFrameTimes({ startSeconds: 0, endSeconds: 0.08, fps: 24, count: 10 });
    expect(plan.frames.map((f) => f.frame)).toEqual([0, 1, 2]);
    expect(plan.warnings.join(' ')).toMatch(/landed on a frame already being captured/);
  });

  it('caps the plan and warns rather than queueing hundreds of host round trips', () => {
    const plan = planFrameTimes({
      startSeconds: 0,
      endSeconds: 60,
      fps: 24,
      everyNFrames: 1,
      maxFrames: 10,
    });
    expect(plan.frames).toHaveLength(10);
    expect(plan.warnings.join(' ')).toMatch(/trimmed from 1441 to the 10-frame cap/);
  });
});

describe('planContactSheetGrid', () => {
  it('lays frames out in a near-square grid by default', () => {
    expect(planContactSheetGrid(4)).toEqual({ columns: 2, rows: 2 });
    expect(planContactSheetGrid(6)).toEqual({ columns: 3, rows: 2 });
    expect(planContactSheetGrid(1)).toEqual({ columns: 1, rows: 1 });
  });

  it('honours an explicit column count and grows the rows to fit', () => {
    expect(planContactSheetGrid(7, 4)).toEqual({ columns: 4, rows: 2 });
  });
});

describe('ffmpeg argument builders', () => {
  it('escapes the colons in a timecode so drawtext does not read them as option separators', () => {
    const argv = buildBurnInArgs({
      inputPath: '/in.png',
      outputPath: '/out.png',
      fontFile: '/System/Library/Fonts/Menlo.ttc',
      text: '00:00:04:12  f108',
    });
    const filter = argv[argv.indexOf('-vf') + 1] as string;
    expect(filter).toContain("text='00\\:00\\:04\\:12  f108'");
    expect(filter).toContain("fontfile='/System/Library/Fonts/Menlo.ttc'");
  });

  it("escapes a Windows font path's backslashes", () => {
    const argv = buildBurnInArgs({
      inputPath: '/in.png',
      outputPath: '/out.png',
      fontFile: 'C:\\Windows\\Fonts\\consola.ttf',
      text: 'x',
    });
    const filter = argv[argv.indexOf('-vf') + 1] as string;
    expect(filter).toContain('C\\:\\\\\\\\Windows');
  });

  it('tiles the sheet at the requested grid and writes a single image', () => {
    const argv = buildContactSheetArgs({
      inputPattern: '/tmp/s_%04d.png',
      outputPath: '/tmp/sheet.png',
      columns: 3,
      rows: 2,
    });
    expect(argv.join(' ')).toContain('tile=3x2:margin=6:padding=6:color=black');
    expect(argv).toContain('-update');
  });

  it('pads the review clip to even dimensions so h264 can encode it', () => {
    const argv = buildMotionClipArgs({
      inputPattern: '/tmp/s_%04d.png',
      outputPath: '/tmp/r.mp4',
      framerate: 8,
    });
    expect(argv.join(' ')).toContain('pad=ceil(iw/2)*2:ceil(ih/2)*2');
    expect(argv[argv.indexOf('-framerate') + 1]).toBe('8');
  });
});

describe('renderTapFrameSource', () => {
  it('labels its frames as the composited render tap and passes the snapped time through', async () => {
    const calls: Array<{ time: number; path: string }> = [];
    const source = renderTapFrameSource(async (_seqId, time, outputPath) => {
      calls.push({ time, path: outputPath });
      return { success: true, outputPath };
    }, 'SEQ-1');
    expect(source.tap).toBe('render');
    const res = await source.capture({
      index: 0,
      seconds: 1.5,
      frame: 36,
      timecode: '00:00:01:12',
      outputPath: '/tmp/a.png',
    });
    expect(res.success).toBe(true);
    expect(calls[0]).toEqual({ time: 1.5, path: '/tmp/a.png' });
  });

  it("surfaces Premiere's own reason when it returns no frame", async () => {
    const source = renderTapFrameSource(
      async () => ({ success: false, error: 'QE frame export is inert on this build' }),
      'SEQ-1',
    );
    const res = await source.capture({
      index: 0,
      seconds: 0,
      frame: 0,
      timecode: '00:00:00:00',
      outputPath: '/tmp/a.png',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/inert on this build/);
  });
});

describe('mediaFileFrameSource labelling', () => {
  it('calls raw footage a source frame and an export a composited render', () => {
    expect(mediaFileFrameSource('/media/a.mov').tap).toBe('media-file');
    expect(mediaFileFrameSource('/media/a.mov').description).toMatch(/no timeline composite/);
    expect(mediaFileFrameSource('/renders/seq.mp4', 'export-file').tap).toBe('export-file');
    expect(mediaFileFrameSource('/renders/seq.mp4', 'export-file').description).toMatch(
      /composited render/,
    );
  });
});

describe('captureFrameStrip — failures are reported, not smoothed over', () => {
  it('records the frames a source refused and keeps the ones it got', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-strip-fail-'));
    const source: FrameSource = {
      tap: 'render',
      description: 'stub render tap',
      async capture(req) {
        if (req.index === 1) return { success: false, error: 'no clip under the playhead' };
        await fs.writeFile(req.outputPath, 'not really a png');
        return { success: true, path: req.outputPath };
      },
    };
    const plan = planFrameTimes({ startSeconds: 0, endSeconds: 1, fps: 24, count: 3 });
    const res = await captureFrameStrip({ source, plan, workDir: dir, prefix: 'fail' });

    expect(res.frames).toHaveLength(2);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]?.error).toMatch(/no clip under the playhead/);
    expect(res.failures[0]?.timecode).toBe('00:00:00:12');
    expect(res.notes.join(' ')).toMatch(/failed and are absent from the sheet/);
    // The bytes were not an image, so the resolution must be unknown, not guessed.
    expect(res.frames[0]?.width).toBe('unknown');
    await fs.rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("fails outright, with the source's reason, when no frame at all lands", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-strip-none-'));
    const source: FrameSource = {
      tap: 'render',
      description: 'stub render tap',
      capture: async () => ({ success: false, error: 'Premiere is not connected' }),
    };
    const plan = planFrameTimes({ startSeconds: 0, endSeconds: 1, fps: 24, count: 2 });
    const res = await captureFrameStrip({ source, plan, workDir: dir });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no frames at all.*Premiere is not connected/s);
    await fs.rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('refuses an empty or invalid plan', async () => {
    const dir = join(tmpdir(), 'unused');
    const source: FrameSource = {
      tap: 'render',
      description: 'stub',
      capture: async () => ({ success: true, path: '/x' }),
    };
    const bad = await captureFrameStrip({
      source,
      plan: planFrameTimes({ startSeconds: 0, endSeconds: 1, fps: 24 }),
      workDir: dir,
    });
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/Neither is defaulted/);
  });
});

describe('captureFrameStrip — end to end with real ffmpeg', () => {
  const ffmpegAvailable =
    spawnSync('ffmpeg', ['-version']).status === 0 &&
    spawnSync('ffprobe', ['-version']).status === 0;
  const maybe = ffmpegAvailable ? describe : describe.skip;

  maybe('over synthesised media', () => {
    let dir: string;
    let movingClip: string;
    let frozenClip: string;

    beforeAll(async () => {
      dir = await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-strip-'));
      movingClip = join(dir, 'moving.mp4');
      frozenClip = join(dir, 'frozen.mp4');
      const moving = spawnSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=24:duration=3',
        '-pix_fmt',
        'yuv420p',
        movingClip,
      ]);
      expect(moving.status).toBe(0);
      const frozen = spawnSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:size=320x180:rate=24:duration=3',
        '-pix_fmt',
        'yuv420p',
        frozenClip,
      ]);
      expect(frozen.status).toBe(0);
    }, 120_000);

    afterAll(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('captures a labelled range, assembles a sheet and a review clip, and proves the picture moves', async () => {
      const plan = planFrameTimes({ startSeconds: 0, endSeconds: 2, fps: 24, count: 4 });
      const res = await captureFrameStrip({
        source: mediaFileFrameSource(movingClip),
        plan,
        workDir: join(dir, 'moving-out'),
        prefix: 'mv',
        label: 'TEST',
      });

      expect(res.success).toBe(true);
      expect(res.frames).toHaveLength(4);
      expect(res.failures).toHaveLength(0);

      // Provenance: decoded from a file, so a source frame that is NOT composited.
      for (const frame of res.frames) {
        expect(frame.provenance).toBe('source-frame');
        expect(frame.composited).toBe('no');
        expect(frame.width).toBe(320);
        expect(frame.height).toBe(180);
        expect(frame.caveats.join(' ')).toMatch(/no timeline composite/);
      }
      // Timecodes are real and ascending.
      expect(res.frames.map((f) => f.at.timecode)).toEqual([
        '00:00:00:00',
        '00:00:00:16',
        '00:00:01:08',
        '00:00:02:00',
      ]);
      expect(res.frames.map((f) => f.at.frame)).toEqual([0, 16, 32, 48]);

      // Artifacts landed and are measurable.
      expect(res.contactSheet).toBeDefined();
      expect(typeof res.contactSheet?.width).toBe('number');
      expect(res.contactSheet?.width as number).toBeGreaterThan(320);
      expect(res.contactSheet?.moving).toBe(false);
      expect(res.motionClip?.moving).toBe(true);
      await fs.access(res.contactSheet?.path as string);
      await fs.access(res.motionClip?.path as string);

      // The review clip must not be mistaken for real-time motion.
      expect(res.motionClip?.caveats.join(' ')).toMatch(/NOT the sequence's real-time motion/);

      // And the point of the whole exercise: the picture demonstrably changes.
      expect(res.motion?.moved).toBe(true);
      expect(res.motion?.movingPairs).toHaveLength(3);
    }, 300_000);

    it('proves the picture does NOT change over a frozen range', async () => {
      const plan = planFrameTimes({ startSeconds: 0, endSeconds: 2, fps: 24, count: 4 });
      const res = await captureFrameStrip({
        source: mediaFileFrameSource(frozenClip),
        plan,
        workDir: join(dir, 'frozen-out'),
        prefix: 'fz',
        skipMotionClip: true,
      });
      expect(res.success).toBe(true);
      expect(res.frames).toHaveLength(4);
      expect(res.motion?.moved).toBe(false);
      expect(res.motion?.conclusion).toMatch(/does not change across this range/);
      expect(res.motionClip).toBeUndefined();
    }, 300_000);

    it('burns the timecode into the sheet frames, which changes those pixels but not the diffed ones', async () => {
      const plan = planFrameTimes({ startSeconds: 0, endSeconds: 1, fps: 24, count: 2 });
      const workDir = join(dir, 'burn-out');
      const res = await captureFrameStrip({
        source: mediaFileFrameSource(frozenClip),
        plan,
        workDir,
        prefix: 'bn',
      });
      expect(res.success).toBe(true);
      // A font exists on macOS/most Linux images; if not, the run must SAY it skipped.
      if (res.burnedIn) {
        const rawSize = (await fs.stat(join(workDir, 'bn_raw_0000.png'))).size;
        const sheetSize = (await fs.stat(join(workDir, 'bn_sheet_0000.png'))).size;
        expect(sheetSize).not.toBe(rawSize);
      } else {
        expect(res.notes.join(' ')).toMatch(/UNLABELLED/);
      }
      // Either way, the motion verdict came off the RAW frames: a frozen clip
      // with different burnt-in timecodes must still read as not moving.
      expect(res.motion?.moved).toBe(false);
    }, 300_000);

    it('labels frames from a Premiere export as a composited render', async () => {
      const plan = planFrameTimes({ startSeconds: 0, endSeconds: 1, fps: 24, count: 2 });
      const res = await captureFrameStrip({
        source: mediaFileFrameSource(movingClip, 'export-file'),
        plan,
        workDir: join(dir, 'export-out'),
        prefix: 'ex',
        skipMotionClip: true,
      });
      expect(res.success).toBe(true);
      expect(res.frames[0]?.provenance).toBe('composited-render');
      expect(res.frames[0]?.composited).toBe('yes');
      expect(res.frames[0]?.caveats.join(' ')).toMatch(/exported FILE/);
    }, 300_000);
  });
});
