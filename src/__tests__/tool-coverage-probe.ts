/**
 * Records which tools the test suite actually invokes.
 *
 * The honest question "how much of this catalogue is exercised at all?" was previously answered
 * by grepping test files for tool names. That gives a floor, not a measurement: a name appears in
 * a table of expected strings without ever being dispatched, and a name assembled at runtime
 * (`\`get_${kind}_info\``) never appears at all. Both directions of error, and no way to tell
 * which you got.
 *
 * So the suite measures itself. This module wraps `PremiereProTools.prototype.executeTool` and
 * appends a line the first time each tool is dispatched, per test file. `npm run coverage:tools`
 * aggregates those lines into verification/test-coverage.json and regenerates
 * docs/TOOL-COVERAGE.md, and a drift test byte-compares the document against the data — the same
 * mechanism as the live-verification ledger, for the same reason.
 *
 * Off unless PREMIERE_MCP_TOOL_COVERAGE=1, so an ordinary `npm test` pays nothing for it and
 * cannot be made to fail by it.
 *
 * What this measures and what it does not: an invocation here went through the dispatcher against
 * a MOCK bridge. It proves the tool is reachable and emits something the test accepted. It proves
 * nothing about the live host — that claim only comes from verification/sweeps/. The generated
 * document keeps the two axes separate for exactly that reason.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.env['PREMIERE_MCP_TOOL_COVERAGE'] === '1') {
  const dir = join(__dirname, '..', '..', '.tool-coverage');
  mkdirSync(dir, { recursive: true });
  // One file per worker process. Jest gives each test file a fresh module registry inside the
  // worker, so the `seen` set below resets between test files; that is fine and in fact wanted,
  // because the aggregator wants (tool, testFile) pairs and dedupes globally.
  const out = join(dir, `worker-${process.pid}.jsonl`);

  const seen = new Set<string>();
  let installed = false;

  /**
   * The tool module is loaded in a `beforeEach`, never at the top of this file.
   *
   * A top-level `import { PremiereProTools }` here silently broke module mocking. Setup files run
   * BEFORE the test file's body, and `jest.mock(...)` calls are registered when that body is
   * evaluated — so an eager import loaded src/tools/index.ts (and its `child_process` dependency)
   * against the REAL modules and cached it. `src/__tests__/tools/index.test.ts` then mocked
   * `child_process` and its three detect_silence cases spawned real ffmpeg: two wrong results and
   * an unhandled ENOENT, in a file this probe is not supposed to be able to affect at all.
   *
   * A `beforeEach` hook registered from setupFilesAfterEach runs after the test file body, so by
   * then every jest.mock is in place and the require resolves to exactly the instance the test
   * uses — which is also the instance that has to be patched for the measurement to mean anything.
   */
  beforeEach(() => {
    if (installed) return;
    installed = true;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
    const { PremiereProTools } = require('../tools/index.js');
    const original = PremiereProTools.prototype.executeTool;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PremiereProTools.prototype.executeTool = function (this: any, name: string, ...rest: any[]) {
      if (typeof name === 'string' && !seen.has(name)) {
        seen.add(name);
        // The test path is read from expect's state rather than captured once, so each record is
        // attributed to the file that actually made the call.
        let testFile = 'unknown';
        try {
          const state = (expect as unknown as { getState?: () => { testPath?: string } }).getState?.();
          if (state?.testPath) testFile = state.testPath;
        } catch {
          testFile = 'unknown';
        }
        // Synchronous append, one line per pair. A crashed or timed-out test still leaves behind
        // everything it reached before dying, which is the point — a run that aborts must not
        // silently report zero coverage for the tools it did exercise.
        appendFileSync(out, JSON.stringify({ tool: name, testFile }) + '\n');
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-spread
      return original.apply(this, [name, ...rest] as never);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });
}
