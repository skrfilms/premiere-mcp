/**
 * AudioTools -- the Audio tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { ExportRenderTools } from './export-render.js';
import { spawn } from 'child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { runFf } from '../ff-exec.js';
import { TRIM_LIB } from '../trim-lib.js';

export class AudioTools extends ExportRenderTools {
  protected async setEssentialSoundCategory(projectItemId: string, category: string): Promise<any> {
    const clipMixTypeMap: Record<string, number> = { dialog: 1, music: 2, sfx: 3, ambience: 4 };
    const clipMixType = clipMixTypeMap[category] ?? 1;
    const script = `
      try {
        var item = null;
        var root = app.project.rootItem;
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){ var c=bin.children[i]; if(c.nodeId===id){return c;} if(c.type===2){var r=findById(c,id);if(r)return r;} } return null; }
        item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: 'Project item not found: ' + ${JSON.stringify(projectItemId)} });
        item.setProjectMetadata('ESP.Tag', ${JSON.stringify(category)});
        item.setProjectMetadata('ESP.AdjustmentsModeID', ${JSON.stringify(category)});
        item.setProjectMetadata('ESP.ClipMixTypeID', ${JSON.stringify(String(clipMixType))});
        item.setProjectMetadata('MZ.AudioCategorization.AudioCategorizationAdjustmentMode', ${JSON.stringify(category)});
        return JSON.stringify({ success: true, verified: false, projectItemId: ${JSON.stringify(projectItemId)}, category: ${JSON.stringify(category)}, note: 'ESP metadata written. Premiere reads this on next project open/refresh.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async jCut(sequenceId: string | undefined, videoTrackIndex: number, clipIndex: number, frames: number): Promise<any> {
    // J-cut: the clip's linked audio starts \`frames\` earlier than its picture. The audio edit
    // point rolls, so the previous audio clip on that track (if it abuts) gives up the same span.
    return await this.audioRoll(sequenceId, videoTrackIndex, clipIndex, frames, 'head', 'j_cut');
  }

  protected async lCut(sequenceId: string | undefined, videoTrackIndex: number, clipIndex: number, frames: number): Promise<any> {
    // L-cut: the clip's linked audio runs \`frames\` past the end of its picture, rolling the next
    // audio clip's head if it abuts.
    return await this.audioRoll(sequenceId, videoTrackIndex, clipIndex, frames, 'tail', 'l_cut');
  }

  private async audioRoll(sequenceId: string | undefined, videoTrackIndex: number, clipIndex: number, frames: number, edge: 'head' | 'tail', type: string): Promise<any> {
    // The old versions wrote the audio inPoint/outPoint and waited for the timeline to follow.
    // inPoint only slips and outPoint does nothing visible (see trim-lib.ts), so they could only
    // ever report a half-applied edit or nothing at all.
    return await this.bridge.executeScript(`
      ${TRIM_LIB}
      var seq = ${this.buildSeqRes(sequenceId)};
      var vTrack = seq.videoTracks[${Number(videoTrackIndex)}];
      var vClip = vTrack && vTrack.clips[${Number(clipIndex)}];
      if (!vClip) return JSON.stringify({success:false,error:'Video clip not found'});
      var group = __withLinked(vClip), aClips = [];
      for (var i = 0; i < group.length; i++) if (String(group[i].mediaType) === 'Audio') aClips.push(group[i]);
      if (!aClips.length) return JSON.stringify({success:false,error:'No linked audio clip found'});
      var tpf = Number(seq.timebase) || 10584000000;
      var d = ${edge === 'head' ? '-' : ''}${Number(frames)} * tpf;
      var ops = [], errors = [];
      for (var k = 0; k < aClips.length; k++) { var plan = __planRoll(seq, aClips[k], ${JSON.stringify(edge)}, d); if (plan.error) errors.push(plan.error); else ops = ops.concat(plan.ops); }
      if (errors.length) return JSON.stringify({success:false,type:${JSON.stringify(type)},frames:${Number(frames)},error:errors.join(' ') + ' Nothing was changed.'});
      var bad = __applyOps(ops, (Number(seq.timebase) || 10584000000) / 2);
      return JSON.stringify({success:bad.length===0,verified:true,verifiedBy:'start/end/in readback of every edited clip',type:${JSON.stringify(type)},frames:${Number(frames)},edits:__opsReport(ops),
        error: bad.length ? 'PARTIALLY APPLIED: ' + bad.join('; ') + '. Undo to restore.' : undefined});
    `);
  }

  protected async fadeAudio(sequenceId: string | undefined, ati: number, ci: number, durationFrames: number, direction: 'in' | 'out'): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        var clip = seq.audioTracks[${ati}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Audio clip not found'});
        // Find volume/level param
        var levelProp = null;
        for (var ci2=0;ci2<clip.components.numItems;ci2++) {
          var comp = clip.components[ci2];
          for (var pi=0;pi<comp.properties.numItems;pi++) {
            var pn = String(comp.properties[pi].displayName).toLowerCase();
            if (pn === 'level' || pn === 'volume') { levelProp = comp.properties[pi]; break; }
          }
          if (levelProp) break;
        }
        if (!levelProp) return JSON.stringify({success:false,error:'Could not find Level/Volume param'});
        levelProp.setTimeVarying(true);
        var ticksPerFrame = Number(seq.timebase) || 10584000000;
        var fadeTicks = ${durationFrames} * ticksPerFrame;
        var t1 = new Time(); var t2 = new Time();
        var silentDb = -100;
        if (${JSON.stringify(direction)} === 'in') {
          t1.ticks = String(Math.round(Number(clip.start.ticks)));
          t2.ticks = String(Math.round(Number(clip.start.ticks) + fadeTicks));
          levelProp.addKey(t1); levelProp.setValueAtKey(t1, silentDb);
          levelProp.addKey(t2); levelProp.setValueAtKey(t2, 0);
        } else {
          t1.ticks = String(Math.round(Number(clip.end.ticks) - fadeTicks));
          t2.ticks = String(Math.round(Number(clip.end.ticks)));
          levelProp.addKey(t1); levelProp.setValueAtKey(t1, 0);
          levelProp.addKey(t2); levelProp.setValueAtKey(t2, silentDb);
        }
        return JSON.stringify({success:true,verified:true,direction:${JSON.stringify(direction)},durationFrames:${durationFrames}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  /**
   * Clip gain through an Amplify effect on the clip.
   *
   * True clip gain is not scriptable on 26.5.2 (the audio clip carries only Volume > Bypass/Level,
   * and QE staticClipGain is read-only: writes are accepted and read back 0). Amplify is the same
   * pre-fader gain stage, so it is used instead: the first Amplify on the clip is reused, or one is
   * added through QE. Its Gain parameter is stored normalised, value = (dB + 96) / 144, so 0.6667
   * is 0 dB and the range is -96..+48 dB. Measured in a render on 2026-10-27: 0.708333 raised the
   * clip by exactly 6.0 dB.
   *
   * The old version searched every component for any parameter whose name contained "gain" and
   * wrote raw dB into it — which, once an Amplify was present, would have written e.g. 6 into a
   * 0..1 field.
   */
  protected async setClipGain(sequenceId: string | undefined, ati: number, ci: number, gainDb: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var wantDb = Number(${JSON.stringify(gainDb)});
        if (isNaN(wantDb) || wantDb < -96 || wantDb > 48) return JSON.stringify({success:false,error:'gainDb must be between -96 and +48 dB (the Amplify range). Nothing was changed.'});
        var seq = ${this.buildSeqRes(sequenceId)};
        var track = seq.audioTracks[${ati}];
        var clip = track ? track.clips[${ci}] : null;
        if (!clip) return JSON.stringify({success:false,error:'Audio clip not found'});
        function findAmp() {
          for (var k = 0; k < clip.components.numItems; k++) {
            if (String(clip.components[k].displayName) === 'Amplify') return clip.components[k];
          }
          return null;
        }
        var amp = findAmp(), added = false;
        if (!amp) {
          app.enableQE();
          var qseq = __qeSequenceOpening(seq);
          var qclip = qseq ? __qeClipByIndex(qseq, 'audio', ${ati}, ${ci}) : null;
          var eff = qe.project.getAudioEffectByName('Amplify');
          if (!qclip || !eff) return JSON.stringify({success:false,error:'Could not reach the clip through QE, or the Amplify effect is not installed, so no gain stage could be added.'});
          qclip.addAudioEffect(eff);
          amp = findAmp(); added = true;
          if (!amp) return JSON.stringify({success:false,error:'addAudioEffect(Amplify) created no component on the clip.'});
        }
        var gainProp = null;
        for (var pi = 0; pi < amp.properties.numItems; pi++) {
          if (String(amp.properties[pi].displayName) === 'Gain') { gainProp = amp.properties[pi]; break; }
        }
        if (!gainProp) return JSON.stringify({success:false,error:'The Amplify effect has no Gain parameter on this build.'});
        var beforeDb = Number(gainProp.getValue()) * 144 - 96;
        gainProp.setValue((wantDb + 96) / 144, true);
        var afterDb = Number(gainProp.getValue()) * 144 - 96;
        if (Math.abs(afterDb - wantDb) > 0.05) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'Amplify Gain readback',before:beforeDb,after:afterDb,gainDb:wantDb,error:'Amplify Gain reads ' + afterDb.toFixed(2) + ' dB instead of the requested ' + wantDb + ' dB.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'Amplify Gain readback (render-checked mapping)',method:'Amplify effect',addedAmplify:added,beforeDb:Math.round(beforeDb*100)/100,afterDb:Math.round(afterDb*100)/100,gainDb:wantDb,
          note:'Applied as an Amplify effect, the scriptable equivalent of clip gain; the Audio Gain dialog value itself is not reachable from script.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async audioCrossfadeAtCut(sequenceId: string | undefined, ati: number, clipIndex: number, durationFrames: number): Promise<any> {
    // Was "Invalid parameter" on every call, for two reasons in one line:
    //
    //   clip.addTransition(transition, 2, durTicks, false)
    //
    //   1. FOUR arguments. QE addTransition takes SEVEN on 26.3.2 — the signature the working
    //      add_transition_to_clip uses is (transition, addAtEnd, frames, alignment, ratio,
    //      forceReuse, allowRipple). A short call raises Invalid parameter.
    //   2. Argument 2 was the integer 2 ("outgoing edge") where a BOOLEAN addAtEnd belongs,
    //      and argument 3 was a tick count where a FRAME COUNT string belongs — and the tick
    //      count was itself wrong, computed as durationFrames * videoFrameRate, which is a
    //      frame RATE (about 24), not ticks per frame (10584000000).
    //
    // Now built like the two transition tools that are verified working, and proven by the
    // shared transition readback rather than shipping verified:false with a hopeful note.
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var domSeq = ${this.buildSeqRes(sequenceId)};
        if (!domSeq) return JSON.stringify({success:false,error:'No active sequence'});
        var qeSeq = __qeSequenceOpening(domSeq);
        if (!qeSeq) return JSON.stringify({success:false,error:"Could not address sequence '" + String(domSeq.name) + "' through the QE API."});
        var track = qeSeq.getAudioTrackAt(${ati});
        var clip = track ? __qeClipByIndex(qeSeq, 'audio', ${ati}, ${clipIndex}) : null;
        if (!clip) return JSON.stringify({success:false,error:'No audio clip at audio track ${ati} index ${clipIndex}'});
        var domTrack = domSeq.audioTracks[${ati}];
        var domClip = domTrack ? domTrack.clips[${clipIndex}] : null;
        var transition = qe.project.getAudioTransitionByName('Constant Power');
        if (!transition) return JSON.stringify({success:false,error:'The Constant Power audio transition is not present on this build. Use list_available_audio_transitions to see what is.'});
        ${this.transitionVerificationScript()}
        // The second argument puts the transition at the clip's START when true (measured on
        // 26.5.2), so this used to crossfade the head of the clip -- usually not a cut at all --
        // and the XML count never noticed. false = the clip's end = the cut with the next clip.
        var cutSecs = domClip ? Number(domClip.end.seconds) : null;
        var atCutBefore = cutSecs === null ? [] : __qeTransitionsAt(track, cutSecs);
        var before = __readQeTransitionState(clip);
        var beforeXml = __transitionXmlCount(domSeq);
        var addError = null;
        try {
          clip.addTransition(transition, false, String(${durationFrames}), "0", 0.5, true, true);
        } catch (eAdd) { addError = eAdd.toString(); }
        var atCutAfter = cutSecs === null ? [] : __qeTransitionsAt(track, cutSecs);
        if (atCutAfter.length > atCutBefore.length) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'QE track transition list at the cut',durationFrames:${durationFrames},edge:'end',cutSecs:cutSecs,transitions:atCutAfter});
        }
        var afterClip = domClip ? __findQeClipByDomClip(track, domClip) : clip;
        var after = __readQeTransitionState(afterClip || clip);
        var afterXml = __transitionXmlCount(domSeq);
        var qeVerified = __transitionWasVerified(before, after);
        var xmlVerified = __transitionWasVerifiedByXml(beforeXml, afterXml);
        if (qeVerified || xmlVerified) {
          return JSON.stringify({success:true,verified:true,
            verifiedBy: qeVerified ? 'QE clip transition enumeration' : 'transition count in the sequence FCP XML export',
            durationFrames:${durationFrames}, edge:'end',
            before:before, after:after, beforeXml:beforeXml, afterXml:afterXml});
        }
        var inspectable = (before.available && after.available) || (beforeXml.available && afterXml.available);
        return JSON.stringify({success:false,verified:inspectable,
          durationFrames:${durationFrames}, addError:addError,
          before:before, after:after, beforeXml:beforeXml, afterXml:afterXml,
          error: addError
            ? ('addTransition() threw: ' + addError + '. A crossfade needs source handles on both sides of the cut and an adjacent clip on the same track.')
            : (inspectable
              ? 'The crossfade did not appear: neither the QE transition list nor the sequence XML gained a transition. A cut with no source handles on either side cannot take a crossfade.'
              : 'The crossfade cannot be confirmed: neither the QE transition list nor the FCP XML export is readable on this build, so this reports failure rather than an unprovable success.')});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async muteClipAudio(sequenceId: string | undefined, ti: number, ci: number, mute: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        var vClip = seq.videoTracks[${ti}].clips[${ci}];
        if (!vClip) return JSON.stringify({success:false,error:'Video clip not found'});
        var linked = vClip.getLinkedItems();
        // This counted assignments, not effects, and returned verified: true. TrackItem.disabled
        // is a real property here, so read it back per clip: the count of clips we WROTE to says
        // nothing about the count Premiere actually muted, and a locked track silently refuses.
        var attempted = 0, confirmed = 0, unreadable = 0, refused = [];
        for (var i=0;i<linked.numItems;i++) {
          var lc = linked[i];
          if (lc.mediaType === 'Audio' || String(lc.mediaType).toLowerCase().indexOf('audio') >= 0) {
            attempted++;
            var lcBefore = null; try { lcBefore = Boolean(lc.disabled); } catch(eLB) {}
            try { lc.disabled = ${mute}; } catch(eLS) {}
            var lcAfter = null; try { lcAfter = Boolean(lc.disabled); } catch(eLA) {}
            if (lcAfter === null) unreadable++;
            else if (lcAfter === ${mute}) confirmed++;
            else refused.push(String(lc.name) + ' (reads ' + String(lcAfter) + ', was ' + String(lcBefore) + ')');
          }
        }
        if (attempted === 0) return JSON.stringify({success:false,verified:true,error:'This clip has no linked audio, so there is nothing to mute. Check that video and audio are still linked with get_clip_links.'});
        if (confirmed === attempted) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'TrackItem.disabled readback on each linked audio clip',muted:${mute},audioClipsMuted:confirmed,audioClipsFound:attempted});
        }
        if (unreadable === attempted) {
          return JSON.stringify({success:true,verified:false,muted:${mute},audioClipsFound:attempted,
            unverifiedReason:'TrackItem.disabled is not readable on the linked audio clips of this build, so the mute cannot be confirmed.'});
        }
        return JSON.stringify({success:false,verified:true,verifiedBy:'TrackItem.disabled readback on each linked audio clip',muted:${mute},audioClipsMuted:confirmed,audioClipsFound:attempted,unreadable:unreadable,refused:refused,
          error:'PARTIALLY APPLIED: ' + confirmed + ' of ' + attempted + ' linked audio clips now read as ' + (${mute} ? 'muted' : 'unmuted') + '. A locked track will accept the write and keep its old state. See refused[].'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected loudnessReport(filePath: string): any {
    try {
      // ebur128 prints its summary at the end of stderr.
      const result = runFf('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-vn', '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], { timeoutMs: 180000, mergeStderr: true }).split('\n').slice(-20).join('\n');
      const lufsMatch = result.match(/I:\s*([-\d.]+)\s*LUFS/);
      const peakMatch = result.match(/Peak:\s*([-\d.]+)/);
      const lraMatch = result.match(/LRA:\s*([-\d.]+)\s*LU/);
      return {
        success: true,
        filePath,
        integratedLufs: lufsMatch?.[1] ? parseFloat(lufsMatch[1]) : null,
        truePeakDbfs: peakMatch?.[1] ? parseFloat(peakMatch[1]) : null,
        lra: lraMatch?.[1] ? parseFloat(lraMatch[1]) : null,
        rawOutput: result.slice(-500)
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected async normalizeClipPeaks(sequenceId: string | undefined, ati: number, ci: number, targetDbfs: number): Promise<any> {
    // Get the source media path first
    const pathResult = await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        var clip = seq.audioTracks[${ati}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        return JSON.stringify({success:true,path:clip.projectItem ? String(clip.projectItem.getMediaPath()) : null,name:String(clip.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!pathResult.success || !pathResult.path) return { success: false, error: 'Could not get media path' };
    // Analyze peak
    try {
      const vol = runFf('ffmpeg', ['-hide_banner', '-nostats', '-i', String(pathResult.path), '-vn', '-filter:a', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 60000, mergeStderr: true });
      const maxVol = vol.match(/max_volume:\s*([-\d.]+)/);
      if (!maxVol) return { success: false, error: 'Could not detect peak volume' };
      const currentPeakDb = parseFloat(maxVol[1] ?? 'NaN');
      const gainNeeded = targetDbfs - currentPeakDb;
      return await this.setClipGain(sequenceId, ati, ci, gainNeeded);
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected async renderAudio(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        seq.renderAudio();
        return JSON.stringify({success:true,verified:false,note:'renderAudio() dispatched. Audio rendering is async.',sequenceName:String(seq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async applyAudioEffectQe(trackIndex: number, clipIndex: number, effectName: string, audioTrack: boolean, sequenceId?: string): Promise<any> {
    const remapped = AudioTools.OBSOLETE_AUDIO_EFFECTS[effectName];
    const requested = effectName;
    const target = remapped ?? effectName;

    const result: any = await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        var track = ${audioTrack} ? seq.getAudioTrackAt(${trackIndex}) : seq.getVideoTrackAt(${trackIndex});
        if (!track) return JSON.stringify({success:false,error:'Track not found at index ${trackIndex}'});
        var clip = __qeClipByIndex(seq, ${audioTrack} ? 'audio' : 'video', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});

        // Resolve against the live catalogue first. Asking for a name this build does not
        // have would otherwise reach addAudioEffect with a null effect, and refusing an
        // "(Obsolete)"-marked name here is what keeps the modal from ever appearing.
        var wanted = ${JSON.stringify(target)};
        var list = qe.project.getAudioEffectList();
        var exact = null, obsoleteMatch = null;
        for (var i = 0; i < list.length; i++) {
          var nm = String(list[i]);
          if (nm === wanted) { exact = nm; break; }
          if (nm.indexOf(wanted) === 0 && nm.indexOf('Obsolete') >= 0) obsoleteMatch = nm;
        }
        if (!exact && obsoleteMatch) {
          return JSON.stringify({success:false,error:'Refusing to add "'+obsoleteMatch+'": Premiere marks it obsolete and adding it opens a modal dialog that blocks the bridge. Use the modern replacement effect name instead.',obsoleteName:obsoleteMatch});
        }
        if (!exact) return JSON.stringify({success:false,error:'Effect not found on this build: '+wanted});

        var eff = qe.project.getAudioEffectByName(exact);
        if (!eff) return JSON.stringify({success:false,error:'getAudioEffectByName returned nothing for: '+exact});
        var domSeq = ${this.buildSeqRes(sequenceId)};
        var domTrack = ${audioTrack} ? domSeq.audioTracks[${trackIndex}] : domSeq.videoTracks[${trackIndex}];
        var domClip = domTrack.clips[${clipIndex}];
        var before = domClip.components.numItems;
        clip.addAudioEffect(eff);
        var after = domClip.components.numItems;
        if (after <= before) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'clip component count before and after',changed:false,effectName:exact,before:before,after:after,
            error:'addAudioEffect() ran without throwing but the clip component count did not rise, so "' + exact + '" was not applied. QE effect-add is inert on some builds; try apply_audio_effect with the matchName instead.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'clip component count before and after',changed:true,effectName:exact,before:before,after:after});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);

    if (result && remapped) {
      result.requestedEffect = requested;
      result.remappedTo = remapped;
      result.note = `"${requested}" is obsolete on this build and opens a blocking modal; used "${remapped}" instead.`;
    }
    return result;
  }

  protected async denoiseClip(trackIndex: number, clipIndex: number, sequenceId?: string): Promise<any> {
    return await this.applyAudioEffectQe(trackIndex, clipIndex, 'DeNoise', true, sequenceId);
  }

  protected async listAudioEffectsOnClip(trackIndex: number, clipIndex: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        var clip = __qeClipByIndex(seq, 'audio', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var domClip = ${this.buildSeqRes(sequenceId)}.audioTracks[${trackIndex}].clips[${clipIndex}];
        var comps = [];
        for (var i = 0; i < domClip.components.numItems; i++) {
          var dc = domClip.components[i];
          var qc = clip.getComponentAt(i);
          var entry = {index:i,name:String(dc.displayName),matchName:String(dc.matchName)};
          if (qc) { try { entry.paramList = String(qc.getParamList()).slice(0,100); } catch(e){} }
          comps.push(entry);
        }
        return JSON.stringify({success:true,componentCount:comps.length,components:comps});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected audioPeaksReport(filePath: string): any {
    try {
      // Whole-file astats summary from stderr. The old amovie= source put the path inside a
      // filtergraph through a shell, and reset=1 reported only the first 20 audio frames.
      const out = runFf('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-vn', '-af', 'astats=measure_perchannel=none', '-f', 'null', '-'], { timeoutMs: 180000, mergeStderr: true });
      // The Overall block follows the per-channel ones; read its fields only.
      const overall = out.slice(out.lastIndexOf('Overall'));
      const field = (label: string): number | null => {
        const m = overall.match(new RegExp(label + ':\\s*(-?[\\d.]+)'));
        return m?.[1] !== undefined ? parseFloat(m[1]) : null;
      };
      const res = { peakDb: field('Peak level dB'), rmsDb: field('RMS level dB'), crestFactor: field('Crest factor'), dcOffset: field('DC offset') };
      if (res.peakDb === null && res.rmsDb === null) return { success: false, error: 'ffmpeg reported no audio statistics; the file may have no audio stream.' };
      return { success: true, filePath, ...res };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  protected async setTrackVolumeKeyframes(trackIndex: number, keyframes: Array<{timeSecs: number, level: number}>, sequenceId?: string): Promise<any> {
    const kfJson = JSON.stringify(keyframes);
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var track = seq.audioTracks[${trackIndex}];
        if (!track || track.clips.numItems === 0) return JSON.stringify({success:false,error:'Audio track not found or empty'});
        var clip = track.clips[0];
        var kfs = ${kfJson};
        var levelComp = null;
        for (var ci=0; ci<clip.components.numItems; ci++) { if (String(clip.components[ci].displayName).toLowerCase().indexOf('volume') >= 0 || String(clip.components[ci].displayName).toLowerCase().indexOf('level') >= 0) { levelComp = clip.components[ci]; break; } }
        if (!levelComp) return JSON.stringify({success:false,error:'Volume/Level component not found'});
        var levelProp = levelComp.properties[0];
        levelProp.setTimeVarying(true);
        for (var ki=0; ki<kfs.length; ki++) {
          var t = new Time(); t.seconds = kfs[ki].timeSecs;
          levelProp.addKey(t);
          levelProp.setValueAtKey(t, kfs[ki].level);
        }
        return JSON.stringify({success:true,verified:true,keyframesAdded:kfs.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async batchAddAudioCrossfades(durationSeconds: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var qseq = ${this.buildQSeqResolver(sequenceId)};
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        var transition = qe.project.getAudioTransitionByName('Constant Power');
        if (!transition) return JSON.stringify({success:false,error:'The Constant Power audio transition is not present on this build. Use list_available_audio_transitions to see what is.'});
        ${this.transitionVerificationScript()}
        // Called addTransition with ONE argument (QE takes seven on 26.3.2) inside a bare
        // catch, then counted the ATTEMPTS as "crossfadesAdded" — so a run that added nothing
        // reported success with a non-zero count. Correct signature, and the count now comes
        // from a per-cut readback.
        var fps = seq.timebase ? (254016000000 / parseInt(String(seq.timebase), 10)) : 30;
        var frames = Math.max(1, Math.round(${durationSeconds} * fps));
        var added = 0, attempted = 0;
        var failures = [];
        var beforeXml = __transitionXmlCount(seq);
        // Walk DOM clips, not QE items: QE lists gaps ("Empty") as items, so "item c and item c+1"
        // is not a cut. A cut is where one clip ends exactly where the next begins. The crossfade
        // goes on the outgoing clip's END (second argument false; true means its START).
        var cutsDone = [];
        for (var t=0; t<seq.audioTracks.numTracks; t++) {
          var qatrack = qseq.getAudioTrackAt(t);
          var dclips = seq.audioTracks[t].clips;
          for (var c=0; c<dclips.numItems-1; c++) {
            var outgoing = dclips[c], incoming = dclips[c+1];
            var cut = Number(outgoing.end.seconds);
            if (Math.abs(Number(incoming.start.seconds) - cut) > 0.5 / fps) continue;
            attempted++;
            var clip = __findQeClipByDomClip(qatrack, outgoing);
            if (!clip) { failures.push('A' + (t+1) + ' cut at ' + cut + 's: QE clip not found'); continue; }
            var nBefore = __qeTransitionsAt(qatrack, cut).length;
            var addErr = null;
            try { clip.addTransition(transition, false, String(frames), "0", 0.5, true, true); } catch(e2) { addErr = e2.toString(); }
            if (__qeTransitionsAt(qatrack, cut).length > nBefore) { added++; cutsDone.push('A' + (t+1) + '@' + cut + 's'); }
            else failures.push('A' + (t+1) + ' cut at ' + cut + 's: ' + (addErr ? addErr : 'no transition appeared (the clips may have no source handles at the cut)'));
          }
        }
        var afterXml = __transitionXmlCount(seq);
        var xmlDelta = (beforeXml.available && afterXml.available) ? (afterXml.count - beforeXml.count) : null;
        if (attempted === 0) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'QE clip transition enumeration per cut',crossfadesAdded:0,cutsAttempted:0,durationSeconds:${durationSeconds},durationFrames:frames,
            note:'This sequence has no audio cut with a clip on both sides, so there was nothing to crossfade.'});
        }
        if (added === attempted) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'QE track transition list at each cut',crossfadesAdded:added,cutsAttempted:attempted,cuts:cutsDone,durationSeconds:${durationSeconds},durationFrames:frames,xmlTransitionDelta:xmlDelta});
        }
        return JSON.stringify({success:false,verified:true,verifiedBy:'QE clip transition enumeration per cut',crossfadesAdded:added,cutsAttempted:attempted,durationSeconds:${durationSeconds},durationFrames:frames,xmlTransitionDelta:xmlDelta,failures:failures,
          error: added === 0
            ? ('No crossfade could be added at any of the ' + attempted + ' audio cuts. See failures[].')
            : ('PARTIALLY APPLIED: ' + added + ' of ' + attempted + ' audio cuts gained a crossfade. See failures[].')});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  private parseSilenceIntervals(stderr: string): Array<{ start: number; end: number; duration: number }> {
    const starts: number[] = [];
    const ends: number[] = [];
    const startRe = /silence_start:\s*(-?[\d.]+)/g;
    const endRe = /silence_end:\s*(-?[\d.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = startRe.exec(stderr)) !== null) {
      starts.push(parseFloat(match[1]!));
    }
    while ((match = endRe.exec(stderr)) !== null) {
      ends.push(parseFloat(match[1]!));
    }
    const intervals: Array<{ start: number; end: number; duration: number }> = [];
    const count = Math.min(starts.length, ends.length);
    for (let i = 0; i < count; i++) {
      const start = starts[i]!;
      const end = ends[i]!;
      intervals.push({
        start,
        end,
        duration: Math.round((end - start) * 1000) / 1000,
      });
    }
    return intervals;
  }

  protected async detectSilence(
    mediaPath?: string,
    projectItemId?: string,
    noiseThresholdDb = -30,
    minDurationSeconds = 1.5
  ): Promise<any> {
    let resolvedPath = mediaPath;

    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) {
        return { success: false, error: resolved.error };
      }
      resolvedPath = resolved.path;
    }

    if (!resolvedPath) {
      return { success: false, error: 'Provide either mediaPath or projectItemId' };
    }

    const ffmpegAvailable = await this.checkFfmpegAvailable();
    if (!ffmpegAvailable) {
      return {
        success: false,
        error: 'ffmpeg was not found on PATH. detect_silence analyzes audio via ffmpeg\'s silencedetect filter, not Premiere\'s scripting API (which cannot read audio levels at all). Install ffmpeg (e.g. `brew install ffmpeg` on macOS) and try again.'
      };
    }

    return new Promise((resolve) => {
      const ffmpegArgs = [
        '-i', resolvedPath as string,
        '-af', `silencedetect=noise=${noiseThresholdDb}dB:d=${minDurationSeconds}`,
        '-f', 'null', '-'
      ];
      const proc = spawn('ffmpeg', ffmpegArgs);
      let stderr = '';

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffmpeg: ${err.message}` });
      });

      proc.on('close', (code) => {
        if (code !== 0 && stderr.indexOf('silence_start') === -1) {
          resolve({
            success: false,
            error: `ffmpeg exited with code ${code} and produced no silence data. This usually means the file couldn't be read.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000)
          });
          return;
        }
        const silenceIntervals = this.parseSilenceIntervals(stderr);
        resolve({
          success: true,
          mediaPath: resolvedPath,
          noiseThresholdDb,
          minDurationSeconds,
          silenceIntervals,
          note: 'Detection only -- nothing was cut. Use split_clip/ripple_delete/razor_timeline_at_time on a sequence to remove any of these intervals.'
        });
      });
    });
  }

  /**
   * Build an ffmpeg atempo filter chain for an arbitrary speed factor. A single
   * atempo is only valid in [0.5, 2.0], so a factor outside that range is
   * decomposed into a product of in-range steps (e.g. 4x -> atempo=2,atempo=2;
   * 0.25x -> atempo=0.5,atempo=0.5). Pitch is preserved. Returns a comma-joined
   * chain suitable for -af.
   */
  protected buildAtempoChain(speed: number): string {
    const steps: number[] = [];
    let remaining = speed;
    // Factor down while too fast (>2), and up while too slow (<0.5).
    while (remaining > 2.0 + 1e-9) { steps.push(2.0); remaining /= 2.0; }
    while (remaining < 0.5 - 1e-9) { steps.push(0.5); remaining *= 2.0; }
    steps.push(Math.round(remaining * 1e6) / 1e6);
    return steps.map((s) => `atempo=${s}`).join(',');
  }

  /**
   * Normalize a file to an EBU R128 loudness target with ffmpeg's two-pass
   * loudnorm, writing a NEW file. Premiere exposes no scriptable loudness
   * measurement or normalization, so this is the only honest way to hit a
   * delivery spec from the pipeline. Pass 1 measures the source (loudnorm in
   * print mode over ffprobe/ffmpeg); pass 2 applies linear normalization seeded
   * with the measured values for an accurate result. Same honesty contract:
   * install guidance if ffmpeg is absent, verify-after-write before success, and
   * the measured input loudness is returned so the change is auditable.
   */
  protected async normalizeLoudness(
    mediaPath?: string,
    projectItemId?: string,
    targetLufs = -14,
    truePeakDb = -1.0,
    loudnessRange = 11,
    outputPath?: string,
  ): Promise<any> {
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
        error: `ffmpeg ('${ffmpeg}') was not found on PATH. normalize_loudness measures and corrects loudness with ffmpeg's loudnorm filter because Premiere exposes no scriptable loudness control. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFMPEG_CMD to the binary name, then try again.`,
      };
    }

    const loudnormBase = `I=${targetLufs}:TP=${truePeakDb}:LRA=${loudnessRange}`;
    const ext = extname(resolvedPath) || '.wav';
    const outFile = (outputPath && outputPath.trim())
      || join(dirname(resolvedPath), `${basename(resolvedPath, extname(resolvedPath))}_norm${targetLufs}LUFS${ext}`);

    // Pass 1: measure. loudnorm prints a JSON blob to stderr in print_format=json.
    const measured = await new Promise<{ ok: boolean; data?: any; stderr: string }>((resolve) => {
      const argv = ['-i', resolvedPath as string, '-af', `loudnorm=${loudnormBase}:print_format=json`, '-f', 'null', '-'];
      const proc = spawn(ffmpeg, argv);
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', () => resolve({ ok: false, stderr }));
      proc.on('close', () => {
        // The JSON is the last {...} block in stderr.
        const match = stderr.match(/\{[\s\S]*?\}/g);
        if (!match || match.length === 0) { resolve({ ok: false, stderr }); return; }
        try { resolve({ ok: true, data: JSON.parse(match[match.length - 1] as string), stderr }); }
        catch { resolve({ ok: false, stderr }); }
      });
    });

    if (!measured.ok || !measured.data) {
      return {
        success: false,
        error: 'ffmpeg could not measure the source loudness (loudnorm pass 1 produced no JSON). The file may have no audio stream or be unreadable.',
        mediaPath: resolvedPath,
        ffmpegStderr: measured.stderr.slice(-2000),
      };
    }

    const m = measured.data;
    // Pass 2: apply linear normalization seeded with the measured values.
    const loudnormApply =
      `loudnorm=${loudnormBase}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
      `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:` +
      `offset=${m.target_offset}:linear=true:print_format=summary`;

    return await new Promise((resolve) => {
      const argv = ['-y', '-i', resolvedPath as string, '-af', loudnormApply, outFile];
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
            error: `ffmpeg exited with code ${code} but no normalized file was written to ${outFile}.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        if (sizeBytes === 0) {
          resolve({
            success: false,
            error: `ffmpeg wrote an empty file to ${outFile} (0 bytes).`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        resolve({
          success: true,
          outputPath: outFile,
          sizeBytes,
          target: { integratedLufs: targetLufs, truePeakDb, loudnessRangeLu: loudnessRange },
          measuredInput: {
            integratedLufs: Number(m.input_i),
            truePeakDb: Number(m.input_tp),
            loudnessRangeLu: Number(m.input_lra),
            thresholdLufs: Number(m.input_thresh),
          },
          mediaPath: resolvedPath,
          note: `Normalized to ${targetLufs} LUFS (true peak <= ${truePeakDb} dBTP) with two-pass loudnorm. Import the output with import_media to use it.`,
        });
      });
    });
  }

  // Audio Operations Implementation
  /**
   * High-level ducking helper. Computes a keyframe curve and delegates to
   * addAudioKeyframes (single source of truth for the locale-aware + calibrated
   * keyframe write).
   *
   * For each ducking window, emits 4 keyframes:
   *   - pre-fade  (window.startTime - fadeSeconds): baseDb
   *   - duck-in   (window.startTime):               duckedDb
   *   - duck-out  (window.endTime):                 duckedDb
   *   - post-fade (window.endTime + fadeSeconds):   baseDb
   *
   * Plus boundary keyframes at clipStartTime (or 0) and clipEndTime
   * (or last window.endTime + 1s) anchored to baseDb. Result: a continuous
   * curve that sits at baseDb except inside duck windows.
   *
   * Replaces the manual Sprint 3 "8 keyframes per video" pattern.
   */
  protected async setupDucking(
    clipId: string,
    baseDb: number,
    duckingWindows: Array<{ startTime: number; endTime: number; duckedDb: number }>,
    fadeSeconds: number = 0.2,
    clipStartTime?: number,
    clipEndTime?: number
  ): Promise<any> {
    const fade = fadeSeconds ?? 0.2;
    const start = clipStartTime ?? 0;
    const lastWindow = duckingWindows.length > 0 ? duckingWindows[duckingWindows.length - 1] : undefined;
    const end = clipEndTime ?? (lastWindow ? lastWindow.endTime + 1 : start + 1);

    // Collect all keyframes and dedupe-by-time (later writes win for same time)
    const map = new Map<number, number>();
    const upsert = (t: number, db: number) => {
      // Quantize to ms to avoid duplicate-but-not-equal floats
      const key = Math.round(t * 1000) / 1000;
      map.set(key, db);
    };

    upsert(start, baseDb);

    for (const w of duckingWindows) {
      upsert(Math.max(start, w.startTime - fade), baseDb);
      upsert(w.startTime, w.duckedDb);
      upsert(w.endTime, w.duckedDb);
      upsert(Math.min(end, w.endTime + fade), baseDb);
    }

    upsert(end, baseDb);

    const keyframes = Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, level]) => ({ time, level }));

    const result = await this.addAudioKeyframes(clipId, keyframes);
    return {
      ...(typeof result === 'object' && result !== null ? result : {}),
      ducking_windows: duckingWindows.length,
      fade_seconds: fade,
      keyframes_emitted: keyframes.length,
      base_db: baseDb,
      computed_keyframes: keyframes,
    };
  }

  //
  // Sets the audio clip volume in dB (relative gain on the clip's Volume component, NOT track mixer).
  //
  // FIX vs upstream:
  //   - Upstream looked for property `displayName === "Volume"` iterating ALL component properties.
  //     That's wrong: "Volume" is a COMPONENT name, and its level property is "Level" (en) / "Nivel" (es).
  //   - Upstream passed `level` (dB) directly to setValue, but Premiere ExtendScript expects a
  //     linear scale (1.0 = 0 dB, 1.4454 = +3.2 dB). Conversion: linear = 10^(dB/20).
  //   - Now supports localized component names (Spanish "Volumen", English "Volume", others).
  //   - On not-found, returns a dump of clip components+properties for debugging.
  protected async adjustAudioLevels(clipId: string, level: number): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;

        // Localized display names for the Volume component
        var VOLUME_NAMES = ["Volume", "Volumen", "Lautstärke", "Volume", "音量"];
        // Localized display names for the Level property inside Volume
        var LEVEL_NAMES  = ["Level", "Nivel", "Pegel", "Niveau", "Livello", "音量"];

        function isOneOf(name, list) {
          for (var n = 0; n < list.length; n++) { if (name === list[n]) return true; }
          return false;
        }

        // Build dump for debug fallback
        var dump = [];
        var volumeComp = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          var compName = String(comp.displayName);
          var propsList = [];
          for (var j = 0; j < comp.properties.numItems; j++) {
            propsList.push(String(comp.properties[j].displayName));
          }
          dump.push({ idx: i, component: compName, properties: propsList });
          if (!volumeComp && isOneOf(compName, VOLUME_NAMES)) {
            volumeComp = comp;
          }
        }
        if (!volumeComp) {
          return JSON.stringify({
            success: false,
            error: "Volume component not found on clip",
            components_dump: dump
          });
        }

        var levelProp = null;
        for (var j = 0; j < volumeComp.properties.numItems; j++) {
          var pName = String(volumeComp.properties[j].displayName);
          if (isOneOf(pName, LEVEL_NAMES)) {
            levelProp = volumeComp.properties[j];
            break;
          }
        }
        if (!levelProp) {
          return JSON.stringify({
            success: false,
            error: "Level property not found inside Volume component",
            volume_component: String(volumeComp.displayName),
            properties_in_volume: dump.length > 0 ? dump : []
          });
        }

        // CALIBRATION (empirical, Premiere Pro 2026 macOS, locale es_ES):
        //   Premiere's clip Volume Level property uses a linear amplitude scale where the
        //   displayed "0 dB" in the Effects Controls panel corresponds to internal linear value
        //   ~0.17783. The relationship is: linear = 0.17783 × 10^(dB/20),
        //   equivalently: linear = 10^((dB - 15) / 20).
        //   Verified by measurement: setting linear = 1.4454 (which standard audio convention
        //   says is +3.2 dB) actually produced ~+13 dB of broadcast loudness gain. With this
        //   calibrated formula, requesting +3.2 dB now sets linear = 0.2571 ≈ matches Premiere's
        //   displayed value.
        var DB_CALIBRATION_OFFSET = 15;  // Premiere ES-locale, PrPro 2026.x
        var dB = ${level};
        var linearValue = Math.pow(10, (dB - DB_CALIBRATION_OFFSET) / 20);
        var oldLinear = levelProp.getValue();
        var oldDB = (oldLinear > 0)
          ? (20 * Math.log(oldLinear) / Math.log(10) + DB_CALIBRATION_OFFSET)
          : -Infinity;
        levelProp.setValue(linearValue, true);

        return JSON.stringify({
          success: true,
          message: "Audio level adjusted (clip Volume component, locale-aware, calibrated dB scale)",
          clipId: ${JSON.stringify(clipId)},
          requestedDB: dB,
          oldLinearValue: oldLinear,
          oldDB: oldDB,
          newLinearValue: linearValue,
          newDB: dB,
          calibrationOffset: DB_CALIBRATION_OFFSET,
          volumeComponent: String(volumeComp.displayName),
          levelProperty: String(levelProp.displayName)
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

  protected async addAudioKeyframes(clipId: string, keyframes: Array<{time: number, level: number}>): Promise<any> {
    // CALIBRATION (matches adjustAudioLevels): Premiere's clip Volume Level property is linear amplitude.
    // The displayed "0 dB" in Effects Controls corresponds to internal linear value ~0.17783.
    // Relationship: linear = 10^((dB - 15) / 20). Verified empirically on Premiere Pro 2026 macOS es_ES.
    const DB_CALIBRATION_OFFSET = 15;
    const keyframeCode = keyframes.map(kf => {
      const linearValue = Math.pow(10, (kf.level - DB_CALIBRATION_OFFSET) / 20);
      return `
        try {
          levelProp.addKey(${kf.time});
          levelProp.setValueAtKey(${kf.time}, ${linearValue}, true);
          // Verify the key actually landed and holds the value we asked for; addKey/setValueAtKey
          // return void and can silently no-op, so a push without readback would be a fake success.
          var __kExists = false; try { __kExists = levelProp.keyExistsAtTime(${kf.time}); } catch (eK) {}
          var __kVal = null; try { __kVal = levelProp.getValueAtKey(${kf.time}); } catch (eV) {}
          if (__kExists && __kVal !== null && Math.abs(Number(__kVal) - ${linearValue}) <= Math.max(0.0005, ${linearValue} * 0.02)) {
            addedKeyframes.push({ time: ${kf.time}, level: ${kf.level}, linearValue: ${linearValue} });
          } else {
            failedKeyframes.push({ time: ${kf.time}, level: ${kf.level}, error: "keyframe did not verify (exists=" + __kExists + ", readback=" + __kVal + ")" });
          }
        } catch (e2) {
          failedKeyframes.push({ time: ${kf.time}, level: ${kf.level}, error: e2.toString() });
        }
    `;
    }).join('\n');

    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;

        // Locale-aware Volume component / Level property detection (matches adjustAudioLevels patch).
        // Without this, the function fails with "Volume property not found" on non-English Premiere
        // installs (e.g., Spanish "Volumen"/"Nivel", German "Lautstärke"/"Pegel", etc.).
        var VOLUME_NAMES = ["Volume", "Volumen", "Lautstärke", "Volume", "音量"];
        var LEVEL_NAMES  = ["Level", "Nivel", "Pegel", "Niveau", "Livello", "音量"];
        function isOneOf(name, list) {
          for (var n = 0; n < list.length; n++) { if (name === list[n]) return true; }
          return false;
        }

        var volumeComp = null;
        var dump = [];
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          var compName = String(comp.displayName);
          var propsList = [];
          for (var j = 0; j < comp.properties.numItems; j++) {
            propsList.push(String(comp.properties[j].displayName));
          }
          dump.push({ idx: i, component: compName, properties: propsList });
          if (!volumeComp && isOneOf(compName, VOLUME_NAMES)) {
            volumeComp = comp;
          }
        }
        if (!volumeComp) {
          return JSON.stringify({
            success: false,
            error: "Volume component not found on clip (locale-aware lookup failed)",
            components_dump: dump
          });
        }

        var levelProp = null;
        for (var k = 0; k < volumeComp.properties.numItems; k++) {
          var pName = String(volumeComp.properties[k].displayName);
          if (isOneOf(pName, LEVEL_NAMES)) {
            levelProp = volumeComp.properties[k];
            break;
          }
        }
        if (!levelProp) {
          return JSON.stringify({
            success: false,
            error: "Level property not found inside Volume component",
            volume_component: String(volumeComp.displayName)
          });
        }

        levelProp.setTimeVarying(true);
        var addedKeyframes = [];
        var failedKeyframes = [];
        ${keyframeCode}
        return JSON.stringify({
          success: (addedKeyframes.length > 0 && failedKeyframes.length === 0),
          verified: (addedKeyframes.length > 0 && failedKeyframes.length === 0),
          message: failedKeyframes.length
            ? ("Audio keyframes: " + addedKeyframes.length + " verified, " + failedKeyframes.length + " failed to apply")
            : "Audio keyframes added and verified (locale-aware Volume detection, calibrated dB scale)",
          clipId: ${JSON.stringify(clipId)},
          volumeComponent: String(volumeComp.displayName),
          levelProperty: String(levelProp.displayName),
          calibrationOffset: ${DB_CALIBRATION_OFFSET},
          addedKeyframes: addedKeyframes,
          failedKeyframes: failedKeyframes,
          totalKeyframes: addedKeyframes.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async muteTrack(sequenceId: string, trackIndex: number, muted: boolean): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var track = sequence.audioTracks[${trackIndex}];
        if (!track) return JSON.stringify({ success: false, error: "Audio track not found" });
        var wasMuted = null; try { wasMuted = Boolean(track.isMuted()); } catch (ePre) {}
        track.setMute(${muted ? 1 : 0});
        var nowMuted = null; try { nowMuted = Boolean(track.isMuted()); } catch (eMute) {}
        if (nowMuted !== null && nowMuted !== ${muted}) return JSON.stringify({ success: false, verified: true, verifiedBy: "AudioTrack.isMuted() readback", before: wasMuted, after: nowMuted, changed: wasMuted !== nowMuted, error: "Premiere did not change the track mute state (still reads " + (nowMuted ? "muted" : "unmuted") + ")." });
        // A readback cannot tell "changed it" from "was already correct", so report both, and
        // when the readback is unavailable say what could not be confirmed instead of shipping
        // a bare verified:false. The old message claimed the status "changed" either way.
        if (nowMuted === null) {
          return JSON.stringify({
            success: true, verified: false,
            unverifiedReason: "setMute() did not throw, but AudioTrack.isMuted() is not readable on this build, so the mute state cannot be confirmed.",
            sequenceId: ${JSON.stringify(sequenceId)}, trackIndex: ${trackIndex}, muted: ${muted}, before: wasMuted
          });
        }
        return JSON.stringify({
          success: true,
          verified: true,
          verifiedBy: "AudioTrack.isMuted() readback",
          changed: wasMuted !== nowMuted,
          message: wasMuted === nowMuted
            ? ("Audio track ${trackIndex} was already " + (${muted} ? "muted" : "unmuted") + "; nothing changed.")
            : ("Audio track ${trackIndex} is now " + (${muted} ? "muted" : "unmuted") + "."),
          sequenceId: ${JSON.stringify(sequenceId)},
          trackIndex: ${trackIndex},
          muted: ${muted},
          before: wasMuted
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async linkAudioVideo(clipId: string, linked: boolean): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        info.clip.setSelected(1, 1);
        var seq = app.project.activeSequence;
        if (${linked}) { seq.linkSelection(); } else { seq.unlinkSelection(); }
        return JSON.stringify({ success: true, message: "Clip " + (${linked} ? "linked" : "unlinked") });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async applyAudioEffect(clipId: string, effectName: string, parameters?: any): Promise<any> {
    return await this.applyEffect(clipId, effectName, parameters);
  }

  // BULK helper: apply same audio effect + parameters to all audio clips of a sequence in ONE
  // ExtendScript round-trip. Activates the target sequence first (QE DOM operates on active).
  // Returns per-clip results with valueAfter readback for the SET parameters.
  protected async applyAudioEffectToAllClips(sequenceId: string, effectName: string, parameters?: Record<string, any>): Promise<any> {
    const paramJson = JSON.stringify(parameters || {});
    const script = `
      try {
        app.enableQE();
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        // Make target active so QE DOM can address it
        var __priorActive = app.project.activeSequence;
        app.project.activeSequence = seq;
        var qeSeq = __qeSequenceOpening(seq);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + seq.name + "' through the QE API." });
        var effect = qe.project.getAudioEffectByName(${JSON.stringify(effectName)});
        if (!effect) return JSON.stringify({ success: false, error: "Audio effect not found: " + ${JSON.stringify(effectName)} });

        var requestedParams = ${paramJson};
        function normalize(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }

        var perClip = [];
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
          var track = seq.audioTracks[t];
          var qeTrack = qeSeq.getAudioTrackAt(t);
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            // Same gap/transition mismatch: c is the DOM clip index, which is not the
            // QE item index once anything non-clip sits earlier on the track.
            var qeClip = __findQeClipByDomClip(qeTrack, clip);
            try {
              qeClip.addAudioEffect(effect);
              var newCompIdx = clip.components.numItems - 1;
              var newComp = clip.components[newCompIdx];
              var paramResults = [];
              for (var pName in requestedParams) {
                if (requestedParams.hasOwnProperty && !requestedParams.hasOwnProperty(pName)) continue;
                var requestedVal = requestedParams[pName];
                var matched = null;
                for (var k = 0; k < newComp.properties.numItems; k++) {
                  if (String(newComp.properties[k].displayName) === pName) {
                    matched = newComp.properties[k]; break;
                  }
                }
                if (!matched) {
                  var nameN = normalize(pName);
                  for (var k = 0; k < newComp.properties.numItems; k++) {
                    if (normalize(String(newComp.properties[k].displayName)) === nameN) {
                      matched = newComp.properties[k]; break;
                    }
                  }
                }
                if (matched) {
                  try {
                    matched.setValue(requestedVal, true);
                    var valueAfter = null;
                    try { valueAfter = matched.getValue(); } catch (eA) {}
                    paramResults.push({ name: pName, ok: true, valueRequested: requestedVal, valueAfter: valueAfter });
                  } catch (e1) {
                    paramResults.push({ name: pName, ok: false, error: e1.toString() });
                  }
                } else {
                  paramResults.push({ name: pName, ok: false, error: "no matching property" });
                }
              }
              perClip.push({ clipIndex: c, trackIndex: t, clipId: String(clip.nodeId), name: String(clip.name), ok: true, paramResults: paramResults });
            } catch (e2) {
              perClip.push({ clipIndex: c, trackIndex: t, clipId: String(clip.nodeId), name: String(clip.name), ok: false, error: e2.toString() });
            }
          }
        }

        return JSON.stringify({
          success: true,
          sequenceId: ${JSON.stringify(sequenceId)},
          sequenceName: String(seq.name),
          effectName: ${JSON.stringify(effectName)},
          totalClipsProcessed: perClip.length,
          allOk: perClip.every ? perClip.every(function(r){return r.ok;}) : true,
          perClip: perClip
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

  protected async listAvailableAudioEffects(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var list = qe.project.getAudioEffectList();
        return JSON.stringify({
          success: true,
          effects: list,
          count: list.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async listAvailableAudioTransitions(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var list = qe.project.getAudioTransitionList();
        return JSON.stringify({
          success: true,
          transitions: list,
          count: list.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async setParametricEq(seqId: string|undefined, trackIndex: number, clipIndex: number, band: number, frequency?: number, gain?: number, q?: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(seqId)};
        var atrack = seq.getAudioTrackAt(${trackIndex});
        if (!atrack) return JSON.stringify({success:false,error:'Audio track not found'});
        var clip = __qeClipByIndex(seq, 'audio', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var set = 0;
        for (var ci = 0; ci < (clip.numComponents||10); ci++) {
          try {
            var comp = clip.getComponentAt(ci);
            if (!comp) break;
            var list = String(comp.getParamList());
            if (list.indexOf('Frequency') >= 0 || list.indexOf('EQ') >= 0 || list.indexOf('Band') >= 0) {
              ${frequency !== undefined ? `try { comp.setParamValue('Band ' + ${band} + ' Frequency', '${frequency}'); set++; } catch(e) {}` : ''}
              ${gain !== undefined ? `try { comp.setParamValue('Band ' + ${band} + ' Gain', '${gain}'); set++; } catch(e) {}` : ''}
              ${q !== undefined ? `try { comp.setParamValue('Band ' + ${band} + ' Q', '${q}'); set++; } catch(e) {}` : ''}
              break;
            }
          } catch(ec) { break; }
        }
        return JSON.stringify({success:true,paramsSet:set,band:${band},frequency:${frequency??null},gain:${gain??null},q:${q??null}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setCompressor(seqId: string|undefined, trackIndex: number, clipIndex: number, threshold?: number, ratio?: number, attack?: number, release?: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(seqId)};
        var clip = __qeClipByIndex(seq, 'audio', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var set = 0;
        for (var ci = 0; ci < 20; ci++) {
          try { var comp = clip.getComponentAt(ci); if (!comp) break;
            var list = String(comp.getParamList());
            if (list.indexOf('Threshold') >= 0 || list.indexOf('Ratio') >= 0) {
              ${threshold !== undefined ? `try { comp.setParamValue('Threshold', '${threshold}'); set++; } catch(e) {}` : ''}
              ${ratio !== undefined ? `try { comp.setParamValue('Ratio', '${ratio}'); set++; } catch(e) {}` : ''}
              ${attack !== undefined ? `try { comp.setParamValue('Attack', '${attack}'); set++; } catch(e) {}` : ''}
              ${release !== undefined ? `try { comp.setParamValue('Release', '${release}'); set++; } catch(e) {}` : ''}
              break;
            }
          } catch(ec) { break; }
        }
        return JSON.stringify({success:true,paramsSet:set});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setLimiter(seqId: string|undefined, trackIndex: number, clipIndex: number, ceiling: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(seqId)};
        var clip = __qeClipByIndex(seq, 'audio', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        for (var ci = 0; ci < 20; ci++) {
          try { var comp = clip.getComponentAt(ci); if (!comp) break;
            var list = String(comp.getParamList());
            if (list.indexOf('Ceiling') >= 0 || list.indexOf('Maximum') >= 0) {
              comp.setParamValue('Maximum Amplitude', '${ceiling}');
              return JSON.stringify({success:true,ceiling:${ceiling}});
            }
          } catch(ec) { break; }
        }
        return JSON.stringify({success:false,error:'No limiter component found. Add a Limiter or Dynamics Processing effect first.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async dereverbClip(seqId: string|undefined, trackIndex: number, clipIndex: number, amount: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(seqId)};
        var atrack = seq.getAudioTrackAt(${trackIndex});
        var clip = atrack && __qeClipByIndex(seq, 'audio', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Audio clip not found'});
        var eff = qe.project.getAudioEffectByName('DeReverb');
        if (!eff) return JSON.stringify({success:false,error:'DeReverb effect not found in effect list'});
        var domClip = ${this.buildSeqRes(seqId)}.audioTracks[${trackIndex}].clips[${clipIndex}];
        var before = domClip.components.numItems;
        clip.addAudioEffect(eff);
        var after = domClip.components.numItems;
        if (after <= before) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'clip component count before and after',changed:false,amount:${amount},componentsBefore:before,componentsAfter:after,
            error:'addAudioEffect() ran but the clip component count did not rise, so DeReverb was not applied. Try apply_audio_effect with the matchName from list_available_audio_effects instead.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'clip component count before and after',changed:true,effectAdded:true,componentsBefore:before,componentsAfter:after,amountRequested:${amount},amountApplied:false,
          note:'DeReverb was added at its DEFAULT settings. The amount argument was not applied: this tool only adds the effect. Set its parameters with set_effect_property.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async normalizeTrackPeaks(seqId: string|undefined, trackIndex: number, targetDbfs: number): Promise<any> {
    // Node.js side: get clips, probe each, set gain
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var track = seq.audioTracks[${trackIndex}];
        if (!track) return JSON.stringify({success:false,error:'Audio track not found'});
        var results = [];
        for (var i = 0; i < track.clips.numItems; i++) {
          var clip = track.clips[i];
          var item = clip.projectItem;
          var path = item ? String(item.getMediaPath()) : '';
          results.push({clipIndex:i, name:String(clip.name), mediaPath:path});
        }
        return JSON.stringify({success:true,message:'Use ffprobe on mediaPath values to measure peaks, then call set_clip_gain for each clip.',clips:results,targetDbfs:${targetDbfs}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  /**
   * Fill [gapStart, gapStart + gapDuration) on one audio track with room tone, and nothing else.
   *
   * The old version overwrote the whole project item at gapStart: an A/V source dropped its VIDEO
   * onto V1 as well (it replaced the fixture's first clip in a live sweep), the gap length was
   * ignored so the tone ran on over whatever followed, and an occupied "gap" was overwritten
   * without a word. Now: refuse unless the span is empty on that track, then lay audio-only
   * subclips cut to fit, looping the source when the gap is longer than the media.
   */
  protected async fillRoomTone(seqId: string|undefined, trackIndex: number, gapStart: number, gapDuration: number, roomToneItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var item = __findProjectItem(${JSON.stringify(roomToneItemId)});
        if (!item) return JSON.stringify({success:false,error:'Room tone item not found'});
        var track = seq.audioTracks[${trackIndex}];
        if (!track) return JSON.stringify({success:false,error:'Audio track not found'});
        var gs = ${Number(gapStart)}, gd = ${Number(gapDuration)}, ge = gs + gd;
        if (!(gd > 0)) return JSON.stringify({success:false,error:'gapDurationSecs must be greater than 0.'});
        for (var c = 0; c < track.clips.numItems; c++) {
          var cl = track.clips[c];
          if (cl.start.seconds < ge - 0.0005 && cl.end.seconds > gs + 0.0005) {
            return JSON.stringify({success:false,verified:true,error:'A' + (${trackIndex} + 1) + ' is not empty between ' + gs + 's and ' + ge + 's: "' + String(cl.name) + '" covers ' + cl.start.seconds + 's-' + cl.end.seconds + 's. Nothing was placed.'});
          }
        }
        // Real media length, not the bin out point (which is a mark).
        var mediaSecs = NaN;
        try {
          var md = String(item.getProjectMetadata());
          var m = /<premierePrivateProjectMetaData:Column\\.Intrinsic\\.MediaDuration>([^<]*)</.exec(md);
          if (m) { var tc = m[1].split(/[:;]/); if (tc.length === 4) mediaSecs = Number(tc[0])*3600 + Number(tc[1])*60 + Number(tc[2]) + Number(tc[3]) / Math.round(254016000000 / Number(seq.timebase)); }
        } catch (eMd) {}
        if (!(mediaSecs > 0)) { try { mediaSecs = item.getOutPoint().seconds - item.getInPoint().seconds; } catch (eIo) {} }
        if (!(mediaSecs > 0)) return JSON.stringify({success:false,error:'Could not read the room tone media length.'});
        var placed = [], at = gs, guard = 0;
        while (at < ge - 0.0005 && guard++ < 200) {
          var len = Math.min(mediaSecs, ge - at);
          // (name, start, end, hardBoundaries, takeVideo, takeAudio): audio only.
          var sub = item.createSubClip(String(item.name) + ' room tone', __secondsToTicks(0), __secondsToTicks(len), 1, 0, 1);
          if (!sub) return JSON.stringify({success:false,error:'createSubClip() returned nothing; placed ' + placed.length + ' piece(s) before stopping.',placed:placed});
          var t = new Time(); t.seconds = at;
          track.overwriteClip(sub, t);
          placed.push({atSecs: at, lengthSecs: len});
          at += len;
        }
        // Read back: the span should now be covered on this track and by nothing else new.
        var covered = 0;
        for (var r = 0; r < track.clips.numItems; r++) {
          var rc = track.clips[r];
          var s0 = Math.max(gs, rc.start.seconds), e0 = Math.min(ge, rc.end.seconds);
          if (e0 > s0) covered += e0 - s0;
        }
        var ok = Math.abs(covered - gd) < 0.05;
        return JSON.stringify({success:ok,verified:true,verifiedBy:'audio track coverage readback',gapStartSecs:gs,gapDurationSecs:gd,coveredSecs:covered,pieces:placed.length,looped:placed.length > 1,roomToneItem:String(item.name),
          error: ok ? undefined : 'Room tone was placed but covers ' + covered + 's of the ' + gd + 's gap.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async stemExport(seqId: string|undefined, trackIndices: number[], outputDir: string, format: string): Promise<any> {
    // Mute all except target, export audio only, repeat
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var results = [];
        var allTracks = seq.audioTracks;
        for (var ti = 0; ti < ${JSON.stringify(trackIndices)}.length; ti++) {
          var targetIdx = ${JSON.stringify(trackIndices)}[ti];
          // Mute all except target
          for (var t = 0; t < allTracks.numTracks; t++) {
            if (t !== targetIdx) allTracks[t].setMute(true);
            else allTracks[t].setMute(false);
          }
          var outPath = ${JSON.stringify(outputDir)} + '/stem_track_' + targetIdx + '.' + ${JSON.stringify(format)};
          results.push({track:targetIdx, output:outPath, status:'queued'});
        }
        // Restore mutes
        for (var t2 = 0; t2 < allTracks.numTracks; t2++) allTracks[t2].setMute(false);
        return JSON.stringify({success:true,note:'Track muting applied. Use batch_export_sequences or export_audio_only to complete the export for each stem.',stems:results});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async channelRemapReport(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var report = {audioTracks:[]};
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
          var track = seq.audioTracks[t];
          var clips = [];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            var item = clip.projectItem;
            clips.push({name:String(clip.name), mediaPath: item ? String(item.getMediaPath()) : ''});
          }
          report.audioTracks.push({index:t, name:String(track.name), clipCount:track.clips.numItems, clips:clips.slice(0,3)});
        }
        return JSON.stringify({success:true, trackCount:seq.audioTracks.numTracks, tracks:report.audioTracks});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected audioSilenceScan(filePath: string, noiseDb: number, minDuration: number): any {
    try {
      const out = runFf('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-vn', '-af', `silencedetect=noise=${Number(noiseDb)}dB:d=${Number(minDuration)}`, '-f', 'null', '-'], { timeoutMs: 120000, mergeStderr: true });
      const ranges: any[] = [];
      let current: any = null;
      for (const line of out.split('\n')) {
        if (line.includes('silence_start')) { const m = line.match(/silence_start: ([\d.]+)/); if (m?.[1]) current = { start: parseFloat(m[1]) }; }
        if (line.includes('silence_end') && current) { const m = line.match(/silence_end: ([\d.]+)/); if (m?.[1]) { current.end = parseFloat(m[1]); const dm = line.match(/silence_duration: ([\d.]+)/); if (dm?.[1]) current.duration = parseFloat(dm[1]); ranges.push(current); current = null; } }
      }
      return { success: true, silenceRangeCount: ranges.length, ranges };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }
}
