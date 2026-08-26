/**
 * Task bundles: does each one actually get its job done on its own?
 *
 * A bundle is a promise to an agent: "select this and the task you were asked to do is
 * covered". Two ways that promise breaks, and both have already happened here:
 *
 *   1. A TYPO. `resolveProfile` reports patterns that match no tool in `unknown`, and a
 *      misspelled bundle entry is a silently smaller bundle — the agent never learns the
 *      tool was meant to be there. Asserted to be empty for every named profile.
 *   2. A MISSING HALF OF A PAIR. `apply_effect` shipped in `core` without
 *      `set_effect_property`: an agent could add Gaussian Blur and then had no way to set
 *      its blurriness, so the first useful call forced a profile switch. That class of
 *      defect is encoded as `BUNDLE_REQUIREMENTS` in profiles.ts and enforced here across
 *      EVERY profile, not just the new ones, because the rule is about coherence rather
 *      than about which bundle happens to be under review.
 *
 * The budget assertions exist for a third reason: the whole argument for curation is a
 * measured context cost, and a measured number that nothing re-measures is just a claim.
 * Tool counts are asserted exactly; the token figure is a chars/4 ESTIMATE and gets a
 * tolerance, because a sibling rewording one tool's description legitimately moves it.
 *
 * Pure: no bridge, no host, no Premiere.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';
import {
  ALWAYS_KEPT,
  BUNDLE_BUDGETS,
  BUNDLE_BUDGET_TOLERANCE,
  BUNDLE_REQUIREMENTS,
  PROFILES,
  TASK_BUNDLES,
  applyProfile,
  resolveProfile,
} from '../../tools/profiles.js';
import { classifySelection } from '../../tools/router.js';

const noBridge = {
  executeScript: async () => {
    throw new Error('bundle tests must not touch the bridge');
  },
} as any;

const tools = new PremiereProTools(noBridge);
/** setup-env.ts pins PREMIERE_MCP_PROFILE=all, so this is the whole catalogue. */
const ALL = tools.getAvailableTools();
const ALL_NAMES = ALL.map((tool) => tool.name);

/** The advertised list an agent would actually be handed under `profile`. */
function advertised(profile: string): Set<string> {
  return new Set(applyProfile(ALL, { PREMIERE_MCP_PROFILE: profile }).map((tool) => tool.name));
}

const BUNDLE_NAMES = Object.keys(TASK_BUNDLES);

/** The four reads every MCP prompt in this build opens with. */
const ORIENT = [
  'verify_premiere_connection',
  'get_project_info',
  'list_sequences',
  'get_active_sequence',
];

describe('task bundles exist and are spelled correctly', () => {
  it('ships at least the five task shapes an editor asks for', () => {
    // Named rather than counted: the point is the SHAPE of the menu, and a count would
    // drift while telling us nothing about coverage.
    for (const expected of [
      'task-orient',
      'task-rough-cut',
      'task-cut-dialogue',
      'task-caption',
      'task-grade',
      'task-motion',
      'task-conform-deliver',
    ]) {
      expect(BUNDLE_NAMES).toContain(expected);
      expect(PROFILES[expected]).toBeDefined();
    }
  });

  it('every bundle entry names a real tool — no typos', () => {
    const typos: string[] = [];
    for (const [name, patterns] of Object.entries(TASK_BUNDLES)) {
      const resolution = resolveProfile(ALL_NAMES, { PREMIERE_MCP_PROFILE: name });
      for (const unknown of resolution.unknown) typos.push(`${name}: ${unknown}`);
      // Bundles use exact names on purpose: a glob makes the size and the measured cost
      // a function of the catalogue instead of a decision.
      for (const pattern of patterns) {
        if (pattern.endsWith('*')) typos.push(`${name}: glob '${pattern}' is not allowed in a bundle`);
      }
    }
    expect(typos).toEqual([]);
  });

  it('no named profile anywhere references a tool that does not exist', () => {
    // Same guard applied to the size-shaped profiles, since a rename lands there too.
    const dangling: string[] = [];
    for (const name of Object.keys(PROFILES)) {
      const resolution = resolveProfile(ALL_NAMES, { PREMIERE_MCP_PROFILE: name });
      for (const unknown of resolution.unknown) dangling.push(`${name}: ${unknown}`);
    }
    expect(dangling).toEqual([]);
  });

  it('every bundle resolves to a non-empty advertised list', () => {
    for (const name of BUNDLE_NAMES) {
      expect(advertised(name).size).toBeGreaterThan(ALWAYS_KEPT.length);
    }
  });
});

describe('every bundle is self-sufficient for its task', () => {
  it('satisfies every pairing rule in BUNDLE_REQUIREMENTS, under every profile', () => {
    const violations: string[] = [];
    for (const profile of Object.keys(PROFILES)) {
      const names = advertised(profile);
      for (const rule of BUNDLE_REQUIREMENTS) {
        if (!names.has(rule.needs)) continue;
        for (const dependency of rule.alsoNeeds) {
          if (!names.has(dependency)) {
            violations.push(`${profile}: has ${rule.needs} but not ${dependency} — ${rule.why}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the effect bundle can both apply an effect AND set its property', () => {
    // The specific pairing that shipped broken, asserted by name so the regression has a
    // test that reads like the bug report.
    const motion = advertised('task-motion');
    expect(motion.has('apply_effect')).toBe(true);
    expect(motion.has('set_effect_property')).toBe(true);
    expect(motion.has('get_effect_properties')).toBe(true);
  });

  it('the keyframe bundle can both add a keyframe AND ease it', () => {
    const motion = advertised('task-motion');
    expect(motion.has('add_keyframe')).toBe(true);
    expect(motion.has('bake_keyframe_ease')).toBe(true);
    expect(motion.has('set_keyframe_interpolation')).toBe(true);
    expect(motion.has('get_keyframes')).toBe(true);
  });

  it('every bundle can complete the orientation step without a profile switch', () => {
    const missing: string[] = [];
    for (const name of BUNDLE_NAMES) {
      const names = advertised(name);
      for (const tool of ORIENT) {
        if (!names.has(tool)) missing.push(`${name}: ${tool}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every bundle carries at least one verification tool and an undo path', () => {
    // A bundle that can mutate but not prove anything is the failure mode this whole
    // server is built against, so it is an invariant rather than a review comment.
    const verifiers = [
      'lint_timeline', 'capture_program_output', 'verify_export', 'verify_color_grade',
      'verify_effect_rendered', 'verify_clip_visible', 'verify_media_online',
      'lumetri_report', 'get_effect_properties', 'get_keyframes', 'list_markers',
      'read_sequence_captions', 'validate_srt', 'assert_clips_unchanged',
      'get_timeline_gaps',
    ];
    for (const name of BUNDLE_NAMES) {
      const names = advertised(name);
      expect(verifiers.some((tool) => names.has(tool))).toBe(true);
      expect(names.has('undo')).toBe(true);
    }
  });

  it('a bundle that offers a checkpoint also offers the way back', () => {
    for (const name of BUNDLE_NAMES) {
      const names = advertised(name);
      if (!names.has('create_recovery_checkpoint')) continue;
      expect(names.has('restore_recovery_checkpoint')).toBe(true);
      expect(names.has('list_recovery_checkpoints')).toBe(true);
    }
  });

  it('no bundle recommends a tool that is known-broken on the verified host build', () => {
    // These are still in the catalogue and still reachable through call_tool. They are
    // simply not what a fresh agent should be handed as a recommendation: each one is
    // recorded as failing or hazardous on 26.3.2 during live host verification.
    const knownBad = [
      'audio_crossfade_at_cut', // "Invalid parameter"
      'apply_morph_cut', // "Invalid parameter"
      'set_sequence_field_type', // "Illegal Parameter type"
      'version_up_sequence', // "Illegal Parameter type"
      'match_shot_color', // suspected engine killer, never cleared
      'set_clip_reverse', // QE call is fatal to the script
      'set_clip_border_width',
      'set_clip_border_color',
      'set_work_area', // accepted and inert on this build
      'set_poster_frame', // no setter exists
    ];
    const offenders: string[] = [];
    for (const [name, patterns] of Object.entries(TASK_BUNDLES)) {
      for (const tool of patterns) {
        if (knownBad.includes(tool)) offenders.push(`${name}: ${tool}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('bundle context cost stays measured', () => {
  it('documents a budget for every task bundle', () => {
    for (const name of BUNDLE_NAMES) {
      expect(BUNDLE_BUDGETS[name]).toBeDefined();
    }
  });

  it('the documented tool count is the real one', () => {
    const drift: string[] = [];
    for (const [name, budget] of Object.entries(BUNDLE_BUDGETS)) {
      const actual = advertised(name).size;
      if (actual !== budget.tools) drift.push(`${name}: documented ${budget.tools}, actual ${actual}`);
    }
    // A failure here is not a bug, it is a stale number: re-measure and update
    // BUNDLE_BUDGETS. Publishing an unchecked figure is the drift this project treats as
    // a lie the agent cannot detect.
    expect(drift).toEqual([]);
  });

  it('the documented token estimate is still within tolerance', () => {
    const drift: string[] = [];
    for (const [name, budget] of Object.entries(BUNDLE_BUDGETS)) {
      const exposed = applyProfile(ALL, { PREMIERE_MCP_PROFILE: name });
      const measured = tools.measureCatalogueCost(exposed).approxTokens;
      const allowed = budget.approxTokens * BUNDLE_BUDGET_TOLERANCE;
      if (Math.abs(measured - budget.approxTokens) > allowed) {
        drift.push(`${name}: documented ~${budget.approxTokens}, measured ${measured}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('every task bundle stays inside published tool-selection guidance', () => {
    // Anthropic reports selection accuracy degrading past ~50 tools and VS Code/Copilot
    // hard-errors above 128. A task bundle that broke either would defeat its own purpose.
    const oversized: string[] = [];
    for (const name of BUNDLE_NAMES) {
      const exposed = applyProfile(ALL, { PREMIERE_MCP_PROFILE: name });
      const cost = tools.measureCatalogueCost(exposed);
      if (cost.exceedsSelectionDegradationThreshold || cost.exceedsCopilotToolLimit) {
        oversized.push(`${name}: ${exposed.length} tools`);
      }
      // and each should be a small slice of a context window, not a third of one
      expect(cost.percentOfReferenceContext).toBeLessThan(8);
    }
    expect(oversized).toEqual([]);
  });

  it('the published table in docs/AGENT-ERGONOMICS.md matches the measured budgets', () => {
    // The doc exists to be read by a human choosing a bundle, which makes a stale figure in
    // it the same class of problem as a stale count in the README: nobody reading it can
    // tell. Parsed rather than eyeballed.
    const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'AGENT-ERGONOMICS.md'), 'utf8');
    const rows = new Map<string, { tools: number; approxTokens: number }>();
    for (const line of doc.split('\n')) {
      const match = /^\|\s*`([a-z-]+)`\s*\|[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/.exec(line);
      if (match) rows.set(match[1]!, { tools: Number(match[2]), approxTokens: Number(match[3]) });
    }
    const drift: string[] = [];
    for (const [name, budget] of Object.entries(BUNDLE_BUDGETS)) {
      const row = rows.get(name);
      if (!row) {
        drift.push(`${name}: missing from the doc table`);
        continue;
      }
      if (row.tools !== budget.tools || row.approxTokens !== budget.approxTokens) {
        drift.push(
          `${name}: doc says ${row.tools} tools / ${row.approxTokens} tokens, ` +
            `BUNDLE_BUDGETS says ${budget.tools} / ${budget.approxTokens}`,
        );
      }
    }
    expect(drift).toEqual([]);
  });

  it('a task bundle is cheaper than the everyday core profile', () => {
    const coreCost = tools.measureCatalogueCost(
      applyProfile(ALL, { PREMIERE_MCP_PROFILE: 'core' }),
    ).approxTokens;
    for (const name of BUNDLE_NAMES) {
      const cost = tools.measureCatalogueCost(
        applyProfile(ALL, { PREMIERE_MCP_PROFILE: name }),
      ).approxTokens;
      expect(cost).toBeLessThan(coreCost);
    }
  });
});

describe('bundles curate cost, never authority', () => {
  it('keeps discovery and routing reachable under every bundle', () => {
    // Curation is only safe because a hidden capability is still discoverable AND callable.
    for (const name of BUNDLE_NAMES) {
      const names = advertised(name);
      for (const kept of ALWAYS_KEPT) expect(names.has(kept)).toBe(true);
    }
  });

  it('classifies every bundle as a cost curation the router may reach past', () => {
    for (const name of BUNDLE_NAMES) {
      const resolution = resolveProfile(ALL_NAMES, { PREMIERE_MCP_PROFILE: name });
      expect(resolution.source).toBe('profile');
      expect(resolution.profileName).toBe(name);
      expect(classifySelection(resolution)).toBe('cost');
    }
  });

  it('read-only remains an authority boundary, unaffected by the new bundles', () => {
    const resolution = resolveProfile(ALL_NAMES, { PREMIERE_MCP_PROFILE: 'read-only' });
    expect(classifySelection(resolution)).toBe('authority');
  });
});
