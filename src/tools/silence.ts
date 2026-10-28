/**
 * Silence removal planning: source-time silences -> timeline ranges to cut.
 *
 * Pure, so the arithmetic (in point, speed, padding, frame snapping, ranges too short to bother
 * with) is tested without Premiere. remove_silence applies the plan by razoring every track at
 * each range, lifting what lies inside, and closing the gap on all tracks at once, last range
 * first, so audio and every other track stay in sync.
 */
export interface ClipSpan { start: number; end: number; inPoint: number; speed: number }
export interface SourceSilence { start: number; end: number }
export interface CutRange { start: number; end: number; duration: number }

/**
 * @param padding seconds of the pause kept on each side, so cuts do not clip breaths or word tails
 * @param minCut ranges shorter than this after padding are left alone
 * @param fps timeline frame rate; ranges are snapped to whole frames
 */
export function planSilenceCuts(silences: SourceSilence[], clip: ClipSpan, padding: number, minCut: number, fps: number): CutRange[] {
  const speed = clip.speed > 0 ? clip.speed : 1;
  const frame = 1 / (fps > 0 ? fps : 24);
  const snap = (t: number) => Math.round(t / frame) * frame;
  const out: CutRange[] = [];
  for (const s of silences) {
    // Source time -> timeline time through the clip's in point and speed.
    let a = clip.start + (s.start - clip.inPoint) / speed + padding;
    let b = clip.start + (s.end - clip.inPoint) / speed - padding;
    a = Math.max(a, clip.start);
    b = Math.min(b, clip.end);
    a = snap(a);
    b = snap(b);
    if (b - a >= Math.max(minCut, frame)) out.push({ start: round(a), end: round(b), duration: round(b - a) });
  }
  return out.sort((x, y) => x.start - y.start);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Seconds -> "HH:MM:SS:FF" at the nominal rate, the form QE razor reads (non-drop count). */
export function toTimecode(seconds: number, fps: number): string {
  const nominal = Math.round(fps > 0 ? fps : 24);
  const total = Math.round(seconds * nominal);
  const f = total % nominal, s = Math.floor(total / nominal) % 60, m = Math.floor(total / nominal / 60) % 60, h = Math.floor(total / nominal / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}
