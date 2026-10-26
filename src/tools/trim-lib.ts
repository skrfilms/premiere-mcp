/**
 * ExtendScript trim primitives, measured rather than assumed.
 *
 * Established on Premiere 26.5.2 against a clip whose every frame encodes its own number as eight
 * black/white bars, read back from the composited program frame (capture_program_output):
 *
 *   TrackItem.inPoint = t   SLIPS: the source moves under a fixed timeline range; duration kept.
 *   TrackItem.start = t     moves the head edge AND the content with it; the source in-point stays.
 *   TrackItem.end = t       trims or extends the tail; the source stays put. Extending past the end
 *                           of the media is accepted and plays BLACK.
 *   TrackItem.outPoint = t  no visible effect at all, although its readback changes.
 *   TrackItem.move(t)       relative offset; moves only that item, not its linked partners.
 *
 * So a head trim that keeps the picture in place is inPoint += d then start += d; a ripple head
 * trim is inPoint += d then end -= d; a tail trim is end -= d. The old tools wrote inPoint/outPoint
 * and expected the timeline to follow, which is why they reported half-applied edits (and why
 * trim_clip reported "trimmed and verified" for an outPoint write that changed nothing).
 *
 * The inPoint/outPoint readbacks go stale after start/end writes, so verification reads start, end
 * and the inPoint this library itself wrote. Every check runs before the first write.
 */
export const TRIM_LIB = `
var __TPS = 254016000000;
function __TT(ticks) { var t = new Time(); t.ticks = String(Math.round(ticks)); return t; }
function __st(c) { return { start: Number(c.start.ticks), end: Number(c.end.ticks), inp: Number(c.inPoint.ticks) }; }
function __key(c) { var s = __st(c); return String(c.mediaType) + '|' + s.start + '|' + s.end + '|' + String(c.name); }
function __mediaEnd(c) {
  try { var o = c.projectItem.getOutPoint(); var v = Number(o.ticks); if (v > 0) return v; } catch (e) {}
  return null;
}
function __tracksOf(seq, c) { return String(c.mediaType) === 'Audio' ? seq.audioTracks : seq.videoTracks; }
function __trackOf(seq, c) {
  var tracks = null;
  try { tracks = __tracksOf(seq, c); } catch (eT) {}
  if (!tracks || typeof tracks.numTracks !== 'number') return null;
  var k = __key(c);
  for (var t = 0; t < tracks.numTracks; t++) {
    for (var i = 0; i < tracks[t].clips.numItems; i++) { if (__key(tracks[t].clips[i]) === k) return tracks[t]; }
  }
  return null;
}
function __withLinked(c) {
  var out = [c], seen = {}; seen[__key(c)] = true;
  try {
    var l = c.getLinkedItems();
    for (var i = 0; i < l.numItems; i++) { var k = __key(l[i]); if (!seen[k]) { seen[k] = true; out.push(l[i]); } }
  } catch (e) {}
  return out;
}
function __label(seq, c) {
  var tr = __trackOf(seq, c), tracks = __tracksOf(seq, c), n = '?';
  for (var t = 0; t < tracks.numTracks; t++) { if (tracks[t] === tr || (tr && tracks[t].name === tr.name)) { n = String(t + 1); break; } }
  return (String(c.mediaType) === 'Audio' ? 'A' : 'V') + n + ' "' + String(c.name) + '" at ' + (Number(c.start.ticks) / __TPS) + 's';
}
/*
 * Plan moving one edge of one item by d ticks (positive = later). Rolls an abutting neighbour on
 * the same track so the edit point moves without opening a gap or overlapping, exactly like
 * dragging an edit point with the rolling tool. Returns {ops:[...]} or {error}.
 */
function __planRoll(seq, c, edge, d) {
  var tpf = Number(seq.timebase) || 10584000000, half = tpf / 2;
  var s = __st(c), dur = s.end - s.start, track = __trackOf(seq, c), media = __mediaEnd(c);
  if (!track) return { error: 'Could not find the track holding ' + __label(seq, c) + '.' };
  var neighbour = null;
  for (var i = 0; i < track.clips.numItems; i++) {
    var o = track.clips[i]; if (__key(o) === __key(c)) continue;
    var os = __st(o);
    if (edge === 'tail' && Math.abs(os.start - s.end) < half) neighbour = o;
    if (edge === 'head' && Math.abs(os.end - s.start) < half) neighbour = o;
  }
  var ops = [];
  if (edge === 'tail') {
    var newEnd = s.end + d;
    if (newEnd - s.start < tpf) return { error: __label(seq, c) + ' would be shorter than one frame.' };
    if (d > 0 && media !== null && s.inp + (newEnd - s.start) > media + half) return { error: __label(seq, c) + ' has only ' + ((media - s.inp - dur) / __TPS) + 's of media after its out-point; extending it ' + (d / __TPS) + 's would play black.' };
    if (neighbour) {
      var ns = __st(neighbour);
      if (ns.end - (ns.start + d) < tpf) return { error: 'Rolling the edit would leave ' + __label(seq, neighbour) + ' shorter than one frame.' };
      if (d < 0 && ns.inp + d < -half) return { error: __label(seq, neighbour) + ' has only ' + (ns.inp / __TPS) + 's of media before its in-point, so the edit cannot roll ' + (-d / __TPS) + 's earlier.' };
      ops.push({ item: neighbour, kind: 'headInPlace', d: d, before: ns });
    } else if (d > 0) {
      for (var j = 0; j < track.clips.numItems; j++) { var q = track.clips[j]; if (__key(q) === __key(c)) continue; var qs = __st(q); if (qs.start < newEnd - half && qs.end > s.end + half) return { error: __label(seq, q) + ' is in the way of extending ' + __label(seq, c) + '.' }; }
    }
    ops.push({ item: c, kind: 'tail', d: d, before: s });
  } else {
    var newStart = s.start + d;
    if (s.end - newStart < tpf) return { error: __label(seq, c) + ' would be shorter than one frame.' };
    if (d < 0 && s.inp + d < -half) return { error: __label(seq, c) + ' has only ' + (s.inp / __TPS) + 's of media before its in-point, so it cannot start ' + (-d / __TPS) + 's earlier.' };
    if (newStart < 0) return { error: __label(seq, c) + ' cannot start before 0.' };
    if (neighbour) {
      var nb = __st(neighbour), nmedia = __mediaEnd(neighbour);
      if ((nb.end + d) - nb.start < tpf) return { error: 'Rolling the edit would leave ' + __label(seq, neighbour) + ' shorter than one frame.' };
      if (d > 0 && nmedia !== null && nb.inp + (nb.end + d - nb.start) > nmedia + half) return { error: __label(seq, neighbour) + ' has no media left to cover ' + (d / __TPS) + 's more.' };
      ops.push({ item: neighbour, kind: 'tail', d: d, before: nb });
    } else if (d < 0) {
      for (var m = 0; m < track.clips.numItems; m++) { var r = track.clips[m]; if (__key(r) === __key(c)) continue; var rs = __st(r); if (rs.end > newStart + half && rs.start < s.start - half) return { error: __label(seq, r) + ' is in the way of extending ' + __label(seq, c) + ' earlier.' }; }
    }
    ops.push({ item: c, kind: 'headInPlace', d: d, before: s });
  }
  return { ops: ops };
}
/* Apply planned ops, then verify each against the timeline. Returns an array of problems. */
/* Tolerance is half a frame: Premiere snaps edits to the frame grid. */
function __applyOps(ops, tol) {
  if (tol === undefined) tol = 1;
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i], b = op.before;
    if (op.kind === 'tail') op.item.end = __TT(b.end + op.d);
    else if (op.kind === 'headInPlace') { op.item.inPoint = __TT(b.inp + op.d); op.item.start = __TT(b.start + op.d); }
    else if (op.kind === 'rippleHead') { op.item.inPoint = __TT(b.inp + op.d); op.item.end = __TT(b.end - op.d); }
    else if (op.kind === 'set') {
      // Head first (in-place: the source in-point and the start move together), then the tail.
      if (op.to.start !== b.start) { op.item.inPoint = __TT(b.inp + (op.to.start - b.start)); op.item.start = __TT(op.to.start); }
      if (op.to.end !== b.end) op.item.end = __TT(op.to.end);
    }
  }
  var bad = [];
  for (var k = 0; k < ops.length; k++) {
    var p = ops[k], a = __st(p.item), w = p.before, wantStart = w.start, wantEnd = w.end, wantIn = w.inp;
    if (p.kind === 'tail') wantEnd = w.end + p.d;
    if (p.kind === 'headInPlace') { wantStart = w.start + p.d; wantIn = w.inp + p.d; }
    if (p.kind === 'rippleHead') { wantEnd = w.end - p.d; wantIn = w.inp + p.d; }
    if (p.kind === 'set') { wantStart = p.to.start; wantEnd = p.to.end; wantIn = w.inp + (p.to.start - w.start); }
    if (Math.abs(a.start - wantStart) > tol || Math.abs(a.end - wantEnd) > tol || Math.abs(a.inp - wantIn) > tol) {
      bad.push(String(p.item.name) + ': start ' + (a.start / __TPS) + 's (want ' + (wantStart / __TPS) + '), end ' + (a.end / __TPS) + 's (want ' + (wantEnd / __TPS) + '), in ' + (a.inp / __TPS) + 's (want ' + (wantIn / __TPS) + ')');
    }
  }
  return bad;
}
/* Put every op's item back to its before-state, last op first. Returns true when all read back. */
function __rollbackOps(ops, tol) {
  if (tol === undefined) tol = 1;
  for (var i = ops.length - 1; i >= 0; i--) {
    var b = ops[i].before, it = ops[i].item;
    try { it.inPoint = __TT(b.inp); } catch (e1) {}
    try { it.start = __TT(b.start); } catch (e2) {}
    try { it.end = __TT(b.end); } catch (e3) {}
  }
  for (var k = 0; k < ops.length; k++) {
    var a = __st(ops[k].item), w = ops[k].before;
    if (Math.abs(a.start - w.start) > tol || Math.abs(a.end - w.end) > tol || Math.abs(a.inp - w.inp) > tol) return false;
  }
  return true;
}
/* Everything that would move in a sync-locked ripple at \`at\`, and anything that blocks it. */
function __planRipple(seq, at, skipKeys) {
  var half = (Number(seq.timebase) || 10584000000) / 2, movers = [], blockers = [];
  var groups = [seq.videoTracks, seq.audioTracks];
  for (var g = 0; g < 2; g++) for (var t = 0; t < groups[g].numTracks; t++) {
    var tr = groups[g][t];
    for (var i = 0; i < tr.clips.numItems; i++) {
      var c = tr.clips[i]; if (skipKeys[__key(c)]) continue;
      var s = __st(c);
      if (s.start >= at - half) movers.push({ item: c, start: s.start });
      else if (s.end > at + half) blockers.push(__label(seq, c));
    }
  }
  movers.sort(function (a, b) { return a.start - b.start; });
  return { movers: movers, blockers: blockers };
}
function __applyRipple(movers, delta) {
  var off = __TT(delta), bad = [];
  if (delta > 0) movers = movers.slice().reverse();
  for (var i = 0; i < movers.length; i++) {
    movers[i].item.move(off);
    var now = Number(movers[i].item.start.ticks);
    if (Math.abs(now - (movers[i].start + delta)) > 1) bad.push(String(movers[i].item.name) + ' at ' + (movers[i].start / __TPS) + 's landed at ' + (now / __TPS) + 's');
  }
  return bad;
}
function __opsReport(ops) {
  var r = [];
  for (var i = 0; i < ops.length; i++) { var a = __st(ops[i].item); r.push({ clip: String(ops[i].item.name), mediaType: String(ops[i].item.mediaType), edit: ops[i].kind, deltaSecs: ops[i].d === undefined ? undefined : ops[i].d / __TPS, startSecs: a.start / __TPS, endSecs: a.end / __TPS, sourceInSecs: a.inp / __TPS }); }
  return r;
}
`;
