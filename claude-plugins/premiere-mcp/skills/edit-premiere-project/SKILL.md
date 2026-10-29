---
name: edit-premiere-project
description: Inspect, edit, verify, and export an open Adobe Premiere Pro project through the local Premiere MCP Bridge.
---

# Edit Premiere Project

Use the `premiere-pro` MCP server for Premiere operations. Start every session with `get_capabilities`, then call `verify_premiere_connection` before any mutation.

Inspect project and sequence state before editing. Ask before destructive actions or overwriting exports. Re-read the relevant sequence, clip, or project state after every mutation and never report a project change as complete without that readback.

If the connection check fails, run `npx -y premiere-mcp@latest doctor` and follow the fix it names. If the plugins are missing, ask the user to quit Premiere, run `npx -y premiere-mcp@latest setup`, then reopen Premiere (the bridge starts with it; no panel needs opening).
