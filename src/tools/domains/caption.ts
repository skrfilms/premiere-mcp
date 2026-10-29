/**
 * CaptionTools -- the Captions tool domain.
 *
 * One link in the chain that composes PremiereProTools. Split out of tools/index.ts, which
 * had grown to 19k lines; the method bodies are unchanged.
 */
import { AudioTools } from './audio.js';
import { spawn } from 'child_process';
// Synchronous fs/path/os bindings for the Node-side (non-ExtendScript) tools.
// Kept separate from the `promises as fs` import above, which is the async API.
import * as fsSync from 'node:fs';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import {
  type SrtCue,
  type SrtValidationIssue,
  parseSrt,
  serializeSrt,
  formatTimecode,
  coerceSeconds,
  validateCues,
  cueErrors,
  insertCue,
  updateCue,
  removeCue,
  shiftCues,
  scaleCues,
} from '../srt.js';

export class CaptionTools extends AudioTools {
  // Batch D: Captions
  protected async exportCaptionsToSrt(outputPath: string, sequenceId?: string): Promise<any> {
    const result: any = await this.bridge.executeScript(`
      try {
        var seq = ${this.buildSeqRes(sequenceId)};
        if (!seq) return JSON.stringify({success:false,error:'No sequence'});
        var captions = seq.captionTracks;
        if (!captions || captions.numTracks === 0) return JSON.stringify({success:false,error:'No caption tracks found'});
        var track = captions[0];
        var cues = [];
        for (var i=0; i<track.clips.numItems; i++) {
          var clip = track.clips[i];
          cues.push({index:i+1,startSecs:clip.start.seconds,endSecs:clip.end.seconds,text:String(clip.name)});
        }
        return JSON.stringify({success:true,cues:cues});
      } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
    `);
    if (!result.success) return result;
    const fs = fsSync;
    const lines: string[] = [];
    for (const cue of result.cues) {
      const fmt = (s: number) => {
        const h = Math.floor(s / 3600),
          m = Math.floor((s % 3600) / 60),
          sec = Math.floor(s % 60),
          ms = Math.round((s % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
      };
      lines.push(`${cue.index}\n${fmt(cue.startSecs)} --> ${fmt(cue.endSecs)}\n${cue.text}\n`);
    }
    fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
    return {
      success: true,
      verified: fs.existsSync(outputPath),
      outputPath,
      cueCount: result.cues.length,
    };
  }

  protected captionQcReport(srtPath: string, maxCps: number, maxLineLength: number): any {
    const fs = fsSync;
    try {
      const content = fs.readFileSync(srtPath, 'utf8');
      const blocks = content.trim().split(/\n\n+/);
      const violations: any[] = [];
      for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;
        const tcLine = lines[1];
        const text = lines.slice(2).join(' ');
        const tc = (tcLine ?? '').match(/(\d+:\d+:\d+[,.:]\d+)\s*-->\s*(\d+:\d+:\d+[,.:]\d+)/);
        if (!tc) continue;
        const toSecs = (t: string) => {
          const p = t.replace(',', '.').split(':');
          return +(p[0] || '0') * 3600 + +(p[1] || '0') * 60 + +(p[2] || '0');
        };
        const dur = toSecs(tc[2]!) - toSecs(tc[1]!);
        const cps = dur > 0 ? text.length / dur : 0;
        if (cps > maxCps)
          violations.push({
            type: 'cps',
            cps: Math.round(cps * 10) / 10,
            maxCps,
            text: text.slice(0, 40),
          });
        for (const l of lines.slice(2)) {
          if (l.length > maxLineLength)
            violations.push({
              type: 'line_length',
              length: l.length,
              max: maxLineLength,
              line: l.slice(0, 40),
            });
        }
      }
      return {
        success: true,
        cueCount: blocks.length,
        violationCount: violations.length,
        violations,
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected captionQcFix(
    srtPath: string,
    outputPath: string | undefined,
    _maxCps: number,
    _minGapMs: number,
  ): any {
    const fs = fsSync;
    const out = outputPath ?? srtPath;
    try {
      const content = fs.readFileSync(srtPath, 'utf8');
      // Pass through — basic implementation: re-number and write back
      const blocks = content.trim().split(/\n\n+/).filter(Boolean);
      const toSecs = (t: string) => {
        const p = t.replace(',', '.').split(':');
        return +(p[0] || '0') * 3600 + +(p[1] || '0') * 60 + +(p[2] || '0');
      };
      const toTc = (s: number) => {
        const h = Math.floor(s / 3600),
          m = Math.floor((s % 3600) / 60),
          sec = Math.floor(s % 60),
          ms = Math.round((s % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
      };
      const fixed: string[] = [];
      let n = 1;
      for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;
        const tc = (lines[1] ?? '').match(/(\d+:\d+:\d+[,.:]\d+)\s*-->\s*(\d+:\d+:\d+[,.:]\d+)/);
        if (!tc) continue;
        const start = toSecs(tc[1]!);
        const end = toSecs(tc[2]!);
        const text = lines.slice(2).join('\n');
        fixed.push(`${n}\n${toTc(start)} --> ${toTc(end)}\n${text}`);
        n++;
      }
      fs.writeFileSync(out, fixed.join('\n\n') + '\n', 'utf8');
      return { success: true, outputPath: out, cueCount: fixed.length };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected captionsFromTranscriptJson(
    jsonPath: string,
    outputPath: string,
    maxCps: number,
    maxLineLength: number,
  ): any {
    const fs = fsSync;
    try {
      const transcript = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const words: Array<{ word: string; start: number; end: number }> = (transcript.words ??
        transcript.segments?.flatMap((s: any) => s.words ?? []) ??
        []) as Array<{ word: string; start: number; end: number }>;
      if (!words.length)
        return { success: false, error: 'No word-level timestamps found in transcript JSON' };
      const toTc = (s: number) => {
        const h = Math.floor(s / 3600),
          m = Math.floor((s % 3600) / 60),
          sec = Math.floor(s % 60),
          ms = Math.round((s % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
      };
      const cues: string[] = [];
      let cueWords: typeof words = [];
      let n = 1;
      for (const word of words) {
        cueWords.push(word);
        const text = cueWords.map((w) => w.word).join(' ');
        const lastWord = cueWords[cueWords.length - 1];
        const firstWord = cueWords[0];
        const dur = (lastWord?.end ?? 0) - (firstWord?.start ?? 0);
        const cps = dur > 0 ? text.length / dur : 0;
        if (cps > maxCps || text.length > maxLineLength) {
          const prev = cueWords.slice(0, -1);
          if (prev.length > 0) {
            const t = prev.map((w) => w.word).join(' ');
            cues.push(
              `${n}\n${toTc(prev[0]?.start ?? 0)} --> ${toTc(prev[prev.length - 1]?.end ?? 0)}\n${t}`,
            );
            n++;
            cueWords = [word];
          }
        }
      }
      if (cueWords.length > 0) {
        const t = cueWords.map((w) => w.word).join(' ');
        cues.push(
          `${n}\n${toTc(cueWords[0]?.start ?? 0)} --> ${toTc(cueWords[cueWords.length - 1]?.end ?? 0)}\n${t}`,
        );
      }
      fs.writeFileSync(outputPath, cues.join('\n\n') + '\n', 'utf8');
      return { success: true, outputPath, cueCount: cues.length };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected srtDiff(srtPathA: string, srtPathB: string): any {
    const fs = fsSync;
    try {
      const parse = (p: string) =>
        fs
          .readFileSync(p, 'utf8')
          .trim()
          .split(/\n\n+/)
          .map((b: string) => {
            const l = b.trim().split('\n');
            return { tc: l[1] ?? '', text: l.slice(2).join('\n') };
          });
      const a = parse(srtPathA);
      const b = parse(srtPathB);
      const added: any[] = [],
        removed: any[] = [],
        changed: any[] = [];
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) {
        if (!a[i]) {
          added.push({ index: i + 1, ...b[i] });
        } else if (!b[i]) {
          removed.push({ index: i + 1, ...a[i] });
        } else {
          const ai = a[i];
          const bi = b[i];
          if (ai && bi && (ai.text !== bi.text || ai.tc !== bi.tc)) {
            changed.push({
              index: i + 1,
              before: { tc: ai.tc, text: ai.text },
              after: { tc: bi.tc, text: bi.text },
            });
          }
        }
      }
      return {
        success: true,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        diff: { added, removed, changed },
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected async captionsToMarkers(
    srtPath: string,
    sequenceId: string | undefined,
    markerType: string,
  ): Promise<any> {
    const fs = fsSync;
    try {
      const content = fs.readFileSync(srtPath, 'utf8');
      const blocks = content.trim().split(/\n\n+/).filter(Boolean);
      const cues: Array<{ start: number; text: string }> = [];
      const toSecs = (t: string) => {
        const p = t.replace(',', '.').split(':');
        return +(p[0] || '0') * 3600 + +(p[1] || '0') * 60 + +(p[2] || '0');
      };
      for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;
        const tc = (lines[1] ?? '').match(/(\d+:\d+:\d+[,.:]\d+)/);
        if (tc) cues.push({ start: toSecs(tc[1]!), text: lines.slice(2).join(' ') });
      }
      const cuesJson = JSON.stringify(cues);
      const result: any = await this.bridge.executeScript(`
        try {
          var seq = ${this.buildSeqRes(sequenceId)};
          if (!seq) return JSON.stringify({success:false,error:'No sequence'});
          var cues = ${cuesJson};
          for (var i=0; i<cues.length; i++) {
            var m = seq.markers.createMarker(cues[i].start);
            m.name = String(i+1);
            m.comments = cues[i].text;
            m.type = ${JSON.stringify(markerType)};
          }
          return JSON.stringify({success:true,markersCreated:cues.length});
        } catch(e) { return JSON.stringify({success:false,error:e.toString()}); }
      `);
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  protected async readSequenceCaptions(sequenceId?: string): Promise<any> {
    const seqArg = sequenceId ? JSON.stringify(sequenceId) : 'null';
    const script = `
      try {
        // A supplied ID that does not resolve must fail. Falling back to the
        // active sequence answers a different question and reports that
        // sequence's identity as though it were the one asked for.
        var sequence = null;
        if (${seqArg}) {
          sequence = __findSequence(${seqArg});
          if (!sequence) {
            return JSON.stringify({
              success: false,
              error: "Sequence not found by id: " + ${seqArg} + ". Use list_sequences or get_active_sequence to obtain a valid sequence ID."
            });
          }
        } else {
          sequence = app.project.activeSequence;
        }
        if (!sequence) return JSON.stringify({ success: false, error: "No active sequence" });

        // Premiere caption tracks live alongside video/audio tracks. Different
        // Premiere versions expose them differently:
        //   - sequence.getCaptionTracks() (newer)
        //   - sequence.captionTracks (some builds)
        //   - sequence.videoTracks[i] with isCaptioning style flag
        // Try in that order, return whatever yields {start, end, text} clips.

        var tracks = [];
        try {
          if (sequence.getCaptionTracks) {
            tracks = sequence.getCaptionTracks();
          } else if (sequence.captionTracks) {
            tracks = sequence.captionTracks;
          }
        } catch (_) { /* fall through to track scan */ }

        // Fallback: scan video tracks for caption clip data
        if ((!tracks || tracks.length === 0) && sequence.videoTracks) {
          for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
            var t = sequence.videoTracks[v];
            if (t && (t.isCaption || t.captionTrack || (t.name && /caption/i.test(t.name)))) {
              tracks.push(t);
            }
          }
        }

        var trackCount = tracks ? tracks.length : 0;
        var output = [];

        for (var i = 0; i < trackCount; i++) {
          var trk = tracks[i];
          if (!trk) continue;
          var clips = trk.clips || trk.captions || [];
          var clipCount = clips.numItems !== undefined ? clips.numItems : (clips.length || 0);
          for (var c = 0; c < clipCount; c++) {
            var clip = clips[c];
            if (!clip) continue;
            var startSec = null;
            var endSec = null;
            try {
              if (clip.start && clip.start.seconds !== undefined) startSec = clip.start.seconds;
              else if (clip.start && clip.start.ticks) startSec = parseFloat(clip.start.ticks) / 254016000000.0;
              else if (typeof clip.startTime === 'number') startSec = clip.startTime;
            } catch (_) {}
            try {
              if (clip.end && clip.end.seconds !== undefined) endSec = clip.end.seconds;
              else if (clip.end && clip.end.ticks) endSec = parseFloat(clip.end.ticks) / 254016000000.0;
              else if (typeof clip.endTime === 'number') endSec = clip.endTime;
            } catch (_) {}

            var text = "";
            try {
              if (typeof clip.text === 'string') text = clip.text;
              else if (clip.captionText) text = clip.captionText;
              else if (clip.name) text = clip.name;
            } catch (_) {}

            output.push({
              trackIndex: i,
              start: startSec,
              end: endSec,
              text: text
            });
          }
        }

        // Premiere Pro exposes NO caption-read API in its scripting DOM (confirmed
        // Adobe limitation — see Bruce Bullis 2021/2023 and the UXP CaptionTrack
        // thread, 2025). createCaptionTrack can WRITE a caption track from an SRT,
        // but there is no read counterpart: no sequence.captionTracks, no
        // getCaptionTracks(), and caption tracks are not surfaced in videoTracks or
        // the QE DOM. So trackCount will essentially always be 0 here. Report that
        // honestly via captionReadSupported + note instead of implying "no captions".
        var captionReadSupported = trackCount > 0;
        var note = captionReadSupported ? "" : "Premiere Pro exposes no caption-read API in its scripting DOM, so caption tracks cannot be enumerated or read back from a sequence (Adobe limitation: createCaptionTrack can write a track, but there is no read counterpart). trackCount:0 does NOT mean the sequence has no captions — it may have a working, rendering caption track that is simply unreadable via script. To recover cue text/timing, parse the source .srt file off disk instead.";

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          captionReadSupported: captionReadSupported,
          trackCount: trackCount,
          captionCount: output.length,
          captions: output,
          note: note
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  /** Shape one cue for a tool response: 1-based index + seconds + timecodes. */
  private srtCueOut(cue: SrtCue, i: number) {
    return {
      index: i + 1,
      start: cue.start,
      end: cue.end,
      startTimecode: formatTimecode(cue.start),
      endTimecode: formatTimecode(cue.end),
      text: cue.text,
    };
  }

  /** Distill a cue list's validation into counts plus the issues themselves. */
  private srtValidationReport(cues: SrtCue[]): {
    errorCount: number;
    warningCount: number;
    issues: SrtValidationIssue[];
  } {
    const issues = validateCues(cues);
    return {
      errorCount: issues.filter((x) => x.severity === 'error').length,
      warningCount: issues.filter((x) => x.severity === 'warning').length,
      issues,
    };
  }

  /**
   * Read + parse an .srt off disk. Requires an absolute path (matches the
   * footage tools). Returns the cues + any malformed blocks, or a caller-facing
   * error (bad path / missing file) without throwing.
   */
  private async loadSrt(
    srtPath: string,
  ): Promise<{ ok: true; cues: SrtCue[]; malformed: any[] } | { ok: false; error: string }> {
    if (typeof srtPath !== 'string' || srtPath.trim() === '') {
      return { ok: false, error: 'srtPath is required.' };
    }
    if (!isAbsolute(srtPath)) {
      return {
        ok: false,
        error: `srtPath must be an absolute path (got ${JSON.stringify(srtPath)}).`,
      };
    }
    let raw: string;
    try {
      raw = await fs.readFile(srtPath, 'utf8');
    } catch (e: any) {
      if (e && e.code === 'ENOENT') {
        return {
          ok: false,
          error: `No file at ${srtPath}. Check the path, or create it with write_srt.`,
        };
      }
      return {
        ok: false,
        error: `Could not read ${srtPath}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const parsed = parseSrt(raw);
    return { ok: true, cues: parsed.cues, malformed: parsed.malformed };
  }

  /**
   * Serialize cues and write them to srtPath (atomic tmp+rename, parents made),
   * then read the file back and re-parse to confirm the on-disk cue count
   * matches. Never reports success on an unverified write. Refuses cues with
   * structural errors unless allowInvalid is set.
   */
  private async persistSrt(
    srtPath: string,
    cues: SrtCue[],
    allowInvalid?: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string; errors?: SrtValidationIssue[] }> {
    const errs = cueErrors(cues);
    if (errs.length > 0 && !allowInvalid) {
      return {
        ok: false,
        error: `Refusing to write: ${errs.length} structural error(s) in the cues. Fix them, or pass allowInvalid=true to write anyway.`,
        errors: errs,
      };
    }
    const doc = serializeSrt(cues);
    try {
      await fs.mkdir(dirname(srtPath), { recursive: true });
      const tmp = `${srtPath}.tmp`;
      await fs.writeFile(tmp, doc, 'utf8');
      await fs.rename(tmp, srtPath);
      // Verify a full round-trip, not just the cue count: re-parse the file and
      // re-serialize it; a clean write reproduces `doc` exactly. This catches
      // silent text corruption (e.g. a blank line inside a cue's text, which SRT
      // cannot represent because a blank line ends a cue) that a count-only check
      // would miss when the truncated tail parses away as a malformed block.
      const back = parseSrt(await fs.readFile(srtPath, 'utf8'));
      if (back.malformed.length > 0 || serializeSrt(back.cues) !== doc) {
        return {
          ok: false,
          error: `Wrote ${srtPath} but it did not round-trip (read-back parsed ${back.cues.length} cue(s)${back.malformed.length ? ` plus ${back.malformed.length} unparseable block(s)` : ''}). A cue's text likely contains a blank line, which SRT cannot represent — a blank line ends a cue. Remove interior blank lines from cue text, or the disk may be full/read-only.`,
        };
      }
    } catch (e) {
      return {
        ok: false,
        error: `Could not write ${srtPath}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { ok: true };
  }

  protected async readSrtFile(srtPath: string): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    return {
      success: true,
      srtPath,
      cueCount: loaded.cues.length,
      cues: loaded.cues.map((c, i) => this.srtCueOut(c, i)),
      validation: this.srtValidationReport(loaded.cues),
      malformedBlockCount: loaded.malformed.length,
      malformed: loaded.malformed,
      note:
        loaded.malformed.length > 0
          ? `${loaded.malformed.length} block(s) could not be parsed and were skipped (see malformed).`
          : undefined,
    };
  }

  protected async validateSrtFile(srtPath: string): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const report = this.srtValidationReport(loaded.cues);
    return {
      success: true,
      srtPath,
      cueCount: loaded.cues.length,
      valid: report.errorCount === 0,
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      issues: report.issues,
      malformedBlockCount: loaded.malformed.length,
      malformed: loaded.malformed,
    };
  }

  protected async writeSrtFile(
    srtPath: string,
    cuesIn: Array<{ start: number | string; end: number | string; text: string }>,
    allowInvalid?: boolean,
  ): Promise<any> {
    if (typeof srtPath !== 'string' || !isAbsolute(srtPath)) {
      return {
        success: false,
        error: `srtPath must be an absolute path (got ${JSON.stringify(srtPath)}).`,
      };
    }
    if (!Array.isArray(cuesIn))
      return { success: false, error: 'cues must be an array of { start, end, text }.' };
    const cues: SrtCue[] = [];
    for (let i = 0; i < cuesIn.length; i++) {
      const c = cuesIn[i] || ({} as any);
      const start = coerceSeconds(c.start);
      const end = coerceSeconds(c.end);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        return {
          success: false,
          error: `cue ${i + 1}: start and end must each be seconds (number) or an "HH:MM:SS,mmm" timecode (got start=${JSON.stringify(c.start)}, end=${JSON.stringify(c.end)}).`,
        };
      }
      cues.push({ start, end, text: typeof c.text === 'string' ? c.text : '' });
    }
    const report = this.srtValidationReport(cues);
    const wrote = await this.persistSrt(srtPath, cues, allowInvalid);
    if (!wrote.ok) {
      return {
        success: false,
        error: wrote.error,
        validation: report,
        ...(wrote.errors ? { errors: wrote.errors } : {}),
      };
    }
    return {
      success: true,
      srtPath,
      cueCount: cues.length,
      verified: true,
      validation: report,
      note:
        report.errorCount > 0 && allowInvalid
          ? 'Written with allowInvalid=true despite structural errors — see validation.'
          : undefined,
    };
  }

  protected async updateSrtCue(
    srtPath: string,
    index: number,
    patch: { start?: number | string; end?: number | string; text?: string },
  ): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const cues = loaded.cues;
    if (!Number.isInteger(index) || index < 1 || index > cues.length) {
      return {
        success: false,
        error: `cue index ${index} is out of range (file has ${cues.length} cue${cues.length === 1 ? '' : 's'}; indices are 1-based, valid range is 1..${cues.length}).`,
      };
    }
    if (patch.start === undefined && patch.end === undefined && patch.text === undefined) {
      return { success: false, error: 'Provide at least one of start, end, or text to change.' };
    }
    const before = this.srtCueOut(cues[index - 1] as SrtCue, index - 1);
    const resolved: Partial<SrtCue> = {};
    if (patch.start !== undefined) {
      const s = coerceSeconds(patch.start);
      if (Number.isNaN(s))
        return {
          success: false,
          error: `start must be seconds or "HH:MM:SS,mmm" (got ${JSON.stringify(patch.start)}).`,
        };
      resolved.start = s;
    }
    if (patch.end !== undefined) {
      const e = coerceSeconds(patch.end);
      if (Number.isNaN(e))
        return {
          success: false,
          error: `end must be seconds or "HH:MM:SS,mmm" (got ${JSON.stringify(patch.end)}).`,
        };
      resolved.end = e;
    }
    if (patch.text !== undefined) resolved.text = patch.text;

    let next: SrtCue[];
    try {
      next = updateCue(cues, index, resolved);
    } catch (e: any) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const report = this.srtValidationReport(next);
    // A surgical edit applies and reports; the round-trip verify still guards
    // file integrity. (Refusing here would cite an allowInvalid flag this tool
    // doesn't expose.) Structural problems surface in `validation` + `note`.
    const wrote = await this.persistSrt(srtPath, next, true);
    if (!wrote.ok) return { success: false, error: wrote.error, validation: report };
    return {
      success: true,
      srtPath,
      cueCount: next.length,
      index,
      before,
      after: this.srtCueOut(next[index - 1] as SrtCue, index - 1),
      validation: report,
      note:
        report.errorCount > 0
          ? `Applied, but ${report.errorCount} cue(s) now have structural errors — see validation.`
          : undefined,
    };
  }

  protected async insertSrtCue(
    srtPath: string,
    start: number | string,
    end: number | string,
    text: string,
  ): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const s = coerceSeconds(start);
    const e = coerceSeconds(end);
    if (Number.isNaN(s) || Number.isNaN(e)) {
      return {
        success: false,
        error: `start and end must each be seconds or an "HH:MM:SS,mmm" timecode (got start=${JSON.stringify(start)}, end=${JSON.stringify(end)}).`,
      };
    }
    const cues = loaded.cues;
    // Mirror insertCue's placement rule to report where the cue landed.
    let at = cues.length;
    for (let i = 0; i < cues.length; i++) {
      if ((cues[i] as SrtCue).start > s) {
        at = i;
        break;
      }
    }
    const insertedIndex = at + 1;
    const next = insertCue(cues, { start: s, end: e, text: typeof text === 'string' ? text : '' });
    const report = this.srtValidationReport(next);
    const wrote = await this.persistSrt(srtPath, next, true);
    if (!wrote.ok) return { success: false, error: wrote.error, validation: report };
    return {
      success: true,
      srtPath,
      cueCount: next.length,
      insertedIndex,
      inserted: this.srtCueOut(next[insertedIndex - 1] as SrtCue, insertedIndex - 1),
      validation: report,
      note:
        report.errorCount > 0
          ? `Inserted, but ${report.errorCount} cue(s) now have structural errors — see validation.`
          : undefined,
    };
  }

  protected async removeSrtCue(srtPath: string, index: number): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    const cues = loaded.cues;
    if (!Number.isInteger(index) || index < 1 || index > cues.length) {
      return {
        success: false,
        error: `cue index ${index} is out of range (file has ${cues.length} cue${cues.length === 1 ? '' : 's'}; indices are 1-based, valid range is 1..${cues.length}).`,
      };
    }
    const removed = this.srtCueOut(cues[index - 1] as SrtCue, index - 1);
    let next: SrtCue[];
    try {
      next = removeCue(cues, index);
    } catch (e: any) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const report = this.srtValidationReport(next);
    // Removing a cue can only fix or preserve validity, so it never needs allowInvalid.
    const wrote = await this.persistSrt(srtPath, next, true);
    if (!wrote.ok) return { success: false, error: wrote.error, validation: report };
    return {
      success: true,
      srtPath,
      cueCount: next.length,
      removedIndex: index,
      removed,
      validation: report,
    };
  }

  protected async shiftSrtTiming(
    srtPath: string,
    offsetSeconds?: number,
    scaleFactor?: number,
    fromIndex?: number,
    toIndex?: number,
  ): Promise<any> {
    const loaded = await this.loadSrt(srtPath);
    if (!loaded.ok) return { success: false, error: loaded.error };
    let cues = loaded.cues;
    if (cues.length === 0) {
      return {
        success: true,
        srtPath,
        cueCount: 0,
        offsetSeconds: offsetSeconds || 0,
        scaleFactor: scaleFactor ?? null,
        cues: [],
        validation: this.srtValidationReport(cues),
        note: 'File has no cues; nothing to shift.',
      };
    }
    if (scaleFactor !== undefined) {
      try {
        cues = scaleCues(cues, scaleFactor);
      } catch (e: any) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    const offset = offsetSeconds || 0;
    try {
      cues = shiftCues(cues, offset, fromIndex, toIndex);
    } catch (e: any) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const report = this.srtValidationReport(cues);
    const wrote = await this.persistSrt(srtPath, cues, true);
    if (!wrote.ok) return { success: false, error: wrote.error, validation: report };
    return {
      success: true,
      srtPath,
      cueCount: cues.length,
      offsetSeconds: offset,
      scaleFactor: scaleFactor ?? null,
      fromIndex: fromIndex ?? 1,
      toIndex: toIndex ?? cues.length,
      cues: cues.map((c, i) => this.srtCueOut(c, i)),
      validation: report,
      note:
        report.errorCount > 0
          ? `Retimed, but ${report.errorCount} cue(s) now have structural errors (e.g. timing clamped to 0) — see validation.`
          : undefined,
    };
  }

  /** Count subtitle cues in SRT text by its time-arrow lines. */
  private countSrtCues(srt: string): number {
    const matches = srt.match(/-->/g);
    return matches ? matches.length : 0;
  }

  /**
   * Transcribe speech in a media file to an .srt using the local OpenAI Whisper
   * CLI. Premiere has no speech-to-text scripting surface, so this runs entirely
   * server-side via child_process, mirroring detect_silence's ffmpeg pattern:
   * probe for the tool, fail with clear install guidance if absent, and
   * verify-after-write (the .srt must exist and be readable before we claim
   * success). Whisper is configurable via PREMIERE_MCP_WHISPER_CMD for installs
   * that expose a differently-named binary.
   */
  protected async transcribeToSrt(
    mediaPath?: string,
    projectItemId?: string,
    outputDir?: string,
    model = 'base',
    language?: string,
    translateToEnglish = false,
    timeoutSeconds = 1800,
  ): Promise<any> {
    let resolvedPath = mediaPath;
    if (!resolvedPath && projectItemId) {
      const resolved = await this.resolveProjectItemMediaPath(projectItemId);
      if (resolved.error) {
        return { success: false, error: resolved.error };
      }
      resolvedPath = resolved.path;
    }
    if (!resolvedPath) {
      return { success: false, error: 'Provide either mediaPath or projectItemId' };
    }

    // The media must exist before we spend minutes launching Whisper on it.
    try {
      await fs.access(resolvedPath, fsConstants.R_OK);
    } catch {
      return { success: false, error: `Media file not found or unreadable: ${resolvedPath}` };
    }

    const whisperCmd = (process.env.PREMIERE_MCP_WHISPER_CMD || 'whisper').trim() || 'whisper';
    const whisperAvailable = await this.checkCommandAvailable(whisperCmd);
    if (!whisperAvailable) {
      return {
        success: false,
        error: `The Whisper CLI ('${whisperCmd}') was not found on PATH. transcribe_to_srt generates subtitles with a local OpenAI Whisper install, not Premiere's scripting API (which has no speech-to-text). Install it with \`pip install -U openai-whisper\` (also needs ffmpeg on PATH), or set PREMIERE_MCP_WHISPER_CMD to the binary name, then try again.`,
      };
    }

    const targetDir = (outputDir && outputDir.trim()) || dirname(resolvedPath);
    const baseName = basename(resolvedPath, extname(resolvedPath));
    const expectedSrt = join(targetDir, `${baseName}.srt`);

    const whisperArgs = [
      resolvedPath,
      '--model',
      model,
      '--output_format',
      'srt',
      '--output_dir',
      targetDir,
    ];
    if (language && language.trim()) whisperArgs.push('--language', language.trim());
    if (translateToEnglish) whisperArgs.push('--task', 'translate');

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value: any): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const proc = spawn(whisperCmd, whisperArgs);
      let stderr = '';
      let stdout = '';
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish({
          success: false,
          error: `Whisper transcription exceeded the ${timeoutSeconds}s timeout and was stopped. Nothing was reported as captions. Try a smaller --model, a shorter clip, or a larger timeoutSeconds.`,
          mediaPath: resolvedPath,
        });
      }, timeoutMs);

      proc.on('error', (err) => {
        clearTimeout(timer);
        finish({
          success: false,
          error: `Failed to run Whisper ('${whisperCmd}'): ${err.message}`,
          mediaPath: resolvedPath,
        });
      });

      proc.on('close', async (code) => {
        clearTimeout(timer);
        // Verify-after-write: only claim success if the .srt is actually on disk.
        let srt: string;
        try {
          srt = await fs.readFile(expectedSrt, 'utf8');
        } catch {
          finish({
            success: false,
            error: `Whisper exited with code ${code} but no subtitle file was found at ${expectedSrt}. The transcription did not produce captions.`,
            mediaPath: resolvedPath,
            whisperStderr: stderr.slice(-2000) || stdout.slice(-2000),
          });
          return;
        }

        const cueCount = this.countSrtCues(srt);
        finish({
          success: true,
          srtPath: expectedSrt,
          cueCount,
          model,
          language: language || 'auto-detected',
          task: translateToEnglish ? 'translate' : 'transcribe',
          mediaPath: resolvedPath,
          empty: cueCount === 0,
          note:
            cueCount === 0
              ? 'Whisper produced an .srt with no cues (no detectable speech, or the wrong language hint). The file exists but is empty of captions.'
              : 'Import this srtPath with import_media, then pass the resulting project item id to create_caption_track to lay the captions onto a sequence.',
        });
      });
    });
  }

  // Caption Track Implementation
  protected async createCaptionTrack(
    sequenceId: string,
    projectItemId: string,
    startTime?: number,
    captionFormat?: string,
  ): Promise<any> {
    const startTimeVal = startTime || 0;
    // createCaptionTrack's optional 3rd arg is a Sequence.CAPTION_FORMAT_* integer
    // constant, NOT a free-form string. Passing a string ("Subtitle Default") raised
    // "Illegal Parameter type" and broke all SRT ingestion. Map friendly names to the
    // constant suffix; omit the arg entirely when none is given (defaults to subtitle,
    // which is correct for .srt and matches Adobe's own PProPanel sample).
    const formatMap: Record<string, string> = {
      subtitle: 'CAPTION_FORMAT_SUBTITLE',
      'subtitle default': 'CAPTION_FORMAT_SUBTITLE',
      srt: 'CAPTION_FORMAT_SUBTITLE',
      'open captions': 'CAPTION_FORMAT_SUBTITLE',
      '608': 'CAPTION_FORMAT_608',
      'cea-608': 'CAPTION_FORMAT_608',
      '708': 'CAPTION_FORMAT_708',
      'cea-708': 'CAPTION_FORMAT_708',
      teletext: 'CAPTION_FORMAT_TELETEXT',
      'open ebu': 'CAPTION_FORMAT_OPEN_EBU',
      ebu: 'CAPTION_FORMAT_OPEN_EBU',
      op42: 'CAPTION_FORMAT_OP42',
      op47: 'CAPTION_FORMAT_OP47',
    };
    const requested = captionFormat ? captionFormat.trim().toLowerCase() : '';
    const constName = requested ? formatMap[requested] || 'CAPTION_FORMAT_SUBTITLE' : '';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: " + ${JSON.stringify(sequenceId)} });
        var projectItem = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!projectItem) return JSON.stringify({ success: false, error: "Caption project item not found" });
        var startAtTime = ${startTimeVal};
        var constName = ${JSON.stringify(constName)};
        var usedFormat = "default";
        var ok;
        // Resolve the format enum if requested; constant location varies by host, so
        // probe a couple of spots and fall back to the 2-arg (subtitle) call.
        var fmtConst = null;
        if (constName) {
          try {
            if (typeof Sequence !== 'undefined' && Sequence[constName] !== undefined) {
              fmtConst = Sequence[constName];
            } else if (sequence.constructor && sequence.constructor[constName] !== undefined) {
              fmtConst = sequence.constructor[constName];
            }
          } catch (eC) { fmtConst = null; }
        }
        if (fmtConst !== null && fmtConst !== undefined) {
          try {
            ok = sequence.createCaptionTrack(projectItem, startAtTime, fmtConst);
            usedFormat = constName;
          } catch (eFmt) {
            ok = sequence.createCaptionTrack(projectItem, startAtTime);
            usedFormat = "default (requested '" + constName + "' rejected: " + eFmt.toString() + ")";
          }
        } else {
          ok = sequence.createCaptionTrack(projectItem, startAtTime);
        }
        // createCaptionTrack returns falsey (or throws) when the ingest fails —
        // an SRT with no matching frame rate, a non-caption project item, etc.
        // Only an explicit false is a hard failure; some hosts return undefined
        // on success, so treat that as applied-but-unverified rather than lie.
        if (ok === false) {
          return JSON.stringify({
            success: false,
            error: "createCaptionTrack returned false; the item was not ingested as captions.",
            captionFormat: usedFormat,
            startTime: startAtTime
          });
        }
        return JSON.stringify({
          success: true,
          message: "Caption track created",
          verified: ok === true || (ok !== null && ok !== undefined),
          captionFormat: usedFormat,
          startTime: startAtTime,
          apiResult: String(ok),
          note: (ok === undefined || ok === null) ? "Host returned no value from createCaptionTrack; creation applied but not independently confirmed." : undefined
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }
}
