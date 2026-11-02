/**
 * The helpers replace_clip uses to carry a clip's settings onto new media: by effect matchName
 * occurrence and property index, never by display name. Lumetri repeats names (four
 * "Saturation"), and the by-name copy this replaced wrote one over another while reporting
 * success.
 */
import vm from 'node:vm';
import { EXTENDSCRIPT_HELPERS } from '../../bridge/index.js';

type Prop = {
  displayName: string;
  value: any;
  keys?: Array<{ seconds: number; v: any }>;
  readOnly?: boolean;
};

function fakeClip(components: Array<{ matchName: string; displayName: string; props: Prop[] }>) {
  const comps = components.map((c) => {
    const properties: any = c.props.map((p) => ({
      displayName: p.displayName,
      isTimeVarying: () => !!p.keys,
      getValue: () => p.value,
      setValue: (v: any) => {
        if (p.readOnly) throw new Error('read only');
        p.value = v;
      },
      getKeys: () => (p.keys ?? []).map((k) => ({ seconds: k.seconds })),
      getValueAtKey: (t: { seconds: number }) => p.keys!.find((k) => k.seconds === t.seconds)!.v,
      setTimeVarying: (on: boolean) => {
        if (on && !p.keys) p.keys = [];
      },
      addKey: (t: { seconds: number }) => {
        if (!p.keys!.some((k) => k.seconds === t.seconds))
          p.keys!.push({ seconds: t.seconds, v: p.value });
      },
      setValueAtKey: (t: { seconds: number }, v: any) => {
        p.keys!.find((k) => k.seconds === t.seconds)!.v = v;
      },
    }));
    properties.numItems = properties.length;
    return { matchName: c.matchName, displayName: c.displayName, properties };
  });
  const list: any = comps;
  list.numItems = comps.length;
  return { components: list };
}

const lumetri = (vals: number[]) => ({
  matchName: 'AE.ADBE Lumetri',
  displayName: 'Lumetri Color',
  props: [
    { displayName: 'Saturation', value: vals[0] },
    { displayName: 'Temperature', value: vals[1] },
    { displayName: 'Saturation', value: vals[2] },
  ],
});
const motion = (scale: number, keys?: Array<{ seconds: number; v: any }>) => ({
  matchName: 'AE.ADBE Motion',
  displayName: 'Motion',
  props: [
    { displayName: 'Position', value: [0.5, 0.5] },
    { displayName: 'Scale', value: scale, keys },
  ],
});

describe('clip state by position', () => {
  const ctx = vm.createContext({
    Time: function (this: any) {
      this.seconds = 0;
    },
  });
  vm.runInContext(EXTENDSCRIPT_HELPERS, ctx);
  const run = (code: string, vars: Record<string, unknown>) => {
    Object.assign(ctx, vars);
    return vm.runInContext(code, ctx);
  };

  it('carries repeated setting names separately, and keyframes, then compares clean', () => {
    const src = fakeClip([
      motion(100, [
        { seconds: 0.5, v: 80 },
        { seconds: 1.5, v: 120 },
      ]),
      lumetri([100, 20, 150]),
    ]);
    const dst = fakeClip([motion(100), lumetri([100, 0, 100])]);
    const errs = run('var s = __mcpSnapClip(src); __mcpApplySnap(dst, s)', { src, dst });
    expect(errs).toEqual([]);
    const lum = dst.components[1].properties;
    expect([lum[0].getValue(), lum[1].getValue(), lum[2].getValue()]).toEqual([100, 20, 150]);
    expect(dst.components[0].properties[1].getKeys().map((k: any) => k.seconds)).toEqual([
      0.5, 1.5,
    ]);
    expect(run('__mcpDiffSnap(dst, __mcpSnapClip(src))', { src, dst })).toEqual([]);
  });

  it('reports a setting that did not take, and a missing effect', () => {
    const src = fakeClip([lumetri([100, 20, 150])]);
    const dst = fakeClip([lumetri([100, 0, 100])]);
    (dst.components[0].properties[1] as any).setValue = () => {
      throw new Error('read only');
    };
    const out = run('var s = __mcpSnapClip(src); [__mcpApplySnap(dst, s), __mcpDiffSnap(dst, s)]', {
      src,
      dst,
    });
    expect(out[0]).toHaveLength(1);
    expect(out[1]).toEqual([
      expect.objectContaining({ comp: 'Lumetri Color', index: 1, want: 20, got: 0 }),
    ]);
    const bare = fakeClip([motion(100)]);
    expect(run('__mcpDiffSnap(bare, __mcpSnapClip(src))', { src, bare })).toEqual([
      expect.objectContaining({ comp: 'Lumetri Color', missing: true }),
    ]);
  });

  it('pairs the second Lumetri with the second, not the first', () => {
    const src = fakeClip([lumetri([110, 1, 120]), lumetri([130, 2, 140])]);
    const dst = fakeClip([lumetri([100, 0, 100]), lumetri([100, 0, 100])]);
    run('__mcpApplySnap(dst, __mcpSnapClip(src))', { src, dst });
    expect(dst.components[1].properties[0].getValue()).toBe(130);
    expect(run('__mcpDiffSnap(dst, __mcpSnapClip(src))', { src, dst })).toEqual([]);
  });

  it('compares numbers with a tolerance and arrays element by element', () => {
    expect(
      run(
        '[__mcpSame(1, 1.00000001), __mcpSame(1, 1.1), __mcpSame([0.5, 0.5], [0.5, 0.5]), __mcpSame([0.5, 0.5], [0.5, 0.6]), __mcpSame("a", "b")]',
        {},
      ),
    ).toEqual([true, false, true, false, false]);
  });
});
