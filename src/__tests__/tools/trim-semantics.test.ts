/**
 * The trim tools against a model of what Premiere 26.5.2 actually does, measured frame by frame
 * from the composited program output (see src/tools/trim-lib.ts):
 *
 *   inPoint = t   slips (timeline range fixed)          start = t   moves the head edge and the content
 *   end = t       trims/extends the tail, source fixed   outPoint    no visible effect
 *   move(t)       relative, this item only
 *
 * The model tracks what each item SHOWS (`src` = source time at its start), so a test asserts the
 * picture, not just the readbacks the old tools were fooled by.
 */

import { PremiereProTools } from '../../tools/index.js';

const TPS = 254016000000;
const FPS24 = 10584000000;

class FakeTime {
  ticks = '0';
  get seconds(): number { return Number(this.ticks) / TPS; }
  set seconds(v: number) { this.ticks = String(Math.round(v * TPS)); }
}
const T = (ticks: number) => { const t = new FakeTime(); t.ticks = String(ticks); return t; };

class Item {
  linked: Item[] = [this];
  constructor(public name: string, public mediaType: 'Video' | 'Audio', public s: number, public e: number, public src: number, public media = 10 * TPS) {}
  get start() { return T(this.s); }
  set start(t: FakeTime) { this.s = Number(t.ticks); } // content moves with the head; src unchanged
  get end() { return T(this.e); }
  set end(t: FakeTime) { this.e = Number(t.ticks); }
  get inPoint() { return T(this.src); }
  set inPoint(t: FakeTime) { this.src = Number(t.ticks); } // slip
  get outPoint() { return T(this.src + this.e - this.s); }
  set outPoint(_t: FakeTime) { /* no visible effect */ }
  get projectItem() { const m = this.media; return { getOutPoint: () => T(m) }; }
  move(t: FakeTime) { const d = Number(t.ticks); this.s += d; this.e += d; }
  getLinkedItems() { const l = this.linked; return Object.assign([...l], { numItems: l.length }); }
  /** Source time shown at timeline time t, or null when this item is not under t. */
  shows(t: number): number | null { return t >= this.s && t < this.e ? this.src + (t - this.s) : null; }
}

function track(items: Item[]) { return { name: 'T', clips: Object.assign(items, { numItems: items.length }) }; }

function fixture(playheadSecs: number) {
  const vA = new Item('A', 'Video', 0, 5 * TPS, 0), vB = new Item('B', 'Video', 5 * TPS, 10 * TPS, 5 * TPS);
  const aA = new Item('A', 'Audio', 0, 5 * TPS, 0), aB = new Item('B', 'Audio', 5 * TPS, 10 * TPS, 5 * TPS);
  vA.linked = [vA, aA]; aA.linked = [aA, vA]; vB.linked = [vB, aB]; aB.linked = [aB, vB];
  const v = track([vA, vB]), a = track([aA, aB]);
  const seq = {
    sequenceID: 'S',
    timebase: String(FPS24),
    videoTracks: Object.assign([v], { numTracks: 1 }),
    audioTracks: Object.assign([a], { numTracks: 1 }),
    getPlayerPosition: () => T(Math.round(playheadSecs * TPS)),
  };
  return { seq, vA, vB, aA, aB };
}

async function run(tool: string, args: Record<string, unknown>, f: ReturnType<typeof fixture>) {
  let script = '';
  const bridge = { executeScript: async (s: string) => { script = s; return { success: true }; } };
  await new PremiereProTools(bridge as never).executeTool(tool, args);
  // buildSeqRes resolves through __findSequence; hand it the fake.
  const out = new Function('Time', '__findSequence', '__findClip', 'app', script)(
    FakeTime, () => f.seq, () => ({ clip: f.vB, sequence: f.seq }),
    { project: { activeSequence: f.seq, sequences: Object.assign([f.seq], { numSequences: 1 }) } });
  return JSON.parse(out);
}

const secs = (t: number | null) => (t === null ? null : Math.round((t / TPS) * 1000) / 1000);

describe('trim tools against measured Premiere semantics', () => {
  it('ripple_trim_in removes the head up to the playhead and closes the space', async () => {
    const f = fixture(6);
    const r = await run('ripple_trim_in', { sequenceId: 'S', trackIndex: 0, clipIndex: 1 }, f);
    expect(r.success).toBe(true);
    expect([secs(f.vB.s), secs(f.vB.e)]).toEqual([5, 9]);
    expect(secs(f.vB.shows(5 * TPS))).toBe(6); // the picture at the cut is the playhead's frame
    expect([secs(f.aB.s), secs(f.aB.e), secs(f.aB.shows(5 * TPS))]).toEqual([5, 9, 6]);
  });

  it('ripple_trim_out removes the tail and ripples later clips left', async () => {
    const f = fixture(3);
    const r = await run('ripple_trim_out', { sequenceId: 'S', trackIndex: 0, clipIndex: 0 }, f);
    expect(r.success).toBe(true);
    expect(secs(f.vA.e)).toBe(3);
    expect([secs(f.vB.s), secs(f.vB.shows(3 * TPS))]).toEqual([3, 5]);
    expect(secs(f.aB.s)).toBe(3);
  });

  it('extend_edit rolls the edit point and keeps the picture continuous', async () => {
    const f = fixture(6);
    const r = await run('extend_edit', { sequenceId: 'S', trackIndex: 0, clipIndex: 0 }, f);
    expect(r.success).toBe(true);
    expect([secs(f.vA.e), secs(f.vB.s)]).toEqual([6, 6]);
    expect(secs(f.vA.shows(5.5 * TPS))).toBe(5.5);
    expect(secs(f.vB.shows(6 * TPS))).toBe(6);
  });

  it('extend_edit refuses to extend past the end of the media', async () => {
    const f = fixture(11);
    const r = await run('extend_edit', { sequenceId: 'S', trackIndex: 0, clipIndex: 1 }, f);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/play black/);
    expect(secs(f.vB.e)).toBe(10);
  });

  it('j_cut starts the audio earlier and trims the previous audio, leaving video alone', async () => {
    const f = fixture(0);
    const r = await run('j_cut', { sequenceId: 'S', videoTrackIndex: 0, clipIndex: 1, frames: 12 }, f);
    expect(r.success).toBe(true);
    expect([secs(f.aA.e), secs(f.aB.s), secs(f.aB.shows(4.5 * TPS))]).toEqual([4.5, 4.5, 4.5]);
    expect([secs(f.vA.e), secs(f.vB.s)]).toEqual([5, 5]);
  });

  it('l_cut runs the audio past the picture and trims the next audio head', async () => {
    const f = fixture(0);
    const r = await run('l_cut', { sequenceId: 'S', videoTrackIndex: 0, clipIndex: 0, frames: 12 }, f);
    expect(r.success).toBe(true);
    expect([secs(f.aA.e), secs(f.aB.s), secs(f.aB.shows(5.5 * TPS))]).toEqual([5.5, 5.5, 5.5]);
  });

  it('nudge_clip moves by a relative offset and takes linked audio with it', async () => {
    const f = fixture(0);
    const r = await run('nudge_clip', { sequenceId: 'S', trackIndex: 0, clipIndex: 1, frames: 24 }, f);
    expect(r.success).toBe(true);
    expect([secs(f.vB.s), secs(f.aB.s)]).toEqual([6, 6]);
  });

  it('trim_clip with a source in-point trims the head in place', async () => {
    const f = fixture(0);
    const r = await run('trim_clip', { clipId: 'B', inPoint: 6 }, f);
    expect(r.success).toBe(true);
    expect([secs(f.vB.s), secs(f.vB.e), secs(f.vB.shows(6 * TPS))]).toEqual([6, 10, 6]);
    expect(secs(f.aB.s)).toBe(6);
  });
});
