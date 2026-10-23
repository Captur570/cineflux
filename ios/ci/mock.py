import os
HERE = os.path.dirname(os.path.abspath(__file__))
"""Faux serveur Xtream + faux TMDB pour tester Cinéflux hors ligne."""
import json, re, base64, time, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

FILMS = [
    ("Les évadés 4K DV 1994", "Les Évadés", 1994, "Drame", 278),
    ("FR - Les Évadés (1994)", None, None, None, None),
    ("|FR| Les évadés 1080p MULTI", None, None, None, None),
    ("4K - Oppenheimer (2023) DV HDR VFF", "Oppenheimer", 2023, "Histoire", 872585),
    ("Oppenheimer (2023) 1080p", None, None, None, None),
    ("[VOSTFR] Dune: Part Two 2024 HDR10 x265", "Dune : Deuxième partie", 2024, "Science-Fiction", 693134),
    ("Dune Deuxième Partie 2024 4K", None, None, None, None),
    ("Inception (2010) FHD", "Inception", 2010, "Action", 27205),
    ("Interstellar 4K HDR 2014", "Interstellar", 2014, "Science-Fiction", 157336),
    ("The.Matrix.1999.1080p.BluRay.x264", "Matrix", 1999, "Action", 603),
    ("Le Comte de Monte-Cristo FHD 2024", "Le Comte de Monte-Cristo", 2024, "Aventure", 1084736),
    ("Intouchables (2011)", "Intouchables", 2011, "Comédie", 77338),
    ("Parasite 2019 VOSTFR", "Parasite", 2019, "Thriller", 496243),
    ("Gladiator II (2024) 4K", "Gladiator II", 2024, "Action", 558449),
    ("Blade Runner 2049 (2017) VF", "Blade Runner 2049", 2017, "Science-Fiction", 335984),
    ("Le Fabuleux Destin d'Amélie Poulain 2001", "Le Fabuleux Destin d'Amélie Poulain", 2001, "Comédie", 194),
    ("Spider-Man: Across the Spider-Verse (2023)", "Spider-Man : Across the Spider-Verse", 2023, "Animation", 569094),
    ("La La Land 2016 FHD", "La La Land", 2016, "Romance", 313369),
    ("Mad Max: Fury Road 4K 2015", "Mad Max : Fury Road", 2015, "Action", 76341),
    ("Anatomie d'une chute (2023)", "Anatomie d'une chute", 2023, "Drame", 915935),
    ("Film inconnu du fournisseur XYZ 2021", None, None, None, -1),
]
SERIES = [
    ("Breaking Bad (2008)", "Breaking Bad", 2008, 1396),
    ("FR - Breaking Bad FHD", None, None, None),
    ("Lupin 2021 VF", "Lupin", 2021, 96677),
    ("The Last of Us (2023) 4K", "The Last of Us", 2023, 100088),
    ("Le Bureau des légendes", "Le Bureau des Légendes", 2015, 62852),
    ("Arcane (2021)", "Arcane", 2021, 94605),
    ("Dark 2017 VOSTFR", "Dark", 2017, 70523),
]
LIVE = ["FR: TF1 FHD", "TF1 ᴴᴰ", "|FR| TF1 4K", "FR| TF1 HD (backup)", "FR: France 2 FHD", "France 2 HD", "FR: France 3 HD",
        "FR: Canal+ FHD", "Canal+ ᵁᴴᴰ", "FR: M6 HD", "M6 +1", "FR: Arte HD", "FR: BFM TV", "BFM TV HD", "FR: TMC HD",
        "FR: W9 FHD", "FR: Eurosport 1 FHD", "Eurosport 1 4K", "FR: beIN Sports 1 FHD", "FR: RMC Sport 1 HD", "FR: France 5",
        "FR: LCI HD", "FR: franceinfo", "FR: C8 HD", "FR: 6ter", "FR: Gulli", "FR: Paris Première HD", "FR: Ciné+ Premier FHD"]
LIVE_CATS = {"1": "FR | Généralistes", "2": "FR | Sport", "3": "FR | Info", "4": "FR | 4K", "5": "FR | Cinéma"}

def live_cat(n):
    if "4K" in n or "ᵁᴴᴰ" in n: return "4"
    if any(x in n for x in ("Sport", "beIN", "RMC")): return "2"
    if any(x in n for x in ("BFM", "LCI", "info")): return "3"
    if "Ciné" in n: return "5"
    return "1"

FILMS.insert(4, ("The Odyssey 2026 HDCAM", "L'Odyssée", 2026, "Aventure", 1033462))
FILMS.append(("Le Seigneur des anneaux : La Communauté de l'anneau Version longue 2001", "Le Seigneur des anneaux : La Communauté de l'anneau", 2001, "Aventure", 120))
RUNTIME = lambda tid: 100 + tid % 70
TMDB = {}
for raw, t, y, g, tid in FILMS:
    if t: TMDB[("movie", tid)] = {"id": tid, "title": t, "original_title": t, "release_date": f"{y}-06-01", "poster_path": f"/p{tid}.jpg",
                                  "backdrop_path": f"/b{tid}.jpg", "overview": f"Résumé de démonstration pour « {t} ». Une histoire captivante qui tient en haleine du début à la fin, portée par une mise en scène remarquable.",
                                  "vote_average": 7.5 + (tid % 15) / 10, "genre_ids": [18], "popularity": 50, "runtime": 178 if tid == 120 else RUNTIME(tid), "vote_count": 5000}
TMDB[("movie", 1033462)]["original_title"] = "The Odyssey"
for raw, t, y, tid in SERIES:
    if t: TMDB[("tv", tid)] = {"id": tid, "name": t, "original_name": t, "first_air_date": f"{y}-01-01", "poster_path": f"/p{tid}.jpg",
                               "backdrop_path": f"/b{tid}.jpg", "overview": f"Résumé de démonstration pour la série « {t} ».", "vote_average": 8.4, "genre_ids": [18], "popularity": 60}

# MOCK_POSTERS=N : N films supplémentaires, chacun avec sa fiche TMDB et une vraie affiche servie par /img/
# (avec un délai de 50 à 600 ms, comme un vrai réseau), pour compter les affiches réellement affichées.
POSTERS = int(os.environ.get("MOCK_POSTERS") or 0)
for i in range(POSTERS):
    tid = 500000 + i
    TMDB[("movie", tid)] = {"id": tid, "title": f"Film Démo {i:04d}", "original_title": f"Film Démo {i:04d}", "release_date": f"{1990 + i % 35}-03-01",
                            "poster_path": f"/p{tid}.jpg", "backdrop_path": f"/b{tid}.jpg", "overview": "Résumé de démonstration.",
                            "vote_average": 6.5, "genre_ids": [18], "popularity": 20, "runtime": 110, "vote_count": 100}
import unicodedata as _ud
EXACT = {re.sub(r"[^a-z0-9]", "", "".join(c for c in _ud.normalize("NFKD", d["title"].lower()) if not _ud.combining(c))): d
         for (k, _), d in TMDB.items() if k == "movie" and d["id"] >= 500000}
_PNG = {}
def poster_png(name):
    import zlib, struct, hashlib
    if name in _PNG: return _PNG[name]
    w, h = 120, 180
    c = hashlib.md5(name.encode()).digest()[:3]
    raw = b"".join(b"\x00" + bytes(c) * w for _ in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    png = b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")
    _PNG[name] = png
    return png

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def j(self, o):
        b = json.dumps(o).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", len(b)); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if u.path.startswith("/3/"):
            return self.tmdb(u.path[2:], q)
        if u.path.startswith("/img/"):
            import random
            time.sleep(random.uniform(0.05, 0.6))
            d = poster_png(u.path.rsplit("/", 1)[-1])
            self.send_response(200); self.send_header("Content-Type", "image/png"); self.send_header("Content-Length", str(len(d))); self.end_headers()
            try: self.wfile.write(d)
            except Exception: pass
            return
        if u.path.endswith("/searchteams.php"):
            t = q.get("t", "")
            return self.j({"teams": [{"strTeam": t, "strBadge": "http://127.0.0.1:8799/badge/" + urllib.parse.quote(t) + ".png"}]} if t in ("PSG", "Bayern Munich") else {"teams": None})
        if u.path.startswith("/badge/"):
            return self.file(os.path.join(HERE, "media", "badge.png"), "image/png")
        M = os.path.join(HERE, "media") + "/"
        if u.path == "/scope.mkv":
            return self.file(M + "scope.mkv", "video/x-matroska")
        if u.path.startswith("/live/"):
            self.send_response(302); self.send_header("Location", "http://127.0.0.1:8799/hls/index.m3u8?tok=abc"); self.send_header("Content-Length", "0"); self.end_headers(); return
        if u.path.startswith("/hls/"):
            return self.file(M + "hls/" + u.path[5:], "application/vnd.apple.mpegurl" if u.path.endswith("m3u8") else "video/mp2t")
        if u.path.startswith("/timeshift/"):
            pass
            return self.file(M + "movie.mp4", "video/mp4")
        if u.path.startswith(("/movie/", "/series/")):
            return self.file(M + "movie.mp4", "video/mp4")
        if q.get("username") != "demo" or q.get("password") != "demo":
            return self.j({"user_info": {"auth": 0}})
        a = q.get("action")
        now = int(time.time())
        if not a:
            return self.j({"user_info": {"auth": 1, "status": "Active", "exp_date": str(now + 86400 * 200), "max_connections": "2", "allowed_output_formats": ["ts", "m3u8"]}, "server_info": {"timezone": "Europe/Paris"}})
        if a == "get_vod_categories" and POSTERS: return self.j([{"category_id": str(10 + c), "category_name": f"Films | Catégorie {c + 1}"} for c in range(12)])
        if a == "get_vod_categories": return self.j([{"category_id": "10", "category_name": "Films | Nouveautés"}, {"category_id": "11", "category_name": "Films | 4K UHD"}, {"category_id": "12", "category_name": "Films | Classiques"}])
        if a == "get_vod_streams" and os.environ.get("MOCK_BIG"):
            import random; rnd = random.Random(1); out = []
            words = ["Le","La","Nuit","Soleil","Retour","Mission","Amour","Guerre","Ombre","Ville","Secret","Dernier","Héros","Voyage","Empire","Rêve"]
            for i in range(40000):
                t = " ".join(rnd.choice(words) for _ in range(rnd.randint(2,4)))
                q = rnd.choice(["4K HDR", "1080p", "FHD MULTI", "720p", "DV 4K", ""])
                out.append({"stream_id": 50000+i, "name": f"|FR| {t} ({rnd.randint(1960,2025)}) {q}", "stream_icon": "", "added": str(now-i*60), "category_id": str(10+i%3), "container_extension": "mkv", "rating": "6.5"})
            return self.j(out)
        if a == "get_vod_streams" and POSTERS:
            out = [{"stream_id": 60000 + i, "name": f"|FR| Film Démo {i:04d} ({1990 + i % 35}) 1080p", "stream_icon": "", "added": str(now - i * 60),
                    "category_id": str(10 + i % 12), "container_extension": "mkv", "rating": "6.5"} for i in range(POSTERS)]
            return self.j(out)
        if a == "get_vod_streams":
            out = []
            for i, (raw, t, y, g, tid) in enumerate(FILMS):
                out.append({"stream_id": 1000 + i, "name": raw, "stream_icon": "", "added": str(now - i * 3600), "category_id": "11" if "4K" in raw else ("12" if (y or 2020) < 2005 else "10"), "container_extension": "mkv", "rating": "7.1"})
            return self.j(out)
        if a == "get_series_categories": return self.j([{"category_id": "20", "category_name": "Séries | Populaires"}, {"category_id": "21", "category_name": "Séries | Françaises"}])
        if a == "get_series" and os.environ.get("MOCK_BIG"):
            import random; rnd = random.Random(2)
            return self.j([{"series_id": 90000+i, "name": f"|FR| Série {rnd.randint(1,99999)} S{rnd.randint(1,9)}", "cover": "", "plot": "", "category_id": "20", "last_modified": str(now-i*60), "rating": "7"} for i in range(9000)])
        if a == "get_series":
            return self.j([{"series_id": 2000 + i, "name": raw, "cover": "", "plot": "", "category_id": "21" if raw.startswith(("Lupin", "Le Bureau")) else "20", "last_modified": str(now - i * 7200), "rating": "8"} for i, (raw, *_r) in enumerate(SERIES)])
        if a == "get_series_info":
            eps = {str(s): [{"id": f"{q['series_id']}{s}{e}", "episode_num": e, "title": f"Show - S0{s}E0{e} - Titre de l'épisode {e}", "container_extension": "mkv", "info": {"plot": "Un épisode décisif où tout bascule.", "duration": "00:47:00"}} for e in range(1, 7)] for s in (1, 2)}
            return self.j({"info": {"name": "Show", "plot": "", "cast": "Acteur Un, Actrice Deux", "director": "Créatrice"}, "seasons": [], "episodes": eps})
        if a == "get_live_categories": return self.j([{"category_id": k, "category_name": v} for k, v in LIVE_CATS.items()])
        if a == "get_live_streams" and os.environ.get("MOCK_BIG"):
            base = [{"num": i + 1, "stream_id": 3000 + i, "name": n, "stream_icon": "", "category_id": live_cat(n), "epg_channel_id": "", "tv_archive": 1 if i < 6 else 0, "tv_archive_duration": "7" if i < 6 else "0"} for i, n in enumerate(LIVE)]
            extra = [{"num": 1000+i, "stream_id": 70000+i, "name": f"|{['FR','PT','ES','UK','DE','IT'][i%6]}| Chaîne {i} {['HD','FHD','4K','SD'][i%4]}", "stream_icon": "", "category_id": "30", "epg_channel_id": ""} for i in range(12000)]
            return self.j(base + extra)
        if a == "get_live_streams":
            return self.j([{"num": i + 1, "stream_id": 3000 + i, "name": n, "stream_icon": "http://127.0.0.1:8799/badge/logo.png" if ("M6" in n or "W9" in n) else "", "category_id": live_cat(n), "epg_channel_id": "", "tv_archive": 1 if i < 6 else 0, "tv_archive_duration": "7" if i < 6 else "0"} for i, n in enumerate(LIVE)])
        if a == "get_vod_info":
            i = int(q.get("vod_id")) - 1000
            raw, t, y, g, tid = FILMS[i] if 0 <= i < len(FILMS) else ("", None, None, None, None)
            k = i
            while tid is None and k > 0:
                k -= 1; tid = FILMS[k][4]
            mins = (208 if tid == 120 else RUNTIME(tid or 1)) if tid and tid > 0 else 95
            if "Oppenheimer (2023) 1080p" in raw: mins = 92
            return self.j({"info": {"plot": "Résumé fournisseur.", "director": "Réalisateur Exemple", "cast": "Acteur A, Actrice B, Acteur C",
                                    "duration_secs": mins * 60, "duration": "%02d:%02d:00" % (mins // 60, mins % 60), "video": {"height": 1080}, "bitrate": 6000}})
        if a == "get_simple_data_table":
            b = lambda s: base64.b64encode(s.encode()).decode()
            sid = int(q.get("stream_id", 0)); out = []
            base = now - now % 3600 - 3 * 86400
            names = ["Journal de 13h", "Téléfilm : L'héritage", "Jeu : Questions pour un champion", "Journal de 20h", "Film : Les Évadés", "Magazine sport"]
            t = base
            while t < now + 6 * 3600:
                n = names[(t // 3600) % len(names)]
                out.append({"title": b(n), "description": b("Programme de démonstration."), "start_timestamp": str(t), "stop_timestamp": str(t + 3600), "has_archive": 1 if t + 3600 < now else 0, "now_playing": 1 if t <= now < t + 3600 else 0})
                t += 3600
            return self.j({"epg_listings": out})
        if a == "get_short_epg":
            b = lambda s: base64.b64encode(s.encode()).decode()
            sid = int(q.get("stream_id", 0))
            lt = time.localtime(now)
            day = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
            soir = {0: ("Koh-Lanta : la tribu maudite", "Divertissement. Les aventuriers s'affrontent."),
                    4: ("Inception", "Film de science-fiction réalisé par Christopher Nolan (2010). Avec Leonardo DiCaprio."),
                    6: ("Le Bureau des légendes", "Série. Saison 2, épisode 4."),
                    7: ("Ligue des champions : PSG - Bayern Munich", "Football. Match en direct depuis le Parc des Princes."),
                    16: ("Fléchettes : championnat d'Europe", "Darts, en direct."),
                    18: ("Top 14 : Toulouse - La Rochelle", "Rugby, en direct."),
                    11: ("Interstellar", "Film de science-fiction (2014)."),
                    12: ("Débat présidentiel", "Débat politique.")}
            cur = [("Ligue des champions : PSG - Bayern Munich", "Match en direct depuis le Parc des Princes."),
                   ("Inception", "Film de science-fiction réalisé par Christopher Nolan. Avec Leonardo DiCaprio."),
                   ("Journal de 20h", "L'actualité du jour."), ("Top 14 : Toulouse - La Rochelle", "Rugby, en direct."),
                   ("Koh-Lanta", "Divertissement."), ("Le Bureau des légendes", "Série. Saison 2, épisode 4.")][sid % 6]
            progs = [(now - 1800, now + 2400, cur)]
            t = now + 2400
            while t < day + 20 * 3600 + 3000:
                progs.append((t, t + 3600, (f"Magazine {sid % 7}", "Magazine.")))
                t += 3600
            e = soir.get(sid - 3000, (f"Téléfilm inédit {sid % 5}", "Téléfilm."))
            progs.append((day + 21 * 3600 + 600, day + 23 * 3600, e))
            progs.append((day + 23 * 3600, day + 24 * 3600 + 1800, ("Programme de nuit", "")))
            return self.j({"epg_listings": [{"title": b(p[2][0]), "description": b(p[2][1]), "start_timestamp": int(p[0]), "stop_timestamp": int(p[1])} for p in progs[: int(q.get("limit", 4))]]})
        self.j([])
    def file(self, path, ctype):
        import os
        data = open(path, "rb").read()
        rng = self.headers.get("Range")
        if rng:
            a, b = rng.replace("bytes=", "").split("-")
            a = int(a); b = int(b) if b else len(data) - 1
            chunk = data[a:b + 1]
            self.send_response(206); self.send_header("Content-Range", f"bytes {a}-{b}/{len(data)}")
        else:
            chunk = data; self.send_response(200)
        self.send_header("Content-Type", ctype); self.send_header("Accept-Ranges", "bytes"); self.send_header("Content-Length", str(len(chunk))); self.end_headers()
        try: self.wfile.write(chunk)
        except Exception: pass

    def tmdb(self, path, q):
        if POSTERS:
            import random
            time.sleep(random.uniform(0.08, 0.25))   # délai d'un vrai TMDB
        m = re.match(r"/(movie|tv)/(\d+)$", path)
        if m:
            d = TMDB.get((m.group(1), int(m.group(2))))
            if not d: return self.j({})
            d = dict(d)
            rd = d.get("release_date") or d.get("first_air_date")
            d["release_dates"] = {"results": [{"iso_3166_1": "US", "release_dates": [{"type": 3, "release_date": rd + "T00:00:00.000Z"}] + ([] if d["id"] == 1033462 else [{"type": 4, "release_date": rd[:4] + "-12-01T00:00:00.000Z"}])}]}
            d["videos"] = {"results": [{"site": "YouTube", "key": "dQw4w9WgXcQ", "type": "Trailer", "iso_639_1": "fr", "official": True}]}
            d["credits"] = {"cast": [{"name": "Acteur Un"}, {"name": "Actrice Deux"}], "crew": [{"job": "Director", "name": "Réalisatrice"}]}
            return self.j(d)
        m = re.match(r"/(movie|tv)/(\d+)/(recommendations|similar)$", path)
        if m:
            vals = [d for (k, _), d in TMDB.items() if k == m.group(1) and d["id"] != int(m.group(2))]
            return self.j({"results": vals[:8]})
        m = re.match(r"/search/(movie|tv)$", path)
        if m:
            import unicodedata
            n = lambda s: re.sub(r"[^a-z0-9]", "", "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c)))
            qq = n(q.get("query", ""))
            if POSTERS and m.group(1) == "movie" and qq in EXACT:
                return self.j({"results": [EXACT[qq]]})
            res = [d for (k, _), d in TMDB.items() if k == m.group(1) and (qq in n(d.get("title") or d.get("name")) or n(d.get("title") or d.get("name")) in qq or qq[:5] == n(d.get("title") or d.get("name"))[:5])]
            res.sort(key=lambda d: n(d.get("title") or d.get("name")) != qq)   # titre exact d'abord
            return self.j({"results": res[:20]})
        if path == "/search/person":
            if "capr" in q.get("query", "").lower() or "nolan" in q.get("query", "").lower():
                nolan = "nolan" in q.get("query", "").lower()
                return self.j({"results": [{"id": 525 if nolan else 6193, "name": "Christopher Nolan" if nolan else "Leonardo DiCaprio", "known_for_department": "Directing" if nolan else "Acting", "popularity": 40, "gender": 2, "profile_path": "/pp.jpg"}]})
            return self.j({"results": []})
        m = re.match(r"/person/(\d+)/combined_credits$", path)
        if m:
            ids = [27205, 157336, 872585] if m.group(1) == "525" else [27205]
            cast = [dict(TMDB[("movie", i)], media_type="movie", character="Cobb") for i in ids if ("movie", i) in TMDB]
            return self.j({"cast": cast if m.group(1) != "525" else [], "crew": [dict(c, job="Director") for c in cast] if m.group(1) == "525" else []})
        if "genre" in path: return self.j({"genres": [{"id": 18, "name": "Drame"}]})
        m = re.match(r"/(trending/(movie|tv)/week|discover/(movie|tv)|(movie|tv)/(popular|top_rated))$", path)
        if m:
            kind = m.group(2) or m.group(3) or m.group(4)
            page = int(q.get("page", 1))
            vals = [d for (k, _), d in TMDB.items() if k == kind][-60:]
            import random
            rnd = random.Random(path + str(sorted(q.items())))
            rnd.shuffle(vals)
            # ajoute des titres absents du catalogue pour vérifier le filtrage
            fake = [{"id": 900000 + i, "title": f"Film absent {i}", "name": f"Série absente {i}", "poster_path": f"/p{900000 + i}.jpg", "backdrop_path": f"/b{900000 + i}.jpg", "release_date": time.strftime("%Y-%m-%d", time.localtime(time.time() - (20 + 200 * i) * 86400)), "first_air_date": "2025-01-01", "vote_average": 7.1, "genre_ids": [18]} for i in range(4)]
            return self.j({"results": (vals + fake) if page == 1 else [], "total_pages": 1})
        self.j({})

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8799), H).serve_forever()
