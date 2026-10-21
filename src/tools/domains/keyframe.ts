/**
 * KeyframeTools -- the Keyframes & Animation tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { InterchangeTools } from './interchange.js';
import {
  type EaseKeyframe,
  type EaseSampleOptions,
  sampleEaseKeyframes,
} from '../easing.js';

export class KeyframeTools extends InterchangeTools {
  /**
   * The Motion component's counterpart to lumetriParamScript, and it exists for the same
   * reason. Seven tools (reset_transform, match_transform, letterbox, pip_layout,
   * grid_layout, reset_motion_to_defaults, set_clip_crop) wrote Motion properties by bare
   * numeric index with EVERY assignment inside its own try/catch, then returned
   * `verified: true` unconditionally — so a rejected write, a shifted parameter list and a
   * successful edit were indistinguishable in the response. Same defect the colour family
   * had, same fix: each target is an {index, name, value}, the index is only trusted when it
   * holds the expected NAME, every write is read back and compared, and a partial
   * application is reported as partial.
   *
   * The name guard matters more here than for Lumetri. Premiere's Motion component exposes
   * Position/Scale/Rotation/Anchor Point/Anti-flicker Filter; Crop is a SEPARATE effect. The
   * old code wrote crop values to Motion properties[7..10] on an assumption nobody had
   * measured, and an unverified index writes a real value into the wrong parameter with no
   * error at all. Refusing with the list of parameters actually present is the honest
   * outcome when the name is not where it was expected.
   */
  /**
   * ES3 fragment defining `__verifyKeyframes(prop, specs)`.
   *
   * Six tools wrote keyframes with addKey/setValueAtKey and then returned
   * `verified: true` unconditionally — ken_burns, keyframe_zoom_in/out, fade_in_video,
   * fade_out_video. Two of them called getKeys() and threw the answer away. A keyframe write
   * fails quietly whenever setTimeVarying is refused or the value is out of the parameter's
   * range, so "did not throw" says nothing about whether the animation exists.
   *
   * Presence is proven from getKeys() (a list of Time objects) rather than
   * keyExistsAtTime(), because the argument type that accessor wants is not consistent
   * across this API. The value is read with a Time object first and a seconds number second,
   * and an unreadable value is reported as unreadable rather than assumed correct.
   */
  protected keyframeVerifyFragment(): string {
    return `
      function __kfMatch(a, b) {
        if (a === null || a === undefined) return false;
        var bIsArr = Array.isArray ? Array.isArray(b) : (b && typeof b.length === 'number' && typeof b !== 'string');
        var aIsArr = Array.isArray ? Array.isArray(a) : (a && typeof a.length === 'number' && typeof a !== 'string');
        if (bIsArr) {
          if (!aIsArr || a.length !== b.length) return false;
          for (var vi=0; vi<b.length; vi++) { if (Math.abs(Number(a[vi]) - Number(b[vi])) > 0.001) return false; }
          return true;
        }
        if (aIsArr) return false;
        return Math.abs(Number(a) - Number(b)) < 0.001;
      }
      function __verifyKeyframes(prop, specs) {
        var keyTicks = [], keysReadable = true;
        try {
          var kk = prop.getKeys();
          if (!kk) keysReadable = false;
          else { for (var ki=0; ki<kk.length; ki++) keyTicks.push(String(Math.round(Number(kk[ki].ticks)))); }
        } catch (eK) { keysReadable = false; }
        var out = [], landed = 0;
        for (var s=0; s<specs.length; s++) {
          var wantTicks = String(Math.round(Number(specs[s].ticks)));
          var present = keysReadable ? (keyTicks.indexOf(wantTicks) >= 0) : null;
          var val = null, valueReadable = false;
          if (present !== false) {
            var tObj = new Time(); tObj.ticks = wantTicks;
            try { val = prop.getValueAtKey(tObj); valueReadable = val !== null && val !== undefined; } catch (eV1) {}
            if (!valueReadable) {
              try { val = prop.getValueAtKey(Number(wantTicks) / 254016000000); valueReadable = val !== null && val !== undefined; } catch (eV2) {}
            }
          }
          var ok = present === true && valueReadable && __kfMatch(val, specs[s].value);
          if (ok) landed++;
          out.push({
            label: specs[s].label, ticks: wantTicks, keyPresent: present, valueAtKey: val, valueRequested: specs[s].value, ok: ok,
            error: ok ? null : (
              present === false ? 'No keyframe exists at this time; addKey did not take.'
              : (present === null ? 'getKeys() is not readable on this parameter, so the keyframe cannot be confirmed.'
              : (!valueReadable ? 'The keyframe exists but its value is not readable, so the animation value is unconfirmed.'
              : 'The keyframe exists but holds ' + String(val) + ' rather than the requested ' + String(specs[s].value) + '.')))
          });
        }
        return { landed: landed, requested: specs.length, keys: out, keysReadable: keysReadable, keyCount: keyTicks.length };
      }
    `;
  }

  protected async setTimeInterpolationType(trackIndex: number, clipIndex: number, type: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      __clip.setTimeInterpolationType(${type});
      return JSON.stringify({success:true,type:${type},note:'0=frameSampling,1=frameBlend,2=opticalFlow'});
    `);
  }

  protected async keyframeZoom(trackIndex: number, clipIndex: number, startScale: number, endScale: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        ${this.keyframeVerifyFragment()}
        var seq=${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        var track=seq.videoTracks[${trackIndex}];
        var clip=track?track.clips[${clipIndex}]:null;
        if(!clip)return JSON.stringify({success:false,error:'No clip at video track ${trackIndex} index ${clipIndex}'});
        // components[1].properties[1] was assumed to be Motion > Scale. Resolve it by name:
        // an unverified index animates whatever is in that slot, silently.
        var mot=null;
        for(var mi=0;mi<clip.components.numItems;mi++){if(String(clip.components[mi].displayName)==='Motion'){mot=clip.components[mi];break;}}
        if(!mot)return JSON.stringify({success:false,verified:false,error:'This clip has no Motion component, so a scale animation cannot be keyframed on it.'});
        var scaleProp=null;
        for(var sp=0;sp<mot.properties.numItems;sp++){if(String(mot.properties[sp].displayName)==='Scale'){scaleProp=mot.properties[sp];break;}}
        if(!scaleProp)return JSON.stringify({success:false,verified:false,error:'Motion on this clip exposes no Scale parameter, so a scale animation cannot be keyframed. Nothing was written.'});
        var tvError=null;
        try{scaleProp.setTimeVarying(true);}catch(eTV){tvError=eTV.toString();}
        var t1=new Time();t1.ticks=String(Math.round(Number(clip.start.ticks)));
        var t2=new Time();t2.ticks=String(Math.round(Number(clip.end.ticks)));
        scaleProp.addKey(t1);scaleProp.setValueAtKey(t1,${startScale});
        scaleProp.addKey(t2);scaleProp.setValueAtKey(t2,${endScale});
        var kf=__verifyKeyframes(scaleProp,[
          { ticks: t1.ticks, value: ${startScale}, label: 'zoom start' },
          { ticks: t2.ticks, value: ${endScale}, label: 'zoom end' }
        ]);
        var full=kf.landed===kf.requested;
        return JSON.stringify({
          success: full,
          verified: kf.keysReadable,
          verifiedBy: kf.keysReadable ? 'Motion Scale getKeys() and getValueAtKey() readback' : undefined,
          unverifiedReason: kf.keysReadable ? undefined : 'getKeys() is not readable on the Motion Scale parameter, so the zoom cannot be confirmed.',
          startScale:${startScale},endScale:${endScale},
          keyframeCount:kf.keyCount,keyframesLanded:kf.landed,keyframesRequested:kf.requested,keyframes:kf.keys,
          setTimeVaryingError:tvError,
          error: full ? null : ('The zoom did not fully land: ' + kf.landed + ' of ' + kf.requested + ' keyframes are present at the requested scale values' + (tvError ? ', and setTimeVarying threw: ' + tvError : '') + '. See keyframes[].')
        });
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async findKeyframeNearTime(trackIndex: number, clipIndex: number, componentIndex: number, paramIndex: number, timeSeconds: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var track = seq.videoTracks[${trackIndex}];
        var clip = track && track.clips[${clipIndex}];
        if (!clip) return JSON.stringify({ success: false, error: 'Clip not found' });
        var comp = clip.components[${componentIndex}];
        if (!comp) return JSON.stringify({ success: false, error: 'Component ${componentIndex} not found on clip' });
        var prop = comp.properties[${paramIndex}];
        if (!prop) return JSON.stringify({ success: false, error: 'Param ${paramIndex} not found on component' });
        var t = new Time(); t.seconds = ${timeSeconds};
        var o = { success: true, component: String(comp.displayName), param: String(prop.displayName), timeSeconds: ${timeSeconds} };
        try { o.keyframesSupported = prop.areKeyframesSupported(); } catch(x) {}
        try { o.isTimeVarying = prop.isTimeVarying(); } catch(x) {}
        try { o.isEmpty = prop.isEmpty(); } catch(x) {}
        try { o.keyExistsAtTime = prop.keyExistsAtTime(t); } catch(x) {}
        try { var nk = prop.findNearestKey(t, 1); o.nearestKeySeconds = nk ? nk.seconds : null; } catch(x) { o.nearestKeyError = String(x); }
        try { var nx = prop.findNextKey(t); o.nextKeySeconds = nx ? nx.seconds : null; } catch(x) {}
        try { var pv = prop.findPreviousKey(t); o.previousKeySeconds = pv ? pv.seconds : null; } catch(x) {}
        try { o.valueAtTime = prop.getValueAtTime(t); } catch(x) {}
        try { o.colorValueAtTime = prop.getColorValue ? prop.getColorValue() : null; } catch(x) {}
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  // Keyframe Implementation
  protected async addKeyframe(clipId: string, componentName: string, paramName: string, time: number, value: number): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var param = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          if (comp.displayName === ${JSON.stringify(componentName)}) {
            for (var j = 0; j < comp.properties.numItems; j++) {
              if (comp.properties[j].displayName === ${JSON.stringify(paramName)}) {
                param = comp.properties[j];
                break;
              }
            }
            if (param) break;
          }
        }
        if (!param) return JSON.stringify({ success: false, error: "Parameter " + ${JSON.stringify(paramName)} + " not found in component " + ${JSON.stringify(componentName)} });
        param.setTimeVarying(true);
        param.addKey(${time});
        param.setValueAtKey(${time}, ${value}, true);
        var keyThere = null; try { keyThere = param.keyExistsAtTime(${time}); } catch (eKey) {}
        if (keyThere === false) return JSON.stringify({ success: false, verified: false, error: "Premiere did not add a keyframe at ${time}s (no key present after addKey)." });
        var keyVal = null; try { keyVal = param.getValueAtKey(${time}); } catch (eVal) {}
        if (keyVal !== null && typeof keyVal === "number" && Math.abs(Number(keyVal) - ${value}) > 0.01) return JSON.stringify({ success: false, verified: true, verifiedBy: "keyExistsAtTime() plus getValueAtKey() readback", error: "Keyframe was created but holds " + keyVal + " instead of the requested ${value}.", actual: keyVal, requested: ${value} });
        if (keyThere !== true) {
          return JSON.stringify({
            success: true, verified: false,
            unverifiedReason: "addKey() and setValueAtKey() did not throw, but keyExistsAtTime() is not readable on this parameter, so the keyframe cannot be confirmed. Read the keys back with get_keyframes.",
            componentName: ${JSON.stringify(componentName)}, paramName: ${JSON.stringify(paramName)}, time: ${time}, value: ${value}, valueAtKey: keyVal
          });
        }
        return JSON.stringify({
          success: true,
          verified: true,
          verifiedBy: "keyExistsAtTime() plus getValueAtKey() readback",
          valueAtKey: keyVal,
          message: "Keyframe added",
          componentName: ${JSON.stringify(componentName)},
          paramName: ${JSON.stringify(paramName)},
          time: ${time},
          value: ${value}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async removeKeyframe(clipId: string, componentName: string, paramName: string, time: number): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var param = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          if (comp.displayName === ${JSON.stringify(componentName)}) {
            for (var j = 0; j < comp.properties.numItems; j++) {
              if (comp.properties[j].displayName === ${JSON.stringify(paramName)}) {
                param = comp.properties[j];
                break;
              }
            }
            if (param) break;
          }
        }
        if (!param) return JSON.stringify({ success: false, error: "Parameter not found" });
        var hadKey = null; try { hadKey = param.keyExistsAtTime(${time}); } catch (ePre) {}
        param.removeKey(${time});
        var stillThere = null; try { stillThere = param.keyExistsAtTime(${time}); } catch (ePost) {}
        if (stillThere === true) return JSON.stringify({ success: false, verified: true, verifiedBy: "keyExistsAtTime() readback", hadKey: hadKey, changed: false, error: "Premiere did not remove the keyframe at ${time}s (still present)." });
        if (stillThere !== false) {
          return JSON.stringify({
            success: true, verified: false,
            unverifiedReason: "removeKey() did not throw, but keyExistsAtTime() is not readable on this parameter, so the removal cannot be confirmed. Read the keys back with get_keyframes.",
            hadKey: hadKey, time: ${time}
          });
        }
        return JSON.stringify({
          success: true,
          verified: true,
          verifiedBy: "keyExistsAtTime() readback",
          changed: hadKey === true,
          message: hadKey === false ? "No keyframe existed at ${time}s; nothing to remove." : "Keyframe removed",
          hadKey: hadKey,
          time: ${time}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async getKeyframes(clipId: string, componentName: string, paramName: string): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var param = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          if (comp.displayName === ${JSON.stringify(componentName)}) {
            for (var j = 0; j < comp.properties.numItems; j++) {
              if (comp.properties[j].displayName === ${JSON.stringify(paramName)}) {
                param = comp.properties[j];
                break;
              }
            }
            if (param) break;
          }
        }
        if (!param) return JSON.stringify({ success: false, error: "Parameter not found" });
        var isTimeVarying = param.isTimeVarying();
        if (!isTimeVarying) {
          return JSON.stringify({
            success: true,
            isTimeVarying: false,
            keyframes: [],
            staticValue: param.getValue()
          });
        }
        var keys = param.getKeys();
        var result = [];
        for (var k = 0; k < keys.length; k++) {
          result.push({
            time: keys[k],
            value: param.getValueAtKey(keys[k])
          });
        }
        return JSON.stringify({
          success: true,
          isTimeVarying: true,
          keyframes: result,
          count: result.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  /**
   * Bakes an eased value curve for a SCALAR parameter into a dense run of
   * keyframes, then reads every written value back and verifies it landed.
   *
   * Why bake instead of setting a native ease: Premiere's DOM can set a
   * keyframe interpolation type but offers no getter to confirm it, and the
   * temporal-ease amount has never been scriptable — so a native ease can't be
   * verified. Keyframe *values* CAN be read back, so a curve baked from an
   * easing function is both arbitrary in shape and provable after the fact.
   */
  protected async bakeKeyframeEase(args: any): Promise<any> {
    const componentName = String(args.componentName ?? 'Opacity');
    const paramName = String(args.paramName ?? 'Opacity');

    let keyframes: EaseKeyframe[];
    try {
      const opts: EaseSampleOptions = {
        startTime: Number(args.startTime),
        endTime: Number(args.endTime),
        startValue: Number(args.startValue),
        endValue: Number(args.endValue),
        samples: Number(args.samples ?? 24),
      };
      if (Array.isArray(args.bezier)) {
        opts.bezier = args.bezier.map(Number) as [number, number, number, number];
      } else if (args.easing != null) {
        opts.easing = String(args.easing);
      }
      keyframes = sampleEaseKeyframes(opts);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    const times = keyframes.map((k) => k.time);
    const values = keyframes.map((k) => k.value);

    const script = `
      try {
        var info = __findClip(${JSON.stringify(args.clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var param = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          if (comp.displayName === ${JSON.stringify(componentName)}) {
            for (var j = 0; j < comp.properties.numItems; j++) {
              if (comp.properties[j].displayName === ${JSON.stringify(paramName)}) {
                param = comp.properties[j];
                break;
              }
            }
            if (param) break;
          }
        }
        if (!param) return JSON.stringify({ success: false, error: "Parameter " + ${JSON.stringify(paramName)} + " not found in component " + ${JSON.stringify(componentName)} });
        if (param.areKeyframesSupported && !param.areKeyframesSupported()) {
          return JSON.stringify({ success: false, error: "Parameter " + ${JSON.stringify(paramName)} + " does not support keyframes" });
        }
        var probe = param.getValue();
        if (typeof probe !== "number") {
          return JSON.stringify({ success: false, error: "bake_keyframe_ease supports scalar parameters only; '" + ${JSON.stringify(paramName)} + "' is not scalar (its value is " + (typeof probe) + "). Use a scalar parameter such as Opacity, Scale, or Rotation." });
        }
        var times = ${JSON.stringify(times)};
        var values = ${JSON.stringify(values)};
        param.setTimeVarying(true);
        for (var w = 0; w < times.length; w++) {
          param.addKey(times[w]);
          param.setValueAtKey(times[w], values[w], true);
        }
        var readback = [];
        for (var r = 0; r < times.length; r++) {
          readback.push(param.getValueAtKey(times[r]));
        }
        return JSON.stringify({ success: true, readback: readback, keyCount: times.length });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    const raw = await this.bridge.executeScript(script);
    const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!res || res.success !== true) {
      return { success: false, error: res?.error ?? 'bake_keyframe_ease failed in host', raw: res };
    }

    // Verify-after-write: every written value must read back within tolerance.
    const readback: unknown[] = Array.isArray(res.readback) ? res.readback : [];
    const mismatches: Array<{ index: number; time: number; expected: number; actual: unknown }> = [];
    for (let i = 0; i < values.length; i++) {
      const expected = values[i] as number;
      const actual = readback[i];
      const tol = Math.max(0.01, Math.abs(expected) * 1e-4);
      if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
        mismatches.push({ index: i, time: times[i] as number, expected, actual });
      }
    }

    const verifiedCount = values.length - mismatches.length;
    if (mismatches.length > 0) {
      return {
        success: false,
        verified: false,
        error: `Wrote ${values.length} eased keyframes but ${mismatches.length} did not read back at the requested value (Premiere may have clamped values outside the parameter's valid range).`,
        componentName,
        paramName,
        keyCount: values.length,
        verifiedCount,
        mismatches: mismatches.slice(0, 10),
      };
    }

    return {
      success: true,
      verified: true,
      message: `Baked and verified ${values.length} keyframes tracing ${args.bezier ? 'a cubic-bezier' : (args.easing ?? 'easeInOutCubic')} ease.`,
      componentName,
      paramName,
      easing: args.bezier ? 'cubic-bezier' : (args.easing ?? 'easeInOutCubic'),
      bezier: args.bezier ?? undefined,
      startTime: times[0],
      endTime: times[times.length - 1],
      startValue: values[0],
      endValue: values[values.length - 1],
      keyCount: values.length,
      verifiedCount,
    };
  }
}
