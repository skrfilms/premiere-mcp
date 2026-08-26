/**
 * Bridge module for communicating with Adobe Premiere Pro
 * 
 * This module handles the communication between the MCP server and Adobe Premiere Pro
 * using various methods including UXP, ExtendScript, and file-based communication.
 */

import { Logger } from '../utils/logger.js';
import { ChildProcess, execSync, spawnSync } from 'child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'fs';
import { extname, join } from 'path';
import { createSecureTempDir, validateFilePath } from '../utils/security.js';
import type { PremiereProTransport } from './types.js';
import {
  BridgeSocketTransport,
  BRIDGE_PROTOCOL_VERSION,
  type LatencyStats,
  type PanelHandshake,
  type SocketCommandType,
} from './socket-transport.js';

const UNSUPPORTED_MODAL_PRONE_IMPORT_EXTENSIONS = new Set([
  '.ass',
  '.ssa'
]);

// The CEP panel writes this file into the shared temp directory on every poll tick
// (~250ms). The server reads it to tell three failure modes apart that used to be
// indistinguishable — all of them blocked the caller for the full timeout:
//   1. panel never started / Premiere closed  (no heartbeat, or connected=false)
//   2. panel alive but wedged behind a modal   (heartbeat fresh, isProcessing=true)
//   3. panel crashed/froze mid-command         (heartbeat was fresh, now gone stale)
// A panel old enough not to write a heartbeat simply produces none, and the server
// falls back to its original full-timeout behaviour — so this is backward compatible.
const HEARTBEAT_FILE = 'bridge-heartbeat.json';
// The panel ticks every 250ms; 4s is 16 missed ticks — comfortably past any GC pause
// or slow disk, but far short of the 60s default timeout it replaces.
const HEARTBEAT_STALE_MS = 4000;
// Give a freshly-clicked Start Bridge time to write its first heartbeat before the
// server is willing to declare the panel dead.
const HEARTBEAT_GRACE_MS = 3000;

interface BridgeHeartbeat {
  ageMs: number;
  connected: boolean;
  isProcessing: boolean;
  currentCommandId: string | null;
  currentCommandStartedAt: number | null;
  queueLength: number;
}

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
 * String.prototype.padStart does not exist in this engine (measured on 26.3.2: typeof is
 * undefined), so frames_to_timecode threw "String().padStart is not a function" on every call.
 * Neither do padEnd, repeat, find, findIndex, some, every, reduce, lastIndexOf, bind, or
 * Object.assign — while map, filter, indexOf and Array.isArray DO exist. No single rule predicts
 * that set, so it is probed rather than assumed; see es3-absent-methods.test.ts.
 */
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

export interface PremiereProProject {
  id: string;
  name: string;
  path: string;
  isOpen: boolean;
  sequences: PremiereProSequence[];
  projectItems: PremiereProProjectItem[];
}

export interface PremiereProSequence {
  id: string;
  name: string;
  duration: number;
  frameRate: number;
  videoTracks: PremiereProTrack[];
  audioTracks: PremiereProTrack[];
}

export interface PremiereProTrack {
  id: string;
  name: string;
  type: 'video' | 'audio';
  clips: PremiereProClip[];
}

export interface PremiereProClip {
  id: string;
  name: string;
  inPoint: number;
  outPoint: number;
  duration: number;
  mediaPath?: string;
}

export interface PremiereProProjectItem {
  id: string;
  name: string;
  type: 'footage' | 'sequence' | 'bin';
  mediaPath?: string;
  duration?: number;
  frameRate?: number;
}

export interface PremiereProEffect {
  id: string;
  name: string;
  category: string;
  parameters: Record<string, any>;
}

export class PremiereProBridge implements PremiereProTransport {
  private logger: Logger;
  private communicationMethod: 'uxp' | 'extendscript' | 'file';
  private tempDir: string;
  private readonly usesExternalTempDir: boolean;
  private uxpProcess?: ChildProcess;
  private isInitialized = false;
  private sessionId: string;
  /** Per-session token the panel must echo on every command. Null when it could not be written. */
  private authToken: string | null = null;
  /**
   * Push channel to the panel. Null until initialize() binds it, and null forever when the
   * operator pinned the transport to file IPC or the listener could not be bound.
   */
  private socket: BridgeSocketTransport | null = null;
  /**
   * Operator override, from PREMIERE_MCP_TRANSPORT:
   *   auto (default)  socket when a panel is connected, file IPC otherwise
   *   file            never bind a listener (no port, no firewall prompt)
   *   socket          refuse to publish over file IPC at all, and say so
   * Configurable rather than hardcoded because a peer bridge reports Premiere dying on the first
   * inbound socket command on some Windows builds (docs/INTERNAL-PLAN.md, Tier 0 risks). That report
   * is unverified, which is a reason to leave an escape hatch, not a reason to default to file.
   */
  private readonly transportPreference: 'auto' | 'file' | 'socket';
  /**
   * Publication counters. These exist so the exactly-one-channel invariant is OBSERVABLE rather
   * than asserted in a comment: every command increments exactly one of the first two.
   */
  private readonly publications = { socket: 0, file: 0, refusedAfterPublish: 0 };

  constructor() {
    this.logger = new Logger('PremiereProBridge');
    this.communicationMethod = 'file'; // Default to file-based communication
    this.sessionId = randomUUID();
    const preference = (process.env.PREMIERE_MCP_TRANSPORT || 'auto').trim().toLowerCase();
    this.transportPreference =
      preference === 'file' || preference === 'socket' ? preference : 'auto';
    // Use PREMIERE_TEMP_DIR if set (same path as UXP plugin "Temp Directory"), else session-specific
    const envDir = process.env.PREMIERE_TEMP_DIR;
    this.usesExternalTempDir = Boolean(envDir);
    this.tempDir = envDir ? envDir.replace(/\/$/, '') : createSecureTempDir(this.sessionId);
  }

  async initialize(): Promise<void> {
    try {
      await this.setupTempDirectory();
      await this.detectPremiereProInstallation();
      await this.initializeCommunication();
      this.isInitialized = true;
      this.logger.info('Adobe Premiere Pro bridge initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Adobe Premiere Pro bridge:', error);
      throw error;
    }
  }

  /**
   * Establish the shared directory, and make it safe to share.
   *
   * Three things happen here, and the honest scope of each matters:
   *
   * 1. The directory is created 0700 AND, if it already existed, re-chmodded and ownership-checked.
   *    Creating with a mode does nothing when the directory is already there — which it always is
   *    when PREMIERE_TEMP_DIR points at a fixed path — so the previous code protected only the
   *    first run on a machine.
   * 2. Leftover `command-*.json` files are swept. A stale command file EXECUTES the moment the
   *    panel next starts, so an abandoned command from a crashed session was a delayed-action
   *    script with nobody waiting for its result.
   * 3. A per-session token is written 0600 and required on every command (see writeAuthToken).
   *
   * What this does NOT do, stated plainly because the alternative is security theatre: any process
   * running as this user can read the token file, so the token does not stop a same-user attacker.
   * Its real jobs are to block BLIND writes into the directory, to keep two concurrent server
   * instances from consuming each other's commands, and to make the trust boundary explicit. The
   * protection against other users is the 0700 directory and the ownership check, not the token.
   */
  private async setupTempDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
      // mkdir's mode is ignored for an existing directory, so assert it every time.
      try {
        const stats = await fs.stat(this.tempDir);
        if (stats.uid !== process.getuid?.()) {
          throw new Error(
            `Refusing to use ${this.tempDir}: it is owned by uid ${stats.uid}, not by this process (uid ${process.getuid?.()}). ` +
            'A directory owned by someone else can feed arbitrary ExtendScript into Premiere.',
          );
        }
        const mode = stats.mode & 0o777;
        if (mode !== 0o700) {
          await fs.chmod(this.tempDir, 0o700);
          this.logger.warn(`Tightened ${this.tempDir} from mode ${mode.toString(8)} to 700`);
        }
      } catch (statError) {
        // An ownership mismatch must abort; a stat/chmod failure for any other reason should not
        // take the bridge down, since the directory may still be perfectly usable.
        if (statError instanceof Error && statError.message.startsWith('Refusing to use')) throw statError;
        this.logger.warn(`Could not verify temp directory permissions: ${statError}`);
      }

      await this.sweepStaleCommands();
      await this.writeAuthToken();
      // After the token, never before: the socket publishes that same token in its endpoint file,
      // so binding first would advertise a port with a null token and force the panel to reconnect.
      await this.startSocketTransport();
      this.logger.debug(`Secure temp directory ready: ${this.tempDir}`);
    } catch (error) {
      this.logger.error('Failed to create temp directory:', error);
      throw error;
    }
  }

  /**
   * Remove `command-*.json` files left behind by an earlier session.
   *
   * These are not litter: the panel polls for that exact pattern and runs whatever it finds, so a
   * command abandoned by a crashed server executes against whatever project happens to be open
   * when Premiere next starts. Orphaned `response-*` and `.tmp-*` files go too — a stale response
   * could satisfy a future command that reuses its id (astronomically unlikely with UUIDs, but
   * free to rule out).
   */
  private async sweepStaleCommands(): Promise<void> {
    try {
      const entries = await fs.readdir(this.tempDir);
      const stale = entries.filter((name) =>
        (name.startsWith('command-') && name.endsWith('.json')) ||
        (name.startsWith('response-') && name.endsWith('.json')) ||
        name.startsWith('.tmp-'));
      for (const name of stale) {
        try { await fs.unlink(join(this.tempDir, name)); } catch { /* another instance won the race */ }
      }
      if (stale.length > 0) {
        this.logger.warn(
          `Swept ${stale.length} leftover command/response file(s) from ${this.tempDir}. ` +
          'A stale command file would have executed when the panel next started.',
        );
      }
    } catch (error) {
      this.logger.warn(`Could not sweep stale commands: ${error}`);
    }
  }

  /** Our own token file — exclusively ours, so we can delete it on exit without a race. */
  private get sessionTokenFile(): string {
    return join(this.tempDir, `auth-session-${this.sessionId}.json`);
  }

  /**
   * Write the per-session token the panel must echo back.
   *
   * TWO files, on purpose.
   *
   * `auth-session-<sessionId>.json` is ours alone. Nothing else ever writes it, so there is no
   * read-modify-write race between servers starting at the same time, and on exit we can delete it
   * knowing the file we are removing is the one we created. The panel accepts a token matching ANY
   * of these, which is what lets several servers share one PREMIERE_TEMP_DIR: each has a live token,
   * and each is answered. Before this, `auth-token.json` was single-valued and last-writer-wins, so
   * every server but the newest had its commands rejected as UNAUTHORIZED.
   *
   * `auth-token.json` is still written, unchanged in shape, for one reason: an OLDER installed panel
   * only knows how to read that file. Dropping it would break a mismatched-version install silently.
   * It names the newest server, which is also the one the socket points at.
   *
   * Backwards compatibility in the other direction is also deliberate: the panel enforces a token
   * only when at least one of these files exists. An older server that writes none keeps working.
   */
  private async writeAuthToken(): Promise<void> {
    this.authToken = randomBytes(32).toString('hex');
    const payload = JSON.stringify({
      token: this.authToken,
      sessionId: this.sessionId,
      pid: process.pid,
      issuedAt: new Date().toISOString(),
    });
    try {
      // Write-then-rename so the panel can never read a half-written token, and 0600 so it is not
      // group- or world-readable even if the directory mode is somehow loosened later.
      const writeAtomic = async (target: string, staging: string): Promise<void> => {
        const stagingPath = join(this.tempDir, staging);
        await fs.writeFile(stagingPath, payload, { mode: 0o600 });
        await fs.chmod(stagingPath, 0o600);
        await fs.rename(stagingPath, target);
      };
      await writeAtomic(this.sessionTokenFile, `.auth-session-${this.sessionId}.tmp`);
      await writeAtomic(join(this.tempDir, 'auth-token.json'), '.auth-token.tmp');
      this.logger.debug('Wrote per-session bridge auth token');
    } catch (error) {
      // A bridge that cannot authenticate should still run rather than refuse to start; the panel
      // falls back to accepting untokened commands exactly as it did before.
      this.logger.warn(`Could not write auth token, continuing without it: ${error}`);
      this.authToken = null;
    }
    await this.reapDeadSessionTokens();
  }

  /**
   * Remove `auth-session-*.json` files whose server is gone.
   *
   * A server killed with SIGKILL — or one whose host crashed — never runs its own cleanup, and the
   * panel would keep accepting that token for as long as Premiere stayed open. `kill(pid, 0)` is a
   * liveness probe that sends no signal; EPERM means the pid exists but belongs to another user, so
   * that counts as alive rather than reapable.
   *
   * Not a security boundary — the temp directory is 0700, so anything that can read these files
   * already runs as this user and could read a live token just as easily. It is hygiene: it stops
   * the accepted-token list growing without bound across a long Premiere session.
   */
  private async reapDeadSessionTokens(): Promise<void> {
    try {
      const entries = await fs.readdir(this.tempDir);
      for (const name of entries) {
        if (!name.startsWith('auth-session-') || !name.endsWith('.json')) continue;
        const path = join(this.tempDir, name);
        if (path === this.sessionTokenFile) continue;
        let pid: number | null = null;
        try {
          const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
          pid = typeof parsed?.pid === 'number' ? parsed.pid : null;
        } catch {
          // Unreadable or malformed: it can never authorise anything, so it is safe to drop.
        }
        if (pid !== null) {
          try {
            process.kill(pid, 0);
            continue; // alive — leave its token in place
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') continue; // alive, another user
          }
        }
        try {
          await fs.unlink(path);
          this.logger.debug(`Reaped the bridge token of a server that is no longer running (${name})`);
        } catch { /* another instance won the race */ }
      }
    } catch (error) {
      this.logger.debug(`Could not reap stale session tokens: ${error}`);
    }
  }

  /**
   * Retire this session's token.
   *
   * The session file is ours exclusively, so it goes unconditionally. `auth-token.json` is shared
   * and last-writer-wins, so it goes ONLY if it still names us: deleting a newer server's token
   * would leave that server unable to authorise anything, and — worse — deleting the last token
   * file makes the panel run unauthenticated, which is the one outcome to avoid. When a newer
   * server owns it, leaving it alone is correct; its own cleanup removes it.
   */
  private async retireAuthToken(): Promise<void> {
    try {
      await fs.unlink(this.sessionTokenFile);
    } catch { /* never written, or already gone */ }

    const sharedFile = join(this.tempDir, 'auth-token.json');
    try {
      const parsed = JSON.parse(await fs.readFile(sharedFile, 'utf8'));
      if (parsed?.sessionId === this.sessionId) await fs.unlink(sharedFile);
    } catch { /* absent, unreadable, or owned by another server — leave it */ }
  }

  /**
   * Bind the loopback push channel, unless the operator pinned the transport to file IPC.
   *
   * Failure here is never fatal. A machine that will not give us a loopback listener still gets a
   * working bridge over the 250ms file poll — trading a latency improvement for a total outage
   * would be a poor bargain, and an unavailable socket is reported rather than hidden
   * (see getTransportStatus).
   */
  private async startSocketTransport(): Promise<void> {
    if (this.transportPreference === 'file') {
      this.logger.info('PREMIERE_MCP_TRANSPORT=file: not binding a WebSocket listener');
      return;
    }
    const transport = new BridgeSocketTransport({
      tempDir: this.tempDir,
      token: this.authToken,
      sessionId: this.sessionId,
      logger: this.logger,
    });
    const started = await transport.start();
    if (started === null) {
      if (this.transportPreference === 'socket') {
        // Pinned to socket and the listener would not bind. Refuse loudly rather than quietly
        // using the channel the operator ruled out.
        throw new Error(
          'PREMIERE_MCP_TRANSPORT=socket was requested but the loopback WebSocket listener could ' +
          'not be bound, and file IPC was ruled out by that setting. Unset PREMIERE_MCP_TRANSPORT ' +
          'to allow the file fallback.',
        );
      }
      return;
    }
    this.socket = transport;
  }

  /**
   * Pick the ONE channel this command will be published to.
   *
   * Publishing a command to both channels would hand the panel two copies of the same work, and a
   * second `insertClip` is not a slow edit, it is a wrong one. So this returns a single channel and
   * the callers below publish to exactly that.
   *
   * `not-published` from the socket is the one case where a second attempt is legitimate: it means
   * nothing reached the wire, so the command has still been published exactly once when it goes out
   * over file IPC.
   */
  private chooseChannel(commandType: SocketCommandType): { channel: 'socket' | 'file'; reason: string } {
    if (this.transportPreference === 'file') return { channel: 'file', reason: 'PREMIERE_MCP_TRANSPORT=file' };
    if (this.socket === null) return { channel: 'file', reason: 'no socket listener is bound' };
    if (!this.socket.isPanelReady()) return { channel: 'file', reason: 'no panel is connected to the socket' };
    if (!this.socket.supportsFeature(commandType)) {
      return {
        channel: 'file',
        reason: `the connected panel did not announce the "${commandType}" feature`,
      };
    }
    return { channel: 'socket', reason: 'a handshaken panel is connected' };
  }

  /**
   * Publish one command and wait for its result, over exactly one channel.
   *
   * Returns the panel's result, or throws. The throw from a PUBLISHED socket command is never
   * followed by a file-IPC retry: see the socket-transport module header for why that matters more
   * than the latency this whole channel exists to save.
   */
  private async publishCommand(
    commandId: string,
    commandType: SocketCommandType,
    script: string,
    timeoutMs: number | undefined,
    mutating: boolean,
  ): Promise<any> {
    const effectiveTimeout = timeoutMs ?? 60000;
    const decision = this.chooseChannel(commandType);

    if (decision.channel === 'socket' && this.socket !== null) {
      const outcome = await this.socket.publish(
        { id: commandId, commandType, script, timeoutMs, mutating },
        effectiveTimeout,
      );

      if (outcome.status === 'ok') {
        this.publications.socket += 1;
        return outcome.result;
      }

      if (outcome.status === 'failed') {
        // Published. The command is finished as far as this server is concerned, whatever state the
        // project is in — and the error text says so.
        this.publications.socket += 1;
        if (outcome.mayHavePartiallyApplied) this.publications.refusedAfterPublish += 1;
        throw outcome.error;
      }

      // not-published: the panel vanished between the decision and the send, so nothing reached the
      // wire. This is the ONLY path that continues to a second channel.
      this.logger.warn(
        `Socket publish declined (${outcome.reason}); publishing over file IPC instead. ` +
        'Nothing was sent over the socket, so this command is still published exactly once.',
      );
      if (this.transportPreference === 'socket') {
        throw new Error(
          `PREMIERE_MCP_TRANSPORT=socket was requested but the command could not be published over ` +
          `the socket (${outcome.reason}), and that setting rules out file IPC. Nothing was sent. ` +
          'Open the MCP Bridge (CEP) panel and start it, or unset PREMIERE_MCP_TRANSPORT.',
        );
      }
    } else if (this.transportPreference === 'socket') {
      throw new Error(
        `PREMIERE_MCP_TRANSPORT=socket was requested but ${decision.reason}, and that setting rules ` +
        'out file IPC. Nothing was sent. Open the MCP Bridge (CEP) panel and start it, or unset ' +
        'PREMIERE_MCP_TRANSPORT.',
      );
    }

    this.publications.file += 1;
    return await this.publishOverFileIpc(commandId, commandType, script, timeoutMs, effectiveTimeout);
  }

  /**
   * The original transport: write `command-<uuid>.json`, wait for `response-<uuid>.json`.
   *
   * Unchanged in behaviour — the atomic write-then-rename, the token, and the cleanup on every exit
   * path are all load-bearing and documented where they happen.
   */
  private async publishOverFileIpc(
    commandId: string,
    commandType: SocketCommandType,
    script: string,
    timeoutMs: number | undefined,
    effectiveTimeout: number,
  ): Promise<any> {
    const commandFile = join(this.tempDir, `command-${commandId}.json`);
    const responseFile = join(this.tempDir, `response-${commandId}.json`);
    // Declared out here so the finally below can remove it: if rename() fails the
    // scratch file is still on disk, and nothing else ever matches that name.
    const commandStaging = join(this.tempDir, `.tmp-${commandId}.json`);

    try {
      // Write command to file. Include timeoutMs so the CEP/UXP panel can extend its own
      // execution watchdog to match — otherwise the panel's default (45s) kills long batch
      // scripts well before the server's own timeout elapses.
      //
      // Written to a scratch name and renamed into place, because the panel polls this
      // directory and picks up anything matching command-*.json the moment it appears. A
      // plain write publishes the filename before the content is complete, so the panel
      // can read a truncated command, fail to parse it, and — since its parse failure path
      // writes an error response and deletes the command — turn a transient race into a
      // permanent spurious failure with no retry. rename() within one directory is atomic,
      // so the file becomes visible only once it is whole.
      //
      // The scratch name must not itself look like a command to the panel, which matches on
      // a "command-" prefix; a leading dot keeps it out of that test.
      const payload: Record<string, unknown> = {
        id: commandId,
        script,
        timeoutMs: timeoutMs,
        // Echoed from auth-token.json. The panel rejects a mismatched token when that file exists,
        // so a process that can write to this directory but has not read the token cannot inject a
        // command. See setupTempDirectory for the honest limits of that guarantee.
        token: this.authToken,
        timestamp: new Date().toISOString(),
      };
      // The panel branches on `type` and only knows one value for it; an ExtendScript command has
      // carried no type since the beginning, so adding one now would be a wire change for nothing.
      if (commandType === 'cep_js') payload['type'] = 'cep_js';
      await fs.writeFile(commandStaging, JSON.stringify(payload));
      await fs.rename(commandStaging, commandFile);

      // Wait for response (in a real implementation, this would be handled by the UXP plugin).
      // Batch operations pass a larger timeout because a single round-trip does the work of
      // dozens of individual calls inside one ExtendScript pass.
      return await this.waitForResponse(responseFile, effectiveTimeout, commandId);
    } finally {
      // Cleanup has to run on the failure path too. Previously it sat after the await, so a
      // timeout skipped it entirely and left the command file behind for the panel to pick
      // up and execute long after the caller had given up on it.
      //
      // One case this does not close: when the panel is merely slow, the response file is
      // written after this has already run, so it stays until the directory is cleaned. The
      // command file is the one that matters here, because a stale command still executes.
      await fs.unlink(commandStaging).catch(() => {});
      await fs.unlink(commandFile).catch(() => {});
      await fs.unlink(responseFile).catch(() => {});
    }
  }

  /**
   * What the transport is actually doing, with measured numbers rather than claims.
   *
   * `latency` is real round-trip timing (publish -> response) taken from a monotonic clock on this
   * side and including the panel's own execution time, because that is what a caller waits for. When
   * no command has completed over the socket, every field is null — an unmeasured latency is
   * reported as unmeasured, not as zero.
   */
  getTransportStatus(): {
    preference: 'auto' | 'file' | 'socket';
    activeChannel: 'socket' | 'file';
    activeChannelReason: string;
    protocolVersion: string;
    socket: {
      listening: boolean;
      port: number | null;
      endpointFile: string | null;
      panelConnected: boolean;
      handshake: PanelHandshake | null;
      inFlight: number;
      latency: LatencyStats | null;
    };
    publications: { socket: number; file: number; refusedAfterPublish: number };
  } {
    const decision = this.chooseChannel('extendscript');
    return {
      preference: this.transportPreference,
      activeChannel: decision.channel,
      activeChannelReason: decision.reason,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      socket: {
        listening: this.socket !== null && this.socket.listeningPort() !== null,
        port: this.socket ? this.socket.listeningPort() : null,
        endpointFile: this.socket ? join(this.tempDir, 'bridge-endpoint.json') : null,
        panelConnected: this.socket ? this.socket.isPanelReady() : false,
        handshake: this.socket ? this.socket.handshake() : null,
        inFlight: this.socket ? this.socket.inFlight() : 0,
        latency: this.socket ? this.socket.latency() : null,
      },
      publications: { ...this.publications },
    };
  }

  private async detectPremiereProInstallation(): Promise<void> {
    // Scan the install root instead of hardcoding release years, so new
    // versions (2025, 2026, ...) are detected without a code change.
    const searchDirs = process.platform === 'win32'
      ? [join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Adobe')]
      : ['/Applications'];

    for (const dir of searchDirs) {
      let entries: string[] = [];
      try {
        const listing = await fs.readdir(dir);
        entries = Array.isArray(listing) ? listing : [];
      } catch (error) {
        continue; // Install root is missing on this machine
      }

      // Newest release first, e.g. "Adobe Premiere Pro 2026" before "... 2024"
      const candidates = entries
        .filter(entry => entry.startsWith('Adobe Premiere Pro'))
        .sort()
        .reverse();

      for (const candidate of candidates) {
        const path = join(dir, candidate);
        try {
          await fs.access(path);
          this.logger.info(`Found Adobe Premiere Pro at: ${path}`);
          return;
        } catch (error) {
          // Continue checking other candidates
        }
      }
    }

    this.logger.warn('Adobe Premiere Pro installation not found in common paths');
  }

  private async initializeCommunication(): Promise<void> {
    // For now, we'll use file-based communication as it's the most reliable
    // In a production environment, you would set up UXP or ExtendScript communication
    this.communicationMethod = 'file';
    this.logger.info(`Using ${this.communicationMethod} communication method`);
  }

  private isSelfInvokingScript(script: string): boolean {
    const trimmed = script.trim();
    return /^\(function\s*\(\)\s*\{[\s\S]*\}\)\s*\(\)\s*;?$/.test(trimmed);
  }

  /**
   * Repairs the two characters that survive JSON.stringify but not the trip
   * into Premiere. Both were reproduced against a live 26.0.2 host.
   *
   * U+2028 and U+2029 are legal unescaped inside a JSON string, so
   * JSON.stringify leaves them raw — but they are line terminators to a
   * JavaScript parser, so a marker named with one produced a generated script
   * with a string literal split across two lines, and the whole call died as
   * "ExtendScript execution failed via CEP evalScript()". Re-escaping them is
   * safe here because everything this server generates is otherwise ASCII, so
   * the only place either can appear is inside a string literal.
   */
  private static repairScriptLineTerminators(script: string): string {
    return script
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  /**
   * A NUL truncates the script at that byte on the way through evalScript, so
   * the host silently receives a prefix of what was sent — a marker named
   * "p\0q" was created as "p". Truncated input is worse than a rejected call,
   * so refuse it and say which argument carried it.
   */
  private static assertNoNulByte(script: string): void {
    const index = script.indexOf('\u0000');
    if (index === -1) return;

    const context = script.slice(Math.max(0, index - 40), index).replace(/\s+/g, ' ');
    throw new Error(
      'Script contains a NUL byte, which Premiere truncates at rather than ' +
      'rejecting, silently discarding everything after it. Remove the NUL ' +
      `from the offending argument. Context before it: ...${context}`,
    );
  }

  private buildExecutableScript(script: string, callerAuthored = false): string {
    PremiereProBridge.assertNoNulByte(script);

    // The line-terminator repair is only safe on scripts this server generated, where
    // everything outside a string literal is ASCII and a U+2028 can therefore only be
    // caller data inside a string. A script handed to execute_extendscript breaks that
    // assumption: rewriting it blindly turned a U+2028 the caller used as a line break
    // into the literal characters \u2028, producing a syntax error on a script that
    // previously ran. Caller-authored source is passed through untouched.
    const safeScript = callerAuthored
      ? script
      : PremiereProBridge.repairScriptLineTerminators(script);

    if (this.isSelfInvokingScript(safeScript)) {
      return EXTENDSCRIPT_HELPERS + safeScript.trim();
    }

    // Wrap script bodies so top-level "return ..." remains valid in ExtendScript.
    return EXTENDSCRIPT_HELPERS + '(function(){\n' + safeScript + '\n})();';
  }

  // Read text from the macOS system clipboard (Node.js side — no CEP panel needed).
  readClipboard(): string {
    return execSync('/usr/bin/pbpaste').toString();
  }

  // Write text to the macOS system clipboard (Node.js side — no CEP panel, no crashes).
  writeClipboard(text: string): void {
    const result = spawnSync('/usr/bin/pbcopy', [], { input: text, encoding: 'utf8' });
    if (result.error) throw result.error;
  }

  // Execute JavaScript in the CEP panel context (not ExtendScript).
  // Has access to window.cep, CSInterface methods, browser APIs.
  async executeCepJs(script: string, timeoutMs = 10000): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Bridge not initialized. Call initialize() first.');
    }
    const commandId = randomUUID();
    try {
      // The cep_js path needs the token as much as the ExtendScript one — arguably more, since it
      // runs in the panel's own JS context with window and filesystem reach. An authenticated
      // ExtendScript channel beside an unauthenticated CEP one would be no protection at all. Both
      // channels carry it: the socket in its hello, the file in the command payload.
      //
      // Treated as mutating: panel-context JavaScript can do anything, so its half-applied state is
      // not something this server can reason about.
      return await this.publishCommand(commandId, 'cep_js', script, timeoutMs, true);
    } catch (error) {
      this.logger.error(`Failed to execute CEP JS: ${error}`);
      throw error;
    }
  }

  async executeScript(script: string, timeoutMs?: number, callerAuthored = false): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Bridge not initialized. Call initialize() first.');
    }

    const commandId = randomUUID();

    try {
      const fullScript = this.buildExecutableScript(script, callerAuthored);
      // Every generated script in this catalogue is treated as potentially mutating. There is no
      // reliable way to prove a given ExtendScript body is read-only by inspecting it, and guessing
      // wrong in the permissive direction would downgrade a "may have partially applied" warning on
      // a real edit into a shrug about a read.
      return await this.publishCommand(commandId, 'extendscript', fullScript, timeoutMs, true);
    } catch (error) {
      this.logger.error(`Failed to execute script: ${error}`);
      throw error;
    }
  }

  /**
   * Reads the panel's liveness heartbeat, returning null when it is absent or
   * unparseable (an older panel, or a torn write). ageMs is relative to the local
   * clock — panel and server share the same machine, so the two wall clocks agree.
   */
  private async readHeartbeat(): Promise<BridgeHeartbeat | null> {
    let raw: string;
    try {
      raw = await fs.readFile(join(this.tempDir, HEARTBEAT_FILE), 'utf8');
    } catch {
      return null;
    }

    try {
      const hb = JSON.parse(raw);
      if (typeof hb.ts !== 'number') return null;
      return {
        ageMs: Date.now() - hb.ts,
        connected: hb.connected === true,
        isProcessing: hb.isProcessing === true,
        currentCommandId: typeof hb.currentCommandId === 'string' ? hb.currentCommandId : null,
        currentCommandStartedAt:
          typeof hb.currentCommandStartedAt === 'number' ? hb.currentCommandStartedAt : null,
        queueLength: typeof hb.queueLength === 'number' ? hb.queueLength : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Turns the last observed heartbeat into an actionable timeout message. Each branch
   * names the ONE thing the caller can do about it, instead of the old catch-all that
   * listed every possible cause and left the reader to guess which applied.
   */
  private describeTimeout(
    timeout: number,
    hb: BridgeHeartbeat | null,
    commandId?: string,
  ): string {
    const base = `Bridge response timeout after ${timeout}ms.`;

    if (!hb) {
      return (
        base +
        ' No panel heartbeat was seen. Ensure Premiere Pro is open, the MCP Bridge (CEP) ' +
        'panel is open, Temp Directory is set to ' + this.tempDir + ', and Start Bridge is ' +
        'clicked. (An older panel build without heartbeat support also produces no heartbeat.)'
      );
    }

    if (!hb.connected) {
      return (
        base +
        ` The panel is open but the bridge is not started (heartbeat age ${hb.ageMs}ms). ` +
        'Click Start Bridge in the MCP Bridge panel.'
      );
    }

    if (hb.isProcessing && hb.currentCommandId && commandId && hb.currentCommandId !== commandId) {
      const busyFor =
        hb.currentCommandStartedAt != null
          ? `${Date.now() - hb.currentCommandStartedAt}ms`
          : 'an unknown time';
      return (
        base +
        ` The bridge is busy: the panel has been processing another command ` +
        `(id ${hb.currentCommandId}) for ${busyFor} and never started this one. If Premiere ` +
        'is showing a modal dialog (an import/codec/save prompt, for example), dismiss it — ' +
        'the bridge cannot advance queued commands until it clears.'
      );
    }

    if (hb.isProcessing && hb.currentCommandId === commandId) {
      return (
        base +
        ' The panel is still processing this command — the operation is genuinely ' +
        'long-running. Pass a larger timeoutMs or split the work into smaller steps.'
      );
    }

    if (hb.isProcessing) {
      return (
        base +
        ' The panel reports it is processing a command but produced no response. If Premiere ' +
        'is showing a modal dialog, dismiss it.'
      );
    }

    return (
      base +
      ` The panel is alive and idle (heartbeat age ${hb.ageMs}ms) but wrote no response for ` +
      'this command — the host-side script likely failed before it could write a result.'
    );
  }

  private async waitForResponse(
    responseFile: string,
    timeout = 60000,
    commandId?: string,
  ): Promise<any> {
    const startTime = Date.now();
    // A response that exists but will not parse is a different failure from one that has
    // not arrived, and reporting it as the latter sends the reader to check whether
    // Premiere is running when the real problem is the payload. Allow a few attempts for a
    // torn read — the panel's write is not atomic on every host — then surface the parse
    // error and a sample of what was actually on disk.
    let lastParseError: Error | null = null;
    let lastRawResponse = '';
    // Track the panel's liveness so a dead/frozen panel fails fast instead of blocking
    // the caller for the whole timeout, and so the timeout message (if we get there) can
    // say which of several unrelated things actually went wrong.
    let sawFreshHeartbeat = false;
    let lastHeartbeat: BridgeHeartbeat | null = null;

    while (Date.now() - startTime < timeout) {
      let raw: string;
      try {
        raw = await fs.readFile(responseFile, 'utf8');
      } catch {
        // Not written yet. This is the ordinary case while the host is still working.
        // Before sleeping, consult the panel heartbeat: if the panel was alive and has
        // since stopped ticking, there is no point waiting out the rest of the timeout.
        const elapsed = Date.now() - startTime;
        const hb = await this.readHeartbeat();
        if (hb) {
          lastHeartbeat = hb;
          if (hb.ageMs <= HEARTBEAT_STALE_MS) sawFreshHeartbeat = true;
        }

        // Fail fast only with positive evidence the panel HAD a live heartbeat that has
        // now gone stale or vanished — that means the panel or Premiere crashed, was
        // closed, or froze while we were waiting. A panel that never wrote a heartbeat
        // (older build) leaves sawFreshHeartbeat false and keeps the original behaviour.
        if (
          elapsed > HEARTBEAT_GRACE_MS &&
          sawFreshHeartbeat &&
          (!hb || hb.ageMs > HEARTBEAT_STALE_MS)
        ) {
          const age = hb ? `${hb.ageMs}ms old` : 'gone';
          throw new Error(
            `Bridge panel stopped responding: its heartbeat is ${age} while waiting for a ` +
            'response. Premiere Pro or the CEP panel likely crashed, was closed, or froze. ' +
            'Reopen the MCP Bridge panel and click Start Bridge. Temp Directory should be ' +
            this.tempDir + '.'
          );
        }

        await new Promise(resolve => setTimeout(resolve, 150));
        continue;
      }

      try {
        const parsed = JSON.parse(raw);
        if (parsed.result !== undefined) return parsed.result;
        return parsed;
      } catch (error) {
        lastParseError = error instanceof Error ? error : new Error(String(error));
        lastRawResponse = raw;
        // Keep polling to the full timeout rather than giving up after a few
        // attempts. A response written non-atomically can be unreadable for many
        // polls, and failing early would turn a slow write into a hard error. The
        // parse failure is remembered so the diagnosis below can still name it.
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }

    if (lastParseError) {
      throw new Error(
        `Bridge response never became valid JSON before the ${timeout}ms timeout. Last parse ` +
        `error: ${lastParseError.message}. First 200 characters on disk: ` +
        JSON.stringify(lastRawResponse.slice(0, 200))
      );
    }

    throw new Error(this.describeTimeout(timeout, lastHeartbeat, commandId));
  }

  // Project Management
  async createProject(name: string, location: string): Promise<PremiereProProject> {
    const normalizedLocation = location.replace(/[\\/]+$/, '');
    const projectFileName = name.endsWith('.prproj') ? name : `${name}.prproj`;
    const projectPath = `${normalizedLocation}/${projectFileName}`;
    const script = `
      var projectPath = ${JSON.stringify(projectPath)};
      var projectFolder = new Folder(${JSON.stringify(normalizedLocation)});

      if (!projectFolder.exists && !projectFolder.create()) {
        return JSON.stringify({
          success: false,
          error: "Could not create project folder",
          projectPath: projectPath
        });
      }

      var createdResult = app.newProject(projectPath);
      var projectFile = new File(projectPath);

      if (!projectFile.exists && app.project && app.project.saveAs) {
        try {
          app.project.saveAs(projectPath);
        } catch (saveError) {}
      }

      var project = app.project;
      var actualPath = project && project.path ? String(project.path) : "";

      if (!projectFile.exists || !__samePath(actualPath, projectPath)) {
        return JSON.stringify({
          success: false,
          error: "Premiere Pro did not create or activate the requested project",
          projectPath: projectPath,
          actualPath: actualPath,
          createdResult: createdResult
        });
      }

      return JSON.stringify({
        success: true,
        id: project.documentID,
        name: project.name,
        path: project.path,
        isOpen: true,
        sequences: [],
        projectItems: []
      });
    `;
    
    return await this.executeScript(script);
  }

  async openProject(path: string): Promise<PremiereProProject> {
    const script = `
      var projectPath = ${JSON.stringify(path)};
      var projectFile = new File(projectPath);

      if (!projectFile.exists) {
        return JSON.stringify({
          success: false,
          error: "Project file does not exist",
          projectPath: projectPath
        });
      }

      var openResult = app.openDocument(projectPath);
      var project = app.project;
      var actualPath = project && project.path ? String(project.path) : "";

      if (!project || !__samePath(actualPath, projectPath)) {
        return JSON.stringify({
          success: false,
          error: "Premiere Pro did not activate the requested project",
          projectPath: projectPath,
          actualPath: actualPath,
          openResult: openResult
        });
      }

      return JSON.stringify({
        success: true,
        id: project.documentID,
        name: project.name,
        path: project.path,
        isOpen: true,
        sequences: [],
        projectItems: []
      });
    `;
    
    return await this.executeScript(script);
  }

  async saveProject(): Promise<void> {
    const script = `
      // Save current project
      app.project.save();
      return JSON.stringify({ success: true });
    `;
    
    await this.executeScript(script);
  }

  async importMedia(filePath: string): Promise<PremiereProProjectItem> {
    // Validate file path for security
    const pathValidation = validateFilePath(filePath);
    if (!pathValidation.valid) {
      throw new Error(`Invalid file path: ${pathValidation.error}`);
    }

    // Use the normalized path from validation (don't double-escape)
    const safePath = pathValidation.normalized || filePath;
    const ext = extname(safePath).toLowerCase();
    if (UNSUPPORTED_MODAL_PRONE_IMPORT_EXTENSIONS.has(ext)) {
      return {
        success: false,
        error: `Unsupported import format "${ext}". Premiere Pro can show a blocking "File format not supported" modal for this file type, so the MCP server refused to import it before calling Premiere. Convert it to .srt or another Premiere-supported media format first.`,
        filePath: safePath,
        blockedBeforePremiere: true
      } as any;
    }

    const script = `
      try {
        function __walkItems(parent, output) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            output.push(child);
            if (child.type === ProjectItemType.BIN) {
              __walkItems(child, output);
            }
          }
        }

        var file = new File(${JSON.stringify(safePath)});
        if (!file.exists) {
          return JSON.stringify({
            success: false,
            error: "File not found: " + ${JSON.stringify(safePath)}
          });
        }

        var existingItems = [];
        __walkItems(app.project.rootItem, existingItems);

        // Premiere returns true when asked to import media already in the
        // project, but it does not add another project item. Reuse that item
        // instead of reporting a fabricated import failure.
        for (var existingIndex = 0; existingIndex < existingItems.length; existingIndex++) {
          var existingItem = existingItems[existingIndex];
          try {
            if (existingItem.getMediaPath && existingItem.getMediaPath() === file.fsName) {
              return JSON.stringify({
                success: true,
                id: existingItem.nodeId,
                name: existingItem.name,
                type: existingItem.type.toString(),
                mediaPath: file.fsName,
                alreadyImported: true
              });
            }
          } catch (e) {}
        }

        var importResult = app.project.importFiles([file.fsName], true, app.project.rootItem, false);
        if (!importResult) {
          return JSON.stringify({
            success: false,
            error: "Failed to import file"
          });
        }

        var afterItems = [];
        __walkItems(app.project.rootItem, afterItems);

        var importedItem = null;
        for (var j = 0; j < afterItems.length; j++) {
          var candidate = afterItems[j];
          var alreadyPresent = false;
          for (var k = 0; k < existingItems.length; k++) {
            if (existingItems[k].nodeId === candidate.nodeId) {
              alreadyPresent = true;
              break;
            }
          }
          if (alreadyPresent) {
            continue;
          }
          try {
            if (candidate.getMediaPath && candidate.getMediaPath() === file.fsName) {
              importedItem = candidate;
              break;
            }
          } catch (e) {}
          if (!importedItem && candidate.name === file.name) {
            importedItem = candidate;
          }
        }

        if (!importedItem) {
          return JSON.stringify({
            success: false,
            error: "Import completed but imported item could not be located"
          });
        }

        return JSON.stringify({
          success: true,
          id: importedItem.nodeId,
          name: importedItem.name,
          type: importedItem.type.toString(),
          mediaPath: importedItem.getMediaPath ? importedItem.getMediaPath() : file.fsName
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.executeScript(script);
  }

  async createSequence(name: string, presetPath: string): Promise<PremiereProSequence> {
    const script = `
      try {
        var sequenceName = ${JSON.stringify(name)};
        var presetPath = ${JSON.stringify(presetPath)};
        var presetFile = new File(presetPath);
        if (!presetFile.exists) {
          return JSON.stringify({
            success: false,
            error: "Sequence preset file not found: " + presetPath,
            sequenceName: sequenceName,
            blockedBeforePremiere: true
          });
        }
        var beforeIds = {};

        if (app.project && app.project.sequences) {
          for (var i = 0; i < app.project.sequences.numSequences; i++) {
            beforeIds[app.project.sequences[i].sequenceID] = true;
          }
        }

        var sequence = null;
        var createError = null;
        try {
          // newSequence(name, presetPath) is Premiere's non-interactive preset API.
          // createNewSequence() treats its second argument differently and can open
          // the native New Sequence dialog on current Premiere releases.
          sequence = app.project.newSequence(sequenceName, presetFile.fsName);
        } catch (createException) {
          createError = createException;
        }

        var created = sequence || null;
        if (!created && app.project && app.project.sequences) {
          for (var j = 0; j < app.project.sequences.numSequences; j++) {
            var candidate = app.project.sequences[j];
            if (!beforeIds[candidate.sequenceID] && candidate.name === sequenceName) {
              created = candidate;
              break;
            }
          }
        }

        // Last-resort name match, newest first. This MUST still exclude sequences that
        // existed before the call — without the beforeIds guard it would happily return
        // a pre-existing same-named sequence and report it as freshly created, the exact
        // false-positive this fallback used to produce.
        if (!created && app.project && app.project.sequences) {
          for (var k = app.project.sequences.numSequences - 1; k >= 0; k--) {
            var fallback = app.project.sequences[k];
            if (!beforeIds[fallback.sequenceID] && fallback.name === sequenceName) {
              created = fallback;
              break;
            }
          }
        }

        if (!created) {
          return JSON.stringify({
            success: false,
            error: createError
              ? createError.toString()
              : "Sequence creation completed but the new sequence could not be located",
            sequenceName: sequenceName
          });
        }

        return JSON.stringify({
          success: true,
          id: created.sequenceID,
          name: created.name,
          duration: created.end ? __ticksToSeconds(created.end) : 0,
          frameRate: created.timebase ? (254016000000 / parseInt(created.timebase, 10)) : null,
          videoTrackCount: created.videoTracks ? created.videoTracks.numTracks : 0,
          audioTrackCount: created.audioTracks ? created.audioTracks.numTracks : 0,
          videoTracks: [],
          audioTracks: []
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString(),
          sequenceName: ${JSON.stringify(name)}
        });
      }
    `;
    
    return await this.executeScript(script);
  }

  async addToTimeline(sequenceId: string, projectItemId: string, trackIndex: number, time: number, linkAudio: boolean = true, sourceInPoint?: number, sourceOutPoint?: number, insertMode: string = 'overwrite'): Promise<PremiereProClip> {
    const useInsert = insertMode === 'insert';
    const script = `
      try {
        // Both ids are caller-supplied and are embedded in generated ExtendScript.
        // Naive quoting here was a full code-execution hole, not just a bad error
        // message: an id of zz"); return JSON.stringify({PWNED:"..."}); (" closed
        // the call, ran arbitrary script, and returned a forged tool result while
        // the real work never happened.
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) {
          return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        }

        var projectItem = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!projectItem) {
          return JSON.stringify({ success: false, error: "Project item not found" });
        }

        // Audio-only routing: detect by file extension and route to audioTracks instead of
        // videoTracks. Without this, mp3/wav/aif/m4a/aac/flac/ogg clips fail with
        // "Video track not found" because addToTimeline always indexed sequence.videoTracks.
        var mediaPath = projectItem.getMediaPath ? projectItem.getMediaPath() : "";
        var isAudioOnly = /\\.(mp3|wav|aif|aiff|m4a|aac|flac|ogg|wma)$/i.test(mediaPath);
        var trackKind;
        var track;
        if (isAudioOnly) {
          trackKind = "audio";
          track = sequence.audioTracks[${trackIndex}];
          if (!track) {
            return JSON.stringify({ success: false, error: "Audio track not found at index ${trackIndex}", audioTrackCount: sequence.audioTracks.numTracks });
          }
        } else {
          trackKind = "video";
          track = sequence.videoTracks[${trackIndex}];
          if (!track) {
            return JSON.stringify({ success: false, error: "Video track not found at index ${trackIndex}", videoTrackCount: sequence.videoTracks.numTracks });
          }
        }

        // Source in/out: replicate the Source-monitor "mark in / mark out then
        // overwrite" move. overwriteClip(projectItem, time) places whatever range
        // is currently marked on the projectItem, so set the marks first. Without
        // this, an arbitrary interior sub-range of a source cannot be placed.
        var srcIn = ${sourceInPoint === undefined ? 'null' : sourceInPoint};
        var srcOut = ${sourceOutPoint === undefined ? 'null' : sourceOutPoint};
        var appliedSourceInOut = false;
        var sourceInOutError = "";
        if (srcIn !== null && srcOut !== null) {
          try {
            // mediaType 4 = all streams (video + audio) in one call
            projectItem.setInPoint(srcIn, 4);
            projectItem.setOutPoint(srcOut, 4);
            appliedSourceInOut = true;
          } catch (eio) {
            try {
              // fall back to per-stream marks (video=1, audio=2)
              projectItem.setInPoint(srcIn, 1);
              projectItem.setOutPoint(srcOut, 1);
              projectItem.setInPoint(srcIn, 2);
              projectItem.setOutPoint(srcOut, 2);
              appliedSourceInOut = true;
            } catch (eio2) {
              try {
                // last resort: no mediaType arg
                projectItem.setInPoint(srcIn);
                projectItem.setOutPoint(srcOut);
                appliedSourceInOut = true;
              } catch (eio3) {
                sourceInOutError = String(eio3);
              }
            }
          }
        }

        // insertMode was accepted by the tool, echoed back in its response, and then
        // dropped: placement was always an overwrite. A caller asking to insert-and-shift
        // therefore had existing footage destroyed and was told the opposite. Both methods
        // exist on video and audio tracks in 26.0.2, so honour the request — and refuse
        // rather than silently overwriting if this build lacks insertClip, since falling
        // back would be the destructive direction.
        var requestedInsert = ${useInsert ? 'true' : 'false'};
        if (requestedInsert) {
          if (typeof track.insertClip !== "function") {
            return JSON.stringify({
              success: false,
              error: "insertMode 'insert' was requested but this Premiere build exposes no track.insertClip. Refusing rather than overwriting, which would delete existing footage."
            });
          }
          track.insertClip(projectItem, ${time});
        } else {
          track.overwriteClip(projectItem, ${time});
        }

        var placedClip = null;
        for (var i = 0; i < track.clips.numItems; i++) {
          var candidate = track.clips[i];
          if (candidate && candidate.projectItem && candidate.projectItem.nodeId === projectItem.nodeId && Math.abs(candidate.start.seconds - ${time}) < 0.1) {
            placedClip = candidate;
            break;
          }
        }

        // No fallback to track.clips[numItems - 1]. That guessed at the last clip on the
        // track — which is simply whatever was already there when the placement did not
        // happen — and then reported its name, times and id back as though they were the
        // new clip. Worse, its start time drove the linkAudio=false sweep below, so a
        // placement that did nothing could delete a completely unrelated audio clip.
        // If the clip cannot be identified, nothing downstream may act on a guess.
        if (!placedClip) {
          return JSON.stringify({
            success: false,
            error: "Placement could not be confirmed: no clip from this project item appears at " + ${time} + "s on the target track. Nothing was reported back and no linked audio was removed.",
            trackKind: trackKind,
            requestedTime: ${time}
          });
        }

        // linkAudio=false post-processing: when placing a video-track clip whose source
        // media has an embedded audio stream (e.g. Remotion .mov outputs with silent PCM),
        // Premiere auto-links and places the audio counterpart on the next available
        // audio track via overwriteClip. This can DESTROY existing audio (Sprint 3 v14g
        // bug: silent overlay PCM overwrote founder voice on A1). Pass linkAudio=false
        // to scan audio tracks for the linked counterpart at the same start time and
        // remove it. The video on the target track is untouched.
        var unlinkedAudioRemoved = 0;
        if (!isAudioOnly && ${linkAudio} === false) {
          var videoStart = placedClip.start.seconds;
          var tolerance = 0.1;
          for (var at = 0; at < sequence.audioTracks.numTracks; at++) {
            var audioTrack = sequence.audioTracks[at];
            // iterate backwards because remove() may shift indices
            for (var ai = audioTrack.clips.numItems - 1; ai >= 0; ai--) {
              var audioClip = audioTrack.clips[ai];
              if (audioClip && audioClip.projectItem &&
                  audioClip.projectItem.nodeId === projectItem.nodeId &&
                  Math.abs(audioClip.start.seconds - videoStart) < tolerance) {
                try {
                  audioClip.remove(false, false); // ripple=false, alignToVideo=false
                  unlinkedAudioRemoved++;
                } catch (rmErr) {
                  // best effort — log but don't fail the whole add_to_timeline
                }
              }
            }
          }
        }

        return JSON.stringify({
          success: true,
          id: placedClip.nodeId,
          name: placedClip.name,
          trackKind: trackKind,
          inPoint: placedClip.start.seconds,
          outPoint: placedClip.end.seconds,
          duration: placedClip.duration.seconds,
          mediaPath: placedClip.projectItem && placedClip.projectItem.getMediaPath ? placedClip.projectItem.getMediaPath() : "",
          insertMode: ${JSON.stringify(useInsert ? 'insert' : 'overwrite')},
          linkAudio: ${linkAudio},
          unlinkedAudioRemoved: unlinkedAudioRemoved,
          appliedSourceInOut: appliedSourceInOut,
          sourceInOutError: sourceInOutError
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.executeScript(script);
  }

  // Batch variant of addToTimeline: place many clips in ONE ExtendScript round-trip.
  // The per-call file/WS round-trip (~seconds each, 60s timeout) is the real bottleneck when
  // placing a whole edit; looping inside one script collapses N round-trips into 1. Mirrors the
  // single-clip logic: audio-only routing by extension, Source-monitor in/out marking (mediaType
  // 4 with per-stream + no-arg fallbacks), overwriteClip. Returns a per-clip result array so a
  // single bad clip never sinks the batch.
  async addToTimelineBatch(sequenceId: string, clips: Array<{ projectItemId: string; trackIndex: number; time?: number; linkAudio?: boolean; sourceInPoint?: number; sourceOutPoint?: number }>, mode: 'absolute' | 'append' = 'absolute'): Promise<any> {
    const specs = clips.map(c => ({
      projectItemId: c.projectItemId,
      trackIndex: c.trackIndex,
      time: typeof c.time === 'number' ? c.time : 0,
      // Mirror the single-call default (true = keep Premiere's native audio linking).
      linkAudio: c.linkAudio === undefined ? true : c.linkAudio,
      sourceInPoint: c.sourceInPoint === undefined ? null : c.sourceInPoint,
      sourceOutPoint: c.sourceOutPoint === undefined ? null : c.sourceOutPoint,
    }));
    const appendMode = mode === 'append';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) {
          return JSON.stringify({ success: false, error: "Sequence not found" });
        }
        var specs = ${JSON.stringify(specs)};
        var appendMode = ${appendMode ? 'true' : 'false'};
        var results = [];
        // Append mode chains clips end-to-end with no gap. Each track keeps a running
        // cursor (in seconds) seeded from its existing content's end, then advanced to the
        // real frame-aligned end of each placed clip, so float-second rounding cannot open
        // a 1-frame gap between consecutive clips.
        var cursors = {};
        function trackEndSeconds(t) {
          var maxEnd = 0;
          for (var ei = 0; ei < t.clips.numItems; ei++) {
            var ec = t.clips[ei];
            if (ec && ec.end && ec.end.seconds > maxEnd) maxEnd = ec.end.seconds;
          }
          return maxEnd;
        }
        for (var c = 0; c < specs.length; c++) {
          var spec = specs[c];
          var r = { index: c, time: spec.time, success: false };
          try {
            var projectItem = __findProjectItem(spec.projectItemId);
            if (!projectItem) { r.error = "Project item not found"; results.push(r); continue; }

            var mediaPath = projectItem.getMediaPath ? projectItem.getMediaPath() : "";
            var isAudioOnly = /\\.(mp3|wav|aif|aiff|m4a|aac|flac|ogg|wma)$/i.test(mediaPath);
            var track = isAudioOnly ? sequence.audioTracks[spec.trackIndex] : sequence.videoTracks[spec.trackIndex];
            if (!track) { r.error = "Track not found at index " + spec.trackIndex; results.push(r); continue; }

            // Resolve the placement time. In append mode, ignore spec.time and use the
            // per-track cursor; seed it from the track's current end on first touch.
            var placeAt = spec.time;
            var cursorKey = (isAudioOnly ? "a" : "v") + spec.trackIndex;
            if (appendMode) {
              if (cursors[cursorKey] === undefined) cursors[cursorKey] = trackEndSeconds(track);
              placeAt = cursors[cursorKey];
            }
            r.time = placeAt;

            if (spec.sourceInPoint !== null && spec.sourceOutPoint !== null) {
              try {
                projectItem.setInPoint(spec.sourceInPoint, 4);
                projectItem.setOutPoint(spec.sourceOutPoint, 4);
              } catch (eio) {
                try {
                  projectItem.setInPoint(spec.sourceInPoint, 1);
                  projectItem.setOutPoint(spec.sourceOutPoint, 1);
                  projectItem.setInPoint(spec.sourceInPoint, 2);
                  projectItem.setOutPoint(spec.sourceOutPoint, 2);
                } catch (eio2) {
                  try {
                    projectItem.setInPoint(spec.sourceInPoint);
                    projectItem.setOutPoint(spec.sourceOutPoint);
                  } catch (eio3) {}
                }
              }
            }

            track.overwriteClip(projectItem, placeAt);

            var placedClip = null;
            for (var i = 0; i < track.clips.numItems; i++) {
              var candidate = track.clips[i];
              if (candidate && candidate.projectItem && candidate.projectItem.nodeId === projectItem.nodeId && Math.abs(candidate.start.seconds - placeAt) < 0.1) {
                placedClip = candidate;
                break;
              }
            }
            // Same reasoning as the single-call path: never fall back to the last clip on
            // the track. An unconfirmed placement here fed both this result row and the
            // linkAudio=false sweep below, so one no-op could report a pre-existing clip
            // as placed and delete an unrelated audio clip alongside it.
            if (!placedClip) {
              r.error = "Placement could not be confirmed: no clip from this project item appears at " + placeAt + "s on the target track. No linked audio was removed.";
              results.push(r);
              continue;
            }

            r.success = true;
            r.id = placedClip.nodeId;
            r.name = placedClip.name;
            r.inPoint = placedClip.start.seconds;
            r.outPoint = placedClip.end.seconds;
            // Advance the append cursor to this clip's real end so the next clip on the
            // same track butts up against it with no gap.
            if (appendMode) cursors[cursorKey] = placedClip.end.seconds;

            // linkAudio=false cleanup — mirror the single-call addToTimeline path so batch
            // rebuild/overlay workflows don't reintroduce the silent embedded-audio overwrite
            // bug. When a video-track clip's source carries an embedded audio stream, Premiere
            // auto-links and overwrites its counterpart onto an audio track, which can DESTROY
            // existing audio. When linkAudio is false, remove that counterpart at the same
            // start time. The video on the target track is untouched.
            r.linkAudio = spec.linkAudio;
            r.unlinkedAudioRemoved = 0;
            if (!isAudioOnly && spec.linkAudio === false) {
              var videoStart = placedClip.start.seconds;
              var tolerance = 0.1;
              for (var at = 0; at < sequence.audioTracks.numTracks; at++) {
                var audioTrack = sequence.audioTracks[at];
                // iterate backwards because remove() may shift indices
                for (var ai = audioTrack.clips.numItems - 1; ai >= 0; ai--) {
                  var audioClip = audioTrack.clips[ai];
                  if (audioClip && audioClip.projectItem &&
                      audioClip.projectItem.nodeId === projectItem.nodeId &&
                      Math.abs(audioClip.start.seconds - videoStart) < tolerance) {
                    try {
                      audioClip.remove(false, false); // ripple=false, alignToVideo=false
                      r.unlinkedAudioRemoved++;
                    } catch (rmErr) {
                      // best effort — don't fail this clip over cleanup
                    }
                  }
                }
              }
            }
          } catch (e) {
            r.error = e.toString();
          }
          results.push(r);
        }
        var placed = 0;
        for (var k = 0; k < results.length; k++) { if (results[k].success) placed++; }
        var failed = specs.length - placed;
        // Aggregate status must reflect reality: success is true ONLY when every requested
        // clip placed. placed===0 => failure; some-but-not-all => partial. Per-clip results[]
        // still carry the detail. (PR #48 review: don't report success when placements failed.)
        var allPlaced = (specs.length > 0 && placed === specs.length);
        return JSON.stringify({
          success: allPlaced,
          status: (placed === 0 ? "failure" : (allPlaced ? "success" : "partial")),
          placed: placed,
          failed: failed,
          total: specs.length,
          results: results
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.executeScript(script, 300000);
  }

  async renderSequence(
    sequenceId: string,
    outputPath: string,
    presetPath: string,
    options: { sourceRange?: 'entire' | 'in_out' | 'work_area'; removeOnCompletion?: boolean } = {}
  ): Promise<any> {
    const sourceRange = options.sourceRange ?? 'entire';
    const removeOnCompletion = options.removeOnCompletion ?? true;
    const encoder = await this.findInstalledMediaEncoder();
    if (encoder.available === false) {
      return {
        success: false,
        status: 'failed',
        code: 'MEDIA_ENCODER_NOT_INSTALLED',
        error: 'Adobe Media Encoder is not installed. The export was not sent to Premiere, so no native Media Encoder warning was shown.',
        searchedPaths: encoder.searchedPaths,
        outputPath,
        presetPath,
        sourceRange,
      };
    }
    const script = `
      try {
        var sequenceId = ${JSON.stringify(sequenceId)};
        var outputPath = ${JSON.stringify(outputPath)};
        var presetPath = ${JSON.stringify(presetPath)};
        var sourceRange = ${JSON.stringify(sourceRange)};
        var removeOnCompletion = ${removeOnCompletion ? 1 : 0};
        var warnings = [];

        function secondsOf(value) {
          if (value === null || typeof value === "undefined") return 0;
          try {
            if (typeof value.ticks !== "undefined") return Number(value.ticks) / 254016000000.0;
            if (typeof value.seconds !== "undefined") {
              var secondsValue = Number(value.seconds);
              return Math.abs(secondsValue) > 1000000 ? secondsValue / 254016000000.0 : secondsValue;
            }
          } catch (_) {}
          var numeric = Number(value);
          if (Math.abs(numeric) > 1000000) return numeric / 254016000000.0;
          return isNaN(numeric) ? 0 : numeric;
        }

        function rangeFailure(code, message, details) {
          var payload = {
            success: false,
            status: "failed",
            code: code,
            error: message,
            sourceRange: sourceRange,
            outputPath: outputPath,
            presetPath: presetPath,
            warnings: warnings
          };
          if (details) {
            for (var key in details) {
              if (details.hasOwnProperty(key)) payload[key] = details[key];
            }
          }
          return JSON.stringify(payload);
        }

        // Premiere 2026 dropped getSequenceByID; iterate via __findSequence helper.
        // Fail hard if the requested sequence isn't found — silently falling back to
        // app.project.activeSequence would queue/render the wrong timeline while still
        // reporting success, masking caller bugs (stale IDs, etc.).
        var sequence = __findSequence(sequenceId);
        if (!sequence) {
          return rangeFailure("SEQUENCE_NOT_FOUND", "Sequence not found by id: " + sequenceId);
        }
        if (typeof app.encoder === "undefined") {
          return rangeFailure("ENCODER_UNAVAILABLE", "app.encoder not available in this Premiere build");
        }

        // Boot AME if not already running so it can pick up the queue
        try { app.encoder.launchEncoder(); }
        catch (e1) {
          warnings.push({ code: "LAUNCH_ENCODER_FAILED", message: e1.toString() });
        }

        var sequenceEnd = secondsOf(sequence.end);
        var sequenceIn = 0;
        var sequenceOut = 0;
        try { sequenceIn = secondsOf(sequence.getInPointAsTime()); } catch (inReadError) {}
        try { sequenceOut = secondsOf(sequence.getOutPointAsTime()); } catch (outReadError) {}
        var inMarked = sequenceIn > 0;
        var outMarked = sequenceOut > 0;
        var range = null;
        var encoderRangeConstant = "";
        var resolvedRange = {
          "in": 0,
          "out": sequenceEnd,
          inMarked: inMarked,
          outMarked: outMarked,
          sequenceEnd: sequenceEnd
        };

        if (sourceRange === "in_out") {
          if (!inMarked && !outMarked) {
            return rangeFailure("IN_OUT_UNSET", "sourceRange in_out requested, but sequence In and Out are both unset.", { resolvedRange: resolvedRange });
          }
          if (!outMarked) {
            return rangeFailure("OUT_POINT_UNSET", "sourceRange in_out requested, but sequence Out is unset.", { resolvedRange: resolvedRange });
          }
          resolvedRange.in = inMarked ? sequenceIn : 0;
          resolvedRange.out = sequenceOut;
          if (resolvedRange.out <= resolvedRange.in) {
            return rangeFailure("INVALID_IN_OUT_RANGE", "sourceRange in_out requires Out to be greater than In.", { resolvedRange: resolvedRange });
          }
          if (sequenceEnd > 0 && resolvedRange.out > sequenceEnd + 0.001) {
            return rangeFailure("OUT_POINT_BEYOND_SEQUENCE_END", "Sequence Out exceeds the physical sequence end.", { resolvedRange: resolvedRange });
          }
          encoderRangeConstant = "ENCODE_IN_TO_OUT";
        } else if (sourceRange === "work_area") {
          var workIn = 0;
          var workOut = 0;
          try { workIn = secondsOf(sequence.getWorkAreaInPointAsTime()); } catch (workInReadError) {}
          try { workOut = secondsOf(sequence.getWorkAreaOutPointAsTime()); } catch (workOutReadError) {}
          resolvedRange = {
            "in": workIn,
            "out": workOut,
            inMarked: workIn > 0,
            outMarked: workOut > 0,
            sequenceEnd: sequenceEnd
          };
          if (workOut <= workIn) {
            return rangeFailure("INVALID_WORK_AREA_RANGE", "sourceRange work_area requires Work Area Out to be greater than Work Area In.", { resolvedRange: resolvedRange });
          }
          if (sequenceEnd > 0 && workOut > sequenceEnd + 0.001) {
            return rangeFailure("WORK_AREA_BEYOND_SEQUENCE_END", "Work Area Out exceeds the physical sequence end.", { resolvedRange: resolvedRange });
          }
          encoderRangeConstant = "ENCODE_WORKAREA";
        } else if (sourceRange === "entire") {
          encoderRangeConstant = "ENCODE_ENTIRE";
        } else {
          return rangeFailure("INVALID_SOURCE_RANGE", "Unsupported sourceRange: " + sourceRange);
        }

        if (typeof app.encoder[encoderRangeConstant] === "undefined") {
          return rangeFailure("ENCODER_RANGE_UNAVAILABLE", "Requested encoder range constant is unavailable: " + encoderRangeConstant, {
            encoderRangeConstant: encoderRangeConstant,
            resolvedRange: resolvedRange
          });
        }
        range = app.encoder[encoderRangeConstant];

        var jobID = app.encoder.encodeSequence(
          sequence,
          outputPath,
          presetPath,
          range,
          removeOnCompletion
        );

        if (!jobID) {
          return JSON.stringify({
            success: false,
            status: "failed",
            error: "encodeSequence returned no jobID — preset path may be invalid or AME not connected",
            outputPath: outputPath,
            presetPath: presetPath,
            sourceRange: sourceRange,
            resolvedRange: resolvedRange,
            encoderRangeConstant: encoderRangeConstant,
            warnings: warnings
          });
        }

        // Trigger AME to actually start processing the queued job
        var queueStarted = false;
        try {
          var startBatchResult = app.encoder.startBatch();
          queueStarted = startBatchResult !== false;
        } catch (e2) {
          warnings.push({ code: "START_BATCH_FAILED", message: e2.toString() });
        }

        return JSON.stringify({
          success: true,
          status: "queued",
          queued: true,
          queueStarted: queueStarted,
          jobID: String(jobID),
          outputPath: outputPath,
          presetPath: presetPath,
          sourceRange: sourceRange,
          resolvedRange: resolvedRange,
          encoderRangeConstant: encoderRangeConstant,
          removeOnCompletion: !!removeOnCompletion,
          warnings: warnings
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "encodeSequence threw: " + e.toString() });
      }
    `;

    const raw = await this.executeScript(script);
    // CEP returns the JSON.stringify'd object; bridge.executeScript returns parsed.result if present.
    // Some CEP plugins wrap as string; handle both.
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return { success: false, error: "Bridge returned unparseable string: " + raw }; }
    }
    return raw;
  }

  /**
   * Avoid calling app.encoder.launchEncoder() when AME is absent: Premiere shows
   * a blocking native warning in that case. An unreadable install directory is
   * treated as unknown, so a transient filesystem error does not disable export.
   */
  private async findInstalledMediaEncoder(): Promise<{ available: boolean; searchedPaths: string[] }> {
    if (process.platform === 'darwin') {
      const applications = '/Applications';
      try {
        const entries = await fs.readdir(applications);
        const found = entries.some((entry) => /^Adobe Media Encoder(?: \d+)?\.app$/i.test(entry));
        return { available: found, searchedPaths: [applications] };
      } catch {
        return { available: true, searchedPaths: [applications] };
      }
    }

    if (process.platform === 'win32') {
      const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((value): value is string => Boolean(value));
      const searchedPaths = roots.map((root) => join(root, 'Adobe'));
      if (searchedPaths.length === 0) return { available: true, searchedPaths };
      try {
        for (const directory of searchedPaths) {
          const entries = await fs.readdir(directory);
          if (entries.some((entry) => /^Adobe Media Encoder(?: \d+)?$/i.test(entry))) {
            return { available: true, searchedPaths };
          }
        }
        return { available: false, searchedPaths };
      } catch {
        return { available: true, searchedPaths };
      }
    }

    return { available: true, searchedPaths: [] };
  }

  async listProjectItems(): Promise<PremiereProProjectItem[]> {
    const script = `
      try {
        if (!app.project || !app.project.rootItem) {
          throw new Error('No open project');
        }
        function walk(item) {
          var results = [];
          if (item.type === ProjectItemType.BIN) {
            for (var i = 0; i < item.children.numItems; i++) {
              results = results.concat(walk(item.children[i]));
            }
          } else {
            results.push({
              id: item.nodeId || item.treePath || item.name,
              name: item.name,
              type: item.type === ProjectItemType.BIN ? 'bin' : (item.type === ProjectItemType.SEQUENCE ? 'sequence' : 'footage'),
              mediaPath: item.getMediaPath ? item.getMediaPath() : undefined,
              duration: item.getOutPoint ? (item.getOutPoint() - item.getInPoint()) : undefined,
              frameRate: item.getVideoFrameRate ? item.getVideoFrameRate() : undefined
            });
          }
          return results;
        }
        var items = walk(app.project.rootItem);
        return JSON.stringify({ ok: true, items: items });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e) });
      }
    `;
    const result = await this.executeScript(script);
    if (result.ok) return result.items;
    throw new Error(result.error || 'Unknown error listing project items');
  }

  async cleanup(): Promise<void> {
    if (this.uxpProcess) {
      this.uxpProcess.kill();
    }

    // Before the directory goes, so the endpoint file is retired and anything still in flight is
    // answered with the truth rather than left hanging on a listener that no longer exists.
    if (this.socket) {
      try {
        await this.socket.stop();
      } catch (error) {
        this.logger.warn('Failed to stop the WebSocket transport:', error);
      }
      this.socket = null;
    }

    // Retire our token BEFORE the directory decision below, because that decision leaves an
    // externally-configured directory standing — which is how a dead server's token used to stay
    // in place and reject a live one. This is symmetric with the socket transport retiring
    // bridge-endpoint.json above; the asymmetry was the bug.
    await this.retireAuthToken();

    // Only remove temp dirs created by this server. The shared bridge directory is
    // configured externally and should persist across restarts.
    try {
      if (!this.usesExternalTempDir) {
        await fs.rm(this.tempDir, { recursive: true });
      }
    } catch (error) {
      this.logger.warn('Failed to clean up temp directory:', error);
    }
    
    this.logger.info('Adobe Premiere Pro bridge cleaned up');
  }
} 
