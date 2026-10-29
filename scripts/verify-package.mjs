import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const requiredPaths = [
  'dist/index.js',
  'dist/cli.js',
  'cep-plugin/CSXS/manifest.xml',
  'cep-plugin/bridge-cep.js',
  'cep-plugin/background.html',
  'scripts/install-macos.sh',
  'scripts/install-windows.ps1',
  'scripts/doctor-macos.sh',
  'scripts/doctor-windows.ps1',
  'README.md',
  'LICENSE.md',
];

// Publishing: setup installs the signed plugins from the package, so a release without them
// would install a server that can never reach Premiere. `npm run release:installer` builds them.
if (process.argv.includes('--release')) requiredPaths.push('installer/MCPBridgeCEP-signed.zxp', 'installer/mcp-uxp-probe.ccx');

const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], { maxBuffer: 1024 * 1024 });
const [pack] = JSON.parse(stdout);
const packagedPaths = new Set(pack.files.map((file) => file.path));
const missing = requiredPaths.filter((path) => !packagedPaths.has(path));

if (missing.length > 0) {
  console.error(`npm package is missing required files: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`npm package verified: ${pack.name}@${pack.version} (${pack.files.length} files)`);
