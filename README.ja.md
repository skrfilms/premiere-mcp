
> **Install:** the steps below may be out of date. Use the English [Install](README.md#install) section: quit Premiere Pro, run `npx -y premiere-mcp@latest setup`, reopen Premiere and your AI app, then run `verify_premiere_connection`. AI agents: see [AGENTS.md](AGENTS.md).

# Adobe Premiere Pro MCP Server

[English](README.md)

Adobe Premiere Pro を MCP 経由で操作できます。Codex、Claude Code、Claude Desktop、その他の MCP クライアントに対応しています。

## クイックスタート

```bash
git clone https://github.com/skrfilms/premiere-mcp.git
cd premiere-mcp
npm run setup:mac
```

1. Premiere Pro で `Window > Extensions > MCP Bridge (CEP)` を開きます。
2. `Temp Directory` を `/tmp/premiere-mcp-bridge` に設定します。
3. `Save Configuration`、`Start Bridge`、`Test Connection` を順に実行します。
4. テストに失敗した場合は `Run Diagnostics` を実行し、`/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json` を共有してください。

## MCP クライアント

- `npm run setup:mac` は macOS の Claude Desktop を自動設定します。
- Codex、Claude Code、その他のクライアントでは、ビルド済み `dist/index.js` と `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge` を使用してください。

## 正式なドキュメント

完全かつ最新のドキュメントは [README.md](README.md) を参照してください。
