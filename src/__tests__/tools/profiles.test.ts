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
  'get_capabilities', 'get_project_info', 'list_sequences',
  'add_to_timeline', 'razor_timeline_at_time', 'export_sequence',
  'color_correct', 'apply_lut', 'adjust_audio_levels', 'setup_ducking',
  'execute_extendscript', 'evaluate_expression',
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
  it('returns the exact same array reference — zero-cost passthrough', () => {
    const out = applyProfile(ALL, {});
    expect(out).toBe(ALL);
  });

  it('resolveProfile reports source "all" and no curation', () => {
    const r = resolveProfile(ALL.map((t) => t.name), {});
    expect(r.source).toBe('all');
    expect(r.profileName).toBeNull();
    expect(r.selected).toHaveLength(ALL.length);
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
      const r = resolveProfile(ALL.map((t) => t.name), { PREMIERE_MCP_PROFILE: name });
      expect(Array.isArray(r.selected)).toBe(true);
    }
  });

  it('an unknown profile name fails safe to the full catalogue and flags it', () => {
    const r = resolveProfile(ALL.map((t) => t.name), { PREMIERE_MCP_PROFILE: 'nope' });
    expect(r.source).toBe('all');
    expect(r.selected).toHaveLength(ALL.length);
    expect(r.unknown).toContain('nope');
  });
});

describe('explicit allowlist (PREMIERE_MCP_TOOLS)', () => {
  it('replaces the profile with an exact set and reports unknown names', () => {
    const r = resolveProfile(ALL.map((t) => t.name), {
      PREMIERE_MCP_PROFILE: 'read-only', // should be ignored
      PREMIERE_MCP_TOOLS: 'add_to_timeline, export_sequence, not_a_tool',
    });
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
