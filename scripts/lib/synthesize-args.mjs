/**
 * Synthesises plausible arguments for any tool in the catalogue, from its Zod schema plus a
 * live snapshot of the scratch fixture.
 *
 * Why this exists. The sweep used to guess arguments from eight regexes over parameter names,
 * so 93 tools were never offered to Premiere even once: the call was rejected by our own schema
 * before it reached the host, and the ledger recorded `skipped_args` — an honest "we did not
 * look", but a large hole in the only breadth claim we can actually defend. Those 93 are not
 * hard cases. `caption_qc_report` wants an `srtPath` and the fixture writes one; `nudge_clip`
 * wants `trackIndex`, `clipIndex`, `frames`; `srt_diff` wants two SRTs. Nothing was missing but
 * a builder that reads the schema.
 *
 * How it works: walk the schema, and for each leaf choose a value by NAME first (a semantic
 * table — `sequenceId` means the fixture's sequence, `outputPath` means a scratch file with an
 * extension inferred from the tool) and by TYPE second. Type always wins over name, because
 * `create_marker` declares `timecode` as a *number* while `go_to_timecode` declares it as a
 * string, and a name-only table gets one of them wrong every time.
 *
 * What it must never do:
 *   - Write outside the scratch directory. Every synthesised output path lands in
 *     `.scratch/synth/out/`, so a sweep cannot scribble over the operator's work. This is not
 *     hypothetical: `consolidate_and_transfer` takes a cwd-relative path and scattered ten
 *     directories through the repo root the first time the catalogue was driven from there.
 *   - Guess a value it cannot justify. A key it cannot resolve is returned in `unresolved`, and
 *     the caller records that instead of a fabricated pass. "We could not build arguments for
 *     `presetPath`" is a fact about the harness; a made-up path would be a fake failure
 *     attributed to the tool.
 *
 * Only REQUIRED keys are filled. An optional key left out is the caller exercising the tool's
 * own defaults, which is the more interesting test anyway.
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Adobe's own preset files, found inside the installed application.
 *
 * An `.epr` cannot be synthesised — it is an Adobe-authored encoder settings blob, and a
 * fabricated path makes the export tool report a missing preset, which reads in the ledger as
 * the tool being broken. Premiere ships hundreds of real ones, so the harness borrows one.
 * Read-only use: nothing writes back into the app bundle.
 */
function findAdobePresets() {
  const roots = ['/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Settings'];
  const found = { epr: null, sqpreset: null };
  for (const root of roots) {
    for (const [key, sub] of [['epr', 'EncoderPresets'], ['sqpreset', 'SequencePresets']]) {
      if (found[key]) continue;
      const dir = join(root, sub);
      if (!existsSync(dir)) continue;
      const stack = [dir];
      while (stack.length && !found[key]) {
        const cur = stack.pop();
        let entries = [];
        try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = join(cur, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name.endsWith(`.${key}`)) { found[key] = full; break; }
        }
      }
    }
  }
  return found;
}

const PREMIERE_LUT = '/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Lumetri/LUTs/Technical/AMIRA_Default_LogC2Rec709.cube';
const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRATCH_DIR = resolve(HERE, '..', '..', '.scratch');
export const SYNTH_DIR = join(SCRATCH_DIR, 'synth');
export const OUT_DIR = join(SYNTH_DIR, 'out');

/* ------------------------------------------------------------------------------------------ *
 * Side fixtures: files on disk that file-format tools read.
 *
 * These are generated rather than committed for the same reason the media is: the fixture must
 * be reproducible on any machine, and a committed binary drifts out of step with the tool that
 * reads it.
 * ------------------------------------------------------------------------------------------ */

/** @returns {{srtA: string, srtB: string, csv: string, notes: string, whisperJson: string, lut: string, txt: string, outDir: string}} */
export function ensureSideFixtures() {
  mkdirSync(OUT_DIR, { recursive: true });

  const srtA = join(SCRATCH_DIR, 'fixture-captions.srt');
  if (!existsSync(srtA)) {
    writeFileSync(srtA, [
      '1', '00:00:00,000 --> 00:00:01,500', 'First fixture caption line.', '',
      '2', '00:00:01,600 --> 00:00:03,000', 'Second fixture caption line.', '',
      '3', '00:00:03,100 --> 00:00:04,000', 'Third fixture caption line.', '',
    ].join('\n'));
  }

  // A second SRT that genuinely differs, so srt_diff has something to report. Identical files
  // would let a broken differ pass by returning nothing.
  const srtB = join(SYNTH_DIR, 'fixture-captions-b.srt');
  writeFileSync(srtB, [
    '1', '00:00:00,000 --> 00:00:01,500', 'First fixture caption line.', '',
    '2', '00:00:01,600 --> 00:00:03,000', 'Second line, REWORDED for the diff.', '',
    '4', '00:00:04,100 --> 00:00:05,000', 'A fourth cue that only exists in B.', '',
  ].join('\n'));

  const csv = join(SYNTH_DIR, 'fixture-markers.csv');
  writeFileSync(csv, [
    'name,start,duration,comment,type',
    'synth_marker_one,00:00:00:12,00:00:00:00,imported from csv,Comment',
    'synth_marker_two,00:00:01:12,00:00:00:00,second row,Comment',
  ].join('\n') + '\n');

  const notes = join(SYNTH_DIR, 'fixture-notes.txt');
  writeFileSync(notes, [
    '00:00:00:12 - tighten this head',
    '00:00:01:12 - check the grade here',
  ].join('\n') + '\n');

  // Whisper's own shape: segments with word-level timings.
  const whisperJson = join(SYNTH_DIR, 'fixture-transcript.json');
  writeFileSync(whisperJson, JSON.stringify({
    text: 'First fixture line. Second fixture line.',
    segments: [
      { id: 0, start: 0.0, end: 1.5, text: 'First fixture line.',
        words: [{ word: 'First', start: 0.0, end: 0.4 }, { word: 'fixture', start: 0.4, end: 1.0 }, { word: 'line.', start: 1.0, end: 1.5 }] },
      { id: 1, start: 1.6, end: 3.0, text: 'Second fixture line.',
        words: [{ word: 'Second', start: 1.6, end: 2.1 }, { word: 'fixture', start: 2.1, end: 2.6 }, { word: 'line.', start: 2.6, end: 3.0 }] },
    ],
  }, null, 2));

  // A valid, minimal identity .cube. Size 2 is legal and enough to prove the parser and the
  // host's LUT slot; a real 33^3 LUT would add 36k lines and prove nothing extra.
  const lut = join(SYNTH_DIR, 'fixture-identity.cube');
  writeFileSync(lut, [
    'TITLE "synth identity"',
    'LUT_3D_SIZE 2',
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '0.0 0.0 0.0', '1.0 0.0 0.0', '0.0 1.0 0.0', '1.0 1.0 0.0',
    '0.0 0.0 1.0', '1.0 0.0 1.0', '0.0 1.0 1.0', '1.0 1.0 1.0',
  ].join('\n') + '\n');

  const txt = join(SYNTH_DIR, 'fixture-plain.txt');
  writeFileSync(txt, 'synthesised plain text fixture\n');

  // A real footage index over the fixture media, so search_footage has something to search.
  // Without it the tool refuses — correctly, and with good guidance — but it refuses on EVERY
  // sweep, which makes a working query path look like a permanent hole in the catalogue.
  //
  // The entries are probed, not invented. A hand-typed width/codec would make the filter appear to
  // work while proving nothing about buildProbeSummary's real output shape, and a wrong value would
  // read as a bug in the matcher.
  const footageIndex = join(SYNTH_DIR, 'fixture-footage-index.json');
  const mediaDir = join(SCRATCH_DIR, 'media');
  const entries = [];
  for (const base of ['fixture_a.mp4', 'fixture_b.mp4', 'fixture_c.mp4']) {
    const full = join(mediaDir, base);
    if (!existsSync(full)) continue;
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', full,
    ], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    let parsed;
    try { parsed = JSON.parse(probe.stdout); } catch { continue; }
    const v = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
    const a = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
    const [num, den] = String(v?.r_frame_rate ?? '0/1').split('/').map(Number);
    entries.push({
      path: full,
      summary: {
        durationSeconds: Number(parsed.format?.duration ?? 0),
        videoStreamCount: v ? 1 : 0,
        audioStreamCount: a ? 1 : 0,
        video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: den ? num / den : 0 } : null,
        audio: a ? { codec: a.codec_name } : null,
      },
    });
  }
  writeFileSync(footageIndex, JSON.stringify({
    version: 1, root: mediaDir, entryCount: entries.length, entries,
  }, null, 2));

  const presets = findAdobePresets();

  // A template whose text the DOM can actually write. Premiere-native titles (Basic Title and the
  // whole Titles/Lower Thirds folders) carry no MGT component, so every text write on them fails;
  // the bundled [AE] packages are After Effects-authored and expose their fields.
  const mogrt = process.env.PREMIERE_MCP_FIXTURE_MOGRT
    || '/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Essential Graphics/[AE] Video Gaming Package/Gaming Lower Third Left.mogrt';

  return {
    srtA, srtB, csv, notes, whisperJson, lut, txt, footageIndex,
    outDir: OUT_DIR, epr: presets.epr, sqpreset: presets.sqpreset,
    mogrt: existsSync(mogrt) ? mogrt : null,
    premiereLut: existsSync(PREMIERE_LUT) ? PREMIERE_LUT : null,
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Live context: what the fixture currently contains.
 * ------------------------------------------------------------------------------------------ */

/**
 * Read the ids, names and paths the fixture actually has right now. Everything here is a real
 * value from the host — no invented ids, because a fabricated id makes a working tool report a
 * lookup failure and that reads as a defect in the tool.
 */
export async function buildContext(bridge) {
  const files = ensureSideFixtures();

  const host = await bridge.executeScript(`(function(){
    var o = { sequences: [], items: [], clips: [], markers: [], components: [], transitions: [] };
    try { o.projectPath = String(app.project.path); } catch (e) {}
    try {
      for (var s = 0; s < app.project.sequences.numSequences; s++) {
        var sq = app.project.sequences[s];
        o.sequences.push({ id: String(sq.sequenceID), name: String(sq.name) });
      }
      for (var i = 0; i < app.project.rootItem.children.numItems; i++) {
        var it = app.project.rootItem.children[i];
        var mp = '';
        try { mp = String(it.getMediaPath()); } catch (e) {}
        o.items.push({ id: String(it.nodeId), name: String(it.name), type: it.type, mediaPath: mp });
      }
      var seq = app.project.activeSequence;
      if (seq) {
        o.activeSequenceId = String(seq.sequenceID);
        o.activeSequenceName = String(seq.name);
        o.videoTracks = seq.videoTracks.numTracks;
        o.audioTracks = seq.audioTracks.numTracks;
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
          var tr = seq.videoTracks[t];
          for (var c = 0; c < tr.clips.numItems; c++) {
            var cl = tr.clips[c];
            o.clips.push({
              id: String(cl.nodeId), name: String(cl.name), trackIndex: t, clipIndex: c,
              startSecs: cl.start.seconds, endSecs: cl.end.seconds
            });
          }
        }
        o.audioClips = [];
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
          var atr = seq.audioTracks[at];
          for (var ac = 0; ac < atr.clips.numItems; ac++) {
            o.audioClips.push({ id: String(atr.clips[ac].nodeId), name: String(atr.clips[ac].name), trackIndex: at, clipIndex: ac });
          }
        }
        // The first MOGRT clip, plus a text and a colour parameter it really exposes.
        for (var mt = 0; mt < seq.videoTracks.numTracks && !o.mogrt; mt++) {
          for (var mc = 0; mc < seq.videoTracks[mt].clips.numItems; mc++) {
            var mclip = seq.videoTracks[mt].clips[mc];
            var mgt = null;
            try { mgt = mclip.isMGT() ? mclip.getMGTComponent() : null; } catch (e) {}
            if (!mgt) continue;
            o.mogrt = { trackIndex: mt, clipIndex: mc, id: String(mclip.nodeId), params: [] };
            for (var mp = 0; mp < mgt.properties.numItems; mp++) {
              var pv = '';
              try { pv = String(mgt.properties[mp].getValue()); } catch (e) {}
              o.mogrt.params.push({ name: String(mgt.properties[mp].displayName), text: pv.indexOf('{') === 0, num: /^[0-9]{12,}$/.test(pv) });
            }
            break;
          }
        }
        if (o.clips.length > 0) {
          var first = seq.videoTracks[o.clips[0].trackIndex].clips[o.clips[0].clipIndex];
          for (var k = 0; k < first.components.numItems; k++) {
            var comp = first.components[k];
            var params = [];
            try {
              for (var p = 0; p < comp.properties.numItems && p < 6; p++) params.push(String(comp.properties[p].displayName));
            } catch (e) {}
            o.components.push({ index: k, name: String(comp.displayName), params: params });
          }
        }
        var mkr = seq.markers.getFirstMarker();
        while (mkr) {
          o.markers.push({ name: String(mkr.name), guid: String(mkr.guid), startSecs: mkr.start.seconds, type: String(mkr.type) });
          mkr = seq.markers.getNextMarker(mkr);
        }
      }
      // Items one level down, for the multicam angles in fixture_bin and the multicam clip itself.
      o.nested = [];
      for (var ni = 0; ni < app.project.rootItem.children.numItems; ni++) {
        var bin = app.project.rootItem.children[ni];
        if (bin.type !== 2) continue;
        for (var nj = 0; nj < bin.children.numItems; nj++) {
          var ch = bin.children[nj];
          var isMc = false;
          try { isMc = ch.isMulticamClip(); } catch (e) {}
          o.nested.push({ id: String(ch.nodeId), name: String(ch.name), bin: String(bin.name), type: ch.type, multicam: isMc });
        }
      }
      // The panel metadata blob, so the tool that writes it can be handed a blob Premiere itself
      // produced. Anything else is a guess that would come back verified:false for the wrong reason.
      try { o.panelMetadata = String(app.project.getProjectPanelMetadata()); } catch (e) {}
      // Real transition names, so the transition family matches something installed rather than a
      // name we believe exists.
      try {
        app.enableQE();
        var vts = qe.project.getVideoTransitionList();
        for (var v = 0; v < vts.length && v < 40; v++) {
          var nm = String(vts[v].name);
          if (nm.indexOf('Dissolve') !== -1 || nm.indexOf('Cross') !== -1) o.transitions.push(nm);
        }
      } catch (e) {}
    } catch (e) { o.error = e.toString(); }
    return JSON.stringify(o);
  })();`);

  // Movies first: a still has no audio stream, so handing one to an ffmpeg audio tool (loudnorm,
  // silencedetect) made a working tool report "could not measure" every sweep.
  const media = (host.items ?? []).filter((i) => i.mediaPath && /\.(mp4|mov|png|wav|mxf)$/i.test(i.mediaPath))
    .sort((a, b) => Number(/\.png$/i.test(a.mediaPath)) - Number(/\.png$/i.test(b.mediaPath)));
  const byName = (n) => (host.items ?? []).find((i) => i.name === n);
  const fixtureItems = [byName('fixture_a.mp4'), byName('fixture_b.mp4')].filter(Boolean)
    .concat((host.items ?? []).filter((i) => i.type === 1 && !/^fixture_[ab]\.mp4$/.test(i.name)));
  const nested = host.nested ?? [];
  const camIds = nested.filter((n) => n.bin === 'fixture_bin' && n.type === 1).map((n) => n.id);
  const multicamEdit = (host.sequences ?? []).find((s) => s.name === 'fixture_mc_edit');
  const captionItem = (host.items ?? []).find((i) => /\.srt$/i.test(i.name));
  const mogrtParams = host.mogrt?.params ?? [];
  const secondSequence = (host.sequences ?? []).find((s) => s.id !== host.activeSequenceId);
  // Effect names that the fixture is known to carry, so effect-by-name tools match something
  // real. `reset-scratch.mjs` puts Lumetri Color on the first V1 clip.
  const componentNames = (host.components ?? []).map((c) => c.name);

  return {
    files,
    sequenceId: host.activeSequenceId ?? host.sequences?.[0]?.id ?? null,
    sequenceName: host.activeSequenceName ?? null,
    secondSequenceId: secondSequence?.id ?? host.activeSequenceId ?? null,
    sequenceIds: (host.sequences ?? []).map((s) => s.id),
    // The fixture clips by name, then whatever is first. "First root item" alone picked up a
    // leftover bin from an earlier sweep whenever the wipe missed one, and item tools then failed.
    itemId: fixtureItems[0]?.id ?? null,
    itemIds: fixtureItems.slice(0, 2).map((i) => i.id),
    itemName: fixtureItems[0]?.name ?? null,
    // fixture_bin by name when it exists: it is the bin reset-scratch fills with camera angles, and
    // an earlier sweep's create_bin leaves several empty "synth_name" bins that would win otherwise.
    binName: (host.items ?? []).find((i) => i.name === 'fixture_bin')?.name ?? (host.items ?? []).find((i) => i.type === 2)?.name ?? 'fixture_bin',
    binId: (host.items ?? []).find((i) => i.name === 'fixture_bin')?.id ?? (host.items ?? []).find((i) => i.type === 2)?.id ?? null,
    audioClipId: host.audioClips?.[0]?.id ?? null,
    audioClip: host.audioClips?.[0] ?? null,
    mogrt: host.mogrt ? {
      trackIndex: host.mogrt.trackIndex,
      clipIndex: host.mogrt.clipIndex,
      textParam: mogrtParams.find((p) => p.text)?.name ?? null,
      colorParam: mogrtParams.find((p) => p.num && /colou?r/i.test(p.name))?.name ?? null,
    } : null,
    camItemIds: camIds,
    multicamSequenceId: multicamEdit?.id ?? null,
    captionItemId: captionItem?.id ?? null,
    markerId: host.markers?.[0]?.guid ?? null,
    transitionName: host.transitions?.[0] ?? null,
    panelMetadata: host.panelMetadata ?? null,
    projectPath: host.projectPath ?? null,
    mediaPath: media[0]?.mediaPath ?? null,
    clipId: host.clips?.[0]?.id ?? null,
    clipIds: (host.clips ?? []).slice(0, 2).map((c) => c.id),
    clipName: host.clips?.[0]?.name ?? null,
    clips: host.clips ?? [],
    videoTracks: host.videoTracks ?? 1,
    audioTracks: host.audioTracks ?? 1,
    markerName: host.markers?.[0]?.name ?? null,
    markers: host.markers ?? [],
    componentNames,
    componentName: componentNames[0] ?? null,
    paramName: host.components?.[0]?.params?.[0] ?? null,
    raw: host,
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Schema walking
 * ------------------------------------------------------------------------------------------ */

/** Unwrap optional/default/nullable/pipe wrappers down to the concrete leaf. */
function unwrap(schema) {
  let def = schema?._def;
  let optional = false;
  const guard = new Set();
  while (def && ['optional', 'default', 'nullable', 'prefault', 'catch'].includes(def.type)) {
    optional = true;
    if (guard.has(def)) break;
    guard.add(def);
    def = def.innerType?._def;
  }
  return { def, optional };
}

/** Extension for a synthesised output path, inferred from the parameter and the tool name. */
function outputExtension(key, toolName) {
  const k = key.toLowerCase();
  const t = toolName.toLowerCase();
  if (/srt|caption/.test(k) || /srt|caption/.test(t)) return '.srt';
  if (/csv/.test(k) || /csv/.test(t)) return '.csv';
  if (/json/.test(k) || /json/.test(t)) return '.json';
  if (/gif/.test(t)) return '.gif';
  if (/preset/.test(k) || /preset/.test(t)) return '.epr';
  if (/xml|fcp|aaf|omf|edl/.test(t)) return /aaf/.test(t) ? '.aaf' : /omf/.test(t) ? '.omf' : /edl/.test(t) ? '.edl' : '.xml';
  if (/project/.test(k) || /as_project/.test(t)) return '.prproj';
  if (/notes/.test(k) || /notes/.test(t)) return '.txt';
  if (/audio|wav|stem/.test(t)) return '.wav';
  // A re-render of the source keeps its container; a .txt output made ffmpeg refuse the muxer.
  if (/loudness|normalize/.test(t)) return '.mp4';
  if (/thumbnail|still|frame|scope|palette|snapshot|false_color/.test(t)) return '.png';
  if (/export|render|encode|reel|spot/.test(t)) return '.mp4';
  return '.txt';
}

/**
 * Resolve one leaf by name, then by type. Returns `undefined` when nothing can be justified,
 * which the caller reports as unresolved rather than filling in.
 */
/**
 * Tools pointed at the second fixture sequence instead of the first, because on the first they
 * either destroy what later tools address or leave it in a state later tools cannot edit:
 *   - placing/assembling tools overwrite V1 (new nodeIds, the Lumetri clip gone);
 *   - lock/mute/target tools left V1 locked, muted or untargeted for every edit after them;
 *   - AAF export renders a multi-minute video mixdown of the first sequence's MOGRT, which held
 *     the host past every timeout (fixture_seq_b is cloned before the MOGRT is added).
 */
const SACRIFICIAL_SEQUENCE = /^(storyboard_bin_to_sequence|add_to_timeline|add_to_timeline_batch|insert_from_source|overwrite_from_source|overwrite_clip|lock_track|sync_lock_track|mute_track|set_target_track|export_aaf)$/;

/** Tools that import a new text graphic onto the timeline. */
const TEXT_PLACING = /^(add_text_overlay|title_card|lower_third_preset|batch_mogrt_from_data|countdown_leader)$/;

/**
 * Optional keys worth filling anyway for a family, because the tool's default would point it at
 * the wrong fixture (V1 clip 0 is a plain video clip; the MOGRT is on V3, the audio on A1, the
 * multicam in its own sequence). Required-only synthesis left these out and the default won.
 */
function forcedOptionalKeys(toolName) {
  const t = toolName.toLowerCase();
  const keys = [];
  if ((/mogrt/.test(t) && !/^import_mogrt/.test(t)) || TEXT_PLACING.test(t)) keys.push('trackindex', 'clipindex', 'mogrtpath');
  if (/multicam/.test(t) && !/^create_multicam/.test(t)) keys.push('sequenceid');
  if (SACRIFICIAL_SEQUENCE.test(t)) keys.push('sequenceid');
  if (t === 'three_point_edit') keys.push('sequencetimecode');
  if (t === 'set_track_lock_qe') keys.push('audio');
  return keys;
}

function resolveLeaf({ key, def, toolName, ctx, path }) {
  // Underscores are stripped as well as case, because the catalogue is not consistent about
  // spelling: `has_proxy` declares `projectItemId` while `get_item_info` declares `item_id` for
  // the same value, and `get_bin_contents` declares `bin_id`. Every pattern below is already a
  // lowercase-collapsed camelCase name, so folding `item_id` to `itemid` lets one table serve both
  // conventions. Without this the snake_case tools resolved to nothing, were called with `{}`, and
  // the host's honest "Project item not found" was recorded as a defect in the tool.
  const k = key.toLowerCase().replace(/_/g, '');
  const type = def?.type;
  const files = ctx.files;
  const tool = toolName.toLowerCase();
  // Tool families that need a specific kind of fixture rather than "the first clip". Each of these
  // used to be handed the first V1 clip and then honestly reported that it was the wrong kind:
  // "Clip is not a MOGRT", "Volume component not found", "canDoMulticam() returned false".
  const isMogrtTool = /mogrt/.test(tool) && !/^import_mogrt/.test(tool);
  const isAudioClipTool = /audio_level|audio_keyframe|ducking|clip_pan|clip_gain|clip_peaks|limiter|clip_volume/.test(tool);
  const isMulticamTool = /multicam/.test(tool) && !/^create_multicam/.test(tool);
  const isTextPlacingTool = TEXT_PLACING.test(tool);

  // Text-placing tools import a new graphic. Left at their defaults (V2 at 1s) they overwrote the
  // fixture's V2 clip; at V3 from 40s they land on empty timeline past the fixture MOGRT (V3 at
  // 20s), which the MOGRT tools later in the run still need.
  if (isTextPlacingTool && (type === 'number' || type === 'int')) {
    if (/trackindex/.test(k)) return 2;
    if (/^(starttime|starttimesecs|timesecs)$/.test(k)) return 40;
  }
  // three_point_edit has no sequence argument and overwrites at the playhead by default, which
  // replaced the fixture's first V1 clip (new nodeId, Lumetri gone) and cost ~40 later tools
  // "Clip not found" on 2026-10-27. Aimed past the fixture's content it still edits for real.
  if (tool === 'three_point_edit' && type === 'string' && /^sequencetimecode$/.test(k)) return '00:00:50:00';
  // set_track_lock_qe has no sequence argument; lock the last audio track, which holds nothing.
  if (tool === 'set_track_lock_qe') {
    if (type === 'boolean' && /^audio$/.test(k)) return true;
    if ((type === 'number' || type === 'int') && /^trackindex$/.test(k)) return Math.max(0, (ctx.audioTracks ?? 1) - 1);
  }

  if (isMogrtTool && ctx.mogrt && (type === 'number' || type === 'int')) {
    if (/trackindex/.test(k)) return ctx.mogrt.trackIndex;
    if (/clipindex/.test(k)) return ctx.mogrt.clipIndex;
  }
  if (isMogrtTool && ctx.mogrt && type === 'string' && /^(paramname|parametername|propertyname)$/.test(k)) {
    return (/color/.test(tool) ? ctx.mogrt.colorParam : ctx.mogrt.textParam) ?? undefined;
  }
  if (isAudioClipTool && ctx.audioClip) {
    if (type === 'string' && /clipid$/.test(k)) return ctx.audioClip.id;
    if ((type === 'number' || type === 'int') && /trackindex/.test(k)) return ctx.audioClip.trackIndex;
    if ((type === 'number' || type === 'int') && /clipindex/.test(k)) return ctx.audioClip.clipIndex;
  }
  if (isMulticamTool && ctx.multicamSequenceId && type === 'string' && /sequenceid$/.test(k)) return ctx.multicamSequenceId;
  // Tools that rebuild V1 wholesale get the disposable second sequence. storyboard_bin_to_sequence
  // overwrote the fixture's V1 with the three camera angles, and every clip id the context holds
  // then answered "Clip not found" for the rest of the run.
  if (SACRIFICIAL_SEQUENCE.test(tool) && type === 'string' && /^sequenceid$/.test(k)) return ctx.secondSequenceId ?? undefined;
  if (/caption/.test(tool) && ctx.captionItemId && type === 'string' && /(projectitemid|itemid)$/.test(k)) return ctx.captionItemId;
  if (type === 'string' && /^mogrtpath$/.test(k)) return files.mogrt ?? undefined;
  // "source" and "target" mean two different things. Resolving both to the same clip or sequence
  // made copy_effect_values, copy_effects_between_clips and copy_markers_between_sequences refuse
  // ("Source and target are the same...") — a correct answer to a degenerate question.
  if (type === 'string' && /^(target|to|dest|destination)(clipid)$/.test(k)) return ctx.clipIds?.[1] ?? undefined;
  if (type === 'string' && /^(source|from)(clipid)$/.test(k)) return ctx.clipIds?.[0] ?? undefined;
  // A second sequence only for the tools that move things BETWEEN sequences; for the clip-copy
  // tools both clip ids come from the active sequence, so the target sequence must be that one.
  if (type === 'string' && /^(target|destination)sequenceid$/.test(k)) {
    return (/between_sequences|sequences$/.test(tool) ? ctx.secondSequenceId : ctx.sequenceId) ?? undefined;
  }

  // ---- enums: pick a member, preferring one that is meaningful for the fixture -------------
  if (type === 'enum') {
    const members = Object.values(def.entries ?? {});
    const prefer = ['Comment', 'video', 'dialog', 'left', 'seconds', 'mp4', 'png'];
    return members.find((m) => prefer.includes(m)) ?? members[0];
  }
  if (type === 'literal') {
    const vals = def.values ?? [def.value];
    return vals[0];
  }

  // ---- booleans: choose the direction that is least likely to destroy fixture state -------
  if (type === 'boolean') {
    if (/^(delete|remove|force|overwrite|destructive|clear|purge|offline|reverse|close|mute)/.test(k)) return false;
    if (/(delete|remove|overwrite|purge|recursive)$/.test(k)) return false;
    return true;
  }

  // ---- strings ----------------------------------------------------------------------------
  if (type === 'string') {
    if (/^(sequenceid|seqid|sourcesequenceid)$/.test(k)) return ctx.sequenceId ?? undefined;
    if (/sequenceid/.test(k)) return /b$|second|target|destination/.test(k) ? (ctx.secondSequenceId ?? undefined) : (ctx.sequenceId ?? undefined);
    if (/binid$/.test(k)) return ctx.binId ?? ctx.itemId ?? undefined;
    // A trailing 1/2 means "two different ones" (compare_takes, add_transition). Hand back
    // distinct fixture ids, because the same id twice is a degenerate case for a comparison.
    const pairMatch = /^(projectitemid|itemid|clipid|sequenceid)([12])$/.exec(k);
    if (pairMatch) {
      const which = Number(pairMatch[2]) - 1;
      const pool = pairMatch[1] === 'clipid' ? ctx.clipIds : pairMatch[1] === 'sequenceid' ? ctx.sequenceIds : ctx.itemIds;
      return pool?.[which] ?? pool?.[0] ?? undefined;
    }
    if (/(projectitemid|itemid)$/.test(k)) return ctx.itemId ?? undefined;
    if (/clipid$/.test(k)) return ctx.clipId ?? undefined;
    if (/^markerid$/.test(k)) return ctx.markerId ?? undefined;
    if (/^(markername)$/.test(k)) return ctx.markerName ?? undefined;
    if (/transitionname/.test(k)) return ctx.transitionName ?? 'Cross Dissolve';
    if (/^metadata$/.test(k)) return ctx.panelMetadata ?? undefined;
    // A literal that genuinely occurs in the scratch project's XML, so a find/replace edit has
    // something to match. reset-scratch.mjs always names the first sequence this.
    if (/^find$/.test(k)) return 'fixture_seq_a';
    if (/^replace$/.test(k)) return 'fixture_seq_a';
    if (/^(oldprefix|oldpath|frompath|fromprefix)$/.test(k)) return dirname(ctx.mediaPath ?? files.txt);
    if (/^(newprefix|newpath|topath)$/.test(k)) return dirname(ctx.mediaPath ?? files.txt);
    if (/^(componentname|effectname|videoeffectname|audioeffectname|matchname)$/.test(k)) {
      return ctx.componentName ?? 'Lumetri Color';
    }
    if (/^(paramname|parametername|propertyname)$/.test(k)) return ctx.paramName ?? undefined;
    if (/^timecode$/.test(k) || /timecode/.test(k)) return '00:00:01:00';
    if (/^(labelcolor|color|colour|markercolor)$/.test(k)) return 'Green';
    if (/^(colorspacename|colorspace)$/.test(k)) return 'Rec. 709';
    if (/^(pattern|query|search|substring|pathsubstring|namecontains)$/.test(k) || /substring|pattern|query/.test(k)) return 'fixture';
    if (/^(key)$/.test(k)) return 'Column.Intrinsic.Name';
    if (/^(value|text|contents|comment|comments|description|summary|note)$/.test(k)) return 'synthesised by the live sweep';
    if (/^(columnid)$/.test(k)) return 'Sweep.Synth.Field';
    if (/^binname$/.test(k)) return ctx.binName ?? undefined;
    if (/(displayname|reelname|sequencename|name)$/.test(k) || /^(label|title)$/.test(k)) {
      return /sequencename$/.test(k) ? 'synth_seq' : 'synth_name';
    }
    if (/^(fileextension|extension|ext)$/.test(k)) return 'txt';
    if (/^(filename)$/.test(k)) return 'synth-sidecar';
    if (/^(format)$/.test(k)) return 'H.264';
    if (/^(renderername)$/.test(k)) return 'Mercury Playback Engine GPU Acceleration (Metal)';
    if (/^(gradejson)$/.test(k)) return JSON.stringify({ Exposure: 0.1, Contrast: 5 });
    if (/^(location|folder|dir|directory|outputdir|destination|destinationdir)$/.test(k) || /(dir|folder)$/.test(k)) return files.outDir;
    // A LUT Premiere actually lists: the Input LUT slot is a dropdown, so apply_lut can only select
    // an installed LUT, and the identity fixture renders like "no LUT" and is (correctly) refused.
    if (/^lutpath$/.test(k) || /lutpath/.test(k)) return files.premiereLut ?? files.lut;
    if (/^(srtpath|srtpatha|captionpath|captionspath)$/.test(k)) return files.srtA;
    if (/^srtpathb$/.test(k)) return files.srtB;
    if (/srtpath|captionfile/.test(k)) return files.srtA;
    if (/^(jsonpath|transcriptpath|transcriptjsonpath)$/.test(k)) return files.whisperJson;
    if (/^(csvpath)$/.test(k)) return files.csv;
    if (/^(notespath)$/.test(k)) return files.notes;
    // The .prproj tools read a project file, not media. Handing them the fixture mp4 would make
    // them report "not a project container", which is true and useless.
    if (/prproj|project_file/.test(toolName) && /(sourcepath|filepath|projectpath|inputpath)$/.test(k)) {
      return ctx.projectPath ?? undefined;
    }
    if (/^(mediapath|sourcepath|inputpath|clippath|filepath|videopath|audiopath|assetpath)$/.test(k)) {
      return ctx.mediaPath ?? undefined;
    }
    // presetPath wants a preset file Adobe authored. A fabricated path would make the tool report
    // a missing preset — a harness failure dressed as a tool failure — so borrow a real one from
    // the installed application. Sequence tools want a .sqpreset, encoder tools an .epr.
    // `outputPresetPath` also contains "presetpath" but is a WRITE target: returning Adobe's own
    // preset there would have the tool overwrite a file inside the application bundle.
    if (/presetpath/.test(k) && !/^output/.test(k)) {
      const wantsSequence = /sequence/.test(toolName.toLowerCase()) && !/export|encode|render/.test(toolName.toLowerCase());
      return (wantsSequence ? files.sqpreset : files.epr) ?? undefined;
    }
    if (/(outputpath|outpath|destpath|targetpath|reportpath|writepath)$/.test(k) || /^output/.test(k)) {
      return join(files.outDir, `synth-${toolName}${outputExtension(key, toolName)}`);
    }
    // Not every key ending in "path" is a path on disk. `object_path` is a dot-path into the
    // Premiere DOM, so handing it a .mp4 filename made reflect_dom_object report "Path did not
    // resolve to a value" — a correct answer to a question the harness had no business asking.
    if (/^(objectpath|dompath|propertypath)$/.test(k)) return 'app.project';
    // A footage index is a JSON document this harness writes, not a media file.
    if (/^(indexpath|footageindexpath)$/.test(k)) return files.footageIndex;
    if (/path$/.test(k)) {
      // An input path we could not name: the fixture media is the only file guaranteed to exist.
      return ctx.mediaPath ?? files.txt;
    }
    return undefined;
  }

  // ---- numbers ----------------------------------------------------------------------------
  if (type === 'number' || type === 'int' || type === 'bigint') {
    if (/^(trackindex|videotrackindex|audiotrackindex|sourcetrackindex|targettrackindex)$/.test(k) || /trackindex/.test(k)) return 0;
    if (/^(clipindex|sourceclipindex|targetclipindex)$/.test(k) || /clipindex/.test(k)) return 0;
    if (/^(componentindex|paramindex|effectindex|markerindex|angleindex|index)$/.test(k) || /index$/.test(k)) return 0;
    if (/^(frames|durationframes|nudgeframes|framecount)$/.test(k) || /frames/.test(k)) return 2;
    if (/^(count|limit|max|maxresults)$/.test(k)) return 3;
    if (/(fps|framerate)$/.test(k) || /^sourcefps$/.test(k)) return 24;
    if (/percent/.test(k)) return 50;
    if (/lufs$/.test(k)) return -14;
    if (/^truepeakdb$/.test(k)) return -1;
    if (/^loudnessrange$/.test(k)) return 11;
    if (/^(gaindb|volumedb|db|leveldb)$/.test(k) || /db$/.test(k)) return 0;
    if (/^(opacity|scale|uniformscale)$/.test(k)) return 100;
    if (/^(r|g|b|red|green|blue)$/.test(k)) return 128;
    if (/^(width|height)$/.test(k)) return 4;
    if (/^(amount|blur|sharpen|strength)$/.test(k)) return 5;
    // A range needs out after in: in = out = 1 made Premiere store a collapsed range that reads
    // back as about -400000 s, which the sweep recorded as a broken set_sequence_in_out_points.
    if (/^(outpoint|outpointsecs|outseconds)$/.test(k)) return 3;
    if (/^(inpoint|inpointsecs|inseconds)$/.test(k)) return 1;
    if (/(secs|seconds|time|start|end|at|duration|targetseconds)/.test(k)) {
      // A time inside the fixture's first clip, so the value addresses real material.
      if (/^(end|endsecs|outsecs|targetseconds|durationsecs|duration|durationseconds)$/.test(k)) return 2;
      return /^(start|startsecs|insecs)$/.test(k) ? 0 : 1;
    }
    if (/^(timecode)$/.test(k)) return 1;
    if (/^(method|type|mode|quality)$/.test(k)) return 0;
    if (/^(maxcps)$/.test(k)) return 17;
    if (/^(mingapms)$/.test(k)) return 80;
    return 1;
  }

  // ---- containers -------------------------------------------------------------------------
  if (type === 'array') {
    const element = def.element;
    // An effect-stack reorder must list names the clip actually carries, in some order, or the
    // tool is being asked to reorder components that are not there.
    if (/^neworder$/.test(k) && ctx.componentNames?.length > 1) {
      return [...ctx.componentNames].reverse();
    }
    if (/^projectitemids$/.test(k)) {
      const pool = /multicam/.test(toolName) && ctx.camItemIds?.length ? ctx.camItemIds : ctx.itemIds;
      return pool?.length ? [...pool] : undefined;
    }
    const singular = key.replace(/(ies)$/, 'y').replace(/s$/, '');
    const one = synthesizeValue({ key: singular, schema: element, toolName, ctx, path: `${path}[0]` });
    if (one.value === undefined) return undefined;
    return [one.value];
  }
  if (type === 'object') {
    const shape = def.shape ?? {};
    const obj = {};
    for (const [childKey, childSchema] of Object.entries(shape)) {
      const { optional } = unwrap(childSchema);
      if (optional) continue;
      const child = synthesizeValue({ key: childKey, schema: childSchema, toolName, ctx, path: `${path}.${childKey}` });
      if (child.value === undefined) return undefined;
      obj[childKey] = child.value;
    }
    return obj;
  }
  if (type === 'record' || type === 'map') return {};
  if (type === 'union') {
    for (const option of def.options ?? []) {
      const attempt = synthesizeValue({ key, schema: option, toolName, ctx, path });
      if (attempt.value !== undefined) return attempt.value;
    }
    return undefined;
  }
  if (type === 'any' || type === 'unknown') return 'synth';

  return undefined;
}

function synthesizeValue({ key, schema, toolName, ctx, path }) {
  const { def } = unwrap(schema);
  if (!def) return { value: undefined, path };
  const value = resolveLeaf({ key, def, toolName, ctx, path });
  return { value, path };
}

/**
 * Build arguments for one tool.
 *
 * @returns {{args: object, unresolved: string[], ok: boolean, error?: string}}
 *   `ok` means the result passed the tool's own schema, so the harness knows the call will reach
 *   the host rather than bouncing off our validator. When it is false the caller records
 *   `skipped_args` with the keys we could not build — the same outcome as before, but now
 *   naming a specific gap instead of the whole tool.
 */
export function synthesizeArgs(tool, ctx) {
  const shape = tool.inputSchema?.shape ?? {};
  const args = {};
  const unresolved = [];

  const forced = forcedOptionalKeys(tool.name);
  for (const [key, schema] of Object.entries(shape)) {
    const { optional } = unwrap(schema);
    if (optional) {
      if (forced.includes(key.toLowerCase().replace(/_/g, ''))) {
        const { value } = synthesizeValue({ key, schema, toolName: tool.name, ctx, path: key });
        if (value !== undefined) args[key] = value;
      }
      continue;
    }
    const { value } = synthesizeValue({ key, schema, toolName: tool.name, ctx, path: key });
    if (value === undefined) unresolved.push(key);
    else args[key] = value;
  }

  const validate = (candidate) => {
    try {
      const parsed = tool.inputSchema?.safeParse?.(candidate);
      if (!parsed || parsed.success) return null;
      return parsed.error?.issues?.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 4).join('; ');
    } catch (e) {
      return String(e.message);
    }
  };

  // Validate against the tool's real schema. Passing our own guess to the host without checking
  // is how the old harness produced 93 identical "Invalid arguments" records that all looked
  // like tool failures in the raw report.
  let error = validate(args);

  /** Add every optional key we can resolve. Kept only if the result still validates. */
  const widen = () => {
    const widened = { ...args };
    for (const [key, schema] of Object.entries(shape)) {
      if (key in widened) continue;
      const { optional } = unwrap(schema);
      if (!optional) continue;
      const { value } = synthesizeValue({ key, schema, toolName: tool.name, ctx, path: key });
      if (value !== undefined) widened[key] = value;
    }
    if (Object.keys(widened).length === Object.keys(args).length) return false;
    const widenedError = validate(widened);
    if (widenedError) return false;
    for (const key of Object.keys(widened)) args[key] = widened[key];
    error = null;
    return true;
  };

  // Required-only is not always sufficient. Several schemas carry a cross-field refinement —
  // `probe_media` accepts a mediaPath OR a projectItemId and declares both optional, so filling
  // only the required keys yields the empty object and the refinement rejects it. When the
  // failure is at the root (a refinement, not a missing field), widen and try once more.
  if (error && /\(root\)/.test(error)) widen();

  // An EMPTY candidate is the other way required-only fails, and it fails silently. This
  // catalogue marks nearly every field `.optional()` on purpose — handlers accept alternate arg
  // spellings (itemId/item_id/projectItemId), so marking the canonical name required would reject
  // alternate-name callers. The side effect is that "required keys only" resolves to `{}` for a
  // large family of tools, `{}` validates cleanly, and the tool is invoked with no arguments at
  // all. The host then answers "Project item not found" — and the ledger records a defect in the
  // tool for a call the harness chose to make empty. get_item_info, get_project_item_info,
  // has_proxy, get_bin_contents and get_value_at_time all failed exactly this way, and all five
  // succeed when handed the id the fixture already reported.
  //
  // So: an empty candidate is never worth sending. Widen instead, and only report unsynthesisable
  // if even the widened form is empty. Tools that DO get required keys are still called minimally,
  // which keeps their own defaults under test.
  if (!error && Object.keys(args).length === 0 && Object.keys(shape).length > 0) widen();

  let ok = !error;
  if (unresolved.length) {
    ok = false;
    error = `could not synthesise: ${unresolved.join(', ')}${error ? ` (${error})` : ''}`;
  }

  return { args, unresolved, ok, error };
}
