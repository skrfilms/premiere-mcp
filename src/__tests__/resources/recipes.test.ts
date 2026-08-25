/**
 * Recipes: static operating knowledge, and the two ways it could betray an agent.
 *
 *   1. NAMING A TOOL THAT DOES NOT EXIST. A recipe is read specifically so the agent does
 *      NOT have to guess, so a dangling name in one is worse than silence — it burns a
 *      call and teaches the wrong thing. `docs-drift.test.ts` already guards the
 *      instructions resource and the prompt chains this way; recipes get the same scan.
 *   2. TOUCHING THE HOST. A recipe about recovering from a dead engine is worthless if
 *      reading it requires a live engine, so each one must render with a bridge that
 *      throws on any request.
 *
 * The content assertions are deliberately about SPECIFICS, not tone: each recipe is
 * checked for the concrete fact it exists to deliver (the matchNames, the ticks/seconds
 * split, the fatal QE property, the modal-dialog escalation). A recipe that has been
 * reworded into generic advice still passes a "contains some text" test and would fail
 * these.
 */

import { PremiereProResources } from '../../resources/index.js';
import { PremiereProTools } from '../../tools/index.js';
import { TASK_BUNDLES } from '../../tools/profiles.js';

const noBridge = {
  executeScript: async () => {
    throw new Error('recipes must never reach the bridge');
  },
} as any;

const resources = new PremiereProResources(noBridge);
const RECIPE_URIS = PremiereProResources.recipeUris();

function toolNames(): Set<string> {
  return new Set(new PremiereProTools(noBridge).getAvailableTools().map((tool) => tool.name));
}

/**
 * snake_case tokens that appear in recipe prose and are deliberately NOT tool names.
 * Kept short on purpose: the longer this list grows, the weaker the guard, so prefer
 * rewording a recipe over adding an entry.
 */
const NOT_TOOLS = new Set([
  // the premiere://config/get_instructions resource URI
  'get_instructions',
  // ExtendScript / QE identifiers referenced by name
  'setup_ducking_placeholder',
]);

function snakeTokens(text: string): string[] {
  const matches = text.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) || [];
  const unique: Record<string, true> = {};
  for (const token of matches) unique[token] = true;
  return Object.keys(unique).filter((token) => !NOT_TOOLS.has(token));
}

async function read(uri: string): Promise<string> {
  const content = await resources.readResource(uri);
  return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('recipe resources are listed and readable', () => {
  it('every recipe is advertised in the resource list with a description', () => {
    const listed = resources.getAvailableResources();
    for (const uri of RECIPE_URIS) {
      const entry = listed.find((resource) => resource.uri === uri);
      expect(entry).toBeDefined();
      expect(entry!.mimeType).toBe('text/plain');
      expect(entry!.description.length).toBeGreaterThan(40);
      expect(entry!.name.length).toBeGreaterThan(0);
    }
  });

  it('every recipe renders without throwing and without touching the host', async () => {
    for (const uri of RECIPE_URIS) {
      const body = await read(uri);
      expect(typeof body).toBe('string');
      // Long enough to carry a real procedure. A one-liner would mean the recipe was
      // gutted rather than removed, which is the failure this catches.
      expect(body.length).toBeGreaterThan(600);
    }
  });

  it('every other resource still renders or fails honestly', async () => {
    // The live projections must reject through the bridge error, not silently return
    // something plausible. Both outcomes are acceptable; a fabricated value is not.
    const listed = resources.getAvailableResources().map((resource) => resource.uri);
    for (const uri of listed) {
      if (RECIPE_URIS.includes(uri) || uri === 'premiere://config/get_instructions') continue;
      await expect(resources.readResource(uri)).rejects.toThrow();
    }
  });

  it('an unknown recipe-shaped URI is still a clean not-found', async () => {
    await expect(resources.readResource('premiere://recipes/does-not-exist')).rejects.toThrow(
      'not found',
    );
  });
});

describe('recipes name only tools that exist', () => {
  it('no recipe references a nonexistent tool', async () => {
    const names = toolNames();
    const dangling: string[] = [];
    for (const uri of RECIPE_URIS) {
      const body = await read(uri);
      for (const token of snakeTokens(body)) {
        if (!names.has(token)) dangling.push(`${uri}: ${token}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('states no hardcoded tool count anywhere', async () => {
    // Same rule as get_instructions: a published count drifts, and the agent cannot tell.
    for (const uri of RECIPE_URIS) {
      const body = await read(uri);
      expect(body).not.toMatch(/\b\d{3,4}\+?\s+tools\b/);
    }
  });
});

describe('each recipe carries the specific fact it exists for', () => {
  it('first-90-seconds gives an ordered, callable sequence ending in a readback', async () => {
    const body = await read('premiere://recipes/first-90-seconds');
    for (const needle of [
      'ping',
      'verify_premiere_connection',
      'get_capabilities',
      'get_active_sequence',
      'add_marker',
      'list_markers',
      'undo',
    ]) {
      expect(body).toContain(needle);
    }
    // ordered: the mutation must come after orientation, and the readback after the write
    expect(body.indexOf('add_marker')).toBeGreaterThan(body.indexOf('get_active_sequence'));
    expect(body.indexOf('list_markers')).toBeGreaterThan(body.indexOf('add_marker'));
  });

  it('verify-or-refuse distinguishes success from verified and names the per-domain check', async () => {
    const body = await read('premiere://recipes/verify-or-refuse');
    expect(body).toContain('verified:false');
    expect(body).toContain('lumetri_report');
    expect(body).toContain('verify_export');
    expect(body).toContain('capture_program_output');
    // the trap that produced convincing false confirmations
    expect(body.toLowerCase()).toContain('no-op');
  });

  it('effect-match-names carries the verified matchNames and the apply/set pairing', async () => {
    const body = await read('premiere://recipes/effect-match-names');
    for (const needle of [
      'AE.ADBE Opacity',
      'AE.ADBE Motion',
      'AE.ADBE Lumetri',
      'AE.Impact_Blur_FX',
      'apply_effect',
      'set_effect_property',
      'get_effect_properties',
      'list_available_effects',
    ]) {
      expect(body).toContain(needle);
    }
  });

  it('time-units states the ticks/seconds split that made nine tools inert', async () => {
    const body = await read('premiere://recipes/time-units');
    expect(body).toContain('Sequence.end');
    expect(body).toContain('TICKS');
    expect(body).toContain('SECONDS');
    expect(body).toContain('getInPoint');
    // the argument-type rule that silently zeroes an in point
    expect(body).toContain('setInPoint');
    expect(body).toContain('set_sequence_in_out_points');
  });

  it('qe-fragility names a script-fatal property and the try/catch caveat', async () => {
    const body = await read('premiere://recipes/qe-fragility');
    expect(body).toContain('setBorderWidth');
    expect(body).toContain('reversed');
    expect(body).toContain('try/catch');
    expect(body).toContain('set_clip_speed_qe');
  });

  it('recovery-first says plainly that the bridge cannot advance a modal dialog', async () => {
    const body = await read('premiere://recipes/recovery-first');
    expect(body).toContain('create_recovery_checkpoint');
    expect(body).toContain('restore_recovery_checkpoint');
    expect(body).toContain('Escape');
    expect(body).toMatch(/CANNOT ADVANCE A DIALOG/i);
    // the engine-dead signature, and why relaunching the app alone is not enough
    expect(body).toContain('Home screen');
  });

  it('honest-wall gives an alternative for every wall entry and defers to the live report', async () => {
    const body = await read('premiere://recipes/honest-wall');
    expect(body).toContain('api_surface_report');
    expect(body).toContain('Track Matte Key');
    expect(body).toContain('link_audio_video');
    expect(body).toContain('bake_speed_change');
    // Every wall entry must offer a way out. A wall entry with no alternative just moves
    // the dead end, which is the specific way the previous honest-wall text misled: it
    // named `track_matte_setup`, a tool that never existed, as the alternative.
    const entries = body.split('\n- ').slice(1);
    expect(entries.length).toBeGreaterThan(8);
    const withoutRoute = entries
      .filter((entry) => !/Route:/.test(entry))
      .map((entry) => entry.split('\n')[0]);
    expect(withoutRoute).toEqual([]);
  });

  it('task-bundles lists every bundle with its measured cost', async () => {
    const body = await read('premiere://recipes/task-bundles');
    for (const name of Object.keys(TASK_BUNDLES)) {
      expect(body).toContain(name);
    }
    expect(body).toContain('advertised tools');
    expect(body).toContain('find_tool');
    expect(body).toContain('call_tool');
    expect(body).toContain('activate_tools');
    // and it must not pretend a bundle is an authority boundary
    expect(body).toContain('read-only');
  });
});

describe('the always-delivered instructions point at the recipes', () => {
  it('names every recipe URI, so a client that only reads instructions can still find them', async () => {
    const body = await read('premiere://config/get_instructions');
    for (const uri of RECIPE_URIS) {
      expect(body).toContain(uri);
    }
  });
});
