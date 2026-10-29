/**
 * Declared result shapes for the most-called tools (MCP outputSchema).
 *
 * A client that knows the shape can check a result and hand the assistant typed data instead of
 * text to parse. Every field is optional and extra fields are allowed: a failure is
 * { success: false, error }, and the server adds fields of its own (routed, resultTruncated,
 * changedOutsideThisServer), so a strict schema would turn an honest error into a protocol
 * failure. What the schema pins down is the TYPE of each field when it is there.
 */
import { z } from 'zod';

const base = { success: z.boolean().optional(), error: z.string().optional(), verified: z.boolean().optional() };
const seqRef = z.looseObject({ id: z.string().optional(), name: z.string().optional() }).nullable().optional();
const clip = z.looseObject({ id: z.string().optional(), name: z.string().optional(), track: z.string().optional(), start: z.number().optional(), end: z.number().optional(), inPoint: z.number().optional() });
const track = z.looseObject({ index: z.number().optional(), name: z.string().optional(), clipCount: z.number().optional(), clips: z.array(z.looseObject({})).optional() });

export const OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  get_project_info: z.looseObject({ ...base, name: z.string().optional(), path: z.string().optional(), activeSequence: seqRef, itemCount: z.number().optional(), sequenceCount: z.number().optional(), hasActiveSequence: z.boolean().optional(), projectNotesPath: z.string().optional(), projectNotes: z.string().nullable().optional() }),
  verify_premiere_connection: z.looseObject({ ...base, status: z.string().optional(), bridge: z.string().optional(), premiere: z.looseObject({ version: z.string().optional(), build: z.string().optional() }).nullable().optional(), project: z.looseObject({ name: z.string().optional(), path: z.string().optional(), sequenceCount: z.number().optional() }).nullable().optional(), activeSequence: seqRef, readOnly: z.boolean().optional() }),
  list_sequences: z.looseObject({ ...base, count: z.number().optional(), sequences: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), duration: z.number().optional(), width: z.number().optional(), height: z.number().optional(), videoTrackCount: z.number().optional(), audioTrackCount: z.number().optional() })).optional() }),
  get_active_sequence: z.looseObject({ ...base, id: z.string().optional(), name: z.string().optional(), duration: z.number().optional(), videoTrackCount: z.number().optional(), audioTrackCount: z.number().optional() }),
  list_sequence_tracks: z.looseObject({ ...base, sequenceId: z.string().optional(), sequenceName: z.string().optional(), videoTracks: z.array(track).optional(), audioTracks: z.array(track).optional(), totalVideoTracks: z.number().optional(), totalAudioTracks: z.number().optional() }),
  list_project_items: z.looseObject({ ...base, items: z.array(z.looseObject({ id: z.string().optional(), name: z.string().optional(), type: z.string().optional(), treePath: z.string().optional(), mediaPath: z.string().optional() })).optional(), totalItems: z.number().optional(), matchingItems: z.number().optional(), returned: z.number().optional(), hasMore: z.boolean().optional(), nextOffset: z.number().optional() }),
  get_playhead_position: z.looseObject({ ...base, position: z.number().optional(), ticks: z.string().optional() }),
  get_selected_clips: z.looseObject({ ...base, count: z.number().optional(), clips: z.array(z.looseObject({})).optional() }),
  timeline_fingerprint: z.looseObject({ ...base, fingerprint: z.string().optional(), clipCount: z.number().optional(), sequenceName: z.string().optional() }),
  what_changed: z.looseObject({ ...base, changed: z.boolean().optional(), summary: z.string().optional(), baselineRecorded: z.boolean().optional(), added: z.array(clip).optional(), removed: z.array(clip).optional(), moved: z.array(z.looseObject({ id: z.string().optional() })).optional() }),
  revert_last_call: z.looseObject({ ...base, reverted: z.string().optional(), undoSteps: z.number().optional(), restoredToAfter: z.boolean().optional() }),
  get_recent_calls: z.looseObject({ ...base, calls: z.array(z.looseObject({ tool: z.string().optional(), status: z.string().optional(), readOnly: z.boolean().optional(), startedAt: z.string().optional(), finishedAt: z.string().optional() })).optional() }),
  get_job: z.looseObject({ ...base, jobId: z.string().optional(), status: z.string().optional() }),
  find_tool: z.looseObject({ ...base, matches: z.array(z.looseObject({ name: z.string().optional(), exposed: z.boolean().optional(), description: z.string().optional() })).optional() }),
  get_project_notes: z.looseObject({ ...base, path: z.string().optional(), notes: z.string().nullable().optional() }),
};

const cache = new Map<string, Record<string, unknown>>();
export function outputJsonSchema(name: string): Record<string, unknown> | undefined {
  const s = OUTPUT_SCHEMAS[name];
  if (!s) return undefined;
  if (!cache.has(name)) {
    // No $schema key: some clients validate with draft-07 tooling that rejects a 2020-12 URI.
    const { $schema: _drop, ...json } = z.toJSONSchema(s, { unrepresentable: 'any' }) as Record<string, unknown>;
    cache.set(name, json);
  }
  return cache.get(name);
}
