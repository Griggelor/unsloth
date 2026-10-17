@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Import-Chat-Database.ps1" %*
if errorlevel 1 (
  echo Chat database was NOT imported. Review the message above.
  pause
  exit /b 1
)
