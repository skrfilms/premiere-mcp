/**
 * Client for the MCP UXP Probe panel (uxp-probe/), a second channel next to the CEP bridge.
 *
 * UXP reaches a few things ExtendScript cannot on 26.x (the work area, transition factories);
 * CEP reaches everything else, including QE, which UXP has no equivalent of. Tools ask this
 * channel first for those few calls and fall back to CEP when the panel is not running, so a
 * missing UXP panel costs a feature, never a crash.
 *
 * Transport: files in the queue directory, mode 0700. A command is written under a dot-name and renamed
 * into place so the panel never reads half a file; the panel answers with response-<id>.json.
 * The directory is fixed because a UXP panel cannot read the environment. There is no socket:
 * nothing here is reachable from another machine.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Fixed in the panel (uxp-probe/main.js). The override exists for tests only. */
export const UXP_DIR_DEFAULT = '/tmp/premiere-mcp-uxp';
const dir = (): string => process.env.PREMIERE_MCP_UXP_DIR || UXP_DIR_DEFAULT;
/** The panel writes a heartbeat every poll (300 ms); older than this means it is not running. */
const STALE_MS = 5000;

export interface UxpResult {
  ok: boolean;
  result?: any;
  error?: string;
}

/** True when the UXP probe panel is running in Premiere and answering. */
export function uxpAvailable(): boolean {
  if (process.platform === 'win32') return false; // the panel's queue path is POSIX-only for now
  try {
    const hb = JSON.parse(readFileSync(`${dir()}/uxp-heartbeat.json`, 'utf8'));
    return Date.now() - Number(hb.ts) < STALE_MS;
  } catch {
    return false;
  }
}

function ensureDir(): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  // A pre-existing directory keeps its mode; tighten it so another local user cannot queue code.
  chmodSync(dir(), 0o700);
}

/** The panel claims a command by renaming it to *.taken but cannot delete it (UXP's fs has no
 *  unlink on 26.5.2), so the claimed files are swept from this side. */
function sweepTaken(): void {
  try {
    for (const n of readdirSync(dir())) {
      if (n.startsWith('command-') && n.endsWith('.taken')) {
        try { unlinkSync(`${dir()}/${n}`); } catch { /* raced */ }
      }
    }
  } catch { /* no directory yet */ }
}

/**
 * Run `code` in the UXP panel as the body of an async function called with (ppro, uxp).
 * Objects from `premierepro` go stale across an await, so code that edits should do its reads
 * and its executeTransaction inside one project.lockedAccess callback.
 */
export async function runUxp(code: string, timeoutMs = 20000): Promise<UxpResult> {
  if (!uxpAvailable()) return { ok: false, error: 'The MCP UXP Probe panel is not running (npm run uxp:install, then restart Premiere).' };
  ensureDir();
  sweepTaken();
  const d = dir();
  const id = randomUUID();
  const staging = `${d}/.c-${id}`;
  writeFileSync(staging, JSON.stringify({ id, code }), { mode: 0o600 });
  renameSync(staging, `${d}/command-${id}.json`);
  const responsePath = `${d}/response-${id}.json`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      // The panel may have no rename and write in place; tolerate a read that lands mid-write.
      try {
        const parsed = JSON.parse(readFileSync(responsePath, 'utf8'));
        try { unlinkSync(responsePath); } catch { /* already gone */ }
        return parsed.ok ? { ok: true, result: parsed.result } : { ok: false, error: String(parsed.error ?? 'unknown UXP error') };
      } catch { /* partial; retry */ }
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  try { unlinkSync(`${d}/command-${id}.json`); } catch { /* the panel took it */ }
  return { ok: false, error: `The UXP panel did not answer within ${timeoutMs / 1000}s.` };
}
