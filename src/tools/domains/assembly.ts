/**
 * AssemblyTools -- the Assembly Editing tool domain.
 *
 * A plain class on ToolsBase. PremiereProTools holds one instance and dispatches tool calls
 * to it by name; other domains it relies on are reached through `this.peers`.
 */
import { ToolsBase } from './base.js';
import { TRIM_LIB } from '../trim-lib.js';
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
   * Swap the media under one timeline clip and keep everything an editor set on it.
   *
   * preserveEffects (the default): every setting on the clip and on the clips linked to it (its
   * audio or video) is read by POSITION, with keyframes, and the swap is rehearsed on a
   * temporary copy of the new media past the end of the edit: the missing effects are added,
   * the settings written, and the copy compared with the original. Only when the rehearsal
   * matches exactly, the source range fits, and the new media would overwrite nothing else, is
   * the old clip (with its linked items) removed, the new media laid into the old slot with the
   * old source range, and the same settings written and compared again. Any mismatch before the
   * swap stops it with nothing changed; a mismatch after it is reported, and the temporary copy
   * that still holds the settings is kept.
   *
   * By position, not by name: Lumetri repeats setting names (four "Saturation", two each of
   * Temperature, Tint and Contrast), and the old by-name copy wrote one over another while
   * reporting success. Keyframe interpolation has no scripting read, so it is not carried; the
   * result says so when there are keyframes. Nothing is slid across other clips: TrackItem.move()
   * scrambled Premiere's track order on 26.5.2 and later clips rendered black.
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
          if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
          var newItem = __findProjectItem(${q(newProjectItemId)});
          if (!newItem) return JSON.stringify({ success: false, error: "New project item not found" });
          var t = new Time(); t.seconds = info.clip.start.seconds;
          info.clip.remove(false, true);
          info.track.overwriteClip(newItem, t);
          return JSON.stringify({ success: true, verified: false, preserveEffects: false, note: "Placed at its own length; trims and effects were not carried over." });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
    }

    // Shared by both scripts: give a group of clips the effects and settings of another group.
    // Pairs members by kind and track order; adds effects a member lacks by name through QE and
    // checks they landed (QE add can be inert); then writes and compares the settings.
    const carry = `
      function __carry(seq, qs, from, to) {
        var out = { problems: [], keyed: false };
        for (var m = 0; m < from.length; m++) {
          var src = from[m], dst = to[m];
          if (!dst) { out.problems.push('the new media has no ' + src.type + ' to carry the linked ' + src.type + ' clip on track ' + (src.track + 1) + ' onto'); continue; }
          var have = {};
          for (var h = 0; h < dst.clip.components.numItems; h++) { var hm = String(dst.clip.components[h].matchName); have[hm] = (have[hm] || 0) + 1; }
          var want = {}, names = {};
          for (var w = 0; w < src.snap.length; w++) { want[src.snap[w].match] = (want[src.snap[w].match] || 0) + 1; names[src.snap[w].match] = src.snap[w].name; }
          var qc = null;
          for (var mt in want) {
            var lacking = want[mt] - (have[mt] || 0);
            for (var n = 0; n < lacking; n++) {
              if (src.type === 'audio') { var why = __crashProneAudioFx(dst.clip, names[mt]); if (why) { out.problems.push(why); continue; } }
              if (!qc) qc = qs ? __qeClipByIndex(qs, dst.type, dst.track, dst.index) : null;
              var fx = dst.type === 'video' ? qe.project.getVideoEffectByName(names[mt]) : qe.project.getAudioEffectByName(names[mt]);
              try { if (qc && fx) { if (dst.type === 'video') qc.addVideoEffect(fx); else qc.addAudioEffect(fx); } } catch (eA) {}
            }
          }
          for (var s = 0; s < src.snap.length; s++) for (var p = 0; p < src.snap[s].props.length; p++) if (src.snap[s].props[p].tv) out.keyed = true;
          var errs = __mcpApplySnap(dst.clip, src.snap);
          var diffs = __mcpDiffSnap(dst.clip, src.snap);
          for (var d = 0; d < diffs.length && d < 8; d++) {
            var df = diffs[d];
            out.problems.push(df.missing ? df.comp + ' could not be added to the new ' + src.type
              : df.comp + ' setting ' + df.index + (df.want !== undefined ? ' reads ' + String(df.got) + ' instead of ' + String(df.want) : ' (keyframes) did not carry'));
          }
          if (diffs.length > 8) out.problems.push((diffs.length - 8) + ' more settings did not carry');
          if (errs.length && !diffs.length) out.writeErrors = errs.length;
        }
        return out;
      }
      function __removeGroup(seq, ids) {
        var left = [];
        for (var i = 0; i < ids.length; i++) { var f = __findClip(ids[i], String(seq.sequenceID)); if (f) { try { f.clip.remove(false, false); } catch (eR) {} } }
        for (var j = 0; j < ids.length; j++) if (__findClip(ids[j], String(seq.sequenceID))) left.push(ids[j]);
        return left;
      }
    `;

    // 1. Read the old clip, rehearse the swap on a temporary copy, and stop on anything wrong.
    const prep: any = await this.bridge.executeScript(`
      ${carry}
      var stagedIds = [];
      try {
        var info = __findClip(${q(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var newItem = __findProjectItem(${q(newProjectItemId)});
        if (!newItem) return JSON.stringify({ success: false, error: "New project item not found" });
        var c = info.clip, seq = info.sequence, track = info.track;
        var speed = 1, rev = false;
        try { speed = Number(c.getSpeed()); } catch (eS) {}
        try { rev = !!c.isSpeedReversed(); } catch (eR) {}
        if (Math.abs(speed - 1) > 0.0001 || rev) return JSON.stringify({ success: false, changed: false, error: "The clip is speed-changed or reversed, so its source range cannot be reproduced on the new media. Nothing was changed. Pass preserveEffects:false to drop in the new media at its own length." });
        var o = { success: true, seq: String(seq.sequenceID), video: info.trackType === 'video', track: info.trackIndex,
          start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds, oldIds: [], group: [] };
        var oldGroup = __mcpClipGroup(seq, c);
        for (var g = 0; g < oldGroup.length; g++) {
          o.oldIds.push(String(oldGroup[g].clip.nodeId));
          o.group.push({ type: oldGroup[g].type, track: oldGroup[g].track, isMain: String(oldGroup[g].clip.nodeId) === String(c.nodeId), snap: __mcpSnapClip(oldGroup[g].clip) });
        }
        // Refuse before anything is staged: DeNoise/DeReverb onto a sequence crashes Premiere.
        for (var gg = 0; gg < o.group.length; gg++) if (o.group[gg].type === 'audio') {
          for (var ce = 0; ce < o.group[gg].snap.length; ce++) {
            var why0 = __crashProneAudioFx({ projectItem: newItem }, o.group[gg].snap[ce].name);
            if (why0) return JSON.stringify({ success: false, verified: true, changed: false, refusedToAvoidCrash: true, error: 'The clip carries ' + o.group[gg].snap[ce].name + ', which would be carried onto the new media. ' + why0 + ' Remove that effect first, or swap with preserveEffects:false.' });
          }
        }
        // The new media must be long enough for the old source range. Checked against its real
        // length: Premiere lays a clip in past the end of short media and reads it back as asked.
        var __haveSecs = __mcpMediaSecs(newItem), __needSecs = o.inPoint + (o.end - o.start);
        if (__haveSecs !== null && __needSecs > __haveSecs + 0.05) return JSON.stringify({ success: false, changed: false, error: 'The new media is ' + __haveSecs + 's long, and the old clip uses its source from ' + o.inPoint + 's to ' + __needSecs + 's, so it does not cover the source range of the old clip. Nothing was changed.' });
        // Stage past everything on every track, so the rehearsal overlaps nothing.
        var far = 0;
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) { var tv = seq.videoTracks[vt]; if (tv.clips.numItems) far = Math.max(far, tv.clips[tv.clips.numItems - 1].end.seconds); }
        for (var at = 0; at < seq.audioTracks.numTracks; at++) { var ta = seq.audioTracks[at]; if (ta.clips.numItems) far = Math.max(far, ta.clips[ta.clips.numItems - 1].end.seconds); }
        far = Math.ceil(far) + 10;
        o.stagedStart = far;
        var prevIn = null, prevOut = null;
        try { prevIn = newItem.getInPoint().seconds; prevOut = newItem.getOutPoint().seconds; } catch (eP) {}
        newItem.setInPoint(o.inPoint, 4);
        newItem.setOutPoint(o.inPoint + (o.end - o.start), 4);
        var when = new Time(); when.seconds = far;
        track.overwriteClip(newItem, when);
        try { if (prevIn !== null) { newItem.setInPoint(prevIn, 4); newItem.setOutPoint(prevOut, 4); } } catch (eB) {}
        var staged = null;
        for (var s2 = 0; s2 < track.clips.numItems; s2++) { var tc = track.clips[s2]; if (Math.abs(tc.start.seconds - far) < 0.02) { staged = tc; break; } }
        if (!staged) return JSON.stringify({ success: false, changed: false, error: "Could not place the new media to rehearse the swap (locked or untargeted track?). Nothing was changed." });
        var sg = __mcpClipGroup(seq, staged);
        for (var si = 0; si < sg.length; si++) stagedIds.push(String(sg[si].clip.nodeId));
        // The new media must cover the old source range.
        if (Math.abs(staged.inPoint.seconds - o.inPoint) > 0.02 || Math.abs((staged.end.seconds - staged.start.seconds) - (o.end - o.start)) > 0.02) {
          var leftR = __removeGroup(seq, stagedIds);
          return JSON.stringify({ success: false, changed: leftR.length > 0, error: 'The new media does not cover the old clip\\'s source range (' + o.inPoint + 's for ' + (o.end - o.start) + 's; it gives ' + staged.inPoint.seconds + 's for ' + (staged.end.seconds - staged.start.seconds) + 's), so the swap was stopped before the old clip was touched.' + (leftR.length ? ' A temporary copy is still on the track from ' + far + 's; delete it.' : ' Nothing was changed.') });
        }
        // In the old slot, the new media must not overwrite anything but the old clip's own group.
        var oldSet = {}; for (var oi = 0; oi < o.oldIds.length; oi++) oldSet[o.oldIds[oi]] = true;
        var blocked = [];
        for (var bi = 0; bi < sg.length; bi++) {
          var tracks = sg[bi].type === 'video' ? seq.videoTracks : seq.audioTracks, tk = tracks[sg[bi].track];
          for (var ci = 0; ci < tk.clips.numItems; ci++) {
            var oc = tk.clips[ci];
            if (oldSet[String(oc.nodeId)]) continue;
            if (oc.start.seconds < o.end - 0.001 && oc.end.seconds > o.start + 0.001) blocked.push((sg[bi].type === 'video' ? 'V' : 'A') + (sg[bi].track + 1) + ' "' + oc.name + '"');
          }
        }
        if (blocked.length) {
          var leftB = __removeGroup(seq, stagedIds);
          return JSON.stringify({ success: false, changed: leftB.length > 0, error: 'Laying the new media into the old slot would overwrite ' + blocked.join(', ') + ', so the swap was stopped before the old clip was touched.' + (leftB.length ? ' A temporary copy is still on the track from ' + far + 's; delete it.' : ' Nothing was changed.') });
        }
        app.enableQE();
        var qs = __qeSequenceOpening(seq);
        var reh = __carry(seq, qs, o.group, sg);
        if (reh.problems.length) {
          var leftC = __removeGroup(seq, stagedIds);
          return JSON.stringify({ success: false, changed: leftC.length > 0, problems: reh.problems, error: 'The new media could not take everything the clip carries (' + reh.problems.slice(0, 3).join('; ') + (reh.problems.length > 3 ? '; and ' + (reh.problems.length - 3) + ' more' : '') + '), so the swap was stopped before the old clip was touched.' + (leftC.length ? ' A temporary copy is still on the track from ' + far + 's; delete it.' : ' Nothing was changed.') });
        }
        o.stagedIds = stagedIds;
        o.keyed = reh.keyed;
        return JSON.stringify(o);
      } catch (e) {
        var leftE = []; try { if (stagedIds.length) leftE = __removeGroup(info.sequence, stagedIds); } catch (eX) {}
        return JSON.stringify({ success: false, changed: leftE.length > 0, error: e.toString() + (stagedIds.length ? (leftE.length ? ' A temporary copy is still on the track past the end of the edit; delete it.' : ' The temporary copy was removed; the old clip was not touched.') : '') });
      }
    `);
    if (!prep?.success) return prep;

    // 2. The swap: remove the old group, lay the new media into the slot, carry, compare.
    return await this.bridge.executeScript(`
      ${carry}
      try {
        var seq = __findSequence(${q(prep.seq)});
        var newItem = __findProjectItem(${q(newProjectItemId)});
        var oldIds = ${q(prep.oldIds)};
        var main = __findClip(${q(clipId)}, ${q(prep.seq)});
        if (!seq || !newItem || !main) return JSON.stringify({ success: false, changed: false, error: "Lost the old clip or the new item before the swap. Nothing was changed; the temporary copy is still on the track from ${prep.stagedStart}s." });
        var track = main.track;
        for (var r = 0; r < oldIds.length; r++) { var f = __findClip(oldIds[r], ${q(prep.seq)}); if (f) f.clip.remove(false, false); }
        var prevIn = null, prevOut = null;
        try { prevIn = newItem.getInPoint().seconds; prevOut = newItem.getOutPoint().seconds; } catch (eP) {}
        newItem.setInPoint(${prep.inPoint}, 4);
        newItem.setOutPoint(${prep.inPoint} + (${prep.end} - ${prep.start}), 4);
        var when = new Time(); when.seconds = ${prep.start};
        track.overwriteClip(newItem, when);
        try { if (prevIn !== null) { newItem.setInPoint(prevIn, 4); newItem.setOutPoint(prevOut, 4); } } catch (eB) {}
        var fin = null;
        for (var k = 0; k < track.clips.numItems; k++) { var tc = track.clips[k]; if (Math.abs(tc.start.seconds - ${prep.start}) < 0.02) { fin = tc; break; } }
        if (!fin) return JSON.stringify({ success: false, changed: true, error: "The new media did not land in the old slot. Undo restores the old clip; the temporary copy past the end of the edit holds its settings." });
        app.enableQE();
        var qs = __qeSequenceOpening(seq);
        var fg = __mcpClipGroup(seq, fin);
        var res = __carry(seq, qs, ${q(prep.group)}, fg);
        var placedOk = Math.abs(fin.start.seconds - ${prep.start}) < 0.02 && Math.abs(fin.end.seconds - ${prep.end}) < 0.02 && Math.abs(fin.inPoint.seconds - ${prep.inPoint}) < 0.02;
        var ok = placedOk && res.problems.length === 0;
        // Keep the rehearsal copy when something did not carry: it is the only clip still holding the settings.
        var left = ok ? __removeGroup(seq, ${q(prep.stagedIds)}) : [];
        return JSON.stringify({
          success: ok && left.length === 0, verified: true,
          verifiedBy: 'every setting and keyframe of the clip and its linked clips compared by position with the original, plus start, end and in point',
          clipId: String(fin.nodeId), start: fin.start.seconds, end: fin.end.seconds, inPoint: fin.inPoint.seconds,
          linkedCarried: fg.length - 1,
          note: 'The swapped clip has a new clip id; use clipId from this result.' + (${prep.keyed ? 'true' : 'false'} ? ' Keyframes were carried by time and value; their interpolation (ease) cannot be read by script, so it is back to the default.' : ''),
          problems: res.problems.length ? res.problems : undefined,
          error: !placedOk ? 'The new clip did not land at the old clip\\'s exact position and source range. Undo restores the old clip.'
            : res.problems.length ? 'Swapped, but not everything carried (' + res.problems.slice(0, 3).join('; ') + '). Undo restores the old clip; the temporary copy from ${prep.stagedStart}s still holds the settings.'
            : left.length ? 'Swapped and verified, but the temporary copy from ${prep.stagedStart}s could not be removed; delete it.' : undefined
        });
      } catch (e) { return JSON.stringify({ success: false, changed: true, error: e.toString() + ' Undo restores the old clip.' }); }
    `);
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
        var targets = [];
        for (var s = 0; s < seqs.length; s++) {
          var vt = seqs[s].videoTracks;
          for (var t = 0; t < vt.numTracks; t++) for (var c = 0; c < vt[t].clips.numItems; c++) {
            var cl = vt[t].clips[c], same = false;
            try { same = String(cl.projectItem.nodeId) === String(oldItem.nodeId); } catch (eP) {}
            if (same) targets.push({ clipId: String(cl.nodeId), sequenceName: String(seqs[s].name), track: t, start: cl.start.seconds });
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
        verifiedBy: 'walked every video track comparing clip.projectItem.nodeId',
        replaced: 0,
        targetsFound: 0,
        error: `The item "${found.oldName}" is in the project but is not used on any video track of ${seqId ? 'the requested sequence' : 'any sequence'}, so nothing was replaced.`,
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
