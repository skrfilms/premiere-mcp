/**
 * Defects the 2026-10-25 live sweep found on Premiere 26.5.2, pinned so they stay fixed.
 *
 * 1. A cold 26.5.2 engine has no Array.prototype.map/filter/indexOf and no Array.isArray.
 *    About twenty tools threw "x.indexOf is not a function" on every call. The bridge prelude
 *    now installs them, and only where they are missing.
 * 2. copy_markers_between_sequences with the same sequence on both sides walked the marker list
 *    it was appending to and never returned. The host could not cancel it and Premiere had to be
 *    killed.
 */

import vm from 'node:vm';
import { EXTENDSCRIPT_HELPERS } from '../../bridge/index.js';
import { PremiereProTools } from '../../tools/index.js';

describe('bridge prelude array polyfills', () => {
  const coldContext = () => {
    const ctx = vm.createContext({});
    // Strip the four methods to model the cold 26.5.2 engine.
    vm.runInContext(
      'delete Array.prototype.map; delete Array.prototype.filter; delete Array.prototype.indexOf; delete Array.isArray;',
      ctx,
    );
    vm.runInContext(EXTENDSCRIPT_HELPERS, ctx);
    return ctx;
  };

  it('installs map, filter, indexOf and isArray on an engine that lacks them', () => {
    const out = vm.runInContext(
      'JSON.stringify([[1,2,3].map(function(x){return x*2;}), [1,2,3,4].filter(function(x){return x%2===0;}), ["a","b"].indexOf("b"), ["a"].indexOf("z"), Array.isArray([]), Array.isArray({length:0})])',
      coldContext(),
    );
    expect(out).toBe('[[2,4,6],[2,4],1,-1,true,false]');
  });

  it('serialises an array without leaking the polyfilled members', () => {
    expect(vm.runInContext('JSON.stringify({a:[1,2]})', coldContext())).toBe('{"a":[1,2]}');
  });

  it('keeps a host implementation that already exists', () => {
    const ctx = vm.createContext({});
    vm.runInContext('var native = Array.prototype.map;', ctx);
    vm.runInContext(EXTENDSCRIPT_HELPERS, ctx);
    expect(vm.runInContext('Array.prototype.map === native', ctx)).toBe(true);
  });
});

describe('copy_markers_between_sequences', () => {
  const scriptFor = async (args: Record<string, unknown>): Promise<string> => {
    let script = '';
    const bridge = { executeScript: async (s: string) => { script = s; return { success: true }; } };
    await new PremiereProTools(bridge as never).executeTool('copy_markers_between_sequences', args);
    return script;
  };

  it('refuses to copy a sequence onto itself', async () => {
    const s = await scriptFor({ sourceSequenceId: 'A', targetSequenceId: 'B' });
    expect(s).toMatch(/src\.sequenceID===tgt\.sequenceID\)return/);
  });

  it('snapshots the source before writing, so the walk cannot see markers it created', async () => {
    const s = await scriptFor({ sourceSequenceId: 'A', targetSequenceId: 'B' });
    const walk = s.indexOf('getNextMarker');
    const write = s.indexOf('createMarker');
    expect(walk).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(walk);
  });

  it('verifies the copy against the target marker count', async () => {
    const s = await scriptFor({ sourceSequenceId: 'A', targetSequenceId: 'B' });
    expect(s).toContain('(after-before)===snap.length');
  });
});

describe('QE sequence resolution', () => {
  // QE lists sequences in a different order from app.project.sequences (measured on 26.5.2),
  // so pairing the two indices addressed the wrong sequence.
  it('resolves a named QE sequence by guid, not by DOM index', async () => {
    let script = '';
    const bridge = { executeScript: async (s: string) => { script = s; return { success: true }; } };
    await new PremiereProTools(bridge as never).executeTool('get_qe_sequence_props', { sequenceId: 'SEQ-1' });
    expect(script).toContain('__qeSequenceOpening(__d)');
    expect(script).not.toMatch(/return qe\.project\.getSequenceAt\(i\)/);
  });
});

describe('gap closing', () => {
  const scriptFor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    let script = '';
    const bridge = { executeScript: async (s: string) => { script = s; return { success: true }; } };
    await new PremiereProTools(bridge as never).executeTool(name, args);
    return script;
  };

  // close_gap_at used to call a getTimelineGaps() this host lacks and then report a note;
  // close_all_gaps returned success:true having moved nothing.
  it.each(['close_gap_at', 'close_all_gaps'])('%s moves clips and reads them back', async (name) => {
    const s = await scriptFor(name, { timecode: '1' });
    expect(s).not.toContain('getTimelineGaps');
    expect(s).toContain('.move(off)');
    expect(s).toContain('misplaced');
  });
});

describe('gap readers', () => {
  // Sequence.getTimelineGaps() does not exist on 26.5.2; a typeof-guarded call to it made
  // get_sequence_gaps report zero gaps and delivery_qc never flag one.
  it.each(['get_sequence_gaps', 'delivery_qc'])('%s computes gaps from clip ranges', async (name) => {
    let script = '';
    const bridge = { executeScript: async (s: string) => { script = s; return { success: true }; } };
    await new PremiereProTools(bridge as never).executeTool(name, { sequenceId: 'S' });
    expect(script).not.toContain('seq.getTimelineGaps');
    expect(script).toMatch(/__(track|video)Gaps\(/);
  });
});

describe('QE frame export time', () => {
  // QE exportFrame* exports frame 0 for a seconds or ticks string; only a timecode lands on the
  // requested frame (measured against a binary frame-counter clip on 26.5.2).
  const tc = (timebase: string, secs: number): string => {
    const ctx = vm.createContext({});
    vm.runInContext(EXTENDSCRIPT_HELPERS, ctx);
    return vm.runInContext(`__qeTimecode({timebase:${JSON.stringify(timebase)}}, ${secs})`, ctx);
  };

  it('builds a timecode from the sequence frame rate', () => {
    expect(tc('10584000000', 2)).toBe('00;00;02;00'); // 24 fps
    expect(tc('10584000000', 5.5)).toBe('00;00;05;12');
    expect(tc('8475667200', 1)).toBe('00;00;01;00'); // 29.97 -> nominal 30
    expect(tc('10584000000', 3725 + 1 / 24)).toBe('01;02;05;01');
  });

  it.each(['capture_program_output', 'export_frame', 'capture_frame', 'export_thumbnail'])('%s exports by timecode only', async (name) => {
    let script = '';
    const bridge = { executeScript: async (s: string) => { script = s; return { success: false }; } };
    await new PremiereProTools(bridge as never).executeTool(name, { sequenceId: 'S', time: 2, outputPath: '/tmp/x.png' });
    expect(script).toContain('__qeTimecode(');
    expect(script).not.toMatch(/tryExport\(timeNumber|tryFrameExport\(frameTicks|tryFrameExport\(frameSeconds/);
  });
});
