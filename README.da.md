
> **Install:** the steps below may be out of date. Use the English [Install](README.md#install) section: quit Premiere Pro, run `npx -y premiere-mcp@latest setup`, reopen Premiere and your AI app, then run `verify_premiere_connection`. AI agents: see [AGENTS.md](AGENTS.md).

# Adobe Premiere Pro MCP Server

[English](README.md)

Styr Adobe Premiere Pro via MCP med Codex, Claude Code, Claude Desktop eller en anden MCP-klient.

## Hurtig start

```bash
git clone https://github.com/skrfilms/premiere-mcp.git
cd premiere-mcp
npm run setup:mac
```

1. Åbn `Window > Extensions > MCP Bridge (CEP)` i Premiere Pro.
2. Sæt `Temp Directory` til `/tmp/premiere-mcp-bridge`.
3. Klik på `Save Configuration`, `Start Bridge` og derefter `Test Connection`.
4. Hvis testen fejler, klik på `Run Diagnostics` og del `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

## MCP-klienter

- `npm run setup:mac` konfigurerer automatisk Claude Desktop på macOS.
- For Codex, Claude Code og andre klienter skal du bruge den byggede `dist/index.js` sammen med `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge`.

## Officiel dokumentation

Den fulde og opdaterede dokumentation findes i [README.md](README.md).
