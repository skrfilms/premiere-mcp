/**
 * project_file_edit rewrites a .prproj OUTSIDE Premiere. It is the most dangerous tool in this
 * build, and the reason it can exist at all is that every one of its refusals is exercised here.
 *
 * These tests use REAL temp files rather than a mocked fs. The invariants are claims about bytes on
 * disk — that the original was not touched, that the output round-trips byte-identically, that the
 * written file reads back as the document intended — and a mocked filesystem would let all three
 * pass while the shipped code did something else. That distinction is not hypothetical here: a
 * harness in this repo destroyed a 111-sequence cut on 2026-08-26 because its guard checked a NAME
 * instead of an identity, and every check below is deliberately built on realpaths and hashes.
 *
 * ONE BRANCH IS NOT COVERED, and it is named rather than quietly skipped: when the bridge does not
 * answer, the tool asks the OS whether Premiere is running, and refuses if it is. Which way that
 * goes depends on the machine running the tests, so forcing it either way would produce a test that
 * passes for the wrong reason. The deterministic half — that a successful bridge answer is what the
 * decision is made from — is covered.
 *
 * That branch was instead verified by hand against a real host on 2026-08-26, along with the two
 * claims no mock can settle:
 *   - bridge unreachable while Premiere ran  -> refused OPEN_STATE_UNKNOWN, wrote nothing
 *   - bridge reachable, target open          -> refused PROJECT_IS_OPEN, wrote nothing
 *   - bridge reachable, target closed        -> wrote the file, and Premiere 26.3 OPENED it and
 *     returned the edited bin name from its own project model via get_bin_tree
 * The last one is why premiereWillLoad stays 'unverified' per call but the note can claim the
 * writer itself has been proven: the evidence is about the writer, not about any given file.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SurgeryRefusal,
  applyReplacements,
  assertOutputWritable,
  assertSupportedFormat,
  censusDiff,
  censusOf,
  containerCanary,
  containsMarkup,
  countOccurrences,
  documentSanity,
  hasOnlyValidEntities,
  markupDiff,
  markupSignature,
  ProjectWriteError,
  parseFormatVersion,
  readProjectFile,
  serializeProjectFile,
  sha256,
  surgeryEnabled,
  writeEditedProject,
  PRPROJ_GZIP_LEVEL,
  SURGERY_ENV_FLAG,
} from '../../tools/prproj-surgery.js';
import { PremiereProTools } from '../../tools/index.js';

/**
 * A miniature project. Deliberately contains the ObjectUID/ObjectURef pair that makes the raw tag
 * count disagree with the real sequence count — the distinction the census depends on.
 */
const FIXTURE_XML = [
  '<?xml version="1.0" encoding="UTF-8" ?>',
  '<PremiereData Version="3">',
  '\t<Project ObjectID="1" ClassID="62ad66dd-0dcd-42da-a660-6d8fbde94876" Version="45">',
  '\t\t<Sequence ObjectUID="uid-seq-a" ClassID="6a15d903-8739-11d5-af2d-9b7f0000ffff">',
  '\t\t\t<Name>fixture_seq_a</Name>',
  '\t\t</Sequence>',
  '\t\t<Sequence ObjectURef="uid-seq-a"/>',
  '\t\t<BinProjectItem ObjectUID="uid-bin-1">',
  '\t\t\t<Name>fixture_bin</Name>',
  '\t\t</BinProjectItem>',
  '\t</Project>',
  '</PremiereData>',
  '',
].join('\n');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'prproj-surgery-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write the fixture as Premiere would: gzip at the level that reproduces its container. */
function writeFixture(name = 'fixture.prproj', xml = FIXTURE_XML): string {
  const file = path.join(dir, name);
  writeFileSync(file, gzipSync(Buffer.from(xml, 'utf8'), { level: PRPROJ_GZIP_LEVEL }));
  return file;
}

describe('reading a project file', () => {
  it('decodes a gzipped project and reports its identity', () => {
    const file = writeFixture();
    const { file: read, raw } = readProjectFile(file);

    expect(read.compressed).toBe(true);
    expect(read.formatVersion).toBe('3');
    expect(read.xml).toBe(FIXTURE_XML);
    expect(read.realpath).toBe(require('node:fs').realpathSync.native(file));
    expect(read.sha256).toBe(sha256(raw));
    expect(read.bytes).toBe(raw.length);
  });

  it('reads an uncompressed .prproj rather than refusing it', () => {
    const file = path.join(dir, 'plain.prproj');
    writeFileSync(file, FIXTURE_XML, 'utf8');
    const { file: read } = readProjectFile(file);
    expect(read.compressed).toBe(false);
    expect(read.formatVersion).toBe('3');
  });

  it.each([
    ['a relative path', 'fixture.prproj', 'RELATIVE_PATH'],
    ['a missing file', path.join(tmpdir(), 'definitely-not-here-9d2f.prproj'), 'NOT_FOUND'],
  ])('refuses %s', (_label, input, code) => {
    expect(() => readProjectFile(input)).toThrow(SurgeryRefusal);
    try { readProjectFile(input); } catch (e) { expect((e as SurgeryRefusal).code).toBe(code); }
  });

  it('refuses a directory', () => {
    try {
      readProjectFile(dir);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('NOT_A_FILE');
    }
  });

  it('refuses a file whose gzip payload is corrupt instead of returning garbage', () => {
    const file = path.join(dir, 'corrupt.prproj');
    writeFileSync(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x41, 0x41, 0x41, 0x41]));
    try {
      readProjectFile(file);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('DECOMPRESS_FAILED');
    }
  });
});

describe('invariant 3 — format version', () => {
  it('accepts Version="3"', () => {
    expect(parseFormatVersion(FIXTURE_XML)).toBe('3');
    const { file } = readProjectFile(writeFixture());
    expect(() => assertSupportedFormat(file)).not.toThrow();
  });

  it('refuses an unverified future version rather than best-effort editing it', () => {
    const file = writeFixture('future.prproj', FIXTURE_XML.replace('Version="3"', 'Version="9"'));
    const { file: read } = readProjectFile(file);
    try {
      assertSupportedFormat(read);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('UNSUPPORTED_FORMAT_VERSION');
      expect((e as Error).message).toContain('Version="9"');
    }
  });

  it('refuses XML that is not a Premiere project at all', () => {
    const file = writeFixture('notaproject.prproj', '<?xml version="1.0"?>\n<SomethingElse/>\n');
    const { file: read } = readProjectFile(file);
    try {
      assertSupportedFormat(read);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('NOT_A_PROJECT');
    }
  });
});

describe('invariant 4 — container canary', () => {
  it('confirms byte-identical re-encoding of a file written the way Premiere writes it', () => {
    const file = writeFixture();
    const { file: read, raw } = readProjectFile(file);
    const canary = containerCanary(raw, read);
    expect(canary.semantic).toBe(true);
    expect(canary.byteIdentical).toBe(true);
    expect(canary.reencodedBytes).toBe(read.bytes);
  });

  /**
   * The canary's real job. A file compressed by an unfamiliar writer still decodes perfectly — the
   * XML is fine, the census would pass — but our output container would differ from the input by
   * more than the edit, and that is the point at which we stop knowing what we changed.
   */
  it('detects a container written by a different compressor, even though the XML is intact', () => {
    const file = path.join(dir, 'level9.prproj');
    writeFileSync(file, gzipSync(Buffer.from(FIXTURE_XML, 'utf8'), { level: 9 }));
    const { file: read, raw } = readProjectFile(file);
    const canary = containerCanary(raw, read);
    expect(read.xml).toBe(FIXTURE_XML);
    expect(canary.semantic).toBe(true);
    expect(canary.byteIdentical).toBe(false);
  });

  it('round-trips an uncompressed project byte-identically too', () => {
    const file = path.join(dir, 'plain.prproj');
    writeFileSync(file, FIXTURE_XML, 'utf8');
    const { file: read, raw } = readProjectFile(file);
    expect(containerCanary(raw, read)).toMatchObject({ byteIdentical: true, semantic: true });
  });

  it('serializes at the measured level rather than whatever zlib defaults to next', () => {
    expect(PRPROJ_GZIP_LEVEL).toBe(6);
    expect(serializeProjectFile(FIXTURE_XML, true).equals(gzipSync(Buffer.from(FIXTURE_XML, 'utf8'), { level: 6 }))).toBe(true);
  });
});

describe('the census', () => {
  /**
   * The number that would have been a lie. Six `<Sequence` tags in the real scratch project meant two
   * sequences; on a real 111-sequence cut, 333 meant 111. Reporting the tag count as a sequence count is
   * exactly the kind of confident-and-wrong number this codebase treats as a defect.
   */
  it('separates ObjectUID definitions from cross-references', () => {
    const census = censusOf(FIXTURE_XML);
    expect(census.nodes.Sequence).toBe(2);
    expect(census.definitions.Sequence).toBe(1);
    expect(census.definitions.BinProjectItem).toBe(1);
  });

  it('reports no diff for an identical document', () => {
    expect(censusDiff(censusOf(FIXTURE_XML), censusOf(FIXTURE_XML))).toEqual([]);
  });

  it('names what changed, with both counts', () => {
    const damaged = FIXTURE_XML.replace('\t\t<Sequence ObjectURef="uid-seq-a"/>\n', '');
    const diff = censusDiff(censusOf(FIXTURE_XML), censusOf(damaged));
    expect(diff).toContain('nodes.Sequence: 2 -> 1');
  });

  it('does not mistake a longer tag for a shorter one', () => {
    // `<SequenceSource` must not count as `<Sequence`; the real project has four of them.
    expect(censusOf('<SequenceSource Version="4"><Sequence ObjectURef="x"/></SequenceSource>').nodes.Sequence).toBe(1);
  });
});

describe('invariant 5 — exactly-N matches', () => {
  it('applies a unique replacement', () => {
    const { xml, applied } = applyReplacements(FIXTURE_XML, [{ find: 'fixture_bin', replace: 'renamed_bin' }]);
    expect(xml).toContain('<Name>renamed_bin</Name>');
    expect(applied).toEqual([{ find: 'fixture_bin', replace: 'renamed_bin', matches: 1 }]);
  });

  it('refuses a find string that matches nothing', () => {
    try {
      applyReplacements(FIXTURE_XML, [{ find: 'no_such_text', replace: 'x' }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('MATCH_COUNT_MISMATCH');
      expect((e as Error).message).toContain('matched 0 time(s), expected exactly 1');
    }
  });

  it('refuses an ambiguous find string rather than replacing all of them', () => {
    try {
      applyReplacements(FIXTURE_XML, [{ find: 'uid-seq-a', replace: 'uid-seq-z' }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('MATCH_COUNT_MISMATCH');
      expect((e as Error).message).toContain('matched 2 time(s)');
    }
  });

  it('allows a deliberate multi-site edit when the count is stated', () => {
    const { xml, applied } = applyReplacements(FIXTURE_XML, [{ find: 'uid-seq-a', replace: 'uid-seq-z', expectedMatches: 2 }]);
    expect(applied[0]!.matches).toBe(2);
    expect(countOccurrences(xml, 'uid-seq-z')).toBe(2);
    expect(countOccurrences(xml, 'uid-seq-a')).toBe(0);
  });

  /**
   * Counts are taken against the ORIGINAL for every replacement before any is applied. Without that,
   * this pair would "succeed": the first edit manufactures the second's match, so each would have
   * been validated against a document that is not the one it edited.
   */
  it('does not let one replacement manufacture another one\'s match', () => {
    try {
      applyReplacements(FIXTURE_XML, [
        { find: 'fixture_bin', replace: 'interim_bin' },
        { find: 'interim_bin', replace: 'final_bin' },
      ]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('MATCH_COUNT_MISMATCH');
    }
  });

  it('refuses an empty replacement list, so a no-op cannot be reported as an edit', () => {
    try {
      applyReplacements(FIXTURE_XML, []);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('NO_REPLACEMENTS');
    }
  });

  it('refuses a replacement that changes nothing', () => {
    try {
      applyReplacements(FIXTURE_XML, [{ find: 'fixture_bin', replace: 'fixture_bin' }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('NO_OP_REPLACEMENT');
    }
  });

  it('refuses an empty find string', () => {
    try {
      applyReplacements(FIXTURE_XML, [{ find: '', replace: 'x' }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('EMPTY_FIND');
    }
  });
});

describe('XML metacharacters in a replacement', () => {
  it('refuses a bare ampersand, which the census cannot detect', () => {
    try {
      applyReplacements(FIXTURE_XML, [{ find: 'fixture_bin', replace: 'Cuts & Trims' }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('BARE_AMPERSAND');
    }
  });

  /**
   * The spelling that actually works has to be allowed, or the guard only teaches callers to give up.
   * A blanket ban on '&' would have refused this — the check is for a valid ENTITY, not a character.
   */
  it('accepts the escaped form', () => {
    const { xml } = applyReplacements(FIXTURE_XML, [{ find: 'fixture_bin', replace: 'Cuts &amp; Trims' }]);
    expect(xml).toContain('<Name>Cuts &amp; Trims</Name>');
    expect(hasOnlyValidEntities(xml)).toBe(true);
  });

  it.each(['&amp;', '&lt;', '&gt;', '&quot;', '&apos;', '&#39;', '&#x27;'])('treats %s as a valid entity', (entity) => {
    expect(hasOnlyValidEntities(`a${entity}b`)).toBe(true);
  });

  it.each(['&', '&nbsp;', '&amp', '& amp;'])('treats %s as a bare ampersand', (bad) => {
    expect(hasOnlyValidEntities(`a${bad}b`)).toBe(false);
  });

  it.each(['a<b', 'a>b'])('refuses raw markup %s unless it is asked for', (replace) => {
    expect(containsMarkup(replace)).toBe(true);
    try {
      applyReplacements(FIXTURE_XML, [{ find: 'fixture_bin', replace }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('MARKUP_IN_REPLACEMENT');
    }
  });

  it('permits a markup edit when allowMarkupEdit is set', () => {
    const { xml } = applyReplacements(FIXTURE_XML, [
      { find: '<Sequence ObjectURef="uid-seq-a"/>', replace: '<!-- gone -->', allowMarkupEdit: true },
    ]);
    expect(xml).toContain('<!-- gone -->');
  });
});

describe('whole-document sanity checks', () => {
  it('passes on an untouched project', () => {
    expect(documentSanity(FIXTURE_XML)).toMatchObject({ angleBalanced: true, entitiesValid: true });
  });

  /**
   * The reason these exist alongside the census: the census counts known tags, so a stray bracket
   * leaves every count identical and sails straight through it.
   */
  it('catches a stray bracket that the census cannot see', () => {
    const damaged = FIXTURE_XML.replace('fixture_bin', 'fixture<bin');
    expect(censusDiff(censusOf(FIXTURE_XML), censusOf(damaged))).toEqual([]);
    expect(documentSanity(damaged).angleBalanced).toBe(false);
  });

  it('catches a bare ampersand that the census cannot see', () => {
    const damaged = FIXTURE_XML.replace('fixture_bin', 'Cuts & Trims');
    expect(censusDiff(censusOf(FIXTURE_XML), censusOf(damaged))).toEqual([]);
    expect(documentSanity(damaged).entitiesValid).toBe(false);
  });
});

describe('invariant 1 — never in place, never overwrite', () => {
  it('accepts a fresh path in an existing directory', () => {
    const source = writeFixture();
    expect(() => assertOutputWritable(source, path.join(dir, 'out.prproj'))).not.toThrow();
  });

  it('refuses an output path that already exists', () => {
    const source = writeFixture();
    const output = path.join(dir, 'taken.prproj');
    writeFileSync(output, 'occupied');
    try {
      assertOutputWritable(source, output);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('OUTPUT_EXISTS');
    }
    // And the occupant is still exactly what it was.
    expect(readFileSync(output, 'utf8')).toBe('occupied');
  });

  it('refuses the source as its own output', () => {
    const source = writeFixture();
    try {
      assertOutputWritable(require('node:fs').realpathSync.native(source), source);
      throw new Error('should have refused');
    } catch (e) {
      expect(['OUTPUT_EXISTS', 'IN_PLACE_REFUSED']).toContain((e as SurgeryRefusal).code);
    }
  });

  it.each([
    ['a relative output path', 'out.prproj', 'RELATIVE_OUTPUT_PATH'],
    ['an empty output path', '', 'NO_OUTPUT_PATH'],
  ])('refuses %s', (_label, output, code) => {
    const source = writeFixture();
    try {
      assertOutputWritable(source, output);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe(code);
    }
  });

  it('refuses a missing output directory rather than creating one', () => {
    const source = writeFixture();
    const output = path.join(dir, 'nope', 'out.prproj');
    try {
      assertOutputWritable(source, output);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('OUTPUT_DIR_MISSING');
    }
    expect(existsSync(path.dirname(output))).toBe(false);
  });
});

describe('writing and reading back', () => {
  it('verifies the written file by re-reading it, and leaves the source untouched', () => {
    const source = writeFixture();
    const before = sha256(readFileSync(source));
    const { file } = readProjectFile(source);
    const { xml: edited } = applyReplacements(file.xml, [{ find: 'fixture_bin', replace: 'renamed_bin' }]);
    const output = path.join(dir, 'out.prproj');

    const result = writeEditedProject(output, edited, file.compressed, censusOf(edited));

    expect(result.readbackMatches).toBe(true);
    expect(result.readbackCensusDiff).toEqual([]);
    expect(readProjectFile(output).file.xml).toContain('<Name>renamed_bin</Name>');
    // The whole reason to prefer file surgery over the API path: the original has a hash.
    expect(sha256(readFileSync(source))).toBe(before);
  });

  it('produces a file that itself round-trips byte-identically, so it can be edited again', () => {
    const source = writeFixture();
    const { file } = readProjectFile(source);
    const { xml: edited } = applyReplacements(file.xml, [{ find: 'fixture_bin', replace: 'renamed_bin' }]);
    const output = path.join(dir, 'out.prproj');
    writeEditedProject(output, edited, file.compressed, censusOf(edited));

    const { file: reread, raw } = readProjectFile(output);
    expect(containerCanary(raw, reread)).toMatchObject({ byteIdentical: true, semantic: true });
  });
});

describe('invariant 8 — off unless the operator opts in', () => {
  it.each([['1', true], ['true', true], ['on', true], ['yes', true], ['0', false], ['', false], ['maybe', false]])(
    '%s -> %s', (value, expected) => {
      expect(surgeryEnabled({ [SURGERY_ENV_FLAG]: value } as NodeJS.ProcessEnv)).toBe(expected);
    });

  it('is off when the flag is absent entirely', () => {
    expect(surgeryEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

/** A transport that answers the open-projects probe with `paths`, and records what it was asked. */
function fakeHost(paths: string[] | null) {
  const scripts: string[] = [];
  return {
    scripts,
    transport: {
      executeScript: async (script: string) => {
        scripts.push(script);
        if (paths === null) return { success: false, error: 'bridge stubbed out' };
        return { success: true, paths };
      },
    } as any,
  };
}

describe('project_file_edit as a tool', () => {
  const ORIGINAL_FLAG = process.env[SURGERY_ENV_FLAG];
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env[SURGERY_ENV_FLAG];
    else process.env[SURGERY_ENV_FLAG] = ORIGINAL_FLAG;
  });

  it('refuses when the operator has not enabled it, and touches nothing', async () => {
    delete process.env[SURGERY_ENV_FLAG];
    const source = writeFixture();
    const before = sha256(readFileSync(source));
    const host = fakeHost([]);
    const tools = new PremiereProTools(host.transport);
    const output = path.join(dir, 'out.prproj');

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SURGERY_DISABLED');
    expect(result.error).toContain(SURGERY_ENV_FLAG);
    // Refused BEFORE any work: nothing written, and the host was never even asked.
    expect(existsSync(output)).toBe(false);
    expect(sha256(readFileSync(source))).toBe(before);
    expect(host.scripts).toHaveLength(0);
  });

  it('refuses when the source is open in Premiere', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const realpath = require('node:fs').realpathSync.native(source);
    const tools = new PremiereProTools(fakeHost([realpath]).transport);
    const output = path.join(dir, 'out.prproj');

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('PROJECT_IS_OPEN');
    expect(result.error).toContain(realpath);
    expect(existsSync(output)).toBe(false);
  });

  it('refuses when the OUTPUT path is open in Premiere', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const output = path.join(dir, 'out.prproj');
    const tools = new PremiereProTools(fakeHost([output]).transport);

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('PROJECT_IS_OPEN');
  });

  it('dryRun validates everything and writes nothing', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const tools = new PremiereProTools(fakeHost([]).transport);
    const output = path.join(dir, 'out.prproj');

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, dryRun: true,
      replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    // A dry run cannot claim verification: nothing was written, so there is nothing to have verified.
    expect(result.verified).toBe(false);
    expect(result.replacementsApplied[0]).toMatchObject({ matches: 1 });
    expect(result.censusDiff).toEqual([]);
    expect(result.wrote).toBe(false);
    expect(existsSync(output)).toBe(false);
  });

  it('writes, verifies by readback, and never claims Premiere will load the result', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const before = sha256(readFileSync(source));
    const tools = new PremiereProTools(fakeHost([]).transport);
    const output = path.join(dir, 'out.prproj');

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output,
      replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.readbackMatches).toBe(true);
    expect(result.readbackCensusDiff).toEqual([]);
    expect(result.sourceUntouched).toBe(true);
    expect(result.sourceSha256After).toBe(before);
    expect(result.outputSha256).toBe(sha256(readFileSync(output)));
    // Invariant 7. XML validity is not acceptance, and this tool cannot make that claim for itself.
    expect(result.premiereWillLoad).toBe('unverified');
    // Every refusal reports wrote:false, so the one path that does write must say so rather than
    // leaving a caller that branches on it reading undefined.
    expect(result.wrote).toBe(true);
    expect(result.premiereWillLoadNote).toContain('open_project');
    expect(readProjectFile(output).file.xml).toContain('<Name>renamed_bin</Name>');
  });

  it('refuses a census-changing edit by default and writes nothing', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const tools = new PremiereProTools(fakeHost([]).transport);
    const output = path.join(dir, 'out.prproj');

    // Deleting the closing tag of the cross-reference removes a Sequence node.
    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output,
      replacements: [{ find: '<Sequence ObjectURef="uid-seq-a"/>', replace: '<!-- gone -->', allowMarkupEdit: true }],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('CENSUS_CHANGED');
    expect(result.error).toContain('nodes.Sequence: 2 -> 1');
    expect(existsSync(output)).toBe(false);
  });

  it('permits a census change only when it is asked for explicitly', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const tools = new PremiereProTools(fakeHost([]).transport);
    const output = path.join(dir, 'out.prproj');

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, allowCensusChange: true,
      replacements: [{ find: '<Sequence ObjectURef="uid-seq-a"/>', replace: '<!-- gone -->', allowMarkupEdit: true }],
    });

    expect(result.success).toBe(true);
    expect(result.censusDiff).toContain('nodes.Sequence: 2 -> 1');
  });

  /**
   * allowMarkupEdit turns off the per-replacement bracket guard, so the whole-document check is the
   * only thing left standing between a restructuring edit and an unloadable file. It has to hold on
   * its own, which is why this goes through the tool rather than the helper.
   */
  it('refuses an allowMarkupEdit edit that leaves the brackets unbalanced', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const tools = new PremiereProTools(fakeHost([]).transport);
    const output = path.join(dir, 'out.prproj');

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, allowCensusChange: true,
      replacements: [{ find: '<Sequence ObjectURef="uid-seq-a"/>', replace: '<Sequence', allowMarkupEdit: true }],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('ANGLE_BRACKETS_UNBALANCED');
    expect(existsSync(output)).toBe(false);
  });

  it('refuses a file written by an unverified compressor', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = path.join(dir, 'level9.prproj');
    writeFileSync(source, gzipSync(Buffer.from(FIXTURE_XML, 'utf8'), { level: 9 }));
    const tools = new PremiereProTools(fakeHost([]).transport);
    const output = path.join(dir, 'out.prproj');

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: output,
      replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('CANARY_BYTE_MISMATCH');
    expect(existsSync(output)).toBe(false);
  });

  it('checks the format version before the open-projects probe, so a junk file costs no host round trip', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture('future.prproj', FIXTURE_XML.replace('Version="3"', 'Version="9"'));
    const host = fakeHost([]);
    const tools = new PremiereProTools(host.transport);

    const result: any = await tools.executeTool('project_file_edit', {
      sourcePath: source, outputPath: path.join(dir, 'out.prproj'),
      replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.code).toBe('UNSUPPORTED_FORMAT_VERSION');
    expect(host.scripts).toHaveLength(0);
  });
});

describe('project_file_inspect as a tool', () => {
  it('reports identity, census and canary without opening anything', async () => {
    const source = writeFixture();
    const host = fakeHost([]);
    const tools = new PremiereProTools(host.transport);

    const result: any = await tools.executeTool('project_file_inspect', {
      projectPath: source,
      countStrings: ['fixture_bin', 'uid-seq-a', 'not_present'],
      xmlExcerptAround: 'fixture_bin',
    });

    expect(result.success).toBe(true);
    expect(result.formatVersion).toBe('3');
    expect(result.formatSupportedForEditing).toBe(true);
    expect(result.compressed).toBe(true);
    expect(result.sha256).toBe(sha256(readFileSync(source)));
    expect(result.census.definitions.Sequence).toBe(1);
    expect(result.census.nodes.Sequence).toBe(2);
    expect(result.containerRoundTrip.byteIdentical).toBe(true);
    expect(result.stringCounts).toEqual({ fixture_bin: 1, 'uid-seq-a': 2, not_present: 0 });
    expect(result.excerpt.found).toBe(true);
    expect(result.excerpt.text).toContain('fixture_bin');
    // Read-only means read-only: it never asks the host anything.
    expect(host.scripts).toHaveLength(0);
  });

  it('needs no opt-in flag, because it cannot change anything', async () => {
    const before = process.env[SURGERY_ENV_FLAG];
    delete process.env[SURGERY_ENV_FLAG];
    try {
      const tools = new PremiereProTools(fakeHost([]).transport);
      const result: any = await tools.executeTool('project_file_inspect', { projectPath: writeFixture() });
      expect(result.success).toBe(true);
    } finally {
      if (before !== undefined) process.env[SURGERY_ENV_FLAG] = before;
    }
  });

  it('reports an unsupported version as inspectable but not editable', async () => {
    const tools = new PremiereProTools(fakeHost([]).transport);
    const source = writeFixture('future.prproj', FIXTURE_XML.replace('Version="3"', 'Version="9"'));
    const result: any = await tools.executeTool('project_file_inspect', { projectPath: source });
    expect(result.success).toBe(true);
    expect(result.formatVersion).toBe('9');
    expect(result.formatSupportedForEditing).toBe(false);
  });

  it('says so plainly when an excerpt literal is absent', async () => {
    const tools = new PremiereProTools(fakeHost([]).transport);
    const result: any = await tools.executeTool('project_file_inspect', {
      projectPath: writeFixture(), xmlExcerptAround: 'no_such_text',
    });
    expect(result.excerpt.found).toBe(false);
  });

  it('refuses a missing file with a code rather than throwing', async () => {
    const tools = new PremiereProTools(fakeHost([]).transport);
    const result: any = await tools.executeTool('project_file_inspect', {
      projectPath: path.join(dir, 'absent.prproj'),
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
  });
});

describe('the real scratch fixture in this repo', () => {
  const scratch = path.join(__dirname, '..', '..', '..', '.scratch', 'trowel_scratch.prproj');

  /**
   * Read-only, and the only test here that touches a file Premiere wrote. It is what turns the
   * fixture-based tests above from "our own encoder agrees with itself" into evidence about a real
   * .prproj.
   *
   * This used to assert `definitions.Sequence === 2`, the number Premiere reported for the project
   * at the time it was written. That is a fixture-coupled claim, and it broke exactly as you would
   * expect: a live mutate sweep added a sequence to this scratch project and the suite went red
   * over a file the code under test handles correctly. The scratch project is a mutable working
   * file — the sweeps write to it on purpose — so no literal count belongs here.
   *
   * What survives is the part that is actually about the parser: the census finds at least one
   * Sequence definition in a real Premiere-written file, and every definition it counts carries a
   * distinct ObjectUID (found by an independent scan, so a double-count or an off-by-one in
   * countDefinition still fails).
   */
  const maybe = existsSync(scratch) ? it : it.skip;

  maybe('round-trips byte-identically and its Sequence definitions are distinct', () => {
    const { file, raw } = readProjectFile(scratch);
    expect(file.formatVersion).toBe('3');
    expect(containerCanary(raw, file)).toMatchObject({ byteIdentical: true, semantic: true });

    const counted = censusOf(file.xml).definitions.Sequence;
    const uids = new Set(
      [...file.xml.matchAll(/<Sequence\s+ObjectUID="([^"]*)"/g)].map((m) => m[1]),
    );
    expect(counted).toBeGreaterThanOrEqual(1);
    expect(uids.size).toBe(counted);
  });
});

describe('a fresh directory is genuinely fresh', () => {
  it('does not leak state between tests', () => {
    mkdirSync(path.join(dir, 'sub'));
    expect(existsSync(path.join(dir, 'sub'))).toBe(true);
  });
});

/**
 * Replacements are counted against the original AND applied in one pass over it. Applying them one
 * after another used to let [A->B, B->C] turn both into C while reporting [1, 1].
 */
describe('one-pass replacement', () => {
  it('applies a chain against the original, so replaced text is never rescanned', () => {
    const { xml, applied } = applyReplacements(FIXTURE_XML, [
      { find: 'fixture_bin', replace: 'fixture_seq_a' },
      { find: 'fixture_seq_a', replace: 'final_seq' },
    ]);
    expect(applied.map((a) => a.matches)).toEqual([1, 1]);
    // Exactly what the census validated: one of each, not two final_seq.
    expect(xml).toContain('<Name>final_seq</Name>');
    expect(xml).toContain('<Name>fixture_seq_a</Name>');
    expect(countOccurrences(xml, 'final_seq')).toBe(1);
  });

  it('swaps two values, which sequential application cannot do', () => {
    const { xml } = applyReplacements(FIXTURE_XML, [
      { find: 'fixture_bin', replace: 'fixture_seq_a' },
      { find: 'fixture_seq_a', replace: 'fixture_bin' },
    ]);
    expect(xml).toBe(FIXTURE_XML.replace('<Name>fixture_seq_a</Name>', '<Name>@@</Name>').replace('<Name>fixture_bin</Name>', '<Name>fixture_seq_a</Name>').replace('@@', 'fixture_bin'));
  });

  it.each([
    ['one find contained in another', [{ find: 'fixture_bin', replace: 'x' }, { find: 'xture_bin', replace: 'y' }]],
    ['the same find twice', [{ find: 'fixture_bin', replace: 'x' }, { find: 'fixture_bin', replace: 'y' }]],
  ])('refuses %s rather than picking a winner', (_label, replacements) => {
    try {
      applyReplacements(FIXTURE_XML, replacements);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('FIND_CONTAINS_FIND');
    }
  });

  it('refuses two finds whose matches overlap in the original', () => {
    try {
      // "fixture_s" and "e_seq" both sit inside "fixture_seq_a", sharing "e_s".
      applyReplacements(FIXTURE_XML, [{ find: 'fixture_s', replace: 'x' }, { find: 'e_seq', replace: 'y' }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('OVERLAPPING_FINDS');
    }
  });
});

describe('markup in a find', () => {
  it('refuses a find that carries a closing tag, which would delete it', () => {
    try {
      applyReplacements(FIXTURE_XML, [{ find: 'fixture_bin</Name>', replace: 'fixture_bin' }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('MARKUP_IN_FIND');
    }
  });

  /** No bracket in find or replace, yet it renames an element — and Name is not a census tag. */
  it('refuses a bracket-free find that matches inside tag names', () => {
    const renamed = FIXTURE_XML.split('Name').join('Nom');
    expect(censusDiff(censusOf(FIXTURE_XML), censusOf(renamed))).toEqual([]);
    expect(markupDiff(markupSignature(FIXTURE_XML), markupSignature(renamed))).toContain('open:Name: 2 -> 0');
    try {
      applyReplacements(FIXTURE_XML, [{ find: 'Name', replace: 'Nom', expectedMatches: 4 }]);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('MARKUP_CHANGED');
    }
  });

  it('refuses it through the tool and writes nothing', async () => {
    const before = process.env[SURGERY_ENV_FLAG];
    process.env[SURGERY_ENV_FLAG] = '1';
    try {
      const tools = new PremiereProTools(fakeHost([]).transport);
      const output = path.join(dir, 'out.prproj');
      const result: any = await tools.executeTool('project_file_edit', {
        sourcePath: writeFixture(), outputPath: output,
        replacements: [{ find: 'fixture_bin</Name>', replace: 'fixture_bin' }],
      });
      expect(result).toMatchObject({ success: false, code: 'MARKUP_IN_FIND', wrote: false });
      expect(existsSync(output)).toBe(false);
    } finally {
      if (before === undefined) delete process.env[SURGERY_ENV_FLAG]; else process.env[SURGERY_ENV_FLAG] = before;
    }
  });
});

describe('the write never clobbers and reports wrote honestly', () => {
  const ORIGINAL_FLAG = process.env[SURGERY_ENV_FLAG];
  beforeEach(() => { process.env[SURGERY_ENV_FLAG] = '1'; });
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env[SURGERY_ENV_FLAG];
    else process.env[SURGERY_ENV_FLAG] = ORIGINAL_FLAG;
  });

  it('refuses an output that appeared after the check, leaving it and no temp file behind', () => {
    const output = path.join(dir, 'out.prproj');
    writeFileSync(output, 'someone else');
    try {
      writeEditedProject(output, FIXTURE_XML, true, censusOf(FIXTURE_XML));
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('OUTPUT_EXISTS');
    }
    expect(readFileSync(output, 'utf8')).toBe('someone else');
    expect(readdirSync(dir)).toEqual(['out.prproj']);
  });

  /** The real race: the existence check passes, then the open-projects probe awaits the host. */
  it('refuses through the tool when the output appears during the host probe', async () => {
    const source = writeFixture();
    const output = path.join(dir, 'out.prproj');
    const transport = {
      executeScript: async () => {
        writeFileSync(output, 'arrived mid-edit');
        return { success: true, paths: [] };
      },
    } as any;

    const result: any = await new PremiereProTools(transport).executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result).toMatchObject({ success: false, code: 'OUTPUT_EXISTS', wrote: false });
    expect(readFileSync(output, 'utf8')).toBe('arrived mid-edit');
    expect(readdirSync(dir).sort()).toEqual(['fixture.prproj', 'out.prproj']);
  });

  const posixNonRoot = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  (posixNonRoot ? it : it.skip)('reports wrote:false with nothing left behind when the write itself fails', async () => {
    const source = writeFixture();
    const output = path.join(dir, 'out.prproj');
    chmodSync(dir, 0o555);
    try {
      expect(() => writeEditedProject(output, FIXTURE_XML, true, censusOf(FIXTURE_XML))).toThrow(ProjectWriteError);
      const result: any = await new PremiereProTools(fakeHost([]).transport).executeTool('project_file_edit', {
        sourcePath: source, outputPath: output, replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
      });
      expect(result).toMatchObject({ success: false, code: 'WRITE_FAILED', wrote: false });
      expect(result.outputPath).toBeUndefined();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readdirSync(dir)).toEqual(['fixture.prproj']);
  });

  it('leaves no temp file behind on success', () => {
    const output = path.join(dir, 'out.prproj');
    const result = writeEditedProject(output, FIXTURE_XML, true, censusOf(FIXTURE_XML));
    expect(result.readbackMatches).toBe(true);
    expect(readdirSync(dir)).toEqual(['out.prproj']);
  });
});

describe('the open-in-Premiere check ignores case where the volume does', () => {
  const ORIGINAL_FLAG = process.env[SURGERY_ENV_FLAG];
  const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
    if (ORIGINAL_FLAG === undefined) delete process.env[SURGERY_ENV_FLAG];
    else process.env[SURGERY_ENV_FLAG] = ORIGINAL_FLAG;
  });

  it.each(['darwin', 'win32'])('treats a differently-cased open path as the same file on %s', async (platform) => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const reported = require('node:fs').realpathSync.native(source).toUpperCase();
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const output = path.join(dir, 'out.prproj');

    const result: any = await new PremiereProTools(fakeHost([reported]).transport).executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.code).toBe('PROJECT_IS_OPEN');
    expect(existsSync(output)).toBe(false);
  });

  it('matches an output given through a symlinked directory against the resolved open path', async () => {
    process.env[SURGERY_ENV_FLAG] = '1';
    const source = writeFixture();
    const output = path.join(dir, 'out.prproj');
    const reported = path.join(require('node:fs').realpathSync.native(dir), 'out.prproj');

    const result: any = await new PremiereProTools(fakeHost([reported]).transport).executeTool('project_file_edit', {
      sourcePath: source, outputPath: output, replacements: [{ find: 'fixture_bin', replace: 'renamed_bin' }],
    });

    expect(result.code).toBe('PROJECT_IS_OPEN');
  });
});

describe('only .prproj paths', () => {
  it('inspect refuses a non-.prproj file and returns none of its contents', async () => {
    const secret = path.join(dir, 'notes.txt');
    writeFileSync(secret, 'token=abc123');
    const result: any = await new PremiereProTools(fakeHost([]).transport).executeTool('project_file_inspect', {
      projectPath: secret, xmlExcerptAround: 'token',
    });
    expect(result).toMatchObject({ success: false, code: 'NOT_PRPROJ_PATH' });
    expect(JSON.stringify(result)).not.toContain('abc123');
  });

  it('accepts the extension in any case', () => {
    const file = writeFixture('UPPER.PRPROJ');
    expect(readProjectFile(file).file.formatVersion).toBe('3');
  });

  it('edit refuses a non-.prproj output path', () => {
    try {
      assertOutputWritable(writeFixture(), path.join(dir, 'out.xml'));
      throw new Error('should have refused');
    } catch (e) {
      expect((e as SurgeryRefusal).code).toBe('NOT_PRPROJ_PATH');
    }
  });

  it('edit refuses a non-.prproj source path', async () => {
    const before = process.env[SURGERY_ENV_FLAG];
    process.env[SURGERY_ENV_FLAG] = '1';
    try {
      const source = path.join(dir, 'project.xml');
      writeFileSync(source, FIXTURE_XML);
      const result: any = await new PremiereProTools(fakeHost([]).transport).executeTool('project_file_edit', {
        sourcePath: source, outputPath: path.join(dir, 'out.prproj'), replacements: [{ find: 'fixture_bin', replace: 'x' }],
      });
      expect(result).toMatchObject({ success: false, code: 'NOT_PRPROJ_PATH', wrote: false });
    } finally {
      if (before === undefined) delete process.env[SURGERY_ENV_FLAG]; else process.env[SURGERY_ENV_FLAG] = before;
    }
  });
});
