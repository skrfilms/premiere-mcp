import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const outputDirectory = join(root, 'release-artifacts');
const stagingDirectory = join(root, '.mcpb-staging');
const serverDirectory = join(stagingDirectory, 'server');
const outputPath = join(outputDirectory, `premiere-mcp-${packageJson.version}.mcpb`);

const manifest = {
  manifest_version: '0.3',
  name: 'premiere-mcp',
  display_name: 'Premiere MCP',
  version: packageJson.version,
  description: 'Control Adobe Premiere Pro through MCP using the included CEP bridge.',
  long_description: 'A local MCP server for Adobe Premiere Pro. On first launch the bundle installs its CEP bridge for the current user. Restart Premiere Pro, open Window > Extensions > MCP Bridge (CEP), and start the bridge before requesting edits.',
  author: {
    name: 'Skry',
    url: 'https://github.com/skrfilms/premiere-mcp'
  },
  repository: {
    type: 'git',
    url: 'https://github.com/skrfilms/premiere-mcp.git'
  },
  documentation: 'https://github.com/skrfilms/premiere-mcp#install',
  support: 'https://github.com/skrfilms/premiere-mcp/issues',
  server: {
    type: 'node',
    entry_point: 'server/launcher.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/launcher.js']
    }
  },
  tools_generated: true,
  keywords: ['adobe', 'premiere-pro', 'video-editing', 'mcp', 'ai'],
  license: 'MIT',
  compatibility: {
    platforms: ['darwin', 'win32'],
    runtimes: { node: '>=20.0.0' }
  }
};

const launcher = `import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { currentEnv, handCopiedBridge, installedBridgeVersion, pluginInstallerPath, runSetup, sharedBridgeDir } from './dist/setup/setup.js';
import { PACKAGE_VERSION } from './dist/version.js';

const root = dirname(fileURLToPath(import.meta.url));
const env = currentEnv();
const tempDirectory = process.env.PREMIERE_TEMP_DIR || sharedBridgeDir(env);

// Premiere side, first launch only. The signed bridge goes through Adobe's own installer (no
// developer mode); an already-installed signed bridge is left alone, because a hand copy next to
// it has the same id and clashes. The unsigned hand copy is the fallback for a bundle built
// without the signed plugins, or a machine without Creative Cloud's installer.
function ensureBridge() {
  if (installedBridgeVersion(env)) return;
  const signed = existsSync(join(root, 'installer', 'MCPBridgeCEP-signed.zxp'));
  if (signed && pluginInstallerPath(env)) {
    const { results } = runSetup(root, PACKAGE_VERSION, { skipClients: true });
    for (const r of results) if (!r.ok) process.stderr.write('Premiere MCP setup: ' + r.step + ': ' + r.detail + '\\n');
    return;
  }
  const target = handCopiedBridge(env);
  if (existsSync(target)) return;
  if (process.platform === 'darwin') {
    for (let version = 9; version <= 15; version += 1) spawnSync('defaults', ['write', 'com.adobe.CSXS.' + version, 'PlayerDebugMode', '-bool', 'true'], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    for (let version = 9; version <= 15; version += 1) spawnSync('reg.exe', ['add', 'HKCU\\\\Software\\\\Adobe\\\\CSXS.' + version, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f'], { stdio: 'ignore' });
  } else {
    throw new Error('Adobe Premiere Pro MCP supports macOS and Windows only.');
  }
  cpSync(join(root, 'cep-plugin'), target, { recursive: true, force: true, filter: (p) => !p.includes('_design') });
}

try {
  ensureBridge();
  mkdirSync(tempDirectory, { recursive: true });
} catch (error) {
  process.stderr.write('Premiere Pro MCP setup failed: ' + (error instanceof Error ? error.message : String(error)) + '\\n');
}

const server = spawn(process.execPath, [join(root, 'dist', 'index.js')], {
  stdio: 'inherit',
  env: { ...process.env, PREMIERE_TEMP_DIR: tempDirectory }
});
server.on('error', (error) => {
  process.stderr.write('Premiere Pro MCP failed to start: ' + error.message + '\\n');
  process.exit(1);
});
server.on('exit', (code) => process.exit(code ?? 1));
`;

await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(serverDirectory, { recursive: true });
await cp(join(root, 'dist'), join(serverDirectory, 'dist'), { recursive: true, filter: (p) => !p.includes('__tests__') && !p.endsWith('.tsbuildinfo') });
await cp(join(root, 'cep-plugin'), join(serverDirectory, 'cep-plugin'), { recursive: true, filter: (p) => !p.includes('_design') });
// The signed plugins, when this machine can build them (npm run release:installer); without them
// the bundle falls back to the unsigned hand copy.
if (existsSync(join(root, 'installer', 'MCPBridgeCEP-signed.zxp'))) await cp(join(root, 'installer'), join(serverDirectory, 'installer'), { recursive: true });
await cp(join(root, 'package.json'), join(serverDirectory, 'package.json'));
await cp(join(root, 'package-lock.json'), join(serverDirectory, 'package-lock.json'));
await writeFile(join(serverDirectory, 'launcher.js'), launcher);
await writeFile(join(stagingDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

await execFileAsync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--prefix', serverDirectory], {
  cwd: root,
  maxBuffer: 1024 * 1024
});
await mkdir(outputDirectory, { recursive: true });
await execFileAsync('npx', ['mcpb', 'validate', stagingDirectory], { cwd: root, maxBuffer: 1024 * 1024 });
await execFileAsync('npx', ['mcpb', 'pack', stagingDirectory, outputPath], { cwd: root, maxBuffer: 1024 * 1024 });
await execFileAsync('npx', ['mcpb', 'info', outputPath], { cwd: root, maxBuffer: 1024 * 1024 });

console.log(`MCPB bundle created: ${outputPath}`);
