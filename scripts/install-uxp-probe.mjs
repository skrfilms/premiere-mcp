#!/usr/bin/env node
/**
 * Build uxp-probe/ into a .ccx and install it through Adobe's Unified Plugin Installer Agent, the
 * same installer Creative Cloud uses for a double-clicked .ccx. No UXP Developer Tools and no
 * Premiere developer mode are needed. Premiere loads the panel on its next launch.
 *
 * Usage: npm run uxp:install            (build + install)
 *        npm run uxp:install -- --build (build dist-uxp/mcp-uxp-probe.ccx only)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'uxp-probe');
const OUT_DIR = join(ROOT, 'dist-uxp');
const CCX = join(OUT_DIR, 'mcp-uxp-probe.ccx');
const UPIA = process.platform === 'win32'
  ? 'C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe'
  : '/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent';

mkdirSync(OUT_DIR, { recursive: true });
rmSync(CCX, { force: true });
// A .ccx is a zip of the plugin folder with the manifest at its root.
const zip = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${SRC}\\*' -DestinationPath '${CCX}.zip'; Move-Item '${CCX}.zip' '${CCX}'`], { stdio: 'inherit' })
  : spawnSync('zip', ['-q', '-X', '-r', CCX, 'manifest.json', 'index.html', 'main.js'], { cwd: SRC, stdio: 'inherit' });
if (zip.status !== 0 || !existsSync(CCX)) {
  console.error('could not build the .ccx');
  process.exit(1);
}
console.log(`built ${CCX}`);
if (process.argv.includes('--build')) process.exit(0);

if (!existsSync(UPIA)) {
  console.error(`Adobe's plugin installer was not found at ${UPIA}. Is Creative Cloud installed? You can also double-click ${CCX}.`);
  process.exit(1);
}
const r = spawnSync(UPIA, ['--install', CCX], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0 || !/Successful/i.test(r.stdout || '')) {
  console.error('install failed');
  process.exit(1);
}
console.log('installed. Restart Premiere Pro, then open Window > UXP Plugins > MCP UXP Probe.');
