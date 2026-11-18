<#
.SYNOPSIS
    Read-only prerequisite check for the portable VELORA validation candidate.
.DESCRIPTION
    Checks whether the WebView2 Runtime (Evergreen) is already installed and
    whether Microsoft Edge is available for Edge Cinema. This script only reads
    the registry and the filesystem. It never installs, downloads or changes
    anything, never modifies user data and never requires elevation.
#>
$ErrorActionPreference = 'Stop'

$webviewGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$candidateKeys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$webviewGuid",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$webviewGuid",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$webviewGuid"
)

$webviewVersion = $null
foreach ($key in $candidateKeys) {
    if (Test-Path -LiteralPath $key) {
        $value = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).pv
        if ($value) {
            $webviewVersion = [string]$value
            Write-Host "WebView2 Runtime: FOUND ($webviewVersion) at $key"
            break
        }
    }
}
if (-not $webviewVersion) {
    Write-Warning 'WebView2 Runtime: NOT DETECTED.'
    Write-Warning 'The portable candidate does not bundle or install a runtime. Ask the system owner to install the official Microsoft WebView2 Runtime before launching. This script will not install it.'
}

$edgePaths = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
)
$edge = $edgePaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($edge) {
    Write-Host "Microsoft Edge: FOUND ($edge) - Edge Cinema available."
} else {
    Write-Host 'Microsoft Edge: NOT DETECTED - Edge Cinema streaming will be unavailable; the rest of the app is unaffected.'
}

if (-not $webviewVersion) { exit 2 }
Write-Host 'PREREQUISITES OK. Launch with Run-VELORA-Portable.cmd'
exit 0
