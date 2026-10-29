
> **Install:** the steps below may be out of date. Use the English [Install](README.md#install) section: quit Premiere Pro, run `npx -y premiere-mcp@latest setup`, reopen Premiere and your AI app, then run `verify_premiere_connection`. AI agents: see [AGENTS.md](AGENTS.md).

# Adobe Premiere Pro MCP Server

[English](README.md)

Управляйте Adobe Premiere Pro через MCP с помощью Codex, Claude Code, Claude Desktop или любого другого MCP-клиента.

## Быстрый старт

```bash
git clone https://github.com/skrfilms/premiere-mcp.git
cd premiere-mcp
npm run setup:mac
```

1. В Premiere Pro откройте `Window > Extensions > MCP Bridge (CEP)`.
2. Установите `Temp Directory` в `/tmp/premiere-mcp-bridge`.
3. Нажмите `Save Configuration`, затем `Start Bridge`, затем `Test Connection`.
4. Если тест не пройдет, нажмите `Run Diagnostics` и отправьте `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

## MCP-клиенты

- `npm run setup:mac` автоматически настраивает Claude Desktop на macOS.
- Для Codex, Claude Code и других клиентов используйте собранный `dist/index.js` и `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge`.

## Основная документация

Полная и актуальная документация находится в [README.md](README.md).
