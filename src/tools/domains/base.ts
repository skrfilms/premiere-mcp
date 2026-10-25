/**
 * ToolsBase -- the shared base for every tool domain tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { spawn } from 'child_process';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';
import type { PremiereProTransport } from '../../bridge/types.js';
import { Logger } from '../../utils/logger.js';
import type { MCPTool } from '../tool-types.js';
import type { CaptureTapReport } from './shared.js';

export class ToolsBase {
  protected bridge: PremiereProTransport;
  protected logger: Logger;
  /** TTL cache for the capture-tap capability probe (speed mandate: don't re-probe every call). */
  protected captureTapsCache?: { at: number; taps: CaptureTapReport[] };
  /**
   * Tools promoted into the advertised list at runtime by `activate_tools`.
   *
   * Session state, deliberately not persisted: an operator who restarts the server
   * should get exactly the profile they configured, not a surface some earlier agent
   * grew. Everything in here passed the same authority gate `call_tool` uses.
   */
  protected activatedTools = new Set<string>();
  /** Notified when the advertised tool list changes, so the server can emit tools/list_changed. */
  protected exposureListeners: Array<() => void> = [];

  constructor(bridge: PremiereProTransport) {
    this.bridge = bridge;
    this.logger = new Logger('PremiereProTools');
  }



  /**
   * The locally-implemented tool catalogue, built ONCE per process.
   *
   * The literal below constructs several hundred Zod schemas, and it was re-evaluated on
   * every call. executeTool() calls it two to three times for a SINGLE tool call (the
   * getAvailableTools lookup, then the local-vs-expanded check), so the cost landed on
   * every real edit as well as on the sweeps: the injection-guard suite, which calls
   * executeTool once per tool x position x payload, spent the overwhelming majority of its
   * 25 minutes rebuilding this array and timed out on the Windows runner because of it.
   *
   * Caching is safe because the builder is pure: it reads no environment variable and no
   * instance state (`this` appears nowhere inside it), so the catalogue is byte-identical
   * for every instance in the process. Profile curation is deliberately NOT cached —
   * applyProfile() reads process.env on every call, so getAvailableTools() still reflects a
   * profile or exclusion set changed after startup, which several suites depend on.
   *
   * A fresh array is returned per call, not the cached one, so a caller that sorts or
   * splices its copy cannot corrupt the catalogue for everyone else. Copying ~640 object
   * references is free next to rebuilding ~640 schemas.
   */
  protected static localToolsCache: MCPTool[] | null = null;



  /**
   * Every tool this build implements, before the active profile filters anything.
   *
   * Cached for the same reason getLocalTools is, and on the same terms: pure inputs, a fresh
   * array handed to each caller. This is the one the hot paths actually call.
   */
  protected static registeredToolsCache: MCPTool[] | null = null;



  // ── New Wave-1 tools ───────────────────────────────────────────────────



  // ── Wave 1 — Navigation & Editing Verbs ───────────────────────────────



  // ── Batch 1: Lumetri Numeric Control ─────────────────────────────────



  // ── Batch 2: Motion, Transform, Layout ──────────────────────────────



  // ── Batch 3: Audio Tools ─────────────────────────────────────────────



  // ── Batch 4: Export & AME Tools ─────────────────────────────────────



  // ── Batch 5: Batch & Metadata ────────────────────────────────────────



  // ── Batch 6: Review & Delivery ───────────────────────────────────────



  // ── Batch 7: VFX & Interchange ───────────────────────────────────────



  // ── Batch 8: MOGRT / Titles ──────────────────────────────────────────



  // ── Batch 9: QE Utilities + Productions ─────────────────────────────



  // ──────────────────────────────────────────────────────────────────────
  // ── Batches A-H Implementations ───────────────────────────────────────



  // Batch C: Audio
  //
  // Adding an effect Premiere has marked obsolete pops a modal "Audio Effects
  // Replacement" dialog ("You are adding an obsolete effect. Would you like to add a
  // newer version instead?"). A modal blocks the CEP bridge until a human clicks it, so
  // every later tool call stalls to its timeout — the whole server appears hung. Observed
  // live on 26.3.2 with 'Adaptive Noise Reduction', which the dialog itself names 'DeNoise'
  // as the replacement. Obsolete names are therefore remapped before the call rather than
  // passed through, and any name still carrying an "(Obsolete)" marker is refused outright.
  protected static readonly OBSOLETE_AUDIO_EFFECTS: Record<string, string> = {
    'Adaptive Noise Reduction': 'DeNoise',
  };



  // PARKED: import_ae_comps is intentionally NOT exposed as a tool.
  // app.project.importAEComps() exists on 26.3.2 (signature confirmed by reflection),
  // but it has never been called with a real .aep here, and the sibling synthetic-media
  // calls (newColorMatte/newBlackVideo) were found to open BLOCKING native dialogs that
  // hang the CEP bridge. Upstream ships a regression guard asserting this name stays out
  // of the catalogue, which is consistent with it being dialog-unsafe. Re-expose only
  // after confirming on a live host that it imports without user interaction.
  // private async importAeComps(aepPath: string, compNames: string[]): Promise<any> {
  // return await this.bridge.executeScript(`
  // try {
  // var names = ${JSON.stringify(compNames)};
  // var before = app.project.rootItem.children.numItems;
  // if (names.length > 0) { app.project.importAEComps(${JSON.stringify(aepPath)}, names); }
  // else { app.project.importAllAEComps(${JSON.stringify(aepPath)}); }
  // var after = app.project.rootItem.children.numItems;
  // return JSON.stringify({success:true,imported:after-before,compNames:names.length>0?names:'all'});
  // } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
  // `);
  // }



  // ──────────────────────────────────────────────────────────────────────



  // ---------------------------------------------------------------------------
  // SRT subtitle CRUD (host-independent; operates on the .srt file on disk).
  // Premiere's DOM can ingest an .srt (create_caption_track) but exposes no
  // caption read/update/delete, so all caption editing lives here on the file.
  // Every write is verified by reading it back and re-parsing. The pure parse/
  // serialize/edit logic is in ./srt; these methods add only the I/O shell.
  // ---------------------------------------------------------------------------



  /** Default media extensions the footage index scans (lowercase, no dot). */
  protected static readonly FOOTAGE_EXTENSIONS = [
    'mov', 'mp4', 'm4v', 'mxf', 'avi', 'mkv', 'webm', 'r3d', 'braw', 'prores',
    'wav', 'aif', 'aiff', 'mp3', 'aac', 'flac', 'm4a',
    'png', 'jpg', 'jpeg', 'tif', 'tiff', 'exr', 'dpx', 'psd',
  ];



  // ============================================
  // NEW TOOLS IMPLEMENTATION
  // ============================================

  // Markers Implementation



  // ── Final batch implementations ───────────────────────────────────────



  // ── Gap-closure implementations ─────────────────────────────────────────
  // Every method below exposes a live-reflected symbol that no tool previously called.
  // Where the API has a getter, the mutation is read back and `verified` reflects the
  // readback. Where no getter exists the response says so rather than implying proof.



  /**
   * Premiere's Auto Save preferences, by their real key names.
   *
   * These are ordinary app.properties keys, so set_app_property could already reach them — but
   * only if the caller knew the exact strings, and nothing told them that a live write is not a
   * durable one. Both halves of that cost a real 111-sequence cut once.
   */
  protected static readonly AUTOSAVE_KEYS = {
    enabled: 'BE.Prefs.AutoSave.DoSave',
    intervalMinutes: 'BE.Prefs.AutoSave.Interval',
    maxVersions: 'BE.Prefs.AutoSave.MaxProjectVersions',
    alsoSaveCurrentProject: 'BE.Prefs.AutoSave.AlsoSaveCurrentProject',
    saveToCloud: 'BE.Prefs.AutoSave.DoSaveToCloud',
  } as const;

  protected static readonly AUTOSAVE_FOLDER_KEY = 'BE.Prefs.ScratchDisks.FirstAutoSaveFolder';





  // ──────────────────────────────────────────────────────────────────────



  // ── Batch Final implementations ────────────────────────────────────────



  // ── #5: Batch execution ─────────────────────────────────────────────────



  // ── #7: Cross-app integration ────────────────────────────────────────────



  // ─────────────────────────────────────────────────────────────────────────


  /**
   * Batch B: QE clip ops. Delegates to buildQSeqResolver rather than inlining its own lookup —
   * it used to carry a private copy that ended in `return qe.project.getActiveSequence()`, so a
   * stale id here reached into the open timeline and pulled the clip at the same track/index.
   * That is the worst version of the bug: the wrong clip, on the wrong sequence, verified.
   */
  protected qeClipScript(trackIndex: number, clipIndex: number, sequenceId?: string): string {
    return `app.enableQE();var __seq=${this.buildQSeqResolver(sequenceId)};var __clip=__seq.getVideoTrackAt(${trackIndex}).getItemAt(${clipIndex});`;
  }

  // Audio Analysis Implementation
  protected async resolveProjectItemMediaPath(projectItemId: string): Promise<{ path?: string; error?: string }> {
    const script = `
      try {
        var item = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!item) {
          return JSON.stringify({ success: false, error: "Project item not found by id: " + ${JSON.stringify(projectItemId)} });
        }
        var mediaPath = null;
        try {
          mediaPath = item.getMediaPath();
        } catch (eMedia) {
          return JSON.stringify({ success: false, error: "Could not read media path: " + eMedia.toString() });
        }
        if (!mediaPath) {
          return JSON.stringify({ success: false, error: "Project item has no media path (is it a sequence or bin?)" });
        }
        return JSON.stringify({ success: true, mediaPath: mediaPath });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    const result = await this.bridge.executeScript(script);
    if (result?.success === false) {
      return { error: result.error || 'Failed to resolve project item media path' };
    }
    return { path: result?.mediaPath };
  }

  /**
   * Whether a command can be launched at all. Uses the child_process 'spawn'
   * event so we learn the binary exists WITHOUT waiting for a heavy tool
   * (whisper imports torch on --help, several seconds) to finish; the probe is
   * killed the instant it launches. ENOENT (not on PATH) surfaces as 'error'.
   */
  protected checkCommandAvailable(command: string, probeArgs: string[] = ['--help']): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const proc = spawn(command, probeArgs);
        proc.on('error', () => done(false));
        proc.on('spawn', () => {
          done(true);
          try { proc.kill(); } catch { /* already gone */ }
        });
        // Fallback for runtimes that never emit 'spawn': a clean close still means it ran.
        proc.on('close', () => done(true));
      } catch {
        done(false);
      }
    });
  }

  /** The ffprobe binary, overridable for installs that expose a different name. */
  protected ffprobeCmd(): string {
    return (process.env.PREMIERE_MCP_FFPROBE_CMD || 'ffprobe').trim() || 'ffprobe';
  }

  /** Parse an ffprobe "num/den" (or plain) frame-rate string to fps. */
  protected parseFrameRate(rate: string): number | undefined {
    const parts = rate.split('/');
    if (parts.length === 2) {
      const num = Number(parts[0]);
      const den = Number(parts[1]);
      if (den) return Math.round((num / den) * 1000) / 1000;
    }
    const single = Number(rate);
    return Number.isFinite(single) ? single : undefined;
  }

  /**
   * Read technical metadata from a media file with ffprobe. Premiere's scripting
   * DOM exposes only a thin slice of a clip's metadata (and nothing at all for
   * files that are not imported), so this shells out to ffprobe -- the same
   * child_process pattern as detect_silence: probe for the tool, fail with clear
   * install guidance if absent, and only return parsed data (never a fabricated
   * shape) when ffprobe actually produced JSON.
   */
  /**
   * Distil a parsed ffprobe JSON payload down to the fields we care about.
   * Shared by probe_media and the footage index so both describe media the same
   * way. Pure (no I/O), so it is unit-testable against fixtures.
   */
  protected buildProbeSummary(parsed: any): any {
    const streams: any[] = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const fmt = parsed?.format || {};
    return {
      durationSeconds: fmt.duration != null ? Number(fmt.duration) : undefined,
      formatName: fmt.format_name,
      sizeBytes: fmt.size != null ? Number(fmt.size) : undefined,
      bitRate: fmt.bit_rate != null ? Number(fmt.bit_rate) : undefined,
      videoStreamCount: streams.filter((s) => s.codec_type === 'video').length,
      audioStreamCount: streams.filter((s) => s.codec_type === 'audio').length,
      video: video
        ? {
            codec: video.codec_name,
            profile: video.profile,
            width: video.width,
            height: video.height,
            pixelFormat: video.pix_fmt,
            colorSpace: video.color_space,
            colorRange: video.color_range,
            bitDepth: video.bits_per_raw_sample != null ? Number(video.bits_per_raw_sample) : undefined,
            fps: typeof video.r_frame_rate === 'string' ? this.parseFrameRate(video.r_frame_rate) : undefined,
          }
        : null,
      audio: audio
        ? {
            codec: audio.codec_name,
            sampleRate: audio.sample_rate != null ? Number(audio.sample_rate) : undefined,
            channels: audio.channels,
            channelLayout: audio.channel_layout,
          }
        : null,
    };
  }

  /** Run ffprobe on one file and return its distilled summary. */
  protected ffprobeFile(path: string, ffprobe: string): Promise<{ success: boolean; summary?: any; error?: string }> {
    return new Promise((resolve) => {
      const argv = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path];
      const proc = spawn(ffprobe, argv);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (c) => { stdout += c.toString(); });
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', (err) => resolve({ success: false, error: err.message }));
      proc.on('close', () => {
        try {
          resolve({ success: true, summary: this.buildProbeSummary(JSON.parse(stdout)) });
        } catch {
          resolve({ success: false, error: stderr.slice(-300) || 'ffprobe returned no parseable metadata' });
        }
      });
    });
  }

  // Export and Rendering Implementation
  protected decodeXmlEntities(value: string): string {
    return value
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  }

  /**
   * DOM sequence resolver — use in executeScript template literals.
   *
   * An id that does not resolve THROWS. It used to `return app.project.activeSequence`,
   * which meant a stale or mistyped sequenceId silently retargeted whatever timeline the
   * editor happened to have open — and every mutating tool then verified its readback
   * against that wrong sequence and reported verified:true. Per-tool verification cannot
   * catch a wrong target, so the refusal has to happen here, at resolution time.
   *
   * Throwing rather than returning null is deliberate: every generated script wraps its
   * body in try/catch and returns {success:false,error:e.toString()}, so this fails closed
   * with a legible message at ~100 call sites without touching any of them. Omitting the
   * id still means the active sequence, which is documented and intended.
   */
  protected buildSeqRes(sid?: string): string {
    if (!sid) return 'app.project.activeSequence';
    return `(function(){var ss=app.project.sequences;for(var i=0;i<ss.numSequences;i++){if(ss[i].sequenceID===${JSON.stringify(sid)})return ss[i];}throw new Error("Sequence not found by id: "+${JSON.stringify(sid)}+". Refusing to fall back to the active sequence -- nothing was read or changed.");})()`;
  }

  /** QE sequence resolver — use in executeScript template literals. Fails closed like buildSeqRes. */
  protected buildQSeqResolver(seqId?: string): string {
    if (!seqId) return 'qe.project.getActiveSequence()';
    // Matched by guid through __qeSequenceFor, never by position. QE does not list sequences in
    // the DOM's order: measured on 26.5.2, DOM index 0 was synth_seq while qe.project
    // .getSequenceAt(0) was fixture_seq_a, so pairing the two indices sent every QE tool given a
    // sequenceId to a different sequence than the one named — with a verified:true readback of
    // the wrong timeline.
    return `(function(){ var __d=__findSequence(${JSON.stringify(seqId)}); if(!__d) throw new Error("Sequence not found by id: "+${JSON.stringify(seqId)}+". Refusing to fall back to the active sequence -- nothing was read or changed."); var __q=__qeSequenceFor(__d); if(!__q) throw new Error("Sequence "+${JSON.stringify(seqId)}+" exists but QE does not expose it (QE only sees sequences that have been opened in a timeline). Open it with set_active_sequence and retry -- nothing was read or changed."); return __q; })()`;
  }

  /** Size and mtime of a path, or null when it is absent or unreadable. */
  protected statSnapshot(filePath: string): { size: number; mtimeMs: number } | null {
    try {
      const s = fsSync.statSync(filePath);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch { return null; }
  }
}
