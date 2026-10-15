"""Correctifs appliqués à PlumeImpactor avant compilation (lancé par atv-tools.yml).

1. Le serveur anisette devient configurable via la variable PLUME_ANISETTE_URL
   (ATVLoad choisit un serveur qui répond si celui par défaut est en panne).
2. Les erreurs du serveur anisette sont renvoyées proprement au lieu de faire planter
   plumesign (« explicit panic »), pour qu'ATVLoad puisse réessayer ailleurs.
3. Octobre 2026 : Apple rejette (HTTP 503) l'ancienne identité « Android » et les
   identifiants client réécrits. Comme isideload/iloader (commits du 13-14/10/2026) :
   - on utilise tel quel l'identifiant client fourni par le serveur anisette
     (ex. « <PC> <Windows;…> <com.apple.AuthKit/1 (com.apple.iTunes/…)> ») ;
   - on ne le met plus en minuscules ni ne le réécrit en « akd » ;
   - User-Agent aligné sur celui du serveur (akd/1.0 CFNetwork/808.1.4) ;
   - serveur par défaut : ani.jkcoxson.com (émule Windows) ;
   - une identité de machine distincte par serveur (state-<serveur>.plist), pour ne
     jamais réutiliser une ancienne identité Android.
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


# ---- 3. Identité Windows/iTunes fournie par le serveur, sans réécriture

import re
_lib = src / "lib.rs"
_t = _lib.read_text(encoding="utf-8")
_t2 = re.sub(r'pub const DEFAULT_ANISETTE_URL_V3: &str = "[^"]*";',
             'pub const DEFAULT_ANISETTE_URL_V3: &str = "https://ani.jkcoxson.com";', _t)
if _t2 == _t and "ani.jkcoxson.com" not in _t:
    sys.exit("DEFAULT_ANISETTE_URL_V3 introuvable")
_lib.write_text(_t2, encoding="utf-8")
print("corrigé : lib.rs (serveur par défaut)")

patch(src / "remote_anisette_v3.rs",
      "client_info.client_info = CLIENT_INFO_HEADER.to_string();",
      "if client_info.client_info.trim().is_empty() { client_info.client_info = CLIENT_INFO_HEADER.to_string(); }")

patch(src / "remote_anisette_v3.rs",
      'let config_path = self.configuration_path.join("state.plist");',
      'let config_path = self.configuration_path.join(format!("state-{}.plist", '
      'self.client_url.trim_start_matches("https://").trim_start_matches("http://")'
      '.replace(|c: char| !c.is_ascii_alphanumeric(), "_")));')

core = root / "crates" / "plume_core" / "src" / "auth"

patch(core / "anisette_data.rs",
      """                    let temp = v.as_str();

                    temp.replace(""",
      """                    let temp = v.as_str();
                    if !temp.contains("Xcode") {
                        temp.to_string()
                    } else {
                    temp.replace(""")
patch(core / "anisette_data.rs",
      """                        "com.apple.AuthKit/1 (com.apple.akd/1.0)",
                    )
                }""",
      """                        "com.apple.AuthKit/1 (com.apple.akd/1.0)",
                    )
                    }
                }""")
patch(core / "anisette_data.rs",
      ".map(|(k, v)| (k.to_lowercase(), v.to_lowercase()))",
      ".map(|(k, v)| (k.to_lowercase(), v.to_string()))")

for f in (core / "account" / "login.rs", core / "account" / "token.rs"):
    t = f.read_text(encoding="utf-8")
    if "CFNetwork/978.0.7 Darwin/18.7.0" in t:
        f.write_text(t.replace("akd/1.0 CFNetwork/978.0.7 Darwin/18.7.0", "akd/1.0 CFNetwork/808.1.4"),
                     encoding="utf-8")
        print(f"corrigé : {f.name} (User-Agent)")
