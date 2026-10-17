# SPDX-License-Identifier: AGPL-3.0-only
# QA-only: never patch, launch or inspect the user's normal Unsloth installation.
$ErrorActionPreference = 'Stop'
$here = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$root = Join-Path $here 'qa-runtime'
$studio = Join-Path $root 'studio'
$exe = Join-Path $here 'Unsloth-Context-QA-Portable.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Portable QA EXE missing; unpack the entire artifact.' }
$env:UNSLOTH_HOME = $root
$env:UNSLOTH_STUDIO_HOME = $studio
$env:UNSLOTH_PORTABLE = '1'
$env:HF_HOME = Join-Path $root 'hf-cache'
$env:UNSLOTH_LLAMA_CPP_PATH = Join-Path $root 'llama.cpp'
$env:UNSLOTH_CONTEXT_LATENCY_TRACE = '1'
$env:UNSLOTH_STUDIO_PROJECTS_HOME = Join-Path $studio 'projects'
$env:UNSLOTH_STUDIO_SANDBOX_HOME = Join-Path $studio 'sandboxes'
$env:PYTHONNOUSERSITE = '1'
foreach ($key in @('STUDIO_HOME', 'STUDIO_LOCAL_REPO', 'PYTHONPATH', 'PYTHONHOME',
                   'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_HUB_TOKEN',
                   'UNSLOTH_AUTH_TOKEN', 'UNSLOTH_API_KEY', 'OPENAI_API_KEY')) {
    Remove-Item "Env:$key" -ErrorAction SilentlyContinue
}
$env:VIRTUAL_ENV = Join-Path $studio 'unsloth_studio'
& (Join-Path $here 'Assert-Portable-Python.ps1') -RuntimeRoot $root
if ($LASTEXITCODE -ne 0) { throw 'Portable Python integrity check failed' }
$env:UNSLOTH_CONTEXT_QA_VALIDATED = '1'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root 'webview2-private'
Write-Host "Starting isolated context-latency QA: $here"
Start-Process -FilePath $exe -WorkingDirectory $here
