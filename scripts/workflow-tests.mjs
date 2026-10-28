#!/usr/bin/env node
/**
 * Workflow tests: real editing jobs as chains of MCP tools, checked by independent evidence.
 *
 * The live sweep proves each tool on its own. A job like "v002 of the comp landed, swap it in"
 * is a chain of five to fifteen calls, and chains break where single tools do not: an id that
 * changes under a later step, an effect that does not survive a swap, a sequence that moves the
 * active target. Each workflow here drives the tools the way an assistant would, and asserts on
 * what Premiere actually holds and renders — ExtendScript readbacks, captured program frames
 * (each version is a different colour), measured audio levels — never on a tool's own report.
 *
 * Runs only against the scratch project. Media: .scratch/media/workflow/ (see the ffmpeg recipe
 * in docs or regenerate with scripts/workflow-media.sh).
 *
 * Usage: PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/workflow-tests.mjs [W1 W2 ...]
 */
process.env.PREMIERE_MCP_PROFILE ||= 'all';
process.env.PREMIERE_MCP_NO_PREFS_WRITE = '1';
const { PremiereProBridge } = await import('../dist/bridge/index.js');
const { PremiereProTools } = await import('../dist/tools/index.js');
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireScratchProject } from './lib/require-scratch-project.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(ROOT, '.scratch', 'media', 'workflow');
const OUT = join(ROOT, '.scratch', 'workflow-out');
const FF = process.env.PREMIERE_MCP_FFMPEG_CMD || 'ffmpeg';
mkdirSync(OUT, { recursive: true });

const bridge = new PremiereProBridge();
await bridge.initialize();
const tools = new PremiereProTools(bridge);
await requireScratchProject(bridge, 'workflow-tests');

// ---------------------------------------------------------------------------------- helpers
const results = [];
let current = null;
function workflow(name) { current = { name, steps: [], ok: true }; results.push(current); console.log(`\n== ${name}`); }
class Abort extends Error {}
function stopped(e) { if (!(e instanceof Abort)) check('no unexpected error in the workflow script', false, String(e && e.stack || e).slice(0, 300)); console.log('  (stopped here)'); }
/** A failed link in the chain: record it and stop this workflow (later steps would act on the wrong thing). */
function must(label, ok, detail) { if (!check(label, ok, detail)) throw new Abort(label); }
function check(label, ok, detail) {
  current.steps.push({ label, ok: !!ok, detail });
  if (!ok) current.ok = false;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 220) : ''}`);
  return !!ok;
}
async function tool(name, args) {
  const r = await tools.executeTool(name, args);
  return r && r.data && r.success !== false && r.tool ? { success: true, ...r.data } : r;
}
async function host(body) { return bridge.executeScript(body); }
const q = (v) => JSON.stringify(v);

async function itemByName(name) {
  const r = await host(`(function(){ var hit=null; function w(it){ for(var i=0;i<it.children.numItems && !hit;i++){ var c=it.children[i]; if(String(c.name)===${q(name)}) hit=c; else if(c.type===2) w(c);} } w(app.project.rootItem); return JSON.stringify({ id: hit ? String(hit.nodeId) : null }); })();`);
  return r.id;
}
async function seqByName(name) {
  const r = await host(`(function(){ for(var i=app.project.sequences.numSequences-1;i>=0;i--){ var s=app.project.sequences[i]; if(String(s.name)===${q(name)}) return JSON.stringify({id:String(s.sequenceID)}); } return JSON.stringify({id:null}); })();`);
  return r.id;
}
/** Everything about V1 an editor would care survives a swap: timing, source range, effect values. */
async function v1(seqId) {
  return host(`(function(){
    var s=__findSequence(${q(seqId)}); var t=s.videoTracks[0]; var out=[];
    for(var i=0;i<t.clips.numItems;i++){ var c=t.clips[i]; var o={ id:String(c.nodeId), name:String(c.name), start:c.start.seconds, end:c.end.seconds, inPoint:c.inPoint.seconds, media:String(c.projectItem.getMediaPath()).split('/').pop(), comps:[] };
      for(var k=0;k<c.components.numItems;k++){ var m=c.components[k]; var e={ name:String(m.displayName) };
        for(var p=0;p<m.properties.numItems;p++){ var pr=m.properties[p]; var dn=String(pr.displayName); if(dn==='Scale'||dn==='Exposure'){ try{ e[dn]=Number(pr.getValue()); }catch(x){} } }
        o.comps.push(e); }
      out.push(o); }
    return JSON.stringify({ clips: out });
  })();`);
}
async function frameAt(seqId, t, tag) {
  const p = join(OUT, `${tag}.png`);
  // Premiere loads relinked or newly placed media asynchronously: a frame rendered straight away
  // can be black. Retry a few times before believing it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await tool('capture_program_output', { sequenceId: seqId, time: t, format: 'png', outputPath: p });
    if (!(r && r.success !== false && existsSync(p))) return null;
    if (hue(meanRgb(p)) !== 'black') return p;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return p;
}
/** Mean RGB of the frame's centre band (the version colour; the text is excluded by averaging). */
function meanRgb(png) {
  const r = spawnSync(FF, ['-v', 'error', '-i', png, '-vf', 'crop=iw/3:ih/6:0:0,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  const b = r.stdout; return b && b.length >= 3 ? [b[0], b[1], b[2]] : null;
}
/** Which colour dominates: the renders are red/blue (SH010 v1/v2) and green/orange (SH020 v1/v2). */
function hue(rgb) {
  if (!rgb) return null;
  const [r, g, b] = rgb;
  if (r + g + b < 30) return 'black';
  if (b > r && b > g) return 'blue';
  if (g > r && g > b) return 'green';
  if (r > g * 1.6 && r > b * 1.6) return 'red';
  return 'orange';
}
function loudness(file, from, dur) {
  const r = spawnSync(FF, ['-hide_banner', '-ss', String(from), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: ([-0-9.]+) dB/.exec(r.stderr || ''); return m ? Number(m[1]) : null;
}

const wanted = new Set(process.argv.slice(2));
const run = (id) => wanted.size === 0 || wanted.has(id);

// ------------------------------------------------------------------- W1: version up a shot
if (run('W1')) try {
  workflow('W1  v002 of SH010 landed: swap it in, keep the cut, the grade and the reframe');
  for (const f of ['SH010_comp_v001.mp4', 'SH020_comp_v001.mp4']) {
    const r = await tool('import_media', { filePath: join(MEDIA, f), binName: 'wf_renders' });
    must(`import ${f}`, r?.success !== false, r?.error);
  }
  const sh010v1 = await itemByName('SH010_comp_v001.mp4');
  const sh020v1 = await itemByName('SH020_comp_v001.mp4');
  const seqR = await tool('create_sequence_from_clips', { projectItemIds: [sh010v1, sh020v1], name: 'wf_edit' });
  const seq = seqR?.sequenceId || await seqByName('wf_edit');
  must('build the edit from the two shots', !!seq, seqR?.error);
  let st = await v1(seq);
  const shot = st.clips?.[0];
  must('SH010 is first on V1', shot && /SH010/.test(shot.media), st.clips?.map((c) => c.media));
  const tr = await tool('trim_clip', { clipId: shot.id, inPoint: 1, outPoint: 4 });
  check('trim SH010 to source 1s-4s', tr?.success !== false, tr?.error);
  const cc = await tool('color_correct', { clipId: shot.id, exposure: 0.5 });
  check('grade it (exposure +0.5)', cc?.success !== false, cc?.error);
  const sc = await tool('set_clip_scale', { clipId: shot.id, value: 120, sequenceId: seq });
  check('reframe it (scale 120)', sc?.success !== false, sc?.error);
  st = await v1(seq);
  const before = st.clips[0];
  const lum = (c) => c.comps.find((x) => x.name === 'Lumetri Color')?.Exposure;
  const mot = (c) => c.comps.find((x) => x.name === 'Motion')?.Scale;
  const f1 = await frameAt(seq, before.start + 0.5, 'w1-before');
  check('before the swap the program shows v001 (red)', hue(meanRgb(f1)) === 'red', meanRgb(f1));

  const imp = await tool('import_media', { filePath: join(MEDIA, 'SH010_comp_v002.mp4'), binName: 'wf_renders' });
  must('import SH010 v002', imp?.success !== false, imp?.error);
  const sh010v2 = await itemByName('SH010_comp_v002.mp4');
  const sw = await tool('replace_clip', { clipId: before.id, newProjectItemId: sh010v2, preserveEffects: true });
  check('swap v001 -> v002 on the timeline', sw?.success !== false, sw?.error);
  st = await v1(seq);
  const after = st.clips.find((c) => /SH010/.test(c.media));
  check('the clip now plays v002', after && after.media === 'SH010_comp_v002.mp4', after?.media);
  check('cut timing unchanged', after && Math.abs(after.start - before.start) < 0.01 && Math.abs(after.end - before.end) < 0.01, { before: [before.start, before.end], after: after && [after.start, after.end] });
  check('source in point unchanged', after && Math.abs(after.inPoint - before.inPoint) < 0.01, { before: before.inPoint, after: after?.inPoint });
  check('grade survived', after && lum(after) === lum(before), { before: lum(before), after: after && lum(after) });
  check('reframe survived', after && mot(after) === mot(before), { before: mot(before), after: after && mot(after) });
  const f2 = await frameAt(seq, before.start + 0.5, 'w1-after');
  check('after the swap the program shows v002 (blue)', hue(meanRgb(f2)) === 'blue', meanRgb(f2));
  // The neighbour must be untouched: an earlier version of the swap slid a clip across SH020 and
  // left everything after it rendering black.
  const nb = st.clips.find((c) => /SH020/.test(c.media));
  const f3 = await frameAt(seq, (nb.start + nb.end) / 2, 'w1-neighbour');
  check('the next shot still renders (SH020 v001, green)', hue(meanRgb(f3)) === 'green', meanRgb(f3));
} catch (e) { stopped(e); }

// ------------------------------------------------------------------- W1b: version up by relink
if (run('W1b')) try {
  workflow('W1b SH020 v002 landed: relink the project item, the timeline clip keeps everything');
  const seq = await seqByName('wf_edit');
  must('the edit from W1 exists', !!seq);
  let st = await v1(seq);
  const shot = st.clips.find((c) => /SH020/.test(c.media));
  must('SH020 is on V1', !!shot, st.clips.map((c) => c.media));
  await tool('trim_clip', { clipId: shot.id, inPoint: 1, outPoint: 3 });
  await tool('color_correct', { clipId: shot.id, exposure: 0.7 });
  await tool('set_clip_scale', { clipId: shot.id, value: 130, sequenceId: seq });
  st = await v1(seq);
  const before = st.clips.find((c) => c.id === shot.id);
  const item = await itemByName('SH020_comp_v001.mp4');
  const r = await tool('replace_clip_media', { projectItemId: item, newFilePath: join(MEDIA, 'SH020_comp_v002.mp4') });
  check('relink SH020 to v002', r?.success !== false, r?.error);
  check('the bin item is renamed to the new file', r?.item === 'SH020_comp_v002.mp4', r?.item);
  st = await v1(seq);
  const after = st.clips.find((c) => c.id === shot.id);
  const lum = (c) => c?.comps.find((x) => x.name === 'Lumetri Color')?.Exposure;
  const mot = (c) => c?.comps.find((x) => x.name === 'Motion')?.Scale;
  check('same timeline clip, now playing v002', after?.media === 'SH020_comp_v002.mp4', after?.media);
  check('cut and source range unchanged', after && after.start === before.start && after.end === before.end && after.inPoint === before.inPoint, { before, after });
  check('grade and reframe unchanged', lum(after) === lum(before) && mot(after) === mot(before), { exposure: lum(after), scale: mot(after) });
  const f = await frameAt(seq, (after.start + after.end) / 2, 'w1b-after');
  check('the program shows v002 (orange)', hue(meanRgb(f)) === 'orange', meanRgb(f));
} catch (e) { stopped(e); }

// ------------------------------------------------------------------- W2: review reel of latest
if (run('W2')) try {
  workflow('W2  review reel: every shot at its latest version, with burn-ins');
  const seq = await seqByName('wf_edit');
  must('the edit from W1 exists', !!seq);
  // The assistant's job: for each shot on V1, find the newest version on disk and swap to it.
  const imp = await tool('import_media', { filePath: join(MEDIA, 'SH020_comp_v002.mp4'), binName: 'wf_renders' });
  check('import SH020 v002 (the newest SH020)', imp?.success !== false, imp?.error);
  let st = await v1(seq);
  for (const c of st.clips) {
    const m = /^(SH\d+)_comp_v(\d+)\.mp4$/.exec(c.media); if (!m) continue;
    const latest = `${m[1]}_comp_v002.mp4`;
    if (c.media === latest) continue;
    const id = await itemByName(latest);
    const r = await tool('replace_clip', { clipId: c.id, newProjectItemId: id, preserveEffects: true });
    check(`bring ${m[1]} up to v002`, r?.success !== false, r?.error);
  }
  st = await v1(seq);
  check('every shot on V1 is at v002', st.clips.length >= 2 && st.clips.every((c) => /_v002\.mp4$/.test(c.media)), st.clips.map((c) => c.media));
  const reel = await tool('assemble_review_reel', { sequenceIds: [seq], reelName: 'wf_reel', handles: 0 });
  const reelId = reel?.reelSequenceId || reel?.sequenceId || await seqByName('wf_reel');
  check('assemble the reel', reel?.success !== false && !!reelId, reel?.error);
  if (reelId) {
    // assemble_review_reel takes SEQUENCES: each becomes one nested clip on the reel.
    const rs = await v1(reelId);
    check('the reel holds the edit (one nested clip per sequence)', rs.clips?.length === 1, rs.clips?.map((c) => c.name));
    const b = await tool('timecode_burn_in', { sequenceId: reelId, trackIndex: 0, clipIndex: 0 });
    check('burn in timecode on the reel', b?.success !== false, b?.error);
    const r2 = await v1(reelId);
    check('the reel clip carries the burn-in effect', r2.clips[0]?.comps.some((x) => /Timecode|Burn/i.test(x.name)), r2.clips[0]?.comps.map((x) => x.name));
    // The edit's shots, at their times inside the reel (handles 0: the nest starts at 0).
    const ed = await v1(seq);
    const sh010 = ed.clips.find((c) => /SH010/.test(c.media)), sh020 = ed.clips.find((c) => /SH020/.test(c.media));
    const fA = await frameAt(reelId, (sh010.start + sh010.end) / 2, 'w2-reel-sh010');
    const fB = await frameAt(reelId, (sh020.start + sh020.end) / 2, 'w2-reel-sh020');
    check('in the reel SH010 renders at v002 (blue)', hue(meanRgb(fA)) === 'blue', meanRgb(fA));
    check('in the reel SH020 renders at v002 (orange)', hue(meanRgb(fB)) === 'orange', meanRgb(fB));
  }
} catch (e) { stopped(e); }

// ------------------------------------------------------------------- W3: captions
if (run('W3')) try {
  workflow('W3  captions: SRT in, on the timeline, rendering');
  const seq = await seqByName('wf_edit');
  const srt = join(OUT, 'wf_captions.srt');
  writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,000\nTHIS IS THE FIRST LINE\n\n2\n00:00:02,500 --> 00:00:04,000\nAND THIS IS THE SECOND\n');
  await tool('set_active_sequence', { sequenceId: seq });
  const imp = await tool('import_media', { filePath: srt, binName: 'wf_renders' });
  check('import the SRT', imp?.success !== false, imp?.error);
  const srtId = await itemByName('wf_captions.srt');
  const cap = await tool('create_caption_track', { sequenceId: seq, projectItemId: srtId });
  check('put it on a caption track', cap?.success !== false, cap?.error);
  const withCap = await frameAt(seq, 1.0, 'w3-caption');
  const noCap = await frameAt(seq, 2.25, 'w3-nocaption');
  // Compare the lower sixth of the frame with and without a cue: the background there is flat,
  // so any caption text makes the two bands differ (PSNR well below "identical").
  const band = (png, out) => { spawnSync(FF, ['-v', 'error', '-y', '-i', png, '-vf', 'crop=iw:ih/6:0:ih*5/6', out]); return out; };
  const a = band(withCap, join(OUT, 'w3-band-cue.png')), b = band(noCap, join(OUT, 'w3-band-gap.png'));
  const r = spawnSync(FF, ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /average:(inf|[0-9.]+)/.exec(r.stderr || '');
  const db = m ? (m[1] === 'inf' ? 99 : Number(m[1])) : null;
  check('the caption renders (lower third differs during a cue)', db !== null && db < 35, { psnrDb: db });
} catch (e) { stopped(e); }

// ------------------------------------------------------------------- W4: audio pass
if (run('W4')) try {
  workflow('W4  audio pass: music under dialogue, loudness, stems');
  const seq = await seqByName('wf_edit');
  for (const f of ['music_bed.m4a', 'dialogue.m4a']) {
    const r = await tool('import_media', { filePath: join(MEDIA, f), binName: 'wf_renders' });
    check(`import ${f}`, r?.success !== false, r?.error);
  }
  const musicId = await itemByName('music_bed.m4a');
  const dlgId = await itemByName('dialogue.m4a');
  // Audio-only items go to audio tracks; place through the host and record where they landed.
  const placed = await host(`(function(){
    var s=__findSequence(${q(seq)}); while(s.audioTracks.numTracks<4){ app.enableQE(); qe.project.getActiveSequence().addTracks(0,0,0,1,s.audioTracks.numTracks,0,0,0); }
    var m=__findProjectItem(${q(musicId)}), d=__findProjectItem(${q(dlgId)});
    var t0=new Time(); t0.seconds=0; s.audioTracks[3].overwriteClip(m, t0);
    var t1=new Time(); t1.seconds=1; s.audioTracks[2].overwriteClip(d, t1);
    return JSON.stringify({ music: String(s.audioTracks[3].clips[0].nodeId), dialogue: String(s.audioTracks[2].clips[0].nodeId) });
  })();`);
  check('music on A4, dialogue on A3 at 1s', placed?.music && placed?.dialogue, placed);
  const duck = await tool('setup_ducking', { clipId: placed.music, baseDb: 0, duckingWindows: [{ startTime: 1, endTime: 5, duckedDb: -18 }], fadeSeconds: 0.25 });
  check('duck the music under the dialogue', duck?.success !== false, duck?.error);
  const stems = await tool('stem_export', { sequenceId: seq, trackIndices: [2, 3], outputDir: join(OUT, 'stems') });
  check('export dialogue and music stems', stems?.success !== false, stems?.error);
  const music = join(OUT, 'stems', 'stem_A4.wav');
  if (existsSync(music)) {
    const open = loudness(music, 0.1, 0.6), ducked = loudness(music, 2, 2);
    check('music is at least 10 dB lower under the dialogue', open !== null && ducked !== null && open - ducked >= 10, { open, ducked });
  } else check('music stem written', false, music);
  const norm = await tool('normalize_loudness', { projectItemId: dlgId, targetLufs: -16, outputPath: join(OUT, 'dialogue_-16LUFS.m4a') });
  check('normalize the dialogue to -16 LUFS', norm?.success !== false, norm?.error);
  if (existsSync(join(OUT, 'dialogue_-16LUFS.m4a'))) {
    const r = spawnSync(FF, ['-hide_banner', '-i', join(OUT, 'dialogue_-16LUFS.m4a'), '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /I:\s+([-0-9.]+) LUFS/.exec((r.stderr || '').split('Summary:').pop() || '');
    check('the file measures -16 LUFS (±1)', m && Math.abs(Number(m[1]) + 16) <= 1, m && m[1]);
  }
} catch (e) { stopped(e); }

// ------------------------------------------------------------------- summary
console.log('\n================ WORKFLOWS ================');
for (const w of results) console.log(`${w.ok ? 'PASS' : 'FAIL'}  ${w.name}  (${w.steps.filter((s) => s.ok).length}/${w.steps.length} steps)`);
writeFileSync(join(OUT, 'workflow-results.json'), JSON.stringify(results, null, 2));
process.exit(results.every((w) => w.ok) ? 0 : 1);
