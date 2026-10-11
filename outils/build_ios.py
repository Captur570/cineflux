# -*- coding: utf-8 -*-
"""
ShippoTV pour iPad : prépare l'interface web embarquée dans l'appli iOS (ios/ShippoTV/web).

  python outils/build_ios.py

Valeurs intégrées (synchronisation, clé TMDB facultative) :
  - sur GitHub (fabrication automatique) : secrets SUPABASE_URL, SUPABASE_KEY, TMDB_KEY (facultatif) ;
  - sur un PC : lues comme pour la version Windows (distribution.json, réglages locaux).
La clé TMDB peut aussi arriver par le code de jumelage donné par le PC.
"""
import base64
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "ios", "ShippoTV", "web")
ENGINE = ["store.js", "tvguide.js", "verify.js", "catalog.js", "sync.js", "app.js"]


def version():
    with open(os.path.join(ROOT, "version.txt"), encoding="utf-8") as f:
        return f.read().strip()


def obf(key):
    return base64.b64encode(bytes(b ^ 0x5A for b in key.encode())).decode() if key else ""


def defaults():
    env = os.environ
    if env.get("GITHUB_ACTIONS"):
        url = re.sub(r"(/rest/v1)?/*$", "", (env.get("SUPABASE_URL") or "").strip())
        return {"version": version(), "supabase_url": url, "supabase_key": (env.get("SUPABASE_KEY") or "").strip(),
                "tmdb_key_obf": obf((env.get("TMDB_KEY") or "").strip()), "update_repo": env.get("GITHUB_REPOSITORY") or ""}
    sys.path.insert(0, os.path.join(ROOT, "outils"))
    import preparer
    preparer.main()
    with open(os.path.join(ROOT, "build", "defaults_build.json"), encoding="utf-8") as f:
        d = json.load(f)
    return {"version": version(), "supabase_url": d.get("supabase_url") or "", "supabase_key": d.get("supabase_key") or "",
            "tmdb_key_obf": d.get("tmdb_key_obf") or "", "update_repo": d.get("update_repo") or ""}


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(os.path.join(ROOT, "web"), OUT, ignore=shutil.ignore_patterns("vendor"))
    os.makedirs(os.path.join(OUT, "engine"), exist_ok=True)
    for f in ENGINE + ["catalog-worker.js"]:
        shutil.copy(os.path.join(ROOT, "tv", "engine", f), os.path.join(OUT, "engine", f))
    for f in ("platform-ios.js", "ios.css"):
        shutil.copy(os.path.join(ROOT, "ios", f), os.path.join(OUT, f))
    d = defaults()
    with open(os.path.join(OUT, "defaults.js"), "w", encoding="utf-8") as f:
        f.write("window.SHIPPO_DEFAULTS = " + json.dumps(d) + ";\nwindow.SHIPPO_PLATFORM = 'ios';\n")
    with open(os.path.join(ROOT, "web", "index.html"), encoding="utf-8") as f:
        html = f.read()
    html = html.replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
                        '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">')
    html = html.replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="ios.css">')
    html = re.sub(r'<script src="vendor/[^"]+"></script>\n?', "", html)
    engine = "\n".join(['<script src="defaults.js"></script>'] + [f'<script src="engine/{f}"></script>' for f in ENGINE])
    for need in ('<script src="js/core.js"></script>', '<script src="js/boot.js"></script>'):
        if need not in html:
            sys.exit("web/index.html inattendu")
    html = html.replace('<script src="js/core.js"></script>', engine + '\n<script src="js/core.js"></script>')
    html = html.replace('<script src="js/boot.js"></script>', '<script src="platform-ios.js"></script>\n<script src="js/boot.js"></script>')
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Interface iPad prête : {OUT} (version {d['version']}, synchro {'oui' if d['supabase_url'] else 'non'})")


if __name__ == "__main__":
    main()
