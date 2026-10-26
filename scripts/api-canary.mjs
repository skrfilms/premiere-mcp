#!/usr/bin/env node
/**
 * API canary — re-measure the Premiere scripting behaviour this server depends on.
 *
 * Premiere 26.5.2 changed the scripting engine and several DOM/QE semantics without notice, and
 * dozens of tools broke silently for weeks. Every fix that followed rests on a MEASURED fact (an
 * inPoint write slips, QE exports need a timecode, move() is relative, ...). This script measures
 * each of those facts again, against the composited program frame where pixels are the only honest
 * witness, and says exactly which one moved. Run it after every Premiere update.
 *
 * Each probe is one of:
 *   relied  - the code is built on this. A change means tools are now wrong: exit 1.
 *   watch   - a known limitation. A change is good news (something may now be scriptable) and is
 *             reported, but does not fail the run.
 *
 * It builds its own throwaway sequences from a frame-counter clip (every frame shows its number as
 * eight black/white bars), deletes them afterwards, and only runs against the repo scratch project.
 *
 * Usage:
 *   PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/api-canary.mjs [--json] [--verbose]
 * Writes verification/canary/<utc>-<premiereVersion>.json and diffs it against the previous run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.PREMIERE_TEMP_DIR = process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge';
process.env.PREMIERE_MCP_PROFILE = process.env.PREMIERE_MCP_PROFILE || 'all';
process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1';

const { PremiereProBridge } = await import('../dist/bridge/index.js');
const { PremiereProTools } = await import('../dist/tools/index.js');
const { requireScratchProject } = await import('./lib/require-scratch-project.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MEDIA = join(REPO, '.scratch', 'media');
const BITS = join(MEDIA, 'canary_bits_10s.mp4');
const DUAL = join(MEDIA, 'canary_bits_dualmono.mp4');
const OUT_DIR = join(REPO, 'verification', 'canary');
const JSON_ONLY = process.argv.includes('--json');
const TPS = 254016000000;

const log = (s) => { if (!JSON_ONLY) process.stdout.write(s + '\n'); };
// The tool layer logs every call to stderr; the canary's own report is the output. --verbose keeps it.
if (!process.argv.includes('--verbose')) { console.error = () => {}; console.warn = () => {}; console.info = () => {}; console.debug = () => {}; }

/* ----------------------------------------------------------------------------- media */

const BARS = "geq=lum='if(bitand(floor(N/pow(2,floor(X/80))),1),235,16)'";

function ensureMedia() {
  mkdirSync(MEDIA, { recursive: true });
  const ff = process.env.PREMIERE_MCP_FFMPEG_CMD || 'ffmpeg';
  const make = (out, extra) => {
    if (existsSync(out)) return;
    const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=gray:s=640x360:r=24:d=10,format=gray,${BARS}`, ...extra,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', '-crf', '10', out], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not build ${out} with ${ff}: ${r.stderr || r.error}`);
  };
  make(BITS, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:a', 'aac', '-shortest']);
  make(DUAL, ['-f', 'lavfi', '-i', 'sine=f=440:d=10', '-f', 'lavfi', '-i', 'sine=f=660:d=10',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:a', 'aac', '-ac', '1']);
}

/** Frame number encoded in an image (8 bars, LSB left). Black (empty timeline) also reads 0. */
function decodeFrame(png) {
  const ff = process.env.PREMIERE_MCP_FFMPEG_CMD || 'ffmpeg';
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', png, '-vf', 'format=gray,scale=8:1:flags=area', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 8) return null;
  let n = 0;
  for (let i = 0; i < 8; i++) if (r.stdout[i] > 125) n += 2 ** i;
  return n;
}

/* ----------------------------------------------------------------------------- host */

const bridge = new PremiereProBridge();
await bridge.initialize();
const tools = new PremiereProTools(bridge);
const pinned = await requireScratchProject(bridge, 'api-canary');

async function host(body) {
  const r = await bridge.executeScript(`(function(){ try { ${body} } catch (e) { return JSON.stringify({ __error: String(e) + ' (line ' + e.line + ')' }); } })()`);
  if (r && r.__error) throw new Error(r.__error);
  return r;
}

const SETUP_LIB = `
  function T(s){ var t = new Time(); t.seconds = s; return t; }
  function item(path){
    var want = new File(path).fsName;
    var stack = [app.project.rootItem];
    while (stack.length) { var b = stack.pop(); for (var i = 0; i < b.children.numItems; i++) { var c = b.children[i]; if (c.type === 2) stack.push(c); else { try { if (c.getMediaPath() === want) return c; } catch (e) {} } } }
    app.project.importFiles([want], true, app.project.rootItem, false);
    for (var j = 0; j < app.project.rootItem.children.numItems; j++) { var d = app.project.rootItem.children[j]; try { if (d.getMediaPath() === want) return d; } catch (e2) {} }
    return null;
  }
  function freshSeq(name, it, copies){
    for (var q = app.project.sequences.numSequences - 1; q >= 0; q--) if (app.project.sequences[q].name === name) app.project.deleteSequence(app.project.sequences[q]);
    var arr = []; for (var k = 0; k < copies; k++) arr.push(it);
    it.clearInPoint(4); it.clearOutPoint(4);
    return app.project.createNewSequenceFromClips(name, arr, app.project.rootItem);
  }
`;

/** Two clips on V1/A1: A 0-5 (source 0-5), B 5-10 (source 5-10). Returns the sequence id. */
async function abSequence(name) {
  const r = await host(`${SETUP_LIB}
    var it = item(${JSON.stringify(BITS)}); if (!it) return JSON.stringify({ __error: 'canary media did not import' });
    var s = freshSeq(${JSON.stringify(name)}, it, 2);
    var g = [s.videoTracks[0], s.audioTracks[0]];
    for (var k = 0; k < 2; k++) { var A = g[k].clips[0], B = g[k].clips[1]; A.end = T(5); B.inPoint = T(5); B.start = T(15); B.move(T(-10)); }
    return JSON.stringify({ id: s.sequenceID });`);
  return r.id;
}

async function capture(seqId, t) {
  const out = join(tmpdir(), `premiere-canary-${process.pid}-${Math.round(t * 1000)}.png`);
  const r = await tools.executeTool('capture_program_output', { sequenceId: seqId, time: t, outputPath: out });
  if (!r || r.success === false) throw new Error(`capture at ${t}s failed: ${r && r.error}`);
  return decodeFrame(r.outputPath || out);
}

async function dropSequences(names) {
  await host(`var n = ${JSON.stringify(names)}, k = 0;
    for (var q = app.project.sequences.numSequences - 1; q >= 0; q--) { for (var i = 0; i < n.length; i++) if (app.project.sequences[q].name === n[i]) { app.project.deleteSequence(app.project.sequences[q]); k++; break; } }
    return JSON.stringify({ deleted: k });`);
}

/* ----------------------------------------------------------------------------- probes */

const results = [];
/**
 * @param {string} id stable probe id (used to diff runs)
 * @param {'relied'|'watch'} kind
 * @param {string} expect what the code assumes / the known limitation
 * @param {() => Promise<{ ok: boolean, observed: any }>} fn
 */
async function probe(id, kind, expect, fn) {
  let entry;
  try {
    const { ok, observed } = await fn();
    entry = { id, kind, expect, ok, observed };
  } catch (e) {
    entry = { id, kind, expect, ok: false, observed: `probe error: ${e.message}` };
  }
  results.push(entry);
  const mark = entry.ok ? 'ok  ' : (kind === 'relied' ? 'FAIL' : 'NEWS');
  log(`  ${mark}  ${id.padEnd(34)} ${typeof entry.observed === 'string' ? entry.observed : JSON.stringify(entry.observed)}`);
}

ensureMedia();
const env = await host(`return JSON.stringify({ premiere: String(app.version), extendscript: String($.version), build: String(app.build || '') });`);
log(`\nPremiere ${env.premiere}  ExtendScript ${env.extendscript}  project ${pinned.name}\n`);

const SEQ = 'api_canary_ab';
const DSEQ = 'api_canary_dualmono';
let ab = await abSequence(SEQ);

// --- engine -------------------------------------------------------------------
await probe('prelude.array-methods', 'relied', 'Array map/filter/indexOf/isArray usable (polyfilled by the prelude if absent)', async () => {
  const r = await host(`return JSON.stringify({ map: [1,2].map(function(x){return x*2;}).join(','), filter: [1,2,3].filter(function(x){return x>1;}).length, indexOf: ['a','b'].indexOf('b'), isArray: Array.isArray([]) });`);
  return { ok: r.map === '2,4' && r.filter === 2 && r.indexOf === 1 && r.isArray === true, observed: r };
});

// --- QE addressing --------------------------------------------------------------
await probe('qe.sequence-by-guid', 'relied', 'every QE-visible sequence is found by guid (QE order may differ from the DOM)', async () => {
  const r = await host(`app.enableQE(); var bad = 0, seen = 0, sameOrder = true;
    for (var i = 0; i < app.project.sequences.numSequences; i++) { var s = app.project.sequences[i]; var q = __qeSequenceFor(s); if (q) { seen++; if (String(q.guid) !== String(s.sequenceID)) bad++; }
      try { var qi = qe.project.getSequenceAt(i); if (!qi || String(qi.guid) !== String(s.sequenceID)) sameOrder = false; } catch (e) { sameOrder = false; } }
    return JSON.stringify({ seen: seen, mismatched: bad, qeOrderMatchesDom: sameOrder });`);
  return { ok: r.seen > 0 && r.mismatched === 0, observed: r };
});
await probe('qe.gap-items', 'relied', 'QE track items include gaps, so DOM clip index != QE item index', async () => {
  const r = await host(`var s = __findSequence(${JSON.stringify(ab)}); var t = new Time(); t.seconds = 1; s.videoTracks[0].clips[1].move(t);
    app.enableQE(); var q = __qeSequenceOpening(s), qt = q.getVideoTrackAt(0), types = [];
    for (var i = 0; i < qt.numItems; i++) types.push(String(qt.getItemAt(i).type));
    var byIndex = __qeClipByIndex(q, 'video', 0, 1), ok = byIndex && Math.abs(Number(byIndex.start.secs) - 6) < 0.01;
    var back = new Time(); back.seconds = -1; s.videoTracks[0].clips[1].move(back);
    return JSON.stringify({ items: types.join(','), qeClipByIndexHitsClip: !!ok });`);
  return { ok: /Empty/.test(r.items) && r.qeClipByIndexHitsClip, observed: r };
});

// --- frame export ---------------------------------------------------------------
await probe('qe.export-frame-timecode', 'relied', 'capture at t=2s / t=5.5s shows source frames 48 / 132', async () => {
  const a = await capture(ab, 2), b = await capture(ab, 5.5);
  return { ok: a === 48 && b === 132, observed: { at2s: a, at5_5s: b } };
});
await probe('qe.export-frame-bare-number', 'relied', 'a bare number string ("2") is read as a FRAME count, not seconds (why exports pass a timecode)', async () => {
  const p = join(tmpdir(), `premiere-canary-secs-${process.pid}`);
  await host(`app.enableQE(); var q = __qeSequenceOpening(__findSequence(${JSON.stringify(ab)})); q.exportFramePNG('2', ${JSON.stringify(p)}); return JSON.stringify({ ok: true });`);
  const f = decodeFrame(p + '.png');
  return { ok: f === 2, observed: { frame: f } };
});

// --- trim / move semantics ------------------------------------------------------
const clipState = (track = 'videoTracks', i = 0) => `var c = __findSequence(${JSON.stringify(ab)}).${track}[0].clips[${i}];`;
const reset = async () => { await dropSequences([SEQ]); ab = await abSequence(SEQ); };

await probe('dom.inPoint-write-slips', 'relied', 'inPoint=1s on clip A shows source 1s at t=0, timeline range unchanged', async () => {
  const r = await host(`${clipState()} c.inPoint = (function(){var t=new Time();t.seconds=1;return t;})(); return JSON.stringify({ start: c.start.seconds, end: c.end.seconds });`);
  const f = await capture(ab, 0);
  await reset();
  return { ok: f === 24 && r.start === 0 && r.end === 5, observed: { frameAt0: f, ...r } };
});
await probe('dom.start-write-moves-content', 'relied', 'start=1s on clip A shows source 1s at t=2 (content moves with the head)', async () => {
  await host(`${clipState()} c.start = (function(){var t=new Time();t.seconds=1;return t;})(); return JSON.stringify({ ok: 1 });`);
  const f = await capture(ab, 2);
  await reset();
  return { ok: f === 24, observed: { frameAt2: f } };
});
await probe('dom.end-write-trims-tail', 'relied', 'end=4s on clip A leaves source 3.958s as its last frame', async () => {
  await host(`${clipState()} c.end = (function(){var t=new Time();t.seconds=4;return t;})(); return JSON.stringify({ ok: 1 });`);
  const f = await capture(ab, 3.958);
  await reset();
  return { ok: f === 95, observed: { frameAt3_958: f } };
});
await probe('dom.outPoint-write-inert', 'watch', 'outPoint writes have no visible effect', async () => {
  await host(`${clipState('videoTracks', 1)} c.outPoint = (function(){var t=new Time();t.seconds=8;return t;})(); return JSON.stringify({ ok: 1 });`);
  const f = await capture(ab, 9.5);
  await reset();
  return { ok: f === 228, observed: { frameAt9_5: f } };
});
await probe('dom.move-relative-single-item', 'relied', 'move(+1s) on V1 clip B shifts it 1s and leaves its linked audio', async () => {
  const r = await host(`var s = __findSequence(${JSON.stringify(ab)}); var v = s.videoTracks[0].clips[1]; v.move((function(){var t=new Time();t.seconds=1;return t;})());
    return JSON.stringify({ video: s.videoTracks[0].clips[1].start.seconds, audio: s.audioTracks[0].clips[1].start.seconds });`);
  await reset();
  return { ok: r.video === 6 && r.audio === 5, observed: r };
});
await probe('dom.remove-no-ripple', 'relied', 'TrackItem.remove(true,true) removes only that item and does not ripple', async () => {
  const r = await host(`var s = __findSequence(${JSON.stringify(ab)}); s.videoTracks[0].clips[0].remove(true, true);
    return JSON.stringify({ v1: s.videoTracks[0].clips.numItems, v1Start: s.videoTracks[0].clips[0].start.seconds, a1: s.audioTracks[0].clips.numItems });`);
  await reset();
  return { ok: r.v1 === 1 && r.v1Start === 5 && r.a1 === 2, observed: r };
});
await probe('dom.nodeId-identity', 'relied', 'dual-mono A1/A2 items have distinct nodeIds that survive edits', async () => {
  const r = await host(`${SETUP_LIB} var it = item(${JSON.stringify(DUAL)}); var s = freshSeq(${JSON.stringify(DSEQ)}, it, 1);
    var a1 = s.audioTracks[0].clips[0], a2 = s.audioTracks[1].clips[0], before = String(a2.nodeId);
    a2.end = T(8); a2.move(T(1)); var after = String(s.audioTracks[1].clips[0].nodeId);
    return JSON.stringify({ distinct: String(a1.nodeId) !== before, stable: before === after });`);
  return { ok: r.distinct && r.stable, observed: r };
});
await probe('item.media-duration-metadata', 'relied', 'Column.Intrinsic.MediaDuration reports the full 10s with an out mark at 4s', async () => {
  const r = await host(`${SETUP_LIB} var it = item(${JSON.stringify(BITS)}); it.setOutPoint(4, 4); var md = String(it.getProjectMetadata()); var m = md.match(/MediaDuration>([^<]+)</); var mark = it.getOutPoint(4).seconds; it.clearOutPoint(4);
    return JSON.stringify({ mediaDuration: m ? m[1] : null, mark: mark });`);
  return { ok: r.mediaDuration === '00:00:10:00' && r.mark === 4, observed: r };
});

// --- transitions / markers -------------------------------------------------------
await probe('qe.addTransition-atStart-flag', 'relied', 'addTransition(t, false, ...) on clip A lands at its end (the 5s cut)', async () => {
  const r = await host(`app.enableQE(); var s = __findSequence(${JSON.stringify(ab)}); var q = __qeSequenceOpening(s); var qt = q.getVideoTrackAt(0);
    var qc = __qeClipByIndex(q, 'video', 0, 0); qc.addTransition(qe.project.getVideoTransitionByName('Cross Dissolve'), false, '12', '0', 0.5, true, true);
    var at = __qeTransitionsAt(qt, 5); return JSON.stringify({ atCut: at.length, span: at.length ? [at[0].startSecs, at[0].endSecs] : null });`);
  await reset();
  return { ok: r.atCut === 1, observed: r };
});
await probe('dom.marker-end-and-colour', 'relied', 'Marker.end takes seconds; setColorByIndex sticks', async () => {
  const r = await host(`var s = __findSequence(${JSON.stringify(ab)}); var m = s.markers.createMarker(1); m.end = 2.5; m.setColorByIndex(3);
    var out = { end: m.end.seconds, colour: m.getColorByIndex() }; s.markers.deleteMarker(m); return JSON.stringify(out);`);
  return { ok: r.end === 2.5 && r.colour === 3, observed: r };
});

// --- known limits (good news if they change) ---------------------------------------
await probe('qe.setSpeed-miscalibrated', 'watch', 'QE setSpeed(2) yields 1.333x (speed tools undo and point to bake_speed_change)', async () => {
  const r = await host(`app.enableQE(); var s = __findSequence(${JSON.stringify(ab)}); var q = __qeSequenceOpening(s); var qc = __qeClipByIndex(q, 'video', 0, 1);
    qc.setSpeed(2, '', false, false, false); var x = s.videoTracks[0].clips[1]; var out = { speed: Number(x.getSpeed()), duration: x.end.seconds - x.start.seconds }; qe.project.undo(); return JSON.stringify(out);`);
  await reset();
  return { ok: Math.abs(r.speed - 2) > 0.02, observed: r };
});
await probe('dom.missing-apis', 'watch', 'getTimelineGaps, openInTimeline, a clip-gain parameter and a work-area setter are absent', async () => {
  const r = await host(`var s = __findSequence(${JSON.stringify(ab)}); var a = s.audioTracks[0].clips[0], gain = false;
    for (var i = 0; i < a.components.numItems; i++) for (var p = 0; p < a.components[i].properties.numItems; p++) if (/gain/i.test(String(a.components[i].properties[p].displayName))) gain = true;
    s.setWorkAreaInPoint(1); var wa = s.getWorkAreaInPoint();
    return JSON.stringify({ getTimelineGaps: typeof s.getTimelineGaps, openInTimeline: typeof s.openInTimeline, clipGainParam: gain, workAreaSettable: Number(wa) === 1 });`);
  return { ok: r.getTimelineGaps === 'undefined' && r.openInTimeline === 'undefined' && !r.clipGainParam && !r.workAreaSettable, observed: r };
});

await dropSequences([SEQ, DSEQ]);

/* ----------------------------------------------------------------------------- report */

const failed = results.filter((r) => r.kind === 'relied' && !r.ok);
const news = results.filter((r) => r.kind === 'watch' && !r.ok);
mkdirSync(OUT_DIR, { recursive: true });
const previous = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json')).sort().pop();
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const record = { ranAt: new Date().toISOString(), environment: env, probes: results };
const file = join(OUT_DIR, `${stamp}-${env.premiere.replace(/[^0-9.]/g, '')}.json`);
writeFileSync(file, JSON.stringify(record, null, 2) + '\n');

const changes = [];
if (previous) {
  try {
    const prev = JSON.parse(readFileSync(join(OUT_DIR, previous), 'utf8'));
    const before = new Map(prev.probes.map((p) => [p.id, p.ok]));
    for (const p of results) if (before.has(p.id) && before.get(p.id) !== p.ok) changes.push(`${p.id}: ${before.get(p.id) ? 'ok' : 'not ok'} -> ${p.ok ? 'ok' : 'not ok'}`);
    if (prev.environment?.premiere !== env.premiere) changes.unshift(`Premiere ${prev.environment?.premiere} -> ${env.premiere}`);
  } catch { /* unreadable previous run: no diff */ }
}

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify({ ...record, failed: failed.map((f) => f.id), news: news.map((n) => n.id), changes, file }, null, 2) + '\n');
} else {
  log(`\n${results.length} probes: ${results.length - failed.length - news.length} ok, ${failed.length} relied-on behaviour CHANGED, ${news.length} limitation(s) changed`);
  if (failed.length) log(`\n!! Tools built on these are now wrong — fix before trusting the server:\n${failed.map((f) => `   - ${f.id}: expected ${f.expect}`).join('\n')}`);
  if (news.length) log(`\nGood news to follow up (a limitation may have lifted):\n${news.map((n) => `   - ${n.id}: was "${n.expect}"`).join('\n')}`);
  if (changes.length) log(`\nSince the last run (${previous}):\n${changes.map((c) => `   - ${c}`).join('\n')}`);
  log(`\nrecorded: ${file}`);
}
await bridge.cleanup?.();
process.exit(failed.length ? 1 : 0);
