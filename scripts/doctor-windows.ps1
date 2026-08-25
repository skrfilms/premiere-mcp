<#
.SYNOPSIS
    Verifies the Windows Premiere Pro MCP install.

.DESCRIPTION
    The Windows counterpart of scripts/doctor-macos.sh. The check list, the
    pass/warn/fail grading and the exit codes are mirrored from that script so the
    two platforms give the same verdict for the same machine state.

    HONESTY NOTE, because it changes how you should read a green run: every check
    below was written by mirroring the verified macOS logic and reviewed
    statically. None of it has been EXECUTED on Windows. A clean run of this
    script is evidence that the checks agree with the mac ones, not evidence that
    the Windows install works.

    Where Windows genuinely differs from macOS, the difference is checked rather
    than papered over:

      * CEP debug mode lives in the registry (HKCU:\Software\Adobe\CSXS.N,
        PlayerDebugMode as REG_SZ "1"), not in a preferences plist.
      * The bridge's shared temp directory cannot be protected with a POSIX 0700
        mode. The server calls chmod(0o700) there and Node silently reduces that
        to the read-only attribute on NTFS, so the mode says nothing. The real
        protection is the directory's NTFS ACL, which is what Test-TempDirectoryAcl
        reads. See docs/WINDOWS-PARITY.md.

.PARAMETER TempDir
    Bridge temp directory shared by the MCP server and the CEP panel. Defaults to
    the same path install-windows.ps1 uses.

.PARAMETER VsCodeConfigPath
    VS Code MCP config used by GitHub Copilot.

.PARAMETER ClaudeConfigPath
    Claude Desktop MCP config path.
#>

[CmdletBinding()]
param(
    # Resolved in the body, not here: a nested if-expression in a parameter default is
    # legal but unparseable at a glance, and this file cannot be executed by its author.
    [string] $TempDir = '',
    [string] $VsCodeConfigPath = (Join-Path $env:APPDATA 'Code\User\mcp.json'),
    [string] $ClaudeConfigPath = (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# $IsWindows exists only in PowerShell 6+; $env:OS covers Windows PowerShell 5.1.
$onWindows = if (Test-Path variable:IsWindows) { $IsWindows } else { $env:OS -eq 'Windows_NT' }
if (-not $onWindows) {
    throw 'This doctor supports Windows only. Use npm run setup:doctor on macOS.'
}

# Same precedence the server uses: PREMIERE_TEMP_DIR wins, then %TEMP%, then %TMP%.
# The %TMP% step is here on purpose -- the SERVER omits it (utils/security.ts), and a
# machine with only TMP set sends the server and the panel to different directories.
if ([string]::IsNullOrWhiteSpace($TempDir)) {
    if ($env:PREMIERE_TEMP_DIR) {
        $TempDir = $env:PREMIERE_TEMP_DIR
    } else {
        $tempBase = if ($env:TEMP) { $env:TEMP } elseif ($env:TMP) { $env:TMP } else { 'C:\Temp' }
        $TempDir = Join-Path $tempBase 'premiere-mcp-bridge'
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$cepTargetDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions\MCPBridgeCEP'
$distEntry = Join-Path $repoRoot 'dist\index.js'
$script:failures = 0
$script:warnings = 0
$script:clientFound = $false

function Pass([string] $Message) { Write-Host "  OK    $Message" }
function Info([string] $Message) { Write-Host "  INFO  $Message" }
function Warn([string] $Message) { Write-Host "  WARN  $Message"; $script:warnings++ }
function Fail([string] $Message) { Write-Host "  FAIL  $Message"; $script:failures++ }

<#
    Read a property that may be absent.

    Set-StrictMode -Version Latest (3.0) makes `$obj.missingProperty` a TERMINATING
    error, and $ErrorActionPreference is 'Stop'. Combined with ConvertFrom-Json --
    which only creates properties that were present in the JSON -- a heartbeat or a
    config file written by an older build would abort the whole doctor instead of
    producing one warning. Every property read off parsed JSON goes through here.
#>
function Get-Prop($Object, [string] $Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property) { return $null }
    return $property.Value
}

<#
    Compare two Windows paths for "do these point at the same directory".

    The macOS doctor can use a plain string compare. On Windows the same two
    directories are spelled several ways -- C:\Temp\x vs c:\temp\x vs
    C:\Temp\x\ vs a path with a forward slash from a hand-edited JSON config --
    so a string compare would report a mismatch that is not one, or miss one
    that is. Nothing here touches the filesystem, so it works for paths that do
    not exist yet.
#>
function Test-SamePath([string] $Left, [string] $Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    function Normalize([string] $Value) {
        $v = $Value.Trim().Trim('"').Trim("'")
        $v = $v -replace '/', '\'
        # Collapse repeated separators, but keep a leading \\ for UNC paths.
        $prefix = ''
        if ($v.StartsWith('\\')) { $prefix = '\\'; $v = $v.Substring(2) }
        while ($v -match '\\\\') { $v = $v -replace '\\\\', '\' }
        return ($prefix + $v).TrimEnd('\')
    }
    return (Normalize $Left) -ieq (Normalize $Right)
}

Write-Host 'Premiere Pro MCP doctor (Windows)'
Write-Host '(checks mirrored from the verified macOS doctor; not executed on Windows by the author)'
Write-Host ''

# --- Node.js (required) -------------------------------------------------------
Write-Host 'Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail 'Node.js not found in PATH'
} else {
    $nodeVersion = & $node.Source -v
    $nodeMajorRaw = & $node.Source -p "process.versions.node.split('.')[0]"
    $nodeMajor = 0
    [void][int]::TryParse("$nodeMajorRaw".Trim(), [ref] $nodeMajor)
    if ($nodeMajor -ge 20) {
        Pass "Node.js available ($nodeVersion)"
    } else {
        Fail "Node.js 20+ required (found $nodeVersion)"
    }
}

# --- Built server (required) --------------------------------------------------
Write-Host 'MCP server build'
if (Test-Path -LiteralPath $distEntry -PathType Leaf) {
    Pass "Built MCP server found at $distEntry"
} else {
    Fail "Build output missing at $distEntry (run npm run build)"
}

# --- CEP extension (required) -------------------------------------------------
# Mirrors the mac doctor's three-way result: installed / present but incomplete /
# not installed. "Incomplete" is a real state on Windows: Copy-Item -Recurse into a
# destination that does not exist has flattened subdirectories in the past, which
# leaves the folder there but CSXS\manifest.xml missing, and Premiere then shows no
# panel with no error anywhere.
Write-Host 'CEP extension'
if (Test-Path -LiteralPath $cepTargetDir -PathType Container) {
    $hasManifest = Test-Path -LiteralPath (Join-Path $cepTargetDir 'CSXS\manifest.xml') -PathType Leaf
    $hasIndex = Test-Path -LiteralPath (Join-Path $cepTargetDir 'index.html') -PathType Leaf
    if ($hasManifest -and $hasIndex) {
        Pass "Premiere CEP extension installed at $cepTargetDir"
    } else {
        Fail "CEP extension folder exists but is incomplete at $cepTargetDir (missing CSXS\manifest.xml or index.html) - re-run npm run setup:win"
    }
} else {
    Fail "Premiere CEP extension not installed at $cepTargetDir"
}

# --- Bridge temp directory (required) -----------------------------------------
Write-Host 'Bridge temp directory'
if (Test-Path -LiteralPath $TempDir -PathType Container) {
    Pass "Bridge temp directory exists at $TempDir"
} else {
    Fail "Bridge temp directory missing at $TempDir"
}

<#
    The NTFS half of what 0700 does on macOS.

    The server creates this directory with mode 0o700 and re-chmods it every start,
    and on macOS that genuinely stops other users reading auth-token.json. On NTFS
    the POSIX mode is not stored; Node's chmod only flips the read-only attribute.
    So the mode the server logs is not the protection -- the ACL is. If the ACL
    grants Everyone / Authenticated Users / BUILTIN\Users, then every interactive
    account on the machine can read the per-session bridge token and drive Premiere
    through the panel. That is reported as a warning here rather than being implied
    away by a 0700 that did nothing.
#>
function Test-TempDirectoryAcl([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    $acl = $null
    try { $acl = Get-Acl -LiteralPath $Path } catch { Warn "Could not read the ACL on $Path ($($_.Exception.Message))"; return }

    # Well-known SIDs for identities that would make the token readable by other
    # accounts. Matching on SID, not on name: the display names are localised.
    $broadSids = @{
        'S-1-1-0'        = 'Everyone'
        'S-1-5-11'       = 'Authenticated Users'
        'S-1-5-32-545'   = 'BUILTIN\Users'
        'S-1-5-4'        = 'INTERACTIVE'
        'S-1-5-7'        = 'ANONYMOUS LOGON'
    }
    $exposed = New-Object System.Collections.Generic.List[string]
    foreach ($ace in $acl.Access) {
        if ($ace.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $null
        try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = $null }
        if ($sid -and $broadSids.ContainsKey($sid) -and -not $exposed.Contains($broadSids[$sid])) {
            $exposed.Add($broadSids[$sid])
        }
    }

    if ($exposed.Count -gt 0) {
        Warn ("$Path grants access to $($exposed -join ', '). auth-token.json in that directory is readable by those accounts, " +
              'so the per-session bridge token protects you from nothing on this machine. The server writes the token 0600, but a POSIX mode ' +
              'is not enforced on NTFS. Re-run npm run setup:win to restrict the ACL, or restrict it by hand.')
    } else {
        Pass "$Path ACL does not grant Everyone/Users/Authenticated Users (owner: $($acl.Owner))"
    }

    $tokenFile = Join-Path $Path 'auth-token.json'
    if (Test-Path -LiteralPath $tokenFile -PathType Leaf) {
        Info "auth-token.json present. On NTFS it has no mode of its own - it inherits this directory's ACL, which is the only thing protecting it."
    }
}
Test-TempDirectoryAcl $TempDir

# --- Adobe CEP debug mode: pass if enabled for ANY installed CSXS version -----
# Premiere 26.x uses CSXS.11/12; older builds use lower numbers. Only one needs to
# allow unsigned extensions, so a per-version failure would ding a working setup.
# Windows stores this in the registry as REG_SZ "1" -- a DWORD 1 is ignored by CEP,
# so the value is compared as a string.
Write-Host 'Adobe CEP debug mode'
$debugVersions = New-Object System.Collections.Generic.List[string]
foreach ($version in 9..15) {
    $key = "HKCU:\Software\Adobe\CSXS.$version"
    if (-not (Test-Path -LiteralPath $key)) { continue }
    $value = $null
    try { $value = (Get-ItemProperty -LiteralPath $key -Name 'PlayerDebugMode' -ErrorAction SilentlyContinue).PlayerDebugMode } catch { $value = $null }
    if ("$value".Trim() -eq '1') { $debugVersions.Add("$version") }
}
if ($debugVersions.Count -gt 0) {
    Pass "Adobe CEP debug mode enabled for CSXS.$($debugVersions -join ',')"
} else {
    Warn ('Adobe CEP debug mode not enabled for any CSXS version (unsigned panels will not load). Run: ' +
          'New-ItemProperty -Path HKCU:\Software\Adobe\CSXS.12 -Name PlayerDebugMode -Value 1 -PropertyType String -Force')
}

# --- Live bridge: sample the heartbeat instead of asking the human ------------
# The CEP panel rewrites bridge-heartbeat.json every poll tick. Sampling it twice
# separates "live", "stale" and "not running", which the old doctor punted to a
# manual "click Test Connection" step.
Write-Host 'Live bridge (heartbeat)'
$heartbeatPath = Join-Path $TempDir 'bridge-heartbeat.json'
function Read-Heartbeat([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}
if (Test-Path -LiteralPath $heartbeatPath -PathType Leaf) {
    $hb1 = Read-Heartbeat $heartbeatPath
    Start-Sleep -Milliseconds 1200
    $hb2 = Read-Heartbeat $heartbeatPath
    $ts1 = Get-Prop $hb1 'ts'
    $ts2 = Get-Prop $hb2 'ts'
    if ($null -eq $hb2 -or [string]::IsNullOrWhiteSpace("$ts2")) {
        Warn "Bridge heartbeat present but unreadable at $heartbeatPath"
    } elseif (-not [string]::IsNullOrWhiteSpace("$ts1") -and "$ts1" -ne "$ts2") {
        if (Get-Prop $hb2 'connected') {
            if (Get-Prop $hb2 'isProcessing') {
                Pass 'Bridge is live and connected (currently processing a command)'
            } else {
                Pass 'Bridge is live and connected (panel polling, idle)'
            }
        } else {
            Warn 'Bridge panel is running but reports not connected to Premiere'
        }
    } else {
        Warn 'Bridge heartbeat is stale (timestamp not advancing) - the panel is not polling. Restart the MCP Bridge (CEP) panel in Premiere.'
    }
} else {
    Info 'Bridge not running (no heartbeat). Open Window > Extensions > MCP Bridge (CEP) in Premiere and start it, then re-run the doctor.'
}

# --- Local backends: optional dependency-backed capabilities ------------------
# Not required for editing, but each unlocks specific tools; report availability so
# the picture is honest rather than silent. Get-Command resolves a bare name through
# PATHEXT, so 'ffmpeg' finds ffmpeg.exe -- but an override pointing at a full path
# with spaces is not on PATH at all, so that case falls back to a file test.
Write-Host 'Local backends (optional)'
function Test-Backend([string] $Label, [string] $Command, [string] $Unlocks) {
    $found = $null
    try { $found = Get-Command $Command -ErrorAction SilentlyContinue } catch { $found = $null }
    if (-not $found -and (Test-Path -LiteralPath $Command -PathType Leaf)) { $found = $Command }
    if ($found) {
        Info "$Label available ($Command) - unlocks $Unlocks"
    } else {
        Info "$Label not found ($Command) - $Unlocks will return install guidance until installed"
    }
}
$ffmpegCmd  = if ($env:PREMIERE_MCP_FFMPEG_CMD)  { $env:PREMIERE_MCP_FFMPEG_CMD }  else { 'ffmpeg' }
$ffprobeCmd = if ($env:PREMIERE_MCP_FFPROBE_CMD) { $env:PREMIERE_MCP_FFPROBE_CMD } else { 'ffprobe' }
$whisperCmd = if ($env:PREMIERE_MCP_WHISPER_CMD) { $env:PREMIERE_MCP_WHISPER_CMD } else { 'whisper' }
Test-Backend 'ffmpeg'  $ffmpegCmd  'generate_scope / bake_speed_change / normalize_loudness / detect_silence'
Test-Backend 'ffprobe' $ffprobeCmd 'probe_media / index_footage / search_footage'
Test-Backend 'whisper' $whisperCmd 'transcribe_to_srt'

<#
    MCP client config: pass if premiere-pro is wired into ANY known client.

    Mirrors check_client_config in doctor-macos.sh, including the grading, which is
    the part that matters: a config file that is simply ABSENT belongs to a client
    you do not use, and is not a finding at all. The old Windows doctor warned on
    every missing file and FAILED on a config that had no premiere-pro entry, so a
    correct Claude-Code-only install reported three warnings and two failures.

    Also compares the client's PREMIERE_TEMP_DIR against the directory this doctor
    (and therefore the CEP panel) is checking. A client pointed at a DIFFERENT temp
    dir is a known silent-bridge-failure mode: the server writes commands where the
    panel never polls, so every tool call times out with a healthy-looking panel and
    nothing in the logs says why. Only reported when the client sets the value
    explicitly and it disagrees -- an unset value correctly inherits the same default.
#>
function Test-ClientConfig([string] $Label, [string] $Path, [string] $RootKey) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }

    $raw = ''
    try { $raw = Get-Content -LiteralPath $Path -Raw } catch { Warn "$Label could not be read"; return }
    if ([string]::IsNullOrWhiteSpace($raw)) { Fail "$Label is empty"; return }

    $json = $null
    try { $json = $raw | ConvertFrom-Json } catch { Fail "$Label is not valid JSON ($($_.Exception.Message))"; return }

    $root = Get-Prop $json $RootKey
    if ($null -eq $root) { Info "$Label present but has no $RootKey section"; return }

    $server = Get-Prop $root 'premiere-pro'
    if ($null -eq $server) { Info "$Label present but has no premiere-pro entry"; return }

    $script:clientFound = $true

    $serverArgs = Get-Prop $server 'args'
    $lastArg = ''
    if ($serverArgs) { $lastArg = "$(@($serverArgs)[-1])" }
    if ($lastArg -and $lastArg -notlike '*index.js*') {
        Warn "$Label premiere-pro entry points at $lastArg (expected a path to dist\index.js)"
        return
    }

    $clientTemp = Get-Prop (Get-Prop $server 'env') 'PREMIERE_TEMP_DIR'
    if ($clientTemp -and -not (Test-SamePath $clientTemp $TempDir)) {
        Warn ("$Label sets PREMIERE_TEMP_DIR=$clientTemp but this doctor and the CEP panel use $TempDir. " +
              'The server would write commands where the panel never looks, so every tool call would time out. Make both the same.')
        return
    }

    Pass "$Label has a premiere-pro entry"
}

Write-Host 'MCP client config'
$cwd = (Get-Location).Path
Test-ClientConfig 'Claude Code .mcp.json (cwd)' (Join-Path $cwd '.mcp.json') 'mcpServers'
if (-not (Test-SamePath $cwd $repoRoot)) {
    Test-ClientConfig 'Claude Code .mcp.json (repo)' (Join-Path $repoRoot '.mcp.json') 'mcpServers'
}
Test-ClientConfig 'Claude Desktop config' $ClaudeConfigPath 'mcpServers'
Test-ClientConfig 'GitHub Copilot VS Code MCP config' $VsCodeConfigPath 'servers'
if (-not $script:clientFound) {
    Info ('No MCP client config with a premiere-pro entry was found in the usual locations. If you use another client ' +
          "(or a project-local .mcp.json elsewhere), point it at: node $distEntry")
}

# --- Verdict ------------------------------------------------------------------
Write-Host ''
if ($script:failures -gt 0) {
    Write-Host "Doctor found $($script:failures) blocking issue(s) and $($script:warnings) warning(s)."
    exit 1
}
if ($script:warnings -gt 0) {
    Write-Host "Doctor passed with $($script:warnings) warning(s) - the install is usable; review the WARN lines above."
    exit 0
}
Write-Host 'Doctor check passed.'
