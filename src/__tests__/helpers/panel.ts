/**
 * Loading the CEP panel so its own code can be driven.
 *
 * Tests here kept re-deriving what the panel does by reading its source — the
 * line that builds `fullScript`, the reject-pattern array, the length ceiling —
 * and every one of those was defeated by an ordinary edit that left the panel
 * behaving differently while the assertion still matched:
 *
 *   - pinning the `fullScript` assignment missed `evalScript(script)`, so the
 *     prelude stopped being prepended with the suite green
 *   - the length ceiling was read with a first-match regex, so a doc comment
 *     restating the old value hid a real ceiling low enough to reject every call
 *   - the pattern list was read up to the first `];`, so moving patterns into a
 *     second array silently shortened it
 *
 * Driving the panel removes the whole class: whatever it actually does is what
 * gets asserted. `jest.config.js` sets `roots: ['<rootDir>/src']`, so nothing
 * under `cep-plugin/` is collected as a test — this is how that code is reached.
 */

import vm from 'vm';
import path from 'path';

const realFs = jest.requireActual<typeof import('fs')>('fs');

export const PANEL_PATH = path.join(__dirname, '..', '..', '..', 'cep-plugin', 'bridge-cep.js');

export interface LoadedPanel {
  /** A bridge instance with its prototype methods, no constructor side effects. */
  bridge: Record<string, any>;
  /** Whatever the panel last handed to evalScript. */
  handedToEvalScript: () => string;
  /** How many times the panel called evalScript — proves a probe was or was not dispatched. */
  evalScriptCalls: () => number;
  /** The fake elements created for `options.elements`, keyed by id. */
  elements: Record<string, FakeElement>;
}

export interface LoadPanelOptions {
  /**
   * Replaces the default no-op `fs` stub, so a test can record what the panel
   * writes (e.g. the heartbeat payload) or simulate disk failures. Only the
   * methods a test needs must be supplied; the rest keep their no-op defaults.
   */
  fs?: Record<string, unknown>;
  /**
   * Ids the panel's `document.getElementById` should resolve, so a test can assert
   * what the panel actually PUT ON SCREEN. Without this every lookup returns null and
   * the panel's null guards make its whole rendering path silently unobservable —
   * which is why the status-light behaviour went untested long enough to ship a green
   * light that proved nothing. Unlisted ids still return null, matching a partial DOM.
   */
  elements?: string[];
}

/** The element surface the panel touches: className, textContent, innerHTML, value, disabled. */
export interface FakeElement {
  className: string;
  textContent: string;
  innerHTML: string;
  value: string;
  disabled: boolean;
}

function fakeElement(): FakeElement {
  return { className: '', textContent: '', innerHTML: '', value: '', disabled: false };
}

/** Minimal stand-ins for what the panel pulls in at load time. */
function nodeStub(name: string, options: LoadPanelOptions): unknown {
  if (name === 'fs') {
    const base = {
      existsSync: () => false,
      mkdirSync: () => {},
      readdirSync: () => [],
      readFileSync: () => '',
      writeFileSync: () => {},
      unlinkSync: () => {},
      renameSync: () => {},
      statSync: () => ({ isDirectory: () => false }),
    };
    return options.fs ? { ...base, ...options.fs } : base;
  }
  if (name === 'path') {
    return {
      join: (...parts: string[]) => parts.join('/'),
      basename: (value: string) => value,
      dirname: (value: string) => value,
    };
  }
  if (name === 'os') return { tmpdir: () => '/tmp', homedir: () => '/tmp' };
  return {};
}

export function loadPanel(options: LoadPanelOptions = {}): LoadedPanel {
  const source = realFs.readFileSync(PANEL_PATH, 'utf8');
  let handed = '';
  let evalCalls = 0;
  const elements: Record<string, FakeElement> = {};
  for (const id of options.elements ?? []) elements[id] = fakeElement();

  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: {
      addEventListener() {},
      getElementById: (id: string) => elements[id] ?? null,
      readyState: 'complete',
    },
    navigator: { userAgent: 'test' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console: { log() {}, warn() {}, error() {} },
    require: (name: string) => nodeStub(name, options),
    CSInterface: function () {
      return {
        getHostEnvironment: () => ({ appName: 'PPRO', appVersion: '26.0.0' }),
        evalScript: (script: string) => {
          handed = script;
          evalCalls += 1;
        },
        addEventListener() {},
      };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const Bridge = (sandbox.window as { MCPPremiereBridge?: new () => unknown }).MCPPremiereBridge;
  if (typeof Bridge !== 'function') throw new Error('panel did not export MCPPremiereBridge');

  // Prototype only: running the constructor would start timers and touch disk.
  const bridge = Object.create((Bridge as unknown as { prototype: object }).prototype) as Record<
    string,
    any
  >;
  // No constructor runs, so give the instance what the constructor would: a panel-role identity,
  // already holding the run lease. Tests about the lease itself reset these explicitly.
  bridge.role = 'panel';
  bridge.headless = false;
  bridge.instanceId = 'panel-test';
  bridge.active = true;
  bridge.leaseTakenAt = 0;
  bridge.engineState = 'ok';
  bridge.engineStalledAt = null;
  bridge.sentinelInFlight = false;
  bridge.csInterface = new (sandbox.CSInterface as new () => unknown)();
  bridge.normalizeHostEnvironment = (value: unknown) => value;
  bridge.log = () => {};

  return { bridge, handedToEvalScript: () => handed, evalScriptCalls: () => evalCalls, elements };
}
