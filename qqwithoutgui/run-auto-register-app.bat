@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:39212/api/status' -TimeoutSec 1; if ($r.StatusCode -ge 200) { Start-Process 'http://127.0.0.1:39212'; exit 0 } } catch {}; exit 1"
if not errorlevel 1 exit /b 0
node lecture-auto-register\index.mjs --app
pause
