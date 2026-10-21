/**
 * Generated ExtendScript may only call methods this engine actually has.
 *
 * "ExtendScript is ES3" is the rule of thumb, and it is wrong in both directions — which is why
 * this suite exists with a MEASURED table rather than a remembered one. Probed live against
 * Premiere Pro 26.3.2 on 2026-08-24:
 *
 *   PRESENT:  Array.prototype.map, Array.prototype.filter, Array.prototype.indexOf,
 *             Array.isArray, JSON.stringify (the latter installed by the bridge prelude)
 *   ABSENT:   Array.prototype.forEach, find, findIndex, some, every, reduce, lastIndexOf,
 *             String.prototype.trim, startsWith, endsWith, includes, padStart, padEnd, repeat,
 *             Function.prototype.bind, Object.keys, Object.assign, Set, Map
 *
 * The selective shape is the point: it has map/filter/indexOf but not forEach/some/every/reduce,
 * so no single-sentence rule predicts it. Every entry below was probed with typeof against the
 * live host, not inferred.
 *
 * Both halves matter. Believing `map` was absent nearly cost 13 working call sites a pointless
 * rewrite; believing `trim` was present cost `grade_snapshot` its entire output — it threw
 * `ReferenceError: " a ".trim is not a function` on every call, and the live sweep is what
 * surfaced it. A static suite can catch this class outright, so it should.
 *
 * Scope note: only the script text SENT TO THE HOST is checked. Node-side TypeScript in the same
 * file is free to use anything, and an earlier hand audit of the source produced false positives
 * precisely because it could not tell the two apart. Driving the tools and capturing what they
 * emit removes the ambiguity.
 */
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';

// A few tools (e.g. consolidate_and_transfer) do real Node-side filesystem work at a
// caller-supplied, cwd-relative path, so driving the whole catalogue from the repo root scattered
// directories named after the seeded path values ("x", and the hostile values the sibling sweeps
// use) through the working tree. Run from a throwaway temp cwd instead; the generated
// ExtendScript — the only thing this suite reads — does not depend on cwd. The same guard is in
// injection-guard.test.ts, undefined-identifiers.test.ts and generated-script-syntax.test.ts.
let originalCwd: string;
let scratchCwd: string;
beforeAll(() => {
  originalCwd = process.cwd();
  scratchCwd = mkdtempSync(join(tmpdir(), 'skry-es3-sweep-'));
  process.chdir(scratchCwd);
});
afterAll(() => {
  process.chdir(originalCwd);
  try { rmSync(scratchCwd, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Methods the host engine does not have. Adding one here is a claim that must be measured. */
const ABSENT: Array<{ pattern: RegExp; name: string; use: string }> = [
  { pattern: /\.trim\s*\(/g, name: "String.prototype.trim", use: "s.replace(/^\\s+|\\s+$/g,'')" },
  { pattern: /\.startsWith\s*\(/g, name: 'String.prototype.startsWith', use: 's.indexOf(x) === 0' },
  { pattern: /\.endsWith\s*\(/g, name: 'String.prototype.endsWith', use: 's.slice(-x.length) === x' },
  { pattern: /\.includes\s*\(/g, name: 'String/Array.prototype.includes', use: 's.indexOf(x) !== -1' },
  { pattern: /\.forEach\s*\(/g, name: 'Array.prototype.forEach', use: 'a plain for loop' },
  { pattern: /\bObject\.keys\s*\(/g, name: 'Object.keys', use: 'for (var k in obj) with a hasOwnProperty guard' },
  { pattern: /\bnew\s+Set\s*\(/g, name: 'Set', use: 'a plain object used as a lookup table' },
  { pattern: /\bnew\s+Map\s*\(/g, name: 'Map', use: 'a plain object' },
  // Added after frames_to_timecode threw "String().padStart is not a function" on a live host.
  { pattern: /\.padStart\s*\(/g, name: 'String.prototype.padStart', use: "a while loop, or __padLeft in the prelude" },
  { pattern: /\.padEnd\s*\(/g, name: 'String.prototype.padEnd', use: 'a while loop' },
  { pattern: /\.repeat\s*\(/g, name: 'String.prototype.repeat', use: 'a while loop' },
  { pattern: /\.findIndex\s*\(/g, name: 'Array.prototype.findIndex', use: 'a for loop' },
  { pattern: /\.some\s*\(/g, name: 'Array.prototype.some', use: 'a for loop with an early return' },
  { pattern: /\.every\s*\(/g, name: 'Array.prototype.every', use: 'a for loop with an early return' },
  { pattern: /\.reduce\s*\(/g, name: 'Array.prototype.reduce', use: 'a for loop with an accumulator' },
  { pattern: /\.lastIndexOf\s*\(/g, name: 'Array.prototype.lastIndexOf', use: 'a reverse for loop' },
  { pattern: /\bObject\.assign\s*\(/g, name: 'Object.assign', use: 'explicit property copies' },
];

/**
 * Tools whose argument IS a program: whatever the caller writes is theirs to get wrong, and the
 * seeded fixture value would be reported as our bug.
 */
const ARBITRARY = new Set(['execute_extendscript', 'evaluate_expression', 'batch_execute']);

/** Plausible values by parameter name, so tools emit a script instead of failing their schema. */
function seed(tool: any): Record<string, unknown> {
  const shape = tool.inputSchema?._def?.shape ?? tool.inputSchema?.shape;
  let keys: string[] = [];
  try { keys = Object.keys(typeof shape === 'function' ? shape() : (shape ?? {})); } catch { keys = []; }
  const args: Record<string, unknown> = {};
  for (const k of keys) {
    if (/Id$/i.test(k)) args[k] = 'seed-id';
    else if (/Ids$/i.test(k)) args[k] = ['seed-id'];
    else if (/Path$/i.test(k)) args[k] = '/tmp/es3-probe.mp4';
    else if (/Index$/i.test(k)) args[k] = 0;
    else if (/^(enabled|reverse|recursive|includeAudio|suppressUI|visible|locked|muted)$/i.test(k)) args[k] = true;
    else if (/(seconds|time|duration|inPoint|outPoint|value|amount|level|gain|opacity|scale|rotation|frames|count|limit|width|height|index)$/i.test(k)) args[k] = 1;
    else if (/^(adjustments|params|options|settings|properties|metadata)$/i.test(k)) args[k] = { brightness: 1 };
    else args[k] = 'seed';
  }
  return args;
}

describe('generated ExtendScript avoids methods this engine does not have', () => {
  // POSITIVE CONTROL on the DETECTOR, not on the seeding.
  //
  // The sweep-driven check below can only inspect tools that accept its synthesised arguments
  // (~57 of them), so a green result there is partly a statement about seeding. What must never
  // silently break is the detection itself — a regex that stops matching would make this whole
  // suite pass vacuously. This asserts the patterns fire against known-bad text, which is exactly
  // the shape of the code that shipped in grade_snapshot and threw on every call.
  it('detects the absent-method calls it is looking for', () => {
    const knownBad = "var t = name.trim(); if (s.startsWith('_')) {} arr.forEach(function(x){}); Object.keys(o); var q = new Set(); var p = String(h).padStart(2,'0'); arr.reduce(function(a,b){return a;});";
    const fired = ABSENT.filter(({ pattern }) => { pattern.lastIndex = 0; return pattern.test(knownBad); }).map((a) => a.name);
    expect(fired).toEqual(expect.arrayContaining([
      'String.prototype.trim',
      'String.prototype.startsWith',
      'Array.prototype.forEach',
      'Object.keys',
      'Set',
      'String.prototype.padStart',
      'Array.prototype.reduce',
    ]));
    // And it must not fire on the ES3-safe replacements the codebase uses instead.
    const knownGood = "var t = name.replace(/^\\s+|\\s+$/g,''); if (s.indexOf('_') === 0) {} for (var k in o) {} var m = [1].map(function(x){return x;});";
    const falsePositives = ABSENT.filter(({ pattern }) => { pattern.lastIndex = 0; return pattern.test(knownGood); }).map((a) => a.name);
    expect(falsePositives).toEqual([]);
  });

  it('emits no call to a measured-absent built-in', async () => {
    const probe = new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);
    const offenders: string[] = [];
    let scriptsChecked = 0;
    const toolsEmitting = new Set<string>();

    // The FULL catalogue, not the active profile: every implemented tool must be safe to call,
    // and the default profile now exposes only a curated subset.
    for (const tool of probe.getRegisteredTools()) {
      if (ARBITRARY.has(tool.name)) continue;

      const scripts: string[] = [];
      const tools = new PremiereProTools({
        executeScript: async (s: string) => { scripts.push(s); return { success: true }; },
      } as never);
      try {
        await tools.executeTool(tool.name, seed(tool));
      } catch {
        // Schema rejection: nothing was emitted, nothing to check.
      }

      for (const script of scripts) {
        scriptsChecked++;
        toolsEmitting.add(tool.name);
        for (const { pattern, name, use } of ABSENT) {
          pattern.lastIndex = 0;
          if (pattern.test(script)) offenders.push(`${tool.name}: calls ${name} — use ${use}`);
        }
      }
    }

    // Honest floor. Only ~57 tools emit under name-pattern seeding; the rest reject these
    // arguments at their schema and emit nothing, so they are NOT covered here. Raising this
    // number requires better argument synthesis, not a bigger assertion — the same limit that
    // caps the live coverage sweep.
    expect(toolsEmitting.size).toBeGreaterThan(50);
    expect(scriptsChecked).toBeGreaterThan(50);
    expect([...new Set(offenders)]).toEqual([]);
  }, 300_000);
});
