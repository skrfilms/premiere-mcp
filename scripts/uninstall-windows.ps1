<#
.SYNOPSIS
    Removes the Premiere Pro MCP CEP bridge panel and client config on Windows.

.DESCRIPTION
    The Windows counterpart of scripts/uninstall-macos.sh, which had no Windows
    equivalent at all -- so a Windows user who ran the installer had no supported way
    to undo it.

    Mirrors the mac uninstaller: removes the CEP extension, removes the bridge temp
    directory, and deletes the premiere-pro entry from MCP client configs. Adobe CEP
    debug mode is deliberately LEFT enabled, exactly as on macOS, because other CEP
    plugins depend on it.

    HONESTY NOTE: written and reviewed on macOS by mirroring the mac uninstaller.
    Not executed on Windows.

.PARAMETER TempDir
    Bridge temp directory to remove.

.PARAMETER VsCodeConfigPath
    VS Code MCP config used by GitHub Copilot.

.PARAMETER ClaudeConfigPath
    Claude Desktop MCP config path.

.PARAMETER KeepTempDir
    Leave the bridge temp directory in place.
#>

[CmdletBinding()]
param(
    # Resolved in the body, not here: a nested if-expression in a parameter default is
    # legal but unparseable at a glance, and this file cannot be executed by its author.
    [string] $TempDir = '',
    [string] $VsCodeConfigPath = (Join-Path $env:APPDATA 'Code\User\mcp.json'),
    [string] $ClaudeConfigPath = (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'),
    [switch] $KeepTempDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$onWindows = if (Test-Path variable:IsWindows) { $IsWindows } else { $env:OS -eq 'Windows_NT' }
if (-not $onWindows) {
    throw 'This uninstaller supports Windows only. Use npm run uninstall:mac on macOS.'
}

if ([string]::IsNullOrWhiteSpace($TempDir)) {
    if ($env:PREMIERE_TEMP_DIR) {
        $TempDir = $env:PREMIERE_TEMP_DIR
    } else {
        $tempBase = if ($env:TEMP) { $env:TEMP } elseif ($env:TMP) { $env:TMP } else { 'C:\Temp' }
        $TempDir = Join-Path $tempBase 'premiere-mcp-bridge'
    }
}

$cepTargetDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions\MCPBridgeCEP'

Write-Host 'Removing Premiere CEP extension...'
if (Test-Path -LiteralPath $cepTargetDir) {
    Remove-Item -LiteralPath $cepTargetDir -Recurse -Force
    Write-Host "  Removed $cepTargetDir"
} else {
    Write-Host "  Not present: $cepTargetDir"
}

if ($KeepTempDir) {
    Write-Host "Leaving bridge temp directory in place (-KeepTempDir): $TempDir"
} else {
    Write-Host 'Removing bridge temp directory...'
    if (Test-Path -LiteralPath $TempDir) {
        # Contains auth-token.json and any leftover command-*.json. A stale command
        # file executes the moment a panel next starts, so leaving these behind is
        # not merely untidy.
        Remove-Item -LiteralPath $TempDir -Recurse -Force
        Write-Host "  Removed $TempDir"
    } else {
        Write-Host "  Not present: $TempDir"
    }
}

<#
    Delete the premiere-pro entry without rewriting the rest of the file.

    Node does the edit for the same reason the installer uses it: ConvertTo-Json in
    Windows PowerShell 5.1 mangles nested MCP config (default -Depth 2 silently
    replaces deeper objects with type names), which would corrupt every OTHER server
    the user has configured. This deletes one key and leaves the rest byte-for-byte
    as JSON.stringify produces it.
#>
function Remove-ServerEntry([string] $ConfigPath, [string] $RootKey) {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        Write-Host "  Not present: $ConfigPath"
        return
    }

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        Write-Warning "node was not found on PATH, so $ConfigPath was left untouched. Remove the premiere-pro entry by hand."
        return
    }

    $helper = @'
const fs = require("fs");

const configPath = process.env.CONFIG_PATH;
const rootKey = process.env.ROOT_KEY;

const raw = fs.readFileSync(configPath, "utf8").trim();
if (!raw) {
  process.exit(0);
}

let data;
try {
  data = JSON.parse(raw);
} catch (error) {
  console.error(`${configPath} is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (data && typeof data === "object" && !Array.isArray(data)) {
  const root = data[rootKey];
  if (root && typeof root === "object" && !Array.isArray(root) && root["premiere-pro"]) {
    delete root["premiere-pro"];
    fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
    console.log("removed");
    process.exit(0);
  }
}
console.log("absent");
'@

    $helperPath = Join-Path $env:TEMP 'premiere-mcp-config-remove.cjs'
    [System.IO.File]::WriteAllText($helperPath, $helper, (New-Object System.Text.UTF8Encoding($false)))

    $oldConfigPath = $env:CONFIG_PATH
    $oldRootKey = $env:ROOT_KEY
    try {
        $env:CONFIG_PATH = $ConfigPath
        $env:ROOT_KEY = $RootKey
        $result = & $nodeCommand.Source $helperPath
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not update $ConfigPath. Remove the premiere-pro entry by hand."
        } elseif ("$result".Trim() -eq 'removed') {
            Write-Host "  Removed premiere-pro from $ConfigPath"
        } else {
            Write-Host "  No premiere-pro entry in $ConfigPath"
        }
    } finally {
        $env:CONFIG_PATH = $oldConfigPath
        $env:ROOT_KEY = $oldRootKey
        Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue
    }
}

Write-Host 'Removing MCP client config entries...'
Remove-ServerEntry -ConfigPath $ClaudeConfigPath -RootKey 'mcpServers'
Remove-ServerEntry -ConfigPath $VsCodeConfigPath -RootKey 'servers'

Write-Host ''
Write-Host 'Uninstall complete.'
Write-Host 'Note: Adobe CEP debug mode (HKCU:\Software\Adobe\CSXS.*\PlayerDebugMode) remains enabled so other CEP plugins keep working.'
