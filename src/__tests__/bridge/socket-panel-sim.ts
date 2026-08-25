/**
 * A simulated CEP panel on the other end of the loopback socket.
 *
 * WHY A SIMULATION AND NOT THE REAL PANEL. The real panel only exists inside Premiere: it needs
 * CSInterface, a CEF runtime with `--enable-nodejs`, and a live host to evalScript into. Premiere is
 * also OPEN on this machine with the owner's working project and a live bridge, so a test that
 * dialled the real temp directory would fight the running server for its token. Every test using
 * this helper therefore builds its own temp directory and speaks the wire protocol directly.
 *
 * WHAT THAT DOES AND DOES NOT PROVE. It proves the SERVER half completely: the endpoint file, auth,
 * the version handshake, channel selection, latency measurement, and the refusal to retry a
 * published command. It proves nothing about whether `cep-plugin/bridge-cep.js` dials correctly
 * inside CEF, or whether CEF's WebSocket behaves as assumed. That half needs a live Premiere and is
 * recorded as owed rather than implied.
 *
 * This file is deliberately not named *.test.ts, so jest's testMatch does not collect it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';

export const PANEL_FEATURES = ['extendscript', 'cep_js', 'heartbeat'];

export interface SimCommand {
  id: string;
  commandType: string;
  script: string;
  timeoutMs: number | null;
  token: string | null;
  receivedAt: number;
}

export interface SimPanelOptions {
  /** Overrides the token read from auth-token.json — used to test rejection. */
  token?: string | null;
  /**
   * Overrides the announced protocol version — used to test the version gate. `null` omits the
   * field entirely, which is how an ancient panel would present itself.
   */
  protocolVersion?: string | null;
  /** Overrides the announced feature list — used to test feature gating. */
  features?: string[];
  /** Suppress the hello entirely, to exercise the auth timeout. */
  sendHello?: boolean;
  /**
   * What to answer a command with. Return null to answer nothing at all (the "panel went quiet"
   * case). The default answers with the same envelope shape the real panel writes to disk.
   */
  respond?: (command: SimCommand) => Record<string, unknown> | null;
}

export interface SimPanel {
  socket: WebSocket;
  /** Resolves once the server has sent its welcome frame. */
  ready: Promise<void>;
  /** Resolves with [code, reason] when the socket closes. */
  closed: Promise<[number, string]>;
  commands: SimCommand[];
  /** Resolves when a command with any id has arrived. */
  nextCommand: () => Promise<SimCommand>;
  close: () => void;
}

export function readEndpoint(tempDir: string): {
  port: number;
  token: string;
  protocolVersion: string;
  pid: number;
  startedAt: string;
} {
  return JSON.parse(readFileSync(join(tempDir, 'bridge-endpoint.json'), 'utf8'));
}

export function connectSimPanel(tempDir: string, options: SimPanelOptions = {}): SimPanel {
  const endpoint = readEndpoint(tempDir);
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}`);
  const commands: SimCommand[] = [];
  const waiters: Array<(command: SimCommand) => void> = [];
  let consumed = 0;

  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A refused connection rejects `ready`, and most tests here assert on the CLOSE CODE rather than
  // awaiting readiness. Without this the rejection is unhandled and jest attributes it to whichever
  // test happens to be running — which is how five passing assertions read as five failures.
  ready.catch(() => {});

  let resolveClosed: (value: [number, string]) => void = () => {};
  const closed = new Promise<[number, string]>((resolve) => { resolveClosed = resolve; });

  socket.on('open', () => {
    if (options.sendHello === false) return;
    const hello: Record<string, unknown> = {
      type: 'hello',
      token: options.token === undefined ? endpoint.token : options.token,
      features: options.features ?? PANEL_FEATURES,
      premiereVersion: '26.3.2',
      engine: 'extendscript',
    };
    // null means "announce nothing", so the server's absent-version path can be exercised.
    if (options.protocolVersion !== null) {
      hello['protocolVersion'] = options.protocolVersion ?? endpoint.protocolVersion;
    }
    socket.send(JSON.stringify(hello));
  });

  socket.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    if (frame['type'] === 'welcome') {
      resolveReady();
      return;
    }
    if (frame['type'] === 'command') {
      const command: SimCommand = {
        id: String(frame['id']),
        commandType: String(frame['commandType']),
        script: String(frame['script']),
        timeoutMs: typeof frame['timeoutMs'] === 'number' ? frame['timeoutMs'] : null,
        token: typeof frame['token'] === 'string' ? frame['token'] : null,
        receivedAt: Date.now(),
      };
      commands.push(command);
      while (waiters.length > 0) (waiters.shift() as (c: SimCommand) => void)(command);

      const respond =
        options.respond ??
        ((c: SimCommand) => ({ success: true, result: { echoed: c.id }, timestamp: new Date().toISOString() }));
      const payload = respond(command);
      if (payload === null) return;
      socket.send(JSON.stringify({ type: 'response', id: command.id, payload }));
    }
  });

  socket.on('close', (code, reason) => {
    resolveClosed([code, reason.toString()]);
    // A connection closed before the welcome never becomes ready; surface that as a rejection so a
    // test awaiting readiness fails with the close code instead of timing out.
    rejectReady(new Error(`socket closed with ${code} before welcome`));
  });
  // Without a listener, an ECONNRESET from a server-side close becomes an unhandled 'error' event.
  socket.on('error', () => {});

  return {
    socket,
    ready,
    closed,
    commands,
    nextCommand: () =>
      new Promise<SimCommand>((resolve) => {
        // Cursor-based, so asking after the command already arrived works as well as asking before.
        const pending = commands[consumed];
        if (pending !== undefined) {
          consumed += 1;
          resolve(pending);
          return;
        }
        waiters.push((command) => { consumed += 1; resolve(command); });
      }),
    close: () => {
      try { socket.close(); } catch { /* already gone */ }
    },
  };
}

/** Wait for a condition, polling. Fails the caller's await with a named timeout rather than hanging. */
export async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}
