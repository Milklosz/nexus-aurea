@echo off
rem VELORA 2.0 portable validation candidate - double-click launcher.
rem Delegates to the PowerShell script so the isolated environment is always
rem configured before nexus-aurea.exe starts. No installer and no elevation.
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-VELORA-Portable.ps1" %*
exit /b %ERRORLEVEL%
