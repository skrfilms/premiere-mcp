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
          tmpdir: () => (platform === 'win32' ? 'C:\\Users\\ben\\AppData\\Local\\Temp' : '/tmp'),
          homedir: () => (platform === 'win32' ? 'C:\\Users\\ben' : '/Users/testuser'),
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
    const { getDefaultTempPath } = loadPanelTempHelpers('win32', { TEMP: 'C:\\Users\\ben\\AppData\\Local\\Temp' });
    // The whole point: a hardcoded '/tmp' or a posix join here would produce a path
    // Premiere cannot poll, and the failure mode is a silent bridge timeout.
    expect(getDefaultTempPath()).toBe('C:\\Users\\ben\\AppData\\Local\\Temp\\premiere-mcp-bridge');
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
      TEMP: 'C:\\Users\\ben\\AppData\\Local\\Temp',
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
    process.env.TEMP = 'C:\\Users\\ben\\AppData\\Local\\Temp';
    const dir = createSecureTempDir('abc123');
    expect(dir.startsWith('C:\\Users\\ben\\AppData\\Local\\Temp')).toBe(true);
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

  it('ignores TMP on win32, unlike the panel — the two can disagree', () => {
    setPlatform('win32');
    delete process.env.TEMP;
    process.env.TMP = 'D:\\scratch';
    try {
      // Panel: %TEMP% || %TMP% || C:\Temp. Server: %TEMP% || C:\Temp. With only TMP
      // set, the panel polls D:\scratch\premiere-mcp-bridge and the server writes to
      // C:\Temp\premiere-bridge-<uuid>: every tool call times out, panel looks healthy.
      expect(createSecureTempDir('abc123')).not.toContain('D:\\scratch');
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

  it('still builds a /tmp path on darwin', () => {
    setPlatform('darwin');
    expect(createSecureTempDir('abc123')).toBe('/tmp/premiere-bridge-abc123');
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
   * What is asserted is the structural cause: the module binds path helpers to the
   * host platform instead of selecting path.win32 for win32 input. Until that
   * changes, no amount of macOS testing can cover the Windows branch, and this test
   * is the marker saying so. The lower-casing patch is in docs/WINDOWS-PARITY.md.
   */
  it('binds path helpers to the host platform, so win32 input cannot be covered here', () => {
    const source = readFileSync(path.join(__dirname, '..', '..', 'utils', 'security.ts'), 'utf8');
    expect(source).toMatch(/import \{ normalize, isAbsolute, resolve \} from 'path'/);
    expect(source).not.toMatch(/path\.win32/);
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
   * uid on the directory, same mismatch, same throw. Marked it.failing because the
   * fix belongs in src/bridge/index.ts, which this change does not own — the patch is
   * in docs/WINDOWS-PARITY.md. Flip to it() when that patch lands; Jest will fail
   * this suite the moment it passes, so it cannot rot into a silent skip.
   */
  it.failing('initialises instead of refusing the directory as foreign-owned', async () => {
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
