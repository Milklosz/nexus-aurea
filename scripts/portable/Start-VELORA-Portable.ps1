<# portable launch wrapper for the VELORA 2.0 validation candidate.
.SYNOPSIS
    Starts the portable EXE with an isolated data, config, log and credential
    environment. Never runs an installer and never changes the registry.
.PARAMETER AppArgs
    Arguments forwarded to nexus-aurea.exe. Use --windowed for a non-fullscreen
    validation window; the default keeps the production fullscreen behaviour.
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $AppArgs
)

$ErrorActionPreference = 'Stop'

$portableRoot = $PSScriptRoot
$dataRoot = Join-Path $portableRoot 'VELORA-Portable-Data'
$localData = Join-Path $dataRoot 'Local'
$roamingData = Join-Path $dataRoot 'Roaming'
$tempData = Join-Path $dataRoot 'Temp'

foreach ($directory in @($dataRoot, $localData, $roamingData, $tempData)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

# Consumed by src-tauri/src/portable.rs and lib.rs: redirects every Tauri
# app_*_dir (including the main WebView2 user-data directory) into $dataRoot.
$env:VELORA_PORTABLE_DATA_DIR = $dataRoot

# Redirect the app's own %LOCALAPPDATA% reads/writes (remote state lock,
# Edge Cinema profiles, Playnite manifest, claude-usage cache) and any
# home-relative resolution in the frontend. These are process-local changes.
$env:LOCALAPPDATA = $localData
$env:APPDATA = $roamingData
$env:USERPROFILE = $dataRoot
$env:TEMP = $tempData
$env:TMP = $tempData

$exe = Join-Path $portableRoot 'nexus-aurea.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Portable executable not found: $exe"
}

Write-Host 'VELORA 2.0 - portable validation candidate (no installation)'
Write-Host "Isolated data root : $dataRoot"
Write-Host 'Installed VELORA data, credentials and autostart are not modified.'
Write-Host '------------------------------------------------------------------'

& $exe @AppArgs
exit $LASTEXITCODE
