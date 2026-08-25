/**
 * Frame diffing is the part of the layer that turns "I think nothing changed"
 * into a number, so the pure verdict logic is tested against the exact metric
 * shapes ffmpeg emits, and then the whole thing is run end to end against a clip
 * synthesised on the spot -- identical frames must come back identical, moving
 * frames must come back changed, and mismatched sizes must be refused rather
 * than quietly rescaled.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeMotion,
  classifyDifference,
  diffFrames,
  parsePsnrSummary,
  parseSignalstatsMetadata,
  parseSsimSummary,
  summarizeMotion,
  type DiffMetrics,
  type MotionPair,
} from '../../capture/frame-diff.js';

/** Verbatim metadata=print output shape from a blend/signalstats chain. */
const SIGNALSTATS_TEXT = `frame:0    pts:0       pts_time:0
lavfi.signalstats.YMIN=0
lavfi.signalstats.YAVG=11.5963
lavfi.signalstats.YMAX=151
frame:1    pts:1       pts_time:0.04
lavfi.signalstats.YAVG=0
lavfi.signalstats.YMAX=0
`;

const PSNR_LINE = '[Parsed_psnr_0 @ 0x600003884000] PSNR r:11.115953 g:12.675107 b:14.550950 average:12.559171 min:12.559171 max:12.559171';
const PSNR_INF_LINE = '[Parsed_psnr_0 @ 0x60000025c600] PSNR r:inf g:inf b:inf average:inf min:inf max:inf';
const SSIM_LINE = '[Parsed_ssim_0 @ 0x600002d00180] SSIM R:0.694177 (5.145296) G:0.761907 (6.232531) B:0.745252 (5.938886) All:0.733778 (5.747568)';

describe('parseSignalstatsMetadata', () => {
  it('reads one record per frame with the mean and peak difference', () => {
    expect(parseSignalstatsMetadata(SIGNALSTATS_TEXT)).toEqual([
      { frame: 0, meanAbsDiff: 11.5963, maxAbsDiff: 151 },
      { frame: 1, meanAbsDiff: 0, maxAbsDiff: 0 },
    ]);
  });

  it('drops a frame block that is missing a statistic rather than inventing one', () => {
    expect(parseSignalstatsMetadata('frame:0 pts:0\nlavfi.signalstats.YAVG=3\n')).toEqual([]);
  });

  it('returns nothing for output with no statistics at all', () => {
    expect(parseSignalstatsMetadata('ffmpeg: command not found')).toEqual([]);
  });
});

describe('parsePsnrSummary / parseSsimSummary', () => {
  it('reads the average PSNR', () => {
    expect(parsePsnrSummary(PSNR_LINE)).toBeCloseTo(12.559171, 5);
  });

  it('reports bit-identical frames as infinite rather than a made-up ceiling', () => {
    expect(parsePsnrSummary(PSNR_INF_LINE)).toBe('infinite');
  });

  it('reads the combined SSIM', () => {
    expect(parseSsimSummary(SSIM_LINE)).toBeCloseTo(0.733778, 5);
  });

  it('reports unknown when the line is absent', () => {
    expect(parsePsnrSummary('nothing here')).toBe('unknown');
    expect(parseSsimSummary('nothing here')).toBe('unknown');
  });
});

describe('classifyDifference', () => {
  const metrics = (meanAbsDiff: DiffMetrics['meanAbsDiff'], maxAbsDiff: DiffMetrics['maxAbsDiff']): DiffMetrics => ({
    meanAbsDiff, maxAbsDiff, psnrAverage: 'unknown', ssimAll: 'unknown',
  });

  it('calls a zero difference identical', () => {
    const res = classifyDifference(metrics(0, 0));
    expect(res.verdict).toBe('identical');
    expect(res.reason).toMatch(/same picture/);
  });

  it('calls codec-level noise near-identical instead of changed', () => {
    expect(classifyDifference(metrics(0.02, 3)).verdict).toBe('near-identical');
  });

  it('calls a real change changed, even when the mean is tiny, if a pixel moved far', () => {
    // A small graphic on a large frame: low mean, high peak.
    expect(classifyDifference(metrics(0.02, 200)).verdict).toBe('changed');
  });

  it('calls a broad shift changed', () => {
    expect(classifyDifference(metrics(11.6, 151)).verdict).toBe('changed');
  });

  it('refuses a verdict when the measurement failed, and says not to read it as unchanged', () => {
    const res = classifyDifference(metrics('unknown', 'unknown'));
    expect(res.verdict).toBe('unknown');
    expect(res.reason).toMatch(/Do not read this as "unchanged"/);
  });

  it('honours caller thresholds', () => {
    expect(classifyDifference(metrics(0.4, 4), { nearIdenticalMeanAbsDiff: 0.1, nearIdenticalMaxAbsDiff: 8 }).verdict).toBe('changed');
  });
});

describe('summarizeMotion', () => {
  const pair = (i: number, verdict: MotionPair['verdict'], mean: number): MotionPair => ({
    fromIndex: i, toIndex: i + 1, from: `/f${i}.png`, to: `/f${i + 1}.png`,
    meanAbsDiff: mean, maxAbsDiff: mean * 10, verdict,
  });

  it('says the picture moved when any measured pair differs', () => {
    const summary = summarizeMotion([pair(0, 'changed', 5), pair(1, 'identical', 0)]);
    expect(summary.moved).toBe(true);
    expect(summary.staticPairs).toHaveLength(1);
    expect(summary.conclusion).toMatch(/static/);
  });

  it('says the picture does not change when every measured pair is identical', () => {
    const summary = summarizeMotion([pair(0, 'identical', 0), pair(1, 'near-identical', 0.01)]);
    expect(summary.moved).toBe(false);
    expect(summary.conclusion).toMatch(/does not change/);
  });

  it('never counts an unmeasured pair as static', () => {
    const summary = summarizeMotion([pair(0, 'unknown', 0), pair(1, 'unknown', 0)]);
    expect(summary.moved).toBe(false);
    expect(summary.staticPairs).toHaveLength(0);
    expect(summary.unmeasuredPairs).toHaveLength(2);
    expect(summary.conclusion).toMatch(/not evidence that the picture is frozen/);
  });

  it('averages only the pairs it could measure', () => {
    const summary = summarizeMotion([pair(0, 'changed', 10), pair(1, 'changed', 20), pair(2, 'unknown', 999)]);
    expect(summary.meanOfMeans).toBe(15);
  });

  it('says nothing at all about motion when given no pairs', () => {
    const summary = summarizeMotion([]);
    expect(summary.moved).toBe(false);
    expect(summary.conclusion).toMatch(/nothing can be said/);
  });
});

describe('diffFrames / analyzeMotion — end to end with real ffmpeg', () => {
  const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0
    && spawnSync('ffprobe', ['-version']).status === 0;
  const maybe = ffmpegAvailable ? describe : describe.skip;

  maybe('against a synthesised clip', () => {
    let dir: string;
    let moving0: string;
    let moving1: string;
    let moving2: string;
    let copyOfMoving0: string;
    let smaller: string;

    beforeAll(async () => {
      dir = await fs.mkdtemp(join(tmpdir(), 'premiere-mcp-diff-'));
      const clip = join(dir, 'moving.mp4');
      // testsrc2 has a moving element, so consecutive frames genuinely differ.
      const gen = spawnSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'testsrc2=size=320x180:rate=24:duration=2',
        '-pix_fmt', 'yuv420p', clip,
      ]);
      expect(gen.status).toBe(0);

      const grab = (t: string, out: string) => {
        const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', t, '-i', clip, '-frames:v', '1', '-update', '1', out]);
        expect(res.status).toBe(0);
      };
      moving0 = join(dir, 'f0.png');
      moving1 = join(dir, 'f1.png');
      moving2 = join(dir, 'f2.png');
      grab('0', moving0);
      grab('0.5', moving1);
      grab('1.0', moving2);

      copyOfMoving0 = join(dir, 'f0-copy.png');
      await fs.copyFile(moving0, copyOfMoving0);

      smaller = join(dir, 'small.png');
      const shrink = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', moving0, '-vf', 'scale=160:90', '-update', '1', smaller]);
      expect(shrink.status).toBe(0);
    }, 120_000);

    afterAll(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('measures a byte-identical pair as identical, with infinite PSNR', async () => {
      const res = await diffFrames(moving0, copyOfMoving0);
      expect(res.success).toBe(true);
      expect(res.verdict).toBe('identical');
      expect(res.metrics?.meanAbsDiff).toBe(0);
      expect(res.metrics?.maxAbsDiff).toBe(0);
      expect(res.metrics?.psnrAverage).toBe('infinite');
      expect(res.metrics?.ssimAll).toBe(1);
      expect(res.dimensions?.matched).toBe(true);
    }, 120_000);

    it('measures two different frames as changed, with real numbers', async () => {
      const res = await diffFrames(moving0, moving1);
      expect(res.success).toBe(true);
      expect(res.verdict).toBe('changed');
      expect(typeof res.metrics?.meanAbsDiff).toBe('number');
      expect(res.metrics?.meanAbsDiff as number).toBeGreaterThan(0.5);
      expect(res.metrics?.maxAbsDiff as number).toBeGreaterThan(8);
      expect(res.metrics?.psnrAverage).not.toBe('infinite');
      expect(res.metrics?.ssimAll as number).toBeLessThan(1);
    }, 120_000);

    it('refuses to compare frames of different sizes instead of rescaling one', async () => {
      const res = await diffFrames(moving0, smaller);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/different \(or unreadable\) sizes: 320x180 vs 160x90/);
      expect(res.dimensions?.matched).toBe(false);
    }, 120_000);

    it('reports honestly when a frame does not exist', async () => {
      const res = await diffFrames(moving0, join(dir, 'nope.png'));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/unreadable|unknown/);
    }, 120_000);

    it('proves motion across a sequence of frames', async () => {
      const res = await analyzeMotion([moving0, moving1, moving2]);
      expect(res.success).toBe(true);
      expect(res.pairs).toHaveLength(2);
      expect(res.summary?.moved).toBe(true);
      expect(res.summary?.movingPairs).toHaveLength(2);
      expect(res.summary?.conclusion).toMatch(/changes continuously/);
    }, 180_000);

    it('proves the ABSENCE of motion when the same frame is repeated', async () => {
      const res = await analyzeMotion([moving0, copyOfMoving0, moving0]);
      expect(res.success).toBe(true);
      expect(res.summary?.moved).toBe(false);
      expect(res.summary?.conclusion).toMatch(/does not change/);
    }, 180_000);

    it('will not guess about motion from a single frame', async () => {
      const res = await analyzeMotion([moving0]);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/At least two frames/);
    });
  });
});
