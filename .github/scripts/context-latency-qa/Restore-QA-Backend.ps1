# QA ONLY: restore five original files from a verified QA backup.
param([Parameter(Mandatory = $true)][string]$BackupDirectory)
$ErrorActionPreference = 'Stop'
$backup = (Resolve-Path -LiteralPath $BackupDirectory).Path
$manifest = Get-Content -LiteralPath (Join-Path $backup 'QA_BACKUP_MANIFEST.json') -Raw | ConvertFrom-Json
$target = [string]$manifest.backend_path
$paths = @('main.py','core/inference/checkpoint.py','core/inference/context_window.py','core/rag/conversation_archive.py','storage/studio_db.py')
$patch = Join-Path $PSScriptRoot 'qa-backend-patch\studio\backend'
foreach ($relative in $paths) {
    if (-not (Test-Path -LiteralPath (Join-Path $backup $relative))) { throw "Incomplete backup. No changes made." }
    if (-not (Test-Path -LiteralPath (Join-Path $target $relative))) { throw "Installed backend missing a patched file. No changes made." }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target $relative)).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $patch $relative)).Hash) {
        throw "Installed code changed after QA patch at $relative. Refusing to overwrite it."
    }
}
$newFile = Join-Path $target 'utils/context_latency_trace.py'
if (-not (Test-Path -LiteralPath $newFile)) { throw "QA instrumentation module is missing. No changes made." }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $newFile).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $patch 'utils/context_latency_trace.py')).Hash) {
    throw "The instrumentation module differs from the QA build. No changes made."
}
foreach ($relative in $paths) {
    Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination (Join-Path $target $relative) -Force
}
Remove-Item -LiteralPath $newFile
Write-Host 'Original backend code restored; QA module removed. Restart Unsloth Studio.'
