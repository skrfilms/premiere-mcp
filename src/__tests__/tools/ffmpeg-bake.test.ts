/**
 * bake_speed_change and normalize_loudness: honest ffmpeg escape hatches for two
 * things Premiere's scripting API cannot do — time-remap (the speed keyframe
 * graph has never been scriptable) and loudness measurement/normalization (no
 * scriptable surface at all). Both render a NEW file with ffmpeg via
 * child_process.
 *
 * These tests cover the deterministic contract — argument validation, the
 * missing-file guard, and the fail-with-guidance path when ffmpeg is absent —
 * plus the atempo-chain math, rather than driving a real ffmpeg run (which would
 * make the suite machine-dependent). The happy path is verified manually.
 */

import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';

const noBridge = { executeScript: async () => ({ success: true }) } as never;

describe('bake_speed_change', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'skry-speed-'));
  });
  afterAll(() => {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('rejects a call with neither mediaPath nor projectItemId', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('bake_speed_change', { speed: 2 });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/mediaPath|projectItemId/i);
  });

  it('rejects a non-positive or missing speed', async () => {
    const media = join(scratch, 'clip.mov');
    writeFileSync(media, 'not really media, just needs to exist');
    const tools = new PremiereProTools(noBridge);
    for (const bad of [
      { mediaPath: media },
      { mediaPath: media, speed: 0 },
      { mediaPath: media, speed: -1 },
    ]) {
      const result = await tools.executeTool('bake_speed_change', bad);
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/speed/i);
    }
  });

  it('fails clearly when the media file does not exist', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('bake_speed_change', {
      mediaPath: join(scratch, 'does-not-exist.mov'),
      speed: 2,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found or unreadable/i);
  });

  it('fails with install guidance when ffmpeg is absent', async () => {
    const media = join(scratch, 'clip.mov');
    writeFileSync(media, 'not really media, just needs to exist');
    const OLD = process.env.PREMIERE_MCP_FFMPEG_CMD;
    process.env.PREMIERE_MCP_FFMPEG_CMD = 'skry-ffmpeg-does-not-exist-xyz';
    try {
      const tools = new PremiereProTools(noBridge);
      const result = await tools.executeTool('bake_speed_change', { mediaPath: media, speed: 0.5 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found on PATH/i);
      expect(result.error).toMatch(/brew install ffmpeg/);
      expect(result.error).toContain('skry-ffmpeg-does-not-exist-xyz');
    } finally {
      if (OLD === undefined) delete process.env.PREMIERE_MCP_FFMPEG_CMD;
      else process.env.PREMIERE_MCP_FFMPEG_CMD = OLD;
    }
  });
});

describe('bake_speed_change — atempo chain math', () => {
  // Reach the private helper through the instance; it is pure and deterministic.
  const chain = (speed: number): string =>
    (
      new PremiereProTools(noBridge) as unknown as { buildAtempoChain(s: number): string }
    ).buildAtempoChain(speed);

  it('leaves in-range factors as a single atempo', () => {
    expect(chain(1)).toBe('atempo=1');
    expect(chain(2)).toBe('atempo=2');
    expect(chain(0.5)).toBe('atempo=0.5');
    expect(chain(1.5)).toBe('atempo=1.5');
  });

  it('decomposes an out-of-range fast factor into in-range steps', () => {
    expect(chain(4)).toBe('atempo=2,atempo=2');
    expect(chain(8)).toBe('atempo=2,atempo=2,atempo=2');
    // 3x -> one halving step (2) then 1.5
    expect(chain(3)).toBe('atempo=2,atempo=1.5');
  });

  it('decomposes an out-of-range slow factor into in-range steps', () => {
    expect(chain(0.25)).toBe('atempo=0.5,atempo=0.5');
    expect(chain(0.125)).toBe('atempo=0.5,atempo=0.5,atempo=0.5');
  });

  it("every step of any produced chain is within ffmpeg's [0.5, 2.0] atempo range", () => {
    for (const speed of [0.1, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 10]) {
      const factors = chain(speed)
        .split(',')
        .map((s) => Number(s.replace('atempo=', '')));
      const product = factors.reduce((a, b) => a * b, 1);
      for (const f of factors) {
        expect(f).toBeGreaterThanOrEqual(0.5 - 1e-6);
        expect(f).toBeLessThanOrEqual(2.0 + 1e-6);
      }
      // The chain must actually multiply back to the requested speed.
      expect(product).toBeCloseTo(speed, 4);
    }
  });
});

describe('normalize_loudness', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'skry-loud-'));
  });
  afterAll(() => {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('rejects a call with neither mediaPath nor projectItemId', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('normalize_loudness', { targetLufs: -14 });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/mediaPath|projectItemId/i);
  });

  it('fails clearly when the media file does not exist', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('normalize_loudness', {
      mediaPath: join(scratch, 'does-not-exist.wav'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found or unreadable/i);
  });

  it('fails with install guidance when ffmpeg is absent', async () => {
    const media = join(scratch, 'clip.wav');
    writeFileSync(media, 'not really media, just needs to exist');
    const OLD = process.env.PREMIERE_MCP_FFMPEG_CMD;
    process.env.PREMIERE_MCP_FFMPEG_CMD = 'skry-ffmpeg-does-not-exist-xyz';
    try {
      const tools = new PremiereProTools(noBridge);
      const result = await tools.executeTool('normalize_loudness', {
        mediaPath: media,
        targetLufs: -23,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found on PATH/i);
      expect(result.error).toMatch(/brew install ffmpeg/);
      expect(result.error).toContain('skry-ffmpeg-does-not-exist-xyz');
    } finally {
      if (OLD === undefined) delete process.env.PREMIERE_MCP_FFMPEG_CMD;
      else process.env.PREMIERE_MCP_FFMPEG_CMD = OLD;
    }
  });
});
