/**
 * A size cap on every tool result.
 *
 * One call that returns a show project's 4,000 clips, or every keyframe on a long clip, can fill
 * most of an assistant's context in one go and push out the conversation it needed. Results over
 * the cap are cut down by halving their longest lists (and clipping very long strings) until they
 * fit, and say exactly what was cut and how to ask for the rest, so nothing is dropped silently.
 */
export const DEFAULT_MAX_RESULT_CHARS = 40_000;
export const HARD_MAX_RESULT_CHARS = 400_000;

export interface Cut { path: string; total: number; kept: number }

export function maxResultChars(perCall: unknown, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.PREMIERE_MCP_MAX_RESULT_CHARS);
  const base = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_RESULT_CHARS;
  const asked = Number(perCall);
  return Math.min(Number.isFinite(asked) && asked > 0 ? asked : base, HARD_MAX_RESULT_CHARS);
}

export function capResult<T>(result: T, max: number): { value: T; cuts?: Cut[]; originalChars?: number } {
  const text = JSON.stringify(result);
  if (text === undefined || text.length <= max) return { value: result };
  const value = JSON.parse(text);
  const lists: Array<{ path: string; arr: unknown[]; total: number }> = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { lists.push({ path, arr: v, total: v.length }); v.forEach((x, i) => { if (i < 50) walk(x, `${path}[${i}]`, depth + 1); }); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(value, '', 0);
  const size = () => JSON.stringify(value).length;
  for (let guard = 0; guard < 200 && size() > max; guard++) {
    const longest = lists.filter((l) => l.arr.length > 1).sort((a, b) => JSON.stringify(b.arr).length - JSON.stringify(a.arr).length)[0];
    if (!longest) break;
    longest.arr.length = Math.max(1, Math.floor(longest.arr.length / 2));
  }
  if (size() > max) clipStrings(value, 2000);
  const cuts = lists.filter((l) => l.arr.length < l.total).map((l) => ({ path: l.path || '(root)', total: l.total, kept: l.arr.length }));
  return { value, cuts, originalChars: text.length };
}

function clipStrings(v: any, at: number): void {
  if (!v || typeof v !== 'object') return;
  for (const k of Object.keys(v)) {
    if (typeof v[k] === 'string' && v[k].length > at) v[k] = `${v[k].slice(0, at)}… [${v[k].length - at} more characters cut]`;
    else clipStrings(v[k], at);
  }
}
