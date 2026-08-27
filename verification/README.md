# verification/

Machine-written evidence that tools were run against a real Adobe Premiere Pro host.

Nothing in `sweeps/` is written by hand. Each file is produced by a harness in `scripts/` at the
end of a run and records, for that run: the UTC time, the harness and whether it was allowed to
mutate, the commit and whether the tree was dirty, the Premiere version the host reported, the
platform, the catalogue size, and one entry per tool the run actually reached.

`docs/LIVE-VERIFICATION.md` is generated from these files:

```
npm run verify:report          # rewrite the summary from the ledger
npm run verify:report:check    # exit 1 if the summary and the ledger disagree
```

`src/__tests__/verification-ledger.test.ts` regenerates the summary and compares it to the file
on disk, so the document cannot claim anything a sweep did not observe. To change what it says,
run a sweep — not an editor.

## The second axis: `test-coverage.json`

`sweeps/` answers "did a real Premiere host run this tool?". `test-coverage.json` answers the
different and weaker question "did anything run it at all?" — the test suite dispatching a tool
against a mock bridge proves it is reachable and that its schema accepts arguments, and proves
nothing whatsoever about Premiere. `docs/TOOL-COVERAGE.md` prints both columns side by side and
never merges them.

```
npm run coverage:tools:measure   # instrumented test run, then aggregate and render
npm run coverage:tools           # aggregate .tool-coverage/*.jsonl and render
npm run coverage:tools:check     # exit 1 if the document and the data disagree
```

The measurement is instrumented, not grepped: `src/__tests__/tool-coverage-probe.ts` wraps the
dispatcher and records real invocations. Grepping test files for tool names gets it wrong in both
directions — a name in a table of expected strings is not a call, and a name assembled at runtime
is never a literal — and both errors are silent. `src/__tests__/tool-coverage.test.ts` byte-compares
the document against the data, the same mechanism as the sweep ledger.

## Why this exists

"Verified live against Premiere 26.3" used to live in commit messages. A sentence cannot be
re-read by a machine, cannot say which tools were covered, and cannot visibly rot. That is the
same failure as a hardcoded tool count: a claim the reader cannot check and the author cannot
notice going stale. A green unit suite is not a substitute — the active-target bug shipped behind
1,300 passing tests because the test fake made it inexpressible.

## What a sweep does not prove

- A `skipped_*` or `deferred_mutating` entry is **not** evidence. It records that we looked and
  did not run the tool, and why.
- A `pass` with `verified:false` means the call succeeded and its effect was never confirmed.
- A tool absent from every sweep is reported as **never exercised live**, with a count.
