# -*- coding: utf-8 -*-
"""
ShippoTV pour télé Samsung (Tizen) : assemble l'appli TV, la signe et l'installe sur la télé.

  python outils/build_tv.py                 -> construit build/tv-app + Output/ShippoTV-TV-x.y.z.wgt et installe
  python outils/build_tv.py --build-only    -> construit seulement (sans Tizen Studio)

Réglages mémorisés dans tv.json (adresse IP de la télé, profil de certificat).
"""
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "tv-app")
PKG = "ShippoTV01"                       # identifiant de paquet Tizen (10 caractères)
APP_ID = PKG + ".ShippoTV"
ENGINE = ["qrcode.js", "store.js", "tvguide.js", "verify.js", "catalog.js", "sync.js", "app.js"]


def say(msg, color=""):
    codes = {"ok": "\033[92m", "err": "\033[91m", "info": "\033[96m", "warn": "\033[93m"}
    if os.name == "nt":
        os.system("")                     # active les couleurs dans la console Windows
    print(f"{codes.get(color, '')}{msg}\033[0m" if color else msg, flush=True)


def fail(msg):
    say("  ERREUR : " + msg, "err")
    sys.exit(1)


def version():
    with open(os.path.join(ROOT, "version.txt"), encoding="utf-8") as f:
        return f.read().strip() or "5.1.0"


def defaults():
    """Mêmes valeurs intégrées que la version PC (clé TMDB, synchronisation)."""
    sys.path.insert(0, os.path.join(ROOT, "outils"))
    import preparer
    preparer.main()
    with open(os.path.join(ROOT, "build", "defaults_build.json"), encoding="utf-8") as f:
        d = json.load(f)
    return {"version": version(), "supabase_url": d.get("supabase_url") or "", "supabase_key": d.get("supabase_key") or "",
            "tmdb_key_obf": d.get("tmdb_key_obf") or "", "update_repo": d.get("update_repo") or ""}


CONFIG_XML = """<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="http://shippotv.app/tv" version="{ver}" viewmodes="maximized">
    <tizen:application id="{app}" package="{pkg}" required_version="3.0"/>
    <content src="index.html"/>
    <feature name="http://tizen.org/feature/screen.size.all"/>
    <icon src="icon.png"/>
    <name>ShippoTV</name>
    <tizen:profile name="tv-samsung"/>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.audio"/>
    <tizen:privilege name="http://tizen.org/privilege/application.launch"/>
    <access origin="*" subdomains="true"></access>
    <tizen:content-security-policy>default-src * 'unsafe-inline' 'unsafe-eval' data: blob: filesystem:; img-src * data: blob:; media-src * blob:; connect-src *; font-src * data:; style-src * 'unsafe-inline'</tizen:content-security-policy>
    <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
"""


def build():
    say("  Assemblage de l'appli TV…", "info")
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(os.path.join(ROOT, "web"), OUT)
    os.makedirs(os.path.join(OUT, "engine"), exist_ok=True)
    for f in ENGINE + ["catalog-worker.js"]:
        shutil.copy(os.path.join(ROOT, "tv", "engine", f), os.path.join(OUT, "engine", f))
    for f in ("platform.js", "tv.css"):
        shutil.copy(os.path.join(ROOT, "tv", f), os.path.join(OUT, f))
    shutil.copy(os.path.join(ROOT, "assets", "shippotv.png"), os.path.join(OUT, "icon.png"))
    d = defaults()
    with open(os.path.join(OUT, "defaults.js"), "w", encoding="utf-8") as f:
        f.write("window.SHIPPO_DEFAULTS = " + json.dumps(d) + ";\n")

    with open(os.path.join(ROOT, "web", "index.html"), encoding="utf-8") as f:
        html = f.read()
    html = html.replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
                        '<meta name="viewport" content="width=1280, user-scalable=no">')
    html = html.replace('<link rel="stylesheet" href="style.css">',
                        '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="tv.css">')
    engine = "\n".join(['<script src="$WEBAPIS/webapis/webapis.js"></script>', '<script src="defaults.js"></script>']
                       + [f'<script src="engine/{f}"></script>' for f in ENGINE])
    if '<script src="js/core.js"></script>' not in html or '<script src="js/boot.js"></script>' not in html:
        fail("web/index.html inattendu")
    html = html.replace('<script src="js/core.js"></script>', engine + '\n<script src="js/core.js"></script>')
    html = html.replace('<script src="js/boot.js"></script>', '<script src="platform.js"></script>\n<script src="js/boot.js"></script>')
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    with open(os.path.join(OUT, "config.xml"), "w", encoding="utf-8") as f:
        f.write(CONFIG_XML.format(ver=d["version"], app=APP_ID, pkg=PKG))
    say(f"  OK : {OUT}", "ok")
    return d["version"]


# --------------------------------------------------------------------------- Tizen Studio
def tizen_paths():
    roots = [os.environ.get("TIZEN_STUDIO", ""), r"C:\tizen-studio", os.path.expanduser(r"~\tizen-studio"),
             r"D:\tizen-studio"]
    for r in roots:
        if not r:
            continue
        cli = os.path.join(r, "tools", "ide", "bin", "tizen.bat" if os.name == "nt" else "tizen")
        sdb = os.path.join(r, "tools", "sdb.exe" if os.name == "nt" else "sdb")
        if os.path.isfile(cli) and os.path.isfile(sdb):
            return cli, sdb
    return None, None


def run(cmd, check=True, capture=False):
    say("  > " + " ".join(f'"{c}"' if " " in c else c for c in cmd))
    r = subprocess.run(cmd, capture_output=capture, text=True, shell=False,
                       encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        if capture:
            print(r.stdout, r.stderr)
        fail("la commande a échoué (voir ci-dessus)")
    return r


def settings():
    p = os.path.join(ROOT, "tv.json")
    try:
        with open(p, encoding="utf-8") as f:
            s = json.load(f)
    except (OSError, ValueError):
        s = {}
    if not s.get("tv_ip"):
        say("\n  Adresse IP de la télé ?", "info")
        say("  (Sur la télé : Paramètres > Général et confidentialité > Réseau > État du réseau > Paramètres IP)")
        s["tv_ip"] = input("  IP de la télé (ex. 192.168.1.50) : ").strip()
    if not s.get("profile"):
        s["profile"] = "ShippoTV"
    with open(p, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)
    return s


def install(ver):
    cli, sdb = tizen_paths()
    if not cli:
        fail("Tizen Studio introuvable (C:\\tizen-studio). Suivez GUIDE_TV.txt, étape 2.")
    s = settings()
    ip = s["tv_ip"]
    serial = ip if ":" in ip else ip + ":26101"

    say("\n  Connexion à la télé…", "info")
    r = run([sdb, "connect", ip], check=False, capture=True)
    out = (r.stdout or "") + (r.stderr or "")
    print("  " + out.strip())
    if "connected" not in out.lower():
        fail("télé injoignable. Vérifiez qu'elle est allumée, en mode développeur, et que l'IP du PC y est bien renseignée "
             "(GUIDE_TV.txt, étape 1).")

    say("\n  Signature du paquet…", "info")
    for f in os.listdir(OUT):
        if f.endswith(".wgt"):
            os.remove(os.path.join(OUT, f))
    r = run([cli, "package", "-t", "wgt", "-s", s["profile"], "--", OUT], check=False, capture=True)
    print((r.stdout or "") + (r.stderr or ""))
    wgts = [f for f in os.listdir(OUT) if f.endswith(".wgt")]
    if r.returncode != 0 or not wgts:
        fail(f"signature impossible. Le profil de certificat « {s['profile']} » existe-t-il dans le Certificate Manager "
             "(GUIDE_TV.txt, étape 3) ?")
    os.makedirs(os.path.join(ROOT, "Output"), exist_ok=True)
    final = os.path.join(ROOT, "Output", f"ShippoTV-TV-{ver}.wgt")
    shutil.copy(os.path.join(OUT, wgts[0]), final)

    say("\n  Installation sur la télé…", "info")
    r = run([cli, "install", "-n", wgts[0], "-s", serial, "--", OUT], check=False, capture=True)
    out = (r.stdout or "") + (r.stderr or "")
    print(out)
    if r.returncode != 0 or "fail" in out.lower() and "success" not in out.lower():
        hint = ""
        if "certificate" in out.lower() or "signature" in out.lower() or "-12" in out:
            hint = " Le certificat ne correspond pas à cette télé : refaites l'étape 3 du guide avec la télé connectée."
        fail("installation refusée par la télé." + hint)
    say("\n  Lancement de ShippoTV sur la télé…", "info")
    run([cli, "run", "-p", APP_ID, "-s", serial], check=False)
    say(f"\n  Terminé ! ShippoTV {ver} est installé sur la télé (rangée des applis).", "ok")


def make_unsigned(ver):
    """Paquet .wgt non signé : à installer avec Apps2Samsung, qui le signe lui-même pour votre télé."""
    import zipfile
    os.makedirs(os.path.join(ROOT, "Output"), exist_ok=True)
    dest = os.path.join(ROOT, "Output", f"ShippoTV-TV-{ver}.wgt")
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(OUT):
            for f in files:
                if f.endswith(".wgt"):
                    continue
                full = os.path.join(base, f)
                z.write(full, os.path.relpath(full, OUT).replace(os.sep, "/"))
    say(f"  Paquet prêt : {dest}", "ok")
    return dest


def main():
    ver = build()
    if "--build-only" in sys.argv or "--wgt" in sys.argv:
        dest = make_unsigned(ver)
        if os.name == "nt" and "--wgt" in sys.argv:
            os.startfile(os.path.dirname(dest))
        return
    install(ver)


if __name__ == "__main__":
    main()
