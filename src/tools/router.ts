/**
 * Schema-on-demand: reaching a 639-tool catalogue through a 3-tool surface.
 *
 * The tool profile (see profiles.ts) exists because advertising every tool costs a
 * client ~102,000 tokens of context before it has read a single instruction, and
 * VS Code / Copilot refuses a list past 128 tools outright. Curation fixed the cost
 * and created a new problem: under `core`, 542 implemented tools became uncallable.
 * `find_tool` told the agent they existed, which is honest but unhelpful — it named a
 * capability and then offered no way to use it.
 *
 * The fix is to separate what is ADVERTISED from what is REACHABLE:
 *
 *   - advertised = the profile's tool list (a context-cost decision)
 *   - reachable  = advertised, PLUS anything routed through `call_tool`, PLUS anything
 *                  promoted into the advertised list by `activate_tools`
 *
 * `find_tool` (search) → `get_tool_typings` (exact signature) → `call_tool` (invoke)
 * is a complete loop that costs three tool definitions instead of 639.
 *
 * THE PART THAT MATTERS FOR HONESTY: separating advertised from reachable is only safe
 * if it cannot quietly widen an operator's authority decision. A profile can be set for
 * two completely different reasons, and this module refuses to conflate them:
 *
 *   - a COST curation (`core`, `audio`, `color`) trims the menu. Reaching past it is
 *     the router's entire purpose, and doing so takes nothing away from the operator.
 *   - an AUTHORITY boundary (`read-only`, or an explicit PREMIERE_MCP_TOOLS allowlist,
 *     or any PREMIERE_MCP_EXCLUDE veto) is a statement about what this deployment is
 *     ALLOWED to do. Routing past that would turn "point an untrusted agent at it" into
 *     a lie, so the router refuses and says which setting refused it.
 *
 * Everything here is pure: no host call, no filesystem, no process.env read except
 * through an injected object. That is deliberate — the gate that decides what a
 * deployment may reach should be testable without a running Premiere.
 */

import { AUTHORITY_PROFILES, matchesPattern, type ProfileResolution } from './profiles.js';

/** Why a selection exists: to save context, or to bound authority. */
export type SelectionKind = 'cost' | 'authority';

/**
 * Classify the active selection.
 *
 * `read-only` is an authority profile by name. An explicit PREMIERE_MCP_TOOLS list is
 * authority by construction: the operator enumerated exact tools, and "I listed twelve
 * tools" cannot reasonably mean "and 627 others by another route".
 */
export function classifySelection(resolution: ProfileResolution): SelectionKind {
  if (resolution.source === 'explicit') return 'authority';
  if (resolution.profileName && AUTHORITY_PROFILES.has(resolution.profileName)) return 'authority';
  return 'cost';
}

export type RouterRefusalCode =
  | 'UNKNOWN_TOOL'
  | 'EXCLUDED_BY_OPERATOR'
  | 'AUTHORITY_PROFILE'
  | 'NOT_ROUTABLE';

export interface RouterVerdict {
  allowed: boolean;
  /** True when the target is not in the advertised list and the router is reaching past a cost curation. */
  reachedPastProfile: boolean;
  code?: RouterRefusalCode;
  reason?: string;
}

/** Tools the router must never invoke, because invoking them through itself is nonsense. */
export const NOT_ROUTABLE = new Set(['call_tool', 'activate_tools', 'deactivate_tools']);

export interface RouterTargetQuery {
  /** The tool the caller wants to reach. */
  name: string;
  /** Every tool this build implements. */
  registeredNames: ReadonlySet<string>;
  /** Tools the active profile (plus any activations) advertises right now. */
  exposedNames: ReadonlySet<string>;
  /** The resolved profile, for the authority decision. */
  resolution: ProfileResolution;
}

/**
 * Decide whether `call_tool` may invoke `name`, and if not, say exactly which setting
 * refused and how to change it. A refusal that does not name the setting responsible is
 * indistinguishable from a missing feature.
 */
export function routerVerdict(query: RouterTargetQuery): RouterVerdict {
  const { name, registeredNames, exposedNames, resolution } = query;

  if (!registeredNames.has(name)) {
    return {
      allowed: false,
      reachedPastProfile: false,
      code: 'UNKNOWN_TOOL',
      reason: `Tool '${name}' does not exist in this build. Call find_tool with a keyword to search the catalogue.`,
    };
  }

  if (NOT_ROUTABLE.has(name)) {
    return {
      allowed: false,
      reachedPastProfile: false,
      code: 'NOT_ROUTABLE',
      reason: `call_tool cannot invoke '${name}'. Call it directly; it is always advertised.`,
    };
  }

  // Already advertised: the router is just a call path, nothing is being widened.
  if (exposedNames.has(name)) {
    return { allowed: true, reachedPastProfile: false };
  }

  // An exclusion is an operator veto and outranks everything, including a cost profile.
  // This is checked before the authority/cost split so that PREMIERE_MCP_EXCLUDE means
  // the same thing under every profile.
  for (const pattern of resolution.excluded) {
    if (matchesPattern(name, pattern)) {
      return {
        allowed: false,
        reachedPastProfile: false,
        code: 'EXCLUDED_BY_OPERATOR',
        reason: `Tool '${name}' is excluded by PREMIERE_MCP_EXCLUDE ('${pattern}'). An exclusion is an operator veto: the router will not route around it. Remove the pattern from PREMIERE_MCP_EXCLUDE to allow it.`,
      };
    }
  }

  if (classifySelection(resolution) === 'authority') {
    const which =
      resolution.source === 'explicit'
        ? 'PREMIERE_MCP_TOOLS names an exact allowlist'
        : `PREMIERE_MCP_PROFILE=${resolution.profileName} is an authority boundary, not a context-cost curation`;
    return {
      allowed: false,
      reachedPastProfile: false,
      code: 'AUTHORITY_PROFILE',
      reason: `Tool '${name}' exists but this deployment is not permitted to call it: ${which}. The router deliberately does not reach past an authority boundary — widen the setting if that is what you intend.`,
    };
  }

  return { allowed: true, reachedPastProfile: true };
}

/* ------------------------------------------------------------------------- *
 * tools/list pagination
 * ------------------------------------------------------------------------- */

/**
 * Page size for tools/list. DEFAULT IS OFF (0 = one page, everything).
 *
 * Paginating by default would be a silent truncation on any client that ignores
 * `nextCursor` — it would see 100 tools and have no way to know 539 were withheld.
 * That is the same class of lie as reporting an unverified edit as done, so paging is
 * opt-in for operators who know their client follows cursors.
 */
export interface PageSizeEnv {
  PREMIERE_MCP_PAGE_SIZE?: string | undefined;
}

export function resolvePageSize(env: PageSizeEnv = process.env as PageSizeEnv): number {
  const raw = (env.PREMIERE_MCP_PAGE_SIZE || '').trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

const CURSOR_PREFIX = 'offset:';

/** Cursors are opaque per the spec; this one is a base64 offset, and nothing reads it but us. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64');
}

/** Returns null for anything we did not issue, so a bad cursor fails loudly rather than silently paging from 0. */
export function decodeCursor(cursor: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) return null;
  const offset = Number.parseInt(decoded.slice(CURSOR_PREFIX.length), 10);
  if (!Number.isFinite(offset) || offset < 0) return null;
  return offset;
}

/**
 * Read the cursor out of a `tools/list` request's params.
 *
 * Trivial-looking, and extracted on purpose: the handler in src/index.ts is a self-starting
 * entry point that tests cannot import, so this was the one line of the pagination path with
 * no coverage. A wrong param path here would silently restart every page from zero.
 */
export function cursorFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const cursor = (params as { cursor?: unknown }).cursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

export interface PageResult<T> {
  page: T[];
  /** Present only when more items remain. Absent on the last page, per the spec. */
  nextCursor?: string;
  /** True when the caller's cursor could not be decoded; the caller should raise InvalidParams. */
  invalidCursor: boolean;
}

/**
 * Slice one page out of `items`. `pageSize <= 0` returns everything in a single page
 * with no cursor, which is the default and keeps today's behaviour byte-for-byte.
 */
export function paginate<T>(
  items: T[],
  cursor: string | undefined,
  pageSize: number,
): PageResult<T> {
  if (pageSize <= 0) return { page: items, invalidCursor: false };

  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (decoded === null) return { page: [], invalidCursor: true };
    offset = decoded;
  }

  const page = items.slice(offset, offset + pageSize);
  const next = offset + page.length;
  return next < items.length
    ? { page, nextCursor: encodeCursor(next), invalidCursor: false }
    : { page, invalidCursor: false };
}
