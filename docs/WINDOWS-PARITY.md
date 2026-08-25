# Windows parity — audit, fixes, and what is still not true

**Date:** 2026-08-25 · **Branch:** `improve/m1-honesty-and-core-bugs` · **Audited at tip:** `b28c7af`

Windows is a stated hard requirement. Every line of this project was written and
exercised on macOS, and **no Windows code path in this repository has ever been
executed** — not in production, not in CI, not in a test. This document is the
audit of that gap, the part of it that has been closed, and the part that has not.

The single most important sentence in this file:

> **The MCP server does not start on Windows at all.** `PremiereProBridge.initialize()`
> throws unconditionally, before it ever contacts Premiere. Every one of the 642 tools
> is unreachable. This is not a rough edge; there is no working Windows install to
> polish.

Nothing below should be read as "Windows works now". The PowerShell in `scripts/`
was brought to genuine logical parity with the verified macOS scripts and reviewed
statically. It has **not been run**, because this work was done on macOS with no
`pwsh` available. The honest phrasing used throughout is *mirrored from the verified
mac logic, not executed*.

---

## 1. Findings

Severity: **P0** = Windows cannot work at all · **P1** = a feature is silently broken
or a security claim is false · **P2** = wrong results in specific cases · **P3** = noted.

Line numbers are from the 2026-08-25 working tree. `src/tools/index.ts` and
`src/bridge/index.ts` were being edited concurrently by other work, so each finding
quotes the offending text verbatim to stay greppable if lines drift.

### P0 — blockers

| # | File:line | Finding | Status |
|---|---|---|---|
| 1 | `src/bridge/index.ts:729` | `if (stats.uid !== process.getuid?.())` — `process.getuid` **does not exist on Windows** and `fs.stat().uid` is always `0` there, so this is `0 !== undefined`, always true. It throws `Refusing to use <dir>… owned by uid 0`, the catch at `:743` deliberately re-throws it, and `initialize()` propagates. **The server never starts on Windows.** The message also misreports: "owned by uid 0, not by this process (uid undefined)". | **FLAGGED** — patch §4.1. Reproduced from macOS and locked by a test. |
| 2 | `src/resources/index.ts:693`, `:785` | The in-product setup resource tells every user, on every platform, to `Set Temp Directory to /tmp/premiere-mcp-bridge`. On Windows the panel *rejects* exactly that input (`cep-plugin/bridge-cep.js:266` returns `''` for any `/tmp…` path when `os.platform() === 'win32'`), so `startBridge()` bails. A Windows user who follows the documentation cannot start the bridge. | **FLAGGED** — patch §4.2. |
| 3 | `src/utils/security.ts:83-91` vs `cep-plugin/bridge-cep.js:211-217` | Server default temp dir is `%TEMP%\premiere-bridge-<uuid>`; panel default is `%TEMP%\premiere-mcp-bridge`. They can never agree. Worse on Windows: the panel falls back `%TEMP% → %TMP% → C:\Temp`, the server only `%TEMP% → C:\Temp`, so a machine with only `TMP` set sends them to different drives. Symptom is the worst one available — a healthy-looking panel and every tool call timing out. | **FLAGGED** — patch §4.3. Locked by tests. |

### P1 — silently broken features, and false security claims

| # | File:line | Finding | Status |
|---|---|---|---|
| 4 | `src/bridge/index.ts:725`, `735-739` | `mkdir(mode: 0o700)` — mode is **ignored on Windows**. `stats.mode & 0o777` reports `0o777` for a directory, so the "tighten" branch fires every startup and `fs.chmod` only toggles the read-only attribute. The log line then says `Tightened <dir> from mode 777 to 700`, which **did not happen**. A fake-success log in a codebase whose thesis is honest verification. | **FLAGGED** — patch §4.1. |
| 5 | `src/bridge/index.ts:799, 810-811`; `src/bridge/socket-transport.ts:292-295` | `auth-token.json` (32 random bytes) and `bridge-endpoint.json` (loopback port **plus the token**) are written `{ mode: 0o600 }` + `chmod(0o600)`. **Both are no-ops on NTFS.** See §2 for the full truth. | **PARTLY FIXED** in `install-windows.ps1` / `doctor-windows.ps1`; code comment still wrong — patch §4.4. |
| 6 | `src/bridge/index.ts:706-722` | The doc comment states "The protection against other users is the 0700 directory and the ownership check, not the token." **Both mechanisms are inoperative on Windows.** A correct macOS threat model presented as platform-independent. | **FLAGGED** — patch §4.4. |
| 7 | `cep-plugin/bridge-cep.js:484` (also `:464`, `:504`) | `try { fs.unlinkSync(filePath); } catch (eUnlink) {}` — deletes the command file after execution. On POSIX unlink always succeeds. On Windows it throws `EBUSY`/`EACCES` while an AV scanner or the Search indexer holds a handle. The catch is empty, so the 250 ms poller finds the same `command-*.json` next tick and **re-executes the same mutating ExtendScript**. Silent duplicate `insertClip` / `ripple_delete`. Windows-only, steady-state. | **FLAGGED** — patch §4.5. Highest-consequence finding after P0 #1. |
| 8 | `src/tools/index.ts:6717, 6755, 7944, 7689, 15555` | `execSync` shell strings using `/dev/null`, `\| tail`, `\| grep`, `\| head`. `execSync` runs `cmd.exe` on Windows: `'tail' is not recognized`. | FLAGGED |
| 9 | `src/tools/index.ts:19850` | `execSync(\`cp "${f.path}" "${dest}"\`)` — `cp` does not exist in `cmd.exe`. Breaks `consolidate_and_transfer` and `archive_master`. | FLAGGED |
| 10 | `src/bridge/index.ts:1161`, `:1166` | `execSync('/usr/bin/pbpaste')` / `spawnSync('/usr/bin/pbcopy')` with **no platform guard**. `read_clipboard` / `write_clipboard` throw ENOENT on Windows. Windows has `Get-Clipboard`/`Set-Clipboard`. | FLAGGED |
| 11 | `src/tools/index.ts:5551` | `execSync('mdfind -name ".prproj"')` — Spotlight is macOS-only, no guard. `list_recent_projects` always fails on Windows. Should return an honest "unsupported on this platform" rather than a generic failure. | FLAGGED |
| 12 | `src/tools/index.ts:11123`, `:11189` | `spawn('ffmpeg', …)` hardcoded, bypassing `this.ffmpegCommand()` (`:11265`) which honours `PREMIERE_MCP_FFMPEG_CMD`. On Windows ffmpeg is usually *not* on PATH and that env var is the documented remedy (`:4623`), so `detect_silence` and `checkFfmpegAvailable()` report ffmpeg missing even when the operator configured it correctly. | FLAGGED |
| 13 | `src/tools/index.ts:11238`, `:11325`; `src/capture/ffmpeg.ts:55` | `spawn(cmd, args)` without `shell: true` resolves `.exe` but **not `.cmd`/`.bat`**. Chocolatey/Scoop/npm ffmpeg shims are `.cmd`, and since Node 20.12 `spawn` on a `.cmd` without a shell throws `EINVAL` → false "not found". | FLAGGED |
| 14 | 9 sites: `src/tools/index.ts:4313, 4314, 4315, 5073, 7050, 7893, 19712, 19800`; `src/tools/expanded.ts:313, 552` | Hardcoded `/tmp` defaults for `outputDir` / asset scratch. On Windows `/tmp/…` resolves to `<current drive>:\tmp\…`, which does not exist, so the "did the file land" check fails and the render-truth tools return `verified:false` on **every** Windows call. `tmpdir()` is already imported at `src/tools/index.ts:16`. | **RATCHETED** — a test now fails if the count grows. |
| 15 | `src/tools/index.ts:7050` | `var tmpPath = '/tmp/premiere-mcp-bridge/generated-assets/social_preset.epr';` — inside **generated ExtendScript**, so Premiere itself writes to `C:\tmp\…`. `export_social_preset` cannot work on Windows. | FLAGGED |
| 16 | `src/tools/index.ts:15873-15874` | AME preset search is `~/Library/Application Support/Adobe/Common/AMEPresets` with **no `%APPDATA%` branch at all** → `list_export_presets` returns zero presets on Windows. Note `:13617-13623` *does* handle `%APPDATA%` for a sibling lookup, so the codebase is internally inconsistent. | FLAGGED |

### P2 / P3

| # | File:line | Finding | Status |
|---|---|---|---|
| 17 | `src/tools/index.ts:20045` | `logoPath.split('/').pop()` — a Windows path has no `/`, so `.pop()` returns the **entire path**, the generated `indexOf` never matches and the logo lookup silently fails. Needs `split(/[\\/]/)`. | FLAGGED |
| 18 | `src/tools/index.ts:8537`, `:16418`; `src/utils/security.ts:48`, `:69` | Case-**sensitive** path comparison against a case-**insensitive** filesystem. `batchRelinkByPattern`/`batchRelinkByPrefix` report success with 0 relinked when drive-letter case differs. `security.ts:69` lets `c:\windows\system32\…` past a guard that lists `C:\Windows\System32`. Also `:48` has no separator-boundary check, so `C:\alloweddir\evil` passes an allowlist of `C:\allowed`. | FLAGGED — **not testable from macOS**, see §3. |
| 19 | `src/bridge/index.ts:687` | `envDir.replace(/\/$/, '')` strips a trailing `/` but not a trailing `\`, so `PREMIERE_TEMP_DIR=C:\bridge\` survives into string comparisons downstream. The panel handles both (`bridge-cep.js:243`). | FLAGGED |
| 20 | `src/tools/index.ts:5511, 19939, 19961`; `src/bridge/index.ts:1394` | Forward slash concatenated *inside* generated ExtendScript / Node path building → `C:\Users\me/out.mp4`. Win32 APIs tolerate it, but the non-canonical path is returned to the caller and then fails any `existsSync`/string compare against a properly joined path. | FLAGGED |
| 21 | `src/tools/index.ts:15555, 19598, 19622, 7944` | ffmpeg `lavfi` filtergraphs with an interpolated path. `lavfi` treats `:` as an option separator and `\` as an escape, so `movie=C:\clips\a.mp4` is unparseable. `:19598` applies POSIX single-quote escaping, which does nothing for a drive colon or backslashes. | FLAGGED |
| 22 | ~18 sites incl. `src/tools/index.ts:7687, 7689, 15575, 19246, 19850` | `JSON.stringify(path)` and naked `"${path}"` used as **shell** quoting. JSON escaping emits `"C:\\a\\b"`, which `cmd.exe` passes through with doubled backslashes. A path ending in `\` turns `"C:\out\"` into an escaped quote under MSVCRT argv parsing and swallows the next argument. | FLAGGED — fixed as a class by converting to `spawn` + argv. |
| 23 | `cep-plugin/bridge-cep.js:474` | `filePath.replace('command-', 'response-')` replaces the first occurrence **anywhere in the absolute path**. A temp dir containing `command-` corrupts the response path. Not Windows-specific; Windows profile names make it likelier. | FLAGGED |
| 24 | `src/bridge/index.ts:1056-1058` | Premiere install search checks `%ProgramFiles%\Adobe` but not `%ProgramFiles(x86)%`. Note `findInstalledMediaEncoder` at `:2257-2287` checks **both** — inconsistent. | FLAGGED (minor) |
| 25 | repo root | **No `.gitattributes`.** With Git's Windows default `core.autocrlf=true`, every `.ts` and `cep-plugin/bridge-cep.js` checks out CRLF. Runtime impact is nil (escapers are built from `String.fromCharCode`; all `join('\n')` happen at runtime), but `docs-drift.test.ts` and `generated-script-syntax.test.ts` do exact-text comparisons and will fail on a Windows clone. `* text=auto eol=lf` is a cheap prerequisite for Windows CI. | FLAGGED |
| 26 | `src/tools/srt.ts:144, 203, 206` | **No defect.** Reads normalize BOM + CRLF/CR (`:144`, `:203`); writes are LF-only (`:206`). Premiere and mainstream players accept LF, and the round-trip check at `src/tools/index.ts:9605` is self-consistent. Flagged only so LF stays a conscious choice. Same for the EDL at `:15819` and CSVs at `:6794`, `:7166` — Excel on Windows prefers CRLF; worth a real-world check, not a blind change. | NOTED |
| 27 | ExtendScript path escaping (category audited in full) | **No defect.** Every interpolation site goes through `JSON.stringify` (~24 sites in `tools/index.ts`, plus `bridge/index.ts:1397, 1525`), and both escapers handle backslash explicitly (`bridge/index.ts:53`, `cep-plugin/bridge-cep.js:22`, parser at `:101`). A Windows `getMediaPath()` round-trips correctly. | NOTED — do not "fix" |
| 28 | `src/cli.ts:22-48` | **No defect.** `runPlatformScript` branches darwin/win32/throw correctly, uses `join()` throughout, and `spawn('powershell.exe', …)` resolves without a shell. The `#!/usr/bin/env node` shebang is irrelevant because `package.json` declares `bin` and npm generates a `.cmd` shim. Only gap: no `pwsh` (PowerShell 7) fallback — patch §4.6. `run` and `runPlatformScript` are module-local, so not unit-testable. | NOTED |

### Fixed in the files this change owns

| File | Was | Now |
|---|---|---|
| `scripts/doctor-windows.ps1:41-73` | Warned on **every** missing client config and **FAILED** when a present config had no `premiere-pro` entry. A correct Claude-Code-only install reported 3 warnings and 2 failures. | Missing file → no finding (mirrors the mac `return`); no entry → INFO; bad path → WARN; invalid JSON → FAIL. Plus a `clientFound` tally and the mac's closing "point it at `node <dist>`" note. |
| `scripts/doctor-windows.ps1` | No `PREMIERE_TEMP_DIR` mismatch check — the mac doctor's most valuable check was simply absent. | Added, with `Test-SamePath` doing case-insensitive, separator-normalised, trailing-separator-tolerant comparison (a plain string compare, as on mac, produces false results on Windows). |
| `scripts/doctor-windows.ps1:126-137` (old) | `$hb2.connected` / `$hb2.isProcessing` / `$hb1.ts` read directly off `ConvertFrom-Json` output. Under `Set-StrictMode -Version Latest` a **missing** property is a terminating error, and `$ErrorActionPreference = 'Stop'`, so a heartbeat from an older panel would **abort the whole doctor** instead of producing one warning. | All parsed-JSON reads go through `Get-Prop`. A test asserts no direct `$hb1.ts` / `$hb2.*` access returns. |
| `scripts/doctor-windows.ps1:99-103` (old) | CEP check tested only `CSXS\manifest.xml`; no "present but incomplete" state. | Three-way grading matching mac: installed / incomplete / absent, checking `manifest.xml` **and** `index.html`. |
| `scripts/doctor-windows.ps1` | No INFO level; no `$env:OS` alternative for PowerShell 7; no ACL check. | `Info` helper, `$IsWindows`-or-`$env:OS` guard, and `Test-TempDirectoryAcl` (see §2). Check order now matches the mac doctor top to bottom. |
| `scripts/install-windows.ps1` | `Copy-Item -Path <dir> -Destination <missing dir> -Recurse` — has flattened subdirectories on some PowerShell versions, leaving the folder present with `CSXS\manifest.xml` missing. Premiere then shows no panel and reports nothing. | Creates the target, copies `\*`, then **verifies** `CSXS\manifest.xml`, `index.html`, `bridge-cep.js` landed and throws if not. |
| `scripts/install-windows.ps1` | Bridge temp dir created with no ACL at all. | `Set-BridgeDirectoryAcl` disables inheritance and grants only the current user, SYSTEM and Administrators — then reads the ACL back and warns if a broad SID survives. This is the only place the Windows equivalent of the server's `0700` can happen. §2. |
| `scripts/install-windows.ps1` | `PlayerDebugMode` written with no readback. | Readback-confirmed per version; warns if none confirmed. `-PropertyType String` retained and commented — CEP honours `REG_SZ "1"` and **ignores a DWORD**, which is the most common bogus "I enabled debug mode". CSXS 9–15 covers 11 and 12, which Premiere 26.x uses. |
| `scripts/install-windows.ps1:126` (old) | `Set-Content -Encoding UTF8` writes a **BOM** on Windows PowerShell 5.1. | `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)`. (Node does strip a leading BOM from CJS, so this was latent, not live.) |
| `scripts/install-windows.ps1` | Told the user to set the panel's temp dir with no warning that the panel derives `%TEMP%` from *Premiere's* environment. | Step 4 now says to type the exact path rather than trust the default, and names the timeout symptom. |
| `scripts/uninstall-windows.ps1` | **Did not exist.** `uninstall-macos.sh` had no Windows counterpart, so a Windows user who ran the installer had no supported way to undo it — including no way to remove the auth token. | Added. Mirrors the mac uninstaller; deletes the config entry via Node rather than `ConvertTo-Json`, whose default `-Depth 2` on PowerShell 5.1 would silently corrupt every *other* MCP server in the user's config. |

---

## 2. The auth token on Windows — the exact truth

The bridge's stated threat model (`src/bridge/index.ts:706-722`) is:

> *"The protection against other users is the 0700 directory and the ownership check,
> not the token."*

**On Windows, both of those are inoperative, so as shipped there is nothing equivalent.**
Concretely:

1. `fs.mkdir(dir, { mode: 0o700 })` — Node **ignores `mode` on Windows**. The directory
   inherits its parent's ACL.
2. `fs.chmod(dir, 0o700)` and `fs.writeFile(token, { mode: 0o600 })` — on Windows
   `chmod` can only toggle the **read-only attribute**. It cannot express an owner /
   group / world split, because NTFS does not store one. The mode is not enforced.
3. The ownership check that was supposed to be the real control (`stats.uid !==
   process.getuid?.()`) does not work on Windows either — it is finding P0 #1, and it
   fails *closed*, taking the whole server down rather than protecting anything.
4. So `auth-token.json` is protected by exactly one thing: **the NTFS ACL that the
   containing directory happened to inherit.** If `PREMIERE_TEMP_DIR` is left at the
   default under `%LOCALAPPDATA%\Temp`, that ACL is per-user and the token is in
   practice fine. If it is pointed anywhere else — `C:\premiere-bridge`, `D:\shared`, a
   network share, or the `C:\Temp` fallback the server uses when `%TEMP%` is unset —
   the 32-byte session token is readable by every account on the machine.

Why that matters more than a leaked secret usually would: anything that can read the
token can write a `command-*.json` into that directory, and the panel executes it as
arbitrary ExtendScript inside Premiere with full project and filesystem reach.

**What this change does about it.** `install-windows.ps1` now sets the ACL explicitly
(inheritance off; FullControl for the current user, SYSTEM and Administrators only) and
reads it back, and `doctor-windows.ps1` re-checks it every run, warning by well-known
SID (`S-1-1-0` Everyone, `S-1-5-11` Authenticated Users, `S-1-5-32-545` BUILTIN\Users,
`S-1-5-4` INTERACTIVE, `S-1-5-7` ANONYMOUS LOGON — matched by SID because the display
names are localised).

**What this change does *not* do.** The installer is not the server. A user who sets
`PREMIERE_TEMP_DIR` to a fresh directory after installing, or who runs the server
without ever running the installer, gets **no** protection — the server itself still
believes `chmod` worked and logs that it "tightened" the directory. Closing that
properly needs an ACL check inside `setupTempDirectory` on win32 (§4.1 makes the
platform split; §4.4 fixes the comment). Until then the doctor is the only thing that
will tell the truth, and it only tells it when someone runs it.

---

## 3. What remains UNVERIFIED, and what the maintainer would need to do

Everything in this section is unverified because the work was done on macOS with no
`pwsh` installed. Nothing in `scripts/*.ps1` has been parsed, let alone executed.

**Not verified at all — needs a Windows machine with Premiere 26.x:**

1. **That the three `.ps1` files parse.** They were written and reviewed by eye. A
   PowerShell syntax error would surface on the first run and nowhere earlier.
   Cheapest check, no Premiere needed:
   `Get-Command -Syntax`, or better, on any machine with PowerShell 7 —
   ```
   pwsh -NoProfile -Command "foreach ($f in Get-ChildItem scripts/*.ps1) { [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$e); if ($e) { $f.Name; $e } }"
   ```
   This is worth doing on the maintainer's Mac if `pwsh` can be installed (`brew install powershell`),
   because it would move item 1 from "unverified" to "verified" without any Windows box.
2. **`Set-StrictMode -Version Latest` behaviour on missing JSON properties.** The
   `Get-Prop` accessor was added because StrictMode 3.0 is documented to make a missing
   property a terminating error. That reasoning is from documentation, not from a run.
   The fix is strictly safer either way, but the *severity* of the original bug is
   asserted, not observed.
3. **That `Set-Acl` with inheritance disabled actually sticks** on a directory under
   `%TEMP%`, un-elevated, and that removing the inherited ACEs does not lock the CEP
   panel (running as the same user, so it should not) out of the directory. **This is
   the highest-risk untested change in this batch** — if it is wrong, the panel cannot
   read/write the bridge directory and the install is worse than before. Test on a
   throwaway Windows profile first.
4. **That `Copy-Item -Path <src>\* -Destination <dst> -Recurse` preserves `CSXS\`.**
   Mitigated rather than verified: the installer now throws if `manifest.xml` is missing
   after the copy, so a wrong assumption fails loudly instead of silently.
5. **That `PlayerDebugMode` as `REG_SZ "1"` under `HKCU:\Software\Adobe\CSXS.11` and
   `.12` actually loads the unsigned panel in Premiere 26.x.** This is the one item that
   genuinely requires Premiere on Windows.
6. **Whether the CEP panel's `process.env.TEMP` inside Premiere matches the installing
   shell's `%TEMP%`.** If it does not, the default temp dir silently diverges. The
   installer now tells the user to type the path rather than trust the default, which
   sidesteps it without answering it.
7. **Every P0/P1 code finding above**, once patched. In particular P0 #1: after applying
   §4.1, `initialize()` should succeed on Windows. That is the gate for testing anything
   else, and until it passes no tool has ever run on Windows.

**Suggested order for the maintainer:** install `pwsh` on the Mac and parse-check the three
scripts (30 seconds, catches the most likely class of error) → apply §4.1 → on a
Windows box, `npm run setup:win` then `npm run setup:doctor:win` → open the panel and
call `ping`. Item 3 (the ACL) is the one to watch.

**Also not verifiable from macOS, by construction:** finding #18. `src/utils/security.ts`
imports `normalize`, `isAbsolute` and `resolve` from `'path'`, which bind to the host
platform at import time. From macOS, `isAbsolute('C:\\Windows\\System32\\x')` is
**false**, so `resolve()` prepends the macOS cwd and the forbidden-path guard misses for
a reason that has nothing to do with the real Windows bug. A test written from macOS
would pass or fail for the wrong reason, so `windows-paths.test.ts` deliberately makes
no behavioural assertion there and instead asserts the structural cause (host-bound path
helpers, no `path.win32`). That test is the marker; delete it only when the module
selects its path flavour explicitly.

---

## 4. Patches for files this change does not own

### 4.1 — P0 #1 + P1 #4: `src/bridge/index.ts:727-745`

Split the POSIX ownership/mode assertion from the Windows case instead of running a
check that cannot work. Replace the inner `try` block:

```ts
      // POSIX only. mkdir's mode is ignored for an existing directory, so assert it
      // every time -- but only where a mode and a uid mean something. On Windows
      // fs.Stats.uid is always 0 and process.getuid does not exist, so the old
      // comparison was `0 !== undefined`: always true, and it took the whole bridge
      // down before it ever reached Premiere.
      if (process.platform !== 'win32') {
        try {
          const stats = await fs.stat(this.tempDir);
          if (stats.uid !== process.getuid?.()) {
            throw new Error(
              `Refusing to use ${this.tempDir}: it is owned by uid ${stats.uid}, not by this process (uid ${process.getuid?.()}). ` +
              'A directory owned by someone else can feed arbitrary ExtendScript into Premiere.',
            );
          }
          const mode = stats.mode & 0o777;
          if (mode !== 0o700) {
            await fs.chmod(this.tempDir, 0o700);
            this.logger.warn(`Tightened ${this.tempDir} from mode ${mode.toString(8)} to 700`);
          }
        } catch (statError) {
          if (statError instanceof Error && statError.message.startsWith('Refusing to use')) throw statError;
          this.logger.warn(`Could not verify temp directory permissions: ${statError}`);
        }
      } else {
        // NTFS stores no POSIX mode, so mkdir's 0o700 above did nothing and a chmod
        // here would only toggle the read-only attribute. Saying so is the honest
        // move: the previous code logged "Tightened ... to 700" for an operation that
        // cannot happen. The token file in this directory is protected by the
        // directory's inherited ACL and nothing else -- scripts/install-windows.ps1
        // restricts it, and scripts/doctor-windows.ps1 re-checks it.
        this.logger.warn(
          `${this.tempDir}: POSIX permissions are not enforced on Windows, so this directory and auth-token.json ` +
          'are protected only by their inherited NTFS ACL. Run npm run setup:doctor:win to check it.',
        );
      }
```

Then flip `it.failing` → `it` on *"initialises instead of refusing the directory as
foreign-owned"* in `src/__tests__/platform/windows-paths.test.ts`. Jest fails a
`.failing` test that passes, so it cannot rot.

### 4.2 — P0 #2: `src/resources/index.ts:693, 785`

Make the documented temp dir platform-conditional so it stops contradicting the panel's
own `/tmp`-rejection on win32:

```ts
const defaultTempDir = process.platform === 'win32'
  ? '%TEMP%\\premiere-mcp-bridge'
  : '/tmp/premiere-mcp-bridge';
```
…and interpolate it at both sites instead of the literal.

### 4.3 — P0 #3: `src/utils/security.ts:83-91`

Align the name with the panel and add the missing `TMP` step:

```ts
export function createSecureTempDir(sessionId: string): string {
  const tempBase = process.platform === 'win32'
    // The panel reads TEMP || TMP || C:\Temp. Omitting TMP here sent the server and the
    // panel to different directories on a machine with only TMP set, which presents as
    // a healthy panel and every tool call timing out.
    ? process.env.TEMP || process.env.TMP || 'C:\\Temp'
    : '/tmp';
  return join(tempBase, `premiere-bridge-${sessionId}`);
}
```
(`join` from `node:path`, not a template literal — see finding #20.) Note this still
does not match the panel's `premiere-mcp-bridge`; unifying the *name* is a separate
call, since changing it changes where existing installs look.

### 4.4 — P1 #5/#6: `src/bridge/index.ts:715-721` comment

```
   * 3. A per-session token is written 0600 and required on every command (see writeAuthToken).
   *    ON WINDOWS THAT MODE IS NOT ENFORCED. NTFS stores no POSIX mode, so both the 0700
   *    directory and the 0600 token file are inert, and the ownership check above is
   *    skipped because process.getuid does not exist. The token is protected only by the
   *    directory's inherited NTFS ACL. scripts/install-windows.ps1 restricts that ACL and
   *    scripts/doctor-windows.ps1 verifies it; a server started without those having run
   *    has no equivalent protection. See docs/WINDOWS-PARITY.md section 2.
```

### 4.5 — P1 #7: `cep-plugin/bridge-cep.js:484`

The duplicate-execution window. Delete-before-execute would be the real fix; the
minimal one is to retry and, on final failure, refuse to re-run the command:

```js
        var unlinked = false;
        for (var attempt = 0; attempt < 5 && !unlinked; attempt++) {
            try { fs.unlinkSync(filePath); unlinked = true; }
            catch (eUnlink) { /* Windows: EBUSY/EACCES while an AV scanner or the
                                 indexer holds a handle. POSIX never gets here. */ }
        }
        if (!unlinked) {
            // Without this the 250ms poller finds the same command file next tick and
            // re-executes the same mutating ExtendScript. A remembered id is cheaper
            // than a duplicate ripple_delete.
            this.executedCommandIds = this.executedCommandIds || {};
            this.executedCommandIds[filePath] = true;
            this.log('Could not delete ' + filePath + ' after 5 attempts; suppressing re-execution.', 'warning');
        }
```
…and have `watchDirectory` skip any path already in `executedCommandIds`.

### 4.6 — #28: `src/cli.ts:35`

Prefer PowerShell 7 when present; `powershell.exe` (5.1) is not guaranteed on future
Windows images:

```ts
  } else if (process.platform === 'win32') {
    // pwsh (7+) first, powershell.exe (5.1) as the fallback. Both are given
    // -NoProfile so a user's profile cannot change the script's behaviour.
    const shell = await which('pwsh') ?? 'powershell.exe';
    code = await run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(packageRoot, 'scripts', windowsScript), ...windowsArgs]);
```
Also note `runPlatformScript` passes `--skip-build` to the mac script for **both**
`install` and `doctor`; `doctor-macos.sh` ignores extra args so it is harmless, but the
two platforms take different argument paths for no reason.

### 4.7 — `package.json`

`uninstall:mac` exists with no Windows counterpart. Add beside it:

```json
    "uninstall:win": "powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/uninstall-windows.ps1",
```

### 4.8 — new `.gitattributes` (finding #25)

```
* text=auto eol=lf
*.ps1 text eol=crlf
*.png binary
*.zxp binary
```
`eol=lf` keeps the exact-text tests passing on a Windows clone; `.ps1` as CRLF is the
PowerShell convention and PowerShell reads either.

---

## 5. Tests added

`src/__tests__/platform/windows-paths.test.ts` — 20 tests that execute Windows code
paths from macOS by supplying win32 *inputs*:

- The panel's `getDefaultTempPath` and `sanitizeTempDirectoryInput` driven with
  `os.platform() === 'win32'` and **`path.win32`**, covering `%TEMP%` → `%TMP%` →
  `C:\Temp`, `PREMIERE_TEMP_DIR` precedence, the posix-`/tmp`-paste rejection, doubled
  backslashes from copied JSON, quotes from Explorer "Copy as path", and a path with a
  space. These are module-local functions inside an IIFE, so the panel source is loaded
  into a VM with an export line spliced in after an **asserted** anchor — renaming the
  anchor fails the suite loudly rather than silently skipping the coverage.
- `createSecureTempDir` on both branches, including the `%TMP%`-ignored divergence from
  the panel and the differing directory name.
- The P0 `getuid` defect, reproduced by deleting `process.getuid` on macOS: undefined
  getuid, a real uid on the directory, the same mismatch, the same throw. Marked
  `it.failing` with the patch referenced, since the fix is in a file this change does
  not own — and Jest fails a `.failing` test that starts passing, so it cannot become a
  silent skip. A companion test asserts the guard **still fires** for a genuine uid
  mismatch, so the patch cannot be "fixed" by deleting the check.

`src/__tests__/platform/installer-parity.test.ts` — 30 tests asserting the Windows
scripts still correspond to the verified mac ones: heartbeat double-sample, CSXS 9–15
any-version pass, `REG_SZ` not DWORD, all three backend probes, missing-config-is-not-a-
finding, the `PREMIERE_TEMP_DIR` mismatch check, separate failure/warning tallies,
three-way CEP grading, Node 20+, a Windows counterpart existing for every mac script,
the ACL work and its SID-based matching, the post-copy `manifest.xml` verification, and
the StrictMode-safe accessor. Plus: no `/tmp`, `$HOME`, `chmod`, `defaults` or `uname`
in any `.ps1` **code** (comments are stripped first — the scripts should be free to
explain the POSIX mechanism they replace), and a ratchet on hardcoded `/tmp` in `src/`
that fails if the count grows past 11.

These are static assertions about correspondence. They cannot show the scripts run.
Their job is to stop the Windows pair drifting behind the mac pair again, which is
exactly how it got four improvements behind.
