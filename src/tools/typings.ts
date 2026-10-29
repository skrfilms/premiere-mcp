/**
 * TypeScript declarations for the tool catalogue.
 *
 * Adobe's own (dormant) MCP server exposes a `getToolTypings` tool that returns a `.d.ts` blob
 * describing every registered tool, and instructs agents to fetch it BEFORE calling anything. That
 * is a strictly better answer to a large catalogue than prose descriptions: a shape mismatch
 * becomes a compile-time error in whatever the agent is authoring, rather than a runtime tool
 * failure it has to interpret from an error string.
 *
 * Generated from the SAME `z.toJSONSchema` output that `tools/list` serves, deliberately. Writing a
 * second interpretation of the Zod schemas would create two sources of truth that drift, and the
 * drift would be invisible — the typings would describe a tool that no longer takes those
 * arguments. One conversion, two renderings.
 */

/** The subset of JSON Schema the tool catalogue actually produces. */
export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
  description?: string;
  default?: unknown;
}

export interface TypingsTool {
  name: string;
  description?: string;
  jsonSchema: JsonSchemaNode;
}

/** A legal TypeScript identifier for a tool name, so `set-clip` style names cannot break output. */
function toInterfaceName(toolName: string): string {
  const camel = toolName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${camel || 'Tool'}Args`;
}

/** Quote a property key only when it is not a bare identifier. */
function propKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function scalarType(node: JsonSchemaNode): string {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (t) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    default:
      return 'unknown';
  }
}

/**
 * Render one schema node as a TypeScript type.
 *
 * Unknown or unrepresentable shapes become `unknown` rather than `any`: `any` would silently accept
 * a wrong argument, which is the opposite of what typings are for. `unknown` forces the author to
 * look at the tool.
 */
export function renderType(node: JsonSchemaNode | undefined, depth = 0): string {
  if (!node || depth > 6) return 'unknown';

  if (node.const !== undefined) return JSON.stringify(node.const);
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  }

  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const rendered = Array.from(new Set(variants.map((v) => renderType(v, depth + 1))));
    return rendered.length === 1 ? rendered[0]! : rendered.join(' | ');
  }
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    return node.allOf.map((v) => renderType(v, depth + 1)).join(' & ');
  }

  const t = Array.isArray(node.type) ? node.type[0] : node.type;

  if (t === 'array') return `Array<${renderType(node.items, depth + 1)}>`;

  if (t === 'object') {
    const props = node.properties ?? {};
    const keys = Object.keys(props);
    if (keys.length === 0) {
      // A free-form object. Record<string, unknown> is honest about accepting keys we cannot name.
      return typeof node.additionalProperties === 'object'
        ? `Record<string, ${renderType(node.additionalProperties, depth + 1)}>`
        : 'Record<string, unknown>';
    }
    const required = new Set(node.required ?? []);
    const indent = '  '.repeat(depth + 1);
    const body = keys
      .map(
        (k) =>
          `${indent}${propKey(k)}${required.has(k) ? '' : '?'}: ${renderType(props[k], depth + 1)};`,
      )
      .join('\n');
    return `{\n${body}\n${'  '.repeat(depth)}}`;
  }

  return scalarType(node);
}

/** Wrap a description as a JSDoc block at the given indent, or return '' when there is none. */
function docComment(text: string | undefined, indent: string): string {
  if (!text) return '';
  const lines = String(text).replace(/\*\//g, '*\\/').split('\n');
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

export interface TypingsOptions {
  /** Tool names the ACTIVE profile serves. Others are emitted but marked not callable. */
  exposedNames?: Set<string>;
  /** Restrict output to these names (after profile marking). */
  only?: string[];
}

/**
 * Build the `.d.ts` blob.
 *
 * Tools hidden by the active profile are still declared, marked `@profileHidden`, and left out of
 * the callable overloads. That mirrors how `find_tool` reports hidden matches: an agent can see the
 * capability exists and learn it needs a wider profile, instead of concluding the feature was never
 * built — which is the same class of lie as a fake success.
 */
export function generateToolTypings(tools: TypingsTool[], options: TypingsOptions = {}): string {
  const { exposedNames, only } = options;
  const selected = only && only.length ? tools.filter((t) => only.includes(t.name)) : tools;
  const sorted = [...selected].sort((a, b) => a.name.localeCompare(b.name));

  const out: string[] = [];
  out.push("// Generated from this build's tool schemas. Do not edit by hand.");
  out.push(
    '// Produced by get_tool_typings from the same z.toJSONSchema output that tools/list serves,',
  );
  out.push(
    '// so these declarations cannot drift from the schemas the server actually validates against.',
  );
  out.push('');
  out.push(`// ${sorted.length} tool${sorted.length === 1 ? '' : 's'} declared.`);
  if (exposedNames) {
    const hidden = sorted.filter((t) => !exposedNames.has(t.name)).length;
    if (hidden > 0) {
      out.push(
        `// ${hidden} of them are hidden by the active tool profile: declared here and marked`,
      );
      out.push(
        '// @profileHidden, but not callable until the profile is widened (see get_capabilities).',
      );
    }
  }
  out.push('');

  const callable: Array<{ name: string; iface: string }> = [];

  for (const tool of sorted) {
    const iface = toInterfaceName(tool.name);
    const exposed = !exposedNames || exposedNames.has(tool.name);
    const notes = exposed ? '' : '\n * @profileHidden Not callable under the active tool profile.';
    const rendered = renderType({ ...tool.jsonSchema, type: 'object' });
    // A tool with no parameters renders as Record<string, unknown>; declare it as an empty object
    // so callTool('ping', {}) type-checks without inviting arbitrary keys.
    const body = rendered === 'Record<string, unknown>' ? '{}' : rendered;
    // Doc comment and declaration are pushed as ONE entry: joining them with the array separator
    // put a blank line between them, which detaches the JSDoc from the interface in TypeScript and
    // loses every description in an editor — the main reason to emit typings at all.
    out.push(
      `${docComment(`${tool.description ?? tool.name}${notes}`, '')}export interface ${iface} ${body}`,
    );
    out.push('');
    if (exposed) callable.push({ name: tool.name, iface });
  }

  out.push('/** Every tool name this build implements. */');
  out.push(
    `export type ToolName =\n${sorted.map((t) => `  | ${JSON.stringify(t.name)}`).join('\n')};`,
  );
  out.push('');
  out.push('/** Tool names callable under the ACTIVE profile. */');
  out.push(
    callable.length
      ? `export type CallableToolName =\n${callable.map((t) => `  | ${JSON.stringify(t.name)}`).join('\n')};`
      : 'export type CallableToolName = never;',
  );
  out.push('');
  out.push('/** Argument type for a given tool name. */');
  out.push('export interface ToolArgs {');
  for (const t of sorted) out.push(`  ${propKey(t.name)}: ${toInterfaceName(t.name)};`);
  out.push('}');
  out.push('');
  out.push('/**');
  out.push(' * Overloaded call signature, one per callable tool, so a wrong argument shape is a');
  out.push(' * compile-time error rather than a runtime tool failure.');
  out.push(' */');
  for (const t of callable) {
    out.push(
      `export declare function callTool(name: ${JSON.stringify(t.name)}, params: ${t.iface}): Promise<unknown>;`,
    );
  }
  out.push('');

  return out.join('\n');
}
