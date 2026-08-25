# The loopback WebSocket transport

Status: **server half implemented and unit-tested; panel half written and NOT yet run inside
Premiere.** Written 2026-08-25 on `improve/m1-honesty-and-core-bugs`.

Premiere's automation API only exists inside Premiere, so the CEP panel executes commands on the
server's behalf. That channel was a **250 ms file poll**: the server wrote `command-<uuid>.json` into
a shared temp directory and the panel noticed it on its next tick. This adds a **push channel**
alongside it — a WebSocket bound to `127.0.0.1` on an ephemeral port — and keeps file IPC as the
fallback, because file IPC needs no port and triggers no firewall prompt.

Where the field stands (from `docs/INTERNAL-PLAN.md`, Tier 0b / Tier 0 #5): one rival uses an authed
loopback socket with a capability handshake for its **UXP** bridge; another talks WebSocket to its
CEP panel with no handshake. Nobody has a socket on the **CEP** path with a versioned handshake
**and** published latency. That combination is what this is.

## Files

| File | Role |
|---|---|
| `src/bridge/socket-transport.ts` | `BridgeSocketTransport` — the listener, auth, handshake, publication verdicts, latency |
| `src/bridge/index.ts` | Channel selection (`chooseChannel`), `publishCommand`, `publishOverFileIpc`, `getTransportStatus` |
| `cep-plugin/bridge-cep.js` | Panel half: `readBridgeEndpoint`, `maintainSocket`, `connectSocket`, `handleSocketMessage`, `executeSocketCommand`, `pollTick` |
| `src/__tests__/bridge/socket-transport.test.ts` | Server half, against a simulated panel (25 tests) |
| `src/__tests__/bridge/dual-transport.test.ts` | Channel selection and the no-retry rule end to end (10 tests) |
| `src/__tests__/bridge/panel-socket.test.ts` | Panel half, driven through the vm helper (11 tests) |
| `src/__tests__/bridge/socket-panel-sim.ts` | The simulated panel (not a test file; jest does not collect it) |

## Discovery: `bridge-endpoint.json`

Written into the shared temp directory beside `auth-token.json`, mode **0600**, **write-then-rename**
(`.bridge-endpoint.tmp` → `bridge-endpoint.json`). Removed on `stop()`, so a panel never keeps
dialling a port nobody is listening on.

```json
{
  "port": 53091,
  "token": "<the same per-session token as auth-token.json>",
  "protocolVersion": "1.0",
  "pid": 4711,
  "sessionId": "…",
  "startedAt": "2026-08-25T19:54:01.089Z"
}
```

The token is the **existing** per-session token from `writeAuthToken`. A second secret would mean two
things to rotate and a panel that could be authorised on one channel while rejected on the other.

## Wire protocol, version `1.0`

All frames are JSON text. `MAJOR.MINOR`: MAJOR is a compatibility contract (a mismatch is refused);
MINOR is additive and negotiated through `features`, not through the number.

### Panel → server

**`hello`** — the FIRST frame. Carries auth and the capability announcement together, so the server
never holds an unauthenticated connection open waiting for a second frame.

```json
{ "type": "hello", "token": "<hex>", "protocolVersion": "1.0",
  "features": ["extendscript", "cep_js", "heartbeat"],
  "premiereVersion": "26.3.2", "engine": "extendscript" }
```

**`response`** — `payload` is the **same object** the panel writes into `response-<uuid>.json`, and
the server unwraps it by the **same rule** the file reader uses (`payload.result` when present, else
the whole object). That parity is load-bearing: every tool in the catalogue was written against the
file channel's shape, including its failure shape (`{success:false, error}` arrives as a value, not a
throw, and dozens of tools branch on `success`).

```json
{ "type": "response", "id": "<uuid>", "payload": { "success": true, "result": …, "timestamp": "…" } }
```

`{ "type": "response", "id": …, "ok": false, "error": "…" }` is the transport-level failure form,
used when the panel refuses a command outright (bad token, another command outstanding).

**`heartbeat`** — accepted and ignored. The **file** heartbeat remains the source of truth for
liveness, because it is the signal that survives the socket being down, which is exactly when the
question is asked.

### Server → panel

**`welcome`** — sent only after the token and the major version have both been accepted. The panel
treats itself as on the fast path only once this arrives.

```json
{ "type": "welcome", "protocolVersion": "1.0", "sessionId": "…",
  "serverFeatures": ["extendscript", "cep_js", "latency"], "acceptedFeatures": [ … ] }
```

**`command`**

```json
{ "type": "command", "id": "<uuid>", "commandType": "extendscript" | "cep_js",
  "script": "…", "timeoutMs": 60000, "token": "<hex>", "publishedAt": "…" }
```

The token is on **every** command, not just the hello, matching the file channel's contract. The
socket is already authenticated, so this is redundant on a healthy connection — and that is the
point: the panel runs **one** authorisation check for both channels, so auth cannot be tightened on
one and silently left off the other.

**`error`** — sent immediately before a close, because the WebSocket close reason is capped at 123
bytes and the full explanation does not fit.

### Close codes (4000–4999, the private-use range)

| Code | Meaning | Panel behaviour |
|---|---|---|
| 4001 `AUTH_TIMEOUT` | No valid hello inside the auth window (default 5 s) | log, retry after 2 s |
| 4002 `AUTH_FAILED` | Token missing or mismatched | log the temp-directory mismatch **once**, stay on file IPC |
| 4003 `PROTOCOL_MISMATCH` | Major version differs, absent, or unparseable — **fails closed** | log "reinstall the panel", stay on file IPC |
| 4004 `BAD_HANDSHAKE` | First frame was not parseable JSON, or was not a hello | log, retry |
| 4005 `SUPERSEDED` | A second panel handshook; the older connection is retired rather than raced | log |
| 4006 `SHUTDOWN` | Server is stopping | log, retry (a new server publishes a new port) |
| 4007 `NOT_LOOPBACK` | Peer was not on loopback — defence in depth behind the `127.0.0.1` bind | n/a |

Reconnect is scheduled **on close only, never on error** (an error is always followed by a close;
reconnecting on both produces a storm against a listener that is refusing connections).

## Exactly one channel per command

**A command is published to exactly one channel.** Two channels carrying one command means two
`insertClip` calls — not a slow edit, a wrong one.

Server side, `chooseChannel()` returns `socket` or `file`, and `publishCommand()` publishes to that
one. `BridgeSocketTransport.publish()` returns a **verdict**, not a value:

| Verdict | Meaning | Caller may use file IPC? |
|---|---|---|
| `not-published` | Nothing reached the wire (no panel / socket not OPEN / feature not announced / synchronous `send` throw) | **Yes** — the command is still published exactly once |
| `ok` | Sent, and the panel answered | n/a |
| `failed` | Sent, or possibly sent | **No, never** |

Panel side enforces the same rule from the other end: while the socket is handshaken, `pollTick()`
**skips the command-file scan entirely**, so even a stale file cannot be executed alongside a socket
command.

The proof in the suite (`dual-transport.test.ts`): the shared directory is sampled every 2 ms while a
socket command is in flight, and no `command-*` or `.tmp-*` name ever appears. Sampling rather than
checking afterwards matters — the file path unlinks what it wrote, so a final listing alone could not
tell "never written" from "written and cleaned up". The `publications` counters
(`socket` / `file` / `refusedAfterPublish`) are exhaustive, so their sum is a second, independent
proof.

## No silent fallback after a published mutation

If the socket dies after a command was published, the host may have applied all, some or none of it.
Retrying that over file IPC is how one edit becomes two. So the server:

- reports `mayHavePartiallyApplied: true`,
- throws an error naming the command id, saying **"MAY HAVE PARTIALLY APPLIED"** and **"NOT retried
  over file IPC"**, and telling the operator to inspect the project state,
- and does **not** republish anywhere.

`mayHavePartiallyApplied` is false in exactly one case: the panel itself answered with a failure,
which proves the host was reached and reported the outcome.

## Latency

`getTransportStatus().socket.latency` reports **measured** round trips — a monotonic clock on the
server side, publish → response, including the panel's own execution time, because that is what the
caller actually waits for. Fields: `samples`, `lastMs`, `minMs`, `maxMs`, `meanMs`, `p50Ms`, `p95Ms`,
over a rolling window of the last 200 samples, reset when a new panel connects (samples from a socket
that no longer exists describe nothing).

**Before any command has completed, every field is `null`, not `0`.** A zero would read as
"sub-millisecond" rather than "never measured".

Measured against the simulated panel on loopback, a round trip is **single-digit milliseconds** (the
suite asserts `< 250 ms`, i.e. faster than one file-poll tick). **No number here describes real
Premiere yet** — the simulated panel does no `evalScript`, so the honest claim today is about the
transport, not about the host. The end-to-end figure needs the live measurement below.

## Configuration

`PREMIERE_MCP_TRANSPORT`:

- `auto` (default) — socket when a handshaken panel is connected, file IPC otherwise.
- `file` — bind no listener at all. No port, no firewall prompt.
- `socket` — refuse to publish over file IPC, and say so, naming the setting.

Configurable rather than hardcoded because a peer bridge reports Premiere dying on the first inbound
socket command on some Windows builds (`docs/INTERNAL-PLAN.md`, Tier 0 strategic risks). That report is
**asserted, not verified** — which is a reason to leave an escape hatch, not a reason to default away
from the socket.

## Verified vs owed

**Verified by tests** (46 tests across the three suites, against a simulated panel):
endpoint file contents / 0600 / atomic publish / removal on stop; loopback-only reachability;
auth accept, token mismatch, absent token, auth timeout, non-hello first frame; handshake recording,
feature gating, major mismatch failing closed, absent or unparseable version failing closed;
socket-vs-file channel selection; exactly-one-channel publication; no retry after a published
mutation (disconnect, timeout, and shutdown); late-response rejection; latency measurement and its
null-until-measured contract; both transport pins; the panel's frame routing, dual-channel
authorisation, response envelope, file-scan suppression, heartbeat continuity, and no-WebSocket
degradation.

**Owed, needs a live Premiere** (deliberately not attempted: Premiere 26.3.2 is open with the
owner's project and a live bridge, and starting a second server against the real temp directory would
rewrite `auth-token.json` under the running one):

1. That `cep-plugin/bridge-cep.js` actually dials from inside CEF — the `WebSocket` global, the
   `ws://127.0.0.1:<port>` connection, and the hello — none of which the vm sandbox can reach.
2. Reconnect after a server restart: new session, new port, panel re-reads the endpoint file.
3. A real `evalScript` round trip over the socket, and therefore the **real** end-to-end latency
   number against Premiere — the only version of that number worth publishing.
4. That the file poller resumes correctly when the socket drops mid-session.
5. Windows: whether the reported first-inbound-command crash reproduces. `PREMIERE_MCP_TRANSPORT=file`
   is the escape hatch if it does.
