/**
 * Schema-on-demand: the router, runtime activation, and tools/list pagination.
 *
 * Two properties are asserted here, and the second one matters more than the first:
 *
 *  1. A COST profile (`core`) hides tools to save context but must not remove capability
 *     — `call_tool` reaches them and `activate_tools` promotes them, end to end, against
 *     the real catalogue.
 *  2. An AUTHORITY boundary (`read-only`, an explicit PREMIERE_MCP_TOOLS allowlist, or a
 *     PREMIERE_MCP_EXCLUDE veto) must stop BOTH. A router that quietly widened what a
 *     deployment may do would be a worse lie than a fake success, because the operator
 *     would have configured a boundary and been told it was in force.
 *
 * The bridge stub throws on any host call, so every passing test here also proves the
 * path it exercises is host-independent.
 */

import {
  classifySelection,
  cursorFromParams,
  routerVerdict,
  paginate,
  encodeCursor,
  decodeCursor,
  resolvePageSize,
} from '../../tools/router.js';
import { PROFILES, resolveProfile } from '../../tools/profiles.js';
import { PremiereProTools } from '../../tools/index.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const noBridge = {
  executeScript: async () => {
    throw new Error('router tests must not touch the bridge');
  },
} as any;

/** Run a body with a temporary env, restoring exactly what was there before. */
async function withEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key] as string;
  }
  try {
    return await body();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key] as string;
    }
  }
}

const NAMES = ['get_capabilities', 'find_tool', 'call_tool', 'get_project_info', 'read_srt', 'add_marker', 'delete_sequence'];

function verdictFor(name: string, env: Record<string, string>, exposed: string[]) {
  return routerVerdict({
    name,
    registeredNames: new Set(NAMES),
    exposedNames: new Set(exposed),
    resolution: resolveProfile(NAMES, env),
  });
}

describe('classifySelection', () => {
  it('treats a menu-size profile as a cost decision', () => {
    expect(classifySelection(resolveProfile(NAMES, { PREMIERE_MCP_PROFILE: 'core' }))).toBe('cost');
    expect(classifySelection(resolveProfile(NAMES, { PREMIERE_MCP_PROFILE: 'audio' }))).toBe('cost');
  });

  it('treats read-only and an explicit allowlist as authority boundaries', () => {
    expect(classifySelection(resolveProfile(NAMES, { PREMIERE_MCP_PROFILE: 'read-only' }))).toBe('authority');
    expect(classifySelection(resolveProfile(NAMES, { PREMIERE_MCP_TOOLS: 'get_project_info find_tool' }))).toBe('authority');
  });
});

describe('routerVerdict', () => {
  it('allows an already-advertised tool without claiming it reached past anything', () => {
    const v = verdictFor('get_project_info', { PREMIERE_MCP_PROFILE: 'core' }, ['get_project_info']);
    expect(v.allowed).toBe(true);
    expect(v.reachedPastProfile).toBe(false);
  });

  it('reaches past a cost profile, and says that is what it did', () => {
    const v = verdictFor('read_srt', { PREMIERE_MCP_PROFILE: 'core' }, ['get_project_info']);
    expect(v.allowed).toBe(true);
    expect(v.reachedPastProfile).toBe(true);
  });

  it('refuses to reach past an authority profile and names the setting', () => {
    const v = verdictFor('add_marker', { PREMIERE_MCP_PROFILE: 'read-only' }, ['get_project_info', 'find_tool']);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('AUTHORITY_PROFILE');
    expect(v.reason).toContain('read-only');
  });

  it('refuses to reach past an explicit allowlist', () => {
    const v = verdictFor('add_marker', { PREMIERE_MCP_TOOLS: 'get_project_info' }, ['get_project_info']);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('AUTHORITY_PROFILE');
    expect(v.reason).toContain('PREMIERE_MCP_TOOLS');
  });

  it('honours an exclusion veto even under a cost profile', () => {
    // The important asymmetry: `core` is routable, but a name the operator excluded is
    // not — otherwise PREMIERE_MCP_EXCLUDE would mean different things per profile.
    const v = verdictFor('read_srt', { PREMIERE_MCP_PROFILE: 'core', PREMIERE_MCP_EXCLUDE: 'read_srt' }, ['get_project_info']);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('EXCLUDED_BY_OPERATOR');
    expect(v.reason).toContain('PREMIERE_MCP_EXCLUDE');
  });

  it('honours an exclusion glob', () => {
    const v = verdictFor('read_srt', { PREMIERE_MCP_PROFILE: 'core', PREMIERE_MCP_EXCLUDE: 'read_*' }, ['get_project_info']);
    expect(v.code).toBe('EXCLUDED_BY_OPERATOR');
  });

  it('reports an unknown name as unknown rather than as a permission problem', () => {
    const v = verdictFor('nope_not_a_tool', { PREMIERE_MCP_PROFILE: 'core' }, ['get_project_info']);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('UNKNOWN_TOOL');
  });

  it('refuses to route the router through itself', () => {
    const v = verdictFor('call_tool', { PREMIERE_MCP_PROFILE: 'core' }, ['call_tool']);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('NOT_ROUTABLE');
  });
});

describe('call_tool against the real catalogue', () => {
  it('is advertised under every profile, including the tightest', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'read-only' }, () => {
      const names = new PremiereProTools(noBridge).getAvailableTools().map((tool) => tool.name);
      expect(names).toContain('call_tool');
      expect(names).toContain('get_tool_typings');
    });
  });

  it('invokes a tool the active profile hides, and reports that it reached past it', async () => {
    // read_srt is in the read-only/audio profiles, not core. A real .srt round trip
    // proves the target ran for real rather than being merely permitted.
    const srtPath = join(await fs.mkdtemp(join(tmpdir(), 'router-srt-')), 'cues.srt');
    await fs.writeFile(srtPath, '1\n00:00:01,000 --> 00:00:02,500\nHello\n', 'utf8');

    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const tools = new PremiereProTools(noBridge);
      expect(tools.getAvailableTools().some((tool) => tool.name === 'read_srt')).toBe(false);

      const result = await tools.executeTool('call_tool', { name: 'read_srt', args: { srtPath } });
      expect(result.success).toBe(true);
      expect(result.cues[0].text).toBe('Hello');
      expect(result.routed).toEqual({ requested: 'read_srt', invoked: true, reachedPastProfile: true });
    });
  });

  it('dryRun validates against the target schema and invokes nothing', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const tools = new PremiereProTools(noBridge);

      const missing = await tools.executeTool('call_tool', { name: 'read_srt', args: {}, dryRun: true });
      expect(missing.invoked).toBe(false);
      expect(missing.argumentsValid).toBe(false);
      expect(missing.validationError).toBeDefined();
      expect(missing.inputSchema).toBeDefined();

      const ok = await tools.executeTool('call_tool', {
        name: 'read_srt',
        args: { srtPath: '/tmp/does-not-need-to-exist.srt' },
        dryRun: true,
      });
      expect(ok.argumentsValid).toBe(true);
      expect(ok.invoked).toBe(false);
    });
  });

  it('refuses a mutating target under read-only without touching the host', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'read-only' }, async () => {
      const result = await new PremiereProTools(noBridge).executeTool('call_tool', {
        name: 'add_marker',
        args: { name: 'x' },
      });
      expect(result.success).toBe(false);
      expect(result.refusedBy).toBe('AUTHORITY_PROFILE');
      expect(result.routed).toEqual({ requested: 'add_marker', invoked: false });
    });
  });

  it('refuses an operator-excluded target under a cost profile', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core', PREMIERE_MCP_EXCLUDE: 'read_srt' }, async () => {
      const result = await new PremiereProTools(noBridge).executeTool('call_tool', {
        name: 'read_srt',
        args: { srtPath: '/tmp/x.srt' },
      });
      expect(result.refusedBy).toBe('EXCLUDED_BY_OPERATOR');
    });
  });

  it('hands back a ranked shortlist for a typo instead of a bare refusal', async () => {
    const result = await new PremiereProTools(noBridge).executeTool('call_tool', { name: 'splitt_clip' });
    expect(result.refusedBy).toBe('UNKNOWN_TOOL');
    expect(result.didYouMean.map((match: any) => match.name)).toContain('split_clip');
  });

  it('will not invoke itself', async () => {
    const result = await new PremiereProTools(noBridge).executeTool('call_tool', {
      name: 'call_tool',
      args: { name: 'get_project_info' },
    });
    expect(result.refusedBy).toBe('NOT_ROUTABLE');
  });

  it('requires a name — schema first, then the whitespace case the schema cannot catch', async () => {
    const tools = new PremiereProTools(noBridge);

    // A missing name is rejected by call_tool's own Zod schema before the handler runs.
    const absent = await tools.executeTool('call_tool', {});
    expect(absent.success).toBe(false);
    expect(absent.error).toContain('Invalid arguments');

    // `"   "` satisfies z.string(), so the handler is the only layer that can refuse it,
    // and it points at the search tool rather than just saying no.
    const blank = await tools.executeTool('call_tool', { name: '   ' });
    expect(blank.success).toBe(false);
    expect(blank.error).toContain('find_tool');
  });
});

describe('excluding the router actually removes it', () => {
  it('drops call_tool when an operator excludes it, instead of forcing it back', async () => {
    // An operator veto that silently did nothing would be the same class of lie as a fake
    // success — and worse here, because it is about what the deployment can reach.
    // get_capabilities and find_tool still survive an exclusion (read-only introspection).
    await withEnv({ PREMIERE_MCP_PROFILE: 'core', PREMIERE_MCP_EXCLUDE: 'call_tool' }, async () => {
      const tools = new PremiereProTools(noBridge);
      const names = tools.getAvailableTools().map((tool) => tool.name);
      expect(names).not.toContain('call_tool');
      expect(names).toContain('find_tool');
      expect(names).toContain('get_capabilities');

      const result = await tools.executeTool('call_tool', { name: 'read_srt', args: { srtPath: '/tmp/x.srt' } });
      expect(result.success).toBe(false);
      expect(result.existsButHiddenByProfile).toBe(true);
    });
  });

  it('drops the activation pair too', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core', PREMIERE_MCP_EXCLUDE: 'activate_tools deactivate_tools' }, () => {
      const names = new PremiereProTools(noBridge).getAvailableTools().map((tool) => tool.name);
      expect(names).not.toContain('activate_tools');
      expect(names).not.toContain('deactivate_tools');
    });
  });
});

describe('activate_tools / deactivate_tools', () => {
  it('switches task menu mid-session: load a bundle whole, drop it again', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'task-cut-dialogue' }, async () => {
      const tools = new PremiereProTools(noBridge);
      const base = tools.getAvailableTools().map((tool) => tool.name);
      expect(base).not.toContain('apply_lumetri_preset');

      const loaded = await tools.executeTool('activate_tools', { bundle: 'grading' });
      expect(loaded.bundle).toBe('task-grade');
      const now = tools.getAvailableTools().map((tool) => tool.name);
      for (const name of PROFILES['task-grade']!) expect(now).toContain(name);
      // Two task menus at once is past the selection guidance: the agent is told to drop one.
      expect(loaded.warning).toMatch(/deactivate_tools/);

      const dropped = await tools.executeTool('deactivate_tools', { bundle: 'task-grade' });
      expect(dropped.success).toBe(true);
      // Tools both menus share stay: the profile itself advertises them.
      expect(tools.getAvailableTools().map((tool) => tool.name)).toEqual(base);
    });
  });

  it('names the bundles when asked for one that does not exist', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const r = await new PremiereProTools(noBridge).executeTool('activate_tools', { bundle: 'sound design' });
      expect(r.success).toBe(false);
      expect(r.bundles.map((b: any) => b.name)).toContain('task-grade');
    });
  });

  it('promotes a hidden tool into the advertised list and fires tools/list_changed once', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const tools = new PremiereProTools(noBridge);
      let notifications = 0;
      tools.onExposureChanged(() => { notifications += 1; });

      const before = tools.getAvailableTools().length;
      const result = await tools.executeTool('activate_tools', { names: ['read_srt', 'validate_srt'] });

      expect(result.activated).toEqual(['read_srt', 'validate_srt']);
      expect(result.toolsNowAdvertised).toBe(before + 2);
      expect(tools.getAvailableTools().map((tool) => tool.name)).toContain('read_srt');
      expect(result.listChangedNotified).toBe(true);
      expect(notifications).toBe(1);
      // Growing the menu has a price; it is reported rather than discovered later.
      expect(result.contextCost.approxTokens).toBeGreaterThan(0);

      // Directly callable now — no router hop needed.
      const direct = await tools.executeTool('validate_srt', { srtPath: '/tmp/nope.srt' });
      expect(direct.error).not.toContain('not exposed');
    });
  });

  it('activates the best matches for a query', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const tools = new PremiereProTools(noBridge);
      const result = await tools.executeTool('activate_tools', { query: 'loudness', limit: 3 });
      expect(result.success).toBe(true);
      expect(result.activated.length + result.alreadyExposed.length).toBeGreaterThan(0);
    });
  });

  it('does not notify when nothing changed', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const tools = new PremiereProTools(noBridge);
      let notifications = 0;
      tools.onExposureChanged(() => { notifications += 1; });

      const result = await tools.executeTool('activate_tools', { names: ['get_project_info'] });
      expect(result.alreadyExposed).toEqual(['get_project_info']);
      expect(result.activated).toEqual([]);
      expect(result.listChangedNotified).toBe(false);
      expect(notifications).toBe(0);
    });
  });

  it('refuses to promote past an authority boundary', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'read-only' }, async () => {
      const tools = new PremiereProTools(noBridge);
      const result = await tools.executeTool('activate_tools', { names: ['add_marker'] });
      expect(result.activated).toEqual([]);
      expect(result.refused[0].refusedBy).toBe('AUTHORITY_PROFILE');
      expect(tools.getAvailableTools().map((tool) => tool.name)).not.toContain('add_marker');
    });
  });

  it('deactivates back to exactly the configured profile', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const tools = new PremiereProTools(noBridge);
      const configured = tools.getAvailableTools().length;

      await tools.executeTool('activate_tools', { names: ['read_srt', 'validate_srt'] });
      const cleared = await tools.executeTool('deactivate_tools', { all: true });

      expect(cleared.deactivated).toEqual(['read_srt', 'validate_srt']);
      expect(tools.getAvailableTools().length).toBe(configured);
    });
  });

  it('reports a name that was never activated instead of claiming a removal', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const tools = new PremiereProTools(noBridge);
      const result = await tools.executeTool('deactivate_tools', { names: ['get_project_info'] });
      expect(result.success).toBe(false);
      expect(result.notActivated).toEqual(['get_project_info']);
      expect(tools.getAvailableTools().map((tool) => tool.name)).toContain('get_project_info');
    });
  });

  it('requires names or all', async () => {
    const result = await new PremiereProTools(noBridge).executeTool('deactivate_tools', {});
    expect(result.success).toBe(false);
  });
});

describe('get_capabilities reports advertised and reachable separately', () => {
  it('under a cost profile: fewer advertised, everything reachable', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'core' }, async () => {
      const caps = await new PremiereProTools(noBridge).executeTool('get_capabilities', {});
      const routing = caps.catalog.routing;
      expect(routing.selectionKind).toBe('cost');
      expect(routing.toolsAdvertised).toBeLessThan(routing.toolsReachable);
      expect(routing.toolsReachable).toBe(caps.catalog.toolsInFullCatalog);
      expect(routing.listChangedSupported).toBe(true);
    });
  });

  it('under an authority profile: reachable never exceeds advertised', async () => {
    await withEnv({ PREMIERE_MCP_PROFILE: 'read-only' }, async () => {
      const caps = await new PremiereProTools(noBridge).executeTool('get_capabilities', {});
      const routing = caps.catalog.routing;
      expect(routing.selectionKind).toBe('authority');
      expect(routing.toolsReachable).toBe(routing.toolsAdvertised);
      expect(routing.note).toContain('authority boundary');
    });
  });
});

describe('tools/list pagination', () => {
  const items = Array.from({ length: 25 }, (_, i) => `tool_${i}`);

  it('is off by default, because paging a client that ignores cursors is a silent truncation', () => {
    expect(resolvePageSize({})).toBe(0);
    expect(resolvePageSize({ PREMIERE_MCP_PAGE_SIZE: '0' })).toBe(0);
    expect(resolvePageSize({ PREMIERE_MCP_PAGE_SIZE: 'nonsense' })).toBe(0);
    expect(resolvePageSize({ PREMIERE_MCP_PAGE_SIZE: '-5' })).toBe(0);
    expect(resolvePageSize({ PREMIERE_MCP_PAGE_SIZE: '100' })).toBe(100);

    const all = paginate(items, undefined, 0);
    expect(all.page).toHaveLength(25);
    expect(all.nextCursor).toBeUndefined();
  });

  it('walks every item exactly once and stops without a cursor', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = paginate(items, cursor, 10);
      seen.push(...result.page);
      cursor = result.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against a cursor that never terminates
    } while (cursor !== undefined);

    expect(seen).toEqual(items);
    expect(pages).toBe(3);
  });

  it('emits no cursor when the last page lands exactly on the boundary', () => {
    const result = paginate(items.slice(0, 20), encodeCursor(10), 10);
    expect(result.page).toHaveLength(10);
    expect(result.nextCursor).toBeUndefined();
  });

  it('reads the cursor out of the request params, and treats junk as absent', () => {
    // The handler in src/index.ts is a self-starting entry point tests cannot import, so
    // this is where the params-reading it does gets checked.
    expect(cursorFromParams({ cursor: encodeCursor(10) })).toBe(encodeCursor(10));
    expect(cursorFromParams({})).toBeUndefined();
    expect(cursorFromParams(undefined)).toBeUndefined();
    expect(cursorFromParams({ cursor: '' })).toBeUndefined();
    expect(cursorFromParams({ cursor: 42 })).toBeUndefined();
  });

  it('flags a cursor it did not issue rather than restarting from the first page', () => {
    // Silently resuming from 0 would hand back page 1 forever and look like a short
    // catalogue — the failure mode this whole module exists to avoid.
    const result = paginate(items, 'not-a-cursor-we-issued', 10);
    expect(result.invalidCursor).toBe(true);
    expect(result.page).toEqual([]);
    expect(decodeCursor('not-a-cursor-we-issued')).toBeNull();
    expect(decodeCursor(encodeCursor(7))).toBe(7);
  });
});
