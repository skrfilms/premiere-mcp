/**
 * Dismiss Premiere's informational export-report dialogs while a tool call is in flight (macOS).
 *
 * exportAAF() raises "AAF Export Log" whenever the sequence carries something AAF cannot hold (any
 * Lumetri grade, for one), and exportAsFinalCutProXML() raises "Translation Report" for the FCP
 * equivalents. Both are modal and OK-only, and both block the ExtendScript engine until someone
 * clicks OK, so every caller after that times out. Measured 2026-10-25: the file is already
 * written when the dialog appears; the dialog only reports what did not translate (the Translation
 * Report is also saved next to the XML). Every FCP XML export in this repo now passes
 * suppressUI=true, which keeps the Translation Report from appearing (so add_transition's
 * verification, export_edl and diff_sequences no longer raise it); exportAAF/exportOMF have no
 * such switch, and export_project_as_fcp_xml lets the caller turn suppressUI off.
 *
 * The guard does not send keystrokes to whatever app is frontmost. It asks System Events for the
 * Premiere process's UI elements, and clicks the button described "OK" only inside a dialog whose
 * name is on REPORT_DIALOGS. It starts polling only once a call has run longer than START_AFTER_MS,
 * so fast calls never spawn anything. Disable with PREMIERE_MCP_DIALOG_GUARD=0. It needs the host
 * process to have Accessibility permission; without it the guard reports itself unavailable.
 */

import { execFileSync, spawn } from 'node:child_process';

export const REPORT_DIALOGS = ['AAF Export Log', 'Translation Report'];
const START_AFTER_MS = 2500;
const POLL_MS = 1500;

const SCRIPT = `on run argv
  tell application "System Events"
    repeat with p in (every process whose name starts with "Adobe Premiere Pro")
      repeat with w in (every UI element of p)
        set wn to (name of w as text)
        if argv contains wn then
          repeat with b in (every button of w)
            if (description of b as text) is "OK" then
              click b
              return wn
            end if
          end repeat
        end if
      end repeat
    end repeat
  end tell
  return ""
end run`;

export interface GuardOutcome {
  dismissed: string[];
  unavailable?: string;
}

function pollOnce(): Promise<{ dismissed?: string; error?: string }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let proc;
    try {
      proc = spawn('osascript', ['-', ...REPORT_DIALOGS]);
    } catch (e: any) {
      resolve({ error: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, 8000);
    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message });
    });
    proc.on('close', () => {
      clearTimeout(timer);
      const name = out.trim();
      resolve(name ? { dismissed: name } : err.trim() ? { error: err.trim() } : {});
    });
    proc.stdin.end(SCRIPT);
  });
}

export function dialogGuardEnabled(): boolean {
  return process.platform === 'darwin' && process.env.PREMIERE_MCP_DIALOG_GUARD !== '0';
}

/*
 * One poller for every call in flight. A per-call guard (or a per-instance depth counter) could not
 * tell a nested call from a concurrent one: a second overlapping request ran unguarded, and the
 * first to finish stopped the polling while the other was still blocked on a modal. Dismissals are
 * credited to every call that was in flight when they happened.
 */
const inFlight = new Set<GuardOutcome>();
let starter: NodeJS.Timeout | undefined;
let interval: NodeJS.Timeout | undefined;
let polling = false;
let unavailable: string | undefined;

async function tick(): Promise<void> {
  if (polling || unavailable || inFlight.size === 0) return;
  polling = true;
  const r = await pollOnce();
  polling = false;
  if (r.dismissed) for (const g of inFlight) g.dismissed.push(r.dismissed);
  else if (r.error && /not allowed|assistive|-1719|-25211|1002/i.test(r.error)) {
    unavailable = r.error.slice(0, 200);
    for (const g of inFlight) g.unavailable = unavailable;
  }
}

function startPolling(): void {
  if (starter || interval) return;
  starter = setTimeout(() => {
    starter = undefined;
    void tick();
    interval = setInterval(() => {
      void tick();
    }, POLL_MS);
  }, START_AFTER_MS);
}

function stopPollingIfIdle(): void {
  if (inFlight.size > 0) return;
  if (starter) {
    clearTimeout(starter);
    starter = undefined;
  }
  if (interval) {
    clearInterval(interval);
    interval = undefined;
  }
}

/**
 * Run `fn`, dismissing listed report dialogs that appear while it (or any other call) runs.
 *
 * `lingerMs` keeps watching after `fn` returns. An FCP XML import returns in well under the
 * 2.5 s start delay and Premiere raises its Translation Report a moment AFTER, so a guard that
 * stopped with the call never saw it, and the reports piled up on screen one per import.
 */
export async function withReportDialogGuard<T>(
  fn: () => Promise<T>,
  opts: { lingerMs?: number } = {},
): Promise<{ result: T; guard: GuardOutcome }> {
  const guard: GuardOutcome = { dismissed: [] };
  if (!dialogGuardEnabled()) return { result: await fn(), guard };
  if (unavailable) guard.unavailable = unavailable;
  inFlight.add(guard);
  startPolling();
  try {
    return { result: await fn(), guard };
  } finally {
    inFlight.delete(guard);
    if (opts.lingerMs && opts.lingerMs > 0) {
      const tail: GuardOutcome = { dismissed: [] };
      inFlight.add(tail);
      // Poll now rather than after the start delay: the report is due any moment.
      if (!interval) {
        if (starter) {
          clearTimeout(starter);
          starter = undefined;
        }
        void tick();
        interval = setInterval(() => {
          void tick();
        }, POLL_MS);
      }
      setTimeout(() => {
        inFlight.delete(tail);
        stopPollingIfIdle();
      }, opts.lingerMs).unref?.();
    } else {
      stopPollingIfIdle();
    }
  }
}

/**
 * macOS: whether the console session's screen is locked. While it is, System Events cannot reach
 * Premiere's windows, so a report dialog cannot be dismissed, and an AAF export on a graded
 * sequence froze Premiere for good (measured 2026-11-01: ENGINE_DEAD after 376 s, the screen
 * locked). Read from ioreg's CGSSessionScreenIsLocked, cached for 5 s; false when unreadable.
 * PREMIERE_MCP_LOCK_CHECK=0 turns the check off.
 */
let lockCache: { at: number; locked: boolean } | undefined;
export function screenLocked(
  now: number = Date.now(),
  probe: () => string = () =>
    execFileSync('ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 3000 }),
): boolean {
  if (process.platform !== 'darwin' || process.env.PREMIERE_MCP_LOCK_CHECK === '0') return false;
  if (lockCache && now - lockCache.at < 5000) return lockCache.locked;
  let locked = false;
  try {
    locked = /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(probe());
  } catch {
    locked = false;
  }
  lockCache = { at: now, locked };
  return locked;
}
/** Test hook: forget the cached lock state. */
export function resetScreenLockCache(): void {
  lockCache = undefined;
}

/** Tools whose Premiere call can raise a report dialog shortly after it returns. */
export const REPORT_DIALOG_TOOLS =
  /fcp_?xml|_xml|aaf|omf|multicam_cut|create_multicam|open_fcp|import_sequences/;
export const REPORT_LINGER_MS = 8000;
