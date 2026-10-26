/**
 * TrimmingTools -- the Trimming tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { GraphicsTools } from './graphics.js';
import { TRIM_LIB } from '../trim-lib.js';

export class TrimmingTools extends GraphicsTools {
  protected async rippleTrimIn(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    // Q: remove from the clip head up to the playhead and close the space. The clip stays where
    // it starts and plays from the playhead's source frame; everything after it, on every track,
    // moves left by the same amount so sync holds. See trim-lib.ts for the measured primitives.
    return await this.bridge.executeScript(`
      ${TRIM_LIB}
      var seq = ${this.buildSeqRes(sequenceId)};
      var track = seq.videoTracks[${Number(trackIndex)}];
      if (!track) return JSON.stringify({success:false,error:'Video track ${Number(trackIndex)} not found'});
      var clip = track.clips[${Number(clipIndex)}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var P = Number(seq.getPlayerPosition().ticks), s0 = __st(clip);
      if (!(P > s0.start && P < s0.end)) return JSON.stringify({success:false,error:'Put the playhead inside the clip (' + (s0.start/__TPS) + 's to ' + (s0.end/__TPS) + 's); it is at ' + (P/__TPS) + 's. Nothing was changed.'});
      var d = P - s0.start, group = __withLinked(clip), ops = [], skip = {};
      for (var i = 0; i < group.length; i++) { var gs = __st(group[i]); skip[__key(group[i])] = true; if (gs.start === s0.start && gs.end === s0.end) ops.push({item:group[i], kind:'rippleHead', d:d, before:gs}); }
      var rip = __planRipple(seq, s0.end, skip);
      if (rip.blockers.length) return JSON.stringify({success:false,error:'A ripple at ' + (s0.end/__TPS) + 's would break sync: ' + rip.blockers.join(', ') + ' span' + (rip.blockers.length===1?'s':'') + ' that point. Nothing was changed.'});
      var bad = __applyOps(ops, (Number(seq.timebase) || 10584000000) / 2).concat(__applyRipple(rip.movers, -d));
      return JSON.stringify({success:bad.length===0,verified:true,verifiedBy:'start/end/in readback of every edited and moved clip',trimmedSecs:d/__TPS,edits:__opsReport(ops),clipsRippled:rip.movers.length,
        error: bad.length ? 'PARTIALLY APPLIED: ' + bad.join('; ') + '. Undo to restore.' : undefined});
    `);
  }

  protected async rippleTrimOut(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    // W: remove from the playhead to the clip tail and close the space, sync-locked.
    return await this.bridge.executeScript(`
      ${TRIM_LIB}
      var seq = ${this.buildSeqRes(sequenceId)};
      var track = seq.videoTracks[${Number(trackIndex)}];
      if (!track) return JSON.stringify({success:false,error:'Video track ${Number(trackIndex)} not found'});
      var clip = track.clips[${Number(clipIndex)}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var P = Number(seq.getPlayerPosition().ticks), s0 = __st(clip);
      if (!(P > s0.start && P < s0.end)) return JSON.stringify({success:false,error:'Put the playhead inside the clip (' + (s0.start/__TPS) + 's to ' + (s0.end/__TPS) + 's); it is at ' + (P/__TPS) + 's. Nothing was changed.'});
      var d = s0.end - P, group = __withLinked(clip), ops = [], skip = {};
      for (var i = 0; i < group.length; i++) { var gs = __st(group[i]); skip[__key(group[i])] = true; if (gs.start === s0.start && gs.end === s0.end) ops.push({item:group[i], kind:'tail', d:-d, before:gs}); }
      var rip = __planRipple(seq, s0.end, skip);
      if (rip.blockers.length) return JSON.stringify({success:false,error:'A ripple at ' + (s0.end/__TPS) + 's would break sync: ' + rip.blockers.join(', ') + ' span' + (rip.blockers.length===1?'s':'') + ' that point. Nothing was changed.'});
      var bad = __applyOps(ops, (Number(seq.timebase) || 10584000000) / 2).concat(__applyRipple(rip.movers, -d));
      return JSON.stringify({success:bad.length===0,verified:true,verifiedBy:'start/end/in readback of every edited and moved clip',trimmedSecs:d/__TPS,edits:__opsReport(ops),clipsRippled:rip.movers.length,
        error: bad.length ? 'PARTIALLY APPLIED: ' + bad.join('; ') + '. Undo to restore.' : undefined});
    `);
  }

  protected async extendEdit(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    // E: move the clip's nearest edit point to the playhead. An abutting neighbour is rolled so no
    // gap or overlap opens; linked audio/video moves with it. Media handles are checked first,
    // because extending past the end of the media is accepted by the API and plays black.
    return await this.bridge.executeScript(`
      ${TRIM_LIB}
      var seq = ${this.buildSeqRes(sequenceId)};
      var track = seq.videoTracks[${Number(trackIndex)}];
      if (!track) return JSON.stringify({success:false,error:'Video track ${Number(trackIndex)} not found'});
      var clip = track.clips[${Number(clipIndex)}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var P = Number(seq.getPlayerPosition().ticks), s0 = __st(clip);
      var edge = Math.abs(P - s0.start) < Math.abs(P - s0.end) ? 'head' : 'tail';
      var d = P - (edge === 'head' ? s0.start : s0.end);
      if (Math.abs(d) < (Number(seq.timebase) || 10584000000) / 2) return JSON.stringify({success:true,verified:true,changed:false,edge:edge,note:'The playhead is already on that edit point; nothing to extend.'});
      var group = __withLinked(clip), ops = [], errors = [];
      for (var i = 0; i < group.length; i++) {
        var gs = __st(group[i]);
        if ((edge === 'head' ? gs.start : gs.end) !== (edge === 'head' ? s0.start : s0.end)) continue;
        var plan = __planRoll(seq, group[i], edge, d);
        if (plan.error) errors.push(plan.error); else ops = ops.concat(plan.ops);
      }
      if (errors.length) return JSON.stringify({success:false,edge:edge,deltaSecs:d/__TPS,error:errors.join(' ') + ' Nothing was changed.'});
      var bad = __applyOps(ops, (Number(seq.timebase) || 10584000000) / 2);
      return JSON.stringify({success:bad.length===0,verified:true,verifiedBy:'start/end/in readback of every edited clip',changed:true,edge:edge,deltaSecs:d/__TPS,edits:__opsReport(ops),
        error: bad.length ? 'PARTIALLY APPLIED: ' + bad.join('; ') + '. Undo to restore.' : undefined});
    `);
  }

  protected async nudgeClip(sequenceId: string | undefined, trackIndex: number, clipIndex: number, frames: number): Promise<any> {
    // move() takes a RELATIVE offset and moves only the item it is called on (measured on
    // 26.5.2). This used to pass the absolute new start, so a clip at 6s nudged one frame went
    // ~6s, and its linked audio stayed behind. The linked group now moves together, after every
    // destination is checked for room.
    return await this.bridge.executeScript(`
      ${TRIM_LIB}
      var seq = ${this.buildSeqRes(sequenceId)};
      var track = seq.videoTracks[${Number(trackIndex)}];
      var clip = track && track.clips[${Number(clipIndex)}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var tpf = Number(seq.timebase) || 10584000000, half = tpf / 2;
      var delta = ${Number(frames)} * tpf;
      if (delta === 0) return JSON.stringify({success:true,verified:true,changed:false,frames:0,note:'A nudge of 0 frames moves nothing.'});
      var group = __withLinked(clip), skip = {}, plan = [];
      for (var i = 0; i < group.length; i++) skip[__key(group[i])] = true;
      for (var g = 0; g < group.length; g++) {
        var it = group[g], st = __st(it), tr = __trackOf(seq, it);
        if (st.start + delta < -half) return JSON.stringify({success:false,error:__label(seq, it) + ' would start before 0. Nothing was changed.'});
        for (var k = 0; tr && k < tr.clips.numItems; k++) {
          var o = tr.clips[k]; if (skip[__key(o)]) continue;
          var os = __st(o);
          if (os.start < st.end + delta - half && os.end > st.start + delta + half) return JSON.stringify({success:false,error:__label(seq, o) + ' is in the way of ' + __label(seq, it) + '. Nothing was changed.'});
        }
        plan.push({item:it, start:st.start});
      }
      var bad = __applyRipple(plan, delta);
      var moved = [];
      for (var m = 0; m < plan.length; m++) moved.push({clip:String(plan[m].item.name), mediaType:String(plan[m].item.mediaType), startSecs:Number(plan[m].item.start.ticks)/__TPS});
      return JSON.stringify({success:bad.length===0,verified:true,verifiedBy:'TrackItem.start readback of every linked item',changed:true,frames:${Number(frames)},moved:moved,
        error: bad.length ? 'PARTIALLY APPLIED: ' + bad.join('; ') + '. Undo to restore.' : undefined});
    `);
  }


  /**
   * Shared ExtendScript for the gap tools. A gap here is a range where NO track, video or audio,
   * has material: closing anything narrower would pull one track against another and break sync.
   * TrackItem.move() takes a relative offset and moves only the item it is called on (measured on
   * 26.5.2: moving V1 left its linked A1 where it was), so every clip after the gap is moved
   * individually, earliest first so nothing is moved onto a neighbour, and every start is read
   * back. This replaces two stubs: close_gap_at was a syntax error, and close_all_gaps reported
   * success without moving anything.
   */
  private gapCloserScript(sequenceId: string | undefined, body: string): string {
    return `
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var TPS = 254016000000;
        var __items = function(){
          var out = [];
          var groups = [seq.videoTracks, seq.audioTracks];
          for (var g=0; g<2; g++) {
            for (var ti=0; ti<groups[g].numTracks; ti++) {
              var tr = groups[g][ti];
              for (var ci=0; ci<tr.clips.numItems; ci++) {
                var c = tr.clips[ci];
                out.push({clip:c, kind:g===0?'V':'A', track:ti, start:Number(c.start.ticks), end:Number(c.end.ticks)});
              }
            }
          }
          return out;
        };
        // Empty ranges across ALL tracks, from 0 up to the last edit.
        var __gaps = function(){
          var items = __items();
          items.sort(function(x,y){ return x.start - y.start; });
          var gaps = [], cursor = 0;
          for (var i=0; i<items.length; i++) {
            if (items[i].start > cursor) gaps.push({start:cursor, end:items[i].start});
            if (items[i].end > cursor) cursor = items[i].end;
          }
          return gaps;
        };
        var __close = function(gap){
          var len = gap.end - gap.start;
          var items = __items();
          var movers = [];
          for (var i=0; i<items.length; i++) { if (items[i].start >= gap.end) movers.push(items[i]); }
          movers.sort(function(x,y){ return x.start - y.start; });
          var off = new Time(); off.ticks = String(-len);
          var bad = [];
          for (var m=0; m<movers.length; m++) {
            movers[m].clip.move(off);
            var now = Number(movers[m].clip.start.ticks);
            if (now !== movers[m].start - len) bad.push(movers[m].kind + (movers[m].track+1) + ' clip at ' + (movers[m].start/TPS) + 's is now at ' + (now/TPS) + 's');
          }
          return {startSecs:gap.start/TPS, endSecs:gap.end/TPS, durationSecs:len/TPS, clipsMoved:movers.length, misplaced:bad};
        };
        ${body}
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `;
  }

  protected async closeGapAt(timecode: string, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(this.gapCloserScript(sequenceId, `
        var tc = ${JSON.stringify(String(timecode))};
        var target = null;
        var parts = tc.split(/[:;]/);
        if (parts.length === 4) {
          var fps = TPS / Number(seq.timebase);
          target = Math.round(((Number(parts[0])*3600 + Number(parts[1])*60 + Number(parts[2])) + Number(parts[3])/fps) * TPS);
        } else if (parts.length === 1 && !isNaN(Number(tc))) {
          target = Math.round(Number(tc) * TPS);
        }
        if (target === null || isNaN(target)) return JSON.stringify({success:false,error:'Could not read timecode "' + tc + '". Pass HH:MM:SS:FF or a number of seconds.'});
        var gaps = __gaps(), hit = null;
        for (var i=0; i<gaps.length; i++) { if (target >= gaps[i].start && target < gaps[i].end) { hit = gaps[i]; break; } }
        if (!hit) return JSON.stringify({success:false,error:'There is no gap across all tracks at ' + (target/TPS) + 's. Something occupies that time on at least one video or audio track, and closing a gap on one track alone would break sync. Nothing was changed.',gapsInSequence:gaps.length});
        var r = __close(hit);
        var ok = r.misplaced.length === 0;
        return JSON.stringify({success:ok,verified:ok,verifiedBy:'clip start readback',gap:r,
          error: ok ? undefined : 'PARTIALLY APPLIED: some clips did not land where expected. See gap.misplaced. Undo to restore.'});
    `));
  }

  protected async closeAllGaps(sequenceId?: string, trackIndex?: number): Promise<any> {
    return await this.bridge.executeScript(this.gapCloserScript(sequenceId, `
        var limit = ${trackIndex === undefined ? 'null' : Number(trackIndex)};
        var before = __gaps();
        if (!before.length) return JSON.stringify({success:true,verified:true,verifiedBy:'gap scan',gapsClosed:0,message:'No gaps across all tracks.'});
        var closed = [];
        // Latest first: closing a gap moves everything after it, so working backwards keeps every
        // earlier gap where the scan found it.
        for (var i=before.length-1; i>=0; i--) closed.push(__close(before[i]));
        var after = __gaps();
        var misplaced = 0;
        for (var k=0; k<closed.length; k++) misplaced += closed[k].misplaced.length;
        var ok = after.length === 0 && misplaced === 0;
        return JSON.stringify({success:ok,verified:ok,verifiedBy:'gap rescan + clip start readback',gapsFound:before.length,gapsClosed:closed.length,gapsRemaining:after.length,closed:closed,
          trackIndexNote: limit === null ? undefined : 'trackIndex is ignored: only gaps empty on every track are closed, because closing one track alone breaks sync.',
          error: ok ? undefined : 'PARTIALLY APPLIED: ' + after.length + ' gap(s) remain and ' + misplaced + ' clip(s) are misplaced. Undo to restore.'});
    `));
  }

  protected async trimClip(clipId: string, inPoint?: number, outPoint?: number, duration?: number): Promise<any> {
    if (outPoint !== undefined && duration !== undefined) {
      return {
        success: false,
        error: 'outPoint and duration cannot be used together',
        errorCode: 'INVALID_TRIM_ARGUMENTS'
      };
    }
    // inPoint/outPoint are SOURCE times; the trim keeps every remaining frame where it was on the
    // timeline (the clip's start moves with a new in-point). This used to write inPoint, which only
    // slips, and outPoint, which changes nothing visible, then report "trimmed and verified" from
    // those same readbacks. Linked audio/video is trimmed with it so sync holds.
    const num = (v: number | undefined) => (v === undefined ? 'null' : String(Number(v)));
    return await this.bridge.executeScript(`
      ${TRIM_LIB}
      var info = __findClip(${JSON.stringify(clipId)});
      if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
      var clip = info.clip, seq = info.sequence;
      var tpf = Number(seq.timebase) || 10584000000, half = tpf / 2;
      var s0 = __st(clip), media = __mediaEnd(clip);
      var reqIn = ${num(inPoint)}, reqOut = ${num(outPoint)}, reqDur = ${num(duration)};
      var newIn = reqIn === null ? s0.inp : Math.round(reqIn * __TPS);
      if (newIn < 0) return JSON.stringify({success:false,errorCode:'TRIM_OUT_OF_RANGE',error:'inPoint cannot be negative.'});
      var newStart = s0.start + (newIn - s0.inp);
      if (newStart < 0) return JSON.stringify({success:false,errorCode:'TRIM_OUT_OF_RANGE',error:'That in-point would start the clip before 0 on the timeline.'});
      var newEnd = s0.end;
      if (reqOut !== null) newEnd = newStart + (Math.round(reqOut * __TPS) - newIn);
      if (reqDur !== null) newEnd = newStart + Math.round(reqDur * __TPS);
      // Snap to the sequence frame grid relative to the clip, the same way Premiere does.
      newStart = s0.start + Math.round((newStart - s0.start) / tpf) * tpf;
      newIn = s0.inp + (newStart - s0.start);
      newEnd = newStart + Math.round((newEnd - newStart) / tpf) * tpf;
      if (newEnd - newStart < tpf) return JSON.stringify({success:false,errorCode:'TRIM_OUT_OF_RANGE',error:'The trimmed clip would be shorter than one frame.'});
      if (media !== null && newIn + (newEnd - newStart) > media + half) return JSON.stringify({success:false,errorCode:'TRIM_UNSUPPORTED_FOR_CLIP',error:'The media is only ' + (media/__TPS) + 's long; that trim would need source up to ' + ((newIn + newEnd - newStart)/__TPS) + 's and the rest would play black. Nothing was changed.'});
      var group = __withLinked(clip), skip = {}, ops = [];
      for (var i = 0; i < group.length; i++) skip[__key(group[i])] = true;
      for (var g = 0; g < group.length; g++) {
        var it = group[g], st = __st(it);
        if (st.start !== s0.start || st.end !== s0.end) continue;
        var tr = __trackOf(seq, it);
        for (var k = 0; tr && k < tr.clips.numItems; k++) {
          var o = tr.clips[k]; if (skip[__key(o)]) continue; var os = __st(o);
          var grows = (newStart < s0.start && os.end > newStart + half && os.start < s0.start - half) || (newEnd > s0.end && os.start < newEnd - half && os.end > s0.end + half);
          if (grows) return JSON.stringify({success:false,errorCode:'TRIM_BLOCKED',error:__label(seq, o) + ' is in the way. Nothing was changed.'});
        }
        ops.push({item:it, kind:'set', to:{start:newStart, end:newEnd}, before:st});
      }
      var bad = __applyOps(ops, half);
      var a = __st(clip), rolledBack = null, code = null;
      if (bad.length) {
        rolledBack = __rollbackOps(ops, half);
        // A write Premiere ignores outright (a native Graphic will not extend, for one) leaves the
        // edge where it was: that is unsupported for this clip, not a half-applied edit.
        code = (Math.abs(a.end - s0.end) <= half && newEnd !== s0.end) || (Math.abs(a.start - s0.start) <= half && newStart !== s0.start) ? 'TRIM_UNSUPPORTED_FOR_CLIP' : 'TRIM_NOT_APPLIED';
      }
      var r = bad.length ? __st(clip) : a;
      return JSON.stringify({ success: bad.length === 0, verified: true, verifiedBy: 'start/end/in readback of the clip and its linked items',
        message: bad.length ? undefined : "Clip trimmed and verified", clipId: ${JSON.stringify(clipId)},
        oldDuration: (s0.end - s0.start)/__TPS, newDuration: (r.end - r.start)/__TPS, newInPoint: r.inp/__TPS,
        before: { startSecs: s0.start/__TPS, endSecs: s0.end/__TPS, sourceInSecs: s0.inp/__TPS, durationSecs: (s0.end-s0.start)/__TPS },
        attempted: { startSecs: a.start/__TPS, endSecs: a.end/__TPS, sourceInSecs: a.inp/__TPS, durationSecs: (a.end-a.start)/__TPS },
        after: { startSecs: r.start/__TPS, endSecs: r.end/__TPS, sourceInSecs: r.inp/__TPS, sourceOutSecs: (r.inp + r.end - r.start)/__TPS, durationSecs: (r.end-r.start)/__TPS },
        linkedItemsTrimmed: ops.length - 1, rolledBack: rolledBack, errorCode: code || undefined,
        error: !bad.length ? undefined : (code === 'TRIM_UNSUPPORTED_FOR_CLIP' ? 'Premiere Pro does not support trimming this clip to the requested range (the edge did not move). ' : 'Premiere Pro did not apply the requested trim: ' + bad.join('; ') + '. ') + (rolledBack ? 'The clip was restored.' : 'The clip could NOT be fully restored; undo.') });
    `);
  }

  protected async getSequenceGaps(seqId?: string, trackIndex?: number): Promise<any> {
    // Computed from clip ranges: getTimelineGaps() does not exist on this host, and the old
    // typeof-guarded call reported gapCount:0 on every sequence, gaps or not.
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var only = ${trackIndex === undefined ? 'null' : Number(trackIndex)};
        if (only !== null && !seq.videoTracks[only]) return JSON.stringify({success:false,error:'Video track ' + only + ' not found'});
        var TPS = 254016000000, result = [];
        for (var t=0; t<seq.videoTracks.numTracks; t++) {
          if (only !== null && t !== only) continue;
          var g = __trackGaps(seq.videoTracks[t]);
          for (var i=0; i<g.length; i++) result.push({trackIndex:t,startTicks:String(g[i].start),endTicks:String(g[i].end),startSecs:g[i].start/TPS,endSecs:g[i].end/TPS,durationSecs:(g[i].end-g[i].start)/TPS});
        }
        var black = __videoGaps(seq), blackOut = [];
        for (var b=0; b<black.length; b++) blackOut.push({startSecs:black[b].start/TPS,endSecs:black[b].end/TPS,durationSecs:(black[b].end-black[b].start)/TPS});
        return JSON.stringify({success:true,gapCount:result.length,gaps:result.slice(0,200),truncated:result.length>200,
          programGaps:blackOut,programGapsNote:'Ranges where no video track has a clip, so the program shows black.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

}
