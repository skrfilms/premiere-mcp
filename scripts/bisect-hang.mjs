#!/usr/bin/env node
/**
 * Bisect which tool wedges the CEP bridge.
 *
 * The sweep's abort message names the tool that was in flight when the stall was
 * detected, which is not necessarily the tool that caused it: a modal opened by an
 * earlier call blocks every later one, so the reported name can be an innocent
 * bystander. This runs candidates strictly one at a time, checking that the bridge
 * actually drained before moving on, so the tool that fails to return is identified
 * unambiguously.
 *
 * Usage:
 *   PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/bisect-hang.mjs tool_a tool_b ...
 */
import { PremiereProBridge } from '../dist/bridge/index.js';
import { PremiereProTools } from '../dist/tools/index.js';
import { readFileSync } from 'node:fs';

// Tools run in-process, and persistPrefToFile (src/tools/index.ts) reads this on every call. A
// harness has no business making a change to the user's global Premiere prefs that survives a
// force-quit, so it is refused here before any tool can run.
process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1';

const CANDIDATES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!CANDIDATES.length) {
  console.error('usage: node scripts/bisect-hang.mjs <tool> [tool...]');
  process.exit(1);
}

const HB = `${process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge'}/bridge-heartbeat.json`;

function heartbeat() {
  try { return JSON.parse(readFileSync(HB, 'utf8')); } catch { return null; }
}

/** Resolves once the panel reports itself idle, or false if it never does. */
async function waitIdle(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hb = heartbeat();
    if (hb && !hb.isProcessing) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const bridge = new PremiereProBridge();
await bridge.initialize();
const tools = new PremiereProTools(bridge);

// Real ids so candidates get plausible arguments.
const ctx = await bridge.executeScript(`
  var o = { sequenceId: null, itemId: null };
  try {
    var s = app.project.activeSequence;
    if (s) { o.sequenceId = String(s.sequenceID);
      if (s.videoTracks.numTracks && s.videoTracks[0].clips.numItems)
        o.itemId = String(s.videoTracks[0].clips[0].projectItem.nodeId); }
  } catch (e) { o.error = e.toString(); }
  return JSON.stringify(o);
`);

console.log(`context: seq=${ctx.sequenceId} item=${ctx.itemId}\n`);

for (const name of CANDIDATES) {
  if (!(await waitIdle(8000))) {
    console.log(`SKIP ${name}: bridge already busy before this call — earlier tool still blocking`);
    continue;
  }

  const tool = tools.getAvailableTools().find((t) => t.name === name);
  if (!tool) { console.log(`SKIP ${name}: not in catalogue`); continue; }

  const args = {};
  let keys = [];
  try {
    const shape = tool.inputSchema?._def?.shape ?? tool.inputSchema?.shape;
    keys = Object.keys(typeof shape === 'function' ? shape() : (shape ?? {}));
  } catch { /* no shape: call with no args */ }
  for (const k of keys) {
    if (/sequenceId|seqId/i.test(k)) args[k] = ctx.sequenceId;
    else if (/projectItemId|itemId/i.test(k)) args[k] = ctx.itemId;
    else if (/trackIndex|clipIndex/i.test(k)) args[k] = 0;
  }
  for (const k of Object.keys(args)) if (args[k] == null) delete args[k];

  process.stdout.write(`${name} ... `);
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      tools.executeTool(name, args),
      new Promise((_, rej) => setTimeout(() => rej(new Error('NO RETURN in 20s')), 20000)),
    ]);
    const ms = Date.now() - t0;
    const drained = await waitIdle(8000);
    if (!drained) {
      console.log(`returned in ${ms}ms BUT LEFT THE BRIDGE BUSY  <-- CULPRIT`);
      console.log('   (the call came back, yet the panel never went idle: it left a modal up)');
      break;
    }
    console.log(`${r?.success === false ? 'error' : 'ok'} (${ms}ms)`);
  } catch (e) {
    console.log(`HUNG: ${e.message}  <-- CULPRIT`);
    break;
  }
}

console.log('\nbisect complete');
process.exit(0);
