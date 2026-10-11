@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py -3 -m pip install -q pywebview python-vlc cryptography tzdata & py -3 cineflux.py) || (python -m pip install -q pywebview python-vlc cryptography tzdata & python cineflux.py)
