
> **Install:** the steps below may be out of date. Use the English [Install](README.md#install) section: quit Premiere Pro, run `npx -y premiere-mcp@latest setup`, reopen Premiere and your AI app, then run `verify_premiere_connection`. AI agents: see [AGENTS.md](AGENTS.md).

# Adobe Premiere Pro MCP Server

[English](README.md)

Contrôlez Adobe Premiere Pro via MCP avec Codex, Claude Code, Claude Desktop ou tout autre client MCP.

## Démarrage rapide

```bash
git clone https://github.com/skrfilms/premiere-mcp.git
cd premiere-mcp
npm run setup:mac
```

1. Dans Premiere Pro, ouvrez `Window > Extensions > MCP Bridge (CEP)`.
2. Définissez `Temp Directory` sur `/tmp/premiere-mcp-bridge`.
3. Cliquez sur `Save Configuration`, puis `Start Bridge`, puis `Test Connection`.
4. Si le test échoue, cliquez sur `Run Diagnostics` et partagez `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

## Clients MCP

- `npm run setup:mac` configure automatiquement Claude Desktop sur macOS.
- Pour Codex, Claude Code et les autres clients, utilisez le `dist/index.js` généré avec `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge`.

## Documentation officielle

La documentation complète et à jour se trouve dans [README.md](README.md).
