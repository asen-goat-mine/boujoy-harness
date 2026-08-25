@echo off
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Setup-Boujoy.ps1" -Root "%ROOT%"
if errorlevel 1 pause
