/**
 * ExportRenderTools -- the Export & Render tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { PlaybackTools } from './playback.js';
import { spawn } from 'child_process';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import * as osSync from 'node:os';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse } from 'node:path';
import { summarizeBatch } from './shared.js';
import type { AddToRenderQueueArgs, CaptureTapReport, EncoderPresetDiscovery, EncoderPresetEntry, ExportSequenceArgs } from './shared.js';
import { runFf } from '../ff-exec.js';

export class ExportRenderTools extends PlaybackTools {
  protected async validateProjectForExport(sequenceId?: string, outputPath?: string, presetPath?: string, requireNonEmptyTimeline = true, checkGaps = true): Promise<any> {
    const script = `
      try {
        var errors = [];
        var warnings = [];
        var info = [];

        function secondsOf(value) {
          if (value === undefined || value === null) return 0;
          if (typeof value === "number") return isFinite(value) ? value : 0;
          // Premiere Pro 26.3 returns sequence.end as a plain tick string rather
          // than a Time object, which previously fell through to 0 and produced a
          // spurious ZERO_DURATION. The timeline inspection tools already read the
          // same value as ticks, so interpret it the same way here.
          if (typeof value === "string") {
            var stringTicks = parseInt(value, 10);
            return isFinite(stringTicks) ? stringTicks / 254016000000.0 : 0;
          }
          if (value.seconds !== undefined) {
            var seconds = Number(value.seconds);
            return isFinite(seconds) ? seconds : 0;
          }
          if (value.ticks !== undefined) {
            var ticks = Number(value.ticks);
            return isFinite(ticks) ? ticks / 254016000000.0 : 0;
          }
          return 0;
        }

        function pathExists(path, expectFolder) {
          if (!path) return false;
          try {
            return expectFolder ? new Folder(path).exists : new File(path).exists;
          } catch (_) {
            return false;
          }
        }

        function parentFolder(path) {
          try {
            return new File(path).parent.fsName;
          } catch (_) {
            return "";
          }
        }

        if (!app.project) {
          return JSON.stringify({
            success: true,
            readyForExport: false,
            errors: [{ code: "NO_PROJECT", message: "No Premiere project is open." }],
            warnings: [],
            info: [],
            summary: {}
          });
        }

        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) {
          errors.push({
            code: ${sequenceId ? '"SEQUENCE_NOT_FOUND"' : '"NO_ACTIVE_SEQUENCE"'},
            message: ${sequenceId ? JSON.stringify(`Sequence not found: ${sequenceId}`) : '"No active sequence is selected."'}
          });
        }

        if (${presetPath ? 'true' : 'false'}) {
          if (!pathExists(${JSON.stringify(presetPath || '')}, false)) {
            errors.push({
              code: "PRESET_NOT_FOUND",
              message: "Export preset file does not exist.",
              path: ${JSON.stringify(presetPath || '')}
            });
          } else if (!/\\.epr$/i.test(${JSON.stringify(presetPath || '')})) {
            warnings.push({
              code: "PRESET_EXTENSION",
              message: "Preset path exists but does not end with .epr.",
              path: ${JSON.stringify(presetPath || '')}
            });
          }
        } else {
          warnings.push({
            code: "PRESET_NOT_PROVIDED",
            message: "No presetPath was provided; export_sequence requires an absolute .epr preset path."
          });
        }

        if (${outputPath ? 'true' : 'false'}) {
          var outputParent = parentFolder(${JSON.stringify(outputPath || '')});
          if (!outputParent || !pathExists(outputParent, true)) {
            errors.push({
              code: "OUTPUT_FOLDER_NOT_FOUND",
              message: "Output parent folder does not exist.",
              path: outputParent || ${JSON.stringify(outputPath || '')}
            });
          }
        } else {
          warnings.push({
            code: "OUTPUT_PATH_NOT_PROVIDED",
            message: "No outputPath was provided; export readiness is partial."
          });
        }

        var summary = {
          projectName: app.project.name || "",
          projectPath: app.project.path || "",
          sequenceId: sequence ? sequence.sequenceID : null,
          sequenceName: sequence ? sequence.name : null,
          durationSeconds: sequence ? secondsOf(sequence.end) : 0,
          videoTrackCount: sequence ? sequence.videoTracks.numTracks : 0,
          audioTrackCount: sequence ? sequence.audioTracks.numTracks : 0,
          videoClipCount: 0,
          audioClipCount: 0,
          markerCount: 0,
          offlineMediaCount: 0,
          gapCount: 0
        };

        var offlineMedia = [];
        var seenMedia = {};
        function inspectProjectItem(item) {
          if (!item) return;
          try {
            if (item.getMediaPath) {
              var mediaPath = String(item.getMediaPath() || "");
              if (mediaPath && !seenMedia[mediaPath]) {
                seenMedia[mediaPath] = true;
                var offline = false;
                try { offline = item.isOffline ? Boolean(item.isOffline()) : false; } catch (_) {}
                if (offline || !pathExists(mediaPath, false)) {
                  offlineMedia.push({
                    nodeId: item.nodeId,
                    name: item.name,
                    mediaPath: mediaPath,
                    offline: offline,
                    fileExists: pathExists(mediaPath, false)
                  });
                }
              }
            }
          } catch (_) {}
          if (item.children) {
            for (var childIndex = 0; childIndex < item.children.numItems; childIndex++) {
              inspectProjectItem(item.children[childIndex]);
            }
          }
        }
        inspectProjectItem(app.project.rootItem);
        summary.offlineMediaCount = offlineMedia.length;
        if (offlineMedia.length) {
          errors.push({
            code: "OFFLINE_OR_MISSING_MEDIA",
            message: "One or more project media files are offline or missing on disk.",
            items: offlineMedia
          });
        }

        var gaps = [];
        if (sequence) {
          var hasVideoClip = false;
          var hasAudioClip = false;

          function inspectTracks(trackCollection, trackType) {
            for (var trackIndex = 0; trackIndex < trackCollection.numTracks; trackIndex++) {
              var track = trackCollection[trackIndex];
              var clips = [];
              for (var clipIndex = 0; clipIndex < track.clips.numItems; clipIndex++) {
                var clip = track.clips[clipIndex];
                var start = secondsOf(clip.start);
                var end = secondsOf(clip.end);
                clips.push({ start: start, end: end, name: clip.name, nodeId: clip.nodeId });
                if (trackType === "video") {
                  summary.videoClipCount++;
                  hasVideoClip = true;
                } else {
                  summary.audioClipCount++;
                  hasAudioClip = true;
                }
              }
              clips.sort(function(a, b) { return a.start - b.start; });
              var cursor = 0;
              for (var gi = 0; gi < clips.length; gi++) {
                if (clips[gi].start - cursor > 0.05) {
                  gaps.push({
                    trackType: trackType,
                    trackIndex: trackIndex,
                    start: cursor,
                    end: clips[gi].start,
                    duration: clips[gi].start - cursor
                  });
                }
                if (clips[gi].end > cursor) cursor = clips[gi].end;
              }
            }
          }

          inspectTracks(sequence.videoTracks, "video");
          inspectTracks(sequence.audioTracks, "audio");

          if (${requireNonEmptyTimeline !== false ? 'true' : 'false'} && summary.videoClipCount + summary.audioClipCount === 0) {
            errors.push({
              code: "EMPTY_TIMELINE",
              message: "The sequence has no video or audio clips."
            });
          }
          if (!hasVideoClip) {
            warnings.push({
              code: "NO_VIDEO_CLIPS",
              message: "The sequence has no video clips."
            });
          }
          if (!hasAudioClip) {
            warnings.push({
              code: "NO_AUDIO_CLIPS",
              message: "The sequence has no audio clips."
            });
          }

          try {
            summary.markerCount = sequence.markers ? sequence.markers.numMarkers : 0;
          } catch (_) {}

          summary.gapCount = gaps.length;
          if (${checkGaps !== false ? 'true' : 'false'} && gaps.length) {
            warnings.push({
              code: "TIMELINE_GAPS",
              message: "Timeline gaps were found. This may be intentional, but agents should verify before export.",
              gaps: gaps
            });
          }

          if (summary.durationSeconds <= 0) {
            errors.push({
              code: "ZERO_DURATION",
              message: "The sequence duration is zero."
            });
          }
        }

        if (!errors.length) {
          info.push({
            code: "EXPORT_READY",
            message: "No blocking export readiness issues were found."
          });
        }

        return JSON.stringify({
          success: true,
          readyForExport: errors.length === 0,
          errors: errors,
          warnings: warnings,
          info: info,
          summary: summary,
          checked: {
            sequenceId: ${sequenceId ? JSON.stringify(sequenceId) : 'null'},
            outputPath: ${outputPath ? JSON.stringify(outputPath) : 'null'},
            presetPath: ${presetPath ? JSON.stringify(presetPath) : 'null'},
            requireNonEmptyTimeline: ${requireNonEmptyTimeline !== false ? 'true' : 'false'},
            checkGaps: ${checkGaps !== false ? 'true' : 'false'}
          }
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected async getSequenceRenderStatus(sequenceId?: string): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        if (!seq) return JSON.stringify({ success: false, error: 'Sequence not found' });
        function timesToArr(arr) { var out=[]; for(var i=0;i<arr.length;i++) out.push({ticks:String(arr[i].ticks),secs:arr[i].secs,frames:arr[i].frames}); return out; }
        var green = timesToArr(seq.getGreenBarTimes());
        var red = timesToArr(seq.getRedBarTimes());
        var yellow = timesToArr(seq.getYellowBarTimes());
        var empty = timesToArr(seq.getEmptyBarTimes());
        var incomplete = seq.isIncompleteBackgroundVideoEffects();
        return JSON.stringify({ success: true, sequenceName: String(seq.name),
          green: { count: green.length/2, ranges: green },
          red: { count: red.length/2, ranges: red },
          yellow: { count: yellow.length/2, ranges: yellow },
          empty: { count: empty.length/2, ranges: empty },
          incompleteBackgroundEffects: incomplete,
          needsRender: red.length > 0 || yellow.length > 0
        });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async renderSequencePreviews(sequenceId?: string, renderAll?: boolean): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var seq = ${this.buildQSeqResolver(sequenceId)};
        if (!seq) return JSON.stringify({ success: false, error: 'Sequence not found' });
        var redBefore = seq.getRedBarTimes().length;
        var yellowBefore = seq.getYellowBarTimes().length;
        if (${renderAll}) { seq.renderAll(); } else { seq.renderPreview(); }
        return JSON.stringify({ success: true, verified: false, note: 'renderPreview() dispatched. Rendering is async — call get_sequence_render_status to check progress.', seqName: String(seq.name), unrenderedSegmentsBefore: redBefore/2, partialSegmentsBefore: yellowBefore/2 });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `;
    return await this.bridge.executeScript(script);
  }

  protected async exportInOutRange(outputPath: string, presetPath: string, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        // workAreaType 1 = work area / in-out range
        var result = seq.exportAsMediaDirect(${JSON.stringify(outputPath)}, ${JSON.stringify(presetPath)}, 1);
        var exists = (new File(${JSON.stringify(outputPath)})).exists;
        return JSON.stringify({success:true,verified:exists,outputPath:${JSON.stringify(outputPath)},exportResult:String(result)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected listAllEncoderPresets(format?: string): any {
    try {
      // Use AME encoder list from our probed catalog
      const formats: Record<string, string[]> = {
        'H.264': ['Match Source - High bitrate', 'Match Source - Medium bitrate', 'YouTube 1080p Full HD', 'YouTube 720p HD', 'Vimeo 1080p Full HD'],
        'H.264 Blu-ray': ['HD 1080i 25', 'HD 1080p 23.976', 'HD 720p 25'],
        'HEVC (H.265)': ['Match Source - High bitrate', 'Match Source - Medium bitrate'],
        'QuickTime': ['Match Source (Rewrap)', 'Apple ProRes 422 HQ', 'Apple ProRes 422', 'Apple ProRes 4444'],
        'Apple ProRes MXF OP1a': ['Apple ProRes 422 HQ', 'Apple ProRes 422 LT', 'Apple ProRes 422 Proxy'],
        'DNxHR/DNxHD MXF OP1a': ['DNX HQ 1080i 50', 'DNX HQ 1080i 59.94', 'Match Source (Rewrap)'],
        'MXF OP1a': ['Match Source (Rewrap)'],
        'MPEG2': ['Match Source - High bitrate', 'Match Source - Medium bitrate'],
        'MPEG4': ['3GPP 176 x 144 H.263'],
        'DPX': ['DPX Sequence - Standard (Match Source)', 'DPX Sequence - Full Range (Match Source)'],
        'OpenEXR': ['OpenEXR Sequence - Piz (Match Source)', 'OpenEXR Sequence - 32bit Float (Match Source)'],
        'PNG': ['PNG Sequence (Match Source)', 'PNG Sequence with Alpha (Match Source)'],
        'TIFF': ['TIFF Sequence (Match Source)'],
        'Targa': ['Targa Sequence (Match Source)'],
        'JPEG': ['JPEG Sequence (Match Source)'],
        'Waveform Audio': ['WAV 48 kHz 16-bit'],
        'AIFF': ['AIFF 48 kHz'],
        'MP3': ['MP3 128 kbps', 'MP3 192 kbps High Quality', 'MP3 256 kbps High Quality'],
        'AAC Audio': ['Stereo AAC, 44.1 kHz 128 kbps', 'Stereo AAC, 48 kHz 256 kbps'],
        'Animated GIF': ['Animated GIF (Match Source)', 'Animated GIF with Transparency (Match Source)'],
      };
      const result = format ? { [format]: formats[format] ?? [] } : formats;
      return { success: true, formats: result, note: 'Static catalog from live probe. Use create_custom_export_preset to modify params.' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected createCustomExportPreset(_format: string, _basePresetName: string | undefined, _params: Record<string, string>, _outputPresetPath: string): any {
    return { success: false, error: 'create_custom_export_preset requires the AME bridge (app.encoder). Use execute_extendscript with: var exp = app.encoder.getExporters(); then find your format, call getPresets(), setExportParamValue(k,v) for each param, writeToFile(path).' };
  }

  protected async exportSocialPreset(outputPath: string, preset: string, sequenceId?: string): Promise<any> {
    const presetSettings: Record<string, Record<string, string>> = {
      youtube_1080p: { Width: '1920', Height: '1080', TargetBitrate: '8', MaxBitrate: '10', FrameRate: '29.97' },
      youtube_4k: { Width: '3840', Height: '2160', TargetBitrate: '40', MaxBitrate: '50', FrameRate: '29.97' },
      instagram_1080p: { Width: '1080', Height: '1080', TargetBitrate: '3.5', MaxBitrate: '5' },
      instagram_reels: { Width: '1080', Height: '1920', TargetBitrate: '3.5', MaxBitrate: '5' },
      tiktok: { Width: '1080', Height: '1920', TargetBitrate: '4', MaxBitrate: '6' },
      twitter: { Width: '1280', Height: '720', TargetBitrate: '6', MaxBitrate: '8' },
    };
    const settings = presetSettings[preset] ?? presetSettings.youtube_1080p;
    const settingsEntries = Object.entries(settings ?? {}) as Array<[string, string]>;
    const paramStr = settingsEntries.map((entry: [string, string]) => `preset.setExportParamValue(${JSON.stringify(entry[0])}, ${JSON.stringify(entry[1])});`).join('\n');
    return await this.bridge.executeScript(`
      try {
        var exporters = app.encoder.getExporters();
        var h264 = null;
        for (var i=0;i<exporters.length;i++) { if (String(exporters[i].name)==='H.264'){h264=exporters[i];break;} }
        if (!h264) return JSON.stringify({success:false,error:'H.264 exporter not found'});
        var presets = h264.getPresets();
        var preset = presets[0];
        ${paramStr}
        var tmpPath = '/tmp/premiere-mcp-bridge/generated-assets/social_preset.epr';
        preset.writeToFile(tmpPath);
        var seq = ${this.buildSeqRes(sequenceId)};
        var r = app.encoder.exportWithPresetObject(${JSON.stringify(outputPath)}, preset, seq, false);
        return JSON.stringify({success:true,preset:${JSON.stringify(preset)},settings:${JSON.stringify(settings)},outputPath:${JSON.stringify(outputPath)},exportResult:String(r)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async exportAudioOnly(outputPath: string, format: string, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var exporters = app.encoder.getExporters();
        var target = null;
        var targetName = ${JSON.stringify(format)} === 'aac' ? 'AAC Audio' : 'Waveform Audio';
        for (var i=0;i<exporters.length;i++) { if (String(exporters[i].name)===targetName){target=exporters[i];break;} }
        if (!target) return JSON.stringify({success:false,error:'Exporter not found: '+targetName});
        var preset = target.getPresets()[0];
        var seq = ${this.buildSeqRes(sequenceId)};
        var r = app.encoder.exportWithPresetObject(${JSON.stringify(outputPath)}, preset, seq, false);
        return JSON.stringify({success:true,outputPath:${JSON.stringify(outputPath)},format:${JSON.stringify(format)},exportResult:String(r)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected verifyExport(filePath: string, expectedDurationSecs?: number, expectedFps?: number, expectedWidth?: number, expectedHeight?: number): any {
    const fs = fsSync;
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
      const probe = runFf('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-of', 'json', '-show_streams', filePath], { timeoutMs: 10000 });
      const data = JSON.parse(probe);
      const stream = data.streams?.[0] ?? {};
      const durationSecs = parseFloat(stream.duration ?? '0');
      const width = stream.width ?? 0;
      const height = stream.height ?? 0;
      const fpsStr = stream.r_frame_rate ?? '0/1';
      const fpsParts = fpsStr.split('/');
      const fps = parseFloat(fpsParts[0]) / parseFloat(fpsParts[1] || '1');
      const checks: string[] = [];
      if (expectedDurationSecs !== undefined) {
        const durationOk = Math.abs(durationSecs - expectedDurationSecs) <= 1;
        checks.push(`duration: ${durationOk ? 'PASS' : 'FAIL'} (got ${durationSecs.toFixed(2)}s, expected ${expectedDurationSecs}s)`);
      }
      if (expectedFps !== undefined) checks.push(`fps: ${Math.abs(fps - expectedFps) < 0.1 ? 'PASS' : 'FAIL'} (got ${fps.toFixed(3)}, expected ${expectedFps})`);
      if (expectedWidth !== undefined) checks.push(`width: ${width === expectedWidth ? 'PASS' : 'FAIL'} (got ${width}, expected ${expectedWidth})`);
      if (expectedHeight !== undefined) checks.push(`height: ${height === expectedHeight ? 'PASS' : 'FAIL'} (got ${height}, expected ${expectedHeight})`);
      const allPass = checks.every(c => c.includes('PASS'));
      return { success: true, qcPass: allPass || checks.length === 0, checks, filePath, durationSecs, width, height, fps, fileSize: fs.statSync(filePath).size };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected async exportSequenceAsProject(outputPath: string, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var result = seq.exportAsProject(${JSON.stringify(outputPath)});
        var exists = (new File(${JSON.stringify(outputPath)})).exists;
        return JSON.stringify({success:true,verified:exists,outputPath:${JSON.stringify(outputPath)},sequenceName:String(seq.name),exportResult:String(result)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async getRendererNames(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var names = qe.project.getRendererNames();
        var list = [];
        for (var i=0;i<names.length;i++) list.push(String(names[i]));
        return JSON.stringify({success:true,renderers:list,count:list.length});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setRenderer(rendererName: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        qe.project.setRenderer(${JSON.stringify(rendererName)});
        return JSON.stringify({success:true,verified:false,renderer:${JSON.stringify(rendererName)},note:'Renderer set. Restart Premiere to confirm the change took effect.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async setRenderPreviewQuality(useMaxQuality?: boolean, presetPath?: string, width?: number, height?: number, sequenceId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var qseq = ${this.buildQSeqResolver(sequenceId)};
        ${useMaxQuality !== undefined ? `qseq.setUseMaxRenderQuality(${useMaxQuality}); qseq.setUseMaxBitDepth(${useMaxQuality});` : ''}
        ${presetPath ? `qseq.setPreviewPresetPath(${JSON.stringify(presetPath)});` : ''}
        ${width && height ? `qseq.setPreviewFrameSize(${width}, ${height});` : ''}
        return JSON.stringify({success:true,useMaxQuality:${useMaxQuality??null},presetPath:${JSON.stringify(presetPath??null)},size:${width&&height?`"${width}x${height}"`:'null'}});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected checkFfmpegAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('ffmpeg', ['-version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  /** The ffmpeg binary, overridable for installs that expose a different name. */
  protected ffmpegCmd(): string {
    return (process.env.PREMIERE_MCP_FFMPEG_CMD || 'ffmpeg').trim() || 'ffmpeg';
  }

  protected async probeMedia(mediaPath?: string, projectItemId?: string): Promise<any> {
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

    const ffprobe = this.ffprobeCmd();
    const available = await this.checkCommandAvailable(ffprobe, ['-version']);
    if (!available) {
      return {
        success: false,
        error: `ffprobe ('${ffprobe}') was not found on PATH. probe_media reads media metadata with ffprobe, which ships with ffmpeg, not via Premiere's scripting API. Install ffmpeg (e.g. \`brew install ffmpeg\` on macOS) or set PREMIERE_MCP_FFPROBE_CMD to the binary name, then try again.`,
      };
    }

    return await new Promise((resolve) => {
      const argv = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', resolvedPath as string];
      const proc = spawn(ffprobe, argv);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => {
        resolve({ success: false, error: `Failed to run ffprobe ('${ffprobe}'): ${err.message}`, mediaPath: resolvedPath });
      });
      proc.on('close', (code) => {
        let parsed: any;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          resolve({
            success: false,
            error: `ffprobe exited with code ${code} and did not return parseable metadata. The file may be unreadable or not a media file.`,
            mediaPath: resolvedPath,
            ffprobeStderr: stderr.slice(-2000),
          });
          return;
        }
        const summary = this.buildProbeSummary(parsed);
        resolve({ success: true, mediaPath: resolvedPath, summary, probe: parsed });
      });
    });
  }

  /**
   * Probe which render-truth capture taps are usable on THIS machine, cached
   * with a short TTL so a burst of captures does not re-probe each time (speed
   * mandate). Four taps, one abstraction:
   *
   *   - render/export: zero-dependency, both OSes, video + audio (via Premiere's
   *     own frame export / Media Encoder). Always available whenever Premiere is
   *     connected -- it is the correctness fallback, never the latency path.
   *   - NDI: real-time video + audio, both OSes; needs an NDI runtime + a
   *     Transmit-style plugin publishing the Program feed.
   *   - Syphon: lowest-latency GPU frame, macOS only, video only.
   *   - Spout: lowest-latency GPU frame, Windows only, video only.
   *
   * The GPU/network taps require a native receiver we do not ship yet, so unless
   * an install advertises one via an env override we report them unavailable
   * with honest per-OS install guidance rather than pretending they work. This
   * probe is intentionally cheap and side-effect-free; it never spawns a
   * receiver (warm persistent receivers are a later optimisation, not something
   * to start here on a mere probe).
   */
  protected probeCaptureTaps(): CaptureTapReport[] {
    const CACHE_TTL_MS = 30_000;
    const cached = this.captureTapsCache;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.taps;
    }

    const os = platform(); // 'darwin' | 'win32' | 'linux' | ...
    const isMac = os === 'darwin';
    const isWin = os === 'win32';

    // An install can point us at a receiver it set up itself. We only claim a
    // GPU/network tap is available when such a signal is present -- never guess.
    const ndiEnv = Boolean(process.env.PREMIERE_MCP_NDI_RECEIVER);
    const syphonEnv = Boolean(process.env.PREMIERE_MCP_SYPHON_RECEIVER);
    const spoutEnv = Boolean(process.env.PREMIERE_MCP_SPOUT_RECEIVER);

    const taps: CaptureTapReport[] = [
      {
        tap: 'render',
        available: true,
        video: true,
        audio: true,
        realtime: false,
        reason: 'Zero-dependency: captures the composited frame via Premiere\'s own frame export. Requires only that Premiere is connected.',
      },
      {
        tap: 'ndi',
        available: ndiEnv,
        video: true,
        audio: true,
        realtime: true,
        reason: ndiEnv
          ? 'NDI receiver advertised via PREMIERE_MCP_NDI_RECEIVER.'
          : 'No NDI receiver detected. NDI gives a real-time video+audio feed on macOS and Windows but needs an NDI runtime plus a Transmit-style plugin publishing the Program feed.',
        install: ndiEnv
          ? undefined
          : 'Install the NDI Tools/runtime (ndi.video) and a Premiere Transmit plugin that outputs NDI, then set PREMIERE_MCP_NDI_RECEIVER to your receiver command/endpoint.',
      },
      {
        tap: 'syphon',
        available: isMac && syphonEnv,
        video: true,
        audio: false,
        realtime: true,
        reason: !isMac
          ? `Syphon is macOS-only; this host is ${os}. Use Spout on Windows or NDI cross-platform.`
          : (syphonEnv
            ? 'Syphon receiver advertised via PREMIERE_MCP_SYPHON_RECEIVER.'
            : 'No Syphon receiver detected. Syphon is the lowest-latency macOS GPU frame tap (video only).'),
        install: isMac && !syphonEnv
          ? 'Install a Syphon-capable Transmit plugin for Premiere plus a Syphon receiver, then set PREMIERE_MCP_SYPHON_RECEIVER to your receiver command.'
          : undefined,
      },
      {
        tap: 'spout',
        available: isWin && spoutEnv,
        video: true,
        audio: false,
        realtime: true,
        reason: !isWin
          ? `Spout is Windows-only; this host is ${os}. Use Syphon on macOS or NDI cross-platform.`
          : (spoutEnv
            ? 'Spout receiver advertised via PREMIERE_MCP_SPOUT_RECEIVER.'
            : 'No Spout receiver detected. Spout is the lowest-latency Windows GPU frame tap (video only).'),
        install: isWin && !spoutEnv
          ? 'Install a Spout-capable Transmit plugin for Premiere plus a Spout receiver, then set PREMIERE_MCP_SPOUT_RECEIVER to your receiver command.'
          : undefined,
      },
    ];

    this.captureTapsCache = { at: Date.now(), taps };
    return taps;
  }

  /**
   * Capture the actual COMPOSITED Program Monitor output -- the real rendered
   * pixels of the sequence at a time -- and write it to an image, so a model can
   * SEE what the edit renders to rather than trusting an API return value. This
   * is Wall 1 of the render-truth loop.
   *
   * Premiere never hands script a framebuffer of the program, so the frame is
   * obtained off one of four taps (see probeCaptureTaps). The render/export tap
   * is the zero-dependency correctness path and reuses exportFrame (Premiere's
   * own QE frame export, which bakes in every clip/effect/title/grade). The
   * GPU/network taps (NDI/Syphon/Spout) are real-time but require a native
   * receiver we do not ship yet; when one is forced and unavailable we return
   * install guidance rather than silently substituting render/export.
   *
   * Honesty contract: always report which tap was actually used; verify a real
   * frame landed on disk (delegated to exportFrame's verify-after-write) before
   * claiming success; never hang and never fake a frame.
   */
  protected async captureProgramOutput(
    sequenceId?: string,
    time?: number,
    format: 'png' | 'jpg' | 'tiff' = 'png',
    outputPath?: string,
    tap: 'auto' | 'render' | 'ndi' | 'syphon' | 'spout' = 'auto',
    probeOnly = false,
  ): Promise<any> {
    const taps = this.probeCaptureTaps();
    const tapReport = (name: string): CaptureTapReport | undefined => taps.find((t) => t.tap === name);

    if (probeOnly) {
      const best = taps.find((t) => t.available && t.realtime) || tapReport('render');
      return {
        success: true,
        probeOnly: true,
        os: platform(),
        taps,
        recommendedTap: best ? best.tap : 'render',
        note: 'Capability probe only -- no frame was captured. render/export is always available when Premiere is connected; NDI/Syphon/Spout need a Transmit plugin + native receiver (see each tap\'s install guidance).',
      };
    }

    // Resolve which tap to actually use. GPU/network taps are not yet wired to a
    // receiver here, so the only tap that can produce a frame is render/export.
    const requested = tap || 'auto';
    if (requested !== 'auto' && requested !== 'render') {
      const report = tapReport(requested);
      // Forcing an unavailable GPU/network tap must fail honestly, not fall back silently.
      return {
        success: false,
        requestedTap: requested,
        available: false,
        error: `Capture tap '${requested}' is not available on this machine. ${report ? report.reason : ''}`.trim(),
        install: report ? report.install : undefined,
        hint: 'Pass tap:"render" (or tap:"auto") to use the zero-dependency render/export tap, or probeOnly:true to see all taps.',
        taps,
      };
    }
    // 'render' explicitly, or 'auto' (no real-time receiver present → render/export is the best available).
    const chosenTap: CaptureTapReport = tapReport('render') as CaptureTapReport;

    // Resolve sequence: explicit id, else the active sequence.
    let resolvedSequenceId = sequenceId;
    let resolvedSequenceName: string | undefined;
    if (!resolvedSequenceId) {
      const active = await this.resolveActiveSequenceId();
      if (active.error || !active.id) {
        return {
          success: false,
          error: active.error || 'No sequenceId provided and no active sequence to capture.',
          tapUsed: chosenTap.tap,
        };
      }
      resolvedSequenceId = active.id;
      resolvedSequenceName = active.name;
    }

    // Resolve time: explicit, else the current playhead of that sequence.
    let resolvedTime: number;
    if (time === undefined || time === null) {
      const playhead = await this.getPlayheadPosition(resolvedSequenceId);
      resolvedTime = (playhead && playhead.success && typeof playhead.position === 'number')
        ? playhead.position
        : 0;
    } else {
      resolvedTime = time;
    }

    // Default output path: a timestamped file in the system temp dir so we never
    // scatter files at the caller's cwd and never overwrite a prior capture.
    const outPath = (outputPath && outputPath.trim())
      || join(tmpdir(), `premiere-program-${resolvedSequenceId}-${Date.now()}.${format}`);

    const result = await this.exportFrame(resolvedSequenceId, resolvedTime, outPath, format);

    if (!result || !result.success) {
      return {
        success: false,
        tapUsed: chosenTap.tap,
        requestedTap: requested,
        sequenceId: resolvedSequenceId,
        time: resolvedTime,
        error: (result && result.error) || 'Frame capture failed and no frame was written.',
        note: 'The render/export tap could not produce a composited frame. Ensure Premiere is connected and the sequence can be opened in a timeline.',
      };
    }

    return {
      success: true,
      tapUsed: chosenTap.tap,
      requestedTap: requested,
      autoSelected: requested === 'auto',
      sequenceId: resolvedSequenceId,
      sequenceName: result.sequenceName || resolvedSequenceName,
      time: resolvedTime,
      format,
      outputPath: result.outputPath,
      requestedPath: result.requestedPath || outPath,
      video: chosenTap.video,
      audio: false,
      realtime: chosenTap.realtime,
      note: 'Composited Program frame captured via the render/export tap (all clips, effects, titles and grades baked in). For real-time video+audio, install an NDI/Syphon/Spout receiver -- run this tool with probeOnly:true for guidance.',
    };
  }

  private displayNameFromPresetXml(xml: string): string | undefined {
    const patterns = [
      /<PresetName[^>]*>([^<]+)<\/PresetName>/i,
      /<Name[^>]*>([^<]+)<\/Name>/i,
      /\bPresetName="([^"]+)"/i,
      /\bName="([^"]+)"/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(xml);
      const name = match?.[1] ? this.decodeXmlEntities(match[1]) : '';
      if (name) return name;
    }
    return undefined;
  }

  private async defaultEncoderPresetDirectories(): Promise<string[]> {
    const baseDirs = [
      // Where AME saves user presets on both macOS and Windows.
      join(homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder'),
      join(homedir(), 'Library', 'Application Support', 'Adobe', 'Common', 'AME'),
    ];
    if (process.env.APPDATA) {
      baseDirs.push(join(process.env.APPDATA, 'Adobe', 'Common', 'AME'));
    }

    const presetDirs = new Set<string>();
    for (const baseDir of baseDirs) {
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = await fs.readdir(baseDir, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        presetDirs.add(join(baseDir, 'Presets'));
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          presetDirs.add(join(baseDir, entry.name, 'Presets'));
        }
      }
    }
    return [...presetDirs].sort();
  }

  private ameVersionFromPresetDirectory(directory: string): string {
    return basename(directory).toLowerCase() === 'presets'
      ? basename(dirname(directory))
      : basename(directory);
  }

  protected async getEncoderPresets(directories?: string[]): Promise<EncoderPresetDiscovery> {
    const searchedDirectories = directories && directories.length > 0
      ? directories
      : await this.defaultEncoderPresetDirectories();
    const presets: EncoderPresetEntry[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    for (const directory of searchedDirectories) {
      let entries: Array<{ name: string; isFile(): boolean }>;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          errors.push({ path: directory, error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.epr') continue;
        const presetPath = join(directory, entry.name);
        try {
          await fs.access(presetPath, fsConstants.R_OK);
          const xml = await fs.readFile(presetPath, 'utf8');
          presets.push({
            name: this.displayNameFromPresetXml(xml) ?? parse(entry.name).name,
            path: presetPath,
            source: 'user',
            ameVersion: this.ameVersionFromPresetDirectory(directory),
          });
        } catch (error) {
          errors.push({ path: presetPath, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    presets.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return {
      success: true,
      presets,
      count: presets.length,
      searchedDirectories,
      errors,
      factoryPresets: {
        supported: false,
        note: 'Factory preset enumeration is not complete or supported; save a user .epr preset in AME and rediscover it here.',
      },
    };
  }

  private async resolvePresetPath(presetPath?: string, presetName?: string): Promise<
    { success: true; presetPath: string; presetName?: string; presetResolution?: any } |
    { success: false; error: string; presetName?: string; matches?: EncoderPresetEntry[]; searchedDirectories?: string[] }
  > {
    if (presetPath && presetName) {
      return { success: false, error: 'Provide either presetPath or presetName, not both.', presetName };
    }

    if (presetPath) {
      return { success: true, presetPath };
    }

    if (!presetName) {
      return {
        success: false,
        error: 'presetPath or presetName required — Adobe encodeSequence requires an absolute .epr preset file.',
      };
    }

    const discovery = await this.getEncoderPresets();
    const matches = discovery.presets.filter((preset) => preset.name === presetName || parse(preset.path).name === presetName);
    if (matches.length === 1) {
      const [match] = matches as [EncoderPresetEntry];
      return {
        success: true,
        presetPath: match.path,
        presetName,
        presetResolution: {
          method: 'exact_name',
          name: match.name,
          path: match.path,
          ameVersion: match.ameVersion,
        },
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: `presetName "${presetName}" is ambiguous; pass presetPath instead.`,
        presetName,
        matches,
        searchedDirectories: discovery.searchedDirectories,
      };
    }
    return {
      success: false,
      error: `presetName "${presetName}" was not found in user AME presets.`,
      presetName,
      searchedDirectories: discovery.searchedDirectories,
    };
  }

  private async validateExportPaths(outputPath: string, presetPath: string, allowOverwrite = false): Promise<Array<{ code: string; message: string; path?: string }>> {
    const errors: Array<{ code: string; message: string; path?: string }> = [];

    if (!isAbsolute(presetPath)) {
      errors.push({ code: 'PRESET_PATH_NOT_ABSOLUTE', message: 'presetPath must be an absolute .epr path.', path: presetPath });
    } else if (extname(presetPath).toLowerCase() !== '.epr') {
      errors.push({ code: 'PRESET_EXTENSION', message: 'presetPath must point to a .epr file.', path: presetPath });
    } else {
      try {
        await fs.access(presetPath, fsConstants.R_OK);
      } catch {
        errors.push({ code: 'PRESET_NOT_READABLE', message: 'Export preset file does not exist or is not readable.', path: presetPath });
      }
    }

    if (!isAbsolute(outputPath)) {
      errors.push({ code: 'OUTPUT_PATH_NOT_ABSOLUTE', message: 'outputPath must be absolute.', path: outputPath });
    } else {
      const outputDirectory = dirname(outputPath);
      try {
        const stat = await fs.stat(outputDirectory);
        if (!stat.isDirectory()) {
          errors.push({ code: 'OUTPUT_FOLDER_NOT_DIRECTORY', message: 'Output parent path is not a directory.', path: outputDirectory });
        }
      } catch {
        errors.push({ code: 'OUTPUT_FOLDER_NOT_FOUND', message: 'Output parent folder does not exist.', path: outputDirectory });
      }

      try {
        await fs.access(outputPath, fsConstants.F_OK);
        if (!allowOverwrite) {
          errors.push({ code: 'OUTPUT_EXISTS', message: 'Output file already exists; pass allowOverwrite:true to replace it.', path: outputPath });
        }
      } catch {
        // Missing output file is the normal export case.
      }
    }

    return errors;
  }

  private deprecatedExportOptionWarnings(format?: string, quality?: string, resolution?: string): Array<{ code: string; message: string; value?: string }> {
    const warnings: Array<{ code: string; message: string; value?: string }> = [];
    if (format) warnings.push({ code: 'FORMAT_IGNORED', message: 'format is deprecated for export_sequence; the .epr preset controls the container and codec.', value: format });
    if (quality) warnings.push({ code: 'QUALITY_IGNORED', message: 'quality is deprecated for export_sequence; the .epr preset controls export quality.', value: quality });
    if (resolution) warnings.push({ code: 'RESOLUTION_IGNORED', message: 'resolution is deprecated for export_sequence; the .epr preset controls output dimensions.', value: resolution });
    return warnings;
  }

  protected async exportSequence(args: ExportSequenceArgs): Promise<any> {
    const {
      sequenceId,
      outputPath,
      presetName,
      sourceRange = 'entire',
      allowOverwrite = false,
      removeOnCompletion = true,
      format,
      quality,
      resolution,
    } = args;
    // app.encoder.encodeSequence() expects an absolute path to a .epr preset file.
    // Passing a string name like "H.264" silently fails: encodeSequence returns
    // no jobID and the JSX bridge reports {success:false}. Reject early with a
    // clear error rather than letting the user think a queue happened.
    const presetResolution = await this.resolvePresetPath(args.presetPath, presetName);
    if (!presetResolution.success) {
      return {
        success: false,
        error: presetResolution.error,
        hint: 'Create the preset in AME UI: File → Export Settings → configure → Save Preset → exports to ~/Library/Application Support/Adobe/Common/AME/<version>/Presets/. Pass that .epr path as presetPath.',
        sequenceId,
        outputPath,
        presetName,
        matches: presetResolution.matches,
        searchedDirectories: presetResolution.searchedDirectories,
        format,
        quality,
        resolution,
      };
    }
    const presetPath = presetResolution.presetPath;

    const pathErrors = await this.validateExportPaths(outputPath, presetPath, allowOverwrite);
    const warnings = this.deprecatedExportOptionWarnings(format, quality, resolution);
    if (pathErrors.length > 0) {
      return {
        success: false,
        error: pathErrors.map((pathError) => pathError.message).join(' '),
        errors: pathErrors,
        warnings,
        sequenceId,
        outputPath,
        presetPath,
        presetName,
        sourceRange,
        allowOverwrite,
        format,
        quality,
        resolution,
      };
    }

    try {
      // bridge.renderSequence returns a structured response; propagate it instead
      // of unconditionally claiming success. Pre-fix wrapper reported success even
      // when AME never received the job (false-success false positives).
      const result = await this.bridge.renderSequence(sequenceId, outputPath, presetPath, {
        sourceRange,
        removeOnCompletion,
      });

      if (result && result.success === false) {
        return {
          ...result,
          sequenceId,
          outputPath,
          presetPath,
          presetName,
          presetResolution: presetResolution.presetResolution,
          sourceRange,
          allowOverwrite,
          warnings: [...warnings, ...(result.warnings ?? [])],
          format,
          quality,
          resolution,
        };
      }

      return {
        success: true,
        status: result?.status ?? 'queued',
        message: 'Sequence queued in Adobe Media Encoder. Render runs asynchronously — verify by checking the output file size growth.',
        sequenceId,
        outputPath,
        presetPath,
        presetName,
        presetResolution: presetResolution.presetResolution,
        sourceRange,
        resolvedRange: result?.resolvedRange,
        encoderRangeConstant: result?.encoderRangeConstant,
        removeOnCompletion,
        format,
        quality,
        resolution,
        warnings: [...warnings, ...(result?.warnings ?? [])],
        jobID: result?.jobID,
        queued: result?.queued,
        queueStarted: result?.queueStarted,
        verify: `ffprobe -show_entries format=duration,size '${outputPath}'`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to export sequence: ${error instanceof Error ? error.message : String(error)}`,
        sequenceId,
        outputPath,
      };
    }
  }

  protected async exportFrame(sequenceId: string, time: number, outputPath: string, format = 'png'): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });

        if (sequence.openInTimeline) {
          try { sequence.openInTimeline(); } catch (e0) {}
        }

        // Resolve the QE handle for the sequence the caller named. Reaching for
        // qe.project.getActiveSequence() here exported whatever happened to be
        // open in the timeline instead: asking for a non-active sequence
        // returned success, echoed back the requested sequenceId, and wrote a
        // frame of the active sequence's content.
        var qeSequence = __qeSequenceFor(sequence);
        if (!qeSequence) {
          return JSON.stringify({
            success: false,
            error: "Could not address sequence '" + sequence.name + "' through the QE API, which frame export requires. Open it in a timeline and retry."
          });
        }

        // Normalize the format to the exact QE method + extension, confirmed live:
        // exportFramePNG/.png, exportFrameJPEG/.jpg, exportFrameTIFF/.tif,
        // exportFrameDPX/.dpx, exportFrameTarga/.tga. The method name is
        // case-sensitive in ExtendScript, so "exportFrameTiff" (wrong casing) silently
        // failed every TIFF export until this was corrected to "exportFrameTIFF".
        var fmt = ${JSON.stringify(format)}.toLowerCase();
        if (fmt === "jpeg") fmt = "jpg";
        else if (fmt === "tiff") fmt = "tif";
        else if (fmt === "targa") fmt = "tga";
        var methodName, formatExtension, formatExts;
        if (fmt === "jpg") { methodName = "exportFrameJPEG"; formatExtension = ".jpg"; formatExts = [".jpg", ".jpeg"]; }
        else if (fmt === "tif") { methodName = "exportFrameTIFF"; formatExtension = ".tif"; formatExts = [".tif", ".tiff"]; }
        else if (fmt === "dpx") { methodName = "exportFrameDPX"; formatExtension = ".dpx"; formatExts = [".dpx"]; }
        else if (fmt === "tga") { methodName = "exportFrameTarga"; formatExtension = ".tga"; formatExts = [".tga", ".targa"]; }
        else { methodName = "exportFramePNG"; formatExtension = ".png"; formatExts = [".png"]; }
        if (typeof qeSequence[methodName] !== "function") {
          return JSON.stringify({
            success: false,
            error: "Frame export format '" + ${JSON.stringify(format)} + "' is not supported by the available Premiere API"
          });
        }

        var timeNumber = ${time};
        var timeString = String(timeNumber);
        var timeTicks = timeString;
        try {
          var exportTime = new Time();
          exportTime.seconds = timeNumber;
          timeTicks = exportTime.ticks;
        } catch (e1) {}

        // Premiere's exportFrame* methods always append "." + format to the
        // path they are handed, so passing the caller's "shot.png" wrote
        // "shot.png.png" while the tool reported "shot.png" — a path with no
        // file at it. Hand Premiere the stem and let it add the extension back.
        // Strip any accepted spelling of the extension (".tiff" as well as the
        // canonical ".tif", ".jpeg" as well as ".jpg") so the double-extension
        // never reappears for an alias; Premiere writes the canonical extension.
        var requestedPath = ${JSON.stringify(outputPath)};
        var exportStem = requestedPath;
        for (var fx = 0; fx < formatExts.length; fx++) {
          var fxExt = formatExts[fx];
          if (requestedPath.length > fxExt.length && requestedPath.substring(requestedPath.length - fxExt.length).toLowerCase() === fxExt) {
            exportStem = requestedPath.substring(0, requestedPath.length - fxExt.length);
            break;
          }
        }

        // Where the frame can land: the canonical extension Premiere writes, each
        // accepted alias off the stem, and the raw requested path (in case a future
        // version stops appending). writtenPath() picks whichever actually appeared.
        var candidatePaths = [exportStem + formatExtension];
        for (var cf = 0; cf < formatExts.length; cf++) candidatePaths.push(exportStem + formatExts[cf]);
        candidatePaths.push(requestedPath);

        // A non-throwing call is not proof that a file was written, so record
        // what is on disk first. Comparing modification stamps rather than mere
        // existence keeps a stale file from an earlier run from being reported
        // as this call's output.
        var beforeState = [];
        for (var p = 0; p < candidatePaths.length; p++) {
          var state = { existed: false, stamp: 0, length: -1 };
          try {
            var probe = new File(candidatePaths[p]);
            if (probe.exists) {
              state.existed = true;
              state.stamp = probe.modified ? probe.modified.getTime() : 0;
              state.length = probe.length;
            }
          } catch (eProbe) {}
          beforeState.push(state);
        }

        // Returns the path that looks freshly written, or null. Freshness is judged
        // on modification time first and length second, because a filesystem with
        // one-second timestamp granularity can rewrite a file within the same second
        // and leave the stamp unchanged.
        function writtenPath(acceptUnchanged) {
          for (var w = 0; w < candidatePaths.length; w++) {
            try {
              var file = new File(candidatePaths[w]);
              if (!file.exists) continue;
              if (!beforeState[w].existed) return candidatePaths[w];
              var stamp = file.modified ? file.modified.getTime() : 0;
              if (stamp !== beforeState[w].stamp) return candidatePaths[w];
              if (file.length !== beforeState[w].length) return candidatePaths[w];
              // Neither moved. The export may still have written identical bytes over
              // an existing file, so on the final check accept it rather than report a
              // failure for a write that did happen -- a false failure invites a retry.
              if (acceptUnchanged) return candidatePaths[w];
            } catch (eCheck) {}
          }
          return null;
        }

        var exportError = null;
        function tryExport(arg1, arg2) {
          try {
            qeSequence[methodName](arg1, arg2);
          } catch (e2) {
            exportError = e2.toString();
            return false;
          }
          // Some argument orders are accepted without throwing and without
          // producing anything, so keep probing the remaining orders rather
          // than reporting a success that left no file behind.
          return writtenPath(false) !== null;
        }

        // Timecode first and only: seconds and ticks strings are accepted and silently export
        // frame 0 (see __qeTimecode), so they must never be tried as fallbacks.
        var exportTimecode = __qeTimecode(sequence, timeNumber);
        var exported = tryExport(exportTimecode, exportStem);

        var actualPath = writtenPath(true);
        if (!exported || !actualPath) {
          return JSON.stringify({
            success: false,
            error: exportError || "Frame export reported no error but wrote no file"
          });
        }

        return JSON.stringify({
          success: true,
          message: "Frame exported successfully",
          timecode: exportTimecode,
          sequenceId: ${JSON.stringify(sequenceId)},
          sequenceName: sequence.name,
          time: ${time},
          outputPath: actualPath,
          requestedPath: requestedPath,
          format: ${JSON.stringify(format)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  protected exportGif(mediaPath: string, startSecs: number, durationSecs: number, fps: number, width: number, outputPath: string): any {
    const palette = outputPath.replace(/\.gif$/i, '_palette.png');
    try {
      runFf('ffmpeg', ['-y', '-ss', String(startSecs), '-t', String(durationSecs), '-i', mediaPath, '-vf', `fps=${Number(fps)},scale=${Number(width)}:-1:flags=lanczos,palettegen`, '-update', '1', palette], { timeoutMs: 30000 });
      runFf('ffmpeg', ['-y', '-ss', String(startSecs), '-t', String(durationSecs), '-i', mediaPath, '-i', palette, '-filter_complex', `fps=${Number(fps)},scale=${Number(width)}:-1:flags=lanczos[x];[x][1:v]paletteuse`, outputPath], { timeoutMs: 30000 });
      const fs = fsSync;
      try { fs.unlinkSync(palette); } catch {}
      return { success: fs.existsSync(outputPath), outputPath, fps, width };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  protected exportStillsBatch(mediaPath: string, outputDir: string, _seqId?: string): any {
    const path = pathSync, fs = fsSync;
    try {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const prefix = path.join(outputDir, 'still_%04d.jpg');
      runFf('ffmpeg', ['-y', '-i', mediaPath, '-vf', 'fps=1/10', prefix], { timeoutMs: 60000 });
      const files = fs.readdirSync(outputDir).filter((f: string) => f.match(/still_\d+\.jpg/)).map((f: string) => path.join(outputDir, f));
      return { success: true, count: files.length, paths: files };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  /**
   * Export a still at the playhead.
   *
   * The QE route (`exportFrameJPEG`) is tried first and is what this tool always used, but on
   * 26.3.2 it returns false and writes nothing — so this tool reported `success: false` with
   * NO error field at all, just `qeResult: "false"`. The file-exists check was already correct;
   * the failure was silent.
   *
   * When QE writes nothing, fall back to ffmpeg against the source media of the clip under the
   * playhead. That distinction is reported rather than smoothed over: ffmpeg renders the SOURCE
   * frame, without effects, transitions, or anything from tracks above. For a composited frame
   * use capture_program_output, which is verified working.
   */
  protected async exportThumbnail(outputPath: string, seqId?: string): Promise<any> {
    const qe: any = await this.bridge.executeScript(`
      try {
        app.enableQE();
        var qseq=${this.buildQSeqResolver(seqId)};
        var playheadSecs=0;
        var domSeq=${this.buildSeqRes(seqId)};
        try{ playheadSecs=Number(domSeq.getPlayerPosition().seconds); }catch(etc){ try{ playheadSecs=Number(qseq.CTI.secs); }catch(etc2){} }
        // QE takes (timecode, path-without-extension) and appends ".jpg" itself. This used to
        // pass (path, timecode) with a timecode built at a hardcoded 24 fps, which wrote nothing.
        var tc=__qeTimecode(domSeq, playheadSecs);
        var outPath=${JSON.stringify(outputPath)};
        var stem=outPath.replace(/\.(jpe?g)$/i,'');
        var target=new File(stem+'.jpg');
        var stampBefore=target.exists&&target.modified?target.modified.getTime():null;
        var result=null;
        try{ result=qseq.exportFrameJPEG(tc,stem); }catch(eq){ result='ERR '+eq; }
        target=new File(stem+'.jpg');
        var exists=target.exists&&(stampBefore===null||(target.modified&&target.modified.getTime()!==stampBefore));
        if(exists&&stem+'.jpg'!==outPath){ try{ target.copy(outPath); }catch(ecp){} }
        // Source media under the playhead, so the Node side can fall back without a second call.
        var mediaPath=null, sourceSecs=null;
        try{
          var dom=${this.buildSeqRes(seqId)};
          var vt=dom.videoTracks[0];
          for(var i=0;i<vt.clips.numItems;i++){
            var c=vt.clips[i];
            var st=Number(c.start.ticks)/254016000000, en=Number(c.end.ticks)/254016000000;
            if(playheadSecs>=st&&playheadSecs<en){
              mediaPath=String(c.projectItem.getMediaPath());
              sourceSecs=(Number(c.inPoint.ticks)/254016000000)+(playheadSecs-st);
              break;
            }
          }
        }catch(em){}
        return JSON.stringify({qeWrote:exists,path:${JSON.stringify(outputPath)},timecode:tc,qeResult:String(result),playheadSecs:playheadSecs,mediaPath:mediaPath,sourceSecs:sourceSecs});
      }catch(e){return JSON.stringify({qeWrote:false,error:e.toString()});}
    `);

    if (qe?.qeWrote) {
      return { success: true, verified: true, path: qe.path, timecode: qe.timecode,
        route: 'qe.exportFrameJPEG', composited: true };
    }

    if (!qe?.mediaPath) {
      return {
        success: false, verified: true, path: outputPath, timecode: qe?.timecode ?? null,
        route: 'none',
        error: `QE exportFrameJPEG returned "${qe?.qeResult ?? 'error'}" and wrote no file (it is inert on this build), and no clip was found under the playhead to fall back to. Move the playhead over a clip, or use capture_program_output for a composited frame.`,
      };
    }

    const ff = await this.runFfmpegStill(qe.mediaPath, Number(qe.sourceSecs ?? 0), outputPath);
    if (!ff.ok) {
      return {
        success: false, verified: true, path: outputPath, route: 'ffmpeg',
        error: `QE exportFrameJPEG wrote nothing (inert on this build) and the ffmpeg fallback failed: ${ff.error}`,
      };
    }
    return {
      success: true, verified: true, path: outputPath, timecode: qe.timecode,
      route: 'ffmpeg-source-frame', composited: false,
      sourceMedia: qe.mediaPath, sourceSeconds: qe.sourceSecs,
      note: 'QE frame export is inert on this build, so this is the SOURCE frame from the clip under the playhead: no effects, no transitions, and nothing from higher tracks. Use capture_program_output for a composited frame.',
    };
  }

  /** Single-frame still via ffmpeg. Returns a result object rather than throwing. */
  private async runFfmpegStill(mediaPath: string, atSeconds: number, outputPath: string): Promise<{ ok: boolean; error?: string }> {
    try {
      runFf('ffmpeg', ['-y', '-v', 'error', '-ss', Math.max(0, atSeconds).toFixed(3), '-i', mediaPath, '-frames:v', '1', '-update', '1', outputPath], { timeoutMs: 60_000 });
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
    if (!fsSync.existsSync(outputPath) || fsSync.statSync(outputPath).size === 0) {
      return { ok: false, error: 'ffmpeg reported success but wrote no usable file.' };
    }
    return { ok: true };
  }

  protected listExportPresets(filter?: string): any {
    const path = pathSync, fs = fsSync;
    const baseDirs = [
      path.join(osSync.homedir(), 'Library/Application Support/Adobe/Common/AMEPresets'),
      '/Library/Application Support/Adobe/Common/AMEPresets'
    ];
    const results: Array<{name: string, path: string}> = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach((f: string) => {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).isDirectory()) walk(fp);
        else if (f.endsWith('.epr')) {
          const name = f.replace('.epr', '');
          if (!filter || name.toLowerCase().includes(filter.toLowerCase())) results.push({ name, path: fp });
        }
      });
    };
    baseDirs.forEach(walk);
    return { success: true, count: results.length, presets: results };
  }

  protected async getExportProgress(seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq=${this.buildQSeqResolver(seqId)};
        var complete=seq.getExportComplete();
        return JSON.stringify({success:true,exportComplete:String(complete),isComplete:complete===true});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async exportPerMarkerSegments(_presetPath: string, _outputDir: string, _filePrefix: string, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq=${this.buildSeqRes(seqId)};
        var markers=[];
        var m=seq.markers.getFirstMarker();
        while(m){if(String(m.type)==='Chapter')markers.push({name:String(m.name),startTicks:String(m.start.ticks),endTicks:m.end?String(m.end.ticks):null});m=seq.markers.getNextMarker(m);}
        return JSON.stringify({success:true,markerCount:markers.length,markers:markers,note:'Call exportAsMediaDirect for each segment range manually with the returned marker times.'});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async exportProjectAsFcpXml(outputPath: string, suppressUI: boolean): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var out = ${JSON.stringify(outputPath)};
        var r = app.project.exportFinalCutProXML(out, ${suppressUI});
        var f = new File(out);
        if (!f.exists) {
          return JSON.stringify({ success: false, verified: false,
            error: 'exportFinalCutProXML() returned ' + String(r) + ' but no file exists at ' + out,
            outputPath: out });
        }
        return JSON.stringify({ success: true, verified: true, outputPath: out, fileSize: f.length,
          scope: 'entire project',
          note: 'This exported the whole PROJECT. Use export_as_fcp_xml for a single sequence.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getEncoderState(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var o = { success: true };
        try { o.lastExportMediaFolder = String(app.encoder.lastExportMediaFolder); } catch(e1) { o.lastFolderError = e1.toString(); }
        try { var ex = app.encoder.getExporters(); o.exporterCount = ex ? ex.length : 0; } catch(e2) { o.exporterError = e2.toString(); }
        o.note = 'Read-only. Does not launch Adobe Media Encoder.';
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async setEncoderXmpOptions(embedded?: boolean, sidecar?: boolean): Promise<any> {
    if (embedded === undefined && sidecar === undefined) {
      return { success: false, error: 'Pass at least one of embedded or sidecar.' };
    }
    return await this.bridge.executeScript(`
      try {
        var applied = [];
        ${embedded !== undefined ? `app.encoder.setEmbeddedXMPEnabled(${embedded}); applied.push('embedded=${embedded}');` : ''}
        ${sidecar !== undefined ? `app.encoder.setSidecarXMPEnabled(${sidecar}); applied.push('sidecar=${sidecar}');` : ''}
        return JSON.stringify({ success: true, verified: false, applied: applied,
          note: 'No getters exist for the XMP flags, so these could not be read back.' });
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async getCloudQueueInfo(): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        if (typeof qe.tqm === 'undefined' || !qe.tqm) {
          return JSON.stringify({ success: false, error: 'qe.tqm is unavailable on this build' });
        }
        var o = { success: true };
        try { o.dispatcherType = String(qe.tqm.reflect.name); } catch(x) {}
        try { o.activeRegion = String(qe.tqm.getActiveRegion()); } catch(x) { o.activeRegionError = String(x); }
        try { o.supportedRegions = String(qe.tqm.getSupportedRegionList()); } catch(x) { o.regionsError = String(x); }
        try { var q = qe.tqm.getQueueListObject(); o.queueListType = q ? String(q.reflect.name) : null; } catch(x) { o.queueListError = String(x); }
        o.note = 'Read-only exploration of an undocumented surface. No login performed, no queue created, no auth token fetched.';
        return JSON.stringify(o);
      } catch(e) { return JSON.stringify({ success: false, error: e.toString() }); }
    `);
  }

  protected async setPreviewQuality(maxRenderQuality?: boolean, maxBitDepth?: boolean, previewWidth?: number, previewHeight?: number, seqId?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        app.enableQE();
        var seq=${this.buildQSeqResolver(seqId)};
        if (!seq) return JSON.stringify({success:false,error:'No active sequence'});
        // Three fire-and-forget QE calls with no readback and no verified field at all. QE
        // exposes no getters for these three, so the honest report is "dispatched, and here is
        // exactly why it is not verified" rather than a bare success.
        var calls = [], failures = [];
        ${maxRenderQuality !== undefined ? `try { seq.setUseMaxRenderQuality(${maxRenderQuality}); calls.push('setUseMaxRenderQuality(${maxRenderQuality})'); } catch(e1) { failures.push('setUseMaxRenderQuality: ' + e1.toString()); }` : ''}
        ${maxBitDepth !== undefined ? `try { seq.setUseMaxBitDepth(${maxBitDepth}); calls.push('setUseMaxBitDepth(${maxBitDepth})'); } catch(e2) { failures.push('setUseMaxBitDepth: ' + e2.toString()); }` : ''}
        ${previewWidth !== undefined && previewHeight !== undefined ? `try { seq.setPreviewFrameSize(${previewWidth},${previewHeight}); calls.push('setPreviewFrameSize(${previewWidth},${previewHeight})'); } catch(e3) { failures.push('setPreviewFrameSize: ' + e3.toString()); }` : ''}
        if (!calls.length && !failures.length) {
          return JSON.stringify({success:false,verified:false,error:'No preview settings were supplied, so nothing was changed. Pass maxRenderQuality, maxBitDepth, or both previewWidth and previewHeight.'});
        }
        if (failures.length) {
          return JSON.stringify({success:false,verified:false,dispatched:calls,failures:failures,
            error:'Some preview settings were rejected by the host: ' + failures.join(' | ') + '.'});
        }
        return JSON.stringify({success:true,verified:false,dispatched:calls,
          maxRenderQuality:${maxRenderQuality??'null'},maxBitDepth:${maxBitDepth??'null'},previewSize:${previewWidth !== undefined ? `[${previewWidth},${previewHeight}]` : 'null'},
          unverifiedReason:'The QE sequence object exposes no getters for max render quality, max bit depth or preview frame size, so these writes are reported as dispatched without throwing rather than as verified. Confirm them in Sequence Settings, or read the whole settings block with get_qe_sequence_settings.'});
      }catch(e){return JSON.stringify({success:false,error:e.toString()});}
    `);
  }

  protected async renderNeedsPreview(seqId?: string): Promise<any> {
    const result = await this.getSequenceRenderStatus(seqId);
    if (!result || !result.success) return result;
    return { success: true, needsRender: result.needsRender, unrenderedSegments: result.red?.count ?? 0, partialSegments: result.yellow?.count ?? 0 };
  }

  // Render Queue
  protected async addToRenderQueue(args: AddToRenderQueueArgs): Promise<any> {
    return await this.exportSequence(args);
  }

  protected async getRenderQueueStatus(outputPath?: string): Promise<any> {
    // Adobe exposes no ExtendScript read of AME's live queue. Two honest signals
    // ARE available, so report those instead of a hardcoded "unavailable":
    //   1. Whether the encoder hand-off bridge (app.encoder) is reachable at all.
    //   2. If the caller names an output file, its on-disk state — the reliable
    //      way to watch an AME render actually progress (poll repeatedly).
    const note =
      "Premiere cannot read Adobe Media Encoder's queue directly. To track a render, " +
      "pass outputPath and poll this tool: a growing byte size means the encode is running; " +
      "a stable size over successive calls means it has finished (or stalled).";

    // Best-effort encoder-bridge probe. A bridge failure must not sink the file report.
    let encoder: any = { available: false, methods: [] };
    try {
      const probe = `
        try {
          var out = { available: false, methods: [] };
          if (typeof app !== 'undefined' && app.encoder) {
            out.available = true;
            var names = ["encodeSequence","encodeProjectItem","encodeFile","launchEncoder","startBatch"];
            for (var i = 0; i < names.length; i++) {
              try { if (typeof app.encoder[names[i]] === "function") out.methods.push(names[i]); } catch (eM) {}
            }
          }
          return JSON.stringify({ success: true, encoder: out });
        } catch (e) {
          return JSON.stringify({ success: false, error: e.toString() });
        }
      `;
      const res: any = await this.bridge.executeScript(probe);
      if (res && res.encoder) encoder = res.encoder;
    } catch {
      // leave encoder at its default (unreachable); the file report below still stands.
    }

    let outputFile: any = undefined;
    if (outputPath) {
      try {
        const st = await fs.stat(outputPath);
        outputFile = {
          path: outputPath,
          exists: true,
          bytes: st.size,
          modifiedIso: st.mtime.toISOString(),
        };
      } catch {
        outputFile = { path: outputPath, exists: false };
      }
    }

    return {
      success: true,
      available: encoder.available,
      encoder,
      ...(outputFile ? { outputFile } : {}),
      note,
    };
  }

  protected async exportWithBurnIns(outputPath: string, presetPath?: string): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        // Add adjustment layer with burn-in effect, export, then undo
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        // Get timecode burn-in effect
        var burnInEff = qe.project.getVideoEffectByName('Timecode');
        if (!burnInEff) burnInEff = qe.project.getVideoEffectByName('Metadata & Timecode Burn-in');
        var note = burnInEff ? 'Burn-in effect found' : 'Burn-in effect not found - export without burn-ins';
        var preset = ${JSON.stringify(presetPath ?? '')};
        if (!preset) preset = '';
        seq.exportAsMediaDirect(${JSON.stringify(outputPath)}, preset, 0);
        return JSON.stringify({success:true,outputPath:${JSON.stringify(outputPath)},note:note,verified:false});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async archiveMaster(outputDir: string, _includeProxy: boolean): Promise<any> {
    const fs = fsSync;
    const path = pathSync;
    // Get project media list via bridge
    const mediaInfo: any = await this.bridge.executeScript(`
      try {
        var files = [];
        function walkBin(bin) {
          for (var i=0;i<bin.children.numItems;i++) {
            var item = bin.children[i];
            if (item.type===1) { var p=item.getMediaPath?String(item.getMediaPath()):''; if(p) files.push({name:String(item.name),path:p}); }
            else if (item.type===2) walkBin(item);
          }
        }
        walkBin(app.project.rootItem);
        return JSON.stringify({success:true,files:files.slice(0,200)});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!mediaInfo?.success) return mediaInfo;
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      const manifest: any[] = [];
      for (const f of (mediaInfo.files || [])) {
        if (!fs.existsSync(f.path)) { manifest.push({ ...f, status: 'missing' }); continue; }
        const dest = path.join(outputDir, path.basename(f.path));
        if (!fs.existsSync(dest)) fs.copyFileSync(f.path, dest, fs.constants.COPYFILE_EXCL);
        const stat = fs.statSync(dest);
        manifest.push({ ...f, dest, size: stat.size, status: 'copied' });
      }
      fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      return { success: true, outputDir, filesCopied: manifest.filter((f: any) => f.status === 'copied').length, missing: manifest.filter((f: any) => f.status === 'missing').length, manifestPath: path.join(outputDir, 'manifest.json') };
    } catch (e: any) { return { success: false, error: e.message?.slice(0, 200) }; }
  }

  protected async startEncodeAndMonitor(outputPath: string, presetPath?: string, workAreaType = 0): Promise<any> {
    return await this.bridge.executeScript(`
      try {
        var seq = app.project.activeSequence;
        var preset = ${JSON.stringify(presetPath ?? '')};
        seq.exportAsMediaDirect(${JSON.stringify(outputPath)}, preset, ${workAreaType});
        app.encoder.startBatch();
        return JSON.stringify({success:true,outputPath:${JSON.stringify(outputPath)},status:'encoding_started',note:'Use get_export_progress or get_render_queue_status to monitor.'});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
  }

  protected async batchExportSequences(sequenceIds: string[], outputDir: string, presetPath?: string): Promise<any> {
    const results: any[] = [];
    for (const seqId of sequenceIds) {
      const r: any = await this.bridge.executeScript(`
        try {
          var seqs = app.project.sequences;
          var seq = null;
          for (var i=0;i<seqs.numSequences;i++) { if(seqs[i].sequenceID===${JSON.stringify(seqId)}) { seq=seqs[i]; break; } }
          if (!seq) return JSON.stringify({success:false,sequenceId:${JSON.stringify(seqId)},error:'Sequence not found'});
          var outPath = ${JSON.stringify(outputDir)} + '/' + String(seq.name).replace(/[^a-zA-Z0-9_-]/g,'_') + '.mp4';
          seq.exportAsMediaDirect(outPath, ${JSON.stringify(presetPath ?? '')}, 0);
          return JSON.stringify({success:true,sequenceId:${JSON.stringify(seqId)},name:String(seq.name),outputPath:outPath});
        } catch(e) { return JSON.stringify({success:false,sequenceId:${JSON.stringify(seqId)},error:e.toString()}); }
      `);
      results.push(r);
    }
    // Three unknown sequence IDs used to come back as {success:true, count:3} with three
    // "Sequence not found" entries buried in `results`, so an agent moved on believing three files
    // existed. No file check is possible here: exportAsMediaDirect queues in AME and returns before
    // anything is written, so this reports only what the per-sequence calls reported.
    const verdict = summarizeBatch(results, (r: any) => r?.success !== false, 'sequence export(s)');
    return { ...verdict, count: results.length, results };
  }

  protected async exportOmfWithSettings(outputPath: string): Promise<any> {
    return await this.exportInterchange('OMF', outputPath, `
      try {
        app.project.exportOMF(app.project.activeSequence, ${JSON.stringify(outputPath)}, '', '', '', '', false, false, 0, false);
        return JSON.stringify({called:true,fallbackUsed:false});
      } catch(e) {
        try { app.project.exportOMF(); return JSON.stringify({called:true,fallbackUsed:true,firstError:e.toString()}); }
        catch(e2) { return JSON.stringify({called:false,error:e2.toString(),firstError:e.toString()}); }
      }
    `);
  }

  protected async exportAafWithSettings(outputPath: string): Promise<any> {
    return await this.exportInterchange('AAF', outputPath, `
      try {
        app.project.exportAAF(app.project.activeSequence, ${JSON.stringify(outputPath)}, '', '', false, false, 0, false, false, false);
        return JSON.stringify({called:true,fallbackUsed:false});
      } catch(e) {
        try { app.project.exportAAF(); return JSON.stringify({called:true,fallbackUsed:true,firstError:e.toString()}); }
        catch(e2) { return JSON.stringify({called:false,error:e2.toString(),firstError:e.toString()}); }
      }
    `);
  }

  /**
   * Run an OMF/AAF export and confirm it by looking for the file, rather than by the call not
   * throwing.
   *
   * Neither `exportOMF` nor `exportAAF` reports whether it worked — the return value is
   * undocumented and was discarded — so the old code answered `success:true` on any call that did
   * not raise, with `verifyExportFile` sitting unused a few lines below. The zero-argument fallback
   * was the sharper edge: that form takes no path at all, so it cannot write to `outputPath`, yet
   * it reported success AND the path the caller asked for.
   *
   * The pre-snapshot is the part that makes this honest. Checking only `existsSync` afterwards
   * would certify a stale file left by an earlier export as this one's output — the same
   * assume-it-worked reasoning in a new place — so an unchanged size+mtime counts as "no file
   * produced".
   */
  private async exportInterchange(kind: 'OMF' | 'AAF', outputPath: string, script: string): Promise<any> {
    const before = this.statSnapshot(outputPath);
    const raw: any = await this.bridge.executeScript(script);

    if (!raw || raw.called !== true) {
      return {
        success: false, verified: false, kind, outputPath,
        error: raw?.error ? `${kind} export failed: ${raw.error}` : `${kind} export did not run.`,
        firstError: raw?.firstError ?? null,
      };
    }

    const after = this.statSnapshot(outputPath);
    const fallbackUsed = raw.fallbackUsed === true;
    const produced = after !== null && (before === null || after.mtimeMs !== before.mtimeMs || after.size !== before.size);

    if (!produced) {
      return {
        success: false, verified: true, kind, outputPath, fallbackUsed,
        fileExisted: before !== null,
        error: fallbackUsed
          ? `Premiere rejected the full ${kind} argument list, so the zero-argument fallback ran instead. That form takes no path, so nothing was written to ${outputPath}; whatever it produced went to the project's own default location.`
          : `Premiere raised no error, but no new file appeared at ${outputPath}. ${kind} export does not report its own result, so this is reported as a failure rather than assumed to have worked.`,
        firstError: raw.firstError ?? null,
      };
    }

    return {
      success: true, verified: true, kind, outputPath,
      fileSizeBytes: after.size, fallbackUsed,
      note: fallbackUsed
        ? `The full ${kind} argument list was rejected and the zero-argument fallback ran, but a new file is present at the requested path.`
        : `${kind} exported. This API exposes limited parameter control, so only the path is honoured.`,
      firstError: raw.firstError ?? null,
    };
  }

  protected verifyExportFile(filePath: string, expectedDuration?: number, expectedFps?: number, expectedWidth?: number, expectedHeight?: number): any {
    const fs = fsSync;
    if (!fs.existsSync(filePath)) return { success: false, error: 'File does not exist: ' + filePath };
    try {
      const out = runFf('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath], { timeoutMs: 15000 });
      const info = JSON.parse(out);
      const video = (info.streams || []).find((s: any) => s.codec_type === 'video');
      const dur = parseFloat(info.format?.duration ?? '0');
      // r_frame_rate arrives as "num/den" (e.g. "24000/1001"). Parsed rather than eval'd: this is a
      // string from an external process, and the comment on the generated-script builder above says
      // this codebase does not reach for eval()/Function() in the host — that applies here too.
      const fps = (video && typeof video.r_frame_rate === 'string' ? this.parseFrameRate(video.r_frame_rate) : 0) ?? 0;
      const w = video?.width, h = video?.height;
      const codec = video?.codec_name;
      const size = fs.statSync(filePath).size;
      const checks: any = {};
      if (expectedDuration) checks.duration = { expected: expectedDuration, actual: dur, match: Math.abs(dur - expectedDuration) < 0.5 };
      if (expectedFps) checks.fps = { expected: expectedFps, actual: fps, match: Math.abs(fps - expectedFps) < 0.1 };
      if (expectedWidth) checks.width = { expected: expectedWidth, actual: w, match: w === expectedWidth };
      if (expectedHeight) checks.height = { expected: expectedHeight, actual: h, match: h === expectedHeight };
      return { success: true, duration: dur, fps, width: w, height: h, codec, fileSizeBytes: size, checks };
    } catch (e: any) { return { success: false, error: e.message?.slice(0, 200) }; }
  }
}
