#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nextSteps, printResults, runDoctor, runSetup } from './setup/setup.js';
import { PACKAGE_VERSION } from './version.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(packageRoot, 'dist', 'index.js');

function printHelp(): void {
  console.log(`Premiere Pro MCP

Usage:
  premiere-mcp                 Start the MCP stdio server
  premiere-mcp setup           Install the signed Premiere plugins and add this server to every
                               AI app found (Claude Desktop, Claude Code, Codex, Cursor, VS Code)
      --dry-run                  show what would change, change nothing
      --clients a,b              only these apps (claude-desktop, claude-code, codex, cursor, vscode)
      --skip-plugins / --skip-clients
      --unsigned                 old route: hand-copy the unsigned panel (turns on CEP debug mode)
  premiere-mcp doctor          Check Node, the installed bridge, Premiere's heartbeat and each app
  premiere-mcp --version       Print the installed package version
  premiere-mcp --help          Show this help
`);
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function runPlatformScript(
  macScript: string,
  windowsScript: string,
  windowsArgs: string[] = [],
): Promise<void> {
  let code: number;
  if (process.platform === 'darwin') {
    code = await run('bash', [join(packageRoot, 'scripts', macScript), '--skip-build']);
  } else if (process.platform === 'win32') {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(packageRoot, 'scripts', windowsScript),
      ...windowsArgs,
    ];
    // PowerShell 7 first, Windows PowerShell 5.1 as the fallback. 5.1 ships with every
    // current Windows but is not guaranteed on future images, and pwsh is what a builder
    // who installed PowerShell deliberately expects to run.
    //
    // The fallback is keyed on spawn's own error rather than on an exit code, and that
    // distinction is what makes retrying safe: ENOENT means the executable was never
    // launched, so the script cannot have run once already. A non-zero EXIT code is a
    // script that DID run and failed; that is returned as-is and never retried.
    try {
      code = await run('pwsh', args);
    } catch {
      code = await run('powershell.exe', args);
    }
  } else {
    throw new Error('Premiere Pro MCP setup is supported on macOS and Windows only.');
  }

  if (code !== 0) process.exitCode = code;
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case 'serve':
      process.exitCode = await run(process.execPath, [serverEntry]);
      return;
    case '--install-cep':
    case 'install-cep':
    case 'setup':
    case '--setup': {
      const flags = process.argv.slice(3);
      if (flags.includes('--unsigned')) {
        await runPlatformScript('install-macos.sh', 'install-windows.ps1', ['-SkipBuild']);
        return;
      }
      const clientsAt = flags.indexOf('--clients');
      const { results } = runSetup(packageRoot, PACKAGE_VERSION, {
        dryRun: flags.includes('--dry-run'),
        skipPlugins: flags.includes('--skip-plugins'),
        skipClients: flags.includes('--skip-clients'),
        clients:
          clientsAt >= 0
            ? String(flags[clientsAt + 1] ?? '')
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean)
            : undefined,
      });
      const ok = printResults(
        `Premiere MCP ${PACKAGE_VERSION} setup${flags.includes('--dry-run') ? ' (dry run: nothing changed)' : ''}`,
        results,
      );
      console.log(nextSteps(packageRoot));
      if (!ok) process.exitCode = 1;
      return;
    }
    case '--doctor':
    case 'doctor': {
      const ok = printResults(`Premiere MCP ${PACKAGE_VERSION} doctor`, runDoctor(packageRoot));
      if (!ok) process.exitCode = 1;
      return;
    }
    case '--version':
    case '-v': {
      const packageJson = await import('../package.json', { with: { type: 'json' } });
      console.log(packageJson.default.version);
      return;
    }
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
