/**
 * Media paths reach ffmpeg/ffprobe as argv entries, never through a shell.
 *
 * Until 2026-10-25, ~30 call sites interpolated caller-supplied paths into a command string for
 * execSync, so a path like `x"; touch /tmp/owned; echo "` ran `touch`. JSON.stringify quoting did
 * not help either: $(...) and backticks still expand inside double quotes. Two guards: a source
 * scan that bans the pattern, and a behavioural check that a hostile path runs nothing.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';

const TOOLS_DIR = join(__dirname, '..', '..', 'tools');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('no shell between tools and ffmpeg', () => {
  it('no tool source builds an interpolated execSync command', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(TOOLS_DIR)) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\bexecSync\s*\(\s*`[^`]*\$\{/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
      const text = lines.join('\n');
      if (/\bexecSync\s*\(\s*\n\s*`[^`]*\$\{/.test(text)) offenders.push(`${f} (multi-line)`);
    }
    expect(offenders).toEqual([]);
  });

  const marker = join(tmpdir(), `premiere-mcp-injection-${process.pid}`);
  const hostile = `/nonexistent/x"; touch ${marker}; echo "$(touch ${marker})\`touch ${marker}\``;
  const bridge = {
    executeScript: async () => ({
      success: true,
      mediaPath: hostile,
      path: hostile,
      sourceTimeSecs: 0,
      duration: 1,
    }),
  };

  afterEach(() => {
    try {
      rmSync(marker, { force: true });
    } catch {
      /* none */
    }
  });

  it.each([
    ['black_frame_scan', { filePath: hostile }],
    ['freeze_frame_scan', { filePath: hostile }],
    ['flash_frame_scan', { filePath: hostile }],
    ['broadcast_safe_check', { mediaPath: hostile }],
    [
      'false_color_frame',
      { mediaPath: hostile, timeSecs: 0, outputPath: join(tmpdir(), 'pmcp-fc.png') },
    ],
    ['extract_palette', { mediaPath: hostile }],
    ['loudness_report', { filePath: hostile }],
    ['audio_peaks_report', { filePath: hostile }],
    ['detect_silence', { filePath: hostile }],
    ['verify_export', { filePath: hostile }],
  ])('%s runs no shell for a hostile path', async (name, args) => {
    process.env.PREMIERE_MCP_PROFILE = 'all';
    const tools = new PremiereProTools(bridge as never);
    await tools.executeTool(name, args as Record<string, unknown>);
    expect(existsSync(marker)).toBe(false);
  });
});
