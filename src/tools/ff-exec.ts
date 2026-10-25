/**
 * Synchronous ffmpeg/ffprobe for the tool domains, with no shell in between.
 *
 * Every call site used to build a command string and hand it to execSync, which runs it through
 * /bin/sh. Paths came straight from tool arguments, so a mediaPath containing a double quote
 * closed the quoting and whatever followed ran as a shell command. Arguments now go to the binary
 * as an argv array, so a path is only ever a path. The binaries honour PREMIERE_MCP_FFMPEG_CMD /
 * PREMIERE_MCP_FFPROBE_CMD like the capture layer does, which those call sites also ignored.
 */

import { spawnSync } from 'node:child_process';
import { ffmpegCmd, ffprobeCmd, FFMPEG_INSTALL_GUIDANCE, FFPROBE_INSTALL_GUIDANCE } from '../capture/ffmpeg.js';

export interface FfOptions {
  timeoutMs?: number;
  /**
   * Return stdout followed by stderr. ffmpeg writes filter reports (psnr, silencedetect,
   * blackdetect, freezedetect) to stderr, which the shell versions captured with 2>&1.
   */
  mergeStderr?: boolean;
  /** Treat a non-zero exit as success. ffmpeg's -f null runs can exit non-zero after reporting. */
  allowNonZero?: boolean;
}

/**
 * Run ffmpeg or ffprobe and return its output. Throws an Error on spawn failure (with install
 * guidance), timeout, or non-zero exit, so existing try/catch call sites keep their shape.
 */
export function runFf(tool: 'ffmpeg' | 'ffprobe', args: string[], opts: FfOptions = {}): string {
  const cmd = tool === 'ffmpeg' ? ffmpegCmd() : ffprobeCmd();
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`${tool} was not found (${cmd}). ${tool === 'ffmpeg' ? FFMPEG_INSTALL_GUIDANCE : FFPROBE_INSTALL_GUIDANCE}`);
    }
    if (code === 'ETIMEDOUT') throw new Error(`${tool} timed out after ${opts.timeoutMs ?? 30_000}ms`);
    throw res.error;
  }
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  if (res.status !== 0 && !opts.allowNonZero) {
    throw new Error(`${tool} exited with status ${res.status}: ${stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 800)}`);
  }
  return opts.mergeStderr ? stdout + stderr : stdout;
}
