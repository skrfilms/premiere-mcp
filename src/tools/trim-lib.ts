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
// Identity by TrackItem.nodeId, which is unique per track item and survives start/end/in writes and
// move() (measured on 26.5.2). Keying by type+range+name made a dual-mono pair (A1 and A2 from one
// source, same name and range) one clip: the second was dropped from every linked group and left
// out of sync while the tool reported success.
function __key(c) {
  var id = null;
  try { id = c.nodeId; } catch (eId) {}
  if (id !== null && id !== undefined && String(id) !== '') return String(c.mediaType) + '#' + String(id);
  var s = __st(c); return String(c.mediaType) + '|' + s.start + '|' + s.end + '|' + String(c.name);
}
// The real length of the media, NOT ProjectItem.getOutPoint(): that is the bin item's out MARK, so
// a 10s file marked out at 4s refused every trim past 4s and mirrored reversal around the wrong
// point. Column.Intrinsic.MediaDuration in the project metadata keeps the full length regardless of
// marks (measured: 00:00:10:00 with the mark at 4s). The mark is only a fallback, and never wins
// when it is shorter.
function __mediaEnd(c) {
  var pi = null;
  try { pi = c.projectItem; } catch (eP) {}
  if (!pi) return null;
  var best = null;
  try {
    var md = String(pi.getProjectMetadata());
    var m = md.match(/MediaDuration>([^<]+)</);
    if (m) {
      var fps = null;
      try { fps = Number(pi.getFootageInterpretation().frameRate); } catch (eF) {}
      var probeSeq = { timebase: String(fps > 0 ? Math.round(__TPS / fps) : 10584000000) };
      var t = __timecodeToTicks(probeSeq, String(m[1]).replace(/^\\s+|\\s+$/g, ''));
      if (t !== null && Number(t) > 0) best = Number(t);
    }
  } catch (eM) {}
  try { var o = Number(pi.getOutPoint(4).ticks); if (o > 0 && (best === null || o > best)) best = o; } catch (eO) {}
  return best;
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
      // Free before fill: when this tail shrinks (d < 0) it must give up the space before the
      // neighbour's head moves into it, so the neighbour goes second.
      var nOp = { item: neighbour, kind: 'headInPlace', d: d, before: ns };
      if (d < 0) { ops.push({ item: c, kind: 'tail', d: d, before: s }); ops.push(nOp); return { ops: ops }; }
      ops.push(nOp);
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
      // Free before fill: when this head moves later (d > 0) it must vacate before the neighbour's
      // tail extends into the space, so the neighbour goes second.
      var tOp = { item: neighbour, kind: 'tail', d: d, before: nb };
      if (d > 0) { ops.push({ item: c, kind: 'headInPlace', d: d, before: s }); ops.push(tOp); return { ops: ops }; }
      ops.push(tOp);
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
// \`gapLo\` (optional): the ripple will pull clips that start at \`at\` back to \`gapLo\`. Anything on any
// track (other than the movers and the edited clips) that still occupies (gapLo, at) would be landed
// on, so it blocks too -- not only clips spanning \`at\`.
function __planRipple(seq, at, skipKeys, gapLo) {
  var half = (Number(seq.timebase) || 10584000000) / 2, movers = [], blockers = [];
  if (gapLo === undefined || gapLo === null) gapLo = at;
  var groups = [seq.videoTracks, seq.audioTracks];
  for (var g = 0; g < 2; g++) for (var t = 0; t < groups[g].numTracks; t++) {
    var tr = groups[g][t];
    for (var i = 0; i < tr.clips.numItems; i++) {
      var c = tr.clips[i]; if (skipKeys[__key(c)]) continue;
      var s = __st(c);
      if (s.start >= at - half) movers.push({ item: c, start: s.start });
      else if (s.end > gapLo + half) blockers.push(__label(seq, c));
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
/*
 * Reverse (or un-reverse) a clip and its linked partners, keeping the SAME source frames.
 * QE setSpeed(speed, '00:00:00:00', reverse, maintainPitch, false) flips the direction, but on
 * 26.5.2 it mirrors the source range around the media: a clip using source 0-5s of a 10s file,
 * reversed, played 9.96s down to 5s. Writing inPoint = mediaEnd - in - span afterwards restores
 * the clip's own frames (verified frame-exact: 4.96s down to 0). The same mirror undoes it.
 */
function __trackIndexOf(seq, c) {
  var tracks = __tracksOf(seq, c), k = __key(c);
  for (var t = 0; t < tracks.numTracks; t++) for (var i = 0; i < tracks[t].clips.numItems; i++) if (__key(tracks[t].clips[i]) === k) return t;
  return -1;
}
function __setReversed(seq, clip, reversed, maintainPitch) {
  var q = __qeSequenceOpening(seq);
  if (!q) return { error: 'QE could not address this sequence.' };
  var group = __withLinked(clip), report = [], problems = [];
  for (var g = 0; g < group.length; g++) {
    var it = group[g], isAudio = String(it.mediaType) === 'Audio';
    var was = null; try { was = Boolean(it.isSpeedReversed()); } catch (eR) {}
    if (was === Boolean(reversed)) { report.push({ clip: String(it.name), mediaType: String(it.mediaType), changed: false }); continue; }
    var s = __st(it), media = __mediaEnd(it), speed = 1;
    try { speed = Number(it.getSpeed()) || 1; } catch (eS) {}
    var ti = __trackIndexOf(seq, it);
    if (ti < 0) { problems.push('could not find the track of ' + __label(seq, it)); continue; }
    var qt = isAudio ? q.getAudioTrackAt(ti) : q.getVideoTrackAt(ti);
    var qc = __findQeClipByDomClip(qt, it);
    if (!qc) { problems.push('could not match ' + __label(seq, it) + ' in QE'); continue; }
    try { qc.setSpeed(speed, '00:00:00:00', Boolean(reversed), Boolean(maintainPitch), false); } catch (eSet) { problems.push(__label(seq, it) + ': ' + eSet); continue; }
    var span = Math.round((s.end - s.start) * speed);
    if (media !== null) it.inPoint = __TT(media - s.inp - span);
    var now = __st(it), is = null; try { is = Boolean(it.isSpeedReversed()); } catch (eN) {}
    if (is !== Boolean(reversed)) problems.push(__label(seq, it) + ' still reads reversed=' + is);
    if (Math.abs(now.start - s.start) > 1 || Math.abs(now.end - s.end) > 1) problems.push(__label(seq, it) + ' moved on the timeline');
    report.push({ clip: String(it.name), mediaType: String(it.mediaType), changed: true, reversed: is, sourceRangeSecs: [s.inp / __TPS, (s.inp + span) / __TPS] });
  }
  return { report: report, problems: problems };
}

/*
 * Remove a clip and its linked partners; with ripple, close the space on every track.
 * TrackItem.remove(ripple, alignToVideo) on 26.5.2 removes ONLY that item and never ripples,
 * whatever the arguments (measured: remove(true,true) on V1 left its audio and the gap). A ripple
 * that would pull clips on another track into material inside the removed range breaks sync, so
 * it is refused; lift (no ripple) always works.
 */
function __removeGroup(seq, clip, ripple) {
  var half = (Number(seq.timebase) || 10584000000) / 2;
  var group = __withLinked(clip), skip = {}, s0 = __st(clip), lo = s0.start, hi = s0.end;
  for (var i = 0; i < group.length; i++) { skip[__key(group[i])] = true; var gs = __st(group[i]); if (gs.start < lo) lo = gs.start; if (gs.end > hi) hi = gs.end; }
  var rip = null;
  if (ripple) {
    var tracks = [seq.videoTracks, seq.audioTracks], inside = [];
    for (var g = 0; g < 2; g++) for (var t = 0; t < tracks[g].numTracks; t++) {
      var tr = tracks[g][t];
      for (var c = 0; c < tr.clips.numItems; c++) { var o = tr.clips[c]; if (skip[__key(o)]) continue; var os = __st(o); if (os.start < hi - half && os.end > lo + half) inside.push(__label(seq, o)); }
    }
    if (inside.length) return { error: 'A ripple delete would pull later clips under material that sits inside the removed range on another track: ' + inside.join(', ') + '. Nothing was changed; use lift (no ripple), or clear those first.' };
    rip = __planRipple(seq, hi, skip);
    if (rip.blockers.length) return { error: 'A ripple at ' + (hi / __TPS) + 's would break sync: ' + rip.blockers.join(', ') + ' span that point. Nothing was changed.' };
  }
  var removed = [], problems = [];
  for (var k = 0; k < group.length; k++) {
    var it = group[k], label = __label(seq, it), tr2 = __trackOf(seq, it), key = __key(it), before = tr2 ? tr2.clips.numItems : null;
    try { it.remove(false, false); } catch (eR) { problems.push(label + ': ' + eR); continue; }
    var still = false;
    if (tr2) for (var q = 0; q < tr2.clips.numItems; q++) if (__key(tr2.clips[q]) === key) still = true;
    if (still) problems.push(label + ' is still on the timeline'); else removed.push(label);
  }
  var bad = [];
  if (ripple && !problems.length) bad = __applyRipple(rip.movers, -(hi - lo));
  return { removed: removed, problems: problems.concat(bad), rippledSecs: ripple ? (hi - lo) / __TPS : 0, clipsRippled: rip ? rip.movers.length : 0 };
}
/* Slip a clip and its linked partners by d ticks of source: timeline range fixed, content moves. */
function __slipGroup(seq, clip, d) {
  var group = __withLinked(clip), ops = [];
  for (var i = 0; i < group.length; i++) {
    var it = group[i], s = __st(it), media = __mediaEnd(it), span = s.end - s.start;
    if (s.inp + d < 0) return { error: __label(seq, it) + ' has only ' + (s.inp / __TPS) + 's of media before its in-point; slipping ' + (d / __TPS) + 's would run off the head.' };
    if (media !== null && s.inp + d + span > media + 1) return { error: __label(seq, it) + ' has only ' + ((media - s.inp - span) / __TPS) + 's of media after its out-point; slipping ' + (d / __TPS) + 's would play black.' };
    ops.push({ item: it, before: s });
  }
  var bad = [];
  for (var k = 0; k < ops.length; k++) {
    ops[k].item.inPoint = __TT(ops[k].before.inp + d);
    var a = __st(ops[k].item);
    if (Math.abs(a.inp - (ops[k].before.inp + d)) > 1 || a.start !== ops[k].before.start || a.end !== ops[k].before.end) bad.push(__label(seq, ops[k].item) + ' did not slip cleanly');
  }
  return { ops: ops, problems: bad };
}
/*
 * Slide: the clip moves by d with its content; the clip before it extends (or shrinks) its tail by d
 * and the clip after it trims (or extends) its head by d, so the program duration is unchanged.
 */
function __planSlide(seq, clip, d) {
  var tpf = Number(seq.timebase) || 10584000000, half = tpf / 2;
  var group = __withLinked(clip), ops = [], movers = [];
  for (var i = 0; i < group.length; i++) {
    var it = group[i], s = __st(it), tr = __trackOf(seq, it), prev = null, next = null;
    if (!tr) return { error: 'Could not find the track holding ' + __label(seq, it) + '.' };
    for (var c = 0; c < tr.clips.numItems; c++) { var o = tr.clips[c], os = __st(o); if (Math.abs(os.end - s.start) < half) prev = o; if (Math.abs(os.start - s.end) < half) next = o; }
    if (!prev || !next) return { error: 'A slide needs clips directly before and after ' + __label(seq, it) + ' on the same track.' };
    var ps = __st(prev), ns = __st(next), pm = __mediaEnd(prev);
    if (d > 0 && pm !== null && ps.inp + (ps.end - ps.start) + d > pm + half) return { error: __label(seq, prev) + ' has no media left to extend ' + (d / __TPS) + 's.' };
    if (d < 0 && (ps.end - ps.start) + d < tpf) return { error: __label(seq, prev) + ' would be shorter than one frame.' };
    if (d > 0 && (ns.end - ns.start) - d < tpf) return { error: __label(seq, next) + ' would be shorter than one frame.' };
    if (d < 0 && ns.inp + d < -half) return { error: __label(seq, next) + ' has no media before its in-point to extend ' + (-d / __TPS) + 's earlier.' };
    ops.push({ item: prev, kind: 'tail', d: d, before: ps });
    ops.push({ item: next, kind: 'headInPlace', d: d, before: ns });
    movers.push({ item: it, start: s.start });
  }
  return { ops: ops, movers: movers };
}
`;
