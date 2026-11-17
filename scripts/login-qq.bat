@echo off
chcp 65001 >nul
cd /d "%~dp0..\vendor\napcat"
call launcher-user.bat %*
