/**
 * Loopback WebSocket transport between this server and the CEP panel.
 *
 * WHY THIS EXISTS
 * ---------------
 * Premiere's automation API only exists INSIDE Premiere, so the panel executes on the server's
 * behalf. Until now that channel was a 250ms file poll: the server wrote `command-<uuid>.json`
 * into a shared temp directory and the panel noticed it on its next tick. That sets a hard latency
 * floor of roughly half a poll interval per call, before Premiere has done any work at all.
 *
 * This module adds a push channel. The server listens on 127.0.0.1 on an ephemeral port, publishes
 * the port and the EXISTING per-session token into `bridge-endpoint.json`, and the panel dials in.
 * File IPC is kept as the fallback because it needs no port and triggers no firewall prompt.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * A command is published to EXACTLY ONE channel. Two channels carrying one command means two
 * `insertClip` calls, which destroys an edit rather than slowing it down. This module therefore
 * never publishes to a file, and it reports back — precisely — whether a command reached the wire:
 *
 *   status 'not-published'  nothing was sent. The caller MAY use file IPC.
 *   status 'ok'             sent, and the panel answered.
 *   status 'failed'         sent (or possibly sent). The caller MUST NOT retry on any channel.
 *
 * The third case is the honesty requirement. If the socket dies after a command was published, the
 * host may have applied all, some, or none of it. Retrying that over file IPC would double-apply a
 * mutation, so the failure is surfaced as "may have partially applied" and stops there.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not run a relay daemon. It is a fair objection that an in-process
 * listener dies with the MCP session, and that a relay is the pattern that survives. This listener
 * is deliberately in-process anyway, because it is bound to the per-session token and the panel
 * re-reads the endpoint file on every reconnect: a server restart moves the port, the panel's
 * socket closes, and the panel dials the new port. The cost is one reconnect per session, not a
 * dropped plugin. A relay remains the right answer for concurrent sessions and is not built here.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';

/**
 * Wire protocol version, `MAJOR.MINOR`.
 *
 * MAJOR is a compatibility contract: a panel announcing a different major is REFUSED, with a
 * message naming both versions. Silent degradation is the failure mode this whole project exists to
 * avoid — a panel that quietly ignored a frame it did not understand would look like a hang, or
 * worse, like a command that never ran when it half ran.
 *
 * MINOR is additive and negotiated by the `features` list, not by the number.
 */
export const BRIDGE_PROTOCOL_VERSION = '1.0';

/** Published beside auth-token.json so the panel can find the port without being configured. */
export const ENDPOINT_FILE = 'bridge-endpoint.json';
const ENDPOINT_STAGING = '.bridge-endpoint.tmp';

/**
 * Application close codes. 4000-4999 is the range the WebSocket spec reserves for private use, so
 * these can never collide with a protocol-level code (1000-1015).
 *
 * Each one is distinct on purpose: "you sent the wrong token" and "you never authenticated" are
 * different operator problems with different fixes, and a single generic 4000 would have made the
 * panel log useless.
 */
export const CLOSE_CODES = {
  /** No valid hello frame arrived inside the auth window. */
  AUTH_TIMEOUT: 4001,
  /** A hello arrived and its token did not match this session's token. */
  AUTH_FAILED: 4002,
  /** Major protocol version mismatch, or an unparseable/absent version. Fails closed. */
  PROTOCOL_MISMATCH: 4003,
  /** The first frame was not parseable JSON, or was not a hello. */
  BAD_HANDSHAKE: 4004,
  /** A second panel handshook; the older connection is retired rather than racing it. */
  SUPERSEDED: 4005,
  /** The server is shutting down. */
  SHUTDOWN: 4006,
  /** The peer was not on the loopback interface. Defence in depth behind the 127.0.0.1 bind. */
  NOT_LOOPBACK: 4007,
} as const;

/** How long a fresh connection has to produce a valid hello before it is closed. */
const DEFAULT_AUTH_TIMEOUT_MS = 5000;

/** Frames larger than this are refused rather than buffered. A script is capped at 500k by the panel. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** What the panel announces about itself. Recorded verbatim, and used to gate behaviour. */
export interface PanelHandshake {
  protocolVersion: string;
  protocolMajor: number;
  features: string[];
  premiereVersion: string | null;
  engine: string | null;
  connectedAt: string;
  remoteAddress: string | null;
}

export type SocketCommandType = 'extendscript' | 'cep_js';

export interface SocketCommand {
  id: string;
  commandType: SocketCommandType;
  script: string;
  /** Passed through so the panel can raise its own execution watchdog to match. */
  timeoutMs?: number | undefined;
  /**
   * True when the command can change the project. It does not change how the command is sent; it
   * changes what is SAID when the socket dies mid-flight, because "may have partially applied"
   * is a warning about a mutation and noise about a read.
   */
  mutating?: boolean | undefined;
}

export type SocketPublishOutcome =
  | {
      /** Nothing reached the wire. The caller is free to publish this command over file IPC. */
      status: 'not-published';
      reason: string;
    }
  | {
      status: 'ok';
      result: unknown;
      /** Measured publish -> response, in milliseconds. Not a claim; a measurement. */
      roundTripMs: number;
    }
  | {
      /**
       * The command was published, or may have been. The caller MUST NOT republish it anywhere.
       * `mayHavePartiallyApplied` is false only when the panel itself answered with an error,
       * which proves the host was reached and reported the outcome.
       */
      status: 'failed';
      error: Error;
      mayHavePartiallyApplied: boolean;
      roundTripMs: number;
    };

export interface LatencyStats {
  /** Completed round trips measured on this socket. */
  samples: number;
  lastMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

interface PendingCommand {
  id: string;
  publishedAt: number;
  mutating: boolean;
  settle: (outcome: SocketPublishOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The most recent samples are kept; an unbounded array on a long session is a slow leak. */
const LATENCY_WINDOW = 200;

function parseMajor(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!match || match[1] === undefined) return null;
  return Number(match[1]);
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  // ::ffff:127.0.0.1 is how a v4 client shows up on a dual-stack socket.
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

export class BridgeSocketTransport {
  private readonly tempDir: string;
  private readonly token: string | null;
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly authTimeoutMs: number;

  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private port: number | null = null;
  private panel: WebSocket | null = null;
  private panelHandshake: PanelHandshake | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private latencySamples: number[] = [];
  private stopped = false;

  constructor(options: {
    tempDir: string;
    token: string | null;
    sessionId: string;
    logger?: Logger;
    authTimeoutMs?: number;
  }) {
    this.tempDir = options.tempDir;
    this.token = options.token;
    this.sessionId = options.sessionId;
    this.logger = options.logger ?? new Logger('BridgeSocket');
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  }

  /**
   * Bind the listener and publish the endpoint file.
   *
   * Returns null rather than throwing when the listener cannot be bound. A machine that refuses a
   * loopback listener (locked-down firewall, exhausted ports) must still get a working bridge over
   * file IPC — refusing to start would trade a latency improvement for a total outage.
   */
  async start(): Promise<{ port: number; endpointFile: string } | null> {
    if (this.wss) {
      return this.port === null
        ? null
        : { port: this.port, endpointFile: join(this.tempDir, ENDPOINT_FILE) };
    }

    let httpServer: HttpServer | null = null;
    let server: WebSocketServer | null = null;
    try {
      // The HTTP server is created explicitly rather than letting ws create one, for one reason:
      // unref(). An idle listener must not be the thing that keeps this process alive — the MCP
      // server is held open by its stdio transport, and a test that forgot to stop the bridge would
      // otherwise hang the whole run instead of failing.
      httpServer = createServer();
      // A stray plain HTTP request (a browser, a port scanner) would otherwise hold an open socket
      // forever waiting for an upgrade that never comes.
      httpServer.on('request', (_request, response) => {
        response.writeHead(426, { 'content-type': 'text/plain' });
        response.end('This port speaks the Premiere MCP bridge WebSocket protocol only.\n');
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer!.once('error', onError);
        // 127.0.0.1 only. Never 0.0.0.0: this channel executes arbitrary ExtendScript inside
        // Premiere, so it must not be reachable from the network under any configuration.
        // Port 0 is ephemeral — a fixed port would make two concurrent MCP sessions fight over it,
        // and the loser would silently have no socket at all.
        httpServer!.listen(0, '127.0.0.1', () => {
          httpServer!.removeListener('error', onError);
          resolve();
        });
      });

      const address = httpServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      if (port === null) {
        httpServer.close();
        this.logger.warn('WebSocket transport bound but reported no port; staying on file IPC');
        return null;
      }
      httpServer.unref();

      server = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_BYTES });
      server.on('connection', (socket, request) => this.onConnection(socket, request.socket.remoteAddress));
      // A listener error after startup must not take the process down; the transport simply stops
      // being available and the caller degrades to file IPC.
      server.on('error', (error) => this.logger.warn(`WebSocket transport error: ${error}`));
      httpServer.on('error', (error) => this.logger.warn(`WebSocket transport error: ${error}`));

      // The endpoint file is written BEFORE the listener is recorded as usable. A port nobody can
      // discover is worse than no port at all: the panel would keep file-polling while this side
      // believed a socket was available.
      await this.writeEndpointFile(port);

      this.wss = server;
      this.httpServer = httpServer;
      this.port = port;
      this.logger.info(`Bridge WebSocket listening on 127.0.0.1:${port} (protocol ${BRIDGE_PROTOCOL_VERSION})`);
      return { port, endpointFile: join(this.tempDir, ENDPOINT_FILE) };
    } catch (error) {
      this.logger.warn(`Could not start the WebSocket transport, staying on file IPC: ${error}`);
      // Leave nothing listening. A half-started transport is how a leaked handle happens.
      try { server?.close(); } catch { /* never started */ }
      try { httpServer?.close(); } catch { /* never started */ }
      this.wss = null;
      this.httpServer = null;
      this.port = null;
      return null;
    }
  }

  /**
   * Publish the port and the session token, 0600, write-then-rename.
   *
   * Write-then-rename for the same reason the command files use it: the panel polls for this exact
   * filename, and a plain write publishes the name before the content is whole. A panel that read a
   * truncated endpoint file would fail to parse it and — because reconnect is scheduled on close,
   * not on parse failure — would sit there not dialling.
   *
   * The token is the EXISTING per-session token from auth-token.json. Minting a second secret would
   * mean two things to rotate, two things to leak, and a panel that could be authorised on one
   * channel while rejected on the other.
   */
  private async writeEndpointFile(port: number): Promise<void> {
    const payload = JSON.stringify({
      port,
      token: this.token,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      pid: process.pid,
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
    });
    const staging = join(this.tempDir, ENDPOINT_STAGING);
    const target = join(this.tempDir, ENDPOINT_FILE);
    await fs.writeFile(staging, payload, { mode: 0o600 });
    // writeFile's mode is only applied when it CREATES the file; a leftover staging file from a
    // crashed session would keep its old mode. Assert it either way.
    await fs.chmod(staging, 0o600);
    await fs.rename(staging, target);
  }

  private onConnection(socket: WebSocket, remoteAddress: string | undefined): void {
    if (!isLoopback(remoteAddress)) {
      // Unreachable while the bind above holds, and kept anyway: the bind is one line away from
      // being edited, and the consequence of that edit is remote ExtendScript execution.
      this.logger.error(`Refusing non-loopback bridge connection from ${remoteAddress}`);
      this.closeWith(socket, CLOSE_CODES.NOT_LOOPBACK, 'Bridge accepts loopback connections only.');
      return;
    }

    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (authenticated) return;
      this.closeWith(
        socket,
        CLOSE_CODES.AUTH_TIMEOUT,
        `No hello frame within ${this.authTimeoutMs}ms.`,
      );
    }, this.authTimeoutMs);
    // An auth timer must never hold the process open.
    if (typeof authTimer.unref === 'function') authTimer.unref();

    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : String(data);
      if (!authenticated) {
        const verdict = this.handleHello(socket, text, remoteAddress ?? null);
        if (!verdict) return; // handleHello has already closed the socket with a reason.
        authenticated = true;
        clearTimeout(authTimer);
        return;
      }
      this.handleFrame(text);
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (this.panel === socket) {
        this.panel = null;
        this.panelHandshake = null;
        this.failPendingOnDisconnect('the bridge socket closed');
      }
    });

    // Reconnect is the PANEL's job, and only on close — never on error, which would produce a
    // reconnect storm against a listener that is refusing connections. Here an error is logged and
    // nothing else; the close that follows does the cleanup.
    socket.on('error', (error) => this.logger.warn(`Bridge socket error: ${error}`));
  }

  /** Validates the first frame. Returns true when the connection is now the live panel. */
  private handleHello(socket: WebSocket, text: string, remoteAddress: string | null): boolean {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      frame = parsed as Record<string, unknown>;
    } catch (error) {
      this.closeWith(socket, CLOSE_CODES.BAD_HANDSHAKE, `First frame was not JSON: ${error}`);
      return false;
    }

    if (frame['type'] !== 'hello') {
      this.closeWith(
        socket,
        CLOSE_CODES.BAD_HANDSHAKE,
        `First frame must be type "hello", got ${JSON.stringify(frame['type'])}.`,
      );
      return false;
    }

    // TOKEN BEFORE VERSION, deliberately. Answering a version question for an unauthenticated peer
    // tells it what to say next; a caller with the token gets the useful diagnosis instead.
    if (this.token !== null) {
      const supplied = typeof frame['token'] === 'string' ? frame['token'] : '';
      if (!this.tokensMatch(supplied)) {
        this.closeWith(
          socket,
          CLOSE_CODES.AUTH_FAILED,
          supplied
            ? 'Bridge token did not match this session. Re-read auth-token.json from the shared temp directory.'
            : 'Bridge hello carried no token. The panel must echo the token from auth-token.json.',
        );
        return false;
      }
    }

    const announced = frame['protocolVersion'];
    const panelMajor = parseMajor(announced);
    const serverMajor = parseMajor(BRIDGE_PROTOCOL_VERSION);
    if (panelMajor === null || panelMajor !== serverMajor) {
      // FAIL CLOSED. A panel one major behind may not understand a command frame at all, and the
      // failure would look like a hang — or like a command that never ran when it half ran.
      this.closeWith(
        socket,
        CLOSE_CODES.PROTOCOL_MISMATCH,
        `Bridge protocol mismatch: this server speaks ${BRIDGE_PROTOCOL_VERSION}, the panel announced ` +
          `${typeof announced === 'string' ? announced : JSON.stringify(announced)}. ` +
          'Reinstall the CEP panel so both halves ship from the same build. Refusing the connection ' +
          'rather than degrading silently.',
      );
      return false;
    }

    const featuresRaw = frame['features'];
    const features = Array.isArray(featuresRaw)
      ? featuresRaw.filter((value): value is string => typeof value === 'string')
      : [];

    const handshake: PanelHandshake = {
      protocolVersion: String(announced),
      protocolMajor: panelMajor,
      features,
      premiereVersion: typeof frame['premiereVersion'] === 'string' ? frame['premiereVersion'] : null,
      engine: typeof frame['engine'] === 'string' ? frame['engine'] : null,
      connectedAt: new Date().toISOString(),
      remoteAddress,
    };

    // One live panel. A second handshake retires the first rather than racing it: two panels
    // answering the same pending id would resolve one command twice.
    if (this.panel && this.panel !== socket) {
      const previous = this.panel;
      this.panel = null;
      this.panelHandshake = null;
      this.closeWith(previous, CLOSE_CODES.SUPERSEDED, 'Another bridge panel connected.');
    }

    this.panel = socket;
    this.panelHandshake = handshake;
    // Latency is per-connection; keeping samples from a previous panel would report a number that
    // describes a socket that no longer exists.
    this.latencySamples = [];

    this.send(socket, {
      type: 'welcome',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      serverFeatures: ['extendscript', 'cep_js', 'latency'],
      // Echoed so the panel log can show what the server understood, without a second round trip.
      acceptedFeatures: features,
    });
    this.logger.info(
      `Bridge panel handshook: protocol ${handshake.protocolVersion}, engine ${handshake.engine ?? 'unknown'}, ` +
        `Premiere ${handshake.premiereVersion ?? 'unknown'}, features [${features.join(', ')}]`,
    );
    return true;
  }

  /** Whole-string comparison. This is a local file-permission boundary, not a network one. */
  private tokensMatch(supplied: string): boolean {
    const expected = this.token ?? '';
    if (supplied.length !== expected.length) return false;
    let same = true;
    for (let i = 0; i < expected.length; i++) {
      if (supplied.charAt(i) !== expected.charAt(i)) same = false;
    }
    return same;
  }

  /** Post-handshake frames: responses, and the panel's optional socket heartbeat. */
  private handleFrame(text: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      frame = parsed as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(`Ignoring unparseable bridge frame: ${error}`);
      return;
    }

    const type = frame['type'];
    if (type === 'heartbeat') {
      // The FILE heartbeat remains the source of truth for liveness, because it is what proves the
      // panel is alive when the socket is down — which is exactly when the question is asked.
      return;
    }
    if (type !== 'response') {
      this.logger.warn(`Ignoring bridge frame of unknown type ${JSON.stringify(type)}`);
      return;
    }

    const id = typeof frame['id'] === 'string' ? frame['id'] : null;
    if (id === null) {
      this.logger.warn('Ignoring bridge response with no command id');
      return;
    }
    const entry = this.pending.get(id);
    if (!entry) {
      // A response to a command that already timed out. Recorded, not resolved: the caller has
      // already been told the truth about it and must not now be told it succeeded.
      this.logger.warn(`Late bridge response for command ${id}; the caller has already been answered`);
      return;
    }

    const roundTripMs = performance.now() - entry.publishedAt;
    this.settle(entry, () => {
      this.recordLatency(roundTripMs);
      if (frame['ok'] === false) {
        const message = typeof frame['error'] === 'string' ? frame['error'] : 'Panel reported a failure with no message';
        return {
          status: 'failed' as const,
          error: new Error(message),
          // The panel answered, so the host was reached and reported the outcome. Whatever
          // happened inside Premiere is described by the panel's own error, not by us guessing.
          mayHavePartiallyApplied: false,
          roundTripMs,
        };
      }
      // `payload` is the SAME object the panel writes into response-<uuid>.json, and it is unwrapped
      // by the same rule the file reader uses (`parsed.result` when present, else the whole object).
      // That parity is deliberate and load-bearing: every tool in the catalogue was written against
      // the file channel's shape, including the failure shape — a panel error arrives as
      // `{success:false, error}` rather than a throw, and dozens of tools branch on `success`.
      // Inventing a tidier envelope here would change tool-visible behaviour on the socket path
      // only, which is the kind of difference nobody finds until a live session.
      const payload = frame['payload'];
      if (payload !== null && typeof payload === 'object' && (payload as Record<string, unknown>)['result'] !== undefined) {
        return { status: 'ok' as const, result: (payload as Record<string, unknown>)['result'], roundTripMs };
      }
      return { status: 'ok' as const, result: payload, roundTripMs };
    });
  }

  /** True only once a panel has authenticated AND handshook a compatible major version. */
  isPanelReady(): boolean {
    return this.panel !== null && this.panelHandshake !== null && this.panel.readyState === 1;
  }

  handshake(): PanelHandshake | null {
    return this.panelHandshake;
  }

  /** Behaviour gate: the panel must have ANNOUNCED a feature before it is used. */
  supportsFeature(feature: string): boolean {
    return this.panelHandshake !== null && this.panelHandshake.features.indexOf(feature) !== -1;
  }

  listeningPort(): number | null {
    return this.port;
  }

  /**
   * Send one command and wait for its answer.
   *
   * The return value is a verdict, not a value, because the caller has to know whether the command
   * reached the wire before it decides anything. See SocketPublishOutcome.
   */
  async publish(command: SocketCommand, timeoutMs: number): Promise<SocketPublishOutcome> {
    if (this.stopped) return { status: 'not-published', reason: 'the socket transport is stopped' };
    const socket = this.panel;
    if (socket === null || this.panelHandshake === null) {
      return { status: 'not-published', reason: 'no panel is connected to the socket' };
    }
    if (socket.readyState !== 1) {
      // Not OPEN, so ws will not transmit. Nothing reached the wire and file IPC is still safe.
      return { status: 'not-published', reason: 'the panel socket is not open' };
    }
    if (!this.supportsFeature(command.commandType)) {
      return {
        status: 'not-published',
        reason: `the connected panel did not announce the "${command.commandType}" feature`,
      };
    }
    if (this.pending.has(command.id)) {
      return { status: 'not-published', reason: `command id ${command.id} is already in flight` };
    }

    const frame = JSON.stringify({
      type: 'command',
      id: command.id,
      commandType: command.commandType,
      script: command.script,
      timeoutMs: command.timeoutMs ?? null,
      // On EVERY command, not just the hello, matching the file channel's contract exactly. The
      // socket is already authenticated, so this is redundant on a healthy connection — and that is
      // the point: the panel runs one authorisation check for both channels, so there is no way to
      // fix or weaken auth on one and forget the other.
      token: this.token,
      // Echoed back by the panel in its response for correlation in the panel log. Latency is
      // measured on THIS side, against a monotonic clock, so a clock skew cannot flatter it.
      publishedAt: new Date().toISOString(),
    });

    // Checked BEFORE anything is sent, so an oversized command is declined rather than half-written.
    // ws would otherwise close the connection with 1009 mid-frame, which reads as a dropped panel and
    // would take every other pending command down with it. Declining leaves file IPC — which has no
    // frame cap — free to carry it, and that is still exactly one publication.
    const frameBytes = Buffer.byteLength(frame, 'utf8');
    if (frameBytes > MAX_FRAME_BYTES) {
      return {
        status: 'not-published',
        reason:
          `the command frame is ${frameBytes} bytes, over the ${MAX_FRAME_BYTES}-byte socket limit; ` +
          'nothing was sent over the socket',
      };
    }

    return await new Promise<SocketPublishOutcome>((resolve) => {
      const entry: PendingCommand = {
        id: command.id,
        publishedAt: performance.now(),
        mutating: command.mutating === true,
        settle: resolve,
        timer: null,
      };
      this.pending.set(command.id, entry);

      const timer = setTimeout(() => {
        this.settle(entry, () => ({
          status: 'failed' as const,
          error: new Error(this.describePublishedTimeout(entry, timeoutMs)),
          mayHavePartiallyApplied: true,
          roundTripMs: performance.now() - entry.publishedAt,
        }));
      }, timeoutMs);
      // Deliberately NOT unref'd, unlike the auth timer and the listener. While a command is in
      // flight this timer is the only thing guaranteeing the caller is answered, so it should hold
      // the event loop exactly as long as the caller is waiting.
      entry.timer = timer;

      try {
        socket.send(frame, (error) => {
          if (!error) return;
          // The send callback errored. readyState was OPEN when we checked, so ws may already have
          // flushed some or all of these bytes — there is no way to prove it did not. Pessimism is
          // the only honest choice: report it as published and refuse a retry.
          this.settle(entry, () => ({
            status: 'failed' as const,
            error: new Error(
              `Bridge socket send failed after the frame was queued (${error.message}). The command ` +
                'may or may not have reached Premiere, so it was NOT retried over file IPC — ' +
                'retrying could apply the same edit twice. Check the project state before repeating it.',
            ),
            mayHavePartiallyApplied: true,
            roundTripMs: performance.now() - entry.publishedAt,
          }));
        });
      } catch (error) {
        // A synchronous throw from send() happens before any transmission, so nothing was
        // published and file IPC is still safe. This is the ONLY error path that says so.
        this.settle(entry, () => ({
          status: 'not-published' as const,
          reason: `the socket rejected the frame before sending it (${error})`,
        }));
      }
    });
  }

  private describePublishedTimeout(entry: PendingCommand, timeoutMs: number): string {
    const base =
      `Bridge socket timeout after ${timeoutMs}ms. The command WAS published to the panel over the ` +
      'socket, so it was not retried over file IPC.';
    if (entry.mutating) {
      return (
        base +
        ' This command can change the project, so it MAY HAVE PARTIALLY APPLIED: the panel may have ' +
        'run all, some or none of it before it stopped answering. Inspect the project state before ' +
        'repeating the operation — repeating it blind could apply the same edit twice.'
      );
    }
    return (
      base +
      ' It is a read, so nothing was changed, but its result is unknown. Re-read once the panel is ' +
      'answering again.'
    );
  }

  /** Resolve a pending entry exactly once, clearing its timer. */
  private settle(entry: PendingCommand, build: () => SocketPublishOutcome): void {
    if (!this.pending.has(entry.id)) return;
    this.pending.delete(entry.id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.settle(build());
  }

  /**
   * The socket died with commands in flight.
   *
   * Every one of them was published, so every one of them is reported as possibly-applied and
   * NONE of them is retried. This is the case the honesty requirement is about: silently
   * re-publishing these over file IPC is how one `insertClip` becomes two.
   */
  private failPendingOnDisconnect(reason: string): void {
    const entries = Array.from(this.pending.values());
    for (const entry of entries) {
      this.settle(entry, () => ({
        status: 'failed' as const,
        error: new Error(
          `The bridge socket dropped while command ${entry.id} was in flight (${reason}). It was ` +
            'already published to the panel, so it MAY HAVE PARTIALLY APPLIED — the panel may have ' +
            'run all, some or none of it. It was NOT retried over file IPC, because retrying a ' +
            'published mutation can apply the same edit twice. Inspect the project state before ' +
            'repeating the operation.',
        ),
        mayHavePartiallyApplied: true,
        roundTripMs: performance.now() - entry.publishedAt,
      }));
    }
  }

  private recordLatency(ms: number): void {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > LATENCY_WINDOW) {
      this.latencySamples = this.latencySamples.slice(-LATENCY_WINDOW);
    }
  }

  /**
   * Real measured round trips, publish -> response. Nobody in this field publishes latency, so the
   * only way this number is worth anything is if it is measured rather than asserted: it is taken
   * from a monotonic clock on the sending side and includes the panel's own execution time, because
   * that is what the caller actually waits for.
   */
  latency(): LatencyStats {
    const samples = this.latencySamples.slice().sort((a, b) => a - b);
    if (samples.length === 0) {
      return { samples: 0, lastMs: null, minMs: null, maxMs: null, meanMs: null, p50Ms: null, p95Ms: null };
    }
    const at = (fraction: number): number => {
      const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(fraction * samples.length) - 1));
      return samples[index] as number;
    };
    const total = samples.reduce((sum, value) => sum + value, 0);
    const last = this.latencySamples[this.latencySamples.length - 1];
    return {
      samples: samples.length,
      lastMs: last === undefined ? null : last,
      minMs: samples[0] as number,
      maxMs: samples[samples.length - 1] as number,
      meanMs: total / samples.length,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
    };
  }

  /** Commands published over the socket and not yet answered. */
  inFlight(): number {
    return this.pending.size;
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.warn(`Could not send bridge frame: ${error}`);
    }
  }

  private closeWith(socket: WebSocket, code: number, message: string): void {
    // The reason phrase is capped at 123 bytes by the WebSocket spec, so the full explanation goes
    // in an error frame and the close reason carries a short label. A panel that only logs the
    // close code still gets something actionable from the code itself.
    this.send(socket, { type: 'error', code, message });
    try {
      socket.close(code, message.slice(0, 100));
    } catch {
      try { socket.terminate(); } catch { /* already gone */ }
    }
    this.logger.warn(`Closed bridge socket with code ${code}: ${message}`);
  }

  /** Stop listening, retire the endpoint file, and answer anything still in flight honestly. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.failPendingOnDisconnect('the server shut the transport down');
    const panel = this.panel;
    this.panel = null;
    this.panelHandshake = null;
    if (panel) {
      this.closeWith(panel, CLOSE_CODES.SHUTDOWN, 'The MCP server is shutting down.');
    }
    const server = this.wss;
    const httpServer = this.httpServer;
    this.wss = null;
    this.httpServer = null;
    this.port = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    // Remove the endpoint file so a panel does not keep dialling a port nobody is listening on.
    await fs.unlink(join(this.tempDir, ENDPOINT_FILE)).catch(() => {});
    await fs.unlink(join(this.tempDir, ENDPOINT_STAGING)).catch(() => {});
  }

  /** A fresh command id, used when the caller has not minted one. */
  static newCommandId(): string {
    return randomUUID();
  }
}
