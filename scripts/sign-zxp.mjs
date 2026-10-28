import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const zxpSignCommand = process.env.ZXP_SIGN_CMD;
const certificatePath = process.env.ZXP_CERT_PATH;
const certificatePassword = process.env.ZXP_CERT_PASSWORD;
const outputPath = process.env.ZXP_OUTPUT_PATH || join(root, 'release-artifacts', `MCPBridgeCEP-v${packageJson.version}-self-signed.zxp`);

if (!zxpSignCommand || !existsSync(zxpSignCommand)) {
  throw new Error('Set ZXP_SIGN_CMD to the Adobe ZXPSignCmd executable.');
}
if (!certificatePath || !existsSync(certificatePath)) {
  throw new Error('Set ZXP_CERT_PATH to a private PKCS#12 (.p12) certificate.');
}
if (!certificatePassword) {
  throw new Error('Set ZXP_CERT_PASSWORD. Do not commit certificate passwords or certificate files.');
}

await mkdir(dirname(outputPath), { recursive: true });
await rm(outputPath, { force: true });
// Sign only what the panel runs. cep-plugin/ also holds design mockups (_design/), which have no
// business in an installed extension.
const RUNTIME = ['CSXS', 'index.html', 'background.html', 'bridge-cep.js', 'CSInterface.js'];
const stage = join(tmpdir(), `premiere-mcp-zxp-${process.pid}`);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const entry of RUNTIME) await cp(join(root, 'cep-plugin', entry), join(stage, entry), { recursive: true });
execFileSync(zxpSignCommand, [
  '-sign',
  stage,
  outputPath,
  certificatePath,
  certificatePassword,
], { stdio: 'inherit' });
await rm(stage, { recursive: true, force: true });
await chmod(outputPath, 0o644);
execFileSync(zxpSignCommand, ['-verify', outputPath], { stdio: 'inherit' });
console.log(`Signed ZXP created: ${outputPath}`);
