@echo off
chcp 65001 >nul
cd /d "%~dp0qqwithoutgui"
call launcher-user.bat %*
