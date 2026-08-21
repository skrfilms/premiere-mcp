/**
 * Lumetri preset + timeline render-status tools.
 *
 * These three wrap engine surfaces that ExtendScript's reflection could see but
 * the catalogue never exposed: getAllLumetriPresetsList / applyLumetriPreset and
 * the QE render-bar getters. The behaviour that matters and that this side can
 * pin without a host: the generated script targets the right engine calls,
 * validates the preset against the real list before applying, verifies the
 * mutation instead of trusting applyLumetriPreset's always-true return, addresses
 * the sequence by guid (never blindly the on-screen one), and threads the
 * caller's arguments through. The generated-script-syntax sweep separately parses
 * every emitted script as ES3.
 *
 * The apply/read semantics themselves were confirmed against a live 26.x host:
 *   applyLumetriPreset("Cinespace 100") on a selected clip -> gains "Lumetri
 *   Color"; a second preset changes the property-value checksum (verified).
 */

import { executeExpandedTool, isExpandedTool } from '../../tools/expanded';

function captureBridge(respond: (script: string) => any = () => ({ success: true, data: {} })) {
  let script = '';
  const bridge = {
    executeScript: async (source: string) => {
      script = source;
      return respond(source);
    },
  };
  return { bridge, getScript: () => script };
}

describe('lumetri + render-status — registration', () => {
  it.each(['list_lumetri_presets', 'apply_lumetri_preset', 'get_timeline_render_status'])(
    '%s is an expanded tool',
    (name) => {
      expect(isExpandedTool(name)).toBe(true);
    },
  );
});

describe('list_lumetri_presets — generated script', () => {
  it('reads the engine preset list and threads the filter', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'list_lumetri_presets', { name_filter: 'cinespace' });
    const script = getScript();
    expect(script).toContain('getAllLumetriPresetsList');
    expect(script).toContain('"name_filter":"cinespace"');
  });

  it('passes the host preset payload through verbatim', async () => {
    const payload = {
      success: true,
      tool: 'list_lumetri_presets',
      data: { count: 2, totalAvailable: 325, presets: ['Cinespace 100', 'Cinespace 25'] },
    };
    const { bridge } = captureBridge(() => payload);
    const res = await executeExpandedTool(bridge as any, 'list_lumetri_presets', {});
    expect(res).toEqual(payload);
  });
});

describe('apply_lumetri_preset — generated script', () => {
  it('validates against the real list, applies, and fingerprint-verifies', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'apply_lumetri_preset', {
      preset_name: 'Cinespace 100',
      clip_name: 'shot_01',
    });
    const script = getScript();
    // guarded against a bogus name before it ever mutates
    expect(script).toContain('getAllLumetriPresetsList');
    expect(script).toContain('applyLumetriPreset');
    // verification, not blind trust in the always-true return
    expect(script).toContain('lpFingerprint');
    expect(script).toContain('Lumetri');
    expect(script).toContain('checksum');
    // caller args are embedded
    expect(script).toContain('"preset_name":"Cinespace 100"');
    expect(script).toContain('"clip_name":"shot_01"');
  });

  it('guards on a missing preset_name in-engine, before any mutation', async () => {
    // The guard runs host-side (zod validation is applied a layer up, not in
    // executeExpandedTool), so pin it in the emitted script: the required-arg
    // refusal is present and sits ahead of the applyLumetriPreset call.
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'apply_lumetri_preset', {});
    const script = getScript();
    expect(script).toContain('preset_name is required');
    expect(script.indexOf('preset_name is required')).toBeLessThan(
      script.indexOf('app.project.applyLumetriPreset(canonicalPreset)'),
    );
  });

  it('reports a verified apply through unchanged', async () => {
    const payload = {
      success: true,
      tool: 'apply_lumetri_preset',
      data: {
        preset: 'Cinespace 100',
        verified: true,
        clipsAffected: 1,
        clips: [{ name: 'shot_01', gainedLumetri: true, valuesChanged: false, verified: true }],
      },
    };
    const { bridge } = captureBridge(() => payload);
    const res = await executeExpandedTool(bridge as any, 'apply_lumetri_preset', {
      preset_name: 'Cinespace 100',
    });
    expect(res).toEqual(payload);
    expect(res.data.verified).toBe(true);
  });

  it('passes an unverifiable-apply failure through unchanged', async () => {
    const fail = {
      success: false,
      tool: 'apply_lumetri_preset',
      error: 'Preset applied but the change could not be verified on every target clip',
    };
    const { bridge } = captureBridge(() => fail);
    const res = await executeExpandedTool(bridge as any, 'apply_lumetri_preset', {
      preset_name: 'Cinespace 100',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not be verified/);
  });
});

describe('get_timeline_render_status — generated script', () => {
  it('reads all four QE bar getters and addresses the sequence by guid', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'get_timeline_render_status', {});
    const script = getScript();
    expect(script).toContain('getGreenBarTimes');
    expect(script).toContain('getYellowBarTimes');
    expect(script).toContain('getRedBarTimes');
    expect(script).toContain('getEmptyBarTimes');
    // guid-matched resolver, not the blindly-active sequence
    expect(script).toContain('qeSequenceFor');
  });

  it('threads a supplied sequenceId into the embedded args', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'get_timeline_render_status', {
      sequenceId: 'abc-123',
    });
    expect(getScript()).toContain('"sequenceId":"abc-123"');
  });

  it('passes the host render-status payload through verbatim', async () => {
    const payload = {
      success: true,
      tool: 'get_timeline_render_status',
      data: {
        sequence: { name: 'cut', id: 'abc-123' },
        green: { available: true, segmentCount: 13, totalSeconds: 120, segments: [] },
        red: { available: true, segmentCount: 0, totalSeconds: 0, segments: [] },
        renderedFraction: 0.9,
        fullyRendered: false,
      },
    };
    const { bridge } = captureBridge(() => payload);
    const res = await executeExpandedTool(bridge as any, 'get_timeline_render_status', {});
    expect(res).toEqual(payload);
  });
});
