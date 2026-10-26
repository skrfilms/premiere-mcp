# API canary

Premiere updates can change scripting behaviour without notice. 26.5.2 did: the engine lost
`Array.prototype.map/filter/indexOf`, and DOM/QE edit semantics turned out to differ from what the
tools assumed, so dozens of tools were broken for weeks before anyone noticed. Every fix that
followed rests on a measured fact. `scripts/api-canary.mjs` measures those facts again.

**Run it after every Premiere update** (about 15 seconds):

```
PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge npm run canary
```

Requirements: Premiere open on the repo scratch project only (the same guard as the live sweeps),
the CEP panel running, and ffmpeg on PATH (or `PREMIERE_MCP_FFMPEG_CMD`). It generates its own
frame-counter clips under `.scratch/media/`, builds throwaway sequences, and deletes them.

## How it judges

Where it can, a probe reads the **composited program frame** (`capture_program_output`) of a clip
whose every frame shows its own number as eight black/white bars, so a result is what Premiere
renders, not what an API readback claims.

| kind | meaning when it changes | exit |
| --- | --- | --- |
| `relied` | tools are built on this; they are now wrong | 1 |
| `watch` | a known limitation; it may have lifted (good news to follow up) | 0 |

Each run is written to `verification/canary/<utc>-<premiereVersion>.json` and diffed against the
previous one, so a Premiere version change and every probe that flipped are listed together.

## What it checks

- Prelude array methods work; QE sequences resolve by guid; QE track items include gaps.
- Frame export by timecode lands on the right frame; a bare number string is a frame count.
- `inPoint` writes slip, `start` writes move the head with its content, `end` trims the tail,
  `outPoint` writes do nothing visible, `move()` is relative and single-item, `remove()` never
  ripples.
- `TrackItem.nodeId` is unique (dual-mono) and stable; project metadata reports the real media
  duration regardless of the bin out mark.
- `addTransition`'s second argument means "at start"; marker `end` takes seconds and
  `setColorByIndex` sticks.
- Watched limits: QE `setSpeed` miscalibration, and the absence of `getTimelineGaps`,
  `openInTimeline`, a clip-gain parameter and a working work-area setter.

When a `relied` probe fails, its `expect` text states the assumption that broke. Most of these
assumptions live in `src/tools/trim-lib.ts` (edit semantics) and the prelude in
`src/bridge/index.ts` (`__qeTimecode`, `__qeSequenceOpening`, `__qeClipByIndex`,
`__qeTransitionsAt`); fix those before trusting the server on the new build.
