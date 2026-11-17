@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Installing application dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
start "AutoRegisterApp" cmd /k npm run app
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:39212"
start "QQNapCatLogin" cmd /k "cd /d vendor\napcat && launcher-user.bat"
