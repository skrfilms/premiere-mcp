/**
 * transcribe_to_srt: local Whisper speech-to-text that fills the gap before
 * create_caption_track (Premiere can ingest an .srt but cannot generate one).
 *
 * The transcription itself shells out to the Whisper CLI, so these tests cover
 * the deterministic contract around it — argument validation, the missing-file
 * guard, and the fail-with-guidance path when Whisper is not installed — rather
 * than driving a real (slow, machine-dependent) model run.
 */

import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';

const noBridge = { executeScript: async () => ({ success: true }) } as never;

describe('transcribe_to_srt', () => {
  let scratch: string;
  beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'skry-transcribe-')); });
  afterAll(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('rejects a call with neither mediaPath nor projectItemId', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('transcribe_to_srt', {});
    expect(result.success).toBe(false);
    // The schema .refine surfaces as an argument-validation error.
    expect(String(result.error)).toMatch(/mediaPath|projectItemId/i);
  });

  it('fails clearly when the media file does not exist', async () => {
    const tools = new PremiereProTools(noBridge);
    const result = await tools.executeTool('transcribe_to_srt', {
      mediaPath: join(scratch, 'does-not-exist.mov'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found or unreadable/i);
  });

  it('fails with install guidance when the Whisper CLI is absent', async () => {
    // A real, readable file clears the existence check; a bogus command name
    // forces the not-available branch deterministically on any machine.
    const media = join(scratch, 'clip.wav');
    writeFileSync(media, 'not really audio, just needs to exist');
    const OLD = process.env.PREMIERE_MCP_WHISPER_CMD;
    process.env.PREMIERE_MCP_WHISPER_CMD = 'skry-whisper-does-not-exist-xyz';
    try {
      const tools = new PremiereProTools(noBridge);
      const result = await tools.executeTool('transcribe_to_srt', { mediaPath: media });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found on PATH/i);
      expect(result.error).toMatch(/pip install -U openai-whisper/);
      expect(result.error).toContain('skry-whisper-does-not-exist-xyz');
    } finally {
      if (OLD === undefined) delete process.env.PREMIERE_MCP_WHISPER_CMD;
      else process.env.PREMIERE_MCP_WHISPER_CMD = OLD;
    }
  });
});
