@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Portable-QA.ps1"
if errorlevel 1 (
  echo Portable QA did not start; see the error above.
  pause
  exit /b 1
)
