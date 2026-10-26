/**
 * AssemblyTools -- the Assembly Editing tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { ToolsBase } from './base.js';

export class AssemblyTools extends ToolsBase {
  protected async threePointEdit(projectItemId: string, sourceIn?: string, sourceOut?: string, sequenceTimecode?: string, mode = 'overwrite', videoTrack = 0, _audioTrack = 0): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var root = app.project.rootItem;
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}} return null; }
        var item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found: '+${JSON.stringify(projectItemId)}});
        app.sourceMonitor.openProjectItem(item);
        ${sourceIn ? `app.enableQE(); qe.source.clip.setInPoint(${JSON.stringify(sourceIn)});` : ''}
        ${sourceOut ? `app.enableQE(); qe.source.clip.setOutPoint(${JSON.stringify(sourceOut)});` : ''}
        var seq = app.project.activeSequence;
        ${sequenceTimecode ? `var t = new Time(); t.seconds = ${JSON.stringify(sequenceTimecode)}; seq.setPlayerPosition(String(t.ticks));` : ''}
        var destTrack = seq.videoTracks[${videoTrack}];
        if (!destTrack) return JSON.stringify({success:false,error:'Video track ${videoTrack} does not exist on this sequence'});
        var beforeCount = destTrack.clips.numItems;
        var landAtSeconds = Number(seq.getPlayerPosition().seconds);
        if (${JSON.stringify(mode)} === 'insert') {
          destTrack.insertClip(item, seq.getPlayerPosition());
        } else {
          destTrack.overwriteClip(item, seq.getPlayerPosition());
        }
        var afterCount = destTrack.clips.numItems;
        // "afterCount >= beforeCount" was a check that could not fail: overwriteClip
        // REPLACES rather than appends, so a flat count is the expected outcome, and the
        // count can never fall. Verify the clip covering the playhead actually references
        // the requested project item instead.
        var landed = false, coveringName = null;
        for (var vc = 0; vc < destTrack.clips.numItems; vc++) {
          var cand = destTrack.clips[vc];
          if (Number(cand.start.seconds) > landAtSeconds + 0.001) continue;
          if (Number(cand.end.seconds) <= landAtSeconds + 0.001) continue;
          coveringName = String(cand.name);
          try { landed = String(cand.projectItem.nodeId) === String(item.nodeId); } catch (eL) {}
          break;
        }
        if (!landed) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'clip covering the playhead compared by projectItem.nodeId',
            error:'The edit did not land: the clip covering ' + landAtSeconds + 's on video track ${videoTrack} is ' + (coveringName === null ? 'absent' : '"' + coveringName + '"') + ', not "' + String(item.name) + '". A locked or targeted-off track, or an out-of-range source in/out, will make Premiere accept the call and place nothing.',
            mode:${JSON.stringify(mode)},sourceItem:String(item.name),clipsBefore:beforeCount,clipsAfter:afterCount,atSeconds:landAtSeconds});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'clip covering the playhead compared by projectItem.nodeId',changed:true,mode:${JSON.stringify(mode)},sourceItem:String(item.name),sourceIn:${JSON.stringify(sourceIn??null)},sourceOut:${JSON.stringify(sourceOut??null)},clipsBefore:beforeCount,clipsAfter:afterCount,atSeconds:landAtSeconds});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // Timeline Operations Implementation
  protected async addToTimelineBatch(sequenceId: string, clips: Array<{ projectItemId: string; trackIndex: number; time?: number; linkAudio?: boolean; sourceInPoint?: number; sourceOutPoint?: number }>, mode: 'absolute' | 'append' = 'absolute'): Promise<any> {
    // In absolute mode every clip needs an explicit time; in append mode time is
    // computed on the track cursor, so a missing time is expected, not an error.
    if (mode !== 'append') {
      const missing = clips.findIndex((c) => typeof c.time !== 'number');
      if (missing !== -1) {
        return {
          success: false,
          error: `clips[${missing}] has no time; time is required in "absolute" mode (use mode:"append" to chain clips end-to-end).`,
          sequenceId,
          requested: clips.length,
        };
      }
    }
    try {
      const result: any = await this.bridge.addToTimelineBatch(sequenceId, clips, mode);
      return { sequenceId, mode, requested: clips.length, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), sequenceId, mode, requested: clips.length };
    }
  }

  protected async addToTimeline(sequenceId: string, projectItemId: string, trackIndex: number, time: number, insertMode = 'overwrite', linkAudio: boolean = true, sourceInPoint?: number, sourceOutPoint?: number): Promise<any> {
    try {
      // insertMode used to stop here: it was echoed in every response below while
      // the bridge unconditionally overwrote, so a caller asking to insert-and-shift
      // had the footage it was moving destroyed and was told the opposite.
      const result: any = await this.bridge.addToTimeline(sequenceId, projectItemId, trackIndex, time, linkAudio, sourceInPoint, sourceOutPoint, insertMode);
      if (!result.success) {
        return {
          ...result,
          sequenceId: sequenceId,
          projectItemId: projectItemId,
          trackIndex: trackIndex,
          time: time,
          insertMode: insertMode,
          linkAudio: linkAudio,
          sourceInPoint: sourceInPoint,
          sourceOutPoint: sourceOutPoint
        };
      }
      return {
        success: true,
        message: `Clip added to timeline successfully`,
        sequenceId: sequenceId,
        projectItemId: projectItemId,
        trackIndex: trackIndex,
        time: time,
        insertMode: insertMode,
        linkAudio: linkAudio,
        sourceInPoint: sourceInPoint,
        sourceOutPoint: sourceOutPoint,
        ...result
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to add clip to timeline: ${error instanceof Error ? error.message : String(error)}`,
        sequenceId: sequenceId,
        projectItemId: projectItemId,
        trackIndex: trackIndex,
        time: time
      };
    }
  }

  protected async removeFromTimeline(clipId: string, sequenceId?: string, deleteMode = 'ripple'): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)}, ${sequenceId ? JSON.stringify(sequenceId) : 'null'});
        if (!info) return JSON.stringify({ success: false, error: ${sequenceId ? JSON.stringify(`Clip not found in sequence: ${sequenceId}`) : '"Clip not found"'} });
        var clip = info.clip;
        var clipName = clip.name;
        var isRipple = ${JSON.stringify(deleteMode)} === "ripple";
        var beforeCount = info.track.clips.numItems;
        clip.remove(isRipple, true);
        var afterCount = info.track.clips.numItems;
        if (afterCount >= beforeCount) return JSON.stringify({ success: false, verified: false, error: "Premiere did not remove '" + clipName + "' (track clip count unchanged).", beforeCount: beforeCount, afterCount: afterCount });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Clip removed from timeline",
          clipId: ${JSON.stringify(clipId)},
          clipName: clipName,
          sequenceId: info.sequenceId,
          sequenceName: info.sequenceName,
          deleteMode: ${JSON.stringify(deleteMode)},
          beforeCount: beforeCount,
          afterCount: afterCount
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

  protected async splitClip(clipId: string, splitTime: number): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var splitSeconds = info.clip.start.seconds + ${Number(splitTime)};
        var clipDur = info.clip.end.seconds - info.clip.start.seconds;
        if (!(${Number(splitTime)} > 0 && ${Number(splitTime)} < clipDur)) return JSON.stringify({ success: false, error: "splitTime is seconds from the START OF THE CLIP and must be between 0 and its duration (" + clipDur + "s); " + ${Number(splitTime)} + "s is outside it. The clip sits at " + info.clip.start.seconds + "s-" + info.clip.end.seconds + "s on the timeline. Nothing was changed." });
        // The timecode must come from the sequence the clip actually lives in, not
        // from whatever is on screen. Taking it from the active sequence put the cut
        // on the right timeline at the wrong frame whenever the two differed in frame
        // rate: a 24 fps clip razored using a 30 fps timebase lands three frames out.
        var seq = info.sequence;
        var tc = __qeTimecode(seq, splitSeconds);
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceOpening(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        // Premiere's razor cuts linked items together; QE razors one track. Cut every track that
        // holds a linked partner too, or the video splits while its audio stays whole.
        var cuts = [{ kind: info.trackType, index: info.trackIndex, track: info.track }];
        try {
          var linked = info.clip.getLinkedItems();
          for (var li = 0; li < linked.numItems; li++) {
            var it = linked[li];
            var isAudio = String(it.mediaType) === 'Audio', tracks = isAudio ? seq.audioTracks : seq.videoTracks;
            for (var ti = 0; ti < tracks.numTracks; ti++) {
              var found = false;
              for (var ci = 0; ci < tracks[ti].clips.numItems; ci++) {
                var c = tracks[ti].clips[ci];
                if (String(c.start.ticks) === String(it.start.ticks) && String(c.end.ticks) === String(it.end.ticks) && String(c.name) === String(it.name)) { found = true; break; }
              }
              if (found) {
                var kind = isAudio ? 'audio' : 'video', dup = false;
                for (var k = 0; k < cuts.length; k++) if (cuts[k].kind === kind && cuts[k].index === ti) dup = true;
                if (!dup) cuts.push({ kind: kind, index: ti, track: tracks[ti] });
                break;
              }
            }
          }
        } catch (eLinked) {}
        var results = [], allSplit = true;
        for (var r = 0; r < cuts.length; r++) {
          var qeTrack = cuts[r].kind === 'video' ? qeSeq.getVideoTrackAt(cuts[r].index) : qeSeq.getAudioTrackAt(cuts[r].index);
          var beforeCount = cuts[r].track.clips.numItems;
          qeTrack.razor(tc);
          var afterCount = cuts[r].track.clips.numItems;
          var ok = afterCount > beforeCount;
          if (!ok) allSplit = false;
          results.push({ track: (cuts[r].kind === 'video' ? 'V' : 'A') + (cuts[r].index + 1), split: ok, beforeCount: beforeCount, afterCount: afterCount });
        }
        // A razor that lands on a clip splits it, so the track's clip count rises by
        // one. If it did not, the cut fell in a gap or off the clip -- report that
        // honestly rather than claiming a split that did not happen.
        if (!results[0].split) return JSON.stringify({ success: false, verified: false, error: "Razor at " + tc + " did not split any clip (track clip count unchanged). The split time may fall in a gap or outside the clip.", tracks: results });
        if (!allSplit) return JSON.stringify({ success: false, verified: true, error: "PARTIALLY APPLIED: the clip split but a linked track did not, so picture and sound are now cut differently. See tracks[]. Undo to restore.", timecode: tc, tracks: results });
        return JSON.stringify({ success: true, verified: true, message: "Clip split at " + tc, splitTime: ${Number(splitTime)}, timecode: tc, tracks: results, linkedTracksSplit: results.length - 1 });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async razorTimelineAtTime(sequenceId?: string, time?: number, videoTrackIndices?: number[], audioTrackIndices?: number[]): Promise<any> {
    const normalizedTime = time ?? 0;
    const videoIndices = videoTrackIndices ?? [];
    const audioIndices = audioTrackIndices ?? [];

    const script = `
      try {
        app.enableQE();
        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) return JSON.stringify({ success: false, error: ${sequenceId ? `"Sequence not found by id: " + ${JSON.stringify(sequenceId)}` : '"No active sequence"'} });

        var __priorActive = app.project.activeSequence;
        if (app.project.activeSequence && app.project.activeSequence.sequenceID !== sequence.sequenceID) {
          app.project.openSequence(sequence.sequenceID);
        }

        var activeSequence = app.project.activeSequence;
        if (!activeSequence || activeSequence.sequenceID !== sequence.sequenceID) {
          return JSON.stringify({ success: false, error: "Unable to activate requested sequence for razor cut" });
        }

        var fps = activeSequence.timebase ? (254016000000 / parseInt(activeSequence.timebase, 10)) : 30;
        var totalFrames = Math.round(${normalizedTime} * fps);
        var hours = Math.floor(totalFrames / (fps * 3600));
        var mins = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
        var secs = Math.floor((totalFrames % (fps * 60)) / fps);
        var frames = Math.round(totalFrames % fps);
        function pad(n) { return n < 10 ? "0" + n : "" + n; }
        var tc = pad(hours) + ":" + pad(mins) + ":" + pad(secs) + ":" + pad(frames);

        var qeSeq = __qeSequenceOpening(sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "QE active sequence unavailable" });

        function buildIndices(count, requested) {
          if (!requested || requested.length === 0) {
            var all = [];
            for (var idx = 0; idx < count; idx++) all.push(idx);
            return all;
          }
          return requested;
        }

        var requestedVideo = ${JSON.stringify(videoIndices)};
        var requestedAudio = ${JSON.stringify(audioIndices)};
        var finalVideo = buildIndices(activeSequence.videoTracks.numTracks, requestedVideo);
        var finalAudio = buildIndices(activeSequence.audioTracks.numTracks, requestedAudio);
        var cutVideoTracks = [];
        var cutAudioTracks = [];
        var skippedVideoTracks = [];
        var skippedAudioTracks = [];

        function __razorTotalClips() {
          var n = 0;
          for (var rv = 0; rv < activeSequence.videoTracks.numTracks; rv++) n += activeSequence.videoTracks[rv].clips.numItems;
          for (var ra = 0; ra < activeSequence.audioTracks.numTracks; ra++) n += activeSequence.audioTracks[ra].clips.numItems;
          return n;
        }
        var __razorBeforeTotal = __razorTotalClips();

        for (var i = 0; i < finalVideo.length; i++) {
          var videoIndex = finalVideo[i];
          if (videoIndex < 0 || videoIndex >= activeSequence.videoTracks.numTracks) {
            skippedVideoTracks.push({ index: videoIndex, reason: "Video track index out of range" });
            continue;
          }
          var qeVideoTrack = qeSeq.getVideoTrackAt(videoIndex);
          if (!qeVideoTrack) {
            skippedVideoTracks.push({ index: videoIndex, reason: "QE video track not found" });
            continue;
          }
          qeVideoTrack.razor(tc);
          cutVideoTracks.push(videoIndex);
        }

        for (var j = 0; j < finalAudio.length; j++) {
          var audioIndex = finalAudio[j];
          if (audioIndex < 0 || audioIndex >= activeSequence.audioTracks.numTracks) {
            skippedAudioTracks.push({ index: audioIndex, reason: "Audio track index out of range" });
            continue;
          }
          var qeAudioTrack = qeSeq.getAudioTrackAt(audioIndex);
          if (!qeAudioTrack) {
            skippedAudioTracks.push({ index: audioIndex, reason: "QE audio track not found" });
            continue;
          }
          qeAudioTrack.razor(tc);
          cutAudioTracks.push(audioIndex);
        }

        var __razorAfterTotal = __razorTotalClips();
        var __razorCutsMade = __razorAfterTotal - __razorBeforeTotal;
        return JSON.stringify({
          success: true,
          verified: __razorCutsMade > 0,
          message: __razorCutsMade > 0 ? "Timeline razored at " + tc : "Razor at " + tc + " landed where no clip crossed it; nothing was cut.",
          sequenceId: activeSequence.sequenceID,
          sequenceName: activeSequence.name,
          time: ${normalizedTime},
          timecode: tc,
          cutsMade: __razorCutsMade,
          beforeCount: __razorBeforeTotal,
          afterCount: __razorAfterTotal,
          cutVideoTracks: cutVideoTracks,
          cutAudioTracks: cutAudioTracks,
          skippedVideoTracks: skippedVideoTracks,
          skippedAudioTracks: skippedAudioTracks
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      } finally {
        // Leave the user where they were. ES3 has try/finally, and this runs
        // before the return above completes.
        try {
          if (__priorActive && app.project.activeSequence &&
              app.project.activeSequence.sequenceID !== __priorActive.sequenceID) {
            app.project.activeSequence = __priorActive;
          }
        } catch (eRestore) {}
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Nested Sequences
  protected async createNestedSequence(_clipIds: string[], _name: string): Promise<any> {
    return {
      success: false,
      error: "create_nested_sequence: This feature requires selection and nesting APIs. Implementation pending.",
      note: "You can manually nest clips via right-click > Nest"
    };
  }

  // Additional Clip Operations
  protected async duplicateClip(clipId: string, offset?: number): Promise<any> {
    // overwriteClip() places a project item's MARKED range, so the old version dropped the whole
    // source media (a 5s clip came back 10s long, from source 0) and overwrote whatever was at the
    // destination, while reporting success. The clip's own source range is now marked on the item
    // for the placement and the item's marks are restored afterwards; an occupied destination is
    // refused. Effects, keyframes and speed are not carried over by overwriteClip().
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip, projItem = clip.projectItem, seq = info.sequence;
        if (!projItem) return JSON.stringify({ success: false, error: "This clip has no project item to duplicate." });
        var srcIn = Number(clip.inPoint.seconds), dur = Number(clip.end.seconds) - Number(clip.start.seconds);
        var insertTime = Number(clip.end.seconds) + ${offset !== undefined ? Number(offset) : 0};
        var tracksToCheck = [info.track];
        try { if (info.trackType === 'video' && seq.audioTracks[info.trackIndex]) tracksToCheck.push(seq.audioTracks[info.trackIndex]); } catch (eA) {}
        for (var t = 0; t < tracksToCheck.length; t++) {
          var tr = tracksToCheck[t];
          for (var i = 0; i < tr.clips.numItems; i++) {
            var o = tr.clips[i];
            if (o.start.seconds < insertTime + dur - 0.001 && o.end.seconds > insertTime + 0.001) {
              return JSON.stringify({ success: false, error: "The destination " + insertTime + "s-" + (insertTime + dur) + "s is occupied on " + tr.name + " by '" + o.name + "' (" + o.start.seconds + "s-" + o.end.seconds + "s). overwriteClip() would replace it, so nothing was placed. Pass an offset that lands on empty space." });
            }
          }
        }
        var oldIn = null, oldOut = null;
        try { oldIn = projItem.getInPoint(4).seconds; oldOut = projItem.getOutPoint(4).seconds; } catch (eM) {}
        var placeError = null;
        try {
          projItem.setInPoint(srcIn, 4);
          projItem.setOutPoint(srcIn + dur, 4);
          info.track.overwriteClip(projItem, insertTime);
        } catch (eP) { placeError = eP.toString(); }
        var marksRestored = false;
        try { if (oldIn !== null) { projItem.setInPoint(oldIn, 4); projItem.setOutPoint(oldOut, 4); marksRestored = Math.abs(projItem.getInPoint(4).seconds - oldIn) < 0.001 && Math.abs(projItem.getOutPoint(4).seconds - oldOut) < 0.001; } } catch (eR) {}
        var landed = null, tol = 0.04;
        for (var di = 0; di < info.track.clips.numItems; di++) {
          var cand = info.track.clips[di];
          if (Math.abs(cand.start.seconds - insertTime) > tol) continue;
          var sameSource = false;
          try { sameSource = String(cand.projectItem.nodeId) === String(projItem.nodeId); } catch (eSrc) {}
          if (sameSource) { landed = cand; break; }
        }
        if (!landed) return JSON.stringify({ success: false, verified: true, error: "overwriteClip() ran but no clip referencing this source is present at " + insertTime + "s, so the duplicate did not land." + (placeError ? " " + placeError : ""), marksRestored: marksRestored });
        var gotDur = landed.end.seconds - landed.start.seconds, gotIn = landed.inPoint.seconds;
        var exact = Math.abs(gotDur - dur) < tol && Math.abs(gotIn - srcIn) < tol;
        return JSON.stringify({
          success: exact, verified: true, verifiedBy: 'start/end/in readback of the placed clip',
          message: exact ? "Clip duplicated at " + insertTime + "s" : undefined,
          duplicateStartSeconds: landed.start.seconds, duplicateEndSeconds: landed.end.seconds, duplicateSourceInSeconds: gotIn,
          originalSourceInSeconds: srcIn, originalDurationSeconds: dur, insertSeconds: insertTime, marksRestored: marksRestored,
          note: "Effects, keyframes and speed changes are not carried over; use copy_effects_between_clips for effects.",
          error: exact ? undefined : "The duplicate landed but its range differs from the original (" + gotIn + "s/" + gotDur + "s vs " + srcIn + "s/" + dur + "s)."
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async replaceClip(clipId: string, newProjectItemId: string, _preserveEffects?: boolean): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var newItem = __findProjectItem(${JSON.stringify(newProjectItemId)});
        if (!newItem) return JSON.stringify({ success: false, error: "New project item not found" });
        var startTime = info.clip.start.seconds;
        info.clip.remove(false, true);
        info.track.overwriteClip(newItem, startTime);
        // Confirm the clip now covering startTime is backed by the requested item,
        // rather than trusting overwriteClip() (which returns void and can no-op).
        var replaced = false;
        for (var rci = 0; rci < info.track.clips.numItems; rci++) {
          var rc = info.track.clips[rci];
          if (rc.start.seconds <= startTime + 0.001 && rc.end.seconds > startTime - 0.001) {
            if (rc.projectItem && String(rc.projectItem.nodeId) === String(newItem.nodeId)) replaced = true;
            break;
          }
        }
        if (!replaced) return JSON.stringify({ success: false, verified: false, error: "Premiere reported the replace but '" + newItem.name + "' is not the clip at " + startTime + "s." });
        return JSON.stringify({ success: true, verified: true, message: "Clip replaced" });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async nestAllV1Clips(newSeqName: string, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var v1 = seq.videoTracks[0];
        if (!v1 || v1.clips.numItems === 0) return JSON.stringify({success:false,error:'No clips on V1'});
        var clips = [];
        for (var i=0;i<v1.clips.numItems;i++) clips.push(v1.clips[i]);
        seq.setSelection(clips);
        var nested = seq.nest(seq.getSelection(), ${JSON.stringify(newSeqName)});
        return JSON.stringify({success:true,nestedSequenceName:${JSON.stringify(newSeqName)},clipCount:clips.length,result:nested ? String(nested) : 'ok'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async batchReplaceClips(oldItemId: string, newItemId: string, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var newItem = __findProjectItem(${JSON.stringify(newItemId)});
        if (!newItem) return JSON.stringify({success:false,error:'New item not found: ' + ${JSON.stringify(newItemId)}});
        var oldItem = __findProjectItem(${JSON.stringify(oldItemId)});
        if (!oldItem) return JSON.stringify({success:false,verified:true,error:'The item to replace is not in this project: ' + ${JSON.stringify(oldItemId)} + '. Nothing was changed. Find the right nodeId with find_project_item_by_name.'});
        if (String(oldItem.nodeId) === String(newItem.nodeId)) return JSON.stringify({success:false,verified:true,error:'oldProjectItemId and newProjectItemId are the same item, so there is nothing to replace.'});
        var replaced = 0;
        var targetsFound = 0;
        var failures = [];
        var seqs = ${seqId ? `(function(){ var arr=[]; var ss=app.project.sequences; for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(seqId)})arr.push(ss[i]);} return arr; })()` : `(function(){ var arr=[]; var ss=app.project.sequences; for(var i=0;i<ss.numSequences;i++) arr.push(ss[i]); return arr; })()`};
        for (var s=0;s<seqs.length;s++) {
          var seq = seqs[s];
          for (var t=0;t<seq.videoTracks.numTracks;t++) {
            var track = seq.videoTracks[t];
            // TrackItem has NO replaceWithClip() — the old call raised
            // "clip.replaceWithClip is not a function" and the whole tool failed. There is no
            // DOM replace, so do it as remove + overwriteClip at the same start time.
            //
            // Targets are collected BEFORE mutating: removing a clip reshuffles
            // track.clips indices, so mutating inside the walk skips clips.
            var targets = [];
            for (var c=0;c<track.clips.numItems;c++) {
              var clip = track.clips[c];
              if (clip.projectItem && String(clip.projectItem.nodeId) === ${JSON.stringify(oldItemId)}) {
                targets.push(String(clip.start.ticks));
              }
            }
            targetsFound += targets.length;
            for (var ti2=0; ti2<targets.length; ti2++) {
              var atTicks = targets[ti2];
              // Re-find by start time, because the previous iteration shifted the collection.
              var victim = null;
              for (var c2=0;c2<track.clips.numItems;c2++) {
                if (String(track.clips[c2].start.ticks) === atTicks) { victim = track.clips[c2]; break; }
              }
              if (!victim) { failures.push('no clip at ' + atTicks); continue; }
              // NAME COLLISION BUG: this Time object was declared as "var t", which is the
              // enclosing TRACK loop counter. Assigning a Time to it made the next "t++" NaN,
              // so the track loop terminated after the first track that had any target — every
              // later track was silently skipped while the tool reported success.
              var atTime = new Time(); atTime.ticks = atTicks;
              try {
                victim.remove(false, false);
                track.overwriteClip(newItem, atTime);
              } catch (eRep) { failures.push(atTicks + ': ' + eRep.toString()); continue; }
              // Verify the replacement is actually there and references the NEW item.
              var ok = false;
              for (var c3=0;c3<track.clips.numItems;c3++) {
                var cand = track.clips[c3];
                if (String(cand.start.ticks) !== atTicks) continue;
                try { ok = String(cand.projectItem.nodeId) === String(newItem.nodeId); } catch (eV) {}
                break;
              }
              if (ok) replaced++; else failures.push(atTicks + ': replacement not present after overwrite');
            }
          }
        }
        // "replaced > 0 || failures.length === 0" reported a verified SUCCESS when the old item
        // appeared on no timeline at all: zero targets, zero failures, zero work. Report the
        // number of targets found separately from the number replaced.
        if (targetsFound === 0) {
          return JSON.stringify({
            success: false, verified: true, verifiedBy: 'walked every video track comparing clip.projectItem.nodeId',
            replaced: 0, targetsFound: 0, failures: [],
            oldItemId:${JSON.stringify(oldItemId)}, newItemId:${JSON.stringify(newItemId)},
            error: 'The item "' + String(oldItem.name) + '" is in the project but is not used on any video track of ' + ${JSON.stringify(seqId ? 'the requested sequence' : 'any sequence')} + ', so nothing was replaced. This tool only replaces TIMELINE clips; to relink the master item itself use relink_media or replace_clip_media.'
          });
        }
        return JSON.stringify({
          success: replaced === targetsFound,
          verified: true, verifiedBy: 'each replacement re-read and compared by projectItem.nodeId',
          replaced: replaced, targetsFound: targetsFound, failures: failures,
          oldItemId:${JSON.stringify(oldItemId)}, newItemId:${JSON.stringify(newItemId)},
          error: replaced === targetsFound ? null : (replaced === 0
            ? ('None of the ' + targetsFound + ' clips referencing "' + String(oldItem.name) + '" could be replaced: ' + failures.join(' | '))
            : ('PARTIALLY APPLIED: ' + replaced + ' of ' + targetsFound + ' clips were replaced. The rest were REMOVED but not overwritten, so those positions are now gaps — undo, or fill them from the source. Details: ' + failures.join(' | ')))
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
