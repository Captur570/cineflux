# -*- coding: utf-8 -*-
"""Fabrication GitHub : lance l'appli Apple TV dans le simulateur tvOS avec un faux fournisseur IPTV
(le même que pour l'iPad) et prend des captures : mise en route (QR code), accueil, fiche, lecteur, sous-titres.
Le journal du moteur (JavaScriptCore) est extrait à part pour repérer les erreurs."""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TVOS = os.path.dirname(HERE)
ROOT = os.path.dirname(TVOS)
OUT = os.path.join(HERE, "out")
APP = os.path.join(TVOS, "build", "sim", "Build", "Products", "Debug-appletvsimulator", "ShippoTV.app")
BUNDLE = "app.shippotv.atv"
MOCK = os.path.join(ROOT, "ios", "ci", "mock.py")


def sh(*a, env=None, check=True):
    print("+", " ".join(a), flush=True)
    return subprocess.run(a, check=check, env=env, capture_output=True, text=True)


def pick_tv():
    devs = json.loads(sh("xcrun", "simctl", "list", "devices", "available", "-j").stdout)["devices"]
    tvs = [d for rt, lst in devs.items() if "tvOS" in rt for d in lst]
    for p in ("Apple TV 4K (3rd", "Apple TV 4K", "Apple TV"):
        for d in tvs:
            if d["name"].startswith(p):
                return d
    sys.exit("aucun simulateur Apple TV")


def main():
    os.makedirs(OUT, exist_ok=True)
    mock = subprocess.Popen([sys.executable, MOCK])
    time.sleep(2)
    d = pick_tv()
    udid = d["udid"]
    print("Simulateur :", d["name"], flush=True)
    sh("xcrun", "simctl", "boot", udid, check=False)
    sh("xcrun", "simctl", "bootstatus", udid, "-b")
    sh("xcrun", "simctl", "install", udid, APP)
    base = {"server": "127.0.0.1:8799", "user": "demo", "pass": "demo", "tmdb_api": "http://127.0.0.1:8799/3", "tmdb_key": "testkey"}
    # « setup » d'abord : l'appli vient d'être installée, rien n'est configuré
    routes = (("setup", 25), ("home", 30), ("detail", 22), ("player", 26), ("subs", 22),
              ("series", 22), ("series_detail", 24), ("episode", 26), ("live", 24), ("live_play", 26), ("live_noimg", 30), ("live_4k", 24), ("search", 22))
    for route, wait in routes:
        sh("xcrun", "simctl", "terminate", udid, BUNDLE, check=False)
        extra = {"search": "dune"} if route == "search" else {}
        env = dict(os.environ, SIMCTL_CHILD_SHIPPO_TEST=json.dumps(dict(base, route=route, **extra)))
        r = sh("xcrun", "simctl", "launch", udid, BUNDLE, env=env, check=False)
        print(r.stdout, r.stderr, flush=True)
        time.sleep(wait)
        sh("xcrun", "simctl", "io", udid, "screenshot", os.path.join(OUT, f"{route}.png"), check=False)
    logs = sh("xcrun", "simctl", "spawn", udid, "log", "show", "--last", "8m", "--style", "compact",
              "--predicate", 'process == "ShippoTV"', check=False).stdout
    with open(os.path.join(OUT, "journal.txt"), "w") as f:
        f.write(logs[-200000:])
    with open(os.path.join(OUT, "journal-moteur.txt"), "w") as f:
        f.write("\n".join(l for l in logs.splitlines() if "[moteur" in l or "[direct]" in l)[-100000:])
    mock.terminate()


if __name__ == "__main__":
    main()
