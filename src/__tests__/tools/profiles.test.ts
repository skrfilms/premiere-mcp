/**
 * Tool profiles are opt-in curation. The invariant that matters most: with no
 * env set, the catalogue is returned UNCHANGED (same items, same order, same
 * reference) so existing clients see no behaviour change. Everything else is a
 * deliberate narrowing that must never drop get_capabilities.
 */

import {
  resolveProfile,
  applyProfile,
  matchesPattern,
  PROFILES,
  ALWAYS_KEPT,
} from '../../tools/profiles.js';

const ALL = [
  // find_tool is in ALWAYS_KEPT alongside get_capabilities: curation is only safe if
  // the agent can still discover what curation removed. The schema-on-demand trio
  // (get_tool_typings / call_tool / activate_tools / deactivate_tools) is kept for the
  // stronger reason that discovery without a call path is just a better-worded refusal.
  'get_capabilities',
  'find_tool',
  'get_tool_typings',
  'call_tool',
  'activate_tools',
  'deactivate_tools',
  'get_project_info',
  'list_sequences',
  'add_to_timeline',
  'razor_timeline_at_time',
  'export_sequence',
  'color_correct',
  'apply_lut',
  'adjust_audio_levels',
  'setup_ducking',
  'execute_extendscript',
  'evaluate_expression',
].map((name) => ({ name }));

describe('matchesPattern', () => {
  it('matches exact, prefix glob, and catch-all', () => {
    expect(matchesPattern('get_project_info', 'get_project_info')).toBe(true);
    expect(matchesPattern('get_project_info', 'get_*')).toBe(true);
    expect(matchesPattern('add_to_timeline', 'get_*')).toBe(false);
    expect(matchesPattern('anything', '*')).toBe(true);
  });
});

describe('default (no env)', () => {
  // The default was `all` and is now `core`. 638 tools is ~51% of a 200k context spent
  // before the user speaks, and VS Code / Copilot hard-errors above 128, so the old
  // default could not run there at all. These tests pin the new contract so it cannot
  // drift back silently — the previous versions of them asserted the opposite.
  it('curates by default rather than exposing the whole catalogue', () => {
    const r = resolveProfile(
      ALL.map((t) => t.name),
      {},
    );
    expect(r.source).toBe('profile');
    expect(r.profileName).toBe('core');
  });

  it('still hands back the whole catalogue when asked explicitly', () => {
    const out = applyProfile(ALL, { PREMIERE_MCP_PROFILE: 'all' });
    // Same reference: `all` with no excludes is a zero-cost passthrough.
    expect(out).toBe(ALL);
    const r = resolveProfile(
      ALL.map((t) => t.name),
      { PREMIERE_MCP_PROFILE: 'all' },
    );
    expect(r.source).toBe('all');
    expect(r.profileName).toBeNull();
    expect(r.selected).toHaveLength(ALL.length);
  });

  it('keeps discovery reachable under the default, so curation cannot hide a capability', () => {
    // Curation is only honest if the agent can still find what curation removed.
    // find_tool reports hidden matches as exposed:false; get_capabilities reports the
    // active profile. Losing either would make a curated build indistinguishable from
    // one where the feature was never written.
    const names = applyProfile(ALL, {}).map((t) => t.name);
    for (const kept of ALWAYS_KEPT) expect(names).toContain(kept);
  });
});

describe('named profile', () => {
  it('read-only keeps only introspection tools', () => {
    const out = applyProfile(ALL, { PREMIERE_MCP_PROFILE: 'read-only' }).map((t) => t.name);
    expect(out).toContain('get_project_info');
    expect(out).toContain('list_sequences');
    expect(out).not.toContain('add_to_timeline');
    expect(out).not.toContain('razor_timeline_at_time');
  });

  it('every named profile in PROFILES resolves without throwing', () => {
    for (const name of Object.keys(PROFILES)) {
      const r = resolveProfile(
        ALL.map((t) => t.name),
        { PREMIERE_MCP_PROFILE: name },
      );
      expect(Array.isArray(r.selected)).toBe(true);
    }
  });

  it('an unknown profile name fails safe to the full catalogue and flags it', () => {
    const r = resolveProfile(
      ALL.map((t) => t.name),
      { PREMIERE_MCP_PROFILE: 'nope' },
    );
    expect(r.source).toBe('all');
    expect(r.selected).toHaveLength(ALL.length);
    expect(r.unknown).toContain('nope');
  });
});

describe('explicit allowlist (PREMIERE_MCP_TOOLS)', () => {
  it('replaces the profile with an exact set and reports unknown names', () => {
    const r = resolveProfile(
      ALL.map((t) => t.name),
      {
        PREMIERE_MCP_PROFILE: 'read-only', // should be ignored
        PREMIERE_MCP_TOOLS: 'add_to_timeline, export_sequence, not_a_tool',
      },
    );
    expect(r.source).toBe('explicit');
    expect(r.selected.sort()).toEqual(['add_to_timeline', 'export_sequence']);
    expect(r.unknown).toContain('not_a_tool');
  });

  it('supports prefix globs in the explicit list', () => {
    const out = applyProfile(ALL, { PREMIERE_MCP_TOOLS: 'get_*' }).map((t) => t.name);
    // get_capabilities is always kept AND matches get_*; get_project_info matches.
    expect(out).toContain('get_project_info');
    expect(out).toContain('get_capabilities');
    expect(out).not.toContain('add_to_timeline');
  });
});

describe('exclude (PREMIERE_MCP_EXCLUDE)', () => {
  it('removes matches from the chosen set, applied last', () => {
    const out = applyProfile(ALL, {
      PREMIERE_MCP_EXCLUDE: 'execute_extendscript, evaluate_expression',
    }).map((t) => t.name);
    expect(out).not.toContain('execute_extendscript');
    expect(out).not.toContain('evaluate_expression');
    // still the full set otherwise
    expect(out).toContain('add_to_timeline');
  });

  it('exclude alone (no profile) still narrows the default', () => {
    const out = applyProfile(ALL, { PREMIERE_MCP_EXCLUDE: 'apply_lut' });
    expect(out).not.toBe(ALL); // no longer the fast-path reference
    expect(out.map((t) => t.name)).not.toContain('apply_lut');
  });
});

describe('get_capabilities is never dropped', () => {
  it('survives an explicit list that omits it', () => {
    const out = applyProfile(ALL, { PREMIERE_MCP_TOOLS: 'add_to_timeline' }).map((t) => t.name);
    expect(out).toContain('add_to_timeline');
    for (const kept of ALWAYS_KEPT) expect(out).toContain(kept);
  });

  it('survives an exclude that names it', () => {
    const out = applyProfile(ALL, { PREMIERE_MCP_EXCLUDE: 'get_capabilities' }).map((t) => t.name);
    expect(out).toContain('get_capabilities');
  });
});
