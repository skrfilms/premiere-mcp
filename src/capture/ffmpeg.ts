/**
 * The one place this layer touches ffmpeg/ffprobe.
 *
 * Same conventions as the rest of the server: the binary name is overridable
 * with PREMIERE_MCP_FFMPEG_CMD / PREMIERE_MCP_FFPROBE_CMD, absence is reported
 * with install guidance rather than crashing, and every write is verified on
 * disk before anything claims success.
 *
 * Argument construction lives in pure `build*Args` functions elsewhere in this
 * folder so the interesting logic can be tested without spawning anything.
 */

import { spawn } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import type { Known } from './types.js';
import { UNKNOWN } from './types.js';

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the binary could not be spawned at all. */
  spawnError?: string;
}

export function ffmpegCmd(): string {
  return (process.env.PREMIERE_MCP_FFMPEG_CMD || 'ffmpeg').trim() || 'ffmpeg';
}

export function ffprobeCmd(): string {
  return (process.env.PREMIERE_MCP_FFPROBE_CMD || 'ffprobe').trim() || 'ffprobe';
}

export const FFMPEG_INSTALL_GUIDANCE =
  'Install ffmpeg and put it on PATH (macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`), or set PREMIERE_MCP_FFMPEG_CMD to its full path.';

export const FFPROBE_INSTALL_GUIDANCE =
  'ffprobe ships with ffmpeg (macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`), or set PREMIERE_MCP_FFPROBE_CMD to its full path.';

/**
 * Run a binary to completion, capturing both streams. Never throws: a missing
 * binary comes back as ok:false with spawnError so callers can turn it into
 * install guidance.
 *
 * `timeoutMs` exists because a capture device can block forever if the OS
 * withholds a permission; we would rather return an honest timeout than hang
 * the MCP request.
 */
export function runBinary(cmd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const proc = spawn(cmd, args);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`,
      });
    }, timeoutMs);

    proc.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    proc.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, spawnError: err.message });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** Is this binary runnable at all? Cheap `-version` probe. */
export async function binaryAvailable(cmd: string): Promise<boolean> {
  const res = await runBinary(cmd, ['-version'], 10_000);
  return res.ok && !res.spawnError;
}

/** Does a readable file exist at this path? */
export async function fileReadable(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(path: string): Promise<Known<number>> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return UNKNOWN;
  }
}

/**
 * Read a still or video's pixel dimensions with ffprobe. Returns 'unknown' for
 * both when ffprobe is absent or the file is unreadable -- never 0x0, which a
 * consumer could mistake for a real measurement.
 */
export async function probeDimensions(
  path: string,
): Promise<{ width: Known<number>; height: Known<number> }> {
  const res = await runBinary(
    ffprobeCmd(),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      path,
    ],
    20_000,
  );
  if (!res.ok) return { width: UNKNOWN, height: UNKNOWN };
  return parseDimensionCsv(res.stdout);
}

/** Pure: parse `1920,1080` (possibly with trailing junk/newlines) from ffprobe csv output. */
export function parseDimensionCsv(stdout: string): { width: Known<number>; height: Known<number> } {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^\d+,\d+/.test(l));
  if (!line) return { width: UNKNOWN, height: UNKNOWN };
  const [w, h] = line.split(',');
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: UNKNOWN, height: UNKNOWN };
  }
  return { width, height };
}

/** Count decoded video frames in a file (used to prove a capture really moved). */
export async function probeFrameCount(path: string): Promise<Known<number>> {
  const res = await runBinary(
    ffprobeCmd(),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-count_frames',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      path,
    ],
    60_000,
  );
  if (!res.ok) return UNKNOWN;
  const n = Number(res.stdout.trim().split('\n')[0]);
  return Number.isFinite(n) && n >= 0 ? n : UNKNOWN;
}
