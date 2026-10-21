/**
 * MulticamTools -- the Multicam tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { MotionLayoutTools } from './motion-layout.js';

export class MulticamTools extends MotionLayoutTools {
  protected async enableMulticam(_seqId: string|undefined, trackIndex: number, clipIndex: number, enabled: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        var canDo = clip.canDoMulticam();
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

  protected async getMulticamAngleCount(_seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var item = seq.projectItem;
        var isMulticam = item ? item.isMulticamClip() : false;
        return JSON.stringify({success:true,isMulticamSequence:isMulticam,videoTrackCount:seq.videoTracks.numTracks,audioTrackCount:seq.audioTracks.numTracks,sequenceName:String(seq.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async flattenMulticam(_seqId: string|undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        clip.setMulticam(false);
        return JSON.stringify({success:true,message:'Multicam disabled on clip. Clip now plays as single-stream at the active angle.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async multicamInfo(_seqId: string|undefined, trackIndex: number, clipIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var qeClip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        if (!qeClip) return JSON.stringify({success:false,error:'Clip not found'});
        var domClip = app.project.activeSequence.videoTracks[${trackIndex}].clips[${clipIndex}];
        return JSON.stringify({success:true,multicamEnabled:qeClip.multicamEnabled,canDoMulticam:qeClip.canDoMulticam(),isMulticamClip:domClip.projectItem.isMulticamClip(),name:String(domClip.name)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setMulticamAngle(_seqId: string|undefined, trackIndex: number, clipIndex: number, angleIndex: number): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq = qe.project.getActiveSequence();
        var clip = seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});
        if (!clip) return JSON.stringify({success:false,error:'Clip not found'});
        clip.setSwitchSources(${angleIndex});
        return JSON.stringify({success:true,angleIndex:${angleIndex}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async createMulticamSourceSequence(binName: string, newSeqName: string, presetPath?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var bin = null;
        var root = app.project.rootItem;
        for (var i = 0; i < root.children.numItems; i++) {
          if (String(root.children[i].name) === ${JSON.stringify(binName)}) { bin = root.children[i]; break; }
        }
        if (!bin) return JSON.stringify({success:false,error:'Bin not found: ' + ${JSON.stringify(binName)}});
        var clips = [];
        for (var j = 0; j < bin.children.numItems; j++) clips.push(bin.children[j]);
        if (clips.length === 0) return JSON.stringify({success:false,error:'Bin is empty'});
        var seq = app.project.createNewSequenceFromClips(${JSON.stringify(newSeqName)}, clips, ${JSON.stringify(presetPath ?? '')});
        if (!seq) return JSON.stringify({success:false,error:'Could not create sequence'});
        return JSON.stringify({success:true,sequenceId:String(seq.sequenceID),name:String(seq.name),clipCount:clips.length});
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
