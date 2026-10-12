# -*- coding: utf-8 -*-
"""Fabrication GitHub : lance l'appli iPad dans le simulateur avec un faux fournisseur IPTV
et prend des captures d'écran de chaque écran (accueil, fiche, direct, réglages, lecteur)."""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
IOS = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
APP = os.path.join(IOS, "build", "sim", "Build", "Products", "Debug-iphonesimulator", "ShippoTV.app")
BUNDLE = "app.shippotv.ipad"


def sh(*a, env=None, check=True):
    print("+", " ".join(a), flush=True)
    return subprocess.run(a, check=check, env=env, capture_output=True, text=True)


def pick_ipad():
    devs = json.loads(sh("xcrun", "simctl", "list", "devices", "available", "-j").stdout)["devices"]
    ipads = [d for rt, lst in devs.items() if "iOS" in rt for d in lst if d["name"].startswith("iPad")]
    pref = ["iPad Air 11", "iPad Air (5th", "iPad Pro 11", "iPad Air", "iPad Pro", "iPad"]
    for p in pref:
        for d in ipads:
            if d["name"].startswith(p):
                return d
    sys.exit("aucun simulateur iPad")


def main():
    os.makedirs(OUT, exist_ok=True)
    mock = subprocess.Popen([sys.executable, os.path.join(HERE, "mock.py")])
    time.sleep(2)
    d = pick_ipad()
    udid = d["udid"]
    print("Simulateur :", d["name"], flush=True)
    sh("xcrun", "simctl", "boot", udid, check=False)
    sh("xcrun", "simctl", "bootstatus", udid, "-b")
    sh("xcrun", "simctl", "install", udid, APP)
    first = True
    for route in ["home", "detail", "live", "settings", "player"]:
        sh("xcrun", "simctl", "terminate", udid, BUNDLE, check=False)
        test = {"server": "127.0.0.1:8799", "user": "demo", "pass": "demo", "country": "FR", "route": route}
        env = dict(os.environ, SIMCTL_CHILD_SHIPPO_TEST=json.dumps(test))
        r = sh("xcrun", "simctl", "launch", udid, BUNDLE, env=env, check=False)
        print(r.stdout, r.stderr, flush=True)
        time.sleep(35 if first else 22)
        first = False
        path = os.path.join(OUT, f"{route}.png")
        sh("xcrun", "simctl", "io", udid, "screenshot", path, check=False)
        # l'appli est en paysage : on remet l'image dans le bon sens si besoin
        info = sh("sips", "-g", "pixelWidth", "-g", "pixelHeight", path, check=False).stdout
        try:
            w = int(info.split("pixelWidth:")[1].split()[0]); h = int(info.split("pixelHeight:")[1].split()[0])
            if h > w:
                sh("sips", "-r", "270", path, check=False)
        except (IndexError, ValueError):
            pass
    logs = sh("xcrun", "simctl", "spawn", udid, "log", "show", "--last", "5m", "--style", "compact",
              "--predicate", 'process == "ShippoTV"', check=False).stdout
    with open(os.path.join(OUT, "journal.txt"), "w") as f:
        f.write(logs[-200000:])
    # sous-titres d'un film « cinémascope » : où VLC les place-t-il selon le réglage ?
    for name, lib, media in [("subs-defaut", "", ""),
                             ("subs-canvas", "", ":video-filter=canvas|:canvas-aspect=59:41|:canvas-padd"),
                             ("subs-canvas-lib", "--video-filter=canvas", ":canvas-aspect=59:41|:canvas-padd")]:
        sh("xcrun", "simctl", "terminate", udid, BUNDLE, check=False)
        test = {"server": "127.0.0.1:8799", "user": "demo", "pass": "demo", "country": "FR", "route": "subs"}
        env = dict(os.environ, SIMCTL_CHILD_SHIPPO_TEST=json.dumps(test), SIMCTL_CHILD_SHIPPO_SUBLIB=lib, SIMCTL_CHILD_SHIPPO_MEDIAOPTS=media)
        sh("xcrun", "simctl", "launch", udid, BUNDLE, env=env, check=False)
        time.sleep(20)
        path = os.path.join(OUT, f"{name}.png")
        sh("xcrun", "simctl", "io", udid, "screenshot", path, check=False)
        info = sh("sips", "-g", "pixelWidth", "-g", "pixelHeight", path, check=False).stdout
        try:
            w = int(info.split("pixelWidth:")[1].split()[0]); h = int(info.split("pixelHeight:")[1].split()[0])
            if h > w:
                sh("sips", "-r", "270", path, check=False)
        except (IndexError, ValueError):
            pass
    mock.terminate()


if __name__ == "__main__":
    main()
