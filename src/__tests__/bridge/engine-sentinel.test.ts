/**
 * Tests for `scripts/engine-sentinel.mjs`.
 *
 * This file exists because the sentinel had NO tests, and shipped in a state where it could not
 * return HEALTHY at all: it sent no auth token, the panel rejected every probe as UNAUTHORIZED, and
 * the sentinel classified that rejection as ENGINE_DEAD. `ensureHealthy()` acts on ENGINE_DEAD by
 * force-quitting Premiere, so on 2026-08-31 the health check closed the project a user had open.
 *
 * The probe is spawned as a real subprocess rather than imported, because it is deliberately
 * dependency-free and its exit code is part of its contract (0/1/2/3/4). The panel is stubbed by a
 * script that mirrors the parts of `cep-plugin/bridge-cep.js` this probe actually depends on:
 * token enforcement, atomic response publication, and unlinking the command only AFTER answering.
 * The sentinel's probe payload is plain JavaScript, so the stub can evaluate it for real instead of
 * hardcoding the expected reply — that way a change to the probe script cannot silently pass.
 */
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { ChildProcess } from 'child_process';

const SENTINEL = resolve(__dirname, '..', '..', '..', 'scripts', 'engine-sentinel.mjs');

let dir: string;
let panel: ChildProcess | null = null;

/**
 * A stand-in for the CEP panel. `enforceAuth` decides whether it accepts the probe's token, so the
 * same stub covers both the healthy path and the rejection that used to be misreported.
 */
const PANEL_STUB = `
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const mode = process.argv[3]; // 'accept' | 'reject' | 'silent' | 'busy'
const busyId = process.argv[4] || null;

function acceptedTokens() {
  const tokens = [];
  for (const name of readdirSync(dir)) {
    if (!/^(auth-token|auth-session-.*)\\.json$/.test(name)) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, name), 'utf8')).token;
      if (typeof t === 'string' && t) tokens.push(t);
    } catch {}
  }
  return tokens;
}

function publish(path, payload) {
  const staging = join(dir, '.tmp-resp-' + Math.random().toString(36).slice(2) + '.json');
  writeFileSync(staging, JSON.stringify(payload));
  renameSync(staging, path);
}

setInterval(() => {
  // The real panel writes this every 250ms. 'busy' advertises a different command in flight, which
  // is what tells the sentinel to say BUSY rather than accuse the panel of not polling.
  publish(join(dir, 'bridge-heartbeat.json'), {
    ts: Date.now(), connected: true,
    isProcessing: mode === 'busy', currentCommandId: mode === 'busy' ? busyId : null,
    currentCommandStartedAt: mode === 'busy' ? Date.now() : null, queueLength: 0,
  });
}, 100);

setInterval(() => {
  // A busy panel does not scan for new command files at all — that is the behaviour being modelled.
  if (mode === 'busy') return;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('command-') || !name.endsWith('.json')) continue;
    const cmdPath = join(dir, name);
    let cmd;
    try { cmd = JSON.parse(readFileSync(cmdPath, 'utf8')); } catch { continue; }
    const respPath = join(dir, name.replace('command-', 'response-'));

    if (mode === 'silent') { try { unlinkSync(cmdPath); } catch {} continue; }

    const tokens = acceptedTokens();
    const supplied = typeof cmd.token === 'string' ? cmd.token : '';
    const authorised = mode === 'accept' && tokens.length > 0 && tokens.includes(supplied);
    if (!authorised) {
      publish(respPath, {
        success: false, code: 'UNAUTHORIZED',
        error: 'Command rejected by the Premiere bridge panel: ' +
          (supplied ? 'token did not match this session' : 'command carried no token') + '.',
      });
      try { unlinkSync(cmdPath); } catch {}
      continue;
    }
    let result = null, success = true;
    try { result = eval(cmd.script); } catch (e) { success = false; result = String(e); }
    publish(respPath, { success, result });
    try { unlinkSync(cmdPath); } catch {}
  }
}, 50);
`;

function startPanel(mode: 'accept' | 'reject' | 'silent' | 'busy', busyId?: string): void {
  const stubPath = join(dir, 'panel-stub.mjs');
  writeFileSync(stubPath, PANEL_STUB);
  panel = spawn(process.execPath, [stubPath, dir, mode, busyId ?? ''], { stdio: 'ignore' });
}

function runSentinel(timeoutMs = 4000): { state: string; code: number; detail: string; status: number } {
  const out = spawnSync(process.execPath, [SENTINEL, '--json', `--timeout=${timeoutMs}`], {
    encoding: 'utf8',
    env: { ...process.env, PREMIERE_TEMP_DIR: dir },
    timeout: timeoutMs + 20_000,
  });
  const line = String(out.stdout).trim().split('\n').pop() ?? '';
  return { ...JSON.parse(line), status: out.status ?? -1 };
}

/** Write a token file the way the server does, so the stub has something to enforce against. */
function writeToken(token = 'a'.repeat(64)): string {
  writeFileSync(join(dir, 'auth-token.json'), JSON.stringify({ token, pid: process.pid }));
  return token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sentinel-test-'));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  panel?.kill('SIGKILL');
  panel = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('engine-sentinel authorisation', () => {
  it('sends the token from auth-token.json, so an authorising panel reports HEALTHY', async () => {
    // The regression. Before the fix this returned ENGINE_DEAD against a perfectly healthy panel,
    // which is the verdict that makes recovery force-quit Premiere.
    writeToken();
    startPanel('accept');
    const verdict = runSentinel();
    expect(verdict.state).toBe('HEALTHY');
    expect(verdict.status).toBe(0);
  });

  it('accepts a token from an auth-session-*.json when auth-token.json is absent', async () => {
    // Several servers can share one panel; each writes its own session file and the panel accepts
    // any of them. A probe that only knew about auth-token.json would fail in that configuration.
    writeFileSync(join(dir, 'auth-session-abc.json'), JSON.stringify({ token: 'b'.repeat(64) }));
    startPanel('accept');
    expect(runSentinel().state).toBe('HEALTHY');
  });

  it('reports SENTINEL_ERROR, not ENGINE_DEAD, when the panel rejects its credentials', async () => {
    // A rejection proves the panel is alive, watching the directory and answering. It says nothing
    // about the ExtendScript engine, because the script was never handed to it — so reporting
    // ENGINE_DEAD here would trigger a restart of a host that is fine.
    writeToken();
    startPanel('reject');
    const verdict = runSentinel();
    expect(verdict.state).toBe('SENTINEL_ERROR');
    expect(verdict.code).toBe(4);
    expect(verdict.detail).toMatch(/UNKNOWN — not dead/);
  });
});

describe('engine-sentinel classification', () => {
  it('reports ENGINE_DEAD when the panel consumes the command and never answers', async () => {
    // The verdict the file exists to produce, and the one case where a restart is the right call.
    writeToken();
    startPanel('silent');
    const verdict = runSentinel(2500);
    expect(verdict.state).toBe('ENGINE_DEAD');
    expect(verdict.code).toBe(1);
  });

  it('reports BUSY, not PANEL_DEAD, when another command is in flight', async () => {
    // A busy panel stops scanning for command files, so ours is never consumed — which looks
    // identical to a panel that has stopped polling until you read currentCommandId.
    writeToken();
    startPanel('busy', 'someone-elses-command-id');
    const verdict = runSentinel(2500);
    expect(verdict.state).toBe('BUSY');
    expect(verdict.code).toBe(3);
    expect(verdict.detail).toContain('someone-elses-command-id');
  });

  it('reports PANEL_DEAD when nothing is watching the directory', async () => {
    writeToken();
    const verdict = runSentinel(2000);
    expect(verdict.state).toBe('PANEL_DEAD');
    expect(verdict.code).toBe(2);
  });
});

describe('engine-sentinel temp-directory citizenship', () => {
  it('claims a client slot while probing and releases it afterwards', async () => {
    // The claim is what stops another server's startup sweep from deleting this probe's in-flight
    // files; leaving it behind would make future sweeps spare files nobody owns.
    writeToken();
    startPanel('accept');
    runSentinel();
    const leftover = require('fs').readdirSync(dir)
      .filter((n: string) => n.startsWith('client-') && n.endsWith('.json'));
    expect(leftover).toEqual([]);
  });
});
