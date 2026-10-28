/**
 * find_tool against the way an editor actually asks. Each phrase names the tool a human would
 * want, and the search must put it in its top 3 (top 1 for the sharpest asks). Baseline on
 * 2026-10-28, before editor vocabulary: about half came first, and "make it black and white"
 * returned black_frame_scan.
 */
import { PremiereProTools } from '../../tools/index.js';

const tools = new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);

async function top(query: string, n = 3): Promise<string[]> {
  const r: any = await tools.executeTool('find_tool', { query, limit: n });
  return (r.matches ?? r.data?.matches ?? []).map((m: any) => m.name);
}

const CASES: Array<[string, string, 1 | 3]> = [
  ['fade out the music', 'fade_out_audio', 1],
  ['make it black and white', 'color_correct', 3],
  ['desaturate this shot', 'color_correct', 3],
  ['swap in the new render version', 'replace_clip_media', 3],
  ['replace this shot with v002', 'replace_clip_media', 3],
  ['add subtitles from srt', 'create_caption_track', 3],
  ['speed up this clip', 'bake_speed_change', 3],
  ['slow motion', 'bake_speed_change', 3],
  ['cross dissolve between shots', 'add_transition', 3],
  ['add a dissolve', 'add_transition', 3],
  ['lower the dialogue volume', 'set_clip_volume', 3],
  ['freeze on this frame', 'freeze_frame', 1],
  ['hold this frame for two seconds', 'freeze_frame', 3],
  ['export for youtube', 'export_social_preset', 3],
  ['color grade like the reference', 'match_shot_color', 3],
  ['match the look of the other shot', 'match_shot_color', 3],
  ['ripple delete the gap', 'ripple_delete', 3],
  ['close the gap', 'close_gap_at', 3],
  ['duck music under voice', 'setup_ducking', 1],
  ['apply LUT', 'apply_lut', 3],
  ['multicam edit switching angles', 'create_multicam_cut', 3],
  ['export each track as stems', 'stem_export', 3],
  ['make the loudness broadcast safe', 'normalize_loudness', 3],
  ['drop a marker here', 'add_marker', 3],
  ['zoom in on the clip', 'set_clip_scale', 3],
  ['play it backwards', 'reverse_clip', 3],
  ['cut the clip in two', 'split_clip', 3],
  ['grab a still of this frame', 'export_frame', 3],
  ['find the silent parts', 'detect_silence', 3],
  ['add a title', 'add_text_overlay', 3],
  // Second batch: phrasings tried AFTER the first fix, to keep the map honest about generalising.
  ['turn this into greyscale', 'color_correct', 3],
  ['update the shot to the latest comp', 'replace_clip_media', 3],
  ['put captions on the timeline', 'create_caption_track', 3],
  ['make this half speed', 'bake_speed_change', 3],
  ['hold the last frame', 'freeze_frame', 1],
  ['soften the cut with a dissolve', 'add_transition', 1],
  ['save a png of this frame', 'export_frame', 3],
  ['remove dead air', 'detect_silence', 3],
  ['mark this spot', 'add_marker', 3],
  ['crop the edges', 'crop_clip', 1],
  ['mute the music track', 'mute_track', 1],
  ['export an xml for the colorist', 'export_as_fcp_xml', 3],
];

describe('find_tool understands editor phrasing', () => {
  it.each(CASES)('"%s" finds %s', async (query, want, within) => {
    expect(await top(query, within)).toContain(want);
  });

  it('ranks a doer above an inspector when the ask is an action', async () => {
    const hits = await top('make it black and white', 3);
    expect(hits[0]).not.toMatch(/scan|report|^get_/);
  });
});
