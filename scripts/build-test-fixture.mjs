#!/usr/bin/env node
/**
 * Build a rich fixture in the open scratch project so the sweep can actually exercise
 * tools that need real material.
 *
 * The first sweep could not test ~82 tools because it had nothing to point them at: one
 * clip on V1, no Lumetri, no markers, no second sequence, no SRT on disk. Those tools were
 * counted as "needs args", i.e. untested — not passing. This creates the material so they
 * become genuinely testable:
 *
 *   - extra clips on V1 and V2, plus linked audio on A1
 *   - a Lumetri Color instance on the first clip (8 Lumetri tools depend on this)
 *   - markers, including a Chapter marker pair (chapter/segment tools)
 *   - a second sequence (copy_markers_between_sequences, conform_sequence_settings, diff)
 *   - sequence in/out points (export-range tools)
 *   - a bin (bin tools)
 *   - an .srt file on disk (the SRT family is file-based, not host-based)
 *
 * Idempotent: re-running does not stack duplicates.
 */
import { PremiereProBridge } from '../dist/bridge/index.js';
import { writeFileSync } from 'node:fs';

// Any short video on disk works. Point PREMIERE_MCP_FIXTURE_PLATE at your own clip.
const PLATE = process.env.PREMIERE_MCP_FIXTURE_PLATE
  || '/tmp/premiere-mcp-bridge/fixture-plate.mp4';
const SRT_PATH = '/tmp/premiere-mcp-bridge/fixture-captions.srt';

const bridge = new PremiereProBridge();
await bridge.initialize();

const state = await bridge.executeScript(
  'return JSON.stringify({ name: String(app.project.name) });'
);
if (!/test|scratch|untitled/i.test(String(state.name))) {
  console.error(`refusing: "${state.name}" is not a scratch project`);
  process.exit(2);
}
console.log(`fixture target: ${state.name}\n`);

// An SRT on disk for the file-based caption tools. Written from Node rather than the host
// because those tools read the filesystem directly and never touch Premiere.
writeFileSync(SRT_PATH, [
  '1', '00:00:00,000 --> 00:00:01,500', 'First fixture caption line.', '',
  '2', '00:00:01,600 --> 00:00:03,000', 'Second fixture caption line.', '',
  '3', '00:00:03,100 --> 00:00:04,000', 'Third fixture caption line.', '',
].join('\n'));
console.log(`srt written: ${SRT_PATH}`);

const steps = [
  ['ensure a second video track and an audio track exist', `
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ok:false,error:'no active sequence'});
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    var addedV = 0, addedA = 0;
    while (seq.videoTracks.numTracks < 2) { qseq.addTracks(1, seq.videoTracks.numTracks, 0, 0, 0, 0, 0, 0); addedV++; if (addedV > 3) break; }
    while (seq.audioTracks.numTracks < 1) { qseq.addTracks(0, 0, 0, 1, seq.audioTracks.numTracks, 0, 0, 0); addedA++; if (addedA > 3) break; }
    return JSON.stringify({ok:true,videoTracks:seq.videoTracks.numTracks,audioTracks:seq.audioTracks.numTracks});
  `],

  ['place additional clips on V1 and V2', `
    var seq = app.project.activeSequence;
    var item = null;
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
      var c = root.children[i];
      if (c.type === 1 && String(c.name).indexOf('.mp4') >= 0) { item = c; break; }
    }
    if (!item) return JSON.stringify({ok:false,error:'no mp4 project item to duplicate'});
    var v1 = seq.videoTracks[0];
    var before = v1.clips.numItems;
    // Append after the existing content so nothing is overwritten.
    var t = new Time();
    t.ticks = String(v1.clips.numItems > 0 ? v1.clips[v1.clips.numItems-1].end.ticks : '0');
    if (v1.clips.numItems < 3) { try { v1.overwriteClip(item, t); } catch(e1) {} }
    var t2 = new Time(); t2.ticks = '0';
    var v2 = seq.videoTracks[1];
    if (v2 && v2.clips.numItems < 1) { try { v2.overwriteClip(item, t2); } catch(e2) {} }
    return JSON.stringify({ok:true,v1Before:before,v1After:v1.clips.numItems,v2:v2?v2.clips.numItems:0});
  `],

  ['apply Lumetri Color to the first V1 clip (8 Lumetri tools need it)', `
    var seq = app.project.activeSequence;
    var clip = seq.videoTracks[0].clips[0];
    if (!clip) return JSON.stringify({ok:false,error:'no clip on V1'});
    var has = false;
    for (var i = 0; i < clip.components.numItems; i++) {
      if (String(clip.components[i].displayName).indexOf('Lumetri') >= 0) { has = true; break; }
    }
    if (!has) {
      app.enableQE();
      var qclip = qe.project.getActiveSequence().getVideoTrackAt(0).getItemAt(0);
      var eff = qe.project.getVideoEffectByName('Lumetri Color');
      if (eff) qclip.addVideoEffect(eff);
    }
    var names = [];
    for (var j = 0; j < clip.components.numItems; j++) names.push(String(clip.components[j].displayName));
    var nowHas = false;
    for (var k = 0; k < names.length; k++) if (names[k].indexOf('Lumetri') >= 0) nowHas = true;
    return JSON.stringify({ok:nowHas,components:names});
  `],

  ['add markers including a Chapter pair', `
    var seq = app.project.activeSequence;
    var m = seq.markers;
    if (m.numMarkers < 3) {
      var a = m.createMarker(0.5); a.name = 'fixture_comment'; a.comments = 'TODO check this beat'; a.type = 'Comment';
      var b = m.createMarker(1.5); b.name = 'Chapter One'; b.type = 'Chapter';
      var c = m.createMarker(3.0); c.name = 'Chapter Two'; c.type = 'Chapter';
    }
    return JSON.stringify({ok:true,markerCount:m.numMarkers});
  `],

  ['set sequence in/out points (export-range tools need them)', `
    var seq = app.project.activeSequence;
    seq.setInPoint(0);
    seq.setOutPoint(2);
    return JSON.stringify({ok:true,inSecs:seq.getInPoint().seconds,outSecs:seq.getOutPoint().seconds});
  `],

  ['create a bin', `
    var root = app.project.rootItem;
    var found = null;
    for (var i = 0; i < root.children.numItems; i++) {
      if (String(root.children[i].name) === 'fixture_bin') { found = root.children[i]; break; }
    }
    if (!found) found = root.createBin('fixture_bin');
    return JSON.stringify({ok:!!found,binName:found?String(found.name):null});
  `],

  ['create a SECOND sequence (cross-sequence tools need two)', `
    var seqs = app.project.sequences;
    var exists = null;
    for (var i = 0; i < seqs.numSequences; i++) {
      if (String(seqs[i].name) === 'fixture_seq_b') { exists = seqs[i]; break; }
    }
    if (!exists) {
      var src = app.project.activeSequence;
      // Duplicating inherits the source's exact settings, which is what the conform and
      // diff tools want to compare against.
      src.projectItem.select();
      app.enableQE();
      qe.project.getActiveSequence().makeCurrent();
      var dup = null;
      try { dup = src.clone(); } catch(e) {}
      // clone() names it "<name> Copy"; rename so the fixture is findable.
      var seqs2 = app.project.sequences;
      for (var j = 0; j < seqs2.numSequences; j++) {
        var nm = String(seqs2[j].name);
        if (nm.indexOf('Copy') >= 0) { seqs2[j].projectItem.name = 'fixture_seq_b'; exists = seqs2[j]; break; }
      }
    }
    return JSON.stringify({ok:!!exists,sequenceCount:app.project.sequences.numSequences,name:exists?String(exists.name):null});
  `],
];

const results = [];
for (const [label, script] of steps) {
  process.stdout.write(`- ${label} ... `);
  try {
    const r = await bridge.executeScript(script);
    const ok = r && (r.ok === true || r.success === true);
    console.log(ok ? 'ok' : `NOT OK: ${JSON.stringify(r).slice(0, 160)}`);
    results.push({ label, ok, detail: r });
  } catch (e) {
    console.log(`FAILED: ${e.message.slice(0, 120)}`);
    results.push({ label, ok: false, error: e.message });
  }
}

// Report the final shape so the harness (and a human) can see what is available.
const summary = await bridge.executeScript(`
  var seq = app.project.activeSequence;
  var o = { sequences: app.project.sequences.numSequences, activeSequence: seq ? String(seq.name) : null };
  if (seq) {
    o.videoTracks = seq.videoTracks.numTracks;
    o.audioTracks = seq.audioTracks.numTracks;
    o.v1Clips = seq.videoTracks.numTracks > 0 ? seq.videoTracks[0].clips.numItems : 0;
    o.v2Clips = seq.videoTracks.numTracks > 1 ? seq.videoTracks[1].clips.numItems : 0;
    o.a1Clips = seq.audioTracks.numTracks > 0 ? seq.audioTracks[0].clips.numItems : 0;
    o.markers = seq.markers.numMarkers;
    var comps = [];
    if (o.v1Clips > 0) { var c = seq.videoTracks[0].clips[0];
      for (var i = 0; i < c.components.numItems; i++) comps.push(String(c.components[i].displayName)); }
    o.v1Clip0Components = comps;
  }
  return JSON.stringify(o);
`);

console.log('\n=== FIXTURE STATE ===');
console.log(JSON.stringify(summary, null, 2));
console.log(`\nsrt fixture: ${SRT_PATH}`);
process.exit(0);
