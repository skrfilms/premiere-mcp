/**
 * Drift guards: nothing agent-facing may name a tool that does not exist.
 *
 * Why this suite exists. A feature-level competitive survey (2026-08-24) found that our
 * agent-facing text had silently drifted from the catalogue in four separate places:
 *
 *   - `get_instructions` recommended `export_with_custom_preset` and `track_matte_setup`.
 *     Neither has ever existed. The second was offered as the *alternative* in the
 *     "what this server CANNOT do" section — so the honest-wall section, the one part of
 *     the server whose entire job is to not mislead, pointed at a tool that is not there.
 *   - README claimed 309 tools, `get_instructions` claimed 600, `package.json` claimed
 *     283+. The real number was 637. Three different wrong answers to one question.
 *
 * A stale number or a dangling tool name is exactly the class of failure this project
 * calls a lie: the agent cannot detect it, and it burns a call to find out. Our closest
 * rival generates its published action list from the live registration surface and fails
 * CI when the doc drifts (`leancoderkavy/premiere-pro-mcp`, `scripts/generate-supported-actions.mjs --check`).
 * This is our equivalent, as tests rather than a generator.
 *
 * These are cheap, pure assertions — no bridge, no host, no Premiere.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';
import { PremiereProResources } from '../../resources/index.js';
import { PremiereProPrompts, referencedToolNames } from '../../prompts/index.js';
import { annotationsFor } from '../../tools/annotations.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** A stub transport: these assertions must never reach a host. */
const noBridge = {
  executeScript: async () => {
    throw new Error('docs-drift tests must not touch the bridge');
  },
} as any;

function toolNames(): Set<string> {
  return new Set(new PremiereProTools(noBridge).getAvailableTools().map((tool) => tool.name));
}

/**
 * snake_case tokens that appear in agent-facing prose but are deliberately NOT tools:
 * argument names, bridge command types, ExtendScript members, env vars.
 */
const NOT_TOOLS = new Set([
  'expected_match_name',
  'cep_js',
  'match_name',
  'node_id',
  'sequence_id',
  'project_item_id',
  'output_path',
  'preset_path',
  'clip_plan',
  'import_ae_comps',
  // the premiere://config/get_instructions resource URI, not a tool
  'get_instructions',
]);

/** Extract snake_case identifiers (two or more underscore-joined lowercase words). */
function snakeTokens(text: string): string[] {
  const matches = text.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) || [];
  const unique: Record<string, true> = {};
  for (const token of matches) unique[token] = true;
  return Object.keys(unique).filter((token) => !NOT_TOOLS.has(token));
}

describe('agent-facing text names only tools that exist', () => {
  it('get_instructions references no nonexistent tool', async () => {
    const resources = new PremiereProResources(noBridge);
    const text = await resources.readResource('premiere://config/get_instructions');
    const body = typeof text === 'string' ? text : JSON.stringify(text);
    const names = toolNames();

    // Every snake_case token in the instructions is either a known tool or explicitly
    // listed as a non-tool above. A new dangling name fails here with its own name in
    // the message, which is the whole point.
    const dangling = snakeTokens(body).filter((token) => !names.has(token));
    expect(dangling).toEqual([]);
  });

  it('get_instructions actually points at the composite tools we ship', async () => {
    // Regression: our rewrite of getInstructions dropped upstream's guidance to prefer
    // assemble_product_spot / clipPlan over hand-placing clips, so the resource hid a
    // capability we have. Assert the guidance is present, not just that names resolve.
    const resources = new PremiereProResources(noBridge);
    const text = await resources.readResource('premiere://config/get_instructions');
    const body = typeof text === 'string' ? text : JSON.stringify(text);
    for (const needle of [
      'assemble_product_spot',
      'build_brand_spot_from_mogrt_and_assets',
      'clipPlan',
      'add_to_timeline_batch',
      'find_tool',
    ]) {
      expect(body).toContain(needle);
    }
  });

  it('every tool named by an MCP prompt chain exists', () => {
    const names = toolNames();
    const dangling = referencedToolNames().filter((tool) => !names.has(tool));
    expect(dangling).toEqual([]);
  });

  it('prompt cautions name no nonexistent tool', async () => {
    const prompts = new PremiereProPrompts();
    const names = toolNames();
    const dangling: string[] = [];
    for (const listed of prompts.getAvailablePrompts()) {
      const generated = await prompts.getPrompt(listed.name, {});
      const body = generated.messages.map((message) => message.content.text).join('\n');
      for (const token of snakeTokens(body)) {
        if (!names.has(token)) dangling.push(`${listed.name}: ${token}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});

describe('published tool counts match the catalogue', () => {
  const actual = () => new PremiereProTools(noBridge).getAvailableTools().length;

  it('README states the real tool count everywhere it states one', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const count = actual();
    // Any "`NNN` ... tools" style claim in the README must be the real number. Catching
    // the wrong ones matters more than finding every phrasing, so assert both
    // directions: the real number appears, and no other 3-digit count is claimed.
    expect(readme).toContain(`\`${count}\``);
    const claimed = (
      readme.match(/`(\d{3})`\s*(?:MCP\s+)?(?:active\s+)?(?:advertised\s+)?tools?/g) || []
    ).map((match) => Number((match.match(/\d{3}/) || ['0'])[0]));
    for (const value of claimed) expect(value).toBe(count);
  });

  it('package.json description states the real tool count', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const claimed = /(\d{3,4})\+?\s+tools/.exec(String(pkg.description || ''));
    expect(claimed).not.toBeNull();
    expect(Number(claimed![1])).toBe(actual());
  });

  it('get_instructions hardcodes no tool count at all', async () => {
    // The drift-proof fix is to state no number and defer to get_capabilities, which
    // computes it. Assert the number never comes back.
    const resources = new PremiereProResources(noBridge);
    const text = await resources.readResource('premiere://config/get_instructions');
    const body = typeof text === 'string' ? text : JSON.stringify(text);
    expect(body).not.toMatch(/\b\d{3,4}\+?\s+tools\b/);
    expect(body).toContain('get_capabilities');
  });
});

describe('MCP tool annotations', () => {
  it('covers every exposed tool and never contradicts itself', () => {
    const tools = new PremiereProTools(noBridge).getAvailableTools();
    for (const tool of tools) {
      const hints = annotationsFor(tool.name);
      expect(typeof hints.title).toBe('string');
      expect(hints.title.length).toBeGreaterThan(0);
      // destructiveHint is only meaningful when the tool is not read-only; a tool that
      // claims both is self-contradictory and would mislead a client's approval logic.
      if (hints.readOnlyHint) expect(hints.destructiveHint).toBe(false);
    }
  });

  it('classifies the obvious cases correctly', () => {
    expect(annotationsFor('get_project_info').readOnlyHint).toBe(true);
    expect(annotationsFor('delete_sequence').readOnlyHint).toBe(false);
    expect(annotationsFor('delete_sequence').destructiveHint).toBe(true);
    expect(annotationsFor('execute_extendscript').openWorldHint).toBe(true);
    expect(annotationsFor('export_sequence').openWorldHint).toBe(true);
    // find_tool ranks this server's own in-memory catalogue: a closed-world read.
    expect(annotationsFor('find_tool').readOnlyHint).toBe(true);
    expect(annotationsFor('find_tool').openWorldHint).toBe(false);
  });

  it('does not mark object-creating tools idempotent', () => {
    // Calling add_marker twice yields two markers, so a client must not treat a retry
    // as free. set_* is the opposite: re-applying the same value is a no-op.
    expect(annotationsFor('add_marker').idempotentHint).toBe(false);
    expect(annotationsFor('create_bin').idempotentHint).toBe(false);
    expect(annotationsFor('set_clip_opacity').idempotentHint).toBe(true);
  });
});
