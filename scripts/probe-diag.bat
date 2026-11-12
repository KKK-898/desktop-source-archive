@echo off
chcp 65001 >nul 2>&1
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0probe-diag.ps1"
if errorlevel 1 (
  echo.
  echo Probe failed. Please screenshot this window and send it back.
  pause
)
endlocal
