/**
 * AssemblyTools -- the Assembly Editing tool domain.
 *
 * A plain class on ToolsBase. PremiereProTools holds one instance and dispatches tool calls
 * to it by name; other domains it relies on are reached through `this.peers`.
 */
import { ToolsBase } from './base.js';
import { TRIM_LIB } from '../trim-lib.js';
import { STATE_HELPERS, revertScript } from '../timeline-state.js';
import { runFf } from '../ff-exec.js';
import { mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * If `firstFile` is the first file of a numbered image sequence (name_0001.exr with a
 * name_0002.exr beside it), the file that holds the frame at `sourceSecs`. Null for a single
 * still. An error when it is a sequence but the frame cannot be located honestly.
 */
export function imageSequenceFrame(
  firstFile: string,
  sourceSecs: number,
  fps: number,
  exists: (p: string) => boolean = existsSync,
): { file: string } | { error: string } | null {
  const m = /^(.*?)(\d+)(\.[^.]+)$/.exec(basename(firstFile));
  if (!m) return null;
  const [, prefix = '', digits = '', ext = ''] = m;
  const dir = dirname(firstFile);
  const at = (n: number) => join(dir, `${prefix}${String(n).padStart(digits.length, '0')}${ext}`);
  const first = parseInt(digits, 10);
  if (!exists(at(first + 1))) return null;
  if (!(fps > 0)) {
    return {
      error: `"${basename(firstFile)}" is an image sequence and its frame rate could not be read, so the frame at ${sourceSecs}s cannot be located. Nothing was changed.`,
    };
  }
  const file = at(first + Math.floor(sourceSecs * fps + 1e-6));
  if (!exists(file)) {
    return {
      error: `The image-sequence frame for ${sourceSecs}s (${basename(file)}) is not on disk. Nothing was changed.`,
    };
  }
  return { file };
}

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
  async freezeFrame(args: any): Promise<any> {
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
        var fps = 0;
        try { fps = Number(c.projectItem.getFootageInterpretation().frameRate); } catch (eF) {}
        // "Still Image" for a single still, "Video" for numbered stills imported as a sequence
        // (measured 2026-11-01; a still also reports 29.97 fps, so the rate cannot tell them apart).
        var mediaType = null;
        try { var __md = /<premierePrivateProjectMetaData:Column\\.Intrinsic\\.MediaType>([^<]*)</.exec(String(c.projectItem.getProjectMetadata())); mediaType = __md ? __md[1] : null; } catch (eT) {}
        var projDir = '';
        try { projDir = String(app.project.path).replace(/[\\/][^\\/]*$/, ''); } catch (eD) {}
        return JSON.stringify({success:true,start:c.start.seconds,end:c.end.seconds,inPoint:c.inPoint.seconds,speed:speed,reversed:reversed,
          mediaPath:path,frameRate:fps,mediaType:mediaType,projectDir:projDir,trackIndex:f.trackIndex,sequenceId:String(f.sequenceId),name:String(c.name)});
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
    // Image media: a numbered image sequence (Premiere reports its first file) is held by picking
    // the frame's own file; a single still has one frame at every time, so it is read without a
    // seek. Animated GIFs are left to ffmpeg's normal seek.
    let input = info.mediaPath;
    let seek: string[] = ['-ss', String(sourceSecs)];
    let heldFile: string | undefined;
    if (/\.(png|jpe?g|tiff?|psd|bmp|exr|dpx|tga)$/i.test(info.mediaPath)) {
      seek = [];
      // Premiere says which it is. A numbered file beside it proves nothing: a single still from
      // a folder of numbered photos would otherwise hold a different photo.
      // Only the two measured English values are trusted; anything else (a localized Premiere,
      // an empty field) is treated as unknown, which refuses when a numbered neighbour exists.
      const still = info.mediaType === 'Still Image';
      const sequence = info.mediaType === 'Video';
      if (!still) {
        const seqFrame = imageSequenceFrame(info.mediaPath, sourceSecs, Number(info.frameRate));
        if (seqFrame && !sequence) {
          return {
            success: false,
            error: `Could not tell whether "${basename(info.mediaPath)}" is a single still or the first frame of an image sequence (Premiere reports its media type as ${info.mediaType == null ? 'nothing' : `"${info.mediaType}"`}), so the frame at ${sourceSecs}s cannot be picked safely. Nothing was changed.`,
          };
        }
        if (seqFrame && 'error' in seqFrame) return { success: false, error: seqFrame.error };
        if (seqFrame) input = heldFile = seqFrame.file;
        else if (sequence) {
          return {
            success: false,
            error: `Premiere treats "${basename(info.mediaPath)}" as an image sequence, but its numbered files could not be found beside it, so the frame at ${sourceSecs}s cannot be located. Nothing was changed.`,
          };
        }
      }
    }
    try {
      runFf('ffmpeg', ['-v', 'error', '-y', ...seek, '-i', input, '-frames:v', '1', png], {
        timeoutMs: 60000,
      });
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
          heldFrameSourceSecs:${sourceSecs},heldFromFile:${JSON.stringify(heldFile ?? null)},startSecs:landed.start.seconds,endSecs:landed.end.seconds,holdSecs:len,png:png,stillItemId:String(still.nodeId),
          note:'Effects on the original clip are not carried onto the still.',
          error: Math.abs(len - ${hold}) < 0.05 ? undefined : 'The hold landed but is ' + len + 's long instead of ${hold}s.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  async threePointEdit(
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
  async addToTimelineBatch(
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

  async addToTimeline(
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

  async removeFromTimeline(
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

  async splitClip(clipId: string, splitTime: number): Promise<any> {
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

  async razorTimelineAtTime(
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

  // Additional Clip Operations
  async duplicateClip(clipId: string, offset?: number): Promise<any> {
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
   * Swap the media under one timeline clip and keep everything an editor set on it, without ever
   * touching anything else.
   *
   * preserveEffects (the default): the clip and every clip linked to it (its audio, or its video)
   * are read: track, start, end, source in point, on/off, effect order, every setting by POSITION
   * with keyframes, and the transitions on their edges. The whole layout is then rebuilt on a
   * temporary copy of the new media past the end of the edit, where nothing else lives: each
   * linked clip on its own track and with its own span (so L- and J-cuts, and audio on another
   * track than the video, come back as they were), effects added in order, settings written,
   * and everything compared with the original. The old clip is touched only when that rehearsal
   * matches exactly, the new media is long enough, and every span the rebuild writes in the old
   * slot is free apart from the old clip's own group; all of that is checked again just before
   * the swap, so an edit made in between stops it untouched.
   *
   * Linked clips that are not rebuilt stay exactly where they are and are linked to the new
   * pieces: a clip from other media (dual-system sound synced to the picture), and a kind of clip
   * the new media does not have (the sync sound under a picture-only VFX render). Audio channels
   * are matched by the order Premiere lays them out in, so a layout it would not reproduce (dual
   * mono moved to other tracks, or a different channel count) is refused rather than guessed.
   *
   * After the swap, settings, layout and edge transitions are compared again. Transitions cannot
   * be rehearsed (they need the neighbouring clip), so they are re-added after the swap and read
   * back; if anything differs the whole swap is undone, step by step, until the sequence is back
   * to the state it was in before the swap, and the result says so. A transition centred on the
   * cut cannot be re-created by script (QE places it starting or ending at the cut), so a clip
   * with one is refused up front. Keyframe interpolation has no scripting read and is not
   * carried; the result says so. Settings that cannot be read on the old clip refuse the swap.
   *
   * By position, not by name: Lumetri repeats setting names (four "Saturation"), and the old
   * by-name copy wrote one over another while reporting success. Nothing is slid across other
   * clips: TrackItem.move() scrambled Premiere's track order on 26.5.2.
   *
   * To relink every use of a project item at once instead (the usual VFX version-up), use
   * replace_clip_media, which keeps the timeline clips themselves untouched.
   */
  async replaceClip(
    clipId: string,
    newProjectItemId: string,
    preserveEffects?: boolean,
  ): Promise<any> {
    const keep = preserveEffects !== false;
    const q = JSON.stringify;
    if (!keep) {
      // The old behaviour, on request: drop the new media in at its own length.
      return await this.bridge.executeScript(`
        try {
          var info = __findClip(${q(clipId)});
          if (!info) return JSON.stringify({ success: false, changed: false, error: "Clip not found" });
          var newItem = __findProjectItem(${q(newProjectItemId)});
          if (!newItem) return JSON.stringify({ success: false, changed: false, error: "New project item not found" });
          var t = new Time(); t.seconds = info.clip.start.seconds;
          info.clip.remove(false, true);
          info.track.overwriteClip(newItem, t);
          return JSON.stringify({ success: true, verified: false, preserveEffects: false, note: "Placed at its own length; trims and effects were not carried over." });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
    }

    // Shared by the rehearsal and the swap.
    //  __layOut: lays the new media out as the old group was, shifted by `shift` seconds, using
    //            only overwriteClip on tracks (which puts video on Vn and audio on An) plus trims;
    //            spare pieces a placement creates are removed; the result is linked. A member
    //            flagged keep (other media, or a kind the new media does not have) is not rebuilt:
    //            the old clip stays where it is and is linked to the new pieces.
    //  __carry:  adds missing effects in order, writes settings by position, compares.
    const lib = `
      var __TPS = 254016000000;
      function __T(x) { var t = new Time(); t.seconds = x; return t; }
      function __tk(x) { return String(Math.round(x * __TPS)); }
      function __label(type, track) { return (type === 'video' ? 'V' : 'A') + (track + 1); }
      function __labels(type, tracks) { var o = []; for (var i = 0; i < tracks.length; i++) o.push(__label(type, tracks[i])); return o.join('+'); }
      // Bin marks as tick strings: a seconds number floors to the frame below (measured 11-08).
      function __place(seq, item, type, track, start, inP, dur, created, footprint) {
        var tracks = type === 'video' ? seq.videoTracks : seq.audioTracks;
        if (track >= tracks.numTracks) return { error: 'the sequence has no ' + __label(type, track) + ' to lay the new media onto' };
        var before = __mcpAllClipIds(seq), pi = null, po = null, made = [], marksOk = true;
        try { pi = String(item.getInPoint().ticks); po = String(item.getOutPoint().ticks); } catch (eP) {}
        try {
          item.setInPoint(__tk(inP), 4); item.setOutPoint(__tk(inP + dur), 4);
          tracks[track].overwriteClip(item, __T(start));
        } finally {
          // However this ends: the bin marks go back (and are read back), and whatever landed is
          // recorded, so a throw part-way cannot leave pieces nothing knows to remove.
          try {
            if (pi !== null) {
              item.setInPoint(pi, 4); item.setOutPoint(po, 4);
              if (String(item.getInPoint().ticks) !== pi || String(item.getOutPoint().ticks) !== po) marksOk = false;
            }
          } catch (eB) { marksOk = false; }
          made = __mcpNewClips(seq, before);
          for (var i = 0; i < made.length; i++) {
            created.push(String(made[i].clip.nodeId));
            footprint.push({ type: made[i].type, track: made[i].track, start: made[i].clip.start.seconds, end: made[i].clip.end.seconds });
          }
        }
        return { made: made, marksOk: marksOk };
      }
      // created: the caller's list, filled as each piece lands (not on return), so a throw
      // part-way still leaves the caller knowing every piece to remove. linkKept: link the kept
      // old clips to the new pieces (the swap; the rehearsal's pieces are temporary).
      function __layOut(seq, item, members, shift, frame, created, linkKept) {
        var footprint = [], problems = [], assigned = [], pool = [], tol = frame / 2, mi = 0, ai = -1;
        for (var a = 0; a < members.length; a++) { if (members[a].isMain) mi = a; if (ai < 0 && !members[a].keep && members[a].type === 'video') ai = a; }
        // Laid in from the picture when there is one: from an audio member, the channels would
        // start on that audio track rather than under the video.
        if (ai < 0) ai = mi;
        var A = members[ai];
        var r = __place(seq, item, A.type, A.track, A.start + shift, A.inPoint, A.end - A.start, created, footprint);
        if (r.error) return { created: created, footprint: footprint, problems: [r.error] };
        if (!r.marksOk) problems.push('the In/Out marks of the new item in the bin could not be put back as they were');
        pool = r.made.slice();
        // A kind of clip the new media does not have (a picture-only render over a clip with sync
        // sound) stays as it was and is linked to the new picture, unless it is the clip asked for.
        var has = { video: false, audio: false };
        for (var h = 0; h < r.made.length; h++) has[r.made[h].type] = true;
        for (var k0 = 0; k0 < members.length; k0++) if (!members[k0].keep && !has[members[k0].type]) {
          if (k0 === mi) problems.push('the new media has no ' + members[k0].type + ' to replace the ' + __label(members[k0].type, members[k0].track) + ' clip with');
          else { members[k0].keep = true; members[k0].keepWhy = 'the new media has no ' + members[k0].type; }
        }
        // Multichannel audio (dual mono, or more mono channels) carries no channel number a script
        // can read; only the order Premiere lays the channels out in (one per track, in order).
        // So the old channels must sit on exactly the tracks a fresh placement uses; otherwise a
        // channel could land on another channel's track and still pass every other check.
        var oldAudio = [], rebuiltAudio = 0;
        for (var oa = 0; oa < members.length; oa++) if (!members[oa].keep && members[oa].type === 'audio') { oldAudio.push(members[oa].track); rebuiltAudio++; }
        if (oldAudio.length > 1) {
          var newAudio = [];
          for (var na = 0; na < r.made.length; na++) if (r.made[na].type === 'audio') newAudio.push(r.made[na].track);
          oldAudio.sort(function (p, q) { return p - q; }); newAudio.sort(function (p, q) { return p - q; });
          if (oldAudio.join(',') !== newAudio.join(','))
            problems.push('the linked audio is ' + oldAudio.length + ' channel clips on ' + __labels('audio', oldAudio) + ', and the new media lays its channels on ' + (newAudio.length ? __labels('audio', newAudio) : 'no audio track') + ', so which channel would end up on which track cannot be checked');
        }
        function take(type, track) { for (var i = 0; i < pool.length; i++) if (pool[i] && pool[i].type === type && pool[i].track === track) { var x = pool[i]; pool[i] = null; return x; } return null; }
        for (var m = 0; m < members.length; m++) assigned[m] = members[m].keep ? null : take(members[m].type, members[m].track);
        if (!problems.length && !assigned[ai]) problems.push('the new media did not land on ' + __label(A.type, A.track));
        // A linked clip on another track than the first placement put it: lay the media in again
        // on that track (which also drops a piece of the other kind there) and keep only that one.
        for (var m2 = 0; m2 < members.length && !problems.length; m2++) if (!members[m2].keep && !assigned[m2]) {
          var mm = members[m2];
          var r2 = __place(seq, item, mm.type, mm.track, mm.start + shift, mm.inPoint, mm.end - mm.start, created, footprint);
          if (r2.error) { problems.push(r2.error); break; }
          if (!r2.marksOk) problems.push('the In/Out marks of the new item in the bin could not be put back as they were');
          var got = null;
          for (var j = 0; j < r2.made.length; j++) { if (!got && r2.made[j].type === mm.type && r2.made[j].track === mm.track) got = r2.made[j]; else pool.push(r2.made[j]); }
          if (!got) problems.push('the new media has no ' + mm.type + ' for the linked ' + mm.type + ' clip on ' + __label(mm.type, mm.track));
          assigned[m2] = got;
        }
        // Spare pieces go, and are checked gone: one left behind would sit in the edit unlinked.
        // A spare AUDIO piece while audio is being rebuilt is a channel the old clip did not use in
        // that place: dropping it would lose sound (stereo old, dual mono new) or keep the wrong mic.
        var spareAudio = [];
        for (var x2 = 0; x2 < pool.length; x2++) if (pool[x2]) {
          var spareId = String(pool[x2].clip.nodeId), spare = __label(pool[x2].type, pool[x2].track);
          if (pool[x2].type === 'audio') spareAudio.push(spare);
          try { pool[x2].clip.remove(false, false); } catch (eX) {}
          if (__mcpLocate(seq, spareId)) problems.push('a spare piece of the new media on ' + spare + ' could not be removed');
        }
        if (spareAudio.length && rebuiltAudio)
          problems.push('the new media lays out more audio channel clips than the old clip used (also ' + spareAudio.join(', ') + '), so carrying it over would drop a channel');
        if (problems.length) return { created: created, footprint: footprint, problems: problems };
        // Each piece to its own span: in point (slip), head, tail; then on/off. Read back from the
        // clip found afresh (the object written to can keep its old in point), to half a frame.
        for (var m3 = 0; m3 < members.length; m3++) {
          if (members[m3].keep) continue;
          var src = members[m3], dst = assigned[m3].clip, dstId = String(dst.nodeId);
          dst.inPoint = __T(src.inPoint); dst.start = __T(src.start + shift); dst.end = __T(src.end + shift);
          footprint.push({ type: src.type, track: src.track, start: src.start + shift, end: src.end + shift });
          var fresh = __mcpLocate(seq, dstId), rd = fresh ? fresh.clip : dst;
          if (Math.abs(rd.start.seconds - (src.start + shift)) > tol || Math.abs(rd.end.seconds - (src.end + shift)) > tol)
            problems.push(__label(src.type, src.track) + ' could not be trimmed to its old span (reads ' + rd.start.seconds + 's-' + rd.end.seconds + 's)');
          else if (Math.abs(rd.inPoint.seconds - src.inPoint) > tol)
            problems.push(__label(src.type, src.track) + ' starts at ' + rd.inPoint.seconds + 's of the new media, not ' + src.inPoint + 's as the old clip did');
          try { dst.disabled = !!src.disabled; } catch (eD) {}
          var dis = null; try { dis = !!dst.disabled; } catch (eD2) {}
          if (dis !== !!src.disabled) problems.push(__label(src.type, src.track) + ' could not be switched ' + (src.disabled ? 'off' : 'on') + ' as the old clip was');
        }
        // One link group, as before: the new pieces, plus the kept old clips in the swap.
        var linkSet = [];
        for (var m4 = 0; m4 < members.length; m4++) {
          if (!members[m4].keep) linkSet.push(assigned[m4].clip);
          else if (linkKept) { var kc = __mcpLocate(seq, members[m4].id); if (kc) linkSet.push(kc.clip); else problems.push('lost the kept ' + __label(members[m4].type, members[m4].track) + ' clip'); }
        }
        if (!problems.length && linkSet.length > 1) {
          var head = assigned[ai].clip, want = {}, n = linkSet.length;
          for (var w0 = 0; w0 < linkSet.length; w0++) want[String(linkSet[w0].nodeId)] = true;
          function linkedOk() { var li = null; try { li = head.getLinkedItems(); } catch (eL) {} if (!li || li.numItems !== n) return false; for (var k = 0; k < li.numItems; k++) if (!want[String(li[k].nodeId)]) return false; return true; }
          if (!linkedOk()) {
            var prevSel = []; try { var ps = seq.getSelection(); for (var p0 = 0; ps && p0 < ps.length; p0++) prevSel.push(ps[p0]); } catch (eS) {}
            // One try per item: a single clip that refuses selection must not leave the rest of
            // the user's selection dropped, or the new pieces selected.
            for (var p1 = 0; p1 < prevSel.length; p1++) { try { prevSel[p1].setSelected(false, false); } catch (eS1) {} }
            for (var m5 = 0; m5 < linkSet.length; m5++) { try { linkSet[m5].setSelected(true, false); } catch (eS3) {} }
            try { seq.linkSelection(); } catch (eLk) {}
            for (var m6 = 0; m6 < linkSet.length; m6++) { try { linkSet[m6].setSelected(false, false); } catch (eS4) {} }
            for (var p2 = 0; p2 < prevSel.length; p2++) { try { prevSel[p2].setSelected(true, false); } catch (eS2) {} }
            if (!linkedOk()) problems.push('the pieces could not be linked as the old clip and its linked clips were (often the audio channels differ, e.g. dual-mono on the old clip and stereo on the new media)');
          }
        }
        var group = [];
        for (var m7 = 0; m7 < members.length; m7++) group.push(members[m7].keep ? null : __mcpLocate(seq, String(assigned[m7].clip.nodeId)));
        return { created: created, footprint: footprint, problems: problems, group: group };
      }
      function __carry(seq, qs, from, to) {
        var out = { problems: [], keyed: false };
        for (var m = 0; m < from.length; m++) {
          var src = from[m], dst = to[m];
          if (src.keep) continue;
          if (!dst) { out.problems.push('lost track of the new ' + __label(src.type, src.track)); continue; }
          // Effects the new clip lacks, added in the old clip's order (QE appends).
          var seen = {}, qc = null;
          for (var w = 0; w < src.snap.length; w++) {
            var mt = src.snap[w].match, nth = seen[mt] || 0; seen[mt] = nth + 1;
            if (__mcpCompIndex(dst.clip, mt, nth) >= 0) continue;
            if (src.type === 'audio') { var why = __crashProneAudioFx(dst.clip, src.snap[w].name); if (why) { out.problems.push(why); continue; } }
            if (!qc) qc = qs ? __qeClipByIndex(qs, dst.type, dst.track, dst.index) : null;
            var fx = dst.type === 'video' ? qe.project.getVideoEffectByName(src.snap[w].name) : qe.project.getAudioEffectByName(src.snap[w].name);
            try { if (qc && fx) { if (dst.type === 'video') qc.addVideoEffect(fx); else qc.addAudioEffect(fx); } } catch (eA) {}
          }
          var oldOrder = [], newOrder = __mcpComponentOrder(dst.clip);
          for (var o1 = 0; o1 < src.snap.length; o1++) oldOrder.push(src.snap[o1].match);
          if (oldOrder.join('|') !== newOrder.join('|')) out.problems.push(__label(src.type, src.track) + ' effects came out in a different order or set (' + newOrder.length + ' vs ' + oldOrder.length + ')');
          for (var s = 0; s < src.snap.length; s++) for (var p = 0; p < src.snap[s].props.length; p++) if (src.snap[s].props[p].tv) out.keyed = true;
          __mcpApplySnap(dst.clip, src.snap);
          var diffs = __mcpDiffSnap(dst.clip, src.snap);
          for (var d = 0; d < diffs.length && d < 8; d++) {
            var df = diffs[d];
            out.problems.push(df.missing ? df.comp + ' could not be added to the new ' + __label(src.type, src.track)
              : __label(src.type, src.track) + ' ' + df.comp + ' setting ' + df.index + (df.want !== undefined ? ' reads ' + String(df.got) + ' instead of ' + String(df.want) : ' (keyframes) did not carry'));
          }
          if (diffs.length > 8) out.problems.push((diffs.length - 8) + ' more settings did not carry');
        }
        return out;
      }
      function __removeIds(seq, ids) {
        for (var i = 0; i < ids.length; i++) { var f = __mcpLocate(seq, ids[i]); if (f) { try { f.clip.remove(false, false); } catch (eR) {} } }
        var left = [];
        for (var j = 0; j < ids.length; j++) if (__mcpLocate(seq, ids[j])) left.push(ids[j]);
        return left;
      }
      // Clips in the edit that the rebuild would overwrite: every span it writes (slot time),
      // against every clip that is not one of the old pieces being replaced.
      function __blockedBy(seq, footprint, replacing) {
        var blocked = {}, out = [];
        for (var f = 0; f < footprint.length; f++) {
          var fp = footprint[f];
          var tk = (fp.type === 'video' ? seq.videoTracks : seq.audioTracks)[fp.track];
          for (var ci = 0; tk && ci < tk.clips.numItems; ci++) {
            var xc = tk.clips[ci];
            if (replacing[String(xc.nodeId)]) continue;
            if (xc.start.seconds < fp.end - 0.001 && xc.end.seconds > fp.start + 0.001) blocked[__label(fp.type, fp.track) + ' "' + xc.name + '"'] = true;
          }
        }
        for (var bk in blocked) out.push(bk);
        return out;
      }
    `;

    // 1. Read the old group, rehearse the whole layout past the end of the edit, check the slot.
    const prep: any = await this.bridge.executeScript(`
      ${lib}
      var createdIds = [], seqRef = null;
      try {
        var info = __findClip(${q(clipId)});
        if (!info) return JSON.stringify({ success: false, changed: false, error: "Clip not found" });
        var newItem = __findProjectItem(${q(newProjectItemId)});
        if (!newItem) return JSON.stringify({ success: false, changed: false, error: "New project item not found" });
        var c = info.clip, seq = info.sequence; seqRef = seq;
        var frame = 1 / 24; try { var fr = Number(seq.getSettings().videoFrameRate.seconds); if (fr > 0) frame = fr; } catch (eF) {}
        var o = { success: true, seq: String(seq.sequenceID), oldIds: [], members: [], transitions: [], frame: frame };
        var og = __mcpClipGroup(seq, c), unreadable = [], mainItem = null, allTrans = [];
        try { mainItem = String(c.projectItem.nodeId); } catch (eMI) {}
        if (mainItem === null) return JSON.stringify({ success: false, changed: false, error: 'The clip has no readable source item, so what it would be replaced from cannot be told. Nothing was changed.' });
        for (var g = 0; g < og.length; g++) {
          var oc = og[g].clip, dis = false, ocItem = null, ocName = '';
          try { ocItem = String(oc.projectItem.nodeId); ocName = String(oc.projectItem.name); } catch (eOI) {}
          // A linked clip from OTHER media (dual-system sound synced to the picture) is not
          // rebuilt from the new media: it stays where it is and is linked to the new pieces.
          var foreign = ocItem !== mainItem;
          if (!foreign) {
            var speed = 1, rev = false;
            // Every piece, not just the clicked one: a linked clip at another speed would be
            // rebuilt at speed 1 and drift out of sync.
            try { speed = Number(oc.getSpeed()); } catch (eS) {}
            try { rev = !!oc.isSpeedReversed(); } catch (eR) {}
            if (Math.abs(speed - 1) > 0.0001 || rev) return JSON.stringify({ success: false, changed: false, error: (og.length > 1 ? 'The ' + __label(og[g].type, og[g].track) + ' piece of the clip' : 'The clip') + ' is speed-changed or reversed, so its source range cannot be reproduced on the new media. Nothing was changed. Pass preserveEffects:false to drop in the new media at its own length.' });
          }
          var snap = foreign ? [] : __mcpSnapClip(oc);
          try { dis = !!oc.disabled; } catch (eD) {}
          for (var u = 0; u < snap.length; u++) for (var up = 0; up < snap[u].props.length; up++) if (!snap[u].props[up].ok) unreadable.push(__label(og[g].type, og[g].track) + ' ' + snap[u].name + ' setting ' + up);
          o.oldIds.push(String(oc.nodeId));
          o.members.push({ id: String(oc.nodeId), type: og[g].type, track: og[g].track, start: oc.start.seconds, end: oc.end.seconds, inPoint: oc.inPoint.seconds, disabled: dis, isMain: String(oc.nodeId) === String(c.nodeId), snap: snap,
            keep: foreign, keepWhy: foreign ? 'it comes from other media ("' + ocName + '")' : '' });
          var tr = __mcpEdgeTransitions(seq, og[g].type, og[g].track, oc.start.seconds, oc.end.seconds, frame / 2);
          for (var ti = 0; ti < tr.length; ti++) { tr[ti].member = g; allTrans.push(tr[ti]); }
        }
        if (unreadable.length) return JSON.stringify({ success: false, changed: false, error: 'These settings cannot be read on the old clip, so they could not be carried or checked: ' + unreadable.slice(0, 5).join('; ') + (unreadable.length > 5 ? '; and ' + (unreadable.length - 5) + ' more' : '') + '. Nothing was changed.' });
        // DeNoise/DeReverb onto a sequence crashes Premiere: refuse before anything is placed.
        for (var gg = 0; gg < o.members.length; gg++) if (o.members[gg].type === 'audio') for (var ce = 0; ce < o.members[gg].snap.length; ce++) {
          var why0 = __crashProneAudioFx({ projectItem: newItem }, o.members[gg].snap[ce].name);
          if (why0) return JSON.stringify({ success: false, verified: true, changed: false, refusedToAvoidCrash: true, error: 'The clip carries ' + o.members[gg].snap[ce].name + ', which would be carried onto the new media. ' + why0 + ' Remove that effect first, or swap with preserveEffects:false.' });
        }
        // Rehearse past everything on every track. The shift is whole frames, so pieces of the
        // old group (on the frame grid) stay on it: a whole second is not a frame boundary at
        // 23.976 or 29.97, and a piece snapped to a frame would fail the span check.
        var far = 0, first = Infinity;
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) { var tv = seq.videoTracks[vt]; if (tv.clips.numItems) far = Math.max(far, tv.clips[tv.clips.numItems - 1].end.seconds); }
        for (var at = 0; at < seq.audioTracks.numTracks; at++) { var ta = seq.audioTracks[at]; if (ta.clips.numItems) far = Math.max(far, ta.clips[ta.clips.numItems - 1].end.seconds); }
        for (var fm = 0; fm < o.members.length; fm++) first = Math.min(first, o.members[fm].start);
        var shift = Math.ceil((far + 10 - first) / frame) * frame;
        o.stagedAt = first + shift;
        app.enableQE();
        var qs = __qeSequenceOpening(seq);
        var lay = __layOut(seq, newItem, o.members, shift, frame, createdIds, false);
        var problems = lay.problems.slice();
        if (!problems.length) { var reh = __carry(seq, qs, o.members, lay.group); problems = reh.problems; o.keyed = reh.keyed; }
        var leftR = __removeIds(seq, createdIds);
        if (problems.length) return JSON.stringify({ success: false, changed: leftR.length > 0, problems: problems, error: 'Rebuilding the clip on the new media did not match (' + problems.slice(0, 3).join('; ') + (problems.length > 3 ? '; and ' + (problems.length - 3) + ' more' : '') + '), so the swap was stopped before the old clip was touched.' + (leftR.length ? ' ' + leftR.length + ' temporary piece(s) are still on the timeline from ' + o.stagedAt + 's; delete them.' : ' Nothing was changed.') });
        if (leftR.length) return JSON.stringify({ success: false, changed: true, error: 'The rehearsal matched, but ' + leftR.length + ' temporary piece(s) past the end of the edit (from ' + o.stagedAt + 's) could not be removed; delete them. The old clip was not touched.' });
        // What the rehearsal settled: which pieces are rebuilt, and only their transitions count
        // (a kept clip keeps its own).
        for (var tc = 0; tc < allTrans.length; tc++) if (!o.members[allTrans[tc].member].keep) o.transitions.push(allTrans[tc]);
        for (var tc2 = 0; tc2 < o.transitions.length; tc2++) if (o.transitions[tc2].align === null) {
          var bad = o.transitions[tc2];
          return JSON.stringify({ success: false, changed: false, error: 'The ' + bad.name + ' on the ' + bad.edge + ' of ' + __label(o.members[bad.member].type, o.members[bad.member].track) + ' is centred on the cut, and Premiere\\'s scripting can only place a transition starting or ending at a cut, so it could not be put back. Nothing was changed. Swap by hand, or re-place that transition first.' });
        }
        // Long enough, from its real length (a clip laid past the end of its media reads back as asked).
        var needSecs = 0;
        for (var ln = 0; ln < o.members.length; ln++) if (!o.members[ln].keep) needSecs = Math.max(needSecs, o.members[ln].inPoint + (o.members[ln].end - o.members[ln].start));
        var haveSecs = __mcpMediaSecs(newItem), isStill = false;
        try { isStill = /Still Image/.test(String(newItem.getProjectMetadata())); } catch (eSt) {}
        if (haveSecs === null && !isStill) return JSON.stringify({ success: false, changed: false, error: 'Premiere does not report how long the new media is, so it cannot be checked that it covers the old clip. Nothing was changed.' });
        if (haveSecs !== null && needSecs > haveSecs + frame / 2) return JSON.stringify({ success: false, changed: false, error: 'The new media is ' + haveSecs + 's long, and the old clip and its linked clips use its source up to ' + needSecs + 's, so it does not cover them. Nothing was changed.' });
        // In the old slot, every span the rebuild writes must be free apart from the pieces it
        // replaces (a kept clip is in the way like any other).
        o.footprint = [];
        for (var f = 0; f < lay.footprint.length; f++) o.footprint.push({ type: lay.footprint[f].type, track: lay.footprint[f].track, start: lay.footprint[f].start - shift, end: lay.footprint[f].end - shift });
        var replacing = {}; for (var oi = 0; oi < o.members.length; oi++) if (!o.members[oi].keep) replacing[o.members[oi].id] = true;
        var bl = __blockedBy(seq, o.footprint, replacing);
        if (bl.length) return JSON.stringify({ success: false, changed: false, error: 'Rebuilding the clip in its old slot would overwrite ' + bl.join(', ') + ' (Premiere lays every track of the new media in at once), so the swap was stopped before the old clip was touched. Nothing was changed.' });
        return JSON.stringify(o);
      } catch (e) {
        var leftE = []; try { if (createdIds.length && seqRef) leftE = __removeIds(seqRef, createdIds); } catch (eX) {}
        return JSON.stringify({ success: false, changed: leftE.length > 0, error: e.toString() + (createdIds.length ? (leftE.length ? ' Temporary pieces are still on the timeline past the end of the edit; delete them.' : ' The temporary pieces were removed; the old clip was not touched.') : '') });
      }
    `);
    if (!prep?.success) return prep;

    // 2. The swap. The state before it is recorded, so any mismatch undoes it back to exactly that.
    const swap: any = await this.bridge.executeScript(`
      ${STATE_HELPERS}
      ${lib}
      var touched = false;
      try {
        var seq = __findSequence(${q(prep.seq)});
        var newItem = __findProjectItem(${q(newProjectItemId)});
        if (!seq || !newItem || !__mcpLocate(seq, ${q(clipId)})) return JSON.stringify({ success: false, changed: false, error: "Lost the old clip or the new item before the swap. Nothing was changed." });
        var members = ${q(prep.members)}, trans = ${q(prep.transitions)}, frame = ${q(prep.frame)}, footprint = ${q(prep.footprint)};
        // Everything the rehearsal checked must still hold: an edit made in between (by hand, or
        // by another call) would otherwise be rebuilt from stale spans or settings, or overwritten.
        var replacing = {};
        for (var v = 0; v < members.length; v++) {
          var now0 = __mcpLocate(seq, members[v].id), want0 = members[v];
          if (!now0 || now0.type !== want0.type || now0.track !== want0.track || Math.abs(now0.clip.start.seconds - want0.start) > frame / 2 || Math.abs(now0.clip.end.seconds - want0.end) > frame / 2 || Math.abs(now0.clip.inPoint.seconds - want0.inPoint) > frame / 2)
            return JSON.stringify({ success: false, changed: false, error: 'The ' + __label(want0.type, want0.track) + ' clip ' + (now0 ? 'moved or was trimmed' : 'is gone') + ' since it was checked, so the swap was stopped before anything was touched. Nothing was changed. Run replace_clip again.' });
          if (!want0.keep) {
            replacing[want0.id] = true;
            if (__mcpDiffSnap(now0.clip, want0.snap).length) return JSON.stringify({ success: false, changed: false, error: 'The effects or settings on ' + __label(want0.type, want0.track) + ' changed since they were checked, so the swap was stopped before anything was touched. Nothing was changed. Run replace_clip again.' });
          }
        }
        var bl = __blockedBy(seq, footprint, replacing);
        if (bl.length) return JSON.stringify({ success: false, changed: false, error: 'Since it was checked, ' + bl.join(', ') + ' landed where the new media goes, so the swap was stopped before anything was touched. Nothing was changed.' });
        var beforeHash = __tlState(seq, false).hash, created = [];
        touched = true;
        for (var r = 0; r < members.length; r++) if (!members[r].keep) { var f = __mcpLocate(seq, members[r].id); if (f) f.clip.remove(false, false); }
        app.enableQE();
        var qs = __qeSequenceOpening(seq);
        var lay = __layOut(seq, newItem, members, 0, frame, created, true);
        var problems = lay.problems.slice(), keyed = false;
        if (!problems.length) { var res = __carry(seq, qs, members, lay.group); problems = res.problems; keyed = res.keyed; }
        // Edge transitions, re-added on the new pieces and read back.
        if (!problems.length) for (var t = 0; t < trans.length; t++) {
          var tr = trans[t], piece = lay.group[tr.member];
          if (!piece) { problems.push('lost the piece for the ' + tr.name); continue; }
          var qc = qs ? __qeClipByIndex(qs, piece.type, piece.track, piece.index) : null;
          var tx = piece.type === 'video' ? qe.project.getVideoTransitionByName(tr.name) : qe.project.getAudioTransitionByName(tr.name);
          var frames = String(Math.round((tr.end - tr.start) / frame));
          try { if (qc && tx) qc.addTransition(tx, tr.edge === 'head', frames, '0', tr.align, true, true); } catch (eT) {}
          var back = __mcpEdgeTransitions(seq, piece.type, piece.track, members[tr.member].start, members[tr.member].end, frame / 2), hit = false;
          for (var b = 0; b < back.length; b++) if (back[b].edge === tr.edge && back[b].matchName === tr.matchName && Math.abs(back[b].start - tr.start) <= frame && Math.abs(back[b].end - tr.end) <= frame) hit = true;
          if (!hit) problems.push('the ' + tr.name + ' on the ' + tr.edge + ' of ' + __label(piece.type, piece.track) + ' could not be put back as it was');
        }
        // Exactly the old edge transitions, no more: one that survived the removal and was added
        // again would otherwise pass the check above as a duplicate.
        if (!problems.length) for (var mb = 0; mb < members.length; mb++) {
          if (members[mb].keep) continue;
          var pc = lay.group[mb], want = 0;
          for (var t2 = 0; t2 < trans.length; t2++) if (trans[t2].member === mb) want++;
          var now = pc ? __mcpEdgeTransitions(seq, pc.type, pc.track, members[mb].start, members[mb].end, frame / 2) : [];
          if (now.length !== want) problems.push(__label(members[mb].type, members[mb].track) + ' has ' + now.length + ' edge transition(s) after the swap, not ' + want);
        }
        if (problems.length) return JSON.stringify({ success: false, revert: true, touched: true, beforeHash: beforeHash, problems: problems });
        var main = null, kept = [];
        for (var m = 0; m < members.length; m++) {
          if (members[m].keep) kept.push(__label(members[m].type, members[m].track) + ' (' + members[m].keepWhy + ')');
          else if (!main || members[m].isMain) main = lay.group[m];
        }
        return JSON.stringify({ success: true, verified: true,
          verifiedBy: 'every setting and keyframe of the clip and its linked clips compared by position with the original, plus each piece\\'s track, start, end, in point and on/off, effect order, edge transitions and the link group',
          clipId: String(main.clip.nodeId), start: main.clip.start.seconds, end: main.clip.end.seconds, inPoint: main.clip.inPoint.seconds,
          linkedCarried: members.length - 1 - kept.length, linkedKept: kept.length, transitionsCarried: trans.length,
          note: 'The swapped clip has a new clip id; use clipId from this result.'
            + (kept.length ? ' Kept as they were and linked to the new media: ' + kept.join(', ') + '.' : '')
            + (keyed ? ' Keyframes were carried by time and value; their interpolation (ease) cannot be read by script, so it is back to the default.' : '')
            + (trans.length ? ' Transitions were put back with their type, length and alignment; their own settings (for example Dip to Color\\'s colour or Push\\'s direction) cannot be read by script, so they are back to the defaults.' : '') });
      } catch (e) { return JSON.stringify({ success: false, revert: true, touched: touched, beforeHash: typeof beforeHash === 'string' ? beforeHash : null, problems: [e.toString()] }); }
    `);
    if (!swap?.revert) return swap;

    // 3. Something did not carry: undo back to exactly the state before the swap.
    const problems: string[] = swap.problems ?? [];
    if (swap.touched === false) {
      return {
        success: false,
        changed: false,
        problems,
        error: `The swap stopped (${problems.slice(0, 3).join('; ')}) before the old clip was touched. Nothing was changed.`,
      };
    }
    if (!swap.beforeHash) {
      return {
        success: false,
        changed: true,
        problems,
        error: `The swap failed (${problems.slice(0, 3).join('; ')}) before its starting state could be recorded. Undo in Premiere restores the old clip.`,
      };
    }
    const back: any = await this.bridge.executeScript(revertScript(prep.seq, swap.beforeHash, 400));
    // Zero undo steps after a swap that removed and placed clips means the state check could not
    // see the change, not that nothing changed (it used to report changed:false with the new
    // media still in the edit). The swap always takes at least one step to undo.
    if (back?.success && Number(back.undoSteps) === 0) {
      return {
        success: false,
        changed: true,
        problems,
        error: `The swap did not carry everything (${problems.slice(0, 3).join('; ')}), and the sequence already reads as it did before the swap, so whether it was undone cannot be told. Check the clip in Premiere; Undo there restores the old clip.`,
      };
    }
    if (back?.success) {
      return {
        success: false,
        changed: false,
        verified: true,
        verifiedBy: 'sequence state hash back to the one recorded just before the swap',
        problems,
        undoSteps: back.undoSteps,
        error: `The swap did not carry everything (${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}), so it was undone back to exactly how the sequence was. Nothing was changed.`,
      };
    }
    return {
      success: false,
      changed: true,
      problems,
      error: `The swap did not carry everything (${problems.slice(0, 3).join('; ')}), and undoing it did not get back to the state before (${back?.error ?? `${back?.undoSteps ?? '?'} steps`}). Check the clip in Premiere; Undo there restores the old clip.`,
    };
  }

  async nestAllV1Clips(newSeqName: string, seqId?: string): Promise<any> {
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

  /**
   * Replace every timeline clip that uses one project item with another, one verified
   * replace_clip per clip, so each keeps its trim, effects, keyframes and linked audio.
   *
   * It used to remove each clip and lay the new item in at full length: trims, grades and levels
   * were all lost, the full-length media could run over the next shot, and the count of clips
   * replaced was reported as success. Clips are found on video tracks, and a target whose swap
   * is refused is left exactly as it was (replace_clip changes nothing when it stops).
   */
  async batchReplaceClips(oldItemId: string, newItemId: string, seqId?: string): Promise<any> {
    const q = JSON.stringify;
    const pickSeqs = seqId
      ? `var one = __findSequence(${q(seqId)}); if (!one) return JSON.stringify({ success: false, error: 'Sequence not found' }); seqs.push(one);`
      : 'for (var si = 0; si < app.project.sequences.numSequences; si++) seqs.push(app.project.sequences[si]);';
    const found: any = await this.bridge.executeScript(`
      try {
        var newItem = __findProjectItem(${q(newItemId)});
        if (!newItem) return JSON.stringify({ success: false, error: 'New item not found: ' + ${q(newItemId)} });
        var oldItem = __findProjectItem(${q(oldItemId)});
        if (!oldItem) return JSON.stringify({ success: false, verified: true, error: 'The item to replace is not in this project: ' + ${q(oldItemId)} + '. Nothing was changed. Find the right nodeId with find_project_item_by_name.' });
        if (String(oldItem.nodeId) === String(newItem.nodeId)) return JSON.stringify({ success: false, verified: true, error: 'oldProjectItemId and newProjectItemId are the same item, so there is nothing to replace.' });
        var seqs = [];
        ${pickSeqs}
        // One target per linked group: video clips first; an audio clip counts only when it is
        // not linked to a video use already listed (an audio-only use of the item).
        var targets = [];
        for (var s = 0; s < seqs.length; s++) {
          var taken = {};
          var vt = seqs[s].videoTracks;
          for (var t = 0; t < vt.numTracks; t++) for (var c = 0; c < vt[t].clips.numItems; c++) {
            var cl = vt[t].clips[c], same = false;
            try { same = String(cl.projectItem.nodeId) === String(oldItem.nodeId); } catch (eP) {}
            // A second video clip linked to one already listed is swapped with it, not again.
            if (!same || taken[String(cl.nodeId)]) continue;
            targets.push({ clipId: String(cl.nodeId), sequenceName: String(seqs[s].name), track: 'V' + (t + 1), start: cl.start.seconds });
            try { var li = cl.getLinkedItems(); for (var l = 0; li && l < li.numItems; l++) taken[String(li[l].nodeId)] = true; } catch (eL) {}
          }
          var at = seqs[s].audioTracks;
          for (var ta = 0; ta < at.numTracks; ta++) for (var ca = 0; ca < at[ta].clips.numItems; ca++) {
            var ac = at[ta].clips[ca], sameA = false;
            try { sameA = String(ac.projectItem.nodeId) === String(oldItem.nodeId); } catch (eA) {}
            if (!sameA || taken[String(ac.nodeId)]) continue;
            targets.push({ clipId: String(ac.nodeId), sequenceName: String(seqs[s].name), track: 'A' + (ta + 1), start: ac.start.seconds });
            try { var la = ac.getLinkedItems(); for (var l2 = 0; la && l2 < la.numItems; l2++) taken[String(la[l2].nodeId)] = true; } catch (eL2) {}
          }
        }
        return JSON.stringify({ success: true, oldName: String(oldItem.name), targets: targets });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!found?.success) return found;
    const targets: any[] = found.targets ?? [];
    if (!targets.length) {
      return {
        success: false,
        verified: true,
        verifiedBy: 'walked every video and audio track comparing clip.projectItem.nodeId',
        replaced: 0,
        targetsFound: 0,
        error: `The item "${found.oldName}" is in the project but is not used on any track of ${seqId ? 'the requested sequence' : 'any sequence'}, so nothing was replaced.`,
      };
    }
    const results: any[] = [];
    for (const t of targets) {
      const r: any = await this.replaceClip(t.clipId, newItemId, true);
      results.push({
        sequenceName: t.sequenceName,
        track: t.track,
        start: t.start,
        success: r?.success === true,
        clipId: r?.clipId,
        changed: r?.success === true ? true : r?.changed,
        error: r?.success === true ? undefined : r?.error,
      });
    }
    const replaced = results.filter((r) => r.success).length;
    const asWas = results.filter((r) => !r.success && r.changed === false).length;
    const partway = targets.length - replaced - asWas;
    return {
      success: replaced === targets.length,
      verified: true,
      verifiedBy:
        'each clip swapped by replace_clip: every setting, keyframe and linked clip compared by position',
      replaced,
      targetsFound: targets.length,
      results,
      error:
        replaced === targets.length
          ? undefined
          : `${replaced} of ${targets.length} clips were replaced; ${asWas} were left exactly as they were${partway ? `, and ${partway} may be part-way (see results; Undo restores them)` : ''}.`,
    };
  }
}
