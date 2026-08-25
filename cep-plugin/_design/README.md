# MCP Bridge (CEP) panel — three design directions

Standalone mockups. **Nothing outside `cep-plugin/_design/` was touched** — `index.html`
and `bridge-cep.js` are untouched and unread-from at runtime here.

| File | Direction |
|---|---|
| `direction-a-stack.html` | A — Priority Stack |
| `direction-b-strip.html` | B — Strip + Stream |
| `direction-c-instrument.html` | C — Instrument |
| `_shots/sheet.html` | screenshot harness: `?dir=a|b|c&w=<px>&h=<px>&cols=<n>` renders all 7 states as iframes |
| `_shots/{a,b,c}-{300,420,700}.png` | the 9 verified state sheets |

Each direction is one self-contained file: vanilla HTML/CSS/JS, no build, no framework,
no CDN, no external font, zero network requests. Open directly, or with
`?state=<name>` / `?bare=1` (hides the dev state switcher).

States rendered by every direction: `disconnected`, `starting`, `connected-idle`,
`processing`, `error`, `premiere-not-ready`, `temp-dir-unset`.

---

## A — Priority Stack

**Thesis:** one column, ordered strictly by the question the human is asking — *alive? →
doing what? → how fast? → set up? → what happened?* — so reading top-to-bottom *is* the
priority order.

- **Optimises for:** the narrow docked column (300px), and for a reader who scans rather
  than navigates. Nothing is hidden behind a click except config and the raw log, both
  `<details>` disclosures. The config disclosure **promotes itself open** the moment it
  becomes the blocker (`temp-dir-unset`), and is a single collapsed line otherwise.
- **Sacrifices:** it scrolls. At 300px the command history sits below the fold in the
  busy states (`processing`, `error`) — telemetry wins the fold, history loses it. At
  700px it splits into two columns, and the right-hand history column is mostly empty
  when the bridge is idle.
- **Against B:** A shows more telemetry and less history; B is the reverse.
  **Against C:** A never hides anything behind a tab, so it is the only one where
  telemetry and history are on screen at once — at the cost of scrolling.

## B — Strip + Stream

**Thesis:** an app shell — a **non-scrolling status strip** pinned to the top (status +
the one action + a 4-cell telemetry rail + the live command line), a scrolling activity
stream in the middle, and a one-line config/identity footer pinned to the bottom.

- **Optimises for:** *watching*. The strip physically cannot fall below the fold at any
  width or height, and the command queue + log get every remaining pixel — this is the
  direction you leave open on a second monitor for an hour. The temp directory lives in
  the footer as an editable one-liner that never competes for attention, and turns
  warning-bordered when unset.
- **Sacrifices:** telemetry is compressed into small readout cells (16px values, 18px
  sparklines) instead of stat tiles, so trends are indicative rather than readable. The
  latency meter shrinks to a 4px microbar inside its cell. Below 340px the per-command
  `ms` column is dropped. `height:100%` + `overflow:hidden` on `<body>` is a real
  constraint: the panel owns the scroll, which is right for CEP but is the least
  forgiving layout if content grows.
- **Against A:** B guarantees the strip is always visible; A guarantees nothing is behind
  a click. **Against C:** B shows history and telemetry simultaneously; C makes you pick a tab.

## C — Instrument

**Thesis:** read it from across the room — a big status headline, exactly **one hero
figure**, the one action, then three tabs (Live / History / Setup) so nothing that matters
is ever below the fold.

- **Optimises for:** glanceability and a flat information budget. Type is the largest of
  the three (18px status, 44px hero figure), tabs cap each panel's height so no state
  scrolls at 620px, and the History and Setup tabs carry their own state in the tab strip
  (a count badge; a warning icon + auto-selection when the temp dir is unset).
- **Sacrifices:** tabs hide things. You cannot see the command log and the latency meter
  at the same time, which is exactly what you want during a failure. The hero figure
  ("commands run this session") is the least operationally useful number on the panel —
  it buys legibility with screen area. It is also the only direction with a navigation
  model to learn.
- **Against A and B:** C is the only one that never scrolls and the only one that can't
  show telemetry and history together.

---

## Decisions common to all three

- **Surface is host-derived.** `applyHostTheme()` reads
  `csInterface.hostEnvironment.appSkinInfo.panelBackgroundColor` and derives the whole
  surface/ink family from it (raised surfaces by mixing toward white/black, ink flipped by
  luminance), so the panel tracks all four Premiere brightness settings. Outside Premiere
  it falls back to the validated dark surface `#1a1a19`. Status colours are excluded from
  theming by design.
- **One primary control, for free.** The live `bridge-cep.js` already sets
  `startButton.disabled = isConnected` and `stopButton.disabled = !isConnected`. All three
  mockups add `#startButton:disabled, #stopButton:disabled { display:none }`, so exactly
  one action is ever on screen. **The port is CSS — no JS change.** A third element
  `#bridgeBusy` covers the `starting` window when both are disabled.
- **The history markup contract is reused verbatim.** `bridge-cep.js` emits
  `#commandQueue > .command-item > .command-label + .command-status.{pending|executing|completed}`
  and `#logContainer > .log-entry.{info|warning|error}`. Every direction styles those exact
  selectors (plus a `.failed` status and an optional `.command-ms`), so porting the table
  and log is CSS-only. Ids reused from `index.html`: `connectionStatus`, `connectionText`,
  `serverStatus`, `serverText`, `startButton`, `stopButton`, `tempDirectory`,
  `commandQueue`, `logContainer`, plus the global handlers `startBridge/stopBridge/
  runDiagnostics/saveConfig/clearLog`.
- **Status is never colour alone.** Every status carries a colour + a distinct *shape* +
  a text label: filled circle = live, hollow circle = off, dashed ring = starting,
  triangle = warning, diamond = serious, X = critical. Shapes come from an inline SVG
  sprite; the queue chips get theirs from `::before` + `clip-path` so the live JS emitter
  needs no change.
- **Text never wears a data colour.** Values, labels and legends use ink tokens; identity
  comes from the mark beside them. The only coloured text is status text next to its icon.
- **Reduced motion** is honoured: the spinner and the animated `…` collapse to static.
- **From the kill list:** marketing paragraph, the three decorative chips
  (`MODE`/`CONTROL`/`PATH`), the duplicated truncated path readout, uniform card weight,
  the bright full-width Save button, the gradient background and the glow blobs are all
  gone. Save is now a quiet button (A, B) or the only primary in the state where it *is*
  the action (C). Identity is one line.
- Deliberately **not** used, per the form heuristic: no pie, no radial gauge, no dual axis,
  no one-bar bar chart. Telemetry is stat tiles; latency is a meter; history is a table.

### Fixes the screenshots forced (found by looking, not by reasoning)

1. `.fd`/`.ico` carried `display:flex|block`, which **overrode the `hidden` attribute** — C
   showed a phantom em-dash under the hero figure and a permanent warning flag on the Setup
   tab. Fixed with a global `[hidden]{display:none !important}` in all three.
2. The empty meter drew a full-width blue track that **read as 100% used**. Empty now
   renders a neutral `--baseline` track with no budget tick (A, C).
3. An all-zeros error sparkline **rendered as a horizontal rule**, encoding nothing.
   Zero-variance series no longer get a sparkline.
4. The `direction:rtl` ellipsis trick on the config path **moved the leading `/` to the
   end** (`…p/premiere-mcp-bridge/`). Replaced with JS truncation + `title`.
5. Sparkline end markers **clipped at the right edge** of their viewBox (padding 4 → 7).
6. B's 4-up telemetry rail at 420px was too narrow: "within 8.0 s budget" **wrapped into
   the sparkline**. The 4-up breakpoint moved 400px → 520px.
7. C's KPI grid **orphaned the 4th tile** on its own row at 700px (3-up → 4-up at ≥600px),
   and the error callout sat under the meter, i.e. **below the fold in the one state where
   it is the point** — it now leads the Live panel.
8. A's config summary label **wrapped to two lines** at 300px because the path peek was
   allowed to win the flex fight.

---

## Palette validation

Runs are from `dataviz/scripts/validate_palette.js`. The categorical palette here is a
**single series slot** (`#3987e5` dark / `#1c5cab` light) because there is exactly one
series on this panel — a legend would restate the title, so per the skill there is none.

```
### series hue, dark fallback surface #1a1a19
Palette (dark, surface #1a1a19, categorical): 1 slots
  [PASS] Lightness band         all 1 inside L 0.48–0.67
  [PASS] Chroma floor           all 1 >= 0.1
  [PASS] CVD separation         n/a
  [PASS] Normal-vision floor    n/a
  [PASS] Contrast vs surface    all 1 >= 3:1
  → ALL CHECKS PASS

### meter ordinal ramp (fill #3987e5 + unfilled track #184f95), dark surface
Palette (dark, surface #1a1a19, ordinal ramp): 2 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #184f95 at 2.15:1 vs surface
  [PASS] Single hue             hue spread 1°
  → ALL CHECKS PASS

### meter severity trio (series blue → warning → critical), dark surface, --pairs all
Palette (dark, surface #1a1a19, categorical): 3 slots
  [FAIL] Lightness band         outside band: [["#fab219",0.811]]
  [PASS] Chroma floor           all 3 >= 0.1
  [PASS] CVD separation         worst all-pairs #d03b3b↔#fab219 ΔE 24.4 (deutan) · tritan 24.4
  [PASS] Normal-vision floor    worst all-pairs #d03b3b↔#fab219 ΔE 28.4 (normal)
  [PASS] Contrast vs surface    all 3 >= 3:1
  → FAILED — fix the marked checks
```

The single FAIL there is `#fab219`'s lightness band — an intrinsic property of the **fixed,
never-themed** status palette, not something a design choice can re-step. Separation is
comfortable (ΔE 24.4 CVD) and the meter always carries its numeric value plus an icon +
sentence ("Over the 8.0 s budget · 100% used"), so the meter never leans on hue.

For completeness, the status palette scored **as if** it were categorical — the reason
icon + text label is mandatory and colour alone is forbidden:

```
### the FIXED status palette, dark surface, --pairs all
Palette (dark, surface #1a1a19, categorical): 4 slots
  [FAIL] Lightness band         outside band: [["#fab219",0.811],["#ec835a",0.717]]
  [PASS] Chroma floor           all 4 >= 0.1
  [FAIL] CVD separation         worst all-pairs #d03b3b↔#0ca30c ΔE 4.1 (deutan) · tritan 9.6
  [FAIL] Normal-vision floor    worst all-pairs #ec835a↔#fab219 ΔE 13.6 (normal) — below 15
  [PASS] Contrast vs surface    all 4 >= 3:1
  → FAILED
```

critical↔good is ΔE 4.1 under deuteranopia and warning↔serious is ΔE 13.6 even with full
colour vision. Hence: colour + shape + text label, every time.

### Light Premiere themes — a real finding

Premiere's lightest panel background is roughly `#b8b8b8`. The palette's light blue step
does **not** clear 3:1 there:

```
### #2a78d6 on #b8b8b8
  [WARN] Contrast vs surface    below 3:1 — relief required: [["#2a78d6",2.23]]

### #1c5cab on #b8b8b8
  [PASS] Lightness band         all 1 inside L 0.43–0.77
  [PASS] Chroma floor           all 1 >= 0.1
  [PASS] Contrast vs surface    all 1 >= 3:1
  → ALL CHECKS PASS

### light meter ordinal ramp: track #2a78d6 (light end) + fill #1c5cab on #b8b8b8
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #2a78d6 at 2.23:1 vs surface
  [PASS] Single hue             hue spread 1°
  → ALL CHECKS PASS
```

So `applyHostTheme()` steps the light-mode series down to **`#1c5cab`** and makes the meter
track the *lighter* step **`#2a78d6`**, keeping the ordinal ramp more-is-darker. No lighter
blue step can clear the ordinal 2:1 floor against a mid-grey surface (`#86b6ef` = 1.06:1,
`#5598e7` = 1.51:1) — inverting which end of the ramp is the track is the only passing fix.

The primary button fill `#256abf` is UI chrome, not an encoding: white text on it is
5.39:1 and the fill is 3.23:1 against the dark surface.

---

## Screenshot coverage

Every direction was rendered in all 7 states at 300 / 420 / 700 px and looked at, then
fixed, then re-shot. Sheets are in `_shots/`. Iframe height is 620px, a realistic docked
panel, so the visible cut in each cell *is* the fold.
