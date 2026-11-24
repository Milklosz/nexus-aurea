<# portable launch wrapper for the VELORA 3.0 validation candidate.
.SYNOPSIS
    Starts the build that initializes its own isolated profile.
    Never runs an installer and never changes the registry.
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
$exe = Join-Path $portableRoot 'nexus-aurea.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Portable executable not found: $exe"
}

$launch = @{ FilePath = $exe; PassThru = $true; Wait = $true }
if ($AppArgs) { $launch.ArgumentList = $AppArgs }
$process = Start-Process @launch
exit $process.ExitCode
