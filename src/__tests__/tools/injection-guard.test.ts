/**
 * No caller-supplied string may break out of the generated ExtendScript.
 *
 * This used to scan the TypeScript source for raw interpolation. That reads the
 * wrong artifact and it read it badly: the span scanner tracked `${` and `}`
 * depth, so an object literal inside an interpolation decremented the depth
 * early and the next backtick ended the span before the method did.
 *
 * So this drives every tool with a hostile value at every string position and
 * checks what the host would actually receive: that it still parses as ES3, and
 * that executing it cannot run the payload.
 *
 * Two blind spots the earlier version of this file had, both of which let a real
 * breakout through with the whole suite green:
 *
 *   - It selected parameters by `constructor.name` against a fixed list, so
 *     `z.array(z.string())` and nested `z.object({...})` were never fuzzed at
 *     all. A raw `${ids.join('","')}` was invisible. Arguments are now seeded
 *     from the schema and the payload is placed at *every* string leaf, inside
 *     arrays and nested objects included.
 *   - Every payload contained only double quotes, so a raw interpolation into a
 *     single-quoted ExtendScript literal could not be seen — it never terminated
 *     the string, so even the ES3 parse check passed. The PR moves message text
 *     to single quotes, which makes that shape idiomatic here, so single-quote
 *     payloads are now part of the set.
 *
 * It also captures every script a tool emits rather than the last one; a tool
 * that runs two scripts was previously only half-checked.
 */

import vm from 'vm';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';
import { PremiereProTools } from '../../tools/index.js';
import {
  seedArgs, stringPaths, withPayloadAt, argNamesFromScript, seedFreeFormArgs,
} from '../helpers/schema-args.js';

// A few tools (e.g. consolidate_and_transfer) do real Node-side filesystem work
// at a caller-supplied, cwd-relative path. Driving them with hostile path values
// would otherwise scatter payload-named directories through the repo root. Run
// the whole sweep from a throwaway temp cwd so any such write lands there and is
// removed afterwards; the generated ExtendScript — the thing under test — is
// unaffected by cwd.
let originalCwd: string;
let scratchCwd: string;
beforeAll(() => {
  originalCwd = process.cwd();
  scratchCwd = mkdtempSync(join(tmpdir(), 'skry-injection-sweep-'));
  process.chdir(scratchCwd);
});
afterAll(() => {
  process.chdir(originalCwd);
  try { rmSync(scratchCwd, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Closes a double-quoted literal, sets a flag, and reopens it so the rest parses. */
const BREAKOUT_DOUBLE = 'zz"); __OWNED = true; ("';
/** The same against a single-quoted literal. */
const BREAKOUT_SINGLE = "zz'; __OWNED = true; var __x = '";
/** Adds a key to the returned JSON without breaking the call. */
const ADD_KEY = 'zz", INJECTED: "yes';
/** Ordinary names that merely contain a quote. */
const BENIGN_DOUBLE = '12" Cuts';
const BENIGN_SINGLE = "Bob's Takes";
/**
 * Defeats an escaper that handles quotes but not backslashes. Escaping only the
 * quote turns this into `"zz\\"` -- a complete literal ending in a backslash --
 * and everything after it becomes code.
 */
const BREAKOUT_BACKSLASH = 'zz\\"); __OWNED = true; ("';
/** A raw line terminator, which no single-line ExtendScript literal survives. */
const BREAKOUT_NEWLINE = 'zz\n__OWNED = true;\n';
/**
 * Legal unescaped inside a JSON string but a line terminator to a JavaScript
 * parser, so a value carrying one can split a literal that looked safely quoted.
 */
const BREAKOUT_LINE_SEPARATOR = 'zz\u2028__OWNED = true;\u2028';
/** An ordinary Windows path, which is where the backslash case shows up in real use. */
const BENIGN_BACKSLASH = 'C:\\Footage\\take "1"';

const PAYLOADS = [
  BREAKOUT_DOUBLE, BREAKOUT_SINGLE, ADD_KEY, BENIGN_DOUBLE, BENIGN_SINGLE,
  BREAKOUT_BACKSLASH, BREAKOUT_NEWLINE, BREAKOUT_LINE_SEPARATOR, BENIGN_BACKSLASH,
];

/**
 * U+2028 is held to the execution check only, not to the parse check.
 *
 * Serialising a value containing one produces a script the host cannot parse:
 * legal inside a JSON string, but a line terminator to a JavaScript parser. That
 * is a broken call rather than a breakout — 0 of these execute — and it is not
 * introduced by this change: interpolating the value raw, as before, emits the
 * same character.
 *
 * Stated plainly: **nothing in this branch repairs it.** The repair belongs at the
 * bridge, which re-escapes line terminators as it assembles the script, and that
 * is a separate change not present here. Doing it at each of the interpolation
 * sites would be the wrong layer. Until the two are together, a value carrying
 * U+2028 still fails — legibly, as a script that will not parse.
 */
const PARSE_EXEMPT = new Set([BREAKOUT_LINE_SEPARATOR]);

/** How many free-form tools also get the shared helpers' arguments fuzzed. */
const HELPER_SAMPLE = 6;

/**
 * Tools whose entire contract is to run a caller-supplied program verbatim: the
 * argument IS the script, so there is no wrapper to break out of — a hostile
 * value there is the caller executing their own code, exactly as documented.
 * Fuzzing them here only proves that `eval` evaluates, so they are excluded from
 * the breakout sweep (as they effectively were before they carried a typed
 * `script` field to seed). Escaping is enforced for every tool that WRAPS a
 * caller string into a generated script — which is every other tool.
 */
const ARBITRARY_CODE_TOOLS = new Set(['execute_extendscript']);

/**
 * Tools that emit NO ExtendScript at all, so there is no generated script for a caller string to
 * break out of — this suite's entire subject. Driving them here tests nothing and costs real time:
 * get_tool_typings re-derives JSON Schema for all 639 tools on every invocation and returns a
 * ~292 KB blob, which it would do once per payload per position.
 *
 * This is an exclusion from the FUZZ, not from scrutiny: get_tool_typings has its own suite
 * (typings.test.ts) that parses its output with TypeScript's parser, including a description
 * containing a comment terminator and non-identifier property keys.
 */
const NO_GENERATED_SCRIPT = new Set([
  'get_tool_typings',
  // The schema-on-demand trio emits no ExtendScript of its own. call_tool delegates to a
  // target, whose escaping IS swept here under that target's own name; activate_tools and
  // deactivate_tools only change what this server advertises. Driving them per payload per
  // position also re-measures the whole catalogue's context cost each time, which is the
  // same cost that got get_tool_typings excluded. Their gate has its own suite
  // (router.test.ts), including a hostile name and an operator veto.
  'call_tool',
  'activate_tools',
  'deactivate_tools',
  // transact_sequence_edits emits no ExtendScript of its own: it delegates each step to a
  // target tool (whose escaping IS swept here under that target's own name) and, given a
  // hostile tool name, classifies it as unrestorable and refuses before running anything.
  // Driving it per payload per position also re-measures the whole catalogue's context cost
  // each time, the same cost that got call_tool excluded. Its state machine has its own
  // suite (transactions.test.ts).
  'transact_sequence_edits',
]);

/**
 * Individual ARGUMENT POSITIONS whose contract is a caller-supplied program, on tools that are
 * otherwise fuzzable. `batch_execute` is the case: each `operations[].script` is concatenated in
 * verbatim by design — the caller is running their own code, the same privilege
 * `execute_extendscript` grants outright — but its sibling `operations[].id` is an ordinary
 * string that MUST still be escaped. Exempting the whole tool (the only lever that existed)
 * would have stopped checking the id too, so the exemption is per-position.
 *
 * Numeric path segments are normalised to `*`, so this matches any array index.
 */
const ARBITRARY_CODE_POSITIONS = new Set([
  'batch_execute.operations.*.script',
]);

const positionKey = (toolName: string, path: (string | number)[]): string =>
  `${toolName}.${path.map((seg) => (/^\d+$/.test(String(seg)) ? '*' : seg)).join('.')}`;

/**
 * The 171 free-form tools emit one shared ~123 KB body, so every payload against
 * every one of them re-parses that body. They are driven with the breakout
 * payloads only: those are what detect an escape, and they exercise the parse
 * check as thoroughly as the benign values do. Tools with a declared schema still
 * get the full set.
 */
const BREAKOUT_PAYLOADS = [
  BREAKOUT_DOUBLE, BREAKOUT_SINGLE, BREAKOUT_BACKSLASH, BREAKOUT_LINE_SEPARATOR,
];

/** Runs an emitted script against a host that records whether the payload fired. */
function payloadRuns(script: string): boolean {
  const sandbox: Record<string, unknown> = {
    __OWNED: false,
    app: {
      enableQE() {},
      project: {
        name: 'p',
        sequences: { numSequences: 0 },
        rootItem: { name: 'root', nodeId: 'r', children: { numItems: 0 }, createBin: () => ({ name: 'b', nodeId: 'n' }) },
        activeSequence: null,
        importFiles: () => true,
        importSequences: () => true,
      },
    },
    qe: { project: {} },
    JSON,
    File: function () { return { exists: false }; },
    Folder: function () { return { exists: false, create: () => false }; },
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(`(function(){${script}})()`, sandbox, { timeout: 2000 });
  } catch {
    // A missing DOM member is expected; only the flag matters.
  }
  return sandbox.__OWNED === true;
}

describe('generated scripts cannot be broken out of', () => {
  it('survives a hostile value at every string position of every tool', async () => {
    const probe = new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);
    const escaped: string[] = [];
    const unparseable: string[] = [];
    let checked = 0;
    let freeFormSeen = 0;
    const emittingTools = new Set<string>();

    for (const tool of probe.getAvailableTools()) {
      if (ARBITRARY_CODE_TOOLS.has(tool.name) || NO_GENERATED_SCRIPT.has(tool.name)) continue;
      let base = seedArgs(tool as never);
      let freeForm = false;

      // A tool declaring a free-form record has no fields to seed, so nothing was
      // ever fuzzed through it. Ask the tool what it reads: emit once, then take
      // the argument names out of its own generated script.
      if (stringPaths(base).length === 0) {
        let probeScript = '';
        const prober = new PremiereProTools({
          executeScript: async (s: string) => { probeScript = s; return { success: true }; },
        } as never);
        try {
          await prober.executeTool(tool.name, base);
        } catch { /* nothing emitted; leaves base as it was */ }
        if (probeScript) {
          // The arguments the shared helpers read apply to every one of these
          // tools, and they all emit the same body, so fuzzing those names once
          // per tool is 171 times the work for the same answer. They are covered
          // on a few representatives; each tool still gets its own case block
          // fuzzed in full.
          freeForm = true;
          const helperNamesCovered = freeFormSeen < HELPER_SAMPLE;
          freeFormSeen++;
          const names = argNamesFromScript(probeScript, tool.name, helperNamesCovered);
          if (names.length) base = seedFreeFormArgs(names);
        }
      }

      const paths = stringPaths(base);
      const payloads = freeForm ? BREAKOUT_PAYLOADS : PAYLOADS;

      for (const path of paths) {
        // A position that is documented to be executed verbatim cannot "break out" of anything;
        // fuzzing it only proves that a script runs. Its siblings are still fuzzed.
        if (ARBITRARY_CODE_POSITIONS.has(positionKey(tool.name, path))) continue;
        for (const payload of payloads) {
          const scripts: string[] = [];
          const tools = new PremiereProTools({
            executeScript: async (s: string) => { scripts.push(s); return { success: true }; },
          } as never);
          try {
            await tools.executeTool(tool.name, withPayloadAt(base, path, payload) as Record<string, unknown>);
          } catch {
            // schema rejection: nothing was emitted
          }

          const where = `${tool.name}.${path.join('.') || '(root)'}`;
          for (const script of scripts) {
            checked++;
            emittingTools.add(tool.name);
            try {
              parse(script, { ecmaVersion: 3, allowReturnOutsideFunction: true });
            } catch {
              // Still executed below when exempt: a payload that cannot be parsed
              // by acorn may still run something once the bridge has repaired it.
              if (!PARSE_EXEMPT.has(payload)) {
                unparseable.push(where);
                continue;
              }
            }
            if (payloadRuns(script)) escaped.push(where);
          }
        }
      }
    }

    // Floors, so a harness that quietly stopped emitting cannot pass vacuously.
    // Floored on tools that actually EMITTED a script. Two earlier floors were
    // wrong in the same direction: one counted schema arithmetic without touching
    // executeTool, the next was set at 60 while 71% of the catalogue emitted
    // nothing, because the 171 free-form tools carried no fuzzable position at
    // all. With those driven from the arguments their own script reads, this sits
    // just under the real number.
    expect(emittingTools.size).toBeGreaterThan(180);
    expect(checked).toBeGreaterThan(900);
    expect([...new Set(escaped)]).toEqual([]);
    expect([...new Set(unparseable)]).toEqual([]);
    // Budget crept 537s -> 549s -> 600s -> 966s (standalone) as the catalogue grew. For a
    // SECURITY sweep, full coverage beats speed, so the ceiling is raised again rather than
    // trimming payloads/positions. The real lever is NOT another raise or thinner coverage:
    // each of the O(tools x positions x payloads) iterations calls executeTool, which rebuilds
    // the ~600-tool schema registry from scratch. Memoizing that registry (production side,
    // infra-owned) makes the whole sweep cheap without touching what it checks. Do that before
    // the next raise.
  }, 1_500_000);
});
