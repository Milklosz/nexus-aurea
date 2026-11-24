@echo off
rem VELORA 3.0 first-frame recovery - portable validation candidate.
setlocal DisableDelayedExpansion
if not exist "%~dp0nexus-aurea.exe" (
  echo VELORA portable executable is missing. 1>&2
  exit /b 2
)
echo VELORA 3.0 portable validation candidate
echo Startup logs are in "%~dp0VELORA-Portable-Data".
"%~dp0nexus-aurea.exe" %*
set "VELORA_EXIT_CODE=%ERRORLEVEL%"
if not "%VELORA_EXIT_CODE%"=="0" echo VELORA exited with code %VELORA_EXIT_CODE%. Check the startup log. 1>&2
exit /b %VELORA_EXIT_CODE%
