#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ShippoTV — lecteur IPTV (Xtream Codes) avec une interface façon plateforme de streaming.

- Films, séries et chaînes TV séparés, recherche instantanée
- Nettoyage des noms ("Les évadés 4K DV 1994" -> "Les évadés", 1994) et jaquettes TMDB
- Fusion des doublons : une seule fiche par film / série / chaîne, avec toutes les sources
- Lecture dans mpv (recommandé) ou VLC, avec bascule automatique sur la source suivante

Lancement : python cineflux.py            (fenêtre d'application)
            python cineflux.py --browser  (ouvre dans le navigateur)
"""
import base64
import datetime
import hashlib
import hmac
import difflib
import gzip
import http.client
import zlib
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import downloads
import sync
import tvguide
import updater
import verify
import vlcplayer

APP_NAME = "ShippoTV"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
TMDB_API = os.environ.get("CINEFLUX_TMDB_API", "https://api.themoviedb.org/3")
CATALOG_MAX_AGE = 24 * 3600
CURRENT_YEAR = time.localtime().tm_year


# --------------------------------------------------------------------------- chemins
def resource_dir():
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def data_dir():
    base = os.environ.get("CINEFLUX_DATA") or os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    d = os.path.join(base, "Cineflux") if not os.environ.get("CINEFLUX_DATA") else base
    os.makedirs(d, exist_ok=True)
    return d


WEB_DIR = os.path.join(resource_dir(), "web")
DATA = data_dir()


def _read_version():
    for d in (resource_dir(), app_dir()):
        try:
            with open(os.path.join(d, "version.txt"), encoding="utf-8") as f:
                return f.read().strip() or "5.3.2"
        except OSError:
            pass
    return "5.3.2"


def _read_defaults():
    """Valeurs intégrées au package au moment de la compilation (clé TMDB, synchro, mises à jour)."""
    for d in (resource_dir(), app_dir()):
        try:
            with open(os.path.join(d, "defaults_build.json"), encoding="utf-8") as f:
                d = json.load(f)
            k = d.get("tmdb_key_obf") or ""
            if k:
                try:
                    raw = base64.b64decode(k.encode())
                    d["tmdb_key"] = bytes(b ^ 0x5A for b in raw).decode()
                except Exception:
                    d["tmdb_key"] = ""
            return d
        except (OSError, ValueError):
            pass
    return {}


VERSION = _read_version()
DEFAULTS = _read_defaults()


# --------------------------------------------------------------------------- stockage JSON
class Store:
    def __init__(self, name, default):
        self.path = os.path.join(DATA, name)
        self.lock = threading.RLock()
        self.data = default
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(default, dict):
                self.data = {**default, **loaded}
            else:
                self.data = loaded
        except (OSError, ValueError):
            pass

    def save(self):
        with self.lock:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, self.path)


CONFIG = Store("config.json", {
    "server": "", "username": "", "password": "", "tmdb_key": "",
    "player_path": "", "fullscreen": True, "live_format": "ts",
    "favs": [], "history": [], "country": "auto", "dl_dir": "", "show_unavailable": True,
    "dl_pause_play": True, "tv_mode": False, "profiles": [], "pdata": {}, "fixes": {},
    "sync_url": "", "sync_key": "",
})
TMDB_CACHE = Store("tmdb_cache.json", {})
VERIFY_CACHE = Store("verifications.json", {})
DL_STORE = Store("telechargements.json", {"items": []})

PROFILE_COLORS = ["#ff6a3d", "#3d8bff", "#2fbf71", "#b45cff", "#ffb347", "#ff4f8b", "#27c2c2"]


def _migrate_profiles():
    c = CONFIG.data
    if not c.get("profiles"):
        c["profiles"] = [{"id": "p1", "name": "Moi", "color": PROFILE_COLORS[0], "kids": False}]
        c["pdata"] = {"p1": {"favs": c.get("favs") or [], "history": c.get("history") or [],
                             "progress": c.get("progress") or {}, "notify": [], "reminders": []}}
        CONFIG.save()


_migrate_profiles()


def pdata(pid):
    """Données propres à un profil (liste, historique, reprise, alertes)."""
    c = CONFIG.data
    if pid not in c["pdata"]:
        pid = c["profiles"][0]["id"]
    d = c["pdata"].setdefault(pid, {})
    for k, v in (("favs", []), ("history", []), ("progress", {}), ("notify", []), ("reminders", []), ("follow", {})):
        d.setdefault(k, v if not isinstance(v, (list, dict)) else type(v)())
    return d


def tmdb_key():
    """Clé personnelle si renseignée, sinon clé intégrée au package."""
    return (CONFIG.data.get("tmdb_key") or "").strip() or (DEFAULTS.get("tmdb_key") or "").strip()


def user_country():
    cc = (CONFIG.data.get("country") or "auto").upper()
    return tvguide.detect_country() if cc in ("", "AUTO") else cc


# --------------------------------------------------------------------------- réseau
def http_json(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        return None
    return json.loads(text)


# --------------------------------------------------------------------------- nettoyage des noms
def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm(s):
    s = strip_accents(s or "").lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", s)


def _tok(pattern):
    return re.compile(r"(?<![a-z0-9])(?:" + pattern + r")(?![a-z0-9])", re.I)


# (motif, catégorie, étiquette) — l'ordre compte
TAG_RULES = [
    (_tok(r"3840p|2160p|4k|uhd|ultra\s?hd"), "q", "4K"),
    (_tok(r"1080[pi]|fhd|full\s?hd"), "q", "1080p"),
    (_tok(r"720p|hd|hdtv"), "q", "720p"),
    (_tok(r"480p|576p|sd"), "q", "SD"),
    (_tok(r"dolby\s?vision|dovi|dv"), "h", "DV"),
    (_tok(r"hdr10\+|hdr10plus|hdr10|hdr"), "h", "HDR"),
    (_tok(r"vostfr|vost|subfrench|st\s?fr"), "l", "VOSTFR"),
    (_tok(r"multi"), "l", "MULTI"),
    (_tok(r"truefrench|vff|vfq|vfi|vf2|vf|french|fr"), "l", "VF"),
    (_tok(r"vo|eng|english"), "l", "VO"),
    (_tok(r"x\.?26[45]|h\.?26[45]|hevc|avc|av1|10\s?bits?|atmos|dts(?:-?hd)?|truehd|ddp?\s?5\.1|e?ac3|aac|"
          r"web-?dl|webrip|web|bluray|blu-ray|bdrip|brrip|hdlight|remux|imax|3d|repack|proper|extended|"
          r"unrated|director'?s\s?cut|\d{2,3}\s?fps|backup|bkp|alt|raw|cam|hd-?cam|camrip|telesync|hd-?ts|"
          r"hd-?tc|ts-?rip|pdvd|screener|dvd-?scr|version\s+longue|[ée]dition\s+longue|version\s+int[ée]grale|"
          r"[ée]dition\s+sp[ée]ciale|special\s+edition|ultimate\s+(?:edition|cut)|uncut|redux|final\s+cut|"
          r"version\s+du\s+r[ée]alisateur"), "x", None),
]
QUALITY_RANK = {"4K": 4, "1080p": 3, "720p": 2, "SD": 1}
PREFIX_RE = re.compile(
    r"^\s*(?:\[[^\]]{1,14}\]|\|[^|]{1,14}\||\((?:[A-Z]{2,4}|4K|VF|VOSTFR|MULTI)\)|"
    r"(?:[A-Z]{2,4}|4K|UHD|FHD|HD|VOD|MULTI|VF|VOSTFR)(?:\s*[:|»>]+\s*|\s+-+\s+))\s*")
SYMBOLS_RE = re.compile(r"[\u2600-\u27BF\u2B00-\u2BFF\u25A0-\u25FF\u2190-\u21FF\U0001F000-\U0001FAFF★☆●◉♦◆•]+")


def clean_title(raw, channel=False):
    """'FR - Les évadés 4K DV (1994)' -> ('Les évadés', 1994, {'q':'4K','h':'DV','l':None})"""
    s = unicodedata.normalize("NFKC", raw or "")       # ᴴᴰ -> HD, ³⁸⁴⁰ᴾ -> 3840P
    s = SYMBOLS_RE.sub(" ", s)
    tags = {"q": None, "h": None, "l": None}
    for rx, cat, label in TAG_RULES:                    # étiquettes lues sur le nom complet
        if cat in tags and tags[cat] is None and rx.search(s):
            tags[cat] = label
    for _ in range(3):
        new = PREFIX_RE.sub("", s, count=1)
        if new == s or not new.strip():
            break
        s = new
    year = None
    if not channel:
        m = re.search(r"[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]", s)
        if not m:
            cands = [c for c in re.finditer(r"(?<![0-9])((?:19|20)\d{2})(?![0-9])", s)
                     if c.start() > 0 and int(c.group(1)) <= CURRENT_YEAR + 1]
            m = cands[-1] if cands else None
        if m and 1900 <= int(m.group(1)) <= CURRENT_YEAR + 1:
            year = int(m.group(1))
            s = s[:m.start()] + " " + s[m.end():]
    if s.count(" ") < 2 and (s.count(".") >= 2 or s.count("_") >= 2):
        s = re.sub(r"[._]", " ", s)
    for rx, _, _ in TAG_RULES:
        s = rx.sub(" ", s)
    s = s.replace("|", " ")
    s = re.sub(r"[\(\[]\s*[\)\]]", " ", s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"^[\s\-:|.,/]+|[\s\-:|.,/(\[]+$", "", s).strip()
    if not s:
        s = (raw or "").strip()
    return s, year, tags


def tags_label(tags):
    return " · ".join(t for t in (tags.get("q"), tags.get("h"), tags.get("l")) if t)


def to_int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def to_float(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- Xtream
class XtreamError(Exception):
    pass


# User-Agents essayés à la connexion : beaucoup de serveurs refusent (404/403) les
# navigateurs et n'acceptent que les applis IPTV connues.
# Profils de connexion : beaucoup de serveurs (souvent derrière Cloudflare) refusent les
# requêtes qui ne ressemblent pas exactement à un navigateur ou à une appli IPTV connue.
# On reproduit donc l'ensemble des en-têtes, dans le bon ordre, et pas seulement le nom.
PROFILES = {
    "chrome": [
        ("Connection", "keep-alive"),
        ("Upgrade-Insecure-Requests", "1"),
        ("User-Agent", UA),
        ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,"
                   "image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"),
        ("Accept-Encoding", "gzip, deflate"),
        ("Accept-Language", "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"),
    ],
    "okhttp": [("Connection", "Keep-Alive"), ("Accept-Encoding", "gzip"), ("User-Agent", "okhttp/4.9.2")],
    "smarters": [("User-Agent", "IPTVSmartersPlayer"), ("Connection", "Keep-Alive"), ("Accept-Encoding", "gzip")],
    "vlc": [("Accept", "*/*"), ("Accept-Language", "fr"), ("User-Agent", "VLC/3.0.20 LibVLC/3.0.20"),
            ("Range", "bytes=0-")],
    "tivimate": [("User-Agent", "TiviMate/4.7.0 (Linux; Android 11)"), ("Connection", "Keep-Alive"),
                 ("Accept-Encoding", "gzip")],
    "firefox": [
        ("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"),
        ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
        ("Accept-Language", "fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3"),
        ("Accept-Encoding", "gzip, deflate"),
        ("Connection", "keep-alive"),
        ("Upgrade-Insecure-Requests", "1"),
    ],
}
UA_CANDIDATES = list(PROFILES)


def profile_ua(name):
    return dict(PROFILES.get(name) or PROFILES["chrome"]).get("User-Agent", UA)


def raw_get(url, header_list, timeout=60, _redirects=4):
    """GET bas niveau (http.client) : en-têtes envoyés tels quels, sans les ajouts de urllib."""
    u = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(u.hostname, u.port, timeout=timeout)
    path = (u.path or "/") + ("?" + u.query if u.query else "")
    try:
        conn.putrequest("GET", path, skip_accept_encoding=True)
        for k, v in header_list:
            conn.putheader(k, v)
        conn.endheaders()
        r = conn.getresponse()
        body = r.read()
        if r.status in (301, 302, 303, 307, 308) and r.getheader("Location") and _redirects:
            return raw_get(urllib.parse.urljoin(url, r.getheader("Location")), header_list, timeout, _redirects - 1)
        if r.status >= 400:
            raise urllib.error.HTTPError(url, r.status, r.reason, r.headers, None)
        enc = (r.getheader("Content-Encoding") or "").lower()
        if enc == "gzip":
            body = gzip.decompress(body)
        elif enc == "deflate":
            try:
                body = zlib.decompress(body)
            except zlib.error:
                body = zlib.decompress(body, -zlib.MAX_WBITS)
        return body
    except http.client.HTTPException as e:
        raise urllib.error.URLError(str(e)) from e
    finally:
        conn.close()


def get_json(url, profile, timeout=60):
    text = raw_get(url, PROFILES.get(profile) or PROFILES["chrome"], timeout).decode("utf-8", "replace").strip()
    if text.startswith("\ufeff"):
        text = text[1:]
    return json.loads(text) if text else None


RETRY_CODES = (400, 401, 403, 404, 405, 406, 444, 451, 500, 502, 503, 512, 520, 521)


def parse_server_input(server, username="", password=""):
    """Accepte une adresse simple, une adresse avec chemin, ou un lien M3U complet
    (get.php?username=...&password=...) dont on extrait les identifiants."""
    s = (server or "").strip().strip('"').strip()
    if s and not re.match(r"[a-z]+://", s, re.I):
        s = "http://" + s
    u = urllib.parse.urlsplit(s)
    q = urllib.parse.parse_qs(u.query)
    username = username or (q.get("username") or [""])[0]
    password = password or (q.get("password") or [""])[0]
    path = re.sub(r"/(player_api|get|panel_api|xmltv)\.php$", "", u.path.rstrip("/"))
    path = re.sub(r"/(c|stalker_portal(/c)?|portal)$", "", path)    # adresses de portail
    return urllib.parse.urlunsplit((u.scheme.lower(), u.netloc, path, "", "")).rstrip("/"), username, password


class Xtream:
    def __init__(self, server, username, password):
        self.raw = (server, username, password)
        s, self.username, self.password = parse_server_input(server, (username or "").strip(), (password or "").strip())
        self.server = s
        self.ua = CONFIG.data.get("ua") if CONFIG.data.get("ua") in PROFILES else "chrome"
        self.output_formats = ["ts", "m3u8"]

    @property
    def user_agent(self):
        return profile_ua(self.ua)

    def _get(self, base, profile, params, timeout):
        url = f"{base}/player_api.php?{urllib.parse.urlencode(params)}"
        return get_json(url, profile, timeout)

    def api(self, action=None, timeout=120, **params):
        q = {"username": self.username, "password": self.password}
        if action:
            q["action"] = action
        q.update({k: v for k, v in params.items() if v is not None})
        try:
            return self._get(self.server, self.ua, q, timeout)
        except urllib.error.HTTPError as e:
            raise XtreamError(f"Le serveur a répondu {e.code}") from e
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
            raise XtreamError(f"Serveur injoignable ({getattr(e, 'reason', e)})") from e
        except ValueError as e:
            raise XtreamError("Réponse illisible du serveur (identifiants ou adresse incorrects ?)") from e

    def _bases(self):
        u = urllib.parse.urlsplit(self.server)
        bases = [self.server]
        other = "https" if u.scheme == "http" else "http"
        if u.path:
            bases.append(urllib.parse.urlunsplit((u.scheme, u.netloc, "", "", "")))
        bases.append(urllib.parse.urlunsplit((other, u.netloc, u.path, "", "")).rstrip("/"))
        out = []
        for b in bases:
            if b not in out:
                out.append(b)
        return out

    def login(self):
        if not self.server or not self.username:
            raise XtreamError("Adresse du serveur et identifiant requis")
        uas = [self.ua] + [x for x in UA_CANDIDATES if x != self.ua]
        params = {"username": self.username, "password": self.password}
        tried, last = [], None
        self._probe_log = []
        for base in self._bases():
            for ua in uas:
                try:
                    info = self._get(base, ua, params, 20)
                except urllib.error.HTTPError as e:
                    last = f"code {e.code}"
                    tried.append(f"{base} → {e.code}")
                    if e.code in RETRY_CODES:
                        continue
                    break
                except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
                    last = f"injoignable ({getattr(e, 'reason', e)})"
                    tried.append(f"{base} → injoignable")
                    break                      # inutile d'essayer d'autres UA sur cette adresse
                except ValueError:
                    last = "réponse illisible"
                    tried.append(f"{base} → réponse non JSON")
                    continue
                ui = (info or {}).get("user_info") if isinstance(info, dict) else None
                if not ui:
                    last = "réponse inattendue"
                    continue
                if str(ui.get("auth", 1)) == "0":
                    raise XtreamError("Identifiants refusés par le serveur")
                if ui.get("status") and ui["status"].lower() not in ("active", "actif"):
                    raise XtreamError(f"Compte {ui['status']}")
                self.server, self.ua = base, ua
                if CONFIG.data.get("ua") != ua:
                    CONFIG.data["ua"] = ua
                    CONFIG.save()
                fmts = ui.get("allowed_output_formats") or []
                if fmts:
                    self.output_formats = fmts
                return info
        found = self._probe_ports(params)
        if found:
            self.server, self.ua, info = found
            ui = info["user_info"]
            if str(ui.get("auth", 1)) == "0":
                raise XtreamError("Identifiants refusés par le serveur")
            CONFIG.data["ua"] = self.ua
            CONFIG.data["server"] = self.server       # on mémorise l'adresse complète trouvée
            CONFIG.save()
            self.raw = (self.server, self.username, self.password)
            if ui.get("allowed_output_formats"):
                self.output_formats = ui["allowed_output_formats"]
            return info
        detail = "; ".join(dict.fromkeys(tried))[:300]
        if getattr(self, "_probe_log", None):
            detail += ". Ports testés : " + ", ".join(self._probe_log)
        hint = " Vérifiez le port dans votre autre appli (ex. http://serveur:8080) ou collez votre lien M3U complet." \
            if not urllib.parse.urlsplit(self.server).port else ""
        raise XtreamError(f"Connexion impossible ({last}). Adresses essayées : {detail}.{hint}")

    COMMON_PORTS = [8080, 80, 8000, 25461, 2095, 2082, 2086, 8880, 8888, 8443, 443, 2052, 25463, 8081, 8090, 1935]

    def _probe_ports(self, params):
        """Aucun port indiqué et rien trouvé : on essaie les ports Xtream les plus courants."""
        self._probe_log = []
        u = urllib.parse.urlsplit(self.server)
        if u.port or not u.hostname:
            return None
        cands = [urllib.parse.urlunsplit(("https" if p in (443, 8443) else "http", f"{u.hostname}:{p}", u.path, "", ""))
                 for p in self.COMMON_PORTS]

        def check(base):
            last = "?"
            for ua in ("chrome", "okhttp", "smarters"):
                try:
                    info = self._get(base, ua, params, 6)
                except urllib.error.HTTPError as e:
                    last = str(e.code)
                    if e.code in RETRY_CODES:
                        continue
                    break
                except Exception:
                    last = "injoignable"
                    break
                if isinstance(info, dict) and info.get("user_info"):
                    return base, ua, info
                last = "réponse inattendue"
            self._probe_log.append(f"{urllib.parse.urlsplit(base).port} → {last}")
            return None

        with ThreadPoolExecutor(max_workers=8) as pool:
            for res in pool.map(check, cands):
                if res:
                    return res
        return None

    def stream_url(self, kind, sid, ext=None, live_fmt=None):
        u = urllib.parse.quote(self.username, safe="")
        p = urllib.parse.quote(self.password, safe="")
        if kind == "live":
            fmt = live_fmt or CONFIG.data.get("live_format") or "ts"
            if fmt not in self.output_formats and self.output_formats:
                fmt = "ts" if "ts" in self.output_formats else self.output_formats[0]
            return f"{self.server}/live/{u}/{p}/{sid}.{fmt}"
        folder = "movie" if kind == "movie" else "series"
        return f"{self.server}/{folder}/{u}/{p}/{sid}.{ext or 'mkv'}"

    def timeshift_url(self, sid, start, minutes):
        """Rattrapage (replay) : l'heure de début s'exprime dans le fuseau horaire du serveur."""
        u = urllib.parse.quote(self.username, safe="")
        p = urllib.parse.quote(self.password, safe="")
        tz = None
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(CONFIG.data.get("server_tz") or "Europe/Paris")
        except Exception:
            tz = None
        dt = datetime.datetime.fromtimestamp(int(start), tz) if tz else datetime.datetime.fromtimestamp(int(start))
        return f"{self.server}/timeshift/{u}/{p}/{int(max(1, minutes))}/{dt.strftime('%Y-%m-%d:%H-%M')}/{sid}.ts"


# --------------------------------------------------------------------------- catalogue
def build_catalog(raw):
    cats = {}
    for kind, key in (("movies", "vod_categories"), ("series", "series_categories"), ("live", "live_categories")):
        cats[kind] = {str(c.get("category_id")): (c.get("category_name") or "").strip()
                      for c in (raw.get(key) or []) if isinstance(c, dict)}

    # ---- films
    movies = {}
    for it in raw.get("vod_streams") or []:
        if not isinstance(it, dict):
            continue
        title, year, tags = clean_title(it.get("name") or "")
        year = year or to_int(it.get("year")) or None
        tm = to_int(it.get("tmdb") or it.get("tmdb_id"))
        key = f"tm{tm}" if tm > 0 else f"{norm(title)}_{year or ''}"
        g = movies.get(key)
        if not g:
            g = movies[key] = {"k": key, "t": title, "y": year, "p": "", "c": [], "a": 0, "r": 0.0,
                               "tm": tm or None, "v": []}
        icon = it.get("stream_icon") or ""
        if icon and not g["p"]:
            g["p"] = icon
        cid = str(it.get("category_id"))
        if cid not in g["c"]:
            g["c"].append(cid)
        g["a"] = max(g["a"], to_int(it.get("added")))
        g["r"] = max(g["r"], to_float(it.get("rating")))
        g["y"] = g["y"] or year
        g["v"].append({"id": it.get("stream_id"), "ext": it.get("container_extension") or "mkv",
                       "q": tags_label(tags), "rank": QUALITY_RANK.get(tags["q"], 0), "n": it.get("name")})
    # ---- séries
    series = {}
    for it in raw.get("series") or []:
        if not isinstance(it, dict):
            continue
        title, year, tags = clean_title(it.get("name") or "")
        year = year or to_int((it.get("releaseDate") or it.get("release_date") or "")[:4]) or None
        tm = to_int(it.get("tmdb") or it.get("tmdb_id"))
        key = f"tm{tm}" if tm > 0 else f"{norm(title)}_{year or ''}"
        g = series.get(key)
        if not g:
            g = series[key] = {"k": key, "t": title, "y": year, "p": "", "bd": "", "c": [], "a": 0, "r": 0.0,
                               "tm": tm or None, "pl": "", "g": "", "s": []}
        if it.get("cover") and not g["p"]:
            g["p"] = it["cover"]
        bd = it.get("backdrop_path")
        if isinstance(bd, list) and bd and not g["bd"]:
            g["bd"] = bd[0]
        g["pl"] = g["pl"] or (it.get("plot") or "")
        g["g"] = g["g"] or (it.get("genre") or "")
        cid = str(it.get("category_id"))
        if cid not in g["c"]:
            g["c"].append(cid)
        g["a"] = max(g["a"], to_int(it.get("last_modified")))
        g["r"] = max(g["r"], to_float(it.get("rating")))
        g["s"].append({"id": it.get("series_id"), "q": tags_label(tags), "n": it.get("name")})

    # ---- chaînes
    live = {}
    names = {}
    for it in raw.get("live_streams") or []:
        if not isinstance(it, dict):
            continue
        title, _, tags = clean_title(it.get("name") or "", channel=True)
        key = norm(title) or str(it.get("stream_id"))
        g = live.get(key)
        if not g:
            g = live[key] = {"k": key, "t": title, "p": "", "c": str(it.get("category_id")), "s": [], "num": to_int(it.get("num"), 99999)}
            names[key] = Counter()
        names[key][title] += 1
        if it.get("stream_icon") and not g["p"]:
            g["p"] = it["stream_icon"]
        q = tags.get("q")
        arc = to_int(it.get("tv_archive_duration")) if str(it.get("tv_archive") or "0") not in ("0", "") else 0
        g["s"].append({"id": it.get("stream_id"), "q": q or "", "rank": QUALITY_RANK.get(q, 2),
                       "n": it.get("name"), "epg": it.get("epg_channel_id") or "", **({"arc": arc} if arc > 0 else {})})
    for key, g in live.items():
        g["t"] = names[key].most_common(1)[0][0]
        g["s"].sort(key=lambda s: -s["rank"])
        g["cc"] = tvguide.channel_country([x["n"] or "" for x in g["s"]], cats["live"].get(g["c"], ""), key)
        arcs = [x.get("arc", 0) for x in g["s"]]
        if any(arcs):
            g["arc"] = max(arcs)

    movies = merge_groups(movies, "v", "m:")
    series = merge_groups(series, "s", "t:")

    def used(kind, items):
        u = set()
        for i in items:
            u.update(i["c"] if isinstance(i["c"], list) else [i["c"]])
        return {k: v for k, v in cats[kind].items() if k in u}

    m_list = sorted(movies.values(), key=lambda g: -g["a"])
    s_list = sorted(series.values(), key=lambda g: -g["a"])
    l_list = sorted(live.values(), key=lambda g: g["num"])
    cats_order = {k: list(cats[k].keys()) for k in cats}
    return {
        "movies": m_list, "series": s_list, "live": l_list,
        "cats": {"movies": used("movies", m_list), "series": used("series", s_list), "live": used("live", l_list),
                 "order": cats_order},
    }


def _absorb(dst, src, vkey):
    dst[vkey].extend(src[vkey])
    for c in src["c"]:
        if c not in dst["c"]:
            dst["c"].append(c)
    dst["a"] = max(dst["a"], src["a"])
    dst["r"] = max(dst["r"], src["r"])
    dst["y"] = dst["y"] or src["y"]
    dst["tm"] = dst["tm"] or src["tm"]
    for k in ("p", "bd", "pl", "g"):
        if k in dst and not dst[k] and src.get(k):
            dst[k] = src[k]


def merge_groups(groups, vkey, prefix):
    """Fusionne : 1) un titre sans année avec l'unique version datée du même titre,
    2) les fiches qui pointent vers la même œuvre TMDB (ex. titre anglais / titre français)."""
    by_title = {}
    for key, g in groups.items():
        by_title.setdefault(norm(g["t"]), []).append(key)
    for keys in by_title.values():
        undated = [k for k in keys if not groups[k]["y"] and not groups[k]["tm"]]
        dated = [k for k in keys if groups[k]["y"] or groups[k]["tm"]]
        if undated and len(dated) == 1:
            for k in undated:
                _absorb(groups[dated[0]], groups.pop(k), vkey)
    by_tm = {}
    for key in list(groups):
        m = TMDB_CACHE.data.get(prefix + key)
        tid = (m or {}).get("id") or groups[key]["tm"]
        if not tid:
            continue
        if tid in by_tm and by_tm[tid] in groups:
            _absorb(groups[by_tm[tid]], groups.pop(key), vkey)
        else:
            by_tm[tid] = key
    if vkey == "v":
        for g in groups.values():
            g["v"].sort(key=lambda v: -v["rank"])
    return groups


# --------------------------------------------------------------------------- TMDB
_genres_lock = threading.Lock()


def tmdb_get(path, **params):
    key = tmdb_key()
    if not key:
        raise RuntimeError("Pas de clé TMDB")
    headers = {}
    if key.startswith("eyJ"):
        headers["Authorization"] = "Bearer " + key
    else:
        params["api_key"] = key
    params.setdefault("language", "fr-FR")
    url = TMDB_API + path + "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    return http_json(url, headers=headers, timeout=15)


SPORTSDB = os.environ.get("CINEFLUX_SPORTSDB_API", "https://www.thesportsdb.com/api/v1/json/3")


def team_badge(name):
    """Écusson d'une équipe (TheSportsDB, gratuit), gardé en cache 30 jours (7 jours si introuvable)."""
    ck = "sdb:" + norm(name)
    c = TMDB_CACHE.data.get(ck)
    if c is not None and time.time() - c.get("ts", 0) < (30 if c.get("b") else 7) * 86400:
        return c.get("b")
    try:
        d = http_json(SPORTSDB + "/searchteams.php?" + urllib.parse.urlencode({"t": name}), timeout=8) or {}
    except Exception:
        return None
    t = (d.get("teams") or [None])[0] or {}
    b = t.get("strBadge") or t.get("strTeamBadge") or None
    TMDB_CACHE.data[ck] = {"b": b, "ts": int(time.time())}
    return b


def add_team_badges(events, pool, limit=12):
    """Matchs sans image : on ajoute les écussons des deux équipes."""
    jobs = []
    for e in events:
        if e.get("tag") == "Sport" and not e.get("img"):
            tm = tvguide.split_teams(e.get("title"))
            if tm:
                jobs.append((e, tm))
    jobs = jobs[:limit]
    names = list(dict.fromkeys(n for _, tm in jobs for n in tm))
    if not names:
        return
    found = dict(zip(names, pool.map(team_badge, names)))
    for e, tm in jobs:
        e["teams"] = [{"n": n, "b": found.get(n)} for n in tm]
    TMDB_CACHE.save()


def tmdb_genres(kind):
    ck = "_genres_" + kind
    with _genres_lock:
        g = TMDB_CACHE.data.get(ck)
        if g is None:
            try:
                g = {str(x["id"]): x["name"] for x in tmdb_get(f"/genre/{kind}/list").get("genres", [])}
            except Exception:
                g = {}
            TMDB_CACHE.data[ck] = g
        return g


def tmdb_pack(kind, d):
    if not d:
        return None
    date = d.get("release_date") or d.get("first_air_date") or ""
    if d.get("genres"):
        genres = [x.get("name") for x in d["genres"] if x.get("name")]
    else:
        gm = tmdb_genres(kind)
        genres = [gm.get(str(i)) for i in d.get("genre_ids") or [] if gm.get(str(i))]
    rt = d.get("runtime") or ((d.get("episode_run_time") or [None])[0])
    return {"id": d.get("id"), "t": d.get("title") or d.get("name") or "", "y": to_int(date[:4]) or None,
            "p": d.get("poster_path") or "", "b": d.get("backdrop_path") or "", "o": d.get("overview") or "",
            "v": round(to_float(d.get("vote_average")), 1), "g": genres[:3], "rt": rt or None, "ts": int(time.time())}


def _score(cand, title, year):
    n = norm(title)
    names = [cand.get("title") or cand.get("name") or "", cand.get("original_title") or cand.get("original_name") or ""]
    r = max(difflib.SequenceMatcher(None, n, norm(x)).ratio() for x in names)
    cy = to_int((cand.get("release_date") or cand.get("first_air_date") or "")[:4])
    if year and cy:
        r += 0.25 if cy == year else (0.1 if abs(cy - year) == 1 else -0.25)
    r += min(to_float(cand.get("popularity")), 100) / 1000
    return r


def tmdb_resolve(kind, title, year, tm_id):
    if tm_id:
        try:
            return tmdb_pack(kind, tmdb_get(f"/{kind}/{int(tm_id)}"))
        except Exception:
            pass
    queries = [(title, year)]
    if year:
        queries.append((title, None))
    if ":" in title or " - " in title:
        short = re.split(r":| - ", title)[0].strip()
        if len(short) > 2:
            queries.append((short, year))
    year_param = "year" if kind == "movie" else "first_air_date_year"
    for q, y in queries:
        res = tmdb_get(f"/search/{kind}", query=q, **({year_param: y} if y else {}), include_adult="false")
        cands = (res or {}).get("results") or []
        if not cands:
            continue
        best = max(cands[:10], key=lambda c: _score(c, title, year))
        if _score(best, title, year) >= 0.72:
            return tmdb_pack(kind, best)
    return None


def light_meta(m):
    return {k: m.get(k) for k in ("id", "t", "y", "p", "b", "v")} if m else None


# --------------------------------------------------------------------------- lecteur vidéo
def find_player():
    custom = (CONFIG.data.get("player_path") or "").strip().strip('"')
    cands = []
    if custom:
        cands.append(custom)
    base = app_dir()
    cands += [os.path.join(base, "mpv.exe"), os.path.join(base, "mpv", "mpv.exe"),
              os.path.join(base, "mpv", "mpv.com")]
    w = shutil.which("mpv")
    if w:
        cands.append(w)
    for pf in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
        cands.append(os.path.join(pf, "mpv", "mpv.exe"))
        cands.append(os.path.join(pf, "VideoLAN", "VLC", "vlc.exe"))
    w = shutil.which("vlc")
    if w:
        cands.append(w)
    if sys.platform == "darwin":
        cands += ["/Applications/mpv.app/Contents/MacOS/mpv", "/Applications/VLC.app/Contents/MacOS/VLC"]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


def player_kind(path):
    return "vlc" if "vlc" in os.path.basename(path or "").lower() else "mpv"


# --------------------------------------------------------------------------- application
IMG = "https://image.tmdb.org/t/p/"


class App:
    def __init__(self):
        self.lock = threading.RLock()
        self.catalog = None
        self.catalog_ts = 0
        self.movie_idx = {}
        self.xt = None
        self.account = {}
        self.online = None
        self.events = deque(maxlen=80)
        self.event_id = 0
        self.player_gen = 0
        self.player_proc = None
        self.playing = False
        self.play_title, self.play_since = "", 0
        self.remote_play, self.stop_cmds, self.remote_cmds = {}, {}, {}
        self.pool = ThreadPoolExecutor(max_workers=8)
        self.disc_cache, self.disc_lock = {}, threading.Lock()
        self.now_cache, self.now_lock = None, threading.Lock()
        self.tv_cache = {}
        self.matchers = {}
        self.vlc_host = None
        self.vlc_profile = None
        self.main_hidden = False
        self.main_fs = False
        self.sinfo_cache = {}
        self.rec_cache = {}
        self.refreshing = False
        self.vqueue = deque()
        self.vqueued = set()
        self.vlock = threading.Lock()
        self.epgc = tvguide.EpgCache(lambda sid, limit: self.epg(sid, limit), ttl=900)
        self.dl = downloads.DownloadManager(DL_STORE, {
            "url": lambda it: self.client().stream_url("movie" if it["kind"] == "movie" else "episode", it["vid"], it.get("ext")),
            "headers": lambda: PROFILES.get(self.client().ua) or PROFILES["chrome"],
            "folder": dl_folder,
            "event": self.event,
            "images": self._dl_images,
        })
        self.updater = updater.Updater(DEFAULTS.get("update_repo") or CONFIG.data.get("update_repo"), VERSION, self.event)
        self.updater.start()
        threading.Thread(target=self.preload, daemon=True, name="prechargement").start()
        threading.Thread(target=self._background, daemon=True, name="fond").start()
        threading.Thread(target=self._verify_worker, daemon=True, name="verif").start()

    # ------------------------------------------------------------------ évènements
    def event(self, msg, level="info", kind="toast", data=None):
        with self.lock:
            self.event_id += 1
            self.events.append({"id": self.event_id, "msg": msg, "level": level, "kind": kind, "data": data})

    # ------------------------------------------------------------------ connexion / catalogue
    def client(self):
        c = CONFIG.data
        if not self.xt or self.xt.raw != (c["server"], c["username"], c["password"]):
            self.xt = Xtream(c["server"], c["username"], c["password"])
        return self.xt

    def connect(self):
        try:
            info = self.client().login()
        except XtreamError as e:
            if "injoignable" in str(e) or "Connexion impossible" in str(e):
                self.online = False
            raise
        self.online = True
        ui = info.get("user_info") or {}
        tz = ((info.get("server_info") or {}).get("timezone") or "").strip()
        if tz and CONFIG.data.get("server_tz") != tz:
            CONFIG.data["server_tz"] = tz
            CONFIG.save()
        self.account = {"exp": to_int(ui.get("exp_date")) or None, "max": ui.get("max_connections"),
                        "active": ui.get("active_cons"), "status": ui.get("status")}
        return self.account

    def _raw_path(self):
        return os.path.join(DATA, "catalogue_brut.json")

    def _fp(self):
        return norm(CONFIG.data["server"] + CONFIG.data["username"])

    def cached_raw(self):
        try:
            with open(self._raw_path(), "r", encoding="utf-8") as f:
                raw = json.load(f)
            if raw.get("_fp") == self._fp():
                return raw
        except (OSError, ValueError):
            pass
        return None

    def fetch_raw(self):
        xt = self.client()
        actions = ["get_vod_categories", "get_vod_streams", "get_series_categories", "get_series",
                   "get_live_categories", "get_live_streams"]
        results = dict(zip(actions, self.pool.map(lambda a: self._safe_api(xt, a), actions)))
        raw = {"_fp": self._fp(), "_ts": time.time(),
               "vod_categories": results["get_vod_categories"], "vod_streams": results["get_vod_streams"],
               "series_categories": results["get_series_categories"], "series": results["get_series"],
               "live_categories": results["get_live_categories"], "live_streams": results["get_live_streams"]}
        if not any(raw[k] for k in ("vod_streams", "series", "live_streams")):
            raise XtreamError("Le serveur n'a renvoyé aucun contenu")
        tmp = self._raw_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, self._raw_path())
        return raw

    @staticmethod
    def _safe_api(xt, action):
        try:
            r = xt.api(action)
            return r if isinstance(r, list) else []
        except XtreamError:
            return []

    def _set_catalog(self, cat, ts):
        self.catalog = cat
        self.catalog_ts = ts
        self.movie_idx = {g["k"]: g for g in cat["movies"]}
        self.series_idx = {g["k"]: g for g in cat["series"]}
        self.live_idx = {g["k"]: g for g in cat["live"]}
        self.disc_cache, self.matchers = {}, {}

    BUILT_VER = 1

    def _built_path(self):
        return os.path.join(DATA, "catalogue.json")

    def cached_built(self):
        """Catalogue déjà préparé (prêt à afficher) : évite de tout recalculer à chaque démarrage."""
        try:
            with open(self._built_path(), "r", encoding="utf-8") as f:
                d = json.load(f)
            if d.get("_fp") == self._fp() and d.get("_v") == self.BUILT_VER and d.get("cat"):
                return d
        except (OSError, ValueError):
            pass
        return None

    def save_built(self, cat, ts):
        def work():
            try:
                tmp = self._built_path() + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump({"_fp": self._fp(), "_v": self.BUILT_VER, "_ts": ts, "cat": cat}, f,
                              ensure_ascii=False, separators=(",", ":"))
                os.replace(tmp, self._built_path())
            except (OSError, TypeError, ValueError, RuntimeError):
                pass
        threading.Thread(target=work, daemon=True, name="cache-catalogue").start()

    def preload(self):
        """Lancé dès l'ouverture : le catalogue est prêt avant même que l'interface le demande."""
        c = CONFIG.data
        if c.get("server") and c.get("username"):
            try:
                self.get_catalog()
            except Exception:
                pass

    def get_catalog(self, force=False):
        """Démarrage instantané : le catalogue enregistré est utilisé tel quel, même ancien.
        La mise à jour se fait ensuite en arrière-plan."""
        with self.lock:
            if self.catalog and not force:
                return self.catalog
            if not force:
                b = self.cached_built()
                if b:
                    self._set_catalog(b["cat"], b.get("_ts") or time.time())
                    return self.catalog
            raw = None if force else self.cached_raw()
            if raw is None:
                if not self.account:
                    self.connect()
                raw = self.fetch_raw()
            ts = raw.get("_ts", time.time())
            self._set_catalog(build_catalog(raw), ts)
            self.save_built(self.catalog, ts)
            return self.catalog

    def refresh_catalog(self, manual=False):
        """Mise à jour en arrière-plan : l'interface continue de fonctionner pendant le téléchargement."""
        if self.refreshing:
            return
        self.refreshing = True
        self.event("", "info", "refreshing", {"on": True})
        try:
            if not self.account:
                self.connect()
            raw = self.fetch_raw()
            new = build_catalog(raw)
            old = self.catalog or {"movies": [], "series": [], "live": []}
            om, osr = {g["k"] for g in old["movies"]}, {g["k"] for g in old["series"]}
            new_m = [g["k"] for g in new["movies"] if g["k"] not in om]
            new_s = [g["k"] for g in new["series"] if g["k"] not in osr]
            with self.lock:
                self._set_catalog(new, raw["_ts"])
            self.save_built(new, raw["_ts"])
            if new_m or new_s:
                parts = []
                if new_m:
                    parts.append(f"{len(new_m)} nouveau{'x' if len(new_m) > 1 else ''} film{'s' if len(new_m) > 1 else ''}")
                if new_s:
                    parts.append(f"{len(new_s)} nouvelle{'s' if len(new_s) > 1 else ''} série{'s' if len(new_s) > 1 else ''}")
                msg = "Catalogue mis à jour : " + " et ".join(parts)
            else:
                msg = "Catalogue à jour" if manual else ""
            self.event(msg, "info", "catalog", {"ts": int(raw["_ts"])})
            if old["movies"]:
                self.queue_verify(new_m[:400])
            self.check_notify()
            self.check_new_episodes()
        except Exception as e:  # noqa
            if manual:
                self.event(f"Mise à jour impossible : {e}", "error")
        finally:
            self.refreshing = False
            self.event("", "info", "refreshing", {"on": False})

    def _background(self):
        """Tâche de fond : connexion, mise à jour du catalogue toutes les 24 h, alertes."""
        time.sleep(3)
        last_notify = 0
        while True:
            try:
                c = CONFIG.data
                if c.get("server") and c.get("username"):
                    if not self.account:
                        try:
                            self.connect()
                        except Exception:
                            pass
                    if self.catalog and self.online and time.time() - self.catalog_ts > CATALOG_MAX_AGE:
                        self.refresh_catalog()
                    if self.catalog and time.time() - last_notify > 1800:
                        last_notify = time.time()
                        self.check_notify()
            except Exception:
                pass
            time.sleep(60)

    def live_ranked(self):
        """Chaînes du pays de l'utilisateur en premier, grandes chaînes d'abord."""
        cat = self.get_catalog()
        country = user_country()
        for g in cat["live"]:
            g["pr"] = tvguide.priority(g["k"], g.get("cc"), country)
            g["loc"] = 1 if g.get("cc") == country or (g.get("cc") is None and g["pr"] < 500) else 0
        return sorted(cat["live"], key=lambda g: (-g["loc"], g["pr"], g["num"])), country

    def catalog_payload(self, force=False):
        if force:
            self.refresh_catalog(manual=True)
        cat = self.get_catalog()
        live, country = self.live_ranked()
        meta = {}
        for pre, items in (("m:", cat["movies"]), ("t:", cat["series"])):
            for it in items:
                m = TMDB_CACHE.data.get(pre + it["k"])
                if m and m.get("id"):
                    meta[pre + it["k"]] = light_meta(m)
        loc_cats = []
        for g in live:
            if g["loc"] and g["c"] not in loc_cats:
                loc_cats.append(g["c"])
        order = cat["cats"]["order"].get("live") or []
        cats = dict(cat["cats"])
        cats["order"] = dict(cats["order"])
        cats["order"]["live"] = loc_cats + [c for c in order if c not in loc_cats]
        return {"movies": cat["movies"], "series": cat["series"], "live": live, "cats": cats,
                "meta": meta, "account": self.account, "verify": self.verify_map(), "ts": int(self.catalog_ts),
                "country": country}

    # ------------------------------------------------------------------ TMDB
    def enrich(self, items):
        has_key = bool(tmdb_key())
        out, todo = {}, []
        week = 7 * 86400
        for it in items[:60]:
            kind = "movie" if it.get("kind") == "movie" else "tv"
            mk = ("m:" if kind == "movie" else "t:") + str(it.get("key"))
            c = TMDB_CACHE.data.get(mk)
            if c and (c.get("id") or time.time() - c.get("ts", 0) < week):
                out[mk] = c if c.get("id") else None
            elif has_key:
                todo.append((mk, kind, it))
            else:
                out[mk] = None

        def work(job):
            mk, kind, it = job
            try:
                return mk, tmdb_resolve(kind, it.get("title") or "", to_int(it.get("year")) or None, it.get("tmdb"))
            except Exception:
                return mk, "error"

        for mk, res in self.pool.map(work, todo):
            if res == "error":
                out[mk] = None
                continue
            TMDB_CACHE.data[mk] = res or {"none": True, "ts": int(time.time())}
            out[mk] = res
        if todo:
            TMDB_CACHE.save()
        return out

    def tmdb_search(self, kind, query):
        kind = "movie" if kind == "movie" else "tv"
        res = tmdb_get(f"/search/{kind}", query=query)
        return [tmdb_pack(kind, r) for r in (res or {}).get("results", [])[:12]]

    def tmdb_override(self, kind, key, tm_id):
        kind = "movie" if kind == "movie" else "tv"
        m = tmdb_pack(kind, tmdb_get(f"/{kind}/{int(tm_id)}"))
        TMDB_CACHE.data[("m:" if kind == "movie" else "t:") + key] = m
        TMDB_CACHE.save()
        CONFIG.data.setdefault("fixes", {})[("m:" if kind == "movie" else "t:") + key] = int(tm_id)
        CONFIG.save()
        if kind == "movie":
            for v in (self.movie_idx.get(key) or {}).get("v", []):
                VERIFY_CACHE.data.pop(str(v["id"]), None)
            self.queue_verify([key], front=True)
        return m

    def tmdb_details(self, kind, tid):
        """Durée, dates de sortie (cinéma / numérique, tous pays) et bande-annonce, mises en cache 7 jours."""
        tkind = "movie" if kind == "movie" else "tv"
        ck = f"md:{tkind}:{tid}"
        c = TMDB_CACHE.data.get(ck)
        if c and time.time() - c.get("ts", 0) < 7 * 86400:
            return c
        extra = "release_dates,videos,credits" if tkind == "movie" else "videos,credits,content_ratings"
        d = tmdb_get(f"/{tkind}/{int(tid)}", append_to_response=extra, include_video_language="fr,en,null") or {}
        rel = dig = None
        for country in (d.get("release_dates") or {}).get("results") or []:
            for r in country.get("release_dates") or []:
                ts = iso_ts(r.get("release_date"))
                if not ts:
                    continue
                if r.get("type") in (2, 3):
                    rel = min(rel or ts, ts)
                elif r.get("type") in (4, 5):
                    dig = min(dig or ts, ts)
        if not rel:
            rel = iso_ts(d.get("release_date") or d.get("first_air_date"))
        vids = [v for v in (d.get("videos") or {}).get("results") or [] if v.get("site") == "YouTube"]
        vids.sort(key=lambda v: (v.get("type") != "Trailer", v.get("iso_639_1") != "fr", not v.get("official")))
        cast = [p.get("name") for p in ((d.get("credits") or {}).get("cast") or [])[:6]]
        crew = [p.get("name") for p in ((d.get("credits") or {}).get("crew") or []) if p.get("job") == "Director"][:2]
        if tkind == "tv":
            crew = [p.get("name") for p in d.get("created_by") or []][:2]
        packed = tmdb_pack(tkind, d) or {}
        rt = d.get("runtime") or ((d.get("episode_run_time") or [None]) or [None])[0]
        res = {**packed, "rt": rt, "rel": rel, "dig": dig, "yt": vids[0]["key"] if vids else None,
               "cast": cast, "dir": crew, "seasons": d.get("number_of_seasons"), "ts": int(time.time())}
        TMDB_CACHE.data[ck] = res
        return res

    def tmdb_info(self, kind, tid):
        d = dict(self.tmdb_details(kind, tid))
        d["status"] = ghost_status(d.get("rel"), d.get("dig"))
        TMDB_CACHE.save()
        return d

    def trailer(self, kind, tid):
        d = self.tmdb_details(kind, tid)
        TMDB_CACHE.save()
        return {"key": d.get("yt")}

    def matcher(self, kind):
        if kind not in self.matchers:
            cat = self.get_catalog()
            self.matchers[kind] = Matcher(cat["movies"] if kind == "movie" else cat["series"],
                                          "m:" if kind == "movie" else "t:")
        return self.matchers[kind]

    def similar(self, kind, tid):
        tkind = "movie" if kind == "movie" else "tv"
        prefix = "m:" if kind == "movie" else "t:"
        m = self.matcher(kind)
        keys, meta = [], {}
        for path in (f"/{tkind}/{int(tid)}/recommendations", f"/{tkind}/{int(tid)}/similar"):
            try:
                res = tmdb_get(path) or {}
            except Exception:
                continue
            for r in res.get("results") or []:
                for k in m.find(r)[:1]:
                    if k not in keys:
                        keys.append(k)
                        c = TMDB_CACHE.data.get(prefix + k)
                        if not (c and c.get("id")):
                            TMDB_CACHE.data[prefix + k] = c = tmdb_pack(tkind, r)
                        meta[prefix + k] = light_meta(c)
            if len(keys) >= 12:
                break
        TMDB_CACHE.save()
        return {"keys": keys[:24], "meta": meta}

    def _recs(self, kind, tid):
        """Recommandations TMDB pour un titre (mise en cache 12 h)."""
        tkind = "movie" if kind == "movie" else "tv"
        ck = f"{tkind}:{tid}"
        c = self.rec_cache.get(ck)
        if c and time.time() - c[0] < 12 * 3600:
            return c[1]
        out = []
        for path in (f"/{tkind}/{int(tid)}/recommendations", f"/{tkind}/{int(tid)}/similar"):
            try:
                out += (tmdb_get(path) or {}).get("results") or []
            except Exception:
                continue
            if len(out) >= 30:
                break
        self.rec_cache[ck] = (time.time(), out)
        return out

    def for_you(self, prof):
        """Rangées « Parce que vous avez regardé X » et suggestions personnelles, propres au profil."""
        if not tmdb_key():
            return {"rows": [], "meta": {}}
        d = pdata(prof)
        seeds, seen_keys = [], set()
        for h in d.get("history") or []:
            kind = h.get("kind")
            if kind not in ("movie", "series"):
                continue
            seen_keys.add((kind, h.get("key")))
            pre = "m:" if kind == "movie" else "t:"
            m = TMDB_CACHE.data.get(pre + (h.get("key") or "")) or {}
            idx = self.movie_idx if kind == "movie" else getattr(self, "series_idx", {})
            g = idx.get(h.get("key"))
            tid = m.get("id") or (g or {}).get("tm")
            if tid and g and len(seeds) < 5:
                seeds.append((kind, h["key"], int(tid), m.get("title") or g.get("t")))
        for f in d.get("favs") or []:
            kind, _, key = f.partition(":")
            if kind in ("movie", "series"):
                seen_keys.add((kind, key))
        results = list(self.pool.map(lambda sd: self._safe(self._recs, sd[0], sd[2]) or [], seeds))
        rows, meta, used, score = [], {}, set(), {}
        for (kind, key, tid, title), recs in zip(seeds, results):
            m = self.matcher(kind)
            pre = "m:" if kind == "movie" else "t:"
            tkind = "movie" if kind == "movie" else "tv"
            keys = []
            for rank, r in enumerate(recs):
                for k in m.find(r)[:1]:
                    if k == key or (kind, k) in seen_keys:
                        continue
                    c = TMDB_CACHE.data.get(pre + k)
                    if not (c and c.get("id")):
                        TMDB_CACHE.data[pre + k] = c = tmdb_pack(tkind, r)
                    meta[pre + k] = light_meta(c)
                    score[(kind, k)] = score.get((kind, k), 0) + 1 + (30 - min(rank, 30)) / 30
                    if (kind, k) not in used and k not in keys:
                        keys.append(k)
            fresh = [k for k in keys if (kind, k) not in used]
            if len(fresh) >= 4 and len(rows) < 3:
                used.update((kind, k) for k in fresh[:20])
                rows.append({"title": f"Parce que vous avez regardé « {title} »", "kind": kind, "keys": fresh[:20]})
        top = sorted((x for x in score.items()), key=lambda x: -x[1])
        mix = [{"kind": k, "key": key} for (k, key), sc in top if sc > 1.6][:20]
        if len(mix) >= 5:
            rows.insert(0, {"title": "Nos suggestions pour vous", "mixed": mix})
        TMDB_CACHE.save()
        return {"rows": rows, "meta": meta}

    def person_search(self, q):
        """Recherche par acteur, actrice, réalisateur : leurs films et séries présents dans le catalogue."""
        q = (q or "").strip()
        if len(q) < 3 or not tmdb_key():
            return {"people": [], "meta": {}}
        ck = "person:" + norm(q)
        c = self.rec_cache.get(ck)
        if c and time.time() - c[0] < 86400:
            return c[1]
        res = tmdb_get("/search/person", query=q) or {}
        people, meta = [], {}
        nq = norm(q)
        cands = [p for p in (res.get("results") or [])[:6] if p.get("popularity", 0) > 1 or norm(p.get("name") or "") == nq]
        cands.sort(key=lambda p: (norm(p.get("name") or "") != nq, -(p.get("popularity") or 0)))
        for p in cands[:2]:
            try:
                cr = tmdb_get(f"/person/{int(p['id'])}/combined_credits") or {}
            except Exception:
                continue
            dept = p.get("known_for_department") or ""
            pool = (cr.get("cast") or []) + [x for x in cr.get("crew") or [] if x.get("job") in ("Director", "Creator", "Screenplay", "Writer")]
            pool.sort(key=lambda x: -(x.get("popularity") or 0))
            got = {"movie": [], "series": []}
            for r in pool:
                kind = "movie" if r.get("media_type") == "movie" else "series" if r.get("media_type") == "tv" else None
                if not kind or r.get("character", "").lower().startswith(("self", "lui-même", "elle-même", "himself", "herself")):
                    continue
                pre = "m:" if kind == "movie" else "t:"
                for k in self.matcher(kind).find(r)[:1]:
                    if k in got[kind]:
                        continue
                    got[kind].append(k)
                    c = TMDB_CACHE.data.get(pre + k)
                    if not (c and c.get("id")):
                        TMDB_CACHE.data[pre + k] = c = tmdb_pack("movie" if kind == "movie" else "tv", r)
                    meta[pre + k] = light_meta(c)
            if got["movie"] or got["series"]:
                people.append({"id": p["id"], "name": p.get("name"), "img": p.get("profile_path") or "",
                               "role": {"Acting": "Acteur" if p.get("gender") != 1 else "Actrice", "Directing": "Réalisation",
                                        "Writing": "Scénario"}.get(dept, dept), "movies": got["movie"][:40], "series": got["series"][:20]})
        TMDB_CACHE.save()
        out = {"people": people, "meta": meta}
        self.rec_cache[ck] = (time.time(), out)
        return out

    def discover(self, kind, force=False):
        kind = "movie" if kind == "movie" else "series"
        if not tmdb_key():
            return {"rows": [], "meta": {}, "no_key": True}
        with self.disc_lock:
            c = self.disc_cache.get(kind)
            if c and not force and time.time() - c["ts"] < 6 * 3600:
                return c
            res = build_discover(self, kind)
            self.disc_cache[kind] = res
        if kind == "movie":
            keys = []
            for r in res["rows"]:
                keys += [k for k in r["keys"] if k not in keys]
            self.queue_verify(keys)
        return res

    # ------------------------------------------------------------------ vérification des versions
    def verify_map(self):
        out = {}
        for vid, r in VERIFY_CACHE.data.items():
            out[vid] = [r.get("st"), r.get("why") or "", r.get("ed") or "", r.get("dur"), r.get("warn") or ""]
        return out

    def queue_verify(self, keys, front=False):
        if not tmdb_key():
            return
        with self.vlock:
            for k in keys:
                if k in self.vqueued:
                    continue
                self.vqueued.add(k)
                (self.vqueue.appendleft if front else self.vqueue.append)(k)

    def _verify_worker(self):
        while True:
            key = None
            with self.vlock:
                if self.vqueue:
                    key = self.vqueue.popleft()
            if not key:
                time.sleep(2)
                continue
            try:
                changed = self.verify_group(key)
                if changed:
                    self.event("", "info", "verify", changed)
            except Exception:
                pass
            finally:
                with self.vlock:
                    self.vqueued.discard(key)
            time.sleep(0.15)

    def vod_tech(self, vid):
        info = self.client().api("get_vod_info", vod_id=vid, timeout=20) or {}
        i = info.get("info") or {}
        if isinstance(i, list):
            i = {}
        video = i.get("video") if isinstance(i.get("video"), dict) else {}
        md = info.get("movie_data") or {}
        return {"dur": verify.parse_duration(i.get("duration_secs")) or verify.parse_duration(i.get("duration"))
                or verify.parse_duration(i.get("episode_run_time")),
                "h": to_int(video.get("height")) or None, "kbps": to_int(i.get("bitrate")) or None,
                "tmdb": to_int(i.get("tmdb_id") or i.get("tmdb")) or None,
                "ext": md.get("container_extension")}

    def probe(self, url):
        """Lit la durée et la définition directement dans le fichier (via le moteur VLC), si rien d'autre ne tourne."""
        st = vlcplayer.status(app_dir())
        if not st["ok"] or self.playing or self.dl.current is not None:
            return {}
        v = vlcplayer.vlc
        inst = v.Instance("--quiet", "--no-video", "--no-audio")
        try:
            m = inst.media_new(url)
            m.add_option(f":http-user-agent={self.client().user_agent}")
            m.parse_with_options(v.MediaParseFlag.network, 12000)
            t0 = time.time()
            while time.time() - t0 < 14 and m.get_parsed_status() not in (
                    v.MediaParsedStatus.done, v.MediaParsedStatus.failed, v.MediaParsedStatus.timeout):
                time.sleep(0.2)
            dur = (m.get_duration() or 0) / 1000
            h = None
            try:
                for t in m.tracks_get() or []:
                    if t.type == v.TrackType.video:
                        h = t.video.contents.height
            except Exception:
                pass
            m.release()
            return {"dur": int(dur) if dur > 0 else None, "h": h}
        finally:
            inst.release()

    def verify_group(self, key, probe=False):
        g = self.movie_idx.get(key)
        if not g:
            return {}
        m = TMDB_CACHE.data.get("m:" + key)
        if not (m and m.get("id")):
            try:
                m = tmdb_resolve("movie", g["t"], g.get("y"), g.get("tm"))
            except Exception:
                return {}
            TMDB_CACHE.data["m:" + key] = m or {"none": True, "ts": int(time.time())}
        if not (m and m.get("id")):
            return {}
        md = self.tmdb_details("movie", m["id"])
        tm = {"id": m["id"], "y": md.get("y") or m.get("y"), "rt": md.get("rt"), "rel": md.get("rel"), "dig": md.get("dig")}
        changed = {}
        for v in g["v"]:
            sv = str(v["id"])
            c = VERIFY_CACHE.data.get(sv)
            fresh = c and c.get("tm") == tm["id"] and time.time() - c.get("ts", 0) < 30 * 86400 \
                and not (probe and c.get("st") == "unk")
            recent = tm.get("rel") and time.time() - tm["rel"] < 150 * 86400
            if fresh and not (recent and time.time() - c.get("ts", 0) > 3 * 86400):
                continue
            try:
                info = self.vod_tech(v["id"])
            except Exception:
                info = {}
            if not info.get("dur") and probe:
                try:
                    info.update({k: x for k, x in self.probe(self.client().stream_url("movie", v["id"], v.get("ext"))).items() if x})
                except Exception:
                    pass
            q = next((t for t in (v.get("q") or "").split(" · ") if t in QUALITY_RANK), None)
            r = verify.verify_version(v.get("n") or "", q, tm, info)
            r.update(tm=tm["id"], ts=int(time.time()))
            VERIFY_CACHE.data[sv] = r
            changed[sv] = [r["st"], r.get("why") or "", r.get("ed") or "", r.get("dur"), r.get("warn") or ""]
        if changed:
            VERIFY_CACHE.save()
            TMDB_CACHE.save()
        return changed

    def group_available(self, kind, key):
        if kind == "movie":
            g = self.movie_idx.get(key)
            if not g:
                return False
            return any((VERIFY_CACHE.data.get(str(v["id"])) or {}).get("st") != "bad" for v in g["v"])
        return key in getattr(self, "series_idx", {})

    def check_notify(self):
        """« Me prévenir » : un titre attendu est arrivé chez le fournisseur avec une version conforme."""
        if not self.catalog:
            return
        by_tm = {"movie": {}, "tv": {}}
        for pre, kind, items in (("m:", "movie", self.catalog["movies"]), ("t:", "tv", self.catalog["series"])):
            for it in items:
                m = TMDB_CACHE.data.get(pre + it["k"]) or {}
                for tid in {m.get("id"), it.get("tm")}:
                    if tid:
                        by_tm[kind][int(tid)] = it["k"]
        dirty = False
        for pid, d in CONFIG.data["pdata"].items():
            keep = []
            for n in d.get("notify") or []:
                kind = "movie" if n.get("kind") == "movie" else "tv"
                key = by_tm[kind].get(int(n.get("id") or 0))
                if key and self.group_available("movie" if kind == "movie" else "series", key):
                    self.event(f"« {n.get('title')} » est maintenant disponible !", "info", "avail",
                               {"profile": pid, "kind": "movie" if kind == "movie" else "series", "key": key})
                    dirty = True
                else:
                    keep.append(n)
            d["notify"] = keep
        if dirty:
            CONFIG.save()

    # ------------------------------------------------------------------ télévision
    def epg(self, sid, limit=4):
        res = self.client().api("get_short_epg", stream_id=sid, limit=limit, timeout=15) or {}
        out = []
        for e in res.get("epg_listings") or []:
            def dec(v):
                try:
                    return base64.b64decode(v).decode("utf-8", "replace")
                except Exception:
                    return v or ""
            out.append({"title": dec(e.get("title")).strip(), "desc": dec(e.get("description")).strip(),
                        "start": to_int(e.get("start_timestamp")), "end": to_int(e.get("stop_timestamp"))})
        return out

    def _local_epg(self, n=45):
        live, country = self.live_ranked()
        chans = tvguide.local_channels(live, country, n)
        return chans, tvguide.channel_epg(self.epgc, chans, 16), country

    def live_now(self, force=False):
        with self.now_lock:
            c = self.now_cache
            if c and not force and time.time() - c["ts"] < 240:
                return c
            chans, epg, country = self._local_epg()
            events, nowmap = tvguide.now_events(chans, epg, country)
            if tmdb_key():
                for e in [e for e in events if e["tag"] == "Film"][:5]:
                    m = self.lookup_movie(e["title"], e.get("desc") or "")
                    if m and m.get("b"):
                        e["img"] = m["b"]
                for e in [e for e in events[:30] if e["tag"] in ("Série", "Émission") and not e.get("img")][:6]:
                    m = self.lookup_tv(e["title"])
                    if m and m.get("b"):
                        e["img"] = m["b"]
            try:
                add_team_badges(events[:30], self.pool)
            except Exception:
                pass
            self.now_cache = {"events": events[:30], "now": nowmap, "ts": int(time.time()), "country": country}
            return self.now_cache

    def tonight(self, force=False):
        c = self.tv_cache.get("tonight")
        if c and not force and time.time() - c["ts"] < 1200:
            return c
        chans, epg, country = self._local_epg()
        has_key = bool(tmdb_key())
        items, day = tvguide.tonight(chans, epg, country,
                                     self.lookup_movie if has_key else (lambda *a: None),
                                     self.lookup_tv if has_key else (lambda *a: None), has_key)
        try:
            add_team_badges(items, self.pool)
        except Exception:
            pass
        TMDB_CACHE.save()
        c = {"items": items, "day": int(day), "ts": int(time.time()), "country": country}
        self.tv_cache["tonight"] = c
        return c

    def guide(self):
        chans, epg, country = self._local_epg(40)
        return tvguide.guide(chans, epg, country)

    def lookup_movie(self, title, desc=""):
        t = re.sub(r"\s*[\(\[].*?[\)\]]\s*$", "", title or "").strip()
        ck = "epgm:" + norm(t)
        c = TMDB_CACHE.data.get(ck)
        if c is not None and time.time() - c.get("ts", 0) < 30 * 86400:
            return c if c.get("id") else None
        ym = re.search(r"\b(19|20)\d{2}\b", desc or "")
        year = int(ym.group(0)) if ym else None
        res = None
        try:
            r = (tmdb_get("/search/movie", query=t, **({"year": year} if year else {})) or {}).get("results") or []
            if r:
                best = r[0]
                names = [best.get("title") or "", best.get("original_title") or ""]
                if max(difflib.SequenceMatcher(None, norm(t), norm(x)).ratio() for x in names) > 0.82:
                    res = tmdb_pack("movie", best)
                    res["pop"] = to_float(best.get("popularity"))
                    if to_int(best.get("vote_count")) < 150:
                        res["v"] = 0
        except Exception:
            return None
        TMDB_CACHE.data[ck] = res or {"none": True, "ts": int(time.time())}
        return res

    def lookup_tv(self, title):
        t = re.sub(r"\s*[\(\[].*?[\)\]]\s*$", "", title or "").strip()
        t = re.split(r"\s+[-:]\s+|\s+S\d+", t)[0]
        ck = "epgt:" + norm(t)
        c = TMDB_CACHE.data.get(ck)
        if c is not None and time.time() - c.get("ts", 0) < 30 * 86400:
            return c if c.get("id") else None
        res = None
        try:
            r = (tmdb_get("/search/tv", query=t) or {}).get("results") or []
            if r and to_int(r[0].get("vote_count")) >= 80:
                if difflib.SequenceMatcher(None, norm(t), norm(r[0].get("name") or "")).ratio() > 0.85:
                    res = tmdb_pack("tv", r[0])
        except Exception:
            return None
        TMDB_CACHE.data[ck] = res or {"none": True, "ts": int(time.time())}
        return res

    # ------------------------------------------------------------------ séries / films (fournisseur)
    def series_info(self, sid):
        info = self.client().api("get_series_info", series_id=sid) or {}
        meta = info.get("info") or {}
        show = clean_title(meta.get("name") or "")[0]
        eps_raw = info.get("episodes") or {}
        if isinstance(eps_raw, list):  # certains serveurs renvoient une liste de listes
            eps_raw = {str(i + 1): v for i, v in enumerate(eps_raw)}
        seasons = {}
        for snum, eps in eps_raw.items():
            lst = []
            for e in eps or []:
                ei = e.get("info") or {}
                if isinstance(ei, list):
                    ei = {}
                t = e.get("title") or ""
                m = re.search(r"S\d+\s*E\d+\s*[-:.]?\s*(.*)$", t, re.I)
                t = (m.group(1) if m else t).strip(" -:")
                if show and norm(t) == norm(show):
                    t = ""
                num = to_int(e.get("episode_num"), len(lst) + 1)
                lst.append({"id": e.get("id"), "n": num, "t": t or f"Épisode {num}",
                            "ext": e.get("container_extension") or "mkv",
                            "img": ei.get("movie_image") or ei.get("cover_big") or "",
                            "plot": ei.get("plot") or ei.get("overview") or "",
                            "dur": ei.get("duration") or ""})
            lst.sort(key=lambda x: x["n"])
            seasons[str(to_int(snum, snum))] = lst
        order = sorted(seasons.keys(), key=lambda s: (to_int(s, 999) == 0, to_int(s, 999)))
        bd = meta.get("backdrop_path")
        return {"seasons": order, "episodes": seasons,
                "info": {"plot": meta.get("plot") or "", "cast": meta.get("cast") or "", "genre": meta.get("genre") or "",
                         "director": meta.get("director") or "", "rating": meta.get("rating") or "",
                         "backdrop": bd[0] if isinstance(bd, list) and bd else ""}}

    def replay(self, key):
        """Programmes passés disponibles en rattrapage pour une chaîne (si le fournisseur l'enregistre)."""
        g = getattr(self, "live_idx", {}).get(key)
        if not g or not g.get("arc"):
            return {"available": False}
        src = max(g["s"], key=lambda x: x.get("arc", 0))
        res = self.client().api("get_simple_data_table", stream_id=src["id"], timeout=30) or {}
        now = time.time()
        floor = now - src.get("arc", 0) * 86400
        rows = res.get("epg_listings") or [] if isinstance(res, dict) else []
        flagged = any("has_archive" in e for e in rows)

        def dec(v):
            try:
                return base64.b64decode(v).decode("utf-8", "replace").strip()
            except Exception:
                return (v or "").strip()
        out, seen = [], set()
        for e in rows:
            st, en = to_int(e.get("start_timestamp")), to_int(e.get("stop_timestamp"))
            if not st or st >= now or st < floor or st in seen:
                continue
            if en <= now and flagged and str(e.get("has_archive") or "0") == "0":
                continue
            seen.add(st)
            out.append({"title": dec(e.get("title")), "desc": dec(e.get("description")), "start": st, "end": en,
                        "live": en > now})
        out.sort(key=lambda x: x["start"])
        return {"available": True, "days": src.get("arc", 0), "sid": src["id"], "progs": out}

    def series_cached(self, sid, max_age=1800):
        c = self.sinfo_cache.get(str(sid))
        if c and time.time() - c[0] < max_age:
            return c[1]
        d = self.series_info(sid)
        self.sinfo_cache[str(sid)] = (time.time(), d)
        return d

    @staticmethod
    def _flat(d):
        return [(sn, e) for sn in d["seasons"] if sn != "0" for e in d["episodes"][sn]]

    @staticmethod
    def _ep_label(sn, e):
        lbl = f"S{int(sn):02d}E{int(e['n']):02d}" if str(sn).isdigit() else f"E{e['n']}"
        return lbl + (f" – {e['t']}" if e.get("t") and not re.match(r"^Épisode \d+$", e["t"]) else "")

    def _series_for(self, g, ep):
        """Source (et liste d'épisodes) contenant l'épisode vu."""
        srcs = [x["id"] for x in g.get("s") or []]
        if ep and ep.get("sid") in srcs:
            srcs.remove(ep["sid"])
            srcs.insert(0, ep["sid"])
        for sid in srcs[:4]:
            try:
                d = self.series_cached(sid)
            except Exception:
                continue
            flat = self._flat(d)
            if not ep or not ep.get("id") or any(str(e["id"]) == str(ep.get("id")) for _, e in flat):
                return sid, flat
        return None, []

    def up_next(self, prof):
        """« À suivre » : pour chaque série dont le dernier épisode vu est terminé, l'épisode suivant."""
        d = pdata(prof)
        idx = getattr(self, "series_idx", {})
        last = {}
        for pid, p in (d.get("progress") or {}).items():
            if p.get("kind") != "series" or not p.get("key") or not p.get("ep"):
                continue
            if p.get("key") not in last or (p.get("ts") or 0) > (last[p["key"]].get("ts") or 0):
                last[p["key"]] = p
        cands = sorted((p for p in last.values() if p.get("done") and time.time() - (p.get("ts") or 0) < 200 * 86400),
                       key=lambda p: -(p.get("ts") or 0))[:12]
        prog = d.get("progress") or {}

        def one(p):
            g = idx.get(p["key"])
            if not g:
                return None
            sid, flat = self._series_for(g, p["ep"])
            if not flat:
                return None
            f = d.setdefault("follow", {}).setdefault(p["key"], {})
            f.update(cnt=len(flat), sid=sid, a=g.get("a") or 0)
            i = next((k for k, (_, e) in enumerate(flat) if str(e["id"]) == str(p["ep"].get("id"))), None)
            if i is None:
                return None
            i += 1
            while i < len(flat) and (prog.get(f"e:{flat[i][1]['id']}") or {}).get("done"):
                i += 1
            if i >= len(flat):
                f["caught_up"] = True
                return None
            f["caught_up"] = False
            mk = lambda sn, e: {"sub": self._ep_label(sn, e), "pid": f"e:{e['id']}",  # noqa: E731
                                "ep": {"id": e["id"], "ext": e["ext"], "sid": sid},
                                "streams": [{"type": "episode", "id": e["id"], "ext": e["ext"], "label": "Épisode"}]}
            sn, e = flat[i]
            started = prog.get(f"e:{e['id']}")
            return {"kind": "series", "key": p["key"], "next": True, "ts": p.get("ts"), "img": e.get("img") or "",
                    "label": self._ep_label(sn, e), "new": bool(f.get("new")), "pos": (started or {}).get("pos") or 0,
                    "dur": (started or {}).get("dur") or 0, **mk(sn, e),
                    "queue": [mk(*x) for x in flat[i + 1:i + 30]]}
        out = [r for r in self.pool.map(lambda p: self._safe(one, p), cands) if r]
        CONFIG.save()
        return out

    @staticmethod
    def _safe(fn, *a):
        try:
            return fn(*a)
        except Exception:
            return None

    def check_new_episodes(self):
        """Après une mise à jour du catalogue : nouveaux épisodes des séries suivies (tous profils)."""
        idx = getattr(self, "series_idx", {})
        changed = False
        for prof in CONFIG.data["profiles"]:
            d = pdata(prof["id"])
            for key, f in list((d.get("follow") or {}).items()):
                g = idx.get(key)
                if not g or not f.get("cnt") or time.time() - (f.get("ts") or 0) > 200 * 86400:
                    continue
                if (g.get("a") or 0) <= (f.get("a") or 0):
                    continue
                f["a"] = g.get("a") or 0
                changed = True
                try:
                    self.sinfo_cache.pop(str(f.get("sid")), None)
                    sid, flat = self._series_for(g, {"sid": f.get("sid")} if f.get("sid") else None)
                except Exception:
                    continue
                if len(flat) > f["cnt"]:
                    n = len(flat) - f["cnt"]
                    f["new"] = (f.get("new") or 0) + n
                    f["cnt"] = len(flat)
                    sn, e = flat[-1]
                    title = g.get("t") or ""
                    self.event(f"{'Nouvel épisode' if n == 1 else f'{n} nouveaux épisodes'} de « {title} » : {self._ep_label(sn, e)}",
                               "info", "newep", {"key": key, "profile": prof["id"]})
        if changed:
            CONFIG.save()

    def movie_info(self, vid):
        info = self.client().api("get_vod_info", vod_id=vid) or {}
        i = info.get("info") or {}
        if isinstance(i, list):
            i = {}
        bd = i.get("backdrop_path")
        return {"plot": i.get("plot") or i.get("description") or "", "cast": i.get("cast") or i.get("actors") or "",
                "director": i.get("director") or "", "genre": i.get("genre") or "", "duration": i.get("duration") or "",
                "rating": i.get("rating") or "", "backdrop": bd[0] if isinstance(bd, list) and bd else "",
                "tmdb": to_int(i.get("tmdb_id") or i.get("tmdb")) or None}

    # ------------------------------------------------------------------ lecture
    def playback(self, on, title=None):
        """Lecture en cours : les téléchargements se mettent en pause (une seule connexion autorisée).
        Les autres appareils du groupe le savent (synchro) : ils peuvent prévenir, ou demander l'arrêt."""
        was = self.playing
        self.playing = on
        if on:
            if title:
                self.play_title = title
            if not was:
                self.play_since = int(time.time())
        else:
            self.play_title, self.play_since = "", 0
        if bool(was) != bool(on):
            s = getattr(self, "sync", None)
            if s and s.group:
                s.poke()
        self.dl.hold("play", bool(on and CONFIG.data.get("dl_pause_play", True)))

    def others_playing(self):
        """Appareils du groupe en train de lire (présence rafraîchie toutes les 5 minutes pendant la lecture)."""
        s = getattr(self, "sync", None)
        me = s.store.get("device") if s else None
        if s and s.group and self.stop_cmds:
            s.poke()                      # arrêt demandé : on regarde plus souvent si l'autre appareil a libéré la place
        now = time.time()
        out = []
        for dev, v in list(self.remote_play.items()):
            if dev == me or not isinstance(v, dict) or now - (v.get("hb") or 0) > 12 * 60:
                continue
            out.append({"id": dev, "name": v.get("n") or "Un autre appareil", "title": v.get("t") or ""})
        return {"others": out, "max": to_int((self.account or {}).get("max")) or 1}

    def remote_stop(self, dev):
        self.stop_cmds[dev] = int(time.time())
        s = getattr(self, "sync", None)
        if s and s.group:
            s.poke()
        return {"ok": True}

    def stop_from_remote(self, who):
        """Un autre appareil a demandé l'arrêt de la lecture ici (abonnement à une seule connexion)."""
        self.player_gen += 1
        self._stop_player()
        self.vlc_stop()
        self.playback(False)
        self.event(f"Lecture arrêtée à la demande de « {who} »", "info", "remote_stop", {"from": who})

    def stream(self, s):
        self.player_gen += 1
        self._stop_player()
        self.vlc_stop()
        local = self.dl.local_file(vid=s.get("id")) if s.get("type") in ("movie", "episode") else None
        if local:
            return {"url": f"/dl/{local['id']}?t={TOKEN}", "mode": "file", "local": True}
        self.playback(True, s.get("title"))
        xt = self.client()
        kind = s.get("type")
        if kind == "replay":
            return {"url": proxy_path(xt.timeshift_url(s.get("id"), s.get("start"), s.get("dur") or 60)), "mode": "ts"}
        if kind == "live":
            fmt = "m3u8" if "m3u8" in xt.output_formats else "ts"
            url = xt.stream_url("live", s.get("id"), live_fmt=fmt)
            return {"url": proxy_path(url), "mode": "hls" if fmt == "m3u8" else "ts"}
        url = xt.stream_url(kind, s.get("id"), s.get("ext"))
        return {"url": proxy_path(url), "mode": "file", "ext": (s.get("ext") or "").lower()}

    def vlc_status(self):
        return vlcplayer.status(app_dir())

    def vlc_hooks(self):
        return {
            "ua": lambda: self.client().user_agent,
            "volume": lambda: CONFIG.data.get("volume", 100),
            "set_volume": self._set_volume,
            "progress": lambda e: save_progress(e, e.get("profile")),
            "event": lambda msg, level="info": self.event(msg, level),
            "zap": self.vlc_zap,
            "closed": self._vlc_closed,
            "shown": self._vlc_shown,
        }

    # Lecteur unifié : la fenêtre VLC prend la place exacte de la fenêtre ShippoTV, qui s'efface
    # pendant la lecture puis réapparaît au même endroit (et à la taille du lecteur s'il a été déplacé).
    def _vlc_shown(self):
        if WINDOW is not None and self.vlc_host and self.vlc_host.win:
            try:
                WINDOW.hide()
                self.main_hidden = True
            except Exception:
                pass

    def _vlc_closed(self, geo=None):
        self.playback(False)
        if WINDOW is not None and getattr(self, "main_hidden", False):
            self.main_hidden = False
            try:
                if geo and geo.get("w", 0) > 300 and not self.main_fs:
                    WINDOW.move(int(geo["x"]), int(geo["y"]))
                    WINDOW.resize(int(geo["w"]), int(geo["h"]))
                WINDOW.show()
            except Exception:
                pass
        self.event("", "info", "closed")

    def _set_volume(self, v):
        CONFIG.data["volume"] = int(v)

    def _vlc_streams(self, streams):
        xt = self.client()
        out = []
        for s in streams:
            if s.get("id") is None:
                continue
            local = self.dl.local_file(vid=s["id"]) if s.get("type") in ("movie", "episode") else None
            if local:
                url = local["path"]
            elif s.get("type") == "replay":
                url = xt.timeshift_url(s["id"], s.get("start"), s.get("dur") or 60)
            else:
                url = xt.stream_url(s.get("type"), s.get("id"), s.get("ext"),
                                    live_fmt="ts" if s.get("type") == "live" else None)
            out.append({"url": url, "label": (s.get("label") or "") + (" · hors ligne" if local else ""),
                        "id": s.get("id"), "local": bool(local)})
        out.sort(key=lambda x: not x["local"])
        return out

    def _resume(self, pid, prof):
        p = (pdata(prof).get("progress") or {}).get(pid or "")
        if p and p.get("dur") and 30 < p.get("pos", 0) < 0.94 * p["dur"]:
            return int(p["pos"])
        return 0

    def vlc_payload(self, b, prof):
        live = b.get("kind") == "live"
        now = (self.now_cache or {}).get("now", {}).get(b.get("key")) if live else None
        item = {"title": b.get("title") or "", "sub": b.get("sub") or "", "kind": b.get("kind"), "key": b.get("key"),
                "pid": b.get("pid"), "ep": b.get("ep"), "streams": self._vlc_streams(b.get("streams") or []),
                "resume": 0 if live else self._resume(b.get("pid"), prof), "now": now, "profile": prof}
        q = []
        for x in (b.get("queue") or [])[:60]:
            q.append({"title": x.get("title") or item["title"], "sub": x.get("sub") or "", "kind": b.get("kind"),
                      "key": b.get("key"), "pid": x.get("pid"), "ep": x.get("ep"), "profile": prof,
                      "streams": self._vlc_streams(x.get("streams") or []), "resume": self._resume(x.get("pid"), prof)})
        item["queue"] = q
        item["fullscreen"] = bool(CONFIG.data.get("fullscreen", True)) or self.main_fs
        item["icon"] = os.path.join(resource_dir(), "assets", "shippotv.png")
        if not os.path.isfile(item["icon"]):
            item["icon"] = os.path.join(app_dir(), "assets", "shippotv.png")
        if WINDOW is not None:
            try:
                item["geometry"] = {"x": WINDOW.x, "y": WINDOW.y, "w": WINDOW.width, "h": WINDOW.height}
            except Exception:
                pass
        return item

    def vlc_play(self, body, prof):
        st = self.vlc_status()
        if not st["ok"]:
            raise RuntimeError("Le lecteur VLC intégré n'est pas disponible (" + (st.get("error") or "libVLC introuvable") + ")")
        payload = self.vlc_payload(body, prof)
        if not payload["streams"]:
            raise RuntimeError("Aucune source à lire")
        self.player_gen += 1
        self._stop_player()
        if not all(s["local"] for s in payload["streams"][:1]):
            self.playback(True, body.get("title"))
        if self.vlc_host is None:
            self.vlc_host = vlcplayer.VlcHost(self.vlc_hooks())
        self.vlc_profile = prof
        self.vlc_host.play(payload)
        if body.get("kind") in ("movie", "series", "live") and body.get("key"):
            push_history(body["kind"], body["key"], prof)
            CONFIG.save()
        return {"ok": True}

    def vlc_stop(self):
        if self.vlc_host is not None:
            self.vlc_host.stop()

    def vlc_zap(self, key, d):
        lst, _ = self.live_ranked()
        i = next((k for k, g in enumerate(lst) if g["k"] == key), None)
        if i is None or not lst:
            return None
        g = lst[(i + d) % len(lst)]
        now = (self.now_cache or {}).get("now", {}).get(g["k"])
        push_history("live", g["k"], self.vlc_profile)
        return {"title": g["t"], "sub": now["t"] if now else "", "kind": "live", "key": g["k"], "pid": None, "ep": None,
                "now": now, "queue": [], "resume": 0, "profile": self.vlc_profile,
                "streams": self._vlc_streams([{"type": "live", "id": x["id"],
                                               "label": f"Source {k + 1}" + (f" · {x['q']}" if x.get("q") else "")}
                                              for k, x in enumerate(g["s"])])}

    def play_external(self, title, streams, kind=None, key=None, prof=None):
        player = find_player()
        if not player:
            raise RuntimeError("Aucun lecteur trouvé. Installez mpv ou VLC, ou indiquez son chemin dans les réglages.")
        xt = self.client()
        urls = []
        for s in streams:
            if s.get("id") is None:
                continue
            local = self.dl.local_file(vid=s["id"]) if s.get("type") in ("movie", "episode") else None
            urls.append(local["path"] if local else xt.stream_url(s.get("type"), s.get("id"), s.get("ext")))
        if not urls:
            raise RuntimeError("Aucune source à lire")
        if kind and key:
            push_history(kind, key, prof)
            CONFIG.save()
        self.player_gen += 1
        gen = self.player_gen
        self._stop_player()
        self.vlc_stop()
        self.playback(True, title)
        threading.Thread(target=self._run_player, args=(gen, player, urls, title, kind == "live"), daemon=True).start()
        return {"player": os.path.basename(player), "sources": len(urls)}

    def _stop_player(self):
        p = self.player_proc
        if p and p.poll() is None:
            try:
                p.terminate()
            except OSError:
                pass

    def _run_player(self, gen, player, urls, title, is_live):
        try:
            self._run_player_inner(gen, player, urls, title, is_live)
        finally:
            if gen == self.player_gen:
                self.playback(False)

    def _run_player_inner(self, gen, player, urls, title, is_live):
        pk = player_kind(player)
        watch_dir = os.path.join(DATA, "reprise")
        os.makedirs(watch_dir, exist_ok=True)
        fs = bool(CONFIG.data.get("fullscreen", True))
        for idx, url in enumerate(urls):
            if gen != self.player_gen:
                return
            if pk == "mpv":
                args = [player, url, f"--force-media-title={title}", "--hwdec=auto-safe",
                        f"--user-agent={self.client().user_agent}", "--keep-open=no", "--osd-level=1"]
                if fs:
                    args.append("--fs")
                if is_live:
                    args += ["--cache=yes", "--demuxer-max-bytes=64MiB", "--network-timeout=15"]
                else:
                    args += ["--save-position-on-quit", f"--watch-later-directory={watch_dir}",
                             "--watch-later-options=start"]
            else:
                args = [player, url, f"--meta-title={title}", "--no-video-title-show", "--play-and-exit",
                        f":http-user-agent={self.client().user_agent}"]
                if fs:
                    args.append("--fullscreen")
            kw = {}
            if sys.platform == "win32":
                kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
            try:
                t0 = time.time()
                self.player_proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                    stderr=subprocess.DEVNULL, **kw)
                if idx == 0:
                    self.event(f"Lecture de « {title} » dans {'mpv' if pk == 'mpv' else 'VLC'}")
                rc = self.player_proc.wait()
            except OSError as e:
                self.event(f"Impossible de lancer le lecteur : {e}", "error")
                return
            if gen != self.player_gen:
                return
            failed = pk == "mpv" and rc not in (0, 4) and time.time() - t0 < 25
            if not failed:
                return
            if idx + 1 < len(urls):
                self.event(f"Source {idx + 1} indisponible, essai de la source {idx + 2}…", "warn")
            else:
                self.event("Aucune source n'a fonctionné pour le moment", "error")

    # ------------------------------------------------------------------ téléchargements
    def _dl_images(self, it):
        pre = "m:" if it["kind"] == "movie" else "t:"
        m = TMDB_CACHE.data.get(pre + str(it.get("key"))) or {}
        g = (self.movie_idx if it["kind"] == "movie" else getattr(self, "series_idx", {})).get(it.get("key")) or {}
        return {"poster": (IMG + "w342" + m["p"]) if m.get("p") else (g.get("p") or ""),
                "backdrop": (IMG + "w1280" + m["b"]) if m.get("b") else (g.get("bd") or "")}

    def download(self, body):
        entries = []
        for e in body.get("items") or []:
            if e.get("vid") is None:
                continue
            entries.append({"kind": "movie" if e.get("kind") == "movie" else "episode", "key": e.get("key"),
                            "vid": e.get("vid"), "ext": e.get("ext") or "mkv", "title": e.get("title") or "",
                            "sub": e.get("sub") or "", "label": e.get("label") or "", "year": e.get("year"),
                            "ep": e.get("ep"), "pid": e.get("pid")})
        ids = self.dl.add(entries)
        return {"added": len(ids)}


def dl_folder():
    return (CONFIG.data.get("dl_dir") or "").strip() or downloads.default_dir()


def iso_ts(s):
    if not s:
        return None
    try:
        return int(time.mktime(time.strptime(s[:10], "%Y-%m-%d")))
    except (ValueError, OverflowError):
        return None


def ghost_status(rel, dig):
    now = time.time()
    if rel and rel > now:
        return "Prochainement"
    if rel and now - rel < 150 * 86400 and not (dig and dig <= now):
        return "Au cinéma"
    return "Indisponible"


# =========================================================================== découverte (TMDB × catalogue)
def _d(days):
    return time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))


def discover_lists(kind):
    today, y1, y5 = _d(0), _d(365), _d(365 * 6)
    if kind == "movie":
        D = "/discover/movie"
        recent = {"primary_release_date.gte": y1, "primary_release_date.lte": today}
        return [
            ("trend", "Tendances de la semaine", "/trending/movie/week", {}, 5),
            ("blockbusters", "Blockbusters des 12 derniers mois", D, {**recent, "sort_by": "revenue.desc", "vote_count.gte": 40}, 5),
            ("top12", "Les mieux notés des 12 derniers mois", D, {**recent, "sort_by": "vote_average.desc", "vote_count.gte": 150}, 5),
            ("popular", "Populaires en ce moment", "/movie/popular", {}, 5),
            ("new", "Sorties récentes", D, {"primary_release_date.gte": _d(200), "primary_release_date.lte": today,
                                             "sort_by": "popularity.desc", "vote_count.gte": 20}, 4),
            ("fr", "Cinéma français", D, {"with_origin_country": "FR", "sort_by": "popularity.desc",
                                         "primary_release_date.gte": y5, "vote_count.gte": 30}, 4),
            ("action", "Action et aventure", D, {"with_genres": "28|12", "sort_by": "popularity.desc", "vote_count.gte": 300}, 3),
            ("comedy", "Comédies", D, {"with_genres": "35", "sort_by": "popularity.desc", "vote_count.gte": 200}, 3),
            ("family", "Animation et famille", D, {"with_genres": "16|10751", "sort_by": "popularity.desc", "vote_count.gte": 200}, 3),
            ("scifi", "Science-fiction et fantastique", D, {"with_genres": "878|14", "sort_by": "popularity.desc", "vote_count.gte": 300}, 3),
            ("thriller", "Thrillers et policiers", D, {"with_genres": "53|80", "sort_by": "popularity.desc", "vote_count.gte": 300}, 3),
            ("horror", "Frissons", D, {"with_genres": "27", "sort_by": "popularity.desc", "vote_count.gte": 200}, 3),
            ("drama", "Grands drames", D, {"with_genres": "18", "sort_by": "popularity.desc", "vote_count.gte": 500}, 3),
            ("classics", "Les incontournables", "/movie/top_rated", {}, 5),
            ("docs", "Documentaires", D, {"with_genres": "99", "sort_by": "popularity.desc", "vote_count.gte": 30}, 2),
        ]
    D = "/discover/tv"
    return [
        ("trend", "Séries tendances de la semaine", "/trending/tv/week", {}, 5),
        ("top12", "Les mieux notées du moment", D, {"air_date.gte": y1, "air_date.lte": today, "sort_by": "vote_average.desc",
                                                   "vote_count.gte": 150}, 5),
        ("popular", "Séries populaires", "/tv/popular", {}, 5),
        ("new", "Nouvelles séries de l'année", D, {"first_air_date.gte": y1, "first_air_date.lte": today,
                                                   "sort_by": "popularity.desc", "vote_count.gte": 15}, 4),
        ("fr", "Séries françaises", D, {"with_origin_country": "FR", "sort_by": "popularity.desc", "vote_count.gte": 15}, 4),
        ("crime", "Crime et suspense", D, {"with_genres": "80|9648", "sort_by": "popularity.desc", "vote_count.gte": 100}, 3),
        ("scifi", "Science-fiction et fantastique", D, {"with_genres": "10765", "sort_by": "popularity.desc", "vote_count.gte": 100}, 3),
        ("comedy", "Comédies", D, {"with_genres": "35", "sort_by": "popularity.desc", "vote_count.gte": 100}, 3),
        ("drama", "Drames", D, {"with_genres": "18", "sort_by": "popularity.desc", "vote_count.gte": 200}, 3),
        ("anime", "Animés", D, {"with_genres": "16", "with_original_language": "ja", "sort_by": "popularity.desc",
                                "vote_count.gte": 50}, 3),
        ("docs", "Documentaires et télé-réalité", D, {"with_genres": "99|10764", "sort_by": "popularity.desc", "vote_count.gte": 20}, 2),
        ("classics", "Séries cultes", "/tv/top_rated", {}, 5),
    ]


def title_keys(title):
    words = re.findall(r"[a-z0-9]+", strip_accents(title or "").lower().replace("&", " and "))
    keys = {"".join(words)} if words else set()
    if len(words) > 1 and words[0] in ("le", "la", "les", "l", "the", "a", "an", "un", "une", "des"):
        keys.add("".join(words[1:]))
    return keys


class Matcher:
    def __init__(self, items, prefix):
        self.by_title, self.by_tm = {}, {}
        for it in items:
            for k in title_keys(it["t"]):
                self.by_title.setdefault(k, []).append(it)
            m = TMDB_CACHE.data.get(prefix + it["k"]) or {}
            for tid in {it.get("tm"), m.get("id")}:
                if tid:
                    self.by_tm.setdefault(int(tid), []).append(it["k"])

    def find(self, r):
        keys = list(self.by_tm.get(int(r["id"]), []))
        if keys:
            return keys
        ry = to_int((r.get("release_date") or r.get("first_air_date") or "")[:4]) or None
        seen = set()
        for t in (r.get("title") or r.get("name"), r.get("original_title") or r.get("original_name")):
            for k in title_keys(t):
                for it in self.by_title.get(k, []):
                    if it["k"] in seen:
                        continue
                    if not it["y"] or not ry or abs(it["y"] - ry) <= 1:
                        seen.add(it["k"])
                        keys.append(it["k"])
        return keys


GHOST_ROWS = {"trend", "blockbusters", "top12", "new", "popular"}


def build_discover(app, kind):
    """Rangées TMDB croisées avec le catalogue. Dans les rangées d'actualité, les titres absents
    chez le fournisseur sont gardés (« fantômes ») pour être affichés avec un bandeau."""
    cat = app.get_catalog()
    tkind = "movie" if kind == "movie" else "tv"
    prefix = "m:" if kind == "movie" else "t:"
    matcher = app.matcher(kind)
    lock = threading.Lock()

    def one(spec):
        rid, title, path, params, pages = spec
        entries, seen_ids, avail = [], set(), 0
        ghosts_ok = rid in GHOST_ROWS
        res = {}
        for page in range(1, pages + 1):
            try:
                res = tmdb_get(path, page=page, **params) or {}
            except Exception:
                break
            for r in res.get("results") or []:
                if r.get("id") in seen_ids:
                    continue
                seen_ids.add(r.get("id"))
                found = matcher.find(r)
                if found:
                    packed = None
                    with lock:
                        for k in found:
                            c = TMDB_CACHE.data.get(prefix + k)
                            if not (c and c.get("id")):
                                packed = packed or tmdb_pack(tkind, r)
                                TMDB_CACHE.data[prefix + k] = packed
                    if not any(e.get("k") == found[0] for e in entries):
                        entries.append({"k": found[0], "also": found[1:]})
                        avail += 1
                elif ghosts_ok and r.get("poster_path") and len(entries) < 40:
                    g = tmdb_pack(tkind, r)
                    rel = iso_ts(r.get("release_date") or r.get("first_air_date"))
                    g.update(kind=kind, rel=rel, status=ghost_status(rel, None))
                    entries.append({"g": g})
            if avail >= 30 or len(entries) >= 40 or page >= (res.get("total_pages") or 1):
                break
        keys = []
        for e in entries:
            if "k" in e:
                keys += [e["k"]] + [k for k in e["also"] if k not in keys]
        return {"id": rid, "title": title, "kind": kind, "items": entries[:40], "keys": keys[:60]}

    with ThreadPoolExecutor(max_workers=6) as pool:
        rows = list(pool.map(one, discover_lists(kind)))
    TMDB_CACHE.save()
    rows = [r for r in rows if len(r["keys"]) >= 4 or (r["id"] in GHOST_ROWS and len(r["items"]) >= 6)]
    meta = {}
    for r in rows:
        for k in r["keys"]:
            m = TMDB_CACHE.data.get(prefix + k)
            if m and m.get("id"):
                meta[prefix + k] = light_meta(m)
    return {"rows": rows, "meta": meta, "ts": int(time.time())}


# =========================================================================== proxy vidéo (lecteur intégré)
def sign_url(url):
    return hmac.new(TOKEN.encode(), url.encode(), hashlib.sha256).hexdigest()[:32]


def proxy_path(url):
    b = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
    ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1][:6]
    return f"/p/{sign_url(url)}/{b}{ext}"


def unproxy(sig, blob):
    blob = blob.split(".")[0]
    url = base64.urlsafe_b64decode(blob + "=" * (-len(blob) % 4)).decode()
    return url if hmac.compare_digest(sig, sign_url(url)) else None


def rewrite_m3u8(text, base_url):
    out = []
    for line in text.splitlines():
        st = line.strip()
        if st and not st.startswith("#"):
            out.append(proxy_path(urllib.parse.urljoin(base_url, st)))
        elif 'URI="' in st:
            out.append(re.sub(r'URI="([^"]+)"', lambda m: 'URI="%s"' % proxy_path(urllib.parse.urljoin(base_url, m.group(1))), st))
        else:
            out.append(line)
    return "\n".join(out) + "\n"


def push_history(kind, key, prof=None):
    d = pdata(prof)
    h = [x for x in d["history"] if not (x.get("kind") == kind and x.get("key") == key)]
    h.insert(0, {"kind": kind, "key": key, "ts": int(time.time())})
    d["history"] = h[:30]


def save_progress(body, prof=None):
    """Position de lecture. Un titre terminé garde un repère « vu » (sert à « À suivre »)."""
    d = pdata(prof)
    prog = d["progress"]
    pid = str(body.get("id"))
    prev = prog.get(pid) or {}
    if body.get("clear"):
        if body.get("forget"):
            prog.pop(pid, None)
        else:
            e = {k: body.get(k) if body.get(k) is not None else prev.get(k) for k in ("kind", "key", "label", "ep", "dur", "vid")}
            e.update(pos=e.get("dur") or prev.get("dur") or 0, done=True, ts=int(time.time()))
            prog[pid] = e
    else:
        prog[pid] = {k: body.get(k) for k in ("kind", "key", "label", "ep", "pos", "dur", "vid")}
        prog[pid]["ts"] = int(time.time())
    if len(prog) > 400:
        for k in sorted(prog, key=lambda k: prog[k].get("ts", 0))[:len(prog) - 400]:
            prog.pop(k, None)
    if body.get("kind") and body.get("key"):
        if not body.get("forget"):
            push_history(body["kind"], body["key"], prof)
        if body["kind"] == "series":
            f = d.setdefault("follow", {}).setdefault(body["key"], {})
            f["new"] = 0
            f["ts"] = int(time.time())
    CONFIG.save()


APP = App()


# --------------------------------------------------------------------------- synchronisation entre appareils
SYNC_STORE = Store("synchro.json", {})
PROF_KEYS = ("favs", "history", "progress", "notify", "reminders")


def sync_export():
    """État local aplati en éléments indépendants (un favori, une reprise… = un élément)."""
    c = CONFIG.data
    out = {}
    with CONFIG.lock:
        for i, p in enumerate(c["profiles"]):
            out[f"prof/{p['id']}"] = {"name": p.get("name"), "color": p.get("color"), "kids": bool(p.get("kids")), "o": i}
        ids = {p["id"] for p in c["profiles"]}
        now = time.time()
        for pid, d in c["pdata"].items():
            if pid not in ids:
                continue
            for f in d.get("favs") or []:
                out[f"p/{pid}/fav/{f}"] = 1
            for k, v in (d.get("progress") or {}).items():
                out[f"p/{pid}/prog/{k}"] = v
            for h in d.get("history") or []:
                out[f"p/{pid}/hist/{h.get('kind')}:{h.get('key')}"] = {"ts": h.get("ts")}
            for n in d.get("notify") or []:
                out[f"p/{pid}/notify/{n.get('kind')}:{n.get('id')}"] = n
            for r in d.get("reminders") or []:
                if (r.get("end") or 0) > now:
                    out[f"p/{pid}/rem/{r.get('key')}@{r.get('start')}"] = r
        for mk, tid in (c.get("fixes") or {}).items():
            out[f"fix/{mk}"] = tid
    # clé TMDB partagée dans le groupe (chiffrée comme le reste) : les appareils qui n'en ont pas la reçoivent
    if tmdb_key():
        out["cfg/tmdb"] = tmdb_key()
    # présence de lecture et demandes d'arrêt (éléments passagers)
    s = getattr(APP, "sync", None)
    if s and APP.playing and APP.play_since:
        out[f"play/{s.store.get('device')}"] = {"t": APP.play_title, "n": s.store.get("name"), "since": APP.play_since,
                                                 "hb": int(time.time() // 300 * 300)}
    for dev, ts in list(APP.stop_cmds.items()):
        if time.time() - ts > 180:
            APP.stop_cmds.pop(dev, None)
        else:
            out[f"cmd/stop/{dev}"] = {"from": s.store.get("name") if s else "", "ts": ts}
    # éléments passagers reçus des autres appareils : renvoyés tels quels (sinon la synchro les effacerait)
    me = s.store.get("device") if s else None
    for dev, v in list(APP.remote_play.items()):
        if dev != me and isinstance(v, dict) and time.time() - (v.get("hb") or 0) < 12 * 60:
            out.setdefault(f"play/{dev}", v)
    for k, v in list(APP.remote_cmds.items()):
        if time.time() - (v.get("ts") or 0) < 180:
            out.setdefault(k, v)
        else:
            APP.remote_cmds.pop(k, None)
    return out


def sync_apply(changes):
    """Applique les modifications venues des autres appareils."""
    c = CONFIG.data
    fixes = []
    s = getattr(APP, "sync", None)
    me = s.store.get("device") if s else None
    rest = []
    for k, v in changes:
        if k.startswith("play/"):
            if v is None:
                APP.remote_play.pop(k[5:], None)
            else:
                APP.remote_play[k[5:]] = v
        elif k.startswith("cmd/stop/"):
            if v is None:
                APP.remote_cmds.pop(k, None)
            else:
                APP.remote_cmds[k] = v
            if v and k[9:] == me and APP.playing and (v.get("ts") or 0) >= APP.play_since - 5 and time.time() - (v.get("ts") or 0) < 180:
                APP.stop_from_remote(v.get("from") or "un autre appareil")
        else:
            rest.append((k, v))
    changes = rest
    if not changes:
        return
    with CONFIG.lock:
        changes = sorted(changes, key=lambda kv: not kv[0].startswith("prof/"))   # profils d'abord
        for k, v in changes:
            parts = k.split("/", 3)
            if k == "cfg/tmdb":
                if isinstance(v, str) and v.strip() and not tmdb_key():
                    c["tmdb_key"] = v.strip()
                continue
            if parts[0] == "prof":
                pid = parts[1]
                cur = next((p for p in c["profiles"] if p["id"] == pid), None)
                if v is None:
                    if cur and len(c["profiles"]) > 1:
                        c["profiles"].remove(cur)
                        c["pdata"].pop(pid, None)
                    continue
                if not cur:
                    cur = {"id": pid}
                    c["profiles"].append(cur)
                    c["pdata"].setdefault(pid, {})
                cur.update(name=v.get("name") or "Profil", color=v.get("color") or PROFILE_COLORS[0], kids=bool(v.get("kids")),
                           _o=v.get("o", 99))
            elif parts[0] == "p" and len(parts) == 4:
                pid, typ, item = parts[1], parts[2], parts[3]
                d = c["pdata"].setdefault(pid, {})
                for kk in PROF_KEYS:
                    d.setdefault(kk, {} if kk == "progress" else [])
                if typ == "fav":
                    d["favs"] = [f for f in d["favs"] if f != item]
                    if v is not None:
                        d["favs"].insert(0, item)
                elif typ == "prog":
                    if v is None:
                        d["progress"].pop(item, None)
                    else:
                        d["progress"][item] = v
                elif typ == "hist":
                    kind, _, key = item.partition(":")
                    h = [x for x in d["history"] if f"{x.get('kind')}:{x.get('key')}" != item]
                    if v is not None:
                        h.append({"kind": kind, "key": key, "ts": v.get("ts") or 0})
                    d["history"] = sorted(h, key=lambda x: -(x.get("ts") or 0))[:30]
                elif typ == "notify":
                    n = [x for x in d["notify"] if f"{x.get('kind')}:{x.get('id')}" != item]
                    if v is not None:
                        n.insert(0, v)
                    d["notify"] = n
                elif typ == "rem":
                    r = [x for x in d["reminders"] if f"{x.get('key')}@{x.get('start')}" != item]
                    if v is not None:
                        r.append(v)
                    d["reminders"] = r
            elif parts[0] == "fix":
                mk = k[4:]
                if v is None:
                    c["fixes"].pop(mk, None)
                elif c.setdefault("fixes", {}).get(mk) != v:
                    c["fixes"][mk] = v
                    fixes.append((mk, v))
        if any(p.get("_o") is not None for p in c["profiles"]):
            c["profiles"].sort(key=lambda p: p.get("_o", 99))
            for p in c["profiles"]:
                p.pop("_o", None)
        CONFIG.save()
    for mk, tid in fixes:          # corrections de jaquette faites sur un autre appareil
        try:
            APP.tmdb_override("movie" if mk.startswith("m:") else "series", mk[2:], tid)
        except Exception:
            pass


def sync_settings():
    c = CONFIG.data
    return ((c.get("sync_url") or DEFAULTS.get("supabase_url") or "").strip(),
            (c.get("sync_key") or DEFAULTS.get("supabase_key") or "").strip())


def make_sync():
    url, key = sync_settings()
    old = getattr(APP, "sync", None)
    if old:
        old.running = False
        old.wake.set()
    s = sync.SyncClient(url, key, SYNC_STORE.data, SYNC_STORE.save,
                        {"export": sync_export, "apply": sync_apply, "event": APP.event})
    APP.sync = s
    s.start()
    return s


make_sync()
_config_save = CONFIG.save


def _save_and_sync():
    _config_save()
    s = getattr(APP, "sync", None)
    if s and s.group:
        s.poke()


CONFIG.save = _save_and_sync


# --------------------------------------------------------------------------- serveur HTTP local
TOKEN = secrets.token_urlsafe(18)
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json"}


def public_config(prof=None):
    c = CONFIG.data
    player = find_player()
    vs = APP.vlc_status()
    d = pdata(prof)
    pid = prof if prof in c["pdata"] else c["profiles"][0]["id"]
    return {"configured": bool(c["server"] and c["username"]), "server": c["server"], "username": c["username"],
            "has_password": bool(c["password"]), "has_tmdb": bool(tmdb_key()), "own_tmdb": bool((c.get("tmdb_key") or "").strip()),
            "builtin_tmdb": bool(DEFAULTS.get("tmdb_key")), "version": VERSION,
            "player": player or "", "player_kind": player_kind(player) if player else None,
            "player_path": c.get("player_path", ""), "fullscreen": c.get("fullscreen", True),
            "live_format": c.get("live_format", "ts"),
            "player_mode": {"internal": "auto"}.get(c.get("player_mode"), c.get("player_mode") or "auto"),
            "native": WINDOW is not None, "vlc": vs["ok"], "vlc_where": vs.get("where") or "",
            "vlc_version": vs.get("version") or "", "vlc_error": vs.get("error") or "",
            "profiles": c["profiles"], "profile": pid, "favs": d["favs"], "history": d["history"],
            "progress": d["progress"], "notify": d["notify"], "reminders": d["reminders"],
            "follow": {k: {"new": v.get("new") or 0} for k, v in (d.get("follow") or {}).items() if v.get("new")},
            "country_setting": (c.get("country") or "auto").upper(), "country": user_country(),
            "countries": [{"code": k, **v} for k, v in tvguide.COUNTRIES.items()],
            "dl_dir": dl_folder(), "dl_pause_play": c.get("dl_pause_play", True),
            "show_unavailable": c.get("show_unavailable", True), "tv_mode": c.get("tv_mode", False),
            "online": APP.online, "catalog_ts": int(APP.catalog_ts or 0), "refreshing": APP.refreshing}


WINDOW = None


class Handler(BaseHTTPRequestHandler):
    server_version = "ShippoTV"
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        extra = {}
        if len(body) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 5)
            extra["Content-Encoding"] = "gzip"
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _authorized(self, q):
        return secrets.compare_digest(self.headers.get("X-Token") or (q.get("t") or [""])[0], TOKEN)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path.startswith("/api/"):
            return self._api("GET", u.path, q, None)
        if u.path.startswith("/p/"):
            return self._proxy(u.path)
        if u.path.startswith(("/dl/", "/img/")):
            if not self._authorized(q):
                return self._send(403, b"Forbidden", "text/plain")
            parts = u.path.strip("/").split("/")
            it = APP.dl.local_file(did=parts[1]) if len(parts) > 1 else None
            if not it:
                return self._send(404, b"Not found", "text/plain")
            if parts[0] == "img":
                p = (it.get("img") or {}).get(parts[2] if len(parts) > 2 else "poster")
                if not p or not os.path.isfile(p):
                    return self._send(404, b"Not found", "text/plain")
                with open(p, "rb") as f:
                    return self._send(200, f.read(), "image/jpeg")
            return self._file(it["path"])
        rel = "index.html" if u.path in ("/", "") else urllib.parse.unquote(u.path.lstrip("/"))
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.normpath(WEB_DIR)) or not os.path.isfile(full):
            return self._send(404, b"Not found", "text/plain")
        with open(full, "rb") as f:
            self._send(200, f.read(), MIME.get(os.path.splitext(full)[1], "application/octet-stream"))

    def _file(self, path):
        size = os.path.getsize(path)
        ext = os.path.splitext(path)[1].lower()
        ctype = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/webm",
                 ".ts": "video/mp2t", ".avi": "video/x-msvideo"}.get(ext, "application/octet-stream")
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m:
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            elif m.group(2):
                start = max(0, size - int(m.group(2)))
        end = min(end, size - 1)
        self.send_response(206 if m else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if m:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            self.close_connection = True

    def _proxy(self, path):
        parts = path.split("/", 3)
        try:
            target = unproxy(parts[2], parts[3])
        except Exception:
            target = None
        if not target:
            return self._send(403, b"Forbidden", "text/plain")
        prof = [(k, v) for k, v in (PROFILES.get(APP.client().ua) or PROFILES["chrome"])
                if k not in ("Accept-Encoding", "Range", "Connection")]
        prof += [("Accept-Encoding", "identity"), ("Connection", "close")]
        if self.headers.get("Range"):
            prof.append(("Range", self.headers["Range"]))
        url, conn, r = target, None, None
        try:
            for _ in range(6):
                sp = urllib.parse.urlsplit(url)
                cls = http.client.HTTPSConnection if sp.scheme == "https" else http.client.HTTPConnection
                conn = cls(sp.hostname, sp.port, timeout=25)
                conn.putrequest("GET", (sp.path or "/") + ("?" + sp.query if sp.query else ""), skip_accept_encoding=True)
                for k, v in prof:
                    conn.putheader(k, v)
                conn.endheaders()
                r = conn.getresponse()
                if r.status in (301, 302, 303, 307, 308) and r.getheader("Location"):
                    url = urllib.parse.urljoin(url, r.getheader("Location"))
                    r.read()
                    conn.close()
                    continue
                break
            ctype = r.getheader("Content-Type") or "application/octet-stream"
            if r.status >= 400:
                r.read()
                return self._send(r.status, f"Source {r.status}".encode(), "text/plain")
            if urllib.parse.urlsplit(url).path.endswith(".m3u8") or "mpegurl" in ctype.lower():
                body = rewrite_m3u8(r.read().decode("utf-8", "replace"), url).encode()
                return self._send(200, body, "application/vnd.apple.mpegurl")
            if ctype in ("application/octet-stream", "text/plain") or not ctype:
                ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1].lower()
                ctype = {".mkv": "video/x-matroska", ".mp4": "video/mp4", ".ts": "video/mp2t", ".avi": "video/x-msvideo",
                         ".webm": "video/webm", ".m4v": "video/mp4", ".mov": "video/quicktime"}.get(ext, ctype)
            if ctype == "video/x-matroska":
                ctype = "video/webm"        # Chromium lit le Matroska annoncé comme WebM
            self.send_response(r.status)
            self.send_header("Content-Type", ctype)
            for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
                if r.getheader(h):
                    self.send_header(h, r.getheader(h))
            if not r.getheader("Content-Length"):
                self.send_header("Connection", "close")
                self.close_connection = True
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                chunk = r.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout, OSError,
                http.client.HTTPException):
            self.close_connection = True
        finally:
            if conn:
                conn.close()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = to_int(self.headers.get("Content-Length"))
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except ValueError:
            return self._json({"error": "JSON invalide"}, 400)
        self._api("POST", u.path, urllib.parse.parse_qs(u.query), body)

    def _api(self, method, path, q, body):
        if not self._authorized(q):
            return self._json({"error": "Accès refusé"}, 403)
        g = lambda k, d=None: (q.get(k) or [d])[0]
        prof = self.headers.get("X-Profile") or g("p")
        body = body or {}
        try:
            route = ROUTES.get(path)
            if route is None:
                return self._json({"error": "Route inconnue"}, 404)
            return self._json(route(method, body, g, prof))
        except XtreamError as e:
            return self._json({"error": str(e), "kind": "xtream"}, 502)
        except Exception as e:  # noqa
            return self._json({"error": str(e) or e.__class__.__name__}, 500)


# --------------------------------------------------------------------------- routes de l'API
def r_config(method, body, g, prof):
    if method == "GET":
        return public_config(prof)
    c = CONFIG.data
    old = (c["server"], c["username"], c["password"])
    for k in ("server", "username", "tmdb_key", "player_path", "live_format", "player_mode", "country", "dl_dir"):
        if k in body and body[k] is not None:
            c[k] = str(body[k]).strip()
    if body.get("password"):
        c["password"] = str(body["password"])
    if "username=" in c["server"]:      # lien M3U collé : on en extrait les identifiants
        base, user, pw = parse_server_input(c["server"])
        c["server"], c["username"] = base, user or c["username"]
        c["password"] = c["password"] if body.get("password") else (pw or c["password"])
    for k in ("fullscreen", "dl_pause_play", "show_unavailable", "tv_mode"):
        if k in body:
            c[k] = bool(body[k])
    if "tmdb_key" in body:
        APP.disc_cache = {}
    if "country" in body:
        APP.now_cache, APP.tv_cache = None, {}
    CONFIG.save()
    if (c["server"], c["username"], c["password"]) != old:
        APP.catalog, APP.account, APP.xt = None, {}, None
        APP.connect()
    return public_config(prof)


def r_profiles(method, body, g, prof):
    c = CONFIG.data
    act = body.get("action")
    if act == "add":
        pid = "p" + secrets.token_hex(3)
        c["profiles"].append({"id": pid, "name": (body.get("name") or "Profil").strip()[:20],
                              "color": body.get("color") or PROFILE_COLORS[len(c["profiles"]) % len(PROFILE_COLORS)],
                              "kids": bool(body.get("kids"))})
        pdata(pid)
        c["pdata"][pid] = {"favs": [], "history": [], "progress": {}, "notify": [], "reminders": []}
    elif act == "edit":
        for p in c["profiles"]:
            if p["id"] == body.get("id"):
                if body.get("name"):
                    p["name"] = body["name"].strip()[:20]
                if body.get("color"):
                    p["color"] = body["color"]
                if "kids" in body:
                    p["kids"] = bool(body["kids"])
    elif act == "delete" and len(c["profiles"]) > 1:
        c["profiles"] = [p for p in c["profiles"] if p["id"] != body.get("id")]
        c["pdata"].pop(body.get("id"), None)
    CONFIG.save()
    return {"profiles": c["profiles"]}


def r_fav(method, body, g, prof):
    d = pdata(prof)
    item = f"{body.get('kind')}:{body.get('key')}"
    favs = [f for f in d["favs"] if f != item]
    if body.get("on"):
        favs.insert(0, item)
    d["favs"] = favs
    CONFIG.save()
    return {"favs": favs}


def r_notify(method, body, g, prof):
    d = pdata(prof)
    n = [x for x in d["notify"] if not (x.get("kind") == body.get("kind") and int(x.get("id") or 0) == int(body.get("id") or 0))]
    if body.get("on"):
        n.insert(0, {"kind": body.get("kind"), "id": int(body.get("id")), "title": body.get("title") or "",
                     "ts": int(time.time())})
    d["notify"] = n
    CONFIG.save()
    APP.check_notify()
    return {"notify": pdata(prof)["notify"]}


def r_reminder(method, body, g, prof):
    d = pdata(prof)
    now = time.time()
    r = [x for x in d["reminders"] if x.get("end", 0) > now and not (x.get("key") == body.get("key") and x.get("start") == body.get("start"))]
    if body.get("on"):
        r.append({k: body.get(k) for k in ("key", "ch", "title", "start", "end")})
    d["reminders"] = r
    CONFIG.save()
    return {"reminders": r}


def r_progress(method, body, g, prof):
    save_progress(body, prof)
    return {"ok": True}


def r_play(method, body, g, prof):
    return APP.play_external(body.get("title") or "", body.get("streams") or [], body.get("kind"), body.get("key"), prof)


def r_player_closed(method, body, g, prof):
    APP.playback(False)
    return {"ok": True}


def r_downloads(method, body, g, prof):
    if method == "POST":
        if body.get("action"):
            APP.dl.action(body.get("id"), body["action"])
        else:
            APP.download(body)
    return APP.dl.status()


def r_events(method, body, g, prof):
    since = to_int(g("since"))
    return [e for e in list(APP.events) if e["id"] > since]


def r_verify(method, body, g, prof):
    key = g("key") or body.get("key")
    changed = APP.verify_group(key, probe=(g("probe") or body.get("probe")) in ("1", True, 1))
    return {"changed": changed, "verify": {str(v["id"]): APP.verify_map().get(str(v["id"]))
                                          for v in (APP.movie_idx.get(key) or {}).get("v", [])}}


def r_fullscreen(method, body, g, prof):
    if WINDOW is not None:
        WINDOW.toggle_fullscreen()
        APP.main_fs = not APP.main_fs
    return {"native": WINDOW is not None, "fs": APP.main_fs}


def r_update(method, body, g, prof):
    up = APP.updater
    if method == "POST" and body.get("action") == "check":
        try:
            up.check(notify=False)
        except Exception as e:  # noqa
            st = up.status()
            st["error"] = "Vérification impossible : " + (str(e) or e.__class__.__name__)
            return st
    elif method == "POST" and body.get("action") == "install":
        return up.install(quit_app)
    return up.status()


def _shutdown():
    """Sauvegardes de fermeture, chacune avec un délai maximum : rien ne doit empêcher l'appli de se fermer."""
    def step(fn, timeout):
        t = threading.Thread(target=fn, daemon=True)
        t.start()
        t.join(timeout)
    APP.player_gen += 1
    for fn in (APP._stop_player, APP.vlc_stop, APP.dl.save, TMDB_CACHE.save, CONFIG.save):
        step(lambda f=fn: _quiet(f), 2)
    if getattr(APP, "sync", None):
        step(lambda: _quiet(APP.sync.stop), 4)


def _quiet(fn):
    try:
        fn()
    except Exception:
        pass


def quit_app():
    """Ferme ShippoTV pour de bon (utilisé avant d'installer une mise à jour) : le processus doit
    disparaître, sinon l'installateur ne peut pas remplacer les fichiers."""
    _shutdown()
    if WINDOW is not None:
        threading.Thread(target=lambda: _quiet(WINDOW.destroy), daemon=True).start()
        time.sleep(1.2)
    os._exit(0)


def check_pending_update():
    """Au démarrage : la mise à jour lancée la dernière fois s'est-elle bien installée ?"""
    p = CONFIG.data.get("pending_update")
    if not p:
        return
    want = p.get("version") or ""
    CONFIG.data.pop("pending_update", None)
    CONFIG.save()
    if updater.vtuple(VERSION) >= updater.vtuple(want):
        APP.event(f"ShippoTV a été mis à jour en {VERSION}", "info")
    elif time.time() - (p.get("ts") or 0) < 3 * 86400:
        APP.event(f"La mise à jour {want} ne s'est pas installée. Réessayez depuis Réglages, ou installez-la à la main "
                  f"(journal : {p.get('log') or 'indisponible'})", "error")


def remember_pending(version, log):
    CONFIG.data["pending_update"] = {"version": version, "log": log, "ts": time.time()}
    CONFIG.save()


def r_sync(method, body, g, prof):
    s = APP.sync
    act = body.get("action") if method == "POST" else None
    try:
        if act == "create":
            s.create_group(body.get("name") or "")
        elif act == "code":
            c = CONFIG.data
            extra = {"xtream": {"server": c["server"], "username": c["username"], "password": c["password"]},
                     "tmdb": tmdb_key() or None} \
                if body.get("creds") and c.get("server") and c.get("username") else None
            return {**s.status(), "pair": s.make_code(extra)}
        elif act == "join":
            s.join(body.get("code") or "")
            extra = getattr(s, "last_extra", None) or {}
            x = extra.get("xtream") or {}
            if extra.get("tmdb") and not tmdb_key():
                CONFIG.data["tmdb_key"] = extra["tmdb"]
            if x.get("server") and x.get("username"):
                c = CONFIG.data
                c["server"], c["username"], c["password"] = x["server"], x["username"], x.get("password") or ""
                _config_save()
                APP.catalog, APP.account, APP.xt = None, {}, None
                try:
                    APP.connect()
                except Exception:
                    pass
                return {**s.status(), "creds": True}
        elif act == "leave":
            s.leave_group()
        elif act == "rotate":
            s.rotate()
        elif act == "rename":
            s.rename_device(body.get("name") or "")
        elif act == "now":
            s.poke()
        elif act == "server":
            CONFIG.data["sync_url"] = (body.get("url") or "").strip()
            if body.get("key") is not None or not CONFIG.data["sync_url"]:
                CONFIG.data["sync_key"] = (body.get("key") or "").strip()
            _config_save()
            s = make_sync()
    except sync.SyncError as e:
        return {**s.status(), "error": str(e)}
    st = s.status()
    st["builtin"] = bool(DEFAULTS.get("supabase_url"))
    st["custom_url"] = CONFIG.data.get("sync_url") or ""
    return st


def r_vlc_stop(method, body, g, prof):
    APP.vlc_stop()
    return {"ok": True}


ROUTES = {
    "/api/config": r_config,
    "/api/profiles": r_profiles,
    "/api/catalog": lambda m, b, g, p: APP.catalog_payload(force=g("refresh") == "1"),
    "/api/refresh": lambda m, b, g, p: (threading.Thread(target=APP.refresh_catalog, kwargs={"manual": True}, daemon=True).start(), {"ok": True})[1],
    "/api/enrich": lambda m, b, g, p: APP.enrich(b.get("items") or []),
    "/api/tmdb_search": lambda m, b, g, p: APP.tmdb_search(b.get("kind"), b.get("query") or ""),
    "/api/tmdb_override": lambda m, b, g, p: APP.tmdb_override(b.get("kind"), b.get("key"), b.get("id")),
    "/api/tmdb_info": lambda m, b, g, p: APP.tmdb_info(g("kind"), g("id")),
    "/api/trailer": lambda m, b, g, p: APP.trailer(g("kind"), g("id")),
    "/api/similar": lambda m, b, g, p: APP.similar(g("kind"), g("id")),
    "/api/series": lambda m, b, g, p: APP.series_cached(g("id"), 120),
    "/api/up_next": lambda m, b, g, p: APP.up_next(p),
    "/api/replay": lambda m, b, g, p: APP.replay(g("key")),
    "/api/for_you": lambda m, b, g, p: APP.for_you(p),
    "/api/person": lambda m, b, g, p: APP.person_search(g("q")),
    "/api/movie": lambda m, b, g, p: APP.movie_info(g("id")),
    "/api/epg": lambda m, b, g, p: APP.epg(g("id"), 6),
    "/api/discover": lambda m, b, g, p: APP.discover(g("kind"), g("refresh") == "1"),
    "/api/live_now": lambda m, b, g, p: APP.live_now(g("refresh") == "1"),
    "/api/tonight": lambda m, b, g, p: APP.tonight(g("refresh") == "1"),
    "/api/guide": lambda m, b, g, p: APP.guide(),
    "/api/stream": lambda m, b, g, p: APP.stream(b),
    "/api/vlc_play": lambda m, b, g, p: APP.vlc_play(b, p),
    "/api/vlc_stop": r_vlc_stop,
    "/api/play": r_play,
    "/api/player_closed": r_player_closed,
    "/api/progress": r_progress,
    "/api/fav": r_fav,
    "/api/notify": r_notify,
    "/api/reminder": r_reminder,
    "/api/downloads": r_downloads,
    "/api/verify": r_verify,
    "/api/fullscreen": r_fullscreen,
    "/api/events": r_events,
    "/api/update": r_update,
    "/api/sync": r_sync,
    "/api/others": lambda m, b, g, p: APP.others_playing(),
    "/api/remote_stop": lambda m, b, g, p: APP.remote_stop(b.get("device") or ""),
}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    APP.updater.on_pending = remember_pending
    _quiet(check_pending_update)
    port = int(os.environ.get("CINEFLUX_PORT") or free_port())
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/?t={TOKEN}"

    if "--serve" in sys.argv:          # pour le développement : serveur seul
        print(url, flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return

    webview = None
    if "--browser" not in sys.argv:
        try:
            import webview  # pywebview
        except Exception:
            webview = None
    if webview is not None:
        global WINDOW
        WINDOW = webview.create_window(APP_NAME, url, width=1440, height=900, min_size=(980, 620),
                                       background_color="#0b0a0f", text_select=False)
        webview.start(private_mode=False)
        _shutdown()
        os._exit(0)                     # aucune tâche de fond ne doit garder ShippoTV ouvert après la fermeture
    else:
        import webbrowser
        webbrowser.open(url)
        print(f"{APP_NAME} est ouvert dans votre navigateur : {url}\nFermez cette fenêtre pour quitter.")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
