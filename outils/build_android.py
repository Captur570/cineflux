# -*- coding: utf-8 -*-
"""
ShippoTV pour Android TV (box Android, Player Freebox Pop…) : prépare l'interface web embarquée
dans l'appli Android (android/app/src/main/assets/web).

  python outils/build_android.py

Interface de la télé Samsung (navigation à la télécommande) + pont natif (réseau, stockage, lecteur),
même protocole que l'iPad. Valeurs intégrées comme pour l'iPad (secrets GitHub ou réglages du PC).
"""
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "android", "app", "src", "main", "assets", "web")
ENGINE = ["qrcode.js", "store.js", "tvguide.js", "verify.js", "catalog.js", "sync.js", "app.js"]

sys.path.insert(0, os.path.join(ROOT, "outils"))
import build_ios  # noqa: E402  (mêmes valeurs intégrées)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(os.path.join(ROOT, "web"), OUT, ignore=shutil.ignore_patterns("vendor"))
    os.makedirs(os.path.join(OUT, "engine"), exist_ok=True)
    for f in ENGINE + ["catalog-worker.js"]:
        shutil.copy(os.path.join(ROOT, "tv", "engine", f), os.path.join(OUT, "engine", f))
    for f in ("platform.js", "tv.css"):
        shutil.copy(os.path.join(ROOT, "tv", f), os.path.join(OUT, f))
    for f in ("bridge.js", "platform-android.js"):
        shutil.copy(os.path.join(ROOT, "android", "web", f), os.path.join(OUT, f))
    d = build_ios.defaults()
    d["update_repo"] = ""          # mises à jour gérées par l'appli Android elle-même (release android-beta)
    with open(os.path.join(OUT, "defaults.js"), "w", encoding="utf-8") as f:
        f.write("window.SHIPPO_DEFAULTS = " + json.dumps(d) + ";\nwindow.SHIPPO_PLATFORM = 'android';\n")
    with open(os.path.join(ROOT, "web", "index.html"), encoding="utf-8") as f:
        html = f.read()
    html = html.replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
                        '<meta name="viewport" content="width=1280, user-scalable=no">')
    html = html.replace('<link rel="stylesheet" href="style.css">',
                        '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="tv.css">')
    html = re.sub(r'<script src="vendor/[^"]+"></script>\n?', "", html)
    if '<script src="js/core.js"></script>' not in html or '<script src="js/boot.js"></script>' not in html:
        sys.exit("web/index.html inattendu")
    engine = "\n".join(['<script src="bridge.js"></script>', '<script src="defaults.js"></script>']
                       + [f'<script src="engine/{f}"></script>' for f in ENGINE])
    html = html.replace('<script src="js/core.js"></script>', engine + '\n<script src="js/core.js"></script>')
    html = html.replace('<script src="js/boot.js"></script>',
                        '<script src="platform.js"></script>\n<script src="platform-android.js"></script>\n<script src="js/boot.js"></script>')
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Interface Android prête : {OUT} (version {d['version']}, synchro {'oui' if d['supabase_url'] else 'non'})")


if __name__ == "__main__":
    main()
