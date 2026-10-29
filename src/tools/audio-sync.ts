/**
 * Sync clips by their audio: how far apart in time two recordings of the same sound are.
 *
 * Editors ask for this constantly (multicam, double-system sound, sequential clips from several
 * cameras), and Premiere's own "synchronize by audio" is not scriptable. Each file is decoded to
 * 8 kHz mono and cross-correlated against the reference with an FFT; the peak lag is the offset.
 * At 8 kHz one sample is 0.125 ms, far finer than a frame. The score is the normalised
 * correlation at the peak, so a weak match is reported as weak rather than as an answer.
 */
import { spawnSync } from 'node:child_process';
import { ffmpegCmd } from '../capture/ffmpeg.js';

export const SYNC_RATE = 8000;

/** Decode the first `seconds` of a file's audio to mono floats at SYNC_RATE. */
export function decodeAudio(path: string, seconds: number): Float32Array {
  const r = spawnSync(ffmpegCmd(), ['-v', 'error', '-t', String(seconds), '-i', path, '-vn', '-ac', '1', '-ar', String(SYNC_RATE), '-f', 's16le', '-'], { maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`ffmpeg could not read the audio of ${path}: ${String(r.stderr || '').trim().slice(0, 300)}`);
  const b = r.stdout as Buffer;
  const out = new Float32Array(Math.floor(b.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2) / 32768;
  return out;
}

/** In-place iterative radix-2 FFT. re/im have power-of-two length. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!, ai = im[i + k]!;
        const br = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const bi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i]! /= n; im[i]! /= n; }
}

export interface SyncResult { offsetSeconds: number; score: number }

/**
 * Offset of `b` relative to `a`: the time in `a` at which `b`'s first sample happens. Place b at
 * (a's position + offsetSeconds) to line them up. Searches within ±maxOffsetSeconds.
 */
export function findOffset(a: Float32Array, b: Float32Array, rate: number, maxOffsetSeconds: number): SyncResult {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  let ea = 0, eb = 0;
  for (let i = 0; i < a.length; i++) { ar[i] = a[i]!; ea += a[i]! * a[i]!; }
  for (let i = 0; i < b.length; i++) { br[i] = b[i]!; eb += b[i]! * b[i]!; }
  fft(ar, ai, false); fft(br, bi, false);
  // r[L] = sum a[t+L] b[t]  ->  FFT(a) * conj(FFT(b))
  for (let i = 0; i < n; i++) { const r = ar[i]! * br[i]! + ai[i]! * bi[i]!; const im = ai[i]! * br[i]! - ar[i]! * bi[i]!; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  const maxLag = Math.min(Math.floor(maxOffsetSeconds * rate), n / 2 - 1);
  let best = -Infinity, bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = ar[(lag + n) % n]!;
    if (v > best) { best = v; bestLag = lag; }
  }
  const denom = Math.sqrt(ea * eb) || 1;
  return { offsetSeconds: bestLag / rate, score: Math.round((best / denom) * 1000) / 1000 };
}
