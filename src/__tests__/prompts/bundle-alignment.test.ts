/**
 * Prompts must be followable, and following one must end in a verified claim.
 *
 * Three failures this suite exists to prevent, all of them cheap to reintroduce:
 *
 *   1. A PROMPT WHOSE FIRST STEP DOES NOT FIT ITS BUNDLE. Every workflow declares the task
 *      bundle it was composed against. If step one names a tool that bundle does not
 *      advertise, an agent following the prompt is forced into a profile switch or a
 *      `call_tool` detour on its very first call — the same defect as a bundle that can
 *      apply an effect but not set its property.
 *   2. A PROMPT THAT DESCRIBES ONLY THE HAPPY PATH. The observed default behaviour when a
 *      call stalls is retry-then-report-success, which is precisely the lie this server is
 *      built to refuse. Every rendered prompt must carry the three failure branches:
 *      verified:false, a modal dialog the bridge cannot advance, and a dead engine.
 *   3. A PROMPT THAT POINTS AT A RESOURCE THAT IS NOT THERE. Recipe URIs are asserted
 *      against the live resource list, not spell-checked by eye.
 *
 * Tool-name existence across all prompt chains is already covered by
 * `tools/docs-drift.test.ts`; this suite is about the chain being *runnable*.
 */

import { PremiereProPrompts, workflowSpecs } from '../../prompts/index.js';
import { PremiereProResources } from '../../resources/index.js';
import { PremiereProTools } from '../../tools/index.js';
import { PROFILES, TASK_BUNDLES, applyProfile } from '../../tools/profiles.js';

const noBridge = {
  executeScript: async () => {
    throw new Error('prompt rendering must not touch the bridge');
  },
} as any;

const prompts = new PremiereProPrompts();
const ALL = new PremiereProTools(noBridge).getAvailableTools();
const RESOURCE_URIS = new Set(
  new PremiereProResources(noBridge).getAvailableResources().map((resource) => resource.uri),
);

function advertised(profile: string): Set<string> {
  return new Set(applyProfile(ALL, { PREMIERE_MCP_PROFILE: profile }).map((tool) => tool.name));
}

async function render(name: string): Promise<string> {
  const generated = await prompts.getPrompt(name, {});
  return generated.messages.map((message) => message.content.text).join('\n');
}

describe('every prompt renders', () => {
  it('renders with no arguments at all, without throwing', async () => {
    for (const listed of prompts.getAvailablePrompts()) {
      const generated = await prompts.getPrompt(listed.name, {});
      expect(generated.description.length).toBeGreaterThan(0);
      expect(generated.messages.length).toBeGreaterThan(1);
      for (const message of generated.messages) {
        expect(message.content.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('renders with its declared arguments supplied', async () => {
    // A required argument that the renderer ignores is a prompt that quietly loses the
    // caller's intent, so exercise the substitution path too.
    for (const listed of prompts.getAvailablePrompts()) {
      const args: Record<string, string> = {};
      for (const argument of listed.arguments || []) args[argument.name] = `VALUE_${argument.name}`;
      const generated = await prompts.getPrompt(listed.name, args);
      const body = generated.messages.map((message) => message.content.text).join('\n');
      for (const argument of listed.arguments || []) {
        if (argument.required) expect(body).toContain(`VALUE_${argument.name}`);
      }
    }
  });

  it('an unknown prompt name is a clean error, not an empty prompt', async () => {
    await expect(prompts.getPrompt('not_a_prompt', {})).rejects.toThrow("not found");
  });
});

describe('prompt-to-bundle alignment', () => {
  it('every declared bundle exists as a profile', () => {
    for (const workflow of workflowSpecs()) {
      if (!workflow.bundle) continue;
      expect(Object.keys(PROFILES)).toContain(workflow.bundle);
    }
  });

  it("every prompt's opening step is fully covered by its bundle", () => {
    const gaps: string[] = [];
    for (const workflow of workflowSpecs()) {
      if (!workflow.bundle) continue;
      const names = advertised(workflow.bundle);
      const first = workflow.steps[0];
      if (!first) continue;
      for (const tool of first.tools) {
        if (!names.has(tool)) gaps.push(`${workflow.name} (${workflow.bundle}): ${tool}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('every task bundle is reachable from at least one prompt', () => {
    // A bundle nobody is told to use is a bundle nobody uses. This is the link between
    // the two surfaces: the prompt names the bundle, the bundle covers the prompt.
    const claimed = new Set(workflowSpecs().map((workflow) => workflow.bundle).filter(Boolean));
    for (const bundle of Object.keys(TASK_BUNDLES)) {
      expect(Array.from(claimed)).toContain(bundle);
    }
  });

  it('a prompt without a bundle says so instead of leaving the agent to guess', async () => {
    for (const workflow of workflowSpecs()) {
      const body = await render(workflow.name);
      if (workflow.bundle) {
        expect(body).toContain(`PREMIERE_MCP_PROFILE=${workflow.bundle}`);
      } else {
        expect(body).toContain('No single tool bundle covers this workflow');
      }
    }
  });
});

describe('every prompt carries the failure paths', () => {
  it('names the verified:false branch, the modal dialog, and the dead engine', async () => {
    for (const listed of prompts.getAvailablePrompts()) {
      const body = await render(listed.name);
      expect(body).toContain('verified:false');
      // the modal case: the bridge cannot advance a dialog and a human must press Escape
      expect(body).toContain('Escape');
      expect(body).toMatch(/modal dialog/i);
      // the dead-engine case, distinguished from a dead panel
      expect(body).toContain('verify_premiere_connection');
      expect(body).toMatch(/relaunch/i);
      // and the rule that a retry is not the fix
      expect(body).toMatch(/no-op again|do not simply re-call/i);
    }
  });

  it('requires the agent to report the evidence rather than the call', async () => {
    for (const listed of prompts.getAvailablePrompts()) {
      const body = await render(listed.name);
      expect(body).toMatch(/read back|readback/i);
      expect(body).toMatch(/Do not summarize an unverified edit as done/i);
    }
  });

  it('offers a rollback in the same breath as the failure', async () => {
    for (const listed of prompts.getAvailablePrompts()) {
      const body = await render(listed.name);
      expect(body).toMatch(/undo|restore_recovery_checkpoint/);
    }
  });
});

describe('prompts point only at resources that exist', () => {
  it('every recipe URI named by a prompt is a real resource', async () => {
    const dangling: string[] = [];
    for (const listed of prompts.getAvailablePrompts()) {
      const body = await render(listed.name);
      const uris = body.match(/premiere:\/\/[a-z0-9/_-]+/g) || [];
      for (const uri of uris) {
        if (!RESOURCE_URIS.has(uri)) dangling.push(`${listed.name}: ${uri}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('every workflow that declares recipes declares existing ones', () => {
    const dangling: string[] = [];
    for (const workflow of workflowSpecs()) {
      for (const uri of workflow.recipes || []) {
        if (!RESOURCE_URIS.has(uri)) dangling.push(`${workflow.name}: ${uri}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});

describe('the onboarding and recovery prompts exist and do their specific job', () => {
  it('first_verified_edit ends in a readback and an undo', async () => {
    const body = await render('first_verified_edit');
    expect(body).toContain('add_marker');
    expect(body).toContain('list_markers');
    expect(body.indexOf('list_markers')).toBeGreaterThan(body.indexOf('add_marker'));
    expect(body).toMatch(/delete_marker|undo/);
    expect(body).toContain('ping');
  });

  it('recover_from_failure checks independently before it retries anything', async () => {
    const body = await render('recover_from_failure');
    expect(body).toMatch(/INDEPENDENTLY|independently/);
    expect(body).toContain('restore_recovery_checkpoint');
    expect(body).toContain('assert_clips_unchanged');
    // a refusal from the router is a boundary, not a failure to work around
    expect(body).toMatch(/refusal is not a failure/i);
  });
});
