# -*- coding: utf-8 -*-
"""
Synchronisation entre appareils par code de jumelage.

- Un « groupe » = un secret aléatoire de 32 octets, connu seulement des appareils associés.
  Rien ne le relie à l'abonnement IPTV.
- Le serveur (Supabase) ne voit qu'un identifiant de groupe dérivé du secret, des noms d'éléments
  hachés et des valeurs chiffrées (AES-256-GCM) : il ne peut savoir ni ce que vous regardez,
  ni chez quel fournisseur.
- Pour associer un appareil : un code à 6 caractères, valable 10 minutes et à usage unique,
  permet de transmettre le secret (lui-même chiffré avec une clé dérivée du code).
- Détection des changements par instantanés : chaque élément (favori, reprise de lecture…) est
  comparé à son état précédent ; le plus récent l'emporte en cas de conflit.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:  # noqa
    AESGCM = None

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # sans 0/O ni 1/I
PAIR_SALT = b"cineflux-pairing-v1"
PAIR_TTL = 600


def _b64(b):
    return base64.b64encode(b).decode()


def _unb64(s):
    return base64.b64decode(s.encode())


class SyncError(Exception):
    pass


class Group:
    def __init__(self, secret):
        self.secret = secret
        self.gid = hashlib.sha256(b"cineflux-gid:" + secret).hexdigest()
        self.enc = hashlib.sha256(b"cineflux-enc:" + secret).digest()
        self.mac = hashlib.sha256(b"cineflux-mac:" + secret).digest()
        self.aes = AESGCM(self.enc)

    def hkey(self, k):
        return hmac.new(self.mac, k.encode(), hashlib.sha256).hexdigest()[:40]

    def seal(self, obj):
        n = os.urandom(12)
        return _b64(n + self.aes.encrypt(n, json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode(), self.gid.encode()))

    def open(self, blob):
        raw = _unb64(blob)
        return json.loads(self.aes.decrypt(raw[:12], raw[12:], self.gid.encode()).decode())


def _code_key(code):
    return hashlib.pbkdf2_hmac("sha256", code.encode(), PAIR_SALT, 200_000)


def _code_hash(code):
    return hashlib.sha256(b"cineflux-pair:" + code.encode()).hexdigest()


class SyncClient:
    """
    hooks :
      export() -> {cle: valeur}           état local actuel, aplati
      apply(changes) -> None              changes = [(cle, valeur | None)] venant des autres appareils
      event(msg, level, kind, data)
    store : dict persistant (CONFIG.data["sync"]) + save()
    """

    def __init__(self, url, key, store, save, hooks, interval=15):
        self.url = re.sub(r"(/rest/v1)?/*$", "", (url or "").strip())
        self.key = key or ""
        self.store = store
        self.save = save
        self.hooks = hooks
        self.interval = interval
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.running = False
        self.last_ok = 0
        self.last_error = ""
        self.devices = list(self.store.get("devices") or [])
        self.group = None
        if self.store.get("secret") and AESGCM:
            self.group = Group(_unb64(self.store["secret"]))
        self.store.setdefault("device", secrets.token_hex(8))
        self.store.setdefault("name", socket.gethostname() or "PC")

    # ------------------------------------------------------------------ état
    @property
    def configured(self):
        return bool(self.url and self.key and AESGCM)

    def status(self):
        return {"configured": self.configured, "crypto": bool(AESGCM), "in_group": bool(self.group),
                "last_ok": int(self.last_ok), "error": self.last_error, "devices": self.devices,
                "device": self.store.get("device"), "name": self.store.get("name"),
                "group_name": self.store.get("group_name") or ""}

    # ------------------------------------------------------------------ réseau
    def _rpc(self, fn, payload, timeout=20):
        headers = {"apikey": self.key, "Content-Type": "application/json", "Accept": "application/json",
                   "User-Agent": "ShippoTV-Sync"}
        if self.key.startswith("eyJ"):
            headers["Authorization"] = "Bearer " + self.key
        req = urllib.request.Request(f"{self.url}/rest/v1/rpc/{fn}", data=json.dumps(payload).encode(),
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                txt = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read().decode("utf-8")).get("message") or ""
            except Exception:
                pass
            if e.code in (503, 540) or "pause" in detail.lower():
                raise SyncError("Serveur de synchronisation en pause (Supabase gratuit, après une semaine sans activité) : relancez-le sur supabase.com, bouton « Restore » du projet") from e
            if e.code == 404:
                raise SyncError("Serveur de synchronisation non préparé (script SQL non exécuté ?)") from e
            if e.code in (401, 403):
                raise SyncError("Clé Supabase refusée") from e
            raise SyncError(f"Erreur du serveur de synchronisation ({e.code}) {detail}".strip()) from e
        except (urllib.error.URLError, socket.timeout, OSError) as e:
            raise SyncError("Serveur de synchronisation injoignable") from e
        return json.loads(txt) if txt else None

    # ------------------------------------------------------------------ groupe
    def create_group(self, name=""):
        if not self.configured:
            raise SyncError("Synchronisation non configurée")
        with self.lock:
            secret = os.urandom(32)
            self._set_group(secret, name or "Mon groupe")
        self.wake.set()
        return self.status()

    def _set_group(self, secret, name):
        self.group = Group(secret)
        self.store.update(secret=_b64(secret), group_name=name, cursor=None, cursor_k="", snap={}, devices=[], dev_day="")
        self.devices = []
        self.save()

    def leave_group(self):
        with self.lock:
            self.group = None
            for k in ("secret", "cursor", "cursor_k", "snap", "group_name", "devices", "dev_day"):
                self.store.pop(k, None)
            self.devices = []
            self.save()
        return self.status()

    def rotate(self):
        """Nouvelle clé de groupe : les anciens appareils ne reçoivent plus rien."""
        if not self.group:
            raise SyncError("Aucun groupe")
        name = self.store.get("group_name") or "Mon groupe"
        with self.lock:
            self._set_group(os.urandom(32), name)
        self.wake.set()
        return self.status()

    def make_code(self, extra=None):
        """Code d'association à 6 caractères, valable 10 minutes, à usage unique.
        extra : réglages transmis avec le code (identifiants IPTV pour configurer un nouvel appareil)."""
        if not self.group:
            raise SyncError("Créez d'abord un groupe")
        code = "".join(secrets.choice(ALPHABET) for _ in range(6))
        key = _code_key(code)
        n = os.urandom(12)
        body = {"s": self.store["secret"], "n": self.store.get("group_name") or ""}
        if extra:
            body["x"] = extra
        payload = _b64(n + AESGCM(key).encrypt(n, json.dumps(body).encode(), b"pair"))
        self._rpc("cf_pair_create", {"p_h": _code_hash(code), "p_payload": payload})
        return {"code": code[:3] + " " + code[3:], "expires": int(time.time()) + PAIR_TTL}

    def join(self, code):
        if not self.configured:
            raise SyncError("Synchronisation non configurée")
        code = "".join(ch for ch in (code or "").upper() if ch.isalnum())
        if len(code) != 6:
            raise SyncError("Le code doit contenir 6 caractères")
        blob = self._rpc("cf_pair_claim", {"p_h": _code_hash(code)})
        if not blob:
            raise SyncError("Code inconnu, déjà utilisé ou expiré")
        raw = _unb64(blob)
        try:
            data = json.loads(AESGCM(_code_key(code)).decrypt(raw[:12], raw[12:], b"pair").decode())
        except Exception as e:
            raise SyncError("Code invalide") from e
        with self.lock:
            self._set_group(_unb64(data["s"]), data.get("n") or "")
        self.last_extra = data.get("x")
        self.wake.set()
        return self.status()

    def rename_device(self, name):
        self.store["name"] = (name or "").strip()[:40] or self.store["name"]
        self.save()
        self.wake.set()

    # ------------------------------------------------------------------ cycle
    def start(self):
        if self.running:
            return
        self.running = True
        threading.Thread(target=self._loop, daemon=True, name="synchro").start()

    def stop(self):
        try:
            if self.group and self.configured:
                self.cycle()
        except Exception:
            pass
        self.running = False
        self.wake.set()

    def poke(self):
        self.wake.set()

    def _loop(self):
        time.sleep(4)
        while self.running:
            if self.group and self.configured:
                try:
                    self.cycle()
                    self.last_error = ""
                    self.last_ok = time.time()
                except SyncError as e:
                    self.last_error = str(e)
                except Exception as e:  # noqa
                    self.last_error = str(e) or e.__class__.__name__
            self.wake.wait(self.interval)
            if self.running:
                time.sleep(2)            # regroupe les modifications rapprochées
            self.wake.clear()

    def _device_item(self):
        day = time.strftime("%Y-%m-%d")
        return f"dev/{self.store['device']}", {"name": self.store.get("name"), "seen": day}

    def _h(self, v):
        return hashlib.sha1(json.dumps(v, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]

    def cycle(self):
        with self.lock:
            g = self.group
            if not g:
                return
            snap = self.store.setdefault("snap", {})
            # 1) réception d'abord : un appareil qui rejoint un groupe adopte les données existantes
            changes, devices = [], {}
            while True:
                rows = self._rpc("cf_pull", {"p_gid": g.gid, "p_since": self.store.get("cursor"),
                                             "p_after_k": self.store.get("cursor_k") or ""}, timeout=40) or []
                for r in rows:
                    try:
                        item = g.open(r["v"])
                    except Exception:
                        continue
                    k, v, t = item.get("k"), item.get("v"), int(r["ts"])
                    if not k:
                        continue
                    deleted = bool(r.get("del")) or v is None
                    if k.startswith("dev/"):
                        if not deleted:
                            devices[k[4:]] = v
                        continue
                    old = snap.get(k)
                    if old and old[1] >= t:
                        continue                              # version locale plus récente ou identique
                    snap[k] = ["-" if deleted else self._h(v), t]
                    changes.append((k, None if deleted else v))
                if rows:
                    self.store["cursor"] = rows[-1]["srv"]
                    self.store["cursor_k"] = rows[-1]["k"]
                if len(rows) < 1000:
                    break
            if changes:
                self.hooks["apply"](changes)
            # 2) envoi des changements locaux
            now_ms = int(time.time() * 1000)
            cur = self.hooks["export"]()
            dk, dv = self._device_item()
            out = []
            for k, v in cur.items():
                h = self._h(v)
                old = snap.get(k)
                if not old or old[0] != h:
                    t = now_ms if not old else max(now_ms, old[1] + 1)
                    out.append({"k": g.hkey(k), "v": g.seal({"k": k, "v": v}), "d": False, "t": t})
                    snap[k] = [h, t]
            for k in [k for k in snap if k not in cur]:
                if snap[k][0] == "-":
                    continue
                t = max(now_ms, snap[k][1] + 1)
                out.append({"k": g.hkey(k), "v": g.seal({"k": k, "v": None}), "d": True, "t": t})
                snap[k] = ["-", t]
            if self.store.get("dev_day") != dv["seen"] + (dv["name"] or ""):
                out.append({"k": g.hkey(dk), "v": g.seal({"k": dk, "v": dv}), "d": False, "t": now_ms})
                self.store["dev_day"] = dv["seen"] + (dv["name"] or "")
            for i in range(0, len(out), 400):
                self._rpc("cf_push", {"p_gid": g.gid, "p_items": out[i:i + 400]}, timeout=40)
            # appareils du groupe
            devices[self.store["device"]] = dv
            known = {d["id"]: d for d in self.devices}
            for did, v in devices.items():
                known[did] = {"id": did, "name": v.get("name"), "seen": v.get("seen"), "me": did == self.store["device"]}
            self.devices = sorted(known.values(), key=lambda d: (not d["me"], d.get("name") or ""))
            if devices.keys() - {self.store["device"]} or self.store.get("devices") != self.devices:
                self.store["devices"] = self.devices
                out = out or [1]
            if changes:
                self.hooks["event"]("", "info", "sync", {"n": len(changes)})
            if changes or out:
                self.save()
