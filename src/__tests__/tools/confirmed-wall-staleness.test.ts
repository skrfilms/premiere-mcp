/**
 * The honest wall must stay honest.
 *
 * `api_surface_report` publishes `confirmed_wall` — a list of things this server has
 * proved Premiere's scripting surface cannot do. An agent reads that list and STOPS
 * TRYING. So a stale entry is a lie in exactly the same class as a fake success: the
 * caller cannot detect it, and it costs them a capability they actually have.
 *
 * It has already happened once. The report listed the system clipboard as impossible
 * after we had cracked it Node-side, and published `total_tools: 600` against a
 * 638-tool build. Both were caught by a human reading the file, which is not a
 * mechanism. This suite is the mechanism.
 *
 * ── HOW STALENESS IS DETECTED ────────────────────────────────────────────────────
 *
 * Deliberately NOT by keyword matching. A wall entry about free-draw masks must not be
 * flagged because some unrelated tool has the word "mask" in its description, and the
 * word "graphics" appears in `build_motion_graphics_demo` and `get_graphics_white_luminance`
 * without either of them touching Essential Graphics authoring. Fuzzy matching here would
 * produce a test that cries wolf until someone deletes it, which is worse than no test.
 *
 * Instead every wall entry carries an explicit, machine-readable disproof contract in
 * WALL_CLAIMS below. Four independent signals, each exact:
 *
 *   1. `disprovingTools` — tool names that could only exist in this catalogue if the
 *      entry were false. Exact-name match against `getRegisteredTools()`. Ship
 *      `create_merged_clip` and the "merged clips creation" entry fails.
 *
 *   2. `shipsButInert` / `partialTools` — tools this build DOES ship that the entry
 *      talks about. Asserted PRESENT (an entry citing a tool we deleted describes a
 *      build that no longer exists), and cross-checked against the live sweep:
 *      an inert tool that starts reporting PASS_VERIFIED is a crack.
 *
 *   3. The live coverage sweep artifact (`.scratch/sweep/coverage-results.json`), which
 *      records a real per-tool outcome against a real host. This is the literal form of
 *      "a passing live test exercises this capability". `.scratch/` is gitignored, so
 *      this signal exists on a developer machine and NOT in CI — the test name says so
 *      rather than pretending the check ran.
 *
 *   4. `CRACKS-WALL: <id>` marker comments. When you write the test that proves a wall
 *      entry wrong, put that marker in it. This suite then fails until the entry is
 *      removed from `confirmed_wall`, and it fails pointing at your file and line.
 *      Unknown ids fail too, so a typo cannot silently disarm the marker.
 *
 * Plus the two failure modes that are not about any single entry:
 *
 *   - Coverage is 1:1 both ways. A NEW wall entry with no disproof contract fails this
 *     suite until someone writes one. An unchecked wall is how the last one went stale.
 *   - The published counts must be computed. `total_tools: 600` was a literal.
 *
 * Everything here is pure: no bridge, no host, no Premiere.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** A stub transport: nothing in this suite may reach a host. */
const noBridge = {
  executeScript: async () => {
    throw new Error('confirmed-wall staleness tests must not touch the bridge');
  },
} as any;

// ────────────────────────────────────────────────────────────────────────────────
// The disproof contracts
// ────────────────────────────────────────────────────────────────────────────────

interface WallClaim {
  /** Stable slug. This is what a `CRACKS-WALL:` marker names, so it must not churn. */
  id: string;
  /**
   * Exact prefix of the published `confirmed_wall` string. A prefix rather than the
   * whole string so the parenthetical evidence can be reworded without breaking the
   * link — but long enough that it cannot match a different entry.
   */
  entryPrefix: string;
  /**
   * Tool names whose mere presence in the catalogue disproves the entry. Every one of
   * these MUST be absent today; that absence is the assertion.
   */
  disprovingTools: string[];
  /** Required when `disprovingTools` is empty, so an empty list is a decision, not an oversight. */
  whyNoToolDisproof?: string;
  /**
   * Tools this build ships that the entry says are accepted-but-inert. Asserted present.
   * If the live sweep ever grades one PASS_VERIFIED, the entry is stale.
   */
  shipsButInert?: string[];
  /** Tools implementing the partial capability the entry itself concedes. Asserted present. */
  partialTools?: string[];
  /** Tools whose live outcome looks like a crack but is not, with the reason. */
  notACrack?: Record<string, string>;
}

const WALL_CLAIMS: WallClaim[] = [
  {
    id: 'free-draw-mask-geometry',
    entryPrefix: 'Free-draw shape mask geometry',
    // Reading or writing mask vertices is the whole capability; a tool that does it
    // could not be named anything but one of these.
    disprovingTools: [
      'set_mask_path',
      'get_mask_path',
      'set_mask_points',
      'create_shape_mask',
      'draw_mask',
    ],
  },
  {
    id: 'essential-sound-auto-tagging',
    entryPrefix: 'Essential Sound auto-tagging',
    disprovingTools: [
      'auto_tag_essential_sound',
      'analyze_essential_sound',
      'essential_sound_auto_tag',
    ],
    // The entry concedes the category can be written. That concession has a tool behind
    // it, and if the tool went away the entry would be overstating what we can do.
    partialTools: ['set_essential_sound_category'],
    notACrack: {
      set_essential_sound_category:
        'Writes the ESP category via metadata. The wall entry already says this is possible; ' +
        'what it denies is driving the automatic ANALYSIS, which no tool attempts.',
    },
  },
  {
    id: 'render-and-replace',
    entryPrefix: 'Render & Replace bake-to-media',
    disprovingTools: ['render_and_replace', 'render_replace_clip', 'bake_clip_to_media'],
    notACrack: {
      bake_speed_change:
        'Bakes a speed change by rewriting clip timing, not by rendering the clip out to new ' +
        'media and relinking. Different operation with a similar-sounding name — exactly the ' +
        'kind of collision a keyword matcher would get wrong.',
      bake_keyframe_ease: 'Writes keyframe interpolation. Nothing to do with rendering media.',
    },
  },
  {
    id: 'essential-graphics-authoring',
    entryPrefix: 'Essential Graphics advanced authoring',
    disprovingTools: [
      'create_essential_graphic',
      'author_essential_graphics',
      'add_shape_layer',
      'create_text_layer',
      'set_graphic_layer_property',
    ],
    notACrack: {
      add_text_overlay:
        'Creates a MOGRT/title from a template. Authoring layers inside the EGP is what is walled.',
      title_card: 'Same: template instantiation, not layer authoring.',
      build_motion_graphics_demo: 'A demo assembler over existing MOGRTs.',
      get_graphics_white_luminance: 'An HDR display setting. Shares only the word "graphics".',
    },
  },
  {
    id: 'merged-clips-creation',
    entryPrefix: 'Merged clips creation',
    disprovingTools: ['create_merged_clip', 'merge_clips', 'merge_audio_video'],
    notACrack: {
      link_audio_video:
        'Links existing timeline clips. A merged clip is a distinct project-item type that ' +
        'cannot be created by script; the DOM only exposes isMergedClip for detection.',
    },
  },
  {
    id: 'work-area-in-out',
    entryPrefix: 'Work area in/out',
    // There is no name-based disproof here, and that is the point: the tool already
    // EXISTS. The host accepts the call and does nothing. So the signal has to be the
    // live outcome, not the catalogue.
    disprovingTools: [],
    whyNoToolDisproof:
      'set_work_area already ships. The entry does not claim the tool is missing, it claims the ' +
      'host silently ignores it, so presence in the catalogue proves nothing. The crack would be ' +
      'set_work_area grading PASS_VERIFIED in a live sweep, which signal 3 checks.',
    shipsButInert: ['set_work_area'],
    notACrack: {
      clear_work_area:
        'Grades PASS_VERIFIED in the sweep, but that is the documented false pass from Tier 0 #3: ' +
        'its target already equalled the current state, so the check confirmed nothing. Not evidence ' +
        'the work area can be written.',
      get_work_area: 'Reading the work area works. The entry is about writing it.',
      is_work_area_enabled: 'Also a read.',
    },
  },
  {
    id: 'no-scripted-menu-bus',
    entryPrefix: 'app.findMenuCommandId / app.executeCommand are absent',
    disprovingTools: [
      'execute_menu_command',
      'find_menu_command_id',
      'run_menu_command',
      'invoke_menu_item',
    ],
  },
];

interface CrackedClaim {
  /** Exact string as published in `cracked_since`. */
  label: string;
  /** Tools that make the crack real. Asserted PRESENT, and asserted not-failing live. */
  provenByTools: string[];
}

const CRACKED_CLAIMS: CrackedClaim[] = [
  {
    // Removed from the wall once we did it Node-side via pbcopy/pbpaste. Recorded so it
    // cannot be re-added — and so that deleting the tools cannot leave the boast behind.
    label: 'Clipboard (system)',
    provenByTools: ['read_clipboard', 'write_clipboard'],
  },
];

// ────────────────────────────────────────────────────────────────────────────────
// Pure checkers. Exported shapes so the synthetic self-test at the bottom can prove
// each one actually fires — a staleness detector that cannot fail is decoration.
// ────────────────────────────────────────────────────────────────────────────────

interface Finding {
  wall: string;
  because: string;
}

const fmt = (findings: Finding[]): string =>
  findings
    .map((f) => `\n  STALE WALL ENTRY: "${f.wall}"\n    contradicted by: ${f.because}`)
    .join('');

/** Signal 1: a tool exists that could only exist if the entry were false. */
export function staleByCatalogue(claims: WallClaim[], registered: Map<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const claim of claims) {
    for (const name of claim.disprovingTools) {
      const description = registered.get(name);
      if (description === undefined) continue;
      findings.push({
        wall: claim.entryPrefix,
        because:
          `the catalogue registers a tool named '${name}' — "${description.slice(0, 120)}". ` +
          `Either remove the wall entry, or (if '${name}' does something else) rename it and ` +
          `drop it from disprovingTools for claim '${claim.id}'.`,
      });
    }
  }
  return findings;
}

/** The inverse lie: an entry citing tools this build no longer ships. */
export function unsupportedCaveats(
  claims: WallClaim[],
  registered: Map<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const claim of claims) {
    for (const name of [...(claim.shipsButInert ?? []), ...(claim.partialTools ?? [])]) {
      if (registered.has(name)) continue;
      findings.push({
        wall: claim.entryPrefix,
        because:
          `claim '${claim.id}' cites '${name}' as a tool this build ships, but it is not in the ` +
          `catalogue. The wall entry describes a build that no longer exists.`,
      });
    }
  }
  return findings;
}

/** Signal 3: a real host graded the capability as working. */
export function staleBySweep(claims: WallClaim[], outcomes: Map<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const claim of claims) {
    for (const name of claim.shipsButInert ?? []) {
      const outcome = outcomes.get(name);
      if (outcome !== 'PASS_VERIFIED') continue;
      findings.push({
        wall: claim.entryPrefix,
        because:
          `a live sweep graded '${name}' PASS_VERIFIED — the host read the value back. The entry ` +
          `says this call is accepted but inert, which is no longer true.`,
      });
    }
    for (const name of claim.disprovingTools) {
      const outcome = outcomes.get(name);
      if (outcome !== 'PASS' && outcome !== 'PASS_VERIFIED') continue;
      findings.push({
        wall: claim.entryPrefix,
        because: `a live sweep graded '${name}' ${outcome}.`,
      });
    }
  }
  return findings;
}

interface Marker {
  id: string;
  where: string;
}

/** Signal 4: someone wrote the test that cracks this and said so in a marker. */
export function staleByMarker(claims: WallClaim[], markers: Marker[]): Finding[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const findings: Finding[] = [];
  for (const marker of markers) {
    const claim = byId.get(marker.id);
    if (!claim) {
      findings.push({
        wall: `(no such claim id: ${marker.id})`,
        because:
          `${marker.where} carries a CRACKS-WALL marker for '${marker.id}', which matches no id in ` +
          `WALL_CLAIMS. Fix the typo, or add the claim — a marker nobody reads protects nothing.`,
      });
      continue;
    }
    findings.push({
      wall: claim.entryPrefix,
      because:
        `${marker.where} declares CRACKS-WALL: ${marker.id}. That test demonstrates the capability, ` +
        `so the entry must come out of confirmed_wall (and the label go into cracked_since).`,
    });
  }
  return findings;
}

/** cracked_since must not contradict the wall, in either direction. */
export function crackedContradictions(
  wall: string[],
  cracked: CrackedClaim[],
  registered: Map<string, string>,
  outcomes: Map<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const claim of cracked) {
    for (const entry of wall) {
      if (!entry.toLowerCase().includes(claim.label.toLowerCase())) continue;
      findings.push({
        wall: entry,
        because: `'${claim.label}' is listed in cracked_since AND still named on the wall. Pick one.`,
      });
    }
    for (const name of claim.provenByTools) {
      if (!registered.has(name)) {
        findings.push({
          wall: `cracked_since: ${claim.label}`,
          because:
            `the crack is credited to '${name}', which is not in the catalogue. The report is ` +
            `claiming a capability this build does not have — a fake success in list form.`,
        });
        continue;
      }
      const outcome = outcomes.get(name);
      if (outcome === 'FAIL') {
        findings.push({
          wall: `cracked_since: ${claim.label}`,
          because: `a live sweep graded '${name}' FAIL, so the crack has regressed and the claim is now false.`,
        });
      }
    }
  }
  return findings;
}

// ────────────────────────────────────────────────────────────────────────────────
// Loading the real data
// ────────────────────────────────────────────────────────────────────────────────

function registeredTools(): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of new PremiereProTools(noBridge).getRegisteredTools()) {
    map.set(tool.name, String((tool as { description?: string }).description ?? ''));
  }
  return map;
}

let cachedReport: Record<string, any> | null = null;
async function apiSurfaceReport(): Promise<Record<string, any>> {
  if (!cachedReport) {
    const tools = new PremiereProTools(noBridge);
    cachedReport = (await tools.executeTool(
      'api_surface_report',
      {},
      { allowUnexposed: true },
    )) as Record<string, any>;
  }
  return cachedReport;
}

/**
 * Live sweep outcomes, if a sweep has ever been run on this machine. `.scratch/` is
 * gitignored, so this returns an empty map in CI. Callers must say so rather than
 * reporting a check that did not happen.
 */
function sweepOutcomes(): { outcomes: Map<string, string>; sources: string[] } {
  const outcomes = new Map<string, string>();
  const sources: string[] = [];
  const candidates = [
    join(REPO_ROOT, '.scratch', 'sweep', 'coverage-results.json'),
    join(process.env.PREMIERE_TEMP_DIR || '/tmp/premiere-mcp-bridge', 'live-tool-sweep.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    if (results.length === 0) continue;
    sources.push(path);
    for (const record of results) {
      const name = record?.name;
      if (typeof name !== 'string') continue;
      // Highest-confidence grade wins across artifacts: a later verified pass supersedes
      // an earlier failure, because the wall is about what the host CAN do now.
      const grade = String(record?.outcome ?? '');
      const rank = (g: string) =>
        g === 'PASS_VERIFIED' ? 3 : g === 'PASS' ? 2 : g === 'FAIL' ? 1 : 0;
      const existing = outcomes.get(name);
      if (existing === undefined || rank(grade) > rank(existing)) outcomes.set(name, grade);
    }
  }
  return { outcomes, sources };
}

/** Walk src/ for `CRACKS-WALL: <id>` markers. */
function crackMarkers(): Marker[] {
  const markers: Marker[] = [];
  const selfName = 'confirmed-wall-staleness.test.ts';
  const pattern = /CRACKS-WALL:\s*([a-z0-9][a-z0-9-]*)/g;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      // This file documents the marker convention, so scanning it would flag every
      // entry the moment the docs mention one. It cannot itself crack anything.
      if (entry === selfName) continue;
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(pattern)) {
          const id = match[1];
          if (id) markers.push({ id, where: `${entry}:${index + 1}` });
        }
      });
    }
  };
  walk(join(REPO_ROOT, 'src'));
  return markers;
}

// ────────────────────────────────────────────────────────────────────────────────
// The suite
// ────────────────────────────────────────────────────────────────────────────────

describe('every confirmed_wall entry carries a disproof contract', () => {
  it('maps 1:1 onto WALL_CLAIMS, so a new entry cannot arrive unchecked', async () => {
    const wall: string[] = (await apiSurfaceReport()).confirmed_wall;
    expect(Array.isArray(wall)).toBe(true);

    const unclaimed = wall.filter(
      (entry) => !WALL_CLAIMS.some((c) => entry.startsWith(c.entryPrefix)),
    );
    expect(unclaimed).toEqual([]);

    const orphaned = WALL_CLAIMS.filter(
      (c) => !wall.some((entry) => entry.startsWith(c.entryPrefix)),
    );
    // An orphan is usually good news — the entry was removed because we cracked it — but
    // the claim has to go too, or the next reader thinks it is still being checked.
    expect(orphaned.map((c) => c.id)).toEqual([]);

    // One prefix must not swallow two entries, or the second goes unchecked while the
    // 1:1 count still looks right.
    for (const claim of WALL_CLAIMS) {
      expect(wall.filter((entry) => entry.startsWith(claim.entryPrefix))).toHaveLength(1);
    }
  });

  it('declares either a disproving tool or a documented reason there is none', () => {
    for (const claim of WALL_CLAIMS) {
      if (claim.disprovingTools.length > 0) continue;
      expect(typeof claim.whyNoToolDisproof).toBe('string');
      expect((claim.whyNoToolDisproof ?? '').length).toBeGreaterThan(40);
    }
  });

  it('uses unique claim ids, so a CRACKS-WALL marker is unambiguous', () => {
    const ids = WALL_CLAIMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the tool catalogue does not contradict the wall', () => {
  it('registers none of the tools that would disprove a wall entry', () => {
    const findings = staleByCatalogue(WALL_CLAIMS, registeredTools());
    if (findings.length > 0) throw new Error(`The honest wall has gone stale.${fmt(findings)}`);
  });

  it('still ships every tool a wall entry cites as inert or partial', () => {
    const findings = unsupportedCaveats(WALL_CLAIMS, registeredTools());
    if (findings.length > 0)
      throw new Error(`A wall entry cites a tool this build dropped.${fmt(findings)}`);
  });

  it('never names one of this build’s own tools inside the wall text', async () => {
    // Exact tool-name match on snake_case tokens only. Not keyword matching: "mask" or
    // "graphics" in an entry proves nothing, but `set_work_area` appearing in the prose
    // means the entry is talking about something we ship and must say which.
    const registered = registeredTools();
    const wall: string[] = (await apiSurfaceReport()).confirmed_wall;
    for (const entry of wall) {
      const claim = WALL_CLAIMS.find((c) => entry.startsWith(c.entryPrefix));
      const declared = new Set([...(claim?.shipsButInert ?? []), ...(claim?.partialTools ?? [])]);
      const tokens = entry.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? [];
      const undeclared = tokens.filter((t) => registered.has(t) && !declared.has(t));
      expect(undeclared).toEqual([]);
    }
  });
});

describe('the wall against real host outcomes', () => {
  const { outcomes, sources } = sweepOutcomes();

  // Named so the log cannot be misread: with no artifact present this asserts nothing
  // about the host. `.scratch/` is gitignored, so that is the CI case.
  it(`is not contradicted by any live sweep artifact present on this machine (${
    sources.length === 0
      ? 'NONE FOUND — this assertion is vacuous here'
      : `${outcomes.size} tool outcomes`
  })`, () => {
    const findings = staleBySweep(WALL_CLAIMS, outcomes);
    if (findings.length > 0) {
      throw new Error(
        `A live host contradicts the wall (from ${sources.join(', ')}).${fmt(findings)}`,
      );
    }
  });

  it('records whether the live signal was available, rather than implying it ran', () => {
    // The point of this assertion is the message, not the boolean: it forces the honest
    // scope into the test output either way.
    expect(sources.length === 0 || outcomes.size > 0).toBe(true);
  });
});

describe('CRACKS-WALL markers', () => {
  it('name no entry that is still on the wall, and no unknown claim id', () => {
    const findings = staleByMarker(WALL_CLAIMS, crackMarkers());
    if (findings.length > 0) {
      throw new Error(`A test in this repo claims to crack a live wall entry.${fmt(findings)}`);
    }
  });
});

describe('cracked_since', () => {
  it('does not contradict the wall or the catalogue', async () => {
    const report = await apiSurfaceReport();
    const { outcomes } = sweepOutcomes();
    const findings = crackedContradictions(
      report.confirmed_wall,
      CRACKED_CLAIMS,
      registeredTools(),
      outcomes,
    );
    if (findings.length > 0) throw new Error(`cracked_since is inconsistent.${fmt(findings)}`);
  });

  it('maps 1:1 onto CRACKED_CLAIMS', async () => {
    const published: string[] = (await apiSurfaceReport()).cracked_since;
    expect([...published].sort()).toEqual(CRACKED_CLAIMS.map((c) => c.label).sort());
  });
});

describe('the published counts are computed, not hardcoded', () => {
  it('matches the live registry and the active profile', async () => {
    const tools = new PremiereProTools(noBridge);
    const report = await apiSurfaceReport();
    expect(report.total_tools).toBe(tools.getRegisteredTools().length);
    expect(report.tools_exposed_by_active_profile).toBe(tools.getAvailableTools().length);
  });

  it('is not a literal in the source', () => {
    // `total_tools: 600` shipped against a 638-tool build. Equality against the live
    // registry above cannot catch that on its own — a literal that happens to be right
    // today passes, then rots. This reads the expression.
    const source = readFileSync(join(REPO_ROOT, 'src', 'tools', 'index.ts'), 'utf8');
    for (const key of ['total_tools', 'tools_exposed_by_active_profile']) {
      const match = new RegExp(`${key}:\\s*([^,\\n]+)`).exec(source);
      expect(match).not.toBeNull();
      const expression = (match?.[1] ?? '').trim();
      expect(expression).not.toMatch(/^\d+$/);
      expect(expression).toMatch(/\.length\b/);
    }
  });
});

describe('the staleness detector actually fires', () => {
  // A green suite that cannot go red is decoration. These feed each checker a synthetic
  // stale wall and assert it reports the contradiction, with the entry named.
  const claim: WallClaim = {
    id: 'synthetic',
    entryPrefix: 'Synthetic capability',
    disprovingTools: ['do_the_synthetic_thing'],
    shipsButInert: ['inert_tool'],
  };

  it('flags a wall entry once the disproving tool is registered', () => {
    const findings = staleByCatalogue([claim], new Map([['do_the_synthetic_thing', 'Does it.']]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.wall).toBe('Synthetic capability');
    expect(findings[0]?.because).toContain('do_the_synthetic_thing');
    expect(findings[0]?.because).toContain('Does it.');
  });

  it('does NOT flag on a keyword in an unrelated tool’s description', () => {
    // The false positive this design exists to avoid: a tool that merely mentions the
    // subject must not take down a wall entry.
    const unrelated = new Map([
      [
        'build_motion_graphics_demo',
        'Assembles a demo with a synthetic capability flavour and a mask',
      ],
      ['letterbox', 'Adds a synthetic capability style matte'],
    ]);
    expect(staleByCatalogue([claim], unrelated)).toEqual([]);
  });

  it('flags an inert tool that starts verifying live, but not one that merely passes', () => {
    expect(staleBySweep([claim], new Map([['inert_tool', 'PASS_VERIFIED']]))).toHaveLength(1);
    // PASS without a readback is the weaker grade and is not evidence of a write landing.
    expect(staleBySweep([claim], new Map([['inert_tool', 'PASS']]))).toEqual([]);
    expect(staleBySweep([claim], new Map([['inert_tool', 'FAIL']]))).toEqual([]);
  });

  it('flags a marker for a live entry, and a marker with an unknown id', () => {
    const live = staleByMarker([claim], [{ id: 'synthetic', where: 'some.test.ts:12' }]);
    expect(live).toHaveLength(1);
    expect(live[0]?.because).toContain('some.test.ts:12');

    const typo = staleByMarker([claim], [{ id: 'synthetc', where: 'some.test.ts:12' }]);
    expect(typo).toHaveLength(1);
    expect(typo[0]?.because).toContain('matches no id in WALL_CLAIMS');
  });

  it('flags an entry that cites a tool the build no longer ships', () => {
    const findings = unsupportedCaveats([claim], new Map());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.because).toContain('inert_tool');
  });

  it('flags a cracked label that is still on the wall, and one with no tool behind it', () => {
    const cracked: CrackedClaim[] = [{ label: 'Widget bus', provenByTools: ['use_widget_bus'] }];
    const both = crackedContradictions(
      ['Widget bus is unreachable on 26.3.2'],
      cracked,
      new Map([['use_widget_bus', 'Uses it.']]),
      new Map(),
    );
    expect(both).toHaveLength(1);
    expect(both[0]?.because).toContain('Pick one');

    const missingTool = crackedContradictions([], cracked, new Map(), new Map());
    expect(missingTool).toHaveLength(1);
    expect(missingTool[0]?.because).toContain('not in the catalogue');

    const regressed = crackedContradictions(
      [],
      cracked,
      new Map([['use_widget_bus', 'Uses it.']]),
      new Map([['use_widget_bus', 'FAIL']]),
    );
    expect(regressed).toHaveLength(1);
    expect(regressed[0]?.because).toContain('regressed');
  });
});
