@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ShippoTV - publication d'une mise a jour
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0outils\publier.ps1"
echo.
pause
