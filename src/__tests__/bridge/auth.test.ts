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
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PremiereProBridge } from '../../bridge/index.js';

let dir: string;
const originalEnv = process.env.PREMIERE_TEMP_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'premiere-mcp-auth-'));
  process.env.PREMIERE_TEMP_DIR = dir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.PREMIERE_TEMP_DIR;
  else process.env.PREMIERE_TEMP_DIR = originalEnv;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * POSIX file modes are not a thing on NTFS, and pretending otherwise here would test the
 * filesystem rather than the server.
 *
 * On Windows `fs.chmod` can only toggle the read-only attribute, so `mode & 0o777` reports
 * 0o666 for a file and 0o777 for a directory whatever the server asked for. These
 * assertions are therefore POSIX-only, and they are SKIPPED rather than weakened, so a
 * Windows run reports them as not-run instead of showing a green tick under a title that
 * says "mode 700" on a platform where no such mode was set.
 *
 * What protects these files on Windows is the directory's NTFS ACL, which
 * scripts/install-windows.ps1 sets and scripts/doctor-windows.ps1 re-checks. That is not
 * verifiable from this suite; it is stated in docs/WINDOWS-PARITY.md section 2 and covered
 * by the installer's own readback.
 */
const itPosixMode = process.platform === 'win32' ? it.skip : it;

/** Initialise a bridge against the scratch dir. Premiere need not be installed or running. */
async function initBridge(): Promise<PremiereProBridge> {
  const bridge = new PremiereProBridge();
  await bridge.initialize();
  return bridge;
}

describe('per-session auth token', () => {
  itPosixMode('is written mode 0600, so it is not readable by group or world', async () => {
    await initBridge();
    // 0600: not group- or world-readable even if the directory mode is loosened later.
    expect(statSync(join(dir, 'auth-token.json')).mode & 0o777).toBe(0o600);
  });

  it('is written to the shared directory, as 32 random bytes tagged with the owning pid', async () => {
    await initBridge();
    const tokenFile = join(dir, 'auth-token.json');
    expect(existsSync(tokenFile)).toBe(true);

    const payload = JSON.parse(readFileSync(tokenFile, 'utf8'));
    // 32 random bytes as hex. Long enough that guessing is not a strategy.
    expect(typeof payload.token).toBe('string');
    expect(payload.token).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.pid).toBe(process.pid);
  });

  it('issues a different token per session', async () => {
    // This says nothing about a token being RETIRED — it was once titled "so a token cannot
    // outlive its process", matching a comment in the bridge that claimed the same thing. Both
    // were wrong: with PREMIERE_TEMP_DIR set the directory survives, so the file did too. What
    // actually retires a token is asserted in 'retiring a token' below.
    await initBridge();
    const first = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;
    await initBridge();
    const second = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;
    expect(second).not.toBe(first);
  });

  itPosixMode('keeps the shared directory at mode 700 even when it already existed', async () => {
    // mkdir's mode argument is ignored for an existing directory, which is ALWAYS the case when
    // PREMIERE_TEMP_DIR points at a fixed path — so the previous code protected only a machine's
    // first ever run.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o777 });
    await initBridge();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

/** A pid that is certainly not running, found rather than guessed. */
function deadPid(): number {
  for (let candidate = 100000; candidate < 400000; candidate++) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('could not find an unused pid');
}

const sessionFiles = (): string[] =>
  readdirSync(dir).filter((name) => name.startsWith('auth-session-') && name.endsWith('.json'));

describe('many servers, one bridge directory', () => {
  /*
   * THE CEILING THIS REMOVES. A panel holds ONE socket — to whichever server last published
   * bridge-endpoint.json — but any number of MCP servers can share a single PREMIERE_TEMP_DIR, and
   * the rest reach the panel over the file poll. auth-token.json is single-valued and
   * last-writer-wins, so the panel authorised only the newest server and answered every other one
   * UNAUTHORIZED through no fault of the caller.
   *
   * The fix is one file per server, owned outright by that server: no shared file is ever
   * read-modify-written, so two servers starting in the same instant cannot erase each other, and
   * each can delete its own credential on the way out without touching anyone else's.
   */

  itPosixMode('publishes its own token file mode 0600', async () => {
    await initBridge();
    const files = sessionFiles();
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0] as string)).mode & 0o777).toBe(0o600);
  });

  it('publishes a token file of its own, matching the shared one', async () => {
    await initBridge();
    const files = sessionFiles();
    expect(files).toHaveLength(1);

    const sessionPath = join(dir, files[0] as string);
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const shared = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8'));
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    // The single-server case must stay trivially consistent, or an older panel that reads only the
    // shared file would authorise a different token than a new panel does.
    expect(session.token).toBe(shared.token);
    expect(session.sessionId).toBe(shared.sessionId);
    expect(session.pid).toBe(process.pid);
  });

  it('leaves an earlier server’s token in place, so both stay usable', async () => {
    await initBridge();
    const firstToken = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;
    await initBridge();
    const secondToken = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;

    const tokens = sessionFiles().map(
      (name) => JSON.parse(readFileSync(join(dir, name), 'utf8')).token,
    );
    // Both live servers are represented. Before this, the first server's credential was simply
    // overwritten and its commands started coming back UNAUTHORIZED.
    expect(tokens).toHaveLength(2);
    expect(tokens).toContain(firstToken);
    expect(tokens).toContain(secondToken);
    // The shared file still names the newest, which is also the one the socket points at.
    expect(secondToken).not.toBe(firstToken);
  });

  it('reaps the token of a server that is no longer running, and keeps a live one', async () => {
    // A server killed with SIGKILL never runs its own cleanup. Without reaping, the panel would go
    // on accepting that token for as long as Premiere stayed open.
    writeFileSync(
      join(dir, 'auth-session-ghost.json'),
      JSON.stringify({ token: 'a'.repeat(64), sessionId: 'ghost', pid: deadPid() }),
    );
    writeFileSync(
      join(dir, 'auth-session-alive.json'),
      JSON.stringify({ token: 'b'.repeat(64), sessionId: 'alive', pid: process.pid }),
    );
    // Malformed: it can never authorise anything, so dropping it is safe and keeps the list short.
    writeFileSync(join(dir, 'auth-session-torn.json'), '{"token":');

    await initBridge();

    const names = sessionFiles();
    expect(names).not.toContain('auth-session-ghost.json');
    expect(names).not.toContain('auth-session-torn.json');
    expect(names).toContain('auth-session-alive.json');
  });
});

describe('retiring a token', () => {
  it('removes its own token on cleanup, so a dead server stops being authorised', async () => {
    const bridge = await initBridge();
    expect(sessionFiles()).toHaveLength(1);
    expect(existsSync(join(dir, 'auth-token.json'))).toBe(true);

    await bridge.cleanup();

    // Both go, because this server owned both. Previously neither did: cleanup() only removes the
    // temp directory when it created it, and PREMIERE_TEMP_DIR being set makes that false — which
    // is exactly the configuration in use, so the token always outlived its process.
    expect(sessionFiles()).toHaveLength(0);
    expect(existsSync(join(dir, 'auth-token.json'))).toBe(false);
  });

  it('does NOT delete the shared token when a newer server owns it', async () => {
    // The reason an unconditional unlink would be the wrong fix. Deleting a live server's
    // credential would break it; deleting the LAST token file is worse still, because the panel
    // treats "no token file" as an older server and runs unauthenticated.
    const first = await initBridge();
    const second = await initBridge();
    const secondToken = JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token;

    await first.cleanup();

    expect(existsSync(join(dir, 'auth-token.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'auth-token.json'), 'utf8')).token).toBe(secondToken);
    // Only the departing server's own file went; the survivor's is untouched.
    const remaining = sessionFiles().map(
      (name) => JSON.parse(readFileSync(join(dir, name), 'utf8')).token,
    );
    expect(remaining).toEqual([secondToken]);

    await second.cleanup();
    expect(sessionFiles()).toHaveLength(0);
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
    const inFlight = bridge
      .executeScript('(function(){ return "1"; })();', 2500)
      .catch(() => undefined);
    let captured: any = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !captured) {
      const { readdirSync } = await import('node:fs');
      const file = readdirSync(dir).find((n) => n.startsWith('command-') && n.endsWith('.json'));
      if (file) {
        try {
          captured = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        } catch {
          /* mid-write */
        }
      }
      if (!captured) await new Promise((r) => setTimeout(r, 25));
    }
    await inFlight;

    expect(captured).not.toBeNull();
    expect(captured.token).toBe(expected);
  }, 20_000);
});
