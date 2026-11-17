@echo off
chcp 65001 >nul
title Stop QQ Lecture Auto Register
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-assistant.ps1"
pause
