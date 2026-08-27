# Contributing

This project manipulates a live Premiere Pro session. Treat tool contracts and documentation as part of the product, not cleanup work.

## Local Setup

```bash
npm install
npm run build
```

For a full local install on macOS:

```bash
npm run setup:mac
```

That installs the CEP extension, builds the server, enables CEP debug mode, and updates Claude Desktop config.

For a full local install on Windows:

```powershell
npm run setup:win
```

That installs the CEP extension, builds the server, enables CEP debug mode, and updates GitHub Copilot in VS Code plus Claude Desktop config.

## Core Development Loop

Use this order:

1. Change TypeScript or CEP code.
2. Rebuild with `npm run build`.
3. If you changed `cep-plugin/bridge-cep.js`, reload the panel in Premiere Pro.
4. Run tests with `npm test -- --runInBand`.
5. Run a live sweep against a scratch project with `node scripts/live-tool-sweep.mjs`, or
   `node scripts/live-smoke-sweep.mjs` for the catalogue-wide read-only pass. Close every other
   project first: the sweep refuses to run while a second project is open, because a tool call
   that omits an explicit target could land on it.
6. Commit the sweep's ledger entry from `verification/sweeps/` and regenerate the summary with
   `npm run verify:report`. `npm run verify:report:check` fails when the summary and the ledger
   disagree, so `docs/LIVE-VERIFICATION.md` is never written by hand.
7. Update docs if behavior or setup changed.

Do not ship a new tool that has only been schema-validated if it claims to perform a real edit.
"Verified live" is not a sentence you write — it is a file a sweep wrote. See `verification/README.md`.

## Project Layout

```text
src/
  index.ts                MCP server entry point
  bridge/index.ts         File-based bridge and shared helpers
  tools/index.ts          PremiereProTools: the dispatcher, the meta/introspection tools,
                          and the last link of the domain class chain
  tools/catalogue.ts      Tool registrations (name, description, input schema)
  tools/domains/          One class per tool domain, chained by inheritance:
                          base.ts holds the shared state and pure helpers, and each domain
                          file extends the previous one. Add a tool implementation to the
                          domain file it belongs to, not to index.ts.
  resources/index.ts      MCP resources
  prompts/index.ts        MCP prompts
  verification/ledger.ts  Schema for the live-verification ledger and the report renderer
  utils/                  Shared helpers

cep-plugin/
  bridge-cep.js           CEP bridge runtime loaded by Premiere
  index.html              CEP panel UI
  CSXS/manifest.xml       CEP manifest

scripts/
  install-macos.sh        macOS installer
  install-windows.ps1     Windows installer for GitHub Copilot and Claude Desktop
  doctor-macos.sh         local installation verifier
  doctor-windows.ps1      Windows installation verifier
  uninstall-macos.sh      macOS uninstall helper
  uninstall-windows.ps1   Windows uninstall helper
  reset-scratch.mjs       rebuild the disposable fixture project from synthesised media
  live-tool-sweep.mjs     end-to-end live tool verifier (the execution census)
  live-smoke-sweep.mjs    faster read-mostly sweep; --mutate opts into write tools
  live-verify-honesty.mjs re-asks the real host the claims a mock cannot answer
  live-verify-cleanup.mjs in-place restore of the fixture after the verifier
  live-verify-tier1.mjs   read-only Tier-1 / footage-index verifier
  lib/
    require-scratch-project.mjs  shared guard: refuse to mutate a non-scratch project
```

## Tool Design Rules

### 1. Do not advertise fake capabilities

If Premiere cannot do something reliably through the available APIs, either:

- do not expose the tool, or
- expose it with a truthful limitation and a narrow scope

Do not return fake success.

### 2. Validate inputs at the schema layer

Every tool must have a Zod schema that rejects incomplete or invalid arguments before the bridge is touched.

### 3. Keep ExtendScript compatible

Use ExtendScript-safe JavaScript inside generated scripts:

- `var`, not `let` or `const`
- no arrow functions
- no modern syntax that ExtendScript does not support

### 4. Prefer truthful errors over silent fallback

If a Premiere API is missing or unsupported, return an explicit error that explains the dependency or limitation.

## Testing Expectations

Minimum bar before merging:

- `npm run build`
- `npm test -- --runInBand`

Release bar:

- `npm run setup:doctor`
- `node scripts/reset-scratch.mjs`
- `node scripts/live-tool-sweep.mjs`
- `node scripts/live-verify-honesty.mjs`, then `node scripts/live-verify-cleanup.mjs`

### The live harnesses mutate the open project

They create `Sweep ...` sequences, import generated assets, add markers and delete sequences. Open the disposable fixture first, never an edit you care about.

Every mutating harness calls `requireScratchProject()` from [scripts/lib/require-scratch-project.mjs](scripts/lib/require-scratch-project.mjs), which refuses any project whose name does not read as disposable and exits rather than warning. `src/__tests__/platform/live-harness-guards.test.ts` pins that each of them still calls it — add a new mutating harness to that list when you write one.

The guard is a backstop, not permission to be careless. It matches on the project NAME, so a real project that happens to be called `colour_test` passes it.

## Editing the CEP Bridge

The CEP code is loaded directly by Premiere and has no build step.

If you change [cep-plugin/bridge-cep.js](cep-plugin/bridge-cep.js):

1. Re-run `npm run setup:mac`, or manually copy the updated file into the installed extension.
2. Right-click the Premiere panel and choose `Reload`, or restart Premiere Pro.

If you forget that reload, you are testing stale JavaScript in memory.

## Documentation Rules

When behavior changes:

- update `README.md` if install, capability, or validation status changed
- update `QUICKSTART.md` if the shortest working path changed
- update `KNOWN_ISSUES.md` if a limitation was fixed or newly confirmed

Stale docs are considered a bug.

## Pull Requests

A good PR includes:

- what changed
- why it changed
- how it was tested
- whether the tool surface changed
- whether docs were updated

If you add, remove, or materially change a tool, mention it explicitly in the PR summary.
