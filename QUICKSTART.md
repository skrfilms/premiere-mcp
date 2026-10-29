# Quick Start

The shortest path to a working install, on macOS or Windows.

## 1. Set up

Needs Node.js 20+ and Premiere Pro (with Creative Cloud) on this computer. Quit Premiere Pro, then:

```bash
npx -y premiere-mcp@latest setup
```

It installs the signed Premiere bridge through Adobe's own plugin installer and adds the server to
every AI app it finds (Claude Desktop, Claude Code, Codex, Cursor, VS Code), backing up each file it
edits. `--dry-run` shows the plan; `--clients codex` (or `claude-code`, `cursor`, `vscode`,
`claude-desktop`) sets up one app.

## 2. Reopen Premiere Pro and your AI app

The bridge starts with Premiere and runs in the background; no panel needs opening. AI apps load
servers when they start, so quit and reopen yours (in Claude Code, start a new session).

## 3. Check

```bash
npx -y premiere-mcp@latest doctor
```

Every line should be `ok`. Then ask your AI app:

```text
Run verify_premiere_connection. Make no changes.
```

## Windows notes

`setup` uses Adobe's installer at
`%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent`.
The bridge folder is `%TEMP%\premiere-mcp-bridge`. The Windows path is checked in CI but has had less
use with a real Premiere than macOS; if the plugin step fails, `setup --unsigned` (hand-copied panel
plus CEP developer mode) is the fallback, and `npm run setup:doctor:win` from a clone checks it.

## Adding the server by hand

For a client `setup` does not know, after `npm install -g premiere-mcp`:

```bash
codex mcp add premiere-pro --env PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge -- premiere-mcp
claude mcp add --scope user premiere-pro -e PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge -- premiere-mcp
```

or in a JSON config:

```json
{ "mcpServers": { "premiere-pro": { "command": "premiere-mcp", "env": { "PREMIERE_TEMP_DIR": "/tmp/premiere-mcp-bridge" } } } }
```

## When something fails

- **Calls time out / "no heartbeat":** Premiere is not running or was not restarted after setup.
  `Window > Extensions > MCP Bridge (CEP)` shows the bridge's status.
- **The app does not list the tools:** reopen the app.
- **A call timed out but may have run:** call `get_recent_calls` before retrying an edit.
- **A full live check:** with a scratch project open, `node scripts/live-tool-sweep.mjs` from a clone
  (it creates disposable `Sweep ...` sequences), or `npm run test:workflows`.
