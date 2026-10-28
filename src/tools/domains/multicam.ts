/**
 * MulticamTools -- the Multicam tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { MotionLayoutTools } from './motion-layout.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class MulticamTools extends MotionLayoutTools {
  /**
   * Build a cut multicam edit: a new sequence whose V1 is a run of multicam clips, each showing
   * the requested angle — i.e. a finished multicam cut that stays switchable in Premiere.
   *
   * ExtendScript can neither create a multicam source sequence nor switch angles on 26.5.2
   * (setSwitchSources throws on every argument). FCP7 XML can do both: a clipitem holding a
   * <multiclip> becomes a real multicam (isMulticamClip() true), and the <angle> carrying
   * <activevideoangle> is the one shown. Measured on 2026-10-27 with three solid-colour angles:
   * each cut rendered its own angle. Angles are synced at their media start (all in points 0).
   */
  protected async createMulticamCut(angleItemIds: string[], cuts: Array<{ startSecs: number; endSecs: number; angle: number }>, sequenceName: string): Promise<any> {
    if (!Array.isArray(angleItemIds) || angleItemIds.length < 2) return { success: false, error: 'angleItemIds needs at least two camera clips.' };
    if (!Array.isArray(cuts) || cuts.length === 0) return { success: false, error: 'cuts needs at least one {startSecs, endSecs, angle}.' };
    const info: any = await this.bridge.executeScript(`
      try {
        var ids = ${JSON.stringify(angleItemIds)}, out = [];
        for (var i = 0; i < ids.length; i++) {
          var it = __findProjectItem(ids[i]);
          if (!it) return JSON.stringify({success:false,error:'Angle item not found: ' + ids[i]});
          var p = ''; try { p = String(it.getMediaPath()); } catch (e) {}
          if (!p) return JSON.stringify({success:false,error:'"' + String(it.name) + '" has no media path; angles must be footage clips.'});
          var md = String(it.getProjectMetadata());
          function tag(n) { var m = new RegExp('<premierePrivateProjectMetaData:' + n + '>([^<]*)<').exec(md); return m ? m[1] : ''; }
          out.push({ name: String(it.name), path: p, duration: tag('Column\\.Intrinsic\\.MediaDuration'), fps: tag('Column\\.Intrinsic\\.MediaTimebase'), size: tag('Column\\.Intrinsic\\.VideoInfo') });
        }
        return JSON.stringify({ success: true, angles: out });
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
    if (!info || info.success === false) return info;
    const angles: any[] = info.angles;
    const fps = Math.round(parseFloat(String(angles[0].fps)) || 24);
    const sizeMatch = /(\d+)\s*x\s*(\d+)/.exec(String(angles[0].size));
    const width = sizeMatch ? Number(sizeMatch[1]) : 1920;
    const height = sizeMatch ? Number(sizeMatch[2]) : 1080;
    const tcFrames = (tc: string) => {
      const p = String(tc).split(/[:;]/).map(Number);
      const [h = NaN, m = NaN, sec = NaN, f = NaN] = p;
      return p.length === 4 && p.every((n) => Number.isFinite(n)) ? ((h * 60 + m) * 60 + sec) * fps + f : NaN;
    };
    const durations = angles.map((a) => tcFrames(a.duration));
    const mcLen = Math.min(...durations.filter((d) => Number.isFinite(d) && d > 0));
    if (!Number.isFinite(mcLen)) return { success: false, error: 'Could not read the media duration of the angle clips.' };
    const toF = (s: number) => Math.round(s * fps);
    for (const c of cuts) {
      if (!(c.angle >= 1 && c.angle <= angles.length)) return { success: false, error: `angle ${c.angle} is out of range 1..${angles.length}. Nothing was created.` };
      if (!(c.endSecs > c.startSecs) || c.startSecs < 0 || toF(c.endSecs) > mcLen) {
        return { success: false, error: `cut ${c.startSecs}s-${c.endSecs}s is empty or runs past the shortest angle (${(mcLen / fps).toFixed(3)}s). Nothing was created.` };
      }
    }
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
    const sc = `<samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
    const fileEl = (i: number, full: boolean) => full
      ? `<file id="mc-file-${i}"><name>${esc(angles[i]!.name)}</name><pathurl>file://localhost${esc(encodeURI(angles[i]!.path))}</pathurl>${rate}<duration>${durations[i]}</duration><media><video>${sc}</video></media></file>`
      : `<file id="mc-file-${i}"/>`;
    const multiclip = (active: number, first: boolean, n: number) => '<multiclip id="mc-cut-1"><name>' + esc(sequenceName) + ' multicam</name><collapsed>FALSE</collapsed><synctype>1</synctype>'
      + angles.map((a, i) => `<angle><name>${esc(a.name)}</name>${i + 1 === active ? '<activevideoangle>TRUE</activevideoangle><activeaudioangle>TRUE</activeaudioangle>' : ''}`
        + `<clip id="mc-angle-${i}-${n}"><name>${esc(a.name)}</name><duration>${mcLen}</duration>${rate}<in>0</in><out>${mcLen}</out><media><video><track>`
        + `<clipitem id="mc-angle-item-${i}-${n}"><name>${esc(a.name)}</name><duration>${mcLen}</duration>${rate}<start>0</start><end>${mcLen}</end><in>0</in><out>${mcLen}</out>${fileEl(i, first)}</clipitem>`
        + '</track></video></media></clip></angle>').join('')
      + '</multiclip>';
    const sorted = [...cuts].sort((a, b) => a.startSecs - b.startSecs);
    const items = sorted.map((c, n) => `<clipitem id="mc-cut-item-${n}"><name>${esc(sequenceName)} multicam</name><duration>${mcLen}</duration>${rate}`
      + `<start>${toF(c.startSecs)}</start><end>${toF(c.endSecs)}</end><in>${toF(c.startSecs)}</in><out>${toF(c.endSecs)}</out>${multiclip(c.angle, n === 0, n)}</clipitem>`).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="mc-cut-seq"><name>${esc(sequenceName)}</name><duration>${toF(sorted[sorted.length - 1]!.endSecs)}</duration>${rate}`
      + `<media><video><format>${sc}</format><track>${items}</track></video></media></sequence></xmeml>\n`;
    const dir = join(tmpdir(), 'premiere-mcp-multicam');
    mkdirSync(dir, { recursive: true });
    const xmlPath = join(dir, `multicam-cut-${Date.now()}.xml`);
    writeFileSync(xmlPath, xml);
    return await this.bridge.executeScript(`
      try {
        var before = {};
        for (var i = 0; i < app.project.sequences.numSequences; i++) before[String(app.project.sequences[i].sequenceID)] = true;
        var bin = app.project.rootItem.createBin(${JSON.stringify(sequenceName + ' multicam')});
        app.project.importFiles([${JSON.stringify(xmlPath)}], true, bin, false);
        var seq = null;
        for (var j = 0; j < app.project.sequences.numSequences; j++) {
          var s = app.project.sequences[j];
          if (!before[String(s.sequenceID)] && String(s.name) === ${JSON.stringify(sequenceName)}) { seq = s; break; }
        }
        if (!seq) return JSON.stringify({success:false,error:'The multicam XML imported but produced no sequence named ' + ${JSON.stringify(JSON.stringify(sequenceName))} + '.',xmlPath:${JSON.stringify(xmlPath)}});
        var want = ${JSON.stringify(sorted.map((c) => c.angle))}, got = [], bad = [];
        var tr = seq.videoTracks[0];
        for (var k = 0; k < tr.clips.numItems; k++) {
          var c = tr.clips[k], isMc = false;
          try { isMc = c.projectItem.isMulticamClip(); } catch (e) {}
          var m = /\\[(\\d+)\\]/.exec(String(c.name));
          var ang = m ? Number(m[1]) : null;
          got.push({ startSecs: c.start.seconds, endSecs: c.end.seconds, angle: ang, multicam: isMc });
          if (!isMc || ang !== want[k]) bad.push(k);
        }
        var ok = got.length === want.length && bad.length === 0;
        return JSON.stringify({success:ok,verified:true,verifiedBy:'each cut is a multicam clip whose name carries the requested [angle]',
          sequenceId:String(seq.sequenceID),sequenceName:String(seq.name),cuts:got,xmlPath:${JSON.stringify(xmlPath)},
          error: ok ? undefined : 'The sequence was built but ' + (got.length !== want.length ? got.length + ' of ' + want.length + ' cuts landed' : 'cuts ' + bad.join(', ') + ' show the wrong angle') + '.'});
      } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async enableMulticam(seqId: string|undefined, trackIndex: number, clipIndex: number, enabled: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(seqId)};
        var clip = __qeClipByIndex(seq, 'video', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var canDo = clip.canDoMulticam();
        // canDoMulticam() reads false on a clip that is ALREADY a multicam (measured on 26.5.2 with
        // a multicam imported from FCP XML: isMulticamClip true, multicamEnabled true, canDo false),
        // so it cannot gate a request that is already satisfied.
        var already = null; try { already = Boolean(clip.multicamEnabled); } catch(eAl) {}
        if (already === ${enabled}) return JSON.stringify({success:true,verified:true,verifiedBy:'qeClip.multicamEnabled readback',enabled:${enabled},canDoMulticam:canDo,before:already,after:already,changed:false,
          note:'The clip was already in this multicam state; nothing changed.'});
        if (!canDo && ${enabled}) return JSON.stringify({success:false,verified:true,error:'canDoMulticam() returned false for this clip, so multicam cannot be enabled on it. Only a clip whose source is a multicam source sequence can be switched to multicam.'});
        // multicamEnabled is one of the QE clip properties measured SAFE to read on 26.3.2.
        var before = null; try { before = Boolean(clip.multicamEnabled); } catch(eB) {}
        clip.setMulticam(${enabled});
        var after = null; try { after = Boolean(clip.multicamEnabled); } catch(eA) {}
        if (after === null) {
          return JSON.stringify({success:true,verified:false,enabled:${enabled},canDoMulticam:canDo,before:before,
            unverifiedReason:'setMulticam() did not throw, but qeClip.multicamEnabled is not readable on this build, so the flag cannot be confirmed.'});
        }
        if (after !== ${enabled}) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'qeClip.multicamEnabled readback',enabled:${enabled},canDoMulticam:canDo,before:before,after:after,changed:before!==after,
            error:'Multicam still reads ' + String(after) + ' after being set to ${enabled}.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'qeClip.multicamEnabled readback',enabled:${enabled},canDoMulticam:canDo,before:before,after:after,changed:before!==after,
          note: before === after ? 'The clip was already in this multicam state; nothing changed.' : undefined});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getMulticamAngleCount(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        var item = seq.projectItem;
        var isMulticam = item ? item.isMulticamClip() : false;
        return JSON.stringify({success:true,isMulticamSequence:isMulticam,videoTrackCount:seq.videoTracks.numTracks,audioTrackCount:seq.audioTracks.numTracks,sequenceName:String(seq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async flattenMulticam(seqId: string|undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(seqId)};
        var clip = __qeClipByIndex(seq, 'video', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        clip.setMulticam(false);
        return JSON.stringify({success:true,message:'Multicam disabled on clip. Clip now plays as single-stream at the active angle.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async multicamInfo(seqId: string|undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(seqId)};
        var qeClip = __qeClipByIndex(seq, 'video', ${trackIndex}, ${clipIndex});
        if (!qeClip) return JSON.stringify({success:false,error:'Clip not found'});
        var domClip = ${this.buildSeqRes(seqId)}.videoTracks[${trackIndex}].clips[${clipIndex}];
        return JSON.stringify({success:true,multicamEnabled:qeClip.multicamEnabled,canDoMulticam:qeClip.canDoMulticam(),isMulticamClip:domClip.projectItem.isMulticamClip(),name:String(domClip.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setMulticamAngle(seqId: string|undefined, trackIndex: number, clipIndex: number, angleIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(seqId)};
        var clip = __qeClipByIndex(seq, 'video', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        try { clip.setSwitchSources(${angleIndex}); } catch(eSw) {
          // Measured on 26.5.2 against a real multicam clip: every argument shape tried (0, 1,
          // true, two args) throws "Unknown error exception", and reading switchSources throws the
          // same. Report it as the platform limit it is rather than a bare host error.
          return JSON.stringify({success:false,error:'Premiere refused the angle switch (qeClip.setSwitchSources: ' + eSw.toString() + '). On 26.5.2 an existing multicam clip cannot be switched from script; build the cut with create_multicam_cut instead (a new sequence of multicam clips, each on the angle you choose), or switch in the Program Monitor.',angleIndex:${angleIndex}});
        }
        return JSON.stringify({success:true,verified:false,angleIndex:${angleIndex},
          unverifiedReason:'setSwitchSources() returned, but the active angle has no readback.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  /**
   * The bin lookup scanned rootItem.children one level deep and never checked that the match
   * was a bin, so a nested bin was unreachable and a CLIP named "Angles" would win the match
   * and then report "Bin is empty". Uses the shared __resolveBin prelude helper. Sub-bins are
   * also skipped when collecting angles -- they were previously pushed in as camera angles.
   */
  protected async createMulticamSourceSequence(binName: string, newSeqName: string, presetPath?: string, binId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var req = __resolveBin(${JSON.stringify(binId??null)}, ${JSON.stringify(binName)});
        if (req.error) return JSON.stringify({success:false,error:req.error+' No sequence was created.',binName:${JSON.stringify(binName)},binId:${JSON.stringify(binId??null)},matchCount:req.matchCount});
        var bin = req.bin;
        var clips = [];
        for (var j = 0; j < bin.children.numItems; j++) { if (!__isBin(bin.children[j])) clips.push(bin.children[j]); }
        if (clips.length === 0) return JSON.stringify({success:false,error:'Bin "'+String(bin.name)+'" ('+String(bin.treePath)+') holds no clips, so there are no camera angles to build from. No sequence was created.',binId:String(bin.nodeId)});
        var seq = app.project.createNewSequenceFromClips(${JSON.stringify(newSeqName)}, clips, ${JSON.stringify(presetPath ?? '')});
        if (!seq) return JSON.stringify({success:false,error:'Could not create sequence'});
        return JSON.stringify({success:true,sequenceId:String(seq.sequenceID),name:String(seq.name),clipCount:clips.length,
          binId:String(bin.nodeId),binName:String(bin.name),binResolvedBy:req.resolvedBy});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async createMulticamFromClips(projectItemIds: string[], seqName: string, presetPath?: string): Promise<any> {
    const idsJson = JSON.stringify(projectItemIds);
    return await this.bridge.executeScript(`
      try {
        var ids = ${idsJson};
        var items = [];
        for (var i = 0; i < ids.length; i++) {
          var item = __findProjectItem(ids[i]);
          if (item) items.push(item);
        }
        if (items.length === 0) return JSON.stringify({success:false,error:'No project items found'});
        var seq = app.project.createNewSequenceFromClips(${JSON.stringify(seqName)}, items, ${JSON.stringify(presetPath ?? '')});
        if (!seq) return JSON.stringify({success:false,error:'Could not create sequence'});
        return JSON.stringify({success:true,sequenceId:String(seq.sequenceID),name:String(seq.name),angleCount:items.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
