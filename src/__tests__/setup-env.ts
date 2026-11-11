/**
 * Jest global setup.
 *
 * The shipped DEFAULT tool profile is `core` (97 tools), because exposing all 638 costs about
 * half a 200k context window and exceeds VS Code's 128-tool ceiling. That is a deployment
 * decision and says nothing about whether a tool is correct, so the suites must see the whole
 * catalogue — otherwise every test of a non-core tool fails with "unknown tool" and reads as a
 * broken implementation rather than a hidden one. Seventy tests failed exactly that way when the
 * default changed.
 *
 * Tests that care about profile behaviour pass an explicit env object to resolveProfile /
 * applyProfile, so they are unaffected by this.
 */
process.env.PREMIERE_MCP_PROFILE = 'all';

// The locked-screen refusal (report-dialog-guard.ts) reads the real machine's lock state, so a
// suite run on a locked Mac would refuse the AAF/OMF tools. Off here; its own test turns it on.
process.env.PREMIERE_MCP_LOCK_CHECK = '0';

/*
 * Never touch the live bridge. Tests that build a real PremiereProBridge without
 * PREMIERE_TEMP_DIR fell back to the folder the bridge in Premiere watches (from the user's
 * ~/.premiere-mcp-bridge/config.json, else /tmp/premiere-mcp-bridge). On 2026-11-10 a full local
 * run with Premiere open overwrote the live bridge-endpoint.json, deleted the live
 * auth-token.json and left motion-demo folders there, under a working user's session.
 *
 * So: every test file starts with its own empty bridge and UXP folders, and any write, rename or
 * delete under a live one (macOS and Windows defaults, plus the configured one) throws, naming
 * the path, instead of happening. Reads are allowed. The live folder a harness wrote its own
 * results to is still readable via PMCP_LIVE_BRIDGE_DIR.
 *
 * Not covered: a child process spawned without an env option gets the real environment, not this
 * one, so it neither sees these folders nor the guard. Pass env: { ...process.env } to children.
 */
// The module object itself, not an import-star copy, so every importer sees the guarded functions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs: typeof import('node:fs') = require('node:fs');
import { tmpdir } from 'node:os';
import { join as joinPath, resolve as resolvePath, sep } from 'node:path';

const LIVE_BRIDGE_DIRS = (() => {
  const temp = process.env.TEMP || process.env.TMP || tmpdir();
  const dirs = [
    '/tmp/premiere-mcp-bridge',
    '/tmp/premiere-mcp-uxp',
    joinPath(temp, 'premiere-mcp-bridge'),
    joinPath(tmpdir(), 'premiere-mcp-uxp'),
  ];
  if (process.env.PREMIERE_TEMP_DIR) dirs.push(process.env.PREMIERE_TEMP_DIR);
  if (process.env.PREMIERE_MCP_UXP_DIR) dirs.push(process.env.PREMIERE_MCP_UXP_DIR);
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const cfg = JSON.parse(
      nodeFs.readFileSync(joinPath(home, '.premiere-mcp-bridge', 'config.json'), 'utf8'),
    );
    if (typeof cfg.tempDirectory === 'string' && cfg.tempDirectory.trim())
      dirs.push(cfg.tempDirectory.trim());
  } catch {
    /* no saved choice */
  }
  const out = new Set<string>();
  const win = process.platform === 'win32';
  for (const d of dirs) {
    const r = resolvePath(d);
    out.add(win ? r.toLowerCase() : r);
    if (!win && r.startsWith('/tmp/')) out.add('/private' + r);
  }
  return [...out];
})();

// Where a live harness writes its results (live-tool-sweep.json), for tests that read them.
process.env.PMCP_LIVE_BRIDGE_DIR =
  process.env.PMCP_LIVE_BRIDGE_DIR ||
  process.env.PREMIERE_TEMP_DIR ||
  (process.platform === 'win32'
    ? joinPath(process.env.TEMP || process.env.TMP || tmpdir(), 'premiere-mcp-bridge')
    : '/tmp/premiere-mcp-bridge');

// Private folders for this test file.
const g = globalThis as any;
g.__pmcpJestDirs = g.__pmcpJestDirs || [];
const own = (prefix: string) => {
  const d = nodeFs.mkdtempSync(joinPath(tmpdir(), prefix));
  g.__pmcpJestDirs.push(d);
  return d;
};
process.env.PREMIERE_TEMP_DIR = own('pmcp-jest-bridge-');
process.env.PREMIERE_MCP_UXP_DIR = own('pmcp-jest-uxp-');
// Removed after the file's tests by setup-after-env.ts (a process 'exit' hook never fires in
// Jest's sandbox).

function isLive(p: unknown): boolean {
  if (p === undefined || p === null || typeof p === 'number') return false;
  let s = resolvePath(p instanceof URL ? p.pathname : String(p));
  if (process.platform === 'win32') s = s.toLowerCase();
  return LIVE_BRIDGE_DIRS.some((d) => s === d || s.startsWith(d + sep));
}
function refuse(op: string, p: unknown): never {
  throw new Error(
    `A test tried to ${op} ${String(p)}, inside the live Premiere bridge folder. Give the test its own PREMIERE_TEMP_DIR (setup-env sets one per file; do not delete it, restore it).`,
  );
}
type AnyFn = (...a: any[]) => any;
const GUARDED = Symbol.for('pmcp.liveBridgeGuard');
// Wrap once per process: jest hands every test file the same core module, so wrapping again per
// file stacked one wrapper per file on every call. The guard reads LIVE_BRIDGE_DIRS of the first
// file, which is the same for every file of a run.
function wrap(target: any, name: string, check: (args: any[]) => unknown, promise: boolean) {
  const orig = target?.[name];
  if (typeof orig !== 'function' || orig[GUARDED]) return;
  const wrapped = function (this: unknown, ...args: any[]) {
    const bad = check(args);
    if (bad !== undefined) {
      if (promise) {
        try {
          refuse(name, bad);
        } catch (e) {
          return Promise.reject(e);
        }
      }
      refuse(name, bad);
    }
    return (orig as AnyFn).apply(this, args);
  };
  (wrapped as any)[GUARDED] = true;
  target[name] = wrapped;
}
const pathAt = (idx: number[]) => (args: any[]) => {
  for (const i of idx) if (isLive(args[i])) return args[i];
  return undefined;
};
const ONE = [
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'rmdir',
  'unlink',
  'truncate',
  'utimes',
  'chmod',
  'mkdtemp',
];
const TWO = ['rename', 'copyFile', 'symlink', 'link', 'cp'];
for (const n of ONE) {
  wrap(nodeFs, n + 'Sync', pathAt([0]), false);
  wrap(nodeFs, n, pathAt([0]), false);
  wrap(nodeFs.promises, n, pathAt([0]), true);
}
for (const n of TWO) {
  wrap(nodeFs, n + 'Sync', pathAt([0, 1]), false);
  wrap(nodeFs, n, pathAt([0, 1]), false);
  wrap(nodeFs.promises, n, pathAt([0, 1]), true);
}
// open() only when it would write: reading a live file (the bridge's own config) is harmless.
const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } = nodeFs.constants;
function writes(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number')
    return (flags & (O_WRONLY | O_RDWR | O_APPEND | O_CREAT | O_TRUNC)) !== 0;
  return /[wa+]/.test(String(flags));
}
const openCheck = (args: any[]) => (isLive(args[0]) && writes(args[1]) ? args[0] : undefined);
wrap(nodeFs, 'openSync', openCheck, false);
wrap(nodeFs, 'open', openCheck, false);
wrap(nodeFs.promises, 'open', openCheck, true);
wrap(nodeFs, 'createWriteStream', pathAt([0]), false);
