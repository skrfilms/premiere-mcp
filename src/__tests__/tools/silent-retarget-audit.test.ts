/**
 * Source-level audit for the two ways a tool can act on something the caller never named.
 *
 * These are not behaviour tests. They read the source and fail on a PATTERN, because both
 * defects below are invisible to per-tool behaviour tests: the tool does exactly what its
 * script says, verifies its own readback, and reports verified:true — against the wrong
 * target. Verification cannot catch a wrong target, so the pattern has to be banned instead.
 *
 * What went wrong, and why a test lives here now:
 *
 * 1. ACCEPTED AND IGNORED. 36 tools declared `sequenceId` in their schema, the dispatcher in
 *    index.ts passed `args.sequenceId` down, and the domain method named the parameter
 *    `_sequenceId` and hardcoded `app.project.activeSequence`. Callers were told which
 *    sequence they were addressing and were addressing whatever timeline happened to be open.
 *    Same shape as the `insertMode` defect: declared, forwarded, discarded at the last step.
 *
 * 2. SILENT FALLBACK. buildSeqRes()/buildQSeqResolver() — the shared resolvers behind ~100
 *    call sites — ended in `return app.project.activeSequence` when the requested id did not
 *    match, so a stale or mistyped id silently retargeted the open timeline.
 *
 * The bin resolvers had the identical shape (`findBin(...) || app.project.rootItem`), so they
 * are pinned here too.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DOMAIN_DIR = join(__dirname, '..', '..', 'tools', 'domains');
const domainFiles = readdirSync(DOMAIN_DIR).filter((f) => f.endsWith('.ts'));

interface Method {
  file: string;
  name: string;
  signature: string;
  body: string;
  line: number;
}

/**
 * Comment lines are stripped before scanning. Every fix in this file left a doc comment behind
 * that QUOTES the banned expression to explain what went wrong, and a scanner that reads comments
 * flags the explanation as the defect — which trains the next person to delete the explanation.
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .map((l) => (/^\s*(?:\/\/|\/\*|\*)/.test(l) ? '' : l))
    .join('\n');
}

/** Every `protected async` method in the domain layer, with its body. */
function domainMethods(): Method[] {
  const out: Method[] = [];
  for (const file of domainFiles) {
    const lines = stripComments(readFileSync(join(DOMAIN_DIR, file), 'utf8')).split('\n');
    const starts: Array<[number, string]> = [];
    lines.forEach((l, i) => {
      const m = /^\s*protected async (\w+)/.exec(l);
      if (m) starts.push([i, m[1]!]);
    });
    starts.forEach(([i, name], idx) => {
      const end = idx + 1 < starts.length ? starts[idx + 1]![0] : lines.length;
      out.push({
        file,
        name,
        signature: lines[i]!,
        body: lines.slice(i, end).join('\n'),
        line: i + 1,
      });
    });
  }
  return out;
}

const methods = domainMethods();

describe('a sequence id that is accepted must be used', () => {
  it('finds methods to audit at all, so an empty scan cannot pass silently', () => {
    // A broken scanner reports zero violations, which is indistinguishable from a clean tree.
    expect(methods.length).toBeGreaterThan(200);
  });

  /**
   * `_name` is TypeScript's convention for "deliberately unused", so the underscore is a
   * reliable, self-declared marker. A sequence id is never legitimately unused: if a tool
   * cannot target a named sequence, the argument does not belong in its schema.
   */
  it('no domain method declares a sequence id it does not consume', () => {
    // Matches the id in ANY position, not just the first. The first version of this test only
    // anchored on `(_sequenceId`, and 20 more methods were hiding behind it as a trailing
    // argument -- which is where an id lands when it is bolted onto an existing signature.
    const offenders = methods
      .filter((m) => /[(,]\s*_(?:seqId|sequenceId)\b/.test(m.signature))
      .map((m) => `${m.file}:${m.line} ${m.name}`);

    expect(offenders).toEqual([]);
  });

  /**
   * The complement: a method that DOES take a sequence id must route it through a resolver.
   * A raw `app.project.activeSequence` in such a method is the defect back again under a
   * different spelling — the parameter is named correctly and still ignored.
   */
  /**
   * Reading `app.project.activeSequence` is legitimate in exactly one shape: a tool that must
   * make its target active in order to run a QE or menu operation, and then puts the editor's
   * previous sequence back. Those read the active sequence to SAVE and RESTORE it, which is the
   * opposite of retargeting. They are listed by name rather than pattern-matched, because a
   * heuristic loose enough to admit them is loose enough to admit the defect.
   */
  const ACTIVE_SEQUENCE_IS_INTENTIONAL = new Set([
    'razorTimelineAtTime', // sets the target active, razors, restores __priorActive
    'applyAudioEffectToAllClips',
    'addTrack',
    'duplicateSequence',
    'deleteTrack', // reports which sequence QE could actually reach
    'setActiveSequence', // the active sequence IS its subject
    'versionUpSequence', // confirms openSequence() landed on the new sequence
    'readSequenceCaptions', // already fails closed on an unresolvable id, in longhand
  ]);

  it('no method that takes a sequence id reaches for the active sequence directly', () => {
    const offenders: string[] = [];
    for (const m of methods) {
      if (!/[(,]\s*(?:seqId|sequenceId)\b/.test(m.signature)) continue;
      if (ACTIVE_SEQUENCE_IS_INTENTIONAL.has(m.name)) continue;
      // `: 'app.project.activeSequence'` is the else-branch of a resolver ternary -- the
      // documented default for an OMITTED id, not a fallback for one that failed to resolve.
      const script = m.body
        .replace(m.signature, '')
        .replace(/: 'app\.project\.activeSequence'/g, '')
        .replace(/: 'qe\.project\.getActiveSequence\(\)'/g, '');
      if (/app\.project\.activeSequence|qe\.project\.getActiveSequence\(\)/.test(script)) {
        offenders.push(`${m.file}:${m.line} ${m.name}`);
      }
    }
    // Route through buildSeqRes(), buildQSeqResolver() or __findSequence() instead.
    expect(offenders).toEqual([]);
  });
});

describe('the shared sequence resolvers fail closed', () => {
  const base = readFileSync(join(DOMAIN_DIR, 'base.ts'), 'utf8');

  it('an unresolvable id throws instead of substituting the active sequence', () => {
    // Asserting on the source, not a call, because these emit ExtendScript text: the
    // substitution is a string the host runs, so the string is the thing to pin.
    const region = base.slice(
      base.indexOf('protected buildSeqRes'),
      base.indexOf('protected statSnapshot'),
    );

    expect(region).toContain('Sequence not found by id:');
    expect(region).toContain('Refusing to fall back to the active sequence');
    // The exact expression that made a stale id silently retarget the open timeline.
    expect(region).not.toContain('return app.project.activeSequence;}');
    expect(region).not.toContain('return qe.project.getActiveSequence(); }');
  });

  it('still uses the active sequence when no id is given, which is the documented default', () => {
    // Failing closed on an OMITTED id would break every tool that legitimately defaults.
    const region = base.slice(
      base.indexOf('protected buildSeqRes'),
      base.indexOf('protected statSnapshot'),
    );

    expect(region).toContain("if (!sid) return 'app.project.activeSequence';");
    expect(region).toContain("if (!seqId) return 'qe.project.getActiveSequence()';");
  });
});

describe('bins are resolved by one shared resolver, never by a local scan', () => {
  /**
   * import_folder could not reach a nested bin because it had its own one-level scan of
   * rootItem.children. Four more tools had four more hand-rolled resolvers with four
   * different behaviours, and one of them fell back to the whole project on a miss.
   */
  it('no tool falls back to the project root when a named bin does not resolve', () => {
    const offenders: string[] = [];
    for (const file of domainFiles) {
      const src = stripComments(readFileSync(join(DOMAIN_DIR, file), 'utf8'));
      src.split('\n').forEach((l, i) => {
        if (l.includes('|| app.project.rootItem')) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no domain file defines its own bin-by-name walker', () => {
    const offenders: string[] = [];
    for (const file of domainFiles) {
      const src = readFileSync(join(DOMAIN_DIR, file), 'utf8');
      // The shared helper is __resolveBin in the bridge prelude. A local `function findBin`
      // or `function __binByName` is a second implementation that will drift from it.
      for (const pattern of [/function findBin\s*\(/, /function __binByName\s*\(/]) {
        if (pattern.test(src)) offenders.push(`${file}: ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every tool that takes a bin name resolves it through __resolveBin', () => {
    // Only methods that emit their own ExtendScript. A method that hands the bin off to the
    // bridge (importMedia -> bridge.importMedia) resolves it there, and requiring the prelude
    // helper in a body that contains no script at all would be a rule about nothing.
    const binTools = methods.filter(
      (m) => /\bbinName\s*[?]?\s*:/.test(m.signature) && m.body.includes('executeScript('),
    );
    // Guard against the filter silently matching nothing.
    expect(binTools.length).toBeGreaterThanOrEqual(4);

    const offenders = binTools
      .filter((m) => !m.body.includes('__resolveBin(') && !m.body.includes('__resolveImportBin('))
      .map((m) => `${m.file}:${m.line} ${m.name}`);

    expect(offenders).toEqual([]);
  });
});
