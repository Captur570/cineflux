@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ShippoTV - fabrication de l'installateur
echo.
echo  === ShippoTV : fabrication de l'installateur ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0outils\build.ps1"
echo.
pause
