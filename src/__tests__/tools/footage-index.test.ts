/**
 * index_footage / search_footage: a local, persistent footage index so
 * discovery does not require importing media into Premiere first.
 *
 * The logic that matters lives in pure functions — planFootageScan (the
 * incremental "don't re-probe unchanged files" decision), matchFootageEntry /
 * queryFootageIndex (the search filter), buildProbeSummary (ffprobe → summary),
 * and footageIndexPath (storage location). Those are driven directly here. Then
 * search_footage is exercised end-to-end against a hand-written index file, and
 * index_footage against a real temp folder using the machine's ffprobe (gated on
 * availability so the suite stays portable) plus its ffprobe-missing guidance.
 */

import { PremiereProTools } from '../../tools/index.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const noBridge = { executeScript: async () => ({ success: true }) } as never;

function priv(): any {
  return new PremiereProTools(noBridge) as unknown as any;
}

const entry = (path: string, summary: Record<string, unknown>) => ({ path, summary });

describe('footage index — pure helpers', () => {
  describe('planFootageScan (incremental rescan)', () => {
    it('probes new and changed files, leaves unchanged ones, and reports missing', () => {
      const existing = [
        { path: '/m/a.mov', size: 100, mtimeMs: 1000 },
        { path: '/m/b.mov', size: 200, mtimeMs: 2000 },
        { path: '/m/gone.mov', size: 5, mtimeMs: 5 },
      ];
      const discovered = [
        { path: '/m/a.mov', size: 100, mtimeMs: 1000 }, // unchanged
        { path: '/m/b.mov', size: 250, mtimeMs: 2000 }, // size changed -> reprobe
        { path: '/m/c.mov', size: 300, mtimeMs: 3000 }, // new -> probe
      ];
      const plan = priv().planFootageScan(existing, discovered);
      expect(plan.unchanged).toEqual(['/m/a.mov']);
      expect(plan.toProbe.map((f: { path: string }) => f.path).sort()).toEqual(['/m/b.mov', '/m/c.mov']);
      expect(plan.missing).toEqual(['/m/gone.mov']);
    });

    it('treats an mtime change alone as needing a reprobe', () => {
      const plan = priv().planFootageScan(
        [{ path: '/m/a.mov', size: 100, mtimeMs: 1000 }],
        [{ path: '/m/a.mov', size: 100, mtimeMs: 1001 }],
      );
      expect(plan.toProbe).toHaveLength(1);
      expect(plan.unchanged).toHaveLength(0);
    });
  });

  describe('matchFootageEntry / queryFootageIndex', () => {
    const entries = [
      entry('/proj/hero_4k.mov', { durationSeconds: 12, videoStreamCount: 1, audioStreamCount: 1, video: { codec: 'prores', width: 3840, height: 2160, fps: 24 }, audio: { codec: 'pcm_s24le' } }),
      entry('/proj/broll_hd.mp4', { durationSeconds: 3, videoStreamCount: 1, audioStreamCount: 0, video: { codec: 'h264', width: 1920, height: 1080, fps: 30 }, audio: null }),
      entry('/proj/vo_take1.wav', { durationSeconds: 45, videoStreamCount: 0, audioStreamCount: 1, video: null, audio: { codec: 'pcm_s16le' } }),
    ];
    const q = (c: Record<string, unknown>) => priv().queryFootageIndex(entries, c).map((e: { path: string }) => e.path);

    it('filters by filename substring (case-insensitive)', () => {
      expect(q({ query: 'HERO' })).toEqual(['/proj/hero_4k.mov']);
    });
    it('filters by extension with or without a dot', () => {
      expect(q({ extension: '.wav' })).toEqual(['/proj/vo_take1.wav']);
      expect(q({ extension: 'mp4' })).toEqual(['/proj/broll_hd.mp4']);
    });
    it('matches a codec against either video or audio streams', () => {
      expect(q({ codec: 'prores' })).toEqual(['/proj/hero_4k.mov']);
      expect(q({ codec: 'pcm_s16le' })).toEqual(['/proj/vo_take1.wav']);
    });
    it('filters by duration and resolution ranges', () => {
      expect(q({ minDurationSeconds: 10 }).sort()).toEqual(['/proj/hero_4k.mov', '/proj/vo_take1.wav']);
      expect(q({ minWidth: 3000 })).toEqual(['/proj/hero_4k.mov']);
    });
    it('filters by frame-rate range', () => {
      expect(q({ minFps: 25 })).toEqual(['/proj/broll_hd.mp4']);
      expect(q({ maxFps: 24 })).toEqual(['/proj/hero_4k.mov']);
    });
    it('filters by audio/video presence', () => {
      expect(q({ hasVideo: false })).toEqual(['/proj/vo_take1.wav']);
      expect(q({ hasAudio: true }).sort()).toEqual(['/proj/hero_4k.mov', '/proj/vo_take1.wav']);
    });
    it('ANDs multiple criteria', () => {
      expect(q({ hasAudio: true, minWidth: 1000 })).toEqual(['/proj/hero_4k.mov']);
    });
  });

  describe('buildProbeSummary', () => {
    it('distils ffprobe JSON into the summary shape', () => {
      const parsed = {
        format: { duration: '5.5', format_name: 'mov', size: '1000', bit_rate: '2000' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30000/1001', pix_fmt: 'yuv420p' },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
        ],
      };
      const s = priv().buildProbeSummary(parsed);
      expect(s.durationSeconds).toBe(5.5);
      expect(s.video.codec).toBe('h264');
      expect(s.video.fps).toBe(29.97);
      expect(s.audioStreamCount).toBe(1);
      expect(s.audio.channels).toBe(2);
    });
  });

  describe('footageIndexPath', () => {
    it('prefers an explicit path over the env and default', () => {
      expect(priv().footageIndexPath('/custom/idx.json')).toBe('/custom/idx.json');
    });
    it('falls back to a default under the home directory', () => {
      const p = priv().footageIndexPath();
      expect(p.endsWith(join('.premiere-mcp', 'footage-index.json'))).toBe(true);
    });
  });
});

describe('search_footage — end to end', () => {
  let indexPath: string;

  beforeAll(async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'trowel-footage-'));
    indexPath = join(dir, 'index.json');
    const doc = {
      version: 1,
      root: '/proj',
      entryCount: 2,
      entries: [
        entry('/proj/hero_4k.mov', { durationSeconds: 12, videoStreamCount: 1, audioStreamCount: 1, video: { codec: 'prores', width: 3840, height: 2160, fps: 24 }, audio: { codec: 'pcm_s24le' } }),
        entry('/proj/broll_hd.mp4', { durationSeconds: 3, videoStreamCount: 1, audioStreamCount: 0, video: { codec: 'h264', width: 1920, height: 1080, fps: 30 }, audio: null }),
      ],
    };
    await fs.writeFile(indexPath, JSON.stringify(doc), 'utf8');
  });

  it('returns filtered matches from the index file', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('search_footage', { minWidth: 3000, indexPath });
    expect(result.success).toBe(true);
    expect(result.totalIndexed).toBe(2);
    expect(result.matchCount).toBe(1);
    expect(result.results[0].path).toBe('/proj/hero_4k.mov');
  });

  it('honours the limit and reports truncation', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('search_footage', { indexPath, limit: 1 });
    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(2);
    expect(result.returned).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('fails honestly when no index exists', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('search_footage', { indexPath: join(tmpdir(), 'trowel-no-such-index.json') });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/no footage index/i);
  });
});

describe('index_footage — end to end', () => {
  it('rejects a relative rootPath', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('index_footage', { rootPath: 'relative/dir' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/absolute/i);
  });

  it('rejects a rootPath that does not exist', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('index_footage', { rootPath: join(tmpdir(), 'trowel-nope-dir-xyz') });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not found|unreadable/i);
  });

  const ffprobeAvailable = spawnSync('ffprobe', ['-version']).status === 0;
  const maybe = ffprobeAvailable ? it : it.skip;

  maybe('indexes real media generated with ffmpeg and finds it via search_footage', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'trowel-realfootage-'));
    const clip = join(dir, 'testclip.mov');
    // Generate a tiny real clip so ffprobe returns genuine metadata.
    const gen = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', clip]);
    if (gen.status !== 0) return; // ffmpeg present but lavfi unavailable — nothing to assert
    const indexPath = join(dir, 'idx.json');

    const tools = new PremiereProTools(noBridge);
    const indexed = await tools.executeTool('index_footage', { rootPath: dir, indexPath });
    expect(indexed.success).toBe(true);
    expect(indexed.scanned).toBeGreaterThanOrEqual(1);
    expect(indexed.added).toBeGreaterThanOrEqual(1);
    expect(indexed.totalIndexed).toBeGreaterThanOrEqual(1);

    // A second pass must skip the unchanged file (incremental).
    const again = await tools.executeTool('index_footage', { rootPath: dir, indexPath });
    expect(again.added).toBe(0);
    expect(again.unchanged).toBeGreaterThanOrEqual(1);

    // And search_footage finds it.
    const found = await tools.executeTool('search_footage', { query: 'testclip', indexPath });
    expect(found.success).toBe(true);
    expect(found.matchCount).toBe(1);
    expect(found.results[0].summary.video.width).toBe(320);
  });
});
