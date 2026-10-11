@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ShippoTV - paquet pour la tele
echo.
echo  === ShippoTV : fabrication du paquet pour la tele (a installer avec Apps2Samsung) ===
echo.
where py >nul 2>nul && (py -3 outils\build_tv.py --wgt) || (python outils\build_tv.py --wgt)
echo.
pause
