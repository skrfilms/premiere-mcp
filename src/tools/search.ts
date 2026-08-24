/**
 * Catalogue search — the discovery half of a large tool surface.
 *
 * This server exposes hundreds of tools. Published guidance on agent tool use is
 * consistent that a very large flat tool list degrades selection accuracy and burns
 * context on schemas the caller never uses, and the mitigation the field has settled
 * on is *progressive disclosure*: keep the catalogue, but give the model a way to
 * SEARCH it by intent instead of scanning it.
 *
 * `find_tool` is that search. It is pure, host-independent (it never touches the
 * bridge, so it works with Premiere closed), and it is deliberately honest about the
 * active tool profile: a tool that exists in the full catalogue but is hidden by
 * `PREMIERE_MCP_PROFILE` / `PREMIERE_MCP_TOOLS` / `PREMIERE_MCP_EXCLUDE` is reported
 * as `hidden`, with the reason, rather than silently omitted. Otherwise a curated
 * deployment looks to the agent exactly like a build where the capability was never
 * written, which is the same class of lie as a fake success.
 */

/** The minimum shape this module needs from a tool definition. */
export interface SearchableTool {
  name: string;
  description?: string;
  /** Parameter names, when the caller can cheaply supply them. */
  parameters?: string[];
}

export interface FindToolMatch {
  name: string;
  description: string;
  /** Relevance score; higher is better. Comparable only within one result set. */
  score: number;
  /** Why this row matched, in plain English, so the agent can judge the hit. */
  matchedOn: string;
  /** False when the full catalogue has this tool but the active profile hides it. */
  exposed: boolean;
  parameters?: string[];
}

export interface FindToolResult {
  success: true;
  query: string;
  /** Terms the query was split into, after normalisation. */
  terms: string[];
  matches: FindToolMatch[];
  /** Total matches before `limit` was applied. */
  totalMatches: number;
  returned: number;
  /** Matches suppressed by the active profile, counted separately. */
  hiddenByProfile: number;
  toolsSearched: number;
  note: string;
}

/**
 * Read-only tools are, by convention in this catalogue, the ones whose names begin
 * with an inspection verb. Used only to answer `readOnly` filters — it is a naming
 * heuristic, not a capability guarantee, and the result says so.
 */
const READ_VERB = /^(get|list|read|find|search|inspect|reflect|is|check|detect|probe|validate|verify|lint|diff)_/;

/** Split a query into lowercase alphanumeric terms, dropping noise words. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'of', 'for', 'in', 'on', 'with', 'how', 'do', 'i',
  'my', 'tool', 'tools', 'premiere', 'please', 'can', 'you', 'that', 'this', 'it',
]);

export function tokenizeQuery(query: string): string[] {
  const raw = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const kept = raw.filter((term) => !STOP_WORDS.has(term));
  // If the caller's whole query was stop words, fall back to the raw terms rather
  // than returning "no results" for a question that did contain intent.
  return kept.length ? kept : raw;
}

/** Tokens of a tool name: "add_to_timeline" -> ["add","to","timeline"]. */
function nameTokens(name: string): string[] {
  return name.toLowerCase().split('_').filter(Boolean);
}

/**
 * Score one tool against one query term. Ordered so that a name hit always
 * outranks a description hit, and a whole-token hit outranks a substring.
 */
function scoreTerm(tool: SearchableTool, term: string, tokens: string[], haystack: string): number {
  if (tool.name.toLowerCase() === term) return 100;
  let score = 0;
  if (tokens.indexOf(term) !== -1) {
    score = 30; // exact name token, e.g. "marker" in add_marker
  } else if (tool.name.toLowerCase().indexOf(term) !== -1) {
    score = 18; // substring of the name, e.g. "seq" in list_sequences
  } else {
    // Prefix match against a name token catches "transit" -> "transition".
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      if (token.indexOf(term) === 0 || term.indexOf(token) === 0) {
        score = 12;
        break;
      }
    }
  }
  if (haystack.indexOf(term) !== -1) score += 6; // also in the description
  return score;
}

export interface FindToolOptions {
  query: string;
  limit?: number;
  /** Only tools whose name begins with an inspection verb. */
  readOnly?: boolean;
  /** Include parameter names in each match. */
  includeParameters?: boolean;
  /** Include tools the active profile hides, flagged `exposed: false`. */
  includeHidden?: boolean;
}

/**
 * Rank `full` (the whole catalogue) against a natural-language query.
 *
 * `exposedNames` is the set of names the active profile actually serves; anything
 * outside it is reported as hidden rather than dropped, so a curated deployment
 * cannot masquerade as a build that lacks the capability.
 */
export function findTools(
  full: SearchableTool[],
  exposedNames: Set<string>,
  options: FindToolOptions,
): FindToolResult {
  const limit = Math.max(1, Math.min(options.limit ?? 15, 100));
  const terms = tokenizeQuery(options.query);
  const includeHidden = options.includeHidden !== false;

  const scored: FindToolMatch[] = [];
  let hiddenByProfile = 0;

  for (const tool of full) {
    if (options.readOnly && !READ_VERB.test(tool.name)) continue;

    const description = tool.description || '';
    const haystack = description.toLowerCase();
    const tokens = nameTokens(tool.name);

    let score = 0;
    let hitTerms = 0;
    const reasons: string[] = [];
    for (const term of terms) {
      const termScore = scoreTerm(tool, term, tokens, haystack);
      if (termScore > 0) {
        score += termScore;
        hitTerms++;
        reasons.push(term);
      }
    }
    if (score === 0) continue;

    // Reward covering more of the query: a tool matching every term is far more
    // likely to be what was asked for than one matching a single common word.
    if (terms.length > 1) score += Math.round((hitTerms / terms.length) * 25);
    // Prefer the shorter, more primitive name among equals ("add_marker" over
    // "add_marker_to_project_item") — the general tool is the better first guess.
    score -= Math.min(tool.name.length / 10, 4);

    const exposed = exposedNames.has(tool.name);
    if (!exposed) {
      hiddenByProfile++;
      if (!includeHidden) continue;
    }

    scored.push({
      name: tool.name,
      description,
      score: Math.round(score * 10) / 10,
      matchedOn: reasons.join(', '),
      exposed,
      ...(options.includeParameters && tool.parameters ? { parameters: tool.parameters } : {}),
    });
  }

  // Stable ordering: score desc, then name asc so identical scores don't shuffle.
  scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));

  const matches = scored.slice(0, limit);
  const note = buildNote(terms, scored.length, matches.length, hiddenByProfile, includeHidden);

  return {
    success: true,
    query: String(options.query || ''),
    terms,
    matches,
    totalMatches: scored.length,
    returned: matches.length,
    hiddenByProfile,
    toolsSearched: full.length,
    note,
  };
}

function buildNote(
  terms: string[],
  total: number,
  returned: number,
  hidden: number,
  includeHidden: boolean,
): string {
  if (total === 0) {
    return terms.length
      ? `No tool name or description matched ${terms.map((t) => `"${t}"`).join(' / ')}. ` +
        'Try a single domain noun (marker, transition, caption, proxy, lumetri, keyframe, ' +
        'export, bin, track) rather than a whole sentence. This search is lexical, not ' +
        'semantic, so a synonym the catalogue does not use will not match.'
      : 'Empty query — pass a keyword such as "marker" or "audio fade".';
  }
  const parts = [`${total} match${total === 1 ? '' : 'es'}`];
  if (returned < total) parts.push(`showing the top ${returned} by relevance (raise limit for more)`);
  if (hidden > 0) {
    parts.push(
      includeHidden
        ? `${hidden} of them are marked exposed:false — they exist in this build but the active ` +
          'tool profile hides them, so calling one will fail until the profile is widened ' +
          '(see get_capabilities for the active profile)'
        : `${hidden} further match${hidden === 1 ? '' : 'es'} hidden by the active tool profile ` +
          '(pass includeHidden to see them)',
    );
  }
  parts.push('Scores rank within this result set only; they are not confidence values');
  return `${parts.join('. ')}.`;
}
