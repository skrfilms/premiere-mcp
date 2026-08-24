/**
 * Jest global setup.
 *
 * The shipped DEFAULT tool profile is `core` (97 tools), because exposing all 638 costs about
 * half a 200k context window and exceeds VS Code's 128-tool ceiling. That is a deployment
 * decision and says nothing about whether a tool is correct, so the suites must see the whole
 * catalogue — otherwise every test of a non-core tool fails with "unknown tool" and reads as a
 * broken implementation rather than a hidden one. Seventy tests failed exactly that way when the
 * default changed.
 *
 * Tests that care about profile behaviour pass an explicit env object to resolveProfile /
 * applyProfile, so they are unaffected by this.
 */
process.env.PREMIERE_MCP_PROFILE = 'all';
