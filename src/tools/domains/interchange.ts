/**
 * InterchangeTools -- the Interchange & Conform tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { ColorTools } from './color.js';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';

export class InterchangeTools extends ColorTools {
  protected async vfxPullList(sequenceId: string | undefined, handles: number, trackIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var track = seq.videoTracks[${trackIndex}];
        if (!track) return JSON.stringify({success:false,error:'Track not found'});
        var ticksPerFrame = Number(seq.timebase) || 10584000000;
        var handleTicks = ${handles} * ticksPerFrame;
        var pulls = [];
        for (var ci=0;ci<track.clips.numItems;ci++) {
          var clip = track.clips[ci];
          var srcPath = ''; try { srcPath = String(clip.projectItem.getMediaPath()); } catch(e){}
          pulls.push({
            index: ci,
            shotName: String(clip.name),
            sourcePath: srcPath,
            srcInTicks: String(Math.max(0, Number(clip.inPoint.ticks) - handleTicks)),
            srcOutTicks: String(Number(clip.outPoint.ticks) + handleTicks),
            srcInSecs: Math.max(0, clip.inPoint.seconds - ${handles}/24),
            srcOutSecs: clip.outPoint.seconds + ${handles}/24,
            seqInTicks: String(clip.start.ticks),
            seqOutTicks: String(clip.end.ticks),
            seqInSecs: clip.start.seconds,
            seqOutSecs: clip.end.seconds,
            durationSecs: clip.duration ? clip.duration.seconds : 0,
            handles: ${handles}
          });
        }
        return JSON.stringify({success:true,pulls:pulls,count:pulls.length,sequenceName:String(seq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async cutListCsv(outputPath: string, sequenceId: string | undefined, trackIndex: number): Promise<any> {
    const pullsResult = await this.vfxPullList(sequenceId, 0, trackIndex);
    if (!pullsResult.success) return pullsResult;
    const fs = fsSync;
    const header = 'index,shot_name,source_path,src_in_secs,src_out_secs,seq_in_secs,seq_out_secs,duration_secs';
    const rows = pullsResult.pulls.map((p: any) => `${p.index},${JSON.stringify(p.shotName)},${JSON.stringify(p.sourcePath)},${p.srcInSecs.toFixed(3)},${p.srcOutSecs.toFixed(3)},${p.seqInSecs.toFixed(3)},${p.seqOutSecs.toFixed(3)},${p.durationSecs.toFixed(3)}`);
    fs.writeFileSync(outputPath, [header, ...rows].join('\n'));
    return { success: true, outputPath, shotCount: pullsResult.count, verified: fs.existsSync(outputPath) };
  }

  protected async changeListReport(sequenceIdA: string, sequenceIdB: string): Promise<any> {
    // Reuse diff_sequences tool logic
    return await this.bridge.executeScript(`
      try {
        var seqs = app.project.sequences;
        var seqA = null; var seqB = null;
        for (var i=0;i<seqs.numSequences;i++) {
          if (seqs[i].sequenceID === ${JSON.stringify(sequenceIdA)}) seqA = seqs[i];
          if (seqs[i].sequenceID === ${JSON.stringify(sequenceIdB)}) seqB = seqs[i];
        }
        if (!seqA) return JSON.stringify({success:false,error:'Sequence A not found'});
        if (!seqB) return JSON.stringify({success:false,error:'Sequence B not found'});
        function getClips(seq) {
          var clips = [];
          for (var ti=0;ti<seq.videoTracks.numTracks;ti++) {
            var track = seq.videoTracks[ti];
            for (var ci=0;ci<track.clips.numItems;ci++) {
              var clip = track.clips[ci];
              clips.push({name:String(clip.name),startSecs:clip.start.seconds,endSecs:clip.end.seconds,track:ti});
            }
          }
          return clips;
        }
        var clipsA = getClips(seqA); var clipsB = getClips(seqB);
        var report = {sequenceA:String(seqA.name),sequenceB:String(seqB.name),clipCountA:clipsA.length,clipCountB:clipsB.length,deltaClips:clipsB.length-clipsA.length,changes:[]};
        // Find added/removed by name comparison
        var namesA = clipsA.map(function(c){return c.name;}); var namesB = clipsB.map(function(c){return c.name;});
        for (var i=0;i<namesB.length;i++) { if (namesA.indexOf(namesB[i]) < 0) report.changes.push({type:'added',name:namesB[i]}); }
        for (var i=0;i<namesA.length;i++) { if (namesB.indexOf(namesA[i]) < 0) report.changes.push({type:'removed',name:namesA[i]}); }
        return JSON.stringify({success:true,report:report});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async syncLockTrack(sequenceId: string | undefined, trackType: 'video' | 'audio', trackIndex: number, locked: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        var track = ${trackType === 'audio' ? `seq.getAudioTrackAt(${trackIndex})` : `seq.getVideoTrackAt(${trackIndex})`};
        if (!track) return JSON.stringify({success:false,error:'Track not found'});
        var before = null; try { before = Boolean(track.isSyncLocked()); } catch(eB) {}
        track.setSyncLock(${locked});
        var after = null; try { after = Boolean(track.isSyncLocked()); } catch(eA) {}
        if (after === null) {
          return JSON.stringify({success:true,verified:false,trackType:${JSON.stringify(trackType)},trackIndex:${trackIndex},locked:${locked},before:before,
            unverifiedReason:'setSyncLock() did not throw, but isSyncLocked() is not readable on this build, so the sync-lock state cannot be confirmed.'});
        }
        if (after !== ${locked}) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'qeTrack.isSyncLocked() readback',changed:before!==after,trackType:${JSON.stringify(trackType)},trackIndex:${trackIndex},locked:${locked},before:before,readback:after,
            error:'Sync lock on ${trackType} track ${trackIndex} still reads ' + String(after) + ' after being set to ${locked}.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'qeTrack.isSyncLocked() readback',changed:before!==after,trackType:${JSON.stringify(trackType)},trackIndex:${trackIndex},locked:${locked},before:before,readback:after,
          note: before === after ? 'That track was already in this sync-lock state; nothing changed.' : undefined});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getProductionList(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var isLoggedIn = qe.ea.isLoggedIn();
        var userEmail = String(qe.ea.getUserEmail());
        var list = qe.ea.getProductionList();
        var prods = [];
        if (list) { for (var i=0;i<list.length;i++) prods.push(String(list[i])); }
        return JSON.stringify({success:true,isLoggedIn:isLoggedIn,userEmail:userEmail,productions:prods,count:prods.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // Batch E: Project lifecycle
  protected async openFcpXml(filePath: string, sequenceName?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.openFCPXML(${JSON.stringify(filePath)}, ${JSON.stringify(sequenceName ?? '')});
        return JSON.stringify({success:true,filePath:${JSON.stringify(filePath)},sequenceName:${JSON.stringify(sequenceName??'')}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  /**
   * Import a Final Cut Pro 7 XML (XMEML) file.
   *
   * Premiere 26 accepts FCP7 XML through importFiles. The second argument asks
   * Premiere to suppress warning UI. Do not use app.openFCPXML here: it rejects
   * the documented-looking two-argument form in the supported host runtime.
   */
  protected async importFcpXml(filePath: string): Promise<any> {
    try {
      // No hand-escaping here. JSON.stringify below already produces a correctly
      // quoted literal; escaping first and then serialising doubled every backslash,
      // so C:\\Users\\bob\\seq.xml reached the host as C:\\\\Users\\\\bob\\\\seq.xml and every
      // Windows path failed. Introduced by the interpolation sweep, which wrapped a
      // site that was already escaped.
      const script = `
        try {
          var f = new File(${JSON.stringify(filePath)});
          if (!f.exists) {
            return JSON.stringify({ success: false, error: "File not found: " + ${JSON.stringify(filePath)} });
          }
          // suppressUI=true asks Premiere not to surface import warning dialogs.
          var imported = app.project.importFiles([${JSON.stringify(filePath)}], true, app.project.rootItem, false);
          if (!imported) {
            return JSON.stringify({ success: false, imported: false, path: ${JSON.stringify(filePath)}, method: "importFiles(suppressUI=true)", error: "Premiere rejected the FCP7 XML import" });
          }
          return JSON.stringify({ success: true, imported: true, path: ${JSON.stringify(filePath)}, method: "importFiles(suppressUI=true)" });
        } catch (e) {
          return JSON.stringify({ success: false, error: e.toString() });
        }
      `;
      const result: any = await this.bridge.executeScript(script);
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      return {
        ...parsed,
        message: parsed.success
          ? `FCP XML imported successfully via ${parsed.method} — Premiere created new sequence atomically`
          : `Failed to import FCP XML — ${parsed.error || 'Premiere rejected the import'}`,
        filePath
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to import FCP XML: ${error instanceof Error ? error.message : String(error)}`,
        filePath
      };
    }
  }

  /**
   * Import a CMX 3600 EDL file via app.importEDL.
   * Premiere prompts for sequence settings + source media in interactive mode.
   * The resulting sequence's timebase/video standard comes from the project defaults
   * or the interactive dialog — app.importEDL has no video-standard argument.
   */
  protected async importEdl(filePath: string): Promise<any> {
    return {
      success: false,
      blockedBeforePremiere: true,
      filePath,
      error: 'CMX 3600 EDL import is disabled because Premiere only exposes it through an interactive dialog that blocks CEP. Convert the EDL to FCP7 XML and use import_fcp_xml for unattended import.'
    };
  }

  protected async exportEdl(outputPath: string, seqId?: string): Promise<any> {
    const xmlPath = outputPath.replace(/\.edl$/i, '_tmp.xml');
    const result = await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        seq.exportAsFinalCutProXML(${JSON.stringify(xmlPath)}, true);
        var f=new File(${JSON.stringify(xmlPath)});
        return JSON.stringify({success:f.exists,xmlPath:${JSON.stringify(xmlPath)},seqName:String(seq.name)});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
    if (!result || !result.success) return result;
    try {
      const fs = fsSync;
      const xml = fs.readFileSync(xmlPath, 'utf8');
      // Simple XMEML to EDL conversion
      const seqName = result.seqName || 'SEQUENCE';
      const clips: string[] = [];
      let clipNum = 1;
      const itemRegex = /<clipitem[^>]*>([\s\S]*?)<\/clipitem>/g;
      let m;
      while ((m = itemRegex.exec(xml)) !== null) {
        const block = m[1] ?? '';
        const srcIn = block.match(/<in>(\d+)<\/in>/)?.[1];
        const srcOut = block.match(/<out>(\d+)<\/out>/)?.[1];
        const seqIn = block.match(/<start>(\d+)<\/start>/)?.[1];
        const seqOut = block.match(/<end>(\d+)<\/end>/)?.[1];
        if (srcIn && srcOut && seqIn && seqOut) {
          const toTC = (f: string) => { const fr = parseInt(f); const h = Math.floor(fr/86400), rest = fr%86400, mi = Math.floor(rest/1440), s = Math.floor((rest%1440)/24), ff = (rest%1440)%24; return `${h.toString().padStart(2,'0')}:${mi.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}:${ff.toString().padStart(2,'0')}`; };
          clips.push(`${clipNum.toString().padStart(3,'0')}  001      V     C        ${toTC(srcIn)} ${toTC(srcOut)} ${toTC(seqIn)} ${toTC(seqOut)}`);
          clipNum++;
        }
      }
      const edl = `TITLE: ${seqName}\nFCM: NON-DROP FRAME\n\n${clips.join('\n')}\n`;
      fs.writeFileSync(outputPath, edl);
      try { fs.unlinkSync(xmlPath); } catch {}
      return { success: true, outputPath, clipCount: clips.length };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  protected async getProductionInfo(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        if (typeof qe.ea === 'undefined' || !qe.ea) {
          return JSON.stringify({ success: false, error: 'qe.ea is unavailable on this build' });
        }
        var o = { success: true };
        try { o.isLoggedIn = qe.ea.isLoggedIn(); } catch(x) { o.loginError = String(x); }
        try { o.userEmail = String(qe.ea.getUserEmail()); } catch(x) {}
        try { o.username = String(qe.ea.getUsername()); } catch(x) {}
        try { o.isAdministrator = qe.ea.isAdministrator; } catch(x) {}
        try { o.isCollaborationOnly = qe.ea.isCollaborationOnly(); } catch(x) {}
        try { o.isHostedCollaborationOnly = qe.ea.isHostedCollaborationOnly(); } catch(x) {}
        try { o.canShare = qe.ea.canShare(); } catch(x) {}
        try { o.isShareCommandEnabled = qe.ea.isShareCommandEnabled(); } catch(x) {}
        try { o.isSyncCommandEnabled = qe.ea.isSyncCommandEnabled(); } catch(x) {}
        try { o.hasUnsharedChanges = qe.ea.doesProjectHaveUnsharedChanges(); } catch(x) {}
        try { o.hasLocalMedia = qe.ea.doesEditingSessionHaveLocalMedia(); } catch(x) {}
        try { o.sessionSyncStatus = String(qe.ea.getSessionSyncStatus()); } catch(x) {}
        try { o.productionList = String(qe.ea.getProductionList()); } catch(x) {}
        try { o.archivedProductionList = String(qe.ea.getArchivedProductionList()); } catch(x) {}
        try { o.inviteList = String(qe.ea.getInviteList()); } catch(x) {}
        try { o.creativeCloudIdentity = String(qe.ea.getCreativeCloudIdentity()); } catch(x) {}
        try { o.remoteServerBuildVersion = String(qe.ea.getRemoteServerBuildVersion()); } catch(x) {}
        try { o.convertToProductionRunning = qe.ea.isConvertProjectIntoProductionRunning(); } catch(x) {}
        try { o.convertToProjectRunning = qe.ea.isConvertProductionIntoProjectRunning(); } catch(x) {}
        o.note = 'Read-only. No cloud state was modified.';
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async openFcpXmlProject(xmlPath: string, sequenceName = ''): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.openFCPXML(${JSON.stringify(xmlPath)},${JSON.stringify(sequenceName)});
        return JSON.stringify({success:true,xmlPath:${JSON.stringify(xmlPath)},note:'FCP XML opened. New sequences should appear in the project.'});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  // Export as FCP XML Implementation
  protected async exportAsFcpXml(sequenceId: string, outputPath: string): Promise<any> {
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        seq.exportAsFinalCutProXML(${JSON.stringify(outputPath)});
        var xmlFile = new File(${JSON.stringify(outputPath)});
        if (!xmlFile.exists) return JSON.stringify({ success: false, verified: false, error: "exportAsFinalCutProXML() ran but no file exists at " + ${JSON.stringify(outputPath)} + ".", outputPath: ${JSON.stringify(outputPath)} });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Exported as Final Cut Pro XML",
          sequenceId: ${JSON.stringify(sequenceId)},
          outputPath: ${JSON.stringify(outputPath)},
          fileSize: xmlFile.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Export AAF Implementation
  protected async exportAaf(sequenceId: string, outputPath: string, mixDownVideo?: boolean, explodeToMono?: boolean, sampleRate?: number, bitsPerSample?: number): Promise<any> {
    // Off unless asked for. A video mixdown renders the whole sequence before the AAF is written:
    // on a 40s fixture with one MOGRT it held the ExtendScript engine for over five minutes
    // (2026-10-27), which every later call experiences as a dead host.
    const mixDown = mixDownVideo === true ? 1 : 0;
    const explode = explodeToMono ? 1 : 0;
    const rate = sampleRate || 48000;
    const bits = bitsPerSample || 16;
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        app.project.exportAAF(seq, ${JSON.stringify(outputPath)}, ${mixDown}, ${explode}, ${rate}, ${bits}, 0, 0, 1, 0);
        var aafFile = new File(${JSON.stringify(outputPath)});
        if (!aafFile.exists) return JSON.stringify({ success: false, verified: false, error: "exportAAF() ran but no file exists at " + ${JSON.stringify(outputPath)} + ".", outputPath: ${JSON.stringify(outputPath)} });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Exported as AAF",
          sequenceId: ${JSON.stringify(sequenceId)},
          outputPath: ${JSON.stringify(outputPath)},
          fileSize: aafFile.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Import Sequences From Project Implementation
  protected async importSequencesFromProject(projectPath: string, sequenceIds: string[]): Promise<any> {
    const script = `
      try {
        var seqIds = ${JSON.stringify(sequenceIds)};
        app.project.importSequences(${JSON.stringify(projectPath)}, seqIds);
        return JSON.stringify({
          success: true,
          message: "Sequences imported from project",
          projectPath: ${JSON.stringify(projectPath)},
          sequenceIds: seqIds
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async sendToAfterEffects(outputPath: string, sequenceId?: string): Promise<any> {
    // Export sequence as .prproj — AE can open Premiere projects and access sequences
    const script = `
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        var result = seq.exportAsProject(${JSON.stringify(outputPath)});
        var f = new File(${JSON.stringify(outputPath)});
        return JSON.stringify({success:true,verified:f.exists,outputPath:${JSON.stringify(outputPath)},sequenceName:String(seq.name),note:'Open this .prproj in After Effects. AE can read Premiere sequences for Dynamic Link.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async convertProjectToProduction(productionPath: string, description?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var loggedIn = qe.ea.isLoggedIn();
        if (!loggedIn) return JSON.stringify({success:false,error:'Not logged in to Creative Cloud. qe.ea.isLoggedIn() returned false.'});
        var projPath = String(app.project.path);
        qe.ea.convertProjectIntoProduction(projPath, ${JSON.stringify(productionPath)}, true, ${JSON.stringify(description ?? '')}, false);
        return JSON.stringify({success:true,verified:false,note:'convertProjectIntoProduction dispatched. Check get_production_list for confirmation.',productionPath:${JSON.stringify(productionPath)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async shareProduction(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        if (!qe.ea.isLoggedIn()) return JSON.stringify({success:false,error:'Not logged in to Creative Cloud'});
        qe.ea.share();
        return JSON.stringify({success:true,verified:false,note:'share() dispatched. Check production sync status for confirmation.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async syncProduction(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        if (!qe.ea.isLoggedIn()) return JSON.stringify({success:false,error:'Not logged in to Creative Cloud'});
        qe.ea.sync();
        return JSON.stringify({success:true,verified:false,note:'sync() dispatched.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async productionSyncStatus(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var loggedIn = qe.ea.isLoggedIn();
        var syncStatus = loggedIn ? String(qe.ea.getSessionSyncStatus()) : 'not logged in';
        var hasUnshared = loggedIn ? qe.ea.doesProjectHaveUnsharedChanges() : false;
        var email = loggedIn ? String(qe.ea.getUserEmail()) : '';
        return JSON.stringify({success:true,loggedIn:loggedIn,syncStatus:syncStatus,hasUnsharedChanges:hasUnshared,userEmail:email});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
