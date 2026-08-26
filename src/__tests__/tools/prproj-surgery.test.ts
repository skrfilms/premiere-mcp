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

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
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
    expect(read.realpath).toBe(require('node:fs').realpathSync(file));
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
   * sequences; on the graveyard cut, 333 meant 111. Reporting the tag count as a sequence count is
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
      assertOutputWritable(require('node:fs').realpathSync(source), source);
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
    const realpath = require('node:fs').realpathSync(source);
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
   * .prproj — including the ObjectUID count, which matched what Premiere reported for this project.
   */
  const maybe = existsSync(scratch) ? it : it.skip;

  maybe('round-trips byte-identically and its ObjectUID count matches Premiere', () => {
    const { file, raw } = readProjectFile(scratch);
    expect(file.formatVersion).toBe('3');
    expect(containerCanary(raw, file)).toMatchObject({ byteIdentical: true, semantic: true });
    // Premiere reported 2 sequences for this project via list_open_projects.
    expect(censusOf(file.xml).definitions.Sequence).toBe(2);
  });
});

describe('a fresh directory is genuinely fresh', () => {
  it('does not leak state between tests', () => {
    mkdirSync(path.join(dir, 'sub'));
    expect(existsSync(path.join(dir, 'sub'))).toBe(true);
  });
});
