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
        var splitSeconds = info.clip.start.seconds + ${splitTime};
        // The timecode must come from the sequence the clip actually lives in, not
        // from whatever is on screen. Taking it from the active sequence put the cut
        // on the right timeline at the wrong frame whenever the two differed in frame
        // rate: a 24 fps clip razored using a 30 fps timebase lands three frames out.
        var seq = info.sequence;
        var fps = seq && seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
        var totalFrames = Math.round(splitSeconds * fps);
        var hours = Math.floor(totalFrames / (fps * 3600));
        var mins = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
        var secs = Math.floor((totalFrames % (fps * 60)) / fps);
        var frames = Math.round(totalFrames % fps);
        function pad(n) { return n < 10 ? "0" + n : "" + n; }
        var tc = pad(hours) + ":" + pad(mins) + ":" + pad(secs) + ":" + pad(frames);
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = info.trackType === 'video' ? qeSeq.getVideoTrackAt(info.trackIndex) : qeSeq.getAudioTrackAt(info.trackIndex);
        var beforeCount = info.track.clips.numItems;
        qeTrack.razor(tc);
        var afterCount = info.track.clips.numItems;
        // A razor that lands on a clip splits it, so the track's clip count rises by
        // one. If it did not, the cut fell in a gap or off the clip -- report that
        // honestly rather than claiming a split that did not happen.
        if (afterCount <= beforeCount) return JSON.stringify({ success: false, verified: false, error: "Razor at " + tc + " did not split any clip (track clip count unchanged). The split time may fall in a gap or outside the clip.", beforeCount: beforeCount, afterCount: afterCount });
        return JSON.stringify({ success: true, verified: true, message: "Clip split at " + tc, splitTime: ${splitTime}, timecode: tc, beforeCount: beforeCount, afterCount: afterCount });
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

        var qeSeq = __qeSequenceFor(sequence);
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
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var projItem = clip.projectItem;
        var insertTime = clip.end.seconds + ${offset !== undefined ? offset : 0};
        var beforeCount = info.track.clips.numItems;
        info.track.overwriteClip(projItem, insertTime);
        var afterCount = info.track.clips.numItems;
        // Verify by LOOKING FOR THE CLIP, not by counting.
        //
        // overwriteClip OVERWRITES: dropped onto occupied time it replaces what is there, so the
        // track count legitimately stays the same and the old check reported a false negative for
        // a duplicate that had in fact landed. Counting only works when the destination is empty,
        // which is exactly the case a caller cannot guarantee.
        var landed = null, tolerance = 0.04;
        for (var di = 0; di < info.track.clips.numItems; di++) {
          var cand = info.track.clips[di];
          if (Math.abs(cand.start.seconds - insertTime) > tolerance) continue;
          var sameSource = false;
          try { sameSource = String(cand.projectItem.nodeId) === String(projItem.nodeId); } catch (eSrc) {}
          if (sameSource) { landed = cand; break; }
        }
        if (!landed) return JSON.stringify({
          success: false, verified: true,
          error: "overwriteClip() ran but no clip referencing this source is present at " + insertTime + "s, so the duplicate did not land.",
          beforeCount: beforeCount, afterCount: afterCount, insertSeconds: insertTime
        });
        return JSON.stringify({
          success: true, verified: true,
          message: "Clip duplicated at " + insertTime + "s",
          beforeCount: beforeCount, afterCount: afterCount,
          // Same count with a clip present means an existing clip was overwritten rather than a
          // new one appended. The caller should know which happened.
          replacedExisting: afterCount === beforeCount,
          insertSeconds: insertTime,
          duplicateStartSeconds: landed.start.seconds,
          duplicateEndSeconds: landed.end.seconds
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

  protected async nestAllV1Clips(newSeqName: string, _seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
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
