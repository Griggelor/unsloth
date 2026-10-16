# QA ONLY: applies matching instrumented Python files with a backup, never a production updater.
param([string]$BackendPath = (Join-Path $env:USERPROFILE '.unsloth\studio\unsloth_studio\Lib\site-packages\studio\backend'))
$ErrorActionPreference = 'Stop'
$paths = @('main.py','core/inference/checkpoint.py','core/inference/context_window.py','core/rag/conversation_archive.py','storage/studio_db.py')
$base = Join-Path $PSScriptRoot 'qa-backend-baseline\studio\backend'
$patch = Join-Path $PSScriptRoot 'qa-backend-patch\studio\backend'
if (-not (Test-Path -LiteralPath $BackendPath -PathType Container)) { throw "Backend location not found. Pass -BackendPath explicitly. No changes made." }
$target = (Resolve-Path -LiteralPath $BackendPath).Path
foreach ($relative in $paths) {
    $onDisk = Join-Path $target $relative
    $baseline = Join-Path $base $relative
    if (-not (Test-Path -LiteralPath $onDisk -PathType Leaf) -or -not (Test-Path -LiteralPath $baseline -PathType Leaf)) { throw "Missing expected backend file $relative. No changes made." }
    $have = (Get-FileHash -Algorithm SHA256 -LiteralPath $onDisk).Hash
    $expected = (Get-FileHash -Algorithm SHA256 -LiteralPath $baseline).Hash
    if ($have -ne $expected) { throw "Backend revision mismatch at $relative. Refusing to modify installed Unsloth. Use an isolated matching QA environment." }
}
$newFile = Join-Path $target 'utils/context_latency_trace.py'
if (Test-Path -LiteralPath $newFile) { throw "Instrumentation module already exists. Refusing to overwrite it." }
$backupRoot = Join-Path $PSScriptRoot ('qa-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -Path $backupRoot -ItemType Directory -Force | Out-Null
foreach ($relative in $paths) {
    $dest = Join-Path $backupRoot $relative
    New-Item -Path (Split-Path -Parent $dest) -ItemType Directory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $target $relative) -Destination $dest -ErrorAction Stop
}
$state = [ordered]@{ backend_path = $target; backup_root = $backupRoot; patched_files = @($paths + 'utils/context_latency_trace.py') }
$state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupRoot 'QA_BACKUP_MANIFEST.json') -Encoding UTF8
try {
    foreach ($relative in $state.patched_files) {
        $dest = Join-Path $target $relative
        $source = Join-Path $patch $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "QA patch source missing: $relative" }
        New-Item -Path (Split-Path -Parent $dest) -ItemType Directory -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $dest -Force
    }
} catch {
    foreach ($relative in $paths) { Copy-Item -LiteralPath (Join-Path $backupRoot $relative) -Destination (Join-Path $target $relative) -Force }
    Remove-Item -LiteralPath $newFile -Force -ErrorAction SilentlyContinue
    throw
}
Write-Host 'QA backend instrumentation installed. Nothing in your chat database was edited.'
Write-Host "Backup: $backupRoot"
Write-Host 'Completely quit any running Studio backend and use Launch-QA.ps1. Restore using Restore-QA-Backend.ps1 -BackupDirectory <backup path>.'
