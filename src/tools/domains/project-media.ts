/**
 * ProjectMediaTools -- the Project & Media Management tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { CaptionTools } from './caption.js';
import { execSync } from 'child_process';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// The async API is the separate `promises as fs` import.
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  SurgeryRefusal,
  ProjectWriteError,
  applyReplacements,
  assertOutputWritable,
  assertSupportedFormat,
  censusDiff,
  censusOf,
  containerCanary,
  countOccurrences,
  documentSanity,
  readProjectFile,
  surgeryEnabled,
  writeEditedProject,
  PRPROJ_SUPPORTED_FORMAT_VERSIONS,
  SURGERY_ENV_FLAG,
} from '../prproj-surgery.js';
import type { ProjectFileEditArgs, ProjectFileInspectArgs } from './shared.js';

export class ProjectMediaTools extends CaptionTools {
  // Discovery Tools Implementation
  /**
   * A show project holds thousands of items, and the whole list in one reply would fill an
   * assistant's context. Filtered and paged here (the walk itself stays in ExtendScript): a page
   * of `limit` items from `offset`, optionally by name, type or bin, with nextOffset to go on.
   */
  protected async listProjectItems(
    includeBins = true,
    _includeMetadata = false,
    page: {
      limit?: number;
      offset?: number;
      nameContains?: string;
      type?: string;
      binPath?: string;
    } = {},
  ): Promise<any> {
    const all: any = await this.listAllProjectItems(includeBins);
    if (!all?.success) return all;
    const needle = (page.nameContains ?? '').toLowerCase();
    const bin = (page.binPath ?? '').replace(/^[\\/]+/, '').toLowerCase();
    const keep = (it: any) =>
      (!needle || String(it.name).toLowerCase().includes(needle)) &&
      (!page.type || it.type === page.type) &&
      (!bin ||
        String(it.treePath ?? '')
          .replace(/\\/g, '/')
          .toLowerCase()
          .includes(`/${bin}/`));
    const items = (all.items as any[]).filter(keep);
    const limit = Math.min(Math.max(Number(page.limit) || 200, 1), 2000);
    const offset = Math.max(Number(page.offset) || 0, 0);
    const slice = items.slice(offset, offset + limit);
    const more = offset + slice.length < items.length;
    const bins = includeBins
      ? (all.bins as any[]).filter((b) => !needle || String(b.name).toLowerCase().includes(needle))
      : [];
    return {
      success: true,
      items: slice,
      bins: bins.slice(0, 500),
      totalItems: all.totalItems,
      totalBins: all.totalBins,
      matchingItems: items.length,
      offset,
      returned: slice.length,
      hasMore: more,
      ...(more
        ? {
            nextOffset: offset + slice.length,
            note: `Showing ${slice.length} of ${items.length}. Pass offset ${offset + slice.length} for the next page, or narrow with nameContains, type or binPath.`,
          }
        : {}),
    };
  }

  private async listAllProjectItems(includeBins: boolean): Promise<any> {
    const script = `
      try {
        function walkItems(parent, results, bins) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            var info = {
              id: item.nodeId,
              name: item.name,
              type: item.type === 2 ? 'bin' : (item.isSequence() ? 'sequence' : 'footage'),
              treePath: item.treePath
            };
            try { info.mediaPath = item.getMediaPath(); } catch(e) {}
            if (item.type === 2) {
              bins.push(info);
              walkItems(item, results, bins);
            } else {
              results.push(info);
            }
          }
        }
        var items = []; var bins = [];
        walkItems(app.project.rootItem, items, bins);
        return JSON.stringify({
          success: true,
          items: items,
          bins: ${includeBins} ? bins : [],
          totalItems: items.length,
          totalBins: bins.length
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

  protected async getProjectInfo(): Promise<any> {
    const script = `
      try {
        var project = app.project;
        var hasActive = project.activeSequence ? true : false;
        return JSON.stringify({
          success: true,
          name: project.name,
          path: project.path,
          activeSequence: hasActive ? {
            id: project.activeSequence.sequenceID,
            name: project.activeSequence.name
          } : null,
          itemCount: project.rootItem.children.numItems,
          sequenceCount: project.sequences.numSequences,
          hasActiveSequence: hasActive
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

  // Project Management Implementation
  protected async createProject(name: string, location: string): Promise<any> {
    try {
      const result: any = await this.bridge.createProject(name, location);
      const projectPath = `${location.replace(/[\\/]+$/, '')}/${name.endsWith('.prproj') ? name : `${name}.prproj`}`;
      if (result?.success === false) {
        return {
          ...result,
          projectPath: result.projectPath || projectPath,
        };
      }

      return {
        success: true,
        message: `Project "${name}" created successfully`,
        projectPath,
        ...result,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create project: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  protected async openProject(path: string): Promise<any> {
    try {
      const result: any = await this.bridge.openProject(path);
      if (result?.success === false) {
        return {
          ...result,
          projectPath: result.projectPath || path,
        };
      }

      return {
        success: true,
        message: `Project opened successfully`,
        projectPath: path,
        ...result,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to open project: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  protected async saveProject(): Promise<any> {
    try {
      await this.bridge.saveProject();
      return {
        success: true,
        message: 'Project saved successfully',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to save project: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  protected async saveProjectAs(name: string, location: string): Promise<any> {
    const script = `
      try {
        var project = app.project;
        var newPath = ${JSON.stringify(location)} + "/" + ${JSON.stringify(name)} + ".prproj";
        project.saveAs(newPath);
        var savedFile = new File(newPath);
        if (!savedFile.exists) return JSON.stringify({ success: false, verified: false, error: "saveAs() ran but no file exists at " + newPath + ". The location may be unwritable.", newPath: newPath });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Project saved as: " + newPath,
          newPath: newPath,
          fileSize: savedFile.length
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

  protected async closeProject(saveFirst: boolean, closeIfLast: boolean): Promise<any> {
    const script = `
      try {
        var name = app.project.name;
        app.project.closeDocument(${saveFirst}, ${closeIfLast});
        return JSON.stringify({ success: true, closedProject: name, savedFirst: ${saveFirst} });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async listOpenProjects(): Promise<any> {
    const script = `
      try {
        var projs = app.projects;
        var list = [];
        for (var i = 0; i < projs.numProjects; i++) {
          var p = projs[i];
          list.push({ name: String(p.name), path: String(p.path), sequences: p.sequences ? p.sequences.numSequences : 0 });
        }
        return JSON.stringify({ success: true, openProjectCount: projs.numProjects, projects: list });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  protected listRecentProjects(limit: number, excludeAutosave: boolean): any {
    try {
      const raw = execSync('mdfind -name ".prproj"', { encoding: 'utf8', timeout: 5000 });
      const files = raw
        .trim()
        .split('\n')
        .filter((f: string) => f && (!excludeAutosave || !f.includes('Auto-Save')));
      const fs = fsSync;
      const withTimes = files
        .map((f: string) => {
          try {
            return { path: f, name: pathSync.basename(f), mtime: fs.statSync(f).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((f: any) => ({ ...f, modified: new Date(f.mtime).toISOString() }));
      return { success: true, count: withTimes.length, projects: withTimes };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected clipboardRead(): any {
    try {
      const text = this.bridge.readClipboard();
      return { success: true, text, length: text.length };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected clipboardWrite(text: string): any {
    try {
      this.bridge.writeClipboard(text);
      const readback = this.bridge.readClipboard();
      const verified = readback === text;
      return {
        success: true,
        verified,
        length: text.length,
        note: verified ? undefined : 'Clipboard content after write did not match exactly.',
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected async addMetadataSchemaField(
    columnId: string,
    displayName: string,
    type: number,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.project.addPropertyToProjectMetadataSchema(${JSON.stringify(columnId)}, ${JSON.stringify(displayName)}, ${type});
        return JSON.stringify({success:true,columnId:${JSON.stringify(columnId)},displayName:${JSON.stringify(displayName)},type:${type}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setItemMetadata(projectItemId: string, key: string, value: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item = null;
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        item = findById(app.project.rootItem, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        item.setProjectMetadata(${JSON.stringify(key)}, ${JSON.stringify(value)});
        return JSON.stringify({success:true,key:${JSON.stringify(key)},value:${JSON.stringify(value)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getItemMetadataColumns(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        var item = findById(app.project.rootItem, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        var cols = JSON.parse(String(item.getProjectColumnsMetadata()));
        return JSON.stringify({success:true,columns:cols,count:cols.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async batchSetLabel(projectItemIds: string[], labelColor: string): Promise<any> {
    const colorMap: Record<string, number> = {
      violet: 0,
      iris: 1,
      caribbean: 2,
      lavender: 3,
      cerise: 4,
      rose: 5,
      mango: 6,
      yellow: 7,
      mint: 8,
      forest: 9,
      teal: 10,
      cyan: 11,
      sky: 12,
      blue: 13,
      purple: 14,
      pink: 15,
      red: 16,
      orange: 17,
      sand: 18,
      lime: 19,
    };
    const colorNum = colorMap[labelColor.toLowerCase()] ?? 1;
    const idsJson = JSON.stringify(projectItemIds);
    return await this.bridge.executeScript(`
      try {
        var ids = ${idsJson};
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        var set = 0;
        for (var i=0;i<ids.length;i++) {
          var item = findById(app.project.rootItem, ids[i]);
          if (item) { try { item.setColorLabel(${colorNum}); set++; } catch(e){} }
        }
        return JSON.stringify({success:true,labeled:set,total:ids.length,color:${JSON.stringify(labelColor)},colorIndex:${colorNum}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async batchRenameProjectItems(
    renames: Array<{ projectItemId: string; newName: string }>,
  ): Promise<any> {
    const renamesJson = JSON.stringify(renames);
    return await this.bridge.executeScript(`
      try {
        var renames = ${renamesJson};
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        var results = [];
        for (var i=0;i<renames.length;i++) {
          var item = findById(app.project.rootItem, renames[i].projectItemId);
          if (item) {
            var before = String(item.name);
            try { item.name = renames[i].newName; results.push({id:renames[i].projectItemId,before:before,after:String(item.name),success:true}); }
            catch(e) { results.push({id:renames[i].projectItemId,success:false,error:e.toString()}); }
          } else { results.push({id:renames[i].projectItemId,success:false,error:'Not found'}); }
        }
        return JSON.stringify({success:true,results:results,renamed:results.filter(function(r){return r.success;}).length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getItemTreepath(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        function findById(bin, id) { for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null; }
        var item = findById(app.project.rootItem, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        return JSON.stringify({success:true,treePath:String(item.treePath),name:String(item.name),nodeId:${JSON.stringify(projectItemId)}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async renameTimelineClip(
    trackIndex: number,
    clipIndex: number,
    name: string,
    sequenceId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      app.enableQE(); ${this.qeClipScript(trackIndex, clipIndex, sequenceId)}
      if (!__clip) return JSON.stringify({success:false,error:'Clip not found'});
      var before = null;
      try { before = String(__clip.name); } catch (eB) {}
      var setError = null;
      try { __clip.setName(${JSON.stringify(name)}); } catch (eS) { setError = eS.toString(); }
      var after = null;
      try { after = String(__clip.name); } catch (eA) {}
      if (after === null) {
        return JSON.stringify({success:true,verified:false,before:before,requested:${JSON.stringify(name)},setError:setError,
          unverifiedReason:'qeClip.name is not readable after setName() on this build, so the rename cannot be confirmed. Read it with get_qe_clip_info.'});
      }
      if (after !== ${JSON.stringify(name)}) {
        return JSON.stringify({success:false,verified:true,verifiedBy:'qeClip.name readback',changed:before!==after,before:before,after:after,requested:${JSON.stringify(name)},setError:setError,
          error:'The timeline clip still reads "' + after + '" instead of the requested name. setName() on a QE clip is refused when the track is locked, and it renames only the TIMELINE instance — use rename_project_item for the master clip in the bin.'});
      }
      return JSON.stringify({success:true,verified:true,verifiedBy:'qeClip.name readback',changed:before!==after,before:before,after:after,
        note: before === after ? 'The clip already had this name; nothing changed.' : undefined});
    `);
  }

  protected async getProjectStats(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seqs = app.project.sequences;
        var totalClips = 0;
        var durationSecs = 0;
        for (var i=0; i<seqs.numSequences; i++) {
          var seq = seqs[i];
          for (var t=0; t<seq.videoTracks.numTracks; t++) totalClips += seq.videoTracks[t].clips.numItems;
          // seq.end is TICKS, not a Time: .seconds was undefined, so this sum became NaN and
          // serialised as null — the project overview silently reported no duration at all.
          try { var d = __seqEndSeconds(seq); if (d !== null) durationSecs += d; } catch(e) {}
        }
        function countBins(bin) { var c=0; for(var i=0;i<bin.children.numItems;i++){ var ch=bin.children[i]; if(ch.type===2) c+=1+countBins(ch); } return c; }
        var binCount = countBins(app.project.rootItem);
        var itemCount = app.project.rootItem.children.numItems;
        return JSON.stringify({success:true,sequences:seqs.numSequences,totalVideoClips:totalClips,bins:binCount,rootItems:itemCount,totalDurationSecs:Math.round(durationSecs)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getBinTree(includeItems: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        function buildTree(bin) {
          var node = {name:String(bin.name),id:String(bin.nodeId),type:'bin',children:[]};
          for (var i=0; i<bin.children.numItems; i++) {
            var child = bin.children[i];
            if (child.type === 2) { node.children.push(buildTree(child)); }
            else if (${includeItems}) { node.children.push({name:String(child.name),id:String(child.nodeId),type:child.type===4?'sequence':'media'}); }
          }
          return node;
        }
        var tree = buildTree(app.project.rootItem);
        return JSON.stringify({success:true,tree:tree});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getClipInfoExtended(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var root = app.project.rootItem;
        function findById(bin,id){for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null;}
        var item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        var info = {
          projectItemId: String(item.nodeId), name: String(item.name), treePath: String(item.treePath),
          type: item.type, isSequence: item.isSequence(), isAdjustmentLayer: item.isAdjustmentLayer(),
          isMergedClip: item.isMergedClip(), isMulticamClip: item.isMulticamClip(), isOffline: item.isOffline(),
          hasProxy: item.hasProxy(), interpretedTimebase: String(item.interpretedTimebase), sourceTimebase: String(item.sourceTimebase)
        };
        try { info.inPoint = item.getInPoint().seconds; } catch(e){}
        try { info.outPoint = item.getOutPoint().seconds; } catch(e){}
        try { info.originalColorSpace = String(item.getOriginalColorSpace()); } catch(e){}
        try { info.mediaPath = String(item.getMediaPath()); } catch(e){}
        var markers = item.getMarkers(); info.markerCount = markers ? markers.numMarkers : 0;
        return JSON.stringify({success:true,info:info});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async batchRelinkByPattern(oldPrefix: string, newPrefix: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var relinked = []; var failed = [];
        function processItems(bin) {
          for (var i=0; i<bin.children.numItems; i++) {
            var item = bin.children[i];
            if (item.type === 2) { processItems(item); continue; }
            if (item.isOffline()) {
              try {
                var oldPath = String(item.getMediaPath ? item.getMediaPath() : '');
                if (oldPath.indexOf(${JSON.stringify(oldPrefix)}) === 0) {
                  var newPath = ${JSON.stringify(newPrefix)} + oldPath.substring(${oldPrefix.length});
                  item.changeMediaPath(newPath, false);
                  relinked.push({name:String(item.name),oldPath:oldPath,newPath:newPath});
                }
              } catch(e) { failed.push({name:String(item.name),error:e.toString()}); }
            }
          }
        }
        processItems(app.project.rootItem);
        return JSON.stringify({success:true,relinked:relinked.length,failed:failed.length,items:relinked,errors:failed});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setItemPosterFrame(projectItemId: string, timeSecs: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var root = app.project.rootItem;
        function findById(bin,id){for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=findById(c,id);if(r)return r;}}return null;}
        var item = findById(root, ${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({success:false,error:'Item not found'});
        var t = new Time(); t.seconds = ${timeSecs};
        item.setStartTime(t);
        return JSON.stringify({success:true,projectItemId:${JSON.stringify(projectItemId)},posterFrameSecs:${timeSecs}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  // Media Management Implementation
  protected async importMedia(filePath: string, binName?: string, binId?: string): Promise<any> {
    try {
      const result: any = await this.bridge.importMedia(filePath, binName, binId);
      if (!result.success) {
        return {
          ...result,
          filePath: filePath,
        };
      }
      // binName/binId/treePath come from the bridge readback and are spread LAST
      // on purpose: the request's binName used to be written over the response,
      // so a file imported to the root reported the bin that was asked for.
      return {
        success: true,
        message: `Media imported successfully`,
        filePath: filePath,
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maybeModalTimeout = /timeout|timed out/i.test(message);
      return {
        success: false,
        error: `Failed to import media: ${message}`,
        filePath: filePath,
        ...(maybeModalTimeout
          ? {
              warning:
                'Premiere may be showing a blocking modal dialog, such as "File format not supported". Dismiss the dialog in Premiere, then retry. For subtitle files, convert unsupported formats like .ass/.ssa to .srt before importing.',
            }
          : {}),
      };
    }
  }

  protected async importFolder(
    folderPath: string,
    binName?: string,
    recursive = false,
    binId?: string,
  ): Promise<any> {
    const script = `
      try {
        var folder = new Folder(${JSON.stringify(folderPath)});
        var importedItems = [];
        var errors = [];
        
        function importFiles(dir, targetBin) {
          var files = dir.getFiles();
          for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (file instanceof File) {
              try {
                var item = targetBin.importFiles([file.fsName]);
                if (item && item.length > 0) {
                  importedItems.push({
                    name: file.name,
                    path: file.fsName,
                    id: item[0].nodeId
                  });
                }
              } catch (e) {
                errors.push({
                  file: file.name,
                  error: e.toString()
                });
              }
            } else if (file instanceof Folder && ${recursive}) {
              importFiles(file, targetBin);
            }
          }
        }
        
        // Destination resolution is delegated to the shared __resolveBin prelude
        // helper (id > "/"-separated path > deep single name, ambiguity refused).
        // The old local __binByName scanned rootItem.children ONE level deep and
        // matched any child by name, so a bin nested under another bin -- which
        // is what create_bin usually hands back -- was unreachable, and a clip
        // sharing the bin's name could be selected as the destination.
        // A named destination that does not exist yet is created (see __resolveImportBin).
        var __binRequest = __resolveImportBin(${binId !== undefined ? JSON.stringify(binId) : 'null'}, ${binName !== undefined ? JSON.stringify(binName) : 'null'});
        if (__binRequest.error) {
          return JSON.stringify({
            success: false,
            error: __binRequest.error + " Nothing was imported. Omit binName/binId to import to the project root.",
            binName: ${binName !== undefined ? JSON.stringify(binName) : 'null'},
            binId: ${binId !== undefined ? JSON.stringify(binId) : 'null'},
            matchCount: __binRequest.matchCount
          });
        }
        var targetBin = __binRequest.bin;

        importFiles(folder, targetBin);

        return JSON.stringify({
          success: true,
          importedItems: importedItems,
          errors: errors,
          totalImported: importedItems.length,
          totalErrors: errors.length,
          binId: targetBin.nodeId,
          binName: String(targetBin.name),
          binResolvedBy: __binRequest.resolvedBy
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

  protected async createBin(
    name: string,
    parentBinName?: string,
    parentBinId?: string,
  ): Promise<any> {
    const script = `
      try {
        var parentBinName = ${parentBinName !== undefined ? JSON.stringify(parentBinName) : 'null'};
        var parentBinId = ${parentBinId !== undefined ? JSON.stringify(parentBinId) : 'null'};
        var parentBin = app.project.rootItem;
        var resolvedBy = "root";

        // __isBin / __binByPath / __binsByNameDeep now live in the ExtendScript
        // prelude (bridge/index.ts) so the import tools resolve destination bins
        // the same way this does. The branching below stays local because the
        // error wording is create_bin's own ("Nothing was created").

        if (parentBinId !== null) {
          // Unambiguous: resolve the parent bin by nodeId.
          var byId = __findProjectItem(parentBinId);
          if (!byId) {
            return JSON.stringify({ success: false, error: "Parent bin not found by id: " + parentBinId + ". Nothing was created." });
          }
          if (!__isBin(byId)) {
            return JSON.stringify({ success: false, error: "parentBinId does not refer to a bin. Nothing was created." });
          }
          parentBin = byId;
          resolvedBy = "id";
        } else if (parentBinName !== null) {
          if (String(parentBinName).indexOf("/") !== -1) {
            // Path form: walk the hierarchy segment by segment.
            var segs = String(parentBinName).split("/");
            var trimmed = [];
            for (var si = 0; si < segs.length; si++) { if (segs[si] !== "") trimmed.push(segs[si]); }
            var byPath = __binByPath(app.project.rootItem, trimmed);
            if (!byPath) {
              return JSON.stringify({ success: false, error: "Parent bin path not found: " + parentBinName + ". Nothing was created.", parentBinName: parentBinName });
            }
            parentBin = byPath;
            resolvedBy = "path";
          } else {
            // Single name: deep-search, but refuse to guess when it is ambiguous —
            // reparenting to the wrong same-named bin is exactly the silent bug to avoid.
            var matches = __binsByNameDeep(app.project.rootItem, parentBinName, []);
            if (matches.length === 0) {
              return JSON.stringify({ success: false, error: "Parent bin not found: " + parentBinName + ". Nothing was created. Omit parentBinName to create at the project root.", parentBinName: parentBinName });
            }
            if (matches.length > 1) {
              return JSON.stringify({ success: false, error: "Parent bin name '" + parentBinName + "' is ambiguous (" + matches.length + " bins share it). Pass parentBinId, or a '/'-separated path, to disambiguate. Nothing was created.", parentBinName: parentBinName, matchCount: matches.length });
            }
            parentBin = matches[0];
            resolvedBy = "name";
          }
        }

        var newBin = parentBin.createBin(${JSON.stringify(name)});
        // createBin() returns void/undefined on refusal; confirm the bin now exists under
        // the parent before claiming success, instead of reading .nodeId off nothing.
        if (!newBin) {
          var __rescan = null;
          try {
            for (var ri = 0; ri < parentBin.children.numItems; ri++) {
              var __c = parentBin.children[ri];
              if (__c && __isBin(__c) && String(__c.name) === ${JSON.stringify(name)}) { __rescan = __c; break; }
            }
          } catch (eRs) {}
          if (!__rescan) return JSON.stringify({ success: false, verified: false, error: "createBin() returned nothing and no bin named '" + ${JSON.stringify(name)} + "' exists under the parent.", binName: ${JSON.stringify(name)} });
          newBin = __rescan;
        }

        return JSON.stringify({
          success: true,
          verified: true,
          binName: ${JSON.stringify(name)},
          binId: newBin.nodeId,
          parentBinId: parentBin.nodeId,
          parentBin: (resolvedBy === "root") ? "Root" : String(parentBin.name),
          resolvedBy: resolvedBy
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

  protected async renameProjectItem(projectItemId: string, newName: string): Promise<any> {
    const safeName = JSON.stringify(newName);
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var oldName = item.name;
        item.name = ${safeName};
        if (String(item.name) !== ${safeName}) return JSON.stringify({ success: false, verified: false, error: "Premiere did not rename the item (reads back as '" + String(item.name) + "').", oldName: oldName, requested: ${safeName} });
        return JSON.stringify({
          success: true,
          verified: true,
          projectItemId: ${JSON.stringify(projectItemId)},
          oldName: oldName,
          newName: String(item.name)
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  /** Resolve where the footage index JSON lives (arg > env > default under home). */
  private footageIndexPath(indexPath?: string): string {
    if (indexPath && indexPath.trim()) return indexPath.trim();
    const fromEnv = (process.env.PREMIERE_MCP_FOOTAGE_INDEX || '').trim();
    if (fromEnv) return fromEnv;
    return join(homedir(), '.premiere-mcp', 'footage-index.json');
  }

  /**
   * Decide, purely, what a footage rescan must do. Given the entries already in
   * the index and the files just discovered on disk (each with size + mtimeMs),
   * classify every discovered file as unchanged (same path, size and mtime),
   * needs-probe (new or modified), and report which previously-indexed paths are
   * now missing. No I/O, so it is directly unit-testable -- the incremental
   * behaviour (don't re-ffprobe files that haven't changed) is the whole point of
   * an index, and this is where that logic lives.
   */
  private planFootageScan(
    existing: Array<{ path: string; size?: number; mtimeMs?: number }>,
    discovered: Array<{ path: string; size: number; mtimeMs: number }>,
  ): {
    toProbe: Array<{ path: string; size: number; mtimeMs: number }>;
    unchanged: string[];
    missing: string[];
  } {
    const byPath = new Map<string, { path: string; size?: number; mtimeMs?: number }>();
    for (const e of existing) byPath.set(e.path, e);
    const discoveredPaths = new Set(discovered.map((d) => d.path));

    const toProbe: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const unchanged: string[] = [];
    for (const d of discovered) {
      const prev = byPath.get(d.path);
      if (prev && prev.size === d.size && prev.mtimeMs === d.mtimeMs) {
        unchanged.push(d.path);
      } else {
        toProbe.push(d);
      }
    }
    const missing = existing.map((e) => e.path).filter((p) => !discoveredPaths.has(p));
    return { toProbe, unchanged, missing };
  }

  /**
   * Whether a footage index entry matches a set of search criteria. Pure and
   * side-effect-free so search_footage's filtering is unit-testable. All supplied
   * criteria must match (AND); an omitted criterion is ignored.
   */
  private matchFootageEntry(entry: any, criteria: any): boolean {
    if (!entry) return false;
    const s = entry.summary || {};
    const v = s.video || {};
    if (criteria.query) {
      const hay = String(entry.path || '').toLowerCase();
      if (!hay.includes(String(criteria.query).toLowerCase())) return false;
    }
    if (criteria.extension) {
      const want = String(criteria.extension).toLowerCase().replace(/^\./, '');
      const got = (entry.path.split('.').pop() || '').toLowerCase();
      if (got !== want) return false;
    }
    if (criteria.codec) {
      const want = String(criteria.codec).toLowerCase();
      const vc = String(v.codec || '').toLowerCase();
      const ac = String((s.audio || {}).codec || '').toLowerCase();
      if (vc !== want && ac !== want) return false;
    }
    if (
      criteria.minDurationSeconds != null &&
      !(Number(s.durationSeconds) >= criteria.minDurationSeconds)
    )
      return false;
    if (
      criteria.maxDurationSeconds != null &&
      !(Number(s.durationSeconds) <= criteria.maxDurationSeconds)
    )
      return false;
    if (criteria.minWidth != null && !(Number(v.width) >= criteria.minWidth)) return false;
    if (criteria.minHeight != null && !(Number(v.height) >= criteria.minHeight)) return false;
    if (criteria.minFps != null && !(Number(v.fps) >= criteria.minFps)) return false;
    if (criteria.maxFps != null && !(Number(v.fps) <= criteria.maxFps)) return false;
    if (criteria.hasAudio === true && !(s.audioStreamCount > 0)) return false;
    if (criteria.hasAudio === false && s.audioStreamCount > 0) return false;
    if (criteria.hasVideo === true && !(s.videoStreamCount > 0)) return false;
    if (criteria.hasVideo === false && s.videoStreamCount > 0) return false;
    return true;
  }

  /** Pure filter over an array of footage entries; see matchFootageEntry. */
  private queryFootageIndex(entries: any[], criteria: any): any[] {
    return (entries || []).filter((e) => this.matchFootageEntry(e, criteria));
  }

  /** Recursively collect media files under a root, with size + mtime for the scan plan. */
  private async walkMediaFiles(
    root: string,
    recursive: boolean,
    extensions: string[],
  ): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const wanted = new Set(extensions.map((e) => e.toLowerCase().replace(/^\./, '')));
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: any[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir -- skip, don't fail the whole scan
      }
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (recursive && !ent.name.startsWith('.')) await walk(full);
          continue;
        }
        if (!ent.isFile()) continue;
        const ext = (ent.name.split('.').pop() || '').toLowerCase();
        if (!wanted.has(ext)) continue;
        try {
          const st = await fs.stat(full);
          out.push({ path: full, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch {
          /* vanished between readdir and stat -- skip */
        }
      }
    };
    await walk(root);
    return out;
  }

  /**
   * Build or refresh a local, persistent index of media on disk so footage
   * DISCOVERY -- the real bottleneck -- stops requiring the media to be imported
   * into Premiere first. Walks a folder, ffprobes each new or changed file (files
   * whose path + size + mtime already match the index are skipped, so a rescan is
   * cheap), and writes a JSON index. Entirely local (ffprobe + filesystem); makes
   * no Premiere request. Honesty contract: needs ffprobe (returns install
   * guidance if absent) and reports exactly what it scanned, added, updated,
   * skipped, and could not read.
   */
  protected async indexFootage(
    rootPath?: string,
    recursive = true,
    extensions?: string[],
    indexPath?: string,
    pruneMissing = false,
  ): Promise<any> {
    if (!rootPath || !rootPath.trim()) {
      return { success: false, error: 'Provide rootPath -- the folder to scan for media.' };
    }
    if (!isAbsolute(rootPath)) {
      return { success: false, error: `rootPath must be an absolute path. Got: ${rootPath}` };
    }
    try {
      const st = await fs.stat(rootPath);
      if (!st.isDirectory())
        return { success: false, error: `rootPath is not a folder: ${rootPath}` };
    } catch {
      return { success: false, error: `Folder not found or unreadable: ${rootPath}` };
    }

    const ffprobe = this.ffprobeCmd();
    const available = await this.checkCommandAvailable(ffprobe, ['-version']);
    if (!available) {
      return {
        success: false,
        error: `ffprobe ('${ffprobe}') was not found on PATH. index_footage reads media metadata with ffprobe, which ships with ffmpeg. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFPROBE_CMD to the binary name, then try again.`,
      };
    }

    const resolvedIndexPath = this.footageIndexPath(indexPath);
    const exts =
      extensions && extensions.length ? extensions : ProjectMediaTools.FOOTAGE_EXTENSIONS;

    // Load the existing index (tolerate absence / corruption -- start fresh).
    let existingEntries: any[] = [];
    try {
      const raw = await fs.readFile(resolvedIndexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.entries)) existingEntries = parsed.entries;
    } catch {
      /* no usable prior index */
    }

    const discovered = await this.walkMediaFiles(rootPath, recursive, exts);
    const plan = this.planFootageScan(existingEntries, discovered);

    // Probe the new/changed files.
    const byPath = new Map<string, any>(existingEntries.map((e) => [e.path, e]));
    const errors: Array<{ path: string; error: string }> = [];
    let added = 0;
    let updated = 0;
    for (const file of plan.toProbe) {
      const probe = await this.ffprobeFile(file.path, ffprobe);
      if (!probe.success) {
        errors.push({ path: file.path, error: probe.error || 'ffprobe failed' });
        continue;
      }
      const wasPresent = byPath.has(file.path);
      byPath.set(file.path, {
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        summary: probe.summary,
      });
      if (wasPresent) updated += 1;
      else added += 1;
    }

    // Optionally drop entries whose files are gone; otherwise keep them.
    let pruned = 0;
    if (pruneMissing) {
      for (const p of plan.missing) {
        if (byPath.delete(p)) pruned += 1;
      }
    }

    const mergedEntries = Array.from(byPath.values()).sort((a, b) =>
      String(a.path).localeCompare(String(b.path)),
    );
    const indexDoc = {
      version: 1,
      root: rootPath,
      entryCount: mergedEntries.length,
      entries: mergedEntries,
    };

    // Write the index (verify-after-write: read it back and confirm the count).
    try {
      await fs.mkdir(dirname(resolvedIndexPath), { recursive: true });
      const tmp = `${resolvedIndexPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(indexDoc, null, 2), 'utf8');
      await fs.rename(tmp, resolvedIndexPath);
      const back = JSON.parse(await fs.readFile(resolvedIndexPath, 'utf8'));
      if (!Array.isArray(back?.entries) || back.entries.length !== mergedEntries.length) {
        return {
          success: false,
          error:
            'Wrote the footage index but read-back did not match. The index may be on a full or read-only disk.',
          indexPath: resolvedIndexPath,
        };
      }
    } catch (e) {
      return {
        success: false,
        error: `Could not write the footage index at ${resolvedIndexPath}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return {
      success: true,
      indexPath: resolvedIndexPath,
      root: rootPath,
      scanned: discovered.length,
      added,
      updated,
      unchanged: plan.unchanged.length,
      missing: plan.missing.length,
      pruned,
      probeErrors: errors.length,
      errors: errors.slice(0, 20),
      totalIndexed: mergedEntries.length,
      note: pruneMissing
        ? 'Rescan complete. Entries for files no longer on disk were pruned. Query it with search_footage.'
        : `Rescan complete. ${plan.missing.length} previously-indexed file(s) were not found on disk this pass but were KEPT (pass pruneMissing=true to drop them). Query it with search_footage.`,
    };
  }

  /**
   * Query the local footage index built by index_footage. Read-only, entirely
   * local -- no Premiere request. Filters by filename substring, extension,
   * codec, duration/resolution/fps ranges, and audio/video presence. Returns
   * matches (path + distilled technical summary) so an agent can FIND the right
   * footage before importing it.
   */
  protected async searchFootage(criteria: any = {}, indexPath?: string, limit = 100): Promise<any> {
    const resolvedIndexPath = this.footageIndexPath(indexPath);
    let doc: any;
    try {
      doc = JSON.parse(await fs.readFile(resolvedIndexPath, 'utf8'));
    } catch {
      return {
        success: false,
        error: `No footage index found at ${resolvedIndexPath}. Build one first with index_footage (pass the folder as rootPath), or point indexPath / PREMIERE_MCP_FOOTAGE_INDEX at an existing index.`,
      };
    }
    const entries: any[] = Array.isArray(doc?.entries) ? doc.entries : [];
    const matches = this.queryFootageIndex(entries, criteria);
    const capped = matches.slice(0, Math.max(0, limit));
    return {
      success: true,
      indexPath: resolvedIndexPath,
      totalIndexed: entries.length,
      matchCount: matches.length,
      returned: capped.length,
      truncated: matches.length > capped.length,
      results: capped,
    };
  }

  protected async enableDisableClip(clipId: string, enabled: boolean): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        info.clip.disabled = ${!enabled};
        var nowEnabled = !info.clip.disabled;
        if (nowEnabled !== ${enabled}) return JSON.stringify({ success: false, verified: false, error: "Premiere did not change the clip's enabled state (still reads " + (nowEnabled ? "enabled" : "disabled") + ")." });
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Clip " + (${enabled} ? "enabled" : "disabled")
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async getClipProperties(clipId: string, sequenceId?: string): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)}, ${sequenceId ? JSON.stringify(sequenceId) : 'null'});
        if (!info) return JSON.stringify({ success: false, error: ${sequenceId ? JSON.stringify(`Clip not found in sequence: ${sequenceId}`) : '"Clip not found"'} });
        var clip = info.clip;

        // Read back Motion (opacity/scale/rotation/position). Position is stored NORMALIZED
        // (0..1); expose both the raw normalized value and PIXELS (using the sequence frame size)
        // so callers can verify/copy framing without exporting a frame. Only present for video clips.
        var __seqW = 1920, __seqH = 1080;
        try {
          if (info.sequence) {
            if (info.sequence.frameSizeHorizontal) { __seqW = info.sequence.frameSizeHorizontal; __seqH = info.sequence.frameSizeVertical; }
            else { var __ss = info.sequence.getSettings(); if (__ss) { __seqW = __ss.videoFrameWidth; __seqH = __ss.videoFrameHeight; } }
          }
        } catch (e0) {}
        var motion = null;
        try {
          var m = {};
          for (var ci = 0; ci < clip.components.numItems; ci++) {
            var comp = clip.components[ci];
            for (var pj = 0; pj < comp.properties.numItems; pj++) {
              var pp = comp.properties[pj];
              try {
                if (pp.displayName === "Opacity") m.opacity = pp.getValue();
                else if (pp.displayName === "Scale") m.scale = pp.getValue();
                else if (pp.displayName === "Rotation") m.rotation = pp.getValue();
                else if (pp.displayName === "Position") {
                  var pv = pp.getValue();
                  if (pv && pv.length >= 2) {
                    m.positionNormalized = { x: pv[0], y: pv[1] };
                    m.position = { x: Math.round(pv[0] * __seqW * 1000) / 1000, y: Math.round(pv[1] * __seqH * 1000) / 1000 };
                  }
                }
              } catch (ep) {}
            }
          }
          motion = m;
        } catch (em) { motion = null; }

        return JSON.stringify({
          success: true,
          properties: {
            name: clip.name,
            start: clip.start.seconds,
            end: clip.end.seconds,
            duration: clip.duration.seconds,
            inPoint: clip.inPoint.seconds,
            outPoint: clip.outPoint.seconds,
            enabled: !clip.disabled,
            trackIndex: info.trackIndex,
            trackType: info.trackType,
            sequenceId: info.sequenceId,
            sequenceName: info.sequenceName,
            frameSize: { width: __seqW, height: __seqH },
            motion: motion,
            speed: clip.getSpeed()
          }
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

  protected async setClipProperties(clipId: string, properties: any): Promise<any> {
    // Position is the Motion "Position" property. Callers pass PIXEL coordinates matching the
    // Effect Controls panel (e.g. 960,756 in a 1920x1280 sequence); the API stores it as a
    // NORMALIZED [x,y] (0..1, 0.5,0.5 = frame center), so we divide by the sequence frame size
    // (__seqW/__seqH). Per-property flags surface a silently-failed setValue or a missing Motion
    // property instead of reporting a blanket success.
    const spec = {
      opacity: properties?.opacity === undefined ? null : properties.opacity,
      scale: properties?.scale === undefined ? null : properties.scale,
      rotation: properties?.rotation === undefined ? null : properties.rotation,
      posX: properties?.position?.x === undefined ? null : properties.position.x,
      posY: properties?.position?.y === undefined ? null : properties.position.y,
    };
    const script = `
      try {
        var it = ${JSON.stringify(spec)};
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        // Sequence frame size, for converting Position pixels -> normalized. Try frameSize props
        // first, then getSettings(); fall back to 1920x1080 if neither is available.
        var __seqW = 1920, __seqH = 1080;
        try {
          if (info.sequence) {
            if (info.sequence.frameSizeHorizontal) { __seqW = info.sequence.frameSizeHorizontal; __seqH = info.sequence.frameSizeVertical; }
            else { var __ss = info.sequence.getSettings(); if (__ss) { __seqW = __ss.videoFrameWidth; __seqH = __ss.videoFrameHeight; } }
          }
        } catch (e0) {}
        var want = { opacity: it.opacity !== null, scale: it.scale !== null, rotation: it.rotation !== null, position: (it.posX !== null || it.posY !== null) };
        // done = the property was found AND the readback confirms the requested value applied.
        // setValue() can silently no-op, so a found+set property is not enough; re-read getValue().
        var done = { opacity: false, scale: false, rotation: false, position: false };
        var __scalarTol = 0.5, __posTol = 0.01;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          for (var j = 0; j < comp.properties.numItems; j++) {
            var p = comp.properties[j];
            try {
              if (want.opacity && p.displayName === "Opacity") { p.setValue(it.opacity, true); var __ro = p.getValue(); done.opacity = (Math.abs(Number(__ro) - it.opacity) <= __scalarTol); }
              if (want.scale && p.displayName === "Scale") { p.setValue(it.scale, true); var __rs = p.getValue(); done.scale = (Math.abs(Number(__rs) - it.scale) <= __scalarTol); }
              if (want.rotation && p.displayName === "Rotation") { p.setValue(it.rotation, true); var __rr = p.getValue(); done.rotation = (Math.abs(Number(__rr) - it.rotation) <= __scalarTol); }
              if (want.position && p.displayName === "Position") {
                var __cur = [0.5, 0.5];
                try { __cur = p.getValue(); } catch (ep) {}
                var __nx = it.posX !== null ? (it.posX / __seqW) : __cur[0];
                var __ny = it.posY !== null ? (it.posY / __seqH) : __cur[1];
                p.setValue([__nx, __ny], true);
                var __rp = [0.5, 0.5];
                try { __rp = p.getValue(); } catch (ep2) {}
                done.position = (Math.abs(Number(__rp[0]) - __nx) <= __posTol && Math.abs(Number(__rp[1]) - __ny) <= __posTol);
              }
            } catch (e2) {}
          }
        }
        var missing = [];
        if (want.opacity && !done.opacity) missing.push("opacity");
        if (want.scale && !done.scale) missing.push("scale");
        if (want.rotation && !done.rotation) missing.push("rotation");
        if (want.position && !done.position) missing.push("position");
        return JSON.stringify({
          success: (missing.length === 0),
          verified: (missing.length === 0),
          applied: done,
          message: missing.length ? ("properties did not apply (readback mismatch or missing): " + missing.join(", ")) : "Clip properties updated"
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected findItemById(id: string): string {
    return `(function(){function f(b,id){for(var i=0;i<b.children.numItems;i++){var c=b.children[i];if(c.nodeId===id)return c;if(c.type===2){var r=f(c,id);if(r)return r;}}return null;}return f(app.project.rootItem,${JSON.stringify(id)});})()`;
  }

  protected async findUnusedSequences(): Promise<any> {
    // ExtendScript is ES3: no Set/Map. Uses a plain object as a string-key lookup.
    return await this.bridge.executeScript(`
      try {
        var seqs=app.project.sequences;
        var usedIds={};
        for(var j=0;j<seqs.numSequences;j++){
          var seq=seqs[j];
          for(var t=0;t<seq.videoTracks.numTracks;t++){
            for(var c=0;c<seq.videoTracks[t].clips.numItems;c++){
              var clip=seq.videoTracks[t].clips[c];
              if(clip.projectItem&&clip.projectItem.isSequence())usedIds['k'+String(clip.projectItem.nodeId)]=true;
            }
          }
        }
        var unused=[];
        for(var k=0;k<seqs.numSequences;k++){
          var s=seqs[k];
          var key='k'+String(s.projectItem?s.projectItem.nodeId:s.sequenceID);
          if(!usedIds[key])unused.push({name:String(s.name),id:String(s.sequenceID)});
        }
        return JSON.stringify({success:true,totalSequences:seqs.numSequences,unusedCount:unused.length,unusedSequences:unused});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async batchEnableDisableClips(
    trackIndex: number,
    enabled: boolean,
    startSecs?: number,
    endSecs?: number,
    seqId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var track=seq.videoTracks[${trackIndex}];if(!track)return JSON.stringify({success:false,error:'Track not found'});
        var count=0;
        for(var c=0;c<track.clips.numItems;c++){
          var clip=track.clips[c];
          var inRange=${startSecs !== undefined} ? (clip.start.seconds>=${startSecs ?? 0}&&clip.end.seconds<=${endSecs ?? 999999}) : true;
          if(inRange){clip.disabled=${!enabled};count++;}
        }
        return JSON.stringify({success:true,clipsUpdated:count,enabled:${enabled}});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async getProjectItemInfoExtended(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item=${this.findItemById(projectItemId)};
        if(!item)return JSON.stringify({success:false,error:'Item not found'});
        var info={success:true,name:String(item.name),nodeId:String(item.nodeId),treePath:String(item.treePath),type:item.type};
        try{info.mediaPath=String(item.getMediaPath());}catch(e){}
        try{var ip=item.getInPoint();info.inPointSecs=ip.seconds;}catch(e){}
        try{var op=item.getOutPoint();info.outPointSecs=op.seconds;info.durationSecs=op.seconds-(info.inPointSecs||0);}catch(e){}
        try{info.embeddedLUTID=String(item.getEmbeddedLUTID());}catch(e){}
        try{info.proxyPath=item.getProxyPath?String(item.getProxyPath()):'none';}catch(e){}
        try{var cs=item.getOriginalColorSpace();info.originalColorSpace=String(cs);}catch(e){}
        try{var ms=item.getMarkers();info.markerCount=ms?ms.numMarkers:0;}catch(e){}
        try{info.isOffline=item.isOffline();info.isMergedClip=item.isMergedClip();info.isMulticamClip=item.isMulticamClip();}catch(e){}
        return JSON.stringify(info);
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async verifyMediaOnline(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item=${this.findItemById(projectItemId)};
        if(!item)return JSON.stringify({success:false,error:'Item not found'});
        var isOffline=item.isOffline();
        var path='';try{path=String(item.getMediaPath());}catch(e){}
        var fileExists=false;try{fileExists=(new File(path)).exists;}catch(e){}
        return JSON.stringify({success:true,isOffline:isOffline,fileExists:fileExists,path:path,online:!isOffline&&fileExists});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  /**
   * The bin lookup used to end in `findBin(...) || app.project.rootItem`, so a name that did
   * not resolve walked the WHOLE PROJECT and returned success:true with a count. There is no
   * way for a caller to tell 40 items in one shot bin from 4,000 items in the project, which
   * makes it worse than an error. Routed through the shared __resolveBin prelude helper, which
   * accepts an id, a "/"-separated path or a deep-searched name and refuses rather than guessing.
   */
  protected async getBinContentsRecursive(binName?: string, binId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var req=__resolveBin(${JSON.stringify(binId ?? null)},${JSON.stringify(binName ?? null)});
        if(req.error)return JSON.stringify({success:false,error:req.error+' Nothing was read. Omit binName/binId to list the whole project.',binName:${JSON.stringify(binName ?? null)},binId:${JSON.stringify(binId ?? null)},matchCount:req.matchCount});
        var startBin=req.bin;
        var items=[];
        function walk(bin){for(var i=0;i<bin.children.numItems;i++){var c=bin.children[i];if(__isBin(c))walk(c);else items.push({name:String(c.name),nodeId:String(c.nodeId),treePath:String(c.treePath),type:c.type});}}
        walk(startBin);
        var scope=null;try{scope=String(startBin.treePath);}catch(eScope){}
        return JSON.stringify({success:true,count:items.length,items:items,
          binId:String(startBin.nodeId),binName:String(startBin.name),binResolvedBy:req.resolvedBy,scope:scope});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async batchRelinkByPrefix(oldPrefix: string, newPrefix: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var relinked=0,failed=0;
        function walk(bin){
          for(var i=0;i<bin.children.numItems;i++){
            var c=bin.children[i];
            if(c.type===2){walk(c);continue;}
            if(!c.isOffline())continue;
            var path='';try{path=String(c.getMediaPath());}catch(e){continue;}
            if(path.indexOf(${JSON.stringify(oldPrefix)})===0){
              var newPath=path.replace(${JSON.stringify(oldPrefix)},${JSON.stringify(newPrefix)});
              try{c.changeMediaPath(newPath,false);relinked++;}catch(er){failed++;}
            }
          }
        }
        walk(app.project.rootItem);
        return JSON.stringify({success:true,relinked:relinked,failed:failed});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async setInterpretationFrameRate(
    projectItemId: string,
    frameRate: number,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item=${this.findItemById(projectItemId)};
        if(!item)return JSON.stringify({success:false,error:'Item not found'});
        var before = null;
        try { before = Number(item.getFootageInterpretation().frameRate); } catch(eB) {}
        item.setOverrideFrameRate(${frameRate});
        var after = null;
        try { after = Number(item.getFootageInterpretation().frameRate); } catch(eA) {}
        if (after === null || isNaN(after)) {
          return JSON.stringify({success:true,verified:false,frameRate:${frameRate},before:before,itemName:String(item.name),
            unverifiedReason:'setOverrideFrameRate() did not throw, but getFootageInterpretation().frameRate is not readable for this item, so the override cannot be confirmed. Read it with get_footage_interpretation.'});
        }
        if (Math.abs(after - ${frameRate}) > 0.001) {
          return JSON.stringify({success:false,verified:true,verifiedBy:'getFootageInterpretation().frameRate readback',changed:before!==after,frameRate:${frameRate},before:before,after:after,itemName:String(item.name),
            error:'The item still interprets at ' + after + ' fps instead of the requested ${frameRate}. Premiere refuses a frame-rate override on media whose native rate it cannot reinterpret, and on sequences.'});
        }
        return JSON.stringify({success:true,verified:true,verifiedBy:'getFootageInterpretation().frameRate readback',changed:before!==after,frameRate:${frameRate},before:before,after:after,itemName:String(item.name),
          note: before === after ? 'The item already interpreted at this frame rate; nothing changed.' : undefined});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async getItemXmpMetadata(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item=${this.findItemById(projectItemId)};
        if(!item)return JSON.stringify({success:false,error:'Item not found'});
        var xmp=item.getXMPMetadata();
        return JSON.stringify({success:true,length:xmp?xmp.length:0,xmp:xmp?String(xmp).slice(0,2000):'null'});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async projectMediaReport(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var codecs={},fpss={},ress={},offline=0,total=0,totalDur=0;
        function walk(bin){
          for(var i=0;i<bin.children.numItems;i++){
            var c=bin.children[i];if(c.type===2){walk(c);continue;}
            total++;if(c.isOffline())offline++;
            try{var ip=c.getInPoint(),op=c.getOutPoint();totalDur+=op.seconds-ip.seconds;}catch(e){}
          }
        }
        walk(app.project.rootItem);
        return JSON.stringify({success:true,totalItems:total,offlineItems:offline,onlineItems:total-offline,totalDurationSecs:Math.round(totalDur)});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async getProjectPanelSelection(viewId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var sel;
        var usedView = ${viewId ? JSON.stringify(viewId) : 'null'};
        if (usedView) { sel = app.getProjectViewSelection(usedView); }
        else { sel = app.getCurrentProjectViewSelection(); }
        var items = [];
        if (sel) for (var i = 0; i < sel.length; i++) {
          var it = sel[i];
          var e = { name: String(it.name), nodeId: String(it.nodeId) };
          try { e.treePath = String(it.treePath); } catch(x) {}
          try { e.isSequence = it.isSequence(); } catch(x) {}
          items.push(e);
        }
        return JSON.stringify({ success: true, viewId: usedView, count: items.length, items: items,
          note: 'This is the PROJECT PANEL selection. For the timeline selection use get_sequence_selection.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async setProjectPanelSelection(
    projectItemIds: string[],
    viewId?: string,
  ): Promise<any> {
    const ids = JSON.stringify(Array.isArray(projectItemIds) ? projectItemIds : []);
    return await this.bridge.executeScript(`
      try {
        var wanted = ${ids};
        if (!wanted.length) return JSON.stringify({ success: false, error: 'projectItemIds was empty' });
        function findById(bin, id) {
          for (var i = 0; i < bin.children.numItems; i++) {
            var c = bin.children[i];
            if (String(c.nodeId) === id) return c;
            if (c.type === 2) { var r = findById(c, id); if (r) return r; }
          }
          return null;
        }
        var found = [], missing = [];
        for (var i = 0; i < wanted.length; i++) {
          var it = findById(app.project.rootItem, String(wanted[i]));
          if (it) found.push(it); else missing.push(String(wanted[i]));
        }
        if (!found.length) return JSON.stringify({ success: false, error: 'None of the given nodeIds were found', missing: missing });
        var usedView = ${viewId ? JSON.stringify(viewId) : 'null'};
        if (usedView) { app.setProjectViewSelection(found, usedView); }
        else {
          var ids = app.getProjectViewIDs();
          if (!ids || !ids.length) return JSON.stringify({ success: false, error: 'No project view available to select in' });
          app.setProjectViewSelection(found, String(ids[0]));
          usedView = String(ids[0]);
        }
        var after = app.getProjectViewSelection(usedView);
        var afterCount = after ? after.length : 0;
        // The old comparison was against what we managed to RESOLVE, so a request naming five
        // items of which two existed reported a verified success for two. Compare against what
        // was asked for, and name the ids that were not found.
        var full = afterCount === wanted.length && missing.length === 0;
        if (!full) {
          return JSON.stringify({ success: false, verified: true, verifiedBy: 'app.getProjectViewSelection() readback',
            requested: wanted.length, resolved: found.length, selectedAfter: afterCount,
            missing: missing, viewId: usedView,
            error: missing.length
              ? ('Selected ' + afterCount + ' of ' + wanted.length + ' requested items. These nodeIds are not in this project: ' + missing.join(', ') + '.')
              : ('The project view reports ' + afterCount + ' items selected after being handed ' + found.length + '. A view that is not showing an item cannot select it — try a different viewId from get_all_project_paths.') });
        }
        return JSON.stringify({ success: true, verified: true, verifiedBy: 'app.getProjectViewSelection() readback',
          requested: wanted.length, resolved: found.length, selectedAfter: afterCount,
          missing: missing, viewId: usedView });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getProjectPanelColumns(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var blob = app.project.getProjectPanelMetadata();
        var str = blob === null || blob === undefined ? null : String(blob);
        return JSON.stringify({ success: true, length: str ? str.length : 0, metadata: str,
          note: 'PROJECT-level panel metadata (column layout). Distinct from get_project_panel_metadata, which reads a single ITEM.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async setProjectPanelColumns(metadata: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var before = '';
        try { before = String(app.project.getProjectPanelMetadata()); } catch(eb) {}
        app.project.setProjectPanelMetadata(${JSON.stringify(metadata)});
        var after = '';
        try { after = String(app.project.getProjectPanelMetadata()); } catch(ea) {}
        return JSON.stringify({ success: true, verified: after !== before, changed: after !== before,
          note: after === before ? 'The blob read back unchanged: the write may have been rejected.' : undefined });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getClipFlags(
    trackIndex: number,
    clipIndex: number,
    seqId?: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(seqId)};
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var track = seq.videoTracks[${trackIndex}];
        if (!track) return JSON.stringify({ success: false, error: 'Video track ${trackIndex} not found' });
        var clip = track.clips[${clipIndex}];
        if (!clip) return JSON.stringify({ success: false, error: 'Clip ${clipIndex} not found on that track' });
        var o = { success: true, name: String(clip.name) };
        try { o.isSpeedReversed = clip.isSpeedReversed(); } catch(e1) {}
        try { o.parentTrackIndex = clip.parentTrackIndex; } catch(e2) {}
        try { o.isSelected = clip.isSelected(); } catch(e3) {}
        try { o.isAdjustmentLayer = clip.isAdjustmentLayer(); } catch(e4) {}
        try { o.isMGT = clip.isMGT(); } catch(e5) {}
        try { o.disabled = clip.disabled; } catch(e6) {}
        try { o.mediaType = String(clip.mediaType); } catch(e7) {}
        try { o.matchName = String(clip.matchName); } catch(e8) {}
        try { o.speed = clip.getSpeed(); } catch(e9) {}
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async setItemPixelAspectRatio(
    projectItemId: string,
    numerator: number,
    denominator: number,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item = ${this.findItemById(projectItemId)};
        if (!item) return JSON.stringify({ success: false, error: 'Project item not found' });
        item.setOverridePixelAspectRatio(${numerator}, ${denominator});
        return JSON.stringify({ success: true, verified: false, numerator: ${numerator}, denominator: ${denominator},
          note: 'No getter exists for the PAR override, so the value could not be read back. Use get_footage_interpretation to inspect interpretation.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async findItemsMatchingMediaPathTool(
    pathSubstring: string,
    ignoreSubclips: boolean,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var matches = app.project.rootItem.findItemsMatchingMediaPath(${JSON.stringify(pathSubstring)}, ${ignoreSubclips ? 1 : 0});
        var out = [];
        if (matches) for (var i = 0; i < matches.length; i++) {
          var m = matches[i];
          var e = { name: String(m.name), nodeId: String(m.nodeId) };
          try { e.mediaPath = String(m.getMediaPath()); } catch(x) {}
          try { e.treePath = String(m.treePath); } catch(x) {}
          out.push(e);
        }
        return JSON.stringify({ success: true, pathSubstring: ${JSON.stringify(pathSubstring)}, count: out.length, items: out });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getItemVideoComponents(projectItemId: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var item = ${this.findItemById(projectItemId)};
        if (!item) return JSON.stringify({ success: false, error: 'Project item not found' });
        var coll = item.videoComponents();
        if (!coll) return JSON.stringify({ success: true, count: 0, components: [], note: 'videoComponents() returned nothing for this item.' });
        var n = 0;
        try { n = coll.numItems; } catch(x) {}
        var comps = [];
        for (var i = 0; i < n; i++) {
          var c = coll[i];
          if (!c) continue;
          var e = {};
          try { e.displayName = String(c.displayName); } catch(x) {}
          try { e.matchName = String(c.matchName); } catch(x) {}
          try { e.instanceName = String(c.instanceName); } catch(x) {}
          comps.push(e);
        }
        return JSON.stringify({ success: true, count: comps.length, components: comps,
          note: 'These are MASTER CLIP effects on the project item, which apply everywhere the item is used — distinct from the per-timeline-clip effects list_clip_effects reports.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getQeProjectInfo(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var o = { success: true };
        try { o.sizeOnDiskBytes = String(qe.project.sizeOnDisk()); } catch(e1) { o.sizeError = e1.toString(); }
        try { o.undoStackIndex = qe.project.undoStackIndex(); } catch(e2) { o.undoError = e2.toString(); }
        try { o.remainingMetadataCacheIndexCount = qe.project.getRemainingMetadataCacheIndexCount(); } catch(e3) { o.metaCacheError = e3.toString(); }
        try { var b = qe.project.getBinAt(0); o.firstBinType = b ? String(b.reflect.name) : null; } catch(e4) { o.firstBinError = e4.toString(); }
        try { var si = qe.project.getSequenceItemAt(0); o.firstSequenceItem = si ? String(si.name) : null; } catch(e5) { o.seqItemError = e5.toString(); }
        try {
          // Round-trip a known nodeId through findItemByID so callers know whether QE
          // id lookup works on this build before relying on it.
          var probeId = null;
          var root = app.project.rootItem;
          if (root.children.numItems > 0) probeId = String(root.children[0].nodeId);
          if (probeId) {
            var byId = qe.project.findItemByID(probeId);
            o.findItemByIdWorks = byId ? true : false;
            o.findItemByIdSample = byId ? String(byId.name) : null;
          }
        } catch(e6) { o.findItemByIdError = e6.toString(); }
        o.note = 'remainingMetadataCacheIndexCount > 0 means Premiere is still indexing media, which can explain sluggish behaviour.';
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async createBinQe(name: string, smart: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var before = app.project.rootItem.children.numItems;
        var r = ${smart} ? qe.project.newSmartBin(${JSON.stringify(name)}, '') : qe.project.newBin(${JSON.stringify(name)});
        var after = app.project.rootItem.children.numItems;
        if (after <= before) {
          return JSON.stringify({ success: false, verified: false,
            error: (${smart} ? 'newSmartBin' : 'newBin') + '() returned ' + String(r) + ' but the root item count did not increase.',
            before: before, after: after });
        }
        return JSON.stringify({ success: true, verified: true, name: ${JSON.stringify(name)}, smart: ${smart}, before: before, after: after });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async importMediaQe(filePath: string, numberedStills: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var f = new File(${JSON.stringify(filePath)});
        if (!f.exists) return JSON.stringify({ success: false, error: 'File does not exist: ' + ${JSON.stringify(filePath)} });
        var before = app.project.rootItem.children.numItems;
        var r = qe.project.import(${JSON.stringify(filePath)}, ${numberedStills});
        var after = app.project.rootItem.children.numItems;
        if (after <= before) {
          return JSON.stringify({ success: false, verified: false,
            error: 'qe.project.import() returned ' + String(r) + ' but no new project item appeared.',
            before: before, after: after });
        }
        return JSON.stringify({ success: true, verified: true, filePath: ${JSON.stringify(filePath)},
          numberedStills: ${numberedStills}, itemsAdded: after - before });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getMediaProcessingStatus(trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var track = seq.getVideoTrackAt(${trackIndex});
        var clip = track && __qeClipByIndex(seq, 'video', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({ success: false, error: 'QE clip not found at track ${trackIndex} clip ${clipIndex}' });
        var pi = clip.getProjectItem();
        if (!pi) return JSON.stringify({ success: false, error: 'getProjectItem() returned nothing' });
        var o = { success: true };
        try { o.name = String(pi.name); } catch(x) {}
        try { o.isIndexing = pi.isIndexing(); } catch(x) { o.isIndexingError = String(x); }
        try { o.isAudioConforming = pi.isAudioConforming(); } catch(x) {}
        try { o.isAudioPeakGenerating = pi.isAudioPeakGenerating(); } catch(x) {}
        try { o.isPending = pi.isPending(); } catch(x) {}
        try { o.isOffline = pi.isOffline(); } catch(x) {}
        try { o.containsSpeechTrack = pi.containsSpeechTrack(); } catch(x) {}
        try { o.metadataSize = pi.getMetadataSize(); } catch(x) {}
        var busy = (o.isIndexing === true) || (o.isAudioConforming === true) || (o.isAudioPeakGenerating === true) || (o.isPending === true);
        o.stillProcessing = busy;
        o.note = busy
          ? 'Premiere is still processing this media (indexing/conforming/peaks). Sluggish playback now is expected and should improve when it finishes.'
          : 'No background processing in progress for this item.';
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async linkMediaQe(
    trackIndex: number,
    clipIndex: number,
    mediaPath: string,
    renameClip: boolean,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var f = new File(${JSON.stringify(mediaPath)});
        if (!f.exists) return JSON.stringify({ success: false, error: 'Media file does not exist: ' + ${JSON.stringify(mediaPath)} });
        var seq = qe.project.getActiveSequence();
        var track = seq && seq.getVideoTrackAt(${trackIndex});
        var clip = track && __qeClipByIndex(seq, 'video', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({ success: false, error: 'QE clip not found' });
        var pi = clip.getProjectItem();
        if (!pi) return JSON.stringify({ success: false, error: 'getProjectItem() returned nothing' });
        var offlineBefore = null;
        try { offlineBefore = pi.isOffline(); } catch(x) {}
        pi.linkMedia(${JSON.stringify(mediaPath)}, ${renameClip});
        var offlineAfter = null;
        try { offlineAfter = pi.isOffline(); } catch(x) {}
        return JSON.stringify({ success: true, verified: offlineAfter === false,
          mediaPath: ${JSON.stringify(mediaPath)}, offlineBefore: offlineBefore, offlineAfter: offlineAfter,
          note: offlineAfter === false ? undefined : 'Item still reports offline after linkMedia(); the path may not match the expected media.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async createProxyQe(
    trackIndex: number,
    clipIndex: number,
    presetPath: string,
  ): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var f = new File(${JSON.stringify(presetPath)});
        if (!f.exists) return JSON.stringify({ success: false, error: 'Preset file does not exist: ' + ${JSON.stringify(presetPath)} });
        var seq = qe.project.getActiveSequence();
        var track = seq && seq.getVideoTrackAt(${trackIndex});
        var clip = track && __qeClipByIndex(seq, 'video', ${trackIndex}, ${clipIndex});
        if (!clip) return JSON.stringify({ success: false, error: 'QE clip not found' });
        var pi = clip.getProjectItem();
        if (!pi) return JSON.stringify({ success: false, error: 'getProjectItem() returned nothing' });
        var r = pi.createProxy(${JSON.stringify(presetPath)}, '');
        var proxiesOn = null;
        try { proxiesOn = app.getEnableProxies() === true; } catch(x) {}
        return JSON.stringify({ success: true, verified: false, dispatched: String(r),
          proxyPlaybackEnabled: proxiesOn,
          note: proxiesOn
            ? 'Proxy creation dispatched to Media Encoder. Proxy playback is already enabled.'
            : 'Proxy creation dispatched, but proxy PLAYBACK is currently OFF — call set_proxies_enabled(true) or the finished proxy will be ignored.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getProxyStatus(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var clips=[];
        for(var t=0;t<seq.videoTracks.numTracks;t++){
          for(var c=0;c<seq.videoTracks[t].clips.numItems;c++){
            var clip=seq.videoTracks[t].clips[c];
            var item=clip.projectItem;
            var hasProxy=false,proxyPath='';
            try{hasProxy=item.hasProxy();proxyPath=hasProxy?String(item.getProxyPath()):'none';}catch(e){}
            clips.push({name:String(clip.name),trackIndex:t,clipIndex:c,hasProxy:hasProxy,proxyPath:proxyPath});
          }
        }
        return JSON.stringify({success:true,clipCount:clips.length,clips:clips});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  /**
   * Is a Premiere process running at all, independent of the bridge?
   *
   * Needed because "the bridge did not answer" has two very different meanings: Premiere is closed
   * (so no project can be open, and file surgery is safe), or Premiere is running with a wedged
   * panel (so a project may well be open and surgery is not safe). Matching on the process NAME via
   * `ps -Ao comm=` rather than the full command line is deliberate — a `pgrep -f "Adobe Premiere
   * Pro"` would also match a harness or editor whose own command line mentions it, and a false
   * "running" here blocks legitimate work on archived projects.
   *
   * Returns null when it cannot tell, which callers must treat as "running".
   */
  private premiereProcessRunning(): boolean | null {
    try {
      if (process.platform === 'win32') {
        const out = execSync('tasklist /FO CSV /NH', {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        });
        return /"Adobe Premiere Pro[^"]*\.exe"/i.test(out);
      }
      const out = execSync('ps -Ao comm=', { encoding: 'utf8', timeout: 10000 });
      return out.split('\n').some((line) => {
        const name = line.trim().split('/').pop() || '';
        return /^Adobe Premiere Pro\b/i.test(name);
      });
    } catch {
      return null;
    }
  }

  /**
   * Invariant 2. Which project files does Premiere currently have open?
   *
   * `known: false` means the answer is unavailable and the caller must refuse — the point of the
   * invariant is that it is decided by measurement, never by the caller asserting Premiere is closed.
   * A self-certification argument here would be the same defect as the guard that let a name stand
   * in for an identity and cost a 111-sequence cut.
   */
  private async openProjectRealpaths(): Promise<{
    known: boolean;
    realpaths: string[];
    reason?: string;
    source: string;
  }> {
    let probe: any = null;
    try {
      probe = await this.bridge.executeScript(`
        try {
          var out = [];
          if (app.projects) {
            for (var i = 0; i < app.projects.numProjects; i++) out.push(String(app.projects[i].path || ''));
          }
          return JSON.stringify({ success: true, paths: out });
        } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
      `);
    } catch (e: any) {
      probe = { success: false, error: e?.message || String(e) };
    }

    if (probe && probe.success !== false && Array.isArray(probe.paths)) {
      const realpaths: string[] = [];
      for (const p of probe.paths) {
        if (!p) continue;
        // .native resolves through the OS, which is what canonicalises case on macOS; the JS
        // implementation only walks symlinks and keeps whatever case the host reported.
        // A path that does not exist (yet) cannot be resolved itself, so resolve its directory.
        try {
          realpaths.push(fsSync.realpathSync.native(String(p)));
        } catch {
          try {
            realpaths.push(
              pathSync.join(
                fsSync.realpathSync.native(pathSync.dirname(String(p))),
                pathSync.basename(String(p)),
              ),
            );
          } catch {
            realpaths.push(String(p));
          }
        }
      }
      return { known: true, realpaths, source: 'app.projects via the bridge' };
    }

    const running = this.premiereProcessRunning();
    if (running === false) {
      return {
        known: true,
        realpaths: [],
        source: 'no Premiere process is running, so no project can be open',
      };
    }
    return {
      known: false,
      realpaths: [],
      source:
        running === null
          ? 'could not determine whether Premiere is running'
          : 'a Premiere process is running',
      reason:
        running === null
          ? 'Could not reach the bridge panel and could not determine whether Premiere is running, so it is not possible to confirm this file is not open. Refusing.'
          : `Premiere is running but the bridge panel did not answer${probe && probe.error ? ` (${probe.error})` : ''}, so it is not possible to confirm this file is not open. Start the MCP Bridge panel, or quit Premiere, then retry.`,
    };
  }

  protected async projectFileInspect(args: ProjectFileInspectArgs): Promise<any> {
    try {
      const { file } = readProjectFile(args.projectPath);
      const census = censusOf(file.xml);
      const canary = containerCanary(fsSync.readFileSync(file.realpath), file);

      const counts: Record<string, number> = {};
      for (const needle of args.countStrings ?? [])
        counts[needle] = countOccurrences(file.xml, needle);

      let excerpt: any;
      if (args.xmlExcerptAround) {
        const at = file.xml.indexOf(args.xmlExcerptAround);
        excerpt =
          at === -1
            ? { found: false, note: 'That literal does not appear in this project.' }
            : {
                found: true,
                offset: at,
                text: file.xml.slice(
                  Math.max(0, at - 300),
                  at + args.xmlExcerptAround.length + 300,
                ),
              };
      }

      return {
        success: true,
        verified: true,
        verifiedBy: 'the file was read and decoded from disk',
        projectPath: file.path,
        realpath: file.realpath,
        bytes: file.bytes,
        sha256: file.sha256,
        compressed: file.compressed,
        formatVersion: file.formatVersion,
        formatSupportedForEditing:
          file.formatVersion !== null && PRPROJ_SUPPORTED_FORMAT_VERSIONS.has(file.formatVersion),
        xmlLength: file.xml.length,
        census,
        containerRoundTrip: canary,
        ...(args.countStrings?.length ? { stringCounts: counts } : {}),
        ...(excerpt ? { excerpt } : {}),
        note: 'census.definitions counts ObjectUID declarations and matches what Premiere reports (e.g. definitions.Sequence is the sequence count). census.nodes counts raw tags including cross-references, so it is higher — it exists to detect structural damage, not to be read as an inventory.',
      };
    } catch (error) {
      if (error instanceof SurgeryRefusal)
        return { success: false, refused: true, code: error.code, error: error.message };
      return {
        success: false,
        error: `project_file_inspect failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  protected async projectFileEdit(args: ProjectFileEditArgs): Promise<any> {
    // Invariant 8, enforced HERE rather than only in the tool profile. A profile is a context-cost
    // decision that call_tool deliberately reaches past (see router.ts), so a gate that lived only in
    // the advertised list would be routable. This one is not.
    if (!surgeryEnabled()) {
      return {
        success: false,
        refused: true,
        code: 'SURGERY_DISABLED',
        error: `Project-file surgery is disabled. It rewrites a .prproj outside Premiere, so it is opt-in: set ${SURGERY_ENV_FLAG}=1 in the server's environment and restart. project_file_inspect is read-only and always available.`,
      };
    }

    const dryRun = args.dryRun === true;
    // Set once the output file exists, so a failure after that point cannot report wrote:false.
    let wroteOutput: string | null = null;

    try {
      const { file, raw } = readProjectFile(args.sourcePath);
      assertSupportedFormat(file); // invariant 3
      assertOutputWritable(file.realpath, args.outputPath); // invariant 1

      // Invariant 4. Before touching anything: prove our writer reproduces this file exactly, so the
      // only difference in the output is the edit.
      const canary = containerCanary(raw, file);
      if (!canary.semantic) {
        throw new SurgeryRefusal(
          'The project XML did not survive a re-encode round trip, so this build cannot write this file losslessly. Nothing was written.',
          'CANARY_SEMANTIC_FAILED',
        );
      }
      if (!canary.byteIdentical) {
        throw new SurgeryRefusal(
          `Re-encoding this file's untouched contents produced ${canary.reencodedBytes} bytes against the original ${file.bytes}, so it was written by a compressor this build has not been verified against. ` +
            'Refusing: the safe interpretation of an unfamiliar writer is to leave its files alone.',
          'CANARY_BYTE_MISMATCH',
        );
      }

      // Invariant 2. Neither file may be open in Premiere — and if that cannot be established, refuse.
      const open = await this.openProjectRealpaths();
      if (!open.known) {
        throw new SurgeryRefusal(
          open.reason || 'Could not determine which projects are open in Premiere.',
          'OPEN_STATE_UNKNOWN',
        );
      }
      // The output does not exist yet, so resolve its directory instead: a host reporting
      // /private/var/... must still collide with an output given as /var/....
      const outputLexical = pathSync.resolve(args.outputPath);
      let outputResolved = outputLexical;
      try {
        outputResolved = pathSync.join(
          fsSync.realpathSync.native(pathSync.dirname(outputLexical)),
          pathSync.basename(outputLexical),
        );
      } catch {
        /* keep the lexical form */
      }
      // macOS and Windows volumes are case-insensitive by default, so "Cut.prproj" open in Premiere is
      // the same file as "cut.prproj" here. Over-matching on a case-sensitive volume only refuses.
      const caseless = process.platform === 'darwin' || process.platform === 'win32';
      const samePath = (a: string, b: string) =>
        caseless ? a.toLowerCase() === b.toLowerCase() : a === b;
      const collision = open.realpaths.find(
        (p) =>
          samePath(p, file.realpath) || samePath(p, outputResolved) || samePath(p, outputLexical),
      );
      if (collision) {
        throw new SurgeryRefusal(
          `"${collision}" is currently open in Premiere. Editing a project file underneath the application means Premiere's in-memory copy wins the moment anyone saves, and the edit is silently lost. Close it in Premiere first.`,
          'PROJECT_IS_OPEN',
        );
      }

      // Invariants 5 and 6.
      const censusBefore = censusOf(file.xml);
      const { xml: editedXml, applied } = applyReplacements(file.xml, args.replacements);
      const censusAfter = censusOf(editedXml);

      // Whole-document damage checks. Both properties were measured on real Premiere output, and both
      // catch corruption the census is blind to: the census counts known tags, so a stray bracket or a
      // bare ampersand sails straight past it and only surfaces when Premiere refuses the project.
      const sanity = documentSanity(editedXml);
      if (!sanity.angleBalanced) {
        throw new SurgeryRefusal(
          `The edited document has ${sanity.openAngles} "<" against ${sanity.closeAngles} ">", so a tag was left unterminated. Nothing was written.`,
          'ANGLE_BRACKETS_UNBALANCED',
        );
      }
      if (!sanity.entitiesValid) {
        throw new SurgeryRefusal(
          'The edited document contains a bare "&" that is not a valid entity reference, which makes it malformed. Nothing was written.',
          'BARE_AMPERSAND_IN_DOCUMENT',
        );
      }

      const diff = censusDiff(censusBefore, censusAfter);
      if (diff.length > 0 && args.allowCensusChange !== true) {
        throw new SurgeryRefusal(
          `The edit changed the structural node census, which a pure text substitution should not do: ${diff.join('; ')}. ` +
            'Nothing was written. If adding or removing structure is genuinely what you intend, pass allowCensusChange: true.',
          'CENSUS_CHANGED',
        );
      }

      const common = {
        sourcePath: file.path,
        sourceRealpath: file.realpath,
        sourceSha256: file.sha256,
        sourceBytes: file.bytes,
        formatVersion: file.formatVersion,
        replacementsApplied: applied.map((a) => ({
          find: a.find,
          replace: a.replace,
          matches: a.matches,
        })),
        censusBefore,
        censusAfter,
        censusDiff: diff,
        documentSanity: sanity,
        containerRoundTrip: canary,
        openProjectsCheck: { source: open.source, openRealpaths: open.realpaths },
      };

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          verified: false,
          verifiedBy:
            'nothing was written — every invariant was checked against the source file only',
          ...common,
          wrote: false,
          wouldWrite: pathSync.resolve(args.outputPath),
          note: 'Every invariant passed and nothing was written. Re-run with dryRun false to produce the file.',
        };
      }

      // Invariant 7, in part: the write is verified by re-reading the bytes, not by having called write.
      // The existence check above is stale by now (the open-projects probe awaited the host), so the
      // writer itself refuses to clobber — see writeEditedProject.
      const written = writeEditedProject(args.outputPath, editedXml, file.compressed, censusAfter);
      wroteOutput = written.outputPath;
      const sourceAfter = readProjectFile(file.realpath).file.sha256;

      const readbackOk =
        written.readbackMatches &&
        written.readbackCensusDiff.length === 0 &&
        !written.readbackError;
      const sourceUntouched = sourceAfter === file.sha256;

      return {
        success: readbackOk && sourceUntouched,
        verified: readbackOk && sourceUntouched,
        verifiedBy:
          'the written file was re-read from disk and its XML and census compared; the source was re-hashed to prove it was untouched',
        ...common,
        // Every refusal path reports wrote:false, so this has to be set here too. A caller that
        // branches on `wrote` would otherwise read undefined on the one path that did write.
        wrote: true,
        outputPath: written.outputPath,
        outputBytes: written.outputBytes,
        outputSha256: written.outputSha256,
        readbackMatches: written.readbackMatches,
        readbackCensusDiff: written.readbackCensusDiff,
        ...(written.readbackError ? { readbackError: written.readbackError } : {}),
        sourceUntouched,
        sourceSha256After: sourceAfter,
        // Invariant 7 in full. XML validity is not acceptance, and this is the one claim this tool
        // cannot make for itself.
        premiereWillLoad: 'unverified',
        premiereWillLoadNote: `Whether Premiere accepts this file has NOT been verified — that requires opening it. To verify: open_project with "${written.outputPath}", then read the edited value back (get_bin_tree, list_sequences, or get_project_info). A file written by this tool has been opened successfully on Premiere 26.3, with the edited value read back from Premiere's own project model — but that is evidence about the writer, not about this file.`,
        ...(readbackOk && sourceUntouched
          ? {}
          : {
              error: !sourceUntouched
                ? 'The source file changed during the edit — treat the output as suspect.'
                : 'The file written to disk did not read back as the document that was intended.',
            }),
      };
    } catch (error) {
      if (error instanceof SurgeryRefusal) {
        // A refusal can come AFTER the write: the post-write source re-hash re-reads the source,
        // which refuses if it vanished mid-call. The output exists then, so say so.
        return {
          success: false,
          refused: true,
          code: error.code,
          error: error.message,
          wrote: wroteOutput !== null,
          ...(wroteOutput !== null ? { outputPath: wroteOutput, outputSuspect: true } : {}),
        };
      }
      if (error instanceof ProjectWriteError) {
        return {
          success: false,
          code: 'WRITE_FAILED',
          error: error.message,
          wrote: error.outputCreated,
          ...(error.outputCreated ? { outputPath: error.outputPath, outputSuspect: true } : {}),
        };
      }
      return {
        success: false,
        error: `project_file_edit failed: ${error instanceof Error ? error.message : String(error)}`,
        wrote: wroteOutput !== null,
        ...(wroteOutput !== null ? { outputPath: wroteOutput, outputSuspect: true } : {}),
      };
    }
  }

  protected async importProjectItems(projectPath: string, includeSequences = true): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var before=app.project.rootItem.children.numItems;
        qe.project.importProject(${JSON.stringify(projectPath)},${includeSequences});
        var after=app.project.rootItem.children.numItems;
        return JSON.stringify({success:true,itemsBefore:before,itemsAfter:after,imported:after-before,projectPath:${JSON.stringify(projectPath)}});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  // Batch variant of setClipProperties: apply Motion values to many clips in ONE round-trip.
  // Same per-clip loop as the single version (opacity/scale/rotation/position), collapsing N
  // file round-trips into 1. Returns a per-clip result array.
  protected async setClipPropertiesBatch(
    items: Array<{ clipId: string; properties: any }>,
  ): Promise<any> {
    const specs = items.map((it) => ({
      clipId: it.clipId,
      opacity: it.properties?.opacity === undefined ? null : it.properties.opacity,
      scale: it.properties?.scale === undefined ? null : it.properties.scale,
      rotation: it.properties?.rotation === undefined ? null : it.properties.rotation,
      posX: it.properties?.position?.x === undefined ? null : it.properties.position.x,
      posY: it.properties?.position?.y === undefined ? null : it.properties.position.y,
    }));
    const script = `
      try {
        var specs = ${JSON.stringify(specs)};
        var results = [];
        for (var n = 0; n < specs.length; n++) {
          var it = specs[n];
          var r = { index: n, clipId: it.clipId, success: false };
          try {
            var info = __findClip(it.clipId);
            if (!info) { r.error = "Clip not found"; results.push(r); continue; }
            var clip = info.clip;
            // Sequence frame size for converting Position pixels -> normalized (see single variant).
            var __seqW = 1920, __seqH = 1080;
            try {
              if (info.sequence) {
                if (info.sequence.frameSizeHorizontal) { __seqW = info.sequence.frameSizeHorizontal; __seqH = info.sequence.frameSizeVertical; }
                else { var __ss = info.sequence.getSettings(); if (__ss) { __seqW = __ss.videoFrameWidth; __seqH = __ss.videoFrameHeight; } }
              }
            } catch (e0) {}
            // Track which requested properties we actually FOUND and SET, so a silently-failed
            // setValue (or a Motion property that isn't present) surfaces instead of a false success.
            var want = { opacity: it.opacity !== null, scale: it.scale !== null, rotation: it.rotation !== null, position: (it.posX !== null || it.posY !== null) };
            // done = found AND readback confirms it applied (setValue can silently no-op).
            var done = { opacity: false, scale: false, rotation: false, position: false };
            var __scalarTol = 0.5, __posTol = 0.01;
            for (var i = 0; i < clip.components.numItems; i++) {
              var comp = clip.components[i];
              for (var j = 0; j < comp.properties.numItems; j++) {
                var p = comp.properties[j];
                try {
                  if (want.opacity && p.displayName === "Opacity") { p.setValue(it.opacity, true); var __ro = p.getValue(); done.opacity = (Math.abs(Number(__ro) - it.opacity) <= __scalarTol); }
                  if (want.scale && p.displayName === "Scale") { p.setValue(it.scale, true); var __rs = p.getValue(); done.scale = (Math.abs(Number(__rs) - it.scale) <= __scalarTol); }
                  if (want.rotation && p.displayName === "Rotation") { p.setValue(it.rotation, true); var __rr = p.getValue(); done.rotation = (Math.abs(Number(__rr) - it.rotation) <= __scalarTol); }
                  if (want.position && p.displayName === "Position") {
                    var __cur = [0.5, 0.5];
                    try { __cur = p.getValue(); } catch (ep) {}
                    var __nx = it.posX !== null ? (it.posX / __seqW) : __cur[0];
                    var __ny = it.posY !== null ? (it.posY / __seqH) : __cur[1];
                    p.setValue([__nx, __ny], true);
                    var __rp = [0.5, 0.5];
                    try { __rp = p.getValue(); } catch (ep2) {}
                    done.position = (Math.abs(Number(__rp[0]) - __nx) <= __posTol && Math.abs(Number(__rp[1]) - __ny) <= __posTol);
                  }
                } catch (e2) {}
              }
            }
            var missing = [];
            if (want.opacity && !done.opacity) missing.push("opacity");
            if (want.scale && !done.scale) missing.push("scale");
            if (want.rotation && !done.rotation) missing.push("rotation");
            if (want.position && !done.position) missing.push("position");
            r.applied = done;
            r.success = (missing.length === 0);
            r.verified = (missing.length === 0);
            if (missing.length) r.error = "properties did not apply (readback mismatch or missing): " + missing.join(", ");
          } catch (e) {
            r.error = e.toString();
          }
          results.push(r);
        }
        var applied = 0;
        for (var k = 0; k < results.length; k++) { if (results[k].success) applied++; }
        return JSON.stringify({ success: (applied === specs.length), applied: applied, total: specs.length, results: results });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script, 300000);
  }

  // Project Item Discovery & Management Implementation
  protected async findProjectItemByName(name: string, type?: string): Promise<any> {
    const filterType = type || 'any';
    const script = `
      try {
        var searchName = ${JSON.stringify(name)}.toLowerCase();
        var filterType = ${JSON.stringify(filterType)};
        var results = [];
        function walkItems(parent) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            var itemType = item.type === 2 ? "bin" : (item.isSequence() ? "sequence" : "footage");
            if (item.name.toLowerCase().indexOf(searchName) !== -1) {
              if (filterType === "any" || filterType === itemType) {
                var info = {
                  id: item.nodeId,
                  name: item.name,
                  type: itemType,
                  treePath: item.treePath
                };
                try { info.mediaPath = item.getMediaPath(); } catch(e) {}
                results.push(info);
              }
            }
            if (item.type === 2) {
              walkItems(item);
            }
          }
        }
        walkItems(app.project.rootItem);
        return JSON.stringify({
          success: true,
          items: results,
          count: results.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async moveItemToBin(projectItemId: string, targetBinId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var bin = __findProjectItem(${JSON.stringify(targetBinId)});
        if (!bin) return JSON.stringify({ success: false, error: "Target bin not found" });
        item.moveBin(bin);
        return JSON.stringify({
          success: true,
          message: "Item moved to bin",
          itemId: ${JSON.stringify(projectItemId)},
          targetBinId: ${JSON.stringify(targetBinId)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Relink Media Implementation
  protected async relinkMedia(projectItemId: string, newFilePath: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        // The target file must exist on disk, or changeMediaPath silently relinks to
        // nothing and the clip stays offline while we'd have claimed success.
        var target = new File(${JSON.stringify(newFilePath)});
        if (!target.exists) {
          return JSON.stringify({ success: false, error: "Target file does not exist: " + ${JSON.stringify(newFilePath)} });
        }
        if (!item.canChangeMediaPath()) {
          return JSON.stringify({ success: false, error: "Cannot change media path for this item" });
        }
        // Capture offline state before, then verify it actually cleared after.
        var wasOffline = null;
        try { wasOffline = item.isOffline(); } catch (eB) {}
        item.changeMediaPath(${JSON.stringify(newFilePath)}, true);
        var stillOffline = null;
        try { stillOffline = item.isOffline(); } catch (eA) {}
        var pathNow = null;
        try { pathNow = item.getMediaPath(); } catch (eP) {}
        // If isOffline is readable and still true, the relink did not take — say so.
        if (stillOffline === true) {
          return JSON.stringify({
            success: false,
            error: "changeMediaPath ran but the item is still offline; the file may not match this clip.",
            projectItemId: ${JSON.stringify(projectItemId)},
            newFilePath: ${JSON.stringify(newFilePath)},
            mediaPathNow: pathNow
          });
        }
        return JSON.stringify({
          success: true,
          message: "Media relinked",
          verified: stillOffline === false,
          projectItemId: ${JSON.stringify(projectItemId)},
          newFilePath: ${JSON.stringify(newFilePath)},
          mediaPathNow: pathNow,
          wasOffline: wasOffline,
          note: stillOffline === null ? "isOffline() not readable on this host; path change was applied but online state is unverified." : undefined
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Get Metadata Implementation
  protected async getMetadata(projectItemId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var projectMetadata = item.getProjectMetadata();
        var xmpMetadata = item.getXMPMetadata();
        return JSON.stringify({
          success: true,
          projectItemId: ${JSON.stringify(projectItemId)},
          projectMetadata: projectMetadata,
          xmpMetadata: xmpMetadata
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Set Metadata Implementation
  protected async setMetadata(projectItemId: string, key: string, value: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var schema = "http://ns.adobe.com/premierePrivateProjectMetaData/1.0/";
        var fullKey = schema + ${JSON.stringify(key)};
        item.setProjectMetadata(${JSON.stringify(value)}, [fullKey]);
        // Read the XMP blob back and look for the value. XMP escapes special
        // characters, so absence is not proof of failure -- report it as
        // unverified rather than failing on a possible false negative.
        var blob = null; try { blob = String(item.getProjectMetadata()); } catch (eMeta) {}
        var found = blob !== null && blob.indexOf(${JSON.stringify(value)}) !== -1;
        return JSON.stringify({
          success: true,
          verified: found,
          message: "Metadata set",
          projectItemId: ${JSON.stringify(projectItemId)},
          key: ${JSON.stringify(key)},
          value: ${JSON.stringify(value)},
          note: found ? undefined : "setProjectMetadata() accepted; the value was not found verbatim in the XMP readback (it may be escaped), so application is unconfirmed."
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Get Footage Interpretation Implementation
  protected async getFootageInterpretation(projectItemId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var interp = item.getFootageInterpretation();
        return JSON.stringify({
          success: true,
          projectItemId: ${JSON.stringify(projectItemId)},
          frameRate: interp.frameRate,
          pixelAspectRatio: interp.pixelAspectRatio,
          fieldType: interp.fieldType,
          removePulldown: interp.removePulldown,
          alphaUsage: interp.alphaUsage
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Set Footage Interpretation Implementation
  protected async setFootageInterpretation(
    projectItemId: string,
    frameRate?: number,
    pixelAspectRatio?: number,
  ): Promise<any> {
    const setFrameRate = frameRate !== undefined;
    const setPar = pixelAspectRatio !== undefined;
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        var interp = item.getFootageInterpretation();
        ${setFrameRate ? 'interp.frameRate = ' + frameRate + ';' : ''}
        ${setPar ? 'interp.pixelAspectRatio = ' + pixelAspectRatio + ';' : ''}
        item.setFootageInterpretation(interp);
        // Re-fetch a fresh interpretation: the local 'interp' object echoes the values
        // we just assigned whether or not Premiere accepted them. Only a fresh read
        // proves the change took.
        var check = item.getFootageInterpretation();
        ${setFrameRate ? `if (Math.abs(Number(check.frameRate) - ${frameRate}) > 0.001) return JSON.stringify({ success: false, verified: false, error: "Premiere did not apply the frame rate (reads back as " + check.frameRate + ", requested ${frameRate}).", actual: check.frameRate });` : ''}
        ${setPar ? `if (Math.abs(Number(check.pixelAspectRatio) - ${pixelAspectRatio}) > 0.001) return JSON.stringify({ success: false, verified: false, error: "Premiere did not apply the pixel aspect ratio (reads back as " + check.pixelAspectRatio + ", requested ${pixelAspectRatio}).", actual: check.pixelAspectRatio });` : ''}
        return JSON.stringify({
          success: true,
          verified: true,
          message: "Footage interpretation updated",
          projectItemId: ${JSON.stringify(projectItemId)},
          frameRate: check.frameRate,
          pixelAspectRatio: check.pixelAspectRatio
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Check Offline Media Implementation
  protected async checkOfflineMedia(): Promise<any> {
    const script = `
      try {
        var offlineItems = [];
        function walkForOffline(parent) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            if (item.type === 2) {
              walkForOffline(item);
            } else {
              if (item.isOffline()) {
                offlineItems.push({
                  nodeId: item.nodeId,
                  name: item.name,
                  treePath: item.treePath
                });
              }
            }
          }
        }
        walkForOffline(app.project.rootItem);
        return JSON.stringify({
          success: true,
          offlineCount: offlineItems.length,
          offlineItems: offlineItems
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Consolidate Duplicates Implementation
  protected async consolidateDuplicates(): Promise<any> {
    const script = `
      try {
        app.project.consolidateDuplicates();
        return JSON.stringify({
          success: true,
          message: "Duplicates consolidated"
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Refresh Media Implementation
  protected async refreshMedia(projectItemId: string): Promise<any> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        item.refreshMedia();
        // refreshMedia() re-reads the media from disk; it is an idempotent reload with
        // no diffable state, so success means the call was accepted, not that anything
        // observably changed. Reported as verified:false to avoid overstating it.
        var offlineNow = null; try { offlineNow = item.isOffline(); } catch (eOff) {}
        return JSON.stringify({
          success: true,
          verified: false,
          message: "Media refresh requested",
          projectItemId: ${JSON.stringify(projectItemId)},
          isOffline: offlineNow,
          note: "refreshMedia() accepted; a reload has no readback to confirm, so this is not independently verified."
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }
}
