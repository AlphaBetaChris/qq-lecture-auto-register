@echo off
chcp 65001 >nul
cd /d "%~dp0"
node lecture-auto-register\index.mjs --login
pause
