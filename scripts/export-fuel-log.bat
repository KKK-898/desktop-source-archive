@echo off
chcp 65001 >nul 2>&1
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export-fuel-log.ps1"
if errorlevel 1 (
  echo.
  echo Export failed. Please take a screenshot of this window and send it back.
  pause
)
endlocal
