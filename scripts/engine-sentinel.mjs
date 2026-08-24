#!/usr/bin/env node
/**
 * Engine sentinel — tells apart the three ways this bridge can be "down".
 *
 * The heartbeat file proves the CEP **panel** is alive. It says nothing about the
 * **ExtendScript engine** behind it, and the engine can die such that every call times out
 * permanently while the heartbeat still reports `connected: true, isProcessing: false` with an
 * age of ~90 ms. On 2026-08-24 that cost most of a session: the healthy-looking beacon led to
 * "stale queue" and innocent-tool diagnoses when the real state was a dead engine.
 *
 * This probe is deliberately dependency-free — it speaks the file IPC directly rather than
 * importing `dist/`, so it still works when the TypeScript build is broken, which is exactly
 * when you most want to know whether the host is alive.
 *
 * The classification hinges on one fact the normal timeout path throws away: whether the panel
 * **consumed** the command file. Consumed-but-silent and never-consumed are completely
 * different failures, and only one of them is safe to retry.
 *
 *   HEALTHY      nonce round-tripped; engine executes ExtendScript
 *   ENGINE_DEAD  panel consumed the command, then never answered  -> relaunch Premiere
 *   PANEL_DEAD   command never consumed and heartbeat is stale    -> panel/bridge not running
 *   BUSY         panel is mid-command on something else            -> wait and re-probe
 *
 * Exit codes are the same order (0/1/2/3) so a shell loop can branch on them, plus 4 for an
 * internal error. `--json` prints one machine-readable line.
 */
import { writeFileSync, renameSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// PREMIERE_TEMP_DIR is the name the server and the panel already agree on (it is what
// .mcp.json sets). Without it the bridge invents a per-session directory and then blames the
// panel's configuration for the silence, so the name matters more than it looks.
const TEMP_DIR =
  process.env.PREMIERE_TEMP_DIR || process.env.PREMIERE_MCP_TEMP_DIR || '/tmp/premiere-mcp-bridge';
const HEARTBEAT = join(TEMP_DIR, 'bridge-heartbeat.json');

/** A heartbeat older than this is not evidence of a live panel. */
const HEARTBEAT_STALE_MS = 10_000;
/** How long to wait for the nonce to come back before calling the engine dead. */
const DEFAULT_TIMEOUT_MS = 12_000;
const POLL_MS = 100;

const asJson = process.argv.includes('--json');
const timeoutMs = Number(
  (process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1] || DEFAULT_TIMEOUT_MS,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readHeartbeat() {
  try {
    const hb = JSON.parse(readFileSync(HEARTBEAT, 'utf8'));
    return { ...hb, ageMs: Date.now() - Number(hb.ts) };
  } catch {
    return null;
  }
}

/**
 * Publish a command the way the server does: write to a staging name, then rename. The panel
 * polls for `command-*.json`, so writing that name directly would let it read a half-written
 * file. rename() inside one directory is atomic.
 */
function publishCommand(id, script) {
  const finalPath = join(TEMP_DIR, `command-${id}.json`);
  const staging = join(TEMP_DIR, `.tmp-${id}.json`);
  writeFileSync(staging, JSON.stringify({ id, script, timeoutMs: 8000 }, null, 2));
  renameSync(staging, finalPath);
  return finalPath;
}

async function probe() {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 });

  const hbBefore = readHeartbeat();
  const nonce = `sentinel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const id = `sentinel-${nonce}`;

  // The cheapest possible round-trip: no DOM traversal, no app object access that could block
  // on a modal, nothing that can be slow. If this does not come back, the engine is not
  // executing script at all. Anything heavier would confound "dead" with "busy".
  //
  // Wrapped in an IIFE to match what the server sends. `return` at the top level of an
  // evalScript payload is a syntax error, and the panel reports that as the same generic
  // "EvalScript error" it reports for a genuinely dead host — so an unwrapped probe would
  // accuse a perfectly healthy engine.
  const script = `(function(){ return JSON.stringify({ nonce: '${nonce}' }); })();`;

  const commandPath = publishCommand(id, script);
  const responsePath = join(TEMP_DIR, `response-${id}.json`);

  const started = Date.now();
  let consumedAt = null;

  while (Date.now() - started < timeoutMs) {
    // Consumption is the load-bearing observation: the panel unlinks the command file when it
    // picks the work up. Record when, because it separates "never ran" from "may have run".
    if (consumedAt === null && !existsSync(commandPath)) consumedAt = Date.now() - started;

    if (existsSync(responsePath)) {
      let payload = null;
      try {
        payload = JSON.parse(readFileSync(responsePath, 'utf8'));
      } catch {
        // A partially-visible response; the panel renames atomically, so just re-poll.
        await sleep(POLL_MS);
        continue;
      }
      try { unlinkSync(responsePath); } catch {}

      const rtt = Date.now() - started;
      // `result` arrives already-parsed when the panel could decode it, and as a raw string
      // when it could not. Accept both rather than assuming, or a healthy host gets reported
      // dead purely because the payload was more decoded than expected.
      let echoed = null;
      try {
        const r = payload.result;
        const obj = typeof r === 'string' ? JSON.parse(r) : r;
        echoed = obj?.nonce ?? null;
      } catch {}

      if (payload.success && echoed === nonce) {
        return { state: 'HEALTHY', code: 0, rttMs: rtt, consumedAfterMs: consumedAt,
          detail: `engine executed ExtendScript and echoed the nonce in ${rtt}ms` };
      }
      // A response that is not our nonce means the channel works but the engine misbehaved —
      // still a real failure, and not one to paper over as healthy.
      return { state: 'ENGINE_DEAD', code: 1, rttMs: rtt, consumedAfterMs: consumedAt,
        detail: `panel answered but the nonce did not round-trip: ${JSON.stringify(payload).slice(0, 200)}` };
    }
    await sleep(POLL_MS);
  }

  // Timed out. Clean up our own command so it cannot execute later against a different project
  // state — a leftover command file runs when the panel next starts.
  const wasConsumed = consumedAt !== null || !existsSync(commandPath);
  try { if (existsSync(commandPath)) unlinkSync(commandPath); } catch {}

  const hbAfter = readHeartbeat();
  const heartbeatLive = hbAfter && hbAfter.ageMs < HEARTBEAT_STALE_MS;

  if (!wasConsumed) {
    // Nobody picked the file up. If the heartbeat is also stale the panel is gone; if the
    // heartbeat is fresh the panel is alive but not polling, which is its own bug worth naming.
    return heartbeatLive
      ? { state: 'PANEL_DEAD', code: 2, consumedAfterMs: null,
          detail: `heartbeat is fresh (${hbAfter.ageMs}ms) but the command was never consumed in ${timeoutMs}ms — the panel is running and not polling` }
      : { state: 'PANEL_DEAD', code: 2, consumedAfterMs: null,
          detail: hbAfter ? `heartbeat stale by ${hbAfter.ageMs}ms and command never consumed` : 'no heartbeat file and command never consumed' };
  }

  if (hbAfter && hbAfter.isProcessing && hbAfter.currentCommandId && !String(hbAfter.currentCommandId).includes(nonce)) {
    return { state: 'BUSY', code: 3, consumedAfterMs: consumedAt,
      detail: `panel is executing a different command (${hbAfter.currentCommandId}); re-probe when idle` };
  }

  // The honest verdict, and the one the whole file exists to produce: the panel took the work
  // and went silent. The beacon will keep saying "connected".
  return {
    state: 'ENGINE_DEAD', code: 1, consumedAfterMs: consumedAt,
    detail:
      `panel consumed the command after ${consumedAfterMsLabel(consumedAt)} and never answered within ${timeoutMs}ms, ` +
      `while the heartbeat still reports connected=${hbAfter ? hbAfter.connected : 'n/a'} ` +
      `isProcessing=${hbAfter ? hbAfter.isProcessing : 'n/a'} age=${hbAfter ? hbAfter.ageMs : 'n/a'}ms. ` +
      'The ExtendScript engine is not executing. Restart Premiere Pro.',
    heartbeatBefore: hbBefore,
    heartbeatAfter: hbAfter,
  };
}

function consumedAfterMsLabel(v) {
  return v === null ? 'an unobserved interval' : `${v}ms`;
}

try {
  const verdict = await probe();
  if (asJson) {
    console.log(JSON.stringify(verdict));
  } else {
    console.log(`${verdict.state}: ${verdict.detail}`);
  }
  process.exit(verdict.code);
} catch (e) {
  const out = { state: 'SENTINEL_ERROR', code: 4, detail: e?.message || String(e) };
  console.log(asJson ? JSON.stringify(out) : `SENTINEL_ERROR: ${out.detail}`);
  process.exit(4);
}
