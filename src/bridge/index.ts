/**
 * Bridge module for communicating with Adobe Premiere Pro
 *
 * This module handles the communication between the MCP server and Adobe Premiere Pro
 * using various methods including UXP, ExtendScript, and file-based communication.
 */

import { Logger } from '../utils/logger.js';
import { ChildProcess, execSync, spawnSync } from 'child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'fs';
import { extname, join } from 'path';
import { createSecureTempDir, validateFilePath } from '../utils/security.js';
import { currentEnv, sharedBridgeDir } from '../setup/setup.js';
import type { PremiereProTransport } from './types.js';
import { EXTENDSCRIPT_HELPERS } from './extendscript-helpers.js';
import {
  BridgeSocketTransport,
  BRIDGE_PROTOCOL_VERSION,
  type LatencyStats,
  type PanelHandshake,
  type SocketCommandType,
} from './socket-transport.js';

const UNSUPPORTED_MODAL_PRONE_IMPORT_EXTENSIONS = new Set(['.ass', '.ssa']);

// The CEP panel writes this file into the shared temp directory on every poll tick
// (~250ms). The server reads it to tell three failure modes apart that used to be
// indistinguishable — all of them blocked the caller for the full timeout:
//   1. panel never started / Premiere closed  (no heartbeat, or connected=false)
//   2. panel alive but wedged behind a modal   (heartbeat fresh, isProcessing=true)
//   3. panel crashed/froze mid-command         (heartbeat was fresh, now gone stale)
// A panel old enough not to write a heartbeat simply produces none, and the server
// falls back to its original full-timeout behaviour — so this is backward compatible.
const HEARTBEAT_FILE = 'bridge-heartbeat.json';
// The panel ticks every 250ms; 4s is 16 missed ticks — comfortably past any GC pause
// or slow disk, but far short of the 60s default timeout it replaces.
const HEARTBEAT_STALE_MS = 4000;
// Give a freshly-clicked Start Bridge time to write its first heartbeat before the
// server is willing to declare the panel dead.
const HEARTBEAT_GRACE_MS = 3000;

// The temp directory is SHARED by every bridge client pointed at it. Each server instance
// announces itself with `client-<pid>.json` so a peer's startup sweep can tell "abandoned by a
// crashed session" from "in flight for a process that is still running". Without this, the sweep
// deletes a live peer's command and response files, and the victim reports a dead ExtendScript
// engine on a completely healthy host.
const CLIENT_FILE_PREFIX = 'client-';
// A client file whose process is gone is worthless; one that has not been touched in this long is
// treated as abandoned even if some unrelated process now holds that pid.
const CLIENT_STALE_MS = 120_000;
// How recent a command/response file must be to be presumed in flight for a live peer. Longer than
// the 60s default command timeout, with room for the slow export/render paths that raise it.
const FOREIGN_FILE_GRACE_MS = 300_000;

interface BridgeHeartbeat {
  ageMs: number;
  connected: boolean;
  isProcessing: boolean;
  currentCommandId: string | null;
  currentCommandStartedAt: number | null;
  queueLength: number;
  /** ExtendScript engine health as the panel sees it; absent from older panels. */
  engine: 'ok' | 'stalled' | 'dead' | null;
}

// The ExtendScript helper library sent ahead of every script.
export { EXTENDSCRIPT_HELPERS };

export interface PremiereProProject {
  id: string;
  name: string;
  path: string;
  isOpen: boolean;
  sequences: PremiereProSequence[];
  projectItems: PremiereProProjectItem[];
}

export interface PremiereProSequence {
  id: string;
  name: string;
  duration: number;
  frameRate: number;
  videoTracks: PremiereProTrack[];
  audioTracks: PremiereProTrack[];
}

export interface PremiereProTrack {
  id: string;
  name: string;
  type: 'video' | 'audio';
  clips: PremiereProClip[];
}

export interface PremiereProClip {
  id: string;
  name: string;
  inPoint: number;
  outPoint: number;
  duration: number;
  mediaPath?: string;
}

export interface PremiereProProjectItem {
  id: string;
  name: string;
  type: 'footage' | 'sequence' | 'bin';
  mediaPath?: string;
  duration?: number;
  frameRate?: number;
}

export interface PremiereProEffect {
  id: string;
  name: string;
  category: string;
  parameters: Record<string, any>;
}

export class PremiereProBridge implements PremiereProTransport {
  private logger: Logger;
  private communicationMethod: 'uxp' | 'extendscript' | 'file';
  private tempDir: string;
  private readonly usesExternalTempDir: boolean;
  private uxpProcess?: ChildProcess;
  private isInitialized = false;
  /** Keeps `client-<pid>.json` fresh so peers can tell this process apart from a crashed one. */
  private clientBeacon: NodeJS.Timeout | null = null;
  private sessionId: string;
  /** Per-session token the panel must echo on every command. Null when it could not be written. */
  private authToken: string | null = null;
  /**
   * Push channel to the panel. Null until initialize() binds it, and null forever when the
   * operator pinned the transport to file IPC or the listener could not be bound.
   */
  private socket: BridgeSocketTransport | null = null;
  /**
   * Operator override, from PREMIERE_MCP_TRANSPORT:
   *   auto (default)  socket when a panel is connected, file IPC otherwise
   *   file            never bind a listener (no port, no firewall prompt)
   *   socket          refuse to publish over file IPC at all, and say so
   * Configurable rather than hardcoded because a peer bridge reports Premiere dying on the first
   * inbound socket command on some Windows builds. That report
   * is unverified, which is a reason to leave an escape hatch, not a reason to default to file.
   */
  private readonly transportPreference: 'auto' | 'file' | 'socket';
  /**
   * Publication counters. These exist so the exactly-one-channel invariant is OBSERVABLE rather
   * than asserted in a comment: every command increments exactly one of the first two.
   */
  private readonly publications = { socket: 0, file: 0, refusedAfterPublish: 0 };

  constructor() {
    this.logger = new Logger('PremiereProBridge');
    this.communicationMethod = 'file'; // Default to file-based communication
    this.sessionId = randomUUID();
    const preference = (process.env.PREMIERE_MCP_TRANSPORT || 'auto').trim().toLowerCase();
    this.transportPreference =
      preference === 'file' || preference === 'socket' ? preference : 'auto';
    // PREMIERE_TEMP_DIR if set; else the folder the bridge in Premiere watches by default (its saved
    // choice, else /tmp/premiere-mcp-bridge). A per-session folder here meant a server started
    // without the variable never met the background bridge, and every call timed out.
    // PREMIERE_MCP_SESSION_TEMP=1 keeps the old private per-session folder.
    const envDir = process.env.PREMIERE_TEMP_DIR;
    this.usesExternalTempDir = Boolean(envDir) || process.env.PREMIERE_MCP_SESSION_TEMP !== '1';
    this.tempDir = envDir
      ? envDir.replace(/\/$/, '')
      : process.env.PREMIERE_MCP_SESSION_TEMP === '1'
        ? createSecureTempDir(this.sessionId)
        : sharedBridgeDir(currentEnv());
  }

  async initialize(): Promise<void> {
    try {
      await this.setupTempDirectory();
      await this.detectPremiereProInstallation();
      await this.initializeCommunication();
      this.isInitialized = true;
      this.logger.info('Adobe Premiere Pro bridge initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Adobe Premiere Pro bridge:', error);
      throw error;
    }
  }

  /**
   * Establish the shared directory, and make it safe to share.
   *
   * Three things happen here, and the honest scope of each matters:
   *
   * 1. The directory is created 0700 AND, if it already existed, re-chmodded and ownership-checked.
   *    Creating with a mode does nothing when the directory is already there — which it always is
   *    when PREMIERE_TEMP_DIR points at a fixed path — so the previous code protected only the
   *    first run on a machine.
   * 2. Leftover `command-*.json` files are swept. A stale command file EXECUTES the moment the
   *    panel next starts, so an abandoned command from a crashed session was a delayed-action
   *    script with nobody waiting for its result.
   * 3. A per-session token is written 0600 and required on every command (see writeAuthToken).
   *
   * What this does NOT do, stated plainly because the alternative is security theatre: any process
   * running as this user can read the token file, so the token does not stop a same-user attacker.
   * Its real jobs are to block BLIND writes into the directory, to keep two concurrent server
   * instances from consuming each other's commands, and to make the trust boundary explicit. The
   * protection against other users is the 0700 directory and the ownership check, not the token.
   *
   * ON WINDOWS THAT MODE IS NOT ENFORCED, so the sentence above describes macOS only. NTFS stores
   * no POSIX mode: both the 0700 directory and the 0600 token file are inert, and the ownership
   * check is skipped because process.getuid does not exist there. The token is protected only by
   * the ACL the directory inherited. scripts/install-windows.ps1 restricts that ACL and
   * scripts/doctor-windows.ps1 verifies it; a server started without those having run has no
   * equivalent protection. See docs/WINDOWS-PARITY.md section 2.
   */
  private async setupTempDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
      // POSIX only. mkdir's mode is ignored for an existing directory, so assert it every
      // time -- but only where a mode and a uid mean something.
      //
      // The gate is the presence of a uid, not the platform name, because that is the thing
      // the comparison actually needs. On Windows process.getuid does not exist and
      // fs.Stats.uid is always 0, so this read `0 !== undefined`: always true. It threw
      // before the bridge ever reached Premiere, which made every tool in the catalogue
      // unreachable on Windows. Any other runtime without getuid failed the same way, and
      // "I cannot verify the owner" is not the same claim as "the owner is wrong".
      const processUid = process.getuid?.();
      if (processUid !== undefined) {
        try {
          const stats = await fs.stat(this.tempDir);
          if (stats.uid !== processUid) {
            throw new Error(
              `Refusing to use ${this.tempDir}: it is owned by uid ${stats.uid}, not by this process (uid ${processUid}). ` +
                'A directory owned by someone else can feed arbitrary ExtendScript into Premiere.',
            );
          }
          const mode = stats.mode & 0o777;
          if (mode !== 0o700) {
            await fs.chmod(this.tempDir, 0o700);
            this.logger.warn(`Tightened ${this.tempDir} from mode ${mode.toString(8)} to 700`);
          }
        } catch (statError) {
          // An ownership mismatch must abort; a stat/chmod failure for any other reason should not
          // take the bridge down, since the directory may still be perfectly usable.
          if (statError instanceof Error && statError.message.startsWith('Refusing to use'))
            throw statError;
          this.logger.warn(`Could not verify temp directory permissions: ${statError}`);
        }
      } else if (process.platform === 'win32') {
        // NTFS stores no POSIX mode, so the 0o700 above did nothing and a chmod here would
        // only toggle the read-only attribute. Saying so is the honest move: the previous
        // code logged `Tightened <dir> ... to 700` for an operation that cannot happen on
        // this platform. The directory and auth-token.json are protected by the ACL the
        // directory inherited and by nothing else -- scripts/install-windows.ps1 restricts
        // it and scripts/doctor-windows.ps1 re-checks it. See docs/WINDOWS-PARITY.md §2.
        this.logger.warn(
          `${this.tempDir}: POSIX permissions are not enforced on Windows, so this directory and ` +
            'auth-token.json are protected only by their inherited NTFS ACL. Run ' +
            '`npm run setup:doctor:win` to check it.',
        );
      } else {
        // Neither a uid nor a documented alternative: report the gap rather than imply a
        // check happened.
        this.logger.warn(
          `${this.tempDir}: this runtime exposes no process.getuid, so the directory's owner ` +
            'could not be verified and its permissions were not asserted.',
        );
      }

      await this.sweepStaleCommands();
      // Announce AFTER sweeping, so this instance never has to reason about its own beacon.
      await this.announceClient();
      await this.writeAuthToken();
      // After the token, never before: the socket publishes that same token in its endpoint file,
      // so binding first would advertise a port with a null token and force the panel to reconnect.
      await this.startSocketTransport();
      this.logger.debug(`Secure temp directory ready: ${this.tempDir}`);
    } catch (error) {
      this.logger.error('Failed to create temp directory:', error);
      throw error;
    }
  }

  /**
   * Remove `command-*.json` files left behind by an earlier session.
   *
   * These are not litter: the panel polls for that exact pattern and runs whatever it finds, so a
   * command abandoned by a crashed server executes against whatever project happens to be open
   * when Premiere next starts. Orphaned `response-*` and `.tmp-*` files go too — a stale response
   * could satisfy a future command that reuses its id (astronomically unlikely with UUIDs, but
   * free to rule out).
   *
   * SCOPED BY PEER LIVENESS, because the temp directory is SHARED and we are not necessarily its
   * only client. This used to delete every matching file unconditionally, which meant starting a
   * second client silently destroyed the first one's in-flight command and response files. The
   * victim then saw its command consumed and never answered — indistinguishable from a dead
   * ExtendScript engine.
   *
   * That is not hypothetical: on 2026-08-31 a harness pre-flight reported ENGINE_DEAD, and the
   * recovery it triggered force-quit a perfectly healthy Premiere and closed the open project.
   *
   * So: with no live peer, sweep everything (the original behaviour, and the common case). With a
   * live peer, spare anything young enough to still be in flight for it. A crashed session's
   * leftovers are older than any command timeout, so the original purpose survives either way.
   */
  private async sweepStaleCommands(): Promise<void> {
    try {
      const entries = await fs.readdir(this.tempDir);
      const peers = await this.livePeers(entries);
      const candidates = entries.filter(
        (name) =>
          (name.startsWith('command-') && name.endsWith('.json')) ||
          (name.startsWith('response-') && name.endsWith('.json')) ||
          name.startsWith('.tmp-'),
      );

      const swept: string[] = [];
      const spared: string[] = [];
      for (const name of candidates) {
        const path = join(this.tempDir, name);
        if (peers.length > 0) {
          let ageMs = Infinity;
          try {
            ageMs = Date.now() - (await fs.stat(path)).mtimeMs;
          } catch {
            continue; // vanished under us; nothing to do
          }
          if (ageMs < FOREIGN_FILE_GRACE_MS) {
            spared.push(name);
            continue;
          }
        }
        try {
          await fs.unlink(path);
          swept.push(name);
        } catch {
          /* another instance won the race */
        }
      }

      if (swept.length > 0) {
        this.logger.warn(
          `Swept ${swept.length} leftover command/response file(s) from ${this.tempDir}. ` +
            'A stale command file would have executed when the panel next started.',
        );
      }
      if (peers.length > 0) {
        // Worth saying out loud even when nothing was spared: a shared panel means any health
        // verdict derived from round-tripping a file through this directory can be another
        // client's race rather than a real fault.
        this.logger.warn(
          `Another bridge client is live on ${this.tempDir} (pid ${peers.join(', ')})` +
            (spared.length > 0 ? `; left ${spared.length} recent file(s) alone` : '') +
            '. The panel is shared, so file round-trip health probes (scripts/engine-sentinel.mjs) ' +
            'can report a dead engine for a healthy host.',
        );
      }
    } catch (error) {
      this.logger.warn(`Could not sweep stale commands: ${error}`);
    }
  }

  /**
   * Publish `client-<pid>.json` and keep it fresh, so a peer's startup sweep spares our in-flight
   * files. Best effort by design: failing to announce must not stop the bridge from working, it
   * only costs us the protection above.
   */
  private async announceClient(): Promise<void> {
    const path = join(this.tempDir, `${CLIENT_FILE_PREFIX}${process.pid}.json`);
    const touch = async () => {
      try {
        await fs.writeFile(
          path,
          JSON.stringify({
            pid: process.pid,
            sessionId: this.sessionId,
            ts: Date.now(),
          }),
          { mode: 0o600 },
        );
      } catch {
        /* best effort */
      }
    };
    await touch();
    // Comfortably inside CLIENT_STALE_MS so a busy event loop cannot make us look abandoned.
    this.clientBeacon = setInterval(touch, 30_000);
    this.clientBeacon.unref?.();
  }

  /**
   * Other bridge servers currently sharing this temp directory, by pid.
   *
   * Liveness is `kill(pid, 0)` rather than file age alone: a peer that is merely idle still owns
   * its in-flight files, and a peer that crashed stops owning them the instant it dies. The age
   * check only guards against a pid that has since been recycled by an unrelated process.
   */
  private async livePeers(entries: string[]): Promise<number[]> {
    const alive: number[] = [];
    for (const name of entries) {
      if (!name.startsWith(CLIENT_FILE_PREFIX) || !name.endsWith('.json')) continue;
      const pid = Number(name.slice(CLIENT_FILE_PREFIX.length, -'.json'.length));
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const path = join(this.tempDir, name);
      try {
        if (Date.now() - (await fs.stat(path)).mtimeMs > CLIENT_STALE_MS) {
          await fs.unlink(path).catch(() => {});
          continue;
        }
        process.kill(pid, 0);
        alive.push(pid);
      } catch {
        // ESRCH (process gone) or the file vanished — either way it is not a live peer.
        await fs.unlink(path).catch(() => {});
      }
    }
    return alive;
  }

  /** Our own token file — exclusively ours, so we can delete it on exit without a race. */
  private get sessionTokenFile(): string {
    return join(this.tempDir, `auth-session-${this.sessionId}.json`);
  }

  /**
   * Write the per-session token the panel must echo back.
   *
   * TWO files, on purpose.
   *
   * `auth-session-<sessionId>.json` is ours alone. Nothing else ever writes it, so there is no
   * read-modify-write race between servers starting at the same time, and on exit we can delete it
   * knowing the file we are removing is the one we created. The panel accepts a token matching ANY
   * of these, which is what lets several servers share one PREMIERE_TEMP_DIR: each has a live token,
   * and each is answered. Before this, `auth-token.json` was single-valued and last-writer-wins, so
   * every server but the newest had its commands rejected as UNAUTHORIZED.
   *
   * `auth-token.json` is still written, unchanged in shape, for one reason: an OLDER installed panel
   * only knows how to read that file. Dropping it would break a mismatched-version install silently.
   * It names the newest server, which is also the one the socket points at.
   *
   * Backwards compatibility in the other direction is also deliberate: the panel enforces a token
   * only when at least one of these files exists. An older server that writes none keeps working.
   */
  private async writeAuthToken(): Promise<void> {
    this.authToken = randomBytes(32).toString('hex');
    const payload = JSON.stringify({
      token: this.authToken,
      sessionId: this.sessionId,
      pid: process.pid,
      issuedAt: new Date().toISOString(),
    });
    try {
      // Write-then-rename so the panel can never read a half-written token, and 0600 so it is not
      // group- or world-readable even if the directory mode is somehow loosened later.
      const writeAtomic = async (target: string, staging: string): Promise<void> => {
        const stagingPath = join(this.tempDir, staging);
        await fs.writeFile(stagingPath, payload, { mode: 0o600 });
        await fs.chmod(stagingPath, 0o600);
        await fs.rename(stagingPath, target);
      };
      await writeAtomic(this.sessionTokenFile, `.auth-session-${this.sessionId}.tmp`);
      await writeAtomic(join(this.tempDir, 'auth-token.json'), '.auth-token.tmp');
      this.logger.debug('Wrote per-session bridge auth token');
    } catch (error) {
      // A bridge that cannot authenticate should still run rather than refuse to start; the panel
      // falls back to accepting untokened commands exactly as it did before.
      this.logger.warn(`Could not write auth token, continuing without it: ${error}`);
      this.authToken = null;
    }
    await this.reapDeadSessionTokens();
  }

  /**
   * Remove `auth-session-*.json` files whose server is gone.
   *
   * A server killed with SIGKILL — or one whose host crashed — never runs its own cleanup, and the
   * panel would keep accepting that token for as long as Premiere stayed open. `kill(pid, 0)` is a
   * liveness probe that sends no signal; EPERM means the pid exists but belongs to another user, so
   * that counts as alive rather than reapable.
   *
   * Not a security boundary — the temp directory is 0700, so anything that can read these files
   * already runs as this user and could read a live token just as easily. It is hygiene: it stops
   * the accepted-token list growing without bound across a long Premiere session.
   */
  private async reapDeadSessionTokens(): Promise<void> {
    try {
      const entries = await fs.readdir(this.tempDir);
      for (const name of entries) {
        if (!name.startsWith('auth-session-') || !name.endsWith('.json')) continue;
        const path = join(this.tempDir, name);
        if (path === this.sessionTokenFile) continue;
        let pid: number | null = null;
        try {
          const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
          pid = typeof parsed?.pid === 'number' ? parsed.pid : null;
        } catch {
          // Unreadable or malformed: it can never authorise anything, so it is safe to drop.
        }
        if (pid !== null) {
          try {
            process.kill(pid, 0);
            continue; // alive — leave its token in place
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') continue; // alive, another user
          }
        }
        try {
          await fs.unlink(path);
          this.logger.debug(
            `Reaped the bridge token of a server that is no longer running (${name})`,
          );
        } catch {
          /* another instance won the race */
        }
      }
    } catch (error) {
      this.logger.debug(`Could not reap stale session tokens: ${error}`);
    }
  }

  /**
   * Retire this session's token.
   *
   * The session file is ours exclusively, so it goes unconditionally. `auth-token.json` is shared
   * and last-writer-wins, so it goes ONLY if it still names us: deleting a newer server's token
   * would leave that server unable to authorise anything, and — worse — deleting the last token
   * file makes the panel run unauthenticated, which is the one outcome to avoid. When a newer
   * server owns it, leaving it alone is correct; its own cleanup removes it.
   */
  private async retireAuthToken(): Promise<void> {
    try {
      await fs.unlink(this.sessionTokenFile);
    } catch {
      /* never written, or already gone */
    }

    const sharedFile = join(this.tempDir, 'auth-token.json');
    try {
      const parsed = JSON.parse(await fs.readFile(sharedFile, 'utf8'));
      if (parsed?.sessionId === this.sessionId) await fs.unlink(sharedFile);
    } catch {
      /* absent, unreadable, or owned by another server — leave it */
    }
  }

  /**
   * Bind the loopback push channel, unless the operator pinned the transport to file IPC.
   *
   * Failure here is never fatal. A machine that will not give us a loopback listener still gets a
   * working bridge over the 250ms file poll — trading a latency improvement for a total outage
   * would be a poor bargain, and an unavailable socket is reported rather than hidden
   * (see getTransportStatus).
   */
  private async startSocketTransport(): Promise<void> {
    if (this.transportPreference === 'file') {
      this.logger.info('PREMIERE_MCP_TRANSPORT=file: not binding a WebSocket listener');
      return;
    }
    const transport = new BridgeSocketTransport({
      tempDir: this.tempDir,
      token: this.authToken,
      sessionId: this.sessionId,
      logger: this.logger,
    });
    const started = await transport.start();
    if (started === null) {
      if (this.transportPreference === 'socket') {
        // Pinned to socket and the listener would not bind. Refuse loudly rather than quietly
        // using the channel the operator ruled out.
        throw new Error(
          'PREMIERE_MCP_TRANSPORT=socket was requested but the loopback WebSocket listener could ' +
            'not be bound, and file IPC was ruled out by that setting. Unset PREMIERE_MCP_TRANSPORT ' +
            'to allow the file fallback.',
        );
      }
      return;
    }
    this.socket = transport;
  }

  /**
   * Pick the ONE channel this command will be published to.
   *
   * Publishing a command to both channels would hand the panel two copies of the same work, and a
   * second `insertClip` is not a slow edit, it is a wrong one. So this returns a single channel and
   * the callers below publish to exactly that.
   *
   * `not-published` from the socket is the one case where a second attempt is legitimate: it means
   * nothing reached the wire, so the command has still been published exactly once when it goes out
   * over file IPC.
   */
  private chooseChannel(commandType: SocketCommandType): {
    channel: 'socket' | 'file';
    reason: string;
  } {
    if (this.transportPreference === 'file')
      return { channel: 'file', reason: 'PREMIERE_MCP_TRANSPORT=file' };
    if (this.socket === null) return { channel: 'file', reason: 'no socket listener is bound' };
    if (!this.socket.isPanelReady())
      return { channel: 'file', reason: 'no panel is connected to the socket' };
    if (!this.socket.supportsFeature(commandType)) {
      return {
        channel: 'file',
        reason: `the connected panel did not announce the "${commandType}" feature`,
      };
    }
    return { channel: 'socket', reason: 'a handshaken panel is connected' };
  }

  /**
   * Publish one command and wait for its result, over exactly one channel.
   *
   * Returns the panel's result, or throws. The throw from a PUBLISHED socket command is never
   * followed by a file-IPC retry: see the socket-transport module header for why that matters more
   * than the latency this whole channel exists to save.
   */
  private async publishCommand(
    commandId: string,
    commandType: SocketCommandType,
    script: string,
    timeoutMs: number | undefined,
    mutating: boolean,
  ): Promise<any> {
    const effectiveTimeout = timeoutMs ?? 60000;
    const decision = this.chooseChannel(commandType);

    if (decision.channel === 'socket' && this.socket !== null) {
      const outcome = await this.socket.publish(
        { id: commandId, commandType, script, timeoutMs, mutating },
        effectiveTimeout,
      );

      if (outcome.status === 'ok') {
        this.publications.socket += 1;
        return outcome.result;
      }

      if (outcome.status === 'failed') {
        // Published. The command is finished as far as this server is concerned, whatever state the
        // project is in — and the error text says so.
        this.publications.socket += 1;
        if (outcome.mayHavePartiallyApplied) this.publications.refusedAfterPublish += 1;
        throw outcome.error;
      }

      // not-published: the panel vanished between the decision and the send, so nothing reached the
      // wire. This is the ONLY path that continues to a second channel.
      this.logger.warn(
        `Socket publish declined (${outcome.reason}); publishing over file IPC instead. ` +
          'Nothing was sent over the socket, so this command is still published exactly once.',
      );
      if (this.transportPreference === 'socket') {
        throw new Error(
          `PREMIERE_MCP_TRANSPORT=socket was requested but the command could not be published over ` +
            `the socket (${outcome.reason}), and that setting rules out file IPC. Nothing was sent. ` +
            'Open the MCP Bridge (CEP) panel and start it, or unset PREMIERE_MCP_TRANSPORT.',
        );
      }
    } else if (this.transportPreference === 'socket') {
      throw new Error(
        `PREMIERE_MCP_TRANSPORT=socket was requested but ${decision.reason}, and that setting rules ` +
          'out file IPC. Nothing was sent. Open the MCP Bridge (CEP) panel and start it, or unset ' +
          'PREMIERE_MCP_TRANSPORT.',
      );
    }

    this.publications.file += 1;
    return await this.publishOverFileIpc(
      commandId,
      commandType,
      script,
      timeoutMs,
      effectiveTimeout,
    );
  }

  /**
   * The original transport: write `command-<uuid>.json`, wait for `response-<uuid>.json`.
   *
   * Unchanged in behaviour — the atomic write-then-rename, the token, and the cleanup on every exit
   * path are all load-bearing and documented where they happen.
   */
  private async publishOverFileIpc(
    commandId: string,
    commandType: SocketCommandType,
    script: string,
    timeoutMs: number | undefined,
    effectiveTimeout: number,
  ): Promise<any> {
    const commandFile = join(this.tempDir, `command-${commandId}.json`);
    const responseFile = join(this.tempDir, `response-${commandId}.json`);
    // Declared out here so the finally below can remove it: if rename() fails the
    // scratch file is still on disk, and nothing else ever matches that name.
    const commandStaging = join(this.tempDir, `.tmp-${commandId}.json`);

    try {
      // Write command to file. Include timeoutMs so the CEP/UXP panel can extend its own
      // execution watchdog to match — otherwise the panel's default (45s) kills long batch
      // scripts well before the server's own timeout elapses.
      //
      // Written to a scratch name and renamed into place, because the panel polls this
      // directory and picks up anything matching command-*.json the moment it appears. A
      // plain write publishes the filename before the content is complete, so the panel
      // can read a truncated command, fail to parse it, and — since its parse failure path
      // writes an error response and deletes the command — turn a transient race into a
      // permanent spurious failure with no retry. rename() within one directory is atomic,
      // so the file becomes visible only once it is whole.
      //
      // The scratch name must not itself look like a command to the panel, which matches on
      // a "command-" prefix; a leading dot keeps it out of that test.
      const payload: Record<string, unknown> = {
        id: commandId,
        script,
        timeoutMs: timeoutMs,
        // Echoed from auth-token.json. The panel rejects a mismatched token when that file exists,
        // so a process that can write to this directory but has not read the token cannot inject a
        // command. See setupTempDirectory for the honest limits of that guarantee.
        token: this.authToken,
        timestamp: new Date().toISOString(),
      };
      // The panel branches on `type` and only knows one value for it; an ExtendScript command has
      // carried no type since the beginning, so adding one now would be a wire change for nothing.
      if (commandType === 'cep_js') payload['type'] = 'cep_js';
      await fs.writeFile(commandStaging, JSON.stringify(payload));
      await fs.rename(commandStaging, commandFile);

      // Wait for the panel's response file. Batch operations pass a larger timeout because a single round-trip does the work of
      // dozens of individual calls inside one ExtendScript pass.
      return await this.waitForResponse(responseFile, effectiveTimeout, commandId);
    } finally {
      // Cleanup has to run on the failure path too. Previously it sat after the await, so a
      // timeout skipped it entirely and left the command file behind for the panel to pick
      // up and execute long after the caller had given up on it.
      //
      // One case this does not close: when the panel is merely slow, the response file is
      // written after this has already run, so it stays until the directory is cleaned. The
      // command file is the one that matters here, because a stale command still executes.
      await fs.unlink(commandStaging).catch(() => {});
      await fs.unlink(commandFile).catch(() => {});
      await fs.unlink(responseFile).catch(() => {});
    }
  }

  /**
   * What the transport is actually doing, with measured numbers rather than claims.
   *
   * `latency` is real round-trip timing (publish -> response) taken from a monotonic clock on this
   * side and including the panel's own execution time, because that is what a caller waits for. When
   * no command has completed over the socket, every field is null — an unmeasured latency is
   * reported as unmeasured, not as zero.
   */
  getTransportStatus(): {
    preference: 'auto' | 'file' | 'socket';
    activeChannel: 'socket' | 'file';
    activeChannelReason: string;
    protocolVersion: string;
    socket: {
      listening: boolean;
      port: number | null;
      endpointFile: string | null;
      panelConnected: boolean;
      handshake: PanelHandshake | null;
      inFlight: number;
      latency: LatencyStats | null;
    };
    publications: { socket: number; file: number; refusedAfterPublish: number };
  } {
    const decision = this.chooseChannel('extendscript');
    return {
      preference: this.transportPreference,
      activeChannel: decision.channel,
      activeChannelReason: decision.reason,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      socket: {
        listening: this.socket !== null && this.socket.listeningPort() !== null,
        port: this.socket ? this.socket.listeningPort() : null,
        endpointFile: this.socket ? join(this.tempDir, 'bridge-endpoint.json') : null,
        panelConnected: this.socket ? this.socket.isPanelReady() : false,
        handshake: this.socket ? this.socket.handshake() : null,
        inFlight: this.socket ? this.socket.inFlight() : 0,
        latency: this.socket ? this.socket.latency() : null,
      },
      publications: { ...this.publications },
    };
  }

  private async detectPremiereProInstallation(): Promise<void> {
    // Scan the install root instead of hardcoding release years, so new
    // versions (2025, 2026, ...) are detected without a code change.
    const searchDirs =
      process.platform === 'win32'
        ? [join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Adobe')]
        : ['/Applications'];

    for (const dir of searchDirs) {
      let entries: string[] = [];
      try {
        const listing = await fs.readdir(dir);
        entries = Array.isArray(listing) ? listing : [];
      } catch (error) {
        continue; // Install root is missing on this machine
      }

      // Newest release first, e.g. "Adobe Premiere Pro 2026" before "... 2024"
      const candidates = entries
        .filter((entry) => entry.startsWith('Adobe Premiere Pro'))
        .sort()
        .reverse();

      for (const candidate of candidates) {
        const path = join(dir, candidate);
        try {
          await fs.access(path);
          this.logger.info(`Found Adobe Premiere Pro at: ${path}`);
          return;
        } catch (error) {
          // Continue checking other candidates
        }
      }
    }

    this.logger.warn('Adobe Premiere Pro installation not found in common paths');
  }

  private async initializeCommunication(): Promise<void> {
    // For now, we'll use file-based communication as it's the most reliable
    // In a production environment, you would set up UXP or ExtendScript communication
    this.communicationMethod = 'file';
    this.logger.info(`Using ${this.communicationMethod} communication method`);
  }

  private isSelfInvokingScript(script: string): boolean {
    const trimmed = script.trim();
    return /^\(function\s*\(\)\s*\{[\s\S]*\}\)\s*\(\)\s*;?$/.test(trimmed);
  }

  /**
   * Repairs the two characters that survive JSON.stringify but not the trip
   * into Premiere. Both were reproduced against a live 26.0.2 host.
   *
   * U+2028 and U+2029 are legal unescaped inside a JSON string, so
   * JSON.stringify leaves them raw — but they are line terminators to a
   * JavaScript parser, so a marker named with one produced a generated script
   * with a string literal split across two lines, and the whole call died as
   * "ExtendScript execution failed via CEP evalScript()". Re-escaping them is
   * safe here because everything this server generates is otherwise ASCII, so
   * the only place either can appear is inside a string literal.
   */
  private static repairScriptLineTerminators(script: string): string {
    return script.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  /**
   * A NUL truncates the script at that byte on the way through evalScript, so
   * the host silently receives a prefix of what was sent — a marker named
   * "p\0q" was created as "p". Truncated input is worse than a rejected call,
   * so refuse it and say which argument carried it.
   */
  private static assertNoNulByte(script: string): void {
    const index = script.indexOf('\u0000');
    if (index === -1) return;

    const context = script.slice(Math.max(0, index - 40), index).replace(/\s+/g, ' ');
    throw new Error(
      'Script contains a NUL byte, which Premiere truncates at rather than ' +
        'rejecting, silently discarding everything after it. Remove the NUL ' +
        `from the offending argument. Context before it: ...${context}`,
    );
  }

  private buildExecutableScript(script: string, callerAuthored = false): string {
    PremiereProBridge.assertNoNulByte(script);

    // The line-terminator repair is only safe on scripts this server generated, where
    // everything outside a string literal is ASCII and a U+2028 can therefore only be
    // caller data inside a string. A script handed to execute_extendscript breaks that
    // assumption: rewriting it blindly turned a U+2028 the caller used as a line break
    // into the literal characters \u2028, producing a syntax error on a script that
    // previously ran. Caller-authored source is passed through untouched.
    const safeScript = callerAuthored
      ? script
      : PremiereProBridge.repairScriptLineTerminators(script);

    if (this.isSelfInvokingScript(safeScript)) {
      return EXTENDSCRIPT_HELPERS + safeScript.trim();
    }

    // Wrap script bodies so top-level "return ..." remains valid in ExtendScript.
    return EXTENDSCRIPT_HELPERS + '(function(){\n' + safeScript + '\n})();';
  }

  // Read text from the macOS system clipboard (Node.js side — no CEP panel needed).
  readClipboard(): string {
    return execSync('/usr/bin/pbpaste').toString();
  }

  // Write text to the macOS system clipboard (Node.js side — no CEP panel, no crashes).
  writeClipboard(text: string): void {
    const result = spawnSync('/usr/bin/pbcopy', [], { input: text, encoding: 'utf8' });
    if (result.error) throw result.error;
  }

  // Execute JavaScript in the CEP panel context (not ExtendScript).
  // Has access to window.cep, CSInterface methods, browser APIs.
  async executeCepJs(script: string, timeoutMs = 10000): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Bridge not initialized. Call initialize() first.');
    }
    const commandId = randomUUID();
    try {
      // The cep_js path needs the token as much as the ExtendScript one — arguably more, since it
      // runs in the panel's own JS context with window and filesystem reach. An authenticated
      // ExtendScript channel beside an unauthenticated CEP one would be no protection at all. Both
      // channels carry it: the socket in its hello, the file in the command payload.
      //
      // Treated as mutating: panel-context JavaScript can do anything, so its half-applied state is
      // not something this server can reason about.
      return await this.publishCommand(commandId, 'cep_js', script, timeoutMs, true);
    } catch (error) {
      this.logger.error(`Failed to execute CEP JS: ${error}`);
      throw error;
    }
  }

  async executeScript(script: string, timeoutMs?: number, callerAuthored = false): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Bridge not initialized. Call initialize() first.');
    }

    const commandId = randomUUID();

    try {
      const fullScript = this.buildExecutableScript(script, callerAuthored);
      // Every generated script in this catalogue is treated as potentially mutating. There is no
      // reliable way to prove a given ExtendScript body is read-only by inspecting it, and guessing
      // wrong in the permissive direction would downgrade a "may have partially applied" warning on
      // a real edit into a shrug about a read.
      return await this.publishCommand(commandId, 'extendscript', fullScript, timeoutMs, true);
    } catch (error) {
      this.logger.error(`Failed to execute script: ${error}`);
      throw error;
    }
  }

  /**
   * Reads the panel's liveness heartbeat, returning null when it is absent or
   * unparseable (an older panel, or a torn write). ageMs is relative to the local
   * clock — panel and server share the same machine, so the two wall clocks agree.
   */
  private async readHeartbeat(): Promise<BridgeHeartbeat | null> {
    let raw: string;
    try {
      raw = await fs.readFile(join(this.tempDir, HEARTBEAT_FILE), 'utf8');
    } catch {
      return null;
    }

    try {
      const hb = JSON.parse(raw);
      if (typeof hb.ts !== 'number') return null;
      return {
        ageMs: Date.now() - hb.ts,
        connected: hb.connected === true,
        isProcessing: hb.isProcessing === true,
        currentCommandId: typeof hb.currentCommandId === 'string' ? hb.currentCommandId : null,
        currentCommandStartedAt:
          typeof hb.currentCommandStartedAt === 'number' ? hb.currentCommandStartedAt : null,
        queueLength: typeof hb.queueLength === 'number' ? hb.queueLength : 0,
        engine:
          hb.engine === 'ok' || hb.engine === 'stalled' || hb.engine === 'dead' ? hb.engine : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Turns the last observed heartbeat into an actionable timeout message. Each branch
   * names the ONE thing the caller can do about it, instead of the old catch-all that
   * listed every possible cause and left the reader to guess which applied.
   */
  private describeTimeout(timeout: number, hb: BridgeHeartbeat | null, commandId?: string): string {
    const base = `Bridge response timeout after ${timeout}ms.`;

    if (!hb) {
      return (
        base +
        ' No panel heartbeat was seen. Ensure Premiere Pro is open, the MCP Bridge (CEP) ' +
        'panel is open, Temp Directory is set to ' +
        this.tempDir +
        ', and Start Bridge is ' +
        'clicked. (An older panel build without heartbeat support also produces no heartbeat.)'
      );
    }

    if (hb.engine === 'dead') {
      return (
        base +
        " Premiere's scripting engine has stopped responding, even to a trivial test script. It " +
        'does not recover on its own: save your work if Premiere lets you, then restart Premiere Pro.'
      );
    }

    if (hb.engine === 'stalled') {
      return (
        base +
        " Premiere's scripting engine is still running an earlier script that ran past its time " +
        'limit (it cannot be cancelled). If Premiere is showing a dialog, close it; otherwise wait and retry.'
      );
    }

    if (!hb.connected) {
      return (
        base +
        ` The panel is open but the bridge is not started (heartbeat age ${hb.ageMs}ms). ` +
        'Click Start Bridge in the MCP Bridge panel.'
      );
    }

    if (hb.isProcessing && hb.currentCommandId && commandId && hb.currentCommandId !== commandId) {
      const busyFor =
        hb.currentCommandStartedAt != null
          ? `${Date.now() - hb.currentCommandStartedAt}ms`
          : 'an unknown time';
      return (
        base +
        ` The bridge is busy: the panel has been processing another command ` +
        `(id ${hb.currentCommandId}) for ${busyFor} and never started this one. If Premiere ` +
        'is showing a modal dialog (an import/codec/save prompt, for example), dismiss it — ' +
        'the bridge cannot advance queued commands until it clears.'
      );
    }

    if (hb.isProcessing && hb.currentCommandId === commandId) {
      return (
        base +
        ' The panel is still processing this command — the operation is genuinely ' +
        'long-running. Pass a larger timeoutMs or split the work into smaller steps.'
      );
    }

    if (hb.isProcessing) {
      return (
        base +
        ' The panel reports it is processing a command but produced no response. If Premiere ' +
        'is showing a modal dialog, dismiss it.'
      );
    }

    return (
      base +
      ` The panel is alive and idle (heartbeat age ${hb.ageMs}ms) but wrote no response for ` +
      'this command — the host-side script likely failed before it could write a result.'
    );
  }

  private async waitForResponse(
    responseFile: string,
    timeout = 60000,
    commandId?: string,
  ): Promise<any> {
    const startTime = Date.now();
    // A response that exists but will not parse is a different failure from one that has
    // not arrived, and reporting it as the latter sends the reader to check whether
    // Premiere is running when the real problem is the payload. A torn read (the panel's write
    // is not atomic on every host) is retried until the timeout; if it never parses, the
    // timeout reports the parse error and a sample of what was actually on disk.
    let lastParseError: Error | null = null;
    let lastRawResponse = '';
    // Track the panel's liveness so a dead/frozen panel fails fast instead of blocking
    // the caller for the whole timeout, and so the timeout message (if we get there) can
    // say which of several unrelated things actually went wrong.
    let sawFreshHeartbeat = false;
    let lastHeartbeat: BridgeHeartbeat | null = null;

    while (Date.now() - startTime < timeout) {
      let raw: string;
      try {
        raw = await fs.readFile(responseFile, 'utf8');
      } catch {
        // Not written yet. This is the ordinary case while the host is still working.
        // Before sleeping, consult the panel heartbeat: if the panel was alive and has
        // since stopped ticking, there is no point waiting out the rest of the timeout.
        const elapsed = Date.now() - startTime;
        const hb = await this.readHeartbeat();
        if (hb) {
          lastHeartbeat = hb;
          if (hb.ageMs <= HEARTBEAT_STALE_MS) sawFreshHeartbeat = true;
        }

        // Fail fast only with positive evidence the panel HAD a live heartbeat that has
        // now gone stale or vanished — that means the panel or Premiere crashed, was
        // closed, or froze while we were waiting. A panel that never wrote a heartbeat
        // (older build) leaves sawFreshHeartbeat false and keeps the original behaviour.
        if (
          elapsed > HEARTBEAT_GRACE_MS &&
          sawFreshHeartbeat &&
          (!hb || hb.ageMs > HEARTBEAT_STALE_MS)
        ) {
          const age = hb ? `${hb.ageMs}ms old` : 'gone';
          throw new Error(
            `Bridge panel stopped responding: its heartbeat is ${age} while waiting for a ` +
              'response. Premiere Pro likely crashed, was closed, or froze. Restart Premiere Pro ' +
              '(the bridge starts with it); `premiere-mcp doctor` checks it. Bridge folder: ' +
              this.tempDir +
              '.',
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }

      try {
        const parsed = JSON.parse(raw);
        if (parsed.result !== undefined) return parsed.result;
        return parsed;
      } catch (error) {
        lastParseError = error instanceof Error ? error : new Error(String(error));
        lastRawResponse = raw;
        // Keep polling to the full timeout rather than giving up after a few
        // attempts. A response written non-atomically can be unreadable for many
        // polls, and failing early would turn a slow write into a hard error. The
        // parse failure is remembered so the diagnosis below can still name it.
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    if (lastParseError) {
      throw new Error(
        `Bridge response never became valid JSON before the ${timeout}ms timeout. Last parse ` +
          `error: ${lastParseError.message}. First 200 characters on disk: ` +
          JSON.stringify(lastRawResponse.slice(0, 200)),
      );
    }

    throw new Error(this.describeTimeout(timeout, lastHeartbeat, commandId));
  }

  // Project Management
  async createProject(name: string, location: string): Promise<PremiereProProject> {
    const normalizedLocation = location.replace(/[\\/]+$/, '');
    const projectFileName = name.endsWith('.prproj') ? name : `${name}.prproj`;
    const projectPath = `${normalizedLocation}/${projectFileName}`;
    const script = `
      var projectPath = ${JSON.stringify(projectPath)};
      var projectFolder = new Folder(${JSON.stringify(normalizedLocation)});

      if (!projectFolder.exists && !projectFolder.create()) {
        return JSON.stringify({
          success: false,
          error: "Could not create project folder",
          projectPath: projectPath
        });
      }

      var createdResult = app.newProject(projectPath);
      var projectFile = new File(projectPath);

      if (!projectFile.exists && app.project && app.project.saveAs) {
        try {
          app.project.saveAs(projectPath);
        } catch (saveError) {}
      }

      var project = app.project;
      var actualPath = project && project.path ? String(project.path) : "";

      if (!projectFile.exists || !__samePath(actualPath, projectPath)) {
        return JSON.stringify({
          success: false,
          error: "Premiere Pro did not create or activate the requested project",
          projectPath: projectPath,
          actualPath: actualPath,
          createdResult: createdResult
        });
      }

      return JSON.stringify({
        success: true,
        id: project.documentID,
        name: project.name,
        path: project.path,
        isOpen: true,
        sequences: [],
        projectItems: []
      });
    `;

    return await this.executeScript(script);
  }

  async openProject(path: string): Promise<PremiereProProject> {
    const script = `
      var projectPath = ${JSON.stringify(path)};
      var projectFile = new File(projectPath);

      if (!projectFile.exists) {
        return JSON.stringify({
          success: false,
          error: "Project file does not exist",
          projectPath: projectPath
        });
      }

      var openResult = app.openDocument(projectPath);
      var project = app.project;
      var actualPath = project && project.path ? String(project.path) : "";

      if (!project || !__samePath(actualPath, projectPath)) {
        return JSON.stringify({
          success: false,
          error: "Premiere Pro did not activate the requested project",
          projectPath: projectPath,
          actualPath: actualPath,
          openResult: openResult
        });
      }

      return JSON.stringify({
        success: true,
        id: project.documentID,
        name: project.name,
        path: project.path,
        isOpen: true,
        sequences: [],
        projectItems: []
      });
    `;

    return await this.executeScript(script);
  }

  async saveProject(): Promise<void> {
    const script = `
      // Save current project
      app.project.save();
      return JSON.stringify({ success: true });
    `;

    await this.executeScript(script);
  }

  /**
   * Import one media file, optionally INTO a named bin.
   *
   * The destination used to be hardcoded to app.project.rootItem while the
   * caller's binName was echoed back in the response, so every bin-targeted
   * import reported a bin it had not used. The bin is now resolved (by id, path
   * or deep name) via the __resolveBin prelude helper, an unresolvable bin
   * fails before anything is imported, and the parent bin is read back off the
   * imported item rather than restated from the request.
   */
  async importMedia(
    filePath: string,
    binName?: string,
    binId?: string,
  ): Promise<PremiereProProjectItem> {
    // Validate file path for security
    const pathValidation = validateFilePath(filePath);
    if (!pathValidation.valid) {
      throw new Error(`Invalid file path: ${pathValidation.error}`);
    }

    // Use the normalized path from validation (don't double-escape)
    const safePath = pathValidation.normalized || filePath;
    const ext = extname(safePath).toLowerCase();
    if (UNSUPPORTED_MODAL_PRONE_IMPORT_EXTENSIONS.has(ext)) {
      return {
        success: false,
        error: `Unsupported import format "${ext}". Premiere Pro can show a blocking "File format not supported" modal for this file type, so the MCP server refused to import it before calling Premiere. Convert it to .srt or another Premiere-supported media format first.`,
        filePath: safePath,
        blockedBeforePremiere: true,
      } as any;
    }

    const script = `
      try {
        function __walkItems(parent, output) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            output.push(child);
            if (child.type === ProjectItemType.BIN) {
              __walkItems(child, output);
            }
          }
        }

        var file = new File(${JSON.stringify(safePath)});
        if (!file.exists) {
          return JSON.stringify({
            success: false,
            error: "File not found: " + ${JSON.stringify(safePath)}
          });
        }

        var __binRequest = __resolveImportBin(${binId !== undefined ? JSON.stringify(binId) : 'null'}, ${binName !== undefined ? JSON.stringify(binName) : 'null'});
        if (__binRequest.error) {
          return JSON.stringify({
            success: false,
            error: __binRequest.error + " Nothing was imported. Omit binName/binId to import to the project root.",
            binName: ${binName !== undefined ? JSON.stringify(binName) : 'null'},
            binId: ${binId !== undefined ? JSON.stringify(binId) : 'null'},
            matchCount: __binRequest.matchCount
          });
        }
        var __destBin = __binRequest.bin;

        var existingItems = [];
        __walkItems(app.project.rootItem, existingItems);

        // Premiere returns true when asked to import media already in the
        // project, but it does not add another project item. Reuse that item
        // instead of reporting a fabricated import failure. It is reported at
        // whatever bin it actually sits in -- a re-import does not move it, so
        // claiming the requested bin here would be the same lie the hardcoded
        // root destination used to tell.
        for (var existingIndex = 0; existingIndex < existingItems.length; existingIndex++) {
          var existingItem = existingItems[existingIndex];
          try {
            if (existingItem.getMediaPath && existingItem.getMediaPath() === file.fsName) {
              var __existingPath = null;
              try { __existingPath = String(existingItem.treePath); } catch (eTp) {}
              // A caller who named a bin is relying on the media being there. The re-import does not
              // move it, so success here would claim a bin the item is not in.
              var __binWasRequested = ${binName !== undefined || binId !== undefined ? 'true' : 'false'};
              var __inDest = false;
              try { for (var xi = 0; xi < __destBin.children.numItems; xi++) { if (__destBin.children[xi].nodeId === existingItem.nodeId) { __inDest = true; break; } } } catch (eIn) {}
              if (__binWasRequested && !__inDest) {
                return JSON.stringify({
                  success: false,
                  alreadyImported: true,
                  id: existingItem.nodeId,
                  name: existingItem.name,
                  treePath: __existingPath,
                  movedToRequestedBin: false,
                  error: "This file is already in the project at " + __existingPath + ", not in the requested bin '" + String(__destBin.name) + "'. Nothing was imported or moved; use move_item_to_bin to put it there."
                });
              }
              return JSON.stringify({
                success: true,
                binCreated: __binRequest.created === true,
                id: existingItem.nodeId,
                name: existingItem.name,
                type: existingItem.type.toString(),
                mediaPath: file.fsName,
                alreadyImported: true,
                treePath: __existingPath,
                movedToRequestedBin: false
              });
            }
          } catch (e) {}
        }

        var importResult = app.project.importFiles([file.fsName], true, __destBin, false);
        if (!importResult) {
          return JSON.stringify({
            success: false,
            error: "Failed to import file"
          });
        }

        var afterItems = [];
        __walkItems(app.project.rootItem, afterItems);

        var importedItem = null;
        for (var j = 0; j < afterItems.length; j++) {
          var candidate = afterItems[j];
          var alreadyPresent = false;
          for (var k = 0; k < existingItems.length; k++) {
            if (existingItems[k].nodeId === candidate.nodeId) {
              alreadyPresent = true;
              break;
            }
          }
          if (alreadyPresent) {
            continue;
          }
          try {
            if (candidate.getMediaPath && candidate.getMediaPath() === file.fsName) {
              importedItem = candidate;
              break;
            }
          } catch (e) {}
          if (!importedItem && candidate.name === file.name) {
            importedItem = candidate;
          }
        }

        if (!importedItem) {
          return JSON.stringify({
            success: false,
            error: "Import completed but imported item could not be located"
          });
        }

        // The destination is read back off the imported item, not restated from
        // the request: treePath is what Premiere actually did with it.
        var __landedPath = null;
        try { __landedPath = String(importedItem.treePath); } catch (eLanded) {}
        var __landedInRequestedBin = null;
        try {
          var __found = false;
          for (var di = 0; di < __destBin.children.numItems; di++) {
            if (__destBin.children[di] && __destBin.children[di].nodeId === importedItem.nodeId) { __found = true; break; }
          }
          __landedInRequestedBin = __found;
        } catch (eCheck) {}

        var __payload = {
          success: true,
          binCreated: __binRequest.created === true,
          id: importedItem.nodeId,
          name: importedItem.name,
          type: importedItem.type.toString(),
          mediaPath: importedItem.getMediaPath ? importedItem.getMediaPath() : file.fsName,
          binId: __destBin.nodeId,
          binName: String(__destBin.name),
          binResolvedBy: __binRequest.resolvedBy,
          treePath: __landedPath
        };
        // Only claim verified when the readback actually answered. An
        // unreadable children collection is "unknown", not "confirmed".
        if (__landedInRequestedBin !== null) __payload.verified = __landedInRequestedBin;
        if (__landedInRequestedBin === false) {
          __payload.success = false;
          __payload.error = "The file was imported but did not land in the requested bin '" + String(__destBin.name) + "'; it is at " + __landedPath + ". Move it with move_item_to_bin.";
        }
        return JSON.stringify(__payload);
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.executeScript(script);
  }

  async createSequence(name: string, presetPath: string): Promise<PremiereProSequence> {
    const script = `
      try {
        var sequenceName = ${JSON.stringify(name)};
        var presetPath = ${JSON.stringify(presetPath)};
        var presetFile = new File(presetPath);
        if (!presetFile.exists) {
          return JSON.stringify({
            success: false,
            error: "Sequence preset file not found: " + presetPath,
            sequenceName: sequenceName,
            blockedBeforePremiere: true
          });
        }
        var beforeIds = {};

        if (app.project && app.project.sequences) {
          for (var i = 0; i < app.project.sequences.numSequences; i++) {
            beforeIds[app.project.sequences[i].sequenceID] = true;
          }
        }

        var sequence = null;
        var createError = null;
        try {
          // newSequence(name, presetPath) is Premiere's non-interactive preset API.
          // createNewSequence() treats its second argument differently and can open
          // the native New Sequence dialog on current Premiere releases.
          sequence = app.project.newSequence(sequenceName, presetFile.fsName);
        } catch (createException) {
          createError = createException;
        }

        var created = sequence || null;
        if (!created && app.project && app.project.sequences) {
          for (var j = 0; j < app.project.sequences.numSequences; j++) {
            var candidate = app.project.sequences[j];
            if (!beforeIds[candidate.sequenceID] && candidate.name === sequenceName) {
              created = candidate;
              break;
            }
          }
        }

        // Last-resort name match, newest first. This MUST still exclude sequences that
        // existed before the call — without the beforeIds guard it would happily return
        // a pre-existing same-named sequence and report it as freshly created, the exact
        // false-positive this fallback used to produce.
        if (!created && app.project && app.project.sequences) {
          for (var k = app.project.sequences.numSequences - 1; k >= 0; k--) {
            var fallback = app.project.sequences[k];
            if (!beforeIds[fallback.sequenceID] && fallback.name === sequenceName) {
              created = fallback;
              break;
            }
          }
        }

        if (!created) {
          return JSON.stringify({
            success: false,
            error: createError
              ? createError.toString()
              : "Sequence creation completed but the new sequence could not be located",
            sequenceName: sequenceName
          });
        }

        return JSON.stringify({
          success: true,
          id: created.sequenceID,
          name: created.name,
          duration: created.end ? __ticksToSeconds(created.end) : 0,
          frameRate: created.timebase ? (254016000000 / parseInt(created.timebase, 10)) : null,
          videoTrackCount: created.videoTracks ? created.videoTracks.numTracks : 0,
          audioTrackCount: created.audioTracks ? created.audioTracks.numTracks : 0,
          videoTracks: [],
          audioTracks: []
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString(),
          sequenceName: ${JSON.stringify(name)}
        });
      }
    `;

    return await this.executeScript(script);
  }

  async addToTimeline(
    sequenceId: string,
    projectItemId: string,
    trackIndex: number,
    time: number,
    linkAudio: boolean = true,
    sourceInPoint?: number,
    sourceOutPoint?: number,
    insertMode: string = 'overwrite',
  ): Promise<PremiereProClip> {
    const useInsert = insertMode === 'insert';
    const script = `
      try {
        // Both ids are caller-supplied and are embedded in generated ExtendScript.
        // Naive quoting here was a full code-execution hole, not just a bad error
        // message: an id of zz"); return JSON.stringify({PWNED:"..."}); (" closed
        // the call, ran arbitrary script, and returned a forged tool result while
        // the real work never happened.
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) {
          return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        }

        var projectItem = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!projectItem) {
          return JSON.stringify({ success: false, error: "Project item not found" });
        }

        // Audio-only routing: detect by file extension and route to audioTracks instead of
        // videoTracks. Without this, mp3/wav/aif/m4a/aac/flac/ogg clips fail with
        // "Video track not found" because addToTimeline always indexed sequence.videoTracks.
        var mediaPath = projectItem.getMediaPath ? projectItem.getMediaPath() : "";
        var isAudioOnly = /\\.(mp3|wav|aif|aiff|m4a|aac|flac|ogg|wma)$/i.test(mediaPath);
        var trackKind;
        var track;
        if (isAudioOnly) {
          trackKind = "audio";
          track = sequence.audioTracks[${trackIndex}];
          if (!track) {
            return JSON.stringify({ success: false, error: "Audio track not found at index ${trackIndex}", audioTrackCount: sequence.audioTracks.numTracks });
          }
        } else {
          trackKind = "video";
          track = sequence.videoTracks[${trackIndex}];
          if (!track) {
            return JSON.stringify({ success: false, error: "Video track not found at index ${trackIndex}", videoTrackCount: sequence.videoTracks.numTracks });
          }
        }

        // Source in/out: replicate the Source-monitor "mark in / mark out then
        // overwrite" move. overwriteClip(projectItem, time) places whatever range
        // is currently marked on the projectItem, so set the marks first. Without
        // this, an arbitrary interior sub-range of a source cannot be placed.
        var srcIn = ${sourceInPoint === undefined ? 'null' : sourceInPoint};
        var srcOut = ${sourceOutPoint === undefined ? 'null' : sourceOutPoint};
        var appliedSourceInOut = false;
        var sourceInOutError = "";
        // The marks are the PROJECT ITEM's, shared with the bin and every later placement. They
        // were left set to the requested range, so the item stayed marked (2-4s, say) and the next
        // add_to_timeline / createNewSequenceFromClips silently used that range. Save and restore.
        var priorMarks = null;
        try { priorMarks = { inSecs: projectItem.getInPoint(4).seconds, outSecs: projectItem.getOutPoint(4).seconds }; } catch (ePM) {}
        if (srcIn !== null && srcOut !== null) {
          try {
            // mediaType 4 = all streams (video + audio) in one call
            projectItem.setInPoint(srcIn, 4);
            projectItem.setOutPoint(srcOut, 4);
            appliedSourceInOut = true;
          } catch (eio) {
            try {
              // fall back to per-stream marks (video=1, audio=2)
              projectItem.setInPoint(srcIn, 1);
              projectItem.setOutPoint(srcOut, 1);
              projectItem.setInPoint(srcIn, 2);
              projectItem.setOutPoint(srcOut, 2);
              appliedSourceInOut = true;
            } catch (eio2) {
              try {
                // last resort: no mediaType arg
                projectItem.setInPoint(srcIn);
                projectItem.setOutPoint(srcOut);
                appliedSourceInOut = true;
              } catch (eio3) {
                sourceInOutError = String(eio3);
              }
            }
          }
        }

        // insertMode was accepted by the tool, echoed back in its response, and then
        // dropped: placement was always an overwrite. A caller asking to insert-and-shift
        // therefore had existing footage destroyed and was told the opposite. Both methods
        // exist on video and audio tracks in 26.0.2, so honour the request — and refuse
        // rather than silently overwriting if this build lacks insertClip, since falling
        // back would be the destructive direction.
        // Audio already under the placement, so anything an overwrite replaces can be reported.
        var __placeDur = 0;
        try { __placeDur = (srcIn !== null && srcOut !== null) ? (srcOut - srcIn) : Number(projectItem.getOutPoint(4).seconds) - Number(projectItem.getInPoint(4).seconds); } catch (eDur) {}
        var __audioSnapshotBefore = (${useInsert ? 'false' : 'true'} && __placeDur > 0) ? __audioUnder(sequence, ${time}, ${time} + __placeDur) : null;
        var requestedInsert = ${useInsert ? 'true' : 'false'};
        if (requestedInsert) {
          if (typeof track.insertClip !== "function") {
            return JSON.stringify({
              success: false,
              error: "insertMode 'insert' was requested but this Premiere build exposes no track.insertClip. Refusing rather than overwriting, which would delete existing footage."
            });
          }
          track.insertClip(projectItem, ${time});
        } else {
          track.overwriteClip(projectItem, ${time});
        }
        var marksRestored = null;
        if (appliedSourceInOut && priorMarks) {
          try { projectItem.setInPoint(priorMarks.inSecs, 4); projectItem.setOutPoint(priorMarks.outSecs, 4); marksRestored = Math.abs(projectItem.getInPoint(4).seconds - priorMarks.inSecs) < 0.001 && Math.abs(projectItem.getOutPoint(4).seconds - priorMarks.outSecs) < 0.001; } catch (eRM) { marksRestored = false; }
        }

        var placedClip = null;
        for (var i = 0; i < track.clips.numItems; i++) {
          var candidate = track.clips[i];
          if (candidate && candidate.projectItem && candidate.projectItem.nodeId === projectItem.nodeId && Math.abs(candidate.start.seconds - ${time}) < 0.1) {
            placedClip = candidate;
            break;
          }
        }

        // No fallback to track.clips[numItems - 1]. That guessed at the last clip on the
        // track — which is simply whatever was already there when the placement did not
        // happen — and then reported its name, times and id back as though they were the
        // new clip. Worse, its start time drove the linkAudio=false sweep below, so a
        // placement that did nothing could delete a completely unrelated audio clip.
        // If the clip cannot be identified, nothing downstream may act on a guess.
        if (!placedClip) {
          return JSON.stringify({
            success: false,
            error: "Placement could not be confirmed: no clip from this project item appears at " + ${time} + "s on the target track. Nothing was reported back and no linked audio was removed.",
            trackKind: trackKind,
            requestedTime: ${time}
          });
        }

        // linkAudio=false post-processing: when placing a video-track clip whose source
        // media has an embedded audio stream (e.g. Remotion .mov outputs with silent PCM),
        // Premiere auto-links and places the audio counterpart on the next available
        // audio track via overwriteClip. This can DESTROY existing audio (Sprint 3 v14g
        // bug: silent overlay PCM overwrote founder voice on A1). Pass linkAudio=false
        // to scan audio tracks for the linked counterpart at the same start time and
        // remove it. The video on the target track is untouched.
        var unlinkedAudioRemoved = 0;
        if (!isAudioOnly && ${linkAudio} === false) unlinkedAudioRemoved = __removeLinkedAudio(placedClip);
        var audioReplaced = __audioSnapshotBefore ? __audioReplaced(sequence, __audioSnapshotBefore) : [];

        return JSON.stringify({
          success: true,
          id: placedClip.nodeId,
          name: placedClip.name,
          trackKind: trackKind,
          inPoint: placedClip.start.seconds,
          outPoint: placedClip.end.seconds,
          duration: placedClip.duration.seconds,
          mediaPath: placedClip.projectItem && placedClip.projectItem.getMediaPath ? placedClip.projectItem.getMediaPath() : "",
          insertMode: ${JSON.stringify(useInsert ? 'insert' : 'overwrite')},
          linkAudio: ${linkAudio},
          unlinkedAudioRemoved: unlinkedAudioRemoved,
          audioOverwritten: audioReplaced.length ? audioReplaced : undefined,
          note: audioReplaced.length ? "Overwrite placement replaced existing audio under it (Premiere's overwrite edit lays the item's audio onto the audio tracks); see audioOverwritten. Undo if that was not intended." : undefined,
          appliedSourceInOut: appliedSourceInOut,
          sourceInOutError: sourceInOutError
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.executeScript(script);
  }

  // Batch variant of addToTimeline: place many clips in ONE ExtendScript round-trip.
  // The per-call file/WS round-trip (~seconds each, 60s timeout) is the real bottleneck when
  // placing a whole edit; looping inside one script collapses N round-trips into 1. Mirrors the
  // single-clip logic: audio-only routing by extension, Source-monitor in/out marking (mediaType
  // 4 with per-stream + no-arg fallbacks), overwriteClip. Returns a per-clip result array so a
  // single bad clip never sinks the batch.
  async addToTimelineBatch(
    sequenceId: string,
    clips: Array<{
      projectItemId: string;
      trackIndex: number;
      time?: number;
      linkAudio?: boolean;
      sourceInPoint?: number;
      sourceOutPoint?: number;
    }>,
    mode: 'absolute' | 'append' = 'absolute',
  ): Promise<any> {
    const specs = clips.map((c) => ({
      projectItemId: c.projectItemId,
      trackIndex: c.trackIndex,
      time: typeof c.time === 'number' ? c.time : 0,
      // Mirror the single-call default (true = keep Premiere's native audio linking).
      linkAudio: c.linkAudio === undefined ? true : c.linkAudio,
      sourceInPoint: c.sourceInPoint === undefined ? null : c.sourceInPoint,
      sourceOutPoint: c.sourceOutPoint === undefined ? null : c.sourceOutPoint,
    }));
    const appendMode = mode === 'append';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) {
          return JSON.stringify({ success: false, error: "Sequence not found" });
        }
        var specs = ${JSON.stringify(specs)};
        var appendMode = ${appendMode ? 'true' : 'false'};
        var results = [];
        // Append mode chains clips end-to-end with no gap. Each track keeps a running
        // cursor (in seconds) seeded from its existing content's end, then advanced to the
        // real frame-aligned end of each placed clip, so float-second rounding cannot open
        // a 1-frame gap between consecutive clips.
        var cursors = {};
        function trackEndSeconds(t) {
          var maxEnd = 0;
          for (var ei = 0; ei < t.clips.numItems; ei++) {
            var ec = t.clips[ei];
            if (ec && ec.end && ec.end.seconds > maxEnd) maxEnd = ec.end.seconds;
          }
          return maxEnd;
        }
        for (var c = 0; c < specs.length; c++) {
          var spec = specs[c];
          var r = { index: c, time: spec.time, success: false };
          try {
            var projectItem = __findProjectItem(spec.projectItemId);
            if (!projectItem) { r.error = "Project item not found"; results.push(r); continue; }

            var mediaPath = projectItem.getMediaPath ? projectItem.getMediaPath() : "";
            var isAudioOnly = /\\.(mp3|wav|aif|aiff|m4a|aac|flac|ogg|wma)$/i.test(mediaPath);
            var track = isAudioOnly ? sequence.audioTracks[spec.trackIndex] : sequence.videoTracks[spec.trackIndex];
            if (!track) { r.error = "Track not found at index " + spec.trackIndex; results.push(r); continue; }

            // Resolve the placement time. In append mode, ignore spec.time and use the
            // per-track cursor; seed it from the track's current end on first touch.
            var placeAt = spec.time;
            var cursorKey = (isAudioOnly ? "a" : "v") + spec.trackIndex;
            if (appendMode) {
              if (cursors[cursorKey] === undefined) cursors[cursorKey] = trackEndSeconds(track);
              placeAt = cursors[cursorKey];
            }
            r.time = placeAt;

            // Restore the project item's own marks after placing (see addToTimeline).
            var batchPriorMarks = null;
            try { batchPriorMarks = { inSecs: projectItem.getInPoint(4).seconds, outSecs: projectItem.getOutPoint(4).seconds }; } catch (eBPM) {}
            var batchMarked = spec.sourceInPoint !== null && spec.sourceOutPoint !== null;
            if (spec.sourceInPoint !== null && spec.sourceOutPoint !== null) {
              try {
                projectItem.setInPoint(spec.sourceInPoint, 4);
                projectItem.setOutPoint(spec.sourceOutPoint, 4);
              } catch (eio) {
                try {
                  projectItem.setInPoint(spec.sourceInPoint, 1);
                  projectItem.setOutPoint(spec.sourceOutPoint, 1);
                  projectItem.setInPoint(spec.sourceInPoint, 2);
                  projectItem.setOutPoint(spec.sourceOutPoint, 2);
                } catch (eio2) {
                  try {
                    projectItem.setInPoint(spec.sourceInPoint);
                    projectItem.setOutPoint(spec.sourceOutPoint);
                  } catch (eio3) {}
                }
              }
            }

            track.overwriteClip(projectItem, placeAt);
            if (batchMarked && batchPriorMarks) {
              try { projectItem.setInPoint(batchPriorMarks.inSecs, 4); projectItem.setOutPoint(batchPriorMarks.outSecs, 4); } catch (eBRM) {}
            }

            var placedClip = null;
            for (var i = 0; i < track.clips.numItems; i++) {
              var candidate = track.clips[i];
              if (candidate && candidate.projectItem && candidate.projectItem.nodeId === projectItem.nodeId && Math.abs(candidate.start.seconds - placeAt) < 0.1) {
                placedClip = candidate;
                break;
              }
            }
            // Same reasoning as the single-call path: never fall back to the last clip on
            // the track. An unconfirmed placement here fed both this result row and the
            // linkAudio=false sweep below, so one no-op could report a pre-existing clip
            // as placed and delete an unrelated audio clip alongside it.
            if (!placedClip) {
              r.error = "Placement could not be confirmed: no clip from this project item appears at " + placeAt + "s on the target track. No linked audio was removed.";
              results.push(r);
              continue;
            }

            r.success = true;
            r.id = placedClip.nodeId;
            r.name = placedClip.name;
            r.inPoint = placedClip.start.seconds;
            r.outPoint = placedClip.end.seconds;
            // Advance the append cursor to this clip's real end so the next clip on the
            // same track butts up against it with no gap.
            if (appendMode) cursors[cursorKey] = placedClip.end.seconds;

            // linkAudio=false cleanup — mirror the single-call addToTimeline path so batch
            // rebuild/overlay workflows don't reintroduce the silent embedded-audio overwrite
            // bug. When a video-track clip's source carries an embedded audio stream, Premiere
            // auto-links and overwrites its counterpart onto an audio track, which can DESTROY
            // existing audio. When linkAudio is false, remove that counterpart at the same
            // start time. The video on the target track is untouched.
            r.linkAudio = spec.linkAudio;
            r.unlinkedAudioRemoved = 0;
            // Only the placed clip's own linked audio (see __removeLinkedAudio).
            if (!isAudioOnly && spec.linkAudio === false) r.unlinkedAudioRemoved = __removeLinkedAudio(placedClip);
          } catch (e) {
            r.error = e.toString();
          }
          results.push(r);
        }
        var placed = 0;
        for (var k = 0; k < results.length; k++) { if (results[k].success) placed++; }
        var failed = specs.length - placed;
        // Aggregate status must reflect reality: success is true ONLY when every requested
        // clip placed. placed===0 => failure; some-but-not-all => partial. Per-clip results[]
        // still carry the detail. (PR #48 review: don't report success when placements failed.)
        var allPlaced = (specs.length > 0 && placed === specs.length);
        return JSON.stringify({
          success: allPlaced,
          status: (placed === 0 ? "failure" : (allPlaced ? "success" : "partial")),
          placed: placed,
          failed: failed,
          total: specs.length,
          results: results
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.executeScript(script, 300000);
  }

  async renderSequence(
    sequenceId: string,
    outputPath: string,
    presetPath: string,
    options: { sourceRange?: 'entire' | 'in_out' | 'work_area'; removeOnCompletion?: boolean } = {},
  ): Promise<any> {
    const sourceRange = options.sourceRange ?? 'entire';
    const removeOnCompletion = options.removeOnCompletion ?? true;
    const encoder = await this.findInstalledMediaEncoder();
    if (encoder.available === false) {
      return {
        success: false,
        status: 'failed',
        code: 'MEDIA_ENCODER_NOT_INSTALLED',
        error:
          'Adobe Media Encoder is not installed. The export was not sent to Premiere, so no native Media Encoder warning was shown.',
        searchedPaths: encoder.searchedPaths,
        outputPath,
        presetPath,
        sourceRange,
      };
    }
    const script = `
      try {
        var sequenceId = ${JSON.stringify(sequenceId)};
        var outputPath = ${JSON.stringify(outputPath)};
        var presetPath = ${JSON.stringify(presetPath)};
        var sourceRange = ${JSON.stringify(sourceRange)};
        var removeOnCompletion = ${removeOnCompletion ? 1 : 0};
        var warnings = [];

        function secondsOf(value) {
          if (value === null || typeof value === "undefined") return 0;
          try {
            if (typeof value.ticks !== "undefined") return Number(value.ticks) / 254016000000.0;
            if (typeof value.seconds !== "undefined") {
              var secondsValue = Number(value.seconds);
              return Math.abs(secondsValue) > 1000000 ? secondsValue / 254016000000.0 : secondsValue;
            }
          } catch (_) {}
          var numeric = Number(value);
          if (Math.abs(numeric) > 1000000) return numeric / 254016000000.0;
          return isNaN(numeric) ? 0 : numeric;
        }

        function rangeFailure(code, message, details) {
          var payload = {
            success: false,
            status: "failed",
            code: code,
            error: message,
            sourceRange: sourceRange,
            outputPath: outputPath,
            presetPath: presetPath,
            warnings: warnings
          };
          if (details) {
            for (var key in details) {
              if (details.hasOwnProperty(key)) payload[key] = details[key];
            }
          }
          return JSON.stringify(payload);
        }

        // Premiere 2026 dropped getSequenceByID; iterate via __findSequence helper.
        // Fail hard if the requested sequence isn't found — silently falling back to
        // app.project.activeSequence would queue/render the wrong timeline while still
        // reporting success, masking caller bugs (stale IDs, etc.).
        var sequence = __findSequence(sequenceId);
        if (!sequence) {
          return rangeFailure("SEQUENCE_NOT_FOUND", "Sequence not found by id: " + sequenceId);
        }
        if (typeof app.encoder === "undefined") {
          return rangeFailure("ENCODER_UNAVAILABLE", "app.encoder not available in this Premiere build");
        }

        // Boot AME if not already running so it can pick up the queue
        try { app.encoder.launchEncoder(); }
        catch (e1) {
          warnings.push({ code: "LAUNCH_ENCODER_FAILED", message: e1.toString() });
        }

        var sequenceEnd = secondsOf(sequence.end);
        var sequenceIn = 0;
        var sequenceOut = 0;
        try { sequenceIn = secondsOf(sequence.getInPointAsTime()); } catch (inReadError) {}
        try { sequenceOut = secondsOf(sequence.getOutPointAsTime()); } catch (outReadError) {}
        var inMarked = sequenceIn > 0;
        var outMarked = sequenceOut > 0;
        var range = null;
        var encoderRangeConstant = "";
        var resolvedRange = {
          "in": 0,
          "out": sequenceEnd,
          inMarked: inMarked,
          outMarked: outMarked,
          sequenceEnd: sequenceEnd
        };

        if (sourceRange === "in_out") {
          if (!inMarked && !outMarked) {
            return rangeFailure("IN_OUT_UNSET", "sourceRange in_out requested, but sequence In and Out are both unset.", { resolvedRange: resolvedRange });
          }
          if (!outMarked) {
            return rangeFailure("OUT_POINT_UNSET", "sourceRange in_out requested, but sequence Out is unset.", { resolvedRange: resolvedRange });
          }
          resolvedRange.in = inMarked ? sequenceIn : 0;
          resolvedRange.out = sequenceOut;
          if (resolvedRange.out <= resolvedRange.in) {
            return rangeFailure("INVALID_IN_OUT_RANGE", "sourceRange in_out requires Out to be greater than In.", { resolvedRange: resolvedRange });
          }
          if (sequenceEnd > 0 && resolvedRange.out > sequenceEnd + 0.001) {
            return rangeFailure("OUT_POINT_BEYOND_SEQUENCE_END", "Sequence Out exceeds the physical sequence end.", { resolvedRange: resolvedRange });
          }
          encoderRangeConstant = "ENCODE_IN_TO_OUT";
        } else if (sourceRange === "work_area") {
          var workIn = 0;
          var workOut = 0;
          try { workIn = secondsOf(sequence.getWorkAreaInPointAsTime()); } catch (workInReadError) {}
          try { workOut = secondsOf(sequence.getWorkAreaOutPointAsTime()); } catch (workOutReadError) {}
          resolvedRange = {
            "in": workIn,
            "out": workOut,
            inMarked: workIn > 0,
            outMarked: workOut > 0,
            sequenceEnd: sequenceEnd
          };
          if (workOut <= workIn) {
            return rangeFailure("INVALID_WORK_AREA_RANGE", "sourceRange work_area requires Work Area Out to be greater than Work Area In.", { resolvedRange: resolvedRange });
          }
          if (sequenceEnd > 0 && workOut > sequenceEnd + 0.001) {
            return rangeFailure("WORK_AREA_BEYOND_SEQUENCE_END", "Work Area Out exceeds the physical sequence end.", { resolvedRange: resolvedRange });
          }
          encoderRangeConstant = "ENCODE_WORKAREA";
        } else if (sourceRange === "entire") {
          encoderRangeConstant = "ENCODE_ENTIRE";
        } else {
          return rangeFailure("INVALID_SOURCE_RANGE", "Unsupported sourceRange: " + sourceRange);
        }

        if (typeof app.encoder[encoderRangeConstant] === "undefined") {
          return rangeFailure("ENCODER_RANGE_UNAVAILABLE", "Requested encoder range constant is unavailable: " + encoderRangeConstant, {
            encoderRangeConstant: encoderRangeConstant,
            resolvedRange: resolvedRange
          });
        }
        range = app.encoder[encoderRangeConstant];

        var jobID = app.encoder.encodeSequence(
          sequence,
          outputPath,
          presetPath,
          range,
          removeOnCompletion
        );

        if (!jobID) {
          return JSON.stringify({
            success: false,
            status: "failed",
            error: "encodeSequence returned no jobID — preset path may be invalid or AME not connected",
            outputPath: outputPath,
            presetPath: presetPath,
            sourceRange: sourceRange,
            resolvedRange: resolvedRange,
            encoderRangeConstant: encoderRangeConstant,
            warnings: warnings
          });
        }

        // Trigger AME to actually start processing the queued job
        var queueStarted = false;
        try {
          var startBatchResult = app.encoder.startBatch();
          queueStarted = startBatchResult !== false;
        } catch (e2) {
          warnings.push({ code: "START_BATCH_FAILED", message: e2.toString() });
        }

        return JSON.stringify({
          success: true,
          status: "queued",
          queued: true,
          queueStarted: queueStarted,
          jobID: String(jobID),
          outputPath: outputPath,
          presetPath: presetPath,
          sourceRange: sourceRange,
          resolvedRange: resolvedRange,
          encoderRangeConstant: encoderRangeConstant,
          removeOnCompletion: !!removeOnCompletion,
          warnings: warnings
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "encodeSequence threw: " + e.toString() });
      }
    `;

    const raw = await this.executeScript(script);
    // CEP returns the JSON.stringify'd object; bridge.executeScript returns parsed.result if present.
    // Some CEP plugins wrap as string; handle both.
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return { success: false, error: 'Bridge returned unparseable string: ' + raw };
      }
    }
    return raw;
  }

  /**
   * Avoid calling app.encoder.launchEncoder() when AME is absent: Premiere shows
   * a blocking native warning in that case. An unreadable install directory is
   * treated as unknown, so a transient filesystem error does not disable export.
   */
  private async findInstalledMediaEncoder(): Promise<{
    available: boolean;
    searchedPaths: string[];
  }> {
    if (process.platform === 'darwin') {
      const applications = '/Applications';
      try {
        const entries = await fs.readdir(applications);
        const found = entries.some((entry) => /^Adobe Media Encoder(?: \d+)?\.app$/i.test(entry));
        return { available: found, searchedPaths: [applications] };
      } catch {
        return { available: true, searchedPaths: [applications] };
      }
    }

    if (process.platform === 'win32') {
      const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
        (value): value is string => Boolean(value),
      );
      const searchedPaths = roots.map((root) => join(root, 'Adobe'));
      if (searchedPaths.length === 0) return { available: true, searchedPaths };
      try {
        for (const directory of searchedPaths) {
          const entries = await fs.readdir(directory);
          if (entries.some((entry) => /^Adobe Media Encoder(?: \d+)?$/i.test(entry))) {
            return { available: true, searchedPaths };
          }
        }
        return { available: false, searchedPaths };
      } catch {
        return { available: true, searchedPaths };
      }
    }

    return { available: true, searchedPaths: [] };
  }

  async listProjectItems(): Promise<PremiereProProjectItem[]> {
    const script = `
      try {
        if (!app.project || !app.project.rootItem) {
          throw new Error('No open project');
        }
        function walk(item) {
          var results = [];
          if (item.type === ProjectItemType.BIN) {
            for (var i = 0; i < item.children.numItems; i++) {
              results = results.concat(walk(item.children[i]));
            }
          } else {
            results.push({
              id: item.nodeId || item.treePath || item.name,
              name: item.name,
              type: item.type === ProjectItemType.BIN ? 'bin' : (item.type === ProjectItemType.SEQUENCE ? 'sequence' : 'footage'),
              mediaPath: item.getMediaPath ? item.getMediaPath() : undefined,
              duration: item.getOutPoint ? (item.getOutPoint() - item.getInPoint()) : undefined,
              frameRate: item.getVideoFrameRate ? item.getVideoFrameRate() : undefined
            });
          }
          return results;
        }
        var items = walk(app.project.rootItem);
        return JSON.stringify({ ok: true, items: items });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e) });
      }
    `;
    const result = await this.executeScript(script);
    if (result.ok) return result.items;
    throw new Error(result.error || 'Unknown error listing project items');
  }

  async cleanup(): Promise<void> {
    if (this.uxpProcess) {
      this.uxpProcess.kill();
    }

    // Before the directory goes, so the endpoint file is retired and anything still in flight is
    // answered with the truth rather than left hanging on a listener that no longer exists.
    if (this.socket) {
      try {
        await this.socket.stop();
      } catch (error) {
        this.logger.warn('Failed to stop the WebSocket transport:', error);
      }
      this.socket = null;
    }

    // Retire our token BEFORE the directory decision below, because that decision leaves an
    // externally-configured directory standing — which is how a dead server's token used to stay
    // in place and reject a live one. This is symmetric with the socket transport retiring
    // bridge-endpoint.json above; the asymmetry was the bug.
    await this.retireAuthToken();

    // Retire the peer beacon for the same reason the token and endpoint files are retired: a
    // leftover beacon makes the next client spare files nobody owns, which reintroduces exactly
    // the stale-command execution this sweep exists to prevent.
    if (this.clientBeacon) {
      clearInterval(this.clientBeacon);
      this.clientBeacon = null;
    }
    await fs.unlink(join(this.tempDir, `${CLIENT_FILE_PREFIX}${process.pid}.json`)).catch(() => {});

    // Only remove temp dirs created by this server. The shared bridge directory is
    // configured externally and should persist across restarts.
    try {
      if (!this.usesExternalTempDir) {
        await fs.rm(this.tempDir, { recursive: true });
      }
    } catch (error) {
      this.logger.warn('Failed to clean up temp directory:', error);
    }

    this.logger.info('Adobe Premiere Pro bridge cleaned up');
  }
}
