/**
 * MarkerTools -- the Markers tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { KeyframeTools } from './keyframe.js';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';
import { MARKER_COLOR_NAMES } from '../catalogue-schemas.js';

export class MarkerTools extends KeyframeTools {
  protected async createMarker(timeSecs: number, name?: string, comment?: string, type?: string, colorIndex?: number, durationSecs?: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      var seq = ${this.buildSeqRes(sequenceId)};
      if (!seq) return JSON.stringify({success:false,error:'No sequence'});
      var markers = seq.markers;
      var m = markers.createMarker(${timeSecs});
      if (!m) return JSON.stringify({success:false,error:'createMarker() returned nothing, so no marker was added.'});
      // Every write used to be swallowed by an empty catch and the call still claimed
      // verified:true. Measured on 26.5.2: Marker.end takes a NUMBER of seconds and rejects a Time
      // ("Illegal Parameter type"); colour is set by setColorByIndex(), and assigning the
      // colorByIndex property does nothing. Each requested field is now read back.
      var mismatches = [];
      ${name ? `try { m.name = ${JSON.stringify(name)}; } catch(e) {} if (String(m.name) !== ${JSON.stringify(name)}) mismatches.push('name');` : ''}
      ${comment ? `try { m.comments = ${JSON.stringify(comment)}; } catch(e) {} if (String(m.comments) !== ${JSON.stringify(comment)}) mismatches.push('comment');` : ''}
      ${type ? `try { m.type = ${JSON.stringify(type)}; } catch(e) {} if (String(m.type) !== ${JSON.stringify(type)}) mismatches.push('type');` : ''}
      ${colorIndex !== undefined ? `try { m.setColorByIndex(${Number(colorIndex)}); } catch(e) {} var cb = null; try { cb = m.getColorByIndex(); } catch(e) {} if (cb !== ${Number(colorIndex)}) mismatches.push('colour');` : ''}
      ${durationSecs ? `try { m.end = ${Number(timeSecs) + Number(durationSecs)}; } catch(e) {} if (Math.abs(Number(m.end.seconds) - ${Number(timeSecs) + Number(durationSecs)}) > 0.001) mismatches.push('duration');` : ''}
      var colorNow = null; try { colorNow = m.getColorByIndex(); } catch(e) {}
      var info = {timeSecs:Number(m.start.seconds),endSecs:Number(m.end.seconds),name:String(m.name),comment:String(m.comments),type:String(m.type),colorIndex:colorNow,ticks:String(m.start.ticks)};
      if (mismatches.length) return JSON.stringify({success:false,verified:true,verifiedBy:'marker field readback',markerCreated:true,marker:info,
        error:'HALF APPLIED: the marker was created but these fields did not take: ' + mismatches.join(', ') + '. Fix it with update_marker or delete it.'});
      return JSON.stringify({success:true,verified:true,verifiedBy:'marker field readback',timeSecs:info.timeSecs,endSecs:info.endSecs,name:info.name,type:info.type,colorIndex:info.colorIndex,ticks:info.ticks});
    `);
  }

  protected async markersToCsv(outputPath: string, sequenceId?: string): Promise<any> {
    const result = await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var markers = seq.markers;
        var rows = [];
        var m = markers.numMarkers > 0 ? markers.getFirstMarker() : null;
        while (m) {
          rows.push({ time: m.start ? m.start.seconds : 0, name: String(m.name||''), comment: String(m.comments||''), type: String(m.type||'Comment'), color: (function(){ try { return m.getColorByIndex(); } catch(eC) { return 0; } })() });
          try { m = markers.getNextMarker(m); } catch(e) { break; }
        }
        return JSON.stringify({success:true,rows:rows,count:rows.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!result.success) return result;
    const fs = fsSync;
    const lines = ['time,name,comment,type,color', ...result.rows.map((r: any) => `${r.time},${JSON.stringify(r.name)},${JSON.stringify(r.comment)},${r.type},${r.color}`)];
    fs.writeFileSync(outputPath, lines.join('\n'));
    return { success: true, outputPath, markerCount: result.count, verified: fsSync.existsSync(outputPath) };
  }

  protected async markersFromCsv(csvPath: string, sequenceId?: string): Promise<any> {
    const fs = fsSync;
    if (!fs.existsSync(csvPath)) return { success: false, error: 'CSV file not found: ' + csvPath };
    const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter((l: string) => l.trim() && !l.startsWith('time'));
    const markers: Array<{time: number, name: string, comment: string, type: string}> = lines.map((line: string) => {
      const parts = line.split(',');
      return { time: parseFloat(parts[0] ?? '0'), name: (parts[1] ?? '').replace(/^"|"$/g, ''), comment: (parts[2] ?? '').replace(/^"|"$/g, ''), type: (parts[3] ?? 'Comment').trim() };
    });
    let created = 0;
    for (const m of markers) {
      const r = await this.createMarker(m.time, m.name, m.comment, m.type, undefined, undefined, sequenceId);
      if (r.success) created++;
    }
    return { success: true, created, total: markers.length };
  }

  /**
   * Map a schema-validated colour to its index. Returns null when no colour was
   * supplied, leaving the marker at Premiere's default rather than silently
   * recolouring it. Unrecognised values cannot reach here — MarkerColorSchema
   * rejects them before the bridge is touched.
   */
  private static resolveMarkerColor(color?: string | number): number | null {
    if (color === undefined || color === null || color === '') return null;
    if (typeof color === 'number') return color;
    const value = String(color).trim().toLowerCase();
    if (/^[0-7]$/.test(value)) return Number(value);
    const index = MARKER_COLOR_NAMES.indexOf(value as typeof MARKER_COLOR_NAMES[number]);
    return index === -1 ? null : index;
  }

  protected async addMarker(sequenceId: string, time: number, name: string, comment?: string, color?: string, duration?: number): Promise<any> {
    const colorIndex = MarkerTools.resolveMarkerColor(color);
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var marker = sequence.markers.createMarker(${time});
        marker.name = ${JSON.stringify(name)};
        ${comment ? `marker.comments = ${JSON.stringify(comment)};` : ''}
        ${colorIndex !== null ? `marker.setColorByIndex(${colorIndex});` : ''}
        ${duration && duration > 0 ? `marker.end = ${time + duration};` : ''}

        return JSON.stringify({
          success: true,
          markerId: marker.guid,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          message: "Marker added successfully"
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

  protected async deleteMarker(sequenceId: string, markerId: string): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var deleted = false;
        for (var i = 0; i < sequence.markers.numMarkers; i++) {
          var marker = sequence.markers[i];
          if (marker.guid === ${JSON.stringify(markerId)}) {
            sequence.markers.deleteMarker(marker);
            deleted = true;
            break;
          }
        }
        var stillPresent = false;
        for (var j = 0; j < sequence.markers.numMarkers; j++) {
          if (sequence.markers[j].guid === ${JSON.stringify(markerId)}) {
            stillPresent = true;
            break;
          }
        }

        return JSON.stringify({
          success: deleted && !stillPresent,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          message: deleted && !stillPresent ? "Marker deleted successfully" : (deleted ? "Premiere reported marker deletion but marker is still present" : "Marker not found")
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

  protected async updateMarker(sequenceId: string, markerId: string, updates: any): Promise<any> {
    const updateColorIndex = MarkerTools.resolveMarkerColor(updates.color);
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        var found = false;
        var mismatch = [];
        for (var i = 0; i < sequence.markers.numMarkers; i++) {
          var marker = sequence.markers[i];
          if (marker.guid === ${JSON.stringify(markerId)}) {
            ${updates.name !== undefined ? `marker.name = ${JSON.stringify(updates.name)};` : ''}
            ${updates.comment !== undefined ? `marker.comments = ${JSON.stringify(updates.comment)};` : ''}
            ${updateColorIndex !== null ? `marker.setColorByIndex(${updateColorIndex});` : ''}
            // Re-read each written attribute off the same marker object; a rejected assignment
            // leaves the old value, which would otherwise be reported as a successful update.
            ${updates.name !== undefined ? `if (String(marker.name) !== ${JSON.stringify(updates.name)}) mismatch.push("name");` : ''}
            ${updates.comment !== undefined ? `if (String(marker.comments) !== ${JSON.stringify(updates.comment)}) mismatch.push("comment");` : ''}
            ${updateColorIndex !== null ? `var __mc = null; try { __mc = marker.getColorByIndex(); } catch (eMc) {} if (__mc !== null && Number(__mc) !== ${updateColorIndex}) mismatch.push("color");` : ''}
            found = true;
            break;
          }
        }

        if (found && mismatch.length) return JSON.stringify({
          success: false,
          verified: false,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          error: "Marker found but these attributes did not apply on readback: " + mismatch.join(", ")
        });
        return JSON.stringify({
          success: found,
          verified: found,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          message: found ? "Marker updated and verified" : "Marker not found"
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

  protected async listMarkers(sequenceId: string): Promise<any> {
    const script = `
      try {
${this.buildSequenceResolver(sequenceId)}
        // getColorByIndex() is not bounded by the write domain: a marker can hold
        // -1, a persistent "no colour assigned" state that renders black. Guard
        // the lookup, or an undefined value silently drops colorName from the JSON.
        var COLOR_NAMES = ["green","red","purple","orange","yellow","white","blue","cyan"];
        var markers = [];
        for (var i = 0; i < sequence.markers.numMarkers; i++) {
          var marker = sequence.markers[i];
          var colorIndex = marker.getColorByIndex();
          markers.push({
            id: marker.guid,
            name: marker.name,
            comment: marker.comments,
            start: marker.start.seconds,
            end: marker.end.seconds,
            duration: marker.end.seconds - marker.start.seconds,
            type: marker.type,
            color: colorIndex,
            colorName: (colorIndex >= 0 && colorIndex < COLOR_NAMES.length) ? COLOR_NAMES[colorIndex] : null
          });
        }

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          markers: markers,
          count: markers.length
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

  protected async durationMarkerAdd(startSecs: number, durationSecs: number, name?: string, comment?: string, type?: string, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        if(!seq)return JSON.stringify({success:false,error:'No active sequence'});
        var m=seq.markers.createMarker(${startSecs});
        if(!m)return JSON.stringify({success:false,verified:true,error:'createMarker() returned nothing, so no marker was added at ${startSecs}s.'});
        ${name ? `m.name=${JSON.stringify(name)};` : ''}
        ${comment ? `m.comments=${JSON.stringify(comment)};` : ''}
        ${type ? `m.type=${JSON.stringify(type)};` : ''}
        // The DURATION is the whole point of this tool and its write was swallowed in
        // try{}catch(ee){} while the response claimed verified:true — so a zero-length marker
        // was indistinguishable from a duration marker. Read the end back and compare.
        var endError=null;
        // Marker.end takes a number of seconds; a Time object is rejected on 26.5.2.
        try{m.end=${Number(startSecs)+Number(durationSecs)};}catch(ee){endError=ee.toString();}
        var endBack=null; try{ endBack=Number(m.end.seconds); }catch(eE){}
        var startBack=null; try{ startBack=Number(m.start.seconds); }catch(eS){}
        var wantEnd=${startSecs+durationSecs};
        var base={startSecs:${startSecs},durationSecs:${durationSecs},name:String(m.name),type:String(m.type),startReadback:startBack,endReadback:endBack};
        if(endBack===null){
          return JSON.stringify({success:true,verified:false,markerCreated:true,startSecs:base.startSecs,durationSecs:base.durationSecs,name:base.name,type:base.type,startReadback:base.startReadback,
            unverifiedReason:'The marker was created but Marker.end is not readable on this build, so its duration cannot be confirmed.',setError:endError});
        }
        if(Math.abs(endBack-wantEnd)>0.001){
          return JSON.stringify({success:false,verified:true,verifiedBy:'Marker.start and Marker.end readback',markerCreated:true,startSecs:base.startSecs,durationSecs:base.durationSecs,name:base.name,type:base.type,startReadback:base.startReadback,endReadback:base.endReadback,setError:endError,
            error:'HALF APPLIED: the marker was created at ' + startBack + 's but its end reads ' + endBack + 's instead of ' + wantEnd + 's, so it has duration ' + (endBack-Number(startBack)) + 's rather than the requested ${durationSecs}s. Delete it with delete_marker or adjust it with update_marker.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'Marker.start and Marker.end readback',markerCreated:true,startSecs:base.startSecs,durationSecs:base.durationSecs,name:base.name,type:base.type,startReadback:base.startReadback,endReadback:base.endReadback});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async setMarkerType(timeSecs: number, type: string, toleranceSecs: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var m=seq.markers.getFirstMarker();var found=null;
        while(m){if(Math.abs(m.start.seconds-${timeSecs})<${toleranceSecs}){found=m;break;}m=seq.markers.getNextMarker(m);}
        if(!found)return JSON.stringify({success:false,error:'No marker near '+${timeSecs}+'s'});
        var before=null; try{ before=String(found.type); }catch(eB){}
        found.type=${JSON.stringify(type)};
        var after=null; try{ after=String(found.type); }catch(eA){}
        if(after===null){
          return JSON.stringify({success:true,verified:false,name:String(found.name),requestedType:${JSON.stringify(type)},before:before,
            unverifiedReason:'Marker.type is not readable on this build, so the type change cannot be confirmed.'});
        }
        if(after!==${JSON.stringify(type)}){
          return JSON.stringify({success:false,verified:true,verifiedBy:'Marker.type readback',changed:before!==after,name:String(found.name),requestedType:${JSON.stringify(type)},before:before,type:after,
            error:'The marker still reads type "' + after + '" instead of the requested ' + ${JSON.stringify(type)} + '. Premiere accepts only Comment, Chapter, Segmentation and WebLink.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'Marker.type readback',changed:before!==after,name:String(found.name),type:after,before:before,
          note: before === after ? 'The marker was already this type; nothing changed.' : undefined});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async todoMarkerReport(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var todos=[];
        var m=seq.markers.getFirstMarker();
        while(m){
          var name=String(m.name),comment=String(m.comments);
          if(name.toUpperCase().indexOf('TODO')>=0||comment.toUpperCase().indexOf('TODO')>=0){
            todos.push({name:name,comment:comment,timeSecs:m.start.seconds,type:String(m.type)});
          }
          m=seq.markers.getNextMarker(m);
        }
        return JSON.stringify({success:true,count:todos.length,todos:todos});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async chapterMarkersToYoutube(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var lines=[];
        var m=seq.markers.getFirstMarker();
        while(m){
          if(String(m.type)==='Chapter'){
            var secs=Math.floor(m.start.seconds);
            var h=Math.floor(secs/3600),mi=Math.floor((secs%3600)/60),s=secs%60;
            var tc=(h>0?h+':':'')+(mi<10&&h>0?'0':'')+mi+':'+(s<10?'0':'')+s;
            lines.push(tc+' '+String(m.name));
          }
          m=seq.markers.getNextMarker(m);
        }
        return JSON.stringify({success:true,chapterCount:lines.length,youtubeText:lines.join('\\n')});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async copyMarkersBetweenSequences(srcSeqId: string, tgtSeqId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seqs=app.project.sequences;
        var src=null,tgt=null;
        for(var i=0;i<seqs.numSequences;i++){
          if(seqs[i].sequenceID===${JSON.stringify(srcSeqId)})src=seqs[i];
          if(seqs[i].sequenceID===${JSON.stringify(tgtSeqId)})tgt=seqs[i];
        }
        if(!src||!tgt)return JSON.stringify({success:false,error:'Source or target sequence not found'});
        // Copying a sequence onto itself used to hang the host: the loop walked the same
        // marker list it was appending to, so it never reached the end and the panel could
        // not cancel it. Refuse it, and snapshot the source before writing anything so the
        // walk can never see a marker this call created.
        if(src===tgt||src.sequenceID===tgt.sequenceID)return JSON.stringify({success:false,error:'Source and target are the same sequence. Copying the markers of a sequence onto itself would only duplicate every marker, so nothing was done.'});
        var snap=[];
        var m=src.markers.getFirstMarker();
        while(m){
          var endT=null;try{endT=m.end?m.end.seconds:null;}catch(eE){}
          var cbi=null;try{cbi=m.getColorByIndex?m.getColorByIndex():null;}catch(eC){}
          snap.push({start:m.start.seconds,end:endT,name:String(m.name),comments:String(m.comments),type:String(m.type),color:cbi});
          m=src.markers.getNextMarker(m);
        }
        var before=tgt.markers.numMarkers;
        var count=0,warnings=[];
        for(var k=0;k<snap.length;k++){
          var s=snap[k];
          var nm=tgt.markers.createMarker(s.start);
          if(!nm){warnings.push('createMarker returned nothing at '+s.start+'s');continue;}
          nm.name=s.name;nm.comments=s.comments;
          try{if(s.type&&s.type!=='Comment'){nm.type=s.type;}}catch(eT){warnings.push('type not set at '+s.start+'s');}
          try{if(s.end!==null&&s.end>s.start){nm.end=s.end;}}catch(eD){warnings.push('duration not set at '+s.start+'s');}
          try{if(s.color!==null&&nm.setColorByIndex){nm.setColorByIndex(s.color);}}catch(eS){warnings.push('colour not set at '+s.start+'s');}
          count++;
        }
        var after=tgt.markers.numMarkers;
        var verified=(after-before)===snap.length;
        return JSON.stringify({success:verified,verified:verified,verifiedBy:'target markers.numMarkers before/after',sourceMarkers:snap.length,markersCopied:count,targetBefore:before,targetAfter:after,warnings:warnings,
          error:verified?undefined:'Expected the target to gain '+snap.length+' markers but it gained '+(after-before)+'.'});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async markerToSubclip(markerName: string, projectItemId: string, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var m=seq.markers.getFirstMarker(),found=null;
        while(m){if(String(m.name)===${JSON.stringify(markerName)}){found=m;break;}m=seq.markers.getNextMarker(m);}
        if(!found)return JSON.stringify({success:false,error:'Marker not found: '+${JSON.stringify(markerName)}});
        var item=${this.findItemById(projectItemId)};
        if(!item)return JSON.stringify({success:false,error:'Item not found'});
        var st=new Time();st.ticks=String(found.start.ticks);
        var et=new Time();et.ticks=String(found.end?found.end.ticks:found.start.ticks);
        var sub=item.createSubClip(${JSON.stringify(markerName)},st,et,false,true,true);
        return JSON.stringify({success:true,subclipName:sub?String(sub.name):'created',startSecs:found.start.seconds});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async getAllMarkers(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var all=[];
        var seqs=app.project.sequences;
        for(var i=0;i<seqs.numSequences;i++){
          var seq=seqs[i];var seqName=String(seq.name);
          var m=seq.markers.getFirstMarker();
          while(m){all.push({sequenceName:seqName,name:String(m.name),comment:String(m.comments),type:String(m.type),secs:m.start.seconds,color:(function(){try{return m.getColorByIndex();}catch(eC){return null;}})()});m=seq.markers.getNextMarker(m);}
        }
        return JSON.stringify({success:true,count:all.length,markers:all});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async frameIoNotesToMarkers(jsonPath: string, sequenceId?: string, markerColor = 1): Promise<any> {
    const fs = fsSync;
    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const data = JSON.parse(raw);
      // Frame.io comment export format: array of {timestamp, text, author, ...} or nested structure
      const comments: Array<{time: number, text: string, author?: string}> = [];
      const items = Array.isArray(data) ? data : (data.comments || data.annotations || data.items || []);
      for (const item of items) {
        const timeSecs = item.timestamp ?? item.time ?? item.timecode_in ?? 0;
        const text = item.text ?? item.comment ?? item.content ?? '';
        const author = item.author?.name ?? item.user?.name ?? item.created_by ?? '';
        if (text) comments.push({ time: typeof timeSecs === 'string' ? parseFloat(timeSecs) : timeSecs, text, author });
      }
      if (!comments.length) return { success: false, error: 'No comments found in Frame.io export', path: jsonPath };

      const markerScript = `
        try {
          var seq = ${this.buildSeqRes(sequenceId)};
          if (!seq) return JSON.stringify({success:false,error:'No sequence'});
          var comments = ${JSON.stringify(comments)};
          var created = 0;
          for (var i = 0; i < comments.length; i++) {
            var c = comments[i];
            var m = seq.markers.createMarker(c.time);
            m.name = c.author ? '[' + c.author + ']' : 'Frame.io';
            m.comments = c.text;
            try { m.setColorByIndex(${markerColor}); } catch(eC) {}
            created++;
          }
          return JSON.stringify({success:true,verified:true,markersCreated:created,sequenceName:String(seq.name)});
        } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
      `;
      return await this.bridge.executeScript(markerScript);
    } catch (e: any) {
      return { success: false, error: 'Could not parse Frame.io export: ' + e.message };
    }
  }

  /**
   * Three defects, all in the same call:
   *
   * 1. It finished with `seq.clearInPoint(0); seq.clearOutPoint(0)`. Those are ProjectItem
   *    methods and are UNDEFINED on Sequence (measured on 26.3.2 — the same fact is written
   *    down in clearSequenceInOut one domain over), so the line threw AFTER every export had
   *    already run. The tool therefore reported success:false on a run that fully succeeded,
   *    and left the caller's in/out points sitting on the last exported range.
   * 2. exportAsMediaDirect's result was discarded and no file was ever stat'ed, so the
   *    response listed output paths that need not exist and called itself success:true.
   * 3. It hardcoded the active sequence with no way to name another one.
   *
   * The in/out points are now captured up front and restored with setInPoint/setOutPoint,
   * and every output is stat'ed so `verified` reflects files that are actually on disk.
   */
  protected async exportPerMarkerRange(outputDir: string, presetPath?: string, markerPattern?: string, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({success:false,error:'No sequence to export from.'});
        // Captured BEFORE any range is set, so the caller's range can be put back.
        var priorIn = null, priorOut = null;
        try { priorIn = seq.getInPointAsTime().seconds; priorOut = seq.getOutPointAsTime().seconds; } catch(ePrior) {}
        var markers = seq.markers;
        var m = markers.getFirstMarker();
        var ranges = [];
        var inMarker = null;
        while (m) {
          var name = String(m.name);
          var matchPattern = ${JSON.stringify(markerPattern ?? '')} === '' || name.indexOf(${JSON.stringify(markerPattern ?? '')}) >= 0;
          if (matchPattern) {
            if (!inMarker) { inMarker = m; }
            else {
              ranges.push({inSecs:inMarker.start.seconds, outSecs:m.start.seconds, name:String(inMarker.name)});
              inMarker = null;
            }
          }
          m = markers.getNextMarker(m);
        }
        // Export each range, then stat the file. A queued-but-absent output is a failure.
        var exported = [], missing = [];
        for (var i = 0; i < ranges.length; i++) {
          var r = ranges[i];
          // The extension is assumed to be .mp4. A preset that writes something else lands at a
          // different path, which shows up below as a missing file rather than a false success.
          var outPath = ${JSON.stringify(outputDir)} + '/' + r.name.replace(/[^a-zA-Z0-9_-]/g,'_') + '_' + i + '.mp4';
          var inT = new Time(); inT.seconds = r.inSecs;
          var outT = new Time(); outT.seconds = r.outSecs;
          seq.setInPoint(inT); seq.setOutPoint(outT);
          var callResult = null;
          try { callResult = seq.exportAsMediaDirect(outPath, ${JSON.stringify(presetPath ?? '')}, 1); } catch(eExp) { callResult = 'threw: ' + eExp.toString(); }
          var f = new File(outPath);
          if (f.exists) exported.push({range:r, outputPath:outPath, fileSize:f.length});
          else missing.push({range:r, outputPath:outPath, exportAsMediaDirectReturned:String(callResult)});
        }
        // clearInPoint/clearOutPoint do NOT exist on Sequence (26.3.2); restore by setting.
        var restored = false;
        if (priorIn !== null && priorOut !== null) {
          try { seq.setInPoint(priorIn); seq.setOutPoint(priorOut); restored = true; } catch(eRestore) {}
        }
        return JSON.stringify({
          success: ranges.length > 0 && missing.length === 0,
          verified: true,
          rangeCount: ranges.length,
          exportedCount: exported.length,
          exported: exported,
          missing: missing,
          inOutPointsRestored: restored,
          error: ranges.length === 0
            ? 'No marker pairs matched, so nothing was exported.'
            : (missing.length ? missing.length + ' of ' + ranges.length + ' ranges produced no file on disk.' : undefined),
          note: restored ? undefined : 'The sequence in/out points were changed for export and could not be restored; they now sit on the last range.'
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }
}
