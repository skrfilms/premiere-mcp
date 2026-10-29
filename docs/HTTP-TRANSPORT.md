# Remote HTTP transport

The server has always spoken MCP over stdio, which means the client had to be a process on
the same machine, started by that machine. This adds a second transport over the same tool
catalogue, so an agent on another machine — or a browser-based client — can drive the
Premiere running on this one.

Entry point: `src/http-cli.ts` (built to `dist/http-cli.js`). Implementation:
`src/http-server.ts`. Shared MCP surface: `src/server-factory.ts`.

---

## Quick start

```bash
export PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge      # same as the CEP panel's Temp Directory
export PREMIERE_MCP_HTTP_TOKEN="$(openssl rand -base64 24)"
node dist/http-cli.js                                  # http://127.0.0.1:3941/mcp
```

Then, from a client:

```bash
curl -s http://127.0.0.1:3941/health \
  -H "Authorization: Bearer $PREMIERE_MCP_HTTP_TOKEN" | jq
```

If `PREMIERE_MCP_HTTP_TOKEN` is not set, a token is generated and printed to stderr at
startup. It lives only as long as that process.

Endpoints:

| Method | Path      | Purpose                                                   |
| ------ | --------- | --------------------------------------------------------- |
| POST   | `/mcp`    | MCP. 2026-07-28 revision, with stateless 2025-era fallback |
| GET    | `/health` | Honest state report (bearer token required)                |
| GET    | `/mcp`    | `405` — there are no long-lived 2025 sessions to resume    |

`/` is accepted as an alias for `/mcp` so a client configured with a bare origin still
works.

---

## Shape

```
socket ──► nodeRequestToWeb ──► createHttpGate.fetch ──► McpHttpHandler.fetch ──► Server
                                      │                   (SDK)                  (shared
            (adapter, ours)           │                                           factory)
                                      ▼
                     1. Host header       (SDK: hostHeaderValidationResponse)
                     2. Origin header     (SDK: originValidationResponse)
                     3. Bearer token      (SDK: requireBearerAuth)
                     4. Body size cap     → 413
                     5. Rate/concurrency  → 429
                     6. Bridge state      → 503
```

**SDK primitives used**, in preference to anything hand-rolled:

- `createMcpHandler(factory)` — the whole protocol layer: era classification, the
  per-request modern transport, the stateless 2025 fallback, JSON-vs-SSE response shaping,
  and every protocol-level error answer. `PerRequestHTTPServerTransport` and
  `WebStandardStreamableHTTPServerTransport` are what it drives internally; wiring them
  by hand would have meant re-implementing `classifyInboundRequest`, so it is not done here.
- `requireBearerAuth({ verifier })` — parses the header, runs the verifier, and produces the
  `401`/`403` with the `WWW-Authenticate` challenge.
- `hostHeaderValidationResponse` / `originValidationResponse`, seeded with
  `localhostAllowedHostnames()` / `localhostAllowedOrigins()` — DNS-rebinding and browser
  cross-origin protection.
- `OAuthError` / `OAuthErrorCode` — so a bad token produces the SDK's own error mapping
  rather than an invented one.

**Written here** (what the SDK deliberately leaves to the host): the loopback default and
its opt-out, the token policy, the three limits, the bridge refusal, `/health`, and the
`node:http` ↔ web `Request`/`Response` adapter.

### One catalogue, two transports

`src/server-factory.ts` holds the request handlers (`tools/list`, `tools/call`,
`resources/*`, `prompts/*`) and is called by the HTTP transport for every request.
`PremiereProTools`, `PremiereProResources`, `PremiereProPrompts` and the bridge are shared
instances, not copies — a tool called over HTTP runs the same code against the same
Premiere and returns the same result. A test asserts that directly: the same `tools/call`
is issued over HTTP and over a real stdio server on in-memory pipes, and the two `result`
objects are compared with `toEqual`.

### Session hygiene

`createMcpHandler` builds one `Server` per request and holds nothing between them, so there
is no session table to leak or to poison. Consequences worth knowing:

- `GET`/`DELETE /mcp` answer `405`: those are 2025 session operations and this endpoint is
  stateless.
- A response upgrades to SSE only when the handler emits a related message (progress,
  logging) before its result. Otherwise it is a single JSON body.
- `handler.close()` on SIGINT/SIGTERM aborts in-flight exchanges and closes their instances.
- `activate_tools` still works — the tools instance is shared — but no
  `notifications/tools/list_changed` is delivered over HTTP, because there is no stream to
  push it onto after the response is sent. An HTTP client must re-list to see an
  activation. The activation result itself reports the new catalogue cost, so nothing is
  silent.

---

## Security posture

### What it protects against

- **Reachability.** Binds `127.0.0.1` by default. Binding anywhere else requires
  `--host`/`PREMIERE_MCP_HTTP_HOST` and prints a warning naming the exposure and the fact
  that traffic is cleartext HTTP.
- **Unauthenticated callers.** A bearer token is required. There is no env var that turns
  auth off and no fallback to no-auth when a token is missing — a missing token generates
  one instead. Disabling auth takes `--allow-no-auth`, which prints a warning that names
  what an unauthenticated listener exposes (`execute_extendscript`, i.e. arbitrary
  ExtendScript in the open project).
- **DNS rebinding and browser cross-origin requests.** `Host` and `Origin` are validated
  against localhost allowlists before anything else happens, including before auth.
- **Oversized bodies.** `413`, from the declared `content-length` where present and from
  the measured bytes otherwise. The socket adapter stops reading at the cap + 1 byte, so an
  oversized upload cannot be buffered into memory on its way to the refusal.
- **Floods and pile-ups.** `429` past either an in-flight cap or an arrivals-per-minute cap,
  with `Retry-After`. Never a queue: Premiere executes one script at a time, and a queue in
  front of it turns a modal dialog into an unbounded wait the caller cannot see.
- **A wedged or absent bridge.** `503` with the cause, for the methods that cannot be
  answered without Premiere (`tools/call`, `resources/read`).

### What it does not protect against

- **What an authorised caller can then do.** A token holder can call `execute_extendscript`
  and therefore run arbitrary ExtendScript inside whatever project is open in Premiere:
  overwrite it, delete sequences, read and write any file the Premiere process can. The
  token is an authentication boundary, not a sandbox. There is no per-tool authorisation in
  this transport beyond the existing `PREMIERE_MCP_PROFILE` / `PREMIERE_MCP_TOOLS` /
  `PREMIERE_MCP_EXCLUDE` settings, which the stdio transport shares.
- **Another process running as the same user.** The token is in this process's environment
  and printed to its stderr; anything with the operator's uid can read it. Same limitation
  the bridge's own token file has, and stated for the same reason.
- **Network eavesdropping.** Plain HTTP. If this listener leaves the machine, the token
  crosses the wire in cleartext unless you terminate TLS in front of it.
- **Anything the ExtendScript layer itself gets wrong.** This transport changes who can
  reach the tools, not what the tools do.

This document does not claim the transport is secure or production ready. It claims exactly
the five protections listed above, each of which has a test.

---

## Options

| Flag | Env | Default | Notes |
| --- | --- | --- | --- |
| `--host <addr>` | `PREMIERE_MCP_HTTP_HOST` | `127.0.0.1` | Off-loopback is warned about |
| `--port <n>` | `PREMIERE_MCP_HTTP_PORT` | `3941` | `0` asks for an ephemeral port |
| — | `PREMIERE_MCP_HTTP_TOKEN` | generated | Minimum 16 characters |
| `--allow-no-auth` | (none, deliberately) | off | Flag only. Prints what it exposes |
| `--allow-host <names>` | `PREMIERE_MCP_HTTP_ALLOWED_HOSTS` | localhost set | Comma separated |
| `--allow-origin <names>` | `PREMIERE_MCP_HTTP_ALLOWED_ORIGINS` | localhost set | Comma separated |
| `--max-body-bytes <n>` | `PREMIERE_MCP_HTTP_MAX_BODY_BYTES` | 4 MiB | Over it → `413` |
| `--max-concurrent <n>` | `PREMIERE_MCP_HTTP_MAX_CONCURRENT` | 4 | Over it → `429` |
| `--max-per-minute <n>` | `PREMIERE_MCP_HTTP_MAX_PER_MINUTE` | 120 | Over it → `429` |
| `--allow-bridge-down` | — | off | Stop refusing with `503` |
| `--doctor` | — | — | Report and exit |

Note the interaction: binding off loopback does **not** widen the `Host` allowlist. A
request addressed to `--host 10.0.0.5` is still refused `403` until you also pass
`--allow-host 10.0.0.5`. That is the rebinding guard working; the startup warning says so.

The tool profile is unchanged and shared with the stdio server: `PREMIERE_MCP_PROFILE`,
`PREMIERE_MCP_TOOLS`, `PREMIERE_MCP_EXCLUDE`. `/health` reports which one is active.

---

## `/health` and `--doctor`

Both report the same structure, and both refuse to overclaim. The numbers below are
illustrative — the endpoint reports the live values for this build and the active profile:

```json
{
  "server": "up",
  "transport": "http",
  "bind": "127.0.0.1:3941",
  "auth": "bearer-token",
  "profile": { "source": "profile", "name": "core", "exposedTools": 101, "implementedTools": 642 },
  "catalogue": { "exposedTools": 101, "implementedTools": 642, "resources": 13, "prompts": 10, "approxTokens": 11800 },
  "limits": { "maxBodyBytes": 4194304, "maxConcurrent": 4, "maxPerMinute": 120, "inFlight": 0, "arrivalsLastMinute": 3 },
  "bridge": { "state": "connected", "checked": true, "reason": "Panel heartbeat is 180ms old and reports the bridge started.", "heartbeatAgeMs": 180 },
  "premiereReachable": null,
  "premiereReachableNote": "Not asserted. Bridge state above is read from the panel heartbeat file; no script was run in Premiere, so this endpoint cannot prove a tool call would succeed. Call the `ping` tool for that."
}
```

`premiereReachable` is **always** `null`. Nothing on this path executes a script in
Premiere, so nothing on this path can prove Premiere would accept one. `bridge.state` is
one of:

| State | Meaning |
| --- | --- |
| `connected` | The panel heartbeat is fresh (< 4 s) and reports the bridge started |
| `not-started` | The panel is beating but `connected: false` — click Start Bridge |
| `no-heartbeat` | Absent or stale heartbeat: panel closed, Premiere closed, or frozen |
| `unobservable` | `PREMIERE_TEMP_DIR` is unset, so the heartbeat path is unknowable |

`unobservable` is reported with `checked: false`, and is deliberately not collapsed into
"down": not knowing is a different fact from knowing it is broken. Note the consequence —
because refusal is the default, an unset `PREMIERE_TEMP_DIR` means every `tools/call` is
refused with `503`. Set it to the panel's Temp Directory, or pass `--allow-bridge-down` to
attempt calls blind.

`--doctor` exits non-zero when the bridge is anything other than `connected`, or when the
configuration has a fatal error. It starts no listener and makes no protocol request.

---

## Tests

`src/__tests__/http/http-transport.test.ts` — the gate, with synthetic `Request`s: auth
accepted/rejected, host and origin validation (including that it happens before auth), 413
on declared and measured oversized bodies, 429 on both caps plus slot release on a throwing
handler, 503 for `tools/call` and `resources/read` with the cause carried in
`error.data.bridge`, every `heartbeatBridgeProbe` state, `/health` honesty, and the
cross-transport equality test against a real stdio server.

`src/__tests__/http/http-listener.test.ts` — the same refusals over a real socket, because
the `node:http` adapter is hand-written and should not be trusted without one.

Neither suite touches Premiere: the injected bridge stub throws if anything reaches for it,
and the bridge probe is stubbed. Run them with:

```bash
npx jest --runInBand src/__tests__/http/
```

---

## Known gaps and follow-ups

1. **No `@modelcontextprotocol/node` dependency.** That package ships `toNodeHandler`, the
   adapter the SDK documents for `node:http`. Adding it lets `nodeRequestToWeb` /
   `writeWebResponse` be deleted outright. They are a socket adapter, not a parallel
   protocol stack, but they are still ~60 lines the SDK would otherwise own.
2. **`HEARTBEAT_STALE_MS` is duplicated.** `src/bridge/index.ts` has the authoritative 4000
   and does not export it. If that changes and this copy does not, `/health` will disagree
   with the bridge about liveness. Exporting it from the bridge fixes this.
3. **No `tools/list_changed` over HTTP.** Per-request server instances have nowhere to push
   it. Delivering it would need either a long-lived subscription stream or an
   unsubscribe on `PremiereProTools.onExposureChanged`, which currently only appends.
4. **The rate limiter is per-process and in-memory.** Fine for one listener; it is not a
   shared quota.
5. **Bearer tokens do not expire.** `AuthInfo.expiresAt` is stamped an hour ahead on each
   verification because the SDK rejects an AuthInfo without one; the token itself is valid
   for the life of the process. Rotation means a restart.


`wireExposureNotifications: true` preserves today's stdio behaviour exactly (the
`onExposureChanged` → `notifications/tools/list_changed` hook). Everything else in
`server-factory.ts` is that method's current body, moved rather than rewritten, so this
should be behaviour-neutral. `src/index.ts` also has top-level side effects — it constructs
and starts the server on import — so it cannot currently be imported by another entry
point; that is why the factory lives in its own module rather than being exported from
there.
