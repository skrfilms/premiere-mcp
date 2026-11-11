/**
 * replace_clip end to end against a small fake of Premiere's DOM: the generated ExtendScript runs
 * in a vm with the real helpers, so the rehearsal, the slot check, the swap and the undo back are
 * exercised as they run on the host. The fake follows what was measured on 26.5.2: overwriteClip
 * on track n lays video on Vn and channel k of the audio on A(n+k), linked; TrackItem.inPoint
 * slips; start/end move the edges; getLinkedItems() includes the clip itself; every edit is one
 * undo step. With floorFrames on, times snap down to the sequence frame, as Premiere does for a
 * time between frames.
 *
 * Each case pins one way the swap used to report the wrong thing (the reviews of PR #18's v2).
 */
import vm from 'node:vm';
import { EXTENDSCRIPT_HELPERS } from '../../bridge/index.js';
import { AssemblyTools } from '../../tools/domains/assembly.js';
import { STATE_HELPERS } from '../../tools/timeline-state.js';

const TPS = 254016000000;
class FakeTime {
  ticks = '0';
  get seconds() {
    return Number(this.ticks) / TPS;
  }
  set seconds(v: number) {
    this.ticks = String(Math.round(v * TPS));
  }
}
const T = (s: number) => {
  const t = new FakeTime();
  t.seconds = s;
  return t;
};
const list = <X>(xs: X[]): X[] & { numItems: number } =>
  Object.assign(xs.slice(), { numItems: xs.length });
/** Seconds from a bin mark argument: a tick string (what replace_clip passes) or seconds. */
const markSecs = (x: unknown) => (typeof x === 'string' ? Number(x) / TPS : Number(x));

interface Flags {
  ignoreInPointWrites?: boolean;
  endSkew?: number;
  throwOnEndWrite?: boolean;
  throwInOverwriteAfterVideo?: boolean;
  floorFrames?: boolean;
  marksDrift?: boolean;
}

class Model {
  nextId = 100;
  nextLink = 1;
  flags: Flags = {};
  items: any[] = [];
  seq: any;
  frame: number;
  clipsEver: any[] = [];
  propsEver: any[] = [];
  history: any[] = [];
  redoStack: any[] = [];
  private depth = 0;
  constructor(frame = 1 / 24, nV = 3, nA = 4) {
    this.frame = frame;
    const mk = (kind: 'video' | 'audio', i: number) => {
      const track: any = {
        kind,
        index: i,
        _clips: [] as any[],
        _transitions: [] as any[],
        get clips() {
          return list([...this._clips].sort((a: any, b: any) => a.start.seconds - b.start.seconds));
        },
        get transitions() {
          return list(this._transitions);
        },
        overwriteClip: (item: any, time: FakeTime) => this.op(() => this.overwrite(i, item, time)),
      };
      return track;
    };
    const vt: any = Array.from({ length: nV }, (_, i) => mk('video', i));
    vt.numTracks = nV;
    const at: any = Array.from({ length: nA }, (_, i) => mk('audio', i));
    at.numTracks = nA;
    this.seq = {
      sequenceID: 'seq-1',
      name: 'cut',
      videoTracks: vt,
      audioTracks: at,
      markers: { numMarkers: 0 },
      getSettings: () => ({ videoFrameRate: { seconds: this.frame } }),
      getSelection: () => this.allClips().filter((c) => c.selected),
      linkSelection: () =>
        this.op(() => {
          const id = this.nextLink++;
          for (const c of this.allClips()) if (c.selected) c.linkId = id;
        }),
    };
  }

  // ---- undo: every top-level edit is one step, as in Premiere
  private snapshot() {
    const tracks = ['video', 'audio'].flatMap((k) => {
      const ts = this.tracks(k as any);
      return Array.from({ length: ts.numTracks }, (_, i) => ({
        tr: ts[i],
        clips: [...ts[i]._clips],
        trans: [...ts[i]._transitions],
      }));
    });
    return {
      tracks,
      clips: this.clipsEver.map((c) => ({ c, st: { ...c._st }, linkId: c.linkId })),
      props: this.propsEver.map((p) => ({ p, v: p.v })),
    };
  }
  private restore(s: any) {
    for (const t of s.tracks) {
      t.tr._clips = t.clips;
      t.tr._transitions = t.trans;
    }
    for (const x of s.clips) {
      Object.assign(x.c._st, x.st);
      x.c.linkId = x.linkId;
    }
    for (const x of s.props) x.p.v = x.v;
  }
  op<R>(fn: () => R): R {
    if (this.depth === 0) {
      this.history.push(this.snapshot());
      this.redoStack = [];
    }
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }
  undo() {
    const s = this.history.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.history.push(this.snapshot());
    this.restore(s);
  }
  snap(x: number) {
    return this.flags.floorFrames ? Math.floor(x / this.frame + 1e-6) * this.frame : x;
  }

  prop(v: any) {
    const p: any = {
      v,
      displayName: 'p',
      isTimeVarying: () => false,
      getValue: () => p.v,
      setValue: (x: any) =>
        this.op(() => {
          p.v = x;
        }),
    };
    this.propsEver.push(p);
    return p;
  }
  components(kind: 'video' | 'audio') {
    const defs =
      kind === 'video'
        ? [
            { matchName: 'AE.ADBE Opacity', displayName: 'Opacity', v: 100 },
            { matchName: 'AE.ADBE Motion', displayName: 'Motion', v: 100 },
          ]
        : [{ matchName: 'AE.ADBE Volume', displayName: 'Volume', v: 0 }];
    return list(
      defs.map((d) => ({
        matchName: d.matchName,
        displayName: d.displayName,
        properties: list([this.prop(d.v)]),
      })),
    );
  }
  item(name: string, secs: number, audioChannels: number, hasVideo = true) {
    const model = { flags: () => this.flags };
    const it: any = {
      nodeId: `item-${this.items.length + 1}`,
      name,
      type: 1,
      hasVideo,
      audioChannels,
      inMark: 0,
      outMark: secs,
      getInPoint: () => T(it.inMark + (model.flags().marksDrift ? 1 / TPS : 0)),
      getOutPoint: () => T(it.outMark),
      setInPoint: (s: unknown) => {
        it.inMark = markSecs(s);
      },
      setOutPoint: (s: unknown) => {
        it.outMark = markSecs(s);
      },
      getProjectMetadata: () => {
        const f = Math.round(secs * 24);
        const tc = `00:00:${String(Math.floor(f / 24)).padStart(2, '0')}:${String(f % 24).padStart(2, '0')}`;
        return `<premierePrivateProjectMetaData:Column.Intrinsic.MediaDuration>${tc}</premierePrivateProjectMetaData:Column.Intrinsic.MediaDuration>`;
      },
      getFootageInterpretation: () => ({ frameRate: 24 }),
      isSequence: () => false,
      isMulticamClip: () => false,
    };
    this.items.push(it);
    return it;
  }
  tracks(kind: 'video' | 'audio') {
    return kind === 'video' ? this.seq.videoTracks : this.seq.audioTracks;
  }
  allClips(): any[] {
    const out: any[] = [];
    for (const k of ['video', 'audio'] as const) {
      const ts = this.tracks(k);
      for (let i = 0; i < ts.numTracks; i++) out.push(...ts[i]._clips);
    }
    return out;
  }
  clip(
    item: any,
    kind: 'video' | 'audio',
    track: number,
    start: number,
    end: number,
    inPoint: number,
    o: { linkId?: number; channel?: number; isNew?: boolean } = {},
  ) {
    const flags = () => this.flags;
    const snap = (x: number) => this.snap(x);
    const op = <R>(fn: () => R) => this.op(fn);
    const tracksOf = (k: 'video' | 'audio') => this.tracks(k);
    const all = () => this.allClips();
    const c: any = {
      _st: { start: start, end: end, inPoint: inPoint },
      nodeId: String(this.nextId++),
      name: item.name,
      projectItem: item,
      kind,
      trackIndex: track,
      channel: o.channel ?? 0,
      linkId: o.linkId ?? 0,
      isNew: !!o.isNew,
      disabled: false,
      selected: false,
      speed: 1,
      components: this.components(kind),
      get start() {
        return T(c._st.start);
      },
      set start(t: FakeTime) {
        op(() => {
          c._st.start = snap(t.seconds);
        });
      },
      get end() {
        return T(c._st.end);
      },
      set end(t: FakeTime) {
        if (c.isNew && flags().throwOnEndWrite) throw new Error('end write refused');
        op(() => {
          c._st.end = snap(t.seconds) + (c.isNew ? (flags().endSkew ?? 0) : 0);
        });
      },
      get inPoint() {
        return T(c._st.inPoint);
      },
      set inPoint(t: FakeTime) {
        if (c.isNew && flags().ignoreInPointWrites) return;
        op(() => {
          c._st.inPoint = t.seconds;
        });
      },
      getSpeed: () => c.speed,
      isSpeedReversed: () => false,
      setSelected: (on: boolean) => {
        c.selected = on;
      },
      getLinkedItems: () => list(c.linkId ? all().filter((x) => x.linkId === c.linkId) : [c]),
      remove: () =>
        op(() => {
          const tr = tracksOf(kind)[c.trackIndex];
          tr._clips = tr._clips.filter((x: any) => x !== c);
          // Premiere drops a clip's edge transitions with it.
          const s = c._st.start,
            e = c._st.end;
          tr._transitions = tr._transitions.filter(
            (x: any) => !(x.start.seconds <= e && x.end.seconds >= s),
          );
        }),
    };
    this.clipsEver.push(c);
    this.tracks(kind)[track]._clips.push(c);
    return c;
  }
  overwrite(n: number, item: any, time: FakeTime) {
    const start = this.snap(time.seconds),
      dur = item.outMark - item.inMark,
      linkId = this.nextLink++;
    const put = (k: 'video' | 'audio', t: number, ch: number) => {
      const tr = this.tracks(k)[t];
      if (!tr) return;
      // Overwrite: what lies under the new piece goes (Premiere splits it; removing is enough here).
      for (const x of [...tr._clips])
        if (x._st.start < start + dur - 1e-9 && x._st.end > start + 1e-9) x.remove();
      this.clip(item, k, t, start, start + dur, item.inMark, { linkId, channel: ch, isNew: true });
    };
    if (item.hasVideo) put('video', n, 0);
    if (this.flags.throwInOverwriteAfterVideo) throw new Error('overwriteClip failed part-way');
    for (let ch = 0; ch < item.audioChannels; ch++) put('audio', n + ch, ch);
  }
  /** What the timeline holds, for "nothing changed" checks. */
  layout() {
    return this.allClips()
      .map(
        (c) =>
          `${c.kind[0]}${c.trackIndex + 1}:${c.projectItem.nodeId}#${c.channel}@${c._st.start.toFixed(4)}-${c._st.end.toFixed(4)}/${c._st.inPoint.toFixed(4)}`,
      )
      .sort();
  }
  linkedTo(c: any) {
    return this.allClips().filter((x) => x !== c && x.linkId && x.linkId === c.linkId);
  }
  context() {
    return vm.createContext({
      Time: FakeTime,
      app: {
        enableQE: () => true,
        project: {
          rootItem: { nodeId: 'root', children: list(this.items) },
          sequences: Object.assign([this.seq], { numSequences: 1 }),
          activeSequence: this.seq,
          openSequence: () => true,
        },
      },
      qe: {
        project: {
          numSequences: 0,
          getSequenceAt: () => null,
          getVideoEffectByName: () => null,
          getAudioEffectByName: () => null,
          getVideoTransitionByName: () => null,
          getAudioTransitionByName: () => null,
          undo: () => this.undo(),
          redo: () => this.redo(),
        },
      },
    });
  }
}

/** A bridge that runs each script in the fake, as the CEP bridge wraps it. */
function bridgeFor(model: Model, between?: (call: number) => void) {
  const ctx = model.context();
  let call = 0;
  return {
    executeScript: async (script: string) => {
      if (between) between(call);
      call++;
      const out = vm.runInContext(
        EXTENDSCRIPT_HELPERS + '(function(){\n' + script + '\n})();',
        ctx,
      );
      return typeof out === 'string' ? JSON.parse(out) : out;
    },
  };
}
const swapOn = (m: Model, clip: any, item: any, between?: (call: number) => void) =>
  new AssemblyTools(bridgeFor(m, between) as never).replaceClip(
    clip.nodeId,
    item.nodeId,
    true,
  ) as Promise<any>;

/** The usual edit: V1 clip 10-15 s (in 2 s) with its linked A1, a neighbour on each side. */
function standard(model: Model, oldItem: any) {
  const other = model.item('other', 60, 1);
  model.clip(other, 'video', 0, 0, 10, 0, { linkId: 900 });
  model.clip(other, 'audio', 0, 0, 10, 0, { linkId: 900 });
  const v = model.clip(oldItem, 'video', 0, 10, 15, 2, { linkId: 901 });
  const a = model.clip(oldItem, 'audio', 0, 10, 15, 2, { linkId: 901 });
  model.clip(other, 'video', 0, 15, 20, 30, { linkId: 902 });
  model.clip(other, 'audio', 0, 15, 20, 30, { linkId: 902 });
  return { v, a };
}
const placedFrom = (m: Model, item: any) =>
  m
    .allClips()
    .filter((c) => c.projectItem === item)
    .map((c) => `${c.kind}${c.trackIndex}@${c._st.start}-${c._st.end}/${c._st.inPoint}`)
    .sort();

describe('replace_clip against a fake Premiere', () => {
  it('swaps a linked clip in place, leaves nothing staged and puts the bin marks back', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 1);
    const newItem = m.item('shot_v002', 30, 1);
    const { v } = standard(m, oldItem);
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    expect(placedFrom(m, newItem)).toEqual(['audio0@10-15/2', 'video0@10-15/2']);
    expect(m.allClips().filter((c) => c.projectItem === oldItem)).toHaveLength(0);
    expect(m.allClips().every((c) => c._st.end <= 20 + 1e-9)).toBe(true);
    expect([newItem.inMark, newItem.outMark]).toEqual([0, 30]);
  });

  it('keeps the sync sound and links it to a picture-only render', async () => {
    const m = new Model();
    const oldItem = m.item('plate', 30, 1);
    const render = m.item('shot_comp_v003', 30, 0); // a VFX render: no audio
    const { v, a } = standard(m, oldItem);
    const r = await swapOn(m, v, render);
    expect(r.success).toBe(true);
    expect(r.linkedKept).toBe(1);
    expect(r.note).toContain('A1 (the new media has no audio)');
    expect(placedFrom(m, render)).toEqual(['video0@10-15/2']);
    // The plate's own audio is untouched, and linked to the new picture.
    expect(m.allClips()).toContain(a);
    expect([a._st.start, a._st.end, a._st.inPoint]).toEqual([10, 15, 2]);
    const newV = m.allClips().find((c) => c.projectItem === render);
    expect(m.linkedTo(newV)).toEqual([a]);
  });

  it('keeps a dual-system WAV and links it to the new picture', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 0);
    const wav = m.item('sound_roll.wav', 300, 1, false);
    const newItem = m.item('shot_v002', 30, 0);
    const v = m.clip(oldItem, 'video', 0, 10, 15, 2, { linkId: 7 });
    const w = m.clip(wav, 'audio', 0, 10, 15, 120, { linkId: 7 });
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(true);
    expect(r.note).toContain('comes from other media ("sound_roll.wav")');
    expect([w._st.start, w._st.end, w._st.inPoint]).toEqual([10, 15, 120]);
    expect(m.linkedTo(m.allClips().find((c) => c.projectItem === newItem))).toEqual([w]);
  });

  it('refuses when new media with sound would land on a kept dual-system WAV', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 0);
    const wav = m.item('sound_roll.wav', 300, 1, false);
    const newItem = m.item('shot_v002', 30, 1);
    const v = m.clip(oldItem, 'video', 0, 10, 15, 2, { linkId: 7 });
    m.clip(wav, 'audio', 0, 10, 15, 120, { linkId: 7 });
    const before = m.layout();
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toContain('would overwrite A1 "sound_roll.wav"');
    expect(m.layout()).toEqual(before);
  });

  it('refuses when a J-cut audio piece cannot take its old in point', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 1);
    const newItem = m.item('shot_v002', 30, 1);
    // Audio leads the picture by 1 s: it starts at 9 s, 1 s earlier in the source.
    const v = m.clip(oldItem, 'video', 0, 10, 15, 2, { linkId: 5 });
    m.clip(oldItem, 'audio', 0, 9, 15, 1, { linkId: 5 });
    m.flags.ignoreInPointWrites = true;
    const before = m.layout();
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toMatch(/A1 starts at .* of the new media, not 1s/);
    expect(m.layout()).toEqual(before);
  });

  it('holds spans to half a frame at 60p, not 0.02 s', async () => {
    const m = new Model(1 / 60);
    const oldItem = m.item('shot_v001', 30, 1);
    const newItem = m.item('shot_v002', 30, 1);
    const { v } = standard(m, oldItem);
    m.flags.endSkew = 0.015; // under the old 0.02 s, nearly a whole frame at 60p
    const before = m.layout();
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toContain('could not be trimmed to its old span');
    expect(m.layout()).toEqual(before);
  });

  it('stages on the frame grid at 23.976, so a good swap is not refused', async () => {
    const f = 1001 / 24000;
    const m = new Model(f);
    m.flags.floorFrames = true;
    const oldItem = m.item('shot_v001', 60, 1);
    const newItem = m.item('shot_v002', 60, 1);
    const other = m.item('other', 60, 1);
    // The edit ends at 7.007 s, so a whole-second staging point (18 s) is 0.57 of a frame off.
    m.clip(other, 'video', 0, 0, 48 * f, 0, { linkId: 900 });
    const v = m.clip(oldItem, 'video', 0, 48 * f, 144 * f, 24 * f, { linkId: 901 });
    m.clip(oldItem, 'audio', 0, 48 * f, 144 * f, 24 * f, { linkId: 901 });
    m.clip(other, 'video', 0, 144 * f, 168 * f, 0, { linkId: 902 });
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(true);
  });

  it('removes the staged pieces when the rehearsal throws part-way', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 1);
    const newItem = m.item('shot_v002', 30, 1);
    const { v } = standard(m, oldItem);
    m.flags.throwOnEndWrite = true;
    const before = m.layout();
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toContain('The temporary pieces were removed');
    expect(m.layout()).toEqual(before);
  });

  it('puts the bin marks back and removes what landed when overwriteClip throws', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 1);
    const newItem = m.item('shot_v002', 30, 1);
    const { v } = standard(m, oldItem);
    m.flags.throwInOverwriteAfterVideo = true;
    const before = m.layout();
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect([newItem.inMark, newItem.outMark]).toEqual([0, 30]);
    expect(m.layout()).toEqual(before);
  });

  it('stops when the bin marks do not read back as they were', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 1);
    const newItem = m.item('shot_v002', 30, 1);
    const { v } = standard(m, oldItem);
    m.flags.marksDrift = true;
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.error).toContain('In/Out marks of the new item');
  });

  it('refuses dual-mono audio that does not sit where a fresh placement lays its channels', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 2);
    const newItem = m.item('shot_v002', 30, 2);
    // Channel 1 on A2 and channel 2 on A3 (moved down a track); a fresh placement under V1 uses A1+A2.
    const v = m.clip(oldItem, 'video', 0, 10, 15, 2, { linkId: 3 });
    m.clip(oldItem, 'audio', 1, 10, 15, 2, { linkId: 3, channel: 0 });
    m.clip(oldItem, 'audio', 2, 10, 15, 2, { linkId: 3, channel: 1 });
    const before = m.layout();
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toContain('2 channel clips on A2+A3');
    expect(m.layout()).toEqual(before);
  });

  it('swaps dual-mono audio laid out as Premiere lays it, from the picture or from a channel', async () => {
    for (const clicked of ['video', 'audio2'] as const) {
      const m = new Model();
      const oldItem = m.item('shot_v001', 30, 2);
      const newItem = m.item('shot_v002', 30, 2);
      const v = m.clip(oldItem, 'video', 0, 10, 15, 2, { linkId: 3 });
      m.clip(oldItem, 'audio', 0, 10, 15, 2, { linkId: 3, channel: 0 });
      const a2 = m.clip(oldItem, 'audio', 1, 10, 15, 2, { linkId: 3, channel: 1 });
      const r = await swapOn(m, clicked === 'video' ? v : a2, newItem);
      expect(r.success).toBe(true);
      const audio = m.allClips().filter((c) => c.projectItem === newItem && c.kind === 'audio');
      expect(audio.map((c) => [c.trackIndex, c.channel]).sort()).toEqual([
        [0, 0],
        [1, 1],
      ]);
    }
  });

  it('refuses when the new media has more audio channel clips than the old clip used', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 1); // one stereo clip
    const newItem = m.item('shot_v002', 30, 2); // dual mono
    const { v } = standard(m, oldItem);
    const before = m.layout();
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toContain('would drop a channel');
    expect(m.layout()).toEqual(before);
  });

  it('refuses a linked piece at another speed', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 1);
    const newItem = m.item('shot_v002', 30, 1);
    const v = m.clip(oldItem, 'video', 0, 10, 15, 2, { linkId: 4 });
    const a = m.clip(oldItem, 'audio', 0, 10, 15, 2, { linkId: 4 });
    a.speed = 2;
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toContain('A1 piece of the clip is speed-changed');
  });

  it('stops before touching anything when the clip was trimmed between the check and the swap', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 1);
    const newItem = m.item('shot_v002', 30, 1);
    const { v } = standard(m, oldItem);
    // After the rehearsal (call 0) and before the swap (call 1), someone trims the old clip.
    const r = await swapOn(m, v, newItem, (call) => {
      if (call === 1) v.end = T(14);
    });
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toContain('since it was checked');
    expect(v._st.end).toBe(14);
    expect(m.allClips().filter((c) => c.projectItem === oldItem)).toHaveLength(2);
    expect(m.allClips().filter((c) => c.projectItem === newItem)).toHaveLength(0);
  });

  it('stops before touching anything when a clip lands in the slot between the check and the swap', async () => {
    const m = new Model();
    const oldItem = m.item('shot_v001', 30, 0);
    const newItem = m.item('shot_v002', 30, 2); // lays audio on A1+A2
    const music = m.item('music', 120, 1, false);
    const v = m.clip(oldItem, 'video', 0, 10, 15, 2);
    let dropped: any = null;
    const r = await swapOn(m, v, newItem, (call) => {
      if (call === 1) dropped = m.clip(music, 'audio', 1, 8, 18, 0);
    });
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toContain('A2 "music"');
    expect(m.allClips()).toContain(dropped);
    expect(m.allClips().filter((c) => c.projectItem === newItem)).toHaveLength(0);
  });

  it('undoes back to the old clip when a same-named re-render cannot carry everything', async () => {
    const m = new Model();
    const oldItem = m.item('shot', 30, 1);
    const newItem = m.item('shot', 30, 1); // a re-render under the same file name
    const { v } = standard(m, oldItem);
    // A cross dissolve ending at the clip's tail: the fake QE cannot re-add it, so the swap fails
    // after the old clip is gone and has to be undone, past pieces that read the same by name.
    m.seq.videoTracks[0]._transitions.push({
      name: 'Cross Dissolve',
      matchName: 'AE.ADBE Cross Dissolve New',
      start: T(14.5),
      end: T(15),
    });
    const before = m.layout();
    const r = await swapOn(m, v, newItem);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.undoSteps).toBeGreaterThan(0);
    expect(m.layout()).toEqual(before);
  });
});

describe('replace_clip revert accounting', () => {
  const prepReply = {
    success: true,
    seq: 'seq-1',
    oldIds: ['1'],
    members: [
      { id: '1', type: 'video', track: 0, start: 1, end: 2, inPoint: 0, isMain: true, snap: [] },
    ],
    transitions: [],
    footprint: [],
    frame: 1 / 24,
  };
  it('treats a revert that took 0 undo steps as not undone', async () => {
    const replies: any[] = [
      prepReply,
      {
        success: false,
        revert: true,
        touched: true,
        beforeHash: 'abc',
        problems: ['x did not carry'],
      },
      { success: true, undoSteps: 0 },
    ];
    const bridge = { executeScript: async () => replies.shift() };
    const r: any = await new AssemblyTools(bridge as never).replaceClip('1', 'item-2', true);
    expect(r.success).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.error).toContain('cannot be told');
  });

  it('reports nothing changed when the swap stopped before touching the old clip', async () => {
    const replies: any[] = [
      prepReply,
      { success: false, revert: true, touched: false, beforeHash: null, problems: ['boom'] },
    ];
    const bridge = { executeScript: async () => replies.shift() };
    const r: any = await new AssemblyTools(bridge as never).replaceClip('1', 'item-2', true);
    expect(r.changed).toBe(false);
    expect(replies).toHaveLength(0);
  });
});

describe('timeline state hash', () => {
  it('differs when only the source item of a clip differs', () => {
    const ctx = vm.createContext({ app: {} });
    vm.runInContext(STATE_HELPERS, ctx);
    const seqWith = (itemId: string) => {
      const clip = {
        name: 'shot',
        nodeId: '1',
        projectItem: { nodeId: itemId },
        start: { ticks: '0', seconds: 0 },
        end: { ticks: String(TPS), seconds: 1 },
        inPoint: { ticks: '0', seconds: 0 },
      };
      const vt: any = [{ clips: list([clip]) }];
      vt.numTracks = 1;
      const at: any = [];
      at.numTracks = 0;
      return {
        videoTracks: vt,
        audioTracks: at,
        markers: { numMarkers: 0 },
        sequenceID: 's',
        name: 's',
      };
    };
    (ctx as any).app = {
      project: { sequences: { numSequences: 1 }, rootItem: { children: list([]) } },
    };
    const h = (id: string) => {
      (ctx as any).s = seqWith(id);
      return vm.runInContext('__tlState(s, false).hash', ctx);
    };
    expect(h('item-1')).not.toBe(h('item-2'));
    expect(h('item-1')).toBe(h('item-1'));
  });
});
