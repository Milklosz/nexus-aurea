param(
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceSha,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(5, 45)][int]$Seconds = 15
)
$ErrorActionPreference = 'Stop'
$resolvedCandidate = (Resolve-Path -LiteralPath $CandidatePath).Path
$candidate = @(Get-Process | Where-Object { $_.Path -eq $resolvedCandidate })
if ($candidate.Count -ne 1) { throw 'Expected one exact candidate process; no measurement was taken.' }
$candidateHash = (Get-FileHash -LiteralPath $resolvedCandidate -Algorithm SHA256).Hash.ToLowerInvariant()
$rootId = $candidate[0].Id
$rows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($rootId)
do {
    $added = $false
    foreach ($row in $rows) {
        if ($owned.Contains([int]$row.ParentProcessId) -and $owned.Add([int]$row.ProcessId)) { $added = $true }
    }
} while ($added)
$baseline = @{}
foreach ($processId in $owned) {
    $process = Get-Process -Id $processId
    $baseline[$processId] = @{ start = $process.StartTime.ToUniversalTime().Ticks; cpu = $process.TotalProcessorTime.TotalSeconds }
}
$samples = @()
$watch = [System.Diagnostics.Stopwatch]::StartNew()
for ($sampleIndex = 0; $sampleIndex -lt $Seconds; $sampleIndex++) {
    Start-Sleep -Seconds 1
    $working = 0L; $private = 0L; $cpuDelta = 0.0
    foreach ($processId in $owned) {
        $process = Get-Process -Id $processId
        if ($process.StartTime.ToUniversalTime().Ticks -ne $baseline[$processId].start) { throw 'Process identity changed.' }
        $working += $process.WorkingSet64; $private += $process.PrivateMemorySize64
        $cpuDelta += $process.TotalProcessorTime.TotalSeconds - $baseline[$processId].cpu
    }
    $samples += [pscustomobject]@{ elapsedSeconds = $watch.Elapsed.TotalSeconds; cpuSeconds = $cpuDelta; workingMiB = $working / 1MB; privateMiB = $private / 1MB }
}
$watch.Stop()
$endRows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
if (@($endRows | Where-Object { $owned.Contains([int]$_.ParentProcessId) -and -not $owned.Contains([int]$_.ProcessId) }).Count) {
    throw 'A new descendant appeared; the fixed-tree sample is incomplete.'
}
if ((Get-FileHash -LiteralPath $resolvedCandidate -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateHash) { throw 'Candidate changed during sampling.' }
$last = $samples[-1]
$result = [ordered]@{
    schemaVersion = 1
    sourceSha = $SourceSha
    artifactSha256 = $candidateHash
    evidenceType = 'readOnlyWindowsProcessMeasurement'
    buildType = 'local-debug-no-bundle'
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    durationSeconds = [Math]::Round($last.elapsedSeconds, 3)
    processCount = $owned.Count
    logicalCores = [Environment]::ProcessorCount
    cpuPercentNormalized = [Math]::Round(100 * $last.cpuSeconds / ($last.elapsedSeconds * [Environment]::ProcessorCount), 4)
    cpuSeconds = [Math]::Round($last.cpuSeconds, 4)
    workingSetSumMiB = @{ min = [Math]::Round(($samples.workingMiB | Measure-Object -Minimum).Minimum, 2); max = [Math]::Round(($samples.workingMiB | Measure-Object -Maximum).Maximum, 2) }
    privateBytesSumMiB = @{ min = [Math]::Round(($samples.privateMiB | Measure-Object -Minimum).Minimum, 2); max = [Math]::Round(($samples.privateMiB | Measure-Object -Maximum).Maximum, 2) }
    samples = $samples
    limitations = @(
        'One bounded idle sample, not a performance guarantee; record visible UI state separately.',
        'Caller supplies source SHA; compare this artifact hash with the build manifest before attribution.',
        'Includes only the exact candidate and descendants present at start; identities checked; new descendants rejected.',
        'Summed working sets can count shared pages twice. Private bytes are committed allocation, not physical RAM.',
        'Unrelated streaming processes excluded. No GPU, startup readiness, input or playback latency is measured.'
    )
}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding utf8
[pscustomobject]$result | Select-Object sourceSha, artifactSha256, durationSeconds, processCount, cpuPercentNormalized, workingSetSumMiB, privateBytesSumMiB | ConvertTo-Json -Depth 4
