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
 * So: every test file starts with its own empty bridge folder, and any write, rename or delete
 * under a live bridge folder throws, naming the path, instead of happening. Reads are allowed.
 */
// The module object itself, not an import-star copy, so every importer sees the guarded functions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs: typeof import('node:fs') = require('node:fs');
import { tmpdir } from 'node:os';
import { join as joinPath, resolve as resolvePath } from 'node:path';

if (!process.env.PREMIERE_TEMP_DIR) {
  process.env.PREMIERE_TEMP_DIR = nodeFs.mkdtempSync(joinPath(tmpdir(), 'pmcp-jest-bridge-'));
}

const LIVE_BRIDGE_DIRS = (() => {
  const dirs = ['/tmp/premiere-mcp-bridge', '/tmp/premiere-mcp-uxp'];
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
  for (const d of dirs) {
    out.add(resolvePath(d));
    if (d.startsWith('/tmp/')) out.add('/private' + resolvePath(d));
  }
  return [...out];
})();

function isLive(p: unknown): boolean {
  if (p === undefined || p === null || typeof p === 'number') return false;
  const s = resolvePath(p instanceof URL ? p.pathname : String(p));
  return LIVE_BRIDGE_DIRS.some((d) => s === d || s.startsWith(d + '/'));
}
function refuse(op: string, p: unknown): never {
  throw new Error(
    `A test tried to ${op} ${String(p)}, inside the live Premiere bridge folder. Give the test its own PREMIERE_TEMP_DIR (setup-env sets one per file; do not delete it, restore it).`,
  );
}
type AnyFn = (...a: any[]) => any;
function guard(target: any, name: string, pathArgs: number[], promise = false) {
  const orig = target?.[name];
  if (typeof orig !== 'function') return;
  target[name] = function (this: unknown, ...args: any[]) {
    for (const i of pathArgs)
      if (isLive(args[i])) {
        if (promise) {
          try {
            refuse(name, args[i]);
          } catch (e) {
            return Promise.reject(e);
          }
        }
        refuse(name, args[i]);
      }
    return (orig as AnyFn).apply(this, args);
  };
}
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
  guard(nodeFs, n + 'Sync', [0]);
  guard(nodeFs, n, [0]);
  guard(nodeFs.promises, n, [0], true);
}
for (const n of TWO) {
  guard(nodeFs, n + 'Sync', [0, 1]);
  guard(nodeFs, n, [0, 1]);
  guard(nodeFs.promises, n, [0, 1], true);
}
// open() only when it would write: reading a live file (the bridge's own config) is harmless.
function writes(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & 3) !== 0 || (flags & 0o100) !== 0;
  return /[wa+]/.test(String(flags));
}
function guardOpen(target: any, name: string, promise = false) {
  const orig = target?.[name];
  if (typeof orig !== 'function') return;
  target[name] = function (this: unknown, ...args: any[]) {
    if (isLive(args[0]) && writes(args[1])) {
      if (promise) {
        try {
          refuse(name, args[0]);
        } catch (e) {
          return Promise.reject(e);
        }
      }
      refuse(name, args[0]);
    }
    return (orig as AnyFn).apply(this, args);
  };
}
guardOpen(nodeFs, 'openSync');
guardOpen(nodeFs, 'open');
guardOpen(nodeFs.promises, 'open', true);
guard(nodeFs, 'createWriteStream', [0]);
