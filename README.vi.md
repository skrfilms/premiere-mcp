
> **Install:** the steps below may be out of date. Use the English [Install](README.md#install) section: quit Premiere Pro, run `npx -y premiere-mcp@latest setup`, reopen Premiere and your AI app, then run `verify_premiere_connection`. AI agents: see [AGENTS.md](AGENTS.md).

# Adobe Premiere Pro MCP Server

[English](README.md)

Điều khiển Adobe Premiere Pro qua MCP bằng Codex, Claude Code, Claude Desktop hoặc bất kỳ MCP client nào khác.

## Bắt đầu nhanh

```bash
git clone https://github.com/skrfilms/premiere-mcp.git
cd premiere-mcp
npm run setup:mac
```

1. Trong Premiere Pro, mở `Window > Extensions > MCP Bridge (CEP)`.
2. Đặt `Temp Directory` thành `/tmp/premiere-mcp-bridge`.
3. Nhấn `Save Configuration`, `Start Bridge`, rồi `Test Connection`.
4. Nếu kiểm tra thất bại, nhấn `Run Diagnostics` và gửi file `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

## MCP Client

- `npm run setup:mac` tự động cấu hình Claude Desktop trên macOS.
- Với Codex, Claude Code và các client khác, dùng `dist/index.js` đã build cùng với `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge`.

## Tài liệu chính thức

Tài liệu đầy đủ và mới nhất nằm trong [README.md](README.md).
