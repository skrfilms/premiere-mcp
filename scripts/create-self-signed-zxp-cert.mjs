import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

if (process.platform !== 'darwin') {
  throw new Error('Create the certificate on the target platform. This helper currently supports macOS only.');
}

const zxpSignCommand = process.env.ZXP_SIGN_CMD;
if (!zxpSignCommand) throw new Error('Set ZXP_SIGN_CMD to the Adobe ZXPSignCmd executable.');

const certificatePath = process.env.ZXP_CERT_PATH || join(homedir(), 'Library', 'Application Support', 'premiere-mcp-signing', 'premiere-mcp-self-signed.p12');
const service = 'premiere-mcp-zxp-signing';
const account = 'certificate-password';
const password = randomBytes(32).toString('base64url');

await mkdir(dirname(certificatePath), { recursive: true });
execFileSync(zxpSignCommand, [
  // Subject: the publisher Premiere shows when the panel is installed. Override per fork.
  '-selfSignedCert', 'US', 'CA', process.env.ZXP_CERT_ORG || 'Skry', process.env.ZXP_CERT_NAME || 'Premiere MCP', password, certificatePath,
  '-validityDays', '3650'
], { stdio: 'inherit' });
await chmod(certificatePath, 0o600);
execFileSync('security', ['add-generic-password', '-U', '-a', account, '-s', service, '-w', password], { stdio: 'ignore' });
console.log(`Self-signed certificate stored at ${certificatePath}`);
console.log(`Password stored in the macOS Keychain service ${service}.`);
