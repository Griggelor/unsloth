# SPDX-License-Identifier: AGPL-3.0-only
# Isolated Windows QA launcher. No installed Studio files are read or patched.
$ErrorActionPreference = 'Stop'
$here = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$root = Join-Path $here 'qa-runtime'
$studio = Join-Path $root 'studio'
$venv = Join-Path $studio 'unsloth_studio'
$py = Join-Path $venv 'Scripts\python.exe'
$cfg = Join-Path $venv 'pyvenv.cfg'
$exe = Join-Path $here 'Unsloth-Context-QA-Portable.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Portable QA EXE missing; unpack the whole ZIP first." }
if (-not (Test-Path -LiteralPath $cfg -PathType Leaf) -or -not (Test-Path -LiteralPath $py -PathType Leaf)) {
    throw "Portable QA Python backend missing; this is NOT a complete standalone package."
}
$baseline = Join-Path $venv 'Lib\site-packages\studio\backend\utils\context_latency_trace.py'
if (-not (Test-Path -LiteralPath $baseline -PathType Leaf)) {
    throw "Instrumented backend missing from private Python environment. Refusing normal installed backend."
}
$baseInterpreters = @(Get-ChildItem -LiteralPath (Join-Path $studio 'python') -Recurse -File -Filter python.exe |
  Where-Object { $_.FullName -notlike '*\Scripts\*' })
if ($baseInterpreters.Count -ne 1) { throw "QA Python runtime ambiguous or missing; refusing to use system Python." }
$baseDir = $baseInterpreters[0].DirectoryName
$content = [System.IO.File]::ReadAllText($cfg)
if ($content -notmatch '(?m)^home\s*=') { throw "QA Python venv is missing its base runtime declaration." }
$replacement = 'home = ' + $baseDir.Replace('$', '$$')
$content = [System.Text.RegularExpressions.Regex]::Replace($content, '(?m)^home\s*=.*$', $replacement)
# uv may also store absolute base executable references in its metadata.
$content = [System.Text.RegularExpressions.Regex]::Replace(
    $content, '(?m)^executable\s*=.*$', 'executable = ' + $baseInterpreters[0].FullName.Replace('$', '$$'))
[System.IO.File]::WriteAllText($cfg, $content, [System.Text.UTF8Encoding]::new($false))
# Never use regular Unsloth settings, home, caches, model paths or token data.
$env:UNSLOTH_HOME = $root
$env:UNSLOTH_STUDIO_HOME = $studio
$env:UNSLOTH_PORTABLE = '1'
$env:HF_HOME = Join-Path $root 'hf-cache'
$env:UNSLOTH_LLAMA_CPP_PATH = Join-Path $root 'llama.cpp'
$env:UNSLOTH_CONTEXT_LATENCY_TRACE = '1'
$env:UNSLOTH_STUDIO_PROJECTS_HOME = Join-Path $studio 'projects'
$env:UNSLOTH_STUDIO_SANDBOX_HOME = Join-Path $studio 'sandboxes'
$env:PYTHONNOUSERSITE = '1'
Remove-Item Env:STUDIO_HOME, Env:STUDIO_LOCAL_REPO -ErrorAction SilentlyContinue
$env:PYTHONPATH = ''
$env:VIRTUAL_ENV = $venv
$test = 'import sys, pathlib; v=pathlib.Path(sys.prefix).resolve(); b=pathlib.Path(sys.base_prefix).resolve(); s=pathlib.Path(sys.argv[1]).resolve(); assert v == s/"unsloth_studio", (v,s); assert s in b.parents, (b,s); import studio.backend.utils.context_latency_trace'
& $py -I -c $test $studio
if ($LASTEXITCODE -ne 0) { throw "Portable QA Python integrity check failed. The system backend will not be used." }
Write-Host "Starting self-contained Unsloth Context QA from $root"
Write-Host "No installed Unsloth Python, database or settings files are modified."
Start-Process -FilePath $exe -WorkingDirectory $here
