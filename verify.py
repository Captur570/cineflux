# -*- coding: utf-8 -*-
"""
Vérification des versions de films : est-ce bien le bon film, dans une version complète ?

Indices bloquants : durée incompatible avec toutes les versions connues du film,
année incompatible, identifiant TMDB du fournisseur différent, mention de copie
cinéma (CAM, TS…) dans le nom.
Indices d'alerte seulement : sortie numérique pas encore passée (tous pays), qui
déclenche un contrôle de la qualité réelle (définition, débit).
"""
import re
import time

# Versions connues (identifiant TMDB -> [(durée en minutes, libellé)]), en plus de la durée cinéma TMDB
EDITIONS = {
    120: [(178, "Version cinéma"), (208, "Version longue"), (228, "Version longue (avec génériques)")],
    121: [(179, "Version cinéma"), (223, "Version longue"), (235, "Version longue (avec génériques)")],
    122: [(201, "Version cinéma"), (251, "Version longue"), (263, "Version longue (avec génériques)")],
    49051: [(169, "Version cinéma"), (182, "Version longue")],
    57158: [(161, "Version cinéma"), (186, "Version longue")],
    122917: [(144, "Version cinéma"), (164, "Version longue")],
    1495: [(144, "Version cinéma"), (190, "Director's Cut"), (194, "Director's Cut")],
    209112: [(151, "Version cinéma"), (182, "Ultimate Edition")],
    13183: [(162, "Version cinéma"), (186, "Director's Cut"), (215, "Ultimate Cut")],
    28: [(147, "Version cinéma"), (196, "Redux"), (202, "Redux"), (183, "Final Cut")],
    679: [(137, "Version cinéma"), (154, "Version longue")],
    19995: [(162, "Version cinéma"), (171, "Édition spéciale"), (178, "Version longue")],
    280: [(137, "Version cinéma"), (153, "Édition spéciale"), (156, "Version longue")],
    2756: [(140, "Version cinéma"), (171, "Édition spéciale")],
    78: [(117, "Version cinéma"), (117, "Final Cut")],
    581: [(181, "Version cinéma"), (236, "Version longue")],
    387: [(149, "Version cinéma"), (208, "Director's Cut"), (293, "Version intégrale")],
    311: [(229, "Version cinéma"), (251, "Version longue")],
    279: [(160, "Version cinéma"), (180, "Director's Cut")],
}

EDITION_TAG = [
    (re.compile(r"director'?s?\s*cut|version\s+du\s+r[ée]alisateur", re.I), "Director's Cut"),
    (re.compile(r"ultimate|uncut|unrated|non\s+censur", re.I), "Version intégrale"),
    (re.compile(r"extended|version\s+longue|longue|[ée]dition\s+longue", re.I), "Version longue"),
    (re.compile(r"redux|final\s*cut", re.I), "Version remontée"),
    (re.compile(r"sp[ée]cial\s+edition|[ée]dition\s+sp[ée]ciale", re.I), "Édition spéciale"),
]
CAM_WORDS_RE = re.compile(r"(?<![a-z0-9])(cam|hd-?cam|camrip|telesync|hd-?ts|ts-?rip|telecine|hd-?tc|"
                          r"pdvd|pre-?dvd|dvd-?scr|screener)(?![a-z0-9])", re.I)
YEAR_RE = re.compile(r"(?<![0-9])((?:19|20)\d{2})(?![0-9])")
CLAIM_H = {"4K": 2000, "1080p": 1000, "720p": 690}


def parse_duration(v):
    """'02:22:00', '142 min', '8520', 8520 -> secondes"""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return int(v) if v > 0 else None
    s = str(v).strip()
    m = re.match(r"^(\d{1,2}):(\d{2}):(\d{2})$", s)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    m = re.match(r"^(\d{1,3}):(\d{2})$", s)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    m = re.match(r"^(\d+)\s*(min|mn|m)?$", s, re.I)
    if m:
        n = int(m.group(1))
        return n * 60 if (m.group(2) or n < 400) else n
    m = re.match(r"^(\d+)\s*h\s*(\d+)?", s, re.I)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2) or 0) * 60
    return None


def fmt_min(m):
    m = int(round(m))
    return f"{m // 60} h {m % 60:02d}" if m >= 60 else f"{m} min"


def edition_from_name(name):
    for rx, label in EDITION_TAG:
        if rx.search(name or ""):
            return label
    return None


def _within(d, e):
    """durée de fichier d compatible avec une version de e minutes (accélération PAL, génériques)"""
    return 0.93 * e - 3 <= d <= e + max(7, 0.07 * e)


def verify_version(name, claimed_q, tm, info, now=None):
    """
    name      : nom brut chez le fournisseur
    claimed_q : '4K' / '1080p' / '720p' / 'SD' / None
    tm        : {'id','y','rt','dig','rel'} (TMDB ; dig/rel = timestamps)
    info      : {'dur','h','kbps','tmdb','year'} (fournisseur ou sonde)
    -> {'st': 'ok'|'bad'|'unk', 'why': str, 'ed': str|None, 'dur': minutes|None, 'h': int|None, 'warn': str|None}
    """
    now = now or time.time()
    res = {"st": "unk", "why": "", "ed": None, "dur": None, "h": info.get("h"), "warn": None}
    if CAM_WORDS_RE.search(name or "") or re.search(r"(?<![a-z0-9])(TS|TC)(?![a-z0-9])", name or ""):
        res.update(st="bad", why="Copie filmée au cinéma (CAM / TS) d'après son nom")
        return res
    # identifiant TMDB annoncé par le fournisseur
    if info.get("tmdb") and tm.get("id") and int(info["tmdb"]) != int(tm["id"]):
        res.update(st="bad", why="Le fournisseur rattache ce fichier à un autre film")
        return res
    # année dans le nom
    ty = tm.get("y")
    years = [int(y) for y in YEAR_RE.findall(name or "") if 1900 <= int(y) <= time.localtime().tm_year + 1]
    if ty and years and all(abs(y - ty) > 1 for y in years):
        res.update(st="bad", why=f"Fichier daté de {years[-1]}, le film est de {ty}")
        return res
    # durée
    dur_s = info.get("dur")
    rt = tm.get("rt")
    ed_tag = edition_from_name(name)
    if dur_s:
        d = dur_s / 60
        res["dur"] = round(d)
        if rt:
            cands = [(rt, "Version cinéma")] + EDITIONS.get(int(tm.get("id") or 0), [])
            match = next((lbl for e, lbl in cands if _within(d, e)), None)
            if not match and ed_tag and 0.93 * rt - 3 <= d <= 1.6 * rt:
                match = ed_tag
            if match:
                res["st"] = "ok"
                has_eds = int(tm.get("id") or 0) in EDITIONS or ed_tag
                res["ed"] = match if (has_eds or match != "Version cinéma") else None
            else:
                alts = sorted({e for e, _ in cands})
                ref = " ou ".join(fmt_min(e) for e in alts[:3])
                res.update(st="bad", why=f"Durée {fmt_min(d)} au lieu de {ref}")
                return res
        elif d < 40:
            res.update(st="bad", why=f"Durée de {fmt_min(d)} : fichier incomplet ou bande-annonce")
            return res
    # sortie récente : contrôle de la qualité réelle
    rel, dig = tm.get("rel"), tm.get("dig")
    recent = rel and now - rel < 150 * 86400 and (not dig or dig > now)
    if recent:
        h, kbps = info.get("h"), info.get("kbps")
        claim = CLAIM_H.get(claimed_q or "")
        low_res = h and claim and h < claim * 0.9
        low_rate = kbps and dur_s and kbps < (1300 if (h or 0) >= 1000 else 700)
        if low_res or low_rate:
            res.update(st="bad", why="Film encore au cinéma et qualité très faible : copie cinéma probable")
            return res
        res["warn"] = "Sortie récente : qualité non garantie"
    if res["st"] == "unk" and dur_s and not rt:
        res["st"] = "unk"
    return res
