/**
 * Bridge authentication — server side.
 *
 * Before this, anything that could write a `command-*.json` into the shared temp directory could
 * execute arbitrary ExtendScript inside Premiere, with full project access and filesystem reach
 * through the `cep_js` path. There was no authentication of any kind.
 *
 * SCOPE OF THIS SUITE, stated up front because the other half matters just as much: these tests
 * cover what the SERVER does — issuing the token, its file mode, sweeping stale commands, and
 * putting the token on every command. The PANEL's rejection of a bad token lives in
 * `cep-plugin/bridge-cep.js`, which is not an importable module and runs inside Premiere's CEP
 * context; it can only be verified against a live host with a panel reload. That verification is
 * owed and is recorded as owed rather than implied by these tests passing.
 *
 * What the token is NOT: protection against a same-user process, which can simply read the token
 * file. Its jobs are to block blind writes, to stop two concurrent server instances consuming each
 * other's commands, and to make the trust boundary explicit. Protection from OTHER users comes from
 * the 0700 directory and the ownership check.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PremiereProBridge } from '../../bridge/index.js';

let dir: string;
const originalEnv = process.env.PREMIERE_TEMP_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trowel-auth-'));
  process.env.PREMIERE_TEMP_DIR = dir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.PREMIERE_TEMP_DIR;
  else process.env.PREMIERE_TEMP_DIR = originalEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Initialise a bridge against the scratch dir. Premiere need not be installed or running. */
async function initBridge(): Promise<PremiereProBridge> {
  const bridge = new PremiereProBridge();
  await bridge.initialize();
  return bridge;
}

describe('per-session auth token', () => {
  it('is written to the shared directory, owner-readable only', async () => {
    await initBridge();
    const tokenFile = join(dir, 'auth-token.json');
    expect(existsSync(tokenFile)).toBe(true);

    // 0600: not group- or world-readable even if the directory mode is loosened later.
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

    const payload = JSON.parse(readFileSync(tokenFile, 'utf8'));
    // 32 random bytes as hex. Long enough that guessing is not a strategy.
    expect(typeof payload.token).toBe('string');
    expect(payload.token).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.pid).toBe(process.pid);
  });

  it('issues a different token per session, so a token cannot outlive its process', async () => {
    await initBridge();
    const first = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;
    await initBridge();
    const second = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;
    expect(second).not.toBe(first);
  });

  it('keeps the shared directory at mode 700 even when it already existed', async () => {
    // mkdir's mode argument is ignored for an existing directory, which is ALWAYS the case when
    // PREMIERE_TEMP_DIR points at a fixed path — so the previous code protected only a machine's
    // first ever run.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o777 });
    await initBridge();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('stale command sweep', () => {
  it('removes leftover command files, which would otherwise execute on the next panel start', async () => {
    // Not litter: the panel polls for command-*.json and runs whatever it finds, so a command
    // abandoned by a crashed server is a delayed-action script with nobody awaiting its result.
    const orphan = join(dir, 'command-abandoned.json');
    const orphanResponse = join(dir, 'response-abandoned.json');
    const orphanStaging = join(dir, '.tmp-abandoned.json');
    writeFileSync(orphan, JSON.stringify({ id: 'abandoned', script: 'app.project.close()' }));
    writeFileSync(orphanResponse, '{}');
    writeFileSync(orphanStaging, '{}');

    await initBridge();

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(orphanResponse)).toBe(false);
    expect(existsSync(orphanStaging)).toBe(false);
  });

  it('leaves unrelated files alone', async () => {
    const keep = join(dir, 'bridge-heartbeat.json');
    writeFileSync(keep, '{"connected":true}');
    await initBridge();
    expect(existsSync(keep)).toBe(true);
  });
});

describe('every command carries the token', () => {
  it('puts the session token on an ExtendScript command', async () => {
    const bridge = await initBridge();
    const expected = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;

    // No panel is running, so the call will time out. The command file it publishes is the artifact
    // under test, so capture it from disk while the call is still in flight.
    const inFlight = bridge.executeScript('(function(){ return "1"; })();', 2500).catch(() => undefined);
    let captured: any = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !captured) {
      const { readdirSync } = await import('node:fs');
      const file = readdirSync(dir).find((n) => n.startsWith('command-') && n.endsWith('.json'));
      if (file) {
        try { captured = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { /* mid-write */ }
      }
      if (!captured) await new Promise((r) => setTimeout(r, 25));
    }
    await inFlight;

    expect(captured).not.toBeNull();
    expect(captured.token).toBe(expected);
  }, 20_000);
});
