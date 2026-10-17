# SPDX-License-Identifier: AGPL-3.0-only
# Windows CI: real relocated payload, HTTP liveness, and synthetic host canary.
param([Parameter(Mandatory = $true)][string]$PackageRoot,
      [Parameter(Mandatory = $true)][string]$SourceSHA)
$ErrorActionPreference = 'Stop'
$origin = (Resolve-Path -LiteralPath $PackageRoot).Path
$moved = Join-Path $env:RUNNER_TEMP 'Entire QA package Ü ö with spaces'
$hostProfile = Join-Path $env:RUNNER_TEMP 'synthetic-NORMAL-Unsloth-profile'
if ((Test-Path -LiteralPath $moved) -or (Test-Path -LiteralPath $hostProfile)) {
    throw 'Isolation precondition: relocation or synthetic host profile already exists'
}
$hostStudio = Join-Path $hostProfile '.unsloth\studio'
New-Item -ItemType Directory -Force -Path $hostStudio | Out-Null
$hostCanary = Join-Path $hostStudio 'normal-chats-must-not-change.txt'
[IO.File]::WriteAllText($hostCanary, 'SYNTHETIC-NORMAL-PROFILE-CANARY-NO-USER-DATA')
$canaryBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $hostCanary).Hash
Move-Item -LiteralPath $origin -Destination $moved
$process = $null
try {
    $runtime = Join-Path $moved 'qa-runtime'
    $studio = Join-Path $runtime 'studio'
    $py = Join-Path $studio 'unsloth_studio\Scripts\python.exe'
    $manifest = Get-Content -LiteralPath (Join-Path $moved 'QA_MANIFEST.json') -Raw | ConvertFrom-Json
    if ($manifest.source_sha -ne $SourceSHA) { throw 'Manifest source SHA mismatch' }
    $expectedHash = @{
        'Unsloth-Context-QA-Portable.exe' = $manifest.exe_sha256
        'qa-runtime\studio\unsloth_studio\Scripts\python.exe' = $manifest.python_sha256
        'qa-runtime\studio\unsloth_studio\Lib\site-packages\studio\backend\utils\context_latency_trace.py' = $manifest.diagnostic_sha256
    }
    foreach ($entry in $expectedHash.GetEnumerator()) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $moved $entry.Key)).Hash
        if ($hash -ne $entry.Value) { throw "Relocated manifest digest mismatch: $($entry.Key)" }
    }
    & (Join-Path $moved 'Assert-Portable-Python.ps1') -RuntimeRoot $runtime

    # Poison a synthetic normal profile. Resolved database/auth paths must stay private.
    $env:USERPROFILE = $hostProfile
    $env:UNSLOTH_HOME = $runtime
    $env:UNSLOTH_STUDIO_HOME = $studio
    $env:UNSLOTH_PORTABLE = '1'
    $env:UNSLOTH_CONTEXT_LATENCY_TRACE = '1'
    $env:UNSLOTH_NO_TORCH = '1'
    $env:HF_HOME = Join-Path $runtime 'hf-cache'
    $env:UNSLOTH_LLAMA_CPP_PATH = Join-Path $runtime 'llama.cpp'
    $env:UNSLOTH_STUDIO_PROJECTS_HOME = Join-Path $studio 'projects'
    $env:UNSLOTH_STUDIO_SANDBOX_HOME = Join-Path $studio 'sandboxes'
    $env:PYTHONNOUSERSITE = '1'
    foreach ($key in @('STUDIO_HOME','STUDIO_LOCAL_REPO','PYTHONHOME','PYTHONPATH','HF_TOKEN','HUGGING_FACE_HUB_TOKEN')) {
        Remove-Item "Env:$key" -ErrorAction SilentlyContinue
    }
    $pathCheck = 'import os,pathlib; import sys; sys.path.insert(0,str(pathlib.Path(sys.prefix)/"Lib/site-packages/studio/backend")); from utils.paths import storage_roots as p; r=pathlib.Path(os.environ["UNSLOTH_HOME"]).resolve(); names=("studio_root","studio_db_path","rag_db_path","auth_db_path","project_workspaces_root","outputs_root","exports_root"); paths=[getattr(p,x)().resolve() for x in names]; assert all(q.is_relative_to(r) for q in paths),paths; assert p.studio_root()==pathlib.Path(os.environ["UNSLOTH_STUDIO_HOME"]).resolve(); print("QA_STORAGE_PATHS_PRIVATE")'
    & $py -I -c $pathCheck
    if ($LASTEXITCODE -ne 0) { throw 'Python chat/RAG/auth database private-root assertions failed' }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $py
    $psi.WorkingDirectory = $studio
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    foreach ($arg in @('-X','utf8','-I','-c',
        "import sys; sys.argv[0]='unsloth'; from unsloth_cli import app; sys.exit(app())",
        'studio','--api-only','-H','127.0.0.1','-p',"$port")) {
        [void]$psi.ArgumentList.Add($arg)
    }
    foreach ($key in @('USERPROFILE','UNSLOTH_HOME','UNSLOTH_STUDIO_HOME',
                      'UNSLOTH_PORTABLE','UNSLOTH_CONTEXT_LATENCY_TRACE',
                      'UNSLOTH_NO_TORCH','HF_HOME','UNSLOTH_LLAMA_CPP_PATH',
                      'UNSLOTH_STUDIO_PROJECTS_HOME','UNSLOTH_STUDIO_SANDBOX_HOME','PYTHONNOUSERSITE')) {
        $psi.Environment[$key] = [Environment]::GetEnvironmentVariable($key)
    }
    foreach ($key in @('STUDIO_HOME','STUDIO_LOCAL_REPO','PYTHONHOME','PYTHONPATH',
                       'HF_TOKEN','HUGGING_FACE_HUB_TOKEN','HUGGINGFACE_HUB_TOKEN')) {
        [void]$psi.Environment.Remove($key)
    }
    $process = [System.Diagnostics.Process]::Start($psi)
    if (-not $process) { throw 'Could not launch private backend process' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $alive = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(150)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) { break }
        try {
            $reply = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/liveness" -TimeoutSec 3
            if ($reply.service -eq 'Unsloth UI Backend' -and $reply.status -in @('alive','healthy')) {
                $alive = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 750
    }
    if (-not $alive) {
        if (-not $process.HasExited) {
            $process.Kill($true)
            $process.WaitForExit(10000) | Out-Null
        }
        $e = $stderr.GetAwaiter().GetResult()
        $o = $stdout.GetAwaiter().GetResult()
        $tail = "$o" + [Environment]::NewLine + "$e"
        if ($tail.Length -gt 3000) { $tail = $tail.Substring($tail.Length - 3000) }
        throw "Relocated independent backend never became healthy on loopback. Diagnostic tail: $tail"
    }
    Write-Host "Relocated private backend HTTP liveness PASS at 127.0.0.1:$port"
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $hostCanary).Hash -ne $canaryBefore) {
        throw 'SYNTHETIC HOST CHAT CANARY CHANGED'
    }
} finally {
    if ($process) {
        try {
            if (-not $process.HasExited) { $process.Kill($true) }
            $process.WaitForExit(10000) | Out-Null
        } catch { }
        $process.Dispose()
    }
    if (Test-Path -LiteralPath $moved) { Move-Item -LiteralPath $moved -Destination $origin }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $hostCanary).Hash -ne $canaryBefore) {
        throw 'Synthetic normal installation canary was modified'
    }
    Remove-Item -LiteralPath $hostProfile -Recurse -Force
}
