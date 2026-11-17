@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if "%~1"=="" (
  call npm run app
) else (
  node app\index.mjs %*
)
pause
