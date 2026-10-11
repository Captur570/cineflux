# -*- coding: utf-8 -*-
"""
Téléchargements de films et d'épisodes pour une lecture hors ligne.

- une file d'attente, un téléchargement à la fois (les abonnements limitent souvent à 1 connexion)
- reprise après coupure grâce aux requêtes partielles (Range) et au fichier .part
- mise en pause automatique pendant la lecture d'une vidéo, reprise ensuite
- jaquettes enregistrées à côté du fichier pour l'affichage hors ligne
"""
import http.client
import json
import os
import re
import shutil
import threading
import time
import urllib.parse
import urllib.request
import uuid


def safe_name(s, maxlen=120):
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", s or "").strip(" .")
    s = re.sub(r"\s+", " ", s)
    return s[:maxlen] or "video"


def default_dir():
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    base = home
    for sub in ("Videos", "Vidéos", "Movies"):
        if os.path.isdir(os.path.join(home, sub)):
            base = os.path.join(home, sub)
            break
    old = os.path.join(base, "Cinéflux")          # dossier des versions précédentes : on le garde
    return old if os.path.isdir(old) else os.path.join(base, "ShippoTV")


class DownloadManager:
    def __init__(self, store, hooks):
        """
        store : objet Store (data = {"items": [...]})
        hooks : url(item) -> url à jour, headers() -> liste d'en-têtes, folder() -> dossier,
                event(msg, level, kind), images(item) -> {"poster": url, "backdrop": url}
        """
        self.store = store
        self.hooks = hooks
        self.lock = threading.RLock()
        self.cv = threading.Condition(self.lock)
        self.hold_reasons = set()
        self.current = None
        self.stop_flag = False
        self.speed = 0.0
        for it in self.items:                 # au redémarrage, rien n'est « en cours »
            if it["status"] == "downloading":
                it["status"] = "queued"
        self.thread = threading.Thread(target=self._loop, daemon=True, name="downloads")
        self.thread.start()

    @property
    def items(self):
        return self.store.data.setdefault("items", [])

    def save(self):
        with self.lock:
            self.store.save()

    # ------------------------------------------------------------------ API
    def add(self, entries):
        added = []
        with self.lock:
            for e in entries:
                if any(x["vid"] == e["vid"] and x["status"] != "error" for x in self.items):
                    continue
                folder = self.hooks["folder"]()
                if e.get("kind") == "episode":
                    sub = safe_name(e.get("title"))
                    fname = safe_name(f"{e.get('title')} - {e.get('sub') or e['vid']}") + "." + (e.get("ext") or "mkv")
                    path = os.path.join(folder, "Séries", sub, fname)
                else:
                    year = f" ({e['year']})" if e.get("year") else ""
                    q = f" [{e['label']}]" if e.get("label") else ""
                    fname = safe_name(f"{e.get('title')}{year}{q}") + "." + (e.get("ext") or "mkv")
                    path = os.path.join(folder, "Films", fname)
                it = {"id": uuid.uuid4().hex[:12], "status": "queued", "done": 0, "size": 0, "err": "",
                      "added": int(time.time()), "path": path, **e}
                self.items.append(it)
                added.append(it["id"])
            self.cv.notify_all()
        self.save()
        return added

    def action(self, did, act):
        with self.lock:
            it = self.get(did)
            if not it:
                return False
            if act == "pause" and it["status"] in ("queued", "downloading"):
                it["status"] = "paused"
            elif act == "resume" and it["status"] in ("paused", "error"):
                it["status"] = "queued"
                it["err"] = ""
            elif act in ("cancel", "delete"):
                it["status"] = "removed"
                self._remove_files(it)
                self.items.remove(it)
            elif act == "top" and it["status"] == "queued":
                self.items.remove(it)
                self.items.insert(0, it)
            self.cv.notify_all()
        self.save()
        return True

    def get(self, did):
        return next((x for x in self.items if x["id"] == did), None)

    def hold(self, reason, on):
        with self.lock:
            if on:
                self.hold_reasons.add(reason)
            else:
                self.hold_reasons.discard(reason)
            self.cv.notify_all()

    def status(self):
        with self.lock:
            out = []
            for it in self.items:
                d = {k: it.get(k) for k in ("id", "status", "done", "size", "err", "kind", "key", "vid", "title", "sub",
                                              "label", "year", "ext", "ep", "path", "added", "pid")}
                d["speed"] = self.speed if self.current is it else 0
                d["img"] = bool(it.get("img"))
                out.append(d)
            folder = self.hooks["folder"]()
            free = None
            try:
                os.makedirs(folder, exist_ok=True)
                free = shutil.disk_usage(folder).free
            except OSError:
                pass
            return {"items": out, "folder": folder, "free": free, "held": bool(self.hold_reasons)}

    def local_file(self, vid=None, did=None):
        for it in self.items:
            if it["status"] == "done" and (str(it["vid"]) == str(vid) or it["id"] == did) and os.path.isfile(it["path"]):
                return it
        return None

    # ------------------------------------------------------------------ boucle
    def _next(self):
        for it in self.items:
            if it["status"] == "queued":
                return it
        return None

    def _loop(self):
        while True:
            with self.lock:
                while self.hold_reasons or not self._next():
                    self.cv.wait(5)
                it = self._next()
                it["status"] = "downloading"
                self.current = it
            try:
                self._download(it)
            except Exception as e:  # noqa
                with self.lock:
                    if it["status"] == "downloading":
                        it["status"] = "error"
                        it["err"] = str(e) or e.__class__.__name__
                self.hooks["event"](f"Téléchargement interrompu : {it['title']} ({it['err']})", "error", "toast")
                time.sleep(3)
            finally:
                with self.lock:
                    self.current = None
                    self.speed = 0
                self.save()

    def _interrupted(self, it):
        return it["status"] != "downloading" or bool(self.hold_reasons)

    def _download(self, it):
        os.makedirs(os.path.dirname(it["path"]), exist_ok=True)
        part = it["path"] + ".part"
        have = os.path.getsize(part) if os.path.exists(part) else 0
        url = self.hooks["url"](it)
        headers = [(k, v) for k, v in self.hooks["headers"]() if k not in ("Range", "Accept-Encoding", "Connection")]
        headers += [("Accept-Encoding", "identity"), ("Connection", "close")]
        if have:
            headers.append(("Range", f"bytes={have}-"))
        conn = r = None
        for _ in range(6):
            sp = urllib.parse.urlsplit(url)
            cls = http.client.HTTPSConnection if sp.scheme == "https" else http.client.HTTPConnection
            conn = cls(sp.hostname, sp.port, timeout=30)
            conn.putrequest("GET", (sp.path or "/") + ("?" + sp.query if sp.query else ""), skip_accept_encoding=True)
            for k, v in headers:
                conn.putheader(k, v)
            conn.endheaders()
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308) and r.getheader("Location"):
                url = urllib.parse.urljoin(url, r.getheader("Location"))
                r.read()
                conn.close()
                continue
            break
        try:
            if r.status == 416:          # déjà complet
                r.read()
            elif r.status >= 400:
                raise RuntimeError(f"le serveur a répondu {r.status}")
            else:
                mode = "ab"
                if r.status == 200 and have:   # le serveur ne gère pas la reprise : on repart de zéro
                    have, mode = 0, "wb"
                total = r.getheader("Content-Length")
                total = int(total) + have if total else 0
                it["size"] = total or it.get("size") or 0
                it["done"] = have
                t0, b0, last_save = time.time(), have, time.time()
                with open(part, mode) as f:
                    while True:
                        if self._interrupted(it):
                            break
                        chunk = r.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        it["done"] += len(chunk)
                        now = time.time()
                        if now - t0 >= 1:
                            self.speed = (it["done"] - b0) / (now - t0)
                            t0, b0 = now, it["done"]
                        if now - last_save > 10:
                            self.save()
                            last_save = now
        finally:
            try:
                conn.close()
            except Exception:
                pass
        with self.lock:
            if it["status"] == "removed":
                try:
                    os.remove(part)
                except OSError:
                    pass
                return
            if it["status"] != "downloading":
                return                       # mis en pause
            if self.hold_reasons:
                it["status"] = "queued"      # reprendra après la lecture
                return
            complete = (not it["size"]) or it["done"] >= it["size"]
            if not complete:
                it["status"] = "queued"      # coupure : on réessaiera
                return
        os.replace(part, it["path"])
        self._fetch_images(it)
        with self.lock:
            it["status"] = "done"
            it["finished"] = int(time.time())
        self.hooks["event"](f"Téléchargement terminé : {it['title']}" + (f" – {it['sub']}" if it.get("sub") else ""),
                            "info", "download")

    def _fetch_images(self, it):
        try:
            imgs = self.hooks["images"](it) or {}
        except Exception:
            imgs = {}
        base = os.path.join(os.path.dirname(it["path"]), ".cineflux")
        saved = {}
        for kind, url in imgs.items():
            if not url:
                continue
            try:
                os.makedirs(base, exist_ok=True)
                dest = os.path.join(base, f"{it['id']}-{kind}.jpg")
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=20) as resp, open(dest, "wb") as f:
                    f.write(resp.read())
                saved[kind] = dest
            except Exception:
                pass
        if saved:
            it["img"] = saved

    def _remove_files(self, it):
        for p in (it["path"], it["path"] + ".part", *(it.get("img") or {}).values()):
            try:
                if p and os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass

    def export_meta(self):
        return json.dumps(self.items)
