#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This doctor command currently supports macOS only."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_ENTRY="$REPO_ROOT/dist/index.js"
CEP_TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP"
CLAUDE_DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
VSCODE_CONFIG="$HOME/Library/Application Support/Code/User/mcp.json"
TEMP_DIR="${PREMIERE_TEMP_DIR:-/tmp/premiere-mcp-bridge}"
HEARTBEAT="$TEMP_DIR/bridge-heartbeat.json"
FAILURES=0
WARNINGS=0

pass() { echo "[ok] $1"; }
fail() { echo "[missing] $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo "[warn] $1"; WARNINGS=$((WARNINGS + 1)); }
info() { echo "[info] $1"; }

# --- Node.js (required) -------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v)"
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    pass "Node.js available ($NODE_VERSION)"
  else
    fail "Node.js 20+ required (found $NODE_VERSION)"
  fi
else
  fail "Node.js not found in PATH"
fi

# --- Built server (required) --------------------------------------------------
if [[ -f "$DIST_ENTRY" ]]; then
  pass "Built MCP server found at $DIST_ENTRY"
else
  fail "Build output missing at $DIST_ENTRY (run npm run build)"
fi

# --- CEP extension (required) -------------------------------------------------
if [[ -d "$CEP_TARGET_DIR" ]]; then
  if [[ -f "$CEP_TARGET_DIR/CSXS/manifest.xml" && -f "$CEP_TARGET_DIR/index.html" ]]; then
    pass "Premiere CEP extension installed at $CEP_TARGET_DIR"
  else
    fail "CEP extension folder exists but is incomplete at $CEP_TARGET_DIR"
  fi
else
  fail "Premiere CEP extension not installed at $CEP_TARGET_DIR"
fi

# --- Bridge temp directory (required) -----------------------------------------
if [[ -d "$TEMP_DIR" ]]; then
  pass "Bridge temp directory exists at $TEMP_DIR"
else
  fail "Bridge temp directory missing at $TEMP_DIR"
fi

# --- Adobe CEP debug mode: pass if enabled for ANY installed CSXS version -----
# Premiere 26.x uses CSXS.11/12; older builds use lower numbers. Only one needs
# to allow unsigned extensions, so a per-version failure would ding a working
# setup. Report which versions are enabled; warn only if none are.
DEBUG_VERSIONS=()
for csxs_version in 9 10 11 12 13 14 15; do
  VALUE="$(defaults read "com.adobe.CSXS.$csxs_version" PlayerDebugMode 2>/dev/null || true)"
  if [[ "$VALUE" == "1" ]]; then
    DEBUG_VERSIONS+=("$csxs_version")
  fi
done
if [[ "${#DEBUG_VERSIONS[@]}" -gt 0 ]]; then
  pass "Adobe CEP debug mode enabled for CSXS.$(IFS=,; echo "${DEBUG_VERSIONS[*]}")"
else
  warn "Adobe CEP debug mode not enabled for any CSXS version (unsigned panels will not load). Run: defaults write com.adobe.CSXS.12 PlayerDebugMode 1"
fi

# --- Live bridge: sample the heartbeat instead of asking the human ------------
# The CEP panel rewrites bridge-heartbeat.json every poll tick. Sampling it
# twice tells us whether the panel is actually running and connected, which the
# old doctor punted to a manual "click Test Connection" step.
if [[ -f "$HEARTBEAT" ]]; then
  TS1="$(HB="$HEARTBEAT" node -e 'try{const h=JSON.parse(require("fs").readFileSync(process.env.HB,"utf8"));process.stdout.write(String(h.ts||""))}catch(e){}' 2>/dev/null || true)"
  sleep 1.2
  READ2="$(HB="$HEARTBEAT" node -e 'try{const h=JSON.parse(require("fs").readFileSync(process.env.HB,"utf8"));process.stdout.write((h.ts||"")+"|"+(h.connected?"1":"0")+"|"+(h.isProcessing?"1":"0"))}catch(e){}' 2>/dev/null || true)"
  TS2="${READ2%%|*}"
  REST="${READ2#*|}"
  CONNECTED="${REST%%|*}"
  PROCESSING="${REST##*|}"
  if [[ -z "$TS2" ]]; then
    warn "Bridge heartbeat present but unreadable at $HEARTBEAT"
  elif [[ -n "$TS1" && "$TS1" != "$TS2" ]]; then
    if [[ "$CONNECTED" == "1" ]]; then
      if [[ "$PROCESSING" == "1" ]]; then
        pass "Bridge is live and connected (currently processing a command)"
      else
        pass "Bridge is live and connected (panel polling, idle)"
      fi
    else
      warn "Bridge panel is running but reports not connected to Premiere"
    fi
  else
    warn "Bridge heartbeat is stale (timestamp not advancing) — the panel is not polling. Restart the MCP Bridge (CEP) panel in Premiere."
  fi
else
  info "Bridge not running (no heartbeat). Open Window > Extensions > MCP Bridge (CEP) in Premiere and start it, then re-run the doctor."
fi

# --- Local backends: optional dependency-backed capabilities ------------------
# These are not required for editing, but each unlocks specific tools; report
# availability so the picture is honest rather than silent.
check_backend() {
  local label="$1"; local cmd="$2"; local unlocks="$3"
  if command -v "$cmd" >/dev/null 2>&1; then
    info "$label available ($cmd) — unlocks $unlocks"
  else
    info "$label not found ($cmd) — $unlocks will return install guidance until installed"
  fi
}
check_backend "ffmpeg"  "${PREMIERE_MCP_FFMPEG_CMD:-ffmpeg}"   "generate_scope / bake_speed_change / normalize_loudness / detect_silence"
check_backend "ffprobe" "${PREMIERE_MCP_FFPROBE_CMD:-ffprobe}" "probe_media / index_footage / search_footage"
check_backend "whisper" "${PREMIERE_MCP_WHISPER_CMD:-whisper}" "transcribe_to_srt"

# --- MCP client config: pass if premiere-pro is wired in ANY known client -----
# The client may be Claude Code (project .mcp.json), Claude Desktop, or VS Code.
# A missing config for a client you do not use is not a failure; only a present
# but broken premiere-pro entry is.
CLIENT_FOUND=0
check_client_config() {
  local label="$1"; local path="$2"; local root_key="$3"
  if [[ ! -f "$path" ]]; then
    return
  fi
  local result
  # Also compares the client's PREMIERE_TEMP_DIR against the directory this doctor
  # (and therefore the CEP panel) is checking. A client pointed at a DIFFERENT temp
  # dir is a known silent-bridge-failure mode: the server writes commands somewhere
  # the panel never polls, so every tool call times out with a healthy-looking panel
  # and nothing in the logs says why. Only reported when the client sets the value
  # explicitly and it disagrees — an unset value correctly inherits the same default.
  result="$(CFG="$path" ROOT="$root_key" DIST="$DIST_ENTRY" TEMP="$TEMP_DIR" node -e '
    const fs=require("fs");
    try {
      const d=JSON.parse(fs.readFileSync(process.env.CFG,"utf8"));
      const root=d[process.env.ROOT];
      const s=root && root["premiere-pro"];
      if(!s){console.log("no-entry");process.exit(0);}
      const arg0=Array.isArray(s.args)?(s.args[s.args.length-1]||""):"";
      const temp=s.env && s.env.PREMIERE_TEMP_DIR;
      if(arg0 && arg0.indexOf("index.js")===-1){console.log("bad-path:"+arg0);}
      else if(temp && temp!==process.env.TEMP){console.log("bad-temp:"+temp);}
      else{console.log("ok");}
    } catch(e){console.log("invalid-json:"+e.message);}
  ' 2>/dev/null || echo "error")"
  case "$result" in
    ok)          pass "$label has a premiere-pro entry"; CLIENT_FOUND=1 ;;
    no-entry)    info "$label present but has no premiere-pro entry" ;;
    bad-path:*)  warn "$label premiere-pro entry points at ${result#bad-path:} (expected a path to dist/index.js)"; CLIENT_FOUND=1 ;;
    bad-temp:*)  warn "$label sets PREMIERE_TEMP_DIR=${result#bad-temp:} but this doctor and the CEP panel use $TEMP_DIR. The server would write commands where the panel never looks, so every tool call would time out. Make both the same."; CLIENT_FOUND=1 ;;
    invalid-json:*) fail "$label is not valid JSON (${result#invalid-json:})" ;;
    *)           warn "$label could not be checked" ;;
  esac
}
# Claude Code project config (the client in use here) — check cwd and repo root.
check_client_config "Claude Code .mcp.json (cwd)"       "$PWD/.mcp.json"        "mcpServers"
[[ "$PWD" != "$REPO_ROOT" ]] && check_client_config "Claude Code .mcp.json (repo)" "$REPO_ROOT/.mcp.json" "mcpServers"
check_client_config "Claude Desktop config"             "$CLAUDE_DESKTOP_CONFIG" "mcpServers"
check_client_config "VS Code MCP config"                "$VSCODE_CONFIG"         "servers"
if [[ "$CLIENT_FOUND" -eq 0 ]]; then
  info "No MCP client config with a premiere-pro entry was found in the usual locations. If you use another client (or a project-local .mcp.json elsewhere), point it at: node $DIST_ENTRY"
fi

# --- Verdict ------------------------------------------------------------------
echo
if [[ "$FAILURES" -gt 0 ]]; then
  echo "Doctor found $FAILURES blocking issue(s) and $WARNINGS warning(s)."
  exit 1
fi
if [[ "$WARNINGS" -gt 0 ]]; then
  echo "Doctor passed with $WARNINGS warning(s) — the install is usable; review the [warn] lines above."
  exit 0
fi
echo "Doctor check passed."
