/**
 * Do the Windows installer/doctor scripts still do what the macOS ones do?
 *
 * The mac scripts are the verified pair — they are run on this machine. The Windows
 * pair cannot be executed here (macOS, no pwsh), so the only thing that can be
 * checked from here is CORRESPONDENCE: that each capability the mac doctor grew is
 * present in the Windows doctor, and that no POSIX-only assumption has been copied
 * into a .ps1.
 *
 * Read the results narrowly. A green run means "the Windows scripts still claim to
 * do the same things, in the same grading, and contain no /tmp". It does NOT mean
 * the Windows scripts run, parse, or produce a correct verdict. That distinction is
 * the whole reason this file exists: the previous Windows doctor drifted behind four
 * separate macOS doctor improvements with nothing to notice.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const read = (name: string) => readFileSync(path.join(SCRIPTS, name), 'utf8');

const macDoctor = read('doctor-macos.sh');
const winDoctor = read('doctor-windows.ps1');
const macInstall = read('install-macos.sh');
const winInstall = read('install-windows.ps1');

describe('every platform has a matching script', () => {
  it.each([
    ['install-macos.sh', 'install-windows.ps1'],
    ['doctor-macos.sh', 'doctor-windows.ps1'],
    // uninstall-windows.ps1 did not exist: a Windows user who ran the installer had
    // no supported way to undo it, including no way to remove the auth token.
    ['uninstall-macos.sh', 'uninstall-windows.ps1'],
  ])('%s has a Windows counterpart %s', (mac, win) => {
    expect(existsSync(path.join(SCRIPTS, mac))).toBe(true);
    expect(existsSync(path.join(SCRIPTS, win))).toBe(true);
  });
});

describe('doctor parity — capabilities the mac doctor has, the Windows doctor must have', () => {
  it('samples the heartbeat twice to separate live / stale / not-running', () => {
    // Mac sleeps 1.2s between two reads; Windows must do the equivalent, or it cannot
    // tell a polling panel from a wedged one and will report a dead bridge as fine.
    expect(macDoctor).toMatch(/sleep 1\.2/);
    expect(winDoctor).toMatch(/Start-Sleep -Milliseconds 1200/);
    for (const doctor of [macDoctor, winDoctor]) {
      expect(doctor).toMatch(/bridge-heartbeat\.json/);
      expect(doctor).toMatch(/stale/i);
      expect(doctor).toMatch(/isProcessing/);
      expect(doctor).toMatch(/connected/);
    }
  });

  it('passes CEP debug mode if it is enabled for ANY CSXS version, including 11 and 12', () => {
    // Premiere 26.x uses CSXS.11/12. A per-version failure would ding a working setup,
    // so both doctors sweep a range and pass on any hit.
    expect(macDoctor).toMatch(/for csxs_version in 9 10 11 12 13 14 15/);
    expect(winDoctor).toMatch(/foreach \(\$version in 9\.\.15\)/);
    // ...and the installer must write the range the doctor reads, or setup and
    // diagnosis disagree about what "enabled" means.
    expect(winInstall).toMatch(/foreach \(\$version in 9\.\.15\)/);
    expect(macInstall).toMatch(/com\.adobe\.CSXS\.12/);
    expect(macInstall).toMatch(/com\.adobe\.CSXS\.11/);
  });

  it('reads PlayerDebugMode from the registry as a string on Windows, not a DWORD', () => {
    // CEP honours REG_SZ "1" and ignores a DWORD 1 — a DWORD looks enabled in regedit
    // and loads no panel, which is the most common bogus "I enabled debug mode".
    expect(winInstall).toMatch(/-PropertyType String/);
    expect(winInstall).toMatch(/HKCU:\\Software\\Adobe\\CSXS\./);
    expect(winDoctor).toMatch(/HKCU:\\Software\\Adobe\\CSXS\./);
    // And the mac side must still use defaults(1), not a registry path.
    expect(macDoctor).toMatch(/defaults read/);
  });

  it('probes ffmpeg, ffprobe and whisper, honouring the same override env vars', () => {
    for (const doctor of [macDoctor, winDoctor]) {
      expect(doctor).toMatch(/PREMIERE_MCP_FFMPEG_CMD/);
      expect(doctor).toMatch(/PREMIERE_MCP_FFPROBE_CMD/);
      expect(doctor).toMatch(/PREMIERE_MCP_WHISPER_CMD/);
      expect(doctor).toMatch(/transcribe_to_srt/);
    }
  });

  it('treats a missing client config as no finding at all, not a warning or a failure', () => {
    // The old Windows doctor warned on every absent config file and FAILED when a
    // present file had no premiere-pro entry, so a correct Claude-Code-only install
    // reported failures. Both doctors must return early on a missing file.
    expect(macDoctor).toMatch(/if \[\[ ! -f "\$path" \]\]; then\s*\n\s*return/);
    expect(winDoctor).toMatch(
      /if \(-not \(Test-Path -LiteralPath \$Path -PathType Leaf\)\) \{ return \}/,
    );
    // A present-but-empty premiere-pro entry is INFO on both.
    expect(macDoctor).toMatch(/no-entry\)\s*info/);
    expect(winDoctor).toMatch(/Info "\$Label present but has no premiere-pro entry"/);
  });

  it('detects the client/panel PREMIERE_TEMP_DIR mismatch that times out every tool call', () => {
    // The silent-failure mode: server writes commands where the panel never polls.
    // The old Windows doctor did not check this at all.
    for (const doctor of [macDoctor, winDoctor]) {
      expect(doctor).toMatch(/PREMIERE_TEMP_DIR/);
      expect(doctor).toMatch(/time out/);
    }
    expect(winDoctor).toMatch(/Test-SamePath/);
  });

  it('tallies failures separately from warnings and exits 1 only on failures', () => {
    expect(macDoctor).toMatch(/FAILURES=\$\(\(FAILURES \+ 1\)\)/);
    expect(macDoctor).toMatch(/WARNINGS=\$\(\(WARNINGS \+ 1\)\)/);
    expect(winDoctor).toMatch(/\$script:failures\+\+/);
    expect(winDoctor).toMatch(/\$script:warnings\+\+/);
    for (const doctor of [macDoctor, winDoctor]) {
      // Warnings must exit 0: a usable install with a caveat is not a broken install.
      expect(doctor).toMatch(/warning\(s\)/);
      expect(doctor).toMatch(/exit 1/);
    }
  });

  it('grades the CEP extension three ways: installed / incomplete / absent', () => {
    for (const doctor of [macDoctor, winDoctor]) {
      expect(doctor).toMatch(/manifest\.xml/);
      expect(doctor).toMatch(/incomplete/i);
      expect(doctor).toMatch(/index\.html/);
    }
  });

  it('requires Node 20+ on both platforms', () => {
    for (const script of [macDoctor, winDoctor, macInstall, winInstall]) {
      expect(script).toMatch(/20/);
      expect(script).toMatch(/process\.versions\.node\.split/);
    }
  });
});

describe('the Windows scripts carry no POSIX-only assumptions', () => {
  /**
   * Strip PowerShell comments before scanning.
   *
   * These scripts deliberately DISCUSS the POSIX mechanisms they replace — "chmod 0700
   * is a no-op on NTFS", "macOS uses defaults write" — and that prose is the honest
   * part, not the defect. Scanning raw text would force the scripts to stop explaining
   * themselves in order to pass, which is the wrong pressure. Only executable lines
   * are checked.
   */
  const codeOnly = (source: string): string =>
    source
      .replace(/<#[\s\S]*?#>/g, '') // block comments, including the help header
      .split('\n')
      .map((line) => line.replace(/(^|\s)#.*$/, '$1')) // line comments
      .join('\n');

  const winScripts: Array<[string, string]> = [
    ['install-windows.ps1', winInstall],
    ['doctor-windows.ps1', winDoctor],
    ['uninstall-windows.ps1', read('uninstall-windows.ps1')],
  ];

  it.each(winScripts)('%s builds no path under /tmp', (_name, source) => {
    const offenders = codeOnly(source)
      .split('\n')
      .filter((line) => /(^|[^a-zA-Z0-9_.])\/tmp['"/\s]/.test(line));
    expect(offenders).toEqual([]);
  });

  it.each(winScripts)(
    '%s does not reach for $HOME/Library, defaults(1), chmod or uname',
    (_name, source) => {
      const code = codeOnly(source);
      expect(code).not.toMatch(/\$HOME/);
      expect(code).not.toMatch(/Library\/Application Support/);
      expect(code).not.toMatch(/\bdefaults (read|write)\b/);
      expect(code).not.toMatch(/\bchmod\b/);
      expect(code).not.toMatch(/\buname\b/);
    },
  );

  it.each(winScripts)(
    '%s uses Join-Path rather than gluing separators into strings',
    (_name, source) => {
      expect(source).toMatch(/Join-Path/);
      // A '\'-concatenated path is the Windows equivalent of the mistake being guarded
      // against: it breaks the moment either side already has (or lacks) a separator.
      expect(source).not.toMatch(/\$\w+ \+ '\\\\'/);
    },
  );

  it.each(winScripts)('%s guards on Windows before doing anything', (_name, source) => {
    expect(source).toMatch(/IsWindows/);
    expect(source).toMatch(/Windows_NT/);
    expect(source).toMatch(/Set-StrictMode/);
  });

  it('reads no property off parsed JSON without a StrictMode-safe accessor', () => {
    // Set-StrictMode -Version Latest makes $obj.missingProperty a TERMINATING error and
    // $ErrorActionPreference is 'Stop', so `$hb2.connected` on a heartbeat written by an
    // older panel would abort the entire doctor instead of producing one warning.
    expect(winDoctor).toMatch(/function Get-Prop/);
    expect(winDoctor).not.toMatch(/\$hb2\.(ts|connected|isProcessing)/);
    expect(winDoctor).not.toMatch(/\$hb1\.ts/);
  });
});

describe('the Windows installer does the ACL work the server cannot', () => {
  it('restricts the bridge temp directory, because chmod 0700 is a no-op on NTFS', () => {
    // On macOS the SERVER protects this directory at runtime (mkdir 0o700 + chmod).
    // On NTFS the POSIX mode is not stored, so the installer is the only place the
    // equivalent can happen. If this assertion ever fails, auth-token.json is readable
    // by every interactive account on the machine and the token guarantees nothing.
    expect(winInstall).toMatch(/SetAccessRuleProtection/);
    expect(winInstall).toMatch(/FileSystemAccessRule/);
    expect(winInstall).toMatch(/Set-Acl/);
    // Set and verified, not set and assumed.
    expect(winInstall).toMatch(/Get-Acl -LiteralPath \$Path/);
  });

  it('names the broad identities by well-known SID, not by localised display name', () => {
    // 'Everyone' / 'Authenticated Users' / 'Users' are localised; the SIDs are not.
    for (const sid of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545']) {
      expect(winInstall).toContain(sid);
      expect(winDoctor).toContain(sid);
    }
  });

  it('states plainly that the POSIX mode guarantees nothing on Windows', () => {
    // The bridge writes the token 0600 and logs that it "tightened" the directory to
    // 700. Both are inert on NTFS. If the scripts stop saying so, the code's own
    // comments become the only account of the threat model, and they describe macOS.
    expect(winInstall).toMatch(/not enforced on NTFS|no-op/i);
    expect(winDoctor).toMatch(/not enforced on NTFS/);
    expect(winDoctor).toMatch(/auth-token\.json/);
  });

  it('verifies the CEP copy landed instead of trusting Copy-Item -Recurse', () => {
    // Copy-Item -Recurse into a destination that does not exist has flattened
    // subdirectories; that leaves the folder present with CSXS\manifest.xml missing,
    // and Premiere then shows no panel and reports nothing anywhere.
    expect(winInstall).toMatch(/CSXS\\manifest\.xml/);
    expect(winInstall).toMatch(/copy is incomplete/);
  });
});

describe('hardcoded /tmp in src — ratchet, not a clean bill of health', () => {
  const SRC = path.join(__dirname, '..', '..');

  const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  /**
   * Literals that are CORRECT: each sits on the non-win32 side of an explicit platform
   * branch, so on Windows it is never reached.
   *
   * Named individually rather than folded into the count. The count used to be 11 with a
   * note that "one of them is legitimate", which conflated two opposite things — a bug
   * waiting to be fixed and a deliberate posix branch — and meant the number could only
   * ever be read as an upper bound on the bug. Splitting them lets the bug count ratchet
   * down honestly, and makes ADDING a posix branch a deliberate edit here rather than
   * something that silently spends the budget.
   */
  const PLATFORM_BRANCHED = new Set([
    // createSecureTempDir: the win32 branch is directly above this line.
    "utils/security.ts '/tmp'",
    // defaultBridgeDir: returns the %TEMP%/%TMP% path for win32 before reaching this.
    "utils/scratch-paths.ts '/tmp/premiere-mcp-bridge'",
    // UXP probe queue: the win32 branch (os.tmpdir()) is on the same line.
    "bridge/uxp-channel.ts '/tmp/premiere-mcp-uxp'",
  ]);

  it('has not grown past the recorded baseline', () => {
    const hits: string[] = [];
    const branched: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const match of line.matchAll(/'\/tmp[^']*'/g)) {
            // Forward slashes whatever the host: on Windows path.relative() returns
            // 'utils\\security.ts', which never matched the allowlist and failed CI there.
            const rel = path.relative(SRC, file).split(path.sep).join('/');
            const where = `${rel}:${i + 1} ${match[0]}`;
            const key = `${rel} ${match[0]}`;
            (PLATFORM_BRANCHED.has(key) ? branched : hits).push(where);
          }
        });
    }

    /*
     * 0. The ten POSIX-only outputDir/asset defaults (which resolved to <drive>:\tmp\...
     * on Windows, so the render-truth tools failed there) now come from
     * utils/scratch-paths.ts. Any new '/tmp' literal outside an explicit platform branch
     * fails here; use bridgeDir() / generatedAssetsDir() instead.
     */
    expect(hits).toEqual([]);

    // Every allowlisted entry must still exist. Otherwise a deleted posix branch leaves a
    // stale exemption behind, and the next literal added at that path inherits it.
    expect(branched.length).toBe(PLATFORM_BRANCHED.size);
  });
});
