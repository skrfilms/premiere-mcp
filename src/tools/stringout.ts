/**
 * Rough cut from a transcript: quoted lines -> source ranges -> a stringout sequence.
 *
 * The editor's paper edit ("use 'we never planned to go back', then 'the engine was already
 * dead'") becomes an assembly without scrubbing. Quotes are found in the transcript by their
 * words, ignoring case and punctuation. Whisper JSON gives real word times; an .srt only gives
 * cue times, so word times inside a cue are spread by character position, which lands within a
 * few frames for normal speech and is why handles exist. Pure, so matching and range planning are
 * tested without Premiere; stringout_from_transcript places the ranges.
 */
import { parseSrt } from './srt.js';

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

const norm = (w: string): string =>
  w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9']/g, '')
    .replace(/^'+|'+$/g, '');

export function tokenize(text: string): string[] {
  return text.split(/\s+/).map(norm).filter(Boolean);
}

/** Words with times from an .srt (spread within each cue by character position). */
export function wordsFromSrt(text: string): TimedWord[] {
  const out: TimedWord[] = [];
  for (const cue of parseSrt(text).cues) {
    const raw = cue.text.split(/\s+/).filter((w) => norm(w));
    const chars = raw.reduce((n, w) => n + w.length + 1, 0) || 1;
    let pos = 0;
    for (const w of raw) {
      const a = cue.start + ((cue.end - cue.start) * pos) / chars;
      pos += w.length + 1;
      const b = cue.start + ((cue.end - cue.start) * pos) / chars;
      out.push({ word: norm(w), start: a, end: b });
    }
  }
  return out;
}

/** Words with times from Whisper JSON: segments[].words[] when present, else segment times spread. */
export function wordsFromWhisperJson(json: any): TimedWord[] {
  const out: TimedWord[] = [];
  for (const seg of json?.segments ?? []) {
    if (Array.isArray(seg.words) && seg.words.length) {
      for (const w of seg.words)
        if (norm(String(w.word ?? '')))
          out.push({ word: norm(String(w.word)), start: Number(w.start), end: Number(w.end) });
    } else {
      const raw = String(seg.text ?? '')
        .split(/\s+/)
        .filter((w) => norm(w));
      const step = (Number(seg.end) - Number(seg.start)) / (raw.length || 1);
      raw.forEach((w, i) =>
        out.push({
          word: norm(w),
          start: Number(seg.start) + i * step,
          end: Number(seg.start) + (i + 1) * step,
        }),
      );
    }
  }
  return out;
}

export interface QuoteMatch {
  quote: string;
  start: number;
  end: number;
  score: number;
  matchedText: string;
}

/**
 * Best place a quote occurs: the window of the quote's length with the most words matching in
 * order position. Exact matches score 1. Below minScore the quote is reported as not found
 * rather than guessed.
 */
export function findQuote(words: TimedWord[], quote: string, minScore = 0.75): QuoteMatch | null {
  const q = tokenize(quote);
  if (!q.length || words.length < q.length) return null;
  let best = -1,
    bestAt = -1;
  for (let i = 0; i + q.length <= words.length; i++) {
    let hit = 0;
    for (let k = 0; k < q.length; k++) if (words[i + k]!.word === q[k]) hit++;
    if (hit > best) {
      best = hit;
      bestAt = i;
      if (hit === q.length) break;
    }
  }
  const score = best / q.length;
  if (score < minScore) return null;
  const span = words.slice(bestAt, bestAt + q.length);
  return {
    quote,
    start: span[0]!.start,
    end: span[span.length - 1]!.end,
    score: Math.round(score * 1000) / 1000,
    matchedText: span.map((w) => w.word).join(' '),
  };
}

export interface PlannedRange {
  label: string;
  sourceIn: number;
  sourceOut: number;
  recordIn: number;
}

/** Source ranges with handles, snapped to frames, clamped to the media, laid end to end. */
export function planStringout(
  ranges: Array<{ label: string; start: number; end: number }>,
  handle: number,
  fps: number,
  mediaDuration: number,
  gap = 0,
): PlannedRange[] {
  const frame = 1 / (fps > 0 ? fps : 24);
  const snap = (t: number) => Math.round(t / frame) * frame;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  let at = 0;
  const out: PlannedRange[] = [];
  for (const r of ranges) {
    const a = snap(Math.max(0, r.start - handle));
    const b = snap(Math.min(mediaDuration > 0 ? mediaDuration : Infinity, r.end + handle));
    if (b - a < frame) continue;
    out.push({ label: r.label, sourceIn: r3(a), sourceOut: r3(b), recordIn: r3(at) });
    at = snap(at + (b - a) + gap);
  }
  return out;
}
