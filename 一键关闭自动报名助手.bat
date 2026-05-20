@echo off
chcp 65001 >nul
title 一键关闭自动报名助手
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-assistant.ps1"
pause