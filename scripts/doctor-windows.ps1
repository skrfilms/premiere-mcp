<#
.SYNOPSIS
    Verifies the Windows Premiere Pro MCP install.
#>

[CmdletBinding()]
param(
    [string] $TempDir = (Join-Path $env:TEMP 'premiere-mcp-bridge'),
    [string] $VsCodeConfigPath = (Join-Path $env:APPDATA 'Code\User\mcp.json'),
    [string] $ClaudeConfigPath = (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'This doctor supports Windows only. Use npm run setup:doctor on macOS.'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$cepTargetDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions\MCPBridgeCEP'
$distEntry = Join-Path $repoRoot 'dist\index.js'
$failures = 0
$warnings = 0

function Pass([string] $Message) {
    Write-Host "  OK    $Message"
}

function Warn([string] $Message) {
    Write-Host "  WARN  $Message"
    $script:warnings++
}

function Fail([string] $Message) {
    Write-Host "  FAIL  $Message"
    $script:failures++
}

function Test-JsonServer([string] $Path, [string] $RootKey) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Warn "$Path not found"
        return
    }

    $raw = Get-Content -LiteralPath $Path -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Fail "$Path is empty"
        return
    }

    try {
        $json = $raw | ConvertFrom-Json
    } catch {
        Fail "$Path is not valid JSON"
        return
    }

    $root = $json.PSObject.Properties[$RootKey]
    if (-not $root) {
        Fail "$Path missing $RootKey"
        return
    }

    $server = $root.Value.PSObject.Properties['premiere-pro']
    if (-not $server) {
        Fail "$Path missing premiere-pro"
        return
    }

    Pass "$Path contains premiere-pro"
}

Write-Host 'Premiere Pro MCP doctor (Windows)'
Write-Host ''

Write-Host 'Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail 'node not found on PATH'
} else {
    $nodeMajor = [int](& $node.Source -p "process.versions.node.split('.')[0]")
    if ($nodeMajor -lt 20) {
        Fail "Node.js 20+ required, found $(& $node.Source -v)"
    } else {
        Pass "$(& $node.Source -v)"
    }
}

Write-Host 'MCP server build'
if (Test-Path -LiteralPath $distEntry -PathType Leaf) {
    Pass $distEntry
} else {
    Fail "$distEntry missing - run npm run build"
}

Write-Host 'CEP extension'
if (Test-Path -LiteralPath (Join-Path $cepTargetDir 'CSXS\manifest.xml') -PathType Leaf) {
    Pass $cepTargetDir
} else {
    Fail "$cepTargetDir missing or incomplete - run npm run setup:win"
}

Write-Host 'Bridge temp directory'
if (Test-Path -LiteralPath $TempDir -PathType Container) {
    Pass $TempDir
} else {
    Fail "$TempDir missing"
}

Write-Host 'Live bridge (heartbeat)'
# The CEP panel rewrites bridge-heartbeat.json every poll tick; sampling it
# twice tells us whether the panel is actually running and connected.
$heartbeatPath = Join-Path $TempDir 'bridge-heartbeat.json'
function Read-Heartbeat([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}
if (Test-Path -LiteralPath $heartbeatPath -PathType Leaf) {
    $hb1 = Read-Heartbeat $heartbeatPath
    Start-Sleep -Milliseconds 1200
    $hb2 = Read-Heartbeat $heartbeatPath
    if ($null -eq $hb2) {
        Warn "Bridge heartbeat present but unreadable at $heartbeatPath"
    } elseif ($null -ne $hb1 -and $hb1.ts -ne $hb2.ts) {
        if ($hb2.connected) {
            if ($hb2.isProcessing) {
                Pass 'Bridge is live and connected (currently processing a command)'
            } else {
                Pass 'Bridge is live and connected (panel polling, idle)'
            }
        } else {
            Warn 'Bridge panel is running but reports not connected to Premiere'
        }
    } else {
        Warn 'Bridge heartbeat is stale (timestamp not advancing) - restart the MCP Bridge (CEP) panel in Premiere.'
    }
} else {
    Write-Host '  INFO  Bridge not running (no heartbeat). Open Window > Extensions > MCP Bridge (CEP) in Premiere and start it, then re-run the doctor.'
}

Write-Host 'Local backends (optional)'
function Test-Backend([string] $Label, [string] $Command, [string] $Unlocks) {
    $found = Get-Command $Command -ErrorAction SilentlyContinue
    if ($found) {
        Write-Host "  INFO  $Label available ($Command) - unlocks $Unlocks"
    } else {
        Write-Host "  INFO  $Label not found ($Command) - $Unlocks will return install guidance until installed"
    }
}
$ffmpegCmd  = if ($env:PREMIERE_MCP_FFMPEG_CMD)  { $env:PREMIERE_MCP_FFMPEG_CMD }  else { 'ffmpeg' }
$ffprobeCmd = if ($env:PREMIERE_MCP_FFPROBE_CMD) { $env:PREMIERE_MCP_FFPROBE_CMD } else { 'ffprobe' }
$whisperCmd = if ($env:PREMIERE_MCP_WHISPER_CMD) { $env:PREMIERE_MCP_WHISPER_CMD } else { 'whisper' }
Test-Backend 'ffmpeg'  $ffmpegCmd  'generate_scope / bake_speed_change / normalize_loudness / detect_silence'
Test-Backend 'ffprobe' $ffprobeCmd 'probe_media / index_footage / search_footage'
Test-Backend 'whisper' $whisperCmd 'transcribe_to_srt'

Write-Host 'Adobe CEP debug mode'
$debugModeFound = $false
foreach ($version in 9..15) {
    $key = "HKCU:\Software\Adobe\CSXS.$version"
    if (Test-Path -LiteralPath $key) {
        $value = (Get-ItemProperty -Path $key -Name 'PlayerDebugMode' -ErrorAction SilentlyContinue).PlayerDebugMode
        if ("$value" -eq '1') {
            $debugModeFound = $true
            Pass "CSXS.$version PlayerDebugMode=1"
        }
    }
}
if (-not $debugModeFound) {
    Warn 'PlayerDebugMode=1 not found under CSXS.9 through CSXS.15'
}

Write-Host 'Claude Code project MCP config (.mcp.json)'
Test-JsonServer -Path (Join-Path (Get-Location) '.mcp.json') -RootKey 'mcpServers'
if ((Get-Location).Path -ne $repoRoot) {
    Test-JsonServer -Path (Join-Path $repoRoot '.mcp.json') -RootKey 'mcpServers'
}

Write-Host 'GitHub Copilot VS Code MCP config'
Test-JsonServer -Path $VsCodeConfigPath -RootKey 'servers'

Write-Host 'Claude Desktop MCP config'
Test-JsonServer -Path $ClaudeConfigPath -RootKey 'mcpServers'

Write-Host ''
if ($failures -gt 0) {
    Write-Host "Doctor found $failures blocking issue(s) and $warnings warning(s)."
    exit 1
}
if ($warnings -gt 0) {
    Write-Host "Doctor passed with $warnings warning(s) - the install is usable; review the WARN lines above."
    exit 0
}
Write-Host 'All required Windows install checks passed.'
