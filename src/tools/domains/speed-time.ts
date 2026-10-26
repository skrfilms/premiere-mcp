/**
 * SpeedTimeTools -- the Speed & Time tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { SourceMonitorTools } from './source-monitor.js';
import { spawn } from 'child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { TRIM_LIB } from '../trim-lib.js';
import { runFf } from '../ff-exec.js';

export class SpeedTimeTools extends SourceMonitorTools {
  protected async setClipReverse(trackIndex: number, clipIndex: number, reverse: boolean, sequenceId?: string): Promise<any> {
    // qeClip.setReverse() killed the engine on 26.3.2 and throws on 26.5.2. setSpeed() with the
    // reverse flag works, with an in-point correction (see __setReversed in trim-lib.ts).
    return await this.bridge.executeScript(`
      ${TRIM_LIB}
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        var track = seq.videoTracks[${Number(trackIndex)}];
        var clip = track && track.clips[${Number(clipIndex)}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        app.enableQE();
        var r = __setReversed(seq, clip, ${reverse === false ? 'false' : 'true'}, false);
        if (r.error) return JSON.stringify({ success: false, error: r.error });
        return JSON.stringify({ success: r.problems.length === 0, verified: true, verifiedBy: 'isSpeedReversed() and start/end readback',
          reversed: ${reverse === false ? 'false' : 'true'}, items: r.report, error: r.problems.length ? r.problems.join('; ') : undefined });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  /**
   * Bake a constant speed change to a NEW media file with ffmpeg. This is the
   * honest escape hatch for Premiere's never-scriptable time-remap graph: rather
   * than writing speed keyframes the renderer ignores, produce a real retimed
   * clip on disk the caller can import and place. Same honesty contract as
   * generate_scope: resolve the source, fail with install guidance if ffmpeg is
   * absent, and verify-after-write (the output must exist and be non-empty)
   * before claiming success.
   */
  protected async bakeSpeedChange(
    mediaPath?: string,
    projectItemId?: string,
    speed?: number,
    outputPath?: string,
    includeAudio = true,
    preservePitch = true,
  ): Promise<any> {
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
      return { success: false, error: 'Provide a speed multiplier greater than 0 (e.g. 0.5 for half speed, 2 for double).' };
    }

    let resolvedPath = mediaPath;
    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) return { success: false, error: resolved.error };
      resolvedPath = resolved.path;
    }
    if (!resolvedPath) return { success: false, error: 'Provide either mediaPath or projectItemId' };

    try {
      await fs.access(resolvedPath, fsConstants.R_OK);
    } catch {
      return { success: false, error: `Media file not found or unreadable: ${resolvedPath}` };
    }

    const ffmpeg = this.ffmpegCmd();
    const available = await this.checkCommandAvailable(ffmpeg, ['-version']);
    if (!available) {
      return {
        success: false,
        error: `ffmpeg ('${ffmpeg}') was not found on PATH. bake_speed_change retimes clips with ffmpeg because Premiere's time-remap graph cannot be scripted. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFMPEG_CMD to the binary name, then try again.`,
      };
    }

    const ext = extname(resolvedPath) || '.mp4';
    const speedLabel = String(speed).replace(/\./g, '_');
    const outFile = (outputPath && outputPath.trim())
      || join(dirname(resolvedPath), `${basename(resolvedPath, extname(resolvedPath))}_${speedLabel}x${ext}`);

    // The source's own frame rate and sample rate, so the retime is exact rather than assumed.
    let srcFps: string | null = null, srcRate = 48000;
    try {
      const probe = JSON.parse(runFf('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate,sample_rate', '-of', 'json', resolvedPath as string], { timeoutMs: 15000 }));
      for (const st of probe.streams ?? []) {
        if (st.codec_type === 'video' && st.r_frame_rate && st.r_frame_rate !== '0/0') srcFps = String(st.r_frame_rate);
        if (st.codec_type === 'audio' && Number(st.sample_rate) > 0) srcRate = Number(st.sample_rate);
      }
    } catch { /* fall back to ffmpeg's own choice below */ }
    // Video: setpts scales presentation timestamps by 1/speed, then fps= resamples back onto the
    // source frame grid. setpts alone leaves the muxer to pick frames, and it got the head wrong:
    // measured on a frame-counter clip at 2x, the output began 0,1,2,3,5,7 instead of 0,2,4,6 and
    // ran three frames behind for the rest of the clip.
    const vf = `setpts=${(1 / speed).toFixed(6)}*PTS` + (srcFps ? `,fps=${srcFps}` : '');
    const argv: string[] = ['-y', '-i', resolvedPath as string, '-vf', vf];
    if (includeAudio) {
      const audioFilter = preservePitch
        ? this.buildAtempoChain(speed)
        // Pitch shifts with speed: run the sample clock faster, then resample back to the source rate.
        : `asetrate=${srcRate}*${speed},aresample=${srcRate}`;
      argv.push('-af', audioFilter);
    } else {
      argv.push('-an');
    }
    argv.push(outFile);

    return await new Promise((resolve) => {
      const proc = spawn(ffmpeg, argv);
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffmpeg ('${ffmpeg}'): ${err.message}`, mediaPath: resolvedPath });
      });
      proc.on('close', async (code) => {
        let sizeBytes = 0;
        try {
          await fs.access(outFile, fsConstants.R_OK);
          sizeBytes = (await fs.stat(outFile)).size;
        } catch {
          resolve({
            success: false,
            error: `ffmpeg exited with code ${code} but no retimed file was written to ${outFile}. The source may be unreadable or the codec unsupported.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        if (sizeBytes === 0) {
          resolve({
            success: false,
            error: `ffmpeg wrote an empty file to ${outFile} (0 bytes). The retime did not produce usable output.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        resolve({
          success: true,
          speed,
          includeAudio,
          preservePitch: includeAudio ? preservePitch : undefined,
          outputPath: outFile,
          sizeBytes,
          mediaPath: resolvedPath,
          note: `Retimed clip written at ${speed}x. Import it with import_media and place it on a timeline. This is a constant time-scale (not optical-flow interpolation); for a ramp, bake segments and butt them together.`,
        });
      });
    });
  }

  protected async speedChange(clipId: string, speed: number, maintainAudio = true): Promise<any> {
    // QE setSpeed is miscalibrated on 26.5.2. Measured frame-exact on a clip with no tail handle:
    // a requested rate r plays at 2r/(r+1) (2x -> 1.33x, 3x -> 1.5x) while the duration is cut to
    // 1/r, so the clip silently loses the tail of its source range; on a clip with a neighbour it
    // did nothing at all; and the linked audio is never retimed, which breaks sync. So: apply,
    // verify BOTH the rate and the duration that rate implies, and on any mismatch undo it
    // (qe.project.undo() restores the clip exactly) and say so. bake_speed_change renders a real
    // retimed file with ffmpeg and is the dependable route.
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var requested = ${Number(speed)};
        if (!(requested > 0)) return JSON.stringify({ success: false, error: "speed must be greater than 0 (use reverse_clip to reverse)." });
        var clip = info.clip, track = info.track;
        var b = { start: Number(clip.start.ticks), end: Number(clip.end.ticks), speed: Number(clip.getSpeed()) };
        var findAgain = function () { for (var i = 0; i < track.clips.numItems; i++) { if (Number(track.clips[i].start.ticks) === b.start) return track.clips[i]; } return null; };
        var qeSeq = __qeSequenceOpening(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = info.trackType === 'video' ? qeSeq.getVideoTrackAt(info.trackIndex) : qeSeq.getAudioTrackAt(info.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, clip);
        if (!qeClip) return JSON.stringify({ success: false, error: "Could not resolve the QE clip for this item." });
        // (rate, durationTimecode, reverse, maintainAudioPitch, ripple)
        try { qeClip.setSpeed(requested, "00:00:00:00", false, ${maintainAudio ? 'true' : 'false'}, false); } catch (e2) {
          return JSON.stringify({ success: false, error: "Speed change via QE DOM failed: " + e2.toString(), oldSpeed: b.speed, requestedSpeed: requested });
        }
        var tpf = Number(info.sequence.timebase) || 10584000000;
        var now = findAgain() || clip;
        var gotSpeed = Number(now.getSpeed()), gotDur = Number(now.end.ticks) - Number(now.start.ticks);
        var wantDur = (b.end - b.start) * b.speed / requested;
        var ok = Math.abs(gotSpeed - requested) <= 0.02 && Math.abs(gotDur - wantDur) <= tpf / 2;
        if (ok) return JSON.stringify({ success: true, verified: true, verifiedBy: "getSpeed() and duration readback", oldSpeed: b.speed, newSpeed: gotSpeed, requestedSpeed: requested, durationSecs: gotDur / 254016000000,
          note: "Linked audio is not retimed by QE setSpeed; check it, or use bake_speed_change for a retimed file." });
        var undoError = null;
        try { qe.project.undo(); } catch (eU) { undoError = eU.toString(); }
        var back = findAgain() || clip;
        var restored = Number(back.getSpeed()) === b.speed && Number(back.end.ticks) === b.end && Number(back.start.ticks) === b.start;
        return JSON.stringify({ success: false, verified: true, verifiedBy: "getSpeed() and duration readback",
          error: "Premiere applied the speed incorrectly (asked " + requested + "x, got " + gotSpeed + "x over " + (gotDur / 254016000000) + "s instead of " + (wantDur / 254016000000) + "s), so it was " + (restored ? "undone; the clip is unchanged." : "NOT fully undone" + (undoError ? " (" + undoError + ")" : "") + "; check the clip.") + " QE speed changes are unreliable on this build. Use bake_speed_change to render a retimed file and place that instead.",
          oldSpeed: b.speed, requestedSpeed: requested, appliedSpeed: gotSpeed, rolledBack: restored });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async reverseClip(clipId: string, maintainAudioPitch?: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      ${TRIM_LIB}
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var mediaPath = "";
        try { mediaPath = info.clip.projectItem && info.clip.projectItem.getMediaPath ? String(info.clip.projectItem.getMediaPath()) : ""; } catch (pathError) {}
        if (/\\.(png|jpg|jpeg|gif|tif|tiff)$/i.test(mediaPath)) {
          return JSON.stringify({ success: true, clipId: ${JSON.stringify(clipId)}, reversed: true, changed: false, method: "still image: reversing changes nothing" });
        }
        app.enableQE();
        var r = __setReversed(info.sequence, info.clip, true, ${maintainAudioPitch ? 'true' : 'false'});
        if (r.error) return JSON.stringify({ success: false, error: r.error });
        return JSON.stringify({ success: r.problems.length === 0, verified: true, verifiedBy: 'isSpeedReversed() and start/end readback; source range restored after QE mirrors it',
          clipId: ${JSON.stringify(clipId)}, reversed: true, items: r.report, error: r.problems.length ? r.problems.join('; ') : undefined });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `);
  }

  protected async rateStretchToFill(trackIndex: number, clipIndex: number, targetDurationSecs?: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq=${this.buildQSeqResolver(seqId)};
        var domSeq=${this.buildSeqRes(seqId)};
        var clip=domSeq.videoTracks[${trackIndex}].clips[${clipIndex}];
        if(!clip)return JSON.stringify({success:false,error:'Clip not found'});
        var currentDur=clip.duration.seconds;
        var targetDur=${targetDurationSecs ?? 'null'};
        if(!targetDur){
          var nextClip=domSeq.videoTracks[${trackIndex}].clips[${clipIndex+1}];
          targetDur=nextClip?nextClip.start.seconds-clip.start.seconds:currentDur;
        }
        var ratio=currentDur/targetDur;
        // By start time, not DOM index: QE track items include gaps and transitions.
        var qeClip=__findQeClipByDomClip(seq.getVideoTrackAt(${trackIndex}), clip);
        if(!qeClip)return JSON.stringify({success:false,error:'Could not match the clip in QE'});
        var oldSpeed=null; try{ oldSpeed=Number(clip.getSpeed()); }catch(eB){}
        var oldDur=Number(clip.duration.seconds);
        var setError=null;
        try{ qeClip.setSpeed(ratio,'00:00:00:00',false,true,false); }catch(eS){ setError=eS.toString(); }
        var newSpeed=null; try{ newSpeed=Number(clip.getSpeed()); }catch(eA){}
        var newDur=Number(clip.duration.seconds);
        if(newSpeed===null||isNaN(newSpeed)){
          return JSON.stringify({success:true,verified:false,ratio:ratio,targetDurationSecs:targetDur,oldSpeedRatio:oldSpeed,durationBefore:oldDur,durationAfter:newDur,setError:setError,
            unverifiedReason:'TrackItem.getSpeed() is not readable after the write, so the rate stretch cannot be confirmed. Read it with get_clip_speed.'});
        }
        var onTarget=Math.abs(newSpeed-ratio)<0.05;
        var durOnTarget=Math.abs(newDur-targetDur)<0.05;
        if(onTarget&&durOnTarget){
          return JSON.stringify({success:true,verified:true,verifiedBy:'TrackItem.getSpeed() and TrackItem.duration readback',changed:oldSpeed!==newSpeed,ratio:ratio,targetDurationSecs:targetDur,oldSpeedRatio:oldSpeed,newSpeedRatio:newSpeed,durationBefore:oldDur,durationAfter:newDur});
        }
        // Speed and duration are two separate readbacks and they can disagree: a speed change
        // that Premiere applies without re-timing the clip leaves the gap this tool exists to
        // fill still open. Reporting only the speed hid that.
        // QE setSpeed is miscalibrated on 26.5.2 (see speedChange): undo rather than leave a clip
        // retimed to something nobody asked for.
        var undone=false;
        if(oldSpeed!==newSpeed||Math.abs(newDur-oldDur)>0.001){ try{ qe.project.undo(); undone=Math.abs(Number(clip.getSpeed())-oldSpeed)<0.0001; }catch(eU){} }
        return JSON.stringify({success:false,verified:true,verifiedBy:'TrackItem.getSpeed() and TrackItem.duration readback',changed:oldSpeed!==newSpeed,rolledBack:undone,ratio:ratio,targetDurationSecs:targetDur,oldSpeedRatio:oldSpeed,newSpeedRatio:newSpeed,durationBefore:oldDur,durationAfter:newDur,setError:setError,
          error: (undone ? 'Undone; the clip is unchanged. ' : '') + (!onTarget
            ? ('Clip speed reads ' + newSpeed + ' instead of the requested ' + ratio + ', so the clip was not rate stretched to fill ' + targetDur + 's.')
            : ('The speed landed at ' + newSpeed + ' but the clip duration reads ' + newDur + 's instead of ' + targetDur + 's, so the gap it was meant to fill is still open. setSpeed changes the rate without necessarily re-timing the clip on the timeline.')) + ' QE speed changes are unreliable on this build; bake_speed_change renders a retimed file instead.'});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async fitClipDuration(trackIndex: number, clipIndex: number, targetSeconds: number, method: string, seqId?: string): Promise<any> {
    if (method === 'speed') return this.rateStretchToFill(trackIndex, clipIndex, targetSeconds, seqId);
    return await this.bridge.executeScript(`
      try {
        var clip=${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        var newEndSecs=clip.start.seconds+${targetSeconds};
        var t=new Time();t.seconds=clip.outPoint.seconds+(newEndSecs-clip.end.seconds);
        clip.outPoint=t;
        return JSON.stringify({success:true,method:'trim',targetSeconds:${targetSeconds},newEnd:newEndSecs});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async verifySpeedDuration(trackIndex: number, clipIndex: number, expectedSpeedPercent?: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var clip=${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        var speed=clip.getSpeed?clip.getSpeed():1;
        var dur=clip.duration.seconds;
        var expected=${expectedSpeedPercent ?? 'null'};
        var matches=expected?Math.abs(speed*100-expected)<1:true;
        return JSON.stringify({success:true,speedRatio:speed,speedPercent:speed*100,durationSecs:dur,expectedSpeedPercent:expected,matches:matches});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async getClipSpeedInfo(trackIndex: number, clipIndex: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var clip=${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        var qeClip=__qeClipByIndex(${this.buildQSeqResolver(seqId)}, 'video', ${trackIndex}, ${clipIndex});
        return JSON.stringify({success:true,speed:clip.getSpeed?clip.getSpeed():1,durationSecs:clip.duration.seconds,isReversed:qeClip?qeClip.reversed:false,frameBlend:qeClip?qeClip.frameBlend:false,timeInterpolation:qeClip?qeClip.timeInterpolationType:0});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async removeTimeRemap(trackIndex: number, clipIndex: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var clip=${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        if(!clip)return JSON.stringify({success:false,error:'Clip not found on the DOM sequence at video track ${trackIndex} index ${clipIndex}'});
        // By start time, not DOM index: QE track items include gaps and transitions.
        var qeClip=__findQeClipByDomClip(${this.buildQSeqResolver(seqId)}.getVideoTrackAt(${trackIndex}), clip);
        if(!qeClip)return JSON.stringify({success:false,error:'Could not match the clip in QE'});
        var oldSpeed=null; try{ oldSpeed=Number(clip.getSpeed()); }catch(eB){}
        var setError=null;
        try{ qeClip.setSpeed(1.0,'00:00:00:00',false,false,false); }catch(eS){ setError=eS.toString(); }
        var newSpeed=null; try{ newSpeed=Number(clip.getSpeed()); }catch(eA){}
        if(newSpeed===null||isNaN(newSpeed)){
          return JSON.stringify({success:true,verified:false,oldSpeed:oldSpeed,setError:setError,
            unverifiedReason:'TrackItem.getSpeed() is not readable after the write, so the speed reset cannot be confirmed. Read it with get_clip_speed.'});
        }
        if(Math.abs(newSpeed-1)>=0.02){
          return JSON.stringify({success:false,verified:true,verifiedBy:'TrackItem.getSpeed() readback',changed:oldSpeed!==newSpeed,oldSpeed:oldSpeed,newSpeed:newSpeed,setError:setError,
            error:'The clip speed still reads ' + newSpeed + ' rather than 1.0, so the time remap was not removed.'});
        }
        // A clip that was never remapped reads 1.0 both before and after, which is a no-op
        // rather than a removal. The old bare comparison called both of those verified.
        return JSON.stringify({success:true,verified:true,verifiedBy:'TrackItem.getSpeed() readback',changed:oldSpeed!==newSpeed,oldSpeed:oldSpeed,newSpeed:newSpeed,
          note: (oldSpeed !== null && Math.abs(oldSpeed-1) < 0.02) ? 'This clip was already at 1.0x, so there was no time remap to remove. Note that setSpeed resets the RATE; keyframed Time Remapping keyframes are not cleared by it — use remove_keyframe_range on the Time Remapping parameter for those.' : 'Speed reset to 1.0x. Keyframed Time Remapping keyframes are not cleared by this call — use remove_keyframe_range on the Time Remapping parameter if the clip carries any.'});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected slowmoQualityReport(sourceFps: number, targetSpeedPercent: number): any {
    const effectiveFps = sourceFps * (targetSpeedPercent / 100);
    const willJudder = effectiveFps < 24;
    return { success: true, sourceFps, targetSpeedPercent, effectiveFps: Math.round(effectiveFps * 100) / 100, willJudder, recommendation: willJudder ? 'Use Optical Flow time interpolation for smooth slow-motion' : 'Frame sample or frame blend will work fine', minimumSpeedForSmooth: Math.ceil(2400 / sourceFps) };
  }

  protected async speedRampBake(trackIndex: number, clipIndex: number, speedPercent: number, _outputDir: string, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var clip=${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        var srcPath=clip.projectItem.getMediaPath();
        var dur=clip.duration.seconds;
        return JSON.stringify({success:false,note:'speedRampBake requires ffmpeg bake — use bake_speed_change tool instead',srcPath:String(srcPath),durationSecs:dur,speedPercent:${speedPercent}});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }
}
