/**
 * MCP Resources for Adobe Premiere Pro
 * 
 * This module provides resources that give AI agents access to contextual
 * information about Adobe Premiere Pro projects, sequences, and media.
 */

import type { PremiereProTransport } from '../bridge/types.js';
import { Logger } from '../utils/logger.js';

export interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export class PremiereProResources {
  private bridge: PremiereProTransport;
  private logger: Logger;

  constructor(bridge: PremiereProTransport) {
    this.bridge = bridge;
    this.logger = new Logger('PremiereProResources');
  }

  getAvailableResources(): MCPResource[] {
    return [
      {
        uri: 'premiere://project/info',
        name: 'Current Project Information',
        description: 'Information about the currently open Premiere Pro project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://project/sequences',
        name: 'Project Sequences',
        description: 'List of all sequences in the current project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://project/media',
        name: 'Project Media',
        description: 'List of all media items in the current project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://project/bins',
        name: 'Project Bins',
        description: 'Organizational structure of bins in the current project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://timeline/clips',
        name: 'Timeline Clips',
        description: 'All clips currently on the timeline',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://timeline/tracks',
        name: 'Timeline Tracks',
        description: 'Information about video and audio tracks',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://timeline/markers',
        name: 'Timeline Markers',
        description: 'Markers and their positions on the timeline',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://effects/available',
        name: 'Available Effects',
        description: 'List of all available effects in Premiere Pro',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://effects/applied',
        name: 'Applied Effects',
        description: 'Effects currently applied to clips',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://transitions/available',
        name: 'Available Transitions',
        description: 'List of all available transitions in Premiere Pro',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://export/presets',
        name: 'Export Presets',
        description: 'Available export presets and their settings',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://project/metadata',
        name: 'Project Metadata',
        description: 'Metadata information for the current project',
        mimeType: 'application/json'
      },
      {
        uri: 'premiere://config/get_instructions',
        name: 'Premiere Operating Instructions',
        description: 'Attach this before editing to give the model workflow and safety guidance for using the Premiere MCP server',
        mimeType: 'text/plain'
      }
    ];
  }

  async readResource(uri: string): Promise<any> {
    this.logger.info(`Reading resource: ${uri}`);
    
    switch (uri) {
      case 'premiere://project/info':
        return await this.getProjectInfo();
      
      case 'premiere://project/sequences':
        return await this.getProjectSequences();
      
      case 'premiere://project/media':
        return await this.getProjectMedia();
      
      case 'premiere://project/bins':
        return await this.getProjectBins();
      
      case 'premiere://timeline/clips':
        return await this.getTimelineClips();
      
      case 'premiere://timeline/tracks':
        return await this.getTimelineTracks();
      
      case 'premiere://timeline/markers':
        return await this.getTimelineMarkers();
      
      case 'premiere://effects/available':
        return await this.getAvailableEffects();
      
      case 'premiere://effects/applied':
        return await this.getAppliedEffects();
      
      case 'premiere://transitions/available':
        return await this.getAvailableTransitions();
      
      case 'premiere://export/presets':
        return await this.getExportPresets();
      
      case 'premiere://project/metadata':
        return await this.getProjectMetadata();

      case 'premiere://config/get_instructions':
        return this.getInstructions();
      
      default:
        throw new Error(`Resource '${uri}' not found`);
    }
  }

  getResource(uri: string): MCPResource | undefined {
    return this.getAvailableResources().find((resource) => resource.uri === uri);
  }

  private async getProjectInfo(): Promise<any> {
    const script = `
      var project = app.project;
      JSON.stringify({
        id: project.documentID,
        name: project.name,
        path: project.path,
        isModified: project.dirty,
        settings: {
          scratchDiskPath: project.scratchDiskPath,
          captureFormat: project.captureFormat,
          previewFormat: project.previewFormat
        },
        statistics: {
          sequenceCount: project.sequences.numSequences,
          projectItemCount: project.rootItem.children.numItems
        }
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getProjectSequences(): Promise<any> {
    const script = `
      var project = app.project;
      var sequences = [];
      
      for (var i = 0; i < project.sequences.numSequences; i++) {
        var sequence = project.sequences[i];
        sequences.push({
          id: sequence.sequenceID,
          name: sequence.name,
          frameRate: sequence.framerate,
          duration: sequence.end - sequence.zeroPoint,
          videoTracks: sequence.videoTracks.numTracks,
          audioTracks: sequence.audioTracks.numTracks,
          settings: {
            frameSize: {
              width: sequence.frameSizeHorizontal,
              height: sequence.frameSizeVertical
            },
            pixelAspectRatio: sequence.pixelAspectRatio,
            fieldType: sequence.fieldType
          }
        });
      }
      
      JSON.stringify({
        sequences: sequences,
        totalCount: project.sequences.numSequences
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getProjectMedia(): Promise<any> {
    const script = `
      var project = app.project;
      var mediaItems = [];
      
      function traverseProjectItems(item) {
        for (var i = 0; i < item.children.numItems; i++) {
          var child = item.children[i];
          if (child.type === ProjectItemType.CLIP) {
            mediaItems.push({
              id: child.nodeId,
              name: child.name,
              type: child.type,
              mediaPath: child.getMediaPath(),
              duration: child.getOutPoint() - child.getInPoint(),
              frameRate: child.getVideoFrameRate(),
              hasVideo: child.hasVideo(),
              hasAudio: child.hasAudio(),
              metadata: {
                creationTime: child.getCreationTime(),
                modificationTime: child.getModificationTime(),
                fileSize: child.getFileSize()
              }
            });
          } else if (child.type === ProjectItemType.BIN) {
            traverseProjectItems(child);
          }
        }
      }
      
      traverseProjectItems(project.rootItem);
      
      JSON.stringify({
        mediaItems: mediaItems,
        totalCount: mediaItems.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getProjectBins(): Promise<any> {
    const script = `
      var project = app.project;
      var bins = [];
      
      function traverseBins(item, depth = 0) {
        for (var i = 0; i < item.children.numItems; i++) {
          var child = item.children[i];
          if (child.type === ProjectItemType.BIN) {
            bins.push({
              id: child.nodeId,
              name: child.name,
              depth: depth,
              itemCount: child.children.numItems,
              path: child.treePath
            });
            traverseBins(child, depth + 1);
          }
        }
      }
      
      traverseBins(project.rootItem);
      
      JSON.stringify({
        bins: bins,
        totalCount: bins.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getTimelineClips(): Promise<any> {
    const script = `
      var project = app.project;
      var clips = [];
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        // Video tracks
        for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
          var track = sequence.videoTracks[v];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              trackType: 'video',
              trackIndex: v,
              startTime: clip.start,
              endTime: clip.end,
              duration: clip.duration,
              inPoint: clip.inPoint,
              outPoint: clip.outPoint,
              mediaPath: clip.projectItem ? clip.projectItem.getMediaPath() : null,
              effects: clip.components.numItems
            });
          }
        }
        
        // Audio tracks
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var track = sequence.audioTracks[a];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              trackType: 'audio',
              trackIndex: a,
              startTime: clip.start,
              endTime: clip.end,
              duration: clip.duration,
              inPoint: clip.inPoint,
              outPoint: clip.outPoint,
              mediaPath: clip.projectItem ? clip.projectItem.getMediaPath() : null,
              effects: clip.components.numItems
            });
          }
        }
      }
      
      JSON.stringify({
        clips: clips,
        totalCount: clips.length,
        activeSequence: project.activeSequence ? project.activeSequence.name : null
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getTimelineTracks(): Promise<any> {
    const script = `
      var project = app.project;
      var tracks = [];
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        // Video tracks
        for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
          var track = sequence.videoTracks[v];
          tracks.push({
            id: track.id,
            name: track.name,
            type: 'video',
            index: v,
            enabled: track.enabled,
            locked: track.locked,
            muted: track.muted,
            clipCount: track.clips.numItems,
            transitionCount: track.transitions.numItems
          });
        }
        
        // Audio tracks
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var track = sequence.audioTracks[a];
          tracks.push({
            id: track.id,
            name: track.name,
            type: 'audio',
            index: a,
            enabled: track.enabled,
            locked: track.locked,
            muted: track.muted,
            clipCount: track.clips.numItems,
            transitionCount: track.transitions.numItems
          });
        }
      }
      
      JSON.stringify({
        tracks: tracks,
        totalCount: tracks.length,
        activeSequence: project.activeSequence ? project.activeSequence.name : null
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getTimelineMarkers(): Promise<any> {
    const script = `
      var project = app.project;
      var markers = [];
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        for (var i = 0; i < sequence.markers.numMarkers; i++) {
          var marker = sequence.markers[i];
          markers.push({
            id: marker.guid,
            name: marker.name,
            comment: marker.comment,
            startTime: marker.start,
            endTime: marker.end,
            duration: marker.duration,
            type: marker.type,
            color: marker.color
          });
        }
      }
      
      JSON.stringify({
        markers: markers,
        totalCount: markers.length,
        activeSequence: project.activeSequence ? project.activeSequence.name : null
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getAvailableEffects(): Promise<any> {
    const script = `
      var effects = [];
      
      // Get video effects
      var videoEffects = app.getAvailableVideoEffects();
      for (var i = 0; i < videoEffects.length; i++) {
        effects.push({
          name: videoEffects[i].name,
          matchName: videoEffects[i].matchName,
          category: videoEffects[i].category,
          type: 'video'
        });
      }
      
      // Get audio effects
      var audioEffects = app.getAvailableAudioEffects();
      for (var i = 0; i < audioEffects.length; i++) {
        effects.push({
          name: audioEffects[i].name,
          matchName: audioEffects[i].matchName,
          category: audioEffects[i].category,
          type: 'audio'
        });
      }
      
      JSON.stringify({
        effects: effects,
        totalCount: effects.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getAppliedEffects(): Promise<any> {
    const script = `
      var project = app.project;
      var appliedEffects = [];
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        // Check video tracks
        for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
          var track = sequence.videoTracks[v];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            for (var e = 0; e < clip.components.numItems; e++) {
              var effect = clip.components[e];
              appliedEffects.push({
                clipId: clip.nodeId,
                clipName: clip.name,
                effectName: effect.displayName,
                effectMatchName: effect.matchName,
                trackType: 'video',
                trackIndex: v,
                enabled: effect.enabled
              });
            }
          }
        }
        
        // Check audio tracks
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var track = sequence.audioTracks[a];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            for (var e = 0; e < clip.components.numItems; e++) {
              var effect = clip.components[e];
              appliedEffects.push({
                clipId: clip.nodeId,
                clipName: clip.name,
                effectName: effect.displayName,
                effectMatchName: effect.matchName,
                trackType: 'audio',
                trackIndex: a,
                enabled: effect.enabled
              });
            }
          }
        }
      }
      
      JSON.stringify({
        appliedEffects: appliedEffects,
        totalCount: appliedEffects.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getAvailableTransitions(): Promise<any> {
    const script = `
      var transitions = [];
      
      // Get video transitions
      var videoTransitions = app.getAvailableVideoTransitions();
      for (var i = 0; i < videoTransitions.length; i++) {
        transitions.push({
          name: videoTransitions[i].name,
          matchName: videoTransitions[i].matchName,
          category: videoTransitions[i].category,
          type: 'video'
        });
      }
      
      // Get audio transitions
      var audioTransitions = app.getAvailableAudioTransitions();
      for (var i = 0; i < audioTransitions.length; i++) {
        transitions.push({
          name: audioTransitions[i].name,
          matchName: audioTransitions[i].matchName,
          category: audioTransitions[i].category,
          type: 'audio'
        });
      }
      
      JSON.stringify({
        transitions: transitions,
        totalCount: transitions.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getExportPresets(): Promise<any> {
    const script = `
      var presets = [];
      var encoder = app.encoder;
      
      // Get available export presets
      var exportPresets = encoder.getExportPresets();
      for (var i = 0; i < exportPresets.length; i++) {
        presets.push({
          name: exportPresets[i].name,
          matchName: exportPresets[i].matchName,
          category: exportPresets[i].category,
          description: exportPresets[i].description,
          fileExtension: exportPresets[i].fileExtension
        });
      }
      
      JSON.stringify({
        presets: presets,
        totalCount: presets.length
      });
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async getProjectMetadata(): Promise<any> {
    const script = `
      var project = app.project;
      var metadata = {};
      
      if (project.activeSequence) {
        var sequence = project.activeSequence;
        
        metadata = {
          project: {
            name: project.name,
            path: project.path,
            creationTime: project.creationTime,
            modificationTime: project.modificationTime
          },
          sequence: {
            name: sequence.name,
            duration: sequence.end - sequence.zeroPoint,
            frameRate: sequence.framerate,
            settings: {
              frameSize: {
                width: sequence.frameSizeHorizontal,
                height: sequence.frameSizeVertical
              },
              pixelAspectRatio: sequence.pixelAspectRatio,
              fieldType: sequence.fieldType
            }
          },
          statistics: {
            totalClips: 0,
            totalEffects: 0,
            totalTransitions: 0
          }
        };
        
        // Count clips, effects, and transitions
        for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
          var track = sequence.videoTracks[v];
          metadata.statistics.totalClips += track.clips.numItems;
          metadata.statistics.totalTransitions += track.transitions.numItems;
          
          for (var c = 0; c < track.clips.numItems; c++) {
            metadata.statistics.totalEffects += track.clips[c].components.numItems;
          }
        }
        
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var track = sequence.audioTracks[a];
          metadata.statistics.totalClips += track.clips.numItems;
          metadata.statistics.totalTransitions += track.transitions.numItems;
          
          for (var c = 0; c < track.clips.numItems; c++) {
            metadata.statistics.totalEffects += track.clips[c].components.numItems;
          }
        }
      }
      
      JSON.stringify(metadata);
    `;
    
    return await this.bridge.executeScript(script);
  }

  /**
   * The operating manual, as a plain string.
   *
   * Public because it is served two ways on purpose. As the
   * `premiere://config/get_instructions` resource it is *opt-in* — the client has to
   * know to attach it, and most callers never do, so the guidance that keeps an agent
   * out of trouble was reaching almost nobody. It is now ALSO returned in the
   * `initialize` response via `ServerOptions.instructions`, which is unconditional:
   * every client gets it before the first tool call. Two competing Adobe MCP servers
   * deliver their instructions this way and it is the better channel; the resource
   * stays so a client can re-attach it mid-session without reconnecting.
   *
   * Pure and host-independent — no bridge request.
   */
  getInstructionsText(): string {
    return this.getInstructions();
  }

  private getInstructions(): string {
    return [
      '# Premiere Pro MCP — Operating Instructions',
      '',
      'You are controlling Adobe Premiere Pro (26.3.x) through a verified MCP server.',
      'Call get_capabilities for the exact tool/resource/prompt counts of THIS build and the active tool',
      'profile -- this text deliberately states no tool count, because a hardcoded one drifts out of date',
      'the moment the catalogue changes and a stale number is a lie the agent cannot detect.',
      'Use find_tool to search the catalogue by keyword instead of guessing a tool name.',
      'The tool list you were given is usually a CURATED subset chosen to save your context, not the',
      'whole build. When find_tool returns a match marked exposed:false, that capability exists and you',
      'can still use it: call_tool({ name, args }) invokes it, get_tool_typings({ only: [name] }) gives',
      'you its exact argument shape first, and activate_tools promotes it into your tool list for the',
      'rest of the session. A refusal from call_tool names the setting responsible — a read-only profile,',
      'an explicit allowlist, or an operator exclusion — so treat that as a real boundary, not a retry.',
      'This server uses fail-closed verification: every mutating tool either confirms its effect with a',
      'readback/fingerprint/pixel check or explicitly returns verified:false. Never assume success from',
      'a tool call — always read the verified field in the response.',
      '',
      '## Before you start',
      '- The CEP bridge panel must be open in Premiere (Window > Extensions > MCP Bridge (CEP)), started,',
      '  and pointed at /tmp/premiere-mcp-bridge. If tools time out, the bridge is not running.',
      '- Call get_premiere_state or ping first to confirm the connection.',
      '- Call list_sequences or get_active_sequence to orient before editing.',
      '',
      '## Operating rules',
      '1. Read before writing. Use list_sequences, list_project_items, get_full_sequence_info first.',
      '2. Duplicate sequences before risky changes: duplicate_sequence with clearContents=false.',
      '3. Build in order: clips first → trims/timing → transitions/effects → export.',
      '4. If a tool returns verified:false, do not report success. Report the honest limitation.',
      '5. Use matchNames for effects (not display names — they vary by locale):',
      '   Opacity=AE.ADBE Opacity  Motion=AE.ADBE Motion  Lumetri=AE.ADBE Lumetri',
      '   Gaussian Blur=AE.Impact_Blur_FX  (use list_available_effects for others)',
      '6. Sequence IDs never change. Clip nodeIds persist across sessions. Prefer IDs over names.',
      '7. QE-based tools (speed, frame blend, time interpolation, effect add/remove) are fragile across',
      '   Premiere builds. They verify via readback — trust verified:true, not just success:true.',
      '8. Prefer ONE composite/batch call over N single calls. Every call is a separate bridge round',
      '   trip (~250ms floor), and a composite applies its whole plan in one pass with per-step readback.',
      '9. Cut through every layer with razor_timeline_at_time rather than splitting clip by clip — a',
      '   per-clip loop drifts out of alignment across tracks.',
      '',
      '## Composite tools — reach for these before hand-assembling',
      'For a branded or ad-style assembly, do NOT place clips one at a time. These build a whole',
      'timeline in a single round trip and read every placement back:',
      '  assemble_product_spot — promo timeline from real media. Pass an explicit clipPlan for',
      '    LLM-directed pacing (per-clip duration, transition, motion, trims, effects) instead of',
      '    accepting the template defaults; template mode is only a fallback when you have no plan.',
      '  build_brand_spot_from_mogrt_and_assets — the same, plus a MOGRT title layer.',
      '  build_motion_graphics_demo — a self-contained motion-graphics demo sequence.',
      '  add_to_timeline_batch — many placements in one call. The general-purpose version of the above.',
      '  batch_add_transitions / batch_apply_effect / set_clip_properties_batch — batch the pass, not the clip.',
      '  assemble_review_reel — gap-free reel from a list of sequences (daily review).',
      '  batch_execute — several ExtendScript reads/writes in ONE round trip when no batch tool fits.',
      'Use find_tool to search for a composite before writing a loop of primitives.',
      '',
      '## Effect lookup — use these exact names with apply_video_effect / apply_audio_effect',
      'Video effects are retrieved by display name via QE. Confirmed on 26.3.2:',
      '  Blur & Sharpen: Gaussian Blur, Unsharp Mask',
      '  Color Correction: Lumetri Color (apply via apply_lumetri_preset — more reliable)',
      '  Keying: Ultra Key, Track Matte Key',
      '  Transform: Transform, Mirror, Flip',
      '  Distort: Lens Distortion, Warp Stabilizer',
      '  Generate: 4-Color Gradient, Gradient',
      '  Stylize: Mosaic, Posterize, Emboss',
      '  Time: Posterize Time',
      '  Noise: Median, Noise',
      '  Metadata & Timecode: Metadata & Timecode Burn-in',
      'Audio effects (use with apply_audio_effect):',
      '  Amplitude & Compression: Dynamics Processing, Limiter, Multiband Compressor',
      '  Noise Reduction: Adaptive Noise Reduction, DeHummer, DeReverb',
      '  EQ: Parametric Equalizer, Graphic Equalizer (10 Bands), Graphic Equalizer (20 Bands)',
      '  Delay & Echo: Analog Delay, Convolution Reverb',
      '  Special: DeEsser, Chorus/Flanger, Distortion',
      '',
      '## Lumetri color workflow',
      'For numeric color control (not preset-based):',
      '1. apply_lumetri_preset to add the effect if not present',
      '2. lumetri_basic_set for exposure/contrast/highlights/shadows/whites/blacks/temp/tint/saturation',
      '3. lumetri_creative_set for look intensity, faded film, vibrance',
      '4. lumetri_vignette_set for vignette',
      '5. lumetri_report to read back current state (verified)',
      '6. copy_grade / paste_grade_to_clips to propagate',
      '325 preset names available via get_lumetri_preset_list.',
      '',
      '## Export workflow',
      'Quick path: export_sequence(sequenceId, outputPath, presetPath)',
      'Social: export_social_preset(sequenceId, platform, outputPath) — platforms: youtube, instagram, tiktok, twitter',
      'Custom: create_custom_export_preset writes a .epr and returns its path -- pass that path as the',
      '  presetPath of export_sequence. There is no single-call custom-preset export tool.',
      'Verify output: verify_export(outputPath) — ffprobe checks duration/fps/codec match sequence',
      'Preset files: list_export_presets() for installed .epr paths',
      '',
      '## What this server CANNOT do (the honest wall)',
      'These editor functions have no scripting surface — use the alternatives instead:',
      '- Free-draw shape masks on effects (bezier/ellipse geometry in Effect Controls): no DOM/QE API.',
      '  Alternative: apply_video_effect with "Track Matte Key" (then set_effect_property to pick the matte',
      '  layer and luma/alpha mode), or lumetri_hsl_secondary_set',
      '  (color-keyed isolation). Mask parameters like Feather/Opacity/Inverted ARE scriptable via the',
      '  prproj XML path, but require save+close+reopen cycle.',
      '- Essential Sound auto-analysis: panel logic not exposed. Alternative: apply effects directly',
      '  (denoise_clip, set_parametric_eq, set_compressor) or set_essential_sound_category to tag the clip.',
      '- Clipboard (Premiere internal): no copy/paste clip API. read_clipboard/write_clipboard handle',
      '  system text clipboard only.',
      '- Render & Replace (bake to source media): use bake_speed_change or export+relink instead.',
      '- Merged clips creation: detection only (isMulticamClip/isMergedClip). Use link_audio_video.',
      '- Essential Graphics advanced authoring (gradients, tracking, shape layers).',
      '',
      '## Render status',
      'get_sequence_render_status returns green (rendered) / yellow (needs render) / red (unrendered) / empty bar ranges.',
      'render_sequence_previews triggers renderPreview() — async, check status after.',
      '',
      '## Bridge setup (if tools time out)',
      '1. In Premiere: Window > Extensions > MCP Bridge (CEP)',
      '2. Set Temp Directory to /tmp/premiere-mcp-bridge',
      '3. Click Start Bridge',
      '4. Confirm with ping or verify_premiere_connection',
    ].join('\n');
  }
}
