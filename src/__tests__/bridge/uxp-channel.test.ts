/**
 * The UXP channel must report itself unavailable unless the panel is demonstrably running, answer
 * a command through the file queue, and keep the queue private to this user.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUxp, uxpAvailable } from '../../bridge/uxp-channel.js';

const posix = process.platform !== 'win32';
// The mode-bit assertion is POSIX-only; everything else runs on Windows too.
const posixIt = it;

describe('uxp channel', () => {
  let dir: string;
  const saved = process.env.PREMIERE_MCP_UXP_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uxp-test-'));
    process.env.PREMIERE_MCP_UXP_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PREMIERE_MCP_UXP_DIR;
    else process.env.PREMIERE_MCP_UXP_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const beat = (ageMs: number) =>
    writeFileSync(join(dir, 'uxp-heartbeat.json'), JSON.stringify({ ts: Date.now() - ageMs }));

  it('is available with a fresh heartbeat, on every platform', () => {
    beat(0);
    expect(uxpAvailable()).toBe(true);
  });

  it('is unavailable with no heartbeat', () => {
    expect(uxpAvailable()).toBe(false);
  });

  posixIt('is unavailable when the heartbeat is stale', () => {
    beat(60_000);
    expect(uxpAvailable()).toBe(false);
  });

  posixIt('refuses to queue anything when the panel is not running', async () => {
    const r = await runUxp('return 1;', 500);
    expect(r.ok).toBe(false);
    expect(readdirSync(dir).filter((n) => n.startsWith('command-'))).toEqual([]);
  });

  posixIt('round-trips a command through the queue and keeps the directory private', async () => {
    beat(0);
    // A stand-in panel: take the command, answer it.
    const panel = setInterval(() => {
      const cmd = readdirSync(dir).find((n) => n.startsWith('command-'));
      if (!cmd) return;
      const req = JSON.parse(readFileSync(join(dir, cmd), 'utf8'));
      rmSync(join(dir, cmd));
      writeFileSync(
        join(dir, `.r-${req.id}`),
        JSON.stringify({ id: req.id, ok: true, result: { echoed: req.code } }),
      );
      renameSync(join(dir, `.r-${req.id}`), join(dir, `response-${req.id}.json`));
    }, 20);
    try {
      const r = await runUxp('return 42;', 3000);
      expect(r).toEqual({ ok: true, result: { echoed: 'return 42;' } });
      if (posix) expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir).filter((n) => n.startsWith('response-'))).toEqual([]);
    } finally {
      clearInterval(panel);
    }
  });

  posixIt('surfaces a panel-side error', async () => {
    beat(0);
    const panel = setInterval(() => {
      const cmd = readdirSync(dir).find((n) => n.startsWith('command-'));
      if (!cmd) return;
      const req = JSON.parse(readFileSync(join(dir, cmd), 'utf8'));
      rmSync(join(dir, cmd));
      writeFileSync(
        join(dir, `response-${req.id}.json`),
        JSON.stringify({ id: req.id, ok: false, error: 'The script object is no longer valid.' }),
      );
    }, 20);
    try {
      const r = await runUxp('return 1;', 3000);
      expect(r).toEqual({ ok: false, error: 'The script object is no longer valid.' });
    } finally {
      clearInterval(panel);
    }
  });
});
