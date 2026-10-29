/**
 * `premiere-mcp setup` and `premiere-mcp doctor`: one command from nothing to a working install.
 *
 * Modelled on how the best-installed MCPs do it (Blender's `uvx mcp-for-blender setup`, Resolve's
 * `npx davinci-resolve-mcp setup`): find the AI apps on this machine, add this server to each
 * (backing up any file it edits), install the Premiere plugins, then say what to do next. No
 * prompts, so an agent can run it; `--dry-run` shows the plan without changing anything.
 *
 * The Premiere side goes through Adobe's own plugin installer (the one Creative Cloud uses) with
 * the signed bridge bundled in the package, so no developer-mode setting is needed and the bridge
 * runs in the background with no panel open.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultBridgeDir } from '../utils/scratch-paths.js';

export const SERVER_NAME = 'premiere-pro';

export interface Launch { command: string; args: string[]; env: Record<string, string> }
export interface Env { platform: NodeJS.Platform; home: string; appData?: string | undefined; programFiles?: string | undefined; commonProgramFiles?: string | undefined; temp?: string | undefined }

export function currentEnv(): Env {
  return { platform: process.platform, home: homedir(), appData: process.env.APPDATA, programFiles: process.env.ProgramFiles, commonProgramFiles: process.env.CommonProgramFiles, temp: process.env.TEMP || process.env.TMP };
}

/** The bridge folder both sides agree on: the panel's saved choice, else the platform default. */
export function sharedBridgeDir(env: Env): string {
  try {
    const cfg = JSON.parse(readFileSync(join(env.home, '.premiere-mcp-bridge', 'config.json'), 'utf8'));
    if (typeof cfg.tempDirectory === 'string' && cfg.tempDirectory.trim()) return cfg.tempDirectory.trim();
  } catch { /* no saved choice */ }
  return defaultBridgeDir(env.platform, { TEMP: env.temp });
}

/**
 * How AI apps should start this server. Run through npx, the package lives in a cache that can be
 * cleared, so the apps get a pinned `npx -y premiere-mcp@<version>`; installed globally or from a
 * clone, they get this exact node and entry point, which keeps working with no PATH lookups.
 */
export function launchFor(packageRoot: string, version: string, nodePath: string, bridge: string): Launch {
  const env = { PREMIERE_TEMP_DIR: bridge };
  if (/[\\/]_npx[\\/]/.test(packageRoot)) return { command: 'npx', args: ['-y', `premiere-mcp@${version}`], env };
  return { command: nodePath, args: [join(packageRoot, 'dist', 'index.js')], env };
}

// ---------------------------------------------------------------------------------- AI apps

export interface ClientTarget { id: string; label: string; kind: 'json' | 'cli'; path?: string; key?: 'mcpServers' | 'servers'; cli?: string }

const onPath = (bin: string, platform: NodeJS.Platform): boolean =>
  spawnSync(platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;

/** AI apps found on this machine. An app counts as present when its config folder or CLI exists. */
export function detectClients(env: Env, hasCli: (bin: string) => boolean = (b) => onPath(b, env.platform)): ClientTarget[] {
  const mac = env.platform === 'darwin';
  const appSupport = mac ? join(env.home, 'Library', 'Application Support') : env.appData;
  const out: ClientTarget[] = [];
  if (appSupport && existsSync(join(appSupport, 'Claude'))) out.push({ id: 'claude-desktop', label: 'Claude Desktop', kind: 'json', path: join(appSupport, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers' });
  if (hasCli('claude')) out.push({ id: 'claude-code', label: 'Claude Code', kind: 'cli', cli: 'claude' });
  if (hasCli('codex')) out.push({ id: 'codex', label: 'Codex', kind: 'cli', cli: 'codex' });
  if (existsSync(join(env.home, '.cursor'))) out.push({ id: 'cursor', label: 'Cursor', kind: 'json', path: join(env.home, '.cursor', 'mcp.json'), key: 'mcpServers' });
  if (appSupport && existsSync(join(appSupport, 'Code', 'User'))) out.push({ id: 'vscode', label: 'VS Code', kind: 'json', path: join(appSupport, 'Code', 'User', 'mcp.json'), key: 'servers' });
  return out;
}

/** The config file with this server's entry added or replaced, other servers untouched. */
export function mergeServerEntry(existing: string | null, key: 'mcpServers' | 'servers', launch: Launch): string {
  let data: any = {};
  if (existing && existing.trim()) {
    data = JSON.parse(existing);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the file is not a JSON object');
  }
  if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) data[key] = {};
  data[key][SERVER_NAME] = { ...(key === 'servers' ? { type: 'stdio' } : {}), command: launch.command, args: launch.args, env: launch.env };
  return JSON.stringify(data, null, 2) + '\n';
}

export interface StepResult { step: string; ok: boolean; detail: string }

function configureClient(c: ClientTarget, launch: Launch, dryRun: boolean): StepResult {
  const step = `Add to ${c.label}`;
  if (c.kind === 'json') {
    const file = c.path!;
    let before: string | null = null;
    try { before = readFileSync(file, 'utf8'); } catch { /* new file */ }
    let next: string;
    try { next = mergeServerEntry(before, c.key!, launch); } catch (e: any) { return { step, ok: false, detail: `${file} could not be read as JSON (${e.message}); left unchanged. Add the entry by hand.` }; }
    if (dryRun) return { step, ok: true, detail: `would write ${file}` };
    mkdirSync(dirname(file), { recursive: true });
    let backup = '';
    if (before !== null) { backup = `${file}.bak-${stamp()}`; copyFileSync(file, backup); }
    writeFileSync(file, next, 'utf8');
    return { step, ok: true, detail: `${file}${backup ? ` (backup: ${backup})` : ''}` };
  }
  const envArgs = (flag: string) => Object.entries(launch.env).flatMap(([k, v]) => [flag, `${k}=${v}`]);
  const cmd = c.cli === 'claude'
    ? ['mcp', 'add', '--scope', 'user', SERVER_NAME, ...envArgs('-e'), '--', launch.command, ...launch.args]
    : ['mcp', 'add', SERVER_NAME, ...envArgs('--env'), '--', launch.command, ...launch.args];
  if (dryRun) return { step, ok: true, detail: `would run: ${c.cli} ${cmd.join(' ')}` };
  // On Windows the CLIs are .cmd shims, which need a shell; the shell joins arguments with
  // spaces, so quote any that contain one (C:\Program Files\nodejs\node.exe).
  const win = process.platform === 'win32';
  const quote = (a: string) => (win && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  // Replace an earlier entry of ours rather than failing on the duplicate name.
  spawnSync(c.cli!, c.cli === 'claude' ? ['mcp', 'remove', '--scope', 'user', SERVER_NAME] : ['mcp', 'remove', SERVER_NAME], { stdio: 'ignore', shell: win });
  const r = spawnSync(c.cli!, cmd.map(quote), { encoding: 'utf8', shell: win });
  return r.status === 0
    ? { step, ok: true, detail: `${c.cli} mcp add (user scope)` }
    : { step, ok: false, detail: `${c.cli} mcp add failed: ${String(r.stderr || r.stdout || r.error || '').trim().slice(0, 300)}` };
}

// ---------------------------------------------------------------------------------- Premiere plugins

export function pluginInstallerPath(env: Env): string | null {
  const p = env.platform === 'darwin'
    ? '/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent'
    : env.platform === 'win32'
      ? join(env.commonProgramFiles || 'C:\\Program Files\\Common Files', 'Adobe', 'Adobe Desktop Common', 'RemoteComponents', 'UPI', 'UnifiedPluginInstallerAgent', 'UnifiedPluginInstallerAgent.exe')
      : null;
  return p && existsSync(p) ? p : null;
}

/** Where a hand-copied (unsigned, developer-mode) bridge lives; it clashes with the signed one. */
export function handCopiedBridge(env: Env): string {
  return env.platform === 'win32'
    ? join(env.appData || join(env.home, 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions', 'MCPBridgeCEP')
    : join(env.home, 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', 'MCPBridgeCEP');
}

export function signedBridgeManifest(env: Env): string {
  return env.platform === 'win32'
    ? join(env.programFiles ? join(dirname(env.programFiles), 'Program Files (x86)') : 'C:\\Program Files (x86)', 'Common Files', 'Adobe', 'CEP', 'extensions', 'MCP Bridge (CEP)', 'CSXS', 'manifest.xml')
    : '/Library/Application Support/Adobe/CEP/extensions/MCP Bridge (CEP)/CSXS/manifest.xml';
}

export function installedBridgeVersion(env: Env): string | null {
  try { return /ExtensionBundleVersion="([^"]+)"/.exec(readFileSync(signedBridgeManifest(env), 'utf8'))?.[1] ?? null; } catch { return null; }
}

function installPlugins(env: Env, packageRoot: string, dryRun: boolean): StepResult[] {
  const dir = join(packageRoot, 'installer');
  const files = ['MCPBridgeCEP-signed.zxp', 'mcp-uxp-probe.ccx'].map((f) => join(dir, f));
  const upia = pluginInstallerPath(env);
  if (!files.every((f) => existsSync(f))) {
    return [{ step: 'Install the Premiere plugins', ok: false, detail: `The signed plugins are not in this copy (${dir}). From a clone, run npm run release:installer first, or install the release's Premiere-MCP-Installer zip.` }];
  }
  if (!upia) return [{ step: 'Install the Premiere plugins', ok: false, detail: "Adobe's plugin installer (part of Creative Cloud) was not found. Install Creative Cloud and Premiere Pro, then run setup again." }];
  const out: StepResult[] = [];
  const old = handCopiedBridge(env);
  if (existsSync(old)) {
    const aside = `${old}-replaced-${stamp()}`;
    if (!dryRun) renameSync(old, aside);
    out.push({ step: 'Move an older hand-copied bridge aside', ok: true, detail: dryRun ? `would move ${old}` : `${old} -> ${aside}` });
  }
  for (const f of files) {
    const step = `Install ${f.endsWith('.zxp') ? 'the bridge' : 'the UXP helper'}`;
    if (dryRun) { out.push({ step, ok: true, detail: `would install ${f}` }); continue; }
    const r = spawnSync(upia, [env.platform === 'win32' ? '/install' : '--install', f], { encoding: 'utf8' });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const ok = /successful|already installed/i.test(text);
    out.push({ step, ok, detail: ok ? text.split('\n').pop()!.trim() : `Adobe's installer said: ${text.slice(-300) || String(r.error ?? 'nothing')}` });
  }
  return out;
}

// ---------------------------------------------------------------------------------- setup / doctor

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

export interface SetupOptions { dryRun?: boolean | undefined; clients?: string[] | undefined; skipPlugins?: boolean | undefined; skipClients?: boolean | undefined }

/**
 * A node path that survives upgrades. process.execPath is often a versioned install folder
 * (Homebrew's Cellar/node/26.3.0, nvm's versions/v22.1.0) that disappears on upgrade; the `node`
 * on PATH resolving to the same binary is the stable name for it.
 */
export function stableNodePath(platform: NodeJS.Platform = process.platform): string {
  try {
    const r = spawnSync(platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' });
    const first = String(r.stdout || '').split(/\r?\n/)[0]!.trim();
    if (first && realpathSync(first) === realpathSync(process.execPath)) return first;
  } catch { /* fall back */ }
  return process.execPath;
}

export function runSetup(packageRoot: string, version: string, opts: SetupOptions = {}, env: Env = currentEnv()): { results: StepResult[]; launch: Launch } {
  const bridge = sharedBridgeDir(env);
  const launch = launchFor(packageRoot, version, stableNodePath(env.platform), bridge);
  const results: StepResult[] = [];
  if (!opts.skipPlugins) results.push(...installPlugins(env, packageRoot, !!opts.dryRun));
  if (!opts.skipClients) {
    let clients = detectClients(env);
    if (opts.clients?.length) clients = clients.filter((c) => opts.clients!.includes(c.id));
    if (!clients.length) results.push({ step: 'Add to your AI apps', ok: false, detail: 'No supported AI app found (Claude Desktop, Claude Code, Codex, Cursor, VS Code). Add the server by hand: see the README.' });
    for (const c of clients) results.push(configureClient(c, launch, !!opts.dryRun));
  }
  if (!opts.dryRun) { try { mkdirSync(bridge, { recursive: true }); } catch { /* reported by doctor */ } }
  return { results, launch };
}

export function runDoctor(packageRoot: string, env: Env = currentEnv()): StepResult[] {
  const out: StepResult[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  out.push({ step: 'Node.js 20 or newer', ok: major >= 20, detail: process.versions.node });
  out.push({ step: 'Server is built', ok: existsSync(join(packageRoot, 'dist', 'index.js')), detail: join(packageRoot, 'dist', 'index.js') });
  const v = installedBridgeVersion(env);
  out.push({ step: 'Signed bridge installed in Premiere', ok: !!v, detail: v ? `version ${v}` : 'not found; run premiere-mcp setup' });
  if (existsSync(handCopiedBridge(env))) out.push({ step: 'No conflicting hand-copied bridge', ok: false, detail: `${handCopiedBridge(env)} clashes with the signed bridge; premiere-mcp setup moves it aside` });
  const bridge = sharedBridgeDir(env);
  let beat: any = null;
  try { beat = JSON.parse(readFileSync(join(bridge, 'bridge-heartbeat.json'), 'utf8')); } catch { /* none */ }
  const age = beat?.ts ? Math.round((Date.now() - Number(beat.ts)) / 1000) : null;
  out.push({ step: 'Premiere is running with the bridge on', ok: age !== null && age < 30, detail: age === null ? `no heartbeat in ${bridge}; start Premiere Pro (the bridge starts with it)` : age < 30 ? `heartbeat ${age}s ago, engine ${beat.engine ?? 'ok'}` : `last heartbeat ${age}s ago: Premiere is closed or the bridge stopped` });
  const clients = detectClients(env);
  for (const c of clients) {
    let ok = false;
    if (c.kind === 'json') { try { ok = !!JSON.parse(readFileSync(c.path!, 'utf8'))?.[c.key!]?.[SERVER_NAME]; } catch { /* missing */ } }
    else {
      // `mcp get` names the scope and the command, and works from any folder (`mcp list` depends
      // on the current project).
      const r = spawnSync(c.cli!, ['mcp', 'get', SERVER_NAME], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 20000 });
      const text = `${r.stdout ?? ''}`;
      ok = r.status === 0 && /dist[\\/]index\.js|premiere-mcp/.test(text);
      const scope = /Scope:\s*(.+)/.exec(text)?.[1]?.trim();
      out.push({ step: `${c.label} has the server`, ok, detail: ok ? `configured${scope ? ` (${scope})` : ''}` : 'not configured; run setup' });
      continue;
    }
    out.push({ step: `${c.label} has the server`, ok, detail: ok ? 'configured' : 'not configured; run setup' });
  }
  return out;
}

export function printResults(title: string, results: StepResult[]): boolean {
  console.log(title);
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.step}${r.detail ? ` — ${r.detail}` : ''}`);
  return results.every((r) => r.ok);
}

/** What to do after setup. `doctor` is the command that reaches this same copy. */
export function nextSteps(packageRoot: string): string {
  const doctor = /[\\/]_npx[\\/]/.test(packageRoot) ? 'npx -y premiere-mcp@latest doctor' : `node "${join(packageRoot, 'dist', 'cli.js')}" doctor`;
  return `
Next:
  1. Start Premiere Pro (or restart it if it was open). The bridge starts with it; no panel needs opening.
  2. Restart your AI app so it loads the server (in Claude Code, start a new session).
  3. Ask it: "Run verify_premiere_connection. Make no changes."
Check any time with: ${doctor}`;
}

