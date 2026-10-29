---
name: premiere-mcp
description: Install, verify, troubleshoot, and operate the Adobe Premiere Pro MCP server. Use when a user wants an agent to set up Premiere MCP, connect Claude Code/Codex/Claude Desktop, control Premiere, import media, build sequences, edit timelines, apply effects, or diagnose bridge issues.
---

# Adobe Premiere Pro MCP

Use this skill when working with the Premiere MCP server from `skrfilms/premiere-mcp`.

## Core Rules

- Use the MCP tools for Premiere operations; do not invent ExtendScript unless the MCP tool surface is missing the needed operation.
- Prefer read-only discovery first: `get_project_info`, `list_sequences`, `list_project_items`, `get_active_sequence`, and relevant resource reads.
- Use real imported media. If the user asks to edit with assets, verify file paths exist, import them with `import_media`, then place the imported project item IDs on a sequence.
- Keep the temp directory consistent across the MCP server and CEP panel: `/tmp/premiere-mcp-bridge` unless the user explicitly configured another path.
- Ask before destructive or externally visible actions: deleting clips/media, overwriting exports, closing projects, saving over important project files, or sending files elsewhere.
- For generated/demo edits, prefer creating a new clearly named sequence instead of modifying the user's active sequence.
- If a tool returns `success: false`, report the exact error and run diagnostics before retrying blindly.

## Install Workflow

If the user asks you to install or set up the MCP (macOS or Windows, on the computer with Premiere):

1. Check Node.js 20+ (`node --version`). If it is missing, ask the user to install it.
2. Ask the user to quit Premiere Pro.
3. Run `npx -y premiere-mcp@latest setup`. It installs the signed Premiere plugins through Adobe's
   own installer and adds the server to every AI app it finds, backing up each config it edits.
   `--dry-run` shows the plan; `--clients codex` (or `claude-code`, `cursor`, `vscode`,
   `claude-desktop`) limits it to one app. Every output line is `ok` or `FAIL` with the reason.
4. Ask the user to start Premiere Pro and restart the AI app. The bridge starts with Premiere and
   runs in the background; no panel needs opening.
5. Run `npx -y premiere-mcp@latest doctor` (every line `ok`), then call `verify_premiere_connection`.

Do not hand-copy `cep-plugin/` or turn on `PlayerDebugMode`; that old route clashes with the signed
install. From a clone, see AGENTS.md.

If Premiere is not running, you can still set up and register the MCP; tell the user live tool
checks need Premiere open.

## Verification

Run local checks:

```bash
npm run setup:doctor
```

If Premiere is running and the bridge is started, verify with safe read-only calls:

- `get_project_info`
- `list_sequences`
- `list_project_items`

For deeper validation in a disposable project, create a test sequence with `create_sequence_from_clips` or `create_sequence` plus a real `.sqpreset` path, then call `list_sequences` and confirm it exists. Do not call blank sequence creation without a preset because newer Premiere versions can open a native dialog that blocks CEP.

## Editing Strategy

- Start by understanding the project: project info, active sequence, existing media, tracks, markers, and selected sequence.
- Build a plan in concrete Premiere operations before changing anything.
- For rough cuts, import media first, then use `create_sequence_from_clips` so Premiere derives settings without a native dialog. Use `create_sequence` only with a real `.sqpreset`; use `duplicate_sequence` with `clearContents=true` when an existing sequence defines the intended settings.
- For product or brand spots, prefer `assemble_product_spot` or `build_brand_spot_from_mogrt_and_assets` when the user's request fits those workflows.
- For black-and-white looks, use `apply_effect` with `Black & White` rather than generic saturation-only changes.
- For timeline cuts, prefer sequence-aware tools and include `sequenceId` when available.
- Export only after confirming output path, format/preset, and overwrite behavior.

## Troubleshooting

If commands time out or report bridge errors:

1. Confirm Premiere is open.
2. Confirm `Window > Extensions > MCP Bridge (CEP)` is open and bridge is started.
3. Confirm both sides use the same temp directory.
4. Run:

```bash
npm run setup:doctor
```

5. Ask the user to click `Run Diagnostics` in the CEP panel.
6. Read `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json` if it exists.
7. Remove stale command/response files only if they are clearly old and the bridge is stopped or idle.

Common fixes:

- `ENOENT` on temp directory: create `/tmp/premiere-mcp-bridge`, save config again, restart bridge.
- Tool succeeds in Premiere but reports failure: run `list_sequences` or the relevant list tool to confirm state before retrying.
- Empty or malformed temp directory config: set the field to the path only, not JSON or an env assignment.
