/**
 * GraphicsTools -- the Titles, Graphics & MOGRTs tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { SpeedTimeTools } from './speed-time.js';
import { createMotionDemoAssets } from '../../utils/demoAssets.js';
import { evaluateTextInjectionResult } from './shared.js';

export class GraphicsTools extends SpeedTimeTools {
  protected async buildMotionGraphicsDemo(sequenceName = 'Apple Like Motion Demo'): Promise<any> {
    const assetBase = process.env.PREMIERE_TEMP_DIR || '/tmp';
    const assetDir = `${assetBase.replace(/\/$/, '')}/motion-demo-${Date.now()}`;
    const assets = await createMotionDemoAssets(assetDir);

    const imported = [];
    for (const asset of assets) {
      const result = await this.importMedia(asset.path);
      imported.push(result);
      if (!result.success || !result.id) {
        return {
          success: false,
          error: result.error || `Failed to import asset ${asset.name}`,
          assetDir,
          assets,
          imported
        };
      }
    }

    const createdSequence = await this.createSequenceFromProjectItems(
      sequenceName,
      imported.map((item: any) => item.id)
    );
    if (!createdSequence.success || !createdSequence.id) {
      return {
        success: false,
        error: createdSequence.error || 'Failed to create demo sequence from imported assets',
        assetDir,
        assets,
        imported
      };
    }

    const placements = [];
    for (let index = 0; index < imported.length; index++) {
      const placement = await this.addToTimeline(createdSequence.id, imported[index].id, 0, index * 5);
      placements.push(placement);
      if (!placement.success) {
        return {
          success: false,
          error: placement.error || `Failed to place ${imported[index].name} on the timeline`,
          assetDir,
          assets,
          createdSequence,
          imported,
          placements
        };
      }
    }

    const clips = placements.map((placement: any) => placement.id).filter(Boolean);
    const transitions = [];
    if (clips[0]) {
      transitions.push(await this.addTransitionToClip(clips[0], 'Cross Dissolve', 'end', 0.75));
    }
    if (clips[1]) {
      transitions.push(await this.addTransitionToClip(clips[1], 'Cross Dissolve', 'end', 0.75));
    }

    const animations = [];
    const scaleFrames = [
      { start: 0, end: 4.8, from: 100, to: 108 },
      { start: 5.005, end: 9.8, from: 112, to: 100 },
      { start: 10.01, end: 14.7, from: 100, to: 106 },
    ];
    for (let index = 0; index < clips.length && index < scaleFrames.length; index++) {
      const frame = scaleFrames[index];
      if (!frame) {
        continue;
      }
      animations.push(await this.addKeyframe(clips[index], 'Motion', 'Scale', frame.start, frame.from));
      animations.push(await this.addKeyframe(clips[index], 'Motion', 'Scale', frame.end, frame.to));
    }

    const tracks = await this.listSequenceTracks(createdSequence.id);

    return {
      success: true,
      message: 'Motion graphics demo sequence created',
      assetDir,
      assets,
      sequence: createdSequence,
      imported,
      placements,
      transitions,
      animations,
      tracks
    };
  }

  protected async setMogrtText(_sequenceId: string | undefined, ti: number, ci: number, paramName: string, text: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        if (!clip.isMGT()) return JSON.stringify({success:false,error:'Clip is not a Motion Graphics Template (MOGRT)'});
        var mogrtComp = clip.getMGTComponent();
        if (!mogrtComp) return JSON.stringify({success:false,error:'Could not get MGT component'});
        var params = mogrtComp.properties;
        var found = false;
        for (var pi=0;pi<params.numItems;pi++) {
          if (String(params[pi].displayName) === ${JSON.stringify(paramName)}) {
            params[pi].setValue(${JSON.stringify(text)}, true);
            found = true;
            break;
          }
        }
        if (!found) return JSON.stringify({success:false,error:'Param not found: '+${JSON.stringify(paramName)},availableParams:Array.prototype.map.call({length:params.numItems},function(_,i){return String(params[i].displayName);})});
        return JSON.stringify({success:true,verified:true,paramName:${JSON.stringify(paramName)},text:${JSON.stringify(text)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setMogrtParam(_sequenceId: string | undefined, ti: number, ci: number, paramName: string, value: any): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        if (!clip.isMGT()) return JSON.stringify({success:false,error:'Clip is not a MOGRT'});
        var mogrtComp = clip.getMGTComponent();
        if (!mogrtComp) return JSON.stringify({success:false,error:'Could not get MGT component'});
        var params = mogrtComp.properties;
        for (var pi=0;pi<params.numItems;pi++) {
          if (String(params[pi].displayName) === ${JSON.stringify(paramName)}) {
            params[pi].setValue(${JSON.stringify(value)}, true);
            var after = params[pi].getValue();
            return JSON.stringify({success:true,verified:true,paramName:${JSON.stringify(paramName)},after:after});
          }
        }
        return JSON.stringify({success:false,error:'Param not found: '+${JSON.stringify(paramName)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async mogrtParamsReport(_sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        if (!clip.isMGT()) return JSON.stringify({success:false,error:'Clip is not a MOGRT — check isMGT()'});
        var mogrtComp = clip.getMGTComponent();
        if (!mogrtComp) return JSON.stringify({success:false,error:'Could not get MGT component'});
        var params = mogrtComp.properties;
        var report = [];
        for (var pi=0;pi<params.numItems;pi++) {
          var p = params[pi]; var v; try { v = p.getValue(); } catch(e) { v = 'N/A'; }
          report.push({index:pi,name:String(p.displayName),value:v,timeVarying:p.isTimeVarying?p.isTimeVarying():false});
        }
        return JSON.stringify({success:true,clipName:String(clip.name),paramCount:report.length,params:report});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async timecodeBurnIn(_sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var qeClip = seq.getVideoTrackAt(${ti}).getItemAt(${ci});
        if (!qeClip) return JSON.stringify({success:false,error:'Clip not found'});
        var domClip = app.project.activeSequence.videoTracks[${ti}].clips[${ci}];
        var before = domClip.components.numItems;
        // Try both common names
        var eff = qe.project.getVideoEffectByName('Timecode') || qe.project.getVideoEffectByName('Metadata & Timecode Burn-in');
        if (!eff) return JSON.stringify({success:false,error:'Timecode burn-in effect not found in effect list'});
        qeClip.addVideoEffect(eff);
        var after = domClip.components.numItems;
        if (after <= before) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'clip component count before and after',changed:false,componentsBefore:before,componentCount:after,
            error:'addVideoEffect() ran but the clip component count did not rise, so the timecode burn-in was not applied. QE effect-add is inert on some builds; try apply_effect with the matchName instead.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'clip component count before and after',changed:true,added:true,componentsBefore:before,componentCount:after});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // Text and Graphics Implementation
  protected async addTextOverlay(args: any): Promise<any> {
    if (args.mogrtPath) {
      // FIX vs upstream: upstream silently ignored args.text; the MOGRT was imported but
      // its text properties stayed at default placeholders ("Su nombre aquí", etc.)
      // This version:
      //   1. importMGT (existing)
      //   2. After import, get trackItem.getMGTComponent() — the special MGT component
      //      that exposes the parameters defined in the Essential Graphics template
      //   3. Dump those properties for debugging (so callers see what's available)
      //   4. If args.text is provided, attempt to set it by:
      //      a. The first text-typed property whose value JSON-parses to {mTextString: ...}
      //      b. Or by displayName match against args.textPropertyName (optional override)
      //   Premiere stores text values as JSON: '{"mTextString":"...", ...}'
      const textJson = args.text !== undefined ? JSON.stringify(args.text) : 'null';
      // When set, the script restricts the write to the property whose displayName matches
      // (instead of running the auto-detect). text2/text3/text4 are ignored in override mode
      // — the override targets a single field by name.
      const textPropNameJson = args.textPropertyName !== undefined
        ? JSON.stringify(args.textPropertyName)
        : 'null';
      const script = `
        try {
          var sequence = __findSequence(${JSON.stringify(args.sequenceId)});
          if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
          var timeTicks = __secondsToTicks(${args.startTime});
          var trackItem = sequence.importMGT(${JSON.stringify(args.mogrtPath)}, timeTicks, ${args.trackIndex}, 0);
          if (!trackItem) return JSON.stringify({ success: false, error: "Failed to import MOGRT. Ensure the .mogrt file exists." });

          // First, probe ALL plausible MGT-access APIs (so we know what's available)
          var apiProbe = {};
          var premiereVersion = "unknown";
          var premiereBuild = "";
          try {
            if (typeof app.version !== "undefined" && app.version !== null) premiereVersion = String(app.version);
          } catch (eVersion) {}
          try {
            if (typeof app.build !== "undefined" && app.build !== null) premiereBuild = String(app.build);
          } catch (eBuild) {}
          apiProbe.hasGetMGTComponent = (typeof trackItem.getMGTComponent === "function");
          apiProbe.hasGetMGT = (typeof trackItem.getMGT === "function");
          apiProbe.hasGetMogrtComponent = (typeof trackItem.getMogrtComponent === "function");
          apiProbe.hasGetComponentParameters = (typeof trackItem.getComponentParameters === "function");
          // App-level
          apiProbe.appHasMOGRTAPI = (app.project && typeof app.project.openMGT === "function");
          // Try calling getMGTComponent and capture more detail
          if (apiProbe.hasGetMGTComponent) {
            try {
              var mgtTry = trackItem.getMGTComponent();
              apiProbe.getMGTComponent_returned = (mgtTry === null) ? "null" : (typeof mgtTry);
              if (mgtTry) {
                apiProbe.getMGTComponent_displayName = String(mgtTry.displayName || "");
                apiProbe.getMGTComponent_propertyCount = (mgtTry.properties ? mgtTry.properties.numItems : -1);
                // Dump first 3 properties of MGT comp
                var mgtPropsSample = [];
                if (mgtTry.properties) {
                  for (var mp = 0; mp < Math.min(5, mgtTry.properties.numItems); mp++) {
                    var mprop = mgtTry.properties[mp];
                    var mval = null;
                    try { mval = mprop.getValue(); } catch (eMg) { mval = "<getValue threw>"; }
                    mgtPropsSample.push({
                      index: mp,
                      displayName: String(mprop.displayName),
                      valueType: typeof mval,
                      valuePreview: (typeof mval === "string" ? mval.substring(0, 80) : mval)
                    });
                  }
                }
                apiProbe.getMGTComponent_propertiesSample = mgtPropsSample;
              }
            } catch (eMG) {
              apiProbe.getMGTComponent_threw = eMG.toString();
            }
          }
          // Probe trackItem.name (some MOGRT-specific stuff might surface here)
          try { apiProbe.trackItemName = String(trackItem.name); } catch (e) {}
          // Probe sequence-level methods
          try { apiProbe.sequenceHasGetSelection = (typeof sequence.getSelection === "function"); } catch (e) {}

          // Iterate ALL components of the imported trackItem (MOGRT params live as
          // properties on one of its components, not always via getMGTComponent)
          var componentsDump = [];
          var textPropsFound = [];  // {compIndex, propIndex, displayName, currentValue}
          for (var ci = 0; ci < trackItem.components.numItems; ci++) {
            var comp = trackItem.components[ci];
            var compName = String(comp.displayName);
            var compMatch = (comp.matchName !== undefined) ? String(comp.matchName) : "";
            var compProps = [];
            for (var i = 0; i < comp.properties.numItems; i++) {
              var prop = comp.properties[i];
              var dn = String(prop.displayName);
              var val = null;
              try { val = prop.getValue(); } catch (eV) { val = "<getValue threw>"; }
              var truncatedVal = (typeof val === "string" ? val.substring(0, 250) : val);
              compProps.push({ index: i, displayName: dn, value: truncatedVal });
              // Heuristic: text properties contain "mTextString" in their JSON value
              if (typeof val === "string" && val.indexOf("mTextString") >= 0) {
                textPropsFound.push({ compIndex: ci, propIndex: i, compDisplayName: compName, propDisplayName: dn, currentValue: val });
              }
            }
            componentsDump.push({ index: ci, displayName: compName, matchName: compMatch, propertyCount: compProps.length, properties: compProps });
          }

          // Set custom text(s). Each "AE.ADBE Text" component in the MOGRT exposes its
          // editable text as property 0 (display name "Texto de origen" / "Source Text").
          // Only one setValue per property — raw_string strategy worked in earlier tests; no
          // JSON wrapping (that broke rendering).
          //
          // Inputs:
          //   args.text  → first text component (e.g., main title in Basic Lower Third)
          //   args.text2 → second text component (e.g., subtitle)
          //   args.text3 → third (if MOGRT has more)
          //   ...
          // Auto-collected from numbered keys.
          var textsByIndex = [];
          if (${textJson} !== null) textsByIndex.push(${textJson});
          ${args.text2 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text2)});` : ''}
          ${args.text3 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text3)});` : ''}
          ${args.text4 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text4)});` : ''}
          var setResults = [];
          if (textsByIndex.length > 0) {
            // PREFERRED PATH: getMGTComponent() for AE-exported MOGRTs (Adobe-CEP canonical).
            // Properties exposed there are the Essential Graphics parameters and contain
            // FULL JSON values that ARE editable.
            // FALLBACK PATH: iterate trackItem.components for "AE.ADBE Text" — only works for
            // some MOGRTs and tokens are opaque single-char references in Premiere-native MOGRTs.
            var textComps = [];
            var textCompsViaMGT = false;
            var textPropNameOverride = ${textPropNameJson};
            // OVERRIDE PATH: caller named a specific property by displayName.
            // Search both the MGT component and all trackItem components for an exact
            // displayName match, then restrict textComps to that single hit.
            // text2/text3/text4 are ignored in override mode — caller targeted one field.
            if (textPropNameOverride) {
              try {
                var mgtCompO = trackItem.getMGTComponent();
                if (mgtCompO && mgtCompO.properties) {
                  for (var miO = 0; miO < mgtCompO.properties.numItems; miO++) {
                    var mpO = mgtCompO.properties[miO];
                    if (String(mpO.displayName) === textPropNameOverride) {
                      textComps.push({ comp: mgtCompO, compIndex: -1, prop: mpO, propIndex: miO, displayName: String(mpO.displayName) });
                      textCompsViaMGT = true;
                      break;
                    }
                  }
                }
              } catch (eOMG) {}
              if (textComps.length === 0) {
                for (var ciO = 0; ciO < trackItem.components.numItems && textComps.length === 0; ciO++) {
                  var cO = trackItem.components[ciO];
                  for (var piO = 0; piO < cO.properties.numItems; piO++) {
                    var pO = cO.properties[piO];
                    if (String(pO.displayName) === textPropNameOverride) {
                      textComps.push({ comp: cO, compIndex: ciO, prop: pO, propIndex: piO, displayName: String(pO.displayName) });
                      break;
                    }
                  }
                }
              }
              if (textComps.length === 0) {
                return JSON.stringify({
                  success: false,
                  error: "textPropertyName override did not match any property displayName: " + textPropNameOverride,
                  componentCount: componentsDump.length,
                  components: componentsDump
                });
              }
              // In override mode keep only the first text (named-target write).
              textsByIndex = [textsByIndex[0]];
              setResults.push({ _strategy: "textPropertyName_override", overrideName: textPropNameOverride });
            }
            // AUTO-DETECT PATH (only when no override).
            if (textComps.length === 0) {
              try {
                var mgtComp = trackItem.getMGTComponent();
                if (mgtComp && mgtComp.properties) {
                  for (var mi = 0; mi < mgtComp.properties.numItems; mi++) {
                    var mp = mgtComp.properties[mi];
                    var mpVal = null;
                    try { mpVal = mp.getValue(); } catch (eMPv) {}
                    // A "text" param has a JSON string value containing textEditValue or mTextString
                    if (typeof mpVal === "string" && mpVal.length > 50 &&
                        (mpVal.indexOf("textEditValue") >= 0 || mpVal.indexOf("mTextString") >= 0 || mpVal.indexOf("capPropTextRunCount") >= 0)) {
                      textComps.push({ comp: mgtComp, compIndex: -1, prop: mp, propIndex: mi, displayName: String(mp.displayName) });
                    }
                  }
                  if (textComps.length > 0) textCompsViaMGT = true;
                }
              } catch (eMGTC) {}
              // Fallback to component iteration if MGT didn't yield text params
              if (textComps.length === 0) {
                for (var ci3 = 0; ci3 < trackItem.components.numItems; ci3++) {
                  var c3 = trackItem.components[ci3];
                  var mn = (c3.matchName !== undefined) ? String(c3.matchName) : "";
                  if (mn === "AE.ADBE Text") {
                    textComps.push({ comp: c3, compIndex: ci3, prop: c3.properties[0], propIndex: 0, displayName: "Source Text (legacy)" });
                  }
                }
              }
              setResults.push({ _strategy: textCompsViaMGT ? "getMGTComponent" : "components_fallback", textCompsFound: textComps.length });
            }
            for (var ti2 = 0; ti2 < textsByIndex.length && ti2 < textComps.length; ti2++) {
              var tc = textComps[ti2];
              var sourceTextProp = tc.prop;
              var newText = String(textsByIndex[ti2]);
              try {
                // Source Text in Premiere/After Effects MOGRTs is stored as:
                //   <4 bytes binary header> + <JSON payload of mTextParam structure>
                // Source: Adobe Community (Kurt_Clark) + Adobe-CEP samples + reproduced
                // independently across multiple Premiere versions (incl. 2026).
                // The agent investigation confirmed this format. Direct setValue("text")
                // stores the value but the renderer cannot parse it → no visual update.
                // Correct mutation: parse JSON (skipping header), patch
                // mTextParam.mStyleSheet.mText, re-prepend header, setValue(...).
                var rawVal = sourceTextProp.getValue();
                var rawValStr = String(rawVal);
                var rawValLen = rawValStr.length;
                var headerBytes = "";
                var jsonStr = "";
                var textObj = null;
                var parseStrategy = "";
                // Strategy 1: 4-byte header + JSON
                try {
                  headerBytes = rawValStr.substring(0, 4);
                  jsonStr = rawValStr.substring(4);
                  textObj = JSON.parse(jsonStr);
                  parseStrategy = "header4+json";
                } catch (eP1) {
                  // Strategy 2: pure JSON (AE 14.3+ no header)
                  try {
                    textObj = JSON.parse(rawValStr);
                    headerBytes = "";
                    parseStrategy = "pure_json";
                  } catch (eP2) {
                    setResults.push({
                      textIndex: ti2, compIndex: tc.compIndex, propIndex: tc.propIndex, requestedText: newText,
                      ok: false,
                      error: "Both JSON parse strategies failed",
                      rawValLength: rawValLen,
                      rawValPreview: rawValStr.substring(0, 50),
                      parseError1: eP1.toString(),
                      parseError2: eP2.toString()
                    });
                    continue;
                  }
                }
                // Mutate the text in the proper nested path(s)
                var mutated = [];
                if (textObj.mTextParam && textObj.mTextParam.mStyleSheet) {
                  textObj.mTextParam.mStyleSheet.mText = newText;
                  mutated.push("mTextParam.mStyleSheet.mText");
                }
                // AE 14.3+ alternate: textEditValue + fontTextRunLength
                if (textObj.textEditValue !== undefined) {
                  textObj.textEditValue = newText;
                  textObj.fontTextRunLength = [newText.length];
                  mutated.push("textEditValue+fontTextRunLength");
                }
                if (mutated.length === 0) {
                  setResults.push({
                    textIndex: ti2, compIndex: tc.compIndex, propIndex: tc.propIndex, requestedText: newText,
                    ok: false,
                    error: "Parsed JSON but no known text field found",
                    parseStrategy: parseStrategy,
                    jsonKeys: (function(){ var ks=[]; for (var k in textObj) ks.push(k); return ks; })()
                  });
                  continue;
                }
                // Re-encode + write back
                var newRawVal = headerBytes + JSON.stringify(textObj);
                sourceTextProp.setValue(newRawVal, true);
                // Verify
                var afterRaw = "";
                try { afterRaw = String(sourceTextProp.getValue()); } catch (eVA) {}
                var afterParseOk = false;
                var afterText = "";
                try {
                  var afterObj = JSON.parse(afterRaw.substring(headerBytes.length));
                  if (afterObj.mTextParam && afterObj.mTextParam.mStyleSheet) {
                    afterText = afterObj.mTextParam.mStyleSheet.mText;
                    afterParseOk = true;
                  } else if (afterObj.textEditValue) {
                    afterText = afterObj.textEditValue;
                    afterParseOk = true;
                  }
                } catch (eAP) {}
                setResults.push({
                  textIndex: ti2,
                  compIndex: tc.compIndex,
                  propIndex: tc.propIndex,
                  requestedText: newText,
                  parseStrategy: parseStrategy,
                  fieldsMutated: mutated,
                  rawValLength: rawValLen,
                  newRawValLength: newRawVal.length,
                  readbackParseOk: afterParseOk,
                  readbackText: afterText,
                  ok: (afterText === newText)
                });
              } catch (eS) {
                setResults.push({ textIndex: ti2, compIndex: tc.compIndex, propIndex: tc.propIndex, requestedText: newText, ok: false, error: eS.toString() });
              }
            }
            if (textComps.length === 0) {
              setResults.push({ ok: false, error: "No 'AE.ADBE Text' components found in MOGRT" });
            } else if (textsByIndex.length > textComps.length) {
              setResults.push({ ok: false, warning: "More texts requested (" + textsByIndex.length + ") than text components in MOGRT (" + textComps.length + ")" });
            }
          }

          return JSON.stringify({
            success: true,
            message: "MOGRT imported as text overlay",
            clipId: trackItem.nodeId,
            premiereVersion: premiereVersion,
            premiereBuild: premiereBuild,
            apiProbe: apiProbe,
            componentCount: componentsDump.length,
            components: componentsDump,
            textPropsAutoDetected: textPropsFound,
            textRequestedCount: textsByIndex.length,
            textInjectionResults: setResults
          });
        } catch (e) {
          var failedClipId = null;
          try {
            if (typeof trackItem !== "undefined" && trackItem) failedClipId = trackItem.nodeId;
          } catch (eClipId) {}
          return JSON.stringify({ success: false, error: e.toString(), clipId: failedClipId });
        }
      `;
      const bridgeResult = await this.bridge.executeScript(script);
      const evaluatedResult = evaluateTextInjectionResult(bridgeResult);
      if (
        (evaluatedResult?.textInjectionStatus === 'failed' ||
          (evaluatedResult?.success === false && evaluatedResult?.clipId)) &&
        args.rollbackOnTextFailure === true &&
        evaluatedResult.clipId
      ) {
        const rollbackScript = `
          try {
            var info = __findClip(${JSON.stringify(evaluatedResult.clipId)}, ${JSON.stringify(args.sequenceId)});
            if (!info) return JSON.stringify({ success: false, error: "Imported Graphic was not found for rollback" });
            info.clip.remove(false, true);
            return JSON.stringify({
              success: true,
              timelineGraphicRemoved: true,
              note: "The timeline Graphic was removed; the imported project item may remain in the Project panel."
            });
          } catch (e) {
            return JSON.stringify({ success: false, timelineGraphicRemoved: false, error: e.toString() });
          }
        `;
        const rollback = await this.bridge.executeScript(rollbackScript);
        const rollbackSucceeded = rollback?.success === true;
        if (rollbackSucceeded) {
          const { clipId: removedClipId, ...failureResult } = evaluatedResult;
          return {
            ...failureResult,
            error: `${evaluatedResult.error} The imported timeline Graphic was removed.`,
            removedClipId,
            rollback
          };
        }
        return {
          ...evaluatedResult,
          error: `${evaluatedResult.error} Rollback of the imported timeline Graphic also failed.`,
          rollback
        };
      }
      if (evaluatedResult?.textInjectionStatus === 'failed') {
        return {
          ...evaluatedResult,
          error: `${evaluatedResult.error} The imported Graphic remains on the timeline.`
        };
      }
      return evaluatedResult;
    }

    // Fallback: try legacy title approach
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(args.sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
        return JSON.stringify({
          success: false,
          error: "Text overlay requires a MOGRT file path. Use the mogrtPath parameter with a .mogrt template file, or use import_mogrt tool.",
          note: "Legacy titles (app.project.createNewTitle) are not supported in current Premiere Pro ExtendScript API."
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Import MOGRT Implementation
  protected async importMogrt(sequenceId: string, mogrtPath: string, time: number, videoTrackIndex?: number, audioTrackIndex?: number): Promise<any> {
    const vidTrack = videoTrackIndex || 0;
    const audTrack = audioTrackIndex || 0;
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var ticks = __secondsToTicks(${time});
        var clip = seq.importMGT(${JSON.stringify(mogrtPath)}, ticks, ${vidTrack}, ${audTrack});
        var clipId = "";
        if (clip && clip.nodeId) clipId = clip.nodeId;
        return JSON.stringify({
          success: true,
          message: "MOGRT imported",
          clipId: clipId
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Import MOGRT From Library Implementation
  protected async importMogrtFromLibrary(sequenceId: string, libraryName: string, mogrtName: string, time: number, videoTrackIndex?: number, audioTrackIndex?: number): Promise<any> {
    const vidTrack = videoTrackIndex || 0;
    const audTrack = audioTrackIndex || 0;
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var ticks = __secondsToTicks(${time});
        var clip = seq.importMGTFromLibrary(${JSON.stringify(libraryName)}, ${JSON.stringify(mogrtName)}, ticks, ${vidTrack}, ${audTrack});
        var clipId = "";
        if (clip && clip.nodeId) clipId = clip.nodeId;
        return JSON.stringify({
          success: true,
          message: "MOGRT imported from library",
          clipId: clipId
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async watermarkApply(logoPath: string, opacity: number, corner: string, _seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var logoFile = new File(${JSON.stringify(logoPath)});
        if (!logoFile.exists) return JSON.stringify({success:false,error:'Logo file not found: ' + ${JSON.stringify(logoPath)}});
        // Import the logo
        app.project.importFiles([${JSON.stringify(logoPath)}], true, app.project.rootItem, false);
        // Find the imported item
        var logoItem = null;
        var root = app.project.rootItem;
        for (var i=root.children.numItems-1;i>=0;i--) {
          if (String(root.children[i].getMediaPath()).indexOf(${JSON.stringify(logoPath.split('/').pop() ?? '')}) >= 0) { logoItem = root.children[i]; break; }
        }
        if (!logoItem) return JSON.stringify({success:false,error:'Could not find imported logo item'});
        // Place on top track
        var topTrack = seq.videoTracks[seq.videoTracks.numTracks - 1];
        var seqDuration = seq.end;
        var t = new Time(); t.ticks = '0';
        topTrack.overwriteClip(logoItem, t);
        return JSON.stringify({success:true,logoPath:${JSON.stringify(logoPath)},opacity:${opacity},corner:${JSON.stringify(corner)},note:'Logo placed on top track. Use set_clip_opacity to set opacity and set_clip_position to position in corner.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getMogrtTextAll(_seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var mogrts = [];
        for (var t=0;t<seq.videoTracks.numTracks;t++) {
          var track = seq.videoTracks[t];
          for (var c=0;c<track.clips.numItems;c++) {
            var clip = track.clips[c];
            if (clip.isMGT && clip.isMGT()) {
              var comp = clip.getMGTComponent();
              var params = [];
              if (comp) {
                for (var i=0;i<comp.properties.numItems;i++) {
                  var prop = comp.properties[i];
                  var pname = String(prop.displayName);
                  try { var val = prop.getValue(); if (typeof val === 'string' || typeof val === 'number') params.push({name:pname,value:val}); } catch(e2) {}
                }
              }
              mogrts.push({track:t,clip:c,name:String(clip.name),params:params});
            }
          }
        }
        return JSON.stringify({success:true,count:mogrts.length,mogrts:mogrts});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async removeMogrtClip(_seqId: string|undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var track = seq.videoTracks[${trackIndex}];
        var clip = track && track.clips[${clipIndex}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var before = track.clips.numItems;
        var wasMogrt = false; try { wasMogrt = !!clip.isMGT(); } catch (eM) {}
        // Sequence has NO remove() method — remove() lives on TrackItem (confirmed by reflection
        // on 26.3.2). The old call raised "seq.remove is not a function" every time, and the
        // dead-end fallback below it built two Time objects and then did nothing with them, so
        // the tool reported success:true with verified:false rather than failing.
        var removed = false, err = null;
        try { clip.remove(false, false); removed = true; } catch (eR) { err = eR.toString(); }
        var after = track.clips.numItems;
        if (!removed || after >= before) {
          return JSON.stringify({
            success: false, verified: true,
            error: err ? ('TrackItem.remove() threw: ' + err) : 'TrackItem.remove() ran but the clip is still on the track.',
            clipsBefore: before, clipsAfter: after, wasMogrt: wasMogrt
          });
        }
        return JSON.stringify({
          success: true, verified: true, clipsBefore: before, clipsAfter: after, wasMogrt: wasMogrt,
          note: wasMogrt ? null : 'This clip was not a Motion Graphics Template; it was removed anyway.'
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async createAdjustmentLayerAt(startTimeSecs: number, durationSecs: number, trackIndex?: number, _seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var tIdx = ${trackIndex ?? 'seq.videoTracks.numTracks - 1'};
        var track = seq.videoTracks[tIdx];
        if (!track) return JSON.stringify({success:false,error:'Track not found'});
        // Create a new transparent video clip as adjustment layer base
        var t = new Time(); t.seconds = ${startTimeSecs};
        return JSON.stringify({success:false,verified:false,note:'createAdjustmentLayerAt: newTransparentVideo() opens a dialog in Premiere (confirmed limitation). Use add_adjustment_layer tool or create via Import instead.',startTimeSecs:${startTimeSecs},durationSecs:${durationSecs}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
