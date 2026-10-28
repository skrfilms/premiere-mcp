<#
.SYNOPSIS
    Installs the Premiere Pro MCP server and CEP bridge panel on Windows.

.DESCRIPTION
    Builds the MCP server, installs the CEP bridge into the per-user Adobe CEP
    extensions folder, enables CEP debug mode in the registry, creates the bridge
    temp directory with a restricted ACL, and writes MCP client config for GitHub
    Copilot in VS Code and Claude Desktop.

    HONESTY NOTE: this script was written and reviewed on macOS by mirroring
    scripts/install-macos.sh. It has NOT been executed on Windows. Read a clean run
    as "the steps match the mac installer", not as "the Windows install is verified".
    See docs/WINDOWS-PARITY.md for what remains unverified.

    Two things are deliberately NOT mirrored from macOS, because mirroring them
    would be wrong:

    1. The temp directory ACL. On macOS the SERVER protects the shared bridge
       directory at runtime with mkdir/chmod 0700, and that genuinely keeps other
       users out. On NTFS a POSIX mode is not stored and Node's chmod only flips the
       read-only attribute, so the server's 0700 is a no-op and auth-token.json
       inherits whatever ACL the directory has. This installer therefore restricts
       the ACL itself -- it is the only place the Windows equivalent can happen.

    2. PlayerDebugMode. macOS uses `defaults write com.adobe.CSXS.N`; Windows uses
       HKCU:\Software\Adobe\CSXS.N with PlayerDebugMode as REG_SZ. CEP reads the
       string "1"; a DWORD 1 is ignored, which is a common way to "enable" debug
       mode and still get no panel.

.PARAMETER TempDir
    Bridge temp directory shared by the MCP server and CEP panel.

.PARAMETER VsCodeConfigPath
    VS Code MCP config used by GitHub Copilot.

.PARAMETER ClaudeConfigPath
    Claude Desktop MCP config path.

.PARAMETER SkipBuild
    Skip npm install and npm run build. Useful for CI after build has already run.

.PARAMETER SkipCopilotConfig
    Do not write the VS Code GitHub Copilot MCP config.

.PARAMETER SkipClaudeDesktopConfig
    Do not write Claude Desktop MCP config.

.PARAMETER SkipAdobeDebugMode
    Do not write Adobe CEP PlayerDebugMode registry values.

.PARAMETER SkipTempDirAcl
    Do not restrict the bridge temp directory ACL. Only pass this if a policy
    manages the ACL for you; without it, any interactive account on the machine can
    read the bridge auth token.
#>

[CmdletBinding()]
param(
    # Resolved in the body, not here: a nested if-expression in a parameter default is
    # legal but unparseable at a glance, and this file cannot be executed by its author.
    [string] $TempDir = '',
    [string] $VsCodeConfigPath = (Join-Path $env:APPDATA 'Code\User\mcp.json'),
    [string] $ClaudeConfigPath = (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'),
    [switch] $SkipBuild,
    [switch] $SkipCopilotConfig,
    [switch] $SkipClaudeDesktopConfig,
    [switch] $SkipAdobeDebugMode,
    [switch] $SkipTempDirAcl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# $IsWindows exists only in PowerShell 6+; $env:OS covers Windows PowerShell 5.1.
$onWindows = if (Test-Path variable:IsWindows) { $IsWindows } else { $env:OS -eq 'Windows_NT' }
if (-not $onWindows) {
    throw 'This installer supports Windows only. Use npm run setup:mac on macOS.'
}

# %TEMP%, then %TMP%, then C:\Temp -- matching the CEP panel's own getDefaultTempPath so
# the installed default and the panel's default agree without further configuration.
if ([string]::IsNullOrWhiteSpace($TempDir)) {
    $tempBase = if ($env:TEMP) { $env:TEMP } elseif ($env:TMP) { $env:TMP } else { 'C:\Temp' }
    $TempDir = Join-Path $tempBase 'premiere-mcp-bridge'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$cepExtensionsDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$cepTargetDir = Join-Path $cepExtensionsDir 'MCPBridgeCEP'
$cepSourceDir = Join-Path $repoRoot 'cep-plugin'
$distEntry = Join-Path $repoRoot 'dist\index.js'

function Resolve-CommandPath([string] $Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    return $command.Source
}

function Update-JsonWithNode([string] $ConfigPath, [string] $Mode) {
    $configDir = Split-Path -Parent $ConfigPath
    if (-not (Test-Path -LiteralPath $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $helper = @'
const fs = require("fs");

const configPath = process.env.CONFIG_PATH;
const mode = process.env.CONFIG_MODE;
const nodePath = process.env.NODE_PATH_VALUE;
const distPath = process.env.DIST_PATH;
const tempPath = process.env.TEMP_PATH;

let data = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8").trim();
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error(`${configPath} is not valid JSON: ${error.message}`);
      process.exit(1);
    }
  }
}

if (!data || typeof data !== "object" || Array.isArray(data)) {
  data = {};
}

if (mode === "copilot") {
  if (!data.servers || typeof data.servers !== "object" || Array.isArray(data.servers)) {
    data.servers = {};
  }
  data.servers["premiere-pro"] = {
    type: "stdio",
    command: nodePath,
    args: [distPath],
    env: {
      PREMIERE_TEMP_DIR: tempPath
    }
  };
} else if (mode === "claude") {
  if (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)) {
    data.mcpServers = {};
  }
  data.mcpServers["premiere-pro"] = {
    command: nodePath,
    args: [distPath],
    env: {
      PREMIERE_TEMP_DIR: tempPath
    }
  };
} else {
  console.error(`Unknown config mode: ${mode}`);
  process.exit(1);
}

fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
'@

    $helperPath = Join-Path $env:TEMP 'premiere-mcp-config-update.cjs'
    # Written BOM-free on purpose. Set-Content -Encoding UTF8 emits a BOM on Windows
    # PowerShell 5.1, and -Encoding utf8NoBOM only exists on PowerShell 6+.
    [System.IO.File]::WriteAllText($helperPath, $helper, (New-Object System.Text.UTF8Encoding($false)))

    $oldConfigPath = $env:CONFIG_PATH
    $oldConfigMode = $env:CONFIG_MODE
    $oldNodePathValue = $env:NODE_PATH_VALUE
    $oldDistPath = $env:DIST_PATH
    $oldTempPath = $env:TEMP_PATH
    try {
        $env:CONFIG_PATH = $ConfigPath
        $env:CONFIG_MODE = $Mode
        $env:NODE_PATH_VALUE = $script:nodePath
        $env:DIST_PATH = $distEntry
        $env:TEMP_PATH = $TempDir
        & $script:nodePath $helperPath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to update MCP config: $ConfigPath"
        }
    } finally {
        $env:CONFIG_PATH = $oldConfigPath
        $env:CONFIG_MODE = $oldConfigMode
        $env:NODE_PATH_VALUE = $oldNodePathValue
        $env:DIST_PATH = $oldDistPath
        $env:TEMP_PATH = $oldTempPath
        Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue
    }
}

<#
    Restrict the bridge temp directory to this user, SYSTEM and Administrators.

    This is the Windows stand-in for what `mkdir(mode: 0o700)` + `chmod 0700` do for
    the server on macOS. It is not decoration: anything that can write a
    command-*.json into this directory executes arbitrary ExtendScript inside
    Premiere with full project and filesystem reach, and anything that can READ it
    gets the per-session auth token, which is the only thing standing in front of
    that. Inheritance is switched off first, because a directory under %TEMP%
    otherwise inherits whatever the parent grants.

    A failure here warns rather than aborts: an install that works but is no better
    protected than the surrounding %TEMP% is more useful than no install, provided
    the user is told. The doctor re-checks this every run.
#>
function Set-BridgeDirectoryAcl([string] $Path) {
    try {
        $acl = Get-Acl -LiteralPath $Path

        # $true = protect from inheritance, $false = do NOT copy the inherited ACEs in.
        $acl.SetAccessRuleProtection($true, $false)

        # Wipe whatever explicit ACEs are already there so the result is exactly the
        # three identities below and nothing that predates this run.
        foreach ($existing in @($acl.Access)) {
            [void]$acl.RemoveAccessRuleAll($existing)
        }

        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')          # NT AUTHORITY\SYSTEM
        $administrators = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544') # BUILTIN\Administrators
        $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        foreach ($sid in @($me, $system, $administrators)) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                $inherit,
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }

        Set-Acl -LiteralPath $Path -AclObject $acl

        # Read it back. An ACL you set and did not verify is a claim, not a control.
        $verify = Get-Acl -LiteralPath $Path
        $broadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4', 'S-1-5-7')
        $stillBroad = New-Object System.Collections.Generic.List[string]
        foreach ($ace in $verify.Access) {
            if ($ace.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
            $sid = $null
            try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = $null }
            if ($sid -and $broadSids -contains $sid) { $stillBroad.Add("$($ace.IdentityReference.Value)") }
        }
        if ($stillBroad.Count -gt 0) {
            Write-Warning "Restricted the ACL on $Path but it still grants $($stillBroad -join ', '). The bridge auth token is readable by those accounts."
        } else {
            Write-Host "  Restricted $Path to $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name), SYSTEM and Administrators."
        }
    } catch {
        Write-Warning ("Could not restrict the ACL on $Path ($($_.Exception.Message)). The bridge auth token in that directory is only as " +
                       'protected as the surrounding %TEMP%. The server writes it with mode 0600, but a POSIX mode is not enforced on NTFS, so ' +
                       'that mode guarantees nothing here. Restrict the folder by hand or re-run elevated.')
    }
}

$script:nodePath = Resolve-CommandPath 'node'
if (-not $script:nodePath) {
    throw "Node.js 20+ is required but 'node' was not found on PATH."
}

$nodeMajor = [int](& $script:nodePath -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
    throw "Node.js 20+ is required. Found: $(& $script:nodePath -v)"
}

$npmPath = Resolve-CommandPath 'npm.cmd'
if (-not $npmPath) { $npmPath = Resolve-CommandPath 'npm' }
if (-not $npmPath) {
    throw "npm was not found on PATH."
}

if ($SkipBuild) {
    Write-Host 'Skipping npm install/build (-SkipBuild).'
} else {
    Write-Host 'Installing npm dependencies...'
    & $npmPath install --prefix $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }

    Write-Host 'Building MCP server...'
    & $npmPath run build --prefix $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
}

if (-not (Test-Path -LiteralPath $distEntry -PathType Leaf)) {
    throw "Built entrypoint not found: $distEntry"
}

if ($SkipAdobeDebugMode) {
    Write-Host 'Skipping Adobe CEP debug mode (-SkipAdobeDebugMode).'
} else {
    Write-Host 'Enabling Adobe CEP debug mode...'
    # 9..15 covers CSXS.11 and CSXS.12, which Premiere 26.x uses, plus older and
    # newer hosts. PropertyType String is required: CEP reads REG_SZ "1" and ignores
    # a DWORD, so a DWORD here would look enabled in regedit and load no panel.
    $enabled = New-Object System.Collections.Generic.List[string]
    foreach ($version in 9..15) {
        $key = "HKCU:\Software\Adobe\CSXS.$version"
        try {
            if (-not (Test-Path -LiteralPath $key)) {
                New-Item -Path $key -Force | Out-Null
            }
            New-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
            $readback = (Get-ItemProperty -LiteralPath $key -Name 'PlayerDebugMode' -ErrorAction SilentlyContinue).PlayerDebugMode
            if ("$readback".Trim() -eq '1') { $enabled.Add("$version") }
        } catch {
            Write-Warning "Could not set PlayerDebugMode for CSXS.$version ($($_.Exception.Message))."
        }
    }
    if ($enabled.Count -gt 0) {
        Write-Host "  PlayerDebugMode=1 confirmed for CSXS.$($enabled -join ',')"
    } else {
        Write-Warning 'PlayerDebugMode could not be confirmed for any CSXS version. Unsigned CEP panels will not load.'
    }
}

Write-Host 'Installing Premiere CEP extension...'
if (-not (Test-Path -LiteralPath $cepSourceDir -PathType Container)) {
    throw "CEP plugin source not found: $cepSourceDir"
}
if (-not (Test-Path -LiteralPath $cepExtensionsDir)) {
    New-Item -ItemType Directory -Path $cepExtensionsDir -Force | Out-Null
}
if (Test-Path -LiteralPath $cepTargetDir) {
    Remove-Item -LiteralPath $cepTargetDir -Recurse -Force
}
# Create the target first and copy the CONTENTS. `Copy-Item -Path <dir> -Destination
# <missing dir> -Recurse` has flattened subdirectories on some PowerShell versions,
# which leaves the folder in place with CSXS\manifest.xml missing -- and Premiere
# then shows no panel and reports nothing anywhere.
New-Item -ItemType Directory -Path $cepTargetDir -Force | Out-Null
Copy-Item -Path (Join-Path $cepSourceDir '*') -Destination $cepTargetDir -Recurse -Force
foreach ($required in @('CSXS\manifest.xml', 'index.html', 'background.html', 'bridge-cep.js')) {
    $probe = Join-Path $cepTargetDir $required
    if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) {
        throw "CEP extension copy is incomplete: $probe is missing after the copy."
    }
}
Write-Host "  Installed to $cepTargetDir (CSXS\manifest.xml verified)."

Write-Host "Preparing bridge temp directory: $TempDir"
if (-not (Test-Path -LiteralPath $TempDir)) {
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
}
if ($SkipTempDirAcl) {
    Write-Warning 'Skipping the bridge temp directory ACL (-SkipTempDirAcl). Any interactive account on this machine can read the bridge auth token.'
} else {
    Set-BridgeDirectoryAcl $TempDir
}

if ($SkipCopilotConfig) {
    Write-Host 'Skipping GitHub Copilot VS Code MCP config (-SkipCopilotConfig).'
} else {
    Write-Host "Updating GitHub Copilot VS Code MCP config: $VsCodeConfigPath"
    Update-JsonWithNode -ConfigPath $VsCodeConfigPath -Mode 'copilot'
}

if ($SkipClaudeDesktopConfig) {
    Write-Host 'Skipping Claude Desktop MCP config (-SkipClaudeDesktopConfig).'
} else {
    Write-Host "Updating Claude Desktop MCP config: $ClaudeConfigPath"
    Update-JsonWithNode -ConfigPath $ClaudeConfigPath -Mode 'claude'
}

Write-Host ''
Write-Host 'Install complete.'
Write-Host 'Next:'
Write-Host '1. Restart VS Code and/or Claude Desktop so MCP config is reloaded.'
Write-Host '2. Restart Premiere Pro.'
Write-Host '3. Open Window > Extensions > MCP Bridge (CEP).'
Write-Host "4. Set Temp Directory to EXACTLY this path: $TempDir"
Write-Host '   The panel derives its own default from %TEMP% as seen by Premiere, which is not'
Write-Host '   always the %TEMP% this shell sees. If the two disagree, the server writes commands'
Write-Host '   where the panel never polls and every tool call times out with a healthy-looking'
Write-Host '   panel. Type the path above in rather than trusting the default.'
Write-Host '5. Click Save Configuration, Start Bridge, then Test Connection.'
Write-Host '6. Run: npm run setup:doctor:win'
Write-Host ''
Write-Host 'Manual MCP entry:'
Write-Host "  command: $script:nodePath"
Write-Host "  args:    $distEntry"
Write-Host "  env:     PREMIERE_TEMP_DIR=$TempDir"
