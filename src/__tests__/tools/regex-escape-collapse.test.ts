/**
 * A regex written inside a template literal reaches the host with its escapes ALREADY COLLAPSED.
 *
 * `generated-script-syntax.test.ts` describes this same hazard for `\"` and guards it by parsing
 * every emitted script. That guard cannot see this variant, because the damage is semantic rather
 * than syntactic: `/(.*[_\-v])(\d+)$/i` written single-backslash reaches Premiere as
 * `/(.*[_-v])(d+)$/i`, which parses perfectly. `\d` became the letter `d`, and `[_\-v]` — three
 * literal characters — became the character RANGE `_` through `v`.
 *
 * It shipped in version_up_sequence, where it meant no real sequence name ever matched, so every
 * call took the fall-through branch: `SHOW_008_0080_v001` was versioned up to
 * `SHOW_008_0080_v001_v002` rather than `SHOW_008_0080_v002`. Silent, plausible-looking output.
 *
 * Two checks, on two different artifacts, because neither alone is sufficient:
 *
 *   1. The EMITTED script, for the tool that carried the bug. This is the artifact that matters,
 *      and the check is behavioural — the regex is pulled out and run against real names.
 *   2. The SOURCE, swept for the general class. Once the escapes have collapsed, `(d+)` is
 *      indistinguishable from a deliberate `(d+)`, so the emitted script simply does not carry the
 *      evidence. Single-vs-double backslash exists only in the source, which makes the source the
 *      correct artifact for THIS defect — the opposite of the usual rule, and the reason it is
 *      spelled out here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PremiereProTools } from '../../tools/index.js';

/** Emit one tool's ExtendScript without touching Premiere. */
const capture = async (name: string, args: Record<string, unknown>): Promise<string> => {
  let script = '';
  const tools = new PremiereProTools({
    executeScript: async (source: string) => {
      script = source;
      return { success: true, data: {} };
    },
  } as never);
  try {
    await tools.executeTool(name, args, { allowUnexposed: true } as never);
  } catch {
    // Emission is what is under test; a later failure against the fake host is not.
  }
  return script;
};

describe('a regex emitted into ExtendScript keeps the escapes it was written with', () => {
  it('version_up_sequence matches a real versioned name instead of falling through', async () => {
    const script = await capture('version_up_sequence', {});
    expect(script).not.toBe('');

    const literal = /name\.match\((\/.*?\/[gimsuy]*)\)/.exec(script);
    expect(literal).not.toBeNull();
    const source = literal![1]!;

    // The collapsed form contained a bare `d` quantified as a digit class would be. Naming the
    // broken string directly is what makes this test fail if the escape is ever un-doubled.
    expect(source).not.toContain('(d+)');
    expect(source).toContain('\\d');

    // Behavioural, not textual: build the regex the host would build and run it.
    const body = source.slice(1, source.lastIndexOf('/'));
    const flags = source.slice(source.lastIndexOf('/') + 1);
    const re = new RegExp(body, flags);

    const bumped = (name: string): string => {
      const m = name.match(re);
      if (!m) return `${name}_v002`; // the tool's fall-through branch
      const num = String(parseInt(m[2]!, 10) + 1).padStart(m[2]!.length, '0');
      return m[1]! + num;
    };

    // A real-world shot-naming convention, which is what the shipped bug got wrong.
    expect(bumped('SHOW_008_0080_v001')).toBe('SHOW_008_0080_v002');
    expect(bumped('SHOW_008_0700_genAI_v001')).toBe('SHOW_008_0700_genAI_v002');
    expect(bumped('shot_v01')).toBe('shot_v02');
    expect(bumped('shot_v009')).toBe('shot_v010');
    // A name with no version still appends, which is the intended fall-through.
    expect(bumped('Reel 1')).toBe('Reel 1_v002');
  });

  it('no regex inside an emitted-script template literal carries a single-backslash class escape', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__' && entry !== 'node_modules') walk(full);
        } else if (entry.endsWith('.ts')) {
          files.push(full);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);

    // \d \s \w \b and friends: valid in a regex, consumed by the template literal first.
    const classEscape = /(?<!\\)\\[dswDSWbB]/;
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      // Track template-literal depth by counting unescaped backticks, which is enough here: the
      // emitted scripts are plain (non-nested) template literals passed to executeScript.
      let inTemplate = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (inTemplate) {
          for (const match of line.matchAll(/\/[^/\n\s][^/\n]*\/[gimsuy]*/g)) {
            if (classEscape.test(match[0])) {
              offenders.push(`${file.slice(root.length + 1)}:${i + 1}  ${match[0].slice(0, 70)}`);
            }
          }
        }
        let ticks = 0;
        for (let c = 0; c < line.length; c++) {
          if (line[c] === '`' && line[c - 1] !== '\\') ticks++;
        }
        if (ticks % 2 === 1) inTemplate = !inTemplate;
      }
    }

    expect(offenders).toEqual([]);
  });
});
