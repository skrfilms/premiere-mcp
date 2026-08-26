/**
 * The panel's half of the socket transport.
 *
 * `cep-plugin/bridge-cep.js` is not an importable module and normally runs inside Premiere's CEF
 * context, so the helper in `../helpers/panel.ts` evaluates it in a vm and hands back an instance
 * built on the prototype. Its methods are then driven directly, which is the only way to assert what
 * the panel ACTUALLY does rather than re-deriving it by reading the source — a pattern that has
 * silently passed while the panel behaved differently three separate times.
 *
 * WHAT THIS CANNOT REACH. The sandbox has no `WebSocket` global (it is a Node vm, not CEF), so
 * `connectSocket` itself is not exercised here: the dial, the hello, and the reconnect-on-close are
 * verified against a live Premiere and are recorded as owed. Everything that runs AFTER a frame
 * arrives — routing, authorisation, the response envelope, and the file-scan suppression that makes
 * "exactly one channel" true at this end — is covered.
 */

import { loadPanel } from '../helpers/panel.js';

const TOKEN = 'c'.repeat(64);

interface SentFrame {
  type?: string;
  id?: string;
  ok?: boolean;
  error?: string;
  payload?: unknown;
}

/** A panel with a fake socket attached, recording every frame it sends. */
function panelWithSocket(fsOverrides: Record<string, unknown> = {}) {
  const sent: SentFrame[] = [];
  const files: Record<string, string> = {
    '/tmp/bridge/auth-token.json': JSON.stringify({ token: TOKEN }),
    '/tmp/bridge/bridge-endpoint.json': JSON.stringify({
      port: 51234, token: TOKEN, protocolVersion: '1.0', pid: 99, startedAt: 'now',
    }),
  };
  const fs = {
    existsSync: (p: string) => files[p] !== undefined,
    readFileSync: (p: string) => files[p] ?? '',
    writeFileSync: () => {},
    renameSync: () => {},
    // Derived from `files` so the fake filesystem cannot disagree with itself: a test that adds a
    // token file has it appear in a directory listing too, which is how the panel finds the tokens
    // of servers other than the newest.
    readdirSync: (p: string) =>
      Object.keys(files)
        .filter((full) => full.startsWith(`${p}/`))
        .map((full) => full.slice(p.length + 1)),
    ...fsOverrides,
  };
  const { bridge } = loadPanel({ fs });
  bridge.tempDirectory = '/tmp/bridge';
  bridge.getTempDirectory = () => '/tmp/bridge';
  bridge.commandQueue = [];
  bridge.isProcessing = false;
  bridge.isConnected = true;
  bridge.socketReady = false;
  bridge.socket = { send: (text: string) => { sent.push(JSON.parse(text)); } };
  return { bridge, sent, files };
}

describe('reading the endpoint the server published', () => {
  it('returns the port and token from bridge-endpoint.json', () => {
    const { bridge } = panelWithSocket();
    const endpoint = bridge.readBridgeEndpoint();
    expect(endpoint.port).toBe(51234);
    expect(endpoint.token).toBe(TOKEN);
  });

  it('returns null rather than throwing when the file is absent, malformed, or portless', () => {
    // The panel must degrade to the file poll in all three cases. An exception here would run on
    // every 250ms tick.
    const missing = panelWithSocket({ existsSync: () => false });
    expect(missing.bridge.readBridgeEndpoint()).toBeNull();

    const torn = panelWithSocket({ readFileSync: () => '{"port":' });
    expect(torn.bridge.readBridgeEndpoint()).toBeNull();

    const portless = panelWithSocket({ readFileSync: () => '{"token":"x"}' });
    expect(portless.bridge.readBridgeEndpoint()).toBeNull();
  });
});

describe('routing frames from the server', () => {
  it('is only ready once the welcome arrives', () => {
    const { bridge } = panelWithSocket();
    expect(bridge.socketReady).toBe(false);
    // Nothing may be treated as a live push channel before the server has authenticated the
    // connection and accepted the version — that acceptance IS the welcome.
    bridge.handleSocketMessage(JSON.stringify({ type: 'welcome', protocolVersion: '1.0', sessionId: 's' }));
    expect(bridge.socketReady).toBe(true);
  });

  it('ignores an unparseable frame and an unknown type without throwing', () => {
    const { bridge, sent } = panelWithSocket();
    expect(() => bridge.handleSocketMessage('not json')).not.toThrow();
    expect(() => bridge.handleSocketMessage(JSON.stringify({ type: 'nonsense' }))).not.toThrow();
    expect(sent).toEqual([]);
  });

  it('runs a command frame through the same execution path the file poller uses', () => {
    const { bridge, sent } = panelWithSocket();
    const executed: Array<Record<string, unknown>> = [];
    // executeCommand is the shared path: validation, cep_js branch, evalScript, the timeout
    // watchdog. Stubbing it here proves the socket path DELEGATES rather than duplicating it.
    bridge.executeCommand = (command: Record<string, unknown>, done: (result: unknown) => void) => {
      executed.push(command);
      done({ success: true, result: { ok: true }, timestamp: 'now' });
    };

    bridge.handleSocketMessage(JSON.stringify({
      type: 'command', id: 'cmd-1', commandType: 'extendscript', script: 'return 1;',
      timeoutMs: 1234, token: TOKEN,
    }));

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ id: 'cmd-1', type: 'extendscript', script: 'return 1;', timeoutMs: 1234 });

    // The response carries the SAME envelope the file path writes to disk, because the server
    // unwraps both by the same rule and every tool was written against that shape.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'response', id: 'cmd-1' });
    expect(sent[0]?.payload).toEqual({ success: true, result: { ok: true }, timestamp: 'now' });
    // The in-flight guard is released, or the panel would refuse every later command.
    expect(bridge.isProcessing).toBe(false);
    expect(bridge.currentCommandId).toBeNull();
  });

  it('does not raise a failure card for a shutdown or a supersede, but does for a real one', () => {
    // The server closes a socket by sending an error frame and then closing, so an ORDINARY
    // shutdown arrives typed as an error (code 4006, CLOSE_CODES.SHUTDOWN in
    // src/bridge/socket-transport.ts). Routed to level 'error' it reached showFailure and left a
    // persistent red "What stopped" card up every time an MCP server exited normally.
    const cases: Array<[number, boolean]> = [
      [4006, false], // SHUTDOWN — the server exited; the file poll carries on
      [4005, false], // SUPERSEDED — another panel took the socket; this one falls back
      [4002, true],  // AUTH_FAILED — the push channel is misconfigured and needs a human
      [4003, true],  // PROTOCOL_MISMATCH — likewise
      [4007, true],  // NOT_LOOPBACK — likewise
    ];

    for (const [code, expectFailure] of cases) {
      const { bridge } = panelWithSocket();
      const levels: string[] = [];
      bridge.log = (_message: string, level?: string) => { levels.push(level ?? 'info'); };

      bridge.handleSocketMessage(JSON.stringify({ type: 'error', code, message: 'because.' }));

      expect(levels).toHaveLength(1);
      expect(levels[0] === 'error').toBe(expectFailure);
    }
  });

  it('maps a cep_js command onto the panel-context branch', () => {
    const { bridge } = panelWithSocket();
    const executed: Array<Record<string, unknown>> = [];
    bridge.executeCommand = (command: Record<string, unknown>, done: (result: unknown) => void) => {
      executed.push(command);
      done({ success: true, result: null });
    };
    bridge.handleSocketMessage(JSON.stringify({
      type: 'command', id: 'cmd-cep', commandType: 'cep_js', script: 'return 1;', token: TOKEN,
    }));
    expect(executed[0]).toMatchObject({ type: 'cep_js' });
  });
});

describe('authorisation applies to both channels', () => {
  it('refuses a socket command whose token does not match, and answers instead of hanging', () => {
    const { bridge, sent } = panelWithSocket();
    let ran = false;
    bridge.executeCommand = () => { ran = true; };

    bridge.handleSocketMessage(JSON.stringify({
      type: 'command', id: 'cmd-bad', commandType: 'extendscript', script: 'app.project.close();',
      token: 'd'.repeat(64),
    }));

    // Never executed, and the caller is told why rather than waiting out a timeout.
    expect(ran).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ok).toBe(false);
    expect(sent[0]?.error).toContain('token did not match');
  });

  it('refuses a second concurrent command, saying plainly that nothing ran', () => {
    const { bridge, sent } = panelWithSocket();
    bridge.isProcessing = true;
    bridge.currentCommandId = 'cmd-outstanding';
    let ran = false;
    bridge.executeCommand = () => { ran = true; };

    bridge.handleSocketMessage(JSON.stringify({
      type: 'command', id: 'cmd-second', commandType: 'extendscript', script: 'return 1;', token: TOKEN,
    }));

    // An outstanding evalScript cannot be cancelled, and a second command's completion callback
    // would clear the first one's guard. "Nothing was run" is the fact the caller needs, because it
    // is what makes a retry safe.
    expect(ran).toBe(false);
    expect(sent[0]?.ok).toBe(false);
    expect(sent[0]?.error).toContain('Nothing was run');
  });
});

describe('authorising more than one server at a time', () => {
  /*
   * A panel holds ONE socket, to whichever server last published bridge-endpoint.json, while any
   * number of MCP servers can share one PREMIERE_TEMP_DIR and reach the panel over the file poll.
   * auth-token.json is single-valued and last-writer-wins, so authorising against it alone rejected
   * every server except the newest — its commands came back UNAUTHORIZED through no fault of the
   * caller. Each server now also publishes auth-session-<sessionId>.json, which it owns outright,
   * and all live ones are accepted.
   */
  const OTHER = 'e'.repeat(64);

  function withSecondServer() {
    const harness = panelWithSocket();
    harness.files['/tmp/bridge/auth-session-s2.json'] = JSON.stringify({
      token: OTHER, sessionId: 's2', pid: 4242,
    });
    return harness;
  }

  it('accepts the token of a second server, not only the newest', () => {
    const { bridge } = withSecondServer();
    expect(bridge.isCommandAuthorized({ token: TOKEN }).ok).toBe(true);
    expect(bridge.isCommandAuthorized({ token: OTHER }).ok).toBe(true);
    // Still not a free pass — an unrelated token is refused.
    expect(bridge.isCommandAuthorized({ token: 'f'.repeat(64) }).ok).toBe(false);
  });

  it('names how many servers it checked, so a refusal is diagnosable', () => {
    const { bridge } = withSecondServer();
    const refusal = bridge.isCommandAuthorized({ token: 'f'.repeat(64) });
    expect(refusal.reason).toContain('2 servers');
  });

  it('still runs unauthenticated when NO token file exists at all', () => {
    // The backwards-compatible case, and the reason a token is never deleted without checking who
    // owns it: a server too old to publish one must keep working against a current panel.
    const { bridge, files } = panelWithSocket();
    delete files['/tmp/bridge/auth-token.json'];
    const verdict = bridge.isCommandAuthorized({});
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain('unauthenticated');
  });

  it('fails closed when a token file exists but yields no usable token', () => {
    // The opposite of the case above, and the distinction that matters: a file that IS there was
    // published by a server, so enforcement is on. Treating a torn or truncated credential as
    // "no token file" would turn a corrupt write into an open door.
    const { bridge, files } = panelWithSocket();
    files['/tmp/bridge/auth-token.json'] = '{"token":';
    const verdict = bridge.isCommandAuthorized({ token: TOKEN });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('no usable token');
  });

  it('ignores a session file it cannot parse without rejecting the ones it can', () => {
    const { bridge, files } = withSecondServer();
    files['/tmp/bridge/auth-session-torn.json'] = '{"token":';
    expect(bridge.isCommandAuthorized({ token: TOKEN }).ok).toBe(true);
    expect(bridge.isCommandAuthorized({ token: OTHER }).ok).toBe(true);
  });

  it('survives a runtime whose fs has no readdirSync', () => {
    // Read on every command, so a throw here would fire on every 250ms tick. Older CEF builds are
    // the reason this is guarded rather than assumed.
    const { bridge } = panelWithSocket({ readdirSync: undefined });
    expect(() => bridge.isCommandAuthorized({ token: TOKEN })).not.toThrow();
    expect(bridge.isCommandAuthorized({ token: TOKEN }).ok).toBe(true);
  });
});

describe('exactly one channel, enforced at the panel end too', () => {
  it('keeps scanning for command files even while the socket is handshaken', () => {
    // This asserts the OPPOSITE of what it used to, because the old invariant was wrong and it
    // cost a whole debugging session. The panel used to skip the file scan whenever socketReady
    // was true, on the reasoning that "the server publishes over the socket only, so anything in
    // the directory is stale or belongs to a different server."
    //
    // The second half of that sentence is the bug. A panel holds exactly ONE socket — to whichever
    // server last wrote bridge-endpoint.json — while several servers routinely share one
    // PREMIERE_TEMP_DIR. Every server except that one was left with no channel at all: its command
    // files sat unread until it gave up at its 60s timeout, while the panel displayed "Ready".
    //
    // Scanning both cannot double-apply anything, because the DOUBLE-APPLICATION IS PREVENTED AT
    // THE SERVER, not here: a command is published over the socket or to a file, never both. That
    // is asserted in both directions by 'EXACTLY ONE channel per command' in
    // src/__tests__/bridge/dual-transport.test.ts. A file found during a socket session is
    // therefore a DIFFERENT command from a different server, and answering it is the correct thing
    // to do — even if the answer is UNAUTHORIZED, which at least says so immediately.
    const { bridge } = panelWithSocket();
    let scans = 0;
    bridge.watchDirectory = () => { scans += 1; };
    bridge.maintainSocket = () => {};

    bridge.socketReady = true;
    bridge.pollTick();
    expect(scans).toBe(1);

    bridge.socketReady = false;
    bridge.pollTick();
    expect(scans).toBe(2);
  });

  it('scans no directory while a command is already in flight, on either channel', () => {
    // This is the guard that actually prevents a command running twice, and it is the one the
    // removed socketReady check was mistakenly credited with. processCommandFile holds
    // isProcessing for the whole life of the command and only unlinks the file once it has been
    // answered, so a re-scan before then is the one thing that could re-run it.
    const { bridge } = panelWithSocket();
    let scans = 0;
    bridge.watchDirectory = () => { scans += 1; };
    bridge.maintainSocket = () => {};

    bridge.isProcessing = true;
    bridge.socketReady = false;
    bridge.pollTick();
    bridge.socketReady = true;
    bridge.pollTick();
    expect(scans).toBe(0);

    bridge.isProcessing = false;
    bridge.pollTick();
    expect(scans).toBe(1);
  });

  it('keeps writing the file heartbeat whatever the socket is doing', () => {
    // The file heartbeat is the only liveness signal that survives the socket being down, which is
    // exactly when the server needs to know whether the panel is alive.
    const writes: string[] = [];
    const { bridge } = panelWithSocket({ writeFileSync: (p: string) => { writes.push(p); } });
    bridge.watchDirectory = () => {};
    bridge.maintainSocket = () => {};

    bridge.socketReady = true;
    bridge.pollTick();
    bridge.socketReady = false;
    bridge.pollTick();

    expect(writes.filter((p) => p.indexOf('bridge-heartbeat.json') !== -1)).toHaveLength(2);
  });

  it('degrades quietly where the runtime has no WebSocket, saying so once', () => {
    // The vm sandbox has no WebSocket, which stands in for an older CEF. The panel must stay on the
    // file poll rather than throwing on every tick.
    const { bridge } = panelWithSocket();
    const logged: string[] = [];
    bridge.log = (message: string) => { logged.push(message); };
    bridge.socket = null;

    expect(() => bridge.maintainSocket()).not.toThrow();
    expect(() => bridge.maintainSocket()).not.toThrow();
    expect(bridge.socket).toBeNull();
    expect(logged.filter((line) => line.indexOf('No WebSocket in this runtime') !== -1)).toHaveLength(1);
  });
});
