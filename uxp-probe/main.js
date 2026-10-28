/*
 * MCP UXP Probe — runs UXP JavaScript (the `premierepro` module) on request.
 *
 * Why this exists next to the CEP panel: Premiere's UXP API reaches things ExtendScript cannot on
 * 26.x (work area, transition/effect factories, keyframe interpolation, caption track items). It
 * does not replace CEP — UXP has no QE DOM and cannot run ExtendScript — so it is a second, narrow
 * channel used for those calls only.
 *
 * Why it is not `uxp-plugin/`: that upstream panel forwards ExtendScript, which UXP cannot execute,
 * and fails to load at all (see KNOWN_ISSUES.md). This is a fresh, minimal design.
 *
 * Transport: files only, no network permission. The client writes
 *   <DIR>/command-<id>.json  { id, code }
 * and this panel answers with
 *   <DIR>/response-<id>.json { id, ok, result | error }
 * written to a .tmp name first and renamed, so a reader never sees half a file. `code` is the body
 * of an async function called with (ppro, uxp). DIR is fixed because a UXP panel cannot read the
 * environment; the client creates it mode 0700, the same trust boundary as the CEP file queue.
 */
const DIR = '/tmp/premiere-mcp-uxp';
const POLL_MS = 300;

const fs = require('fs');
const uxp = require('uxp');
const ppro = require('premierepro');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let busy = false;
let timer = null;
let handled = 0;
let lastError = null;
let lastSeen = null;

/**
 * UXP's fs is not Node's: writeFileSync/readFileSync/readdirSync exist, renameSync/unlinkSync do
 * not (measured on 26.5.2), and rename/unlink are async. Try each spelling rather than assume one.
 */
async function move(from, to) {
  if (typeof fs.renameSync === 'function') return fs.renameSync(from, to);
  if (typeof fs.rename === 'function') return await new Promise((res, rej) => {
    const r = fs.rename(from, to, (err) => (err ? rej(err) : res()));
    if (r && typeof r.then === 'function') r.then(res, rej);
  });
  throw new Error('no rename in this fs');
}
async function remove(path) {
  if (typeof fs.unlinkSync === 'function') return fs.unlinkSync(path);
  if (typeof fs.unlink === 'function') return await new Promise((res, rej) => {
    const r = fs.unlink(path, (err) => (err ? rej(err) : res()));
    if (r && typeof r.then === 'function') r.then(res, rej);
  });
  throw new Error('no unlink in this fs');
}

/** readdir entries can come back as names, paths, or entry objects depending on the UXP build. */
function entryName(e) {
  const n = typeof e === 'string' ? e : (e && (e.name || e.path)) || String(e);
  return String(n).split('/').pop();
}

/** The panel is optional: these no-op when it is closed, since polling runs regardless. */
function setStatus(text, state) {
  try {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
    const dot = document.getElementById('dot');
    if (dot) dot.className = 'dot ' + (state || '');
  } catch (e) { /* no document */ }
}
function setLast(text, bad) {
  try {
    const el = document.getElementById('last');
    if (el) { el.textContent = text; el.className = 'last' + (bad ? ' bad' : ''); }
  } catch (e) { /* no document */ }
}

function serialise(value, depth = 0) {
  // UXP objects are host proxies; JSON.stringify sees nothing on most of them. Walk own and
  // prototype getters one level so a probe can return an object and still learn its shape.
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (depth > 2) return `[${value.constructor?.name ?? 'object'}]`;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => serialise(v, depth + 1));
  const out = {};
  const seen = new Set();
  for (let o = value; o && o !== Object.prototype && seen.size < 200; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (seen.has(k) || k === 'constructor') continue;
      seen.add(k);
      try {
        const v = value[k];
        out[k] = typeof v === 'function' ? '[function]' : serialise(v, depth + 1);
      } catch (e) {
        out[k] = `[threw ${e.message}]`;
      }
    }
  }
  return out;
}

async function heartbeat() {
  try {
    fs.writeFileSync(`${DIR}/uxp-heartbeat.json`, JSON.stringify({ ts: Date.now(), handled, busy, lastError, lastSeen }));
  } catch (e) { /* DIR not created yet: the client makes it */ }
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    let names = [];
    try { names = Array.from(fs.readdirSync(DIR)).map(entryName); } catch (e) { lastError = `readdir: ${e.message}`; setStatus('Waiting for the MCP server', 'off'); return; }
    lastSeen = names.slice(0, 6);
    const cmd = names.find((n) => n.startsWith('command-') && n.endsWith('.json'));
    if (!cmd) { setStatus('Ready', 'ready'); return; }
    const path = `${DIR}/${cmd}`;
    let req;
    try {
      const raw = fs.readFileSync(path, { encoding: 'utf-8' });
      req = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch (e) { lastError = `read ${cmd}: ${e.message}`; return; }
    // Claim the command by renaming it, so a second poller (or a retry) cannot run it twice.
    try { await move(path, `${path}.taken`); } catch (e) { lastError = `claim ${cmd}: ${e.message}`; return; }
    try { await remove(`${path}.taken`); } catch (e) { /* leftover is harmless */ }
    setStatus('Working…', 'busy');
    let res;
    try {
      const result = await new AsyncFunction('ppro', 'uxp', req.code)(ppro, uxp);
      res = { id: req.id, ok: true, result: serialise(result) };
    } catch (e) {
      res = { id: req.id, ok: false, error: String(e && e.message ? e.message : e), stack: String(e && e.stack || '') };
    }
    const tmp = `${DIR}/response-${req.id}.json.tmp`;
    const final = `${DIR}/response-${req.id}.json`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(res));
      await move(tmp, final);
    } catch (e) {
      // No rename: write in place. The client parses defensively and retries a partial read.
      fs.writeFileSync(final, JSON.stringify(res));
    }
    handled++;
    const what = req.label ? String(req.label) : 'Last request';
    setLast(res.ok ? `${what} — done` : `${what} — failed: ${res.error}`, !res.ok);
  } finally {
    busy = false;
    heartbeat();
  }
}

// Poll from load, not from show(): the panel is a status view, and closing it must not stop
// the channel. (It used to start in show() and stop in destroy(), so a closed panel meant a
// dead channel.)
function start() { if (!timer) timer = setInterval(poll, POLL_MS); }
start();

uxp.entrypoints.setup({
  plugin: {
    create() { start(); },
  },
  panels: {
    uxpProbePanel: {
      show() { start(); setStatus('Ready', 'ready'); },
    },
  },
});
