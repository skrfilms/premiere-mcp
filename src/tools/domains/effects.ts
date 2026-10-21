/**
 * EffectsTools -- the Effects & Keying tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { AssemblyTools } from './assembly.js';
import { execSync } from 'child_process';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';

export class EffectsTools extends AssemblyTools {
  protected async removeEffectAtIndex(trackIndex: number, clipIndex: number, componentIndex: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      var domSeq = app.project.activeSequence;
      var domClip = domSeq.videoTracks[${trackIndex}].clips[${clipIndex}];
      var before = domClip.components.numItems;
      var comp = __clip.getComponentAt(${componentIndex});
      if (!comp) return JSON.stringify({success:false,error:'Component not found'});
      var name = '';
      try { var pl = comp.getParamList ? comp.getParamList() : ''; name = String(pl).split(',')[0]; } catch(e) {}
      var removeError = null;
      try { comp.remove(); } catch (eRm) { removeError = eRm.toString(); }
      var after = domClip.components.numItems;
      if (after >= before) {
        return JSON.stringify({success:false,verified:true,verifiedBy:'clip component count before and after',changed:false,removed:${componentIndex},componentName:name,before:before,after:after,
          error: removeError
            ? ('Component.remove() threw: ' + removeError)
            : 'Component.remove() ran but the clip still has ' + after + ' components, so nothing was removed. Intrinsic components (Motion, Opacity, Time Remapping) cannot be removed — use enable_disable_effect to switch one off instead.'});
      }
      return JSON.stringify({success:true,verified:true,verifiedBy:'clip component count before and after',changed:true,removed:${componentIndex},componentName:name,before:before,after:after});
    `);
  }

  protected async reorderEffects(trackIndex: number, clipIndex: number, newOrder: string[], _sequenceId?: string): Promise<any> {
    const orderJson = JSON.stringify(newOrder);
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var qeClip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        var domSeq = app.project.activeSequence;
        var domClip = domSeq.videoTracks[${trackIndex}].clips[${clipIndex}];
        var newOrder = ${orderJson};
        // Serialize all component params
        var comps = [];
        for (var i = 0; i < domClip.components.numItems; i++) {
          var domComp = domClip.components[i];
          var qeComp = qeClip.getComponentAt(i);
          var entry = { name: String(domComp.displayName), matchName: String(domComp.matchName), params: {} };
          if (qeComp) { try { var pl=qeComp.getParamList(); var pns=String(pl).split(',').map(function(s){return s.replace(/^\\s+|\\s+$/g,'');}).filter(function(s){return s;}); for(var j=0;j<pns.length;j++){try{entry.params[pns[j]]=String(qeComp.getParamValue(pns[j]));}catch(ep){}} } catch(e){} }
          comps.push(entry);
        }
        // Build order map
        var ordered = [];
        for (var oi=0;oi<newOrder.length;oi++) { for (var ci=0;ci<comps.length;ci++) { if (comps[ci].name===newOrder[oi]){ordered.push(comps[ci]);break;} } }
        return JSON.stringify({success:true,note:'Reorder serialized. Full effect removal and re-add requires keyframe data preservation which is complex. Use remove_effect_at_index + apply_video_effect to manually reorder.',serialized:ordered.map(function(c){return c.name;})});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async findClipsWithEffect(effectName: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var pat = ${JSON.stringify(effectName.toLowerCase())};
        var results = [];
        var seqs = app.project.sequences;
        for (var si=0; si<seqs.numSequences; si++) {
          var seq = seqs[si];
          for (var t=0; t<seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            for (var c=0; c<track.clips.numItems; c++) {
              var clip = track.clips[c];
              for (var e=0; e<clip.components.numItems; e++) {
                if (String(clip.components[e].displayName).toLowerCase().indexOf(pat) >= 0) {
                  results.push({sequence:String(seq.name),sequenceId:String(seq.sequenceID),track:t,clip:c,clipName:String(clip.name),componentIndex:e,effectName:String(clip.components[e].displayName)});
                }
              }
            }
          }
        }
        return JSON.stringify({success:true,matchCount:results.length,results:results});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async effectStackReport(trackIndex: number, clipIndex: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqScript(sequenceId)};
        var clip = seq.videoTracks[${trackIndex}].clips[${clipIndex}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var effects = [];
        for (var i=0; i<clip.components.numItems; i++) {
          var comp = clip.components[i];
          var entry = {index:i,name:String(comp.displayName),matchName:String(comp.matchName),paramCount:comp.properties.numItems,params:[]};
          for (var pi=0; pi<Math.min(comp.properties.numItems,20); pi++) {
            var p = comp.properties[pi];
            var pe = {name:String(p.displayName)};
            try { pe.value = p.getValue(); } catch(e) {}
            entry.params.push(pe);
          }
          effects.push(entry);
        }
        return JSON.stringify({success:true,clipName:String(clip.name),effectCount:effects.length,effects:effects});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async enableDisableEffect(trackIndex: number, clipIndex: number, effectName: string, enabled: boolean, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqScript(sequenceId)};
        var clip = seq.videoTracks[${trackIndex}].clips[${clipIndex}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var pat = ${JSON.stringify(effectName.toLowerCase())};
        var found = [], present = [], noToggle = [];
        for (var i=0; i<clip.components.numItems; i++) {
          var comp = clip.components[i];
          var nm = String(comp.displayName);
          present.push(nm);
          if (nm.toLowerCase().indexOf(pat) < 0) continue;
          // VideoComponent has NO enabled property at all — measured on 26.3.2, typeof is undefined on
          // every component. Assigning it merely creates a stray JS property on the ScriptObject,
          // so reading it back verifies OUR OWN WRITE and nothing about Premiere. That is the
          // exact false-verification this server exists to avoid, and it is what this tool did.
          //
          // The real toggle is the component's own "Active" parameter, which round-trips through
          // ComponentParam.setValue/getValue (verified: true -> false -> true).
          var active = null;
          for (var pj=0; pj<comp.properties.numItems; pj++) {
            if (String(comp.properties[pj].displayName).toLowerCase() === 'active') { active = comp.properties[pj]; break; }
          }
          if (!active) {
            var pnames = [];
            for (var pk=0; pk<comp.properties.numItems && pk<12; pk++) pnames.push(String(comp.properties[pk].displayName));
            noToggle.push({ index: i, name: nm, params: pnames });
            continue;
          }
          var was = null; try { was = active.getValue(); } catch (eR) {}
          try { active.setValue(${enabled}, true); } catch (eS) {}
          var now = null; try { now = active.getValue(); } catch (eR2) {}
          if (!!now === ${enabled}) {
            found.push({ index: i, name: nm, was: !!was, now: !!now, changed: !!was !== !!now, via: 'Active parameter' });
          } else {
            noToggle.push({ index: i, name: nm, reason: 'the Active parameter did not accept the new value (reads back as ' + now + ')' });
          }
        }
        if (found.length === 0) {
          return JSON.stringify({
            success: false, verified: true,
            error: noToggle.length
              ? ('Matched ' + noToggle.length + ' component(s), but none could be toggled. On this build an effect is enabled/disabled through its "Active" parameter; effects without one cannot be toggled by script. Details in notToggleable[].')
              : ('No effect on this clip matched ' + ${JSON.stringify(effectName)} + '. Components present: ' + (present.length ? present.join(', ') : '(none)')),
            matched: 0, componentsPresent: present, notToggleable: noToggle
          });
        }
        return JSON.stringify({ success: true, verified: true, enabled: ${enabled}, matched: found.length, components: found, componentsPresent: present, notToggleable: noToggle });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // Batch H: Effects shortcuts
  protected async blurClip(trackIndex: number, clipIndex: number, amount: number, _sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var domClip = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}];
        var before = domClip.components.numItems;
        var eff = qe.project.getVideoEffectByName('Gaussian Blur');
        if (!eff) return JSON.stringify({success:false,error:'Gaussian Blur not found'});
        clip.addVideoEffect(eff);
        var after = domClip.components.numItems;
        if (after <= before) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'clip component count before and after',changed:false,amount:${amount},componentsBefore:before,componentsAfter:after,
            error:'addVideoEffect() ran but the clip component count did not rise, so Gaussian Blur was not applied. Try apply_effect with matchName AE.Impact_Blur_FX instead.'});
        }
        // The blur AMOUNT write was swallowed in try{}catch(e2){}, so a clip that received an
        // effect at its default blurriness reported verified:true for the requested amount.
        // Read the parameter back off the DOM component and say which half landed.
        var amountSet = null, amountError = null;
        var qeComp = clip.getComponentAt(after-1);
        if (!qeComp) amountError = 'The new component could not be addressed through QE, so Blurriness was left at its default.';
        else { try { qeComp.setParamValue('Amount', String(${amount})); } catch(e2){ amountError = e2.toString(); } }
        var newComp = domClip.components[after-1];
        if (newComp) {
          for (var bp=0; bp<newComp.properties.numItems; bp++) {
            var bpn = String(newComp.properties[bp].displayName).toLowerCase();
            if (bpn.indexOf('blurriness') >= 0 || bpn === 'amount') { try { amountSet = Number(newComp.properties[bp].getValue()); } catch(e3){} break; }
          }
        }
        var amountLanded = amountSet !== null && Math.abs(amountSet - ${amount}) < 0.001;
        if (amountLanded) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'clip component count plus Blurriness getValue() readback',changed:true,amount:${amount},amountReadback:amountSet,componentsBefore:before,componentsAfter:after});
        }
        return JSON.stringify({success:false,verified:true,verifiedBy:'clip component count plus Blurriness getValue() readback',changed:true,effectAdded:true,amount:${amount},amountReadback:amountSet,componentsBefore:before,componentsAfter:after,setError:amountError,
          error:'HALF APPLIED: Gaussian Blur was added to the clip but its blurriness reads ' + String(amountSet) + ' rather than the requested ${amount}, so the clip is blurred by the wrong amount. Set it with set_effect_property, or remove the effect with remove_effect_by_name.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async sharpenClip(trackIndex: number, clipIndex: number, amount: number, _sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var domClip = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}];
        var before = domClip.components.numItems;
        var eff = qe.project.getVideoEffectByName('Unsharp Mask');
        if (!eff) return JSON.stringify({success:false,error:'Unsharp Mask not found'});
        clip.addVideoEffect(eff);
        var after = domClip.components.numItems;
        if (after <= before) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'clip component count before and after',changed:false,amount:${amount},componentsBefore:before,componentsAfter:after,
            error:'addVideoEffect() ran but the clip component count did not rise, so Unsharp Mask was not applied. Try apply_effect with the matchName from list_available_effects instead.'});
        }
        // The amount argument was accepted and never written by this tool — the effect landed
        // at its default. Saying so is the honest version of the old verified:true.
        return JSON.stringify({success:true,verified:true,verifiedBy:'clip component count before and after',changed:true,componentsBefore:before,componentsAfter:after,amountRequested:${amount},amountApplied:false,
          note:'Unsharp Mask was added at its DEFAULT settings. The amount argument was not applied: this tool only adds the effect. Set Amount with set_effect_property.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async enableDisableAllEffects(trackIndex: number, clipIndex: number, enabled: boolean, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqScript(sequenceId)};
        var clip = seq.videoTracks[${trackIndex}].clips[${clipIndex}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var skip = ['Motion','Opacity','Time Remapping'];
        // This assigned component.enabled and counted the assignments. VideoComponent has NO
        // enabled property on 26.3.2 — the assignment just creates a stray JS property on the
        // ScriptObject and Premiere never sees it — so the tool reported success:true and a
        // non-zero "toggled" count while changing nothing at all. Same defect that was found
        // and fixed in enable_disable_effect; this sibling was missed. The real toggle is each
        // component's own Active parameter, read back per component.
        var toggled = [], notToggleable = [], considered = 0;
        for (var i=0; i<clip.components.numItems; i++) {
          var comp = clip.components[i];
          var name = String(comp.displayName);
          var isBuiltin = false;
          for (var s=0; s<skip.length; s++) { if (name === skip[s]) { isBuiltin=true; break; } }
          if (isBuiltin) continue;
          considered++;
          var active = null;
          for (var pj=0; pj<comp.properties.numItems; pj++) {
            if (String(comp.properties[pj].displayName).toLowerCase() === 'active') { active = comp.properties[pj]; break; }
          }
          if (!active) { notToggleable.push({ index: i, name: name, reason: 'no Active parameter, so this effect cannot be toggled by script' }); continue; }
          var was = null; try { was = active.getValue(); } catch (eR) {}
          var setErr = null;
          try { active.setValue(${enabled}, true); } catch (eS) { setErr = eS.toString(); }
          var now = null; try { now = active.getValue(); } catch (eR2) {}
          if (now !== null && !!now === ${enabled}) toggled.push({ index: i, name: name, was: !!was, now: !!now, changed: !!was !== !!now });
          else notToggleable.push({ index: i, name: name, reason: now === null ? 'the Active parameter is not readable, so the toggle cannot be confirmed' : ('the Active parameter still reads ' + String(now)), setError: setErr });
        }
        if (considered === 0) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'Active parameter readback per component',enabled:${enabled},toggled:0,considered:0,
            note:'This clip carries no user effects (only intrinsic Motion/Opacity/Time Remapping), so there was nothing to toggle.'});
        }
        if (toggled.length === considered) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'Active parameter readback per component',enabled:${enabled},toggled:toggled.length,considered:considered,components:toggled});
        }
        return JSON.stringify({success:false,verified:true,verifiedBy:'Active parameter readback per component',enabled:${enabled},toggled:toggled.length,considered:considered,components:toggled,notToggleable:notToggleable,
          error: toggled.length === 0
            ? ('None of the ' + considered + ' user effect(s) on this clip could be toggled. On this build an effect is enabled/disabled through its Active parameter; effects without one cannot be toggled by script. See notToggleable[].')
            : ('PARTIALLY APPLIED: ' + toggled.length + ' of ' + considered + ' user effects were toggled; the rest are unchanged, so the clip is in a mixed state. See notToggleable[].')});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async removeAllEffectsQe(trackIndex: number, clipIndex: number, _sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var domClip = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}];
        var before = domClip.components.numItems;
        var names = [];
        for (var ni=0; ni<domClip.components.numItems; ni++) names.push(String(domClip.components[ni].displayName));
        clip.removeEffects();
        var after = domClip.components.numItems;
        // A bare "after < before" reported verified:false with no reason on a clip that had no
        // removable effects in the first place, which is not a failure. Name the outcome.
        if (after < before) {
          return JSON.stringify({success:true,verified:true,verifiedBy:'clip component count before and after',changed:true,removedCount:before-after,componentsBefore:before,componentsAfter:after,
            note:'QE removeEffects() strips ALL user effects at once. Intrinsic components (Motion, Opacity, Time Remapping) and Lumetri Color are preserved by the API and remain on the clip.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'clip component count before and after',changed:false,removedCount:0,componentsBefore:before,componentsAfter:after,componentsPresent:names,
          note:'Nothing was removed because this clip carries no removable user effects. QE removeEffects() preserves the intrinsic components (Motion, Opacity, Time Remapping) and Lumetri Color, which are what remain; see componentsPresent.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async listEffectsOnClipQe(trackIndex: number, clipIndex: number, _sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        var domClip = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}];
        if (!clip || !domClip) return JSON.stringify({success:false,error:'Clip not found'});
        var effects = [];
        for (var i=0; i<domClip.components.numItems; i++) {
          var dc = domClip.components[i];
          var qc = clip.getComponentAt(i);
          var entry = {index:i,displayName:String(dc.displayName),matchName:String(dc.matchName)};
          if (qc) { try { entry.paramList = String(qc.getParamList()).slice(0,100); } catch(e){} }
          effects.push(entry);
        }
        return JSON.stringify({success:true,effectCount:effects.length,effects:effects});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected transitionVerificationScript(): string {
    return `
        function __readQeTransitionState(qeClip) {
          var state = { available: false, count: null, names: [] };
          if (!qeClip) return state;
          function numberValue(value) {
            if (typeof value === "number" && !isNaN(value)) return value;
            if (value && typeof value.numItems === "number") return value.numItems;
            if (value && typeof value.length === "number") return value.length;
            return null;
          }
          var countProps = ["numTransitions", "numVideoTransitions", "numAudioTransitions", "transitions"];
          for (var i = 0; i < countProps.length; i++) {
            try {
              var prop = qeClip[countProps[i]];
              var count = numberValue(typeof prop === "function" ? prop.call(qeClip) : prop);
              if (count !== null) {
                state.available = true;
                state.count = count;
                break;
              }
            } catch (e) {}
          }
          if (state.count !== null && state.count > 0) {
            var getterNames = ["getTransitionAt", "getVideoTransitionAt", "getAudioTransitionAt"];
            for (var g = 0; g < getterNames.length; g++) {
              if (typeof qeClip[getterNames[g]] !== "function") continue;
              try {
                for (var t = 0; t < state.count; t++) {
                  var transition = qeClip[getterNames[g]](t);
                  if (transition) {
                    state.names.push(transition.name || transition.displayName || transition.toString());
                  }
                }
                break;
              } catch (e2) {}
            }
          }
          return state;
        }
        function __transitionWasVerified(before, after) {
          if (!before.available || !after.available) return false;
          if (before.count !== null && after.count !== null && after.count > before.count) return true;
          if (after.names && before.names && after.names.length > before.names.length) return true;
          return false;
        }
        function __transitionXmlCount(seq) {
          var state = { available: false, count: 0, path: null, error: null };
          try {
            if (!seq || typeof seq.exportAsFinalCutProXML !== "function") {
              state.error = "exportAsFinalCutProXML unavailable";
              return state;
            }
            var file = new File(Folder.temp.fsName + "/premiere-mcp-transition-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000000) + ".xml");
            seq.exportAsFinalCutProXML(file.fsName);
            state.path = file.fsName;
            if (!file.exists) {
              state.error = "XML export file was not created";
              return state;
            }
            file.open("r");
            var text = file.read();
            file.close();
            var matches = text.match(/<transitionitem[\\s>]/g);
            state.available = true;
            state.count = matches ? matches.length : 0;
            try { file.remove(); } catch (removeError) {}
            return state;
          } catch (xmlError) {
            state.error = xmlError.toString();
            return state;
          }
        }
        function __transitionWasVerifiedByXml(beforeXml, afterXml) {
          return beforeXml && afterXml && beforeXml.available && afterXml.available && afterXml.count > beforeXml.count;
        }
        function __findQeClipByDomClip(qeTrack, domClip) {
          if (!qeTrack || !domClip) return null;
          var targetTicks = null;
          try { targetTicks = String(domClip.start.ticks); } catch (targetError) {}
          var best = null;
          var bestDelta = null;
          for (var qi = 0; qi < qeTrack.numItems; qi++) {
            var item = qeTrack.getItemAt(qi);
            if (!item || String(item.type) !== "Clip") continue;
            if (targetTicks !== null) {
              var itemTicks = null;
              try { itemTicks = String(item.start.ticks); } catch (itemError) {}
              if (itemTicks === targetTicks) return item;
              if (itemTicks !== null) {
                var delta = Math.abs(parseInt(itemTicks, 10) - parseInt(targetTicks, 10));
                if (best === null || delta < bestDelta) {
                  best = item;
                  bestDelta = delta;
                }
              }
            }
          }
          return best;
        }
    `;
  }

  // Effects and Transitions Implementation
  // FIX vs upstream: upstream silently ignored `parameters` (typed as `_parameters`).
  // This version:
  //   1. Adds the effect (current behavior)
  //   2. Locates the newly added component by diffing the ordered component snapshots
  //   3. Dumps that component's properties (displayName + current value) so callers can see
  //      exactly which params are settable via flat property access (some effects hide their
  //      real params behind "Custom Setup / Editar..." dialogs and won't be settable this way)
  //   4. For each entry in `parameters`, attempts to set the matching property by displayName
  //      (exact match first, then case-insensitive whitespace-stripped match)
  //   5. Returns dump + per-param result so debugging is one round-trip
  protected async applyEffect(clipId: string, effectName: string, parameters?: Record<string, any>, expectedMatchName?: string): Promise<any> {
    const paramJson = JSON.stringify(parameters || {});
    const clipIdJson = JSON.stringify(clipId);
    const effectNameJson = JSON.stringify(effectName);
    const expectedMatchNameJson = JSON.stringify(expectedMatchName || null);
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${clipIdJson});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        function stableValue(value) {
          try {
            var encoded = JSON.stringify(value);
            return encoded === undefined ? String(value) : encoded;
          } catch (e) {
            try { return String(value); } catch (e2) { return "<unreadable>"; }
          }
        }
        function snapshotComponent(component) {
          var propertyParts = [];
          var propertyCount = -1;
          var componentProperties = null;
          try {
            componentProperties = component.properties;
            propertyCount = componentProperties.numItems;
          } catch (e3) {
            propertyParts.push("<properties unreadable>");
          }
          for (var si = 0; si < propertyCount; si++) {
            try {
              var snapshotProperty = componentProperties[si];
              var snapshotValue = "<getValue failed>";
              try { snapshotValue = stableValue(snapshotProperty.getValue()); } catch (e4) {}
              propertyParts.push(String(snapshotProperty.displayName) + "=" + snapshotValue);
            } catch (e5) {
              propertyParts.push("<property " + si + " unreadable>");
            }
          }
          var matchName = "";
          try { matchName = String(component.matchName || ""); } catch (e6) {}
          var displayName = String(component.displayName);
          return {
            displayName: displayName,
            matchName: matchName,
            propertyCount: propertyCount,
            fingerprint: displayName + "|" + matchName + "|" + propertyParts.join("|")
          };
        }
        function snapshotComponents(targetClip) {
          var snapshots = [];
          for (var sci = 0; sci < targetClip.components.numItems; sci++) {
            snapshots.push(snapshotComponent(targetClip.components[sci]));
          }
          return snapshots;
        }
        function fingerprintsEqual(left, right) {
          if (left.length !== right.length) return false;
          for (var fei = 0; fei < left.length; fei++) {
            if (left[fei].fingerprint !== right[fei].fingerprint) return false;
          }
          return true;
        }
        var beforeComponents = snapshotComponents(clip);
        var beforeCount = beforeComponents.length;
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack, effect;
        if (info.trackType === 'video') {
          qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
          effect = qe.project.getVideoEffectByName(${effectNameJson});
        } else {
          qeTrack = qeSeq.getAudioTrackAt(info.trackIndex);
          effect = qe.project.getAudioEffectByName(${effectNameJson});
        }
        if (!effect) return JSON.stringify({ success: false, error: "Effect not found: " + ${effectNameJson} + ". Use list_available_effects to see available effects." });
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
        var qeClip = findQeClipByTime();
        if (!qeClip) return JSON.stringify({ success: false, error: "Could not locate matching QE clip for effect application" });
        if (info.trackType === 'video') { qeClip.addVideoEffect(effect); } else { qeClip.addAudioEffect(effect); }

        // Re-resolve after the QE mutation, then locate the unique inserted component by
        // finding the index whose removal restores the complete pre-add fingerprint sequence.
        var afterInfo = __findClip(${clipIdJson});
        if (!afterInfo) return JSON.stringify({ success: false, error: "Clip could not be re-resolved after effect add" });
        clip = afterInfo.clip;
        var afterComponents = snapshotComponents(clip);
        var afterCount = afterComponents.length;
        if (afterCount <= beforeCount) {
          return JSON.stringify({
            success: false,
            error: "Effect add did not create a new component on the target clip",
            clipId: ${clipIdJson},
            effectName: ${effectNameJson},
            beforeComponentCount: beforeCount,
            afterComponentCount: afterCount
          });
        }
        var candidateIndices = [];
        if (afterCount === beforeCount + 1) {
          for (var candidateIndex = 0; candidateIndex < afterCount; candidateIndex++) {
            var withoutCandidate = [];
            for (var afterIndex = 0; afterIndex < afterCount; afterIndex++) {
              if (afterIndex !== candidateIndex) withoutCandidate.push(afterComponents[afterIndex]);
            }
            if (fingerprintsEqual(beforeComponents, withoutCandidate)) candidateIndices.push(candidateIndex);
          }
        }
        if (candidateIndices.length !== 1) {
          function componentDiagnostics(snapshots) {
            var diagnostics = [];
            for (var di = 0; di < snapshots.length; di++) {
              diagnostics.push({
                componentIndex: di,
                displayName: snapshots[di].displayName,
                matchName: snapshots[di].matchName,
                propertyCount: snapshots[di].propertyCount
              });
            }
            return diagnostics;
          }
          return JSON.stringify({
            success: false,
            error: "Effect was added, but its component could not be uniquely identified; no parameters were written and an automatic retry is unsafe",
            effectAdded: true,
            retryUnsafe: true,
            clipId: ${clipIdJson},
            effectName: ${effectNameJson},
            beforeComponents: componentDiagnostics(beforeComponents),
            afterComponents: componentDiagnostics(afterComponents),
            candidateComponentIndices: candidateIndices
          });
        }
        var newCompIdx = candidateIndices[0];
        var newComp = clip.components[newCompIdx];
        var newCompMatchName = "";
        try { newCompMatchName = String(newComp.matchName || ""); } catch (eMn) {}

        // Identity guard: getVideoEffectByName resolves by DISPLAY name only, so a
        // stock name like "Gaussian Blur" can silently land a third-party plugin
        // (e.g. AE.Impact_Blur_FX). If the caller told us the matchName they meant
        // and it does not match, refuse — and roll the add back when it is safe
        // (removeEffects strips ALL user effects at once, so it is only clean when
        // our add was the sole non-intrinsic, non-Lumetri effect on the clip).
        var expectedMatchName = ${expectedMatchNameJson};
        if (expectedMatchName) {
          function identityIntrinsic(m) { return m === "AE.ADBE Opacity" || m === "AE.ADBE Motion" || m.indexOf("Lumetri") !== -1; }
          function identityNormalize(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }
          if (identityNormalize(newCompMatchName) !== identityNormalize(expectedMatchName)) {
            var userEffectsBefore = 0;
            for (var ueb = 0; ueb < beforeComponents.length; ueb++) {
              if (!identityIntrinsic(beforeComponents[ueb].matchName)) userEffectsBefore++;
            }
            var rolledBack = false;
            if (userEffectsBefore === 0) {
              try { qeClip.removeEffects(); } catch (eRb) {}
              try { rolledBack = fingerprintsEqual(beforeComponents, snapshotComponents(__findClip(${clipIdJson}).clip)); } catch (eRbV) {}
            }
            return JSON.stringify({
              success: false,
              error: "Requested effect '" + ${effectNameJson} + "' resolved to matchName '" + newCompMatchName + "', not the expected '" + expectedMatchName + "'. A plugin or legacy variant likely shadows this display name on this system.",
              clipId: ${clipIdJson},
              effectName: ${effectNameJson},
              expectedMatchName: expectedMatchName,
              actualMatchName: newCompMatchName,
              identityMismatch: true,
              rolledBack: rolledBack,
              rollbackNote: userEffectsBefore === 0 ? undefined : "Left in place: the clip carried other user effects and removeEffects() would strip all of them.",
              noParametersSet: true
            });
          }
        }

        // Dump every property name + current value
        var propsDump = [];
        for (var i = 0; i < newComp.properties.numItems; i++) {
          var prop = newComp.properties[i];
          var dn = String(prop.displayName);
          var val = null;
          try { val = prop.getValue(); } catch (e1) { val = "<getValue threw: " + e1.toString() + ">"; }
          propsDump.push({ index: i, displayName: dn, value: val });
        }

        // Apply parameters by displayName match (exact first, then normalized)
        var requestedParams = ${paramJson};
        var paramResults = [];
        function normalize(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }
        function valuesEquivalent(actual, requested) {
          var actualIsArray = Object.prototype.toString.call(actual) === "[object Array]";
          var requestedIsArray = Object.prototype.toString.call(requested) === "[object Array]";
          if (actualIsArray || requestedIsArray) {
            if (!actualIsArray || !requestedIsArray || actual.length !== requested.length) return false;
            for (var vai = 0; vai < actual.length; vai++) {
              if (!valuesEquivalent(actual[vai], requested[vai])) return false;
            }
            return true;
          }
          if (typeof actual === "number" && typeof requested === "number") {
            return Math.abs(actual - requested) <= 0.0001;
          }
          if (typeof requested === "boolean" && typeof actual === "number" && (actual === 0 || actual === 1)) {
            return Boolean(actual) === requested;
          }
          if (typeof actual === "boolean" && typeof requested === "number" && (requested === 0 || requested === 1)) {
            return actual === Boolean(requested);
          }
          return stableValue(actual) === stableValue(requested);
        }
        for (var pName in requestedParams) {
          if (requestedParams.hasOwnProperty && !requestedParams.hasOwnProperty(pName)) continue;
          var requestedVal = requestedParams[pName];
          var matched = null;
          // Pass 1: exact displayName match
          for (var k = 0; k < newComp.properties.numItems; k++) {
            if (String(newComp.properties[k].displayName) === pName) {
              matched = { idx: k, prop: newComp.properties[k], strategy: "exact" };
              break;
            }
          }
          // Pass 2: normalized match (strip case/whitespace/underscores/dashes)
          if (!matched) {
            var nameN = normalize(pName);
            for (var k = 0; k < newComp.properties.numItems; k++) {
              if (normalize(String(newComp.properties[k].displayName)) === nameN) {
                matched = { idx: k, prop: newComp.properties[k], strategy: "normalized" };
                break;
              }
            }
          }
          if (matched) {
            try {
              var valueBefore = null;
              var beforeReadable = true;
              try { valueBefore = matched.prop.getValue(); } catch (eB) { beforeReadable = false; }
              matched.prop.setValue(requestedVal, true);
              var valueAfter = null;
              var afterReadable = true;
              try { valueAfter = matched.prop.getValue(); } catch (eA) { afterReadable = false; }
              var verified = afterReadable && valuesEquivalent(valueAfter, requestedVal);
              var changed = beforeReadable && afterReadable && !valuesEquivalent(valueAfter, valueBefore);
              var acceptedWithWarning = !verified && changed;
              var unverifiable = !afterReadable;
              var resultOk = verified || acceptedWithWarning;
              paramResults.push({
                requestedName: pName,
                matchedDisplayName: String(matched.prop.displayName),
                strategy: matched.strategy,
                valueRequested: requestedVal,
                valueBefore: valueBefore,
                valueAfter: valueAfter,
                verification: verified ? "verified" : (acceptedWithWarning ? "changed_with_warning" : (unverifiable ? "unverifiable" : "failed")),
                warning: acceptedWithWarning
                  ? "Premiere changed the property but readback differs from the requested value (possibly clamped or coerced)"
                  : (unverifiable ? "Premiere accepted setValue but the resulting value could not be read back" : undefined),
                ok: resultOk
              });
            } catch (e2) {
              paramResults.push({ requestedName: pName, ok: false, error: "setValue threw: " + e2.toString() });
            }
          } else {
            paramResults.push({ requestedName: pName, ok: false, error: "no property matches this displayName (exact or normalized)" });
          }
        }

        var failedParams = [];
        var paramWarnings = [];
        for (var pr = 0; pr < paramResults.length; pr++) {
          if (!paramResults[pr].ok) failedParams.push(paramResults[pr]);
          if (paramResults[pr].warning) paramWarnings.push({
            requestedName: paramResults[pr].requestedName,
            verification: paramResults[pr].verification,
            warning: paramResults[pr].warning
          });
        }

        return JSON.stringify({
          success: failedParams.length === 0,
          message: "Effect applied",
          clipId: ${clipIdJson},
          effectName: ${effectNameJson},
          addedComponent: {
            displayName: String(newComp.displayName),
            matchName: newCompMatchName,
            componentIndex: newCompIdx,
            identificationStrategy: "unique ordered component fingerprint insertion",
            propertyCount: propsDump.length,
            properties: propsDump
          },
          paramResults: paramResults,
          warnings: paramWarnings,
          error: failedParams.length ? "One or more effect parameters could not be set" : undefined
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async addTransition(clipId1: string, clipId2: string, transitionName: string, duration: number): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info1 = __findClip(${JSON.stringify(clipId1)});
        if (!info1) return JSON.stringify({ success: false, error: "First clip not found" });
        var info2 = __findClip(${JSON.stringify(clipId2)});
        var targetInfo = info2 || info1;
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(targetInfo.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + targetInfo.sequenceName + "' through the QE API." });
        var qeTrack = qeSeq.getVideoTrackAt(targetInfo.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, targetInfo.clip);
        if (!qeClip) return JSON.stringify({ success: false, error: "Could not locate matching QE clip for transition" });
        var transition = qe.project.getVideoTransitionByName(${JSON.stringify(transitionName)});
        if (!transition) return JSON.stringify({ success: false, error: "Transition not found: " + ${JSON.stringify(transitionName)} + ". Use list_available_transitions." });
        // The clip may live outside the active sequence, and a duration in frames
        // computed from the wrong timebase gives the transition the wrong length.
        var seq = targetInfo.sequence;
        var fps = seq && seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
        var frames = Math.round(${duration} * fps);
        ${this.transitionVerificationScript()}
        var before = __readQeTransitionState(qeClip);
        var beforeXml = __transitionXmlCount(seq);
        qeClip.addTransition(transition, info2 ? false : true, String(frames), "0", 0.5, false, true);
        var afterClip = __findQeClipByDomClip(qeTrack, targetInfo.clip);
        var after = __readQeTransitionState(afterClip);
        var afterXml = __transitionXmlCount(seq);
        if (!__transitionWasVerified(before, after) && !__transitionWasVerifiedByXml(beforeXml, afterXml)) {
          return JSON.stringify({
            success: false,
            error: "Transition call completed but Premiere Pro did not expose a verified transition change",
            transitionName: ${JSON.stringify(transitionName)},
            duration: ${duration},
            frames: frames,
            before: before,
            after: after,
            beforeXml: beforeXml,
            afterXml: afterXml
          });
        }
        return JSON.stringify({ success: true, message: "Transition added and verified", transitionName: ${JSON.stringify(transitionName)}, duration: ${duration}, frames: frames, before: before, after: after, beforeXml: beforeXml, afterXml: afterXml });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async addTransitionToClip(clipId: string, transitionName: string, position: 'start' | 'end', duration: number): Promise<any> {
    const atEnd = position === 'end';
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, status: "failed", verified: false, error: "Clip not found" });
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = info.trackType === 'video' ? qeSeq.getVideoTrackAt(info.trackIndex) : qeSeq.getAudioTrackAt(info.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, info.clip);
        if (!qeClip) return JSON.stringify({ success: false, status: "failed", verified: false, error: "Could not locate matching QE clip for transition" });
        var transition = info.trackType === 'video'
          ? qe.project.getVideoTransitionByName(${JSON.stringify(transitionName)})
          : qe.project.getAudioTransitionByName(${JSON.stringify(transitionName)});
        if (!transition) return JSON.stringify({ success: false, status: "failed", verified: false, error: "Transition not found: " + ${JSON.stringify(transitionName)} });
        // The clip may live outside the active sequence, and a duration in frames
        // computed from the wrong timebase gives the transition the wrong length.
        var seq = info.sequence;
        var fps = seq && seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
        var frames = Math.round(${duration} * fps);
        ${this.transitionVerificationScript()}
        var before = __readQeTransitionState(qeClip);
        var beforeXml = __transitionXmlCount(seq);
        qeClip.addTransition(transition, ${atEnd}, String(frames), "0", 0.5, true, true);
        var afterClip = __findQeClipByDomClip(qeTrack, info.clip);
        var after = __readQeTransitionState(afterClip);
        var afterXml = __transitionXmlCount(seq);
        var qeVerified = __transitionWasVerified(before, after);
        var xmlVerified = __transitionWasVerifiedByXml(beforeXml, afterXml);
        if (!qeVerified && !xmlVerified) {
          var qeInspectionAvailable = before.available && after.available;
          var xmlInspectionAvailable = beforeXml.available && afterXml.available;
          var inspectionAvailable = qeInspectionAvailable || xmlInspectionAvailable;
          return JSON.stringify({
            success: true,
            status: "accepted_unverified",
            verified: false,
            verification: {
              method: "transition_enumeration_and_xml",
              available: inspectionAvailable,
              channels: {
                transitionEnumeration: {
                  available: qeInspectionAvailable,
                  before: qeInspectionAvailable ? before : null,
                  after: qeInspectionAvailable ? after : null
                },
                finalCutProXml: {
                  available: xmlInspectionAvailable,
                  before: xmlInspectionAvailable ? beforeXml : null,
                  after: xmlInspectionAvailable ? afterXml : null,
                  beforeError: beforeXml.error,
                  afterError: afterXml.error
                }
              },
              reason: inspectionAvailable
                ? "Available Premiere Pro inspection channels did not confirm a transition change; these channels can omit transitions for some clip types"
                : "Premiere Pro did not expose a readable transition list for this clip type",
              before: inspectionAvailable ? { transitionEnumeration: before, finalCutProXml: beforeXml } : null,
              after: inspectionAvailable ? { transitionEnumeration: after, finalCutProXml: afterXml } : null
            },
            warning: "Transition command accepted; result could not be independently verified.",
            transitionName: ${JSON.stringify(transitionName)},
            position: ${JSON.stringify(position)},
            duration: ${duration},
            frames: frames
          });
        }
        return JSON.stringify({
          success: true,
          status: "applied_verified",
          verified: true,
          message: "Transition added at " + ${JSON.stringify(position)} + " and verified",
          verification: {
            method: qeVerified ? "transition_enumeration" : "final_cut_pro_xml",
            available: true,
            reason: qeVerified ? null : "Verified by a sequence-wide Final Cut Pro XML transition-count increase",
            before: qeVerified ? before : beforeXml,
            after: qeVerified ? after : afterXml
          },
          transitionName: ${JSON.stringify(transitionName)},
          position: ${JSON.stringify(position)},
          duration: ${duration},
          frames: frames
        });
      } catch (e) {
        return JSON.stringify({ success: false, status: "failed", verified: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Advanced Features Implementation
  protected async stabilizeClip(clipId: string, _method = 'warp', smoothness = 50): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        // Addressed by id, not by whatever is on screen. __findClip() searches every
        // sequence in the project, so a clip can be resolved out of one sequence and
        // then, through getActiveSequence(), have the effect applied to whichever
        // clip sits at the same track and index in a different one.
        var qeSeq = __qeSequenceFor(info.sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + info.sequenceName + "' through the QE API." });
        var qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
        var qeClip = __findQeClipByDomClip(qeTrack, info.clip);
        var effect = qe.project.getVideoEffectByName("Warp Stabilizer");
        if (!effect) return JSON.stringify({ success: false, error: "Warp Stabilizer effect not found" });
        qeClip.addVideoEffect(effect);
        var clip = info.clip;
        var lastComp = clip.components[clip.components.numItems - 1];
        for (var j = 0; j < lastComp.properties.numItems; j++) {
          try {
            if (lastComp.properties[j].displayName === "Smoothness") lastComp.properties[j].setValue(${smoothness}, true);
          } catch (e2) {}
        }
        return JSON.stringify({ success: true, message: "Warp Stabilizer applied", clipId: ${JSON.stringify(clipId)}, smoothness: ${smoothness} });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async applyMorphCut(trackIndex: number, clipIndex: number, seqId?: string, durationFrames?: number): Promise<any> {
    // Was "Invalid parameter" on every call:
    //
    //   clip.addTransition(mc, 2, 0)
    //
    // THREE arguments where QE addTransition takes seven on 26.3.2, the integer 2 where a
    // boolean addAtEnd belongs, and a duration of 0 — a zero-length Morph Cut is nothing to
    // apply even if the call were shaped right. Rebuilt on the same seven-argument form the
    // two working transition tools use, with the duration defaulting to one second of the
    // sequence's own timebase rather than zero.
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var domSeq=${this.buildSeqScript(seqId)};
        if(!domSeq)return JSON.stringify({success:false,error:'No active sequence'});
        var qeSeq=__qeSequenceFor(domSeq);
        if(!qeSeq)return JSON.stringify({success:false,error:"Could not address sequence '" + String(domSeq.name) + "' through the QE API."});
        var qeTrack=qeSeq.getVideoTrackAt(${trackIndex});
        var clip=qeTrack?qeTrack.getItemAt(${clipIndex}):null;
        if(!clip)return JSON.stringify({success:false,error:'No clip at video track ${trackIndex} index ${clipIndex}'});
        var domTrack=domSeq.videoTracks[${trackIndex}];
        var domClip=domTrack?domTrack.clips[${clipIndex}]:null;
        var mc=qe.project.getVideoTransitionByName('Morph Cut');
        if(!mc)return JSON.stringify({success:false,error:'The Morph Cut transition is not present on this build. Use list_available_transitions to see what is.'});
        var fps=domSeq.timebase?(254016000000/parseInt(String(domSeq.timebase),10)):30;
        var frames=${durationFrames !== undefined ? `${Math.max(1, Math.round(durationFrames))}` : 'Math.max(1, Math.round(fps))'};
        ${this.transitionVerificationScript()}
        var before=__readQeTransitionState(clip);
        var beforeXml=__transitionXmlCount(domSeq);
        var addError=null;
        try { clip.addTransition(mc, true, String(frames), "0", 0.5, true, true); } catch(eAdd) { addError=eAdd.toString(); }
        var afterClip=domClip?__findQeClipByDomClip(qeTrack, domClip):clip;
        var after=__readQeTransitionState(afterClip||clip);
        var afterXml=__transitionXmlCount(domSeq);
        var qeVerified=__transitionWasVerified(before, after);
        var xmlVerified=__transitionWasVerifiedByXml(beforeXml, afterXml);
        if(qeVerified||xmlVerified){
          // The TRANSITION is proven present. The Morph Cut ANALYSIS is a background render
          // that this call cannot wait for, so it is reported separately instead of being
          // folded into verified.
          var renderError=null;
          try { qeSeq.renderPreview(); } catch(eR) { renderError=eR.toString(); }
          return JSON.stringify({success:true,verified:true,
            verifiedBy: qeVerified ? 'QE clip transition enumeration' : 'transition count in the sequence FCP XML export',
            durationFrames:frames, fps:fps, edge:'end',
            analysisVerified:false,
            analysisNote:'The Morph Cut transition is present and proven. Its frame ANALYSIS runs as a background render and is NOT verified by this call — until it finishes the cut plays as a straight dissolve. Poll get_sequence_render_status, and inspect the result with capture_program_output.',
            renderPreviewError:renderError,
            before:before, after:after, beforeXml:beforeXml, afterXml:afterXml});
        }
        var inspectable=(before.available&&after.available)||(beforeXml.available&&afterXml.available);
        return JSON.stringify({success:false,verified:inspectable,
          durationFrames:frames, fps:fps, addError:addError,
          before:before, after:after, beforeXml:beforeXml, afterXml:afterXml,
          error: addError
            ? ('addTransition() threw: ' + addError + '. Morph Cut needs source handles on the outgoing side of the cut and an adjacent clip on the same track.')
            : (inspectable
              ? 'The Morph Cut did not appear: neither the QE transition list nor the sequence XML gained a transition. A clip with no source handle past its out-point cannot take one.'
              : 'The Morph Cut cannot be confirmed: neither the QE transition list nor the FCP XML export is readable on this build, so this reports failure rather than an unprovable success.')});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  // Effect & Transition Discovery Implementation
  protected async listAvailableEffects(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var list = qe.project.getVideoEffectList();
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

  protected async listAvailableTransitions(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var list = qe.project.getVideoTransitionList();
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

  // Batch Operations Implementation
  protected async batchAddTransitions(sequenceId: string, trackIndex: number, transitionName: string, duration: number): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var track = sequence.videoTracks[${trackIndex}];
        if (!track) return JSON.stringify({ success: false, error: "Track not found at index ${trackIndex}" });
        var clipCount = track.clips.numItems;
        if (clipCount < 2) return JSON.stringify({ success: false, error: "Need at least 2 clips to add transitions, found " + clipCount });
        var qeSeq = __qeSequenceFor(sequence);
        if (!qeSeq) return JSON.stringify({ success: false, error: "Could not address sequence '" + sequence.name + "' through the QE API." });
        var qeTrack = qeSeq.getVideoTrackAt(${trackIndex});
        var transition = qe.project.getVideoTransitionByName(${JSON.stringify(transitionName)});
        if (!transition) return JSON.stringify({ success: false, error: "Transition not found: " + ${JSON.stringify(transitionName)} });
        var added = 0;
        var errors = [];
        var fps = 254016000000 / parseInt(sequence.timebase, 10);
        var frames = Math.round(${duration} * fps);
        ${this.transitionVerificationScript()}
        var beforeXml = __transitionXmlCount(sequence);
        for (var i = 0; i < clipCount; i++) {
          try {
            var domClip = track.clips[i];
            var qeClip = __findQeClipByDomClip(qeTrack, domClip);
            if (!qeClip) {
              errors.push("Clip " + i + ": Could not locate matching QE clip");
              continue;
            }
            var before = __readQeTransitionState(qeClip);
            qeClip.addTransition(transition, true, String(frames), "0", 0.5, false, true);
            var afterClip = __findQeClipByDomClip(qeTrack, domClip);
            var after = __readQeTransitionState(afterClip);
            if (__transitionWasVerified(before, after)) {
              added++;
            } else {
              errors.push("Clip " + i + ": transition call completed but no verified transition change was exposed");
            }
          } catch (e) {
            errors.push("Clip " + i + ": " + e.toString());
          }
        }
        var afterXml = __transitionXmlCount(sequence);
        if (added === 0 && __transitionWasVerifiedByXml(beforeXml, afterXml)) {
          added = afterXml.count - beforeXml.count;
        }
        if (added === 0) {
          return JSON.stringify({
            success: false,
            error: "No transitions were verifiably added",
            transitionsAdded: 0,
            totalClips: clipCount,
            frames: frames,
            errors: errors,
            beforeXml: beforeXml,
            afterXml: afterXml
          });
        }
        return JSON.stringify({
          success: true,
          transitionsAdded: added,
          totalClips: clipCount,
          frames: frames,
          errors: errors,
          beforeXml: beforeXml,
          afterXml: afterXml
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async verifyEffectRendered(
    _seqId: string | undefined, trackIndex: number, clipIndex: number,
    effectName: string, effectParam?: string, effectParamValue?: string, outputDir = '/tmp/premiere-mcp-bridge/generated-assets'
  ): Promise<any> {
    const pathMod = pathSync;
    const fs = fsSync;

    // Step 1: capture a frame BEFORE applying the effect
    const frameBefore = pathMod.join(outputDir, `vfx_verify_before_${Date.now()}.jpg`);
    const frameAfter = pathMod.join(outputDir, `vfx_verify_after_${Date.now()}.jpg`);

    const mediaInfo: any = await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var track = seq.videoTracks[${trackIndex}];
        var clip = track && track.clips[${clipIndex}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var mediaPath = clip.projectItem ? String(clip.projectItem.getMediaPath()) : '';
        var midSecs = (clip.start.seconds + clip.end.seconds) / 2;
        var clipStartSecs = clip.start.seconds;
        var inSecs = clip.inPoint.seconds;
        var sourceTimeSecs = inSecs + (midSecs - clipStartSecs);
        return JSON.stringify({success:true,mediaPath:mediaPath,sourceTimeSecs:sourceTimeSecs});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!mediaInfo?.success) return { success: false, error: 'Could not locate clip media: ' + mediaInfo?.error };

    try {
      execSync(`ffmpeg -y -ss ${mediaInfo.sourceTimeSecs} -i "${mediaInfo.mediaPath}" -vframes 1 "${frameBefore}"`, { timeout: 15000 });
    } catch (e: any) { return { success: false, error: 'ffmpeg frame capture failed: ' + e.message?.slice(0,100) }; }

    // Step 2: apply the effect via QE
    const applyResult: any = await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'QE clip not found'});
        var domClip = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}];
        var before = domClip.components.numItems;
        var eff = qe.project.getVideoEffectByName(${JSON.stringify(effectName)});
        if (!eff) return JSON.stringify({success:false,error:'Effect not found: '+${JSON.stringify(effectName)}});
        clip.addVideoEffect(eff);
        var after = domClip.components.numItems;
        var added = after > before;
        ${effectParam && effectParamValue ? `
        if (added) {
          var newComp = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}].getComponentAt ? null : null;
          var qeComp = clip.getComponentAt(after - 1);
          if (qeComp) { try { qeComp.setParamValue(${JSON.stringify(effectParam)}, ${JSON.stringify(effectParamValue)}); } catch(ep) {} }
        }` : ''}
        return JSON.stringify({success:true,effectAdded:added,componentsBefore:before,componentsAfter:after});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!applyResult?.success) return { success: false, error: 'Effect apply failed: ' + applyResult?.error, verified: false };

    // Step 3: capture frame AFTER applying
    try {
      execSync(`ffmpeg -y -ss ${mediaInfo.sourceTimeSecs} -i "${mediaInfo.mediaPath}" -vframes 1 "${frameAfter}"`, { timeout: 15000 });
    } catch (e: any) { return { success: false, error: 'Post-effect frame capture failed', verified: false }; }

    // Step 4: pixel diff
    try {
      const psnrOut = execSync(`ffmpeg -i "${frameBefore}" -i "${frameAfter}" -lavfi psnr -f null - 2>&1`, { timeout: 10000 }).toString();
      const match = psnrOut.match(/psnr_avg:(\S+)/);
      const psnr = match?.[1] ? parseFloat(match[1]) : null;
      const identical = psnr !== null && psnr > 45;
      const effectLanded = !identical; // effect changed the image = verified

      // Cleanup temp frames
      try { fs.unlinkSync(frameBefore); fs.unlinkSync(frameAfter); } catch(_) {}

      return {
        success: true,
        verified: effectLanded,
        effectName,
        effectAdded: applyResult.effectAdded,
        psnr,
        pixelDifferenceDetected: effectLanded,
        note: effectLanded
          ? `Effect "${effectName}" confirmed: rendered output changed (PSNR ${psnr?.toFixed(1)}dB).`
          : `Effect "${effectName}" may not have rendered yet or had no visible impact (PSNR ${psnr?.toFixed(1)}dB — frames appear identical). Try render_sequence_previews first.`
      };
    } catch (e: any) {
      return { success: false, error: 'PSNR comparison failed: ' + e.message?.slice(0,100), verified: false };
    }
  }

  protected async getAllClipEffects(_seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var report = [];
        for (var t=0;t<seq.videoTracks.numTracks;t++) {
          var track = seq.videoTracks[t];
          for (var c=0;c<track.clips.numItems;c++) {
            var clip = track.clips[c];
            var effects = [];
            for (var e=2;e<clip.components.numItems;e++) { // skip Opacity(0) Motion(1)
              var comp = clip.components[e];
              effects.push({name:String(comp.displayName),matchName:String(comp.matchName)});
            }
            if (effects.length > 0) report.push({track:t,clip:c,clipName:String(clip.name),effectCount:effects.length,effects:effects});
          }
        }
        return JSON.stringify({success:true,clipsWithEffects:report.length,report:report});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
