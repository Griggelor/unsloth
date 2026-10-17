# SPDX-License-Identifier: AGPL-3.0-only
# Interactive local-only import of normal Unsloth chats into this QA package.
param([string]$SourceDb, [switch]$Replace)
$ErrorActionPreference = 'Stop'
$here = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$runtime = Join-Path $here 'qa-runtime'
$py = Join-Path $runtime 'studio\unsloth_studio\Scripts\python.exe'
if (Get-Process -Name 'Unsloth-Context-QA-Portable' -ErrorAction SilentlyContinue) {
    throw 'Close the portable Unsloth QA application before importing chats.'
}
if (-not (Test-Path -LiteralPath $py -PathType Leaf)) {
    throw 'Private QA Python not found. Extract the entire portable build first.'
}
if (-not $SourceDb) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Select ORIGINAL Unsloth studio.db (read-only source)'
    $dialog.Filter = 'Unsloth Studio database (studio.db)|studio.db|SQLite database (*.db)|*.db'
    $default = Join-Path $env:USERPROFILE '.unsloth\studio'
    if (Test-Path -LiteralPath $default -PathType Container) {
        $dialog.InitialDirectory = $default
    }
    $dialog.FileName = 'studio.db'
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host 'Import cancelled. Nothing was changed.'
        exit 1
    }
    $SourceDb = $dialog.FileName
}
$dest = Join-Path $runtime 'studio\studio.db'
Write-Host "Read-only source: $SourceDb"
Write-Host "PRIVATE QA destination: $dest"
Write-Host 'The snapshot includes all records in studio.db (including app settings).'
Write-Host 'Chat original attachments are copied separately where available.'
Write-Host 'Any embedded absolute project/model paths remain in the copied data.'
$answer = Read-Host 'Proceed with this LOCAL import? Type IMPORT to confirm'
if ($answer -cne 'IMPORT') { throw 'Import cancelled.' }
& (Join-Path $here 'Assert-Portable-Python.ps1') -RuntimeRoot $runtime
$arguments = @('-I', '-B', (Join-Path $here 'Import-Chat-Database.py'), '--source', $SourceDb)
if ($Replace) { $arguments += '--replace' }
& $py @arguments
if ($LASTEXITCODE -ne 0) { throw "QA database import failed (exit $LASTEXITCODE)" }
Write-Host 'Import finished. Start the QA app with Start-Portable-QA.cmd.'
