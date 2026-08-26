/**
 * The live harnesses in scripts/ must refuse to run against a real project.
 *
 * These scripts are not testable end-to-end from here — they need a running Premiere — but the
 * thing most worth pinning does not need one. `scripts/live-verify-cleanup.mjs` deletes every
 * sequence outside a two-name allowlist. Pointed at an editor's cut it destroys 100+ sequences,
 * and the harness that produced this project's fixtures ran against a host that also had a real
 * 111-sequence cut open. The only thing preventing that is one guard call, so the guard's presence
 * is asserted rather than assumed.
 *
 * A structural test, and read as one: it proves each harness IMPORTS and CALLS the guard, and that
 * the shipped name pattern classifies the real project names correctly. It does not prove the
 * guard runs before the first mutation — nothing here can. The ordering is enforced by review, and
 * by the guard calling process.exit rather than returning a boolean a caller could ignore.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const GUARD = path.join(SCRIPTS, 'lib', 'require-scratch-project.mjs');

/** Every script in scripts/ that mutates the open project. Adding one here is deliberate. */
const MUTATING_HARNESSES = [
  'live-verify-honesty.mjs',
  'live-verify-cleanup.mjs',
  'reset-scratch.mjs',
  // Had no guard of any kind until 2026-08-26, and it is the one the release bar tells people to run.
  'live-tool-sweep.mjs',
  // Had an inline copy of the guard that was missing 'fixture'.
  'live-smoke-sweep.mjs',
];

describe('mutating live harnesses are gated on a scratch project', () => {
  it.each(MUTATING_HARNESSES)('%s imports and calls the shared guard', (name) => {
    const file = path.join(SCRIPTS, name);
    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, 'utf8');
    // The shared helper specifically — an inline copy is how the doctor scripts drifted apart.
    expect(source).toMatch(/import \{ requireScratchProject \} from '\.\/lib\/require-scratch-project\.mjs'/);
    expect(source).toMatch(/await requireScratchProject\(bridge, /);
  });

  it('exits the process rather than returning a value a caller can ignore', () => {
    const source = readFileSync(GUARD, 'utf8');
    expect(source).toMatch(/process\.exit\(2\)/);
  });
});

describe('the shipped scratch-name pattern', () => {
  /**
   * Compiled from the literal in the helper, not restated here. A copy of the regex would keep
   * passing after the shipped one was loosened, which is the only failure that matters.
   */
  const pattern = (() => {
    const source = readFileSync(GUARD, 'utf8');
    const match = source.match(/export const SCRATCH_NAME_PATTERN = (\/.+\/[a-z]*);/);
    if (!match) throw new Error('SCRATCH_NAME_PATTERN is no longer a plain regex literal in require-scratch-project.mjs');
    const body = match[1].slice(1, match[1].lastIndexOf('/'));
    const flags = match[1].slice(match[1].lastIndexOf('/') + 1);
    return new RegExp(body, flags);
  })();

  it.each([
    // Real work on this machine. The first is the project that was open while the harnesses ran.
    'graveyard_chase_v2.prproj',
    '20260819_SPHE_PC_CUT_V30',
    'SPHE_008_0080.prproj',
  ])('refuses %s', (name) => {
    expect(pattern.test(name)).toBe(false);
  });

  it.each([
    'trowel_scratch.prproj',
    'premiere-mcp-scratch.prproj',
    'Untitled',
    'fixture_bed.prproj',
  ])('allows %s', (name) => {
    expect(pattern.test(name)).toBe(true);
  });
});
