import { parseVersioned, planVersionUp } from '../../tools/version-up.js';

describe('version_up_shots planning', () => {
  it('reads shot, version and extension from common render names', () => {
    expect(parseVersioned('SH010_comp_v003.mp4')).toMatchObject({
      stem: 'SH010_comp',
      version: 3,
      ext: '.mp4',
    });
    expect(parseVersioned('SPHE_008_0080.v12.mov')).toMatchObject({
      stem: 'SPHE_008_0080',
      version: 12,
    });
    expect(parseVersioned('shot-v2.exr')).toMatchObject({ stem: 'shot', version: 2 });
    expect(parseVersioned('interview_take3.mp4')).toBeNull();
  });

  it('relinks each item to the newest version with the same stem and extension, and nothing else', () => {
    const items = [
      { id: 'a', name: 'SH010_comp_v001.mp4', path: '/r/SH010/SH010_comp_v001.mp4' },
      { id: 'b', name: 'SH020_comp_v004.mp4', path: '/r/SH020/SH020_comp_v004.mp4' },
      { id: 'c', name: 'music.wav', path: '/a/music.wav' },
    ];
    const files = [
      '/r/SH010/SH010_comp_v001.mp4',
      '/r/SH010/SH010_comp_v002.mp4',
      '/r/SH010/SH010_comp_v010.mp4',
      '/r/SH010/SH010_comp_v011.mov', // different extension: not the same deliverable
      '/r/SH010/SH010_bg_v020.mp4', // different stem
      '/r/SH020/SH020_comp_v003.mp4', // older than what is cut in
    ];
    const plan = planVersionUp(items, files);
    expect(plan.relink).toEqual([
      expect.objectContaining({
        id: 'a',
        fromVersion: 1,
        toVersion: 10,
        to: '/r/SH010/SH010_comp_v010.mp4',
      }),
    ]);
    expect(plan.current.map((c) => c.id)).toEqual(['b']);
    expect(plan.unversionedCount).toBe(1);
  });
});
