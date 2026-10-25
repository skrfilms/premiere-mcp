/**
 * TrimmingTools -- the Trimming tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { GraphicsTools } from './graphics.js';

export class TrimmingTools extends GraphicsTools {
  protected async rippleTrimIn(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var track = seq.videoTracks[${trackIndex}];
      if (!track) return JSON.stringify({success:false,error:'Track not found'});
      var clip = track.clips[${clipIndex}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var playhead = seq.getPlayerPosition();
      var beforeStart = String(clip.start.ticks);
      // Ripple trim: set clip start to playhead by adjusting inPoint
      var frameDelta = Number(playhead.ticks) - Number(clip.start.ticks);
      var newInTicks = Number(clip.inPoint.ticks) + frameDelta;
      if (newInTicks < 0) return JSON.stringify({success:false,error:'Not enough head room to trim to playhead'});
      var newIn = new Time(); newIn.ticks = String(Math.round(newInTicks));
      // TrackItem exposes inPoint as a writable property; there is no setInPoint()
      // method on it (confirmed by reflection on 26.3.2). Read back to prove it took.
      var __inBefore = Number(clip.inPoint.ticks);
      clip.inPoint = newIn;
      var __inAfter = Number(clip.inPoint.ticks);
      if (__inAfter === __inBefore) return JSON.stringify({success:false,verified:false,error:'Assigning clip.inPoint did not change it (property may be read-only on this build). No ripple performed.',requestedTicks:String(newIn.ticks)});
      var afterStart = String(clip.start.ticks);
      // Three outcomes, and they must not be collapsed. Previously this returned
      // success:true with verified:false and NO reason, which tells a caller nothing:
      //   - frameDelta 0: nothing was asked for, so nothing changing is correct.
      //   - start moved: the ripple landed.
      //   - inPoint moved but start did not: the edit is HALF-APPLIED. The source in-point
      //     changed while the clip did not move on the timeline, which is worse than a
      //     failure because the project is now in a state the caller did not ask for.
      if (frameDelta === 0) return JSON.stringify({success:true,verified:true,changed:false,note:'Playhead is already at the clip start; nothing to trim.',beforeStart:beforeStart,afterStart:afterStart});
      if (afterStart === beforeStart) return JSON.stringify({success:false,verified:true,changed:true,halfApplied:true,error:'The source in-point moved but the clip did not ripple on the timeline, so this edit is half-applied: clip.inPoint is now '+String(clip.inPoint.ticks)+' ticks while clip.start is unchanged at '+beforeStart+'. Undo before retrying.',beforeStart:beforeStart,afterStart:afterStart,inPointTicks:String(clip.inPoint.ticks)});
      return JSON.stringify({success:true,verified:true,changed:true,beforeStart:beforeStart,afterStart:afterStart,playheadTicks:String(playhead.ticks)});
    `);
  }

  protected async rippleTrimOut(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var track = seq.videoTracks[${trackIndex}];
      if (!track) return JSON.stringify({success:false,error:'Track not found'});
      var clip = track.clips[${clipIndex}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var playhead = seq.getPlayerPosition();
      var beforeEnd = String(clip.end.ticks);
      var frameDelta = Number(clip.end.ticks) - Number(playhead.ticks);
      var newOutTicks = Number(clip.outPoint.ticks) - frameDelta;
      var newOut = new Time(); newOut.ticks = String(Math.round(newOutTicks));
      var __outBefore = Number(clip.outPoint.ticks);
      clip.outPoint = newOut;
      var __outAfter = Number(clip.outPoint.ticks);
      if (__outAfter === __outBefore) return JSON.stringify({success:false,verified:false,error:'Assigning clip.outPoint did not change it (property may be read-only on this build). No ripple performed.',requestedTicks:String(newOut.ticks)});
      var afterEnd = String(clip.end.ticks);
      if (afterEnd === beforeEnd) return JSON.stringify({success:false,verified:true,changed:true,halfApplied:true,error:'The source out-point moved but the clip end did not change on the timeline, so this edit is half-applied: clip.outPoint is now '+String(clip.outPoint.ticks)+' ticks while clip.end is unchanged at '+beforeEnd+'. Undo before retrying.',beforeEnd:beforeEnd,afterEnd:afterEnd,outPointTicks:String(clip.outPoint.ticks)});
      return JSON.stringify({success:true,verified:true,changed:true,beforeEnd:beforeEnd,afterEnd:afterEnd,playheadTicks:String(playhead.ticks)});
    `);
  }

  protected async extendEdit(sequenceId: string | undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var track = seq.videoTracks[${trackIndex}];
      var clip = track && track.clips[${clipIndex}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var playhead = seq.getPlayerPosition();
      var ph = Number(playhead.ticks);
      var distToIn = Math.abs(ph - Number(clip.start.ticks));
      var distToOut = Math.abs(ph - Number(clip.end.ticks));
      var extendIn = distToIn < distToOut;
      var beforeTick = extendIn ? String(clip.start.ticks) : String(clip.end.ticks);
      var t = new Time(); t.ticks = String(ph);
      if (extendIn) { clip.inPoint = t; } else { clip.outPoint = t; }
      var afterTick = extendIn ? String(clip.start.ticks) : String(clip.end.ticks);
      if (afterTick === beforeTick) return JSON.stringify({success:false,verified:true,changed:false,error:'The '+(extendIn?'in':'out')+' edge did not move. The playhead may already be at that edge, or the clip has no room to extend in that direction (check the adjacent clip and available source handles).',extendedEdge:extendIn?'in':'out',before:beforeTick,after:afterTick});
      return JSON.stringify({success:true,verified:true,changed:true,extendedEdge:extendIn?'in':'out',before:beforeTick,after:afterTick});
    `);
  }

  protected async nudgeClip(sequenceId: string | undefined, trackIndex: number, clipIndex: number, frames: number): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var track = seq.videoTracks[${trackIndex}];
      var clip = track && track.clips[${clipIndex}];
      if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
      var ticksPerFrame = Number(seq.timebase) || 10584000000;
      var before = String(clip.start.ticks);
      var wantTicks = Math.max(0, Math.round(Number(before) + ${frames} * ticksPerFrame));
      var newStart = new Time(); newStart.ticks = String(wantTicks);
      clip.move(newStart, ${trackIndex});
      var after = String(clip.start.ticks);
      // Enumerate the outcomes rather than shipping a bare inequality. A nudge of 0
      // frames, a nudge clamped at 0, and a nudge Premiere refused all read back with
      // before === after, and only the last of those is a failure.
      var onTarget = Math.abs(Number(after) - wantTicks) < ticksPerFrame / 2;
      var changed = after !== before;
      if (onTarget) {
        return JSON.stringify({success:true,verified:true,verifiedBy:'TrackItem.start readback',changed:changed,frames:${frames},before:before,after:after,
          note: changed ? undefined : 'The clip was already at the requested position, so nothing moved.'});
      }
      return JSON.stringify({success:false,verified:true,verifiedBy:'TrackItem.start readback',changed:changed,frames:${frames},before:before,after:after,wantTicks:String(wantTicks),
        error:'The clip did not land at the requested position. move() is blocked when the destination overlaps another clip on the same track, and it clamps at 0. Clear the destination or move to an empty track first.'});
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

    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        function secondsOf(value) {
          if (value === undefined || value === null) return null;
          if (typeof value === "number") return value;
          if (value.seconds !== undefined) return Number(value.seconds);
          if (value.ticks !== undefined) return Number(value.ticks) / 254016000000.0;
          return null;
        }
        function frameDurationOf(sequence) {
          try {
            if (sequence && sequence.timebase !== undefined) {
              var value = Number(sequence.timebase) / 254016000000.0;
              if (value > 0 && isFinite(value)) return value;
            }
          } catch (frameError) {}
          return 1 / 48;
        }
        var frameDurationSeconds = frameDurationOf(info.sequence);
        function exactEnough(a, b) {
          return a !== null && b !== null && Math.abs(a - b) < 0.000001;
        }
        function closeEnough(a, b) {
          return a !== null && b !== null && Math.abs(a - b) <= (frameDurationSeconds / 2) + 0.000001;
        }
        function timeFromSeconds(seconds) {
          var t = new Time();
          t.seconds = Number(seconds);
          return t;
        }
        function capturedTime(value) {
          if (value === undefined || value === null) return null;
          var captured = { seconds: secondsOf(value), ticks: null };
          try {
            if (value.ticks !== undefined && value.ticks !== null) captured.ticks = String(value.ticks);
          } catch (ticksError) {}
          return captured;
        }
        function timeFromCaptured(captured) {
          if (!captured) return null;
          var t = new Time();
          if (captured.ticks !== null) t.ticks = captured.ticks;
          else t.seconds = Number(captured.seconds);
          return t;
        }
        function stateOf() {
          return {
            inPoint: secondsOf(clip.inPoint),
            outPoint: secondsOf(clip.outPoint),
            start: secondsOf(clip.start),
            end: secondsOf(clip.end),
            duration: secondsOf(clip.duration)
          };
        }

        var before = stateOf();
        var original = {
          inPoint: capturedTime(clip.inPoint),
          outPoint: capturedTime(clip.outPoint),
          start: capturedTime(clip.start),
          end: capturedTime(clip.end)
        };
        var writeErrors = [];
        function recordWriteError(propertyName, error) {
          writeErrors.push({ property: propertyName, error: error.toString() });
        }

        ${inPoint !== undefined ? `
        if (!exactEnough(before.inPoint, ${inPoint})) {
          try { clip.inPoint = timeFromSeconds(${inPoint}); }
          catch (inPointError) { recordWriteError("inPoint", inPointError); }
        }
        ` : ''}
        ${outPoint !== undefined ? `
        if (!exactEnough(before.outPoint, ${outPoint})) {
          try { clip.outPoint = timeFromSeconds(${outPoint}); }
          catch (outPointError) { recordWriteError("outPoint", outPointError); }
        }
        ` : ''}
        ${duration !== undefined ? `
        var targetDuration = ${duration};
        if (!exactEnough(before.duration, targetDuration)) {
          try {
            clip.end = timeFromSeconds(secondsOf(clip.start) + targetDuration);
          } catch (timelineError) {
            recordWriteError("end", timelineError);
          }
        }
        ` : ''}

        var after = stateOf();
        var verified = true;
        var verificationErrors = [];
        ${inPoint !== undefined ? `
        if (!closeEnough(after.inPoint, ${inPoint})) {
          verified = false;
          verificationErrors.push("inPoint did not change to requested value");
        }
        ` : ''}
        ${outPoint !== undefined ? `
        if (!closeEnough(after.outPoint, ${outPoint})) {
          verified = false;
          verificationErrors.push("outPoint did not change to requested value");
        }
        ` : ''}
        ${duration !== undefined ? `
        if (!closeEnough(after.duration, ${duration})) {
          verified = false;
          verificationErrors.push("timeline duration did not change to requested value");
        }
        ` : ''}

        if (!verified) {
          var attempted = after;
          var rollbackErrors = [];
          function rollback(propertyName, captured) {
            try {
              if (captured) clip[propertyName] = timeFromCaptured(captured);
            } catch (rollbackError) {
              rollbackErrors.push({ property: propertyName, error: rollbackError.toString() });
            }
          }
          ${duration !== undefined ? 'if (!exactEnough(attempted.end, before.end)) rollback("end", original.end);' : ''}
          ${outPoint !== undefined || duration !== undefined ? 'if (!exactEnough(attempted.outPoint, before.outPoint)) rollback("outPoint", original.outPoint);' : ''}
          ${inPoint !== undefined ? 'if (!exactEnough(attempted.inPoint, before.inPoint)) rollback("inPoint", original.inPoint);' : ''}
          var restored = stateOf();
          var rolledBack =
            exactEnough(restored.inPoint, before.inPoint) &&
            exactEnough(restored.outPoint, before.outPoint) &&
            exactEnough(restored.start, before.start) &&
            exactEnough(restored.end, before.end);
          var errorCode = "TRIM_NOT_APPLIED";
          ${duration !== undefined ? `
          if (${duration} > before.duration && closeEnough(attempted.duration, before.duration)) {
            errorCode = "TRIM_UNSUPPORTED_FOR_CLIP";
          }
          ` : ''}
          return JSON.stringify({
            success: false,
            error: errorCode === "TRIM_UNSUPPORTED_FOR_CLIP"
              ? "Premiere Pro does not support extending this clip to the requested duration"
              : "Premiere Pro did not apply the requested trim",
            errorCode: errorCode,
            clipId: ${JSON.stringify(clipId)},
            requested: {
              inPoint: ${inPoint !== undefined ? inPoint : 'null'},
              outPoint: ${outPoint !== undefined ? outPoint : 'null'},
              duration: ${duration !== undefined ? duration : 'null'}
            },
            before: before,
            after: after,
            attempted: attempted,
            restored: restored,
            rolledBack: rolledBack,
            verificationErrors: verificationErrors,
            writeErrors: writeErrors,
            rollbackErrors: rollbackErrors,
            frameDurationSeconds: frameDurationSeconds
          });
        }

        return JSON.stringify({
          success: true,
          message: "Clip trimmed and verified",
          clipId: ${JSON.stringify(clipId)},
          oldInPoint: before.inPoint,
          oldOutPoint: before.outPoint,
          oldDuration: before.duration,
          newInPoint: after.inPoint,
          newOutPoint: after.outPoint,
          newDuration: after.duration,
          before: before,
          after: after,
          writeErrors: writeErrors,
          frameDurationSeconds: frameDurationSeconds
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async getSequenceGaps(seqId?: string, _trackIndex?: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var gaps = seq.getTimelineGaps ? seq.getTimelineGaps() : [];
        if (!gaps) return JSON.stringify({success:true,gapCount:0,gaps:[]});
        var result = [];
        if (typeof gaps.length === 'number') {
          for (var i=0;i<gaps.length;i++) {
            var g = gaps[i];
            result.push({startTicks:g.start?String(g.start.ticks):'0',endTicks:g.end?String(g.end.ticks):'0',startSecs:g.start?g.start.seconds:0,durationSecs:g.duration?g.duration.seconds:0});
          }
        }
        return JSON.stringify({success:true,gapCount:result.length,gaps:result.slice(0,50)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
