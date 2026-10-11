# SPDX-License-Identifier: AGPL-3.0-only
# Windows-only local numeric QA. Do not upload private chats, logs or dumps.
# Example: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\tests\studio\windows_agent_history_unlock_probe.ps1 -Minutes 15
param(
  [ValidateRange(2,60)][int]$Minutes = 15,
  [ValidateSet('NoScroll','ScrollAfter30s')][string]$Scenario = 'NoScroll'
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows-only test.' }
Add-Type -ReferencedAssemblies @('System.Windows.Forms','System.Drawing') -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class AgentSessionEvent {
  public readonly string Kind;
  public readonly DateTime TimeUtc;
  public AgentSessionEvent(string kind) { Kind=kind; TimeUtc=DateTime.UtcNow; }
}
public sealed class AgentUnlockNotifier : Form {
  private const int SESSION_MSG = 0x02B1;
  private bool registered;
  public readonly ConcurrentQueue<AgentSessionEvent> Events =
    new ConcurrentQueue<AgentSessionEvent>();
  [DllImport("wtsapi32.dll", SetLastError=true)]
  private static extern bool WTSRegisterSessionNotification(IntPtr hwnd, int flags);
  [DllImport("wtsapi32.dll", SetLastError=true)]
  private static extern bool WTSUnRegisterSessionNotification(IntPtr hwnd);
  public AgentUnlockNotifier() {
    ShowInTaskbar=false; FormBorderStyle=FormBorderStyle.FixedToolWindow;
    StartPosition=FormStartPosition.Manual; Location=new Point(-20000,-20000);
    Opacity=0; Width=1; Height=1;
  }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    if(!WTSRegisterSessionNotification(Handle,0))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot register session notifications");
    registered=true;
  }
  protected override void WndProc(ref Message m) {
    if(m.Msg == SESSION_MSG) {
      if(m.WParam.ToInt32() == 7) Events.Enqueue(new AgentSessionEvent("LOCK"));
      if(m.WParam.ToInt32() == 8) Events.Enqueue(new AgentSessionEvent("UNLOCK"));
    }
    base.WndProc(ref m);
  }
  protected override void OnHandleDestroyed(EventArgs e) {
    if(registered) { WTSUnRegisterSessionNotification(Handle); registered=false; }
    base.OnHandleDestroyed(e);
  }
}
'@
$dir = Join-Path $env:LOCALAPPDATA 'UnslothQA'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$dest = Join-Path $dir ('unlock-numeric-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.csv')
$writer = New-Object System.IO.StreamWriter($dest, $false, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true
$writer.WriteLine('Utc,Scenario,Event,SecondsAfterUnlock,TotalRAM_MB,FreeRAM_MB,CommitMB,CommitLimitMB,WebView2Count,WebView2PrivateMB,WebView2WorkingMB,WebView2Handles,StudioCount,StudioPrivateMB,LlamaCount,LlamaPrivateMB,DwmPrivateMB,DwmWorkingMB,ProcessCount,ProbeCostMs')

function SumMB($items, [string]$field) {
  $total = 0.0
  foreach($item in $items) { try { $total += [double]$item.$field } catch {} }
  return [math]::Round($total / 1MB, 1)
}
function Sample([string]$phase, $lastUnlock) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $utc = [datetime]::UtcNow
  $seconds = if($null -ne $lastUnlock) { [math]::Round(($utc - $lastUnlock).TotalSeconds, 2) } else { -1 }
  $processes = @(Get-Process -ErrorAction SilentlyContinue)
  $web = @($processes | Where-Object { $_.ProcessName -ieq 'msedgewebview2' })
  $studio = @($processes | Where-Object { $_.ProcessName -match 'unsloth|studio' })
  $llama = @($processes | Where-Object { $_.ProcessName -match '^llama' })
  $dwm = @($processes | Where-Object { $_.ProcessName -ieq 'dwm' })
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  $mem = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue
  $handles = 0
  foreach($p in $web) { try { $handles += [int]$p.HandleCount } catch {} }
  $total = if($os) { [math]::Round([double]$os.TotalVisibleMemorySize / 1024, 1) } else { -1 }
  $free = if($os) { [math]::Round([double]$os.FreePhysicalMemory / 1024, 1) } else { -1 }
  $committed = if($mem) { [math]::Round([double]$mem.CommittedBytes / 1MB, 1) } else { -1 }
  $limit = if($mem) { [math]::Round([double]$mem.CommitLimit / 1MB, 1) } else { -1 }
  $sw.Stop()
  $row = @(
    $utc.ToString('o'),$Scenario,$phase,$seconds,$total,$free,$committed,$limit,
    $web.Count,(SumMB $web 'PrivateMemorySize64'),(SumMB $web 'WorkingSet64'),$handles,
    $studio.Count,(SumMB $studio 'PrivateMemorySize64'),
    $llama.Count,(SumMB $llama 'PrivateMemorySize64'),
    (SumMB $dwm 'PrivateMemorySize64'),(SumMB $dwm 'WorkingSet64'),
    $processes.Count,$sw.ElapsedMilliseconds
  )
  $writer.WriteLine(($row -join ','))
}
$form=$null
try {
  $form = New-Object AgentUnlockNotifier
  $null = $form.Handle
  $lastUnlock = $null
  $locked = $false
  $lastSample = [datetime]::MinValue
  $end = [datetime]::UtcNow.AddMinutes($Minutes)
  Write-Host "Numeric-only local CSV: $dest"
  Write-Host 'Manually lock using Win+L, then manually sign back in.'
  if($Scenario -eq 'NoScroll') {
    Write-Host 'First run: NO scrolling for at least 30 seconds after unlock.'
  } else {
    Write-Host 'Second supervised run: wait 30 seconds after unlock, then scroll gently.'
  }
  Write-Host 'No passwords, chats, command lines, paths, screenshots or crash dumps are collected.'
  Sample 'START' $lastUnlock
  while([datetime]::UtcNow -lt $end) {
    [System.Windows.Forms.Application]::DoEvents()
    $event = $null
    while($form.Events.TryDequeue([ref]$event)) {
      $locked = $event.Kind -eq 'LOCK'
      if($event.Kind -eq 'UNLOCK') { $lastUnlock = $event.TimeUtc }
      Write-Host "$($event.Kind) at $($event.TimeUtc.ToString('o'))"
      Sample $event.Kind $lastUnlock
      $lastSample = [datetime]::UtcNow
      $event = $null
    }
    $now = [datetime]::UtcNow
    $seconds = if($null -ne $lastUnlock) { ($now - $lastUnlock).TotalSeconds } else { -1 }
    $interval = if($seconds -ge 0 -and $seconds -lt 30) { 1 } else { 5 }
    if(($now - $lastSample).TotalSeconds -ge $interval) {
      $phase = if($locked) {'LOCKED'} elseif($seconds -ge 0 -and $seconds -lt 10) {
        'UNLOCK_0_10'
      } elseif($seconds -ge 10 -and $seconds -lt 30) {
        'UNLOCK_10_30'
      } elseif($seconds -ge 30) { 'UNLOCK_LATER' } else { 'PRE_LOCK' }
      Sample $phase $lastUnlock
      $lastSample = [datetime]::UtcNow
    }
    Start-Sleep -Milliseconds 100
  }
} finally {
  if($form) { $form.Dispose() }
  $writer.Flush(); $writer.Close()
  Write-Host "Local CSV only: $dest"
}
