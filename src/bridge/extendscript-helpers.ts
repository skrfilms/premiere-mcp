/**
 * The ExtendScript helper library sent ahead of every generated script.
 *
 * ExtendScript is ES3: no let/const, no arrow functions, no Array.prototype.forEach, no JSON
 * in some hosts (hence __mcpStringify / __mcpParse). Everything here is written for that engine
 * and runs inside Premiere, not Node. It lives in a TypeScript template literal, so a backslash
 * is consumed once before Premiere sees it: write `\\` for one backslash, or build the
 * character from its code as __mcpEscapeString does.
 *
 * Checked by the test suite: every script, with this prefix, must parse as ES3
 * (generated-script-syntax.test.ts), and every __helper a tool calls must be defined here
 * (undefined-identifiers.test.ts).
 */
export const EXTENDSCRIPT_HELPERS = `
function __mcpEscapeString(value) {
  // Built from character codes rather than backslash literals on purpose: this
  // function is written inside a TypeScript template literal, where an escape
  // is consumed once before it ever reaches Premiere.
  var text = String(value);
  var backslash = String.fromCharCode(92);
  var out = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code === 34) { out += backslash + '"'; }
    else if (code === 92) { out += backslash + backslash; }
    else if (code === 8) { out += backslash + 'b'; }
    else if (code === 9) { out += backslash + 't'; }
    else if (code === 10) { out += backslash + 'n'; }
    else if (code === 12) { out += backslash + 'f'; }
    else if (code === 13) { out += backslash + 'r'; }
    else if (code < 32 || code === 0x2028 || code === 0x2029) {
      // Everything else below U+0020 has no short form and must go out as a
      // \\uXXXX escape. U+2028 and U+2029 are legal inside a JSON string but
      // are line terminators to a JavaScript parser, so they are escaped too
      // for any consumer that evaluates rather than parses the payload.
      var hex = code.toString(16);
      while (hex.length < 4) { hex = '0' + hex; }
      out += backslash + 'u' + hex;
    }
    else { out += text.charAt(i); }
  }
  return out;
}
// Saved before anything can shadow it. Reading hasOwnProperty off the value being
// serialised lets that value decide which of its own keys are emitted.
var __mcpOwnProperty = Object.prototype.hasOwnProperty;
function __mcpStringify(value) {
  if (value === null) return 'null';
  var valueType = typeof value;
  if (valueType === 'string') return '"' + __mcpEscapeString(value) + '"';
  if (valueType === 'number') return isFinite(value) ? String(value) : 'null';
  if (valueType === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Array) {
    var arrayParts = [];
    for (var i = 0; i < value.length; i++) {
      arrayParts.push(__mcpStringify(value[i]));
    }
    return '[' + arrayParts.join(',') + ']';
  }
  if (valueType === 'object') {
    var objectParts = [];
    for (var key in value) {
      // Through the saved reference, because an own property named hasOwnProperty
      // shadows the method. A non-function threw and lost the whole response; a
      // function returning false was worse, emitting {} that parses cleanly while
      // every field silently vanished.
      //
      // Switching to the reference would drop data if a host object carried its
      // values on a prototype, so that was measured rather than assumed: across
      // Application, Project, ProjectItem, Sequence, SequenceSettings, Track,
      // TrackCollection, TrackItem and MarkerCollection on 26.0.2 -- 101 enumerable
      // keys -- every one is an own property and none inherited. Keys are kept if
      // the check itself throws: one extra inherited key is recoverable, dropping
      // data is not.
      var isOwn = true;
      try { isOwn = __mcpOwnProperty.call(value, key); } catch (ownError) { isOwn = true; }
      if (!isOwn) continue;
      // Read once, and survive a read that throws. Guarding the ownership check
      // while leaving the read unguarded still lost the whole response to a
      // property that raises on access -- and a DOM object reaches here directly
      // through evaluate_expression. Reading twice also ran any side effect twice.
      var member;
      try { member = value[key]; } catch (readError) { continue; }
      if (typeof member === 'undefined' || typeof member === 'function') continue;
      objectParts.push(__mcpStringify(String(key)) + ':' + __mcpStringify(member));
    }
    return '{' + objectParts.join(',') + '}';
  }
  return 'null';
}
if (typeof JSON === 'undefined') { JSON = {}; }
// This engine has no JSON of its own. Measured on ExtendScript build 80.1060872:
// neither JSON.parse nor JSON.stringify exists, so the object created on the line
// above is fabricated by this prelude, and both directions installed below are the
// only ones the engine will ever have. The parser is further down, after the
// escaper it mirrors.
//
// Mind the wording here: the panel validates the whole script, prelude included,
// against a list of patterns that includes a bare "process" followed by a dot.
// A comment matching one of those makes the panel reject every call.
//
// It replaces one that escaped only backslash, quote, carriage return, line
// feed and tab, passing every other control character through raw. Every tool
// returns its payload through this function, so a single U+0001 in a clip or
// marker name did not corrupt one field -- it made the entire response
// unparseable and the whole call was lost.
//
// Assigned unconditionally rather than behind a typeof guard. On this engine
// the guard can never be false; should a later host ship its own, a measured
// escaper is still preferable to an unmeasured one. That makes the limits below
// the limits, so they are listed in full. This covers what the tools return --
// strings, finite numbers, booleans, null, arrays and plain objects -- and
// differs from a conformant JSON.stringify:
//
//   Date              {} rather than an ISO string, and toJSON() is ignored.
//   circular refs     recurses until the stack gives out; no clean TypeError.
//   boxed primitives  new String/Number/Boolean serialise as objects.
//   undefined, fn     at the top level return "null" rather than undefined.
//   replacer, space   accepted positionally by callers and ignored; output is
//                     never indented.
//
// Add any of those to a tool response and this needs extending first.
JSON.stringify = __mcpStringify;
// Recursive descent, because the engine has no JSON.parse either and the object
// above is fabricated: installing only stringify leaves a JSON that answers
// typeof but has no read direction, so a caller that feature-detects it gets a
// missing-function error instead. add_text_overlay decodes a MOGRT text payload
// that way and could never succeed.
//
// Recursive descent rather than the usual one-liner built on the dynamic code
// evaluator: the panel rejects any script mentioning that function by name and
// would refuse every call. This comment cannot spell it either, which the
// generated-script test enforces. Characters are compared by code rather than by
// literal for the same reason __mcpEscapeString does it -- a backslash written
// here is consumed by the template literal before it reaches the host.
// Two limits, measured rather than assumed. Nesting is bounded by the JavaScript
// call stack: around 6,000 levels before it gives out, against no observed limit
// in a modern engine. And each string is built one character at a time, which is
// linear where the engine has rope strings and quadratic where it does not; both
// are far outside the shape of a tool payload, but a caller feeding this arbitrary
// third-party JSON should know. The host cost of either is unmeasured.
function __mcpParse(text) {
  var source = String(text);
  var at = 0;

  function fail(what) {
    throw new Error('JSON.parse: ' + what + ' at position ' + at);
  }
  function skipWhitespace() {
    while (at < source.length) {
      var code = source.charCodeAt(at);
      if (code === 32 || code === 9 || code === 10 || code === 13) { at++; } else { break; }
    }
  }
  function expect(code) {
    if (source.charCodeAt(at) !== code) fail('expected character ' + code);
    at++;
  }
  function parseString() {
    expect(34);
    var out = '';
    while (at < source.length) {
      var code = source.charCodeAt(at);
      if (code === 34) { at++; return out; }
      if (code === 92) {
        at++;
        var esc = source.charCodeAt(at);
        at++;
        if (esc === 34) { out += String.fromCharCode(34); }
        else if (esc === 92) { out += String.fromCharCode(92); }
        else if (esc === 47) { out += '/'; }
        else if (esc === 98) { out += String.fromCharCode(8); }
        else if (esc === 102) { out += String.fromCharCode(12); }
        else if (esc === 110) { out += String.fromCharCode(10); }
        else if (esc === 114) { out += String.fromCharCode(13); }
        else if (esc === 116) { out += String.fromCharCode(9); }
        else if (esc === 117) {
          var hex = source.substr(at, 4);
          if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          at += 4;
        }
        else fail('bad escape');
        continue;
      }
      // Unescaped control characters are not legal inside a JSON string.
      if (code < 32) fail('unescaped control character');
      out += source.charAt(at);
      at++;
    }
    fail('unterminated string');
  }
  // The escape below is doubled deliberately. A single backslash is consumed by
  // the template literal, and the host then receives a dot that matches any
  // character -- which accepted 012, 000 and 0123 as numbers on a live 26.0.2.
  function parseNumber() {
    var start = at;
    if (source.charCodeAt(at) === 45) at++;
    while (at < source.length && source.charCodeAt(at) >= 48 && source.charCodeAt(at) <= 57) at++;
    if (source.charCodeAt(at) === 46) {
      at++;
      while (at < source.length && source.charCodeAt(at) >= 48 && source.charCodeAt(at) <= 57) at++;
    }
    var exponent = source.charCodeAt(at);
    if (exponent === 101 || exponent === 69) {
      at++;
      var sign = source.charCodeAt(at);
      if (sign === 43 || sign === 45) at++;
      while (at < source.length && source.charCodeAt(at) >= 48 && source.charCodeAt(at) <= 57) at++;
    }
    var literal = source.substring(start, at);
    if (!/^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(literal)) fail('bad number');
    return Number(literal);
  }
  function parseWord() {
    if (source.substr(at, 4) === 'true') { at += 4; return true; }
    if (source.substr(at, 5) === 'false') { at += 5; return false; }
    if (source.substr(at, 4) === 'null') { at += 4; return null; }
    fail('unexpected token');
  }
  function parseValue() {
    skipWhitespace();
    var code = source.charCodeAt(at);
    if (code === 34) return parseString();
    if (code === 123) {
      at++;
      var object = {};
      skipWhitespace();
      if (source.charCodeAt(at) === 125) { at++; return object; }
      for (;;) {
        skipWhitespace();
        var key = parseString();
        skipWhitespace();
        expect(58);
        var member = parseValue();
        if (key === '__proto__') {
          // Measured on 26.0.2: this engine implements the __proto__ setter, so
          // plain assignment grafts the payload onto the prototype instead of
          // adding a key -- a value carrying {"__proto__":{"mTextString":"X"}}
          // then reads back X from a field nobody set, and {"__proto__":null}
          // yields an object whose String() throws.
          //
          // Object.defineProperty does not exist here either, so the key cannot be
          // created as an ordinary property. It is dropped instead. That differs
          // from a conformant parser, which defines an own property, and the
          // difference is deliberate: losing one key is recoverable, silent field
          // injection is not. Where defineProperty does exist the conformant
          // behaviour is used.
          if (typeof Object.defineProperty === 'function') {
            try {
              Object.defineProperty(object, key, {
                value: member, enumerable: true, writable: true, configurable: true
              });
            } catch (defineError) { /* left out rather than assigned */ }
          }
        } else {
          object[key] = member;
        }
        skipWhitespace();
        if (source.charCodeAt(at) === 44) { at++; continue; }
        expect(125);
        return object;
      }
    }
    if (code === 91) {
      at++;
      var array = [];
      skipWhitespace();
      if (source.charCodeAt(at) === 93) { at++; return array; }
      for (;;) {
        array.push(parseValue());
        skipWhitespace();
        if (source.charCodeAt(at) === 44) { at++; continue; }
        expect(93);
        return array;
      }
    }
    if (code === 45 || (code >= 48 && code <= 57)) return parseNumber();
    return parseWord();
  }

  var result = parseValue();
  skipWhitespace();
  if (at < source.length) fail('unexpected trailing content');
  return result;
}
JSON.parse = __mcpParse;
// Premiere 26.5.2 crashes (SIGABRT in AccusonusBaseFilter::SetupSTFT, a null window buffer)
// when DeNoise or DeReverb is added to a clip whose source is a sequence. Measured 2026-10-29:
// the live sweep's denoise_clip took Premiere down on a nested clip, and it reproduced on a
// nested clip; both effects work on file-based video and audio-only clips. Multicam clips are
// sequences too and are refused the same way as a precaution (not measured separately).
// No version check: refused on every build until a build is measured safe.
//
// Fails closed: if the clip's source cannot be read, the effect is refused rather than risked.
// Names match in any case, and the obsolete "Adaptive Noise Reduction" counts, because adding
// it offers to swap in DeNoise. Returns a refusal message, or '' when it is safe.
function __crashProneAudioFx(domClip, effectName) {
  var n = String(effectName || '');
  var low = n.toLowerCase();
  if (low.indexOf('denoise') < 0 && low.indexOf('dereverb') < 0 && low.indexOf('adaptive noise reduction') < 0) return '';
  var item = null, nested = false, multicam = false, known = false;
  try {
    item = domClip ? domClip.projectItem : null;
    if (item) {
      nested = !!item.isSequence();
      try { multicam = !!item.isMulticamClip(); } catch (eM) {}
      known = true;
    }
  } catch (e) {}
  if (!known) return n + ' was not added: could not confirm that this clip comes from a media file, and on a nested sequence or multicam clip it crashes Premiere. Nothing was changed.';
  if (!nested && !multicam) return '';
  return n + ' on a nested sequence or multicam clip crashes Premiere, so it was not added and nothing was changed. Apply it to the clips inside that sequence instead.';
}

function __findSequence(id) {
  if (!app.project || !app.project.sequences) return null;
  // Fall back to the active sequence when no id is given. Most sequence tools in this catalogue
  // already default that way, and the ones that did not silently reported "Sequence not found"
  // for the entirely reasonable call of "act on the sequence I am looking at".
  if (id === null || typeof id === 'undefined' || id === '') {
    return app.project.activeSequence ? app.project.activeSequence : null;
  }
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    if (app.project.sequences[i].sequenceID === id) return app.project.sequences[i];
  }
  return null;
}
function __qeSequenceFor(seq) {
  if (!seq) return null;
  try { app.enableQE(); } catch (eEnable) { return null; }
  var count = 0;
  try { count = qe.project.numSequences; } catch (eCount) { return null; }
  for (var qi = 0; qi < count; qi++) {
    // Each index is guarded separately: qe.project.numSequences can report more
    // sequences than getSequenceAt() will actually return, and a throw at one
    // index must not abort the scan before the target index is reached.
    try {
      var candidate = qe.project.getSequenceAt(qi);
      if (candidate && String(candidate.guid) === String(seq.sequenceID)) return candidate;
    } catch (eAt) {}
  }
  // getSequenceAt() does not expose every sequence: one created by
  // duplicate_sequence and never opened in a timeline is invisible to it, even
  // while it is the active sequence. getActiveSequence() still returns a
  // working handle in that case — verified against 26.0.2, guid and all — so
  // fall back to it, but only once the guid confirms it is the sequence that
  // was asked for. Addressing the wrong one is the bug this helper exists to
  // prevent.
  try {
    var activeCandidate = qe.project.getActiveSequence();
    if (activeCandidate && String(activeCandidate.guid) === String(seq.sequenceID)) return activeCandidate;
  } catch (eActive) {}
  return null;
}
/*
 * QE addresses only the sequences in its own list plus whichever sequence is ACTIVE (measured on
 * 26.5.2: a sequence never opened in a timeline is absent from qe.project.getSequenceAt(), and
 * becomes reachable the moment app.project.openSequence(id) makes it active). Sequence
 * .openInTimeline() does not exist on this build, so callers that guarded on it silently did
 * nothing. This opens the named sequence when QE cannot see it. Side effect, by design: the named
 * sequence is left active, the same contract the transactions module declares.
 */
function __qeSequenceOpening(seq) {
  var q = __qeSequenceFor(seq);
  if (q || !seq) return q;
  try { app.project.openSequence(seq.sequenceID); } catch (eOpen) {}
  return __qeSequenceFor(seq);
}
function __findQeClipByDomClip(qeTrack, domClip) {
  // QE track items are not the DOM clip list: they include gaps and
  // transitions, so the DOM clip index addresses a different item as soon as
  // anything precedes the target. Verified against 26.0.2 — a track holding
  // three clips with one gap reported five QE items, and color_correct on DOM
  // clip 2 landed on the gap at QE index 2 and reported success having done
  // nothing. Match on start time instead, and skip anything that is not a clip.
  if (!qeTrack || !domClip) return null;
  var targetTicks = null;
  try { targetTicks = String(domClip.start.ticks); } catch (eTarget) {}
  var best = null, bestDelta = null;
  for (var qi = 0; qi < qeTrack.numItems; qi++) {
    var item = qeTrack.getItemAt(qi);
    if (!item) continue;
    var itemType = null;
    try { itemType = String(item.type); } catch (eType) {}
    if (itemType !== "Clip") continue;
    if (targetTicks === null) return item;
    var itemTicks = null;
    try { itemTicks = String(item.start.ticks); } catch (eItem) {}
    if (itemTicks === targetTicks) return item;
    if (itemTicks !== null) {
      var delta = Math.abs(parseInt(itemTicks, 10) - parseInt(targetTicks, 10));
      if (best === null || delta < bestDelta) { best = item; bestDelta = delta; }
    }
  }
  return best;
}
/*
 * The QE item for DOM clip index ci on track ti. qeTrack.getItemAt(ci) is NOT that clip: QE track
 * items include gaps and transitions, so the DOM index lands on a different item as soon as
 * anything precedes the clip (see __findQeClipByDomClip). Resolves the DOM clip through the
 * sequence whose id is the QE sequence's guid, then matches by start time. Null when either side
 * cannot be resolved -- never a guess.
 */
function __qeClipByIndex(qeSeq, kind, ti, ci) {
  if (!qeSeq) return null;
  var dom = null;
  try {
    var g = String(qeSeq.guid);
    for (var i = 0; i < app.project.sequences.numSequences; i++) { if (String(app.project.sequences[i].sequenceID) === g) { dom = app.project.sequences[i]; break; } }
  } catch (eG) {}
  var qt = null;
  try { qt = kind === 'audio' ? qeSeq.getAudioTrackAt(ti) : qeSeq.getVideoTrackAt(ti); } catch (eT) {}
  if (!qt || !dom) return null;
  var tracks = kind === 'audio' ? dom.audioTracks : dom.videoTracks;
  var dc = tracks[ti] ? tracks[ti].clips[ci] : null;
  if (!dc) return null;
  return __findQeClipByDomClip(qt, dc);
}
/*
 * Named transitions on a QE track that touch time t (seconds). QE track transition lists also
 * carry unnamed placeholder spans, which are skipped. Used to prove a transition landed AT A CUT:
 * QE addTransition's second argument means "at the clip's START" (true) or its end (false) --
 * measured on 26.5.2 -- so a call can succeed while putting the transition somewhere else.
 */
function __qeTransitionsAt(qeTrack, t, tol) {
  var out = [];
  if (!qeTrack) return out;
  if (tol === undefined) tol = 0.05;
  var n = 0;
  try { n = qeTrack.numTransitions; } catch (eN) { return out; }
  for (var i = 0; i < n; i++) {
    var tr = null;
    try { tr = qeTrack.getTransitionAt(i); } catch (eT) {}
    if (!tr) continue;
    var name = '';
    try { name = String(tr.name); } catch (eName) {}
    if (!name) continue;
    var a = Number(tr.start.secs), b = Number(tr.end.secs);
    if (a <= t + tol && b >= t - tol) out.push({ name: name, startSecs: a, endSecs: b });
  }
  return out;
}
/*
 * linkAudio=false clean-up and overwrite reporting for placements.
 *
 * The old clean-up removed every audio clip from the same source that started at the placement
 * time, so the user's OWN clip of that media starting there was deleted too (measured: a dual-mono
 * sequence lost its A1 clip at 10-20s when a video-only piece was placed on V2 at 10s). Only the
 * placed clip's linked audio is removed now. Overwrite placement of an A/V item also overwrites the
 * audio tracks under it -- that is Premiere's overwrite edit -- so the audio there is snapshotted
 * and anything it replaced is reported instead of passing silently.
 */
function __removeLinkedAudio(placed) {
  var removed = 0;
  try {
    var l = placed.getLinkedItems();
    var victims = [];
    for (var i = 0; i < l.numItems; i++) { if (String(l[i].mediaType) === 'Audio') victims.push(l[i]); }
    for (var k = 0; k < victims.length; k++) { try { victims[k].remove(false, false); removed++; } catch (eR) {} }
  } catch (eL) {}
  return removed;
}
function __audioUnder(seq, a, b) {
  var out = [];
  for (var t = 0; t < seq.audioTracks.numTracks; t++) {
    var tr = seq.audioTracks[t];
    for (var i = 0; i < tr.clips.numItems; i++) {
      var c = tr.clips[i], cs = Number(c.start.seconds), ce = Number(c.end.seconds);
      if (cs < b - 0.001 && ce > a + 0.001) out.push({ track: 'A' + (t + 1), nodeId: String(c.nodeId), name: String(c.name), start: cs, end: ce });
    }
  }
  return out;
}
function __audioReplaced(seq, snapshot) {
  var hit = [];
  for (var s = 0; s < snapshot.length; s++) {
    var w = snapshot[s], intact = false;
    for (var t = 0; t < seq.audioTracks.numTracks && !intact; t++) {
      var tr = seq.audioTracks[t];
      for (var i = 0; i < tr.clips.numItems; i++) {
        var c = tr.clips[i];
        if (String(c.nodeId) === w.nodeId && Math.abs(Number(c.start.seconds) - w.start) < 0.001 && Math.abs(Number(c.end.seconds) - w.end) < 0.001) { intact = true; break; }
      }
    }
    if (!intact) hit.push(w.track + ' "' + w.name + '" ' + w.start + '-' + w.end + 's');
  }
  return hit;
}
function __findClipInSequence(seq, nodeId) {
  if (!seq) return null;
  for (var t = 0; t < seq.videoTracks.numTracks; t++) {
    var track = seq.videoTracks[t];
    for (var c = 0; c < track.clips.numItems; c++) {
      if (track.clips[c].nodeId === nodeId)
        return { clip: track.clips[c], track: track, trackIndex: t, clipIndex: c, trackType: 'video', sequence: seq, sequenceId: seq.sequenceID, sequenceName: seq.name };
    }
  }
  for (var t = 0; t < seq.audioTracks.numTracks; t++) {
    var track = seq.audioTracks[t];
    for (var c = 0; c < track.clips.numItems; c++) {
      if (track.clips[c].nodeId === nodeId)
        return { clip: track.clips[c], track: track, trackIndex: t, clipIndex: c, trackType: 'audio', sequence: seq, sequenceId: seq.sequenceID, sequenceName: seq.name };
    }
  }
  return null;
}
function __findClip(nodeId, sequenceId) {
  if (!app.project) return null;
  if (sequenceId) return __findClipInSequence(__findSequence(sequenceId), nodeId);

  var found = __findClipInSequence(app.project.activeSequence, nodeId);
  if (found) return found;

  if (!app.project.sequences) return null;
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    found = __findClipInSequence(app.project.sequences[i], nodeId);
    if (found) return found;
  }
  return null;
}
function __samePath(a, b) {
  function normalize(value) {
    return String(value || '').replace(/\\\\/g, '/').replace(/\\/+$/g, '');
  }
  return normalize(a) === normalize(b);
}
function __findProjectItem(nodeId) {
  if (!app.project || !app.project.rootItem) return null;
  function walk(item) {
    if (item.nodeId === nodeId) return item;
    if (item.children) {
      for (var i = 0; i < item.children.numItems; i++) {
        var found = walk(item.children[i]);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(app.project.rootItem);
}
/*
 * Bin addressing, shared by every tool that takes a destination bin.
 *
 * These lived only inside create_bin's generated script, so import_folder and
 * import_media each carried a weaker copy that scanned rootItem.children one
 * level deep. A bin created inside another bin -- which is what create_bin
 * returns most of the time -- was therefore unreachable as an import
 * destination, and the only diagnosis on offer was "Destination bin not found"
 * for a bin that plainly existed. One resolver, three callers.
 */
function __isBin(it) {
  // type is authoritative: 2 = BIN, 3 = ROOT (both hold children). The createBin duck-type is
  // only a fallback for an item that reports no type, because on 26.5.2 CLIPS have createBin()
  // too (measured): the duck-type alone made every clip a "bin", so a bin of camera angles read
  // as empty and a clip sharing a bin's name made the bin name "ambiguous".
  if (!it) return false;
  if (it.type === 2 || it.type === 3) return true;
  if (typeof it.type === 'number') return false;
  return (typeof it.createBin === 'function');
}
function __binByPath(root, segments) {
  var node = root;
  for (var s = 0; s < segments.length; s++) {
    if (!node || !node.children) return null;
    var next = null;
    for (var i = 0; i < node.children.numItems; i++) {
      var ch = node.children[i];
      if (ch && __isBin(ch) && String(ch.name) === String(segments[s])) { next = ch; break; }
    }
    if (!next) return null;
    node = next;
  }
  return node;
}
function __binsByNameDeep(root, wanted, acc) {
  if (!root || !root.children) return acc;
  for (var i = 0; i < root.children.numItems; i++) {
    var ch = root.children[i];
    if (ch && __isBin(ch)) {
      if (String(ch.name) === String(wanted)) acc.push(ch);
      __binsByNameDeep(ch, wanted, acc);
    }
  }
  return acc;
}
/*
 * Resolve a destination bin from an id, a "/"-separated path, or a single name.
 * Returns { bin: <ProjectItem> } on success or { error: "..." } on failure --
 * never a silent fall back to the project root, because an import that lands
 * somewhere other than where it was asked to land is the failure this replaces.
 * A bare name is deep-searched and REFUSED when two bins share it: guessing
 * between them is how media ends up in the wrong scene.
 */
/*
 * For IMPORT destinations only: create the bin (or each missing segment of an "a/b/c" path) at
 * the project root. "Import these into a renders bin" used to fail with "Bin not found" when the
 * bin did not exist yet, which is the normal case the first time. Ambiguous names and bad ids
 * still refuse: creating there would hide a mistake.
 */
function __createBinPath(binName) {
  var root = app.project.rootItem, node = root;
  var segs = String(binName).split('/');
  for (var s = 0; s < segs.length; s++) {
    if (segs[s] === '') continue;
    var next = null;
    for (var i = 0; i < node.children.numItems; i++) {
      var ch = node.children[i];
      if (__isBin(ch) && String(ch.name) === segs[s]) { next = ch; break; }
    }
    if (!next) next = node.createBin(segs[s]);
    if (!next) return null;
    node = next;
  }
  return node === root ? null : node;
}
function __resolveImportBin(binId, binName) {
  var r = __resolveBin(binId, binName);
  if (r.error && (binId === undefined || binId === null || String(binId) === '') && binName && /not found/.test(r.error)) {
    var made = __createBinPath(binName);
    if (made) return { bin: made, resolvedBy: 'created', created: true };
  }
  return r;
}
/*
 * Every timeline use of a project item, or of anything inside a bin. "Where is this used?" is
 * the question to ask before deleting: a user reported deleting one bin emptied five timelines.
 */
function __usesOf(item, limit) {
  var ids = {};
  (function collect(it) {
    ids[String(it.nodeId)] = String(it.name);
    if (it.type === 2 || it.type === 3) for (var i = 0; i < it.children.numItems; i++) collect(it.children[i]);
  })(item);
  var uses = [], total = 0, seqNames = {};
  for (var s = 0; s < app.project.sequences.numSequences; s++) {
    var seq = app.project.sequences[s];
    var kinds = [['video', seq.videoTracks], ['audio', seq.audioTracks]];
    for (var k = 0; k < 2; k++) {
      var tracks = kinds[k][1];
      for (var t = 0; t < tracks.numTracks; t++) {
        var tr = tracks[t];
        for (var c = 0; c < tr.clips.numItems; c++) {
          var clip = tr.clips[c], pid = null;
          try { pid = clip.projectItem ? String(clip.projectItem.nodeId) : null; } catch (e) {}
          if (pid && ids[pid] !== undefined) {
            total++;
            seqNames[String(seq.name)] = true;
            if (uses.length < (limit || 50)) uses.push({ sequence: String(seq.name), sequenceId: String(seq.sequenceID), track: (kinds[k][0] === 'video' ? 'V' : 'A') + (t + 1), startSecs: clip.start.seconds, item: ids[pid] });
          }
        }
      }
    }
  }
  var names = []; for (var n in seqNames) names.push(n);
  return { total: total, sequences: names, uses: uses };
}
function __resolveBin(binId, binName) {
  var root = (app.project && app.project.rootItem) ? app.project.rootItem : null;
  if (!root) return { error: 'No project is open.' };
  if (binId !== undefined && binId !== null && String(binId) !== '') {
    var byId = __findProjectItem(String(binId));
    if (!byId) return { error: 'Bin not found by id: ' + binId + '.' };
    if (!__isBin(byId)) return { error: 'binId ' + binId + ' refers to "' + String(byId.name) + '", which is not a bin.' };
    return { bin: byId, resolvedBy: 'id' };
  }
  if (binName === undefined || binName === null || String(binName) === '') {
    return { bin: root, resolvedBy: 'root' };
  }
  if (String(binName).indexOf('/') !== -1) {
    var segs = String(binName).split('/');
    var trimmed = [];
    for (var si = 0; si < segs.length; si++) { if (segs[si] !== '') trimmed.push(segs[si]); }
    var byPath = __binByPath(root, trimmed);
    if (!byPath) return { error: 'Bin path not found: ' + binName + '.' };
    return { bin: byPath, resolvedBy: 'path' };
  }
  var matches = __binsByNameDeep(root, binName, []);
  if (matches.length === 0) return { error: 'Bin not found: ' + binName + '.' };
  if (matches.length > 1) {
    return { error: 'Bin name "' + binName + '" is ambiguous (' + matches.length + ' bins share it). Pass binId, or a "/"-separated path, to disambiguate.', matchCount: matches.length };
  }
  return { bin: matches[0], resolvedBy: 'name' };
}
/*
 * String.prototype.padStart does not exist in this engine (measured on 26.3.2: typeof is
 * undefined), so frames_to_timecode threw "String().padStart is not a function" on every call.
 * Neither do padEnd, repeat, find, findIndex, some, every, reduce, lastIndexOf, bind, or
 * Object.assign — while map, filter, indexOf and Array.isArray DO exist. No single rule predicts
 * that set, so it is probed rather than assumed; see es3-absent-methods.test.ts.
 */
/*
 * map, filter, indexOf and Array.isArray are NOT reliably present. Premiere 26.5.2 (ExtendScript
 * 4.5.6), probed with typeof on a freshly launched host on 2026-10-25, has none of them, and
 * ~20 tools threw "x.indexOf is not a function" / "x.map is not a function" on every call. The
 * 26.3.2 probe that recorded them as present was most likely reading a shared engine another
 * extension had already polyfilled, so a measurement on a warm host says nothing about a cold one.
 * Installed only where missing, so a host that has its own keeps it. The serialiser walks arrays
 * by index and every for-in over an object here is own-property guarded, so these enumerable
 * prototype members cannot leak into a response.
 */
if (typeof Array.isArray !== 'function') {
  Array.isArray = function (value) { return Object.prototype.toString.call(value) === '[object Array]'; };
}
if (typeof Array.prototype.indexOf !== 'function') {
  Array.prototype.indexOf = function (needle, fromIndex) {
    var len = this.length >>> 0;
    var i = fromIndex ? Number(fromIndex) : 0;
    if (i < 0) i = Math.max(0, len + i);
    for (; i < len; i++) { if (i in this && this[i] === needle) return i; }
    return -1;
  };
}
if (typeof Array.prototype.map !== 'function') {
  Array.prototype.map = function (fn, thisArg) {
    var len = this.length >>> 0, out = new Array(len);
    for (var i = 0; i < len; i++) { if (i in this) out[i] = fn.call(thisArg, this[i], i, this); }
    return out;
  };
}
if (typeof Array.prototype.filter !== 'function') {
  Array.prototype.filter = function (fn, thisArg) {
    var len = this.length >>> 0, out = [];
    for (var i = 0; i < len; i++) { if (i in this && fn.call(thisArg, this[i], i, this)) out.push(this[i]); }
    return out;
  };
}
/*
 * Sequence.getTimelineGaps() does not exist (typeof undefined on 26.5.2), and every caller that
 * reached for it behind a typeof guard silently reported zero gaps. Gaps are computed from clip
 * ranges instead. __trackGaps returns the empty ranges on one track, from 0 to its last clip, in
 * ticks. __videoGaps returns ranges where NO video track has a clip, i.e. black in the program.
 */
function __rangesGaps(ranges) {
  ranges.sort(function (a, b) { return a.start - b.start; });
  var gaps = [], cursor = 0;
  for (var i = 0; i < ranges.length; i++) {
    if (ranges[i].start > cursor) gaps.push({ start: cursor, end: ranges[i].start });
    if (ranges[i].end > cursor) cursor = ranges[i].end;
  }
  return gaps;
}
function __trackGaps(track) {
  var ranges = [];
  for (var i = 0; i < track.clips.numItems; i++) {
    ranges.push({ start: Number(track.clips[i].start.ticks), end: Number(track.clips[i].end.ticks) });
  }
  return __rangesGaps(ranges);
}
function __videoGaps(seq) {
  var ranges = [];
  for (var t = 0; t < seq.videoTracks.numTracks; t++) {
    var tr = seq.videoTracks[t];
    for (var i = 0; i < tr.clips.numItems; i++) {
      ranges.push({ start: Number(tr.clips[i].start.ticks), end: Number(tr.clips[i].end.ticks) });
    }
  }
  return __rangesGaps(ranges);
}
/*
 * Colour spaces are ColorSpace host objects, not names. Measured on 26.5.2: ColorSpace has no
 * constructor, its fields are read-only, ProjectItem.getOverrideColorSpaceList() does not exist,
 * String(colorSpace) is "[object Object]", and setOverrideColorSpace("Rec. 709") throws "Illegal
 * Parameter type". The only source of ColorSpace objects a script can pass back is a sequence's
 * settings.workingColorSpaceList (plus items' own original colour spaces), so names are resolved
 * against those.
 */
function __csInfo(cs) {
  if (!cs) return null;
  var o = {};
  try { o.name = String(cs.name); } catch (e1) {}
  try { o.empty = Boolean(cs.empty); } catch (e2) {}
  try { o.primaries = Number(cs.primaries); } catch (e3) {}
  try { o.transferCharacteristic = Number(cs.transferCharacteristic); } catch (e4) {}
  try { o.matrixEquation = Number(cs.matrixEquation); } catch (e5) {}
  try { o.isSceneReferred = Boolean(cs.isSceneReferred); } catch (e6) {}
  return o;
}
function __colorSpaceCatalog(item) {
  var out = [], seen = {};
  var add = function (cs) {
    if (!cs) return;
    var n = '';
    try { if (cs.empty) return; n = String(cs.name); } catch (e) { return; }
    if (!n || seen[n]) return;
    seen[n] = true; out.push(cs);
  };
  try {
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
      var list = null;
      try { list = seqs[i].getSettings().workingColorSpaceList; } catch (eL) {}
      if (list) for (var j = 0; j < list.length; j++) add(list[j]);
    }
  } catch (eS) {}
  if (item) { try { add(item.getOriginalColorSpace()); } catch (eO) {} }
  return out;
}
function __findColorSpace(name, item) {
  var want = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  var cat = __colorSpaceCatalog(item);
  for (var i = 0; i < cat.length; i++) {
    if (String(cat[i].name).toLowerCase().replace(/[^a-z0-9]/g, '') === want) return cat[i];
  }
  return null;
}
function __colorSpaceNames(item) {
  var cat = __colorSpaceCatalog(item), names = [];
  for (var i = 0; i < cat.length; i++) names.push(String(cat[i].name));
  return names;
}
/*
 * The QE exportFrame* methods take the time as a TIMECODE STRING. Measured on 26.5.2 against a
 * frame-counter clip: "00;00;02;00" and "00:00:02:00" export frame 48 at 24 fps, while "2" and a
 * ticks string are accepted without error and export frame 0, and a bare number throws. The old
 * callers tried seconds and ticks first and took the first call that wrote a file, so every
 * captured frame was frame 0 regardless of the time asked for. Built from the sequence's own
 * frame rate, as whole frames at the nominal rate (non-drop).
 */
function __qeTimecode(seq, seconds) {
  var fps = 24;
  try { fps = 254016000000 / Number(seq.timebase); } catch (eFps) {}
  if (!(fps > 0)) fps = 24;
  var nominal = Math.round(fps);
  var frames = Math.round(Number(seconds) * fps);
  if (frames < 0) frames = 0;
  var ff = frames % nominal, totalSecs = Math.floor(frames / nominal);
  var ss = totalSecs % 60, mm = Math.floor(totalSecs / 60) % 60, hh = Math.floor(totalSecs / 3600);
  // ':' on purpose. QE reads either separator as a NON-drop frame count (measured on a 29.97
  // sequence: 00;10;00;00 and 00:10:00:00 both export frame 18000), so the frames are laid out at the
  // nominal rate whatever the sequence's display format; ';' only invited a drop-frame misreading.
  return __padLeft(hh, 2) + ':' + __padLeft(mm, 2) + ':' + __padLeft(ss, 2) + ':' + __padLeft(ff, 2);
}
/*
 * Timecode -> tick string for a sequence. Accepts HH:MM:SS:FF (non-drop), HH;MM;SS;FF (drop-frame
 * at 29.97/59.94) or a plain number of seconds. Sequence.setZeroPoint() takes TICKS as a string, so
 * a tool that passed the timecode straight through was inert. Null when it cannot be parsed.
 */
function __timecodeToTicks(seq, tc) {
  var tb = 10584000000;
  try { tb = Number(seq.timebase) || tb; } catch (eTb) {}
  var fps = 254016000000 / tb, nominal = Math.round(fps);
  var text = String(tc);
  if (/^\\s*-?[0-9.]+\\s*$/.test(text)) return String(Math.round(Number(text) * 254016000000));
  var m = text.match(/^\\s*(\\d+)[:;](\\d+)[:;](\\d+)([:;])(\\d+)\\s*$/);
  if (!m) return null;
  var h = Number(m[1]), mi = Number(m[2]), se = Number(m[3]), fr = Number(m[5]);
  if (fr >= nominal || mi > 59 || se > 59) return null;
  var frames = ((h * 3600 + mi * 60 + se) * nominal) + fr;
  var drop = m[4] === ';' && (nominal === 30 || nominal === 60) && Math.abs(fps - nominal) > 0.001;
  if (drop) { var d = nominal === 30 ? 2 : 4, totalMinutes = 60 * h + mi; frames -= d * (totalMinutes - Math.floor(totalMinutes / 10)); }
  return String(Math.round(frames * tb));
}
function __padLeft(value, width, padChar) {
  var out = String(value);
  var ch = (padChar === undefined || padChar === null) ? '0' : String(padChar);
  while (out.length < width) out = ch + out;
  return out;
}
function __ticksToSeconds(ticks) {
  return parseInt(ticks, 10) / 254016000000;
}
function __secondsToTicks(seconds) {
  return String(Math.round(seconds * 254016000000));
}
/*
 * Sequence time accessors are the sharpest footgun in this API. Measured on 26.3.2:
 *
 *   Sequence.end                        -> STRING of TICKS      ("2540160000000")
 *   Sequence.getInPoint()/getOutPoint() -> STRING of SECONDS     ("0", "2")
 *   ProjectItem.getInPoint()/getOutPoint() -> Time object        (.ticks / .seconds)
 *   TrackItem.start/end/inPoint/outPoint   -> Time object        (.ticks / .seconds)
 *
 * So the two Sequence accessors have the SAME type and DIFFERENT units, with nothing in the
 * value to tell them apart. Reading .ticks off either yields undefined, which becomes the
 * literal string "undefined" when handed to setPlayerPosition (the playhead silently does not
 * move) or NaN when added into a duration total (serialised as null).
 *
 * These are deliberately one helper per accessor rather than one clever unit-sniffing function:
 * a magnitude heuristic cannot distinguish 2 seconds from 2 ticks, and a wrong guess here is
 * invisible. Each helper also tolerates a Time object, in case a future build changes shape.
 */
function __timeFieldToNumber(value) {
  if (value === null || typeof value === 'undefined') return null;
  if (typeof value === 'object') {
    if (typeof value.ticks !== 'undefined') return Number(value.ticks);
    if (typeof value.seconds !== 'undefined') return Number(value.seconds) * 254016000000;
    return null;
  }
  var n = Number(value);
  return isNaN(n) ? null : n;
}
/* Sequence.end is TICKS. Returns Number of ticks, or null when unreadable. */
function __seqEndTicks(seq) {
  if (!seq) return null;
  var v = seq.end;
  if (v === null || typeof v === 'undefined') return null;
  if (typeof v === 'object') return __timeFieldToNumber(v);
  var n = Number(v);
  return isNaN(n) ? null : n;
}
function __seqEndSeconds(seq) {
  var t = __seqEndTicks(seq);
  return t === null ? null : t / 254016000000;
}
/* Sequence.getInPoint()/getOutPoint() are SECONDS. Returns Number of seconds, or null. */
function __seqPointSeconds(seq, which) {
  if (!seq) return null;
  var raw;
  try { raw = (which === 'out') ? seq.getOutPoint() : seq.getInPoint(); } catch (e) { return null; }
  if (raw === null || typeof raw === 'undefined') return null;
  if (typeof raw === 'object') {
    if (typeof raw.seconds !== 'undefined') return Number(raw.seconds);
    if (typeof raw.ticks !== 'undefined') return Number(raw.ticks) / 254016000000;
    return null;
  }
  var n = Number(raw);
  return isNaN(n) ? null : n;
}
function __seqInSeconds(seq) { return __seqPointSeconds(seq, 'in'); }
function __seqOutSeconds(seq) { return __seqPointSeconds(seq, 'out'); }
/*
 * A sequence with no in/out range set reports a NEGATIVE seconds value (about -0.04, i.e. one
 * frame below zero) rather than null. Passing that straight through produced an attempt to move
 * the playhead to a negative tick position, which then failed with an accurate but unhelpful
 * "playhead did not land" message. Treat negative as "not set" so callers get the real reason.
 */
function __seqInTicks(seq) {
  var s = __seqInSeconds(seq);
  if (s === null || s < 0) return null;
  return Math.round(s * 254016000000);
}
function __seqOutTicks(seq) {
  var s = __seqOutSeconds(seq);
  if (s === null || s < 0) return null;
  return Math.round(s * 254016000000);
}
/*
 * Work area readback. The AsTime variants are the reliable pair on 26.3.2; the plain getters are
 * kept as a fallback in case a build exposes only those.
 *
 * Note for callers: the work-area SETTERS are inert on 26.3.2. setWorkAreaInPoint /
 * setWorkAreaOutPoint are present and accept values without throwing, and QE
 * setWorkInOutPoints likewise, but the readback never moves — even after
 * setWorkAreaEnabled(true) flips isWorkAreaEnabled() to true. Premiere 2026 deprecated the
 * work-area bar in favour of sequence in/out points, which ARE settable. Read the work area
 * freely; do not trust a write to it.
 */
function __readWorkArea(seq) {
  var inTicks = null, outTicks = null;
  try {
    inTicks = __timeFieldToNumber(seq.getWorkAreaInPointAsTime());
    outTicks = __timeFieldToNumber(seq.getWorkAreaOutPointAsTime());
  } catch (e) {}
  if (outTicks === null) {
    try {
      inTicks = __timeFieldToNumber(seq.getWorkAreaInPoint());
      outTicks = __timeFieldToNumber(seq.getWorkAreaOutPoint());
    } catch (e2) {}
  }
  return { inTicks: inTicks, outTicks: outTicks };
}
function __workAreaEnabled(seq) {
  try { return !!seq.isWorkAreaEnabled(); } catch (e) { return null; }
}
/*
 * Move the playhead and PROVE it landed. setPlayerPosition takes a ticks string and silently
 * accepts garbage, so the readback comparison is the only thing separating a real move from a
 * fake success. Tolerance is one frame's worth of ticks at 24fps unless told otherwise.
 */
function __setPlayheadVerified(seq, targetTicks, toleranceTicks) {
  if (targetTicks === null || typeof targetTicks === 'undefined' || isNaN(Number(targetTicks))) {
    return { moved: false, verified: false, error: 'Refusing to set the playhead to a non-numeric position (' + String(targetTicks) + '). Nothing was changed.' };
  }
  var tol = (typeof toleranceTicks === 'number') ? toleranceTicks : 10584000000;
  var target = Math.round(Number(targetTicks));
  var before = null;
  try { before = __timeFieldToNumber(seq.getPlayerPosition()); } catch (e) {}
  try { seq.setPlayerPosition(String(target)); } catch (e2) {
    return { moved: false, verified: false, error: 'setPlayerPosition threw: ' + e2.toString(), beforeTicks: before };
  }
  var after = null;
  try { after = __timeFieldToNumber(seq.getPlayerPosition()); } catch (e3) {}
  if (after === null) {
    return { moved: false, verified: false, error: 'Could not read the playhead back, so the move is unproven.', targetTicks: target, beforeTicks: before };
  }
  var landed = Math.abs(after - target) <= tol;
  return {
    moved: landed, verified: true, targetTicks: target, actualTicks: after,
    actualSeconds: after / 254016000000, beforeTicks: before,
    error: landed ? null : 'Playhead did not land on the requested position (asked ' + target + ' ticks, got ' + after + ').'
  };
}
`;
