@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  node lecture-auto-register\index.mjs --app
) else (
  node lecture-auto-register\index.mjs %*
)
pause
