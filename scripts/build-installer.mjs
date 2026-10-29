#!/usr/bin/env node
/**
 * Build the teammate installer: one zip holding the signed CEP bridge, the UXP helper, and a
 * double-click "Install Premiere MCP.command" that installs both through Adobe's own installer.
 *
 * Signing: a signed .zxp loads without the CEP debug switch (PlayerDebugMode), which is what
 * makes the bridge installable on a Mac nobody has configured. Uses the self-signed certificate
 * from scripts/create-self-signed-zxp-cert.mjs; on macOS its password is read from the Keychain
 * when ZXP_CERT_PASSWORD is not set.
 *
 * Usage: npm run release:installer
 * Env:   ZXP_SIGN_CMD (default: ~/Library/Application Support/premiere-mcp-signing/bin/ZXPSignCmd)
 *        ZXP_CERT_PATH (default: alongside it), ZXP_CERT_PASSWORD (default: Keychain)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const signingDir = join(homedir(), 'Library', 'Application Support', 'premiere-mcp-signing');
const env = { ...process.env };
env.ZXP_SIGN_CMD ||= join(signingDir, 'bin', 'ZXPSignCmd');
env.ZXP_CERT_PATH ||= join(signingDir, 'premiere-mcp-self-signed.p12');
if (!env.ZXP_CERT_PASSWORD && process.platform === 'darwin') {
  try {
    env.ZXP_CERT_PASSWORD = execFileSync('security', ['find-generic-password', '-s', 'premiere-mcp-zxp-signing', '-a', 'certificate-password', '-w'], { encoding: 'utf8' }).trim();
  } catch { /* reported by sign-zxp.mjs */ }
}

const out = join(root, 'release-artifacts');
const stage = join(out, `Premiere MCP Installer v${version}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

env.ZXP_OUTPUT_PATH = join(stage, 'MCPBridgeCEP-signed.zxp');
execFileSync(process.execPath, [join(root, 'scripts', 'sign-zxp.mjs')], { env, stdio: 'inherit' });
execFileSync(process.execPath, [join(root, 'scripts', 'install-uxp-probe.mjs'), '--build'], { stdio: 'inherit' });
copyFileSync(join(root, 'dist-uxp', 'mcp-uxp-probe.ccx'), join(stage, 'mcp-uxp-probe.ccx'));
copyFileSync(join(root, 'scripts', 'installer', 'Install Premiere MCP.command'), join(stage, 'Install Premiere MCP.command'));
writeFileSync(join(stage, 'README.txt'), [
  `Premiere MCP plugins v${version}`,
  '',
  '1. Quit Premiere Pro.',
  '2. Double-click "Install Premiere MCP.command".',
  '   The first time, macOS may say it cannot verify the developer. If so, right-click the',
  '   file, choose Open, then Open again.',
  '3. Start Premiere Pro. Nothing needs to be opened: the bridge runs in the background.',
  '',
  'The MCP server itself installs separately: double-click premiere-mcp-' + version + '.mcpb for',
  'Claude Desktop, or see the README on GitHub for Claude Code and other clients.',
  '',
].join('\n'));

// The same two signed plugins ship inside the npm package, for `premiere-mcp setup`.
const npmInstaller = join(root, 'installer');
mkdirSync(npmInstaller, { recursive: true });
for (const f of ['MCPBridgeCEP-signed.zxp', 'mcp-uxp-probe.ccx']) copyFileSync(join(stage, f), join(npmInstaller, f));

const zip = join(out, `Premiere-MCP-Installer-v${version}.zip`);
rmSync(zip, { force: true });
// ditto keeps the .command's executable bit, which a plain zip may drop.
execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', stage, zip], { stdio: 'inherit' });
if (!existsSync(zip)) throw new Error('installer zip was not written');
console.log(`installer: ${zip}`);
