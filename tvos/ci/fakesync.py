# -*- coding: utf-8 -*-
"""Faux serveur de synchronisation (mêmes fonctions que Supabase, cf. outils/supabase.sql), en mémoire,
pour les essais GitHub de l'association : port 8798, n'importe quelle clé acceptée."""
import json
import threading
import time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOCK = threading.Lock()
ITEMS = {}   # (gid, k) -> dict(k, v, del, ts, srv)
PAIR = {}    # h -> (payload, exp)
LAST = [0.0]


def srv_now():
    t = max(time.time(), LAST[0] + 1e-6)
    LAST[0] = t
    return t


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def parse(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        fn = self.path.rsplit("/", 1)[-1]
        b = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        with LOCK:
            if fn == "cf_push":
                n = 0
                for x in b.get("p_items") or []:
                    key = (b["p_gid"], x["k"])
                    old = ITEMS.get(key)
                    if old and old["ts"] > int(x["t"]):
                        continue
                    ITEMS[key] = {"k": x["k"], "v": x["v"], "del": bool(x.get("d")), "ts": int(x["t"]), "srv": srv_now()}
                    n += 1
                return self.send(200, n)
            if fn == "cf_pull":
                since, after = parse(b.get("p_since")), b.get("p_after_k") or ""
                rows = sorted((r for (g, _), r in ITEMS.items() if g == b.get("p_gid")), key=lambda r: (r["srv"], r["k"]))
                if since is not None:
                    rows = [r for r in rows if (r["srv"], r["k"]) > (since + 5e-7, after) or (abs(r["srv"] - since) < 5e-7 and r["k"] > after)]
                return self.send(200, [dict(r, srv=iso(r["srv"])) for r in rows[:1000]])
            if fn == "cf_pair_create":
                PAIR[b["p_h"]] = (b["p_payload"], time.time() + 600)
                return self.send(200, True)
            if fn == "cf_pair_claim":
                p = PAIR.pop(b["p_h"], None)
                return self.send(200, p[0] if p and p[1] > time.time() else None)
        self.send(404, {"message": "fonction inconnue"})

    def send(self, code, obj):
        d = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(d)))
        self.end_headers()
        self.wfile.write(d)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8798), H).serve_forever()
