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
