/**
 * Windows behaviour, driven from macOS.
 *
 * Every line of this project was written and exercised on macOS. The Windows code
 * paths — the win32 branches, the temp-directory derivation, the ownership check —
 * had never been EXECUTED by anything, in production or in a test, so "Windows is
 * supported" rested on nothing but the presence of a `=== 'win32'` branch.
 *
 * These tests do not need Windows. They need the win32 INPUTS: platform reported as
 * win32, %TEMP% instead of $TMPDIR, path.win32 instead of path.posix, and a process
 * object with no getuid(). Feeding those in from macOS reaches the same branches a
 * Windows run would, and catches the class of defect that a mac-only suite is blind
 * to by construction.
 *
 * What these tests do NOT prove: that Premiere on Windows loads the panel, that the
 * registry PlayerDebugMode value is honoured, or that the CEP panel's own %TEMP%
 * matches the server's. Those need a Windows host and are recorded as owed in
 * docs/WINDOWS-PARITY.md rather than implied by this file passing.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'vm';
import { createSecureTempDir, validateFilePath } from '../../utils/security.js';
import { bridgeTempDirForDocs } from '../../resources/index.js';
import { PremiereProBridge } from '../../bridge/index.js';

const PANEL_PATH = path.join(__dirname, '..', '..', '..', 'cep-plugin', 'bridge-cep.js');

/**
 * The panel's temp-path helpers are module-local functions inside an IIFE, so they
 * cannot be imported. Rather than restating what they do (a source-text assertion
 * that any edit defeats while staying green — the exact failure mode
 * `helpers/panel.ts` was written to kill), the panel is loaded with an extra export
 * line spliced in, and the real functions are then called with win32 inputs.
 *
 * The splice anchor is asserted, so renaming the export line fails this suite loudly
 * instead of silently skipping the coverage.
 */
interface PanelTempHelpers {
  getDefaultTempPath(): string;
  sanitizeTempDirectoryInput(value: unknown): string;
}

function loadPanelTempHelpers(platform: 'win32' | 'darwin', env: Record<string, string | undefined>): PanelTempHelpers {
  const source = readFileSync(PANEL_PATH, 'utf8');
  const anchor = 'window.MCPPremiereBridge = MCPPremiereBridge;';
  if (!source.includes(anchor)) {
    throw new Error(`bridge-cep.js no longer contains the splice anchor "${anchor}" — update this helper.`);
  }
  const patched = source.replace(
    anchor,
    `${anchor}\nwindow.__parity = { getDefaultTempPath: getDefaultTempPath, sanitizeTempDirectoryInput: sanitizeTempDirectoryInput };`,
  );

  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: { addEventListener() {}, getElementById: () => null, readyState: 'complete' },
    navigator: { userAgent: 'test' },
    // The panel reads process.env directly; the sandbox gets only what the test set.
    process: { env },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console: { log() {}, warn() {}, error() {} },
    require: (name: string) => {
      if (name === 'fs') {
        return {
          existsSync: () => false, mkdirSync: () => {}, readdirSync: () => [],
          readFileSync: () => '', writeFileSync: () => {}, unlinkSync: () => {},
          renameSync: () => {}, statSync: () => ({ isDirectory: () => true }),
        };
      }
      // The real separator semantics for the platform under test. A posix path.join
      // on Windows inputs is precisely the bug this suite exists to catch, so the
      // stub must not smooth it over.
      if (name === 'path') return platform === 'win32' ? path.win32 : path.posix;
      if (name === 'os') {
        return {
          platform: () => platform,
          tmpdir: () => (platform === 'win32' ? 'C:\\Users\\testuser\\AppData\\Local\\Temp' : '/tmp'),
          homedir: () => (platform === 'win32' ? 'C:\\Users\\testuser' : '/Users/testuser'),
        };
      }
      return {};
    },
    CSInterface: function () {
      return { getHostEnvironment: () => ({ appName: 'PPRO', appVersion: '26.0.0' }), evalScript: () => {}, addEventListener() {} };
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(patched, sandbox);
  const helpers = (sandbox.window as { __parity?: PanelTempHelpers }).__parity;
  if (!helpers) throw new Error('panel did not expose the spliced temp helpers');
  return helpers;
}

describe('CEP panel getDefaultTempPath — both platform branches', () => {
  it('uses %TEMP% and backslash separators on win32', () => {
    const { getDefaultTempPath } = loadPanelTempHelpers('win32', { TEMP: 'C:\\Users\\testuser\\AppData\\Local\\Temp' });
    // The whole point: a hardcoded '/tmp' or a posix join here would produce a path
    // Premiere cannot poll, and the failure mode is a silent bridge timeout.
    expect(getDefaultTempPath()).toBe('C:\\Users\\testuser\\AppData\\Local\\Temp\\premiere-mcp-bridge');
  });

  it('falls back to TMP when TEMP is unset on win32', () => {
    const { getDefaultTempPath } = loadPanelTempHelpers('win32', { TMP: 'D:\\scratch' });
    expect(getDefaultTempPath()).toBe('D:\\scratch\\premiere-mcp-bridge');
  });

  it('falls back to C:\\Temp when neither TEMP nor TMP is set on win32', () => {
    const { getDefaultTempPath } = loadPanelTempHelpers('win32', {});
    expect(getDefaultTempPath()).toBe('C:\\Temp\\premiere-mcp-bridge');
  });

  it('still uses /tmp on darwin', () => {
    const { getDefaultTempPath } = loadPanelTempHelpers('darwin', {});
    expect(getDefaultTempPath()).toBe('/tmp/premiere-mcp-bridge');
  });

  it('honours PREMIERE_TEMP_DIR ahead of the platform default on win32', () => {
    const { getDefaultTempPath } = loadPanelTempHelpers('win32', {
      TEMP: 'C:\\Users\\testuser\\AppData\\Local\\Temp',
      PREMIERE_TEMP_DIR: 'E:\\Shows\\bridge',
    });
    expect(getDefaultTempPath()).toBe('E:\\Shows\\bridge');
  });

  it('never returns a path containing a forward slash on win32', () => {
    for (const env of [{ TEMP: 'C:\\T' }, { TMP: 'C:\\T' }, {}]) {
      const { getDefaultTempPath } = loadPanelTempHelpers('win32', env);
      expect(getDefaultTempPath()).not.toMatch(/\//);
    }
  });
});

describe('CEP panel sanitizeTempDirectoryInput — win32 inputs', () => {
  const win32 = () => loadPanelTempHelpers('win32', { TEMP: 'C:\\Temp' }).sanitizeTempDirectoryInput;

  it('rejects a pasted posix /tmp path on win32 rather than polling a path that cannot exist', () => {
    // Copy-pasting the README's macOS path into the panel on Windows is the obvious
    // user error; returning '' makes the panel fall back instead of watching C:\tmp.
    expect(win32()('/tmp/premiere-mcp-bridge')).toBe('');
    expect(win32()('/tmp')).toBe('');
  });

  it('keeps a drive-letter path intact, including one with spaces', () => {
    expect(win32()('C:\\Program Files\\Adobe\\bridge')).toBe('C:\\Program Files\\Adobe\\bridge');
  });

  it('collapses the doubled backslashes a user gets from copying out of JSON', () => {
    expect(win32()('C:\\\\Users\\\\ben\\\\Temp')).toBe('C:\\Users\\ben\\Temp');
  });

  it('extracts the value from a pasted JSON env block with a Windows path', () => {
    expect(win32()('{"PREMIERE_TEMP_DIR": "C:\\\\Temp\\\\bridge"}')).toBe('C:\\Temp\\bridge');
  });

  it('strips wrapping quotes, which Explorer "Copy as path" adds', () => {
    expect(win32()('"C:\\Temp\\bridge"')).toBe('C:\\Temp\\bridge');
  });
});

describe('createSecureTempDir — win32 branch', () => {
  const originalPlatform = process.platform;
  const originalTemp = process.env.TEMP;

  const setPlatform = (value: string) => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = originalTemp;
  });

  /**
   * A limit worth stating rather than working around: createSecureTempDir picks its
   * BASE from process.platform (stubbable, so testable here) but joins with the
   * module-level `normalize` imported from 'path', which is bound to the REAL host
   * platform at import time and cannot be stubbed. So from macOS the win32 branch
   * yields `C:\...\Temp/premiere-bridge-x` — a posix normalize on a Windows path.
   *
   * On a real Windows host normalize() is path.win32 and collapses that separator, so
   * the mixed path below is an artefact of testing from macOS, NOT a Windows defect.
   * Asserting the exact string would therefore be asserting a lie. What IS verifiable
   * from here is the base selection and the fallback, so that is what is asserted.
   */
  it('takes its base from %TEMP% on win32', () => {
    setPlatform('win32');
    process.env.TEMP = 'C:\\Users\\testuser\\AppData\\Local\\Temp';
    const dir = createSecureTempDir('abc123');
    expect(dir.startsWith('C:\\Users\\testuser\\AppData\\Local\\Temp')).toBe(true);
    expect(dir).toContain('premiere-bridge-abc123');
  });

  it('falls back to C:\\Temp when TEMP is unset — which is NOT a per-user directory', () => {
    setPlatform('win32');
    delete process.env.TEMP;
    // Documented, not endorsed. C:\Temp is machine-wide, and this directory holds the
    // bridge auth token and the command files that execute ExtendScript inside
    // Premiere. The panel tries TMP before falling back (bridge-cep.js); the server
    // does not, so an environment with only TMP set sends the two to different places.
    expect(createSecureTempDir('abc123').startsWith('C:\\Temp')).toBe(true);
  });

  it('honours TMP on win32, in the same order as the panel', () => {
    setPlatform('win32');
    delete process.env.TEMP;
    process.env.TMP = 'D:\\scratch';
    try {
      // Panel: %TEMP% || %TMP% || C:\Temp. The server used to be %TEMP% || C:\Temp, so
      // with only TMP set the panel polled D:\scratch\premiere-mcp-bridge while the
      // server wrote to C:\Temp\premiere-bridge-<uuid> — a different drive. Every tool
      // call timed out and the panel still looked healthy. Fixed 2026-08-26; the two now
      // agree on the BASE. They still differ on the leaf name, which the next test pins.
      expect(createSecureTempDir('abc123')).toBe('D:\\scratch\\premiere-bridge-abc123');
    } finally {
      delete process.env.TMP;
    }
  });

  it('uses a different directory NAME than the panel default, on either platform', () => {
    setPlatform('win32');
    process.env.TEMP = 'C:\\Temp';
    // Server default: premiere-bridge-<sessionId>. Panel default: premiere-mcp-bridge.
    // They can never agree unless PREMIERE_TEMP_DIR is set on both sides, which is why
    // every documented setup path sets it. A platform-independent trap, but on Windows
    // it compounds with the TEMP/TMP divergence above.
    expect(createSecureTempDir('abc123')).not.toContain('premiere-mcp-bridge');
  });

  it('still builds a posix /tmp path on darwin, whatever host runs the test', () => {
    setPlatform('darwin');
    // Asserted with forward slashes literally, not path.join: joining with the HOST
    // flavour is precisely the bug this pins. The darwin branch must emit a posix path
    // even when the suite runs on a Windows runner, where the old host-bound normalize()
    // turned it into \tmp\premiere-bridge-abc123 and failed this test for a reason that
    // had nothing to do with darwin.
    expect(createSecureTempDir('abc123')).toBe('/tmp/premiere-bridge-abc123');
  });
});

describe('the setup text the server hands agents and users', () => {
  /**
   * The in-product setup resource used to tell EVERY reader, on every platform, to type
   * `/tmp/premiere-mcp-bridge` into the panel — the one input the panel explicitly
   * rejects on win32. Following the documentation was sufficient to make the bridge
   * unstartable (docs/WINDOWS-PARITY.md P0 #2).
   *
   * Asserted by composition rather than by restating the string: the value the resource
   * emits is fed to the panel's REAL sanitizer, so this fails if either side changes
   * independently of the other.
   */
  const sanitizerFor = (env: Record<string, string | undefined>) =>
    loadPanelTempHelpers('win32', env).sanitizeTempDirectoryInput;

  it('gives a win32 reader a path the panel accepts, unchanged', () => {
    const env = { TEMP: 'C:\\Users\\testuser\\AppData\\Local\\Temp' };
    const documented = bridgeTempDirForDocs('win32', env);
    expect(sanitizerFor(env)(documented)).toBe(documented);
  });

  it('matches the panel default exactly, so the field is already correct', () => {
    // Same base fallback order and same leaf name. If these drift apart, a Windows user
    // who trusts the pre-filled field and one who follows the docs end up in different
    // directories, and only one of them matches the server.
    for (const env of [{ TEMP: 'C:\\T' }, { TMP: 'D:\\scratch' }, {}]) {
      expect(bridgeTempDirForDocs('win32', env))
        .toBe(loadPanelTempHelpers('win32', env).getDefaultTempPath());
    }
  });

  it('emits no %TEMP%, because the panel expands nothing', () => {
    // path.resolve('%TEMP%\\x') on Windows yields <cwd>\%TEMP%\x — a real directory with
    // a literal percent-sign name, and a server polling somewhere else.
    expect(bridgeTempDirForDocs('win32', { TEMP: 'C:\\T' })).not.toContain('%');
  });

  it('still documents /tmp off win32', () => {
    expect(bridgeTempDirForDocs('darwin', { TEMP: 'C:\\T' })).toBe('/tmp/premiere-mcp-bridge');
  });
});

describe('validateFilePath — why its Windows behaviour is NOT verifiable from macOS', () => {
  /**
   * The honest result of trying to test this from macOS.
   *
   * validateFilePath's forbidden-path guard lists 'C:\Windows\System32', and on
   * Windows it is a case-SENSITIVE startsWith against a case-INSENSITIVE filesystem,
   * so `c:\windows\system32\evil.exe` walks straight through. That is a real defect.
   *
   * It cannot be demonstrated here. `isAbsolute('C:\\Windows\\...')` is FALSE under
   * posix, so resolve() prepends the macOS cwd and the guard misses for a completely
   * different reason. A passing test written from macOS would be evidence of the
   * wrong thing, so no behavioural assertion is made.
   *
   * What is asserted is the structural cause: validateFilePath binds its path helpers
   * to the HOST platform instead of selecting a flavour for win32 input. Until that
   * changes, no amount of macOS testing can cover the Windows branch, and this test
   * is the marker saying so. The lower-casing patch is in docs/WINDOWS-PARITY.md.
   *
   * Scope narrowed 2026-08-26: createSecureTempDir in the same module now joins with
   * path.win32 / path.posix per branch, so a bare "this module contains no path.win32"
   * assertion is no longer true and would have to be deleted. The marker is kept by
   * asserting the thing that is still true — validateFilePath itself uses the
   * host-bound normalize/isAbsolute/resolve — so it cannot be retired by an unrelated
   * fix elsewhere in the file.
   */
  it('binds validateFilePath’s path helpers to the host platform, so win32 input cannot be covered here', () => {
    const source = readFileSync(path.join(__dirname, '..', '..', 'utils', 'security.ts'), 'utf8');
    // Host-bound helpers are still imported unqualified and still used by the guard.
    expect(source).toMatch(/import \{ normalize, isAbsolute, resolve[^}]*\} from 'path'/);
    // Just the function, cut at its own closing brace in column 1 — not at the next `export`,
    // which would drag in the following doc comment and whatever it happens to mention.
    const guard = source.slice(source.indexOf('export function validateFilePath'));
    const guardBody = guard.slice(0, guard.indexOf('\n}') + 2);
    expect(guardBody).toMatch(/\bresolve\(/);
    expect(guardBody).not.toMatch(/win32/);
    // The Windows entries the guard claims to cover, which only bite on a real host.
    expect(source).toContain('C:\\\\Windows\\\\System32');
  });

  it('does block the posix system directories it can actually see from here', () => {
    // Not a Windows assertion. It keeps the guard from being deleted wholesale on the
    // grounds that "the Windows half never worked anyway".
    expect(validateFilePath('/etc/passwd').valid).toBe(false);
    expect(validateFilePath('/System/Library/x').valid).toBe(false);
  });
});

describe('bridge temp-directory ownership check on a platform without getuid()', () => {
  let dir: string;
  const originalEnv = process.env.PREMIERE_TEMP_DIR;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'parity-getuid-'));
    process.env.PREMIERE_TEMP_DIR = dir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PREMIERE_TEMP_DIR;
    else process.env.PREMIERE_TEMP_DIR = originalEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /**
   * process.getuid does not exist on Windows, and fs.Stats.uid is reported as 0
   * there. setupTempDirectory compares `stats.uid !== process.getuid?.()`, so on
   * Windows that is `0 !== undefined` — always true — and the bridge THROWS
   * "Refusing to use <dir>: it is owned by uid 0" before it ever talks to Premiere.
   * The MCP server does not start on Windows at all.
   *
   * Deleting process.getuid on macOS reproduces it exactly: undefined getuid, a real
   * uid on the directory, same mismatch, same throw.
   *
   * FIXED 2026-08-26 in src/bridge/index.ts: the ownership assertion is now gated on a
   * uid actually being available (`process.getuid?.()` !== undefined) rather than run
   * unconditionally, because without a uid the comparison is not a failed check — it is
   * no check at all. Windows takes an explicit branch that says the mode is unenforced
   * on NTFS instead of logging a "tightened to 700" that cannot have happened. This was
   * it.failing while the patch was owed; it is a live assertion now, and the sibling
   * test below stops the fix being "achieved" by deleting the check.
   */
  it('initialises instead of refusing the directory as foreign-owned', async () => {
    const original = process.getuid;
    (process as unknown as { getuid: undefined }).getuid = undefined;
    try {
      await new PremiereProBridge().initialize();
    } finally {
      (process as unknown as { getuid: typeof original }).getuid = original;
    }
  }, 30000);

  it('still refuses a directory genuinely owned by another uid when getuid IS available', async () => {
    const original = process.getuid;
    (process as unknown as { getuid: () => number }).getuid = () => 999999;
    try {
      await expect(new PremiereProBridge().initialize()).rejects.toThrow(/Refusing to use/);
    } finally {
      (process as unknown as { getuid: typeof original }).getuid = original;
    }
  }, 30000);
});
