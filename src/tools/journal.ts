/**
 * Call journal: "did my last call run?", and safe retries.
 *
 * A client that times out never sees the response, but Premiere may well have done the edit. The
 * field's most-reported failure is exactly that: a retried roll edit applied twice after an
 * export outlived the client's 60 s timeout. So every top-level tool call is journaled here — when
 * it started, whether it finished, and a summary of what came back — and `get_recent_calls`
 * answers the question directly, including for calls whose response was lost.
 *
 * `requestId` makes a retry safe: a call carrying a requestId the journal has already seen
 * finish returns that first result (marked `replayed`) instead of running again; one still in
 * flight returns its status instead of starting a second copy.
 *
 * Persisted as JSON lines next to the bridge files, so it survives a server restart (which is
 * what a client usually does after a timeout). Bounded to the most recent entries.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { bridgeDir } from '../utils/scratch-paths.js';

export interface JournalEntry {
  id: string;
  requestId?: string;
  tool: string;
  argsPreview: string;
  argsDigest: string;
  readOnly: boolean;
  startedAt: string;
  /** Strictly increasing within a process, so calls started in the same millisecond keep their order. */
  order?: number;
  finishedAt?: string;
  status: 'running' | 'ok' | 'failed';
  summary?: string;
  /** Full result, kept only for calls with a requestId so a replay can return it. */
  result?: unknown;
}

const MAX_ENTRIES = 500;
const MAX_RESULT_CHARS = 20000;

const file = (): string =>
  process.env.PREMIERE_MCP_JOURNAL_PATH || join(bridgeDir(), 'mcp-call-journal.jsonl');

function readAll(): JournalEntry[] {
  try {
    if (!existsSync(file())) return [];
    const byId = new Map<string, JournalEntry>();
    for (const line of readFileSync(file(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as JournalEntry;
        byId.set(e.id, { ...(byId.get(e.id) ?? {}), ...e });
      } catch {
        /* torn line */
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

function append(e: Partial<JournalEntry> & { id: string }): void {
  try {
    mkdirSync(join(file(), '..'), { recursive: true });
    appendFileSync(file(), JSON.stringify(e) + '\n', { mode: 0o600 });
    compactIfLarge();
  } catch {
    /* the journal must never break a tool call */
  }
}

let appendsSinceCompact = 0;
function compactIfLarge(): void {
  if (++appendsSinceCompact < 200) return;
  appendsSinceCompact = 0;
  const kept = readAll()
    .sort((a, b) => byNewest(b, a))
    .slice(-MAX_ENTRIES);
  writeFileSync(file(), kept.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
}

let lastOrder = 0;
const nextOrder = (): number => (lastOrder = Math.max(Date.now() * 1000, lastOrder + 1));
const byNewest = (a: JournalEntry, b: JournalEntry): number =>
  (b.order ?? Date.parse(b.startedAt) * 1000) - (a.order ?? Date.parse(a.startedAt) * 1000);

const digest = (args: unknown): string =>
  createHash('sha1')
    .update(JSON.stringify(args ?? {}))
    .digest('hex')
    .slice(0, 12);

export function begin(
  tool: string,
  args: Record<string, unknown>,
  readOnly: boolean,
): JournalEntry {
  const e: JournalEntry = {
    id: randomUUID(),
    tool,
    argsPreview: JSON.stringify(args ?? {}).slice(0, 300),
    argsDigest: digest(args),
    readOnly,
    startedAt: new Date().toISOString(),
    order: nextOrder(),
    status: 'running',
    ...(typeof args?.requestId === 'string' && args.requestId
      ? { requestId: String(args.requestId) }
      : {}),
  };
  append(e);
  return e;
}

export function finish(e: JournalEntry, result: unknown): void {
  const ok = !(
    result &&
    typeof result === 'object' &&
    (result as { success?: unknown }).success === false
  );
  const text = JSON.stringify(result ?? null);
  append({
    id: e.id,
    finishedAt: new Date().toISOString(),
    status: ok ? 'ok' : 'failed',
    summary: text.slice(0, 600),
    ...(e.requestId && text.length <= MAX_RESULT_CHARS ? { result } : {}),
  });
}

export function failThrown(e: JournalEntry, message: string): void {
  append({
    id: e.id,
    finishedAt: new Date().toISOString(),
    status: 'failed',
    summary: message.slice(0, 600),
  });
}

/** The most recent entry carrying this requestId, if any. */
export function byRequestId(requestId: string): JournalEntry | undefined {
  return readAll()
    .filter((x) => x.requestId === requestId)
    .sort(byNewest)[0];
}

export function recent(
  opts: { limit?: number; mutatingOnly?: boolean; sinceSeconds?: number } = {},
): JournalEntry[] {
  const since = opts.sinceSeconds ? Date.now() - opts.sinceSeconds * 1000 : 0;
  return (
    readAll()
      // Not itself: the get_recent_calls call asking the question is always the newest entry.
      .filter(
        (x) =>
          x.tool !== 'get_recent_calls' &&
          (!opts.mutatingOnly || !x.readOnly) &&
          (!since || Date.parse(x.startedAt) >= since),
      )
      .sort(byNewest)
      .slice(0, Math.max(1, Math.min(opts.limit ?? 10, 100)))
      .map(({ result: _r, ...rest }) => rest)
  );
}
