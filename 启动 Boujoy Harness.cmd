@echo off
setlocal
set "ROOT=%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Start-Boujoy.ps1" -Root "%ROOT%" -Check
if errorlevel 1 (
  echo.
  echo Boujoy Harness needs first-time setup.
  choice /C YN /N /M "Run guided setup now? [Y/N] "
  if errorlevel 2 exit /b 1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Setup-Boujoy.ps1" -Root "%ROOT%"
  if errorlevel 1 (
    pause
    exit /b 1
  )
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Start-Boujoy.ps1" -Root "%ROOT%" -Check
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

start "Boujoy Harness" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0windows\Start-Boujoy.ps1" -Root "%ROOT%"
exit /b 0
