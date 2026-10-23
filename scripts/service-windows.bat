@echo off
setlocal

if "%~1"=="" goto usage

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass ^
  -File "%~dp0service-windows.ps1" %*
exit /b %ERRORLEVEL%

:usage
echo Usage: %~nx0 ^<start^|stop^|restart^|disable^|enable^|status^> [-TaskName NAME]
exit /b 2
