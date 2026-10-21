/**
 * ReviewDeliveryTools -- the Review & Delivery tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { MulticamTools } from './multicam.js';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';

export class ReviewDeliveryTools extends MulticamTools {
  protected async assembleReviewReel(sequenceIds: string[], reelName: string, handles: number): Promise<any> {
    const idsJson = JSON.stringify(sequenceIds);
    return await this.bridge.executeScript(`
      try {
        var sourceIds = ${idsJson};
        var reelName = ${JSON.stringify(reelName)};
        var handles = ${handles};
        var seqs = app.project.sequences;
        // Find source sequences
        var sources = [];
        for (var si=0;si<seqs.numSequences;si++) {
          for (var di=0;di<sourceIds.length;di++) {
            if (seqs[si].sequenceID === sourceIds[di]) { sources.push(seqs[si]); break; }
          }
        }
        if (sources.length === 0) return JSON.stringify({success:false,error:'No matching sequences found'});
        // createNewSequenceFromClips is the non-interactive constructor and is verified working.
        // createNewSequence (used here before) opens the New Sequence dialog on this build and
        // hangs the scripting host until a human presses Escape.
        var sourceItems = [];
        for (var si2 = 0; si2 < sources.length; si2++) {
          if (sources[si2].projectItem) sourceItems.push(sources[si2].projectItem);
        }
        if (sourceItems.length === 0) return JSON.stringify({success:false,error:'None of the source sequences expose a projectItem, so no reel could be created.'});
        var reel = null;
        try { reel = app.project.createNewSequenceFromClips(reelName, sourceItems, app.project.rootItem); } catch (eReel) {
          return JSON.stringify({success:false,error:'createNewSequenceFromClips failed: ' + eReel.toString()});
        }
        if (!reel) return JSON.stringify({success:false,error:'Could not create reel sequence (createNewSequenceFromClips returned null)'});
        // The clips are already laid out by the constructor; the loop below is now a verification
        // and gap-filling pass rather than the thing that builds the reel.
        try { app.project.openSequence(String(reel.sequenceID)); } catch (eOpenReel) {}
        // Overwrite each source into the reel
        var cursor = new Time(); cursor.ticks = '0';
        var placed = 0, skipped = [];
        for (var i=0;i<sources.length;i++) {
          var src = sources[i];
          // src.end is a TICKS string, not a Time. Reading .ticks gave undefined, so the cursor
          // advanced by NaN and every later source was written to the same spot — while the tool
          // still reported success. Measured on 26.3.2.
          var durTicks = __seqEndTicks(src);
          var srcItem = src.projectItem;
          if (!srcItem) { skipped.push(String(src.name) + ' (no projectItem)'); continue; }
          if (durTicks === null || isNaN(durTicks)) { skipped.push(String(src.name) + ' (unreadable duration)'); continue; }
          try { reel.videoTracks[0].overwriteClip(srcItem, cursor); } catch (eOv) { skipped.push(String(src.name) + ' (' + eOv.toString() + ')'); continue; }
          cursor.ticks = String(Math.round(Number(cursor.ticks) + durTicks));
          placed++;
        }
        var landed = reel.videoTracks[0].clips.numItems;
        return JSON.stringify({
          success: placed > 0 && landed >= placed,
          verified: true,
          reelSequenceId:String(reel.sequenceID), reelName:String(reel.name),
          sourceCount:sources.length, placed: placed, clipsOnV1: landed,
          skipped: skipped,
          totalDurationTicks:String(cursor.ticks),
          error: placed === 0 ? 'No source sequence could be placed into the reel.' : (skipped.length ? 'Some sources were skipped; see skipped[].' : null)
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async versionUpSequence(sequenceId?: string, setActive?: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        if (!seq) return JSON.stringify({success:false,error:'Sequence not found'});
        var name = String(seq.name);
        // Try to bump version: _v001 -> _v002, _v01 -> _v02, or append _v001
        var newName;
        // Escapes are DOUBLED because this regex lives inside a template literal: the host
        // receives the result of collapsing them. Written single, \\d reached Premiere as a
        // literal 'd' and \\- turned [_\\-v] into the character RANGE _ through v, so no real
        // sequence name ever matched and every call fell through to appending '_v002' —
        // 'SHOW_008_0080_v001' became 'SHOW_008_0080_v001_v002' instead of '..._v002'.
        var vMatch = name.match(/(.*[_\\-v])(\\d+)$/i);
        if (vMatch) {
          var prefix = vMatch[1]; var num = parseInt(vMatch[2],10);
          var newNum = String(num+1); while(newNum.length < vMatch[2].length) newNum = '0'+newNum;
          newName = prefix + newNum;
        } else { newName = name + '_v002'; }
        // clone() is the only safe duplicate here. The old fallback called
        // app.project.createNewSequence, which OPENS THE NEW SEQUENCE DIALOG on this build and
        // wedges the scripting host — a fallback that hangs is worse than no fallback.
        // clone() does NOT return a usable Sequence on this build — it returned a truthy value
        // whose sequenceID and name were both undefined, which my first fix then reported as
        // success. Find the new sequence by diffing the project's sequence ids across the call.
        var idsBefore = {};
        for (var bi = 0; bi < app.project.sequences.numSequences; bi++) idsBefore[String(app.project.sequences[bi].sequenceID)] = true;
        var cloneReturn = seq.clone();
        var newSeq = null;
        for (var ai = 0; ai < app.project.sequences.numSequences; ai++) {
          var cand = app.project.sequences[ai];
          if (!idsBefore[String(cand.sequenceID)]) { newSeq = cand; break; }
        }
        if (!newSeq) return JSON.stringify({success:false,verified:true,error:'Sequence.clone() did not add a sequence to the project, so no new version was created. (The previous fallback, createNewSequence, opens a modal dialog on this build and would hang the bridge, so it was removed.)',cloneReturn:String(cloneReturn)});
        // A Sequence name is set through its ProjectItem; assigning Sequence.name does not stick.
        var renamed = false;
        try { newSeq.projectItem.name = newName; renamed = (String(newSeq.name) === newName); } catch(eRen) {}
        if (!renamed) { try { newSeq.name = newName; renamed = (String(newSeq.name) === newName); } catch(eRen2) {} }
        // openSequence takes a sequenceID STRING; passing the Sequence object raised
        // "Illegal Parameter type" and the whole tool failed after doing its work.
        var opened = false;
        if (${setActive ?? true}) {
          try { app.project.openSequence(String(newSeq.sequenceID)); opened = (String(app.project.activeSequence.sequenceID) === String(newSeq.sequenceID)); } catch(eOpen) {}
        }
        return JSON.stringify({
          success:true, verified:true,
          newSequenceId:String(newSeq.sequenceID), newName:String(newSeq.name), requestedName:newName,
          renamed:renamed, openedAsActive:opened, fromName:name,
          error: renamed ? null : 'The new version was created but could not be renamed to ' + newName + '; it kept the name Premiere gave it.'
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async shotStatusReport(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seqs = app.project.sequences;
        var report = [];
        for (var i=0;i<seqs.numSequences;i++) {
          var s = seqs[i];
          var totalClips = 0;
          var vt = s.videoTracks;
          for (var ti=0;ti<vt.numTracks;ti++) totalClips += vt[ti].clips.numItems;
          var durationSecs = s.end ? s.end.seconds : 0;
          report.push({
            name: String(s.name),
            id: String(s.sequenceID),
            durationSecs: durationSecs,
            videoTracks: vt.numTracks,
            audioTracks: s.audioTracks.numTracks,
            totalClips: totalClips
          });
        }
        return JSON.stringify({success:true,sequences:report,count:report.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async notesToMarkers(notesPath: string, sequenceId?: string, markerType = 'Comment', colorIndex?: number): Promise<any> {
    const fs = fsSync;
    if (!fs.existsSync(notesPath)) return { success: false, error: 'Notes file not found: ' + notesPath };
    const lines = fs.readFileSync(notesPath, 'utf8').split('\n').filter((l: string) => l.trim());
    let created = 0;
    for (const line of lines) {
      // Format: "HH:MM:SS:FF Note" or "SS.ms Note" or "MM:SS Note"
      const match = line.match(/^(\d+:\d+:\d+:\d+|\d+:\d+:\d+|\d+:\d+|\d+\.?\d*)\s+(.*)/);
      if (!match) continue;
      const tcStr = match[1] ?? ''; const note = (match[2] ?? '').trim();
      // Parse TC to seconds
      let secs = 0;
      const parts = tcStr.split(':'); const P = (n: number) => parts[n] ?? '0';
      if (parts.length === 4) secs = parseInt(P(0)) * 3600 + parseInt(P(1)) * 60 + parseInt(P(2)) + parseInt(P(3)) / 24;
      else if (parts.length === 3) secs = parseInt(P(0)) * 3600 + parseInt(P(1)) * 60 + parseFloat(P(2));
      else if (parts.length === 2) secs = parseInt(P(0)) * 60 + parseFloat(P(1));
      else secs = parseFloat(tcStr);
      const r = await this.createMarker(secs, note, '', markerType, colorIndex, undefined, sequenceId);
      if (r.success) created++;
    }
    return { success: true, created, total: lines.length };
  }

  protected async markersToNotes(outputPath: string, sequenceId?: string, format = 'text'): Promise<any> {
    const result = await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        var markers = seq.markers;
        var rows = [];
        var m = markers.numMarkers > 0 ? markers.getFirstMarker() : null;
        while (m) {
          rows.push({ time: m.start ? m.start.seconds : 0, ticks: m.start ? String(m.start.ticks) : '0', name: String(m.name||''), comment: String(m.comments||''), type: String(m.type||'Comment') });
          try { m = markers.getNextMarker(m); } catch(e) { break; }
        }
        return JSON.stringify({success:true,rows:rows});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!result.success) return result;
    const fs = fsSync;
    let content: string;
    if (format === 'json') {
      content = JSON.stringify(result.rows, null, 2);
    } else if (format === 'csv') {
      content = ['time,name,comment,type', ...result.rows.map((r: any) => `${r.time},${JSON.stringify(r.name)},${JSON.stringify(r.comment)},${r.type}`)].join('\n');
    } else {
      content = result.rows.map((r: any) => {
        const t = r.time; const h = Math.floor(t/3600); const m = Math.floor((t%3600)/60); const s = Math.floor(t%60);
        const tc = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        return `${tc}  ${r.name}${r.comment ? '  — ' + r.comment : ''}`;
      }).join('\n');
    }
    fs.writeFileSync(outputPath, content);
    return { success: true, outputPath, markerCount: result.rows.length, format };
  }

  protected async deliveryQc(sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${sequenceId ? `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sequenceId)})return ss[i];}return app.project.activeSequence;})()` : 'app.project.activeSequence'};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var issues = [];
        // Check offline media
        var offlineCount = 0;
        var vt = seq.videoTracks;
        for (var ti=0;ti<vt.numTracks;ti++) {
          var clips = vt[ti].clips;
          for (var ci=0;ci<clips.numItems;ci++) {
            try { if (clips[ci].projectItem && clips[ci].projectItem.isOffline()) offlineCount++; } catch(e){}
          }
        }
        if (offlineCount > 0) issues.push('OFFLINE_MEDIA: ' + offlineCount + ' clip(s) offline');
        // Check for gaps
        var gaps = seq.getTimelineGaps ? seq.getTimelineGaps() : [];
        if (gaps && gaps.length > 0) issues.push('TIMELINE_GAPS: ' + gaps.length + ' gap(s) detected');
        // Check render status via QE
        try {
          app.enableQE();
          var qseq = qe.project.getActiveSequence();
          var red = qseq.getRedBarTimes();
          if (red && red.length > 0) issues.push('UNRENDERED: ' + (red.length/2) + ' range(s) need rendering');
        } catch(eqc){}
        // Sequence stats
        var totalClips = 0;
        for (var ti2=0;ti2<vt.numTracks;ti2++) totalClips += vt[ti2].clips.numItems;
        // seq.end is a TICKS string; .seconds on it was undefined and shipped as null.
        var durationSecs = __seqEndSeconds(seq);
        if (durationSecs === null) durationSecs = 0;
        return JSON.stringify({
          success:true,
          qcPass: issues.length === 0,
          issues: issues,
          sequenceName: String(seq.name),
          durationSecs: durationSecs,
          totalClips: totalClips,
          offlineClips: offlineCount
        });
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async shotgridStatusSync(csvPath: string, statusToColor?: Record<string, number>): Promise<any> {
    const fs = fsSync;
    const defaultMap: Record<string, number> = { wtg: 0, ip: 3, fin: 2, na: 7, hld: 6, rev: 4, cmpt: 2 };
    const colorMap = statusToColor ?? defaultMap;
    try {
      const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter(Boolean);
      const header = (lines[0] ?? '').toLowerCase().split(',').map((h: string) => h.trim().replace(/"/g,''));
      const nameIdx = header.indexOf('shot_name') >= 0 ? header.indexOf('shot_name') : header.indexOf('name');
      const statusIdx = header.indexOf('status') >= 0 ? header.indexOf('status') : header.indexOf('sg_status_list');
      const assigneeIdx = header.indexOf('assignee') >= 0 ? header.indexOf('assignee') : header.indexOf('task_assignees');
      if (nameIdx < 0 || statusIdx < 0) return { success: false, error: 'CSV must have shot_name and status columns' };

      const shots = lines.slice(1).map((line: string) => {
        const cols = line.split(',').map((c: string) => c.trim().replace(/"/g,''));
        return { name: cols[nameIdx], status: cols[statusIdx]?.toLowerCase(), assignee: assigneeIdx >= 0 ? cols[assigneeIdx] : '' };
      }).filter((s: any) => s.name && s.status);

      const script = `
        try {
          var shots = ${JSON.stringify(shots)};
          var colorMap = ${JSON.stringify(colorMap)};
          var updated = 0;
          var seqs = app.project.sequences;
          for (var i = 0; i < seqs.numSequences; i++) {
            var seq = seqs[i];
            var seqName = String(seq.name);
            for (var j = 0; j < shots.length; j++) {
              var shot = shots[j];
              if (seqName.indexOf(shot.name) >= 0 || shot.name.indexOf(seqName) >= 0) {
                var color = colorMap[shot.status] !== undefined ? colorMap[shot.status] : 0;
                seq.projectItem.setColorLabel(color);
                seq.projectItem.setProjectMetadata('sg.status', shot.status);
                if (shot.assignee) seq.projectItem.setProjectMetadata('sg.assignee', shot.assignee);
                updated++;
                break;
              }
            }
          }
          return JSON.stringify({success:true,shotsProcessed:shots.length,sequencesUpdated:updated});
        } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
      `;
      return await this.bridge.executeScript(script);
    } catch (e: any) {
      return { success: false, error: 'CSV parse failed: ' + e.message };
    }
  }
}
