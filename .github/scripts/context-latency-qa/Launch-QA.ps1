# Run only after Apply-QA-Backend.ps1 has succeeded on a matching test installation.
param([string]$BackendPath = (Join-Path $env:USERPROFILE '.unsloth\studio\unsloth_studio\Lib\site-packages\studio\backend'))
$ErrorActionPreference = 'Stop'
$instrument = Join-Path $BackendPath 'utils/context_latency_trace.py'
$expected = Join-Path $PSScriptRoot 'qa-backend-patch\studio\backend\utils\context_latency_trace.py'
if (-not (Test-Path -LiteralPath $instrument)) { throw 'Instrumented backend not installed. First run Apply-QA-Backend.ps1 in an isolated matching test installation.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $instrument).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $expected).Hash) { throw 'Backend instrumentation mismatch. Refusing to launch an unverified test.' }
$exe = Join-Path $PSScriptRoot 'unsloth-studio-CONTEXT-QA-UNSIGNED.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'QA EXE is missing.' }
$env:UNSLOTH_CONTEXT_LATENCY_TRACE = '1'
Write-Host 'Context latency instrumentation enabled for the launched app and its new Python child. Fully quit existing Studio and backend processes before launching.'
Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot
