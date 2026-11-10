/**
 * ffmpeg/ffprobe are found when the MCP client was started with launchd's minimal PATH (Claude
 * Desktop from the Dock), not only from a shell. Ported in spirit from upstream c8477b4.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from '../../capture/ffmpeg.js';

describe('resolveBinary', () => {
  let dir: string;
  const saved = { PATH: process.env.PATH, X: process.env.TEST_FF_CMD };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pmcp-bin-'));
    writeFileSync(join(dir, 'ffmpeg'), '');
    delete process.env.TEST_FF_CMD;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.PATH = saved.PATH;
    if (saved.X === undefined) delete process.env.TEST_FF_CMD;
    else process.env.TEST_FF_CMD = saved.X;
  });

  it('uses the env override first', () => {
    process.env.TEST_FF_CMD = '  /custom/ffmpeg  ';
    expect(resolveBinary('ffmpeg', 'TEST_FF_CMD', [dir])).toBe('/custom/ffmpeg');
  });

  it('keeps the bare name when it is on PATH', () => {
    process.env.PATH = dir;
    expect(resolveBinary('ffmpeg', 'TEST_FF_CMD', [])).toBe('ffmpeg');
  });

  it('falls back to the full path in a known install folder when PATH lacks it', () => {
    process.env.PATH = '/usr/bin:/bin';
    expect(resolveBinary('ffmpeg', 'TEST_FF_CMD', ['/nonexistent-dir', dir])).toBe(
      join(dir, 'ffmpeg'),
    );
  });

  it('returns the bare name when it is nowhere, so the spawn reports it missing', () => {
    process.env.PATH = '/nonexistent-dir';
    expect(resolveBinary('ffmpeg', 'TEST_FF_CMD', ['/also-nonexistent'])).toBe('ffmpeg');
  });
});
