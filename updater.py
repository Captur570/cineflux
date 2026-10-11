# -*- coding: utf-8 -*-
"""
Mises à jour automatiques : vérifie la dernière version publiée sur GitHub,
télécharge l'installateur et le lance en mode silencieux (il relance ShippoTV tout seul).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

UA = "ShippoTV-Updater"


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "0")[:4]) or (0,)


class Updater:
    def __init__(self, repo, version, event):
        self.repo = (repo or "").strip().strip("/")
        self.version = version
        self.event = event
        self.info = None
        self.state = "idle"          # idle | downloading | ready | error
        self.progress = 0
        self.error = ""
        self.lock = threading.Lock()
        self.api = os.environ.get("CINEFLUX_UPDATE_API", "https://api.github.com")
        self.on_pending = None          # mémorise la version en cours d'installation (vérifiée au redémarrage)

    @property
    def enabled(self):
        return bool(self.repo)

    def check(self, notify=True):
        if not self.enabled:
            return None
        req = urllib.request.Request(f"{self.api}/repos/{self.repo}/releases/latest",
                                     headers={"User-Agent": UA, "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            rel = json.loads(r.read().decode("utf-8"))
        tag = rel.get("tag_name") or ""
        asset = next((a for a in rel.get("assets") or [] if (a.get("name") or "").lower().endswith(".exe")), None)
        if not asset or vtuple(tag) <= vtuple(self.version):
            self.info = None
            return None
        new = {"version": tag.lstrip("vV"), "url": asset.get("browser_download_url"), "size": asset.get("size") or 0,
               "notes": (rel.get("body") or "").strip()[:1500], "name": asset.get("name")}
        first = not self.info or self.info["version"] != new["version"]
        self.info = new
        if notify and first:
            self.event(f"ShippoTV {new['version']} est disponible", "info", "update", new)
        return new

    def loop(self):
        time.sleep(25)
        while True:
            try:
                self.check()
            except Exception:
                pass
            time.sleep(6 * 3600)

    def start(self):
        if self.enabled:
            threading.Thread(target=self.loop, daemon=True, name="maj").start()

    def status(self):
        return {"enabled": self.enabled, "current": self.version, "available": self.info, "state": self.state,
                "progress": self.progress, "error": self.error, "installed": bool(getattr(sys, "frozen", False))}

    def install(self, on_exit):
        """Télécharge puis lance l'installateur ; on_exit() ferme ShippoTV."""
        with self.lock:
            if self.state == "downloading" or not self.info:
                return self.status()
            self.state, self.progress, self.error = "downloading", 0, ""
        threading.Thread(target=self._install, args=(on_exit,), daemon=True).start()
        return self.status()

    def launch_installer(self, setup):
        """Un petit script attend que ShippoTV soit VRAIMENT fermé (son numéro de processus a disparu),
        puis lance l'installation silencieuse, qui relance ShippoTV à la fin.
        Avant (5.1.x), l'installateur démarrait alors que l'appli tournait encore : rien ne s'installait."""
        log = os.path.join(tempfile.gettempdir(), "ShippoTV-maj.log")
        if self.on_pending:
            self.on_pending(self.info.get("version"), log)
        pid = os.getpid()
        script = os.path.join(tempfile.gettempdir(), "ShippoTV-maj.cmd")
        lines = [
            "@echo off",
            "setlocal",
            "set n=0",
            ":attente",
            f'tasklist /FI "PID eq {pid}" 2>nul | find "{pid}" >nul',
            "if errorlevel 1 goto installe",
            "set /a n+=1",
            "if %n% GEQ 40 (",
            f"  taskkill /F /PID {pid} >nul 2>&1",
            "  goto installe",
            ")",
            "ping -n 2 127.0.0.1 >nul",
            "goto attente",
            ":installe",
            "ping -n 2 127.0.0.1 >nul",
            f'start "" /wait "{setup}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /LOG="{log}"',
            'del "%~f0" >nul 2>&1',
        ]
        with open(script, "w", encoding="mbcs" if sys.platform == "win32" else "utf-8", newline="\r\n") as f:
            f.write("\n".join(lines) + "\n")
        flags = 0x08000000 | 0x00000200 if sys.platform == "win32" else 0   # CREATE_NO_WINDOW | NEW_PROCESS_GROUP
        subprocess.Popen(["cmd.exe", "/d", "/c", script], creationflags=flags, close_fds=True,
                         cwd=tempfile.gettempdir())

    def _install(self, on_exit):
        try:
            dest = os.path.join(tempfile.gettempdir(), self.info.get("name") or "ShippoTV-Setup.exe")
            req = urllib.request.Request(self.info["url"], headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r, open(dest + ".part", "wb") as f:
                total = int(r.headers.get("Content-Length") or self.info.get("size") or 0)
                done = 0
                while True:
                    chunk = r.read(256 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    self.progress = int(100 * done / total) if total else 0
            os.replace(dest + ".part", dest)
            self.state = "ready"
            if not getattr(sys, "frozen", False):
                self.event("Installateur téléchargé (mode développement : lancez-le vous-même) : " + dest, "info")
                return
            self.event("Installation de la mise à jour… ShippoTV va redémarrer.", "info", "update_go")
            time.sleep(1.5)
            self.launch_installer(dest)
            on_exit()
        except Exception as e:  # noqa
            self.state, self.error = "error", str(e) or e.__class__.__name__
            self.event("Mise à jour impossible : " + self.error, "error")
