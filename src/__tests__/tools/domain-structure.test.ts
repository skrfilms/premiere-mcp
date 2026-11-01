/**
 * How the tool domains fit together: each is a plain class on ToolsBase, and anything one
 * domain needs from another goes through the typed `peers`.
 *
 * The guard exists because of what flattening the old 20-level class chain found: four calls
 * reached the facade's executeTool through `(this as any)`, which the compiler cannot check and
 * no unit test exercised, so they broke silently and only the live workflow tests caught it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', '..', 'tools', 'domains');
const files = readdirSync(DIR).filter(
  (f) => f.endsWith('.ts') && f !== 'base.ts' && f !== 'shared.ts',
);

describe('tool domains', () => {
  it('finds the domains', () => {
    expect(files.length).toBeGreaterThanOrEqual(19);
  });

  it('each extends ToolsBase directly, never another domain', () => {
    const wrong = files.filter(
      (f) => !/export class \w+ extends ToolsBase \{/.test(readFileSync(join(DIR, f), 'utf8')),
    );
    expect(wrong).toEqual([]);
  });

  it('never calls through `this as any`, which hides a broken call from the compiler', () => {
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(join(DIR, f), 'utf8')
        .split('\n')
        .forEach((l, i) => {
          if (/\(this as any\)/.test(l)) offenders.push(`${f}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('the catalogue and the handlers agree', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PremiereProTools } = require('../../tools/index.js');
  const { isExpandedTool } = require('../../tools/expanded.js');
  const tools = new PremiereProTools({ executeScript: async () => ({ success: true }) });
  const handled = new Set(Object.keys(tools.handlers));
  const local: string[] = tools.getLocalTools().map((t: { name: string }) => t.name);
  // Dispatched before the handler map: rebuilt tools, and the expanded catalogue.
  const elsewhere = new Set(['freeze_frame', 'set_keyframe_interpolation']);

  it('every advertised local tool has a handler', () => {
    const missing = local.filter((n) => !handled.has(n) && !elsewhere.has(n) && !isExpandedTool(n));
    expect(missing).toEqual([]);
  });

  it('every handler belongs to a tool in the catalogue', () => {
    const all = new Set<string>(tools.getRegisteredTools().map((t: { name: string }) => t.name));
    expect([...handled].filter((n) => !all.has(n))).toEqual([]);
  });
});
