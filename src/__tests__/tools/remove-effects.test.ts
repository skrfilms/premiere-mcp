/**
 * remove_effect / remove_effect_by_name / remove_all_effects — honest removal via QE.
 *
 * Ground truth confirmed against a live 26.3.2 host: DOM effect components expose NO
 * remove()/delete() method (component.reflect.methods is empty), so the old handlers'
 * tryCall(component, ["remove","delete"]) could never have removed anything. The only
 * working removal path is qeClip.removeEffects(), which is all-or-nothing: it strips
 * every user-added effect at once while preserving the intrinsic Motion/Opacity/Volume/
 * Pan AND any Lumetri Color.
 *
 * Consequences these handlers now encode honestly:
 *  - remove_effect can only surgically remove a named effect when it is the SOLE user
 *    effect; with other user effects present it refuses rather than nuke them silently.
 *  - Intrinsic and Lumetri components cannot be removed and are reported as such.
 *  - remove_all_effects verifies by diffing the component list and surfaces any Lumetri
 *    it was forced to leave behind (preservedLumetri).
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

describe('remove_effect family — registration', () => {
  it('all three are expanded tools', () => {
    expect(isExpandedTool('remove_effect')).toBe(true);
    expect(isExpandedTool('remove_effect_by_name')).toBe(true);
    expect(isExpandedTool('remove_all_effects')).toBe(true);
  });
});

describe('remove_effect — generated script', () => {
  it('removes through QE removeEffects and verifies, never DOM remove()/delete()', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'remove_effect', {
      clipId: 'node-1',
      effectName: 'Crop',
    });
    const script = getScript();
    expect(script).toContain('removeEffects');
    // the disproven DOM path must be gone
    expect(script).not.toContain('["remove", "delete"]');
    // verification by re-reading the component list
    expect(script).toContain('verified');
  });

  it('guards the all-or-nothing boundary and the intrinsic/Lumetri cases', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'remove_effect', {
      clipId: 'node-1',
      effectName: 'Crop',
    });
    const script = getScript();
    // refuses when other user effects would also be stripped
    expect(script).toContain('allOrNothing');
    expect(script).toContain('otherUserEffects');
    // intrinsic + Lumetri are named as unremovable
    expect(script).toContain('intrinsic');
    expect(script).toContain('lumetri');
  });

  it('requires an effect name', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'remove_effect', { clipId: 'node-1' });
    const script = getScript();
    expect(script).toContain('requires effectName');
  });

  it('passes a verified removal through unchanged', async () => {
    const payload = {
      success: true,
      tool: 'remove_effect',
      data: { removed: true, changed: true, matchName: 'AE.ADBE Gaussian Blur 2', method: 'qe.removeEffects', verified: true },
    };
    const { bridge } = captureBridge(() => payload);
    const res = await executeExpandedTool(bridge as any, 'remove_effect', { clipId: 'node-1', effectName: 'Gaussian Blur' });
    expect(res).toEqual(payload);
    expect(res.data.verified).toBe(true);
  });
});

describe('remove_all_effects — generated script', () => {
  it('strips user effects via QE, preserves Lumetri, and reports it', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'remove_all_effects', { clipId: 'node-1' });
    const script = getScript();
    expect(script).toContain('removeEffects');
    expect(script).toContain('preservedLumetri');
    // verification by component diff
    expect(script).toContain('stillPresent');
    expect(script).toContain('verified');
    expect(script).not.toContain('["remove", "delete"]');
  });

  it('requires a clip id', async () => {
    const { bridge, getScript } = captureBridge();
    await executeExpandedTool(bridge as any, 'remove_all_effects', {});
    const script = getScript();
    expect(script).toContain('requires clipId');
  });
});
