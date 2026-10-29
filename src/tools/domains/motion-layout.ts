/**
 * MotionLayoutTools -- the Motion & Clip Layout tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { MarkerTools } from './marker.js';
import type { MotionParamTarget, MotionStyle } from './shared.js';

export class MotionLayoutTools extends MarkerTools {
  protected getMotionRange(style: MotionStyle, index: number): { from: number; to: number } {
    if (style === 'push_in') {
      return { from: 100, to: 108 };
    }
    if (style === 'pull_out') {
      return { from: 108, to: 100 };
    }
    if (style === 'alternate') {
      const invert = index % 2 === 1;
      return invert ? { from: 110, to: 100 } : { from: 100, to: 108 };
    }
    return { from: 100, to: 100 };
  }

  private motionParamScript(
    seqId: string | undefined,
    ti: number,
    ci: number,
    targets: MotionParamTarget[],
    label: string,
  ): string {
    return this.motionParamBatchScript(seqId, [{ trackIndex: ti, clipIndex: ci, targets }], label);
  }

  /** Batch form: one round trip for a whole layout across several clips. */
  private motionParamBatchScript(
    seqId: string | undefined,
    entries: Array<{ trackIndex: number; clipIndex: number; targets: MotionParamTarget[] }>,
    label: string,
  ): string {
    return `
      try {
        var seq = ${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        function __valuesMatch(a, b) {
          if (a === null || a === undefined) return false;
          var aIsArr = Array.isArray ? Array.isArray(a) : (a && typeof a.length === 'number' && typeof a !== 'string');
          var bIsArr = Array.isArray ? Array.isArray(b) : (b && typeof b.length === 'number' && typeof b !== 'string');
          if (bIsArr) {
            if (!aIsArr || a.length !== b.length) return false;
            for (var vi=0; vi<b.length; vi++) { if (Math.abs(Number(a[vi]) - Number(b[vi])) > 0.001) return false; }
            return true;
          }
          if (aIsArr) return false;
          if (typeof b === 'boolean') return Boolean(a) === b;
          return Math.abs(Number(a) - Number(b)) < 0.001;
        }
        var entries = ${JSON.stringify(entries)};
        var clipReports = [];
        var totalRequested = 0, totalApplied = 0, clipsFullyApplied = 0, clipsPartial = 0;
        for (var ei=0; ei<entries.length; ei++) {
          var entry = entries[ei];
          var track = seq.videoTracks[entry.trackIndex];
          var clip = track ? track.clips[entry.clipIndex] : null;
          totalRequested += entry.targets.length;
          if (!clip) {
            clipReports.push({ trackIndex: entry.trackIndex, clipIndex: entry.clipIndex, ok: false, applied: 0,
              requested: entry.targets.length, error: 'No clip at video track ' + entry.trackIndex + ' index ' + entry.clipIndex + '.' });
            continue;
          }
          var motion = null;
          for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName)==='Motion') { motion=clip.components[i]; break; } }
          if (!motion) {
            clipReports.push({ trackIndex: entry.trackIndex, clipIndex: entry.clipIndex, clip: String(clip.name), ok: false, applied: 0,
              requested: entry.targets.length, error: 'This clip has no Motion component, so position, scale, rotation and anchor point cannot be set on it.' });
            continue;
          }
          var props = motion.properties;
          var present = [];
          for (var pn=0; pn<props.numItems; pn++) { var nmP=''; try{ nmP=String(props[pn].displayName); }catch(eP){} present.push(pn + ':' + nmP); }
          var results = [], applied = 0;
          for (var t=0;t<entry.targets.length;t++) {
            var spec = entry.targets[t];
            var accept = [spec.name];
            if (spec.aliases) { for (var ai=0; ai<spec.aliases.length; ai++) accept.push(spec.aliases[ai]); }
            var param = null, route = 'index';
            if (spec.index < props.numItems) {
              var candidate = props[spec.index];
              var actualName = '';
              try { actualName = String(candidate.displayName); } catch (eN) {}
              if (accept.indexOf(actualName) >= 0) { param = candidate; route = 'index(' + actualName + ')'; }
            }
            if (!param) {
              for (var pj=0; pj<props.numItems; pj++) {
                var nm2 = '';
                try { nm2 = String(props[pj].displayName); } catch (eN2) {}
                if (accept.indexOf(nm2) >= 0) { param = props[pj]; route = 'name-fallback(index ' + pj + ')'; break; }
              }
            }
            if (!param) {
              results.push({ name: spec.name, expectedIndex: spec.index, acceptedNames: accept, ok: false, status: 'parameter_not_found',
                error: 'Motion on this clip has no parameter named ' + accept.join(' or ') + ' at index ' + spec.index + ' or anywhere in its ' + props.numItems + ' parameters, so nothing was written. Parameters present: ' + present.join(', ') + '.' });
              continue;
            }
            var before = null; try { before = param.getValue(); } catch (eB) {}
            var setError = null;
            try { param.setValue(spec.value, true); } catch (eS) { setError = eS.toString(); }
            var after = null; try { after = param.getValue(); } catch (eA) {}
            var landed = __valuesMatch(after, spec.value);
            if (landed) applied++;
            results.push({ name: spec.name, route: route, valueRequested: spec.value, valueBefore: before,
              valueAfter: after, changed: !__valuesMatch(before, spec.value), ok: landed,
              status: landed ? 'verified' : (setError ? 'set_threw' : 'not_applied'),
              error: landed ? null : (setError || ('Value reads back as ' + String(after) + ' rather than ' + String(spec.value) + '.')) });
          }
          totalApplied += applied;
          var full = applied === entry.targets.length && entry.targets.length > 0;
          if (full) clipsFullyApplied++; else if (applied > 0) clipsPartial++;
          clipReports.push({ trackIndex: entry.trackIndex, clipIndex: entry.clipIndex, clip: String(clip.name),
            ok: full, applied: applied, requested: entry.targets.length, results: results });
        }
        var allFull = clipsFullyApplied === entries.length && entries.length > 0;
        var singleClip = entries.length === 1;
        return JSON.stringify({
          success: allFull,
          verified: true, verifiedBy: 'Motion parameter getValue() readback, index guarded by displayName',
          operation: ${JSON.stringify(label)},
          applied: totalApplied, requested: totalRequested,
          clips: clipReports,
          clipsFullyApplied: clipsFullyApplied, clipsPartiallyApplied: clipsPartial, clipsRequested: entries.length,
          results: singleClip ? (clipReports[0] ? clipReports[0].results : []) : undefined,
          error: allFull ? null : (
            entries.length === 0 ? 'No clips were supplied, so nothing was changed.'
            : (totalApplied === 0
              ? ('No Motion parameter could be applied for ' + ${JSON.stringify(label)} + '; see clips[].')
              : ('PARTIALLY APPLIED: ' + totalApplied + ' of ' + totalRequested + ' Motion parameters landed across ' + entries.length + ' clip(s); see clips[]. The affected clips are in a mixed state.')))
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `;
  }

  protected async flipClip(
    sequenceId: string | undefined,
    ti: number,
    ci: number,
    direction: 'horizontal' | 'vertical',
  ): Promise<any> {
    // Premiere's Transform effect has no flip parameter (measured on 26.5.2: Anchor Point,
    // Position, Uniform Scale, Scale Height, Scale Width, Skew, Skew Axis, Rotation, Opacity,
    // shutter and sampling only), so the old path always left an inert Transform on the clip.
    // Flipping is its own pair of parameterless effects, so success is proven by the clip
    // gaining a component of that exact name. qe.project.getVideoEffectByName() returns an
    // object even for a name that does not exist, so its return value proves nothing.
    const effectName = direction === 'horizontal' ? 'Horizontal Flip' : 'Vertical Flip';
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var domSeq = ${this.buildSeqRes(sequenceId)};
        var domTrack = domSeq.videoTracks[${ti}];
        if (!domTrack) return JSON.stringify({success:false,error:'Video track ${ti} not found'});
        var domClip = domTrack.clips[${ci}];
        if (!domClip) return JSON.stringify({success:false,error:'Clip not found'});
        var qeSeq = __qeSequenceOpening(domSeq);
        if (!qeSeq) return JSON.stringify({success:false,error:'QE could not address this sequence even after opening it.'});
        var qeClip = __findQeClipByDomClip(qeSeq.getVideoTrackAt(${ti}), domClip);
        if (!qeClip) return JSON.stringify({success:false,error:'Could not match the clip in QE'});
        var countNamed = function(){ var n=0; for (var i=0;i<domClip.components.numItems;i++){ if (String(domClip.components[i].displayName)===${JSON.stringify(effectName)}) n++; } return n; };
        var before = domClip.components.numItems, namedBefore = countNamed();
        if (namedBefore > 0) return JSON.stringify({success:true,verified:true,verifiedBy:'component already present',direction:${JSON.stringify(direction)},effect:${JSON.stringify(effectName)},alreadyFlipped:true,changed:false});
        var effect = qe.project.getVideoEffectByName(${JSON.stringify(effectName)});
        if (!effect) return JSON.stringify({success:false,error:${JSON.stringify(effectName + ' effect not found on this build')}});
        qeClip.addVideoEffect(effect);
        var after = domClip.components.numItems, namedAfter = countNamed();
        if (namedAfter !== namedBefore + 1) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'component readback',direction:${JSON.stringify(direction)},componentsBefore:before,componentsAfter:after,
            error:${JSON.stringify('The ' + effectName + ' effect did not appear on the clip, so it is not flipped.')} + (after > before ? ' A different component was added instead; check list_effects_on_clip_qe.' : '')});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'component readback',direction:${JSON.stringify(direction)},effect:${JSON.stringify(effectName)},componentsBefore:before,componentsAfter:after,changed:true});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async fadeVideo(
    sequenceId: string | undefined,
    ti: number,
    ci: number,
    durationFrames: number,
    direction: 'in' | 'out',
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        ${this.keyframeVerifyFragment()}
        // Opacity was addressed as components[0].properties[0] with no name check. Confirm
        // the parameter really is Opacity before animating it, or the fade lands on whatever
        // parameter happens to sit at that slot.
        var opComp = null;
        for (var oc=0; oc<clip.components.numItems; oc++) { if (String(clip.components[oc].displayName)==='Opacity') { opComp = clip.components[oc]; break; } }
        if (!opComp) return JSON.stringify({success:false,verified:false,error:'This clip has no Opacity component, so a video fade cannot be keyframed on it.'});
        var opProp = null;
        for (var op=0; op<opComp.properties.numItems; op++) { if (String(opComp.properties[op].displayName)==='Opacity') { opProp = opComp.properties[op]; break; } }
        if (!opProp) return JSON.stringify({success:false,verified:false,error:'The Opacity component on this clip exposes no Opacity parameter, so a video fade cannot be keyframed.'});
        var tvError = null;
        try { opProp.setTimeVarying(true); } catch (eTV) { tvError = eTV.toString(); }
        var ticksPerFrame = Number(seq.timebase) || 10584000000;
        var fadeTicks = ${durationFrames} * ticksPerFrame;
        var t1 = new Time(); var t2 = new Time();
        var v1 = 0, v2 = 100;
        if (${JSON.stringify(direction)} === 'in') {
          t1.ticks = String(Math.round(Number(clip.start.ticks)));
          t2.ticks = String(Math.round(Number(clip.start.ticks) + fadeTicks));
        } else {
          t1.ticks = String(Math.round(Number(clip.end.ticks) - fadeTicks));
          t2.ticks = String(Math.round(Number(clip.end.ticks)));
          v1 = 100; v2 = 0;
        }
        opProp.addKey(t1); opProp.setValueAtKey(t1, v1);
        opProp.addKey(t2); opProp.setValueAtKey(t2, v2);
        var kf = __verifyKeyframes(opProp, [
          { ticks: t1.ticks, value: v1, label: 'fade start' },
          { ticks: t2.ticks, value: v2, label: 'fade end' }
        ]);
        var full = kf.landed === kf.requested;
        return JSON.stringify({
          success: full,
          verified: kf.keysReadable,
          verifiedBy: kf.keysReadable ? 'Opacity getKeys() and getValueAtKey() readback' : undefined,
          unverifiedReason: kf.keysReadable ? undefined : 'getKeys() is not readable on this Opacity parameter, so the fade keyframes cannot be confirmed.',
          direction:${JSON.stringify(direction)}, durationFrames:${durationFrames},
          keyframeCount: kf.keyCount, keyframesLanded: kf.landed, keyframesRequested: kf.requested, keyframes: kf.keys,
          setTimeVaryingError: tvError,
          error: full ? null : ('The fade did not fully land: ' + kf.landed + ' of ' + kf.requested + ' keyframes are present at the requested values' + (tvError ? ', and setTimeVarying threw: ' + tvError : '') + '. See keyframes[].')
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async resetTransform(
    sequenceId: string | undefined,
    ti: number,
    ci: number,
  ): Promise<any> {
    return await this.bridge.executeScript(
      this.motionParamScript(
        sequenceId,
        ti,
        ci,
        [
          { index: 0, name: 'Position', value: [0.5, 0.5] },
          { index: 1, name: 'Scale', value: 100 },
          { index: 4, name: 'Rotation', value: 0 },
          { index: 5, name: 'Anchor Point', value: [0.5, 0.5] },
        ],
        'reset_transform',
      ),
    );
  }

  protected async matchTransform(
    sequenceId: string | undefined,
    srcTi: number,
    srcCi: number,
    targets: Array<{ trackIndex: number; clipIndex: number }>,
  ): Promise<any> {
    const readScript = `
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        var clip = seq.videoTracks[${srcTi}].clips[${srcCi}];
        if (!clip) return JSON.stringify({success:false,error:'Source clip not found'});
        var mot = null;
        for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName)==='Motion'){mot=clip.components[i];break;} }
        if (!mot) return JSON.stringify({success:false,error:'No Motion'});
        var pos=mot.properties[0].getValue(); var scale=mot.properties[1].getValue(); var rot=mot.properties[4].getValue(); var anchor=mot.properties[5].getValue();
        return JSON.stringify({success:true,pos:pos,scale:scale,rot:rot,anchor:anchor});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `;
    const src = await this.bridge.executeScript(readScript);
    if (!src.success) return src;
    const results: any[] = [];
    for (const t of targets) {
      const r = await this.bridge.executeScript(
        this.motionParamScript(
          sequenceId,
          t.trackIndex,
          t.clipIndex,
          [
            { index: 0, name: 'Position', value: src.pos },
            { index: 1, name: 'Scale', value: src.scale },
            { index: 4, name: 'Rotation', value: src.rot },
            { index: 5, name: 'Anchor Point', value: src.anchor },
          ],
          'match_transform',
        ),
      );
      results.push({
        ...t,
        success: r.success,
        verified: r.verified === true,
        applied: r.applied ?? 0,
        requested: r.requested ?? 4,
        error: r.error ?? null,
        properties: r.results ?? null,
      });
    }
    // "matched" used to count scripts that did not throw, and every individual write was
    // swallowed, so a target that received nothing still counted. It now counts targets on
    // which all four Motion parameters read back at the source values.
    const matched = results.filter((r) => r.success).length;
    const partial = results.filter((r) => !r.success && r.applied > 0).length;
    return {
      success: matched === targets.length && targets.length > 0,
      verified: true,
      verifiedBy: 'Motion parameter getValue() readback on every target',
      matched,
      requested: targets.length,
      partiallyApplied: partial,
      results,
      error:
        matched === targets.length
          ? null
          : targets.length === 0
            ? 'No target clips were supplied, so no transform was copied.'
            : `Transform fully landed on ${matched} of ${targets.length} target clips${partial ? `, and PARTIALLY on ${partial} more (those clips are in a mixed state)` : ''}. See results[].`,
    };
  }

  protected async applyLetterbox(
    sequenceId: string | undefined,
    ti: number,
    ci: number,
    aspect?: string,
    cropPercent?: number,
  ): Promise<any> {
    let crop = cropPercent;
    if (!crop && aspect) {
      const parts = aspect!.split(':');
      const w = parseFloat(parts[0] ?? '16');
      const h = parseFloat(parts[1] ?? '9');
      // For a 16:9 source: cropPercent = (1 - (h/w)/(9/16)) / 2 * 100
      const srcAspect = 16 / 9;
      const tgtAspect = w / h;
      crop = Math.max(0, ((1 - srcAspect / tgtAspect) / 2) * 100);
    }
    if (!crop) crop = 11.25; // 2.35:1 default
    // Motion properties[8] and [10] were assumed to be CropTop/CropBottom and each write was
    // swallowed, so a clip that gained no letterbox at all reported verified: true. Route
    // through the name-guarded helper: if this build's Motion has no top/bottom crop
    // parameter, the tool now refuses and lists what Motion does expose, instead of writing
    // 11.25 into whatever parameter happens to sit at index 8.
    const r: any = await this.bridge.executeScript(
      this.motionParamScript(
        sequenceId,
        ti,
        ci,
        [
          { index: 8, name: 'Crop Top', aliases: ['Top', 'crop top'], value: crop },
          { index: 10, name: 'Crop Bottom', aliases: ['Bottom', 'crop bottom'], value: crop },
        ],
        'letterbox',
      ),
    );
    return {
      ...r,
      cropPercent: crop,
      aspect: aspect ?? null,
      hint:
        r?.success === false && r?.applied === 0
          ? 'Crop is a separate effect in Premiere, not part of Motion. Add the Crop effect with apply_effect, then set its parameters with set_effect_property.'
          : undefined,
    };
  }

  protected async kenBurns(args: any): Promise<any> {
    const ti = args.trackIndex ?? 0;
    const ci = args.clipIndex ?? 0;
    const sScale = args.startScale ?? 100;
    const eScale = args.endScale ?? 110;
    const sX = args.startX ?? 0.5;
    const sY = args.startY ?? 0.5;
    const eX = args.endX ?? 0.5;
    const eY = args.endY ?? 0.5;
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        ${this.keyframeVerifyFragment()}
        var mot = null;
        for (var i=0;i<clip.components.numItems;i++){if(String(clip.components[i].displayName)==='Motion'){mot=clip.components[i];break;}}
        if (!mot) return JSON.stringify({success:false,verified:false,error:'This clip has no Motion component, so a Ken Burns move cannot be keyframed on it.'});
        var posProp = null, scaleProp = null;
        for (var mp=0; mp<mot.properties.numItems; mp++) {
          var mpn = String(mot.properties[mp].displayName);
          if (mpn === 'Position') posProp = mot.properties[mp];
          else if (mpn === 'Scale') scaleProp = mot.properties[mp];
        }
        if (!posProp || !scaleProp) return JSON.stringify({success:false,verified:false,error:'Motion on this clip does not expose both a Position and a Scale parameter, so a Ken Burns move cannot be keyframed. Nothing was written.'});
        var tvErrors = [];
        try { posProp.setTimeVarying(true); } catch (eP) { tvErrors.push('Position: ' + eP.toString()); }
        try { scaleProp.setTimeVarying(true); } catch (eS) { tvErrors.push('Scale: ' + eS.toString()); }
        var t1 = new Time(); t1.ticks = String(Math.round(Number(clip.start.ticks)));
        var t2 = new Time(); t2.ticks = String(Math.round(Number(clip.end.ticks)));
        posProp.addKey(t1); posProp.setValueAtKey(t1, [${sX},${sY}]);
        posProp.addKey(t2); posProp.setValueAtKey(t2, [${eX},${eY}]);
        scaleProp.addKey(t1); scaleProp.setValueAtKey(t1, ${sScale});
        scaleProp.addKey(t2); scaleProp.setValueAtKey(t2, ${eScale});
        var posKf = __verifyKeyframes(posProp, [
          { ticks: t1.ticks, value: [${sX},${sY}], label: 'position start' },
          { ticks: t2.ticks, value: [${eX},${eY}], label: 'position end' }
        ]);
        var scaleKf = __verifyKeyframes(scaleProp, [
          { ticks: t1.ticks, value: ${sScale}, label: 'scale start' },
          { ticks: t2.ticks, value: ${eScale}, label: 'scale end' }
        ]);
        var landed = posKf.landed + scaleKf.landed;
        var readable = posKf.keysReadable && scaleKf.keysReadable;
        return JSON.stringify({
          success: landed === 4,
          verified: readable,
          verifiedBy: readable ? 'Motion Position and Scale getKeys() and getValueAtKey() readback' : undefined,
          unverifiedReason: readable ? undefined : 'getKeys() is not readable on the Motion Position or Scale parameter, so the move cannot be confirmed.',
          startScale:${sScale}, endScale:${eScale}, startPosition:[${sX},${sY}], endPosition:[${eX},${eY}],
          keyframesLanded: landed, keyframesRequested: 4,
          position: posKf.keys, scale: scaleKf.keys, setTimeVaryingErrors: tvErrors.length ? tvErrors : undefined,
          error: landed === 4 ? null : ('PARTIALLY APPLIED: only ' + landed + ' of the 4 Ken Burns keyframes are present at the requested values, so the clip holds an incomplete move. See position[] and scale[].')
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setClipScaleToFrameSize(
    sequenceId: string | undefined,
    ti: number,
    ci: number,
    enabled: boolean,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        var clip = __qeClipByIndex(seq, 'video', ${ti}, ${ci});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        // scaleToFrameSize is one of the QE clip properties measured SAFE to read on 26.3.2,
        // so there is no excuse for the unconditional verified: true this used to return.
        var before = null; try { before = Boolean(clip.scaleToFrameSize); } catch(eB) {}
        clip.setScaleToFrameSize(${enabled});
        var after = null; try { after = Boolean(clip.scaleToFrameSize); } catch(eA) {}
        if (after === null) {
          return JSON.stringify({success:true,verified:false,enabled:${enabled},before:before,
            unverifiedReason:'setScaleToFrameSize() did not throw, but qeClip.scaleToFrameSize is not readable on this build, so the flag cannot be confirmed.'});
        }
        if (after !== ${enabled}) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'qeClip.scaleToFrameSize readback',enabled:${enabled},before:before,after:after,changed:before!==after,
            error:'Scale to frame size still reads ' + String(after) + ' after being set to ${enabled}.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'qeClip.scaleToFrameSize readback',enabled:${enabled},before:before,after:after,changed:before!==after,
          note: before === after ? 'The clip was already set this way; nothing changed.' : undefined});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  /**
   * Scale-to-frame-size across many clips in one call.
   *
   * The per-clip tool means one round-trip per clip, so normalising a 45-clip
   * stringout cost 45 calls. Scope is a whole video track, every video track, or
   * an explicit clip-id list.
   *
   * QE items are matched to DOM clips by start time via __findQeClipByDomClip,
   * not by index: a QE track also contains gaps and transitions, so the DOM clip
   * index addresses a different item as soon as anything precedes the target.
   *
   * setScaleToFrameSize() requires an EXPLICIT boolean -- called with no
   * argument it throws "Error: Not Enough Parameters" rather than defaulting to
   * true, so `enabled` is always passed through.
   */
  protected async setScaleToFrameSizeBatch(
    enabled: boolean,
    sequenceId?: string,
    trackIndex?: number,
    clipIds?: string[],
  ): Promise<any> {
    const idFilter = Array.isArray(clipIds) && clipIds.length ? JSON.stringify(clipIds) : 'null';
    return await this.bridge.executeScript(`
      try {
        var seq = __findSequence(${sequenceId !== undefined ? JSON.stringify(sequenceId) : 'null'});
        if (!seq) return JSON.stringify({success:false,error:'Sequence not found. Pass a sequenceId from list_sequences, or open a sequence.'});
        app.enableQE();
        var qeSeq = __qeSequenceOpening(seq);
        if (!qeSeq) return JSON.stringify({success:false,error:"Could not address sequence '" + String(seq.name) + "' through the QE API."});

        var wantedIds = ${idFilter};
        function __wanted(nodeId) {
          if (wantedIds === null) return true;
          for (var w = 0; w < wantedIds.length; w++) { if (String(wantedIds[w]) === String(nodeId)) return true; }
          return false;
        }

        var firstTrack = ${trackIndex !== undefined ? trackIndex : 'null'};
        var lastTrack = firstTrack === null ? (seq.videoTracks.numTracks - 1) : firstTrack;
        if (firstTrack === null) firstTrack = 0;
        if (firstTrack < 0 || lastTrack >= seq.videoTracks.numTracks) {
          return JSON.stringify({success:false,error:'trackIndex ' + ${trackIndex !== undefined ? trackIndex : 'null'} + ' is out of range; the sequence has ' + seq.videoTracks.numTracks + ' video tracks (0-based).'});
        }

        var applied = [], failed = [], skipped = [], seenIds = [];
        for (var t = firstTrack; t <= lastTrack; t++) {
          var domTrack = seq.videoTracks[t];
          var qeTrack = null;
          try { qeTrack = qeSeq.getVideoTrackAt(t); } catch (eTrack) {}
          if (!qeTrack) { failed.push({trackIndex:t,error:'QE could not address video track ' + t}); continue; }
          for (var c = 0; c < domTrack.clips.numItems; c++) {
            var domClip = domTrack.clips[c];
            var nodeId = null; try { nodeId = String(domClip.nodeId); } catch (eNode) {}
            if (!__wanted(nodeId)) continue;
            seenIds.push(nodeId);
            var qeClip = __findQeClipByDomClip(qeTrack, domClip);
            if (!qeClip) { failed.push({trackIndex:t,clipIndex:c,nodeId:nodeId,name:String(domClip.name),error:'No QE item matches this clip start time.'}); continue; }
            var before = null; try { before = Boolean(qeClip.scaleToFrameSize); } catch (eB) {}
            try {
              // Explicit boolean: called with no argument this throws
              // "Error: Not Enough Parameters" instead of defaulting.
              qeClip.setScaleToFrameSize(${enabled});
            } catch (eSet) {
              failed.push({trackIndex:t,clipIndex:c,nodeId:nodeId,name:String(domClip.name),error:eSet.toString()});
              continue;
            }
            var after = null; try { after = Boolean(qeClip.scaleToFrameSize); } catch (eA) {}
            var entry = {trackIndex:t,clipIndex:c,nodeId:nodeId,name:String(domClip.name),before:before,after:after};
            if (after === null) {
              // Unreadable flag is "unknown", not "done" -- reported separately
              // so a caller is never told 45 clips were verified when none were.
              entry.verified = false;
              entry.unverifiedReason = 'qeClip.scaleToFrameSize is not readable on this build, so the flag cannot be confirmed.';
              skipped.push(entry);
            } else if (after !== ${enabled}) {
              entry.error = 'Scale to frame size still reads ' + String(after) + ' after being set to ${enabled}.';
              failed.push(entry);
            } else {
              entry.verified = true;
              entry.changed = before !== after;
              applied.push(entry);
            }
          }
        }

        var missingIds = [];
        if (wantedIds !== null) {
          for (var mi = 0; mi < wantedIds.length; mi++) {
            var seen = false;
            for (var si = 0; si < seenIds.length; si++) { if (String(seenIds[si]) === String(wantedIds[mi])) { seen = true; break; } }
            if (!seen) missingIds.push(String(wantedIds[mi]));
          }
        }

        var total = applied.length + failed.length + skipped.length;
        return JSON.stringify({
          success: failed.length === 0 && missingIds.length === 0 && total > 0,
          verified: failed.length === 0 && skipped.length === 0 && missingIds.length === 0 && total > 0,
          verifiedBy: 'qeClip.scaleToFrameSize readback per clip',
          enabled: ${enabled},
          sequenceId: seq.sequenceID,
          sequenceName: String(seq.name),
          trackScope: ${trackIndex !== undefined ? `'video track ' + ${trackIndex}` : "'all video tracks'"},
          clipsMatched: total,
          appliedCount: applied.length,
          applied: applied,
          failed: failed.length ? failed : undefined,
          unverified: skipped.length ? skipped : undefined,
          notFoundClipIds: missingIds.length ? missingIds : undefined,
          error: total === 0
            ? 'No clips matched the requested scope, so nothing was changed.'
            : (failed.length || missingIds.length
                ? ('PARTIALLY APPLIED: ' + applied.length + ' of ' + total + ' clips confirmed. See failed[] and notFoundClipIds[].')
                : null)
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setFrameBlendQe(
    trackIndex: number,
    clipIndex: number,
    enabled: boolean,
    sequenceId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      __clip.setFrameBlend(${enabled});
      return JSON.stringify({success:true,frameBlend:__clip.frameBlend});
    `);
  }

  protected async setClipBorderWidth(
    trackIndex: number,
    clipIndex: number,
    _width: number,
    sequenceId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      // A CALL THAT KILLS THE SCRIPT IS NOT WORTH EMITTING.
      // Measured one-call-per-script on 26.3.2: qeClip.setBorderWidth, setBorderColor, setReverse and setAntiAliasQuality do not throw a catchable exception — they terminate the entire evalScript, so the tool returned only the generic "ExtendScript execution failed" and the caller learned nothing.
      // Reading the matching properties (borderWidth, borderColor, reverse, antiAliasQuality, alignment, startPercent, endPercent, switchSources) is fatal in the same way.
      // setFrameBlend and setScaleToFrameSize are fine, so this is specific, not a blanket QE problem.
      return JSON.stringify({success:false,verified:true,available:false,error:'qeClip.setBorderWidth terminates the ExtendScript engine on this build (26.3.2), so this tool cannot run. No scripted alternative exists for clip borders; set them in the Effect Controls panel.'});

    `);
  }

  protected async cropClip(
    clipId: string,
    options: {
      left?: number;
      right?: number;
      top?: number;
      bottom?: number;
      zoom?: boolean;
      edgeFeather?: number;
    },
  ): Promise<any> {
    const params: Record<string, any> = {};
    if (options.left !== undefined) params['Left'] = options.left;
    if (options.top !== undefined) params['Top'] = options.top;
    if (options.right !== undefined) params['Right'] = options.right;
    if (options.bottom !== undefined) params['Bottom'] = options.bottom;
    if (options.zoom !== undefined) params['Zoom'] = options.zoom;
    if (options.edgeFeather !== undefined) params['Edge Feather'] = options.edgeFeather;

    const paramJson = JSON.stringify(params);
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        if (info.trackType !== "video") return JSON.stringify({ success: false, error: "crop_clip only supports video clips" });

        var clip = info.clip;
        var cropComp = null;
        var cropCompIdx = -1;

        function isCropComponent(component) {
          return String(component.displayName) === "Crop" || String(component.matchName) === "AE.ADBE AECrop";
        }

        function findCropComponent() {
          for (var i = clip.components.numItems - 1; i >= 0; i--) {
            var component = clip.components[i];
            if (isCropComponent(component)) {
              cropComp = component;
              cropCompIdx = i;
              return true;
            }
          }
          return false;
        }

        var effectAdded = false;
        if (!findCropComponent()) {
          // Addressed by id, not by whatever is on screen. __findClip() searches every
          // sequence in the project, so a clip can be resolved out of one sequence and
          // then, through getActiveSequence(), have the effect applied to whichever
          // clip sits at the same track and index in a different one.
          var qeSeq = __qeSequenceOpening(info.sequence);
          if (!qeSeq) return JSON.stringify({ success: false, error: "QE active sequence not available" });
          var qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
          if (!qeTrack) return JSON.stringify({ success: false, error: "QE video track not found for clip" });
          var effect = qe.project.getVideoEffectByName("Crop");
          if (!effect) return JSON.stringify({ success: false, error: "Crop effect not found. Use list_available_effects to inspect installed effects." });

          function findQeClipByTime() {
            var targetTicks = String(info.clip.start.ticks);
            var best = null;
            var bestDelta = null;
            for (var qi = 0; qi < qeTrack.numItems; qi++) {
              var item = qeTrack.getItemAt(qi);
              if (!item || String(item.type) !== "Clip") continue;
              var itemTicks = String(item.start.ticks);
              if (itemTicks === targetTicks) return item;
              var delta = Math.abs(parseInt(itemTicks, 10) - parseInt(targetTicks, 10));
              if (best === null || delta < bestDelta) {
                best = item;
                bestDelta = delta;
              }
            }
            return best;
          }

          var beforeCount = clip.components.numItems;
          var qeClip = findQeClipByTime();
          if (!qeClip) return JSON.stringify({ success: false, error: "Could not locate matching QE clip for Crop effect" });
          qeClip.addVideoEffect(effect);
          if (clip.components.numItems <= beforeCount) {
            return JSON.stringify({
              success: false,
              error: "Crop effect add did not create a new component on the target clip",
              beforeComponentCount: beforeCount,
              afterComponentCount: clip.components.numItems
            });
          }
          effectAdded = true;
          if (!findCropComponent()) {
            var addedNames = [];
            for (var ai = beforeCount; ai < clip.components.numItems; ai++) {
              addedNames.push(String(clip.components[ai].displayName));
            }
            return JSON.stringify({
              success: false,
              error: "Effect add completed but the new component was not Crop",
              addedComponents: addedNames
            });
          }
        }

        var requestedParams = ${paramJson};
        var paramResults = [];
        function normalize(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }
        for (var pName in requestedParams) {
          if (requestedParams.hasOwnProperty && !requestedParams.hasOwnProperty(pName)) continue;
          var requestedVal = requestedParams[pName];
          var matched = null;
          for (var k = 0; k < cropComp.properties.numItems; k++) {
            if (String(cropComp.properties[k].displayName) === pName) {
              matched = { prop: cropComp.properties[k], strategy: "exact" };
              break;
            }
          }
          if (!matched) {
            var nameN = normalize(pName);
            for (var nk = 0; nk < cropComp.properties.numItems; nk++) {
              if (normalize(String(cropComp.properties[nk].displayName)) === nameN) {
                matched = { prop: cropComp.properties[nk], strategy: "normalized" };
                break;
              }
            }
          }
          if (!matched) {
            paramResults.push({ requestedName: pName, ok: false, error: "no Crop property matches this displayName" });
            continue;
          }
          try {
            var valueBefore = null;
            try { valueBefore = matched.prop.getValue(); } catch (eB) {}
            matched.prop.setValue(requestedVal, true);
            var valueAfter = null;
            try { valueAfter = matched.prop.getValue(); } catch (eA) {}
            var clamped = false;
            if (typeof valueAfter === "number" && typeof requestedVal === "number") {
              clamped = Math.abs(valueAfter - requestedVal) > 0.0001;
            } else {
              clamped = valueAfter !== requestedVal;
            }
            // A clamped value is a legitimate outcome (Crop clamps to its domain), but a PURE
            // no-op -- the value neither moved from before nor matches the request -- is a silent
            // failure and must not be reported ok. Only guard the numeric case (clamping applies there).
            var noOp = false;
            if (typeof valueAfter === "number" && typeof requestedVal === "number" && typeof valueBefore === "number") {
              noOp = (Math.abs(valueAfter - valueBefore) < 0.0001) && (Math.abs(valueAfter - requestedVal) > 0.0001);
            }
            paramResults.push({
              requestedName: pName,
              matchedDisplayName: String(matched.prop.displayName),
              strategy: matched.strategy,
              valueRequested: requestedVal,
              valueBefore: valueBefore,
              valueAfter: valueAfter,
              clamped: clamped,
              ok: !noOp,
              error: noOp ? "setValue did not change the value (silent no-op)" : undefined
            });
          } catch (eSet) {
            paramResults.push({ requestedName: pName, ok: false, error: "setValue threw: " + eSet.toString() });
          }
        }

        var propsDump = [];
        for (var pi = 0; pi < cropComp.properties.numItems; pi++) {
          var prop = cropComp.properties[pi];
          var val = null;
          try { val = prop.getValue(); } catch (eVal) { val = "<getValue threw: " + eVal.toString() + ">"; }
          propsDump.push({ index: pi, displayName: String(prop.displayName), value: val });
        }

        var failedParams = [];
        for (var pr = 0; pr < paramResults.length; pr++) {
          if (!paramResults[pr].ok) failedParams.push(paramResults[pr]);
        }

        return JSON.stringify({
          success: failedParams.length === 0,
          message: effectAdded ? "Crop effect applied" : "Existing Crop effect updated",
          clipId: ${JSON.stringify(clipId)},
          effectName: "Crop",
          effectAdded: effectAdded,
          componentIndex: cropCompIdx,
          properties: propsDump,
          paramResults: paramResults,
          error: failedParams.length ? "One or more Crop parameters could not be set" : undefined
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "Crop effect failed: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async pipLayout(
    trackIndex: number,
    clipIndex: number,
    corner: string,
    sizePercent: number,
    seqId?: string,
  ): Promise<any> {
    const positions: Record<string, [number, number]> = {
      'top-left': [0.125, 0.125],
      'top-right': [0.875, 0.125],
      'bottom-left': [0.125, 0.875],
      'bottom-right': [0.875, 0.875],
    };
    const [px, py] = positions[corner] ?? [0.875, 0.125];
    const scale = sizePercent;
    // This tool already read Position and Scale back and then ignored both, returning
    // verified: true whatever they said. The helper compares them.
    const r: any = await this.bridge.executeScript(
      this.motionParamScript(
        seqId,
        trackIndex,
        clipIndex,
        [
          { index: 0, name: 'Position', value: [px, py] },
          { index: 1, name: 'Scale', value: scale },
        ],
        'pip_layout',
      ),
    );
    return { ...r, corner, sizePercent: scale };
  }

  protected async gridLayout(
    clips: Array<{ trackIndex: number; clipIndex: number }>,
    cols: number,
    seqId?: string,
  ): Promise<any> {
    const rows = Math.ceil(clips.length / cols);
    const scale = Math.floor(100 / cols);
    const positions = clips.map((_, i) => {
      const col = i % cols,
        row = Math.floor(i / cols);
      return [(col + 0.5) / cols, (row + 0.5) / rows];
    });
    // The old script skipped a missing clip with `continue`, swallowed every write, and
    // still returned verified: true with clipCount = the number REQUESTED — so a grid that
    // landed on nothing reported a verified success for every tile.
    const r: any = await this.bridge.executeScript(
      this.motionParamBatchScript(
        seqId,
        clips.map((c, i) => ({
          trackIndex: c.trackIndex,
          clipIndex: c.clipIndex,
          targets: [
            { index: 0, name: 'Position', value: [positions[i]![0]!, positions[i]![1]!] },
            { index: 1, name: 'Scale', value: scale },
          ] as MotionParamTarget[],
        })),
        'grid_layout',
      ),
    );
    return { ...r, cols, rows, scale, clipsRequested: clips.length };
  }

  protected async splitScreenLayout(
    clips: Array<{ trackIndex: number; clipIndex: number }>,
    orientation: string,
    seqId?: string,
  ): Promise<any> {
    const n = clips.length;
    const positions =
      orientation === 'horizontal'
        ? clips.map((_, i) => ({
            x: (i + 0.5) / n,
            y: 0.5,
            cropLeft: (i / n) * 100,
            cropRight: ((n - i - 1) / n) * 100,
          }))
        : clips.map((_, i) => ({
            x: 0.5,
            y: (i + 0.5) / n,
            cropTop: (i / n) * 100,
            cropBottom: ((n - i - 1) / n) * 100,
          }));
    const splitScale = Math.floor(100 / n);
    const r: any = await this.bridge.executeScript(
      this.motionParamBatchScript(
        seqId,
        clips.map((c, i) => ({
          trackIndex: c.trackIndex,
          clipIndex: c.clipIndex,
          targets: [
            { index: 0, name: 'Position', value: [positions[i]!.x, positions[i]!.y] },
            { index: 1, name: 'Scale', value: splitScale },
          ] as MotionParamTarget[],
        })),
        'split_screen_layout',
      ),
    );
    // The crop halves of the layout are computed but Motion has no crop parameter to write
    // them to, so they are returned as data rather than implied to have been applied.
    return {
      ...r,
      orientation,
      scale: splitScale,
      clipsRequested: clips.length,
      cropsNotApplied: positions,
      note: 'Position and Scale were applied. The per-clip crop values are returned but NOT applied: crop is a separate effect in Premiere, not a Motion parameter. Add the Crop effect with apply_effect and set them with set_effect_property.',
    };
  }

  protected async resetMotionToDefaults(
    trackIndex: number,
    clipIndex: number,
    seqId?: string,
  ): Promise<any> {
    // Eleven bare-index writes, no readback, unconditional verified: true. Indices 7..10 were
    // assumed to be crop; each target now carries the name it must be, and a parameter that is
    // not where it was expected is reported instead of written blind.
    return await this.bridge.executeScript(
      this.motionParamScript(
        seqId,
        trackIndex,
        clipIndex,
        [
          { index: 0, name: 'Position', value: [0.5, 0.5] },
          { index: 1, name: 'Scale', value: 100 },
          { index: 2, name: 'Scale Width', aliases: ['Scale Height'], value: 100 },
          { index: 3, name: 'Uniform Scale', value: true },
          { index: 4, name: 'Rotation', value: 0 },
          { index: 5, name: 'Anchor Point', value: [0.5, 0.5] },
          { index: 6, name: 'Anti-flicker Filter', aliases: ['Anti-flicker filter'], value: 0 },
        ],
        'reset_motion_to_defaults',
      ),
    );
  }

  protected async alignClipsSpatial(
    clips: Array<{ trackIndex: number; clipIndex: number }>,
    alignment: string,
    seqId?: string,
  ): Promise<any> {
    const axis: Record<string, [0 | 1, number]> = {
      left: [0, 0.1],
      center: [0, 0.5],
      right: [0, 0.9],
      top: [1, 0.1],
      middle: [1, 0.5],
      bottom: [1, 0.9],
    };
    const target = axis[alignment];
    if (!target) {
      return {
        success: false,
        verified: false,
        error: `Unrecognised alignment "${alignment}". Use one of: ${Object.keys(axis).join(', ')}.`,
      };
    }
    // Read the current Position of each clip first: alignment overrides one axis and keeps
    // the other, so the write target is not known until the current value is in hand. The
    // old version did the read on the host, then swallowed the write and reported
    // count = the number requested regardless of what landed.
    const read: any = await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        var clips=${JSON.stringify(clips)};
        var out=[];
        for(var i=0;i<clips.length;i++){
          var track=seq.videoTracks[clips[i].trackIndex];
          var clip=track?track.clips[clips[i].clipIndex]:null;
          if(!clip){ out.push({trackIndex:clips[i].trackIndex,clipIndex:clips[i].clipIndex,position:null,error:'Clip not found'}); continue; }
          var motion=null;
          for(var c=0;c<clip.components.numItems;c++){ if(String(clip.components[c].displayName)==='Motion'){motion=clip.components[c];break;} }
          if(!motion){ out.push({trackIndex:clips[i].trackIndex,clipIndex:clips[i].clipIndex,position:null,error:'No Motion component'}); continue; }
          var pos=null;
          for(var p=0;p<motion.properties.numItems;p++){ if(String(motion.properties[p].displayName)==='Position'){ try{pos=motion.properties[p].getValue();}catch(eG){} break; } }
          out.push({trackIndex:clips[i].trackIndex,clipIndex:clips[i].clipIndex,position:pos,error:pos===null?'Motion has no readable Position parameter':null});
        }
        return JSON.stringify({success:true,positions:out});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
    if (!read?.success) return { ...read, verified: false };
    const entries: Array<{ trackIndex: number; clipIndex: number; targets: MotionParamTarget[] }> =
      [];
    const unreadable: any[] = [];
    for (const p of read.positions ?? []) {
      if (!p.position) {
        unreadable.push(p);
        continue;
      }
      const next = [Number(p.position[0]), Number(p.position[1])];
      next[target[0]] = target[1];
      entries.push({
        trackIndex: p.trackIndex,
        clipIndex: p.clipIndex,
        targets: [{ index: 0, name: 'Position', value: next }],
      });
    }
    if (!entries.length) {
      return {
        success: false,
        verified: true,
        alignment,
        requested: clips.length,
        aligned: 0,
        unreadable,
        error:
          'None of the requested clips exposed a readable Motion Position parameter, so nothing was aligned. See unreadable[].',
      };
    }
    const r: any = await this.bridge.executeScript(
      this.motionParamBatchScript(seqId, entries, 'align_clips_spatial'),
    );
    const aligned = r?.clipsFullyApplied ?? 0;
    return {
      ...r,
      alignment,
      requested: clips.length,
      aligned,
      unreadable,
      success: r?.success === true && unreadable.length === 0,
      error:
        r?.success === true && unreadable.length === 0
          ? null
          : (r?.error ??
            `Aligned ${aligned} of ${clips.length} requested clips; ${unreadable.length} had no readable Motion Position. See clips[] and unreadable[].`),
    };
  }

  protected async safeAreaCheck(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq=${this.buildSeqRes(seqId)};
      var w=seq.frameSizeHorizontal,h=seq.frameSizeVertical;
      return JSON.stringify({success:true,width:w,height:h,actionSafe:{left:Math.round(w*0.05),top:Math.round(h*0.05),right:Math.round(w*0.95),bottom:Math.round(h*0.95)},titleSafe:{left:Math.round(w*0.1),top:Math.round(h*0.1),right:Math.round(w*0.9),bottom:Math.round(h*0.9)}});
    `);
  }

  protected async setClipCrop(
    trackIndex: number,
    clipIndex: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    seqId?: string,
  ): Promise<any> {
    const r: any = await this.bridge.executeScript(
      this.motionParamScript(
        seqId,
        trackIndex,
        clipIndex,
        [
          { index: 7, name: 'Crop Left', aliases: ['Left'], value: left },
          { index: 8, name: 'Crop Top', aliases: ['Top'], value: top },
          { index: 9, name: 'Crop Right', aliases: ['Right'], value: right },
          { index: 10, name: 'Crop Bottom', aliases: ['Bottom'], value: bottom },
        ],
        'set_clip_crop',
      ),
    );
    return {
      ...r,
      left,
      top,
      right,
      bottom,
      hint:
        r?.success === false && r?.applied === 0
          ? 'Crop is a separate effect in Premiere, not part of Motion. Add the Crop effect with apply_effect, then set Left/Top/Right/Bottom with set_effect_property.'
          : undefined,
    };
  }

  protected async toggleUniformScale(
    trackIndex: number,
    clipIndex: number,
    uniformScale: boolean,
    seqId?: string,
  ): Promise<any> {
    // Was a bare `getValue() === uniformScale` with no `before`, so an already-correct clip
    // and a successful write were indistinguishable, and a failed write reported
    // verified: false with no reason at all.
    const r: any = await this.bridge.executeScript(
      this.motionParamScript(
        seqId,
        trackIndex,
        clipIndex,
        [{ index: 3, name: 'Uniform Scale', value: uniformScale }],
        'toggle_uniform_scale',
      ),
    );
    const first = r?.results?.[0];
    return { ...r, uniformScale, changed: first ? first.changed === true : undefined };
  }

  // Auto Reframe Implementation
  protected async autoReframeSequence(
    sequenceId: string,
    numerator: number,
    denominator: number,
    motionPreset?: string,
    newName?: string,
  ): Promise<any> {
    const preset = motionPreset || 'default';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var reframedName = ${newName ? JSON.stringify(newName) : 'sequence.name + " Reframed"'};
        sequence.autoReframeSequence(${numerator}, ${denominator}, ${JSON.stringify(preset)}, reframedName, false);
        return JSON.stringify({
          success: true,
          message: "Sequence auto-reframed",
          aspectRatio: ${numerator} + ":" + ${denominator},
          motionPreset: ${JSON.stringify(preset)},
          newName: reframedName
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }
}
