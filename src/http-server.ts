/**
 * Remote HTTP transport for the Premiere MCP server.
 *
 * WHAT THIS IS
 * ------------
 * A second transport over the SAME catalogue the stdio server serves. Protocol work is
 * done by the SDK: `createMcpHandler` from `@modelcontextprotocol/server` builds one MCP
 * `Server` per HTTP request (from `buildPremiereMcpServer`, the shared factory), serves
 * the 2026-07-28 revision, and falls back to stateless 2025-era serving. Auth and
 * DNS-rebinding protection are the SDK's own helpers — `requireBearerAuth`,
 * `hostHeaderValidationResponse`, `originValidationResponse`. What is written here is only
 * what the SDK deliberately leaves to the host: the localhost default, the token policy,
 * the limits, the bridge refusal, and the Node socket adapter.
 *
 * WHAT IT PROTECTS AGAINST, AND WHAT IT DOES NOT
 * ----------------------------------------------
 * Protects against: reachability from off-machine (binds 127.0.0.1 unless an explicit flag
 * says otherwise), unauthenticated callers (bearer token required unless an explicit flag
 * says otherwise), DNS rebinding and browser cross-origin requests (Host/Origin
 * allowlists), oversized bodies (413), request floods and pile-ups behind a busy Premiere
 * (429/503).
 *
 * Does NOT protect against: what the caller can then do. A holder of the token can run
 * `execute_extendscript` and therefore ARBITRARY ExtendScript against whatever project is
 * open in the operator's Premiere — save over it, delete sequences, export anywhere the
 * user can write. Nor does it protect against another process running as the same user:
 * the token is readable by anything with the operator's uid, exactly like the bridge's own
 * token file. This transport is not a sandbox and this file makes no claim to be one.
 *
 * Every log line goes to stderr. stdout stays untouched, because the stdio server's
 * JSON-RPC framing lives there and both transports may run at once.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createMcpHandler,
  requireBearerAuth,
  hostHeaderValidationResponse,
  originValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { PremiereProTools } from './tools/index.js';
import { PremiereProResources } from './resources/index.js';
import { PremiereProPrompts } from './prompts/index.js';
import { PremiereProBridge } from './bridge/index.js';
import { resolveProfile, type ProfileEnv } from './tools/profiles.js';
import {
  buildPremiereMcpServer,
  BRIDGE_BACKED_METHODS,
  type PremiereMcpSurface,
} from './server-factory.js';
import { Logger } from './utils/logger.js';
import { PACKAGE_VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_HTTP_PORT = 3941;
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_PER_MINUTE = 120;
export const HTTP_MCP_PATH = '/mcp';
export const HTTP_HEALTH_PATH = '/health';

/**
 * Mirrors HEARTBEAT_STALE_MS in bridge/index.ts (the panel beats every 250 ms, so 4 s of
 * silence means it is gone, not slow). The bridge does not export its constant; if that
 * one changes and this one does not, /health will disagree with the bridge about
 * liveness. Asked for as an export in docs/HTTP-TRANSPORT.md.
 */
export const HEARTBEAT_STALE_MS = 4000;
const HEARTBEAT_FILE = 'bridge-heartbeat.json';

export interface HttpTransportConfig {
  host: string;
  port: number;
  /** The bearer token callers must present. Null ONLY when authDisabled is true. */
  token: string | null;
  authDisabled: boolean;
  /** True when the token was generated at startup rather than supplied by the operator. */
  tokenGenerated: boolean;
  maxBodyBytes: number;
  maxConcurrent: number;
  maxPerMinute: number;
  /** Hostnames accepted in the Host header. */
  allowedHosts: string[];
  /** Hostnames accepted in the Origin header. */
  allowedOrigins: string[];
  /** Refuse bridge-backed methods with 503 when the bridge is not observably up. */
  refuseWhenBridgeDown: boolean;
}

export interface HttpConfigResolution {
  config: HttpTransportConfig;
  /** Lines that MUST be printed to stderr at startup. Not advisory — they name real exposure. */
  warnings: string[];
  /** Fatal misconfiguration. When non-empty the server must not start. */
  errors: string[];
}

export interface HttpEnv {
  /** Index signature so `process.env` is assignable without a cast. */
  [key: string]: string | undefined;
  PREMIERE_MCP_HTTP_HOST?: string | undefined;
  PREMIERE_MCP_HTTP_PORT?: string | undefined;
  PREMIERE_MCP_HTTP_TOKEN?: string | undefined;
  PREMIERE_MCP_HTTP_MAX_BODY_BYTES?: string | undefined;
  PREMIERE_MCP_HTTP_MAX_CONCURRENT?: string | undefined;
  PREMIERE_MCP_HTTP_MAX_PER_MINUTE?: string | undefined;
  PREMIERE_MCP_HTTP_ALLOWED_HOSTS?: string | undefined;
  PREMIERE_MCP_HTTP_ALLOWED_ORIGINS?: string | undefined;
  PREMIERE_TEMP_DIR?: string | undefined;
  /** Read only to report the active profile in /health; selection itself stays in profiles.ts. */
  PREMIERE_MCP_PROFILE?: string | undefined;
  PREMIERE_MCP_TOOLS?: string | undefined;
  PREMIERE_MCP_EXCLUDE?: string | undefined;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Narrow an env bag to the three keys profiles.ts reads. Explicit rather than a cast, so
 * /health reports the profile the tools layer will actually apply — the same three keys,
 * resolved by the same function.
 */
function profileEnvFrom(env: HttpEnv): ProfileEnv {
  return {
    ...(env.PREMIERE_MCP_PROFILE === undefined
      ? {}
      : { PREMIERE_MCP_PROFILE: env.PREMIERE_MCP_PROFILE }),
    ...(env.PREMIERE_MCP_TOOLS === undefined ? {} : { PREMIERE_MCP_TOOLS: env.PREMIERE_MCP_TOOLS }),
    ...(env.PREMIERE_MCP_EXCLUDE === undefined
      ? {}
      : { PREMIERE_MCP_EXCLUDE: env.PREMIERE_MCP_EXCLUDE }),
  };
}

/**
 * Ports differ from the other numeric settings in allowing 0, which asks the OS for an
 * ephemeral port. The bound port is reported by `startHttpTransport` and by /health, so a
 * caller can still learn where the server actually landed.
 */
function parsePort(raw: string | undefined, errors: string[]): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HTTP_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    errors.push(
      `--port / PREMIERE_MCP_HTTP_PORT must be 0-65535 (0 = an ephemeral port); got ${JSON.stringify(raw)}.`,
    );
    return DEFAULT_HTTP_PORT;
  }
  return value;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  errors: string[],
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${label} must be a positive integer; got ${JSON.stringify(raw)}.`);
    return fallback;
  }
  return value;
}

/**
 * Resolve the transport's configuration from env and argv.
 *
 * Two decisions are deliberately awkward to make, because both remove a protection:
 *
 *   --host / PREMIERE_MCP_HTTP_HOST other than a loopback address makes this listener
 *   reachable from the network. It is accepted, and it is loudly logged.
 *
 *   --allow-no-auth removes authentication entirely. It is accepted only from the flag —
 *   never from an env var, never as a fallback when a token is missing — so a
 *   no-auth listener cannot happen by accident or by omission.
 */
export function resolveHttpConfig(
  env: HttpEnv = process.env,
  argv: string[] = [],
): HttpConfigResolution {
  const warnings: string[] = [];
  const errors: string[] = [];

  const flag = (name: string): boolean => argv.includes(name);
  const valueOf = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      errors.push(`${name} requires a value.`);
      return undefined;
    }
    return next;
  };

  const host = valueOf('--host') ?? env.PREMIERE_MCP_HTTP_HOST ?? '127.0.0.1';
  const port = parsePort(valueOf('--port') ?? env.PREMIERE_MCP_HTTP_PORT, errors);

  const authDisabled = flag('--allow-no-auth');
  const suppliedToken = (env.PREMIERE_MCP_HTTP_TOKEN ?? '').trim();
  let token: string | null = null;
  let tokenGenerated = false;

  if (authDisabled) {
    if (suppliedToken) {
      warnings.push(
        'PREMIERE_MCP_HTTP_TOKEN is set AND --allow-no-auth was passed. The flag wins: no token is checked.',
      );
    }
    warnings.push(
      'AUTHENTICATION IS OFF (--allow-no-auth). Anything that can reach ' +
        `http://${host}:${port}${HTTP_MCP_PATH} can call every tool in the active profile, ` +
        'including execute_extendscript — that is arbitrary ExtendScript inside whatever ' +
        'project is currently open in Premiere: it can overwrite the project, delete ' +
        'sequences, read and write any file the Premiere process can, and nothing here ' +
        'will ask who is calling. Remove the flag and set PREMIERE_MCP_HTTP_TOKEN.',
    );
  } else if (suppliedToken) {
    if (suppliedToken.length < 16) {
      errors.push(
        `PREMIERE_MCP_HTTP_TOKEN is ${suppliedToken.length} characters. Use at least 16 ` +
          '(this token is the only thing standing between a caller and arbitrary ExtendScript).',
      );
    }
    token = suppliedToken;
  } else {
    token = randomBytes(24).toString('base64url');
    tokenGenerated = true;
  }

  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!loopback.has(host)) {
    warnings.push(
      `BINDING TO ${host} — NOT loopback. This listener is reachable from the network, and a ` +
        'caller holding the token can run arbitrary ExtendScript in the open Premiere project. ' +
        'Bind 127.0.0.1 (the default) unless you have deliberately decided otherwise, and note ' +
        'that traffic is plain HTTP: the token crosses the wire in cleartext unless you put ' +
        'TLS in front of it.',
    );
  }

  const extraHosts = parseList(valueOf('--allow-host') ?? env.PREMIERE_MCP_HTTP_ALLOWED_HOSTS);
  const extraOrigins = parseList(
    valueOf('--allow-origin') ?? env.PREMIERE_MCP_HTTP_ALLOWED_ORIGINS,
  );
  const allowedHosts = [...localhostAllowedHostnames(), ...extraHosts];
  const allowedOrigins = [...localhostAllowedOrigins(), ...extraOrigins];
  if (extraHosts.length) {
    warnings.push(`Host header allowlist widened with: ${extraHosts.join(', ')}.`);
  }
  if (extraOrigins.length) {
    warnings.push(
      `Origin allowlist widened with: ${extraOrigins.join(', ')} — browser pages served from those origins may call this server.`,
    );
  }
  if (!loopback.has(host) && extraHosts.length === 0) {
    warnings.push(
      `Host header validation still allows only ${localhostAllowedHostnames().join(', ')}, so requests ` +
        `addressed to ${host} will be refused with 403 until you pass --allow-host ${host}. ` +
        'That is the DNS-rebinding guard doing its job, not a bug.',
    );
  }

  const config: HttpTransportConfig = {
    host,
    port,
    token,
    authDisabled,
    tokenGenerated,
    maxBodyBytes: parsePositiveInt(
      valueOf('--max-body-bytes') ?? env.PREMIERE_MCP_HTTP_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
      'PREMIERE_MCP_HTTP_MAX_BODY_BYTES',
      errors,
    ),
    maxConcurrent: parsePositiveInt(
      valueOf('--max-concurrent') ?? env.PREMIERE_MCP_HTTP_MAX_CONCURRENT,
      DEFAULT_MAX_CONCURRENT,
      'PREMIERE_MCP_HTTP_MAX_CONCURRENT',
      errors,
    ),
    maxPerMinute: parsePositiveInt(
      valueOf('--max-per-minute') ?? env.PREMIERE_MCP_HTTP_MAX_PER_MINUTE,
      DEFAULT_MAX_PER_MINUTE,
      'PREMIERE_MCP_HTTP_MAX_PER_MINUTE',
      errors,
    ),
    allowedHosts,
    allowedOrigins,
    refuseWhenBridgeDown: !flag('--allow-bridge-down'),
  };

  return { config, warnings, errors };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // timingSafeEqual throws on length mismatch. Compare against self so the work done
    // does not depend on the guess, then fail.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * A one-token verifier in the shape `requireBearerAuth` expects.
 *
 * `expiresAt` is stamped one hour ahead on every successful verification: the SDK rejects
 * an AuthInfo with no expiry, and this token genuinely does not expire — it is valid for
 * as long as the process holds it. Rotating it means restarting with a new
 * PREMIERE_MCP_HTTP_TOKEN. Said here rather than implied, because a caller reading
 * `expiresAt` off the wire would otherwise believe an expiry that is not real.
 */
export function staticTokenVerifier(token: string, scopes: string[] = ['mcp']): OAuthTokenVerifier {
  return {
    async verifyAccessToken(presented: string): Promise<AuthInfo> {
      if (!constantTimeEquals(presented, token)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid bearer token.');
      }
      return {
        token: presented,
        clientId: 'premiere-mcp-http',
        scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge observation
// ---------------------------------------------------------------------------

export type BridgeState =
  /** Panel heartbeat is fresh and reports the bridge started. */
  | 'connected'
  /** Panel heartbeat is fresh but the bridge has not been started in it. */
  | 'not-started'
  /** No heartbeat, or a stale one: the panel is closed, Premiere is closed, or it froze. */
  | 'no-heartbeat'
  /** We cannot see the heartbeat at all, so we do not know either way. */
  | 'unobservable';

export interface BridgeStatus {
  state: BridgeState;
  /** False when no observation was possible; then `state` is 'unobservable'. */
  checked: boolean;
  /** Always populated, and always names the cause rather than restating the state. */
  reason: string;
  heartbeatAgeMs?: number;
  queueLength?: number;
  busy?: boolean;
}

export type BridgeProbe = () => Promise<BridgeStatus>;

/**
 * Observe the bridge by reading the panel's heartbeat file.
 *
 * Passive on purpose: it runs no ExtendScript, so asking /health never touches the
 * operator's open project. The cost is that it can only be done when PREMIERE_TEMP_DIR
 * names the shared directory — otherwise the bridge uses a per-session random path this
 * probe has no way to know, and the honest answer is 'unobservable' rather than a guess.
 */
export function heartbeatBridgeProbe(
  env: HttpEnv = process.env,
  now: () => number = Date.now,
): BridgeProbe {
  return async (): Promise<BridgeStatus> => {
    const dir = env.PREMIERE_TEMP_DIR?.replace(/\/$/, '');
    if (!dir) {
      return {
        state: 'unobservable',
        checked: false,
        reason:
          'PREMIERE_TEMP_DIR is not set, so the bridge is using a per-session temp directory whose ' +
          'path this endpoint cannot know. Set PREMIERE_TEMP_DIR to the same directory as the CEP ' +
          "panel's Temp Directory to make bridge state observable.",
      };
    }

    let raw: string;
    try {
      raw = await readFile(join(dir, HEARTBEAT_FILE), 'utf8');
    } catch (error) {
      return {
        state: 'no-heartbeat',
        checked: true,
        reason:
          `No readable heartbeat at ${join(dir, HEARTBEAT_FILE)} (${error instanceof Error ? error.message : String(error)}). ` +
          'Open Premiere, open Window > Extensions > MCP Bridge (CEP), point it at ' +
          `${dir}, and click Start Bridge.`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        state: 'no-heartbeat',
        checked: true,
        reason:
          'The heartbeat file is not valid JSON — most likely a torn write; retry in a moment.',
      };
    }

    const hb = parsed as {
      ts?: unknown;
      connected?: unknown;
      isProcessing?: unknown;
      queueLength?: unknown;
    };
    if (typeof hb.ts !== 'number') {
      return {
        state: 'no-heartbeat',
        checked: true,
        reason:
          'The heartbeat file has no numeric `ts`, so its age cannot be judged (an older panel build writes this shape).',
      };
    }

    const ageMs = now() - hb.ts;
    const queueLength = typeof hb.queueLength === 'number' ? hb.queueLength : 0;
    const busy = hb.isProcessing === true;

    if (ageMs > HEARTBEAT_STALE_MS) {
      return {
        state: 'no-heartbeat',
        checked: true,
        reason: `The last heartbeat is ${ageMs}ms old (stale past ${HEARTBEAT_STALE_MS}ms). The panel is closed, Premiere is closed, or the panel froze.`,
        heartbeatAgeMs: ageMs,
        queueLength,
        busy,
      };
    }

    if (hb.connected !== true) {
      return {
        state: 'not-started',
        checked: true,
        reason:
          'The panel is open and beating but reports connected=false. Click Start Bridge in the MCP Bridge (CEP) panel.',
        heartbeatAgeMs: ageMs,
        queueLength,
        busy,
      };
    }

    return {
      state: 'connected',
      checked: true,
      reason: `Panel heartbeat is ${ageMs}ms old and reports the bridge started.`,
      heartbeatAgeMs: ageMs,
      queueLength,
      busy,
    };
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface LimiterRejection {
  reason: string;
  retryAfterSeconds: number;
}

/**
 * Concurrency and arrival-rate caps.
 *
 * Both answer 429 rather than queueing. A queue in front of a single-threaded Premiere is
 * the worst of the options: the caller is told the request was accepted, then waits behind
 * work it cannot see, and a modal dialog in Premiere turns that wait into forever. A 429
 * with a reason is a fact the caller can act on.
 */
export class RequestLimiter {
  private inFlight = 0;
  private arrivals: number[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(): { ok: true; release: () => void } | ({ ok: false } & LimiterRejection) {
    const t = this.now();
    this.arrivals = this.arrivals.filter((at) => t - at < 60_000);

    if (this.arrivals.length >= this.maxPerMinute) {
      const oldest = this.arrivals[0] ?? t;
      const retryAfterSeconds = Math.max(1, Math.ceil((60_000 - (t - oldest)) / 1000));
      return {
        ok: false,
        reason: `Rate limit: ${this.maxPerMinute} requests per minute. ${this.arrivals.length} arrived in the last 60s.`,
        retryAfterSeconds,
      };
    }

    if (this.inFlight >= this.maxConcurrent) {
      return {
        ok: false,
        reason: `Concurrency limit: ${this.maxConcurrent} in-flight requests. Premiere executes one script at a time, so requests are refused rather than queued behind it.`,
        retryAfterSeconds: 1,
      };
    }

    this.arrivals.push(t);
    this.inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
      },
    };
  }

  get stats(): { inFlight: number; arrivalsLastMinute: number } {
    const t = this.now();
    return {
      inFlight: this.inFlight,
      arrivalsLastMinute: this.arrivals.filter((at) => t - at < 60_000).length,
    };
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** JSON-RPC-shaped refusal, so an MCP client surfaces the reason instead of a bare status. */
function rpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

export interface HealthReport {
  server: 'up';
  transport: 'http';
  name: string;
  version: string;
  bind: string;
  auth: 'bearer-token' | 'disabled';
  endpoint: string;
  profile: { source: string; name: string | null; exposedTools: number; implementedTools: number };
  catalogue: {
    exposedTools: number;
    implementedTools: number;
    resources: number;
    prompts: number;
    approxTokens?: number;
  };
  limits: {
    maxBodyBytes: number;
    maxConcurrent: number;
    maxPerMinute: number;
    inFlight: number;
    arrivalsLastMinute: number;
  };
  bridge: BridgeStatus;
  /**
   * Deliberately always null. Nothing on this path executes a script in Premiere, so no
   * observation made here can prove Premiere would accept a command. A `connected`
   * bridge means the panel is beating and started — not that the next tool call succeeds.
   */
  premiereReachable: null;
  premiereReachableNote: string;
}

export interface GateDeps {
  config: HttpTransportConfig;
  surface: PremiereMcpSurface;
  handler: Pick<McpHttpHandler, 'fetch'>;
  bridgeProbe: BridgeProbe;
  limiter?: RequestLimiter;
  logger?: Logger;
  version?: string;
  env?: HttpEnv;
  /**
   * Filled in by `startHttpTransport` once the socket is bound, so /health reports the port
   * the server is really on rather than the requested one — which is 0 when the operator
   * asked for an ephemeral port.
   */
  boundPort?: { port: number };
}

export interface HttpGate {
  fetch: (request: Request) => Promise<Response>;
  health: () => Promise<HealthReport>;
  limiter: RequestLimiter;
}

/**
 * The request pipeline, in the order the checks have to happen:
 *
 *   1. Host header      — DNS-rebinding guard (SDK helper). Before anything is parsed.
 *   2. Origin header    — browser cross-origin guard (SDK helper).
 *   3. Bearer token     — SDK helper. Applies to /health too: the report names the active
 *                         profile, the catalogue size and the bridge state, which is
 *                         reconnaissance, not a liveness ping.
 *   4. Body size        — 413 before the body is handed to the protocol layer.
 *   5. Rate/concurrency — 429, never a queue.
 *   6. Bridge state     — 503 for methods that cannot be answered without Premiere.
 *   7. SDK handler      — everything protocol-shaped, including error answers.
 */
export function createHttpGate(deps: GateDeps): HttpGate {
  const { config, surface, handler, bridgeProbe } = deps;
  const logger = deps.logger ?? new Logger('PremiereHttp');
  const limiter = deps.limiter ?? new RequestLimiter(config.maxConcurrent, config.maxPerMinute);
  const version = deps.version ?? PACKAGE_VERSION;
  const authGate =
    config.token !== null
      ? requireBearerAuth({ verifier: staticTokenVerifier(config.token) })
      : null;

  const health = async (): Promise<HealthReport> => {
    const exposed = surface.tools.getAvailableTools();
    const implemented = surface.tools.getRegisteredTools();
    const resolution = resolveProfile(
      implemented.map((tool) => tool.name),
      profileEnvFrom(deps.env ?? process.env),
    );
    let approxTokens: number | undefined;
    try {
      approxTokens = surface.tools.measureCatalogueCost(exposed).approxTokens;
    } catch {
      // A cost estimate must never be the reason a health check fails; omitting the
      // field is honest, a zero would not be.
      approxTokens = undefined;
    }

    return {
      server: 'up',
      transport: 'http',
      name: 'premiere-mcp',
      version,
      bind: `${config.host}:${deps.boundPort?.port ?? config.port}`,
      auth: config.token === null ? 'disabled' : 'bearer-token',
      endpoint: HTTP_MCP_PATH,
      profile: {
        source: resolution.source,
        name: resolution.profileName,
        exposedTools: exposed.length,
        implementedTools: implemented.length,
      },
      catalogue: {
        exposedTools: exposed.length,
        implementedTools: implemented.length,
        resources: surface.resources.getAvailableResources().length,
        prompts: surface.prompts.getAvailablePrompts().length,
        ...(approxTokens === undefined ? {} : { approxTokens }),
      },
      limits: {
        maxBodyBytes: config.maxBodyBytes,
        maxConcurrent: config.maxConcurrent,
        maxPerMinute: config.maxPerMinute,
        ...limiter.stats,
      },
      bridge: await bridgeProbe(),
      premiereReachable: null,
      premiereReachableNote:
        'Not asserted. Bridge state above is read from the panel heartbeat file; no script was run in ' +
        'Premiere, so this endpoint cannot prove a tool call would succeed. Call the `ping` tool for that.',
    };
  };

  const fetchGate = async (request: Request): Promise<Response> => {
    // 1 + 2: SDK DNS-rebinding / cross-origin guards.
    const rejected =
      hostHeaderValidationResponse(request, config.allowedHosts) ??
      originValidationResponse(request, config.allowedOrigins);
    if (rejected) {
      logger.warn(
        `Refused ${request.method} ${new URL(request.url).pathname}: host/origin validation ` +
          `(host=${request.headers.get('host') ?? 'absent'}, origin=${request.headers.get('origin') ?? 'absent'}).`,
      );
      return rejected;
    }

    // 3: auth.
    let authInfo: AuthInfo | undefined;
    if (authGate) {
      const result = await authGate(request);
      if (result instanceof Response) {
        logger.warn(
          `Refused ${request.method} ${new URL(request.url).pathname}: bearer auth (${result.status}).`,
        );
        return result;
      }
      authInfo = result;
    }

    const url = new URL(request.url);

    if (url.pathname === HTTP_HEALTH_PATH) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return rpcError(405, -32000, `${HTTP_HEALTH_PATH} accepts GET.`, { allow: 'GET, HEAD' });
      }
      const report = await health();
      // HEAD carries no body: the report is computed anyway so the status is earned rather
      // than assumed, then discarded.
      return request.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'content-type': 'application/json' } })
        : jsonResponse(200, report);
    }

    if (url.pathname !== HTTP_MCP_PATH && url.pathname !== '/') {
      return rpcError(
        404,
        -32601,
        `No such endpoint: ${url.pathname}. MCP is served at ${HTTP_MCP_PATH}; health at ${HTTP_HEALTH_PATH}.`,
      );
    }

    // 4: body cap. The declared length is checked first so an oversized POST is refused
    // without reading it; the measured length is checked too, because content-length can
    // lie or be absent under chunked encoding.
    let parsedBody: unknown;
    let bodyText = '';
    if (request.method === 'POST') {
      const declared = Number(request.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
        return rpcError(
          413,
          -32000,
          `Request body declares ${declared} bytes; the cap is ${config.maxBodyBytes}. Raise PREMIERE_MCP_HTTP_MAX_BODY_BYTES if this is legitimate.`,
        );
      }
      bodyText = await request.text();
      const measured = Buffer.byteLength(bodyText, 'utf8');
      if (measured > config.maxBodyBytes) {
        return rpcError(
          413,
          -32000,
          `Request body is ${measured} bytes; the cap is ${config.maxBodyBytes}. Raise PREMIERE_MCP_HTTP_MAX_BODY_BYTES if this is legitimate.`,
        );
      }
      if (bodyText.length > 0) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          // Left undefined: the SDK owns the parse-error answer, and classifying a
          // non-JSON body here would duplicate its judgement.
          parsedBody = undefined;
        }
      }
    }

    // 5: limits.
    const slot = limiter.acquire();
    if (!slot.ok) {
      logger.warn(`Refused ${request.method} ${url.pathname}: ${slot.reason}`);
      return rpcError(429, -32000, slot.reason, { 'retry-after': String(slot.retryAfterSeconds) });
    }

    try {
      // 6: bridge state, only for methods that cannot be answered without Premiere.
      if (config.refuseWhenBridgeDown && parsedBody !== undefined) {
        const methods = jsonRpcMethods(parsedBody);
        const needsBridge = methods.some((method) => BRIDGE_BACKED_METHODS.has(method));
        if (needsBridge) {
          const status = await bridgeProbe();
          if (status.state !== 'connected') {
            logger.warn(`Refused ${methods.join(', ')}: bridge ${status.state}. ${status.reason}`);
            return jsonResponse(
              503,
              {
                jsonrpc: '2.0',
                error: {
                  code: -32000,
                  message: `Premiere bridge is not available (${status.state}): ${status.reason}`,
                  data: { bridge: status, refusedMethods: methods },
                },
                id: null,
              },
              { 'retry-after': '5' },
            );
          }
        }
      }

      // 7: the SDK serves the protocol. parsedBody is handed over so the body is read once.
      const options =
        parsedBody === undefined
          ? authInfo === undefined
            ? {}
            : { authInfo }
          : authInfo === undefined
            ? { parsedBody }
            : { authInfo, parsedBody };
      const requestForHandler =
        request.method === 'POST' ? cloneWithBody(request, bodyText) : request;
      return await handler.fetch(requestForHandler, options);
    } finally {
      slot.release();
    }
  };

  return { fetch: fetchGate, health, limiter };
}

/**
 * The body was consumed by the size check, so hand the SDK a request it can still read.
 * The clone carries the same method, URL and headers over the bytes already in hand.
 */
function cloneWithBody(request: Request, bodyText: string): Request {
  if (bodyText.length === 0) {
    return new Request(request.url, { method: request.method, headers: request.headers });
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText,
  });
}

/** Every JSON-RPC method named in a body — one object, or a legacy batch array. */
export function jsonRpcMethods(body: unknown): string[] {
  const methodOf = (value: unknown): string | null => {
    if (typeof value !== 'object' || value === null) return null;
    const method = (value as { method?: unknown }).method;
    return typeof method === 'string' ? method : null;
  };
  if (Array.isArray(body)) {
    return body.map(methodOf).filter((method): method is string => method !== null);
  }
  const single = methodOf(body);
  return single === null ? [] : [single];
}

// ---------------------------------------------------------------------------
// Node socket adapter
// ---------------------------------------------------------------------------

/**
 * node:http <-> web Request/Response.
 *
 * This exists only because `@modelcontextprotocol/node` (which ships `toNodeHandler`,
 * the adapter the SDK documents for Express/Fastify/node:http) is not a dependency of
 * this package. It is a socket adapter, not a protocol implementation: it moves bytes and
 * headers, and every decision about MCP still belongs to the SDK. If that package is
 * added, delete this and call `toNodeHandler(handler)`.
 *
 * The read is capped at maxBodyBytes + 1 so an attempt to send a gigabyte cannot be
 * buffered into memory on the way to its 413.
 */
export async function nodeRequestToWeb(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Request> {
  const host = req.headers.host ?? '127.0.0.1';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return new Request(url, { method: req.method, headers });
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const cap = maxBodyBytes + 1;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total <= cap) {
      chunks.push(buf);
    }
    if (total > cap) {
      // Keep exactly cap bytes: enough for the gate to measure over the limit and answer
      // 413, without holding the rest.
      break;
    }
  }
  const body = Buffer.concat(chunks).subarray(0, cap);
  return new Request(url, {
    method: req.method ?? 'POST',
    headers,
    body: body.length ? body : null,
  });
}

export async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  // SSE streams must reach the client as they are produced, so the body is piped rather
  // than buffered.
  const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await new Promise<void>((resolve) => {
    stream.on('error', () => {
      res.end();
      resolve();
    });
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.on('end', () => resolve());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export interface HttpTransportHandle {
  config: HttpTransportConfig;
  gate: HttpGate;
  server: NodeHttpServer;
  handler: McpHttpHandler;
  address: { host: string; port: number };
  close: () => Promise<void>;
}

export interface StartOptions {
  env?: HttpEnv;
  argv?: string[];
  /** Injected in tests. When omitted, a real bridge is created and initialized. */
  surface?: PremiereMcpSurface;
  bridge?: PremiereProBridge;
  bridgeProbe?: BridgeProbe;
  logger?: Logger;
  version?: string;
}

/**
 * Start the HTTP transport. Resolves once the socket is listening.
 *
 * Startup order is deliberate: configuration errors abort before a socket exists, and the
 * security warnings are printed BEFORE the listener opens, so a `--allow-no-auth` or
 * off-loopback bind cannot scroll past unread while requests are already arriving.
 */
export async function startHttpTransport(options: StartOptions = {}): Promise<HttpTransportHandle> {
  const logger = options.logger ?? new Logger('PremiereHttp');
  const env = options.env ?? process.env;
  const { config, warnings, errors } = resolveHttpConfig(env, options.argv ?? []);

  if (errors.length) {
    throw new Error(`Cannot start the HTTP transport:\n  - ${errors.join('\n  - ')}`);
  }

  for (const warning of warnings) process.stderr.write(`[premiere-mcp-http] WARNING: ${warning}\n`);

  const bridge = options.bridge ?? (options.surface ? undefined : new PremiereProBridge());
  let surface = options.surface;
  if (!surface) {
    const activeBridge = bridge ?? new PremiereProBridge();
    await activeBridge.initialize();
    surface = {
      tools: new PremiereProTools(activeBridge),
      resources: new PremiereProResources(activeBridge),
      prompts: new PremiereProPrompts(),
    };
  }
  const resolvedSurface = surface;

  const handler = createMcpHandler(
    () => buildPremiereMcpServer(resolvedSurface, { logger, wireExposureNotifications: false }),
    {
      onerror: (error) => logger.error('HTTP handler error:', error),
    },
  );

  const boundPort = { port: config.port };
  const gate = createHttpGate({
    config,
    surface: resolvedSurface,
    handler,
    bridgeProbe: options.bridgeProbe ?? heartbeatBridgeProbe(env),
    logger,
    ...(options.version === undefined ? {} : { version: options.version }),
    env,
    boundPort,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const request = await nodeRequestToWeb(req, config.maxBodyBytes);
        const response = await gate.fetch(request);
        await writeWebResponse(response, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Unhandled request failure: ${message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: `Transport failure: ${message}` },
            id: null,
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const address = server.address();
  boundPort.port = typeof address === 'object' && address !== null ? address.port : config.port;

  process.stderr.write(
    `[premiere-mcp-http] listening on http://${config.host}:${boundPort.port}${HTTP_MCP_PATH} ` +
      `(health: ${HTTP_HEALTH_PATH}, auth: ${config.token === null ? 'DISABLED' : 'bearer token required'})\n`,
  );
  if (config.tokenGenerated && config.token) {
    process.stderr.write(
      `[premiere-mcp-http] generated bearer token (this process only; set PREMIERE_MCP_HTTP_TOKEN to pin it):\n` +
        `[premiere-mcp-http]   Authorization: Bearer ${config.token}\n`,
    );
  }

  return {
    config,
    gate,
    server,
    handler,
    address: { host: config.host, port: boundPort.port },
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (bridge) await bridge.cleanup().catch(() => {});
    },
  };
}

/**
 * `--doctor` for the HTTP transport: report what can be established without starting a
 * listener and without touching Premiere. Returns the same honest shape /health serves.
 */
export async function httpDoctor(
  options: StartOptions = {},
): Promise<{ report: HealthReport; warnings: string[]; errors: string[] }> {
  const env = options.env ?? process.env;
  const { config, warnings, errors } = resolveHttpConfig(env, options.argv ?? []);
  const surface: PremiereMcpSurface = options.surface ?? {
    tools: new PremiereProTools(options.bridge ?? new PremiereProBridge()),
    resources: new PremiereProResources(options.bridge ?? new PremiereProBridge()),
    prompts: new PremiereProPrompts(),
  };

  const gate = createHttpGate({
    config,
    surface,
    // Never called by health(); a doctor run makes no protocol request.
    handler: { fetch: async () => rpcError(503, -32000, 'doctor mode serves no MCP traffic') },
    bridgeProbe: options.bridgeProbe ?? heartbeatBridgeProbe(env),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.version === undefined ? {} : { version: options.version }),
    env,
  });

  return { report: await gate.health(), warnings, errors };
}
