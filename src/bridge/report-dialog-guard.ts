/**
 * Dismiss Premiere's informational export-report dialogs while a tool call is in flight (macOS).
 *
 * exportAAF() raises "AAF Export Log" whenever the sequence carries something AAF cannot hold (any
 * Lumetri grade, for one), and exportAsFinalCutProXML() raises "Translation Report" for the FCP
 * equivalents. Both are modal and OK-only, and both block the ExtendScript engine until someone
 * clicks OK, so every caller after that times out. Measured 2026-10-25: the file is already
 * written when the dialog appears; the dialog only reports what did not translate (the Translation
 * Report is also saved next to the XML). Tools that export FCP XML internally (add_transition's
 * verification, export_edl, diff_sequences) hit the same dialog.
 *
 * The guard does not send keystrokes to whatever app is frontmost. It asks System Events for the
 * Premiere process's UI elements, and clicks the button described "OK" only inside a dialog whose
 * name is on REPORT_DIALOGS. It starts polling only once a call has run longer than START_AFTER_MS,
 * so fast calls never spawn anything. Disable with PREMIERE_MCP_DIALOG_GUARD=0. It needs the host
 * process to have Accessibility permission; without it the guard reports itself unavailable.
 */

import { spawn } from 'node:child_process';

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
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
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

/** Run `fn`, dismissing listed report dialogs that appear while it is still running. */
export async function withReportDialogGuard<T>(fn: () => Promise<T>): Promise<{ result: T; guard: GuardOutcome }> {
  const guard: GuardOutcome = { dismissed: [] };
  if (!dialogGuardEnabled()) return { result: await fn(), guard };
  let done = false;
  let polling = false;
  const tick = async () => {
    if (done || polling || guard.unavailable) return;
    polling = true;
    const r = await pollOnce();
    polling = false;
    if (r.dismissed) guard.dismissed.push(r.dismissed);
    else if (r.error && /not allowed|assistive|-1719|-25211|1002/i.test(r.error)) guard.unavailable = r.error.slice(0, 200);
  };
  let interval: NodeJS.Timeout | undefined;
  const starter = setTimeout(() => { void tick(); interval = setInterval(() => { void tick(); }, POLL_MS); }, START_AFTER_MS);
  try {
    return { result: await fn(), guard };
  } finally {
    done = true;
    clearTimeout(starter);
    if (interval) clearInterval(interval);
  }
}
