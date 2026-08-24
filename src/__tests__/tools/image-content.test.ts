/**
 * Tests for inline image content blocks.
 *
 * The behaviour that matters is not "an image comes back" but the honesty around it: a
 * frame that was written and cannot be attached must SAY so, and a zero-byte file must be
 * treated as a failed capture rather than a successful one. `capture_program_output` exists
 * to prove what the pixels look like; a silent omission there would undo the whole point.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attachImageForResult,
  findImagePath,
  MAX_INLINE_IMAGE_BYTES,
} from '../../tools/image-content.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'premiere-mcp-image-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A 1x1 PNG, so the test exercises a real decodable file rather than random bytes. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGP2rBqAAAAAElFTkSuQmCC',
  'base64',
);

function writePng(name: string, contents: Buffer = ONE_PIXEL_PNG): string {
  const target = join(dir, name);
  writeFileSync(target, contents);
  return target;
}

describe('findImagePath', () => {
  it('finds the purpose-built field ahead of the generic one', () => {
    // generate_scope returns scopePath; a result carrying both must not pick outputPath.
    const path = findImagePath({ success: true, scopePath: '/a/scope.png', outputPath: '/a/other.png' });
    expect(path).toBe('/a/scope.png');
  });

  it('recognises each field our capture tools actually return', () => {
    expect(findImagePath({ success: true, outputPath: '/a/frame.png' })).toBe('/a/frame.png');
    expect(findImagePath({ success: true, framePath: '/a/frame.jpg' })).toBe('/a/frame.jpg');
    expect(findImagePath({ success: true, contactSheetPath: '/a/sheet.png' })).toBe('/a/sheet.png');
  });

  it('ignores non-image outputs so an export_sequence mp4 is never inlined', () => {
    expect(findImagePath({ success: true, outputPath: '/a/movie.mp4' })).toBeNull();
    expect(findImagePath({ success: true, outputPath: '/a/report.csv' })).toBeNull();
  });

  it('ignores a path on a failed call', () => {
    // A failed tool's stale path is not evidence of anything.
    expect(findImagePath({ success: false, outputPath: '/a/frame.png' })).toBeNull();
  });

  it('is null for results with no image at all', () => {
    expect(findImagePath({ success: true, sequences: [] })).toBeNull();
    expect(findImagePath(null)).toBeNull();
    expect(findImagePath([1, 2, 3])).toBeNull();
  });
});

describe('attachImageForResult', () => {
  it('attaches a real PNG as an MCP image block', () => {
    const path = writePng('frame.png');
    const outcome = attachImageForResult({ success: true, outputPath: path });

    expect(outcome.reason).toBeNull();
    expect(outcome.attachment).not.toBeNull();
    expect(outcome.attachment!.block.type).toBe('image');
    expect(outcome.attachment!.block.mimeType).toBe('image/png');
    expect(outcome.attachment!.sourcePath).toBe(path);
    expect(outcome.attachment!.bytes).toBe(ONE_PIXEL_PNG.length);
    // Round-trips to the exact bytes on disk.
    expect(Buffer.from(outcome.attachment!.block.data, 'base64')).toEqual(ONE_PIXEL_PNG);
  });

  it('maps jpg and jpeg to image/jpeg', () => {
    const jpg = attachImageForResult({ success: true, framePath: writePng('frame.jpg') });
    const jpeg = attachImageForResult({ success: true, framePath: writePng('frame2.jpeg') });
    expect(jpg.attachment!.block.mimeType).toBe('image/jpeg');
    expect(jpeg.attachment!.block.mimeType).toBe('image/jpeg');
  });

  it('stays silent when there was no image to attach', () => {
    const outcome = attachImageForResult({ success: true, sequences: [] });
    expect(outcome.attachment).toBeNull();
    // No reason: the overwhelmingly common case is not worth commenting on.
    expect(outcome.reason).toBeNull();
  });

  it('reports a missing file rather than omitting the image silently', () => {
    const outcome = attachImageForResult({ success: true, outputPath: join(dir, 'never-written.png') });
    expect(outcome.attachment).toBeNull();
    expect(outcome.reason).toContain('could not be read back');
    // The point of the message: the write itself is now suspect.
    expect(outcome.reason).toContain('unconfirmed');
  });

  it('treats a zero-byte file as a failed capture', () => {
    const empty = writePng('empty.png', Buffer.alloc(0));
    const outcome = attachImageForResult({ success: true, outputPath: empty });
    expect(outcome.attachment).toBeNull();
    expect(outcome.reason).toContain('0 bytes');
    expect(outcome.reason).toContain('failed capture');
  });

  it('refuses an oversize frame and says how to get a viewable one', () => {
    const big = writePng('big.png', Buffer.alloc(2048, 1));
    const outcome = attachImageForResult({ success: true, outputPath: big }, 1024);
    expect(outcome.attachment).toBeNull();
    expect(outcome.reason).toContain('over the');
    expect(outcome.reason).toContain('inline limit');
    // Must remain actionable, and must still say where the file is.
    expect(outcome.reason).toContain('smaller');
    expect(outcome.reason).toContain(big);
  });

  it('rejects a directory that happens to end in .png', () => {
    const fake = join(dir, 'a-directory.png');
    mkdirSync(fake);
    const outcome = attachImageForResult({ success: true, outputPath: fake });
    expect(outcome.attachment).toBeNull();
    expect(outcome.reason).toContain('not a file');
  });

  it('has a default cap large enough for a real frame but not a 4K PNG', () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBeGreaterThan(512 * 1024);
    expect(MAX_INLINE_IMAGE_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
