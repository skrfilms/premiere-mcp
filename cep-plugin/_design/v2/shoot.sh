#!/bin/bash
# Per-shot headless Chrome. One process per screenshot with a throwaway profile, so any
# number of agents can run this concurrently without fighting over a shared browser.
#
# WHY THE IFRAME: Chrome enforces a MINIMUM WINDOW WIDTH of 500 CSS px. Passing
# --window-size=300 does NOT give a 300px viewport — it lays the page out at 500px and then
# crops the screenshot to 300 device px. Measured: window-size 300 -> innerWidth 500, and
# `matchMedia('(max-width:359px)')` reports NO MATCH. That silently faked every narrow-width
# check: real overflow was invisible and phantom overflow appeared where there was none.
# Loading the page in an iframe of the exact target width gives it a true viewport of that
# width -- media queries inside an iframe key off the iframe, not the window -- while the
# window itself stays above Chrome's floor.
#   usage: shoot.sh <file.html> <outdir> <width> [state]
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SRC="$1"; OUT="$2"; W="${3:-420}"; STATE="${4:-}"
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }
FILE="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
H=620
mkdir -p "$OUT"
TARGET="file://$FILE"; [ -n "$STATE" ] && TARGET="$TARGET?state=$STATE"
PNG="$OUT/$(basename "${SRC%.html}")-${W}${STATE:+-$STATE}.png"
rm -f "$PNG"

# Window must clear Chrome's 500px floor; the iframe carries the real width.
WIN=$(( W + 24 )); [ "$WIN" -lt 520 ] && WIN=520
WRAP="$(mktemp -d)/wrap.html"
cat > "$WRAP" <<HTML
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#3c3c3c}
  /* The dashed edge marks where the panel ends and the harness begins, so a screenshot
     can never be mistaken for the panel bleeding to the window edge. */
  iframe{width:${W}px;height:${H}px;border:0;outline:1px dashed #6e6e6e;display:block}
</style></head><body><iframe src="${TARGET}"></iframe></body></html>
HTML

PROF="$(mktemp -d)"
"$CHROME" --headless=new --no-first-run --no-default-browser-check --disable-extensions \
  --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size="$WIN,$(( H + 24 ))" --user-data-dir="$PROF" \
  --allow-file-access-from-files --screenshot="$PNG" "file://$WRAP" >/dev/null 2>&1 &
PID=$!
for i in $(seq 1 60); do [ -s "$PNG" ] && break; sleep 0.5; done
sleep 1; kill $PID 2>/dev/null; rm -rf "$PROF"
[ -s "$PNG" ] && echo "$PNG" || { echo "FAILED: $PNG" >&2; exit 1; }
