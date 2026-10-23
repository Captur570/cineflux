#!/usr/bin/env python3
"""
ATVLoad — interface graphique.

Fenêtre pywebview (moteur Edge WebView2 de Windows) au-dessus d'atvload.py : mêmes commandes,
même état (%APPDATA%\\ATVLoad), même renouvellement automatique. Les questions que plumesign pose
dans le terminal (code PIN de l'Apple TV, code de validation Apple) deviennent des fenêtres de saisie.

Lancement : ATVLoad.exe (empaqueté), ou  pythonw atvload_gui.py
Avec des arguments, se comporte comme la ligne de commande (la tâche planifiée lance « refresh --notify »).
"""

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import zipfile
from pathlib import Path

import atvload as A

VERSION = "1.0"
HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
UI_FILE = HERE / "atvload_gui.html"

# Apps proposées en un clic (publiées par les fabrications GitHub du dépôt)
PRESETS = {
    "shippotv": {
        "name": "ShippoTV",
        "desc": "Dernière version bêta pour Apple TV",
        "url": "https://github.com/Captur570/cineflux/releases/download/appletv-beta/ShippoTV-AppleTV.ipa",
        "bundle": "app.shippotv.atv",
    },
    "hellotv": {
        "name": "HelloTV",
        "desc": "Petite app de test, pour vérifier que tout marche",
        "url": "https://github.com/Captur570/cineflux/releases/download/atv-tools/HelloTV.ipa",
        "bundle": None,
    },
}

# Questions posées par plumesign (voir PlumeImpactor : apps/plumesign/src/commands/pair.rs et account.rs)
PROMPTS = [
    (re.compile(r"Enter PIN", re.I), "pin"),
    (re.compile(r"code sent via SMS", re.I), "sms"),
    (re.compile(r"code sent to your device", re.I), "2fa_sms"),
    (re.compile(r"Enter 2FA code", re.I), "2fa"),
]


class GuiIO(A.ConsoleIO):
    """Remplace le terminal : la sortie part vers la fenêtre, les questions deviennent des fenêtres de saisie."""

    def __init__(self, app):
        self.app = app
        self.answers = queue.Queue()
        self.tail = ""
        self.password = None

    def write(self, text):
        self.app.emit("log", text)
        self.out = (getattr(self, "out", "") + text)[-20000:]
        self.tail = (self.tail + text)[-400:]
        for rx, kind in PROMPTS:
            if rx.search(self.tail):
                self.tail = ""
                self.app.emit("prompt", {"kind": kind})
                break

    def line(self, level, msg):
        self.app.emit("line", {"level": level, "msg": msg})

    def ask(self, kind, prompt, secret=False, options=None):
        if kind == "password" and self.password is not None:
            pw, self.password = self.password, None
            return pw
        self.app.emit("prompt", {"kind": kind, "text": prompt, "options": options or []})
        v = self.answers.get()
        if v is None:
            raise A.Fail("Annulé.")
        return v

    def read_line(self):
        return self.answers.get()

    def new_job(self):
        """File de réponses neuve à chaque opération : un relais resté bloqué sur l'ancienne
        (plumesign déjà terminé) ne doit pas avaler la réponse destinée à la nouvelle."""
        old, self.answers = self.answers, queue.Queue()
        old.put(None)
        self.tail = ""
        self.out = ""

    def error_lines(self):
        """Les quelques lignes de plumesign qui expliquent l'échec (affichées dans le cadre rouge)."""
        keep = []
        for raw in getattr(self, "out", "").splitlines():
            line = re.sub(r"\x1b\[[0-9;]*m", "", raw).strip()
            line = re.sub(r"^\[?\d{4}-\d\d-\d\dT[\d:.]+Z?\s+(ERROR|WARN|INFO|DEBUG)\s+[\w:]+\]?\s*", r"\1 ", line)
            if not line or line.startswith(("INFO", "DEBUG")):
                continue
            if re.search(r"error|erreur|panicked|failed|denied|refus|invalid|unauthor|forbidden|\b[45]\d\d\b|-\d{4,5}\b", line, re.I):
                if line not in keep:
                    keep.append(line[:300])
        return keep[-4:]


def ns(**kw):
    return argparse.Namespace(**kw)


class Api:
    """Fonctions appelées par la page (window.pywebview.api.*)."""

    # Tous les attributs commencent par « _ » : pywebview expose à la page chaque attribut public de
    # l'Api, en descendant dans les objets (fenêtre, verrous…). Avec self.window, il parcourait toute la
    # fenêtre au démarrage et l'interface se figeait (« Ne répond pas »).
    def __init__(self):
        self._window = None
        self._io = GuiIO(self)
        A.IO = self._io
        self._job = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------- vers la page
    def emit(self, kind, data=None):
        w = self._window
        if not w:
            return
        try:
            w.evaluate_js(f"window.ui && ui.on({json.dumps({'kind': kind, 'data': data}, ensure_ascii=False)})")
        except Exception:
            pass

    # ------------------------------------------------------------- état
    def ready(self):
        """Appelée par la page une fois chargée (preuve que la page et Python se parlent)."""
        A.log_to_file(f"interface prête (ATVLoad {VERSION})")
        return True

    def status(self):
        st = A.load_state()
        try:
            plume = str(A.plumesign_path())
        except A.Fail:
            plume = None
        apps = []
        def tvname(udid):
            n = st.get("devices", {}).get(udid, {}).get("name")
            return n if n and not A.looks_like_id(n) else ((st.get("paired") or {}).get("name") or "Apple TV")
        for key, a in st.get("apps", {}).items():
            left = A.days_left(a)
            apps.append({
                "key": key, "name": a.get("name"), "bundle": a.get("bundle"),
                "tv": tvname(a.get("udid")),
                "expires": a.get("expires"), "expires_txt": A.fmt_date(a.get("expires")) if a.get("expires") else None,
                "days_left": left, "installed": a.get("installed"), "refreshed": a.get("refreshed"),
                "ipa_ok": bool(a.get("ipa")) and Path(a["ipa"]).is_file(),
            })
        apps.sort(key=lambda x: (x["days_left"] is None, x["days_left"] if x["days_left"] is not None else 0))
        return {
            "version": VERSION,
            "plumesign": plume,
            "account": st.get("account"),
            "devices": [{"udid": u, "name": tvname(u)} for u in st.get("devices", {})],
            "paired": bool(st.get("devices") or st.get("paired")) or self._has_pairing(),
            "paired_name": (st.get("paired") or {}).get("name"),
            "apps": apps,
            "schedule": A.task_exists(),
            "windows": os.name == "nt",
            "busy": self._job,
            "presets": {k: {"name": v["name"], "desc": v["desc"]} for k, v in PRESETS.items()},
            "log_file": str(A.LOG_FILE),
        }

    @staticmethod
    def _has_pairing():
        d = A.plume_data_dir()
        try:
            return any(p.suffix in (".plist", ".json") and "pair" in p.name.lower() for p in d.rglob("*"))
        except Exception:
            return False

    # ------------------------------------------------------------- tâches
    def start(self, job, params=None):
        params = params or {}
        with self._lock:
            if self._job:
                return {"ok": False, "error": "Une opération est déjà en cours."}
            self._job = job
        self._io.new_job()
        if job == "login":
            self._io.password = params.get("password") or ""
        threading.Thread(target=self._run, args=(job, params), daemon=True).start()
        return {"ok": True}

    def _run(self, job, p):
        state = A.load_state()
        result = {"job": job, "ok": True, "error": None, "data": None}
        A.log_to_file(f"--- interface : {job}")
        try:
            if job == "setup":
                A.cmd_setup(ns(force=bool(p.get("force"))), state)
            elif job == "pair":
                A.cmd_pair(ns(), state)
            elif job == "login":
                A.cmd_login(ns(email=p.get("email")), state)
            elif job == "install":
                A.cmd_install(ns(ipa=p["path"], udid=p.get("udid"), revoke=p.get("revoke")), state)
            elif job == "preset":
                path = self._download(p["id"])
                A.cmd_install(ns(ipa=str(path), udid=p.get("udid"), revoke=p.get("revoke")), state)
            elif job == "refresh":
                A.cmd_refresh(ns(all=bool(p.get("all")), notify=False), state)
            elif job == "refresh_one":
                self._refresh_one(state, p["key"], full=bool(p.get("full")))
            elif job == "scan":
                result["data"] = self._scan()
            elif job == "schedule":
                A.cmd_schedule(ns(time=p.get("time")), state)
            elif job == "unschedule":
                A.cmd_unschedule(ns(), state)
            elif job == "certs":
                A.cmd_certs(ns(), state)
            else:
                raise A.Fail(f"Action inconnue : {job}")
        except A.Fail as e:
            result.update(ok=False, error=str(e), detail=self._io.error_lines(), session=bool(getattr(e, "session", False)))
            A.log_to_file("XX " + str(e))
        except Exception as e:  # erreur imprévue : on la montre plutôt que de figer la fenêtre
            result.update(ok=False, error=f"Erreur inattendue : {e}", detail=self._io.error_lines())
            A.log_to_file(traceback.format_exc())
        finally:
            self._io.password = None
            self._job = None
        self.emit("done", result)
        self.emit("status", self.status())

    def _refresh_one(self, state, key, full=False):
        app = state["apps"].get(key)
        if not app:
            raise A.Fail("App inconnue.")
        if not Path(app.get("ipa") or "").is_file():
            raise A.Fail(f"Copie de l'IPA de {app['name']} introuvable : réinstalle-la depuis le fichier.")
        udid, dev = A.resolve_device(state, app["udid"])
        A.info(("Réinstallation" if full else "Renouvellement") + f" de {app['name']}…")
        try:
            expiry = A.sign_install(state, app["ipa"], udid, dev, refresh=not full)
        except A.Fail as e:
            if full or not getattr(e, "retryable", True):
                raise
            A.info("Renouvellement simple impossible, réinstallation complète…")
            expiry = A.sign_install(state, app["ipa"], udid, dev)
        app["expires"] = expiry or app.get("expires")
        app["refreshed"] = A.dt.datetime.now().isoformat(timespec="minutes")
        A.save_state(state)
        A.ok(f"{app['name']} valable jusqu'au {A.fmt_date(app['expires'])}")

    def _scan(self):
        A.info("Recherche des Apple TV sur le réseau…")
        pairable = [{"name": d["txt"].get("name", d["name"]), "ip": d["ip"]} for d in A.browse(A.SVC_PAIRABLE, 4)]
        paired = [{"udid": u, "name": d["name"], "ip": d["ip"]} for u, d in A.find_paired_devices(5).items()]
        st = A.load_state()
        for d in paired:
            st["devices"].setdefault(d["udid"], {}).setdefault("name", d["name"])
        A.save_state(st)
        if paired:
            A.ok("Apple TV joignable : " + ", ".join(f"{d['name']} ({d['ip']})" for d in paired))
        elif pairable:
            A.info("Apple TV en mode appairage trouvée, mais pas encore appairée.")
        else:
            A.warn("Aucune Apple TV trouvée. Allumée, sur le même réseau, réseau Windows en profil « Privé » ?")
        return {"paired": paired, "pairable": pairable}

    def _download(self, pid):
        pr = PRESETS[pid]
        dest = A.data_dir() / "telechargements"
        dest.mkdir(exist_ok=True)
        target = dest / f"{pid}.ipa"
        tmp = target.with_suffix(".part")
        A.info(f"Téléchargement de {pr['name']}…")
        last = [0.0]

        def hook(blocks, bs, total):
            now = time.time()
            if total > 0 and (now - last[0] > 0.25 or blocks * bs >= total):
                last[0] = now
                self.emit("progress", {"label": f"Téléchargement de {pr['name']}", "pct": min(100, blocks * bs * 100 / total),
                                       "mb": round(min(blocks * bs, total) / 1e6, 1), "total": round(total / 1e6, 1)})
        try:
            urllib.request.urlretrieve(pr["url"], tmp, hook)
        except Exception as e:
            raise A.Fail(f"Téléchargement de {pr['name']} impossible ({e}).")
        try:
            zipfile.ZipFile(tmp).close()
        except zipfile.BadZipFile:
            tmp.unlink(missing_ok=True)
            raise A.Fail(f"Le fichier téléchargé pour {pr['name']} n'est pas une IPA valide.")
        tmp.replace(target)
        self.emit("progress", None)
        A.ok(f"{pr['name']} téléchargée ({target.stat().st_size / 1e6:.1f} Mo)")
        return target

    # ------------------------------------------------------------- réponses de la page
    def answer(self, value):
        self._io.answers.put("" if value is None else str(value))
        return True

    def cancel(self):
        """Annule la question en cours et arrête plumesign."""
        self._io.answers.put(None)
        p = A.CURRENT.get("proc")
        if p and p.poll() is None:
            try:
                p.kill()
            except Exception:
                pass
        return True

    def ipa_info(self, path):
        try:
            p = A.ipa_info(path)
        except A.Fail as e:
            return {"ok": False, "error": str(e)}
        plat = p.get("CFBundleSupportedPlatforms", [])
        tv = "AppleTVOS" in plat or 3 in p.get("UIDeviceFamily", [])
        return {"ok": True, "tvos": tv, "name": p.get("CFBundleDisplayName") or p.get("CFBundleName"),
                "bundle": p.get("CFBundleIdentifier"), "version": p.get("CFBundleShortVersionString"),
                "platforms": plat}

    def pick_ipa(self):
        import webview
        kind = getattr(getattr(webview, "FileDialog", None), "OPEN", None) or webview.OPEN_DIALOG
        r = self._window.create_file_dialog(kind, allow_multiple=False, file_types=("Apps tvOS (*.ipa)", "Tous les fichiers (*.*)"))
        if not r:
            return None
        return r[0] if isinstance(r, (list, tuple)) else r

    def remove_app(self, key):
        st = A.load_state()
        st["apps"].pop(key, None)
        A.save_state(st)
        return self.status()

    def logout(self):
        st = A.load_state()
        st["account"] = None
        A.save_state(st)
        return self.status()

    def open_path(self, which):
        target = {"log": A.LOG_FILE, "data": A.data_dir(), "plume": A.plume_data_dir()}.get(which)
        if target and Path(target).exists() and os.name == "nt":
            os.startfile(str(target))  # noqa: S606 (Windows uniquement)
        return True

    def read_log(self, n=400):
        try:
            return "".join(A.LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines(True)[-n:])
        except OSError:
            return ""


def run_gui():
    import webview
    api = Api()
    win = webview.create_window(
        "ATVLoad", url=str(UI_FILE), js_api=api, width=1100, height=760, min_size=(900, 620),
        background_color="#0B0B0F",
    )
    api._window = win

    def on_ready():
        # glisser-déposer d'une IPA : le chemin complet n'est disponible que côté Python (pywebview ≥ 5)
        try:
            from webview.dom import DOMEventHandler

            def dropped(e):
                files = (e.get("dataTransfer") or {}).get("files") or []
                paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
                if paths:
                    api.emit("dropped", paths[0])
            win.dom.document.events.drop += DOMEventHandler(dropped, True, True)
        except Exception:
            api.emit("nodrop", None)

    win.events.loaded += on_ready
    webview.start(debug=bool(os.environ.get("ATVLOAD_DEBUG")))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        A.main()          # mode ligne de commande (tâche planifiée : refresh --notify)
    else:
        run_gui()
