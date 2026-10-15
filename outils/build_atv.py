# -*- coding: utf-8 -*-
"""
ShippoTV pour Apple TV : prépare le moteur ShippoTV embarqué dans l'appli tvOS (tvos/ShippoTV/Resources/Engine).

  python outils/build_atv.py

Le moteur (catalogue, Xtream, TMDB, guide TV, synchronisation) est le même que sur la télé Samsung
et l'iPad ; sur l'Apple TV il tourne dans JavaScriptCore, l'interface est en SwiftUI.

Valeurs intégrées (synchronisation, clé TMDB facultative) :
  - sur GitHub (fabrication automatique) : secrets SUPABASE_URL, SUPABASE_KEY, TMDB_KEY (facultatif) ;
  - sur un PC : lues comme pour la version Windows (distribution.json, réglages locaux).
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_ios  # noqa: E402  (mêmes valeurs intégrées que l'iPad)

ROOT = build_ios.ROOT
OUT = os.path.join(ROOT, "tvos", "ShippoTV", "Resources", "Engine")
ENGINE = ["store.js", "tvguide.js", "verify.js", "catalog.js", "sync.js", "app.js"]


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    for f in ENGINE:
        shutil.copy(os.path.join(ROOT, "tv", "engine", f), os.path.join(OUT, f))
    shutil.copy(os.path.join(ROOT, "tvos", "bridge.js"), os.path.join(OUT, "bridge.js"))
    d = build_ios.defaults()
    with open(os.path.join(OUT, "defaults.js"), "w", encoding="utf-8") as f:
        f.write("window.SHIPPO_DEFAULTS = " + json.dumps(d) + ";\nwindow.SHIPPO_PLATFORM = 'atv';\n")
    with open(os.path.join(OUT, "order.json"), "w", encoding="utf-8") as f:
        json.dump(["bridge.js", "defaults.js"] + ENGINE, f)
    print(f"Moteur Apple TV prêt : {OUT} (version {d['version']}, synchro {'oui' if d['supabase_url'] else 'non'})")


if __name__ == "__main__":
    main()
