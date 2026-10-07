# device-id.ps1 - the PowerShell twin of `node device-id.mjs --tool claude-code`,
# for a Windows device without Node (#408 S3).
#
# Setup needs ONE non-secret fact before provision_emit: the instance id this
# device was last provisioned with, so a re-run rotates it instead of minting a
# duplicate. The file that holds it also holds the durable emit credential, so
# the model must never open it; this script reads it out of process and prints
# ONLY a fixed set of non-secret keys:
#   {"enrolled","tool","instance_id","bearer_host","reason","platform","node"}
# `node` is always null here: this lane exists for devices where Node did not
# resolve. The object is built from those keys alone, never from the store.
#
# Reads <profile>\.claude\settings.json, the file claude-redeem.ps1 writes. The
# profile is [Environment]::GetFolderPath('UserProfile'), the same anchor the
# writer uses (read where the writer writes), never $env:USERPROFILE.
#
# Only the claude-code lane: Copilot setup runs in Copilot's own Node.
#
# Windows PowerShell 5.1 syntax. ASCII only.

$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
# PATH next, for the same reason (otel-headers-helper.sh pins TRUSTED_PATH):
# nothing here runs a program by name, and nothing added later may find one
# the repository put on PATH. Windows only; off Windows only tests run this.
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $env:PATH = [Environment]::SystemDirectory + ';' + [Environment]::SystemDirectory + '\WindowsPowerShell\v1.0' }
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. ([System.IO.Path]::Combine($PSScriptRoot, 'ps-json.ps1'))

function Get-TsPlatformName {
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) { return 'win32' }
  if (Test-Path -LiteralPath '/System/Library/CoreServices') { return 'darwin' }
  return 'linux'
}

function New-TsResult([bool]$Enrolled, $ToolName, $InstanceId, $BearerHost, $Reason) {
  $r = New-TsJsonObject
  $r['enrolled'] = $Enrolled
  $r['tool'] = $ToolName
  $r['instance_id'] = $InstanceId
  $r['bearer_host'] = $BearerHost
  $r['reason'] = $Reason
  $r['platform'] = Get-TsPlatformName
  $r['node'] = $null
  return ,$r
}

# device-id.mjs attrValue: the value of `key=` at the start of a comma field,
# leading whitespace skipped, trimmed; empty reads as absent.
function Get-TsAttrValue($Attrs, [string]$Key) {
  if (-not ($Attrs -is [string])) { return $null }
  foreach ($field in $Attrs.Split(',')) {
    $eq = $field.IndexOf('=')
    if ($eq -lt 0) { continue }
    if ($field.Substring(0, $eq).TrimStart() -cne $Key) { continue }
    $v = $field.Substring($eq + 1).Trim()
    if ($v -eq '') { return $null }
    return $v
  }
  return $null
}

# device-id.mjs hostOf: URL host, lower-cased, or null.
function Get-TsHostOf($Endpoint) {
  if (-not ($Endpoint -is [string])) { return $null }
  $u = $null
  if (-not [System.Uri]::TryCreate($Endpoint.Trim(), [System.UriKind]::Absolute, [ref]$u)) { return $null }
  if ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') { return $null }
  $h = $u.Host.ToLowerInvariant()
  if (-not $u.IsDefaultPort) { $h += ':' + $u.Port }
  if (-not $h) { return $null }
  return $h
}

function Get-TsDeviceIdentity([string]$WantTool) {
  if ($WantTool -cne 'claude-code' -and $WantTool -cne 'copilot-cli') { return (New-TsResult $false $null $null $null 'unknown-tool') }
  if ($WantTool -cne 'claude-code') { return (New-TsResult $false $null $null $null 'unsupported-tool') }
  $profileDir = [System.Environment]::GetFolderPath('UserProfile')
  $path = [System.IO.Path]::Combine([System.IO.Path]::Combine($profileDir, '.claude'), 'settings.json')
  $settings = $null
  try {
    if ([System.IO.File]::Exists($path)) {
      $settings = ConvertFrom-TsJson (ConvertFrom-TsUtf8 ([System.IO.File]::ReadAllBytes($path)))
    }
  } catch {
    $settings = $null
  }
  $envObj = Get-TsJsonMember $settings 'env'
  if (-not (Test-TsJsonObject $envObj)) { return (New-TsResult $false $null $null $null 'no-enrolment') }
  $attrs = Get-TsJsonMember $envObj 'OTEL_RESOURCE_ATTRIBUTES'
  $instanceId = Get-TsAttrValue $attrs 'tokenscope.instance_id'
  if (-not $instanceId) { return (New-TsResult $false $null $null $null 'no-enrolment') }
  $toolName = Get-TsAttrValue $attrs 'tool'
  if (-not $toolName) { $toolName = 'claude-code' }
  $bearerHost = Get-TsHostOf (Get-TsJsonMember $envObj 'TOKENSCOPE_BEARER_ENDPOINT')
  if ($toolName -cne $WantTool) { return (New-TsResult $false $toolName $null $bearerHost 'tool-mismatch') }
  return (New-TsResult $true $toolName $instanceId $bearerHost $null)
}

# `--tool <name>` / `--tool=<name>`, default claude-code, as device-id.mjs.
$want = 'claude-code'
for ($i = 0; $i -lt $args.Count; $i++) {
  if ([string]$args[$i] -ceq '--tool' -and $i + 1 -lt $args.Count -and [string]$args[$i + 1]) { $want = [string]$args[$i + 1]; break }
  if (([string]$args[$i]).StartsWith('--tool=')) { $want = ([string]$args[$i]).Substring(7); break }
}

try {
  $out = Get-TsDeviceIdentity $want
} catch {
  $out = New-TsResult $false $null $null $null 'unreadable'
}
[Console]::Out.Write((ConvertTo-TsJson $out) + "`n")
exit 0
