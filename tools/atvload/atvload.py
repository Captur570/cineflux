#!/usr/bin/env python3
"""
ATVLoad — installe tes apps tvOS sur ton Apple TV depuis Windows, avec un Apple ID GRATUIT.

Équivalent Windows d'atvloadly. Le gros du travail (appairage, connexion Apple,
signature, installation par le réseau) est fait par plumesign (projet open source
PlumeImpactor, variante de bitxeno). Ce script le pilote et ajoute :
détection de l'Apple TV sur le réseau, mémoire des apps installées, et
renouvellement automatique avant l'expiration des 7 jours.

Commandes :
  setup                 Télécharge plumesign.exe et vérifie les dépendances
  scan                  Liste les Apple TV visibles sur le réseau
  pair                  Appaire l'Apple TV (code PIN affiché sur la TV)
  login                 Connecte ton Apple ID (double authentification gérée)
  install App.ipa       Signe et installe une app
  list                  Apps installées et date d'expiration
  refresh [--all]       Renouvelle les apps qui expirent bientôt
  schedule / unschedule Active / désactive le renouvellement automatique quotidien
  certs                 Liste tes certificats (utile si Apple refuse d'en créer un nouveau)
"""

import argparse
import datetime as dt
import getpass
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

APP_NAME = "ATVLoad"
TASK_NAME = "ATVLoad - renouvellement"
# Binaire Windows de plumesign compilé par GitHub Actions (voir .github/workflows/atv-tools.yml)
PLUMESIGN_URL = os.environ.get(
    "ATVLOAD_PLUMESIGN_URL",
    "https://github.com/Captur570/cineflux/releases/download/atv-tools/plumesign-windows-x86_64.exe",
)
REFRESH_MARGIN_DAYS = 3  # on renouvelle quand il reste moins de 3 jours

SVC_PAIRED = "_remotepairing._tcp.local."
SVC_PAIRABLE = "_remotepairing-manual-pairing._tcp.local."

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

# Sous Windows : pas de fenêtre noire qui s'ouvre à chaque appel de plumesign (interface graphique)
NOWIN = {"creationflags": 0x08000000} if os.name == "nt" else {}
FROZEN = getattr(sys, "frozen", False)   # ATVLoad.exe (interface graphique empaquetée)


class ConsoleIO:
    """Entrées/sorties du terminal. L'interface graphique (atvload_gui.py) la remplace par la sienne."""

    def write(self, text):
        if sys.stdout:
            sys.stdout.write(text)
            sys.stdout.flush()

    def line(self, level, msg):
        self.write(f"[{level}] {msg}\n")

    def ask(self, kind, prompt, secret=False, options=None):
        if options:
            for i, o in enumerate(options, 1):
                self.write(f"  {i}. {o}\n")
        return getpass.getpass(prompt) if secret else input(prompt)

    def read_line(self):
        """Ligne tapée pendant que plumesign attend (code PIN, code 2FA) ; None = fin."""
        line = sys.stdin.readline() if sys.stdin else ""
        return line or None


IO = ConsoleIO()
CURRENT = {"proc": None}   # plumesign en cours (l'interface peut l'arrêter : bouton « Annuler »)


# ======================================================================= utilitaires

def data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    d = Path(base) / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


STATE_FILE = data_dir() / "state.json"
LOG_FILE = data_dir() / "atvload.log"


def log_to_file(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def info(msg):  IO.line("..", msg); log_to_file(msg)
def ok(msg):    IO.line("OK", msg); log_to_file("OK " + msg)
def warn(msg):  IO.line("!!", msg); log_to_file("!! " + msg)


class Fail(Exception):
    pass


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            warn("state.json illisible, je repars de zéro.")
    return {"account": None, "devices": {}, "apps": {}}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def plumesign_path() -> Path:
    for c in (os.environ.get("ATVLOAD_PLUMESIGN"),
              data_dir() / "plumesign.exe",
              Path(__file__).with_name("plumesign.exe"),
              shutil.which("plumesign")):
        if c and Path(c).is_file():
            return Path(c)
    raise Fail("plumesign introuvable. Lance d'abord :  atvload setup")


def plume_cmd(*args):
    return [str(plumesign_path()), *args]


# Serveurs « anisette » : ils fournissent l'identité de machine qu'Apple exige pour
# se connecter sans Mac. Liste publique de SideStore ; on prend le premier qui répond.
# Depuis mi-octobre 2026, Apple rejette (503) l'identité « Android » : on privilégie
# les serveurs qui émulent un PC Windows avec iTunes (client_info « <PC> <Windows;… »).
ANISETTE_SERVERS = [
    "https://ani.jkcoxson.com",
    "https://ani.stikstore.app",
    "https://ani.sidestore.app",
    "https://ani.sidestore.io",
    "https://ani.sidestore.zip",
    "https://ani.846969.xyz",
    "https://ani.npeg.us",
    "https://anisette.wedotstud.io",
    "https://ani.xu30.top",
    "https://ani.owoellen.rocks",
    "https://ani.neoarz.com",
    "https://ani3server.fly.dev",
    "https://anisette.crystall1ne.dev",
    "https://omni.ethxn.xyz",
]
_ANISETTE = {"url": None}


# Anisette LOCAL : comme atvloadly sous Linux, on fait tourner sur le PC les deux
# bibliothèques d'identification d'Apple, extraites de l'app Apple Music pour Android
# (fichier public d'Apple). Le PC a alors sa propre identité, au lieu de passer par
# des serveurs publics partagés qu'Apple finit par bloquer (erreur 503).
APPLE_MUSIC_APK = "https://apps.mzstatic.com/content/android-apple-music-apk/applemusic.apk"
ADI_LIBS = ("libstoreservicescore.so", "libCoreADI.so")


def plume_data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / "PlumeImpactor"


def local_lib_dir() -> Path:
    return plume_data_dir() / "lib" / "x86_64"


def local_anisette_ready():
    return all((local_lib_dir() / n).is_file() for n in ADI_LIBS)


class _HttpRangeFile:
    """Fichier distant lisible par morceaux (HTTP Range) : zipfile n'y lit que ce qu'il faut."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            self.size = int(r.headers["Content-Length"])
            if r.headers.get("Accept-Ranges", "").lower() != "bytes":
                raise OSError("pas de lecture partielle")

    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.pos + n, self.size) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        self.pos += len(data)
        return data


def install_local_anisette():
    if local_anisette_ready():
        ok("Identification locale déjà en place (bibliothèques Apple).")
        return True
    info("Récupération des bibliothèques d'identification d'Apple (depuis Apple Music pour Android)…")
    dest = local_lib_dir()
    dest.mkdir(parents=True, exist_ok=True)
    tmp_apk = None
    try:
        try:
            src = _HttpRangeFile(APPLE_MUSIC_APK)   # ne télécharge que les ~5 Mo utiles
        except Exception:
            info("Téléchargement complet de l'APK (plus long)…")
            tmp_apk = Path(tempfile.gettempdir()) / "atvload-applemusic.apk"
            urllib.request.urlretrieve(APPLE_MUSIC_APK, tmp_apk)
            src = open(tmp_apk, "rb")
        try:
            with zipfile.ZipFile(src) as z:
                for n in ADI_LIBS:
                    (dest / n).write_bytes(z.read(f"lib/x86_64/{n}"))
        finally:
            if hasattr(src, "close"):
                src.close()
        ok(f"Identification locale installée : {dest}")
        return True
    except Exception as e:
        warn(f"Impossible d'installer l'identification locale ({e}). Repli sur les serveurs publics.")
        for n in ADI_LIBS:
            (dest / n).unlink(missing_ok=True)
        return False
    finally:
        if tmp_apk:
            try:
                tmp_apk.unlink(missing_ok=True)
            except OSError:
                pass


def disable_local_anisette():
    """Si le chargeur local plante sur ce PC, on le met de côté et on repasse par un serveur."""
    d = local_lib_dir()
    if d.exists():
        backup = d.with_name("x86_64.desactive")
        shutil.rmtree(backup, ignore_errors=True)
        try:
            d.rename(backup)
            info("Identification locale (identité Android, refusée par Apple) mise de côté.")
        except OSError:
            shutil.rmtree(d, ignore_errors=True)


def is_local_loader_crash(out):
    o = out.lower()
    return ("store_services_core" in o or "android_loader" in o or "android-loader" in o) and "panicked" in o


def is_risk_block(out):
    o = out.lower()
    return "503" in o and ("risk control" in o or "srp" in o)


def plume_env():
    env = dict(os.environ, RUST_LOG=os.environ.get("RUST_LOG", "info"), RUST_BACKTRACE="0")
    if _ANISETTE["url"]:
        env["PLUME_ANISETTE_URL"] = _ANISETTE["url"]
    return env


def anisette_info(url, timeout=6):
    """client_info annoncé par le serveur, ou None s'il ne répond pas."""
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/v3/client_info", timeout=timeout) as r:
            data = json.loads(r.read().decode())
            return data.get("client_info") or None
    except Exception:
        return None


def choose_anisette(state, exclude=()):
    """Choisit un serveur anisette : d'abord ceux qui émulent Windows (seuls acceptés par
    Apple depuis octobre 2026), en commençant par celui qui a déjà marché."""
    disable_local_anisette()  # l'identité Android locale est désormais rejetée par Apple
    order = ([state["anisette"]] if state.get("anisette") else []) + ANISETTE_SERVERS
    seen, fallback = set(), None
    for url in order:
        if url in seen or url in exclude:
            continue
        seen.add(url)
        ci = anisette_info(url)
        if not ci:
            continue
        if "windows" in ci.lower():
            if url != state.get("anisette"):
                info(f"Serveur d'identification : {url}")
            _ANISETTE["url"] = url
            return url
        fallback = fallback or url
    if fallback:
        info(f"Serveur d'identification : {fallback}")
        _ANISETTE["url"] = fallback
        return fallback
    raise Fail("Aucun serveur d'identification (anisette) ne répond. Vérifie ta connexion Internet, "
               "ou réessaie plus tard.")


def is_anisette_error(out):
    o = out.lower()
    return "anisette" in o or ("panicked" in o and "omnisette" in o)


def _pump(p, chunks):
    fd = p.stdout.fileno()
    while True:
        b = os.read(fd, 4096)
        if not b:
            break
        text = b.decode("utf-8", errors="replace")
        chunks.append(text)
        IO.write(text)


def _log_cmd(cmd, secrets):
    shown = " ".join(cmd[1:])
    for s in secrets:
        shown = shown.replace(s, "***")
    log_to_file("$ plumesign " + shown)


def run_tee(cmd, secrets=()):
    """Lance plumesign, affiche sa sortie en direct et la renvoie (pour l'analyser)."""
    _log_cmd(cmd, secrets)
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=plume_env(), **NOWIN)
    CURRENT["proc"] = p
    chunks = []
    try:
        _pump(p, chunks)
        p.wait()
    finally:
        CURRENT["proc"] = None
    out = "".join(chunks)
    log_to_file(out[-4000:])
    return p.returncode, out


def run_interactive(cmd, first_lines=(), secrets=()):
    """Comme run_tee, mais envoie d'abord first_lines (ex. mot de passe) puis relaie
    ce que tu tapes (code PIN, code 2FA…)."""
    _log_cmd(cmd, secrets)
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, env=plume_env(), **NOWIN)
    for line in first_lines:
        p.stdin.write((line + "\n").encode())
    p.stdin.flush()

    def relay():
        try:
            while p.poll() is None:
                line = IO.read_line()
                if line is None or p.poll() is not None:
                    break
                p.stdin.write((line.rstrip("\r\n") + "\n").encode())
                p.stdin.flush()
        except (OSError, ValueError):
            pass

    threading.Thread(target=relay, daemon=True).start()
    CURRENT["proc"] = p
    chunks = []
    try:
        _pump(p, chunks)
        p.wait()
    finally:
        CURRENT["proc"] = None
    out = "".join(chunks)
    for s in secrets:
        out = out.replace(s, "***")
    log_to_file(out[-4000:])
    return p.returncode, out


# ======================================================================= réseau (mDNS)

def browse(service_type, seconds=6.0):
    """Renvoie la liste des services trouvés : {name, ip, port, txt}."""
    try:
        from zeroconf import IPVersion, ServiceBrowser, ServiceListener, Zeroconf
    except ImportError:
        raise Fail("Module zeroconf manquant :  pip install zeroconf")

    found = {}

    class Listener(ServiceListener):
        def _store(self, zc, type_, name):
            si = zc.get_service_info(type_, name, timeout=3000)
            if not si:
                return
            ips = [a for a in si.parsed_addresses(IPVersion.V4Only)
                   if a.startswith(("10.", "192.168.", "172."))] or si.parsed_addresses(IPVersion.V4Only)
            if not ips:
                return
            txt = {}
            for k, v in (si.properties or {}).items():
                if k is None:
                    continue
                txt[k.decode(errors="replace")] = (v or b"").decode(errors="replace")
            found[name] = {"name": name.split(".")[0], "ip": ips[0], "port": si.port, "txt": txt}

        def add_service(self, zc, type_, name):
            self._store(zc, type_, name)

        def update_service(self, zc, type_, name):
            self._store(zc, type_, name)

        def remove_service(self, zc, type_, name):
            pass

    zc = Zeroconf(ip_version=IPVersion.V4Only)
    try:
        ServiceBrowser(zc, service_type, Listener())
        time.sleep(seconds)
    finally:
        zc.close()
    return list(found.values())


def find_paired_devices(seconds=6.0):
    """Apple TV déjà appairées et visibles : {udid: {ip, port, name}}."""
    result = {}
    for svc in browse(SVC_PAIRED, seconds):
        ident, tag = svc["txt"].get("identifier"), svc["txt"].get("authTag")
        if not ident or not tag:
            continue
        r = subprocess.run(plume_cmd("check", "find-pairing", "--identifier", ident, "--auth-tag", tag),
                           capture_output=True, text=True, errors="replace", **NOWIN)
        m = re.search(r"UDID: `([^`]+)`", r.stdout + r.stderr)
        if m:
            result[m.group(1)] = {"ip": svc["ip"], "port": svc["port"], "name": svc["name"]}
    return result


def looks_like_id(name):
    return bool(re.fullmatch(r"[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}|[0-9A-Fa-f-]{20,}", name or ""))


def resolve_device(state, wanted=None, seconds=6.0):
    info("Recherche de l'Apple TV sur le réseau…")
    devices = find_paired_devices(seconds)
    if not devices:
        raise Fail("Aucune Apple TV appairée trouvée. Vérifie qu'elle est allumée (pas en veille profonde), "
                   "sur le même réseau que le PC, puis réessaie. Si elle n'a jamais été appairée : atvload pair")
    if wanted:
        if wanted not in devices:
            raise Fail(f"Apple TV {wanted} introuvable. Visibles : {', '.join(devices)}")
        udid = wanted
    else:
        udid = next(iter(devices))
        if len(devices) > 1:
            warn(f"Plusieurs Apple TV : {', '.join(devices)}. J'utilise {udid} (choisis avec --udid).")
    dev = devices[udid]
    cur = state["devices"].get(udid, {}).get("name")
    if not cur or looks_like_id(cur):   # le nom réseau est souvent un identifiant : on garde celui de l'appairage
        cur = (state.get("paired") or {}).get("name") or (dev["name"] if not looks_like_id(dev["name"]) else "Apple TV")
    state["devices"].setdefault(udid, {})["name"] = cur
    ok(f"Apple TV trouvée : {state['devices'][udid]['name']} ({dev['ip']})")
    return udid, dev


# ======================================================================= IPA et profils

def ipa_info(path):
    try:
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", n)]
            if not names:
                raise Fail("IPA invalide : pas de Payload/<App>.app/Info.plist")
            return plistlib.loads(z.read(names[0]))
    except zipfile.BadZipFile:
        raise Fail(f"{path} n'est pas une IPA valide (fichier zip attendu).")


def check_tvos(path):
    p = ipa_info(path)
    bundle = p.get("CFBundleIdentifier", "?")
    platforms = p.get("CFBundleSupportedPlatforms", [])
    if "AppleTVOS" not in platforms and 3 not in p.get("UIDeviceFamily", []):
        raise Fail(f"{Path(path).name} ({bundle}) est une app {', '.join(platforms) or 'iOS'}, pas tvOS. "
                   "L'Apple TV n'accepte que les apps compilées pour tvOS.")
    name = p.get("CFBundleDisplayName") or p.get("CFBundleName") or bundle
    ok(f"App tvOS : {name} ({bundle}) v{p.get('CFBundleShortVersionString', '?')}")
    return bundle, name


def profile_expiry(path):
    try:
        raw = Path(path).read_bytes()
        s, e = raw.find(b"<?xml"), raw.find(b"</plist>")
        exp = plistlib.loads(raw[s:e + 8]).get("ExpirationDate")
        if isinstance(exp, dt.datetime):
            return exp.replace(tzinfo=None).isoformat(timespec="minutes")
    except Exception:
        pass
    return None


def apple_refused(out):
    """Refus d'Apple lié à l'identité de machine (503 / -80045) : réessayer aussitôt n'y change rien."""
    o = out.lower()
    return "-80045" in o or is_risk_block(out) or ("503" in o and ("developer" in o or "gsa" in o or "service unavailable" in o))


def session_expired(out):
    o = out.lower()
    return "session has expired" in o or "please log in" in o or "error 1100" in o


def explain_failure(out):
    o = out.lower()
    if session_expired(out):
        warn("Session Apple expirée : reconnecte-toi (atvload login).")
    elif "-80045" in o or (apple_refused(out) and not is_risk_block(out)):
        warn("Apple refuse l'identité de machine fournie par le serveur d'identification (erreur 503 / -80045). "
             "C'est le problème qui touche tous les outils de ce genre depuis mi-octobre 2026 : réessaie plus tard, "
             "pas plus de 2-3 fois par heure.")
    elif is_risk_block(out):
        warn("Apple bloque temporairement (503). Attends quelques heures avant de réessayer.")
    elif is_anisette_error(out):
        warn("Le serveur d'identification (anisette) n'a pas répondu correctement. Réessaie dans quelques "
             "minutes ; si ça persiste, relance  atvload login")
    elif "certificate" in o and ("limit" in o or "revok" in o or "approval" in o):
        warn("Apple refuse de créer un nouveau certificat : ton compte gratuit a atteint sa limite.\n"
             "     Lance  atvload certs  pour les voir, puis réessaie avec  --revoke <numéro de série>\n"
             "     (révoquer un certificat désactive les apps signées avec lui sur tes autres appareils).")
    elif ("maximum" in o and "app" in o) or "3 apps" in o:
        warn("Limite du compte gratuit atteinte (3 apps actives par appareil). Supprime une app de l'Apple TV.")
    elif session_expired(out) or "can't log-in" in o or "developersession" in o or "not logged" in o or "no account" in o:
        warn("Session Apple expirée ou absente : relance  atvload login")
    elif "not compatible" in o or ("platform" in o and "device" in o):
        warn("L'app n'est pas compatible avec l'Apple TV (elle doit être compilée pour tvOS).")
    elif "connection refused" in o or "timed out" in o or "tunnel" in o:
        warn("Connexion à l'Apple TV impossible. Réveille-la (bouton de la télécommande) et réessaie. "
             "Si ça persiste après une mise à jour de tvOS, refais  atvload pair")
    elif "pairing" in o or ("socket io failed" in o and "no such file" in o):
        warn("Appairage invalide : refais  atvload pair")


# ======================================================================= commandes

def cmd_setup(args, state):
    try:
        import zeroconf  # noqa: F401
        ok("Module zeroconf présent")
    except ImportError:
        if FROZEN:
            raise Fail("Module zeroconf absent de ATVLoad.exe (fabrication incomplète).")
        info("Installation du module zeroconf…")
        subprocess.run([sys.executable, "-m", "pip", "install", "--user", "zeroconf"], check=True)

    target = data_dir() / "plumesign.exe"
    remote_size = None
    try:
        req = urllib.request.Request(PLUMESIGN_URL, method="HEAD")
        with urllib.request.urlopen(req, timeout=20) as r:
            remote_size = int(r.headers.get("Content-Length") or 0) or None
    except Exception:
        pass
    if target.exists() and not args.force and (remote_size is None or remote_size == target.stat().st_size):
        ok(f"plumesign à jour : {target}")
    else:
        info(f"Téléchargement de plumesign depuis {PLUMESIGN_URL}")
        tmp = target.with_suffix(".part")
        try:
            urllib.request.urlretrieve(PLUMESIGN_URL, tmp)
        except Exception as e:
            raise Fail(f"Téléchargement impossible ({e}). Tu peux aussi poser plumesign.exe "
                       f"à côté de atvload.py.")
        tmp.replace(target)
        ok(f"plumesign installé : {target}")

    r = subprocess.run(plume_cmd("--help"), capture_output=True, text=True, errors="replace", **NOWIN)
    if r.returncode != 0 or "sign-rsd" not in r.stdout:
        raise Fail("plumesign ne répond pas comme prévu (version sans prise en charge réseau ?).")
    ok("plumesign fonctionne.")
    disable_local_anisette()
    choose_anisette(state)
    ok("Serveur d'identification joignable.")
    save_state(state)
    info("Étapes suivantes :  atvload pair   puis   atvload login   puis   atvload install MonApp.ipa")


def cmd_scan(args, state):
    pairable = browse(SVC_PAIRABLE, args.wait)
    for d in pairable:
        print(f"  [à appairer] {d['txt'].get('name', d['name'])}  {d['ip']}:{d['port']}")
    paired = find_paired_devices(args.wait)
    for udid, d in paired.items():
        print(f"  [appairée]   {d['name']}  {d['ip']}  UDID {udid}")
    if not pairable and not paired:
        warn("Rien trouvé. Apple TV allumée et sur le même réseau ? Pare-feu Windows : autorise Python "
             "sur les réseaux privés (le réseau doit être en profil « Privé »).")


def cmd_pair(args, state):
    info("Sur l'Apple TV : Réglages > Télécommandes et appareils > Application et appareils distants.")
    info("Reste sur cet écran. Recherche de l'Apple TV en mode appairage…")
    found = []
    for _ in range(4):
        found = browse(SVC_PAIRABLE, 5)
        if found:
            break
        info("Pas encore visible, je réessaie…")
    if not found:
        raise Fail("Aucune Apple TV en mode appairage trouvée. Vérifie l'écran de l'Apple TV, le réseau, "
                   "et que le pare-feu Windows autorise Python (réseau privé).")
    dev = found[0]
    if len(found) > 1:
        names = [f"{d['txt'].get('name', d['name'])} ({d['ip']})" for d in found]
        dev = found[int(IO.ask("choice", "Laquelle ? ", options=names) or 1) - 1]
    name = dev["txt"].get("name", dev["name"])
    ok(f"Trouvée : {name} ({dev['ip']}:{dev['port']})")
    info("Un code va s'afficher sur la TV : tape-le ici puis Entrée.")
    code, _ = run_interactive(plume_cmd("pair", "--ip", dev["ip"], "--port", str(dev["port"]),
                                        "--host", f"ATVLoad-{os.environ.get('COMPUTERNAME', 'PC')}"))
    if code != 0:
        raise Fail("Appairage échoué (code erroné ou délai dépassé). Relance  atvload pair")
    state["paired"] = {"name": name, "at": dt.datetime.now().isoformat(timespec="minutes")}
    save_state(state)
    ok("Apple TV appairée ! Elle apparaît désormais dans  atvload scan")


def cmd_login(args, state):
    email = (args.email or IO.ask("email", "Apple ID (e-mail) : ")).strip()
    password = IO.ask("password", "Mot de passe (non affiché) : ", secret=True)
    info("Connexion à Apple… Si un code de validation s'affiche sur ton iPhone/iPad/Mac, tape-le ici.")
    info("(Pas d'appareil Apple pour recevoir le code ? tape  sms  puis Entrée.)")
    tried = set()
    while True:
        url = choose_anisette(state, exclude=tried)
        code, out = run_interactive(plume_cmd("account", "login", "-u", email),
                                    first_lines=[password], secrets=[password])
        if code == 0:
            break
        if url == "local" and is_local_loader_crash(out):
            warn("L'identification locale ne fonctionne pas sur ce PC, je passe par un serveur public.")
            disable_local_anisette()
            continue
        if is_risk_block(out):
            raise Fail(f"Apple a refusé la connexion (erreur 503) avec le serveur {url}. "
                       "Envoie-moi cette sortie ; en attendant, n'insiste pas plus de 2-3 fois par heure.")
        if url != "local" and is_anisette_error(out) and len(tried) < 5:
            warn(f"Le serveur d'identification {url} ne répond pas correctement, j'en essaie un autre.")
            tried.add(url)
            state.pop("anisette", None)
            continue
        if "-22406" in out:
            raise Fail("Apple indique un mot de passe incorrect (-22406). Vérifie-le, ou essaie avec un "
                       "Apple ID secondaire sans majuscules ni caractères spéciaux.")
        if "SRP protocol selected" in out:
            raise Fail("Apple a accepté la 1re étape mais refusé la 2e. Envoie-moi cette sortie.")
        raise Fail("Connexion refusée par Apple (code ci-dessus). Envoie-moi cette sortie ; "
                   "n'insiste pas plus de 2-3 fois par heure.")
    if url != "local":
        state["anisette"] = url
    state["account"] = email
    save_state(state)
    ok(f"Connecté avec {email}. La session est mémorisée pour les renouvellements.")


def sign_install(state, ipa, udid, dev, refresh=False, revoke=None):
    account = state.get("account")
    if not account:
        raise Fail("Pas de compte Apple configuré : lance d'abord  atvload login")
    prov = Path(tempfile.gettempdir()) / f"atvload-{os.getpid()}.mobileprovision"
    cmd = plume_cmd("sign-rsd", "--apple-id", "--register-and-install",
                    "--output-provision", str(prov),
                    "--ip", dev["ip"], "--port", str(dev["port"]), "--udid", udid,
                    "-u", account, "-p", str(ipa))
    if refresh:
        cmd.append("--refresh")
    if revoke:
        cmd += ["--revoke-certificate", revoke]
    choose_anisette(state)
    code, out = run_tee(cmd)
    if code != 0 and _ANISETTE["url"] is None and is_local_loader_crash(out):
        warn("L'identification locale ne fonctionne pas sur ce PC, je passe par un serveur public.")
        disable_local_anisette()
        state["anisette"] = choose_anisette(state)
        save_state(state)
        code, out = run_tee(cmd)
    if code != 0 and _ANISETTE["url"] and is_anisette_error(out):
        warn("Serveur d'identification en panne, j'en essaie un autre…")
        state["anisette"] = choose_anisette(state, exclude={_ANISETTE["url"]})
        save_state(state)
        code, out = run_tee(cmd)
    expiry = profile_expiry(prov) if prov.exists() else None
    prov.unlink(missing_ok=True)
    if code != 0 or "Installation complete" not in out:
        explain_failure(out)
        err = Fail("Échec de plumesign (détails ci-dessus, et dans " + str(LOG_FILE) + ").")
        err.retryable = not apple_refused(out) and not is_anisette_error(out) and not session_expired(out)
        err.session = session_expired(out)
        raise err
    return expiry


def cmd_install(args, state):
    ipa = Path(args.ipa).resolve()
    if not ipa.is_file():
        raise Fail(f"Fichier introuvable : {ipa}")
    bundle, name = check_tvos(ipa)
    udid, dev = resolve_device(state, args.udid)

    # On garde une copie de l'IPA : le renouvellement en a besoin même si tu déplaces l'original.
    store = data_dir() / "ipas"
    store.mkdir(exist_ok=True)
    kept = store / f"{bundle}.ipa"
    if kept != ipa:
        shutil.copy2(ipa, kept)

    info(f"Signature et installation de {name}… (la première fois, Apple crée ton certificat : patience)")
    expiry = sign_install(state, kept, udid, dev, revoke=args.revoke)
    state["apps"][f"{udid}|{bundle}"] = {
        "udid": udid, "bundle": bundle, "name": name, "ipa": str(kept),
        "installed": dt.datetime.now().isoformat(timespec="minutes"), "expires": expiry,
    }
    save_state(state)
    ok(f"{name} est installée sur l'Apple TV" + (f", valable jusqu'au {fmt_date(expiry)}." if expiry else "."))
    if not task_exists():
        info("Astuce : active le renouvellement automatique avec  atvload schedule")


def fmt_date(iso):
    try:
        return dt.datetime.fromisoformat(iso).strftime("%d/%m/%Y à %H:%M")
    except Exception:
        return iso or "?"


def days_left(app):
    try:
        return (dt.datetime.fromisoformat(app["expires"]) - dt.datetime.now()).total_seconds() / 86400
    except Exception:
        return None


def cmd_list(args, state):
    if not state["apps"]:
        info("Aucune app installée avec ATVLoad pour l'instant.")
        return
    print(f"Compte : {state.get('account') or '(aucun)'}")
    for app in state["apps"].values():
        left = days_left(app)
        status = "?" if left is None else ("EXPIRÉE" if left <= 0 else f"{left:.1f} j restants")
        tv = state["devices"].get(app["udid"], {}).get("name", app["udid"][:8])
        print(f"  {app['name']:<25} sur {tv:<15} expire le {fmt_date(app.get('expires'))}  ({status})")
    print(f"Renouvellement automatique : {'activé' if task_exists() else 'désactivé'}")


def cmd_refresh(args, state):
    todo = [a for a in state["apps"].values()
            if args.all or days_left(a) is None or days_left(a) < REFRESH_MARGIN_DAYS]
    if not todo:
        ok("Rien à renouveler : toutes les apps ont encore de la marge.")
        return
    info(f"{len(todo)} app(s) à renouveler.")
    devices = {}
    failures = []
    for app in todo:
        try:
            if app["udid"] not in devices:
                devices[app["udid"]] = resolve_device(state, app["udid"])[1]
            info(f"Renouvellement de {app['name']}…")
            # --refresh ne réinstalle que le profil (rapide) ; si l'app a disparu on la réinstalle
            try:
                expiry = sign_install(state, app["ipa"], app["udid"], devices[app["udid"]], refresh=True)
            except Fail as e:
                if not getattr(e, "retryable", True):
                    raise   # refus d'Apple : une réinstallation échouerait pareil et compterait un essai de plus
                info("Renouvellement simple impossible, réinstallation complète…")
                expiry = sign_install(state, app["ipa"], app["udid"], devices[app["udid"]])
            app["expires"] = expiry or app.get("expires")
            app["refreshed"] = dt.datetime.now().isoformat(timespec="minutes")
            save_state(state)
            ok(f"{app['name']} renouvelée jusqu'au {fmt_date(app['expires'])}")
        except Fail as e:
            warn(f"{app['name']} : {e}")
            failures.append(app)
    if failures and args.notify:
        urgent = [a for a in failures if (days_left(a) or 0) < 1.5]
        if urgent:
            notify("ATVLoad n'a pas pu renouveler : " + ", ".join(a["name"] for a in urgent) +
                   ".\nAllume l'Apple TV et lance « atvload refresh ». Détails dans le journal.")
    if failures:
        raise Fail(f"{len(failures)} renouvellement(s) en échec.")


def notify(text):
    log_to_file("NOTIFY " + text)
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, text, APP_NAME, 0x40 | 0x40000)  # info + topmost
        except Exception:
            pass


def task_exists():
    if os.name != "nt":
        return False
    return subprocess.run(["schtasks", "/Query", "/TN", TASK_NAME],
                          capture_output=True, **NOWIN).returncode == 0


def cmd_schedule(args, state):
    if os.name != "nt":
        raise Fail("La planification n'est disponible que sous Windows.")
    if FROZEN:   # ATVLoad.exe : il se relance lui-même en mode renouvellement silencieux
        action = f'"{Path(sys.executable).resolve()}" refresh --notify'
    else:
        pyw = Path(sys.executable).with_name("pythonw.exe")
        exe = pyw if pyw.exists() else Path(sys.executable)
        action = f'"{exe}" "{Path(__file__).resolve()}" refresh --notify'
    hour = args.time or "12:00"
    r = subprocess.run(["schtasks", "/Create", "/F", "/TN", TASK_NAME, "/SC", "DAILY",
                        "/ST", hour, "/TR", action], capture_output=True, text=True, errors="replace", **NOWIN)
    if r.returncode != 0:
        raise Fail("Création de la tâche planifiée échouée : " + (r.stderr or r.stdout).strip())
    # Rattrapage si le PC était éteint à l'heure prévue
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun:$false; "
                    f"Set-ScheduledTask -TaskName '{TASK_NAME}' -Settings $s | Out-Null"],
                   capture_output=True, **NOWIN)
    ok(f"Renouvellement automatique activé : chaque jour à {hour} (rattrapé au démarrage si le PC était éteint).")
    info(f"Seules les apps à moins de {REFRESH_MARGIN_DAYS} jours de l'expiration sont renouvelées. "
         "Le PC doit être allumé et l'Apple TV sur le même réseau.")


def cmd_unschedule(args, state):
    subprocess.run(["schtasks", "/Delete", "/F", "/TN", TASK_NAME], capture_output=True, **NOWIN)
    ok("Renouvellement automatique désactivé.")


def cmd_certs(args, state):
    if not state.get("account"):
        raise Fail("Pas de compte : atvload login")
    run_tee(plume_cmd("certificate", "list", "-u", state["account"]))


# ======================================================================= CLI

def main():
    ap = argparse.ArgumentParser(prog="atvload",
                                 description="Installe tes apps tvOS sur Apple TV depuis Windows, Apple ID gratuit.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("setup", help="télécharge plumesign et vérifie l'installation")
    p.add_argument("--force", action="store_true", help="retélécharger plumesign")
    p.set_defaults(fn=cmd_setup)

    p = sub.add_parser("scan", help="liste les Apple TV du réseau")
    p.add_argument("--wait", type=float, default=6.0)
    p.set_defaults(fn=cmd_scan)

    sub.add_parser("pair", help="appaire l'Apple TV (code PIN)").set_defaults(fn=cmd_pair)

    p = sub.add_parser("login", help="connecte ton Apple ID")
    p.add_argument("email", nargs="?")
    p.set_defaults(fn=cmd_login)

    p = sub.add_parser("install", help="signe et installe une IPA tvOS")
    p.add_argument("ipa")
    p.add_argument("--udid", help="choisir l'Apple TV si plusieurs")
    p.add_argument("--revoke", metavar="SERIE", help="révoquer ce certificat si la limite est atteinte")
    p.set_defaults(fn=cmd_install)

    sub.add_parser("list", help="apps installées et expiration").set_defaults(fn=cmd_list)

    p = sub.add_parser("refresh", help="renouvelle les apps proches de l'expiration")
    p.add_argument("--all", action="store_true", help="tout renouveler maintenant")
    p.add_argument("--notify", action="store_true", help="fenêtre d'alerte en cas d'échec (tâche planifiée)")
    p.set_defaults(fn=cmd_refresh)

    p = sub.add_parser("schedule", help="active le renouvellement automatique")
    p.add_argument("--time", help="heure HH:MM (défaut 12:00)")
    p.set_defaults(fn=cmd_schedule)
    sub.add_parser("unschedule", help="désactive le renouvellement automatique").set_defaults(fn=cmd_unschedule)
    sub.add_parser("certs", help="liste tes certificats Apple").set_defaults(fn=cmd_certs)

    args = ap.parse_args()
    state = load_state()
    try:
        args.fn(args, state)
    except Fail as e:
        print(f"[XX] {e}")
        log_to_file("XX " + str(e))
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrompu.")
        sys.exit(130)


if __name__ == "__main__":
    main()
