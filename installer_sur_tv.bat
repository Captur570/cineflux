@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ShippoTV - installation sur la tele Samsung
echo.
echo  === ShippoTV : installation sur la tele Samsung ===
echo.
where py >nul 2>nul && (py -3 outils\build_tv.py) || (python outils\build_tv.py)
echo.
pause
