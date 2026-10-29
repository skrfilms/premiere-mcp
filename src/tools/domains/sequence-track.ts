/**
 * SequenceTrackTools -- the Sequence & Track Structure tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { EffectsTools } from './effects.js';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// The async API is the separate `promises as fs` import.
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import { runFf } from '../ff-exec.js';
import { generatedAssetsDir } from '../../utils/scratch-paths.js';

export class SequenceTrackTools extends EffectsTools {
  protected async listSequences(): Promise<any> {
    const script = `
      try {
        var sequences = [];
        
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
          var seq = app.project.sequences[i];
          sequences.push({
            id: seq.sequenceID,
            name: seq.name,
            duration: __ticksToSeconds(seq.end),
            width: seq.frameSizeHorizontal,
            height: seq.frameSizeVertical,
            timebase: seq.timebase,
            videoTrackCount: seq.videoTracks.numTracks,
            audioTrackCount: seq.audioTracks.numTracks
          });
        }

        return JSON.stringify({
          success: true,
          sequences: sequences,
          count: sequences.length
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

  protected async listSequenceTracks(sequenceId: string): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}

        var videoTracks = [];
        var audioTracks = [];

        for (var i = 0; i < sequence.videoTracks.numTracks; i++) {
          var track = sequence.videoTracks[i];
          var clips = [];

          for (var j = 0; j < track.clips.numItems; j++) {
            var clip = track.clips[j];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              startTime: clip.start.seconds,
              endTime: clip.end.seconds,
              duration: clip.duration.seconds
            });
          }

          videoTracks.push({
            index: i,
            name: track.name || "Video " + (i + 1),
            clips: clips,
            clipCount: clips.length
          });
        }

        for (var i = 0; i < sequence.audioTracks.numTracks; i++) {
          var track = sequence.audioTracks[i];
          var clips = [];

          for (var j = 0; j < track.clips.numItems; j++) {
            var clip = track.clips[j];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              startTime: clip.start.seconds,
              endTime: clip.end.seconds,
              duration: clip.duration.seconds
            });
          }

          audioTracks.push({
            index: i,
            name: track.name || "Audio " + (i + 1),
            clips: clips,
            clipCount: clips.length
          });
        }

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          videoTracks: videoTracks,
          audioTracks: audioTracks,
          totalVideoTracks: videoTracks.length,
          totalAudioTracks: audioTracks.length
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

  protected async deleteEmptyTracks(
    sequenceId: string | undefined,
    video: boolean,
    audio: boolean,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        var beforeV = seq.numVideoTracks; var beforeA = seq.numAudioTracks;
        if (${video}) seq.removeEmptyVideoTracks();
        if (${audio}) seq.removeEmptyAudioTracks();
        var afterV = seq.numVideoTracks; var afterA = seq.numAudioTracks;
        return JSON.stringify({success:true,verified:true,removedVideoTracks:beforeV-afterV,removedAudioTracks:beforeA-afterA,remainingVideo:afterV,remainingAudio:afterA});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setSequenceInOutQe(
    inPoint?: string,
    outPoint?: string,
    sequenceId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        ${inPoint ? `try { seq.setInPoint(${JSON.stringify(inPoint)}, true, false); } catch(e) {}` : ''}
        ${outPoint ? `try { seq.setOutPoint(${JSON.stringify(outPoint)}, true, false); } catch(e) {}` : ''}
        return JSON.stringify({success:true,inPoint:${inPoint ? JSON.stringify(inPoint) : 'null'},outPoint:${outPoint ? JSON.stringify(outPoint) : 'null'},seqName:String(seq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getQeSequenceProps(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        var cti = seq.CTI; var ip = seq.inPoint; var op = seq.outPoint; var wi = seq.workInPoint; var wo = seq.workOutPoint;
        return JSON.stringify({
          success:true, sequenceName:String(seq.name),
          cti:{ticks:String(cti.ticks),secs:cti.secs,frames:cti.frames},
          inPoint:{ticks:String(ip.ticks),secs:ip.secs},
          outPoint:{ticks:String(op.ticks),secs:op.secs},
          workInPoint:{ticks:String(wi.ticks),secs:wi.secs},
          workOutPoint:{ticks:String(wo.ticks),secs:wo.secs},
          previewPresetPath:String(seq.previewPresetPath),
          editingModeGuid:String(seq.editingMode),
          numVideoTracks:seq.numVideoTracks, numAudioTracks:seq.numAudioTracks,
          useMaxBitDepth:seq.useMaxBitDepth, useMaxRenderQuality:seq.useMaxRenderQuality
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getEditPointList(sequenceId?: string, videoOnly?: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var cuts = [];
      for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
          var clip = track.clips[c];
          cuts.push({type:'video',track:t,clip:c,name:String(clip.name),startSecs:clip.start.seconds,endSecs:clip.end.seconds,startTicks:String(clip.start.ticks)});
        }
      }
      if (!${videoOnly}) {
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
          var atrack = seq.audioTracks[at];
          for (var ac = 0; ac < atrack.clips.numItems; ac++) {
            var aclip = atrack.clips[ac];
            cuts.push({type:'audio',track:at,clip:ac,name:String(aclip.name),startSecs:aclip.start.seconds,endSecs:aclip.end.seconds});
          }
        }
      }
      cuts.sort(function(a,b){return a.startSecs - b.startSecs;});
      return JSON.stringify({success:true,cutCount:cuts.length,cuts:cuts});
    `);
  }

  protected async detectSettingsMismatch(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var seqFps = seq.timebase ? Math.round(254016000000/Number(seq.timebase)*100)/100 : 0;
      var seqW = seq.frameSizeHorizontal; var seqH = seq.frameSizeVertical;
      var mismatches = [];
      for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
          var clip = track.clips[c];
          var item = clip.projectItem;
          if (!item) continue;
          var srcTb = item.sourceTimebase ? Number(item.sourceTimebase) : 0;
          var srcFps = srcTb > 0 ? Math.round(254016000000/srcTb*100)/100 : 0;
          if (srcFps > 0 && Math.abs(srcFps - seqFps) > 0.1) {
            mismatches.push({track:t,clip:c,name:String(clip.name),clipFps:srcFps,seqFps:seqFps,issue:'fps_mismatch'});
          }
        }
      }
      return JSON.stringify({success:true,seqFps:seqFps,seqSize:seqW+'x'+seqH,mismatchCount:mismatches.length,mismatches:mismatches});
    `);
  }

  protected async countTracksUsed(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var result = {videoTracks:[],audioTracks:[]};
      for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var tr = seq.videoTracks[t]; result.videoTracks.push({index:t,name:String(tr.name),clips:tr.clips.numItems,hasContent:tr.clips.numItems>0});
      }
      for (var at = 0; at < seq.audioTracks.numTracks; at++) {
        var atr = seq.audioTracks[at]; result.audioTracks.push({index:at,name:String(atr.name),clips:atr.clips.numItems,hasContent:atr.clips.numItems>0});
      }
      return JSON.stringify({success:true,videoTracksTotal:result.videoTracks.length,videoTracksWithContent:result.videoTracks.filter(function(t){return t.hasContent;}).length,audioTracksTotal:result.audioTracks.length,audioTracksWithContent:result.audioTracks.filter(function(t){return t.hasContent;}).length,tracks:result});
    `);
  }

  protected sequenceThumbnailStrip(filePath: string, count: number, outputDir?: string): any {
    const path = pathSync;
    const fs = fsSync;
    const dir = outputDir ?? generatedAssetsDir();
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const base = path.join(dir, 'thumb_%04d.jpg');
      const dur = parseFloat(
        runFf(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            filePath,
          ],
          { timeoutMs: 15000 },
        ).trim(),
      );
      const fps = count / dur;
      runFf(
        'ffmpeg',
        [
          '-y',
          '-loglevel',
          'error',
          '-i',
          filePath,
          '-vf',
          `fps=${fps}`,
          '-frames:v',
          String(count),
          base,
        ],
        { timeoutMs: 120000 },
      );
      const files: string[] = [];
      for (let i = 1; i <= count; i++) {
        const p = path.join(dir, `thumb_${String(i).padStart(4, '0')}.jpg`);
        if (fs.existsSync(p)) files.push(p);
      }
      return { success: true, count: files.length, files, durationSecs: dur };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected async listSequencesByName(pattern: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var pat = ${JSON.stringify(pattern.toLowerCase())};
        var seqs = app.project.sequences;
        var matches = [];
        for (var i=0; i<seqs.numSequences; i++) {
          var s = seqs[i];
          if (String(s.name).toLowerCase().indexOf(pat) >= 0) {
            matches.push({name:String(s.name),id:String(s.sequenceID),tracks:{v:s.videoTracks.numTracks,a:s.audioTracks.numTracks}});
          }
        }
        return JSON.stringify({success:true,matchCount:matches.length,matches:matches});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // Batch F: Sequence utilities
  protected async setSequenceInOutFromClips(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var qseq = ${this.buildQSeqResolver(sequenceId)};
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq || !qseq) return JSON.stringify({success:false,error:'No sequence'});
        var firstStart = null; var lastEnd = null;
        for (var t=0; t<seq.videoTracks.numTracks; t++) {
          var track = seq.videoTracks[t];
          for (var c=0; c<track.clips.numItems; c++) {
            var clip = track.clips[c];
            var s = Number(clip.start.ticks); var e = Number(clip.end.ticks);
            if (firstStart === null || s < firstStart) firstStart = s;
            if (lastEnd === null || e > lastEnd) lastEnd = e;
          }
        }
        if (firstStart === null) return JSON.stringify({success:false,error:'No clips found on V1'});
        qseq.setWorkInPoint(String(firstStart));
        qseq.setWorkOutPoint(String(lastEnd));
        return JSON.stringify({success:true,workInTicks:String(firstStart),workOutTicks:String(lastEnd)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async flushSequenceCache(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var qseq = ${this.buildQSeqResolver(sequenceId)};
        qseq.flushCache();
        return JSON.stringify({success:true,sequenceName:String(qseq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // Sequence Management Implementation
  protected async createSequence(
    name: string,
    presetPath: string,
    frameRate?: number,
  ): Promise<any> {
    try {
      const result: any = await this.bridge.createSequence(name, presetPath);
      if (result?.success === false) {
        return {
          ...result,
          sequenceName: result.sequenceName || name,
        };
      }

      // The preset dictates the initial frame rate, so 24 vs 23.976 is whatever the
      // .sqpreset happens to carry. When the caller asks for a specific rate, set it
      // on the freshly created sequence and read it back through the already-validated
      // setSequenceSettings path, surfacing a warning if Premiere refused it.
      let frameRateResult: any = undefined;
      if (frameRate !== undefined && result?.id) {
        frameRateResult = await this.setSequenceSettings(result.id, { frameRate });
      }

      return {
        success: true,
        message: `Sequence "${name}" created successfully`,
        sequenceName: name,
        ...result,
        ...(frameRateResult
          ? {
              frameRateRequested: frameRate,
              frameRateApplied: frameRateResult.success !== false,
              // setSequenceSettings reads the rate back after writing: `after` on the
              // success path, `settings` on the no-op / rejected branches.
              ...((): any => {
                const actual =
                  frameRateResult.after?.frameRate ?? frameRateResult.settings?.frameRate;
                return actual !== undefined && actual !== null ? { frameRateActual: actual } : {};
              })(),
              ...(frameRateResult.success === false || frameRateResult.warning
                ? { frameRateWarning: frameRateResult.error || frameRateResult.warning }
                : {}),
            }
          : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timeout|timed out/i.test(message);
      return {
        success: false,
        error: `Failed to create sequence: ${message}`,
        sequenceName: name,
        ...(timedOut
          ? {
              warning:
                'Premiere may still create the sequence after this timeout. Wait for the bridge to become responsive, then run list_sequences to verify before retrying. The server intentionally does not run automatic recovery after a timeout because that can wedge the CEP bridge on Windows.',
            }
          : {}),
      };
    }
  }

  protected async createSequenceFromProjectItems(
    name: string,
    projectItemIds: string[],
  ): Promise<any> {
    if (!projectItemIds.length) {
      return {
        success: false,
        error:
          'At least one imported project item is required to create a sequence without a dialog.',
      };
    }

    const script = `
      try {
        function walk(parent, output) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            output.push(item);
            if (item.type === ProjectItemType.BIN) walk(item, output);
          }
        }
        var ids = ${JSON.stringify(projectItemIds)};
        var allItems = [];
        walk(app.project.rootItem, allItems);
        var items = [];
        for (var j = 0; j < ids.length; j++) {
          for (var k = 0; k < allItems.length; k++) {
            if (String(allItems[k].nodeId) === String(ids[j])) {
              items.push(allItems[k]);
              break;
            }
          }
        }
        if (!items.length) return JSON.stringify({ success: false, error: 'Imported project items could not be found.' });
        var sequence = app.project.createNewSequenceFromClips(${JSON.stringify(name)}, items, app.project.rootItem);
        if (!sequence) return JSON.stringify({ success: false, error: 'Premiere did not create a sequence from the imported clips.' });
        return JSON.stringify({ success: true, id: sequence.sequenceID, name: sequence.name, itemCount: items.length });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async duplicateSequence(
    sequenceId: string,
    newName: string,
    clearContents = false,
  ): Promise<any> {
    const safeName = JSON.stringify(newName);
    const script = `
      try {
        var originalSeq = __findSequence(${JSON.stringify(sequenceId)});
        if (!originalSeq) return JSON.stringify({ success: false, error: "Sequence not found" });

        // In current Premiere, Sequence.clone() returns the clone's ProjectItem (NOT a Sequence),
        // which has a settable .name but no .sequenceID / .videoTracks. Resolve the real Sequence
        // object via getSequence() before touching tracks; handle builds that return a Sequence too.
        // Noted before the clone so the fallback below can tell a newly created
        // sequence apart from the one the user already had open.
        var priorActiveId = null;
        try {
          priorActiveId = app.project.activeSequence ? String(app.project.activeSequence.sequenceID) : null;
        } catch (ePriorActive) {}

        var cloneResult = originalSeq.clone();
        var newItem = null, newSeqObj = null;
        if (cloneResult) {
          if (typeof cloneResult.getSequence === "function") {
            newItem = cloneResult;
            try { newSeqObj = cloneResult.getSequence(); } catch (_) {}
          } else if (cloneResult.videoTracks) {
            newSeqObj = cloneResult;
          }
        }
        // Fallback: a freshly cloned sequence usually becomes the active one.
        //
        // Only accept it once it is demonstrably new — a different sequence from
        // both the clone source and whatever was active before the clone ran.
        // Taken unconditionally, this clause hands back the user's own open
        // timeline whenever clone() returns something unexpected or
        // getSequence() throws, and everything below then renames it and, with
        // clearContents, removes every clip from it — reported as success.
        if (!newSeqObj) {
          try {
            var activeCandidate = app.project.activeSequence;
            var activeCandidateId = activeCandidate ? String(activeCandidate.sequenceID) : null;
            if (activeCandidateId &&
                activeCandidateId !== String(originalSeq.sequenceID) &&
                activeCandidateId !== priorActiveId) {
              newSeqObj = activeCandidate;
            }
          } catch (eActiveFallback) {}
        }

        // Refuse rather than guess. Clearing a sequence that may not be the copy
        // is irreversible, so an unresolved copy has to stop the operation.
        if (${clearContents ? 'true' : 'false'} && !newSeqObj) {
          return JSON.stringify({
            success: false,
            error: "The sequence was duplicated but the copy could not be identified, so clearContents was not run. Nothing was cleared. Find the new sequence with list_sequences and clear it explicitly.",
            duplicated: true,
            cleared: false
          });
        }

        // Rename on the ProjectItem (visible in the project panel) AND the Sequence object.
        if (newItem) { try { newItem.name = ${safeName}; } catch (_) {} }
        if (newSeqObj) { try { newSeqObj.name = ${safeName}; } catch (_) {} }

        // clearContents=true → produce an EMPTY sequence that inherits the source's exact
        // settings (frame rate, resolution, track layout). This is the reliable way to auto-create
        // a correctly-specced target because create_sequence ignores frameRate. Remove every clip
        // from all tracks (iterate backwards; remove() shifts indices).
        var clearedClips = 0;
        if (${clearContents ? 'true' : 'false'} && newSeqObj) {
          function __clearTracks(tracks) {
            if (!tracks) return;
            for (var t = 0; t < tracks.numTracks; t++) {
              var tr = tracks[t];
              if (!tr || !tr.clips) continue;
              for (var ci = tr.clips.numItems - 1; ci >= 0; ci--) {
                try { tr.clips[ci].remove(false, false); clearedClips++; } catch (_) {}
              }
            }
          }
          __clearTracks(newSeqObj.videoTracks);
          __clearTracks(newSeqObj.audioTracks);
        }

        // Sequence.name does NOT always propagate to the project panel — if clone() didn't give us
        // the ProjectItem directly, find the matching one by sequenceID and rename it too.
        function __findItemForSequence(parent, seqId) {
          if (!parent || !parent.children) return null;
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            if (!item) continue;
            try {
              var seq = item.getSequence && item.getSequence();
              if (seq && seq.sequenceID === seqId) return item;
            } catch (_) { /* not a sequence-bearing item */ }
            if (item.type === 2 /* BIN */) {
              var nested = __findItemForSequence(item, seqId);
              if (nested) return nested;
            }
          }
          return null;
        }

        var renamedAtItem = false;
        if (newItem) {
          renamedAtItem = true;
        } else if (newSeqObj) {
          newItem = __findItemForSequence(app.project.rootItem, newSeqObj.sequenceID);
          if (newItem) {
            try { newItem.name = ${safeName}; renamedAtItem = true; } catch (_) { /* fall through */ }
          }
        }

        // Fail closed when the clone produced nothing identifiable: reading back all-null
        // ids as success:true is a fake success (the duplicate silently did not happen).
        if (!newSeqObj && !newItem) {
          return JSON.stringify({ success: false, verified: false, error: "clone() ran but neither the new sequence nor its project item could be resolved; nothing was duplicated.", originalSequenceId: ${JSON.stringify(sequenceId)} });
        }
        // Verify the rename actually landed on the project item, rather than trusting the assignment.
        var renameVerified = false;
        if (newItem) { try { renameVerified = (String(newItem.name) === ${safeName}); } catch (eRv) {} }

        return JSON.stringify({
          success: true,
          verified: true,
          originalSequenceId: ${JSON.stringify(sequenceId)},
          newSequenceId: newSeqObj ? newSeqObj.sequenceID : null,
          newName: ${safeName},
          newProjectItemId: newItem ? newItem.nodeId : null,
          renamedAtProjectItem: renamedAtItem,
          renameVerified: renameVerified,
          clearedClips: clearedClips
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async deleteSequence(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
        var sequenceName = sequence.name;
        var beforeCount = app.project.sequences.numSequences;
        app.project.deleteSequence(sequence);
        var stillThere = __findSequence(${JSON.stringify(sequenceId)});
        var afterCount = app.project.sequences.numSequences;
        if (stillThere || afterCount >= beforeCount) return JSON.stringify({ success: false, verified: false, error: "Premiere did not delete the sequence '" + sequenceName + "' (still present after deleteSequence).", beforeCount: beforeCount, afterCount: afterCount });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Sequence deleted successfully",
          deletedSequenceId: ${JSON.stringify(sequenceId)},
          deletedSequenceName: sequenceName,
          beforeCount: beforeCount,
          afterCount: afterCount
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  /**
   * Read a sequence's full track structure (video + audio clips with times and
   * best-effort source frame rate, plus the sequence frame rate). Read-only.
   * Shared by lint_timeline and diff_sequences. Defaults to the active sequence.
   */
  protected async walkSequence(sequenceId?: string): Promise<any> {
    const seqExpr = sequenceId
      ? `__findSequence(${JSON.stringify(sequenceId)})`
      : 'app.project.activeSequence';
    const script = `
      try {
        var sequence = ${seqExpr};
        if (!sequence) return JSON.stringify({ success: false, error: ${sequenceId ? `"Sequence not found by id: " + ${JSON.stringify(sequenceId)}` : '"No active sequence"'} });

        var fps = 30;
        try { if (sequence.timebase) fps = 254016000000.0 / parseInt(sequence.timebase, 10); } catch (eFps) {}

        function readClipFps(clip) {
          try {
            var pit = clip.projectItem;
            if (pit && pit.getFootageInterpretation) {
              var interp = pit.getFootageInterpretation();
              if (interp && interp.frameRate) return Number(interp.frameRate);
            }
          } catch (eInterp) {}
          return null;
        }

        function walk(trackGroup) {
          var out = [];
          for (var i = 0; i < trackGroup.numTracks; i++) {
            var track = trackGroup[i];
            var clips = [];
            for (var j = 0; j < track.clips.numItems; j++) {
              var clip = track.clips[j];
              var srcFps = readClipFps(clip);
              var entry = {
                name: clip.name,
                startTime: clip.start.seconds,
                endTime: clip.end.seconds,
                duration: clip.duration.seconds
              };
              if (srcFps) entry.sourceFrameRate = srcFps;
              clips.push(entry);
            }
            out.push({ index: i, name: track.name || "", clips: clips });
          }
          return out;
        }

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          frameRate: Math.round(fps * 1000) / 1000,
          videoTracks: walk(sequence.videoTracks),
          audioTracks: walk(sequence.audioTracks)
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  /**
   * Resolve the active sequence's id, so capture_program_output can default to
   * "whatever is open" the way the frame/scope tools elsewhere accept no id.
   */
  protected async resolveActiveSequenceId(): Promise<{
    id?: string;
    name?: string;
    error?: string;
  }> {
    const script = `
      try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: "No active sequence" });
        return JSON.stringify({ success: true, id: String(seq.sequenceID), name: seq.name });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    const res = await this.bridge.executeScript(script);
    if (res && res.success && res.id) return { id: String(res.id), name: res.name };
    return { error: (res && res.error) || 'Could not resolve the active sequence' };
  }

  /**
   * Builds the ExtendScript preamble that resolves a caller-supplied sequence ID to a real
   * sequence object.
   *
   * Premiere's ExtendScript DOM can read and mutate any sequence in the project, not just
   * the one on screen, so a tool that accepts a sequenceId must act on that sequence rather
   * than silently retargeting to `app.project.activeSequence`. When the ID matches nothing
   * we return a truthful error instead of falling back to the active sequence, which would
   * quietly write to the wrong timeline.
   *
   * The ID compared here is `sequence.sequenceID` (a GUID) — the same value surfaced as `id`
   * by `list_sequences` and `get_active_sequence`. It is deliberately not `sequence.id` or
   * `projectItem.nodeId`, which are different identifiers.
   */
  protected buildSequenceResolver(sequenceId: string, varName: string = 'sequence'): string {
    const literal = JSON.stringify(sequenceId);
    return `        var ${varName} = __findSequence(${literal});
        if (!${varName}) {
          return JSON.stringify({
            success: false,
            error: "Sequence not found by id: " + ${literal} + ". Use list_sequences or get_active_sequence to obtain a valid sequence ID."
          });
        }`;
  }

  // Track Management Implementation
  // FIX vs upstream: upstream called qeSeq.addTracks(numVideo, numAudio, 0) which interpreted
  // the 3rd arg as videoInsertIndex = 0, meaning "insert NEW track AT INDEX 0", pushing all
  // existing tracks up by 1. This destroyed V1's content positioning relative to track names
  // and caused MOGRT inserts to land on the wrong track.
  //
  // QE DOM signature: Sequence.addTracks(videoCount, videoInsertIndex, audioCount,
  //   audioMediaType, audioInsertIndex, audioSubmixCount, audioSubmixAudioType)
  //
  // Now we honor the `position` param:
  //   - "above" (default) → insert at index = numVideoTracks (becomes new TOP track,
  //     existing tracks keep their indices)
  //   - "below" → insert at 0 (legacy behavior, pushes existing up — only useful in special
  //     cases since V1 in Premiere's UI is the bottom)
  protected async addTrack(
    sequenceId: string,
    trackType: string,
    position: string = 'above',
  ): Promise<any> {
    const isVideo = trackType === 'video';
    const numVideo = isVideo ? 1 : 0;
    const numAudio = isVideo ? 0 : 1;
    const script = `
      try {
        app.enableQE();
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var __priorActive = app.project.activeSequence;
        app.project.activeSequence = seq;
        var qeSeq = __qeSequenceOpening(seq);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + seq.name + "' through the QE API." });

        // Calculate insertion index based on position
        var existingVideoTracks = seq.videoTracks.numTracks;
        var existingAudioTracks = seq.audioTracks.numTracks;
        var insertVideoIdx = (${JSON.stringify(position)} === 'above') ? existingVideoTracks : 0;
        var insertAudioIdx = (${JSON.stringify(position)} === 'above') ? existingAudioTracks : 0;

        // Full QE addTracks signature. Arg 4 is audio type, arg 5 is audio insert index.
        qeSeq.addTracks(${numVideo}, insertVideoIdx, ${numAudio}, 1, insertAudioIdx, 0, 0);

        var afterVideoTracks = seq.videoTracks.numTracks;
        var afterAudioTracks = seq.audioTracks.numTracks;

        var expectedVideoTracks = existingVideoTracks + ${numVideo};
        var expectedAudioTracks = existingAudioTracks + ${numAudio};
        if (afterVideoTracks < expectedVideoTracks || afterAudioTracks < expectedAudioTracks) {
          return JSON.stringify({
            success: false,
            error: "Premiere did not add the requested track",
            trackType: ${JSON.stringify(trackType)},
            position: ${JSON.stringify(position)},
            videoTracksBefore: existingVideoTracks,
            videoTracksAfter: afterVideoTracks,
            audioTracksBefore: existingAudioTracks,
            audioTracksAfter: afterAudioTracks,
            expectedVideoTracks: expectedVideoTracks,
            expectedAudioTracks: expectedAudioTracks
          });
        }

        return JSON.stringify({
          success: true,
          message: ${JSON.stringify(trackType)} + " track added at " + ${JSON.stringify(position)},
          trackType: ${JSON.stringify(trackType)},
          position: ${JSON.stringify(position)},
          videoTracksBefore: existingVideoTracks,
          videoTracksAfter: afterVideoTracks,
          audioTracksBefore: existingAudioTracks,
          audioTracksAfter: afterAudioTracks,
          newVideoTrackIndex: ${isVideo ? `(${JSON.stringify(position)} === 'above') ? existingVideoTracks : 0` : 'null'},
          newAudioTrackIndex: ${!isVideo ? `(${JSON.stringify(position)} === 'above') ? existingAudioTracks : 0` : 'null'}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
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

  protected async deleteTrack(
    sequenceId: string,
    trackType: string,
    trackIndex: number,
  ): Promise<any> {
    if (trackType === 'caption') {
      return {
        success: false,
        error:
          'Caption track deletion is not supported by Premiere Pro scripting. The ExtendScript DOM exposes no sequence.captionTracks/getCaptionTracks surface, and the QE DOM exposes no caption-track accessor or delete method.',
        sequenceId,
        trackType,
        trackIndex,
        unsupportedByPremiereApi: true,
        workaround:
          'Delete caption tracks manually in Premiere, or remove/recreate captions from the source .srt before creating the caption track.',
      };
    }

    // Premiere 26 exposes no DOM trackCollection.deleteTrack, so deletion falls through to the
    // QE DOM — and QE can only reach qe.project.getActiveSequence(). Rather than deleting a
    // track from whatever timeline happens to be on screen, refuse the cross-sequence case with
    // a truthful error that names the limitation.
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var tracks = ${trackType === 'video' ? 'sequence.videoTracks' : 'sequence.audioTracks'};
        if (${trackIndex} >= 0 && ${trackIndex} < tracks.numTracks) {
          var beforeCount = tracks.numTracks;
          var deleted = false;
          if (tracks.deleteTrack) {
            tracks.deleteTrack(${trackIndex});
            deleted = true;
          } else {
            // QE addresses sequences by index through getSequenceAt(), not
            // only whatever is active, so resolve by guid instead of refusing
            // every cross-sequence request. What QE actually limits is which
            // sequences it exposes at all — a sequence it cannot see is
            // reported as such, naming it, rather than deleting a track from
            // the timeline that happens to be on screen.
            var activeSeq = app.project.activeSequence;
            var qeSeq = __qeSequenceOpening(sequence);
            if (!qeSeq) {
              return JSON.stringify({
                success: false,
                error: "Track deletion needs the QE API, which cannot address sequence '" + sequence.name + "'. Premiere exposes no DOM track-deletion API, and QE only reaches sequences it has open. Open it in a timeline, or call set_active_sequence with " + sequence.sequenceID + ", then retry.",
                sequenceId: sequence.sequenceID,
                sequenceName: sequence.name,
                activeSequenceId: activeSeq ? activeSeq.sequenceID : null,
                requiresOpenSequence: true
              });
            }
            if (${trackType === 'video' ? 'true' : 'false'} && qeSeq.removeVideoTrack) {
              qeSeq.removeVideoTrack(${trackIndex});
              deleted = true;
            } else if (${trackType === 'audio' ? 'true' : 'false'} && qeSeq.removeAudioTrack) {
              qeSeq.removeAudioTrack(${trackIndex});
              deleted = true;
            }
          }
          var afterCount = tracks.numTracks;
          if (!deleted || afterCount >= beforeCount) {
            return JSON.stringify({
              success: false,
              error: "Premiere did not remove the requested track",
              beforeCount: beforeCount,
              afterCount: afterCount
            });
          }
          return JSON.stringify({
            success: true,
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            message: "Track deleted successfully",
            beforeCount: beforeCount,
            afterCount: afterCount
          });
        } else {
          return JSON.stringify({
            success: false,
            error: "Track index out of range"
          });
        }
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async lockTrack(
    sequenceId: string,
    trackType: string,
    trackIndex: number,
    locked: boolean,
  ): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var tracks = ${trackType === 'video' ? 'sequence.videoTracks' : 'sequence.audioTracks'};
        if (${trackIndex} >= 0 && ${trackIndex} < tracks.numTracks) {
          var lockTarget = tracks[${trackIndex}];
          // isLocked is a property on this API, not a method. Read it back rather
          // than trusting the void setLocked() call.
          var wasLocked = null; try { wasLocked = Boolean(lockTarget.isLocked); } catch (ePre) {}
          lockTarget.setLocked(${locked ? 1 : 0});
          var nowLocked = null; try { nowLocked = Boolean(lockTarget.isLocked); } catch (eLock) {}
          if (nowLocked !== null && nowLocked !== ${locked}) return JSON.stringify({ success: false, verified: true, verifiedBy: "Track.isLocked readback", before: wasLocked, after: nowLocked, changed: wasLocked !== nowLocked, error: "Premiere did not change the track lock state (still reads " + (nowLocked ? "locked" : "unlocked") + ")." });
          if (nowLocked === null) {
            return JSON.stringify({
              success: true, verified: false,
              unverifiedReason: "setLocked() did not throw, but Track.isLocked is not readable on this build, so the lock state cannot be confirmed.",
              sequenceId: sequence.sequenceID, sequenceName: sequence.name, before: wasLocked, locked: ${locked}
            });
          }
          return JSON.stringify({
            success: true,
            verified: true,
            verifiedBy: "Track.isLocked readback",
            changed: wasLocked !== nowLocked,
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            before: wasLocked,
            locked: ${locked},
            message: wasLocked === nowLocked
              ? ("Track was already " + (${locked} ? "locked" : "unlocked") + "; nothing changed.")
              : ("Track " + (${locked} ? "locked" : "unlocked"))
          });
        } else {
          return JSON.stringify({
            success: false,
            error: "Track index out of range"
          });
        }
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async toggleTrackVisibility(
    sequenceId: string,
    trackIndex: number,
    visible: boolean,
  ): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        if (${trackIndex} >= 0 && ${trackIndex} < sequence.videoTracks.numTracks) {
          // This used to call setTargeted(), which is the V1/A1 patch button, not the
          // eye. Track output was never touched and the caller's track targeting was
          // silently changed instead, under a response saying "Track visibility
          // toggled". On a video track, mute IS the eye: setMute(1) disables output.
          var visibilityTrack = sequence.videoTracks[${trackIndex}];
          if (!visibilityTrack.setMute) {
            return JSON.stringify({ success: false, error: "Track.setMute is unavailable on this build, so track output cannot be changed" });
          }
          visibilityTrack.setMute(${visible} ? 0 : 1);

          // Read it back: assignment is not evidence of effect anywhere else in this API.
          var nowMuted = null;
          try { nowMuted = visibilityTrack.isMuted ? visibilityTrack.isMuted() : null; } catch (eMuted) {}
          if (nowMuted !== null && nowMuted === ${visible}) {
            return JSON.stringify({
              success: false,
              error: "Premiere accepted the change but the track output did not move",
              requestedVisible: ${visible},
              muted: nowMuted
            });
          }

          return JSON.stringify({
            success: true,
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            trackIndex: ${trackIndex},
            visible: nowMuted === null ? ${visible} : !nowMuted,
            message: ${visible} ? "Track output enabled" : "Track output disabled"
          });
        } else {
          return JSON.stringify({
            success: false,
            error: "Track index out of range"
          });
        }
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async unnestSequence(nestedSequenceClipId: string): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(nestedSequenceClipId)});
        if (!info) return JSON.stringify({ success: false, error: "Nested sequence clip not found" });
        var parentSeq = app.project.activeSequence;
        if (!parentSeq) return JSON.stringify({ success: false, error: "No active parent sequence" });
        var nestedClip = info.clip;
        var nestedItem = nestedClip.projectItem;
        var nestedSeq = null;
        if (nestedItem && typeof nestedItem.getSequence === "function") {
          nestedSeq = nestedItem.getSequence();
        }
        if (!nestedSeq && nestedItem && app.project && app.project.sequences) {
          for (var ns = 0; ns < app.project.sequences.numSequences; ns++) {
            var candidateSeq = app.project.sequences[ns];
            if (candidateSeq && candidateSeq.name === nestedItem.name) {
              nestedSeq = candidateSeq;
              break;
            }
          }
        }
        if (!nestedSeq) return JSON.stringify({ success: false, error: "Project item did not return a nested sequence" });

        function secondsOf(value) {
          if (value === undefined || value === null) return 0;
          if (typeof value === "number") return value;
          if (value.seconds !== undefined) return Number(value.seconds);
          if (value.ticks !== undefined) return Number(value.ticks) / 254016000000.0;
          return 0;
        }

        var parentStart = secondsOf(nestedClip.start);
        var placed = [];
        var errors = [];
        function copyTrackItems(trackCollection, parentCollection, parentBaseTrack, trackType) {
          if (!trackCollection || !parentCollection) return;
          for (var t = 0; t < trackCollection.numTracks; t++) {
            var sourceTrack = trackCollection[t];
            var targetTrackIndex = parentBaseTrack + t;
            if (targetTrackIndex >= parentCollection.numTracks) {
              errors.push({ trackType: trackType, trackIndex: targetTrackIndex, error: "Parent track does not exist" });
              continue;
            }
            var targetTrack = parentCollection[targetTrackIndex];
            for (var c = 0; c < sourceTrack.clips.numItems; c++) {
              var sourceClip = sourceTrack.clips[c];
              if (!sourceClip || !sourceClip.projectItem) {
                errors.push({ trackType: trackType, trackIndex: t, clipIndex: c, error: "Nested clip has no source project item" });
                continue;
              }
              var targetTime = parentStart + secondsOf(sourceClip.start);
              try {
                targetTrack.overwriteClip(sourceClip.projectItem, targetTime);
                placed.push({
                  trackType: trackType,
                  sourceTrackIndex: t,
                  targetTrackIndex: targetTrackIndex,
                  clipIndex: c,
                  name: sourceClip.name,
                  time: targetTime
                });
              } catch (placeError) {
                errors.push({ trackType: trackType, trackIndex: t, clipIndex: c, error: placeError.toString() });
              }
            }
          }
        }

        copyTrackItems(nestedSeq.videoTracks, parentSeq.videoTracks, info.trackIndex, "video");
        copyTrackItems(nestedSeq.audioTracks, parentSeq.audioTracks, 0, "audio");

        if (!placed.length) {
          return JSON.stringify({ success: false, error: "No nested clips could be placed into the parent sequence", errors: errors });
        }

        nestedClip.remove(false, true);
        return JSON.stringify({
          success: true,
          message: "Nested sequence clip replaced with its child clips",
          nestedSequenceClipId: ${JSON.stringify(nestedSequenceClipId)},
          nestedSequenceId: nestedSeq.sequenceID,
          nestedSequenceName: nestedSeq.name,
          placedCount: placed.length,
          placed: placed,
          errors: errors
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Project Settings
  protected async getSequenceSettings(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) {
          return JSON.stringify({
            success: false,
            error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)}
          });
        }
        var settings = sequence.getSettings();
        return JSON.stringify({
          success: true,
          settings: {
            name: sequence.name,
            sequenceID: sequence.sequenceID,
            width: settings.videoFrameWidth,
            height: settings.videoFrameHeight,
            timebase: sequence.timebase,
            videoDisplayFormat: settings.videoDisplayFormat,
            audioChannelType: settings.audioChannelType,
            audioSampleRate: settings.audioSampleRate
          }
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

  protected async setSequenceSettings(sequenceId: string, settings: any): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        // This used to compare width and height, write nothing at all, and report
        // "Requested sequence settings already match the active Premiere sequence" —
        // two falsehoods in one line, since frameRate and pixelAspectRatio were never
        // even looked at, and the sequence operated on is the resolved one rather than
        // whatever is active. It also refused any frame size change on the grounds that
        // Premiere cannot do it, which is untrue: setSettings() resizes a sequence after
        // creation, verified live by taking one from 1920x1080 to 1280x720.
        var requested = ${JSON.stringify(settings || {})};
        if (!sequence.getSettings || !sequence.setSettings) {
          return JSON.stringify({ success: false, error: "Sequence settings API unavailable on this build" });
        }

        function readSettings(seq) {
          var g = seq.getSettings();
          var fps = null;
          try { fps = 254016000000 / parseInt(String(g.videoFrameRate.ticks), 10); } catch (eFps) {}
          return {
            width: Number(g.videoFrameWidth),
            height: Number(g.videoFrameHeight),
            frameRate: fps,
            pixelAspectRatio: String(g.videoPixelAspectRatio)
          };
        }

        var before = readSettings(sequence);
        var settingsObject = sequence.getSettings();
        var applied = [];

        if (requested.width !== undefined) { settingsObject.videoFrameWidth = Number(requested.width); applied.push("width"); }
        if (requested.height !== undefined) { settingsObject.videoFrameHeight = Number(requested.height); applied.push("height"); }

        if (requested.frameRate !== undefined) {
          // videoFrameRate is a Time expressed as ticks per frame, and it has to be
          // assigned as a STRING of ticks. Assigning the number is accepted without
          // complaint and then corrupts the value — the field reads back as 2^63 ticks,
          // which works out to a frame rate of 2.75e-08.
          settingsObject.videoFrameRate = String(Math.round(254016000000 / Number(requested.frameRate)));
          applied.push("frameRate");
        }

        if (requested.pixelAspectRatio !== undefined) {
          // Stored as an "N:M" string; a number throws "Illegal Parameter type".
          var parValue = requested.pixelAspectRatio;
          var parText = String(parValue);
          if (parText.indexOf(":") === -1) {
            var parNumber = Number(parValue);
            if (!isFinite(parNumber) || parNumber <= 0) {
              return JSON.stringify({ success: false, error: "pixelAspectRatio must be a positive number or an \\"N:M\\" ratio string." });
            }
            var denominator = 1000;
            var numerator = Math.round(parNumber * denominator);
            var a = numerator, b = denominator;
            while (b) { var t = a % b; a = b; b = t; }
            parText = (numerator / a) + ":" + (denominator / a);
          }
          settingsObject.videoPixelAspectRatio = parText;
          applied.push("pixelAspectRatio");
        }

        if (!applied.length) {
          return JSON.stringify({
            success: true,
            message: "No recognised settings were supplied, so nothing was changed",
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            settings: before,
            supported: ["width", "height", "frameRate", "pixelAspectRatio"],
            changed: false
          });
        }

        try {
          sequence.setSettings(settingsObject);
        } catch (eApply) {
          return JSON.stringify({
            success: false,
            error: "Premiere rejected the settings: " + eApply.toString(),
            sequenceId: sequence.sequenceID,
            sequenceName: sequence.name,
            attempted: applied,
            settings: before
          });
        }

        // Read back rather than trusting the write: several of these fields accept an
        // assignment and silently keep their old value.
        var after = readSettings(sequence);
        var unchanged = [];
        for (var ai = 0; ai < applied.length; ai++) {
          var field = applied[ai];
          if (String(after[field]) === String(before[field]) && String(requested[field]) !== String(before[field])) {
            unchanged.push(field);
          }
        }

        return JSON.stringify({
          success: unchanged.length === 0,
          error: unchanged.length ? "Premiere accepted the assignment but did not apply: " + unchanged.join(", ") : undefined,
          message: unchanged.length ? undefined : "Sequence settings applied",
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          applied: applied,
          before: before,
          after: after,
          changed: true
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async distributeClipsEvenly(
    trackIndex: number,
    clipIndices: number[],
    startSecs: number,
    endSecs: number,
    seqId?: string,
  ): Promise<any> {
    const n = clipIndices.length;
    if (n === 0) return { success: false, error: 'No clips specified' };
    const step = (endSecs - startSecs) / n;
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var indices=${JSON.stringify(clipIndices)};
        var step=${step};
        for(var i=0;i<indices.length;i++){
          var clip=seq.videoTracks[${trackIndex}].clips[indices[i]];
          if(!clip)continue;
          var t=new Time();t.seconds=${startSecs}+i*step;
          clip.move(t,${trackIndex});
        }
        return JSON.stringify({success:true,count:indices.length,step:step});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async snapClipsToGrid(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var tb=Number(seq.timebase)||10584000000;
        var moved=0;
        for(var t=0;t<seq.videoTracks.numTracks;t++){
          var track=seq.videoTracks[t];
          for(var c=0;c<track.clips.numItems;c++){
            var clip=track.clips[c];
            var startTicks=Number(clip.start.ticks);
            var snapped=Math.round(startTicks/tb)*tb;
            if(snapped!==startTicks){
              var nt=new Time();nt.ticks=String(snapped);clip.move(nt,t);moved++;
            }
          }
        }
        return JSON.stringify({success:true,clipsSnapped:moved});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async conformSequenceSettings(srcSeqId: string, tgtSeqId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seqs=app.project.sequences;
        var src=null,tgt=null;
        for(var i=0;i<seqs.numSequences;i++){if(seqs[i].sequenceID===${JSON.stringify(srcSeqId)})src=seqs[i];if(seqs[i].sequenceID===${JSON.stringify(tgtSeqId)})tgt=seqs[i];}
        if(!src||!tgt)return JSON.stringify({success:false,error:'Sequence not found'});
        tgt.frameSizeHorizontal=src.frameSizeHorizontal;tgt.frameSizeVertical=src.frameSizeVertical;
        return JSON.stringify({success:true,sourceSettings:{fps:src.frameSizeHorizontal,h:src.frameSizeVertical},targetUpdated:true});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async getSequenceInfoExtended(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var markerCount=0;var m=seq.markers.getFirstMarker();while(m){markerCount++;m=seq.markers.getNextMarker(m);}
        var clipCount=0;for(var t=0;t<seq.videoTracks.numTracks;t++)clipCount+=seq.videoTracks[t].clips.numItems;
        var qseq=${this.buildQSeqResolver(seqId)};
        return JSON.stringify({success:true,name:String(seq.name),sequenceID:String(seq.sequenceID),width:seq.frameSizeHorizontal,height:seq.frameSizeVertical,videoTracks:seq.videoTracks.numTracks,audioTracks:seq.audioTracks.numTracks,clipCount:clipCount,markerCount:markerCount,workAreaIn:seq.getWorkAreaInPoint?seq.getWorkAreaInPoint().seconds:0,workAreaOut:seq.getWorkAreaOutPoint?seq.getWorkAreaOutPoint().seconds:0,previewCodecPath:qseq?String(qseq.previewPresetPath):null});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async setSequenceZeroPoint(timecode: string, seqId?: string): Promise<any> {
    // Same operation as set_sequence_start_timecode; this one passed the timecode straight to
    // setZeroPoint (which takes ticks) and reported success with no readback.
    return await this.setSequenceStartTimecode(timecode, seqId);
  }

  protected async sequenceFromMarkers(seqId?: string, markerType = 'Chapter'): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        if(!seq)return JSON.stringify({success:false,error:'Sequence not found'});
        var markers=[];
        var m=seq.markers.getFirstMarker();
        while(m){if(String(m.type)===${JSON.stringify(markerType)})markers.push({name:String(m.name),start:m.start.seconds,end:m.end?m.end.seconds:m.start.seconds+5});m=seq.markers.getNextMarker(m);}
        // markerType goes through JSON.stringify, NOT raw interpolation. I wrote it raw inside a
        // single-quoted ExtendScript string two commits ago and the injection-guard suite caught
        // it: a quote in the value broke out of the literal and made the whole script
        // unparseable. Every caller-supplied string that reaches generated script has to be
        // escaped by the serialiser, never pasted.
        if(markers.length===0)return JSON.stringify({success:false,markerCount:0,error:'No markers of type '+${JSON.stringify(markerType)}+' were found, so no sequences were created.'});
        // createNewSequence OPENS THE NEW SEQUENCE DIALOG on this build. That is what wedged the
        // ExtendScript engine reproducibly in two overnight sweeps: a 45s timeout, a panel that
        // stopped polling, and a state indistinguishable from a dead engine (two Escapes cleared
        // it). Our own bridge already documents this — app.project.newSequence(name, presetPath)
        // is the non-interactive API — but this tool used the interactive one.
        //
        // Rewritten on createSubsequence, which is verified working and does what this tool
        // actually promised: a sequence per marker RANGE, with the content in it, rather than an
        // empty sequence named after a marker.
        var MAX_NEW=24;
        var created=[], failed=[];
        var capped=markers.length>MAX_NEW;
        var limit=capped?MAX_NEW:markers.length;
        var origIn=__seqInSeconds(seq), origOut=__seqOutSeconds(seq);
        for(var i=0;i<limit;i++){
          try{
            // Number arguments are SECONDS; a string would be read as ticks.
            seq.setInPoint(markers[i].start);
            seq.setOutPoint(markers[i].end);
            var sub=seq.createSubsequence(false);
            if(sub){
              try{ sub.projectItem.name=markers[i].name; }catch(eRen){}
              created.push(String(markers[i].name));
            } else {
              failed.push(markers[i].name+' (createSubsequence returned null)');
            }
          }catch(ec){failed.push(markers[i].name+' ('+ec.toString()+')');}
        }
        // Put the caller's in/out range back: this tool borrowed it as a mechanism and should not
        // leave it pointing at the last marker.
        try{ if(origIn!==null) seq.setInPoint(origIn); if(origOut!==null) seq.setOutPoint(origOut); }catch(eR){}
        return JSON.stringify({
          success:created.length>0, verified:true,
          markerCount:markers.length, sequencesCreated:created.length, createdNames:created,
          failed:failed, sequenceCountNow:app.project.sequences.numSequences,
          capped:capped,
          error:created.length===0?'No subsequences could be created; see failed[].':(capped?'Capped at '+MAX_NEW+' of '+markers.length+' markers to bound host work; re-run to continue.':null),
          note:'Each sequence covers its marker range and contains the clips in it, via createSubsequence. The sequence in/out points were used as the mechanism and have been restored.'
        });
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async getQeSequenceSettings(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var o = { success: true, name: String(seq.name) };
        try { o.editingModeGUID = String(seq.editingMode); } catch(x) {}
        try { o.videoFrameRate = String(seq.videoFrameRate); } catch(x) {}
        try { o.audioFrameRate = String(seq.audioFrameRate); } catch(x) {}
        try { o.videoDisplayFormat = String(seq.videoDisplayFormat); } catch(x) {}
        try { o.audioDisplayFormat = String(seq.audioDisplayFormat); } catch(x) {}
        try { o.fieldType = String(seq.fieldType); } catch(x) {}
        try { o.par = String(seq.par); } catch(x) {}
        try { o.multicam = String(seq.multicam); } catch(x) {}
        try { o.numVideoTracks = seq.numVideoTracks; } catch(x) {}
        try { o.numAudioTracks = seq.numAudioTracks; } catch(x) {}
        try { o.previewPresetPath = String(seq.previewPresetPath); } catch(x) {}
        try { o.previewPresetCodec = String(seq.previewPresetCodec); } catch(x) {}
        try { o.useMaxRenderQuality = seq.useMaxRenderQuality; } catch(x) {}
        try { o.useMaxBitDepth = seq.useMaxBitDepth; } catch(x) {}
        try { o.isOpen = seq.isOpen(); } catch(x) {}
        try { var pl = String(seq.presetList); o.presetListSample = pl.length > 200 ? pl.substring(0, 200) : pl; } catch(x) {}
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async setTrackLockQe(
    trackIndex: number,
    locked: boolean,
    audio: boolean,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var qeTrack = ${audio} ? seq.getAudioTrackAt(${trackIndex}) : seq.getVideoTrackAt(${trackIndex});
        if (!qeTrack) return JSON.stringify({ success: false, error: 'QE track ${trackIndex} not found' });
        var domSeq = app.project.activeSequence;
        var domTrack = ${audio} ? domSeq.audioTracks[${trackIndex}] : domSeq.videoTracks[${trackIndex}];
        var before = null;
        try { before = domTrack.isLocked(); } catch(x) {}
        qeTrack.setLock(${locked});
        var after = null;
        try { after = domTrack.isLocked(); } catch(x) {}
        return JSON.stringify({ success: true, verified: after === ${locked}, requested: ${locked},
          before: before, after: after, audio: ${audio},
          note: after === ${locked} ? undefined : 'Lock state did not read back as requested.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async attachSequenceCustomProperty(
    key: string,
    value: string,
    seqId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        seq.attachCustomProperty(${JSON.stringify(key)}, ${JSON.stringify(value)});
        return JSON.stringify({ success: true, verified: false, sequenceName: String(seq.name),
          key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)},
          note: 'No getter exists for custom properties, so this could not be read back.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async qeSequenceInfo(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq=${this.buildQSeqResolver(seqId)};
        if(!seq)return JSON.stringify({success:false,error:'No active QE sequence'});
        return JSON.stringify({success:true,name:String(seq.name),guid:String(seq.guid||''),CTI:{ticks:String(seq.CTI.ticks),secs:seq.CTI.secs},inPoint:{ticks:String(seq.inPoint.ticks)},outPoint:{ticks:String(seq.outPoint.ticks)},workInPoint:{ticks:String(seq.workInPoint.ticks)},workOutPoint:{ticks:String(seq.workOutPoint.ticks)},editingMode:String(seq.editingMode),numVideoTracks:seq.numVideoTracks,numAudioTracks:seq.numAudioTracks,previewPresetPath:String(seq.previewPresetPath||''),previewPresetCodec:String(seq.previewPresetCodec||''),useMaxBitDepth:seq.useMaxBitDepth,useMaxRenderQuality:seq.useMaxRenderQuality});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  // Active Sequence Management Implementation
  protected async setActiveSequence(sequenceId: string): Promise<any> {
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        app.project.openSequence(seq.sequenceID);
        var active = app.project.activeSequence;
        if (!active || String(active.sequenceID) !== String(seq.sequenceID)) return JSON.stringify({ success: false, verified: false, error: "Premiere did not make '" + seq.name + "' the active sequence.", requestedId: seq.sequenceID, activeId: active ? active.sequenceID : null });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Active sequence set",
          sequenceId: seq.sequenceID,
          name: seq.name
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async getActiveSequence(): Promise<any> {
    const script = `
      try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: "No active sequence" });
        return JSON.stringify({
          success: true,
          id: seq.sequenceID,
          name: seq.name,
          duration: __ticksToSeconds(seq.end),
          videoTrackCount: seq.videoTracks.numTracks,
          audioTrackCount: seq.audioTracks.numTracks
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Set Sequence In/Out Points Implementation
  protected async setSequenceInOutPoints(
    sequenceId: string | undefined,
    inPoint?: number,
    outPoint?: number,
  ): Promise<any> {
    const setIn = inPoint !== undefined;
    const setOut = outPoint !== undefined;
    // Premiere does not reject in >= out: it stores a collapsed range that reads back as about
    // -400000 s, which looked like a broken API in the sweep. Every argument form works when the
    // range is real (measured on 26.5.2), so refuse the degenerate request instead.
    if (setIn && setOut && !(Number(outPoint) > Number(inPoint))) {
      return {
        success: false,
        error: `outPoint (${outPoint}s) must be after inPoint (${inPoint}s). Nothing was changed.`,
      };
    }
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        ${setIn ? 'seq.setInPoint(__secondsToTicks(' + inPoint + '));' : ''}
        ${setOut ? 'seq.setOutPoint(__secondsToTicks(' + outPoint + '));' : ''}
        var inReadback = null, outReadback = null;
        try { inReadback = seq.getInPointAsTime().seconds; } catch (eIn) {}
        try { outReadback = seq.getOutPointAsTime().seconds; } catch (eOut) {}
        var ioTol = 0.04;
        ${setIn ? 'if (inReadback === null || Math.abs(inReadback - ' + inPoint + ') > ioTol) return JSON.stringify({ success: false, verified: false, error: "setInPoint() ran but the sequence in point reads back as " + inReadback + " s, not the requested ' + inPoint + ' s.", sequenceId: ' + JSON.stringify(sequenceId) + ', inPoint: inReadback });' : ''}
        ${setOut ? 'if (outReadback === null || Math.abs(outReadback - ' + outPoint + ') > ioTol) return JSON.stringify({ success: false, verified: false, error: "setOutPoint() ran but the sequence out point reads back as " + outReadback + " s, not the requested ' + outPoint + ' s.", sequenceId: ' + JSON.stringify(sequenceId) + ', outPoint: outReadback });' : ''}
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Sequence in/out points set",
          sequenceId: ${JSON.stringify(sequenceId)},
          inPoint: inReadback,
          outPoint: outReadback
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Get Sequence In/Out Points Implementation
  protected async getSequenceInOutPoints(sequenceId: string): Promise<any> {
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var inTime = seq.getInPointAsTime();
        var outTime = seq.getOutPointAsTime();
        return JSON.stringify({
          success: true,
          sequenceId: ${JSON.stringify(sequenceId)},
          inPoint: inTime.seconds,
          outPoint: outTime.seconds
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Create Subsequence Implementation
  protected async createSubsequence(
    sequenceId: string,
    ignoreTrackTargeting?: boolean,
  ): Promise<any> {
    const ignoreTargeting = ignoreTrackTargeting ? 'true' : 'false';
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var subseq = seq.createSubsequence(${ignoreTargeting});
        return JSON.stringify({
          success: true,
          message: "Subsequence created",
          sequenceId: subseq.sequenceID,
          name: subseq.name
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  /**
   * The bin lookup scanned rootItem.children one level deep and did not check that the match
   * was a bin, so a nested bin -- which is what create_bin returns whenever a parent is named --
   * could not be reached at all, and a CLIP sharing the name would win. Uses the shared
   * __resolveBin prelude helper (id, "/"-separated path, or deep name with an ambiguity refusal).
   */
  protected async createSequenceFromBin(
    binName: string,
    seqName: string,
    presetPath?: string,
    binId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var req = __resolveBin(${JSON.stringify(binId ?? null)}, ${JSON.stringify(binName)});
        if (req.error) return JSON.stringify({success:false,error:req.error+' No sequence was created.',binName:${JSON.stringify(binName)},binId:${JSON.stringify(binId ?? null)},matchCount:req.matchCount});
        var bin = req.bin;
        var items = [];
        for (var j=0;j<bin.children.numItems;j++) {
          if (bin.children[j].type === 1) items.push(bin.children[j]);
        }
        if (items.length === 0) return JSON.stringify({success:false,error:'No footage items in bin "'+String(bin.name)+'" ('+String(bin.treePath)+'). No sequence was created.',binId:String(bin.nodeId)});
        // The third argument is the DESTINATION BIN, not a preset: a path string here raised
        // "Illegal Parameter type" on every call. The sequence takes its settings from the clips.
        var seq = app.project.createNewSequenceFromClips(${JSON.stringify(seqName)}, items, app.project.rootItem);
        if (!seq) return JSON.stringify({success:false,error:'createNewSequenceFromClips returned null'});
        return JSON.stringify({success:true,presetPathIgnored:${JSON.stringify(Boolean(presetPath))},sequenceId:String(seq.sequenceID),name:String(seq.name),clipCount:items.length,
          binId:String(bin.nodeId),binName:String(bin.name),binResolvedBy:req.resolvedBy});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async clearSequenceInOut(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = __findSequence(${JSON.stringify(seqId ?? null)});
        if (!seq) return JSON.stringify({success:false,error:'Sequence not found'});
        // clearInPoint/clearOutPoint are ProjectItem methods and are UNDEFINED on Sequence
        // (measured on 26.3.2), so this threw on every call. There is no true "clear" for a
        // sequence in/out range — an unset range simply reads back as 0 .. sequence end — so
        // resetting to the full sequence is the honest equivalent, and the response says so
        // rather than implying a clear happened.
        var endTicks = __seqEndTicks(seq);
        if (endTicks === null) return JSON.stringify({success:false,verified:false,error:'Could not read the sequence end time, so the in/out range was left unchanged.'});
        var beforeIn = __seqInSeconds(seq), beforeOut = __seqOutSeconds(seq);
        // Number arguments are SECONDS here; a STRING argument would be interpreted as ticks.
        seq.setInPoint(0);
        seq.setOutPoint(endTicks / 254016000000);
        var afterIn = __seqInSeconds(seq), afterOut = __seqOutSeconds(seq);
        var full = afterIn !== null && afterOut !== null && Math.abs(afterIn) < 0.04
          && Math.abs(afterOut - endTicks / 254016000000) < 0.04;
        return JSON.stringify({
          success: full, verified: afterIn !== null && afterOut !== null,
          changed: afterIn !== beforeIn || afterOut !== beforeOut,
          before: { inSeconds: beforeIn, outSeconds: beforeOut },
          after: { inSeconds: afterIn, outSeconds: afterOut },
          note: 'Premiere exposes no clear for a sequence in/out range; it was reset to span the whole sequence, which is what an unset range reads back as.',
          error: full ? null : 'The in/out range did not reset to the full sequence.',
          sequenceName: String(seq.name)
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setSequenceStartTimecode(timecode: string, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        // Reported success with no readback of any kind. setZeroPoint takes TICKS as a string;
        // a timecode string is not a tick count, so this call was very likely inert.
        var before = null; try { before = String(seq.zeroPoint); } catch(eB) {}
        var wantTicks = __timecodeToTicks(seq, ${JSON.stringify(String(timecode))});
        if (wantTicks === null) return JSON.stringify({success:false,error:'Could not read timecode "' + ${JSON.stringify(String(timecode))} + '". Pass HH:MM:SS:FF, HH;MM;SS;FF (drop-frame) or seconds.'});
        var setError = null;
        try { seq.setZeroPoint(wantTicks); } catch(eS) { setError = eS.toString(); }
        var after = null; try { after = String(seq.zeroPoint); } catch(eA) {}
        if (after === null) {
          return JSON.stringify({success:true,verified:false,timecode:${JSON.stringify(timecode)},sequenceName:String(seq.name),before:before,setError:setError,
            unverifiedReason:'Sequence.zeroPoint is not readable on this build, so the start timecode cannot be confirmed.'});
        }
        if (after !== wantTicks) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'Sequence.zeroPoint readback',changed:after!==before,timecode:${JSON.stringify(timecode)},sequenceName:String(seq.name),before:before,after:after,wantTicks:wantTicks,setError:setError,
            error:'The sequence zero point reads ' + after + ' ticks, not the ' + wantTicks + ' that ' + ${JSON.stringify(String(timecode))} + ' converts to.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'Sequence.zeroPoint readback',changed:after!==before,timecode:${JSON.stringify(timecode)},sequenceName:String(seq.name),before:before,after:after});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getSequenceDuration(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({success:false,error:'Sequence not found'});
        // seq.end is TICKS, not a Time. .seconds was undefined, which made frames NaN and
        // reported a sequence with no duration at all.
        var endSecs = __seqEndSeconds(seq);
        if (endSecs === null) return JSON.stringify({success:false,error:'Could not read the sequence end time.'});
        var fps = seq.timebase ? (254016000000 / Number(seq.timebase)) : 24;
        var frames = Math.round(endSecs * fps);
        return JSON.stringify({success:true,sequenceName:String(seq.name),durationSecs:endSecs,frames:frames,fps:fps,width:seq.frameSizeHorizontal,height:seq.frameSizeVertical});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
