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
$base = @(Get-ChildItem -LiteralPath (Join-Path $studio 'python') -Recurse -File -Filter python.exe |
    Where-Object { $_.FullName -notlike '*\Scripts\*' })
# uv can leave both the floating-minor runtime and its exact-patch runtime in a
# private QA tree (e.g. cpython-3.13-* and cpython-3.13.14-*). This is safe to
# resolve ONLY when it is precisely this pair, in our own runtime tree, and the
# exact-patch interpreter proves its own private prefix and stdlib imports.
if ($base.Count -eq 2) {
    $floatingPattern = '^cpython-(?<minor>\d+\.\d+)-windows-(?<arch>x86_64|aarch64)-none$'
    $exactPattern = '^cpython-(?<version>\d+\.\d+\.\d+)-windows-(?<arch>x86_64|aarch64)-none$'
    $floating = @($base | Where-Object { $_.Directory.Name -match $floatingPattern })
    $exact = @($base | Where-Object { $_.Directory.Name -match $exactPattern })
    if ($floating.Count -eq 1 -and $exact.Count -eq 1) {
        $shortMatch = [regex]::Match($floating[0].Directory.Name, $floatingPattern,
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $exactMatch = [regex]::Match($exact[0].Directory.Name, $exactPattern,
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $version = $exactMatch.Groups['version'].Value
        $minor = $shortMatch.Groups['minor'].Value
        $architectureMatches = $shortMatch.Groups['arch'].Value -eq $exactMatch.Groups['arch'].Value
        if (-not $architectureMatches -or -not $version.StartsWith("${minor}.", [StringComparison]::Ordinal)) {
            throw 'Conflicting private CPython runtime versions; refusing to guess or use host Python'
        }
        $checkPrivateBase = 'import sys,pathlib; root=pathlib.Path(sys.argv[1]).resolve(); expected=sys.argv[2]; assert pathlib.Path(sys.prefix).resolve()==root,(sys.prefix,root); assert pathlib.Path(sys.base_prefix).resolve()==root,(sys.base_prefix,root); assert all(not p or pathlib.Path(p).resolve().is_relative_to(root) for p in sys.path),(sys.path,root); actual="{}.{}.{}".format(*sys.version_info[:3]); assert actual==expected,(actual,expected); import encodings,sqlite3; assert pathlib.Path(encodings.__file__).resolve().is_relative_to(root); assert pathlib.Path(sqlite3.__file__).resolve().is_relative_to(root)'
        & $exact[0].FullName -I -c $checkPrivateBase $exact[0].DirectoryName $version
        if ($LASTEXITCODE -ne 0) { throw 'Exact private CPython cannot prove its runtime isolation' }
        $base = @($exact[0])
        Write-Host "Portable QA: selected validated exact CPython $version from two private runtimes."
    }
}
if ($base.Count -ne 1) { throw 'Ambiguous or missing private CPython; no host fallback allowed' }
$baseExe = $base[0].FullName
$baseDir = $base[0].DirectoryName
$content = [System.IO.File]::ReadAllText($cfg)
if ($content -notmatch '(?m)^home\s*=') { throw 'No Python venv base runtime declaration' }
$content = [Text.RegularExpressions.Regex]::Replace($content, '(?m)^home\s*=.*$', ('home = ' + $baseDir.Replace('$', '$$')))
$content = [Text.RegularExpressions.Regex]::Replace($content, '(?m)^executable\s*=.*$', ('executable = ' + $baseExe.Replace('$', '$$')))
[IO.File]::WriteAllText($cfg, $content, [Text.UTF8Encoding]::new($false))
# -I drops Python environment and user site, detects missing private stdlib rather than silently falling back.
$check = 'import sys,pathlib; s=pathlib.Path(sys.argv[1]).resolve(); v=(s/"unsloth_studio").resolve(); b=pathlib.Path(sys.base_prefix).resolve(); assert pathlib.Path(sys.prefix).resolve()==v,(sys.prefix,v); assert b == pathlib.Path(sys.argv[2]).resolve(),(b,sys.argv[2]); assert pathlib.Path(sys.executable).resolve()==(v/"Scripts/python.exe").resolve(); assert all(not p or pathlib.Path(p).resolve().is_relative_to(s) for p in sys.path),(sys.path,s); import studio.backend.utils.context_latency_trace as m; assert pathlib.Path(m.__file__).resolve().is_relative_to(v); import unsloth_cli; assert pathlib.Path(unsloth_cli.__file__).resolve().is_relative_to(v)'
& $py -I -c $check $studio $baseDir
if ($LASTEXITCODE -ne 0) { throw 'Relocated Python private-prefix/import check failed; refusing system backend' }
