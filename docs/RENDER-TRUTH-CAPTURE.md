# Render-truth capture: what we can actually see, and what we cannot

Every other Premiere MCP tells an agent its instruction was *received*. This layer exists to
tell it what happened to the **pixels**. That only has value if the agent can tell the
difference between a frame Premiere rendered and a photograph of a monitor, so the first job of
this document is to be blunt about which is which.

Code: `src/capture/`. Nothing in it talks to Premiere; frames arrive through an injected
`FrameSource`, so all of it is testable without a host. Tests: `src/__tests__/capture/`.

---

## 1. What this machine can genuinely capture

Probed on macOS 26.5 (Darwin 25.5.0), arm64, ffmpeg/ffprobe 8.1, Premiere 26.3.2 running.

| Capability | Verdict | Evidence |
|---|---|---|
| Premiere frame export (**render tap**) | **Works** (already shipped as `capture_program_output`) | Existing tool |
| Frames read back out of a Premiere **export file** | **Works**, zero new dependencies | ffmpeg decode |
| **Screen capture** of the display, incl. live video | **Works** | `ffmpeg -devices` lists `avfoundation`; `-list_devices` lists `Capture screen 0/1/2`; a 1-frame grab produced a 2560x1440 PNG and a 0.5s grab produced 15 frames at 30fps |
| Timecode **burn-in** on captured frames | **Works** | `drawtext` is compiled in (`--enable-libfreetype`); `/System/Library/Fonts/Menlo.ttc` present |
| Numeric **frame diffing** | **Works** | `blend=difference` + `signalstats`, plus `psnr` and `ssim` filters all present and verified |
| **NDI** receive | **Impossible without a native module** | ffmpeg has no NDI demuxer (`libndi_newtek` was removed upstream and is not in this build's `-formats`), and there is no NDI runtime installed (`/usr/local/lib/libndi*`, `/Library/NDI*` absent) |
| **Syphon** receive | **Impossible without a native module** | Syphon shares IOSurface GPU textures; there is no ffmpeg input device for it and no Syphon framework installed |
| **Spout** receive | **Impossible here, ever** | Windows-only (DirectX texture sharing) |
| Locating Premiere's **Program monitor** on screen automatically | **Impossible without a new dependency** | Accessibility is granted, but `System Events` returns an **empty window list** for `Adobe Premiere Pro 2026`; `Quartz`/pyobjc (which could enumerate windows) is not installed |

The honest summary: **the only real-time tap reachable without a compiler is the screen**, and
it cannot aim itself at the Program monitor. Everything else real-time stays unavailable, with
install guidance, exactly as the existing probe does it.

---

## 2. The provenance labelling scheme

Every artifact this layer writes is a `CaptureEvidence` record (`src/capture/types.ts`) and
carries all of:

- `tap` — the mechanism: `render`, `export-file`, `media-file`, `screen`, `ndi`, `syphon`, `spout`
- `provenance` — `composited-render` | `source-frame` | `screen-grab` | `unknown`
- `composited` — `yes` | `no` | **`unverifiable`**
- `width`, `height` — measured with ffprobe, or `'unknown'`
- `at` — `{ seconds, frame, timecode, fps }`, each independently `'unknown'`-able
- `moving` — still or video
- `sizeBytes`
- `caveats[]` — never empty

`provenance` and `composited` are **derived from the tap** by a lookup table in
`src/capture/provenance.ts`. A caller cannot pass them in, so no code path can label a screen
grab as a render:

| tap | provenance | composited | what it proves |
|---|---|---|---|
| `render` | `composited-render` | `yes` | Premiere rendered it through the sequence: effects, transitions, upper tracks, grades all included |
| `export-file` | `composited-render` | `yes` | Same, obtained from an export of the range instead of N host round trips |
| `media-file` | `source-frame` | `no` | Ground truth about that FILE and nothing about the timeline |
| `screen` | `screen-grab` | `unverifiable` | What was on the display. Nothing in the pixels proves it came from the Program monitor |
| `ndi` / `syphon` / `spout` | `screen-grab` | `unverifiable` | A publishing plugin decides what the feed contains; not us |

`unverifiable` is deliberately a first-class answer rather than a failure. A screen grab
probably *is* showing the composite — but another window may have been in front, the panel may
have been scrolled, playback resolution may be 1/4, and the display colour-manages the result.
Those four sentences ship as inherent caveats on every screen artifact.

**Unknown is never defaulted.** A screen grab has no timecode of its own, so `at.timecode` is
`'unknown'` unless the caller asserts a sequence time — and if it does, a caveat records that
the time is an assertion. A frame whose resolution could not be read reports `'unknown'`, never
`0`.

---

## 3. What was built

### 3.1 `probeCaptureCapability()` — `src/capture/probe.ts`

Spawns ffmpeg/ffprobe, never Premiere. Returns the table in §1 for the current machine: binary
availability with env overrides, the screen-capture input device and enumerated displays, the
per-tap capability rows, and `bestCompositedTap` / `bestMotionTap`.

- Taps that need a compiled native module are flagged `requiresNativeModule: true` and say so
  in `reason`. No stubs.
- `premiereConnected` is an **input**, not a guess: this module cannot see the bridge, so the
  render/export taps are only claimed available when the caller states Premiere is reachable.
- The screen-recording permission is only *proved* if the caller passes `testScreenGrab: true`,
  because proving it means capturing the user's screen. Otherwise `permissionVerified` is
  `'not-tested'` — an honest third value.
- `programMonitorGeometryCapability()` returns `available: false` with the reason (no AX
  windows) and the workaround (supply a crop rect, or use the calibration frame).

A bug this probe's own test caught, worth recording: `ffmpeg -devices` opens with a legend
(`D. = Demuxing supported`) that has the exact shape of a device row. The first parser read it
as a demuxer named `=` and therefore concluded that a machine with `avfoundation` had no screen
capture at all. Rows are now only read after the `---` separator, and the flag columns are
treated as positional (an unsupported direction is a **space**, not a dot).

### 3.2 Sequence-range capture — `src/capture/frame-strip.ts`

The verification workhorse. `planFrameTimes()` → `captureFrameStrip()` produces:

- N frames over a time range, each **snapped onto the real frame grid** (a request for t=1.037s
  on a 24fps timeline is a request for a frame that does not exist; the neighbour Premiere
  returns would silently disagree with the timecode we then burn in)
- a **timecode burn-in** per frame (`SEQ name  00:00:01:05  f29`) so an agent can verify *which*
  frame it is looking at
- a **contact sheet** of the labelled frames
- a **review clip** of the labelled frames, explicitly caveated as *not* real-time motion
- a **motion verdict** measured on the RAW frames — burn-in text is a pixel change, so diffing
  the labelled copies would report our own annotation as motion

Frames come from a `FrameSource`:

- `renderTapFrameSource(exportFrameFn, sequenceId)` — wraps the existing render tap. One host
  round trip per frame; highest trust; `composited-render`.
- `mediaFileFrameSource(path, 'export-file')` — frames out of a Premiere export of the range.
  **Still `composited-render`**, and one export instead of N round trips. This is the cheap way
  to get motion evidence over a long range.
- `mediaFileFrameSource(path)` — raw footage. `source-frame`, `composited: 'no'`.

Failures are reported, never smoothed over: a frame the source refuses lands in `failures[]`
with its timecode and Premiere's own reason, and a note says the sheet has gaps.

`maxFrames` (default 64) caps a plan so a careless range does not queue hundreds of host round
trips; the trim is reported as a warning.

### 3.3 Screen tap — `src/capture/screen-tap.ts`

The live tap. `captureScreenStill()`, `captureScreenClip()` (continuous video — this is the part
a single `capture_frame` cannot do), and `captureCalibrationFrame()`.

Since macOS will not tell us where the Program monitor is, the calibration frame is the honest
substitute: a full-display grab with a labelled coordinate grid burnt over it, so the rect can
be read off **once** by eye and passed as `crop` from then on. Without a `crop`, a caveat states
that the artifact is the whole display including Premiere's UI.

Platform details that are not cosmetic: avfoundation's screen input refuses `yuv420p` and only
offers `bgr0`; a single PNG needs `-update 1`; `drawtext` values need `:` and `\` escaped or the
filter graph eats a timecode.

### 3.4 Frame diffing — `src/capture/frame-diff.ts`

`diffFrames(a, b)` returns real numbers: mean and peak absolute luma difference (0–255) from
`blend=difference` + `signalstats`, plus PSNR (`'infinite'` when bit-identical, never a
made-up ceiling) and SSIM. `classifyDifference()` maps them to `identical` /
`near-identical` (codec noise) / `changed`, and to **`unknown`** when the measurement failed —
with the reason "Do not read this as 'unchanged'".

Mismatched dimensions are **refused**, not rescaled: a resize would make every number a property
of our resampler rather than of the edit.

`analyzeMotion(frames[])` diffs every consecutive pair and `summarizeMotion()` aggregates:
`moved`, `movingPairs`, `staticPairs`, and `unmeasuredPairs` held separately — a failed
measurement is never rounded into "static", because that would turn a broken probe into
evidence of a frozen picture.

---

## 4. Questions an agent can now answer that it could not before

| Question | How |
|---|---|
| Did the clip actually move between 4s and 6s? | `captureFrameStrip` over the range → `motion.moved`, plus per-pair numbers |
| Did the transition actually appear? | Strip across the cut → static pairs before/after, changed pairs through the dissolve |
| Is the frame at 00:00:04:12 what the edit implies? | Frame-snapped plan + burnt-in timecode: the picture and the claim are in the same image |
| Did my instruction change anything at all? | `diffFrames(before, after)` → `identical` means every luma sample matched |
| Is playback actually running? | `captureScreenClip()` — labelled `screen-grab`, `composited: 'unverifiable'` |
| Is this frame trustworthy evidence about the composite? | `provenance` + `composited` + `caveats` on every record |

---

## 5. Limits, stated plainly

- **No composited real-time tap.** NDI/Syphon/Spout need a compiled native module; we do not
  ship one. The live tap is the screen, and it is `unverifiable`.
- **The screen tap cannot aim itself.** Supply a crop rect or accept the whole display.
- **The screen tap is not colour-accurate** and reflects Premiere's playback-resolution setting,
  not the render.
- **The render tap costs one host round trip per frame.** For long ranges, export once and use
  `mediaFileFrameSource(..., 'export-file')`.
- **Timecode is non-drop-frame.** Drop-frame renumbering needs the sequence's display format,
  which lives in Premiere; inventing it here would be exactly the silent default this layer
  exists to avoid. On a 29.97 DF timeline the numbers are the NDF equivalents.
- **The review clip is not a speed reference.** Sampling interval and playback rate are ours.
- `PREMIERE_MCP_FFMPEG_CMD`, `PREMIERE_MCP_FFPROBE_CMD`, `PREMIERE_MCP_CAPTURE_FONT`,
  `PREMIERE_MCP_NDI_RECEIVER`, `PREMIERE_MCP_SYPHON_RECEIVER`, `PREMIERE_MCP_SPOUT_RECEIVER`.

---

## 6. Appendix: wiring into the tool layer

`src/capture/**` is owned separately from `src/tools/index.ts`; this is the exact patch to apply
there. Nothing below changes existing behaviour — it adds three tools.

### 6.1 Import (top of `src/tools/index.ts`)

```ts
import {
  probeCaptureCapability,
  planFrameTimes,
  captureFrameStrip,
  renderTapFrameSource,
  mediaFileFrameSource,
  captureScreenStill,
  captureScreenClip,
  captureCalibrationFrame,
  diffFrames,
  type CropRect,
} from '../capture/index.js';
```

### 6.2 Tool definitions (add to the tool list)

```ts
{
  name: 'capture_sequence_range',
  description: 'RENDER-TRUTH RANGE CAPTURE: captures several frames across a time range, snaps each onto a real frame boundary, burns its timecode into the pixels, assembles a contact sheet plus a review clip, and MEASURES whether the picture actually changes between the frames (mean/peak luma difference, PSNR, SSIM). This is how an agent verifies motion, a transition, or that the frame at a given timecode is what the edit implies -- a single still cannot. Frames come from Premiere\'s own frame export (provenance composited-render, one host round trip per frame) or, with exportFilePath, from an export of the range that has already been rendered (also composited-render, far cheaper). Every artifact reports tap, provenance, composited (yes/no/unverifiable), resolution, frame and timecode, and unknowns are reported as "unknown" rather than defaulted.',
  inputSchema: z.object({
    startSeconds: z.number().describe('Range start in seconds of sequence time.'),
    endSeconds: z.number().describe('Range end in seconds of sequence time.'),
    count: z.number().optional().describe('How many frames to sample across the range, inclusive of both ends.'),
    everyNFrames: z.number().optional().describe('Alternative to count: a fixed frame stride. One of count/everyNFrames is required; neither is defaulted.'),
    sequenceId: z.string().optional().describe('Defaults to the active sequence.'),
    workDir: z.string().optional().describe('Directory for the frames and assembled artifacts. Defaults to a temp dir.'),
    exportFilePath: z.string().optional().describe('Read frames from this already-rendered export of the sequence instead of doing one frame-export round trip per frame. Still a composited render.'),
    columns: z.number().optional().describe('Contact sheet columns. Defaults to a near-square grid.'),
    reviewFps: z.number().optional().describe('Playback rate of the review clip. Default 6. NOT the sequence rate.'),
    skipMotionClip: z.boolean().optional(),
    maxFrames: z.number().optional().describe('Cap on planned frames. Default 64.'),
  }),
},
{
  name: 'diff_captured_frames',
  description: 'Compares two captured frames NUMERICALLY with ffmpeg and returns mean and peak absolute luma difference (0-255), PSNR (reported as "infinite" when bit-identical) and SSIM, plus a verdict of identical / near-identical / changed -- or "unknown" when the measurement failed, which is explicitly NOT the same as unchanged. Frames of different sizes are refused rather than rescaled, because a resize makes every number a property of the resampler instead of the edit. Use it to PROVE that an instruction did or did not alter the pixels.',
  inputSchema: z.object({
    framePathA: z.string(),
    framePathB: z.string(),
    nearIdenticalMeanAbsDiff: z.number().optional().describe('Below this mean difference a change is called codec noise. Default 0.5.'),
    nearIdenticalMaxAbsDiff: z.number().optional().describe('A pixel differing by more than this is a real change regardless of the mean. Default 8.'),
  }),
},
{
  name: 'capture_screen_region',
  description: 'LIVE tap: captures the display with ffmpeg -- a still, a short moving CLIP (so an agent can watch playback rather than inspect one frame), or a labelled calibration grid. Honestly labelled provenance "screen-grab", composited "unverifiable": nothing in these pixels proves they came from Premiere\'s Program monitor, they are display-scaled and display-colour-managed, and Premiere\'s playback-resolution setting is baked in. Premiere exposes no windows to macOS accessibility, so the Program monitor cannot be located automatically -- run mode:"calibrate" once, read the crop rect off the grid, then pass it. For evidence about the composite use capture_program_output or capture_sequence_range instead.',
  inputSchema: z.object({
    mode: z.enum(['still', 'clip', 'calibrate']).describe('still = one frame; clip = a short moving capture; calibrate = full display with a labelled coordinate grid.'),
    outputPath: z.string().optional().describe('Defaults to a timestamped temp file.'),
    displayIndex: z.number().optional().describe('avfoundation device index of the display. Defaults to the first display the probe found.'),
    crop: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe('Program monitor rect. Without it you get the WHOLE display including Premiere\'s UI.'),
    durationSeconds: z.number().optional().describe('Required for mode:"clip".'),
    framerate: z.number().optional().describe('Capture rate. Default 30.'),
    scaleWidth: z.number().optional().describe('Downscale the clip to this width.'),
    assertedSequenceSeconds: z.number().optional().describe('Sequence time you believe was on screen. Recorded as YOUR assertion; a screen grab carries no timecode.'),
    assertedFps: z.number().optional(),
  }),
},
```

### 6.3 Dispatch cases (next to `case 'capture_program_output':`)

```ts
case 'capture_sequence_range':
  return await this.captureSequenceRange(args);
case 'diff_captured_frames':
  return await this.diffCapturedFrames(args);
case 'capture_screen_region':
  return await this.captureScreenRegion(args);
```

### 6.4 Private methods (add near `captureProgramOutput`)

```ts
/**
 * The sequence's real frame rate, from its timebase. Returns an error rather
 * than a default: guessing 24 would make every burnt-in timecode a lie.
 */
private async resolveSequenceFps(sequenceId: string): Promise<{ fps?: number; error?: string }> {
  const res = await this.bridge.executeScript(`
    try {
      var seq = __findSequence(${JSON.stringify(sequenceId)});
      if (!seq) return JSON.stringify({ success: false, error: "Sequence not found by id" });
      if (!seq.timebase) return JSON.stringify({ success: false, error: "Sequence exposes no timebase" });
      return JSON.stringify({ success: true, fps: Math.round(254016000000 / Number(seq.timebase) * 1000) / 1000 });
    } catch (e) { return JSON.stringify({ success: false, error: e.toString() }); }
  `);
  if (res && res.success && typeof res.fps === 'number' && res.fps > 0) return { fps: res.fps };
  return { error: (res && res.error) || 'Could not read the sequence frame rate, so frames cannot be snapped or timecoded.' };
}

private async captureSequenceRange(args: any): Promise<any> {
  let sequenceId: string | undefined = args.sequenceId;
  let sequenceName: string | undefined;
  if (!sequenceId) {
    const active = await this.resolveActiveSequenceId();
    if (!active.id) return { success: false, error: active.error || 'No sequenceId and no active sequence.' };
    sequenceId = active.id;
    sequenceName = active.name;
  }

  const rate = await this.resolveSequenceFps(sequenceId);
  if (!rate.fps) return { success: false, sequenceId, error: rate.error };

  const plan = planFrameTimes({
    startSeconds: args.startSeconds,
    endSeconds: args.endSeconds,
    fps: rate.fps,
    count: args.count,
    everyNFrames: args.everyNFrames,
    maxFrames: args.maxFrames,
  });
  if (plan.error) return { success: false, sequenceId, fps: rate.fps, error: plan.error };

  const source = args.exportFilePath
    ? mediaFileFrameSource(String(args.exportFilePath), 'export-file')
    : renderTapFrameSource((id, time, outPath, format) => this.exportFrame(id, time, outPath, format), sequenceId, 'png');

  const workDir = (args.workDir && String(args.workDir).trim())
    || join(tmpdir(), `premiere-range-${sequenceId}-${Date.now()}`);

  const result = await captureFrameStrip({
    source,
    plan,
    workDir,
    prefix: 'range',
    columns: args.columns,
    reviewFps: args.reviewFps,
    skipMotionClip: args.skipMotionClip === true,
    label: sequenceName || sequenceId,
    ...(args.nearIdenticalMeanAbsDiff !== undefined || args.nearIdenticalMaxAbsDiff !== undefined
      ? { diffThresholds: {
          nearIdenticalMeanAbsDiff: args.nearIdenticalMeanAbsDiff ?? 0.5,
          nearIdenticalMaxAbsDiff: args.nearIdenticalMaxAbsDiff ?? 8,
        } }
      : {}),
  });

  return { ...result, sequenceId, sequenceName: sequenceName ?? 'unknown', fps: rate.fps };
}

private async diffCapturedFrames(args: any): Promise<any> {
  const thresholds = {
    nearIdenticalMeanAbsDiff: typeof args.nearIdenticalMeanAbsDiff === 'number' ? args.nearIdenticalMeanAbsDiff : 0.5,
    nearIdenticalMaxAbsDiff: typeof args.nearIdenticalMaxAbsDiff === 'number' ? args.nearIdenticalMaxAbsDiff : 8,
  };
  return await diffFrames(String(args.framePathA), String(args.framePathB), thresholds);
}

private async captureScreenRegion(args: any): Promise<any> {
  const capability = await probeCaptureCapability();
  const screen = capability.screen;
  if (!screen.available || !screen.inputFormat) {
    return {
      success: false,
      error: `The screen tap is not available on this machine. ${screen.reason}`,
      install: screen.install,
      taps: capability.taps,
    };
  }

  const target = {
    inputFormat: screen.inputFormat,
    ...(screen.inputFormat === 'avfoundation'
      ? { displayIndex: typeof args.displayIndex === 'number' ? args.displayIndex : screen.displays[0]?.index }
      : {}),
  } as const;

  const mode = args.mode as 'still' | 'clip' | 'calibrate';
  const ext = mode === 'clip' ? 'mp4' : 'png';
  const outputPath = (args.outputPath && String(args.outputPath).trim())
    || join(tmpdir(), `premiere-screen-${mode}-${Date.now()}.${ext}`);
  const crop = args.crop as CropRect | undefined;

  if (mode === 'calibrate') {
    return {
      ...(await captureCalibrationFrame({
        target,
        outputPath,
        ...(typeof args.spacing === 'number' ? { spacing: args.spacing } : {}),
      })),
      programMonitorGeometry: capability.programMonitorGeometry,
    };
  }
  if (mode === 'clip') {
    return await captureScreenClip({
      target,
      outputPath,
      durationSeconds: Number(args.durationSeconds),
      ...(typeof args.framerate === 'number' ? { framerate: args.framerate } : {}),
      ...(crop ? { crop } : {}),
      ...(typeof args.scaleWidth === 'number' ? { scaleWidth: args.scaleWidth } : {}),
    });
  }
  return await captureScreenStill({
    target,
    outputPath,
    ...(typeof args.framerate === 'number' ? { framerate: args.framerate } : {}),
    ...(crop ? { crop } : {}),
    ...(typeof args.assertedSequenceSeconds === 'number' ? { assertedSequenceSeconds: args.assertedSequenceSeconds } : {}),
    ...(typeof args.assertedFps === 'number' ? { assertedFps: args.assertedFps } : {}),
  });
}
```

`join` and `tmpdir` are already imported in `src/tools/index.ts`.

### 6.5 Optional, and worth doing: two existing tools are less honest than they look

- **`probeCaptureTaps()`** can delegate to `probeCaptureCapability({ premiereConnected: true })`
  so the tap table stops being a hand-maintained constant and starts reflecting the machine
  (it would then report the screen tap as an available real-time option, which today it never
  mentions).
- **`frame_diff`** currently exports two frames **from the source media of the first V1 clip**
  and reports the PSNR as if it were a difference between two frames of the sequence. It is not:
  it sees no effects, no transitions, no upper tracks. It also calls `identical` on
  `psnr > 50` (a threshold, not a measurement) and builds its ffmpeg command by interpolating
  paths into an `execSync` string. Replacing its body with
  `diffFrames(await captureProgramOutput(...), await captureProgramOutput(...))` would make it
  a real composited-frame diff with an argv-array spawn and an honest verdict.
