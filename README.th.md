
> **Install:** the steps below may be out of date. Use the English [Install](README.md#install) section: quit Premiere Pro, run `npx -y premiere-mcp@latest setup`, reopen Premiere and your AI app, then run `verify_premiere_connection`. AI agents: see [AGENTS.md](AGENTS.md).

# Adobe Premiere Pro MCP Server

[English](README.md)

ควบคุม Adobe Premiere Pro ผ่าน MCP ด้วย Codex, Claude Code, Claude Desktop หรือ MCP client อื่น ๆ

## เริ่มต้นอย่างรวดเร็ว

```bash
git clone https://github.com/skrfilms/premiere-mcp.git
cd premiere-mcp
npm run setup:mac
```

1. ใน Premiere Pro เปิด `Window > Extensions > MCP Bridge (CEP)`.
2. ตั้งค่า `Temp Directory` เป็น `/tmp/premiere-mcp-bridge`.
3. กด `Save Configuration`, `Start Bridge` และ `Test Connection`.
4. หากการทดสอบล้มเหลว ให้กด `Run Diagnostics` และส่งไฟล์ `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

## MCP Clients

- `npm run setup:mac` จะตั้งค่า Claude Desktop บน macOS ให้อัตโนมัติ
- สำหรับ Codex, Claude Code และ client อื่น ๆ ให้ใช้ `dist/index.js` ที่ build แล้ว พร้อม `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge`

## เอกสารหลัก

เอกสารฉบับเต็มและล่าสุดอยู่ที่ [README.md](README.md)
