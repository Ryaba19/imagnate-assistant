@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запускаю локальный сервер Store Control...
node server-local.js
pause
