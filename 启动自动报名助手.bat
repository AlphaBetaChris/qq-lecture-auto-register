@echo off
chcp 65001 >nul
cd /d "%~dp0qqwithoutgui"
start "AutoRegisterApp" cmd /k run-auto-register-app.bat %*
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:39212"
start "QQNapCatLogin" cmd /k launcher-user.bat
