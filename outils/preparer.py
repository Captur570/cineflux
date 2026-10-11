# -*- coding: utf-8 -*-
"""
Prépare les valeurs intégrées au package (appelé par build.ps1).

- distribution.json  -> build/defaults_build.json
- "tmdb_key": "auto" -> la clé est lue dans les réglages de ShippoTV sur ce PC
  (%APPDATA%\\Cineflux\\config.json), pour ne jamais avoir à la recopier.
"""
import base64
import json
import re
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    with open(os.path.join(ROOT, "distribution.json"), encoding="utf-8") as f:
        dist = json.load(f)
    key = (dist.get("tmdb_key") or "").strip()
    source = "distribution.json"
    if key.lower() == "auto":
        key, source = "", "réglages de ShippoTV sur ce PC"
        cfg = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~/.config"), "Cineflux", "config.json")
        try:
            with open(cfg, encoding="utf-8") as f:
                key = (json.load(f).get("tmdb_key") or "").strip()
        except (OSError, ValueError):
            pass
    out = {
        "supabase_url": re.sub(r"(/rest/v1)?/*$", "", (dist.get("supabase_url") or "").strip()),
        "supabase_key": (dist.get("supabase_key") or "").strip(),
        "update_repo": (dist.get("update_repo") or "").strip().strip("/"),
        "tmdb_key_obf": base64.b64encode(bytes(b ^ 0x5A for b in key.encode())).decode() if key else "",
    }
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    with open(os.path.join(ROOT, "build", "defaults_build.json"), "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"  Clé TMDB intégrée : {'oui (' + source + ')' if key else 'NON - chaque utilisateur devra saisir la sienne'}")
    print(f"  Synchronisation   : {'oui' if out['supabase_url'] and out['supabase_key'] else 'non configurée'}")
    print(f"  Mises à jour auto : {'github.com/' + out['update_repo'] if out['update_repo'] else 'non configurées'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
