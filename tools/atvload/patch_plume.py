"""Correctifs appliqués à PlumeImpactor avant compilation (lancé par atv-tools.yml).

1. Le serveur anisette devient configurable via la variable PLUME_ANISETTE_URL
   (ATVLoad choisit un serveur qui répond si celui par défaut est en panne).
2. Les erreurs du serveur anisette sont renvoyées proprement au lieu de faire planter
   plumesign (« explicit panic »), pour qu'ATVLoad puisse réessayer ailleurs.
"""
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
src = root / "3rdparty" / "omnisette" / "src"


def patch(path, old, new):
    text = path.read_text(encoding="utf-8")
    if new in text:
        print(f"déjà appliqué : {path.name}")
        return
    if old not in text:
        sys.exit(f"Motif introuvable dans {path} :\n{old}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"corrigé : {path.name}")


patch(src / "lib.rs",
      "anisette_url_v3: DEFAULT_ANISETTE_URL_V3.to_string(),",
      "anisette_url_v3: std::env::var(\"PLUME_ANISETTE_URL\").ok()"
      ".filter(|s| !s.trim().is_empty()).map(|s| s.trim().trim_end_matches('/').to_string())"
      ".unwrap_or_else(|| DEFAULT_ANISETTE_URL_V3.to_string()),")

patch(src / "remote_anisette_v3.rs",
      'panic!("Unknown error {}", message)',
      'Err(AnisetteError::Anyhow(anyhow::anyhow!("Anisette server error: {}", message)))')

patch(src / "remote_anisette_v3.rs",
      """                } else {
                    panic!()
                }""",
      """                } else {
                    return Err(err);
                }""")
