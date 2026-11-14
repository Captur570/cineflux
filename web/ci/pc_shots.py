"""Captures de l'interface ShippoTV dans Chromium (GitHub), avec le faux fournisseur ios/ci/mock.py :
version PC (souris, grand écran) puis mode télécommande (flèches). Utilise l'interface assemblée pour
Android (android/app/src/main/assets/web), sans les fichiers propres à Android : le moteur tourne dans la page."""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "android", "app", "src", "main", "assets", "web")
SITE = os.path.join(ROOT, "build", "pc-apercu")
OUT = os.path.join(ROOT, "web", "ci", "out")

TEST_JS = r"""
(function () {
  var T = {};
  try { T = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}'); } catch (e) {}
  window.SHIPPO_TEST = T;
  if (T.tmdb_api && window.SHIPPO_DEFAULTS) window.SHIPPO_DEFAULTS.tmdb_api = T.tmdb_api;
  window.SHIPPO_PLATFORM = 'pc';
})();
"""
WRAP_JS = r"""
(function () {
  var T = window.SHIPPO_TEST || {};
  if (!window.ENGINE || !T.server) return;
  var call0 = ENGINE.call, ready = false;
  ENGINE.call = async function (path, body, prof) {
    if (!ready) {
      ready = true;
      await ENGINE.ready();
      var c = ENGINE._CONFIG.data;
      if (!c.server) { Object.assign(c, { server: T.server, username: T.user, password: T.pass, country: 'FR', tmdb_key: T.tmdb || '' }); ENGINE._CONFIG.save(); }
    }
    return call0.call(this, path, body, prof);
  };
})();
"""


def assemble():
    if os.path.isdir(SITE):
        shutil.rmtree(SITE)
    shutil.copytree(SRC, SITE)
    with open(os.path.join(SITE, "index.html"), encoding="utf-8") as f:
        h = f.read()
    for tag in ['<link rel="stylesheet" href="tv.css">', '<link rel="stylesheet" href="android.css">',
                '<script src="bridge.js"></script>', '<script src="platform.js"></script>', '<script src="platform-android.js"></script>']:
        h = h.replace(tag + "\n", "").replace(tag, "")
    h = h.replace('<script src="defaults.js"></script>', '<script src="defaults.js"></script>\n<script src="test.js"></script>')
    h = h.replace('<script src="js/core.js"></script>', '<script src="wrap.js"></script>\n<script src="js/core.js"></script>')
    h = h.replace('<meta name="viewport" content="width=1280, user-scalable=no">', '<meta name="viewport" content="width=device-width, initial-scale=1">')
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as f:
        f.write(h)
    open(os.path.join(SITE, "test.js"), "w").write(TEST_JS)
    open(os.path.join(SITE, "wrap.js"), "w").write(WRAP_JS)


def main():
    assemble()
    os.makedirs(OUT, exist_ok=True)
    mock = subprocess.Popen([sys.executable, os.path.join(ROOT, "ios", "ci", "mock.py")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = ThreadingHTTPServer(("127.0.0.1", 8800), partial(SimpleHTTPRequestHandler, directory=SITE))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(1.5)
    from playwright.sync_api import sync_playwright
    T = {"server": "127.0.0.1:8799", "user": "demo", "pass": "demo", "tmdb": "testkey", "tmdb_api": "http://127.0.0.1:8799/3"}
    url = "http://127.0.0.1:8800/index.html#" + urllib.parse.quote(json.dumps(T))
    log = open(os.path.join(OUT, "console.txt"), "w", encoding="utf-8")
    with sync_playwright() as p:
        exe = os.environ.get("CHROME_PATH") or None
        b = p.chromium.launch(executable_path=exe, args=["--disable-web-security", "--autoplay-policy=no-user-gesture-required"])

        def shot(page, name, wait=1.2):
            time.sleep(wait)
            page.screenshot(path=os.path.join(OUT, name + ".png"))
            print("capture", name, flush=True)

        def step(page, name, js=None, wait=1.5, keys=()):
            try:
                if js:
                    page.evaluate(js)
                for k in keys:
                    page.keyboard.press(k)
                    time.sleep(0.25)
                shot(page, name, wait)
            except Exception as e:
                print("ÉCHEC", name, e, flush=True)
                log.write(f"ÉCHEC {name} : {e}\n")

        # ---------------- PC : souris
        ctx = b.new_context(viewport={"width": 1600, "height": 900})
        page = ctx.new_page()
        page.on("console", lambda m: log.write(f"[{m.type}] {m.text}\n") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: log.write(f"[pageerror] {e}\n"))
        page.goto(url)
        page.wait_for_selector("#view .row", timeout=60000)
        time.sleep(4)
        shot(page, "pc_01_accueil")
        page.mouse.move(40, 300)
        shot(page, "pc_02_menu_ouvert", 0.8)
        page.mouse.move(900, 500)
        step(page, "pc_03_films", "go('movies')", 2.5)
        step(page, "pc_04_series", "go('series')", 2.5)
        step(page, "pc_05_direct", "S.liveTab='une'; go('live')", 2.5)
        step(page, "pc_06_fiche_film", "openDetail('movie', S.cat.movies.find(m => m.v.length > 1) || S.cat.movies[0])", 3)
        step(page, "pc_07_versions", "(document.querySelector('[data-a=\"versions\"]') || {click(){}}).click()", 1.5)
        step(page, "pc_08_source_chaine", "closeModal(); playLive(S.cat.live.find(c => c.s.length > 2) || S.cat.live[0], 0)", 1.5)
        step(page, "pc_09_reglages", "closeModal(); go('settings')", 2.5)
        step(page, "pc_10_fiche_serie", "openDetail('series', S.cat.series[0])", 3)
        ctx.close()

        # ---------------- mode télécommande (flèches), comme sur la télé et Android
        ctx = b.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1.5)
        page = ctx.new_page()
        page.on("pageerror", lambda e: log.write(f"[tv pageerror] {e}\n"))
        page.add_init_script("document.addEventListener('DOMContentLoaded', () => document.body.classList.add('tv'))")
        page.goto(url)
        page.wait_for_selector("#view .row", timeout=60000)
        time.sleep(4)
        step(page, "tv_01_accueil", None, 1.0, ["ArrowDown", "ArrowDown", "ArrowDown"])
        step(page, "tv_02_rangee_suivante", None, 1.0, ["ArrowDown", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"])
        step(page, "tv_03_menu", None, 1.0, ["ArrowLeft"] * 8 + ["ArrowDown"])
        step(page, "tv_04_films", "document.activeElement.blur(); go('movies')", 2.5, ["ArrowDown", "ArrowDown", "ArrowDown"])
        step(page, "tv_05_fiche", "document.activeElement.blur(); openDetail('movie', S.cat.movies.find(m => m.v.length > 1) || S.cat.movies[0])", 2.5, ["ArrowDown"] * 4)
        step(page, "tv_06_direct", "document.activeElement.blur(); S.liveTab='une'; go('live')", 2.5, ["ArrowDown", "ArrowDown", "ArrowDown"])
        step(page, "tv_07_source", "playLive(S.cat.live.find(c => c.s.length > 2) || S.cat.live[0], 0)", 1.5, ["ArrowDown"])
        ctx.close()
        b.close()
    log.close()
    srv.shutdown()
    mock.terminate()


if __name__ == "__main__":
    main()
