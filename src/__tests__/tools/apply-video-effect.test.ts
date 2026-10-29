/**
 * apply_video_effect — verified effect-add with identity guard.
 *
 * The reliability story this tool exists to tell: qe.project.getVideoEffectByName()
 * resolves by DISPLAY name only, so on a machine with third-party plugins a stock
 * name like "Gaussian Blur" can silently resolve to a plugin's effect
 * (AE.Impact_Blur_FX) instead of Adobe's AE.ADBE Gaussian Blur 2. This tool adds
 * through QE, diffs the clip's component list before/after to learn the matchName
 * that ACTUALLY landed, and — when the caller passes expected_match_name — refuses
 * a mismatch and rolls the add back when that is safe (removeEffects strips every
 * user effect at once, so rollback is only clean when our add was the sole one).
 *
 * The mechanism was confirmed against a live 26.3.2 host: addVideoEffect grew the
 * DOM component count and the diff surfaced AE.Impact_Blur_FX for "Gaussian Blur";
 * removeEffects() then stripped exactly the added user effect while leaving the
 * intrinsic Motion/Opacity and Lumetri components in place.
 *
 * These assertions pin the generated script without a host; generated-script-syntax
 * separately parses every emitted script as ES3.
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

describe('apply_video_effect — registration', () => {
  it('is an expanded tool', () => {
    expect(isExpandedTool('apply_video_effect')).toBe(true);
  });
});

describe('apply_video_effect — generated script', () => {
  it('resolves by display name, adds through QE, and diffs to verify', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'apply_video_effect', {
      effect_name: 'Gaussian Blur',
      clip_name: 'shot_01',
    });
    const script = getScript();
    expect(script).toContain('getVideoEffectByName');
    expect(script).toContain('addVideoEffect');
    // guid-matched sequence + time-matched QE clip, never the on-screen one
    expect(script).toContain('qeSequenceFor');
    expect(script).toContain('__findQeClipByDomClip');
    // verification by component diff, and the actual matchName is surfaced
    expect(script).toContain('matchName');
    expect(script).toContain('addedComponent');
    // caller args are embedded
    expect(script).toContain('"effect_name":"Gaussian Blur"');
    expect(script).toContain('"clip_name":"shot_01"');
  });

  it('guards on a missing effect_name in-engine, before any add', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'apply_video_effect', {});
    const script = getScript();
    expect(script).toContain('effect_name is required');
    expect(script.indexOf('effect_name is required')).toBeLessThan(
      script.indexOf('aveQeClip.addVideoEffect(aveFx)'),
    );
  });

  it('wires the identity guard and safe rollback when expected_match_name is given', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'apply_video_effect', {
      effect_name: 'Gaussian Blur',
      clip_name: 'shot_01',
      expected_match_name: 'AE.ADBE Gaussian Blur 2',
    });
    const script = getScript();
    expect(script).toContain('"expected_match_name":"AE.ADBE Gaussian Blur 2"');
    expect(script).toContain('identityMismatch');
    // rollback via removeEffects, gated on the clip having no other user effects
    expect(script).toContain('removeEffects');
    expect(script).toContain('aveUserEffectsBefore');
  });

  it('passes a verified apply through unchanged', async () => {
    const payload = {
      success: true,
      tool: 'apply_video_effect',
      data: {
        requestedEffectName: 'Gaussian Blur',
        addedComponent: {
          displayName: 'Gaussian Blur',
          matchName: 'AE.ADBE Gaussian Blur 2',
          componentIndex: 3,
        },
        identityConfidence: 'unique',
        verified: true,
      },
    };
    const { bridge } = captureBridge(() => payload);
    const res = await executeExpandedTool(bridge as any, 'apply_video_effect', {
      effect_name: 'Gaussian Blur',
      clip_name: 'shot_01',
    });
    expect(res).toEqual(payload);
    expect(res.data.verified).toBe(true);
  });

  it('passes an identity-mismatch failure through unchanged', async () => {
    const fail = {
      success: false,
      tool: 'apply_video_effect',
      error:
        "Requested 'Gaussian Blur' resolved to matchName 'AE.Impact_Blur_FX', not the expected 'AE.ADBE Gaussian Blur 2'.",
      data: { identityMismatch: true, actualMatchName: 'AE.Impact_Blur_FX', rolledBack: true },
    };
    const { bridge } = captureBridge(() => fail);
    const res = await executeExpandedTool(bridge as any, 'apply_video_effect', {
      effect_name: 'Gaussian Blur',
      clip_name: 'shot_01',
      expected_match_name: 'AE.ADBE Gaussian Blur 2',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/does not match|not the expected/);
  });
});
