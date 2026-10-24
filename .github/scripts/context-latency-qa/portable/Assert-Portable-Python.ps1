# SPDX-License-Identifier: AGPL-3.0-only
# Runs on both the Windows CI relocation path and every user launch.
param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
$studio = Join-Path $RuntimeRoot 'studio'
$venv = Join-Path $studio 'unsloth_studio'
$py = Join-Path $venv 'Scripts\python.exe'
$cfg = Join-Path $venv 'pyvenv.cfg'
$trace = Join-Path $venv 'Lib\site-packages\studio\backend\utils\context_latency_trace.py'
$llama = Join-Path $RuntimeRoot 'llama.cpp'
foreach ($file in @($py, $cfg, $trace)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Portable QA component missing: $file" }
}
if (-not (Test-Path -LiteralPath $llama -PathType Container)) { throw 'Private llama.cpp runtime missing' }
# The portable may carry several CPython patch versions. Only the exact
# version recorded by this private venv is a valid base for this launcher.
$pythonRoot = Join-Path $studio 'python'
if (-not (Test-Path -LiteralPath $pythonRoot -PathType Container)) { throw 'Private CPython directory missing' }
$content = [System.IO.File]::ReadAllText($cfg)
$match = [regex]::Match($content, '(?m)^version\s*=\s*(\d+\.\d+\.\d+)\s*$')
if (-not $match.Success) { throw 'Private venv has no exact Python patch version; refusing to guess' }
$version = $match.Groups[1].Value
$prefix = "cpython-$version-"
$all = @(Get-ChildItem -LiteralPath $pythonRoot -Recurse -File -Filter python.exe |
    Where-Object { $_.FullName -notlike '*\\Scripts\\*' })
$base = @($all | Where-Object { $_.Directory.Name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
if ($base.Count -ne 1) {
    $found = @($all | ForEach-Object { $_.FullName }) -join '; '
    throw "Ambiguous or missing PRIVATE CPython $version (matches=$($base.Count), found=$found); no host fallback allowed"
}
$baseExe = $base[0].FullName
$baseDir = $base[0].DirectoryName
Write-Host "Private CPython selected: $version ($baseDir)"
$content = [System.IO.File]::ReadAllText($cfg)
if ($content -notmatch '(?m)^home\s*=') { throw 'No Python venv base runtime declaration' }
$content = [Text.RegularExpressions.Regex]::Replace($content, '(?m)^home\s*=.*$', ('home = ' + $baseDir.Replace('$', '$$')))
$content = [Text.RegularExpressions.Regex]::Replace($content, '(?m)^executable\s*=.*$', ('executable = ' + $baseExe.Replace('$', '$$')))
[IO.File]::WriteAllText($cfg, $content, [Text.UTF8Encoding]::new($false))
# Use an on-disk Python validation script. PowerShell 5.1 can corrupt quoted
# string literals inside python -c when marshaling native Windows argv.
$checkPath = Join-Path $PSScriptRoot 'Assert-Portable-Python-Check.py'
if (-not (Test-Path -LiteralPath $checkPath -PathType Leaf)) {
    throw "Private portable validator missing: $checkPath"
}
& $py -I -B $checkPath $studio $baseDir
if ($LASTEXITCODE -ne 0) { throw 'Relocated Python private-prefix/import check failed; refusing system backend' }
