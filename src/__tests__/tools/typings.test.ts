/**
 * The generated typings must be VALID TYPESCRIPT, not merely plausible text.
 *
 * A `.d.ts` blob is the one artifact where "looks right" is worthless: an agent feeds it to a
 * compiler, and a single malformed interface makes the whole file useless while the tool that
 * produced it still reported success. So the check here is to parse the real output with
 * TypeScript's own parser and assert zero syntactic diagnostics — the same
 * verify-the-effect-not-the-call rule the Premiere tools follow, applied to our own generator.
 */
import ts from 'typescript';
import { PremiereProTools } from '../../tools/index.js';
import { generateToolTypings, renderType } from '../../tools/typings.js';

/** Parse as a declaration file and return syntactic diagnostics. */
function syntaxErrors(source: string): string[] {
  const file = ts.createSourceFile('premiere-mcp-tools.d.ts', source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  // `parseDiagnostics` is internal but is the only way to get syntax errors without a Program.
  const diags = (file as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.map((d) => `${ts.flattenDiagnosticMessageText(d.messageText, ' ')} @${d.start ?? -1}`);
}

describe('renderType', () => {
  it('maps the schema shapes the catalogue actually produces', () => {
    expect(renderType({ type: 'string' })).toBe('string');
    expect(renderType({ type: 'integer' })).toBe('number');
    expect(renderType({ type: 'boolean' })).toBe('boolean');
    expect(renderType({ type: 'array', items: { type: 'string' } })).toBe('Array<string>');
    expect(renderType({ enum: ['video', 'audio'] })).toBe('"video" | "audio"');
    expect(renderType({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number');
    expect(renderType({ type: 'object', additionalProperties: { type: 'string' } })).toBe('Record<string, string>');
  });

  it('uses unknown rather than any for shapes it cannot express', () => {
    // `any` would silently accept a wrong argument, which defeats the purpose of typings.
    expect(renderType(undefined)).toBe('unknown');
    expect(renderType({})).toBe('unknown');
  });

  it('marks optional properties optional and required ones required', () => {
    const rendered = renderType({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
    expect(rendered).toContain('a: string;');
    expect(rendered).toContain('b?: number;');
  });

  it('terminates on a self-referential schema instead of recursing forever', () => {
    const node: Record<string, unknown> = { type: 'object' };
    node.properties = { self: node };
    expect(() => renderType(node as never)).not.toThrow();
  });
});

describe('generateToolTypings', () => {
  it('attaches the description to the interface with no blank line between them', () => {
    // A blank line detaches the JSDoc from the declaration, so every description disappears in an
    // editor — which is most of the value. This regressed once already.
    const out = generateToolTypings([
      { name: 'add_marker', description: 'Adds a marker.', jsonSchema: { type: 'object', properties: { time: { type: 'number' } }, required: ['time'] } },
    ]);
    expect(out).toContain('/** Adds a marker. */\nexport interface AddMarkerArgs');
  });

  it('declares a profile-hidden tool but leaves it out of the callable overloads', () => {
    const out = generateToolTypings(
      [
        { name: 'visible_tool', jsonSchema: { type: 'object' } },
        { name: 'hidden_tool', jsonSchema: { type: 'object' } },
      ],
      { exposedNames: new Set(['visible_tool']) },
    );
    // Present and explained, not omitted: an agent must be able to tell "hidden by profile" from
    // "never implemented".
    expect(out).toContain('HiddenToolArgs');
    expect(out).toContain('@profileHidden');
    expect(out).toContain('export declare function callTool(name: "visible_tool"');
    expect(out).not.toContain('export declare function callTool(name: "hidden_tool"');
  });

  it('produces syntactically valid TypeScript for awkward names and empty schemas', () => {
    const out = generateToolTypings([
      { name: 'weird-name.with punctuation', description: 'Has */ a comment terminator', jsonSchema: { type: 'object', properties: { 'not-an-identifier': { type: 'string' } } } },
      { name: 'no_params', jsonSchema: { type: 'object' } },
    ]);
    expect(syntaxErrors(out)).toEqual([]);
    expect(out).toContain('"not-an-identifier"?: string;');
  });
});

describe('get_tool_typings over the real catalogue', () => {
  it('emits valid TypeScript for every registered tool', async () => {
    const tools = new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);
    const result = await tools.executeTool('get_tool_typings', {});

    expect(result.success).toBe(true);
    // Floor, so a generator that silently stopped emitting cannot pass vacuously.
    expect(result.toolsDeclared).toBeGreaterThan(500);
    expect(syntaxErrors(result.typings)).toEqual([]);
  }, 120_000);

  it('makes no Premiere request', async () => {
    // Purely local: the stub throws if the bridge is touched at all.
    const tools = new PremiereProTools({
      executeScript: async () => { throw new Error('get_tool_typings must not touch the host'); },
    } as never);
    const result = await tools.executeTool('get_tool_typings', { only: ['ping'] });
    expect(result.success).toBe(true);
  });

  it('reports a requested name that is not a tool instead of dropping it', async () => {
    const tools = new PremiereProTools({ executeScript: async () => ({ success: true }) } as never);
    const result = await tools.executeTool('get_tool_typings', { only: ['add_marker', 'definitely_not_a_tool'] });
    expect(result.unknownToolNames).toEqual(['definitely_not_a_tool']);
    expect(result.toolsDeclared).toBe(1);
  });
});
