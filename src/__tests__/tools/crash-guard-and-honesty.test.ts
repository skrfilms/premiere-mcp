/**
 * Pins the fixes from the PR #16 review (2026-11-01):
 *
 * 1. __crashProneAudioFx, the guard that keeps DeNoise/DeReverb off nested and multicam clips
 *    (they crash Premiere 26.5.2). It must match any case and the obsolete alias, catch multicam
 *    directly, and refuse when it cannot read the clip's source rather than let the effect through.
 * 2. freeze_frame on a numbered image sequence holds the frame's own file, not frame 1.
 * 3. reorder_effects changes nothing, so a transaction must treat it as read-only.
 */
import vm from 'node:vm';
import { join } from 'node:path';
import { EXTENDSCRIPT_HELPERS } from '../../bridge/index.js';
import { imageSequenceFrame } from '../../tools/domains/assembly.js';
import { classifyTransactionTool } from '../../tools/transactions.js';

describe('__crashProneAudioFx', () => {
  const ctx = vm.createContext({});
  vm.runInContext(EXTENDSCRIPT_HELPERS, ctx);
  const guard = (clip: unknown, effect: string): string => {
    (ctx as any).__clip = clip;
    return vm.runInContext(`__crashProneAudioFx(__clip, ${JSON.stringify(effect)})`, ctx);
  };
  const item = (o: { seq?: boolean; mc?: boolean; mcThrows?: boolean }) => ({
    isSequence: () => !!o.seq,
    isMulticamClip: () => {
      if (o.mcThrows) throw new Error('no such method');
      return !!o.mc;
    },
  });
  const fileClip = { projectItem: item({}) };
  const nestedClip = { projectItem: item({ seq: true }) };
  const multicamClip = { projectItem: item({ mc: true }) };

  it('allows DeNoise and DeReverb on a file-based clip', () => {
    expect(guard(fileClip, 'DeNoise')).toBe('');
    expect(guard(fileClip, 'DeReverb')).toBe('');
  });

  it('refuses them on a nested sequence and on a multicam clip', () => {
    expect(guard(nestedClip, 'DeNoise')).toMatch(
      /nested sequence or multicam clip crashes Premiere/,
    );
    expect(guard(multicamClip, 'DeReverb')).toMatch(/nothing was changed/);
  });

  it('matches the name in any case, and the obsolete Adaptive Noise Reduction', () => {
    expect(guard(nestedClip, 'denoise')).not.toBe('');
    expect(guard(nestedClip, 'DEREVERB')).not.toBe('');
    expect(guard(nestedClip, 'Adaptive Noise Reduction (Obsolete)')).not.toBe('');
  });

  it('fails closed when the clip or its source cannot be read', () => {
    expect(guard(null, 'DeNoise')).toMatch(/could not confirm/);
    expect(guard({}, 'DeNoise')).toMatch(/could not confirm/);
    const throwing = {
      get projectItem() {
        throw new Error('Unknown error exception');
      },
    };
    expect(guard(throwing, 'DeNoise')).toMatch(/could not confirm/);
  });

  it('still treats a clip as file-based when only the multicam probe is missing', () => {
    expect(guard({ projectItem: item({ mcThrows: true }) }, 'DeNoise')).toBe('');
  });

  it('leaves every other effect alone, nested or not', () => {
    expect(guard(nestedClip, 'Parametric Equalizer')).toBe('');
    expect(guard(null, 'Hard Limiter')).toBe('');
  });
});

describe('imageSequenceFrame (freeze_frame on image media)', () => {
  const dir = '/plates/sh010';
  const onDisk = (names: string[]) => {
    const set = new Set(names.map((n) => join(dir, n)));
    return (p: string) => set.has(p);
  };

  it('treats a single numbered still as a still', () => {
    expect(imageSequenceFrame(join(dir, 'logo_01.png'), 3, 24, onDisk(['logo_01.png']))).toBeNull();
    expect(imageSequenceFrame(join(dir, 'logo.png'), 3, 24, onDisk(['logo.png']))).toBeNull();
  });

  it("picks the frame's own file, keeping the padding and start number", () => {
    const files = ['sh010_1001.exr', 'sh010_1002.exr', 'sh010_1077.exr'];
    // 3.2 s at 24 fps is frame index 76 from the first file, 1001 + 76 = 1077.
    expect(imageSequenceFrame(join(dir, files[0]), 3.2, 24, onDisk(files))).toEqual({
      file: join(dir, 'sh010_1077.exr'),
    });
  });

  it('refuses when the frame rate is unknown or the frame is missing', () => {
    const files = ['sh010_0001.dpx', 'sh010_0002.dpx'];
    expect(imageSequenceFrame(join(dir, files[0]), 1, 0, onDisk(files))).toMatchObject({
      error: expect.stringMatching(/frame rate could not be read/),
    });
    expect(imageSequenceFrame(join(dir, files[0]), 5, 24, onDisk(files))).toMatchObject({
      error: expect.stringMatching(/not on disk/),
    });
  });
});

describe('reorder_effects in a transaction', () => {
  it('is read-only, so including it does not fail the transaction', () => {
    expect(classifyTransactionTool('reorder_effects')).toMatchObject({
      readOnly: true,
      category: 'read_only',
    });
  });
});
