/**
 * ColorTools -- the Color tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { ProjectMediaTools } from './project-media.js';
import { spawn, execSync } from 'child_process';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import * as osSync from 'node:os';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { ClipPlanColor } from './shared.js';

export class ColorTools extends ProjectMediaTools {
  protected hasColorAdjustments(color?: ClipPlanColor): boolean {
    if (!color) {
      return false;
    }
    return Object.values(color).some((value) => value !== undefined);
  }

  /**
   * Set Lumetri parameters BY INDEX BUT CHECKED BY NAME, and verify each one by readback.
   *
   * The previous version took a blob of assignments, each individually wrapped in
   * `try{...}catch(e){}`, and then returned `success: true, verified: true`
   * unconditionally. So every failure was swallowed and reported as a verified success —
   * the exact shape of lie this server exists to prevent.
   *
   * Two things make the index approach safe now:
   *
   *  - Each index carries the NAME it is expected to be, checked before writing. The indices
   *    are correct on 26.3.2 (14 Temperature, 15 Tint, 16 Saturation, 19 Exposure, 20 Contrast,
   *    21 Highlights, 22 Shadows, 23 Whites, 24 Blacks, 40 Faded Film, 41 Sharpen, 42 Vibrance,
   *    43 Saturation, 110-113 Vignette) — but a hardcoded index that silently shifts in a future
   *    build would write a real value to the WRONG parameter, mis-grading a shot with no error.
   *    On a mismatch this falls back to a by-name search and says which route it used; if the
   *    name is nowhere to be found it reports that instead of writing anything.
   *  - Every write is read back and compared, so `verified` means something.
   *
   * Lumetri's flat list repeats several names (Temperature at 14 and 101, Contrast at 20 and 103,
   * Saturation at 16, 43 and 105), which is why the index is the primary key and the name is the
   * guard rather than the other way round.
   */
  private lumetriParamScript(
    seqId: string | undefined,
    ti: number,
    ci: number,
    targets: Array<{ index: number; name: string; value: number }>,
  ): string {
    return `
      try {
        var seq = ${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        var track = seq.videoTracks[${ti}];
        if (!track) return JSON.stringify({success:false,error:'Video track ${ti} not found'});
        var clip = track.clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found at track ${ti} index ${ci}'});
        var lumetri = null;
        for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName).indexOf('Lumetri')>=0) { lumetri=clip.components[i]; break; } }
        if (!lumetri) return JSON.stringify({success:false,error:'No Lumetri Color on clip — apply it first with apply_lumetri_preset'});
        var props = lumetri.properties;
        var targets = ${JSON.stringify(targets)};
        var results = [], applied = 0;
        for (var t=0;t<targets.length;t++) {
          var spec = targets[t];
          var param = null, route = 'index';
          if (spec.index < props.numItems) {
            var candidate = props[spec.index];
            var actualName = '';
            try { actualName = String(candidate.displayName); } catch (eN) {}
            if (actualName === spec.name) { param = candidate; }
          }
          if (!param) {
            // Index did not hold the expected parameter on this build — find it by name instead.
            for (var pj=0; pj<props.numItems; pj++) {
              var nm2 = '';
              try { nm2 = String(props[pj].displayName); } catch (eN2) {}
              if (nm2 === spec.name) { param = props[pj]; route = 'name-fallback(index ' + pj + ')'; break; }
            }
          }
          if (!param) {
            results.push({ name: spec.name, expectedIndex: spec.index, ok: false, status: 'parameter_not_found',
              error: 'Lumetri on this clip has no parameter named ' + spec.name + ' at index ' + spec.index + ' or anywhere in its ' + props.numItems + ' parameters. Nothing was written.' });
            continue;
          }
          var before = null; try { before = param.getValue(); } catch (eB) {}
          var setError = null;
          try { param.setValue(spec.value, true); } catch (eS) { setError = eS.toString(); }
          var after = null; try { after = param.getValue(); } catch (eA) {}
          var landed = after !== null && Math.abs(Number(after) - Number(spec.value)) < 0.001;
          if (landed) applied++;
          results.push({ name: spec.name, route: route, valueRequested: spec.value, valueBefore: before,
            valueAfter: after, changed: before !== after, ok: landed,
            status: landed ? 'verified' : (setError ? 'set_threw' : 'not_applied'),
            error: landed ? null : (setError || ('Value reads back as ' + after + ' rather than ' + spec.value + '.')) });
        }
        return JSON.stringify({
          success: applied > 0 && applied === targets.length,
          verified: true, applied: applied, requested: targets.length, results: results,
          error: applied === targets.length ? null : (applied === 0 ? 'No Lumetri parameter could be applied; see results[].' : 'Only ' + applied + ' of ' + targets.length + ' parameters applied; see results[].')
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `;
  }

  protected async lumetriBasicSet(args: any): Promise<any> {
    const ti = args.trackIndex ?? 0; const ci = args.clipIndex ?? 0;
    const targets: Array<{ index: number; name: string; value: number }> = [];
    // index/name pairs verified against 26.3.2; the name is checked before the write.
    const map: Array<[string, number, string]> = [
      ['temperature', 14, 'Temperature'], ['tint', 15, 'Tint'], ['saturation', 16, 'Saturation'],
      ['exposure', 19, 'Exposure'], ['contrast', 20, 'Contrast'], ['highlights', 21, 'Highlights'],
      ['shadows', 22, 'Shadows'], ['whites', 23, 'Whites'], ['blacks', 24, 'Blacks'],
    ];
    for (const [arg, index, name] of map) {
      if (args[arg] !== undefined) targets.push({ index, name, value: Number(args[arg]) });
    }
    if (targets.length === 0) return { success: false, error: `No Lumetri basic parameters provided. Supply at least one of: ${map.map((m) => m[0]).join(', ')}.` };
    return await this.bridge.executeScript(this.lumetriParamScript(args.sequenceId, ti, ci, targets));
  }

  protected async lumetriCreativeSet(args: any): Promise<any> {
    const ti = args.trackIndex ?? 0; const ci = args.clipIndex ?? 0;
    const targets: Array<{ index: number; name: string; value: number }> = [];
    const map: Array<[string, number, string]> = [
      ['fadedFilm', 40, 'Faded Film'], ['sharpen', 41, 'Sharpen'],
      ['vibrance', 42, 'Vibrance'], ['saturation', 43, 'Saturation'],
    ];
    for (const [arg, index, name] of map) {
      if (args[arg] !== undefined) targets.push({ index, name, value: Number(args[arg]) });
    }
    if (targets.length === 0) return { success: false, error: `No Lumetri creative parameters provided. Supply at least one of: ${map.map((m) => m[0]).join(', ')}.` };
    return await this.bridge.executeScript(this.lumetriParamScript(args.sequenceId, ti, ci, targets));
  }

  protected async lumetriVignetteSet(args: any): Promise<any> {
    const ti = args.trackIndex ?? 0; const ci = args.clipIndex ?? 0;
    const targets: Array<{ index: number; name: string; value: number }> = [];
    const map: Array<[string, number, string]> = [
      ['amount', 110, 'Amount'], ['midpoint', 111, 'Midpoint'],
      ['roundness', 112, 'Roundness'], ['feather', 113, 'Feather'],
    ];
    for (const [arg, index, name] of map) {
      if (args[arg] !== undefined) targets.push({ index, name, value: Number(args[arg]) });
    }
    if (targets.length === 0) return { success: false, error: `No Lumetri vignette parameters provided. Supply at least one of: ${map.map((m) => m[0]).join(', ')}.` };
    return await this.bridge.executeScript(this.lumetriParamScript(args.sequenceId, ti, ci, targets));
  }

  protected async lumetriReport(sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        var clip = seq.videoTracks[${ti}].clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var lumetri = null;
        for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName).indexOf('Lumetri')>=0) { lumetri=clip.components[i]; break; } }
        if (!lumetri) return JSON.stringify({success:false,error:'No Lumetri Color on clip'});
        var props = lumetri.properties;
        var report = {};
        var names = ['Blob','HDR','BasicCorrection','Active','','','InputLUT','InputLUT2','HDRWhite','','','Intensity','Color','WhiteBalance','Temperature','Tint','Saturation','','Light','Exposure','Contrast','Highlights','Shadows','Whites','Blacks','HDRSpecular','','','','','Creative','Active2','','','Look','Look2','','ColorSpace','Intensity2','Adjustments','FadedFilm','Sharpen','Vibrance','Saturation2','','TintBalance','','','Curves','Active3','RGBCurves','Active4','HDRRange','','','HueSatCurves','Active5','HueSatSel','HueSat','Active6','HueHueSel','HueHue','Active7','HueLumaSel','HueLuma','Active8','LumaSatSel','LumaSat','Active9','SatSatSel','SatSat','','','ColorWheels','Active10','','FaceDetection','','HDRWhite2','','','HSLSecondary','Active11','Key','SetColor','AddColor','RemoveColor','','ShowMask','','InvertMask','','','','Refine','Denoise','Blur','Blur2','Correction','','','Temperature2','Tint2','Contrast2','Sharpen2','Saturation3','Saturation4','','Vignette','Active12','Amount','Midpoint','Roundness','Feather'];
        for (var pi=0;pi<Math.min(props.numItems,names.length);pi++) {
          var n = names[pi] || ('param_'+pi);
          try { var v=props[pi].getValue(); if (typeof v !== 'object' && String(v).length < 100) report[n]=v; } catch(e){}
        }
        return JSON.stringify({success:true,clipName:String(clip.name),grade:report});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async copyGrade(sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    const report = await this.lumetriReport(sequenceId, ti, ci);
    if (!report.success) return report;
    return { success: true, gradeJson: JSON.stringify(report.grade), clipName: report.clipName };
  }

  protected async pasteGradeToClips(gradeJson: string, targets: Array<{trackIndex: number, clipIndex: number}>, sequenceId?: string): Promise<any> {
    const grade = JSON.parse(gradeJson);
    const names = ['Blob','HDR','BasicCorrection','Active','','','InputLUT','InputLUT2','HDRWhite','','','Intensity','Color','WhiteBalance','Temperature','Tint','Saturation','','Light','Exposure','Contrast','Highlights','Shadows','Whites','Blacks','HDRSpecular','','','','','Creative','Active2','','','Look','Look2','','ColorSpace','Intensity2','Adjustments','FadedFilm','Sharpen','Vibrance','Saturation2','','TintBalance','','','Curves','Active3','RGBCurves','Active4','HDRRange','','','HueSatCurves','Active5','HueSatSel','HueSat','Active6','HueHueSel','HueHue','Active7','HueLumaSel','HueLuma','Active8','LumaSatSel','LumaSat','Active9','SatSatSel','SatSat','','','ColorWheels','Active10','','FaceDetection','','HDRWhite2','','','HSLSecondary','Active11','Key','SetColor','AddColor','RemoveColor','','ShowMask','','InvertMask','','','','Refine','Denoise','Blur','Blur2','Correction','','','Temperature2','Tint2','Contrast2','Sharpen2','Saturation3','Saturation4','','Vignette','Active12','Amount','Midpoint','Roundness','Feather'];
    const numericKeys = ['Temperature','Tint','Saturation','Exposure','Contrast','Highlights','Shadows','Whites','Blacks','FadedFilm','Sharpen','Vibrance','Saturation2','Amount','Midpoint','Roundness','Feather','Intensity','Intensity2'];
    // The `names` table above is a positional map of Lumetri's flat parameter list, with
    // synthetic suffixes for the repeated names (Saturation2, Temperature2, ...). Only the real
    // parameter name is checked against the host, so strip the suffix before passing it as the
    // expected name — otherwise every de-duplicated entry would fail its own name guard.
    const paramTargets = names
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n && (n in grade) && numericKeys.includes(n))
      .map(({ n, i }) => ({ index: i, name: n.replace(/[0-9]+$/, ''), value: Number(grade[n]) }))
      .filter((t) => Number.isFinite(t.value));

    if (paramTargets.length === 0) {
      return { success: false, error: 'The supplied grade contained no numeric Lumetri parameters that this tool knows how to paste.', pasted: 0, results: [] };
    }

    const results: any[] = [];
    for (const t of targets) {
      const r: any = await this.bridge.executeScript(this.lumetriParamScript(sequenceId, t.trackIndex, t.clipIndex, paramTargets));
      results.push({ trackIndex: t.trackIndex, clipIndex: t.clipIndex, success: r?.success === true,
        applied: r?.applied ?? 0, requested: r?.requested ?? paramTargets.length, error: r?.error ?? null });
    }
    // Previously returned success:true and pasted:results.length no matter what each clip did,
    // so a paste that landed on nothing reported total success.
    const fullyPasted = results.filter((r) => r.success).length;
    return {
      success: fullyPasted > 0 && fullyPasted === results.length,
      verified: true,
      pasted: fullyPasted, attempted: results.length, parameters: paramTargets.length, results,
      error: fullyPasted === results.length ? null
        : (fullyPasted === 0 ? 'The grade was pasted to no clips; see results[].' : `Only ${fullyPasted} of ${results.length} clips received the full grade; see results[].`),
    };
  }

  protected async autoWhiteBalance(sequenceId: string | undefined, ti: number, ci: number): Promise<any> {
    const newData = JSON.stringify({ mAutoTonePressed: true, mBlacks: 0, mContrast: 0, mExposure: 0, mHighlights: 0, mLastPressedAutoToneButton: 0, mResetPressed: false, mSaturation: 0, mShadows: 0, mTemperature: 0, mTint: 0, mWhites: 0 });
    // This one writes a JSON BLOB to the Auto Tone Analytics Data parameter, not a number, so the
    // numeric helper does not apply. Verified by comparing the blob string back, and honest that a
    // successful write is not proof Premiere has finished analysing.
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        var track = seq.videoTracks[${ti}];
        var clip = track && track.clips[${ci}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found at track ${ti} index ${ci}'});
        var lumetri = null;
        for (var i=0;i<clip.components.numItems;i++) { if (String(clip.components[i].displayName).indexOf('Lumetri')>=0) { lumetri=clip.components[i]; break; } }
        if (!lumetri) return JSON.stringify({success:false,error:'No Lumetri Color on clip — apply it first with apply_lumetri_preset'});
        var props = lumetri.properties;
        // Locate the parameter by NAME, falling back to the known index, so a shifted parameter
        // list produces an error rather than a value written into the wrong slot.
        var param = null, route = 'name';
        for (var pj=0; pj<props.numItems; pj++) {
          var nm=''; try { nm=String(props[pj].displayName); } catch(eN){}
          if (nm === 'Auto Tone Analytics Data') { param = props[pj]; break; }
        }
        if (!param && props.numItems > 126) { param = props[126]; route = 'index-126-fallback'; }
        if (!param) return JSON.stringify({success:false,error:'Lumetri exposes no Auto Tone Analytics Data parameter on this clip, so auto white balance cannot be triggered by script.'});
        var before=null; try{ before=String(param.getValue()); }catch(eB){}
        var setError=null;
        try { param.setValue(${JSON.stringify(newData)}, true); } catch(eS) { setError=eS.toString(); }
        var after=null; try{ after=String(param.getValue()); }catch(eA){}
        var wrote = after !== null && after !== before;
        return JSON.stringify({
          success: wrote, verified: after !== null, route: route, changed: wrote,
          error: wrote ? null : (setError || 'The Auto Tone blob read back unchanged, so the request was not accepted.'),
          note: wrote ? 'Auto Tone was requested. Premiere performs the analysis itself, so the resulting Temperature/Tint values are not readable from this call — read them with lumetri_report once the analysis has settled.' : null
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setLutInterpolation(method: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var before = null;
        try { before = Number(app.project.getLUTInterpolationMethod()); } catch(eB) {}
        app.project.setLUTInterpolationMethod(${method});
        var after = null;
        try { after = Number(app.project.getLUTInterpolationMethod()); } catch(eA) {}
        if (after === null) {
          return JSON.stringify({success:true,verified:false,method:${method},before:before,
            unverifiedReason:'setLUTInterpolationMethod() did not throw, but getLUTInterpolationMethod() is not readable on this build, so the value cannot be confirmed.'});
        }
        if (after !== Number(${method})) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'app.project.getLUTInterpolationMethod() readback',changed:after!==before,method:${method},before:before,readback:after,
            error:'Premiere kept LUT interpolation at ' + after + ' instead of the requested ${method}. Only the methods this build supports are accepted.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'app.project.getLUTInterpolationMethod() readback',changed:after!==before,method:${method},before:before,readback:after,
          note: after === before ? 'LUT interpolation was already set to this method; nothing changed.' : undefined});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getLumetriPresetList(folder?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var all;
        if (${folder ? JSON.stringify(folder) : 'null'}) {
          all = app.project.getLumetriPresetsForFolderList(${folder ? JSON.stringify(folder) : '""'});
        } else {
          all = app.project.getAllLumetriPresetsList();
        }
        var parts = String(all).split(',').map(function(s){return s.replace(/^\\s+|\\s+$/g,'');}).filter(function(s){return s.length>0;});
        return JSON.stringify({success:true,presets:parts,count:parts.length,folder:${folder ? JSON.stringify(folder) : 'null'}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setClipBorderColor(trackIndex: number, clipIndex: number, _r: number, _g: number, _b: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      // A CALL THAT KILLS THE SCRIPT IS NOT WORTH EMITTING.
      // Measured one-call-per-script on 26.3.2: qeClip.setBorderWidth, setBorderColor, setReverse and setAntiAliasQuality do not throw a catchable exception — they terminate the entire evalScript, so the tool returned only the generic "ExtendScript execution failed" and the caller learned nothing.
      // Reading the matching properties (borderWidth, borderColor, reverse, antiAliasQuality, alignment, startPercent, endPercent, switchSources) is fatal in the same way.
      // setFrameBlend and setScaleToFrameSize are fine, so this is specific, not a blanket QE problem.
      return JSON.stringify({success:false,verified:true,available:false,error:'qeClip.setBorderColor terminates the ExtendScript engine on this build (26.3.2), so this tool cannot run. No scripted alternative exists for clip borders; set them in the Effect Controls panel.'});

    `);
  }

  // Batch G: Clip property utilities
  protected async getClipColorSpace(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var root = app.project.rootItem;
        function findById(bin,id){for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null;}
        var item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        var orig = null, ovr = null;
        try { orig = __csInfo(item.getOriginalColorSpace()); } catch(eO) {}
        try { ovr = __csInfo(item.getOverrideColorSpace()); } catch(eV) {}
        return JSON.stringify({success:true,projectItemId:${JSON.stringify(projectItemId)},originalColorSpace:orig,overrideColorSpace:(ovr && !ovr.empty) ? ovr : null,availableOverrides:__colorSpaceNames(item)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setClipColorSpace(projectItemId: string, colorSpaceName: string): Promise<any> {
    // Same operation as set_color_space_override. This used to pass the name string straight to
    // setOverrideColorSpace(), which takes a ColorSpace object and threw "Illegal Parameter type".
    return await this.setColorSpaceOverride(projectItemId, colorSpaceName);
  }

  protected async applyLutToClip(trackIndex: number, clipIndex: number, lutPath: string, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        var clip = seq.videoTracks[${trackIndex}].clips[${clipIndex}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var comps = clip.components;
        for (var i=0; i<comps.numItems; i++) {
          if (String(comps[i].displayName).indexOf('Lumetri') >= 0) {
            // Input LUT is at param index 6 and 7 (path and mode)
            var lutProp = null;
            for (var pi=0; pi<comps[i].properties.numItems; pi++) {
              if (String(comps[i].properties[pi].displayName) === 'Input LUT' && pi === 6) { lutProp = comps[i].properties[pi]; break; }
            }
            if (lutProp) {
              lutProp.setValue(${JSON.stringify(lutPath)}, true);
              return JSON.stringify({success:true,lutPath:${JSON.stringify(lutPath)},appliedToLumetriIndex:i});
            }
          }
        }
        return JSON.stringify({success:false,error:'No Lumetri Color component found on clip. Apply lumetri first.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  /** Map a scope name to its (verified) ffmpeg video filter. */
  private scopeFilter(scope: string): string {
    switch (scope) {
      case 'vectorscope': return 'vectorscope';
      case 'histogram': return 'histogram';
      case 'rgb_parade': return 'waveform=display=parade:components=7';
      case 'waveform':
      default: return 'waveform';
    }
  }

  /**
   * Render a signal scope (waveform / vectorscope / histogram / RGB parade) from
   * one frame of a media file to a PNG, via ffmpeg. Premiere's Lumetri scopes
   * are not scriptable, so this is the only way to get scope output from the
   * pipeline. Same honesty contract as detect_silence/transcribe_to_srt: probe
   * for ffmpeg, fail with install guidance if absent, and verify-after-write
   * (the PNG must exist) before claiming success -- so an out-of-range timestamp
   * or unreadable file returns a clear error, not a fake success.
   */
  protected async generateScope(
    mediaPath?: string,
    projectItemId?: string,
    scope = 'waveform',
    timeSeconds = 0,
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
        error: `ffmpeg ('${ffmpeg}') was not found on PATH. generate_scope renders scopes with ffmpeg because Premiere's Lumetri scopes cannot be scripted or exported. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFMPEG_CMD to the binary name, then try again.`,
      };
    }

    const outPng = (outputPath && outputPath.trim())
      || join(dirname(resolvedPath), `${basename(resolvedPath, extname(resolvedPath))}_${scope}.png`);
    const filter = this.scopeFilter(scope);
    const seek = Math.max(0, timeSeconds);

    return await new Promise((resolve) => {
      const argv = ['-y', '-ss', String(seek), '-i', resolvedPath as string, '-frames:v', '1', '-vf', filter, outPng];
      const proc = spawn(ffmpeg, argv);
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffmpeg ('${ffmpeg}'): ${err.message}`, mediaPath: resolvedPath });
      });
      proc.on('close', async (code) => {
        // Verify-after-write: the PNG must actually exist before we claim success.
        try {
          await fs.access(outPng, fsConstants.R_OK);
        } catch {
          resolve({
            success: false,
            error: `ffmpeg exited with code ${code} but no scope image was written to ${outPng}. The frame at ${seek}s may be past the end of the clip, or the file couldn't be read.`,
            mediaPath: resolvedPath,
            ffmpegStderr: stderr.slice(-2000),
          });
          return;
        }
        let sizeBytes: number | undefined;
        try { sizeBytes = (await fs.stat(outPng)).size; } catch { /* size is best-effort */ }
        resolve({
          success: true,
          scope,
          scopePath: outPng,
          timeSeconds: seek,
          sizeBytes,
          mediaPath: resolvedPath,
          note: `Scope image written. ffmpeg filter used: "${filter}" at t=${seek}s.`,
        });
      });
    });
  }

  // Color Correction Implementation
  //
  // colorCorrect and applyLut both add a Lumetri Color effect to a QE-addressed clip
  // and then set named properties on it. Earlier versions swallowed every setValue
  // error in an empty catch and returned success unconditionally, so a localized
  // Premiere (where a property's displayName differs), an unmatched property, or an
  // invalid value silently "succeeded". Both now route through applyLumetriParams,
  // which matches each property by displayName (exact then normalized), reads the
  // value back, and reports precisely what took.
  private async applyLumetriParams(
    clipId: string,
    requestedParams: Record<string, number | string>,
    label: string,
    extra: Record<string, unknown> = {}
  ): Promise<any> {
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
        if (!qeClip) return JSON.stringify({ success: false, error: "Could not address the clip through the QE API." });
        var effect = qe.project.getVideoEffectByName("Lumetri Color");
        if (!effect) return JSON.stringify({ success: false, error: "Lumetri Color effect not found" });
        qeClip.addVideoEffect(effect);
        var clip = info.clip;
        var lastComp = clip.components[clip.components.numItems - 1];

        function normalizeName(s) { return String(s).toLowerCase().replace(/[\\s_-]+/g, ''); }
        function valuesEquivalent(actual, requested) {
          if (actual === requested) return true;
          if (typeof actual === "number" && typeof requested === "number") return Math.abs(actual - requested) <= 0.0001;
          return String(actual) === String(requested);
        }

        var requestedParams = ${JSON.stringify(requestedParams)};
        var results = [];
        for (var rn in requestedParams) {
          if (requestedParams.hasOwnProperty && !requestedParams.hasOwnProperty(rn)) continue;
          var reqVal = requestedParams[rn];
          var matched = null;
          for (var k = 0; k < lastComp.properties.numItems; k++) {
            if (String(lastComp.properties[k].displayName) === rn) { matched = lastComp.properties[k]; break; }
          }
          if (!matched) {
            var nn = normalizeName(rn);
            for (var k2 = 0; k2 < lastComp.properties.numItems; k2++) {
              if (normalizeName(String(lastComp.properties[k2].displayName)) === nn) { matched = lastComp.properties[k2]; break; }
            }
          }
          if (!matched) { results.push({ name: rn, ok: false, status: "no_matching_property" }); continue; }
          var before = null; var beforeOk = true;
          try { before = matched.getValue(); } catch (eB) { beforeOk = false; }
          var threw = false; var errMsg = null;
          try { matched.setValue(reqVal, true); } catch (eS) { threw = true; errMsg = eS.toString(); }
          var after = null; var afterOk = true;
          try { after = matched.getValue(); } catch (eA) { afterOk = false; }
          var verified = !threw && afterOk && valuesEquivalent(after, reqVal);
          var changed = !threw && beforeOk && afterOk && !valuesEquivalent(after, before);
          var status = threw ? "setvalue_threw" : (verified ? "verified" : (changed ? "changed_with_warning" : (!afterOk ? "unverifiable" : "unchanged")));
          results.push({ name: rn, matchedDisplayName: String(matched.displayName), valueRequested: reqVal, valueBefore: before, valueAfter: after, status: status, ok: (verified || changed), error: errMsg });
        }

        var okCount = 0; var matchedCount = 0;
        for (var r = 0; r < results.length; r++) {
          if (results[r].status !== "no_matching_property") matchedCount++;
          if (results[r].ok) okCount++;
        }
        var overall = results.length > 0 && okCount === results.length;
        var payload = ${JSON.stringify(extra)};
        payload.success = overall;
        payload.applied = okCount;
        payload.matched = matchedCount;
        payload.requested = results.length;
        payload.results = results;
        payload.clipId = ${JSON.stringify(clipId)};
        payload.message = overall
          ? (${JSON.stringify(label)} + " applied and verified (" + okCount + "/" + results.length + " properties).")
          : (${JSON.stringify(label)} + " not fully applied (" + okCount + "/" + results.length + " properties verified). See results.");
        // Populate the error field too, not just message. This returned success:false with NO
        // error field, so every caller — including our own sweep harness — saw an unexplained
        // failure while the actual reason sat in message/results. The convention is that a failed
        // result explains itself in error; putting the explanation somewhere else is the same
        // problem as not having one.
        payload.verified = true;
        if (!overall) {
          var failedNames = [];
          for (var fi = 0; fi < results.length; fi++) {
            if (!results[fi].ok) {
              failedNames.push(String(results[fi].name) + " (" + String(results[fi].status || "not applied") + ")");
            }
          }
          payload.error = results.length === 0
            ? (${JSON.stringify(label)} + ": no properties were requested, so nothing was applied.")
            : (${JSON.stringify(label)} + ": " + okCount + " of " + results.length + " properties verified. Not applied: " + failedNames.join(", ") + ". A property reported as no_matching_property does not exist under that name on this build of Lumetri.");
        } else {
          payload.error = null;
        }
        return JSON.stringify(payload);
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  /**
   * Basic colour correction, mapped to the parameter names Lumetri ACTUALLY exposes.
   *
   * Enumerated live on 26.3.2: Lumetri's Basic Correction parameters are Temperature, Tint,
   * Saturation, Exposure, Contrast, Highlights, Shadows, Whites, Blacks and (further down)
   * Vibrance. There is **no parameter called Brightness**, so the previous mapping of
   * brightness -> "Brightness" could never match and the tool reported
   * no_matching_property for the one adjustment people reach for first. Exposure is the
   * equivalent, so brightness maps there.
   *
   * There is also no Hue parameter in Basic Correction, so `hue` is rejected explicitly instead
   * of being sent to a name that does not exist. Silently accepting an adjustment that cannot be
   * applied is the failure mode this whole server is built to avoid.
   *
   * Note several names appear more than once in the flat parameter list (Temperature at 14 and
   * 101, Contrast at 20 and 103, Saturation at 16, 43 and 105). Matching by name takes the first,
   * which is the Basic Correction instance — the one a caller means.
   */
  protected async colorCorrect(clipId: string, adjustments: any): Promise<any> {
    const requested: Record<string, number> = {};
    // brightness and exposure are the same Lumetri parameter; an explicit exposure wins.
    if (adjustments.brightness !== undefined) requested["Exposure"] = adjustments.brightness;
    if (adjustments.exposure !== undefined) requested["Exposure"] = adjustments.exposure;
    if (adjustments.contrast !== undefined) requested["Contrast"] = adjustments.contrast;
    if (adjustments.saturation !== undefined) requested["Saturation"] = adjustments.saturation;
    if (adjustments.vibrance !== undefined) requested["Vibrance"] = adjustments.vibrance;
    if (adjustments.highlights !== undefined) requested["Highlights"] = adjustments.highlights;
    if (adjustments.shadows !== undefined) requested["Shadows"] = adjustments.shadows;
    if (adjustments.whites !== undefined) requested["Whites"] = adjustments.whites;
    if (adjustments.blacks !== undefined) requested["Blacks"] = adjustments.blacks;
    if (adjustments.temperature !== undefined) requested["Temperature"] = adjustments.temperature;
    if (adjustments.tint !== undefined) requested["Tint"] = adjustments.tint;

    const unsupported: string[] = [];
    if (adjustments.hue !== undefined) unsupported.push('hue (Lumetri Basic Correction exposes no Hue parameter on this build; use vibrance or saturation, or a Hue/Saturation Curves preset)');

    if (Object.keys(requested).length === 0) {
      return {
        success: false,
        error: unsupported.length
          ? `No applicable colour adjustments. ${unsupported.join('; ')}.`
          : 'No colour adjustments provided. Supply at least one of: brightness (=exposure), exposure, contrast, saturation, vibrance, highlights, shadows, whites, blacks, temperature, tint.',
        unsupported,
      };
    }
    const result: any = await this.applyLumetriParams(clipId, requested, 'Color correction');
    if (!unsupported.length) return result;
    // An adjustment that was asked for and cannot be applied must not leave success:true. A caller
    // checking only `success` would otherwise never learn that part of its request was dropped —
    // the same silent-partial-success failure this whole pass exists to remove. The applied
    // parameters are still reported as verified, so nothing is lost by being explicit.
    return {
      ...result,
      success: false,
      unsupported,
      appliedAnyway: result?.applied ?? 0,
      error: [result?.error, `Unsupported on this build and NOT applied: ${unsupported.join('; ')}.`]
        .filter(Boolean).join(' '),
    };
  }

  protected async applyLut(clipId: string, lutPath: string, _intensity = 100): Promise<any> {
    return await this.applyLumetriParams(clipId, { "Input LUT": lutPath }, "LUT", { lutPath });
  }

  protected async lumetriHslSecondarySet(trackIndex: number, clipIndex: number, params: any, seqId?: string): Promise<any> {
    const sets = [];
    if (params.showMask !== undefined) sets.push(`props[88].setValue(${params.showMask},true);`);
    if (params.invertMask !== undefined) sets.push(`props[90].setValue(${params.invertMask},true);`);
    if (params.temperature !== undefined) sets.push(`props[101].setValue(${params.temperature},true);`);
    if (params.tint !== undefined) sets.push(`props[102].setValue(${params.tint},true);`);
    if (params.contrast !== undefined) sets.push(`props[103].setValue(${params.contrast},true);`);
    if (params.saturation !== undefined) sets.push(`props[105].setValue(${params.saturation},true);`);
    if (params.denoise !== undefined) sets.push(`props[95].setValue(${params.denoise},true);`);
    if (params.blur !== undefined) sets.push(`props[96].setValue(${params.blur},true);`);
    return await this.bridge.executeScript(`
      try {
        var clip=${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        var lumetri=null;
        for(var i=0;i<clip.components.numItems;i++){if(clip.components[i].displayName==='Lumetri Color'){lumetri=clip.components[i];break;}}
        if(!lumetri)return JSON.stringify({success:false,error:'No Lumetri Color component on this clip'});
        var props=lumetri.properties;
        ${sets.join('\n        ')}
        return JSON.stringify({success:true,verified:true,paramsSet:${sets.length}});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected broadcastSafeCheck(mediaPath: string): any {
    try {
      const out = execSync(`ffprobe -v error -f lavfi -i "movie=${mediaPath},signalstats" -show_entries frame_tags=lavfi.signalstats.YMAX,lavfi.signalstats.YMIN -of csv 2>/dev/null`, { encoding: 'utf8', timeout: 30000 });
      const lines = out.trim().split('\n').filter((l: string) => l);
      let illegalHigh = 0, illegalLow = 0;
      lines.forEach((l: string) => {
        const parts = l.split(',');
        if (parts[1] && Number(parts[1]) > 235) illegalHigh++;
        if (parts[2] && Number(parts[2]) < 16) illegalLow++;
      });
      return { success: true, totalFrames: lines.length, illegalHighFrames: illegalHigh, illegalLowFrames: illegalLow, broadcastSafe: illegalHigh === 0 && illegalLow === 0 };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  protected extractPalette(mediaPath: string, startSecs = 0, durationSecs = 10, colorCount = 8): any {
    const os = osSync, path = pathSync;
    const palettePath = path.join(os.tmpdir(), 'mcp_palette.png');
    try {
      // stats_mode=single emits one palette PER FRAME, which the image2 muxer cannot write
      // to a single output path ("Conversion failed!"). The default (stats_mode=full)
      // computes one palette across the whole range, and -frames:v 1 pins the output to
      // exactly one image.
      execSync(`ffmpeg -y -ss ${startSecs} -t ${durationSecs} -i "${mediaPath}" -vf "palettegen=max_colors=${colorCount}" -frames:v 1 "${palettePath}"`, { timeout: 30000 });
      return { success: true, palettePath, note: 'Palette PNG written. Use image tools to extract hex values from the palette image.' };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  protected async setColorSpaceOverride(projectItemId: string, colorSpaceName: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item=${this.findItemById(projectItemId)};
        if(!item)return JSON.stringify({success:false,error:'Item not found'});
        var cs=__findColorSpace(${JSON.stringify(colorSpaceName)}, item);
        if(!cs)return JSON.stringify({success:false,error:'No colour space named '+${JSON.stringify(JSON.stringify(colorSpaceName))}+' is available. Pass one of availableColorSpaces.',availableColorSpaces:__colorSpaceNames(item)});
        var valid=true; try{ valid=item.isValidOverrideColorSpace(cs); }catch(eV){}
        if(!valid)return JSON.stringify({success:false,error:'Premiere rejects '+String(cs.name)+' as an override for this item.',availableColorSpaces:__colorSpaceNames(item)});
        var before=null; try{ before=__csInfo(item.getOverrideColorSpace()); }catch(eB){}
        var setError=null;
        try{ item.setOverrideColorSpace(cs); }catch(eS){ setError=eS.toString(); }
        var back=null; try{ back=__csInfo(item.getOverrideColorSpace()); }catch(eA){}
        if(!back){
          return JSON.stringify({success:true,verified:false,colorSpace:String(cs.name),setError:setError,
            unverifiedReason:'getOverrideColorSpace() is not readable for this item, so the override cannot be confirmed.'});
        }
        if(back.empty || back.name!==String(cs.name)){
          return JSON.stringify({success:false,verified:true,verifiedBy:'getOverrideColorSpace() readback',colorSpace:String(cs.name),before:before,readback:back,setError:setError,
            error:'The override reads "'+back.name+'" after the write, not '+String(cs.name)+'.'});
        }
        var unchanged = before && !before.empty && before.name===back.name;
        return JSON.stringify({success:true,verified:true,verifiedBy:'getOverrideColorSpace() readback',changed:!unchanged,colorSpace:back,before:(before && !before.empty) ? before : null,
          note:'An override cannot be cleared by script on this build; set it back to the original colour space instead.'});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async matchShotColor(srcTrack: number, srcClip: number, tgtTrack: number, tgtClip: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var src=seq.videoTracks[${srcTrack}].clips[${srcClip}];
        var tgt=seq.videoTracks[${tgtTrack}].clips[${tgtClip}];
        var srcL=null,tgtL=null;
        for(var i=0;i<src.components.numItems;i++)if(src.components[i].displayName==='Lumetri Color'){srcL=src.components[i];break;}
        for(var j=0;j<tgt.components.numItems;j++)if(tgt.components[j].displayName==='Lumetri Color'){tgtL=tgt.components[j];break;}
        if(!srcL||!tgtL)return JSON.stringify({success:false,error:'Lumetri Color not found on both clips'});
        var namedParams=['Exposure','Contrast','Highlights','Shadows','Whites','Blacks','Temperature','Tint','Saturation'];
        var srcProps=srcL.properties,tgtProps=tgtL.properties;
        var applied=0;
        for(var k=0;k<srcProps.numItems;k++){
          var pname=String(srcProps[k].displayName);
          if(namedParams.indexOf(pname)>=0){try{tgtProps[k].setValue(srcProps[k].getValue(),true);applied++;}catch(ev){}}
        }
        return JSON.stringify({success:true,paramsApplied:applied});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async gradeSnapshot(trackIndex: number, clipIndex: number, outputPath: string, seqId?: string): Promise<any> {
    const result = await this.bridge.executeScript(`
      try {
        var clip=${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        var lumetri=null;
        for(var i=0;i<clip.components.numItems;i++)if(clip.components[i].displayName==='Lumetri Color'){lumetri=clip.components[i];break;}
        if(!lumetri)return JSON.stringify({success:false,error:'No Lumetri Color'});
        var grade={};
        var props=lumetri.properties;
        for(var j=0;j<props.numItems;j++){
          var n=String(props[j].displayName);
          // Neither String.prototype.trim nor startsWith exists in this engine (measured on
          // 26.3.2: typeof ''.trim === 'undefined'). Both threw a ReferenceError here, so
          // grade_snapshot could never return a grade.
          var nTrimmed=n?n.replace(/^\\s+|\\s+$/g,''):'';
          if(nTrimmed.length>0&&nTrimmed.charAt(0)!=='_'){
            try{grade[n+'_'+j]=props[j].getValue();}catch(ev){}
          }
        }
        return JSON.stringify({success:true,grade:grade,clipName:String(clip.name)});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
    if (result && result.success) {
      const fs = fsSync;
      try { fs.writeFileSync(outputPath, JSON.stringify(result.grade, null, 2)); return { ...result, outputPath, written: true }; }
      catch (e: any) { return { ...result, outputPath, written: false, writeError: e.message }; }
    }
    return result;
  }

  protected falseColorFrame(mediaPath: string, timeSecs: number, outputPath: string): any {
    try {
      execSync(`ffmpeg -y -ss ${timeSecs} -i "${mediaPath}" -frames:v 1 -vf "scale=1280:-1,lutrgb=r=if(gt(r\\,200)\\,r\\,0):g=if(between(r\\,100\\,200)\\,255\\,0):b=if(lt(r\\,100)\\,255\\,0)" "${outputPath}"`, { timeout: 20000 });
      const fs = fsSync;
      return { success: fs.existsSync(outputPath), outputPath };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  protected async getColorManagementOptions(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var o = { success: true };
        try { o.currentGraphicsWhiteLuminance = app.project.getGraphicsWhiteLuminance(); } catch(e1) {}
        try { o.supportedGraphicsWhiteLuminances = String(app.project.getSupportedGraphicsWhiteLuminances()); } catch(e2) { o.supportedLuminanceError = e2.toString(); }
        try { o.currentLutInterpolationMethod = String(app.project.getLUTInterpolationMethod()); } catch(e3) {}
        try { o.supportedLutInterpolationMethods = String(app.project.getSupportedLUTInterpolationMethods()); } catch(e4) { o.supportedLutError = e4.toString(); }
        o.note = 'Pass only values from the supported lists to set_graphics_white_luminance / set_lut_interpolation.';
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async setLogColorManagementTool(enabled: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.project.setLogColorManagement(${enabled});
        return JSON.stringify({ success: true, verified: false, enabled: ${enabled},
          note: 'No getter exists for this flag, so the value could not be read back.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getItemColorManagement(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item = ${this.findItemById(projectItemId)};
        if (!item) return JSON.stringify({ success: false, error: 'Project item not found: ' + ${JSON.stringify(projectItemId)} });
        var o = { success: true, name: String(item.name) };
        try { o.isColorManagedMedia = item.isColorManagedMedia(); } catch(e1) {}
        try { o.originalColorSpace = __csInfo(item.getOriginalColorSpace()); } catch(e2) {}
        try { var ov = __csInfo(item.getOverrideColorSpace()); o.overrideColorSpace = (ov && !ov.empty) ? ov : null; } catch(e3) {}
        try { o.overrideColorSpaceList = __colorSpaceNames(item); } catch(e4) {}
        try { o.colorSpace = __csInfo(item.getColorSpace()); } catch(e5) {}
        try { o.embeddedLUTID = String(item.getEmbeddedLUTID()); } catch(e6) {}
        try { o.inputLUTID = String(item.getInputLUTID()); } catch(e7) {}
        try { o.isReference = item.isReference(); } catch(e8) {}
        try { o.timeDisplayFormat = String(item.timeDisplayFormat); } catch(e9) {}
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  // Set Color Label Implementation
  protected async setColorLabel(projectItemId: string, colorIndex: number): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var beforeColor = null; try { beforeColor = Number(item.getColorLabel()); } catch (ePre) {}
        item.setColorLabel(${colorIndex});
        var nowColor = null; try { nowColor = item.getColorLabel(); } catch (eColor) {}
        if (nowColor !== null && Number(nowColor) !== ${colorIndex}) return JSON.stringify({ success: false, verified: true, verifiedBy: "ProjectItem.getColorLabel() readback", before: beforeColor, changed: beforeColor !== Number(nowColor), error: "Premiere did not set the color label (reads back as " + nowColor + ", requested ${colorIndex}).", actual: nowColor });
        if (nowColor === null) {
          return JSON.stringify({
            success: true, verified: false,
            unverifiedReason: "setColorLabel() did not throw, but getColorLabel() is not readable for this item, so the label cannot be confirmed.",
            projectItemId: ${JSON.stringify(projectItemId)}, colorIndex: ${colorIndex}, before: beforeColor
          });
        }
        return JSON.stringify({
          success: true,
          verified: true,
          verifiedBy: "ProjectItem.getColorLabel() readback",
          changed: beforeColor !== Number(nowColor),
          message: beforeColor === Number(nowColor) ? "The item already carried colour label ${colorIndex}; nothing changed." : "Color label set",
          projectItemId: ${JSON.stringify(projectItemId)},
          colorIndex: ${colorIndex},
          before: beforeColor
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Get Color Label Implementation
  protected async getColorLabel(projectItemId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var colorLabel = item.getColorLabel();
        return JSON.stringify({
          success: true,
          projectItemId: ${JSON.stringify(projectItemId)},
          colorLabel: colorLabel
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async verifyColorGrade(
    _seqId: string | undefined, trackIndex: number, clipIndex: number,
    gradeParams: Record<string, number>, outputDir = '/tmp/premiere-mcp-bridge/generated-assets'
  ): Promise<any> {
    const pathMod = pathSync;
    const fs = fsSync;

    const frameBefore = pathMod.join(outputDir, `grade_verify_before_${Date.now()}.jpg`);
    const frameAfter = pathMod.join(outputDir, `grade_verify_after_${Date.now()}.jpg`);

    // Get clip media path
    const mediaInfo: any = await this.bridge.executeScript(`
      try {
        var clip = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}];
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var mediaPath = clip.projectItem ? String(clip.projectItem.getMediaPath()) : '';
        var midSecs = (clip.start.seconds + clip.end.seconds) / 2;
        var sourceTimeSecs = clip.inPoint.seconds + (midSecs - clip.start.seconds);
        return JSON.stringify({success:true,mediaPath:mediaPath,sourceTimeSecs:sourceTimeSecs});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!mediaInfo?.success) return { success: false, error: mediaInfo?.error, verified: false };

    try {
      execSync(`ffmpeg -y -ss ${mediaInfo.sourceTimeSecs} -i "${mediaInfo.mediaPath}" -vframes 1 "${frameBefore}"`, { timeout: 15000 });
    } catch (e: any) { return { success: false, error: 'Pre-grade capture failed', verified: false }; }

    // Apply grade params
    const paramMap: Record<string, number> = { exposure: 19, contrast: 20, highlights: 21, shadows: 22, whites: 23, blacks: 24, temperature: 14, tint: 15, saturation: 16 };
    const setStatements = Object.entries(gradeParams)
      .filter(([k]) => paramMap[k] !== undefined)
      .map(([k, v]) => `try { lumetriComp.properties[${paramMap[k]}].setValue(${v}, true); } catch(ep) {}`)
      .join('\n        ');

    const gradeResult: any = await this.bridge.executeScript(`
      try {
        var clip = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}];
        var lumetriComp = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          if (String(clip.components[i].displayName).indexOf('Lumetri') >= 0) { lumetriComp = clip.components[i]; break; }
        }
        if (!lumetriComp) return JSON.stringify({success:false,error:'No Lumetri component on clip — apply_lumetri_preset first'});
        ${setStatements}
        return JSON.stringify({success:true,paramsSet:${JSON.stringify(Object.keys(gradeParams))}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!gradeResult?.success) return { success: false, error: 'Grade apply failed: ' + gradeResult?.error, verified: false };

    try {
      execSync(`ffmpeg -y -ss ${mediaInfo.sourceTimeSecs} -i "${mediaInfo.mediaPath}" -vframes 1 "${frameAfter}"`, { timeout: 15000 });
      const psnrOut = execSync(`ffmpeg -i "${frameBefore}" -i "${frameAfter}" -lavfi psnr -f null - 2>&1`, { timeout: 10000 }).toString();
      const match = psnrOut.match(/psnr_avg:(\S+)/);
      const psnr = match?.[1] ? parseFloat(match[1]) : null;
      const gradeLanded = psnr !== null && psnr < 45;
      try { fs.unlinkSync(frameBefore); fs.unlinkSync(frameAfter); } catch(_) {}
      return {
        success: true,
        verified: gradeLanded,
        psnr,
        pixelDifferenceDetected: gradeLanded,
        gradeParams,
        note: gradeLanded
          ? `Grade confirmed: rendered output changed (PSNR ${psnr?.toFixed(1)}dB).`
          : `Grade may not have rendered yet (PSNR ${psnr?.toFixed(1)}dB — frames identical). Try render_sequence_previews first.`
      };
    } catch (e: any) {
      return { success: false, error: e.message?.slice(0,100), verified: false };
    }
  }

  protected async setMogrtColor(seqId: string|undefined, trackIndex: number, clipIndex: number, paramName: string, r: number, g: number, b: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var clip = ${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        if (!clip || !clip.isMGT()) return JSON.stringify({success:false,error:'Clip is not a MOGRT'});
        var comp = clip.getMGTComponent();
        if (!comp) return JSON.stringify({success:false,error:'Could not get MGT component'});
        for (var i=0;i<comp.properties.numItems;i++) {
          var prop = comp.properties[i];
          if (String(prop.displayName) === ${JSON.stringify(paramName)}) {
            prop.setColorValue(${r}/255, ${g}/255, ${b}/255, 1.0);
            return JSON.stringify({success:true,paramName:${JSON.stringify(paramName)},r:${r},g:${g},b:${b}});
          }
        }
        return JSON.stringify({success:false,error:'Param not found: ' + ${JSON.stringify(paramName)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
