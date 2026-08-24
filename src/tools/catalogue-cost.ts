/**
 * Context cost of the tool catalogue — measured, not asserted.
 *
 * Published guidance on this is unambiguous and we were on the wrong side of it:
 *
 *  - Anthropic: *"Claude's ability to pick the right tool degrades once you exceed
 *    30-50 available tools."* Their Tool Search Tool measurements show Opus 4 going
 *    from 49% to 74% and Opus 4.5 from 79.5% to 88.1% on large tool libraries once
 *    tools are searched rather than all loaded up front.
 *  - MCP's own client best-practices doc: *"Loading every tool definition into the
 *    model's context window upfront wastes tokens, increases latency, and degrades
 *    model performance"*, and recommends deferring past a threshold of **1-5% of the
 *    context window**. Claude Code's own `ENABLE_TOOL_SEARCH=auto` defers everything
 *    once definitions reach **10%**.
 *  - VS Code / Copilot hard-errors above **128** tools in one request.
 *
 * This server's full catalogue is far past all of those. Rather than quietly hope, we
 * measure the real `tools/list` payload and publish the number through
 * `get_capabilities`, plus a one-line advisory on stderr at startup. A server that
 * refuses to fake a successful edit should not fake a comfortable tool budget either.
 *
 * The token figure is an ESTIMATE (chars / 4) and says so everywhere it appears. It is
 * not a tokenizer; it is the right order of magnitude and it is honest about that.
 */

/** Rough chars-per-token for English + JSON. Deliberately crude and labelled as such. */
const CHARS_PER_TOKEN = 4;

/** Context windows we report against, so the percentage means something concrete. */
const REFERENCE_CONTEXT_TOKENS = 200_000;

/** Above this, VS Code / GitHub Copilot rejects the request outright. */
export const COPILOT_TOOL_LIMIT = 128;

/** Above this, Anthropic reports tool-selection accuracy degrading. */
export const SELECTION_DEGRADATION_THRESHOLD = 50;

export interface CatalogueCost {
  toolsExposed: number;
  /** Serialized size of the tools/list payload, in characters. Exact. */
  payloadChars: number;
  /** chars / 4. An estimate, not a tokenizer result. */
  approxTokens: number;
  approxTokensPerTool: number;
  /** Share of a 200k-token context window consumed before the first message. */
  percentOfReferenceContext: number;
  referenceContextTokens: number;
  /** True when a Copilot/VS Code client would refuse this list outright. */
  exceedsCopilotToolLimit: boolean;
  /** True when past the count where Anthropic reports selection accuracy dropping. */
  exceedsSelectionDegradationThreshold: boolean;
  /** Plain-English reading of the numbers above, safe to show a human. */
  assessment: string;
  /** What to actually do about it. */
  guidance: string[];
}

/**
 * Measure the cost of a serialized tool list.
 *
 * `payloadChars` is passed in rather than computed here so the caller can measure the
 * *real* payload it is about to send (descriptions + JSON Schema + annotations),
 * instead of this module guessing at a serialization it does not own.
 */
export function describeCatalogueCost(toolsExposed: number, payloadChars: number): CatalogueCost {
  const approxTokens = Math.round(payloadChars / CHARS_PER_TOKEN);
  const percent = (approxTokens / REFERENCE_CONTEXT_TOKENS) * 100;
  const overCopilot = toolsExposed > COPILOT_TOOL_LIMIT;
  const overSelection = toolsExposed > SELECTION_DEGRADATION_THRESHOLD;

  const guidance: string[] = [];
  if (overSelection) {
    guidance.push(
      'Set PREMIERE_MCP_PROFILE to a curated profile (see get_capabilities for the list) ' +
        'so the client is offered a smaller, higher-signal menu. "core" is the everyday ' +
        'editorial set; "read-only" is safe for an untrusted agent.',
    );
    guidance.push(
      'Or set PREMIERE_MCP_TOOLS to an exact allowlist of just the tools your workflow ' +
        'needs, and PREMIERE_MCP_EXCLUDE to drop families you never use.',
    );
    guidance.push(
      'Call find_tool to search the catalogue by keyword instead of relying on the whole ' +
        'list being in context. It is always exposed, even under the tightest profile.',
    );
  }
  if (overCopilot) {
    guidance.push(
      `VS Code / GitHub Copilot rejects a request with more than ${COPILOT_TOOL_LIMIT} tools ` +
        'enabled, so this profile will not work there at all. Curate before using those clients.',
    );
  }
  if (!overSelection) {
    guidance.push('This profile is within the range where tool selection is reliable.');
  }

  let assessment: string;
  if (!overSelection) {
    assessment =
      `${toolsExposed} tools, about ${approxTokens} estimated tokens ` +
      `(~${percent.toFixed(1)}% of a ${REFERENCE_CONTEXT_TOKENS / 1000}k context). Within published guidance.`;
  } else {
    assessment =
      `${toolsExposed} tools cost roughly ${approxTokens} estimated tokens of context ` +
      `(~${percent.toFixed(1)}% of a ${REFERENCE_CONTEXT_TOKENS / 1000}k window) before the ` +
      'conversation starts. Anthropic reports tool-selection accuracy degrading past ' +
      `${SELECTION_DEGRADATION_THRESHOLD} tools, and MCP guidance recommends deferring tool ` +
      'definitions once they reach 1-10% of the window. This is a real cost, not a feature: ' +
      'the breadth is only an asset if the client curates or searches rather than loading ' +
      'everything. Clients that defer MCP tools (Claude Code does by default) are unaffected.';
  }

  return {
    toolsExposed,
    payloadChars,
    approxTokens,
    approxTokensPerTool: toolsExposed > 0 ? Math.round(approxTokens / toolsExposed) : 0,
    percentOfReferenceContext: Math.round(percent * 10) / 10,
    referenceContextTokens: REFERENCE_CONTEXT_TOKENS,
    exceedsCopilotToolLimit: overCopilot,
    exceedsSelectionDegradationThreshold: overSelection,
    assessment,
    guidance,
  };
}

/**
 * One-line startup advisory for stderr, or null when the profile is already sane.
 * stderr is the right channel: it reaches the operator without polluting the protocol
 * stream, and it is where an operator looks when an agent picks the wrong tool.
 */
export function startupAdvisory(cost: CatalogueCost): string | null {
  if (!cost.exceedsSelectionDegradationThreshold) return null;
  const copilot = cost.exceedsCopilotToolLimit
    ? ` VS Code/Copilot rejects >${COPILOT_TOOL_LIMIT} tools outright.`
    : '';
  return (
    `[premiere-mcp] Exposing ${cost.toolsExposed} tools (~${cost.approxTokens} est. tokens, ` +
    `~${cost.percentOfReferenceContext}% of a 200k context). Published guidance puts reliable ` +
    `tool selection under ~${SELECTION_DEGRADATION_THRESHOLD} tools.${copilot} ` +
    'Set PREMIERE_MCP_PROFILE=core (or read-only / audio / color), or PREMIERE_MCP_TOOLS=<allowlist>, ' +
    'to curate. find_tool searches the full catalogue either way.'
  );
}
