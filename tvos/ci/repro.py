# -*- coding: utf-8 -*-
"""Essais GitHub « reproduire avant de corriger » (simulateur Apple TV) :
1. association : un faux PC (vrai moteur) fabrique un code AVEC identifiants sur un faux serveur de synchro ;
   l'appli fraîchement installée le saisit et appuie sur « Valider ». Captures toutes les 2-3 s + suivi pas à pas.
2. affiches : 3 000 films ayant chacun une fiche et une affiche (servie avec un délai réseau réaliste) ;
   l'accueil est compté toutes les 5 s, avec l'ancien affichage (AsyncImage) puis le nouveau.
Résultats dans tvos/ci/repro/ (captures + journaux)."""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TVOS = os.path.dirname(HERE)
ROOT = os.path.dirname(TVOS)
OUT = os.path.join(HERE, "repro")
APP = os.path.join(TVOS, "build", "sim", "Build", "Products", "Debug-appletvsimulator", "ShippoTV.app")
BUNDLE = "app.shippotv.atv"


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


def fresh(udid):
    sh("xcrun", "simctl", "terminate", udid, BUNDLE, check=False)
    sh("xcrun", "simctl", "uninstall", udid, BUNDLE, check=False)
    sh("xcrun", "simctl", "install", udid, APP)


def launch(udid, test, extra_env=None):
    env = dict(os.environ, SIMCTL_CHILD_SHIPPO_TEST=json.dumps(test))
    for k, v in (extra_env or {}).items():
        env["SIMCTL_CHILD_" + k] = v
    r = sh("xcrun", "simctl", "launch", udid, BUNDLE, env=env, check=False)
    print(r.stdout, r.stderr, flush=True)


def shots(udid, name, times):
    t0 = time.time()
    for t in times:
        time.sleep(max(0, t - (time.time() - t0)))
        sh("xcrun", "simctl", "io", udid, "screenshot", os.path.join(OUT, f"{name}-{int(t):03d}s.png"), check=False)


def journal(udid, name, since):
    # journal de l'essai écrit par l'appli dans ses Documents
    box = sh("xcrun", "simctl", "get_app_container", udid, BUNDLE, "data", check=False).stdout.strip()
    src = os.path.join(box, "Documents", "essai.txt")
    txt = open(src).read() if box and os.path.exists(src) else "(pas de journal d'essai)"
    logs = sh("xcrun", "simctl", "spawn", udid, "log", "show", "--last", "4m", "--style", "compact",
              "--predicate", 'process == "ShippoTV"', check=False).stdout
    keep = [l for l in logs.splitlines() if any(x in l for x in ("[diag]", "[moteur", "exception"))]
    with open(os.path.join(OUT, f"{name}-journal.txt"), "w") as f:
        f.write(txt + "\n\n----- journal système -----\n" + "\n".join(keep)[-100000:])


def stamp(udid):
    return ""


def main():
    os.makedirs(OUT, exist_ok=True)
    sync = subprocess.Popen([sys.executable, os.path.join(HERE, "fakesync.py")])
    mock = subprocess.Popen([sys.executable, os.path.join(ROOT, "ios", "ci", "mock.py")], env=dict(os.environ, MOCK_POSTERS="30000"))
    time.sleep(2)
    d = pick_tv()
    udid = d["udid"]
    print("Simulateur :", d["name"], flush=True)
    sh("xcrun", "simctl", "boot", udid, check=False)
    sh("xcrun", "simctl", "bootstatus", udid, "-b")
    base = {"server": "127.0.0.1:8799", "user": "demo", "pass": "demo", "tmdb_api": "http://127.0.0.1:8799/3",
            "tmdb_key": "testkey", "img_base": "http://127.0.0.1:8799/img/"}

    # 1. association depuis l'écran de bienvenue
    pc = subprocess.Popen(["node", os.path.join(HERE, "pc_code.js")], stdout=subprocess.PIPE, text=True)
    code = pc.stdout.readline().strip()
    print("Code du faux PC :", code, flush=True)
    fresh(udid)
    since = stamp(udid)
    launch(udid, dict(base, route="join", code=code, sync_url="http://127.0.0.1:8798", sync_key="test"))
    shots(udid, "association", [3, 5, 6, 7, 8, 10, 14, 20, 30])
    journal(udid, "association", since)

    # 2. affiches : ancien affichage puis nouveau, chacun sur une installation neuve
    for mode in ("ancien", "nouveau"):
        fresh(udid)
        since = stamp(udid)
        launch(udid, dict(base, route="scroll"), {"SHIPPO_IMG": "async"} if mode == "ancien" else None)
        shots(udid, f"affiches-{mode}", [20, 40, 60, 80, 100, 120, 150, 170])
        journal(udid, f"affiches-{mode}", since)

    pc.kill()
    mock.terminate()
    sync.terminate()


if __name__ == "__main__":
    main()
