# Bridge Architecture Comparison

**What this document is:** a survey of how every Premiere Pro MCP server (and the
instructive adjacent Adobe MCPs) actually moves a command from a Node process into
Adobe's scripting engine and gets a result back — the *transport layer*, not the tool
catalogue. It exists to answer one question honestly: **does anyone have a better-designed
bridge than ours, and what should we take?**

**Date of survey:** 2026-08-24.

## Evidence standard

Every claim below is tagged:

- **[CODE]** — the file was cloned and read. Path and, where it matters, the verbatim snippet.
- **[MEASURED]** — observed on this machine against live Premiere Pro 26.3.2.
- **[DOC]** — stated in Adobe's own first-party documentation, quoted.
- **[CLAIM]** — a README/marketing assertion that could **not** be confirmed in source or Adobe docs.
  Treat as unverified.

Where a project's README claims an architecture its source does not contain, that is called
out explicitly. Nothing here is inferred from a feature list.

Clones used for this survey live under `/tmp/bridge-research/` (ephemeral).

---

## 1. The comparison table

### Premiere Pro

| Server | Transport | Push / poll | Host layer | Concurrency | Liveness detection |
|---|---|---|---|---|---|
| **ours** (`skrfilms/premiere-mcp`) | file IPC, `/tmp/premiere-mcp-bridge`, per-UUID `command-*`/`response-*`, atomic tmp+rename **both directions** | **poll both ways** — panel 250 ms, server 150 ms | CEP + ExtendScript (ES3) | **strictly 1 in flight** | **always-on heartbeat beacon** (250 ms) w/ `connected`/`isProcessing`/`currentCommandId`/`startedAt` → 5 distinct diagnoses + fail-fast on crash |
| `hetpatel-11/Adobe_Premiere_Pro_MCP` (our upstream, 488★) | identical file IPC (we inherited it) | poll — panel 250 ms, server 150 ms | CEP + ExtendScript | 1 in flight | **none.** Dead panel, unstarted panel, and modal-wedged panel all produce one identical 60 s timeout string |
| `leancoderkavy/premiere-pro-mcp` (211★, **the real rival**) | **three:** file IPC (`cmd_*.jsx`/`res_*.json`) + **loopback WebSocket for UXP** + Streamable HTTP for remote | file path: **server-side `fs.watch` (push)** + 250 ms fallback; panel 200 ms poll. UXP path: **full push** | **CEP *and* a working native-UXP plugin** | file path: **pipelined**, ownership won by atomic rename-claim. UXP: pipelined by request id | per-command lazy `busy_<id>.json` (starts at 2 s) + socket state on UXP |
| `ayushozha/AdobePremiereProMCP` (86★) | MCP stdio → **gRPC** → Node → **WebSocket** → CEP. gRPC is *between its own services*; it never reaches Premiere | **push** (WS both ways) | CEP + ExtendScript (WS **server** runs inside the panel) | **unbounded parallel** — N tool calls become N concurrent `evalScript` into a single-threaded engine | WS ping 15 s / pong 5 s + reconnect backoff. **No wedge detection** (pong is answered by the CEF thread, so a dead ES engine still looks healthy) |
| `Siddhant704/premiere-pro-mcp` (0★, 1 commit, dead) | WebSocket, **panel is the server** on fixed port 8085, **no auth** | push | CEP + preloaded `.jsx` libs | pipelined | socket close only |
| `npm adobe-premiere-mcp` (mrfentmen) | none — `spawn(premiere, ['-r', script])` per call | n/a | none | n/a | none. **Broken by construction:** Premiere has no `-r` contract and returns nothing on stdout |
| `@iflow-mcp/leancoderkavy-*`, `iflow-mcp-leancoderkavy-*` | — | — | — | — | **rebrand only.** Byte-identical to leancoderkavy; `package.json` is the sole differing file (sha verified) |
| `ppmcp` | — | — | — | — | **does not exist.** No GitHub org, npm 404. The name is a label in a third-party republish's `repository.url` |

### Adjacent Adobe apps (surveyed for transport ideas)

| Server | Transport | Push / poll | Host layer | Concurrency | Liveness |
|---|---|---|---|---|---|
| `Dakkshin/after-effects-mcp` (569★) — **the copy installed at `tools/after-effects-mcp`** | file IPC, **one fixed file pair** in `~/Documents/ae-mcp-bridge` | poll — AE 2000 ms, Node 250 ms | **ScriptUI palette + `app.scheduleTask`** (no CEP) | **none** — a 2nd command overwrites an unconsumed 1st, silently | none (only a >30 s mtime warning) |
| `kumoproductions/mcp-aftereffects` (46★) | per-UUID mailbox, atomic both ways, consume-on-read | poll 80 ms | **no resident at all** — `osascript DoScript` / `-r` per call | promise chain + **cross-process `open("wx")` file lock** | inferred from request-consumed-or-not; **timeout says which** |
| `JUNKDOGE-JOE/after-effects-mcp` (46★) | CEP loopback **HTTP + token** *and* a **native C++ AEGP socket RPC** | push | CEP + C++ AEGP plugin | serialized queue + **drain sentinel** | state machine (`degraded`/`draining`) on `/health` |
| `Engine-Room-Games/after-effects-mcp` | **panel hosts HTTP + WebSocket**; MCP is the client | push | CEP, `AutoVisible` + `ApplicationActivate` (**self-starting**) | promise chain | `/health` + **`bundleHash` of the code actually running** |
| `AJSMonty/adobe-mcp` (Ppro + AE) | `osascript DoScript` (AE) / CEP file IPC (Ppro) | block + 120 ms poll | none (AE) / CEP (Ppro) | implicit | **heartbeat file, 1 s write / 5 s stale** + modal-dialog error taxonomy |
| `a-y-ibrahim/after-effects-mcp` | Dakkshin's file pair **+ correlation id** | poll — AE 250 ms, Node **40 ms exponential backoff** | ScriptUI (dockable) | dedup by id | **capability probe**, not a version string |
| `oneprism-io/After-Effects-MCP` | **[CLAIM]** cloud HTTP + OAuth → ws → signed `.zxp` | — | — | — | — · **docs-only repo, zero source. Its own README says so.** |
| `mikechambers/adb-mcp` (Ps + Ai + ID + AE + **Premiere**) | **socket.io through a standalone Node proxy on :3001**; MCP server *and* UXP plugin are both clients, routed by app name. **No auth** | push | **UXP** (`manifestVersion 5`, `premierepro` ≥ 25.6) | one request per connection — the Python client **opens a fresh socket per command**, waits, disconnects | `connect_error`/`disconnect` handlers + a queue timeout. No heartbeat |
| Adobe **Illustrator (Beta)** — first-party | **[DOC]** native in-app **loopback HTTP + Bearer token**, `http://localhost:18412/v1/mcp`. No plugin at all | push | none — built into the app | — | — |

---

## 2. What is actually true about the field

Three findings reframe the whole comparison.

### 2a. Nobody reaches Premiere by anything other than `evalScript`

`ayushozha` is the repo most often described as architecturally different — "Go/Rust/Python over
gRPC." The polyglot code is real (Go 2.0 MB, Rust 97 KB, Python 283 KB) but **[CODE]** the gRPC
sits *entirely behind* the MCP server, between its own services. Their own `.proto` says so:

> `proto/definitions/premierpro/premiere/v1/premiere.proto:8` — *"Implemented by the TypeScript service (CEP panel or standalone Node.js)."*

The Rust crate implements `MediaEngineService` (probe / scenes / waveform / thumbnails). A grep
for `premiere|extendscript|websocket` across `rust-engine/src` returns **one** hit: a `.prproj`
→ MIME-string mapping. The last hop into Premiere is `WebSocket → csInterface.evalScript →
mcpDispatch()`, and all ~1,060 of their tools funnel through that one generic string-eval.

**So the choice is not "file IPC vs. something fundamentally better."** It is: *how do you get a
string to `evalScript`, and how honestly do you report what happened?* Everyone is on the same
last mile. That is the correct frame for the rest of this document.

### 2b. The engine can die in a way every bridge in the field mistakes for health

**[MEASURED]** While probing payload limits I sent ExtendScript a few large allocations
(`for (i=0; i<16e6; i++) a.push("x")`). Result:

- Before: the trivial probe `(function(){ return __mcpStringify({v: app.version}); })();` returned
  `{"v":"26.3.2"}` in **227–256 ms**, six runs.
- After: **the same script** timed out at the panel's 45 s watchdog. So did a bare `for` loop. So
  did everything, permanently — Premiere sat at 109 % CPU with the ExtendScript engine
  unrecoverable short of an application restart.
- Throughout, **our heartbeat reported perfect health**: `connected: true`, `isProcessing: false`,
  age 90–175 ms.

This is the single most important gap found in the survey, and **it is unhandled by every Premiere
MCP examined**, ours included. Our heartbeat proves the *panel* is alive. It says nothing about
whether the *scripting engine* is alive, and those are different processes with different failure
modes. The caller gets "Premiere Pro or the CEP scripting host did not return a result" — true, but
it does not say *the engine is dead, restart Premiere*, so an agent will retry forever.

leancoderkavy documented the same class of decay from a different cause **[CODE]**
(`src/bridge/script-builder.ts`): re-sending helpers on every call *"can hit 'InternalError: Stack
overrun' once the long-lived ExtendScript engine has degraded, at which point every tool call dies
with an opaque 'EvalScript error.'"* They mitigate the cause; nobody detects the state.

The only known fix pattern in any Adobe MCP is **JUNKDOGE's drain sentinel** (§3, item 2), and it
lives in an After Effects project. Porting it is our opening.

### 2c. There are exactly two working UXP Premiere bridges, and both dial out

**[CODE]** `leancoderkavy` (§3.15) and **`mikechambers/adb-mcp`** (last commit 2026-07-08) are the only
UXP Premiere plugins in the survey that call the real `premierepro` API. Everything else labelled UXP
— including **our own `uxp-plugin/`** — is aspirational code that cannot run.

adb-mcp is worth reading because it picks a different topology: a **standalone Node socket.io proxy on
port 3001** that both the MCP server *and* the plugin connect to as clients, keyed by application name.
That neatly solves "UXP cannot listen" without the MCP server having to be a server — one proxy fans
out to Photoshop, Illustrator, InDesign, After Effects and Premiere at once. Three things about it are
instructive, two of them cautionary:

- **The Windows WebSocket problem is real and their fix is one line** **[CODE]** (`uxp/pr/main.js:72-74`):
  ```js
  socket = io(PROXY_URL, { transports: IS_WINDOWS ? ["polling"] : ["websocket"] });
  ```
  On Windows they abandon WebSocket entirely and run socket.io's HTTP long-polling fallback. This is
  the strongest practical argument for **socket.io over raw `ws`** if we ever build a socket bridge:
  the fallback is free and already written. (Whether long-polling *avoids* the underlying crash or
  merely sidesteps that code path is not established from the source alone — treat the mechanism as
  unverified, the mitigation as real.)
- **The proxy broadcasts** **[CODE]** (`adb-proxy-socket/proxy.js`, `sendToApplication`): it emits the
  command to *every* client registered for that application. Two open panels — or one stale
  registration — means the same command executes twice and both reply. No claim protocol, no
  request-id dedup. Worse than leancoderkavy's atomic rename-claim and worse than our single-panel
  model.
- **A fresh socket per command** **[CODE]** (`mcp/socket_client.py:35-149`, `send_message_blocking`):
  connect → `emit` → block on a queue → disconnect, every call. Correlation is *"the one outstanding
  request on this connection"* — there is no per-request id anywhere. It works, but it pays full
  connection setup per tool call and cannot ever pipeline.

One genuinely good idea to take: **[CODE]** their response envelope attaches current state to *every*
reply (`out.sequences = await getSequences(); out.project = await getProjectInfo();`), so the agent's
world model refreshes for free on each call instead of needing a follow-up query.

Also **[DOC]**: Adobe has published **zero** guidance on loopback networking from UXP —
`localhost`/`127.0.0.1` returns no hits across the whole Premiere UXP docs tree, and
`AdobeDocs/uxp-photoshop` issue **#321** (open since Sep 2022, never answered) reports `"http://localhost"`,
`"http://127.0.0.1"` and `"*"` all yielding *"Permission denied"* on manifestVersion 5. Anyone building
a UXP socket bridge is in untested territory. And **[DOC]** Adobe's own CEP→UXP migration guides in
`AdobeDocs/uxp-premiere-pro` are literally placeholder files reading `"Stuff goes here..."` — which is
a fair summary of how much help exists.

### 2d. Our heartbeat is the best liveness design in Premiere-land — and it has a false-positive bug

Only two Premiere servers signal liveness at all, and the designs differ in kind:

| | ours | leancoderkavy |
|---|---|---|
| Shape | one always-on beacon | one file per in-flight command |
| Written | every 250 ms tick, unconditionally | every 2 s, **only after the command is already 2 s old** |
| When idle | still beating | **nothing on disk** |
| Distinguishes panel-never-started from panel-idle | **yes** | **no** |
| Distinguishes "busy on *my* command" from "busy on *someone else's*" | **yes** (`currentCommandId`) | no |
| Fails fast when the panel dies mid-wait | **yes** | no |
| Disk churn on fast commands | 4 writes/sec always | zero |

Ours carries strictly more information. Keep it. **[CODE]** `src/bridge/index.ts:742-831`
(`readHeartbeat`, `describeTimeout`) and `cep-plugin/bridge-cep.js:569-604`.

**But:** the fail-fast branch trusts a *single* reading.

```ts
// src/bridge/index.ts:871-883
if (elapsed > HEARTBEAT_GRACE_MS && sawFreshHeartbeat && (!hb || hb.ageMs > HEARTBEAT_STALE_MS)) {
  throw new Error(`Bridge panel stopped responding: ...`);
}
```

`readHeartbeat()` returns `null` on *any* read failure, including a transient one. **[MEASURED]** I
hit exactly that during this survey: two reads seconds apart, the first succeeded, the second
returned `ENOENT` on `bridge-heartbeat.json`, and the file was present again immediately after. So
the precondition for a spurious "panel stopped responding" on a perfectly healthy panel is not
hypothetical — it happens. Fix: require **2–3 consecutive** stale-or-missing observations before
declaring death. Cheap, and it removes a whole class of phantom failure.

---

## 3. Specific things worth stealing

Ranked by value. Each says what it is, where to read it, and **why it beats what we do now**.

### 1. Two-outcome timeouts: "never picked up" vs. "picked up, may still be running"
**From:** `kumoproductions/mcp-aftereffects` `src/transport/FileIpcTransport.ts:150-272`;
`JUNKDOGE-JOE` `plugin/host/{jsx-bridge,server}.js` **[CODE]**

kumo reclaims the request file on timeout and reports which happened:

```ts
`timeout after ${timeoutMs}ms waiting for After Effects to respond` +
  (reclaimed
    ? ` (the request was never picked up by AE after ${attempts} launch attempt${...} and has been discarded)`
    : " (the request WAS picked up by AE; the operation may still be running)")
```

JUNKDOGE goes further, tagging every failure `disposition: 'failed' | 'not_dispatched' | uncertain`
and distinguishing a timed-out **mutation** (side effects unknown) from a timed-out **read**
(harmless).

**Why it beats ours:** our timeout says the panel is busy but never says whether *our command* was
consumed, so an agent cannot know if a destructive edit applied. We already have the fact on
hand — `unlink(commandFile)` in the `finally` at `src/bridge/index.ts:731-733` either removes a
never-consumed command or fails because the panel already took it. **We throw that signal away.**
Capture the unlink result and put it in the message. This is the highest-leverage change in the
list and it is nearly free.

### 2. The drain sentinel — recover from a wedge you cannot cancel
**From:** `JUNKDOGE-JOE` `plugin/host/jsx-bridge.js:8-12, 92-120` **[CODE]**

You cannot cancel a running ExtendScript. So on timeout, enter a `degraded` state and repeatedly
fire a trivial script; when *its* callback fires, the engine has provably drained everything queued
ahead of it:

```js
const DRAIN_SENTINEL_JSX = 'try{app.endUndoGroup()}catch(e){};1+1';
```

Calls that arrive during the drain get a **definite** `not_dispatched` instead of a guess.

**Why it beats ours:** this is the direct answer to §2b. Today a wedge is indistinguishable from a
slow command and every subsequent call burns a full 45 s. With a sentinel we can (a) know the
engine drained, (b) after N consecutive sentinel failures state plainly *"the ExtendScript engine
is unrecoverable — restart Premiere Pro"*, and (c) fail queued calls instantly instead of at 45 s
each. Note the sentinel also closes a dangling undo group the dead script left open. Portable to
CEP+Premiere verbatim; only the undo call needs swapping.

### 3. Ship the ExtendScript prelude once, not twice per call
**From:** `leancoderkavy` `src/bridge/script-builder.ts:519-548` **[CODE]**

They hash the helper block, write it to `<tempDir>/helpers_<md5-12>.jsx` once, and each command
carries a one-line bootstrap:

```ts
`if (typeof __HELPERS_V === "undefined" || __HELPERS_V !== "${HELPERS_VERSION}") { $.evalFile("${escaped}"); }`
```

Content-hashed filename means a version bump can never run stale helpers.

**Why it beats ours:** **[CODE]** we prepend our ~10 KB `EXTENDSCRIPT_HELPERS` in
`buildExecutableScript()` (`src/bridge/index.ts:619-638`) **and the panel prepends its own copy
again** (`cep-plugin/bridge-cep.js:499`: `var fullScript = EXTENDSCRIPT_COMPAT_HELPERS + '\n' +
script;`). Every single call pushes **two copies of the polyfill** through `evalScript`. That is
pure overhead on a channel with a size ceiling, it inflates every payload, and — per leancoderkavy's
own note — repeated re-parsing is a documented contributor to engine decay. Also: our panel-side
denylist runs over the *concatenated* script, so the duplicated prelude doubles the surface on
which a stray `eval(`/`process.` in a **comment** can brick every call.

### 4. `fs.watch` for the response, with the poll as fallback
**From:** `leancoderkavy` `src/bridge/file-bridge.ts:190-210` **[CODE]**

```ts
watcher = watch(dirname(resFile), { persistent: false }, (_event, filename) => {
  if (!filename || filename.toString() === responseName) check();
});
// first retry 100 ms, then POLL_FALLBACK_MS = 250
```

**Why it beats ours:** our server polls the response file at a flat 150 ms
(`src/bridge/index.ts:885`), adding 0–150 ms of pure latency to every call. `fs.watch` makes that
edge push while the timer remains as a correctness net. Note the honest bound: **[MEASURED]** a
tight-spinning client still saw **227–256 ms** per round trip, so the *panel's* 250 ms poll is the
real floor — fixing the server side alone buys ~75 ms average, not 250. Both halves need work to
matter (see item 9).

### 5. Elastic timeout: keep waiting while the host is provably still working
**From:** `leancoderkavy` `src/bridge/file-bridge.ts:179-245` **[CODE]**

```ts
const hardCapMs = Math.max(timeoutMs * 4, 120_000);
...
if (stillBusy && elapsed <= hardCapMs) { scheduleFallback(); return; }
```

**Why it beats ours:** we already *detect* "the panel is still processing this command" — and then
throw anyway, telling the caller to pass a bigger `timeoutMs`
(`src/bridge/index.ts:810-816`). That is a retry we could have avoided. We have better evidence
than they do (`currentCommandId` matches, so we know it is *our* command, not someone else's) and
we act on it less. Extend to a hard cap when `hb.isProcessing && hb.currentCommandId === commandId`.

### 6. Bulk data as a separate field — never inlined into generated source
**From:** `kumoproductions` `src/transport/AeTransport.ts:11-20` **[CODE]**

> *"Inlining megabytes of JSON into generated source stresses ExtendScript's parser and makes every character an escaping hazard; `payload` never passes through the ES3 tokenizer at all."*

**Why it beats ours:** every value we send is `JSON.stringify`'d into the script text. That is
correct and injection-safe, but it means payload size and *script* size are the same number, and
each byte is an escaping hazard — which is exactly the family of bug our `assertNoNulByte` and
`repairScriptLineTerminators` exist to patch after the fact. A side-channel payload file read by
the host removes the class instead of patching instances.

### 7. Bounded serialization with an actionable error
**From:** `JUNKDOGE-JOE` `plugin/host/server.js:420-433`; `AJSMonty` `core/harness.jsx:20-45` **[CODE]**

Depth cap 12, cycle detection, 1 000 000-char limit, and on overflow:

```js
'throw new Error("ae_exec result "+reason+"; return a smaller projection (for example, map to the fields you need)");'
```

AJSMonty caps depth at 8 with a per-key `try/catch` → `"[unserializable]"`.

**Why it beats ours:** **[CODE]** our `__mcpStringify` (`src/bridge/index.ts:79-173`) has excellent
*escaping* — control chars to `\uXXXX`, U+2028/9 handled, `hasOwnProperty` captured before it can
be shadowed, per-key `try/catch` — and it is the best escaper in the field by a clear margin. But
it has **no depth cap and no cycle detection**. Premiere's DOM is full of parent/child back-references
(`sequence → track → clip → projectItem → …`); one accidental broad serialization is unbounded
recursion inside the engine — plausibly the very decay in §2b.

### 8. Report the code the host is *running*, not what is on disk
**From:** `Engine-Room-Games` `packages/mcp-server/src/setup/panelVersion.ts:6-23`, `client/main.js:103-142` **[CODE]**

> *"the user updates the tools, does not update the panel, and the next call comes back `Unknown op: get_house_style`. Nothing in that says 'your panel is older than your tools'."*

They sha256 the bundle at the moment it is evaluated and serve it on `/health`, with five states:
`current | restart-needed | update-needed | partial-install | unknown`. Pair with `a-y-ibrahim`'s
**capability probe** — never trust a self-reported version string; probe for the feature (does it
echo the correlation id?).

**Why it beats ours:** we ship a `cep-plugin/` that the user installs by hand. A stale panel is a
guaranteed recurring support case, and today it presents as an unexplained timeout. Our heartbeat
is the natural carrier: add `panelVersion` + a hash of `bridge-cep.js` as loaded. It also gives us
a real answer to "is `cep_js` supported?" instead of a 10 s timeout.

### 9. Cut the panel poll, or make it push
**From:** `leancoderkavy` `cep-plugin/main.js:10` (`POLL_MS = 200`); `a-y-ibrahim`
`mcp-bridge-auto.jsx:2921` — 2000 ms → **250 ms**, *"the per-check work is tiny (a file existence check)"* **[CODE]**

**Why it matters for us:** **[MEASURED]** the panel's 250 ms tick *is* our latency, exactly. Six
consecutive round trips landed at 227/248/256/256/253/254 ms — the ExtendScript execution itself
is unmeasurable. Two options: drop the interval (a `readdirSync` of a near-empty dir is cheap), or
use `fs.watch` in the panel too — CEP panels run with `--enable-nodejs --mixed-context`, so the
panel has real `fs`. Nobody in the field watches on the panel side; it is available and unclaimed.

### 10. `open("wx")` cross-process lock so two clients cannot collide
**From:** `kumoproductions` `src/transport/FileIpcTransport.ts:327-389` **[CODE]**

Atomic create-exclusive, mtime-refreshed while held, breakable when stale, and it refuses to
release a lock it no longer owns (a laptop suspend can stall the loop past the staleness threshold;
blindly releasing hands a third caller a slot while the second is still driving the app).

**Why it beats ours:** our single-in-flight guarantee is enforced *inside one panel*
(`isProcessing`). Two MCP server instances sharing `PREMIERE_TEMP_DIR` — two editors, or a stale
server left running — both write commands into the same directory with no mutual exclusion. Related
**[CODE]**: leancoderkavy's panel wins ownership by atomic rename-claim (`cep-plugin/main.js:163-174`)
so a visible panel and a headless instance cannot double-execute the same command. We have no
equivalent.

### 11. Never interpolate an ExtendScript exception
**From:** `kumoproductions` `jsx/dispatcher.jsx:42-66` **[CODE]**

> *"`"failed: " + e` is not a safe way to report an error in ExtendScript. The engine cannot coerce an Error to a primitive, so the concatenation ITSELF throws — from inside the handler whose whole job was to report the original failure. The real error is lost, the replacement escapes, and AE raises a modal that blocks all scripting until a human clicks OK; every later call then fails as a busy-lock timeout."*

**Why it beats ours:** worth an audit pass over every `catch` in our generated ExtendScript. This is
a one-line fix (`describeError(e)`) against a failure that costs a whole session.

### 12. Stale-file and startup hygiene
**From:** `leancoderkavy` `file-bridge.ts:23-61, 285-299`; `a-y-ibrahim`'s dedup seeding **[CODE]**

Three separate ideas: (a) `ensureDir` refuses a pre-existing dir owned by another uid and re-`chmod`s
to `0o700`; (b) `cleanupTempDir()` sweeps all `cmd_`/`res_`/`busy_` files; (c) seed the dedup key at
startup **so a stale destructive command from a dead session cannot replay**.

**Why it beats ours:** **[CODE]** our `cleanup()` correctly refuses to delete an externally
configured dir (`src/bridge/index.ts:1855-1858`) — but there is **no startup sweep**, and with
`PREMIERE_TEMP_DIR` set (the only configuration where panel and server actually agree on a path)
nothing is ever swept. We create the dir `0o700` but never verify ownership of a pre-existing one.
And a leftover `command-*.json` from a crashed server *will* execute when the panel next starts.

### 13. Loopback + shared-secret token
**From:** `ayushozha` `cep-panel/src/panel.js:462-475, 573-629`; `JUNKDOGE-JOE`
`plugin/host/auth-token.js:29-37` **[CODE]**

32 random bytes at `~/.premierpro-mcp/cep-token`, `0600`/`0700`, `flag: "wx"` race-safe,
`crypto.timingSafeEqual`, browser `Origin` rejected, bind `127.0.0.1`. This is the one area where
ayushozha is unambiguously ahead of everyone.

**Why it matters for us:** less urgent for a file-IPC design (our dir is `0o700`), but it becomes
mandatory the moment we add a socket. Bank it now as the design for item 15. Compare
`Siddhant704`: WebSocket server on fixed port 8085 with **no auth at all** — any local process can
drive Premiere.

### 14. Honest per-command capability negotiation
**From:** `leancoderkavy` `uxp-plugin/commands.cjs` + `index.cjs` `capabilities()` **[CODE]**

Their UXP `hello` handshake returns, per command, `{supported, readOnly, destructive, undoable,
idempotent, cancellable, minHostVersion, probe}` — and the server refuses to dispatch an
unsupported one:

```ts
if (hello.commands[command]?.supported !== true) throw new UxpBridgeError("UXP_COMMAND_UNSUPPORTED", ...);
```

Including explicit negative entries:

```js
"captions.create": { supported: false, reason: "No documented Premiere UXP caption creation API." }
```

**Why this one stings:** that is *our* stated moat — honesty about what does and does not work —
implemented at the transport layer, machine-readable, and version-gated per host build. Our
`get_capabilities` is coarser and lives above the bridge. Their `minHostVersion` + runtime `probe()`
pair is the right shape and we should adopt it.

### 15. A UXP path that actually works — as a second path, not a replacement
**From:** `leancoderkavy` `uxp-plugin/` + `src/bridge/uxp-websocket-bridge.ts` **[CODE]**

They have a **working** UXP plugin: `manifestVersion: 5`, `host.app: "premierepro"`,
`minVersion: "25.6.0"`, and it calls the **native `premierepro` API** — `require("premierepro")`,
99 `ppro.*` call sites across `index.cjs`/`commands.cjs`. No ExtendScript anywhere on that path,
therefore no polyfill, no ES3, no `evalScript` string ceiling. Transport: the **plugin dials out**
to `ws://127.0.0.1:7777/uxp`, `?token=` + `timingSafeEqual`, ≥16-char token, `maxPayload` 1 MiB,
versioned `hello` handshake (protocols 1 and 2) with a 5 s handshake timer, `randomUUID`-keyed
request map, 2 s reconnect, and explicit `MAX_COMMAND_BYTES` (64 KiB) / `MAX_RESULT_BYTES` (1 MiB).

**The honest limit:** ~129 command definitions on their UXP path versus their full CEP tool set.
Premiere's UXP DOM cannot do most of what ExtendScript can — **[DOC]** no QE, no menu commands, no
caption-cue CRUD, no MOGRT text write, keyboard shortcuts unsupported, panels can be opened but not
closed programmatically — which is why they run both and why CEP remains the workhorse. And
**[DOC]** *plugin dials out* is not a preference: UXP cannot listen, so it is the only available
shape. Note also **[DOC]** two breaking changes in 26.3 that any UXP work must target:
`Sequence.setSelection` became synchronous (`.then()` chains break; `await` survives), and
`create*Action` calls must now sit inside `project.lockedAccess(() => {…})`. Adobe ships
`@adobe/eslint-plugin-premierepro` to catch exactly those.

**Why it beats ours:** **[CODE]** we ship a `uxp-plugin/` too — and it is **inherited dead code**.
`uxp-plugin/bridge.js:11` does `require('premiere')` (the module is `premierepro`), then hopes for
`app.executeExtendScript` or `app.evalScript` and rejects with *"ExtendScript execution not available
in this Premiere Pro version"* when neither exists. Neither ever exists. It polls files at 500 ms,
has no heartbeat, and writes responses non-atomically. Its manifest requests
`network.domains: ["localhost","127.0.0.1"]` — a leftover from a WebSocket design never written.
We should either build it properly against the native API or delete it, because shipping a plugin
that cannot work is exactly the dishonesty we claim to be against.

### 16. Smaller, free wins
**[CODE]** each:

- **`AutoVisible` + `StartOn ApplicationActivate`** (`Engine-Room-Games`, `ayushozha`) — the panel
  starts itself when the app launches. We auto-start the *bridge* once the panel is open
  (`bridge-cep.js:319-338`), which is good; this removes the remaining manual step.
- **Exponential poll backoff from ~40 ms** (`a-y-ibrahim` `bridge-core.ts:230-245`) — *"quick
  commands return in tens of ms instead of waiting a fixed interval, while long waits back off so
  the loop never busy-spins."* Strictly better than our flat 150 ms.
- **Host-script load probe** (`Anant-404`, `Engine-Room`) —
  `$.evalFile(...); typeof dispatch === 'function' ? 'ok' : 'no-dispatch'`. Verify the host layer
  registered; don't assume the eval took.
- **Empty-`evalScript` result is a bridge failure, not a success** (`leancoderkavy`
  `cep-plugin/main.js:213-224`) — *"reporting it as 'OK' is what made this so hard to diagnose"*,
  and the message names the cause: *"the CEP panel is stale — close and reopen it (a reload is not
  enough)."* We map the `'EvalScript error.'` sentinel well but treat an empty string as a value.
- **ES3 lint as a unit test over generated script strings** (`kumoproductions`
  `tests/helpers/lint-jsx.ts`; `kikikk` `es3-compatibility.test.ts`) — reject `let`/`const`/arrows/
  backticks/spread before a round trip. Complements our case-hoisting rule.
- **Error → lessons loop** (`AJSMonty` `knowledge/lessons.jsonl`) — keyword-match every failure
  against curated + runtime lessons and **append the matches to the error the agent sees**. Our
  memory files are the human-side analogue of exactly this.
- **If we ever build a socket bridge, use socket.io, not raw `ws`** (`adb-mcp` `uxp/pr/main.js:72-74`)
  — reconnect, backoff, ping/pong and an **HTTP long-polling fallback for Windows** all come for free,
  and that fallback is precisely what adb-mcp uses to route around a Windows WebSocket failure. Every
  raw-`ws` bridge in the survey (`ayushozha`, `leancoderkavy` UXP, `Siddhant704`, `hodor`, `Anant-404`)
  hand-rolls a subset of that.
- **Return current state with every response** (`adb-mcp` `uxp/pr/main.js:56-58`) — attach
  sequences/project info to each reply so the agent's world model refreshes for free rather than
  costing a follow-up round trip. Cheap on a 250 ms channel.

### Explicitly *not* worth stealing

- **gRPC / polyglot sidecars** (`ayushozha`). Real code, but it adds three hops and a `buf generate`
  build step without shortening the last mile. Their generated protobufs aren't even checked in
  (`.gitignore:41-47`), so a clean clone cannot build.
- **Unbounded parallel `evalScript`** (`ayushozha`, `leancoderkavy` CEP path, `kikikk`). ExtendScript
  is single-threaded; N concurrent calls only queue *inside* the engine with less visibility. Our
  strict serialization is the correct choice — keep it.
- **`eval("(" + str + ")")` as `JSON.parse`** (`ayushozha` `core.jsx`, `Dakkshin`, `Engine-Room`,
  most of the field). Ours is a real recursive-descent parser. Keep it.
- **`app.beginSuppressDialogs()`**. Heavily recommended across the AE projects and it is the right
  answer *there* — but it is an After Effects DOM method. **[CODE]** a grep for `suppressDialog`
  across all four Premiere repos surveyed returns nothing, because Premiere's ExtendScript has no
  equivalent. Do not chase it; the drain sentinel (item 2) is the Premiere-side answer.
- **A mock-response generator in the transport.** `Anant-404` ships `_simulateResponse()` returning
  hardcoded fake timeline data ("Main Sequence", 4 video tracks). Currently unreferenced. Cite it as
  the anti-pattern our honesty stance exists to prevent.

---

## 4. What we do better and should claim

All **[CODE]**, verified against the cloned competitors.

1. **The best liveness signal in Premiere-land.** An always-on beacon carrying
   `connected`/`isProcessing`/`currentCommandId`/`currentCommandStartedAt`, and a `describeTimeout()`
   that turns it into **five distinct, actionable messages** — panel never started / bridge not
   started / busy on *someone else's* command (with how long) / still on *yours* / alive-and-idle-but-
   silent. Upstream has literally one string for all five. leancoderkavy has two and cannot see an
   idle panel at all. `ayushozha`'s WS pong is answered by the CEF Node thread, so it cannot see a
   wedged engine even in principle. Plus we **fail fast** on crash-mid-wait instead of burning 60 s.

2. **The best ExtendScript JSON layer in the field, by a wide margin.** A real recursive-descent
   `__mcpParse` (deliberately not `eval`-based, so it survives our own denylist) *and* a
   `__mcpStringify` that escapes control characters to `\uXXXX`, handles U+2028/9, captures
   `hasOwnProperty` before it can be shadowed, and guards each key read. Compare:
   **leancoderkavy — the strongest rival — escapes only `\\`, `"` and `\n`, emits bare `undefined`,
   and has no `JSON.parse` at all.** A clip or marker name containing a `\r` or `\t` produces invalid
   JSON and loses their whole response. `Siddhant704`, `hodor`, `kikikk` and `adobe-premiere-mcp` ship
   no polyfill whatsoever. (Caveat: add a depth cap — item 7.)

3. **Two documented `evalScript` corruption fixes nobody else has.** `assertNoNulByte` — a NUL
   *truncates* the script rather than failing it, so `"p\0q"` silently created a marker named `"p"` —
   and `repairScriptLineTerminators` for U+2028/9, which are legal raw in JSON but are line
   terminators to the ES3 parser. Both reproduced against a live host. Only `kumoproductions` (an AE
   project) independently found the U+2028 issue; nobody else found either.

4. **Atomic handoff in both directions, with the reasoning written down.** `.tmp-<uuid>` → rename on
   the server, `.part` → rename in the panel, and a scratch name deliberately chosen not to match the
   panel's `command-` prefix. Only three of ten AE projects do tmp+rename at all; `Dakkshin` — the
   569-star field default — writes its command file with a plain `writeFileSync`.

5. **`type: 'cep_js'` — code execution in the panel context.** **Unique in the entire survey.**
   Every other bridge, Premiere and AE alike, can only reach ExtendScript. `ayushozha` has a fixed
   13-entry action map and no panel-context path; leancoderkavy has none. This gives us `window.cep`
   (fs/process/encoding/util), CSInterface methods, real browser APIs, and Promise support — i.e. an
   escape hatch from ES3 that runs *inside* Premiere. It is a genuine differentiator and it is
   undersold.

6. **Strict single-in-flight execution.** Correct for a single-threaded engine, and the opposite of
   what `ayushozha`, leancoderkavy's CEP path, and `kikikk` do.

7. **Failure-path cleanup that cannot resurrect a command.** Our `finally` unlinks staging, command
   *and* response, with the reason recorded: cleanup used to sit after the `await`, so a timeout left
   the command file for the panel to execute long after the caller gave up. The panel's unlink is
   separately guarded so a server-side timeout-unlink cannot overwrite a just-published result.
   `Dakkshin` still replays a stale `status: "pending"` command on next panel open.

8. **Per-command timeout negotiation.** The server writes `timeoutMs` into the command file and the
   panel widens its own watchdog to match (never narrows). Batch tools pass 300 s. Only `a-y-ibrahim`
   does anything comparable.

---

## 5. Bugs in our own bridge found while writing this

Concrete, all evidenced above.

| # | Bug | Evidence | Fix |
|---|---|---|---|
| 1 | **Dead ExtendScript engine reads as healthy.** Heartbeat fresh + `isProcessing: false` while every call times out at 45 s, permanently. | **[MEASURED]** §2b | Drain sentinel (§3.2); after N consecutive sentinel failures say *"restart Premiere Pro"* |
| 2 | **Spurious "panel stopped responding"** from a *single* transient heartbeat read failure. | **[MEASURED]** observed `ENOENT` on a live, healthy panel; `index.ts:871-883` | Require 2–3 consecutive stale/missing readings |
| 3 | **`queueLength` is a lifetime counter, not a queue depth.** `addToQueue` pushes; nothing ever dequeues. | **[MEASURED]** live heartbeat read `queueLength: 110` on an idle panel with an empty directory. Inherited from upstream (`bridge-cep.js:606-609`) | Prune on completion, or rename the field to `commandsSeen` |
| 4 | **The prelude ships twice per call** (~20 KB of pure overhead on a size-capped channel), and the denylist runs over both copies. | **[CODE]** `index.ts:619-638` + `bridge-cep.js:499` | §3.3 — `$.evalFile` a content-hashed helper file |
| 5 | **No depth cap or cycle detection** in `__mcpStringify`, against a DOM full of parent/child back-references. | **[CODE]** `index.ts:79-173` | §3.7 — depth cap + `seen` set + actionable overflow message |
| 6 | **45 s panel watchdog floor cannot be lowered** — `timeoutMs` only ever raises it — so one bad script wedges the bridge for 45 s regardless of the caller's timeout. | **[CODE]** `bridge-cep.js:503-506`; **[MEASURED]** every probe cost exactly ~45 s | Honour a *lower* requested timeout, with a sane floor |
| 7 | **No startup sweep**; with `PREMIERE_TEMP_DIR` set nothing is ever cleaned, and a leftover `command-*.json` executes when the panel next starts. No ownership check on a pre-existing dir. | **[CODE]** `index.ts:1855-1858` | §3.12 |
| 8 | **No cross-process mutual exclusion.** Two server instances sharing the dir have no lock. | **[CODE]** `isProcessing` is per-panel | §3.10 |
| 9 | **`uxp-plugin/` cannot work.** `require('premiere')` (wrong module), depends on non-existent `app.executeExtendScript`/`app.evalScript`. | **[CODE]** `uxp-plugin/bridge.js:11, 144-174` | Rebuild against native `premierepro`, or delete |
| 10 | **Timeouts discard the one fact that matters** — whether the command was consumed — although the `finally` unlink already computes it. | **[CODE]** `index.ts:731-733` | §3.1 |

---

## 6. Verdict

**Is our bridge the best design available? Not quite — but the gap is narrow, uneven, and closable.**

The honest scoreboard:

- **We are ahead on correctness and diagnosis.** Our JSON layer, our `evalScript` corruption fixes,
  our atomic handoff, our five-way timeout diagnosis and our strict serialization are each the best
  or joint-best in the field. Against our own upstream this is not close: upstream has **no liveness
  signal whatsoever**. The `cep_js` panel-context path is unique across all eleven bridges surveyed.
- **We are behind on latency and lifecycle.** **[MEASURED]** ~250 ms per round trip, entirely
  poll-tick, versus leancoderkavy's `fs.watch`-on-response + 200 ms panel tick, and versus the fully
  push WebSocket designs (`ayushozha`, `Siddhant704`, `hodor`, `Engine-Room`, `JUNKDOGE`). We are also
  behind on stale-file hygiene, cross-process locking, and shipping the prelude once.
- **`leancoderkavy/premiere-pro-mcp` is the only Premiere server genuinely ahead of us on
  architecture**, and only in specific places: three transports instead of one, push on the response
  edge, helpers loaded once, a real cross-engine claim protocol, stricter temp-dir ownership, and — most
  importantly — **a working native-UXP plugin with per-command capability negotiation**. It is also
  the most active project in the field (pushed the day of this survey, 284 commits). It is *behind* us
  on JSON safety in a way that will silently corrupt real responses, and on liveness granularity.
- **`ayushozha` is not the architectural threat its README implies.** The gRPC/Rust/Python is real but
  sits behind its own MCP server; the last mile is CEP + one generic `evalScript` dispatch, same as
  everyone. Its genuine lead is **transport authentication**. Its genuine liabilities are unbounded
  parallel eval into a single-threaded engine, an unwired circuit breaker whose architecture doc
  advertises it as a runtime feature, and three arbitrary-code/shell tools reachable by the model. And
  **[CODE]** their own audit concedes *"Live CEP/Premiere execution was not performed."*
- **Everything else is noise.** `Siddhant704` is one commit and unauthenticated; `adobe-premiere-mcp`
  cannot work; `ppmcp` does not exist; the `@iflow-mcp/*` packages are byte-identical rebrands; the
  98 upstream forks contain no notable divergence.

**The strategic point.** Our stated moat is honesty, and §2b says the moat has a hole in it: the
ExtendScript engine can die in a state our heartbeat calls healthy, and **no Premiere MCP detects
it**. Fixing that — the drain sentinel, plus a timeout that says whether the command was consumed —
would make ours the only Premiere bridge that can tell an agent *"your edit may or may not have
applied, and here is which"*. That is worth more than the 250 ms.

**The UXP point — and a correction we should propagate.** Our own notes have carried "CEP support
ends September 2026" as a fact. **It is not one.** **[DOC — verified absent]** No Adobe statement
sets that date. It traces to a *user's* forum question (where the Adobe employee reply conspicuously
did not confirm it) and a third-party docs mirror. Adobe's only on-record position is:

> *"At the time of this writing, there is no definitive end date for CEP in any given product. It's
> our plan to support CEP and UXP side-by-side for many years. … Premiere Pro will almost certainly
> remove CEP long before InDesign, for example, but no product teams have planned this definitively
> yet."* — Adobe employee, community.adobe.com/questions-628/future-of-cep-685590

`developer.adobe.com/premiere-pro/` still offers CEP as a live option beside UXP. So the UXP port is
**a capability play, not a forced migration** — which is the better footing, because it removes the
pressure to swap a working transport in a hurry.

Two things make UXP a *smaller* prize than it first looks:

- **[DOC]** UXP **cannot host a socket server** — Adobe states it twice (*"UXP supports WebSocket
  clients only… cannot host or accept incoming connections"*), and their platform table reads
  *"Socket Server — UXP: No / CEP: Yes, via Node / ExtendScript: Yes."* So the plugin-dials-out shape
  is not a design choice, it is the only shape available. leancoderkavy did not pick well; they picked
  the only option.
- **[DOC]** UXP has **no QE / menu-command API at all** — a grep of the 26.3 type definitions for
  `menu|executeCommand|qe` returns nothing, and Adobe's own prose claiming *"run menu items"* is a doc
  error. Everything we do today via QE has **no UXP path**. A UXP bridge cannot replace our CEP
  bridge; it can only sit beside it.

**And the signal that should shape our roadmap: Adobe has started shipping native in-app MCP
listeners.** **[DOC — verified]** Illustrator (Beta) now includes a **built-in MCP server** — not a
plugin — reached by plain loopback HTTP with a Bearer token:

```
claude mcp add --transport http \
  --header "Authorization: Bearer ilst_…" \
  --scope user illustrator http://localhost:18412/v1/mcp
```

That is Adobe's own answer to "UXP can't listen": skip the extension layer entirely. Every community
bridge in this document — ours included — exists only because that listener does not exist for
Premiere yet. If Premiere follows, a hand-built UXP socket bridge is obsolete overnight, while our
**tool surface, honesty semantics and capability probing** — the things a 40-tool first-party server
will not have — keep their value.

**Conclusion: invest above the transport, and keep the transport boring and swappable.**

### Suggested order of work

1. **Timeout says whether the command was consumed** (§3.1) — near-free, biggest honesty win.
2. **Drain sentinel + "restart Premiere" escalation** (§3.2) — closes the §2b hole nobody else sees.
3. **Heartbeat needs 2–3 consecutive bad readings** (§5.2) and **fix `queueLength`** (§5.3) — small, real.
4. **Depth cap + cycle detection in `__mcpStringify`** (§3.7) — plausibly a *cause* of §2b.
5. **Prelude once via content-hashed `$.evalFile`** (§3.3) — removes ~20 KB per call.
6. **`fs.watch` on both edges + lower the panel tick** (§3.4, §3.9) — 250 ms → tens of ms.
7. **Startup sweep, dir-ownership check, cross-process lock** (§3.12, §3.10).
8. **Panel version/capability in the heartbeat** (§3.8) — kills the stale-panel support case.
9. **Decide on UXP — but without panic.** There is no deadline (§6). Either build it against native
   `premierepro` with a plugin-dials-out loopback WS + token handshake and per-command capability
   negotiation (§3.14, §3.15), or **delete `uxp-plugin/`**. Shipping a plugin that provably cannot
   work is worse than shipping none. Given no QE and no menu commands in UXP, treat it as an
   *additional* path beside CEP, never a replacement.

---

## Appendix: measurement method

**[MEASURED]** items were produced against live Premiere Pro **26.3.2** with our CEP panel
connected, by writing command files directly into `/tmp/premiere-mcp-bridge` using the same
`.tmp-<uuid>` → rename protocol the server uses, and spinning at 5 ms so the measurement reflects
the *bridge* rather than the server's own 150 ms poll.

Round-trip latency, script `(function(){ return __mcpStringify({ v: app.version }); })();`,
six consecutive runs: **227, 248, 256, 256, 253, 254 ms** — all returning `{"v":"26.3.2"}`.

The payload-limit probe was **abandoned, and produced no size figure.** Attempting to return
1–16 M characters instead destroyed the ExtendScript engine (§2b): the same trivial script that had
just run in 227 ms began timing out at 45 s and never recovered, with Premiere pinned at 109 % CPU.
Any `evalScript` payload ceiling for Premiere therefore remains **unmeasured** — and that failure
turned out to be the most valuable result in this survey. **The host application requires a restart
to recover.**
