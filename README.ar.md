
> **Install:** the steps below may be out of date. Use the English [Install](README.md#install) section: quit Premiere Pro, run `npx -y premiere-mcp@latest setup`, reopen Premiere and your AI app, then run `verify_premiere_connection`. AI agents: see [AGENTS.md](AGENTS.md).

# Adobe Premiere Pro MCP Server

[English](README.md)

تحكم في Adobe Premiere Pro عبر MCP باستخدام Codex أو Claude Code أو Claude Desktop أو أي عميل MCP آخر.

## البدء السريع

```bash
git clone https://github.com/skrfilms/premiere-mcp.git
cd premiere-mcp
npm run setup:mac
```

1. في Premiere Pro افتح `Window > Extensions > MCP Bridge (CEP)`.
2. اضبط `Temp Directory` على `/tmp/premiere-mcp-bridge`.
3. اضغط `Save Configuration` ثم `Start Bridge` ثم `Test Connection`.
4. إذا فشل الاختبار، اضغط `Run Diagnostics` وشارك الملف `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

## عملاء MCP

- يقوم `npm run setup:mac` بإعداد Claude Desktop تلقائيًا على macOS.
- بالنسبة إلى Codex وClaude Code والعملاء الآخرين، استخدم `dist/index.js` بعد البناء مع `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge`.

## الوثائق الرسمية

الوثائق الكاملة والأحدث موجودة في [README.md](README.md).
