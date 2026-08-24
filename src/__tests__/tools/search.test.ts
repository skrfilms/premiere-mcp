/**
 * Tests for catalogue search (`find_tool`).
 *
 * The point of find_tool is that an agent facing a 600+ tool catalogue can search it
 * instead of scanning it, and that a curated deployment cannot masquerade as a build
 * where the capability was never written. Both properties are asserted here, plus the
 * ranking behaviour that makes the search actually useful rather than merely present.
 */

import { findTools, tokenizeQuery, type SearchableTool } from '../../tools/search.js';
import { PremiereProTools } from '../../tools/index.js';

const noBridge = {
  executeScript: async () => {
    throw new Error('search tests must not touch the bridge');
  },
} as any;

const FIXTURE: SearchableTool[] = [
  { name: 'add_marker', description: 'Adds a marker to the sequence at a time.' },
  { name: 'add_marker_to_project_item', description: 'Adds a marker to a project item.' },
  { name: 'list_markers', description: 'Lists every marker on the sequence.' },
  { name: 'delete_marker', description: 'Removes a marker by index.' },
  { name: 'set_clip_opacity', description: 'Sets the opacity of a timeline clip.' },
  { name: 'export_sequence', description: 'Renders and exports a sequence to a video file.' },
  { name: 'get_project_info', description: 'Reads the current project name and path.' },
];

const ALL = new Set(FIXTURE.map((tool) => tool.name));

describe('tokenizeQuery', () => {
  it('lowercases, splits on non-alphanumerics, and drops noise words', () => {
    expect(tokenizeQuery('How do I add a Marker?')).toEqual(['add', 'marker']);
  });

  it('falls back to the raw terms when the whole query was stop words', () => {
    // "tools for premiere" is all stop words; returning nothing would report "no
    // results" for a query that did carry intent, so keep the raw terms instead.
    expect(tokenizeQuery('tools for premiere').length).toBeGreaterThan(0);
  });

  it('returns an empty list for an empty query', () => {
    expect(tokenizeQuery('')).toEqual([]);
  });
});

describe('findTools ranking', () => {
  it('ranks an exact whole-token name match above a substring match', () => {
    const result = findTools(FIXTURE, ALL, { query: 'marker' });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]!.name).toBe('add_marker');
  });

  it('prefers the shorter, more primitive name among equals', () => {
    // add_marker and add_marker_to_project_item both match "add marker"; the general
    // tool is the better first guess for an agent, so it must outrank the specific one.
    const result = findTools(FIXTURE, ALL, { query: 'add marker' });
    const names = result.matches.map((match) => match.name);
    expect(names.indexOf('add_marker')).toBeLessThan(names.indexOf('add_marker_to_project_item'));
  });

  it('rewards covering more of the query', () => {
    const result = findTools(FIXTURE, ALL, { query: 'clip opacity' });
    expect(result.matches[0]!.name).toBe('set_clip_opacity');
  });

  it('reports which terms produced the hit', () => {
    const result = findTools(FIXTURE, ALL, { query: 'clip opacity' });
    expect(result.matches[0]!.matchedOn).toContain('opacity');
  });

  it('honours limit and still reports the true total', () => {
    const result = findTools(FIXTURE, ALL, { query: 'marker', limit: 2 });
    expect(result.returned).toBe(2);
    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBeGreaterThan(2);
    expect(result.note).toContain('showing the top 2');
  });

  it('filters to inspection tools when readOnly is set', () => {
    const result = findTools(FIXTURE, ALL, { query: 'marker', readOnly: true });
    expect(result.matches.map((match) => match.name)).toEqual(['list_markers']);
  });

  it('returns an actionable note and no matches for an unmatched query', () => {
    const result = findTools(FIXTURE, ALL, { query: 'zzzznothing' });
    expect(result.matches).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.note).toContain('lexical, not');
  });

  it('produces a stable order for equal scores', () => {
    const a = findTools(FIXTURE, ALL, { query: 'marker' }).matches.map((m) => m.name);
    const b = findTools(FIXTURE, ALL, { query: 'marker' }).matches.map((m) => m.name);
    expect(a).toEqual(b);
  });
});

describe('findTools is honest about profile-hidden tools', () => {
  const exposed = new Set(['list_markers']);

  it('flags a match that exists but is hidden, rather than omitting it', () => {
    const result = findTools(FIXTURE, exposed, { query: 'marker' });
    const hidden = result.matches.filter((match) => !match.exposed);
    expect(hidden.length).toBeGreaterThan(0);
    expect(result.hiddenByProfile).toBe(hidden.length);
    // The note must explain that these exist in the build but the profile hides them,
    // so an agent does not conclude the capability was never written.
    expect(result.note).toContain('exposed:false');
  });

  it('omits hidden matches only when explicitly asked, and says how many', () => {
    const result = findTools(FIXTURE, exposed, { query: 'marker', includeHidden: false });
    expect(result.matches.every((match) => match.exposed)).toBe(true);
    expect(result.hiddenByProfile).toBeGreaterThan(0);
    expect(result.note).toContain('hidden by the active tool profile');
  });
});

describe('find_tool over the real catalogue', () => {
  const tools = new PremiereProTools(noBridge);

  it('is exposed as a tool', () => {
    expect(tools.getAvailableTools().some((tool) => tool.name === 'find_tool')).toBe(true);
  });

  it('makes no Premiere request (the stub bridge would throw)', async () => {
    const result = await tools.executeTool('find_tool', { query: 'marker' });
    expect(result.success).toBe(true);
  });

  it('finds a real tool for a natural-language question', async () => {
    const result = await tools.executeTool('find_tool', {
      query: 'how do I export with a custom preset',
      limit: 5,
    });
    expect(result.matches.map((match: any) => match.name)).toContain('create_custom_export_preset');
  });

  it('searches the whole catalogue, not just the exposed subset', async () => {
    const result = await tools.executeTool('find_tool', { query: 'sequence' });
    expect(result.toolsSearched).toBeGreaterThanOrEqual(tools.getAvailableTools().length);
  });

  it('can optionally return parameter names', async () => {
    const result = await tools.executeTool('find_tool', {
      query: 'add marker',
      includeParameters: true,
      limit: 3,
    });
    expect(Array.isArray(result.matches[0].parameters)).toBe(true);
  });
});

describe('unknown tool names get a shortlist instead of a wall of names', () => {
  const tools = new PremiereProTools(noBridge);

  it('suggests the nearest real tool for a typo and does not dump the catalogue', async () => {
    const result = await tools.executeTool('splitt_clip', {});
    expect(result.success).toBe(false);
    expect(result.didYouMean.map((entry: any) => entry.name)).toContain('split_clip');
    // The old behaviour returned every tool name; that is a multi-kilobyte response the
    // model must scan. Keep the shortlist short.
    expect(result.didYouMean.length).toBeLessThanOrEqual(8);
    expect(result.availableTools).toBeUndefined();
  });

  it('distinguishes "no such tool" from "hidden by the profile"', async () => {
    const result = await tools.executeTool('definitely_not_a_tool', {});
    expect(result.existsButHiddenByProfile).toBe(false);
    expect(result.error).toContain('does not exist in this build');
    expect(result.hint).toContain('find_tool');
  });
});
