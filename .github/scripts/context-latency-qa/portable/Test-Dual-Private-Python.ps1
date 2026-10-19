# SPDX-License-Identifier: AGPL-3.0-only
# Windows CI only: synthesise uv's floating-minor + exact-patch CPython pair.
param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
$studio = Join-Path $RuntimeRoot 'studio'
$pythonHome = Join-Path $studio 'python'
$bases = @(Get-ChildItem -LiteralPath $pythonHome -Recurse -File -Filter python.exe |
    Where-Object { $_.FullName -notlike '*\Scripts\*' })
if ($bases.Count -ne 1) { throw 'Dual-Python test requires precisely one initial runtime' }
$source = $bases[0].Directory.FullName
$version = (& $bases[0].FullName -I -c 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))' | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Could not read private CPython version' }
$minor = ($version -split '\.')[0..1] -join '.'
$arch = if ($bases[0].Directory.Name -match '-windows-(x86_64|aarch64)-none$') { $Matches[1] } else { throw 'Unexpected uv Python architecture' }
$floating = Join-Path $pythonHome "cpython-$minor-windows-$arch-none"
$exact = Join-Path $pythonHome "cpython-$version-windows-$arch-none"
if ($source -ne $floating -and $source -ne $exact) { throw 'Unexpected uv Python package directory' }
$moveSource = $source -eq $floating
$alias = $floating
if ($moveSource) {
    if (Test-Path -LiteralPath $exact) { throw 'Exact runtime already exists before test' }
    Move-Item -LiteralPath $floating -Destination $exact
} elseif (Test-Path -LiteralPath $floating) {
    throw 'Floating alias already exists before test'
}
try {
    New-Item -ItemType Directory -Path $alias -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath (Join-Path $exact 'python.exe') -Destination (Join-Path $alias 'python.exe')
    $found = @(Get-ChildItem -LiteralPath $pythonHome -Recurse -File -Filter python.exe |
        Where-Object { $_.FullName -notlike '*\Scripts\*' })
    if ($found.Count -ne 2) { throw 'Dual-Python regression did not create two candidates' }
    & (Join-Path $PSScriptRoot 'Assert-Portable-Python.ps1') -RuntimeRoot $RuntimeRoot
    Write-Host 'Dual private CPython version alias regression PASS.'
} finally {
    if (Test-Path -LiteralPath $alias) { Remove-Item -LiteralPath $alias -Recurse -Force }
    if ($moveSource -and (Test-Path -LiteralPath $exact)) {
        Move-Item -LiteralPath $exact -Destination $floating
    }
}
& (Join-Path $PSScriptRoot 'Assert-Portable-Python.ps1') -RuntimeRoot $RuntimeRoot
