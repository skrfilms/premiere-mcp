#!/bin/bash
# Installs the two Premiere Pro plugins the Premiere MCP needs, through Adobe's own plugin
# installer (the one Creative Cloud uses). Double-click to run. Nothing else on the Mac changes.
#
#   MCPBridgeCEP-signed.zxp  the bridge (runs in the background; no panel needs to be open)
#   mcp-uxp-probe.ccx        the UXP helper (work area, transitions, keyframe checks)
#
# Quit Premiere Pro first, or restart it afterwards.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

say() { printf '%s\n' "$*"; }
fail() { say ""; say "Install stopped: $*"; say ""; read -r -p "Press Return to close." _; exit 1; }

say "Premiere MCP plugin installer"
say ""
[ -x "$UPIA" ] || fail "Adobe Creative Cloud's plugin installer was not found. Install Creative Cloud and Premiere Pro first."
[ -f "$HERE/MCPBridgeCEP-signed.zxp" ] || fail "MCPBridgeCEP-signed.zxp is missing next to this installer."
[ -f "$HERE/mcp-uxp-probe.ccx" ] || fail "mcp-uxp-probe.ccx is missing next to this installer."

# An older hand-copied bridge has the same extension id and would clash with the installed one.
OLD="$HOME/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP"
if [ -d "$OLD" ]; then
  BACKUP="$HOME/Library/Application Support/Adobe/CEP/MCPBridgeCEP-replaced-$(date +%Y%m%d-%H%M%S)"
  mv "$OLD" "$BACKUP" || fail "could not move the old bridge copy at $OLD out of the way."
  say "Moved an older bridge copy to: $BACKUP"
fi

for pkg in "MCPBridgeCEP-signed.zxp" "mcp-uxp-probe.ccx"; do
  say "Installing $pkg ..."
  out="$("$UPIA" --install "$HERE/$pkg" 2>&1)"
  printf '%s\n' "$out" | tail -n 1
  printf '%s' "$out" | grep -qi "successful" || fail "$pkg did not install. Full output above."
done

say ""
say "Done. Restart Premiere Pro. The bridge then runs in the background with no panel open."
say "To see its status, open Window > Extensions > MCP Bridge (CEP)."
say ""
read -r -p "Press Return to close." _
