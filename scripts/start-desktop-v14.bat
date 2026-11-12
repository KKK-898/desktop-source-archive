@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-desktop-standalone.ps1" -ExecutablePath "%~dp0..\src-tauri\target\standalone-v14\debug\gaoge-free.exe"
if errorlevel 1 (
  echo.
  echo Close the running Gaoge client from its tray menu, then try again.
  pause
  exit /b 1
)
endlocal
