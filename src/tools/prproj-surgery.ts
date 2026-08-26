/**
 * Project-file surgery: editing a .prproj as a file, under invariants.
 *
 * WHY THIS EXISTS. A menu item is not a unit of capability — it is a UI affordance over a state
 * change. Premiere exposes no scripted menu bus (app.findMenuCommandId and app.executeCommand are
 * absent on 26.3; only qe.executeConsoleCommand exists, see docs/VERIFIED-API-SURFACE.md), so a
 * whole class of state lives behind menus that ExtendScript cannot reach. But this server is a local
 * Node process with access to the files Premiere's state lives in, so it can produce the state
 * change directly — no menu, no stolen focus, no synthetic keystrokes. That is what makes this a
 * real MCP tool rather than GUI puppetry.
 *
 * WHAT IS VERIFIED. A .prproj is a gzip'd XML document, header `<PremiereData Version="3">`. On this
 * host, Node's own zlib at its default level reproduces Premiere's container BYTE-IDENTICALLY, and
 * Premiere opened a file edited by exactly this path and reported the edit as its own state
 * (a bin rename, read back through get_bin_tree on 2026-08-26).
 *
 * WHY IT IS SO DEFENSIVE. On the same day, a live harness in this repo destroyed a 111-sequence cut.
 * The root cause was not a missing check, it was that A NAME STOOD IN FOR AN IDENTITY: the guard
 * compared `app.project.name` against a regex, and a name says nothing about which bytes get
 * written. File surgery is safer than that API path in exactly one respect — a file has a strong
 * identity (absolute realpath plus content hash) — and every invariant below is built on identity
 * rather than on labels, intentions, or the caller's word.
 *
 *   1. Never write in place. The output is always a new file, and an existing output is refused.
 *   2. Refuse if either file is open in Premiere. Checked against the host, never self-certified.
 *   3. Refuse an unrecognised PremiereData format version.
 *   4. Per-file canary: the container must round-trip byte-identically before anything is edited.
 *   5. Exactly-N matches per replacement, or refuse. There is no replace-all.
 *   6. The structural node census must be unchanged across the edit.
 *   7. "Premiere will load this" is reported as UNVERIFIED unless it was actually opened.
 *   8. Off unless the operator opts in, and never auto-invoked.
 *
 * Everything here is pure or filesystem-only: no bridge, no host call. The invariants that decide
 * whether someone's cut gets rewritten are testable without a running Premiere, which is the whole
 * point — the guard that failed on 2026-08-26 was one that could only be exercised live.
 */

import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';

/**
 * Format versions this module is willing to touch.
 *
 * An unknown version is refused rather than best-effort edited: the census and the replacement
 * offsets both assume a layout, and "it looked like XML" is not evidence that a future schema keeps
 * the same invariants. Widening this set should mean someone verified a round trip on that version.
 */
export const PRPROJ_SUPPORTED_FORMAT_VERSIONS: ReadonlySet<string> = new Set(['3']);

/** gzip magic. A .prproj may also be stored uncompressed, which is handled rather than refused. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/**
 * Compression level that reproduces Premiere's own container byte-for-byte on this host.
 *
 * Measured, not assumed: at level 6 Node emitted a file identical to Premiere's 39450-byte original,
 * while levels 1 and 9 did not. It is named rather than left implicit because a future zlib default
 * change would break invariant 4 loudly, and the canary is what would catch it.
 */
export const PRPROJ_GZIP_LEVEL = 6;

/**
 * Structural nodes counted before and after an edit.
 *
 * The census is a tripwire, not an inventory: its job is to prove a text replacement did not add or
 * destroy structure. So the set is chosen for breadth across the things an edit could plausibly
 * damage rather than for semantic tidiness, and the counts are of raw tags — see `definitions` in
 * `censusOf` for the numbers that carry real meaning.
 */
export const CENSUS_TAGS: readonly string[] = [
  'Sequence', 'ProjectItem', 'BinProjectItem', 'RootProjectItem', 'ClipProjectItem',
  'MasterClip', 'SubClip', 'Media', 'Track', 'ClipTrack', 'TrackItem', 'Clip',
  'VideoClip', 'AudioClip', 'ClipTrackItem', 'VideoClipTrackItem', 'AudioClipTrackItem',
  'VideoTransitionTrackItem', 'AudioTransitionTrackItem', 'Marker', 'ComponentChain',
  'VideoComponentParam', 'AudioComponentParam', 'Node', 'Properties',
];

/**
 * Object kinds whose `ObjectUID=` form is the DEFINITION rather than a cross-reference.
 *
 * This is the difference between a number that means something and a number that misleads. The
 * scratch project contains six `<Sequence` tags but only two sequences: four are `ObjectURef`
 * pointers. Counting raw tags would have reported "6 sequences" — and on the 111-sequence cut, 333.
 * Counting `ObjectUID` gives 2 and 111, matching what Premiere itself reports.
 */
export const DEFINITION_TAGS: readonly string[] = ['Sequence', 'MasterClip', 'BinProjectItem', 'ClipProjectItem'];

export interface PrprojCensus {
  /** Raw tag counts. A tripwire for structural damage; not a semantic inventory. */
  nodes: Record<string, number>;
  /** `ObjectUID` definition counts — these match what Premiere reports. */
  definitions: Record<string, number>;
}

export interface PrprojFile {
  /** The path as given. */
  path: string;
  /** Resolved through symlinks — the identity everything else is decided on. */
  realpath: string;
  /** Size of the file on disk. */
  bytes: number;
  /** SHA-256 of the file on disk, so a caller can prove the original was untouched. */
  sha256: string;
  /** False for a .prproj saved uncompressed. */
  compressed: boolean;
  /** The decoded XML. */
  xml: string;
  /** The PremiereData Version attribute, or null if the document is not a Premiere project. */
  formatVersion: string | null;
}

/** Thrown for every refusal, so a caller cannot mistake one for a normal result. */
export class SurgeryRefusal extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SurgeryRefusal';
  }
}

export function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** `<PremiereData Version="3">` → `"3"`. Null when the root element is missing. */
export function parseFormatVersion(xml: string): string | null {
  const match = /<PremiereData\b[^>]*\bVersion="([^"]*)"/.exec(xml.slice(0, 4096));
  return match ? (match[1] ?? null) : null;
}

/** Count raw tag occurrences, matching only a real element start (`<Tag>`, `<Tag `, `<Tag/>`). */
export function countTag(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}(?=[\\s/>])`, 'g');
  return (xml.match(re) || []).length;
}

/** Count `<Tag ObjectUID=` — the definition form. */
export function countDefinition(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}\\s+ObjectUID=`, 'g');
  return (xml.match(re) || []).length;
}

export function censusOf(xml: string): PrprojCensus {
  const nodes: Record<string, number> = {};
  for (const tag of CENSUS_TAGS) nodes[tag] = countTag(xml, tag);
  const definitions: Record<string, number> = {};
  for (const tag of DEFINITION_TAGS) definitions[tag] = countDefinition(xml, tag);
  return { nodes, definitions };
}

/**
 * Human-readable differences between two censuses. Empty array means structurally identical.
 *
 * Returns descriptions rather than a boolean because a census failure is the one refusal an operator
 * will want to argue with, and "Sequence 111 -> 110" ends that argument immediately.
 */
export function censusDiff(before: PrprojCensus, after: PrprojCensus): string[] {
  const out: string[] = [];
  for (const [group, key] of [[before.nodes, 'nodes'], [before.definitions, 'definitions']] as const) {
    const afterGroup = key === 'nodes' ? after.nodes : after.definitions;
    for (const tag of Object.keys(group)) {
      const b = group[tag] ?? 0;
      const a = afterGroup[tag] ?? 0;
      if (a !== b) out.push(`${key}.${tag}: ${b} -> ${a}`);
    }
  }
  return out;
}

/** Non-overlapping occurrences of a literal substring. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The five named entities plus numeric character references. Anything else is a bare ampersand. */
const VALID_ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/g;

/**
 * Every `&` in `value` forms a valid entity reference.
 *
 * The failure this prevents: an agent renames a bin to `Cuts & Trims`, the document stops being
 * well-formed, and Premiere refuses the whole project — after the census passed, because counting
 * tags cannot see a broken entity. Checking for a VALID entity rather than for the character is what
 * lets the correct input (`Cuts &amp; Trims`) through; a blanket ban on `&` would refuse the one
 * spelling that actually works. Not auto-escaped, because silently rewriting a caller's string is
 * how you end up storing a bin called `12\"`.
 *
 * Verified against a real project: all 2113 ampersands in the scratch .prproj are valid entities.
 */
export function hasOnlyValidEntities(value: string): boolean {
  return value.replace(VALID_ENTITY, '').indexOf('&') === -1;
}

/** True when a value carries a raw angle bracket, i.e. it is editing markup and not just text. */
export function containsMarkup(value: string): boolean {
  return /[<>]/.test(value);
}

/**
 * Cheap whole-document damage checks, run on the EDITED xml.
 *
 * Both are properties measured to hold on real Premiere output rather than assumed: the scratch
 * project has exactly 15295 `<` and 15295 `>`, and every one of its ampersands is a valid entity.
 * They are not a well-formedness proof — this build ships no XML parser, and pretending otherwise
 * would make `premiereWillLoad: unverified` sound weaker than it is — but they catch the realistic
 * damage from a text substitution, which is a stray bracket or a bare ampersand.
 */
export function documentSanity(xml: string): { angleBalanced: boolean; openAngles: number; closeAngles: number; entitiesValid: boolean } {
  const openAngles = (xml.match(/</g) || []).length;
  const closeAngles = (xml.match(/>/g) || []).length;
  return {
    angleBalanced: openAngles === closeAngles,
    openAngles,
    closeAngles,
    entitiesValid: hasOnlyValidEntities(xml),
  };
}

export interface Replacement {
  /** Literal text to find. Not a regex — a generated pattern is not something to run over a cut. */
  find: string;
  /** Literal replacement. */
  replace: string;
  /** Required number of matches. Default 1. */
  expectedMatches?: number;
  /** Permit raw `<`/`>` in `replace`, i.e. an edit to markup rather than to text. Default false. */
  allowMarkupEdit?: boolean;
}

export interface AppliedReplacement {
  find: string;
  replace: string;
  matches: number;
}

/**
 * Apply every replacement, enforcing the exact match count for each.
 *
 * Counts are taken against the ORIGINAL document for all replacements before any is applied, so a
 * set of edits cannot interact: without that, an earlier replacement could manufacture or destroy a
 * later one's match and the count each was checked against would be a different document than the
 * one it edited.
 */
export function applyReplacements(xml: string, replacements: readonly Replacement[]): { xml: string; applied: AppliedReplacement[] } {
  if (replacements.length === 0) {
    throw new SurgeryRefusal('No replacements were given, so there is nothing to verify or apply.', 'NO_REPLACEMENTS');
  }

  const applied: AppliedReplacement[] = [];
  for (const [index, replacement] of replacements.entries()) {
    const { find, replace } = replacement;
    const expected = replacement.expectedMatches ?? 1;

    if (typeof find !== 'string' || find.length === 0) {
      throw new SurgeryRefusal(`replacements[${index}].find is empty. Refusing rather than guessing what to match.`, 'EMPTY_FIND');
    }
    if (find === replace) {
      throw new SurgeryRefusal(`replacements[${index}] would change nothing (find === replace). Refusing so a no-op cannot be reported as an edit.`, 'NO_OP_REPLACEMENT');
    }
    if (!hasOnlyValidEntities(replace)) {
      throw new SurgeryRefusal(
        `replacements[${index}].replace contains a bare "&" that is not a valid entity reference. That alone makes the document malformed, ` +
        'and the census cannot detect it. Write &amp; for a literal ampersand.',
        'BARE_AMPERSAND',
      );
    }
    if (containsMarkup(replace) && replacement.allowMarkupEdit !== true) {
      throw new SurgeryRefusal(
        `replacements[${index}].replace contains a raw < or >, so it is editing markup rather than text. ` +
        'Write &lt; / &gt; for literal angle brackets in a name, or set allowMarkupEdit: true if restructuring the XML is genuinely what you intend.',
        'MARKUP_IN_REPLACEMENT',
      );
    }

    const matches = countOccurrences(xml, find);
    if (matches !== expected) {
      throw new SurgeryRefusal(
        `replacements[${index}] matched ${matches} time(s), expected exactly ${expected}. Nothing was written. ` +
        (matches === 0
          ? 'Run project_file_inspect and search the XML for the exact literal first.'
          : 'Lengthen the find string until it is unique, or set expectedMatches deliberately.'),
        'MATCH_COUNT_MISMATCH',
      );
    }
    applied.push({ find, replace, matches });
  }

  let edited = xml;
  for (const { find, replace } of applied) edited = edited.split(find).join(replace);
  return { xml: edited, applied };
}

/** Encode XML back into a .prproj payload, matching Premiere's own container. */
export function serializeProjectFile(xml: string, compressed: boolean): Buffer {
  const raw = Buffer.from(xml, 'utf8');
  return compressed ? gzipSync(raw, { level: PRPROJ_GZIP_LEVEL }) : raw;
}

/**
 * Invariant 4. Re-encoding the untouched XML must reproduce the original file byte-for-byte.
 *
 * This is a stronger claim than "the XML survived a round trip", and deliberately so: byte identity
 * proves our writer is indistinguishable from the one that produced this file, so the only
 * difference in the output is the edit itself. A failure means the file came from a writer we have
 * not verified against, which is a reason to stop rather than a reason to try.
 */
export function containerCanary(original: Buffer, file: PrprojFile): { byteIdentical: boolean; semantic: boolean; reencodedBytes: number } {
  const reencoded = serializeProjectFile(file.xml, file.compressed);
  let semantic = false;
  try {
    const decoded = file.compressed ? gunzipSync(reencoded) : reencoded;
    semantic = decoded.toString('utf8') === file.xml;
  } catch {
    semantic = false;
  }
  return { byteIdentical: reencoded.equals(original), semantic, reencodedBytes: reencoded.length };
}

/**
 * Read and decode a project file, or refuse.
 *
 * Refuses rather than returns a partial result: everything downstream decides whether to rewrite
 * someone's project, and a half-read file is not a safe input to that decision.
 */
export function readProjectFile(filePath: string): { file: PrprojFile; raw: Buffer } {
  if (!filePath || typeof filePath !== 'string') {
    throw new SurgeryRefusal('A project file path is required.', 'NO_PATH');
  }
  if (!path.isAbsolute(filePath)) {
    throw new SurgeryRefusal(`"${filePath}" is not an absolute path. Relative paths resolve against this server's working directory, which is not the caller's.`, 'RELATIVE_PATH');
  }
  if (!existsSync(filePath)) {
    throw new SurgeryRefusal(`"${filePath}" does not exist.`, 'NOT_FOUND');
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new SurgeryRefusal(`"${filePath}" is not a file.`, 'NOT_A_FILE');
  }

  const raw = readFileSync(filePath);
  const compressed = raw.length >= 2 && raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1];

  let xml: string;
  try {
    xml = (compressed ? gunzipSync(raw) : raw).toString('utf8');
  } catch (error) {
    throw new SurgeryRefusal(`"${filePath}" could not be decompressed: ${error instanceof Error ? error.message : String(error)}`, 'DECOMPRESS_FAILED');
  }

  const formatVersion = parseFormatVersion(xml);
  return {
    raw,
    file: {
      path: filePath,
      realpath: realpathSync(filePath),
      bytes: raw.length,
      sha256: sha256(raw),
      compressed,
      xml,
      formatVersion,
    },
  };
}

/** Invariant 3. Called separately from reading so `project_file_inspect` can report on odd files. */
export function assertSupportedFormat(file: PrprojFile): void {
  if (file.formatVersion === null) {
    throw new SurgeryRefusal(`"${file.path}" has no <PremiereData Version="..."> root element, so it is not a Premiere project file.`, 'NOT_A_PROJECT');
  }
  if (!PRPROJ_SUPPORTED_FORMAT_VERSIONS.has(file.formatVersion)) {
    throw new SurgeryRefusal(
      `"${file.path}" is PremiereData Version="${file.formatVersion}". This build has only been verified against ` +
      `${[...PRPROJ_SUPPORTED_FORMAT_VERSIONS].join(', ')}, and editing an unverified layout is how a project gets silently corrupted.`,
      'UNSUPPORTED_FORMAT_VERSION',
    );
  }
}

/** Invariant 1. The output must be somewhere new; an existing file is never overwritten. */
export function assertOutputWritable(sourceRealpath: string, outputPath: string): void {
  if (!outputPath || typeof outputPath !== 'string') {
    throw new SurgeryRefusal('An output path is required. This tool never edits in place.', 'NO_OUTPUT_PATH');
  }
  if (!path.isAbsolute(outputPath)) {
    throw new SurgeryRefusal(`"${outputPath}" is not an absolute path.`, 'RELATIVE_OUTPUT_PATH');
  }
  if (existsSync(outputPath)) {
    throw new SurgeryRefusal(
      `"${outputPath}" already exists. This tool never overwrites: pick a new path, or move the existing file aside yourself so the decision is visibly yours.`,
      'OUTPUT_EXISTS',
    );
  }
  const dir = path.dirname(outputPath);
  if (!existsSync(dir)) {
    throw new SurgeryRefusal(`The output directory "${dir}" does not exist.`, 'OUTPUT_DIR_MISSING');
  }
  // Belt and braces for invariant 1: `existsSync` above already rules this out unless the source is
  // a dangling symlink, but in-place editing is the failure mode with no recovery path.
  if (path.resolve(outputPath) === sourceRealpath) {
    throw new SurgeryRefusal('The output path is the source file. This tool never edits in place.', 'IN_PLACE_REFUSED');
  }
}

/**
 * Invariant 8. Off unless the operator explicitly turns it on.
 *
 * A profile exclusion is not sufficient on its own — `call_tool` deliberately reaches past a
 * cost-shaped profile (see router.ts), so a gate that only lived in the tool list would be routable.
 * This one is enforced in the tool body, where nothing can route around it.
 */
export const SURGERY_ENV_FLAG = 'PREMIERE_MCP_ALLOW_PROJECT_FILE_SURGERY';

export function surgeryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[SURGERY_ENV_FLAG] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

export interface WriteResult {
  outputPath: string;
  outputBytes: number;
  outputSha256: string;
  /** Re-read from disk after writing — invariant: what we intended is what landed. */
  readbackMatches: boolean;
  readbackCensusDiff: string[];
}

/**
 * Write the edited document and verify by re-reading it.
 *
 * The readback is the difference between "we called writeFileSync" and "the bytes on disk decode to
 * the document we meant". Reporting the former as success is the same class of lie as a fake
 * verified:true, and it is the one this whole module exists to avoid.
 */
export function writeEditedProject(outputPath: string, editedXml: string, compressed: boolean, expectedCensus: PrprojCensus): WriteResult {
  const payload = serializeProjectFile(editedXml, compressed);
  writeFileSync(outputPath, payload);

  const { file: reread } = readProjectFile(outputPath);
  return {
    outputPath,
    outputBytes: payload.length,
    outputSha256: sha256(payload),
    readbackMatches: reread.xml === editedXml,
    readbackCensusDiff: censusDiff(expectedCensus, censusOf(reread.xml)),
  };
}
