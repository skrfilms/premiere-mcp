/**
 * The one place the server states its own version. Hardcoded defaults drifted: the 1.3.0
 * release bumped package.json and the HTTP fallback but left MCP `initialize` reporting
 * 1.2.0. A literal rather than a runtime package.json read, because the jest transform
 * compiles to CommonJS where import.meta does not parse; src/__tests__/version.test.ts
 * fails whenever this and package.json disagree, so a release cannot bump only one.
 */
export const PACKAGE_VERSION = '1.3.1';
