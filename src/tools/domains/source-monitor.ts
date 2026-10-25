/**
 * SourceMonitorTools -- the Source Monitor & Logging tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { ReviewDeliveryTools } from './review-delivery.js';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import { runFf } from '../ff-exec.js';

export class SourceMonitorTools extends ReviewDeliveryTools {
  protected async openProjectItemInSource(projectItemId: string, timecode?: string): Promise<any> {
    const script = `
      try {
        var item = null;
        var root = app.project.rootItem;
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){ var c=bin.children[i]; if(c.nodeId===id){return c;} if(c.type===2){var r=findById(c,id);if(r)return r;} } return null; }
        item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: 'Project item not found: ' + ${JSON.stringify(projectItemId)} });
        app.sourceMonitor.openProjectItem(item);
        ${timecode ? `
        // Cue to timecode if provided
        try {
          app.enableQE();
          qe.source.clip.setInPoint(${JSON.stringify(timecode)});
        } catch(eCue) {}` : ''}
        var loaded = app.sourceMonitor.getProjectItem();
        var verified = loaded && loaded.nodeId === ${JSON.stringify(projectItemId)};
        return JSON.stringify({ success: true, verified: verified, projectItemId: ${JSON.stringify(projectItemId)}, itemName: loaded ? String(loaded.name) : null, timecode: ${JSON.stringify(timecode ?? null)} });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async logClip(projectItemId: string, inPoint?: string, outPoint?: string, name?: string, labelColor?: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item=${this.findItemById(projectItemId)};
        if(!item)return JSON.stringify({success:false,error:'Item not found'});
        app.sourceMonitor.openProjectItem(item);
        ${inPoint ? `try{app.enableQE();qe.source.clip.setInPoint(${JSON.stringify(inPoint)});}catch(ei){}` : ''}
        ${outPoint ? `try{app.enableQE();qe.source.clip.setOutPoint(${JSON.stringify(outPoint)});}catch(eo){}` : ''}
        ${name ? `try{item.name=${JSON.stringify(name)};}catch(en){}` : ''}
        ${labelColor !== undefined ? `try{item.setColorLabel(${labelColor});}catch(el){}` : ''}
        return JSON.stringify({success:true,itemName:String(item.name),inPoint:${JSON.stringify(inPoint??null)},outPoint:${JSON.stringify(outPoint??null)}});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async createSubclipsFromMarkers(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item=${this.findItemById(projectItemId)};
        if(!item)return JSON.stringify({success:false,error:'Item not found'});
        var markers=item.getMarkers();
        if(!markers||markers.numMarkers===0)return JSON.stringify({success:true,created:0,note:'No markers on item'});
        var created=[];
        var m=markers.getFirstMarker();
        while(m){
          try{
            var st=new Time();st.ticks=String(m.start.ticks);
            var et=new Time();et.ticks=m.end?String(m.end.ticks):String(Number(m.start.ticks)+254016000000);
            var sub=item.createSubClip(String(m.name)||'subclip_'+created.length,st,et,false,true,true);
            if(sub)created.push(String(sub.name));
          }catch(ec){}
          m=markers.getNextMarker(m);
        }
        return JSON.stringify({success:true,created:created.length,subclipNames:created});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected hoverScrubFrames(mediaPath: string, count: number, outputDir: string): any {
    const fs = fsSync, path = pathSync;
    try {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      // Get duration first
      const dur = parseFloat(runFf('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mediaPath], { timeoutMs: 10000 }).trim());
      const paths: string[] = [];
      for (let i = 0; i < count; i++) {
        const t = (dur / (count + 1)) * (i + 1);
        const outPath = path.join(outputDir, `scrub_${i.toString().padStart(3,'0')}.jpg`);
        runFf('ffmpeg', ['-y', '-ss', t.toFixed(3), '-i', mediaPath, '-frames:v', '1', '-update', '1', '-q:v', '3', outPath], { timeoutMs: 10000 });
        if (fs.existsSync(outPath)) paths.push(outPath);
      }
      return { success: true, count: paths.length, paths };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  protected compareTakes(_itemId1: string, _itemId2: string, _outputDir: string): any {
    return { success: false, note: 'compareTakes requires media paths. Use get_project_item_info on each item first to get mediaPath, then call hover_scrub_frames on each.' };
  }

  protected async getSourceClipInfo(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var loaded=app.sourceMonitor.getProjectItem();
        if(!loaded)return JSON.stringify({success:true,loaded:false,note:'Nothing in source monitor'});
        var pos=app.sourceMonitor.getPosition();
        return JSON.stringify({success:true,loaded:true,name:String(loaded.name),path:loaded.getMediaPath?String(loaded.getMediaPath()):null,inPoint:{ticks:String(loaded.getInPoint?loaded.getInPoint().ticks:0)},outPoint:{ticks:String(loaded.getOutPoint?loaded.getOutPoint().ticks:0)},playerPosSecs:pos?pos.seconds:null});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async batchLogFromCsv(csvPath: string): Promise<any> {
    const fs = fsSync;
    try {
      const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter((l: string) => l.trim() && !l.startsWith('#'));
      const rows = lines.slice(1).map((l: string) => { const parts = l.split(','); return { name: parts[0]?.trim(), inTC: parts[1]?.trim(), outTC: parts[2]?.trim(), label: parseInt(parts[3]?.trim() || '0'), comment: parts[4]?.trim() }; });
      const rowsJson = JSON.stringify(rows);
      return await this.bridge.executeScript(`
        try {
          var rows=${rowsJson};
          var applied=0;
          function findByName(bin,name){for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(String(c.name)===name)return c;if(c.type===2){var r=findByName(c,name);if(r)return r;}}return null;}
          for(var i=0;i<rows.length;i++){
            var r=rows[i];if(!r.name)continue;
            var item=findByName(app.project.rootItem,r.name);if(!item)continue;
            if(r.inTC){try{var t=new Time();t.seconds=Number(r.inTC.replace(':','.'))||0;item.setInPoint(t,1);}catch(ei){}}
            if(r.outTC){try{var t2=new Time();t2.seconds=Number(r.outTC.replace(':','.'))||0;item.setOutPoint(t2,1);}catch(eo){}}
            if(r.label>0){try{item.setColorLabel(r.label);}catch(el){}}
            applied++;
          }
          return JSON.stringify({success:true,rowsProcessed:applied,totalRows:rows.length});
        }catch(e){return JSON.stringify({success:false,error:e.toString()});}
      `);
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  /**
   * The local findBin deep-walked but returned the FIRST name match, so with two bins of the
   * same name (one per scene, which is the normal shape of a show project) this assembled the
   * wrong bin onto the timeline and reported success. The shared __resolveBin prelude helper
   * refuses an ambiguous bare name instead of guessing, and also accepts a path or an id.
   */
  protected async storyboardBinToSequence(binName: string, seqId?: string, startAtSecs = 0, binId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var req=__resolveBin(${JSON.stringify(binId??null)},${JSON.stringify(binName)});
        if(req.error)return JSON.stringify({success:false,error:req.error+' Nothing was placed on the timeline.',binName:${JSON.stringify(binName)},binId:${JSON.stringify(binId??null)},matchCount:req.matchCount});
        var bin=req.bin;
        var pos=new Time();pos.seconds=${startAtSecs};
        var placed=0;
        for(var i=0;i<bin.children.numItems;i++){
          var item=bin.children[i];
          if(item.type!==1)continue;
          seq.videoTracks[0].overwriteClip(item,pos);
          var dur=item.getOutPoint().seconds-item.getInPoint().seconds;
          pos.seconds+=dur;placed++;
        }
        return JSON.stringify({success:placed>0,placed:placed,finalPositionSecs:pos.seconds,
          binId:String(bin.nodeId),binName:String(bin.name),binResolvedBy:req.resolvedBy,
          error:placed===0?'Bin "'+String(bin.name)+'" ('+String(bin.treePath)+') holds no footage items, so nothing was placed.':undefined});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async findClipsBySource(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var results=[];
        var seqs=app.project.sequences;
        for(var s=0;s<seqs.numSequences;s++){
          var seq=seqs[s];
          for(var t=0;t<seq.videoTracks.numTracks;t++){
            for(var c=0;c<seq.videoTracks[t].clips.numItems;c++){
              var clip=seq.videoTracks[t].clips[c];
              if(clip.projectItem&&clip.projectItem.nodeId===${JSON.stringify(projectItemId)}){
                results.push({sequenceName:String(seq.name),trackIndex:t,clipIndex:c,name:String(clip.name),startSecs:clip.start.seconds});
              }
            }
          }
        }
        return JSON.stringify({success:true,count:results.length,clips:results});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async openItemInSourceQe(trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var track = seq && seq.getVideoTrackAt(${trackIndex});
        var clip = track && track.getItemAt(${clipIndex});
        if (!clip) return JSON.stringify({ success: false, error: 'QE clip not found' });
        var pi = clip.getProjectItem();
        if (!pi) return JSON.stringify({ success: false, error: 'getProjectItem() returned nothing' });
        var wantedName = String(pi.name);
        var wantedId = null; try { wantedId = String(pi.nodeId); } catch(eI) {}
        pi.openInSource();
        // "loaded !== null" only proved the Source Monitor had SOMETHING in it — including the
        // clip that was already there when openInSource did nothing. Compare identity.
        var loaded = null, loadedId = null;
        try { var li = app.sourceMonitor.getProjectItem(); if (li) { loaded = String(li.name); try { loadedId = String(li.nodeId); } catch(eL) {} } } catch(x) {}
        if (loaded === null) {
          return JSON.stringify({ success: false, verified: true, verifiedBy: 'app.sourceMonitor.getProjectItem() identity comparison', requested: wantedName,
            error: 'The Source Monitor reports no loaded item after openInSource(), so the clip was not opened.' });
        }
        var isOurs = wantedId !== null && loadedId !== null ? loadedId === wantedId : loaded === wantedName;
        if (!isOurs) {
          return JSON.stringify({ success: false, verified: true, verifiedBy: 'app.sourceMonitor.getProjectItem() identity comparison',
            requested: wantedName, loadedInSource: loaded,
            error: 'The Source Monitor holds "' + loaded + '", not the requested "' + wantedName + '", so openInSource() did not take.' });
        }
        return JSON.stringify({ success: true, verified: true, verifiedBy: 'app.sourceMonitor.getProjectItem() identity comparison', loadedInSource: loaded, requested: wantedName });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  // Subclip Implementation
  protected async createSubclip(projectItemId: string, name: string, startTime: number, endTime: number, hasHardBoundaries?: boolean, takeAudio?: boolean, takeVideo?: boolean): Promise<any> {
    const hardBounds = hasHardBoundaries ? 1 : 0;
    const audio = takeAudio !== false ? 1 : 0;
    const video = takeVideo !== false ? 1 : 0;
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var startTicks = __secondsToTicks(${startTime});
        var endTicks = __secondsToTicks(${endTime});
        var sub = item.createSubClip(${JSON.stringify(name)}, startTicks, endTicks, ${hardBounds}, ${audio}, ${video});
        if (!sub) return JSON.stringify({ success: false, verified: false, error: "createSubClip() returned no project item; the subclip was not created." });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Subclip created",
          name: ${JSON.stringify(name)},
          subclipName: String(sub.name),
          subclipNodeId: sub.nodeId,
          startTime: ${startTime},
          endTime: ${endTime}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async stopSourceMonitor(): Promise<any> {
    return await this.bridge.executeScript(`
      try { app.enableQE(); qe.source.player.stop(); return JSON.stringify({success:true}); }
      catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async stepSourceMonitor(frames: number): Promise<any> {
    const tc = frames >= 0 ? `00:00:00:${Math.abs(frames).toString().padStart(2,'0')}` : `-00:00:00:${Math.abs(frames).toString().padStart(2,'0')}`;
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        qe.source.player.step(${JSON.stringify(tc)});
        return JSON.stringify({success:true,frames:${frames},timecode:${JSON.stringify(tc)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async scrubSourceTo(timecode: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        qe.source.player.scrubTo(${JSON.stringify(timecode)});
        return JSON.stringify({success:true,timecode:${JSON.stringify(timecode)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getSourcePosition(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var pos = qe.source.player.getPosition();
        return JSON.stringify({success:true,position:String(pos),isPlaying:qe.source.player.isPlaying});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async openFileInSource(filePath: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        qe.source.openFilePath(${JSON.stringify(filePath)});
        return JSON.stringify({success:true,filePath:${JSON.stringify(filePath)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setSourceInOutQe(inPoint?: string | null, outPoint?: string | null): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        ${inPoint ? `qe.source.clip.setInPoint(${JSON.stringify(inPoint)});` : 'qe.source.clip.clearInPoint();'}
        ${outPoint ? `qe.source.clip.setOutPoint(${JSON.stringify(outPoint)});` : 'qe.source.clip.clearOutPoint();'}
        return JSON.stringify({success:true,inPoint:${JSON.stringify(inPoint ?? null)},outPoint:${JSON.stringify(outPoint ?? null)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getSourceClipInfoQe(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var clip = qe.source.clip;
        var player = qe.source.player;
        var clipType = clip ? String(clip.reflect.name) : 'null';
        var methods = [];
        if (clip) { var refs = clip.reflect.methods; for (var i=0;i<refs.length;i++) methods.push(String(refs[i].name)); }
        return JSON.stringify({success:true,clipType:clipType,isPlaying:player.isPlaying,methods:methods});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
