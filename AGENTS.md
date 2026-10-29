# Instructions for AI agents

Two jobs come up: **setting this up for a user**, and **working on this code**. Do the one asked.

## Set up Premiere MCP for a user

Everything runs on the user's own computer (macOS or Windows), where Premiere Pro is installed.

1. **Check prerequisites.** Node.js 20 or newer (`node --version`) and Adobe Premiere Pro with
   Creative Cloud. If Node is missing, ask the user to install it from https://nodejs.org (or
   `brew install node` on a Mac); do not install it without asking.
2. **Ask the user to quit Premiere Pro.** Plugins install while it is closed.
3. **Run setup for the app the user asked about** (you, usually):

   ```bash
   npx -y premiere-mcp@latest setup --clients claude-code
   ```

   Use `codex`, `cursor`, `vscode` or `claude-desktop` instead as fits; leave `--clients` off only
   if the user wants every AI app on the machine set up. It installs the signed Premiere plugins
   through Adobe's own plugin installer (no developer mode, no panel to open), adds the server to
   the app, and backs up any config file it edits. Every output line is `ok` or `FAIL` with the
   reason. Add `--dry-run` first to show the user the plan.

   **From a clone** (no npm): `npm install && npm run build`, then `node dist/cli.js setup
   --clients claude-code`. The signed plugins come from `installer/`; if that folder is missing,
   either build it with `npm run release:installer` (needs the signing certificate) or install the
   plugins from the release's `Premiere-MCP-Installer` zip and add `--skip-plugins`.
4. **Ask the user to start Premiere Pro and restart their AI app** (the app loads servers at
   start). If you are Claude Code, the user must start a new session.
5. **Verify:** `npx -y premiere-mcp@latest doctor` (from a clone: `node dist/cli.js doctor`) should
   show every line `ok`, including "Premiere is running with the bridge on". Then call the
   `verify_premiere_connection` tool. It changes nothing.

If `doctor` is already all `ok` before you start, it is already set up: say so and stop.

Versions: the npm package (for example 1.5.0) and the Premiere bridge (`ExtensionBundleVersion`,
for example 1.1.6) are numbered separately; `doctor` shows both and a difference is expected.

If something fails, `doctor` names the step and the fix. Common ones: Creative Cloud's plugin
installer missing (install Creative Cloud), Premiere not running (no heartbeat), or an app that
was not restarted.

**Do not** hand-copy `cep-plugin/` into Adobe's extensions folder or turn on `PlayerDebugMode`: that
is the old unsigned route (`setup --unsigned`), and a hand copy clashes with the signed install.

## Use it well

- Start with `get_project_info` (it includes the project's notes) and `verify_premiere_connection`.
- The tool list is a curated menu; `find_tool` searches all of them, `call_tool` runs any, and
  `activate_tools({ bundle: "task-grade" })` loads a whole task menu.
- Never assume an edit happened: read the `verified` field. To take back a whole edit use
  `revert_last_call`, not `undo`. After the user edits by hand, `what_changed` says what moved.
- Record project conventions you learn with `add_project_note`.

## Work on this code

- TypeScript in `src/`, built with `npm run build`; tests with `npm test`; lint with `npm run lint`.
- Generated ExtendScript is ES3 inside template literals: escape backslashes twice, no `/` inside
  a regex character class, no ES3 reserved words as names. `src/__tests__/tools/generated-script-syntax.test.ts` checks.
- Live checks against a running Premiere (scratch project only):
  `PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/workflow-tests.mjs`.
- `docs/TOOL-COVERAGE.md`, `docs/LIVE-VERIFICATION.md` and the tool counts in `README.md` are
  checked by tests; regenerate with `npm run coverage:tools:measure` and `npm run verify:report`.
