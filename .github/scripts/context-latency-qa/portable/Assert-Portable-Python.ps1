# SPDX-License-Identifier: AGPL-3.0-only
# QA only. Supports Windows PowerShell 5.1 and PowerShell 7, never host Python.
param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
$studio = Join-Path $RuntimeRoot 'studio'
$venv = Join-Path $studio 'unsloth_studio'
$py = Join-Path $venv 'Scripts\python.exe'
$cfg = Join-Path $venv 'pyvenv.cfg'
$trace = Join-Path $venv 'Lib\site-packages\studio\backend\utils\context_latency_trace.py'
$llama = Join-Path $RuntimeRoot 'llama.cpp'
foreach ($file in @($py, $cfg, $trace)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Portable QA component missing: $file"
    }
}
if (-not (Test-Path -LiteralPath $llama -PathType Container)) {
    throw 'Private llama.cpp runtime missing'
}
$pythonRoot = Join-Path $studio 'python'
if (-not (Test-Path -LiteralPath $pythonRoot -PathType Container)) {
    throw 'Private CPython installation directory missing; no host fallback allowed'
}
$base = @(Get-ChildItem -LiteralPath $pythonRoot -Recurse -File -Filter python.exe |
    Where-Object { $_.FullName -notlike '*\Scripts\*' })

$expectedVersion = ''
if ($base.Count -eq 2) {
    # Windows uv can retain both a floating minor and an exact patch of the same CPython.
    $minorPattern = '^cpython-(?<minor>\d+\.\d+)-windows-(?<arch>x86_64|aarch64)-none$'
    $exactPattern = '^cpython-(?<version>\d+\.\d+\.\d+)-windows-(?<arch>x86_64|aarch64)-none$'
    $short = @($base | Where-Object { $_.Directory.Name -match $minorPattern })
    $exact = @($base | Where-Object { $_.Directory.Name -match $exactPattern })
    if ($short.Count -ne 1 -or $exact.Count -ne 1) {
        throw 'Ambiguous private CPython installations; refusing to select arbitrary interpreter'
    }
    $shortMatch = [regex]::Match($short[0].Directory.Name, $minorPattern)
    $exactMatch = [regex]::Match($exact[0].Directory.Name, $exactPattern)
    $expectedVersion = $exactMatch.Groups['version'].Value
    $minor = $shortMatch.Groups['minor'].Value
    if ($shortMatch.Groups['arch'].Value -ne $exactMatch.Groups['arch'].Value -or
        -not $expectedVersion.StartsWith(($minor + '.'), [System.StringComparison]::Ordinal)) {
        throw 'Conflicting CPython runtime versions; no host fallback allowed'
    }
    $base = @($exact[0])
}
if ($base.Count -ne 1) {
    throw 'Ambiguous or missing private CPython; no host fallback allowed'
}
$baseExe = $base[0].FullName
$baseDir = $base[0].DirectoryName

# Crucial: Windows PowerShell 5.1 strips nested double quotes in python -c arguments.
# Execute the probe from a short-lived source file located INSIDE the QA folder instead.
$probe = @'
import sys
import pathlib
import encodings
import sqlite3


def require(test, explanation):
    if not test:
        raise RuntimeError(explanation)

mode, studio_str, base_str = sys.argv[1:4]
studio = pathlib.Path(studio_str).resolve()
base = pathlib.Path(base_str).resolve()
require(base.is_relative_to(studio / 'python'), 'Base Python is outside private QA python tree')

if mode == 'base':
    expected_version = sys.argv[4] if len(sys.argv) > 4 else ''
    require(pathlib.Path(sys.executable).resolve().is_relative_to(base), 'Base executable not private')
    require(pathlib.Path(sys.prefix).resolve() == base, 'Base sys.prefix not private')
    require(pathlib.Path(sys.base_prefix).resolve() == base, 'Base sys.base_prefix not private')
    require(all(not p or pathlib.Path(p).resolve().is_relative_to(base) for p in sys.path),
            'Base sys.path includes paths outside private interpreter')
    require(pathlib.Path(encodings.__file__).resolve().is_relative_to(base), 'Encodings not private')
    require(pathlib.Path(sqlite3.__file__).resolve().is_relative_to(base), 'SQLite not private')
    if expected_version:
        actual = '.'.join(map(str, sys.version_info[:3]))
        require(actual == expected_version, 'Exact patch runtime does not match directory name')
elif mode == 'venv':
    venv = (studio / 'unsloth_studio').resolve()
    require(pathlib.Path(sys.prefix).resolve() == venv, 'Venv prefix outside QA')
    require(pathlib.Path(sys.base_prefix).resolve() == base, 'Venv base prefix mismatch')
    require(pathlib.Path(sys.executable).resolve() == (venv / 'Scripts' / 'python.exe').resolve(),
            'Venv executable mismatch')
    require(all(not p or pathlib.Path(p).resolve().is_relative_to(studio) for p in sys.path),
            'Venv sys.path includes paths outside QA studio')
    import studio.backend.utils.context_latency_trace as trace
    import unsloth_cli
    require(pathlib.Path(trace.__file__).resolve().is_relative_to(venv), 'Tracer outside QA')
    require(pathlib.Path(unsloth_cli.__file__).resolve().is_relative_to(venv), 'Unsloth CLI outside QA')
else:
    raise RuntimeError('Invalid private Python verification mode')
'@
$probePath = Join-Path $studio ('.qa-python-check-' + [guid]::NewGuid().ToString('N') + '.py')
try {
    [System.IO.File]::WriteAllText($probePath, $probe, [System.Text.UTF8Encoding]::new($false))
    & $baseExe -I -B $probePath base $studio $baseDir $expectedVersion
    if ($LASTEXITCODE -ne 0) {
        throw 'Private base CPython failed interpreter and stdlib confinement checks'
    }
    if ($expectedVersion) {
        Write-Host "Portable QA: selected validated exact CPython $expectedVersion from two private runtimes."
    }
    $content = [System.IO.File]::ReadAllText($cfg)
    if ($content -notmatch '(?m)^home\s*=') {
        throw 'No Python venv base runtime declaration'
    }
    $content = [Text.RegularExpressions.Regex]::Replace(
        $content, '(?m)^home\s*=.*$', ('home = ' + $baseDir.Replace('$', '$$')))
    $content = [Text.RegularExpressions.Regex]::Replace(
        $content, '(?m)^executable\s*=.*$', ('executable = ' + $baseExe.Replace('$', '$$')))
    [System.IO.File]::WriteAllText($cfg, $content, [System.Text.UTF8Encoding]::new($false))
    & $py -I -B $probePath venv $studio $baseDir
    if ($LASTEXITCODE -ne 0) {
        throw 'Relocated QA venv failed private prefix, module or import validation'
    }
} finally {
    if (Test-Path -LiteralPath $probePath) {
        Remove-Item -LiteralPath $probePath -Force
    }
}
