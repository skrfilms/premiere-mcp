
> **Install:** the steps below may be out of date. Use the English [Install](README.md#install) section: quit Premiere Pro, run `npx -y premiere-mcp@latest setup`, reopen Premiere and your AI app, then run `verify_premiere_connection`. AI agents: see [AGENTS.md](AGENTS.md).

# Adobe Premiere Pro MCP Server

[English](README.md)

Controla Adobe Premiere Pro mediante MCP usando Codex, Claude Code, Claude Desktop o cualquier otro cliente MCP.

## Inicio rápido

```bash
git clone https://github.com/skrfilms/premiere-mcp.git
cd premiere-mcp
npm run setup:mac
```

1. En Premiere Pro, abre `Window > Extensions > MCP Bridge (CEP)`.
2. Configura `Temp Directory` como `/tmp/premiere-mcp-bridge`.
3. Haz clic en `Save Configuration`, `Start Bridge` y luego `Test Connection`.
4. Si la prueba falla, haz clic en `Run Diagnostics` y comparte `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

## Clientes MCP

- `npm run setup:mac` configura automáticamente Claude Desktop en macOS.
- Para Codex, Claude Code y otros clientes, usa `dist/index.js` ya compilado con `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge`.

## Documentación oficial

La documentación completa y actualizada está en [README.md](README.md).
