/**
 * Timeline state: what a sequence holds, cheap enough to read around every edit.
 *
 * Two jobs rest on it. "Undo my last call": Premiere's undo is one step, and many tools here take
 * five to twenty, so revert_last_call undoes step by step until the sequence is back to the state
 * recorded before the call (and redoes forward again if it never gets there). "What changed": the
 * user edits by hand between calls, and the assistant's clip ids go stale without anything saying
 * so; what_changed diffs the sequence against the state recorded after the assistant's last edit.
 *
 * The state string and its hash are built in ExtendScript, so the undo loop can compare without a
 * round trip per step. The hash also covers the project's sequence and item counts, so an edit
 * somewhere else (which Premiere's single undo stack would undo first) is noticed.
 */

export interface ClipState { id: string; track: string; name: string; start: number; end: number; inPoint: number }
export interface TimelineState {
  sequenceId: string;
  sequenceName: string;
  hash: string;
  tracks: { video: number; audio: number };
  clips: ClipState[];
  markers: number;
  project: { sequences: number; items: number };
  capturedAt: string;
}

/**
 * ExtendScript (ES3) helpers defining __tlState(seq) -> { str, hash, ... }. The string is what the
 * hash covers: every clip's track, name, start, end and in point in ticks, marker count and
 * project counts. Ticks, not seconds, so float formatting cannot make equal states differ.
 */
export const STATE_HELPERS = `
  function __tlHash(s) { var h = 5381; for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(16); }
  function __tlCount(it) { var n = 0; try { for (var i = 0; i < it.children.numItems; i++) { n++; var c = it.children[i]; if (c.type === 2) n += __tlCount(c); } } catch (e) {} return n; }
  function __tlState(seq, withClips) {
    var parts = [], clips = [];
    var kinds = [['V', seq.videoTracks], ['A', seq.audioTracks]];
    for (var k = 0; k < 2; k++) {
      var trs = kinds[k][1];
      for (var t = 0; t < trs.numTracks; t++) {
        var tr = trs[t];
        for (var i = 0; i < tr.clips.numItems; i++) {
          var c = tr.clips[i], label = kinds[k][0] + (t + 1);
          parts.push(label + ':' + c.name + '@' + c.start.ticks + '-' + c.end.ticks + '/' + c.inPoint.ticks);
          if (withClips) clips.push({ id: String(c.nodeId), track: label, name: String(c.name), start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds });
        }
      }
    }
    var markers = 0; try { markers = seq.markers.numMarkers; } catch (e) {}
    var seqs = app.project.sequences.numSequences, items = __tlCount(app.project.rootItem);
    var str = parts.join('|') + '#m' + markers + '#v' + seq.videoTracks.numTracks + '#a' + seq.audioTracks.numTracks + '#s' + seqs + '#i' + items;
    return { str: str, hash: __tlHash(str), sequenceId: String(seq.sequenceID), sequenceName: String(seq.name),
      tracks: { video: seq.videoTracks.numTracks, audio: seq.audioTracks.numTracks }, clips: clips, markers: markers, project: { sequences: seqs, items: items } };
  }
  function __tlSeq(id) { if (id) { try { var s = __findSequence(id); if (s) return s; } catch (e) {} } return app.project.activeSequence; }
`;

/** Script returning the TimelineState of a sequence (or the active one). */
export function captureScript(sequenceId?: string): string {
  return `
    try {
      ${STATE_HELPERS}
      var seq = __tlSeq(${JSON.stringify(sequenceId ?? '')});
      if (!seq) return JSON.stringify({ success: false, error: 'No sequence' });
      var st = __tlState(seq, true);
      return JSON.stringify({ success: true, sequenceId: st.sequenceId, sequenceName: st.sequenceName, hash: st.hash, tracks: st.tracks, clips: st.clips, markers: st.markers, project: st.project });
    } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
  `;
}

/**
 * Script that undoes until the sequence hashes to `targetHash`, at most maxSteps. If it never
 * matches it redoes until the state is back where it started, so a failed revert leaves things as
 * they were.
 */
export function revertScript(sequenceId: string, targetHash: string, maxSteps: number): string {
  return `
    try {
      ${STATE_HELPERS}
      app.enableQE();
      var seq = __tlSeq(${JSON.stringify(sequenceId)});
      if (!seq) return JSON.stringify({ success: false, error: 'The sequence is gone' });
      // Undo and redo can switch the active sequence; put it back however this ends.
      var wasActive = app.project.activeSequence ? String(app.project.activeSequence.sequenceID) : null;
      function __tlReactivate() { try { if (wasActive) app.project.openSequence(wasActive); } catch (e) {} }
      var target = ${JSON.stringify(targetHash)}, steps = 0, start = __tlState(seq, false).hash, hit = start === target;
      while (!hit && steps < ${Math.max(1, Math.floor(maxSteps))}) {
        qe.project.undo(); steps++;
        seq = __tlSeq(${JSON.stringify(sequenceId)});
        if (!seq) break;
        hit = __tlState(seq, false).hash === target;
      }
      if (hit) { __tlReactivate(); return JSON.stringify({ success: true, undoSteps: steps }); }
      // Redo back to where this started, by state, not by count: undo past the bottom of the
      // history is a no-op, and redoing as many times would re-apply edits undone earlier.
      var r = 0, back = __tlSeq(${JSON.stringify(sequenceId)});
      while (r < steps && back && __tlState(back, false).hash !== start) { qe.project.redo(); r++; back = __tlSeq(${JSON.stringify(sequenceId)}); }
      __tlReactivate();
      var endHash = back ? __tlState(back, false).hash : null;
      return JSON.stringify({ success: false, undoSteps: steps, redoneSteps: r, restored: endHash === start, restoredToAfter: endHash });
    } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
  `;
}

export interface StateDiff {
  changed: boolean;
  added: ClipState[];
  removed: ClipState[];
  moved: Array<{ id: string; name: string; track: string; from: { track: string; start: number; end: number; inPoint: number }; to: { track: string; start: number; end: number; inPoint: number } }>;
  renamed: Array<{ id: string; from: string; to: string }>;
  tracks?: { from: TimelineState['tracks']; to: TimelineState['tracks'] };
  markers?: { from: number; to: number };
  project?: { from: TimelineState['project']; to: TimelineState['project'] };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** What differs between two states of the same sequence, clip by clip (by clip id). */
export function diffStates(a: TimelineState, b: TimelineState): StateDiff {
  const before = new Map(a.clips.map((c) => [`${c.id}|${c.track}`, c]));
  const after = new Map(b.clips.map((c) => [`${c.id}|${c.track}`, c]));
  // Clip ids survive a move between tracks only in name; match leftovers by id alone.
  const byIdBefore = new Map<string, ClipState[]>();
  for (const c of a.clips) (byIdBefore.get(c.id) ?? byIdBefore.set(c.id, []).get(c.id)!).push(c);
  const out: StateDiff = { changed: a.hash !== b.hash, added: [], removed: [], moved: [], renamed: [] };
  const usedBefore = new Set<string>();
  for (const [k, c] of after) {
    const p = before.get(k) ?? (byIdBefore.get(c.id) ?? []).find((x) => !usedBefore.has(`${x.id}|${x.track}`) && !after.has(`${x.id}|${x.track}`));
    if (!p) { out.added.push(c); continue; }
    usedBefore.add(`${p.id}|${p.track}`);
    if (p.name !== c.name) out.renamed.push({ id: c.id, from: p.name, to: c.name });
    if (p.track !== c.track || Math.abs(p.start - c.start) > 1e-3 || Math.abs(p.end - c.end) > 1e-3 || Math.abs(p.inPoint - c.inPoint) > 1e-3) {
      out.moved.push({ id: c.id, name: c.name, track: c.track, from: { track: p.track, start: r3(p.start), end: r3(p.end), inPoint: r3(p.inPoint) }, to: { track: c.track, start: r3(c.start), end: r3(c.end), inPoint: r3(c.inPoint) } });
    }
  }
  for (const [k, c] of before) if (!usedBefore.has(k)) out.removed.push(c);
  if (a.tracks.video !== b.tracks.video || a.tracks.audio !== b.tracks.audio) out.tracks = { from: a.tracks, to: b.tracks };
  if (a.markers !== b.markers) out.markers = { from: a.markers, to: b.markers };
  if (a.project.sequences !== b.project.sequences || a.project.items !== b.project.items) out.project = { from: a.project, to: b.project };
  return out;
}

/** One line a person can read: "2 clips added, 1 moved on V1, markers 3 -> 5". */
export function describeDiff(d: StateDiff): string {
  if (!d.changed) return 'Nothing changed.';
  const bits: string[] = [];
  if (d.added.length) bits.push(`${d.added.length} clip${d.added.length > 1 ? 's' : ''} added`);
  if (d.removed.length) bits.push(`${d.removed.length} removed`);
  if (d.moved.length) bits.push(`${d.moved.length} moved or trimmed`);
  if (d.renamed.length) bits.push(`${d.renamed.length} renamed`);
  if (d.tracks) bits.push(`tracks V${d.tracks.from.video}/A${d.tracks.from.audio} -> V${d.tracks.to.video}/A${d.tracks.to.audio}`);
  if (d.markers) bits.push(`markers ${d.markers.from} -> ${d.markers.to}`);
  if (d.project) bits.push(`project ${d.project.from.sequences} sequences/${d.project.from.items} items -> ${d.project.to.sequences}/${d.project.to.items}`);
  return bits.length ? bits.join(', ') + '.' : 'Changed (clip order within a track).';
}
