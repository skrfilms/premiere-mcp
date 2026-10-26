/**
 * Two tools that could only ever act on one thing at a time.
 *
 * copy_effects_between_clips resolved both clip ids through findClip(), which
 * looks in args.sequenceId or the active sequence and nowhere else. Two valid
 * ids in two different sequences therefore came back as "Source or target clip
 * not found" — while lifting an effect stack off a reference sequence onto a new
 * one is the main reason to reach for the tool at all.
 *
 * set_clip_scale_to_frame_size is per-clip, so normalising a 45-clip stringout
 * cost 45 round-trips. set_scale_to_frame_size_batch covers a track, every video
 * track, or a clip-id list in one call, and reports each clip's readback rather
 * than one blanket success.
 */

import { PremiereProTools } from '../../tools/index.js';
import { executeExpandedTool } from '../../tools/expanded.js';

describe('copy_effects_between_clips across sequences', () => {
  const scriptFor = async (args: Record<string, unknown>): Promise<string> => {
    let script = '';
    const bridge = { executeScript: async (s: string) => { script = s; return { success: true }; } };
    await executeExpandedTool(bridge as never, 'copy_effects_between_clips', args);
    return script;
  };

  const caseBody = (script: string): string => {
    const start = script.indexOf('case "copy_effects_between_clips":');
    expect(start).toBeGreaterThan(-1);
    const rest = script.slice(start);
    // The block ends at the next case label that follows real statements; the
    // handler is shared with copy_effect_values via a consecutive label.
    const end = rest.indexOf('case "replace_clip_media":');
    expect(end).toBeGreaterThan(0);
    return rest.slice(0, end);
  };

  it('resolves each clip across every sequence instead of only the active one', async () => {
    const body = caseBody(await scriptFor({ sourceClipId: 'A', targetClipId: 'B' }));

    expect(body).toContain('findClipAnySequence(');
    // findClip() is the single-sequence lookup that caused the bug.
    expect(body).not.toMatch(/findClip\(args\.sourceClipId/);
    expect(body).not.toMatch(/findClip\(args\.targetClipId/);
  });

  it('accepts a sequence id per side', async () => {
    const body = caseBody(await scriptFor({ sourceClipId: 'A', targetClipId: 'B' }));

    expect(body).toContain('args.sourceSequenceId');
    expect(body).toContain('args.targetSequenceId');
  });

  it('reports which side failed rather than one ambiguous message', async () => {
    const body = caseBody(await scriptFor({ sourceClipId: 'A', targetClipId: 'B' }));

    expect(body).toContain('"Source"');
    expect(body).toContain('"Target"');
    expect(body).not.toContain('Source or target clip not found');
  });

  it('the resolver honours an explicit sequence id and never falls back to the active one', async () => {
    const script = await scriptFor({ sourceClipId: 'A', targetClipId: 'B' });
    const helper = script.slice(script.indexOf('function findClipAnySequence'));
    const body = helper.slice(0, helper.indexOf('function clipInfo'));

    // An unresolvable explicit id is an error. Substituting the active sequence
    // is the exact silent-retarget failure the rest of this catalogue guards.
    expect(body).toContain('Sequence not found by id:');
    expect(body).toContain('app.project.sequences.numSequences');
    expect(body).toContain('scanSequenceForClip(activeSequence(), nodeId)');
  });

  it('names the components present when nothing matched, instead of just failing', async () => {
    const body = caseBody(await scriptFor({ sourceClipId: 'A', targetClipId: 'B' }));

    expect(body).toContain('sourceComponents: componentNames(copySource.clip)');
  });
});

describe('set_scale_to_frame_size_batch', () => {
  let tools: PremiereProTools;
  let bridge: { executeScript: jest.Mock };

  beforeEach(() => {
    bridge = { executeScript: jest.fn().mockResolvedValue({ success: true }) };
    tools = new PremiereProTools(bridge as never);
  });

  // The LAST call, not the first: a test that invokes the tool twice would
  // otherwise assert twice against the first script and pass regardless.
  const script = async (args: Record<string, unknown>): Promise<string> => {
    await tools.executeTool('set_scale_to_frame_size_batch', args);
    const calls = bridge.executeScript.mock.calls;
    return calls[calls.length - 1][0] as string;
  };

  it('is registered and reaches its handler', async () => {
    const s = await script({});

    expect(s).toContain('setScaleToFrameSize(true)');
  });

  it('passes an explicit boolean, because a bare call throws Not Enough Parameters', async () => {
    expect(await script({ enabled: false })).toContain('setScaleToFrameSize(false)');
    expect(await script({})).not.toContain('setScaleToFrameSize()');
  });

  it('covers every video track when no trackIndex is given', async () => {
    const s = await script({});

    expect(s).toContain('seq.videoTracks.numTracks - 1');
  });

  it('scopes to one track when trackIndex is given', async () => {
    const s = await script({ trackIndex: 2 });

    expect(s).toContain('var firstTrack = 2;');
  });

  it('addresses the requested sequence, not whatever is on screen', async () => {
    const s = await script({ sequenceId: 'SEQ-1' });

    expect(s).toContain('__findSequence("SEQ-1")');
    expect(s).not.toContain('qe.project.getActiveSequence()');
  });

  it('matches QE items to clips by start time, not by index', async () => {
    const s = await script({});

    expect(s).toContain('__findQeClipByDomClip(qeTrack, domClip)');
    expect(s).not.toContain('getItemAt(c)');
  });

  it('reports requested clip ids it never found instead of ignoring them', async () => {
    const s = await script({ clipIds: ['A', 'B'] });

    expect(s).toContain('var wantedIds = ["A","B"];');
    expect(s).toContain('notFoundClipIds');
  });

  it('does not claim verified when a clip readback was unavailable', async () => {
    const s = await script({});

    expect(s).toContain('verified: failed.length === 0 && skipped.length === 0');
    expect(s).toContain('unverifiedReason');
  });

  it('says so when the scope matched nothing rather than reporting success', async () => {
    const s = await script({});

    expect(s).toContain('No clips matched the requested scope');
    expect(s).toContain('total > 0');
  });
});
