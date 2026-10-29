/**
 * probe_media and generate_scope: local ffmpeg/ffprobe media analysis that
 * Premiere cannot do from its scripting API (no deep metadata for un-imported
 * files; Lumetri scopes are not scriptable or exportable at all).
 *
 * Both shell out to external binaries, so these tests cover the deterministic
 * contract around them — argument validation, the missing-file guard, and the
 * fail-with-guidance path when the binary is absent — rather than driving a real
 * ffmpeg run (which would make the suite machine-dependent). The happy path is
 * verified manually against synthetic ffmpeg sources.
 */

import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';

const noBridge = { executeScript: async () => ({ success: true }) } as never;

describe('probe_media', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'skry-probe-'));
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
    const result = await tools.executeTool('probe_media', {});
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/mediaPath|projectItemId/i);
  });

  it('fails clearly when the media file does not exist', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('probe_media', {
      mediaPath: join(scratch, 'does-not-exist.mov'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found or unreadable/i);
  });

  it('fails with install guidance when ffprobe is absent', async () => {
    // A real, readable file clears the existence check; a bogus command name
    // forces the not-available branch deterministically on any machine.
    const media = join(scratch, 'clip.mov');
    writeFileSync(media, 'not really media, just needs to exist');
    const OLD = process.env.PREMIERE_MCP_FFPROBE_CMD;
    process.env.PREMIERE_MCP_FFPROBE_CMD = 'skry-ffprobe-does-not-exist-xyz';
    try {
      const tools = new PremiereProTools(noBridge);
      const result = await tools.executeTool('probe_media', { mediaPath: media });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found on PATH/i);
      expect(result.error).toMatch(/brew install ffmpeg/);
      expect(result.error).toContain('skry-ffprobe-does-not-exist-xyz');
    } finally {
      if (OLD === undefined) delete process.env.PREMIERE_MCP_FFPROBE_CMD;
      else process.env.PREMIERE_MCP_FFPROBE_CMD = OLD;
    }
  });
});

describe('generate_scope', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'skry-scope-'));
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
    const result = await tools.executeTool('generate_scope', { scope: 'waveform' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/mediaPath|projectItemId/i);
  });

  it('fails clearly when the media file does not exist', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('generate_scope', {
      mediaPath: join(scratch, 'does-not-exist.mov'),
      scope: 'vectorscope',
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
      const result = await tools.executeTool('generate_scope', {
        mediaPath: media,
        scope: 'histogram',
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
