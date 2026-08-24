/**
 * Inline image content blocks — let the model actually SEE the frame it asked for.
 *
 * This closes the most-repeated gap found in the 2026-08-24 feature survey: three
 * independent projects return captured pixels to the model as an MCP image content
 * block, and we returned only a filesystem path.
 *
 *   - `CaYatur/PremiereProMCP` — `server/src/tools/vision.ts`, and it labels the image
 *     `[PURE encode]` / `[full Premiere window]` / `[full desktop fallback]` so the model
 *     knows whether it is looking at a real render or a screen grab.
 *   - `MarkelAnthony/uxpplugin-mcpconnector-premierepro` — *"return the actual image so it
 *     can be viewed directly -- not just a file path... Use this to let Claude 'look at'
 *     footage."*
 *   - `mikechambers/adb-mcp` — `get_sequence_frame_image` returns `[result_dict, MCP_Image]`.
 *
 * It matters more for us than for any of them, because a render-truth feedback loop is
 * this project's stated north star. `capture_program_output` existed to prove what the
 * pixels actually look like, and then handed back a path the model cannot open — so the
 * loop was only ever closed if the caller happened to have a filesystem tool. That is a
 * verification claim we could not actually deliver on.
 *
 * Design rules, all deliberate:
 *  - **Additive only.** The text and `structuredContent` blocks are unchanged, so nothing
 *    that parses our results today can break. The image is an extra content block.
 *  - **Never silently omit.** If a frame was written but could not be attached, the reason
 *    is reported in the result rather than the image just not appearing — the same rule we
 *    apply to edits.
 *  - **Bounded.** A 4K PNG is large enough to blow a context window on its own, and the AE
 *    surveys were explicit about this (*"never per-frame or in a loop"*). Over the cap we
 *    attach nothing and say why, including the actual size.
 */

import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';

/**
 * Result fields that, when present, hold a path to an image this server just wrote.
 * Ordered by specificity so the most purpose-built field wins.
 */
const IMAGE_PATH_FIELDS = ['scopePath', 'framePath', 'imagePath', 'contactSheetPath', 'outputPath'];

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * Cap on the encoded payload. Base64 inflates by ~4/3, so this is ~5.3 MB of base64 —
 * already a large slice of a context window, and past it the honest move is to hand back
 * the path and say so rather than flooding the caller.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

export interface ImageAttachment {
  /** An MCP image content block, ready to append to `content`. */
  block: { type: 'image'; data: string; mimeType: string };
  /** The file it came from, so the result stays traceable. */
  sourcePath: string;
  bytes: number;
}

export interface ImageAttachmentOutcome {
  attachment: ImageAttachment | null;
  /**
   * Why no image is attached, when a path was present but unusable. Null when there was
   * no image path at all (the overwhelmingly common case — not worth commenting on).
   */
  reason: string | null;
}

/** Pull the first plausible image path out of a tool result. */
export function findImagePath(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  // Only attach for a call that actually succeeded; a failed tool's stale path is not
  // evidence of anything.
  if (record.success === false) return null;

  for (const field of IMAGE_PATH_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || !value) continue;
    const extension = pathSync.extname(value).toLowerCase();
    if (MIME_BY_EXTENSION[extension]) return value;
  }
  return null;
}

/**
 * Read the image a tool just wrote and return it as an MCP content block.
 *
 * Pure apart from the single file read, and it never throws: an unreadable file yields a
 * stated reason, because a capture tool failing to hand back its own output is exactly the
 * kind of thing this server refuses to paper over.
 */
export function attachImageForResult(
  result: unknown,
  maxBytes: number = MAX_INLINE_IMAGE_BYTES,
): ImageAttachmentOutcome {
  const sourcePath = findImagePath(result);
  if (!sourcePath) return { attachment: null, reason: null };

  const mimeType = MIME_BY_EXTENSION[pathSync.extname(sourcePath).toLowerCase()];
  if (!mimeType) {
    return { attachment: null, reason: `Not an inlineable image type: ${sourcePath}` };
  }

  let bytes: number;
  try {
    const stat = fsSync.statSync(sourcePath);
    if (!stat.isFile()) {
      return { attachment: null, reason: `Image path is not a file: ${sourcePath}` };
    }
    bytes = stat.size;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      attachment: null,
      reason:
        `The tool reported writing ${sourcePath} but it could not be read back (${message}). ` +
        'The image is NOT attached, and the write itself should be treated as unconfirmed.',
    };
  }

  if (bytes === 0) {
    return {
      attachment: null,
      reason:
        `${sourcePath} exists but is empty (0 bytes), so no frame was actually captured. ` +
        'Treat this as a failed capture rather than a successful one.',
    };
  }

  if (bytes > maxBytes) {
    return {
      attachment: null,
      reason:
        `${sourcePath} is ${Math.round(bytes / 1024)} KB, over the ${Math.round(maxBytes / 1024)} KB ` +
        'inline limit, so it is not attached — a full-resolution frame can consume a large ' +
        'share of the context window. The file is on disk at that path; request a smaller ' +
        'capture (lower resolution, or JPEG rather than PNG) to view it inline.',
    };
  }

  try {
    const data = fsSync.readFileSync(sourcePath).toString('base64');
    return { attachment: { block: { type: 'image', data, mimeType }, sourcePath, bytes }, reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { attachment: null, reason: `Could not read ${sourcePath} for inlining: ${message}` };
  }
}
