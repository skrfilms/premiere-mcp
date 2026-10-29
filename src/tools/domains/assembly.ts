/**
 * AssemblyTools -- the Assembly Editing tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { ToolsBase } from './base.js';
import { TRIM_LIB } from '../trim-lib.js';
import { runFf } from '../ff-exec.js';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class AssemblyTools extends ToolsBase {
  /**
   * Freeze frame: hold the frame at `time` for `durationSecs`, as an overwrite on the clip's track.
   *
   * There is no frame-hold call on 26.5.2 (setFrameHold / freezeFrame do not exist on TrackItem or
   * the QE clip), so this builds it from parts that are each verified: ffmpeg pulls the SOURCE
   * frame the clip shows at `time` (mapped through its in point and speed), the PNG is imported
   * with in/out set to the hold length, and it is overwritten onto the same track at `time`.
   * Overwrite rather than insert so nothing on other tracks slides out of sync; the clip's tail
   * after the hold keeps playing from where it would have been.
   *
   * Limits, reported rather than hidden: the still is the raw source frame, so effects on the
   * original clip (Lumetri, Motion) are not carried onto it; reversed or time-remapped clips are
   * refused because their source time cannot be computed from in point and speed.
   */
  protected async freezeFrame(args: any): Promise<any> {
    const clipId = String(args.clipId ?? args.node_id ?? args.nodeId ?? '');
    if (!clipId) return { success: false, error: 'freeze_frame requires clipId.' };
    const at = Number(args.time ?? args.seconds ?? NaN);
    const hold = Number(args.durationSecs ?? args.duration ?? 2);
    if (!(hold > 0)) return { success: false, error: 'durationSecs must be greater than 0.' };
    const seqArg = JSON.stringify(args.sequenceId ?? null);
    const info: any = await this.bridge.executeScript(`
      try {
        var f = __findClip(${JSON.stringify(clipId)}, ${seqArg});
        if (!f) return JSON.stringify({success:false,error:'Clip not found'});
        if (f.trackType !== 'video') return JSON.stringify({success:false,error:'freeze_frame needs a video clip.'});
        var c = f.clip, speed = 1, reversed = false;
        try { speed = Number(c.getSpeed()); } catch (eS) {}
        try { reversed = !!c.isSpeedReversed(); } catch (eR) {}
        var path = '';
        try { path = String(c.projectItem.getMediaPath()); } catch (eP) {}
        var projDir = '';
        try { projDir = String(app.project.path).replace(/[\\/][^\\/]*$/, ''); } catch (eD) {}
        return JSON.stringify({success:true,start:c.start.seconds,end:c.end.seconds,inPoint:c.inPoint.seconds,speed:speed,reversed:reversed,
          mediaPath:path,projectDir:projDir,trackIndex:f.trackIndex,sequenceId:String(f.sequenceId),name:String(c.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!info || info.success === false) return info;
    const t = Number.isFinite(at) ? at : info.start;
    if (t < info.start - 1e-6 || t >= info.end) {
      return {
        success: false,
        error: `time ${t}s is outside "${info.name}" (${info.start}s-${info.end}s). Nothing was changed.`,
      };
    }
    if (info.reversed || !(info.speed > 0)) {
      return {
        success: false,
        error: `"${info.name}" is reversed or time-remapped, so the source frame at ${t}s cannot be computed. Nothing was changed.`,
      };
    }
    if (!info.mediaPath || !existsSync(info.mediaPath)) {
      return {
        success: false,
        error: `The clip's media is not on disk (${info.mediaPath || 'no path'}), so its frame cannot be extracted.`,
      };
    }
    const sourceSecs = info.inPoint + (t - info.start) * info.speed;
    const outDir = join(info.projectDir || dirname(info.mediaPath), 'Freeze Frames');
    mkdirSync(outDir, { recursive: true });
    const stamp = sourceSecs.toFixed(3).replace('.', '_');
    const base = String(info.name)
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_');
    const png = join(outDir, `${base}_hold_${stamp}.png`);
    try {
      runFf(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-ss',
          String(sourceSecs),
          '-i',
          info.mediaPath,
          '-frames:v',
          '1',
          png,
        ],
        { timeoutMs: 60000 },
      );
    } catch (e: any) {
      return { success: false, error: `ffmpeg could not extract the frame: ${e.message}` };
    }
    if (!existsSync(png)) return { success: false, error: 'ffmpeg ran but wrote no frame.' };
    return await this.bridge.executeScript(`
      try {
        var seq = __findSequence(${JSON.stringify(info.sequenceId)});
        if (!seq) return JSON.stringify({success:false,error:'Sequence not found'});
        var png = ${JSON.stringify(png)};
        var bin = null;
        for (var b = 0; b < app.project.rootItem.children.numItems; b++) {
          var ch = app.project.rootItem.children[b];
          if (ch.type === 2 && String(ch.name) === 'Freeze Frames') { bin = ch; break; }
        }
        if (!bin) bin = app.project.rootItem.createBin('Freeze Frames');
        app.project.importFiles([png], true, bin, false);
        var still = null, wanted = png.replace(/^.*[\\/]/, '');
        for (var i = bin.children.numItems - 1; i >= 0; i--) {
          if (String(bin.children[i].name) === wanted) { still = bin.children[i]; break; }
        }
        if (!still) return JSON.stringify({success:false,error:'The frame was extracted but importing it produced no project item.',png:png});
        still.setInPoint(0, 4);
        still.setOutPoint(${hold}, 4);
        var track = seq.videoTracks[${info.trackIndex}];
        var when = new Time(); when.seconds = ${t};
        track.overwriteClip(still, when);
        var landed = null;
        for (var k = 0; k < track.clips.numItems; k++) {
          var tc = track.clips[k];
          if (Math.abs(tc.start.seconds - ${t}) < 0.02 && String(tc.projectItem.nodeId) === String(still.nodeId)) { landed = tc; break; }
        }
        if (!landed) return JSON.stringify({success:false,verified:true,error:'The still was imported but did not land at ${t}s on V${info.trackIndex + 1} (locked or untargeted track?).',png:png});
        var len = landed.end.seconds - landed.start.seconds;
        return JSON.stringify({success:Math.abs(len - ${hold}) < 0.05,verified:true,verifiedBy:'track item readback',method:'source frame extracted with ffmpeg, overwritten as a still',
          heldFrameSourceSecs:${sourceSecs},startSecs:landed.start.seconds,endSecs:landed.end.seconds,holdSecs:len,png:png,stillItemId:String(still.nodeId),
          note:'Effects on the original clip are not carried onto the still.',
          error: Math.abs(len - ${hold}) < 0.05 ? undefined : 'The hold landed but is ' + len + 's long instead of ${hold}s.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async threePointEdit(
    projectItemId: string,
    sourceIn?: string,
    sourceOut?: string,
    sequenceTimecode?: string,
    mode = 'overwrite',
    videoTrack = 0,
    _audioTrack = 0,
  ): Promise<any> {
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
        // sequenceTimecode is a timecode string ("00:00:50:00", ';' for drop-frame) or plain
        // seconds. It was assigned straight to Time.seconds, which throws "Illegal Parameter type"
        // for every timecode, so passing one at all made the tool fail.
        ${
          sequenceTimecode
            ? `
        var tcRaw = ${JSON.stringify(String(sequenceTimecode))};
        var tcSecs = NaN;
        if (/^[0-9]+(\\.[0-9]+)?$/.test(tcRaw)) {
          tcSecs = Number(tcRaw);
        } else {
          var tcParts = tcRaw.split(/[:;]/);
          if (tcParts.length === 4) {
            var tcFps = 254016000000 / Number(seq.timebase);
            var tcNominal = Math.round(tcFps);
            tcSecs = Number(tcParts[0]) * 3600 + Number(tcParts[1]) * 60 + Number(tcParts[2]) + Number(tcParts[3]) / tcNominal;
          }
        }
        if (isNaN(tcSecs)) return JSON.stringify({success:false,error:'sequenceTimecode "' + tcRaw + '" is neither HH:MM:SS:FF nor a number of seconds. Nothing was edited.'});
        var t = new Time(); t.seconds = tcSecs; seq.setPlayerPosition(String(t.ticks));`
            : ''
        }
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
        return JSON.stringify({success:true,verified:true,verifiedBy:'clip covering the playhead compared by projectItem.nodeId',changed:true,mode:${JSON.stringify(mode)},sourceItem:String(item.name),sourceIn:${JSON.stringify(sourceIn ?? null)},sourceOut:${JSON.stringify(sourceOut ?? null)},clipsBefore:beforeCount,clipsAfter:afterCount,atSeconds:landAtSeconds});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // Timeline Operations Implementation
  protected async addToTimelineBatch(
    sequenceId: string,
    clips: Array<{
      projectItemId: string;
      trackIndex: number;
      time?: number;
      linkAudio?: boolean;
      sourceInPoint?: number;
      sourceOutPoint?: number;
    }>,
    mode: 'absolute' | 'append' = 'absolute',
  ): Promise<any> {
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
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sequenceId,
        mode,
        requested: clips.length,
      };
    }
  }

  protected async addToTimeline(
    sequenceId: string,
    projectItemId: string,
    trackIndex: number,
    time: number,
    insertMode = 'overwrite',
    linkAudio: boolean = true,
    sourceInPoint?: number,
    sourceOutPoint?: number,
  ): Promise<any> {
    try {
      // insertMode used to stop here: it was echoed in every response below while
      // the bridge unconditionally overwrote, so a caller asking to insert-and-shift
      // had the footage it was moving destroyed and was told the opposite.
      const result: any = await this.bridge.addToTimeline(
        sequenceId,
        projectItemId,
        trackIndex,
        time,
        linkAudio,
        sourceInPoint,
        sourceOutPoint,
        insertMode,
      );
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
          sourceOutPoint: sourceOutPoint,
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
        ...result,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to add clip to timeline: ${error instanceof Error ? error.message : String(error)}`,
        sequenceId: sequenceId,
        projectItemId: projectItemId,
        trackIndex: trackIndex,
        time: time,
      };
    }
  }

  protected async removeFromTimeline(
    clipId: string,
    sequenceId?: string,
    deleteMode = 'ripple',
  ): Promise<any> {
    const script = `
      ${TRIM_LIB}
      try {
        var info = __findClip(${JSON.stringify(clipId)}, ${sequenceId ? JSON.stringify(sequenceId) : 'null'});
        if (!info) return JSON.stringify({ success: false, error: ${sequenceId ? JSON.stringify(`Clip not found in sequence: ${sequenceId}`) : '"Clip not found"'} });
        var clip = info.clip;
        var clipName = String(clip.name);
        var isRipple = ${JSON.stringify(deleteMode)} === "ripple";
        // TrackItem.remove() removes only that item and never ripples on 26.5.2, so a "ripple"
        // left a gap and both modes orphaned the linked audio. __removeGroup does both properly.
        var r = __removeGroup(info.sequence, clip, isRipple);
        if (r.error) return JSON.stringify({ success: false, error: r.error, deleteMode: ${JSON.stringify(deleteMode)} });
        return JSON.stringify({
          success: r.problems.length === 0,
          verified: true,
          verifiedBy: "every linked item looked up after removal; rippled clips' starts read back",
          message: r.problems.length ? undefined : "Clip removed from timeline",
          clipId: ${JSON.stringify(clipId)},
          clipName: clipName,
          sequenceId: info.sequenceId,
          sequenceName: info.sequenceName,
          deleteMode: ${JSON.stringify(deleteMode)},
          removed: r.removed,
          rippledSecs: r.rippledSecs,
          clipsRippled: r.clipsRippled,
          error: r.problems.length ? "PARTIALLY APPLIED: " + r.problems.join("; ") + ". Undo to restore." : undefined
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

  protected async razorTimelineAtTime(
    sequenceId?: string,
    time?: number,
    videoTrackIndices?: number[],
    audioTrackIndices?: number[],
  ): Promise<any> {
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
      error:
        'create_nested_sequence: This feature requires selection and nesting APIs. Implementation pending.',
      note: 'You can manually nest clips via right-click > Nest',
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

  /**
   * Swap the media under one timeline clip and keep everything an editor set on it.
   *
   * This used to remove the clip and overwriteClip() the new item at full length, and it took
   * preserveEffects and ignored it: in a live version-up the trim, the Lumetri grade and the Motion
   * scale were all lost, and the full-length v002 ran over the next shot. Now (preserveEffects,
   * the default): a temporary copy past the end of the edit takes the old clip's effects, the old
   * clip and its linked audio are removed, the new media is laid into the old slot with the old
   * source range, the effects are copied onto it from the temporary copy, and the copy is deleted.
   * Nothing is slid across other clips (that scrambled Premiere's track order; see below).
   * Verified by readback: same start, end and in point, every effect present.
   *
   * To relink every use of a project item at once instead (the usual VFX version-up), use
   * replace_clip_media, which keeps the timeline clips themselves untouched.
   */
  protected async replaceClip(
    clipId: string,
    newProjectItemId: string,
    preserveEffects?: boolean,
  ): Promise<any> {
    const keep = preserveEffects !== false;
    const prep: any = await this.bridge.executeScript(`
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var newItem = __findProjectItem(${JSON.stringify(newProjectItemId)});
        if (!newItem) return JSON.stringify({ success: false, error: "New project item not found" });
        var c = info.clip, seq = info.sequence, track = info.track;
        var speed = 1, rev = false;
        try { speed = Number(c.getSpeed()); } catch (eS) {}
        try { rev = !!c.isSpeedReversed(); } catch (eR) {}
        if (${keep} && (Math.abs(speed - 1) > 0.0001 || rev)) return JSON.stringify({ success: false, error: "The clip is speed-changed or reversed, so its source range cannot be reproduced on the new media. Nothing was changed. Pass preserveEffects:false to drop in the new media at its own length." });
        var o = { success: true, seq: String(seq.sequenceID), video: info.trackType === 'video', track: info.trackIndex,
          start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds, outPoint: c.outPoint.seconds,
          effects: [], linked: [] };
        for (var k = 0; k < c.components.numItems; k++) o.effects.push(String(c.components[k].displayName));
        try { var li = c.getLinkedItems(); for (var l = 0; l < li.numItems; l++) if (String(li[l].nodeId) !== String(c.nodeId)) o.linked.push(String(li[l].nodeId)); } catch (eL) {}
        if (!${keep}) return JSON.stringify(o);
        // Empty space past everything on every track, so the staging copy overlaps nothing.
        var far = 0;
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) { var tv = seq.videoTracks[vt]; if (tv.clips.numItems) far = Math.max(far, tv.clips[tv.clips.numItems - 1].end.seconds); }
        for (var at = 0; at < seq.audioTracks.numTracks; at++) { var ta = seq.audioTracks[at]; if (ta.clips.numItems) far = Math.max(far, ta.clips[ta.clips.numItems - 1].end.seconds); }
        far = Math.ceil(far) + 10;
        var prevIn = null, prevOut = null;
        try { prevIn = newItem.getInPoint().seconds; prevOut = newItem.getOutPoint().seconds; } catch (eP) {}
        newItem.setInPoint(o.inPoint, 4);
        newItem.setOutPoint(o.inPoint + (o.end - o.start), 4);
        var when = new Time(); when.seconds = far;
        track.overwriteClip(newItem, when);
        // Put the bin item's own marks back: they are the item's, not this edit's.
        try { if (prevIn !== null) { newItem.setInPoint(prevIn, 4); newItem.setOutPoint(prevOut, 4); } } catch (eB) {}
        var staged = null, stagedIndex = -1;
        for (var s2 = 0; s2 < track.clips.numItems; s2++) { var tc = track.clips[s2]; if (Math.abs(tc.start.seconds - far) < 0.02) { staged = tc; stagedIndex = s2; break; } }
        if (!staged) return JSON.stringify({ success: false, error: "Could not place the new media to stage the swap (locked or untargeted track?). Nothing was changed." });
        // Effects the old clip has and the staged copy lacks, added by name so their values can be copied.
        var have = {}; for (var h = 0; h < staged.components.numItems; h++) have[String(staged.components[h].displayName)] = (have[String(staged.components[h].displayName)] || 0) + 1;
        var need = {}; for (var e = 0; e < o.effects.length; e++) need[o.effects[e]] = (need[o.effects[e]] || 0) + 1;
        var added = [], missing = [];
        app.enableQE();
        var q = __qeSequenceOpening(seq);
        var qc = q ? __qeClipByIndex(q, o.video ? 'video' : 'audio', o.track, stagedIndex) : null;
        for (var name in need) {
          var lacking = need[name] - (have[name] || 0);
          for (var n = 0; n < lacking; n++) {
            var fx = o.video ? qe.project.getVideoEffectByName(name) : qe.project.getAudioEffectByName(name);
            try { if (qc && fx) { if (o.video) qc.addVideoEffect(fx); else qc.addAudioEffect(fx); added.push(name); } else missing.push(name); } catch (eA) { missing.push(name); }
          }
        }
        o.staged = String(staged.nodeId);
        o.stagedStart = far;
        o.added = added;
        o.missing = missing;
        return JSON.stringify(o);
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `);
    if (!prep?.success) return prep;

    if (!keep) {
      // The old behaviour, on request: drop the new media in at its own length.
      return await this.bridge.executeScript(`
        try {
          var info = __findClip(${JSON.stringify(clipId)});
          var newItem = __findProjectItem(${JSON.stringify(newProjectItemId)});
          var t = new Time(); t.seconds = info.clip.start.seconds;
          info.clip.remove(false, true);
          info.track.overwriteClip(newItem, t);
          return JSON.stringify({ success: true, verified: false, preserveEffects: false, note: "Placed at its own length; trims and effects were not carried over." });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
    }

    // Effects: old clip -> temporary copy (it holds them while the old clip goes away).
    await (this as any).executeTool('copy_effects_between_clips', {
      sourceClipId: clipId,
      targetClipId: prep.staged,
      sourceSequenceId: prep.seq,
      targetSequenceId: prep.seq,
    });

    // No TrackItem.move(): sliding the staged copy back across other clips left Premiere's
    // internal track order scrambled (QE listed SH020 6-12s before SH010 1-4s, then "Empty from
    // 4s"), and everything after the moved clip rendered black — measured on 26.5.2. Instead the
    // new clip is laid straight into the old slot and the temporary copy is deleted afterwards.
    const placed: any = await this.bridge.executeScript(`
      try {
        var seq = __findSequence(${JSON.stringify(prep.seq)});
        var old = __findClip(${JSON.stringify(clipId)}, ${JSON.stringify(prep.seq)});
        var newItem = __findProjectItem(${JSON.stringify(newProjectItemId)});
        if (!old || !newItem) return JSON.stringify({ success: false, error: "Lost the old clip or the new item mid-swap." });
        var track = old.track;
        var oldLinked = ${JSON.stringify(prep.linked)};
        for (var l = 0; l < oldLinked.length; l++) { var lo = __findClip(oldLinked[l], ${JSON.stringify(prep.seq)}); if (lo) lo.clip.remove(false, false); }
        old.clip.remove(false, false);
        var prevIn = null, prevOut = null;
        try { prevIn = newItem.getInPoint().seconds; prevOut = newItem.getOutPoint().seconds; } catch (eP) {}
        newItem.setInPoint(${prep.inPoint}, 4);
        newItem.setOutPoint(${prep.inPoint} + (${prep.end} - ${prep.start}), 4);
        var when = new Time(); when.seconds = ${prep.start};
        track.overwriteClip(newItem, when);
        try { if (prevIn !== null) { newItem.setInPoint(prevIn, 4); newItem.setOutPoint(prevOut, 4); } } catch (eB) {}
        var fin = null, finIndex = -1;
        for (var k = 0; k < track.clips.numItems; k++) { var tc = track.clips[k]; if (Math.abs(tc.start.seconds - ${prep.start}) < 0.02) { fin = tc; finIndex = k; break; } }
        if (!fin) return JSON.stringify({ success: false, error: "The new media did not land in the old slot. The temporary copy past the end of the edit still holds the effects." });
        var have = {}; for (var h = 0; h < fin.components.numItems; h++) have[String(fin.components[h].displayName)] = (have[String(fin.components[h].displayName)] || 0) + 1;
        var need = {}; var want = ${JSON.stringify(prep.effects)}; for (var e = 0; e < want.length; e++) need[want[e]] = (need[want[e]] || 0) + 1;
        app.enableQE();
        var q = __qeSequenceOpening(seq);
        var qc = q ? __qeClipByIndex(q, ${prep.video ? "'video'" : "'audio'"}, ${prep.track}, finIndex) : null;
        for (var name in need) {
          var lacking = need[name] - (have[name] || 0);
          for (var n = 0; n < lacking; n++) {
            var fx = ${prep.video ? 'qe.project.getVideoEffectByName(name)' : 'qe.project.getAudioEffectByName(name)'};
            try { if (qc && fx) { ${prep.video ? 'qc.addVideoEffect(fx)' : 'qc.addAudioEffect(fx)'}; } } catch (eA) {}
          }
        }
        return JSON.stringify({ success: true, finalId: String(fin.nodeId) });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!placed?.success) return placed;

    // Effects: temporary copy -> the clip now in the old slot.
    const copied: any = await (this as any).executeTool('copy_effects_between_clips', {
      sourceClipId: prep.staged,
      targetClipId: placed.finalId,
      sourceSequenceId: prep.seq,
      targetSequenceId: prep.seq,
    });

    return await this.bridge.executeScript(`
      try {
        var tmp = __findClip(${JSON.stringify(prep.staged)}, ${JSON.stringify(prep.seq)});
        if (tmp) {
          var tl = [];
          try { var li = tmp.clip.getLinkedItems(); for (var i = 0; i < li.numItems; i++) if (String(li[i].nodeId) !== String(tmp.clip.nodeId)) tl.push(li[i]); } catch (eL) {}
          for (var t = 0; t < tl.length; t++) { try { tl[t].remove(false, false); } catch (eT) {} }
          tmp.clip.remove(false, false);
        }
        var now = __findClip(${JSON.stringify(placed.finalId)}, ${JSON.stringify(prep.seq)});
        var c = now ? now.clip : null;
        var effects = [];
        if (c) for (var e = 0; e < c.components.numItems; e++) effects.push(String(c.components[e].displayName));
        var want = ${JSON.stringify(prep.effects)};
        var lost = [];
        for (var w = 0; w < want.length; w++) { var found = false; for (var f = 0; f < effects.length; f++) if (effects[f] === want[w]) { found = true; effects.splice(f, 1); break; } if (!found) lost.push(want[w]); }
        var placedOk = c && Math.abs(c.start.seconds - ${prep.start}) < 0.02 && Math.abs(c.end.seconds - ${prep.end}) < 0.02 && Math.abs(c.inPoint.seconds - ${prep.inPoint}) < 0.02;
        return JSON.stringify({
          success: !!placedOk && lost.length === 0 && !__findClip(${JSON.stringify(prep.staged)}, ${JSON.stringify(prep.seq)}), verified: true,
          verifiedBy: 'timeline readback of start, end, in point and effect list; temporary copy removed',
          clipId: c ? String(c.nodeId) : null, start: c ? c.start.seconds : null, end: c ? c.end.seconds : null, inPoint: c ? c.inPoint.seconds : null,
          effectsAdded: ${JSON.stringify(prep.added)}, effectValuesCopied: ${JSON.stringify(copied?.data?.copied ?? copied?.copied ?? null)},
          note: 'The swapped clip has a new clip id; use clipId from this result.',
          error: !placedOk ? 'The new clip did not land at the old clip\\'s exact position and source range.' : (lost.length ? 'These effects could not be carried over: ' + lost.join(', ') : undefined)
        });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
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

  protected async batchReplaceClips(
    oldItemId: string,
    newItemId: string,
    seqId?: string,
  ): Promise<any> {
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
