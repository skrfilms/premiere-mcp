/**
 * PlaybackTools -- the Playback, Navigation & Monitors tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { SequenceTrackTools } from './sequence-track.js';

export class PlaybackTools extends SequenceTrackTools {
  protected async goToSequenceStart(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var r = __setPlayheadVerified(seq, 0);
      return JSON.stringify({success:r.moved,verified:r.verified,error:r.error,ticks:String(r.actualTicks),secs:r.actualSeconds,sequenceName:String(seq.name)});
    `);
  }

  protected async goToSequenceEnd(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      // Sequence.end is a TICKS string, not a Time object — reading .ticks off it gave
      // undefined, which setPlayerPosition swallowed while this tool still claimed verified
      // success. Measured on 26.3.2; see __seqEndTicks in the prelude.
      var endTicks = __seqEndTicks(seq);
      if (endTicks === null) return JSON.stringify({success:false,verified:false,error:'Could not read the sequence end time, so the playhead was not moved.'});
      var r = __setPlayheadVerified(seq, endTicks);
      return JSON.stringify({success:r.moved,verified:r.verified,error:r.error,ticks:String(r.actualTicks),secs:r.actualSeconds,requestedTicks:String(endTicks),sequenceName:String(seq.name)});
    `);
  }

  protected async goToInPoint(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      // getInPoint() returns a SECONDS string here, not a Time — .ticks was undefined.
      var ticks = __seqInTicks(seq);
      if (ticks === null) return JSON.stringify({success:false,verified:true,error:'This sequence has no in point set (Premiere reports a negative value when the range is unset), so there is nowhere to move to. Set one with set_sequence_in_out_points.',inPointSeconds:__seqInSeconds(seq)});
      var r = __setPlayheadVerified(seq, ticks);
      return JSON.stringify({success:r.moved,verified:r.verified,error:r.error,ticks:String(r.actualTicks),secs:r.actualSeconds,inPointSeconds:__seqInSeconds(seq)});
    `);
  }

  protected async goToOutPoint(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      // getOutPoint() returns a SECONDS string here, not a Time — .ticks was undefined.
      var ticks = __seqOutTicks(seq);
      if (ticks === null) return JSON.stringify({success:false,verified:true,error:'This sequence has no out point set (Premiere reports a negative value when the range is unset), so there is nowhere to move to. Set one with set_sequence_in_out_points.',outPointSeconds:__seqOutSeconds(seq)});
      var r = __setPlayheadVerified(seq, ticks);
      return JSON.stringify({success:r.moved,verified:r.verified,error:r.error,ticks:String(r.actualTicks),secs:r.actualSeconds,outPointSeconds:__seqOutSeconds(seq)});
    `);
  }

  protected async stepFrames(frames: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var beforeTicks = __timeFieldToNumber(seq.getPlayerPosition());
      if (beforeTicks === null) return JSON.stringify({success:false,verified:false,error:'Could not read the current playhead position, so no move was attempted.'});
      var ticksPerFrame = Number(seq.timebase) || 10584000000;
      var target = Math.max(0, beforeTicks + ${frames} * ticksPerFrame);
      // Half a frame: landing on the requested frame is success, sub-frame drift is not a failure.
      var r = __setPlayheadVerified(seq, target, ticksPerFrame / 2);
      var framesActuallyMoved = (r.actualTicks !== null && typeof r.actualTicks !== 'undefined')
        ? Math.round((r.actualTicks - beforeTicks) / ticksPerFrame) : null;
      return JSON.stringify({
        success: r.moved, verified: r.verified, error: r.error,
        framesRequested: ${frames}, framesMoved: framesActuallyMoved,
        before: { ticks: String(beforeTicks), secs: beforeTicks / 254016000000 },
        after: { ticks: String(r.actualTicks), secs: r.actualSeconds }
      });
    `);
  }

  protected async getPlaybackState(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
      var pos = seq.getPlayerPosition();
      return JSON.stringify({success:true,ticks:String(pos.ticks),secs:pos.seconds,sequenceName:String(seq.name),frameSizeH:seq.frameSizeHorizontal,frameSizeV:seq.frameSizeVertical});
    `);
  }

  protected async getSequenceSelection(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var sel = seq.getSelection();
      var items = [];
      if (sel) for (var i = 0; i < sel.length; i++) {
        var c = sel[i]; items.push({name:String(c.name),start:c.start?String(c.start.ticks):null,end:c.end?String(c.end.ticks):null,mediaType:String(c.mediaType)});
      }
      return JSON.stringify({success:true,count:items.length,clips:items});
    `);
  }

  protected async setSequenceSelection(clips: Array<{trackIndex: number, clipIndex: number}>, sequenceId?: string): Promise<any> {
    const clipsJson = JSON.stringify(clips);
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var clipList = ${clipsJson};
      var toSelect = [];
      var unresolved = [];
      for (var i = 0; i < clipList.length; i++) {
        var track = seq.videoTracks[clipList[i].trackIndex] || seq.audioTracks[clipList[i].trackIndex];
        if (track && track.clips[clipList[i].clipIndex]) toSelect.push(track.clips[clipList[i].clipIndex]);
        else unresolved.push('track ' + clipList[i].trackIndex + ' clip ' + clipList[i].clipIndex);
      }
      seq.setSelection(toSelect);
      var sel = seq.getSelection();
      var selCount = sel ? sel.length : 0;
      // The old check compared the selection against what we MANAGED to resolve, so a
      // request naming five clips of which two existed reported a verified success for
      // two. Compare against what was ASKED for, and name what could not be found.
      var allSelected = sel && selCount === clipList.length && unresolved.length === 0;
      if (!allSelected) {
        return JSON.stringify({success:false,verified:true,verifiedBy:'Sequence.getSelection() readback',
          requested:clipList.length,resolved:toSelect.length,selected:selCount,unresolved:unresolved,
          error: unresolved.length
            ? ('Selected ' + selCount + ' of ' + clipList.length + ' requested clips. Not found on this sequence: ' + unresolved.join(', ') + '.')
            : ('Premiere selected ' + selCount + ' clips after being handed ' + toSelect.length + '. Locked tracks are excluded from a selection.')});
      }
      return JSON.stringify({success:true,verified:true,verifiedBy:'Sequence.getSelection() readback',requested:clipList.length,resolved:toSelect.length,selected:selCount});
    `);
  }

  protected async goToNextMarker(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var pos = seq.getPlayerPosition();
      var m = seq.markers.getFirstMarker();
      var next = null;
      while (m) { if (Number(m.start.ticks) > Number(pos.ticks)) { next = m; break; } m = seq.markers.getNextMarker(m); }
      if (!next) return JSON.stringify({success:false,error:'No next marker'});
      seq.setPlayerPosition(String(next.start.ticks));
      return JSON.stringify({success:true,markerName:String(next.name),ticks:String(next.start.ticks),secs:next.start.seconds});
    `);
  }

  protected async goToPrevMarker(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var pos = seq.getPlayerPosition();
      var m = seq.markers.getLastMarker();
      var prev = null;
      while (m) { if (Number(m.start.ticks) < Number(pos.ticks)) { prev = m; break; } m = seq.markers.getPrevMarker(m); }
      if (!prev) return JSON.stringify({success:false,error:'No previous marker'});
      seq.setPlayerPosition(String(prev.start.ticks));
      return JSON.stringify({success:true,markerName:String(prev.name),ticks:String(prev.start.ticks),secs:prev.start.seconds});
    `);
  }

  protected async goToTimecode(timecode: string, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var parts = ${JSON.stringify(timecode)}.split(':');
      var fps = seq.timebase ? (254016000000 / Number(seq.timebase)) : 24;
      var h=0,m=0,s=0,f=0;
      if (parts.length===4) { h=+parts[0]; m=+parts[1]; s=+parts[2]; f=+parts[3]; }
      else if (parts.length===3) { m=+parts[0]; s=+parts[1]; f=+parts[2]; }
      var totalFrames = h*3600*fps + m*60*fps + s*fps + f;
      var ticks = Math.round(totalFrames * Number(seq.timebase));
      seq.setPlayerPosition(String(ticks));
      var after = seq.getPlayerPosition();
      return JSON.stringify({success:true,ticks:String(after.ticks),secs:after.seconds});
    `);
  }

  protected async playInToOut(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var ip = seq.getInPoint();
      seq.setPlayerPosition(String(ip.ticks));
      return JSON.stringify({success:true,startedAt:{ticks:String(ip.ticks),secs:ip.seconds},note:'Playhead set to in-point. Use play_timeline to start playback.'});
    `);
  }

  protected async timecodeToFrames(timecode: string, frameRate?: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var fps = ${frameRate ?? 0} || (seq && seq.timebase ? Math.round(254016000000/Number(seq.timebase)*100)/100 : 24);
        var parts = ${JSON.stringify(timecode)}.split(':');
        var h=0,m=0,s=0,f=0;
        if (parts.length===4){h=+parts[0];m=+parts[1];s=+parts[2];f=+parts[3];}
        else if(parts.length===3){m=+parts[0];s=+parts[1];f=+parts[2];}
        var frames = Math.round(h*3600*fps + m*60*fps + s*fps + f);
        var secs = frames/fps;
        return JSON.stringify({success:true,timecode:${JSON.stringify(timecode)},frames:frames,seconds:Math.round(secs*1000)/1000,fps:fps});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async framesToTimecode(frames: number, frameRate?: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var fps = ${frameRate ?? 0} || (seq && seq.timebase ? Math.round(254016000000/Number(seq.timebase)*100)/100 : 24);
        var f = ${frames};
        var h = Math.floor(f/3600/fps), remaining = f - h*3600*fps;
        var m = Math.floor(remaining/60/fps); remaining = remaining - m*60*fps;
        var s = Math.floor(remaining/fps); var fr = Math.round(remaining - s*fps);
        // padStart does not exist in this engine; __padLeft is the prelude's ES3 equivalent.
        var tc = __padLeft(h,2)+':'+__padLeft(m,2)+':'+__padLeft(s,2)+':'+__padLeft(fr,2);
        return JSON.stringify({success:true,frames:f,timecode:tc,seconds:Math.round(f/fps*1000)/1000,fps:fps});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async selectClipsInTimeRange(startSecs: number, endSecs: number, trackIndices?: number[], seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var tracks=${trackIndices ? JSON.stringify(trackIndices) : 'null'};
        var toSelect=[];
        for(var t=0;t<seq.videoTracks.numTracks;t++){
          if(tracks&&tracks.indexOf(t)<0)continue;
          var track=seq.videoTracks[t];
          for(var c=0;c<track.clips.numItems;c++){
            var clip=track.clips[c];
            if(clip.end.seconds>${startSecs}&&clip.start.seconds<${endSecs})toSelect.push(clip);
          }
        }
        seq.setSelection(toSelect);
        return JSON.stringify({success:true,selectedCount:toSelect.length,range:[${startSecs},${endSecs}]});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async clearWorkArea(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        if(!seq) return JSON.stringify({success:false,error:'Sequence not found'});
        // seq.end is a TICKS string; .ticks on it was undefined, so setWorkOutPoint received the
        // literal "undefined" and the work area was never reset — while this reported success.
        var endTicks=__seqEndTicks(seq);
        if(endTicks===null) return JSON.stringify({success:false,verified:false,error:'Could not read the sequence end time, so the work area was left unchanged.'});
        // The DOM setters are setWorkArea*; setWorkInPoint/setWorkOutPoint are QE-only names and
        // are undefined on the Sequence object (measured on 26.3.2). This tool called the QE
        // names against the DOM object, so it never touched the work area.
        if(!seq.setWorkAreaInPoint||!seq.setWorkAreaOutPoint) return JSON.stringify({success:false,verified:false,error:'This build does not expose setWorkAreaInPoint/setWorkAreaOutPoint on Sequence.'});
        var before=__readWorkArea(seq);
        seq.setWorkAreaInPoint('0');
        seq.setWorkAreaOutPoint(String(endTicks));
        var after=__readWorkArea(seq);
        if(after.outTicks===null) return JSON.stringify({success:false,verified:false,error:'Work area could not be read back, so the reset is unproven.'});
        var onTarget = Math.abs(after.outTicks-endTicks) <= 10584000000 && Math.abs(after.inTicks) <= 10584000000;
        var changed = before.outTicks===null || after.outTicks!==before.outTicks || after.inTicks!==before.inTicks;
        // A no-op and a real change read back identically when the target already equals the
        // current value. Saying "verified" without that distinction is how a tool that does
        // nothing passes its own check, so report which of the two actually happened.
        return JSON.stringify({
          success:onTarget, verified:true, changed:changed, alreadyFullSequence: onTarget && !changed,
          workInTicks:String(after.inTicks), workOutTicks:String(after.outTicks),
          sequenceEndTicks:String(endTicks), workAreaEnabled:__workAreaEnabled(seq),
          error: onTarget ? null : 'The work area did not move. Measured on 26.3.2: setWorkAreaInPoint/setWorkAreaOutPoint are accepted but inert (QE setWorkInOutPoints likewise), so the work area cannot be set by script on this build. Use sequence in/out points instead — set_sequence_in_out_points is verified working.',
          note: onTarget && !changed ? 'Work area already spanned the whole sequence; nothing was changed.' : 'Work area reset to full sequence'
        });
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async refreshUi(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.refresh();
        return JSON.stringify({ success: true, verified: false, note: 'app.refresh() dispatched. A UI repaint has no readback, so this is not verified.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getPanelVisibility(panels?: string[]): Promise<any> {
    const checkPanels = panels ?? ['Timeline','Source Monitor','Program Monitor','Effects','Lumetri Color','Effect Controls','Project','Audio Track Mixer'];
    const checksJson = JSON.stringify(checkPanels);
    return await this.bridge.executeScript(`
      try {
        var panels=${checksJson};
        var result={};
        for(var i=0;i<panels.length;i++){
          try{result[panels[i]]=app.isWindowVisible(panels[i]);}catch(e){result[panels[i]]=false;}
        }
        return JSON.stringify({success:true,panels:result});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  // Playhead & Work Area Implementation
  protected async getPlayheadPosition(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var pos = sequence.getPlayerPosition();
        return JSON.stringify({
          success: true,
          position: __ticksToSeconds(pos.ticks),
          ticks: pos.ticks
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async setPlayheadPosition(sequenceId: string, time: number): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var ticks = __secondsToTicks(${time});
        var beforeSeconds = null; try { beforeSeconds = sequence.getPlayerPosition().seconds; } catch (ePre) {}
        sequence.setPlayerPosition(ticks);
        var nowSeconds = null; try { nowSeconds = sequence.getPlayerPosition().seconds; } catch (ePlay) {}
        if (nowSeconds !== null && Math.abs(nowSeconds - ${time}) > 0.04) return JSON.stringify({ success: false, verified: true, verifiedBy: "Sequence.getPlayerPosition() readback", before: beforeSeconds, changed: beforeSeconds !== nowSeconds, error: "Premiere did not move the playhead to ${time}s (reads back at " + nowSeconds + "s). A target beyond the end of the sequence is clamped.", requested: ${time}, actual: nowSeconds });
        if (nowSeconds === null) {
          return JSON.stringify({
            success: true, verified: false,
            unverifiedReason: "setPlayerPosition() did not throw, but getPlayerPosition() is not readable, so the playhead cannot be confirmed at ${time}s.",
            time: ${time}, before: beforeSeconds
          });
        }
        return JSON.stringify({
          success: true,
          verified: true,
          verifiedBy: "Sequence.getPlayerPosition() readback",
          changed: beforeSeconds !== nowSeconds,
          message: beforeSeconds === nowSeconds ? "The playhead was already at ${time}s; nothing moved." : "Playhead position set",
          time: ${time},
          before: beforeSeconds,
          actualTime: nowSeconds
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Work Area Implementation
  protected async setWorkArea(sequenceId: string, inPoint: number, outPoint: number): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        sequence.setWorkAreaInPoint(__secondsToTicks(${inPoint}));
        sequence.setWorkAreaOutPoint(__secondsToTicks(${outPoint}));
        var inNow = null, outNow = null;
        try { inNow = sequence.getWorkAreaInPointAsTime().seconds; } catch (eIn) {}
        try { outNow = sequence.getWorkAreaOutPointAsTime().seconds; } catch (eOut) {}
        if (inNow === null && outNow === null) {
          return JSON.stringify({ success: false, verified: false, error: "The work area could not be read back, so setting it is unproven. Not reporting success.", requested: { inPoint: ${inPoint}, outPoint: ${outPoint} } });
        }
        if ((inNow !== null && Math.abs(inNow - ${inPoint}) > 0.04) || (outNow !== null && Math.abs(outNow - ${outPoint}) > 0.04)) {
          // Measured on 26.3.2: these setters are present and throw nothing, but the readback
          // never moves, with or without setWorkAreaEnabled(true), and the QE route
          // (setWorkInOutPoints) is inert too. Premiere 2026 deprecated the work-area bar in
          // favour of sequence in/out points. Name that instead of just reporting a mismatch,
          // so the caller knows to stop retrying and what to use instead.
          return JSON.stringify({
            success: false, verified: false,
            error: "The work area did not move (reads back in " + inNow + "s / out " + outNow + "s). setWorkAreaInPoint/setWorkAreaOutPoint are accepted but inert (measured on 26.3.2 and again on 26.5.2, with the work area enabled and every argument form: seconds, ticks, Time, and QE setWorkInOutPoints with a timecode), so the work area cannot be set by script here. Retrying will not help. Use set_sequence_in_out_points instead — it is verified working — and export with workAreaType set to the in/out range.",
            workAreaEnabled: __workAreaEnabled(sequence),
            requested: { inPoint: ${inPoint}, outPoint: ${outPoint} }, actual: { inPoint: inNow, outPoint: outNow }
          });
        }
        return JSON.stringify({
          success: true,
          verified: inNow !== null && outNow !== null,
          verifiedBy: (inNow !== null && outNow !== null) ? "getWorkAreaInPointAsTime()/getWorkAreaOutPointAsTime() readback" : undefined,
          unverifiedReason: (inNow !== null && outNow !== null) ? undefined : "Only one of the two work-area points is readable on this build, so the range is half confirmed at best.",
          message: "Work area set",
          inPoint: ${inPoint},
          outPoint: ${outPoint},
          actual: { inPoint: inNow, outPoint: outNow }
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async getWorkArea(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var inTime = sequence.getWorkAreaInPointAsTime();
        var outTime = sequence.getWorkAreaOutPointAsTime();
        return JSON.stringify({
          success: true,
          inPoint: inTime.seconds,
          outPoint: outTime.seconds
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Clip Lookup Implementation
  protected async getClipAtPosition(sequenceId: string, trackType: string, trackIndex: number, time: number): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var tracks = ${JSON.stringify(trackType)} === "video" ? sequence.videoTracks : sequence.audioTracks;
        if (${trackIndex} < 0 || ${trackIndex} >= tracks.numTracks) return JSON.stringify({ success: false, error: "Track index out of range" });
        var track = tracks[${trackIndex}];
        var targetTime = ${time};
        for (var i = 0; i < track.clips.numItems; i++) {
          var clip = track.clips[i];
          if (clip.start.seconds <= targetTime && clip.end.seconds > targetTime) {
            return JSON.stringify({
              success: true,
              clip: {
                nodeId: clip.nodeId,
                name: clip.name,
                start: clip.start.seconds,
                end: clip.end.seconds,
                duration: clip.duration.seconds,
                inPoint: clip.inPoint.seconds,
                outPoint: clip.outPoint.seconds,
                trackIndex: ${trackIndex},
                trackType: ${JSON.stringify(trackType)},
                clipIndex: i
              }
            });
          }
        }
        return JSON.stringify({
          success: true,
          clip: null,
          message: "No clip found at time " + targetTime + "s on " + ${JSON.stringify(trackType)} + " track " + ${trackIndex}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async selectAllOnTrack(trackIndex: number, startSecs?: number, endSecs?: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var track = seq.videoTracks[${trackIndex}];
        if (!track) return JSON.stringify({success:false,error:'Track not found'});
        var toSelect = [];
        for (var c=0;c<track.clips.numItems;c++) {
          var clip = track.clips[c];
          ${startSecs !== undefined ? `if (clip.start.seconds < ${endSecs ?? 999999} && clip.end.seconds > ${startSecs}) toSelect.push(clip);` : 'toSelect.push(clip);'}
        }
        seq.setSelection(toSelect);
        var sel = seq.getSelection();
        var selCount = sel ? sel.length : 0;
        if (toSelect.length === 0) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'Sequence.getSelection() readback',selected:0,matched:0,clipsOnTrack:track.clips.numItems,
            note:'No clip on video track ${trackIndex} matched the requested range, so the selection was cleared rather than set.'});
        }
        if (selCount !== toSelect.length) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'Sequence.getSelection() readback',matched:toSelect.length,selected:selCount,clipsOnTrack:track.clips.numItems,
            error:'Premiere reports ' + selCount + ' clips selected after being handed ' + toSelect.length + '. Clips on a locked track are excluded from a selection.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'Sequence.getSelection() readback',selected:selCount,matched:toSelect.length,clipsOnTrack:track.clips.numItems});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
