# -*- coding: utf-8 -*-
"""
Guide TV de ShippoTV : chaînes de votre pays, programme du moment, grille horaire
et « Ce soir chez vous » (films, séries, sport populaire dans votre pays, grandes émissions).
"""
import locale
import os
import re
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor


def _norm(s):
    s = "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", "", s.replace("&", "and"))


# --------------------------------------------------------------------------- pays
COUNTRIES = {
    "FR": {"name": "France", "flag": "🇫🇷"}, "BE": {"name": "Belgique", "flag": "🇧🇪"},
    "CH": {"name": "Suisse", "flag": "🇨🇭"}, "CA": {"name": "Canada", "flag": "🇨🇦"},
    "PT": {"name": "Portugal", "flag": "🇵🇹"}, "BR": {"name": "Brésil", "flag": "🇧🇷"},
    "ES": {"name": "Espagne", "flag": "🇪🇸"}, "IT": {"name": "Italie", "flag": "🇮🇹"},
    "DE": {"name": "Allemagne", "flag": "🇩🇪"}, "UK": {"name": "Royaume-Uni", "flag": "🇬🇧"},
    "US": {"name": "États-Unis", "flag": "🇺🇸"}, "NL": {"name": "Pays-Bas", "flag": "🇳🇱"},
    "MA": {"name": "Maroc", "flag": "🇲🇦"}, "DZ": {"name": "Algérie", "flag": "🇩🇿"},
    "TN": {"name": "Tunisie", "flag": "🇹🇳"},
}

PREFIX_MAP = {
    "FR": "FR", "FRA": "FR", "FRANCE": "FR", "FRENCH": "FR", "BE": "BE", "BEL": "BE", "CH": "CH", "SUI": "CH",
    "SWISS": "CH", "CA": "CA", "CAN": "CA", "QC": "CA", "PT": "PT", "POR": "PT", "PRT": "PT", "BR": "BR",
    "BRA": "BR", "ES": "ES", "ESP": "ES", "SP": "ES", "IT": "IT", "ITA": "IT", "DE": "DE", "GER": "DE",
    "DEU": "DE", "UK": "UK", "GB": "UK", "ENG": "UK", "US": "US", "USA": "US", "NL": "NL", "NED": "NL",
    "MA": "MA", "DZ": "DZ", "ALG": "DZ", "TN": "TN",
}
COUNTRY_WORDS = [
    (re.compile(r"\bfran[cç]e|fran[cç]ais|french|\btnt\b", re.I), "FR"),
    (re.compile(r"belgi", re.I), "BE"), (re.compile(r"suisse|switzerland|schweiz", re.I), "CH"),
    (re.compile(r"qu[ée]bec|canada", re.I), "CA"), (re.compile(r"portugal|portugu[eê]s", re.I), "PT"),
    (re.compile(r"bra[sz]il|br[ée]sil", re.I), "BR"), (re.compile(r"espa[ñn]a|spain|espagne|spanish", re.I), "ES"),
    (re.compile(r"itali", re.I), "IT"), (re.compile(r"deutsch|german|allemagne", re.I), "DE"),
    (re.compile(r"united kingdom|\buk\b|england|british", re.I), "UK"), (re.compile(r"\busa\b|united states", re.I), "US"),
    (re.compile(r"nederland|netherlands|dutch", re.I), "NL"), (re.compile(r"maroc|morocco", re.I), "MA"),
    (re.compile(r"alg[ée]rie|algeria", re.I), "DZ"), (re.compile(r"tunisi", re.I), "TN"),
]
PREFIX_RE = re.compile(r"^\W*([A-Za-z]{2,7})\s*(?:[:|\-»>]|\s\|)")

# Grandes chaînes par pays, par ordre d'importance (clés normalisées)
MAJORS = {
    "FR": ["tf1", "france2", "france3", "canal", "france5", "m6", "arte", "c8", "w9", "tmc", "tfx", "nrj12", "lcp",
           "france4", "bfmtv", "cnews", "lci", "franceinfo", "cstar", "gulli", "tf1seriesfilms", "lequipe", "6ter",
           "rmcstory", "rmcdecouverte", "cherie25", "t18", "novo19", "canalsport", "canalfoot", "canalsport360",
           "beinsports1", "beinsports2", "beinsports3", "rmcsport1", "rmcsport2", "eurosport1", "eurosport2",
           "dazn1", "ligue1", "ligue1plus", "primevideoligue1", "lequipelive1", "canalcinemas", "cineplusfrisson",
           "cinepluspremier", "cineplusemotion", "cineplusclassic", "ocs", "ocsmax", "paramountchannel",
           "tcmcinema", "canalseries", "seriesclub", "warnertv", "13emerue", "syfy"],
    "BE": ["laune", "rtltvi", "tipik", "latrois", "clubrtl", "plugrtl", "ab3", "een", "vtm", "canvas", "play4",
           "vtm2", "vier", "vijf", "tf1", "france2", "m6", "eleven1", "elevenpro1", "playsports1"],
    "CH": ["rtsun", "rts1", "rtsdeux", "rts2", "srf1", "srfzwei", "rsila1", "tf1", "france2", "m6", "blue sport1"],
    "CA": ["tva", "iciradiocanadatele", "radiocanada", "noovo", "telequebec", "rds", "rds2", "tvasports", "lcn", "rdi",
           "cbc", "ctv", "global", "tsn", "sportsnet"],
    "PT": ["rtp1", "rtp2", "sic", "tvi", "cmtv", "rtp3", "sicnoticias", "cnnportugal", "sporttv1", "sporttv2",
           "sporttv3", "sporttv4", "sporttv5", "benficatv", "portocanal", "elevensports1", "dazn1", "tvicinema",
           "hollywood", "axn", "fox", "sicmulher", "tvireality"],
    "BR": ["globo", "tvglobo", "redeglobo", "sbt", "record", "recordtv", "band", "redetv", "tvcultura", "sportv",
           "sportv2", "sportv3", "premiere", "premiereclubes", "espn", "espn2", "espn4", "bandsports", "globonews",
           "multishow", "gnt", "telecineaction", "telecinepremium", "hbo", "megapix", "warner", "tnt", "space"],
    "ES": ["la1", "antena3", "telecinco", "lasexta", "cuatro", "la2", "movistarlaliga", "movistarplus",
           "movistarligadecampeones", "dazn1", "laligatv", "gol", "teledeporte", "neox", "fdf", "24h"],
    "IT": ["rai1", "canale5", "rai2", "italia1", "rai3", "rete4", "la7", "tv8", "nove", "skysportuno",
           "skysportcalcio", "skysport24", "dazn1", "raisport", "skycinemauno", "20mediaset", "iris", "cielo"],
    "DE": ["daserste", "ard", "zdf", "rtl", "sat1", "prosieben", "vox", "kabeleins", "kabel1", "rtlzwei", "sport1",
           "skysportbundesliga1", "skysportbundesliga", "skysporttopevent", "dazn1", "eurosport1", "ntv", "welt"],
    "UK": ["bbcone", "itv1", "itv", "bbctwo", "channel4", "channel5", "skyone", "skyshowcase",
           "skysportsmainevent", "skysportspremierleague", "skysportsfootball", "tntsports1", "tntsports2",
           "skysportsf1", "skysportscricket", "skycinemapremiere", "bbcnews", "skynews", "e4", "dave"],
    "US": ["abc", "cbs", "nbc", "fox", "espn", "espn2", "tnt", "tbs", "hbo", "foxnews", "cnn", "nflnetwork",
           "nbatv", "amc", "fx", "usa", "foxsports1", "fs1", "cw"],
    "NL": ["npo1", "npo2", "npo3", "rtl4", "rtl5", "sbs6", "rtl7", "veronica", "ziggosport", "espn1"],
    "MA": ["almaghribia", "2m", "arryadia", "medi1tv", "beinsports1", "beinsports2"],
    "DZ": ["entv", "canalalgerie", "echorouk", "ennahar", "beinsports1"],
    "TN": ["watania1", "elhiwar", "attessia", "nessma", "beinsports1"],
}
_MAJOR_RANK = {cc: {k: i for i, k in enumerate(v)} for cc, v in MAJORS.items()}

# Sport réellement populaire par pays (seul ce qui correspond est mis en avant)
SPORT_POP = {
    "FR": r"ligue ?1|ligue des champions|champions league|europa league|conference league|coupe de france|"
          r"troph[ée]e des champions|[ée]quipe de france|les bleus|bleues|psg|paris sg|paris saint|\bom\b|marseille|"
          r"\bol\b|lyon|lens|lille|monaco|nice|rennes|nantes|strasbourg|real madrid|barcelone|bar[cç]a|bayern|"
          r"liverpool|manchester|arsenal|chelsea|coupe du monde|\beuro\b|top ?14|six nations|tournoi des 6|"
          r"xv de france|champions cup|coupe du monde de rugby|toulouse|la rochelle|stade fran[cç]ais|racing 92|"
          r"roland|wimbledon|us open|open d'australie|masters|coupe davis|tour de france|paris-roubaix|giro|vuelta|"
          r"grand prix|formule ?1|\bf1\b|motogp|jeux olympiques|\bjo\b|handball.*france|basket.*france|elitesserien",
    "BE": r"jupiler|pro league|anderlecht|club brugge|bruges|standard|genk|gand|diables rouges|red devils|"
          r"ligue des champions|champions league|europa|coupe du monde|\beuro\b|tour de france|ronde van vlaanderen|"
          r"tour des flandres|paris-roubaix|li[eè]ge-bastogne|grand prix|formule ?1|\bf1\b|roland|wimbledon",
    "CH": r"super league|young boys|b[aâ]le|basel|servette|lugano|nati|suisse|ski|lauberhorn|hockey|national league|"
          r"ligue des champions|champions league|roland|wimbledon|grand prix|formule ?1",
    "CA": r"\bnhl\b|lnh|canadiens|maple leafs|hockey|\bnba\b|raptors|\bnfl\b|\bcfl\b|mls|cf montr[ée]al|grand prix|"
          r"formule ?1|coupe du monde",
    "PT": r"liga portugal|primeira liga|liga betclic|benfica|\bporto\b|sporting|braga|vit[oó]ria|ta[çc]a de portugal|"
          r"ta[çc]a da liga|liga dos campe[õo]es|champions league|liga europa|europa league|sele[çc][ãa]o|"
          r"portugal|mundial|\beuro\b|futsal|motogp|f[óo]rmula ?1|ronaldo",
    "BR": r"brasileir[ãa]o|s[ée]rie a|libertadores|copa do brasil|sul-americana|flamengo|corinthians|palmeiras|"
          r"s[ãa]o paulo|santos|vasco|gr[êe]mio|internacional|atl[ée]tico-mg|cruzeiro|botafogo|fluminense|"
          r"bahia|fortaleza|sele[çc][ãa]o|copa do mundo|f[óo]rmula ?1|\bf1\b|v[ôo]lei|\bufc\b|\bnba\b|champions league",
    "ES": r"laliga|la liga|real madrid|bar[cç]a|barcelona|atl[ée]tico|sevilla|betis|valencia|athletic|"
          r"champions league|liga de campeones|copa del rey|selecci[óo]n|mundial|\beuro\b|f[óo]rmula ?1|\bf1\b|"
          r"motogp|alcaraz|nadal|roland|wimbledon|acb|euroliga|vuelta",
    "IT": r"serie a|juventus|\binter\b|milan|napoli|roma|lazio|atalanta|fiorentina|champions league|coppa italia|"
          r"azzurri|nazionale|mondiali|\beuro\b|formula ?1|\bf1\b|ferrari|motogp|giro d'italia|sinner|tennis|"
          r"sei nazioni",
    "DE": r"bundesliga|dfb-pokal|bayern|dortmund|leverkusen|leipzig|champions league|nationalmannschaft|\bdfb\b|"
          r"\bwm\b|\bem\b|formel ?1|\bf1\b|handball|biathlon|ski|skispringen|nfl|darts",
    "UK": r"premier league|\bfa cup\b|carabao|champions league|arsenal|chelsea|liverpool|manchester|tottenham|"
          r"newcastle|england|six nations|wimbledon|the open|ryder cup|formula ?1|\bf1\b|cricket|ashes|darts|"
          r"snooker|grand national|rugby league",
    "US": r"\bnfl\b|super bowl|\bnba\b|\bmlb\b|world series|\bnhl\b|stanley cup|college football|march madness|"
          r"ncaa|\bmls\b|\bufc\b|nascar|masters",
    "NL": r"eredivisie|ajax|psv|feyenoord|oranje|champions league|formule ?1|verstappen|schaatsen",
    "MA": r"botola|raja|wydad|lions de l'atlas|maroc|champions league|ligue des champions|can\b|coupe d'afrique",
    "DZ": r"ligue ?1 mobilis|mca|usma|jsk|fennecs|alg[ée]rie|can\b|coupe d'afrique|champions league",
    "TN": r"ligue ?1|esp[ée]rance|club africain|[ée]toile du sahel|aigles de carthage|tunisie|can\b|champions league",
}
SPORT_POP_RE = {cc: re.compile(rx, re.I) for cc, rx in SPORT_POP.items()}

# Grandes émissions par pays
SHOWS = {
    "FR": r"koh-?lanta|the voice|star academy|les enfoir[ée]s|fort boyard|danse avec les stars|zone interdite|"
          r"envoy[ée] sp[ée]cial|cash investigation|capital|quotidien|p[ée]kin express|top chef|meilleur p[âa]tissier|"
          r"mask singer|qui veut gagner des millions|l'amour est dans le pr[ée]|les tra[iî]tres|la france a un incroyable|"
          r"complément d'enquête|compl[ée]ment d'enqu[êe]te|c dans l'air|la grande librairie|des racines et des ailes|"
          r"le grand concours|secrets d'histoire|carnets de julie|nouvelle star|loto|euromillions|l'[ée]mission politique|"
          r"d[ée]bat pr[ée]sidentiel|victoires de la musique|c[ée]sar|festival de cannes|eurovision",
    "BE": r"the voice|top chef|la boite à|on n'est pas des pigeons|questions à la une|eurovision|koh-?lanta",
    "CH": r"temps pr[ée]sent|mise au point|a bon entendeur|eurovision|the voice",
    "CA": r"occupation double|tout le monde en parle|star acad[ée]mie|la voix|big brother|survivor",
    "PT": r"big brother|casa dos segredos|the voice portugal|got talent|masterchef|a quinta|ídolos|idolos|"
          r"festival da can[çc][ãa]o|eurovis[ãa]o|alta defini[çc][ãa]o|jornal da noite|telejornal",
    "BR": r"big brother brasil|\bbbb\b|a fazenda|the voice brasil|masterchef|fant[áa]stico|jornal nacional|"
          r"novela|domingo legal|programa do ratinho|altas horas|caldeir[ãa]o|est[ãa]o loucos|show da virada",
    "ES": r"operaci[óo]n triunfo|masterchef|la isla de las tentaciones|supervivientes|el hormiguero|pasapalabra|"
          r"la voz|got talent|gran hermano|benidorm fest|eurovisi[óo]n",
    "IT": r"festival di sanremo|sanremo|x factor|grande fratello|amici|ballando con le stelle|isola dei famosi|"
          r"striscia|le iene|porta a porta|che tempo che fa|eurovision",
    "DE": r"tatort|wetten,? dass|let's dance|germany's next topmodel|deutschland sucht den superstar|"
          r"wer wird million[äa]r|the masked singer|eurovision|sportschau",
    "UK": r"strictly|i'm a celebrity|britain's got talent|the great british bake off|eastenders|coronation street|"
          r"love island|the traitors|doctor who|match of the day|question time|eurovision",
    "US": r"saturday night live|\bsnl\b|the voice|american idol|survivor|dancing with the stars|60 minutes|"
          r"jeopardy|wheel of fortune|the oscars|academy awards|golden globes|grammys|super bowl halftime",
}
SHOWS_RE = {cc: re.compile(rx, re.I) for cc, rx in SHOWS.items()}

SPORT_RE = re.compile(
    r"\b(match|football|foot|futebol|f[úu]tbol|calcio|fu[ßs]ball|soccer|ligue|liga|league|coupe|copa|cup|ta[çc]a|"
    r"rugby|tennis|t[ée]nis|grand prix|formul|f1|motogp|nba|nfl|nhl|mlb|basket|handball|cyclisme|ciclismo|tour de|"
    r"ufc|boxe|boxing|mma|olymp|mondial|mundial|biathlon|ski|golf|volley|v[ôo]lei|athl[ée]tisme|snooker|darts|"
    r"fl[ée]chettes|cricket|hockey|nascar|curling|p[ée]tanque|bowling|surf|natation|swimming|halt[ée]rophilie|"
    r"multiplex|en direct du stade)\b", re.I)
VS_RE = re.compile(r"\S.{1,40}\s(?:-|–|vs\.?|v\.?|x|/)\s.{1,40}\S")
LIVE_RE = re.compile(r"\b(en direct|direct|live|ao vivo|en vivo|in diretta)\b", re.I)
REPLAY_RE = re.compile(r"\b(magazine|r[ée]sum[ée]|replay|rediffusion|avant-match|apr[èe]s-match|talk|club|"
                       r"d[ée]brief|highlights|les buts|goals|reprise|meilleurs moments|plateau|journal du)\b", re.I)
BIG_RE = re.compile(r"\b(finale|final|classico|cl[áa]sico|cl[àa]ssico|derby|d[ée]rbi|cl[áa]ssico)\b", re.I)
NEWS_RE = re.compile(r"\b(journal|jt|info|infos|m[ée]t[ée]o|actualit[ée]s?|matinale|le 20h|19/20|12/13|t[ée]l[ée]matin|"
                     r"flash|[ée]dition|d[ée]bat|bourse|telejornal|jornal|noticias|notici[áa]rio|tg1|tagesschau|news)\b", re.I)
FILM_RE = re.compile(r"(^|\b)(film|long[- ]m[ée]trage|t[ée]l[ée]film|r[ée]alis[ée] par|filme|pel[íi]cula|movie|"
                     r"de \w+ \w+, \d{4}|\(\d{4}\))\b", re.I)
SERIE_RE = re.compile(r"\b(s[ée]rie|saison \d+|season \d+|temporada \d+|[ée]pisode \d+|epis[óo]dio \d+|s\d+\s?e\d+|novela)\b", re.I)
CINE_CH_RE = re.compile(r"cin[ée]|ocs|paramount|tcm|action|frisson|emotion|premier|famiz|classic|telecine|megapix|"
                        r"hollywood|movies|cinema|film|sky cinema", re.I)
SPORT_CH_RE = re.compile(r"sport|foot|bein|rmc ?sport|eurosport|dazn|ligue ?1|equipe|golf|tennis|automoto|espn|"
                         r"sportv|premiere|eleven|tnt sports|teledeporte|gol|laliga|bt sport", re.I)


def detect_country():
    """Pays d'après les réglages régionaux du système (Windows : région, sinon langue)."""
    if sys.platform == "win32":
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(10)
            if ctypes.windll.kernel32.GetUserDefaultGeoName(buf, 10):
                cc = buf.value.upper()
                return "UK" if cc == "GB" else cc
        except Exception:
            pass
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(85)
            if ctypes.windll.kernel32.GetUserDefaultLocaleName(buf, 85):
                part = buf.value.split("-")[-1].upper()
                if len(part) == 2:
                    return "UK" if part == "GB" else part
        except Exception:
            pass
    for v in (os.environ.get("LC_ALL"), os.environ.get("LANG"), (locale.getlocale() or [None])[0]):
        if v and "_" in v:
            part = v.split(".")[0].split("_")[-1].upper()
            if len(part) == 2:
                return "UK" if part == "GB" else part
    return "FR"


def channel_country(raw_names, cat_name, key):
    votes = {}
    for txt in list(raw_names) + [cat_name or ""]:
        m = PREFIX_RE.match(txt or "")
        if m:
            cc = PREFIX_MAP.get(m.group(1).upper())
            if cc:
                votes[cc] = votes.get(cc, 0) + 2
    for rx, cc in COUNTRY_WORDS:
        if rx.search(cat_name or ""):
            votes[cc] = votes.get(cc, 0) + 1
    if votes:
        return max(votes, key=votes.get)
    for cc, ranks in _MAJOR_RANK.items():
        if key in ranks:
            return cc
    return None


def priority(key, cc, country):
    if cc and cc != country:
        return 999
    return _MAJOR_RANK.get(country, {}).get(key, 500)


def popular_sport(text, country):
    rx = SPORT_POP_RE.get(country)
    return bool(rx and rx.search(text))


# --------------------------------------------------------------------------- programmes
class EpgCache:
    def __init__(self, fetch, ttl=900):
        self.fetch, self.ttl = fetch, ttl
        self.data = {}
        self.lock = threading.Lock()

    def get_many(self, sids, limit=16):
        now = time.time()
        todo = [s for s in sids if not (s in self.data and now - self.data[s][0] < self.ttl)]

        def one(sid):
            try:
                return sid, self.fetch(sid, limit)
            except Exception:
                return sid, []

        if todo:
            with ThreadPoolExecutor(max_workers=8) as pool:
                for sid, progs in pool.map(one, todo):
                    with self.lock:
                        self.data[sid] = (time.time(), progs)
        return {s: self.data.get(s, (0, []))[1] for s in sids}


def local_channels(live, country, n=45):
    """Grandes chaînes du pays présentes chez le fournisseur, puis autres chaînes locales sport / cinéma."""
    loc = [g for g in live if g.get("cc") in (country, None) and g.get("pr", 999) < 500]
    loc.sort(key=lambda g: g["pr"])
    extra = [g for g in live if g.get("cc") == country and g.get("pr", 999) >= 500
             and (SPORT_CH_RE.search(g["t"]) or CINE_CH_RE.search(g["t"]))]
    sel = loc[:n] + extra[:12]
    if len(sel) < 10:
        sel += [g for g in live if g.get("cc") == country and g not in sel][:20]
    return sel


def channel_epg(epgc, chans, limit=16):
    sids = []
    for g in chans:
        sids += [s["id"] for s in g["s"][:2]]
    data = epgc.get_many(sids, limit)
    out = {}
    for g in chans:
        for s in g["s"][:2]:
            if data.get(s["id"]):
                out[g["k"]] = data[s["id"]]
                break
    return out


def classify(ch, prog, country, rank):
    """-> (tag, score)  ; score <= 0 : à ne pas mettre en avant"""
    title, desc = prog.get("title") or "", prog.get("desc") or ""
    text = f"{title} {desc}"
    dur = max(1, (prog["end"] - prog["start"]) // 60)
    lt = time.localtime(prog["start"])
    hour = lt.tm_hour + lt.tm_min / 60
    base = max(0, 40 - rank) if rank < 500 else 0
    is_sport_ch = bool(SPORT_CH_RE.search(ch["t"]))
    if NEWS_RE.search(title) and not SPORT_RE.search(title):
        return "Info", base - 30
    if SPORT_RE.search(text) or (is_sport_ch and VS_RE.search(title)):
        if REPLAY_RE.search(text):
            return "Sport", base - 20
        if not popular_sport(text, country):
            return "Sport", -1                       # sport peu suivi dans votre pays : ignoré
        score = base + 55 + (25 if VS_RE.search(title) else 0) + (15 if LIVE_RE.search(text) else 0)
        score += 25 if BIG_RE.search(text) else 0
        return "Sport", score
    show_rx = SHOWS_RE.get(country)
    if show_rx and show_rx.search(title):
        return "Émission", base + 45 + (10 if 20.4 <= hour <= 22 else 0)
    if re.search(r"t[ée]l[ée]film", f"{title} {desc[:60]}", re.I):
        return "Téléfilm", base
    if FILM_RE.search(desc[:120]) or FILM_RE.search(title) or (CINE_CH_RE.search(ch["t"]) and dur >= 80):
        return "Film", base + 30
    if SERIE_RE.search(text):
        return "Série", base + 15
    if dur < 15:
        return "Programme", base - 20
    return "Programme", base + (10 if 20.4 <= hour <= 22.5 else 0)


_TEAM_SEP = re.compile(r"\s+(?:-|–|—|/|vs\.?|v\.?|contre|x)\s+", re.I)


def split_teams(title):
    """« Ligue 1 : PSG - Marseille (direct) » -> ["PSG", "Marseille"] ; None si ce n'est pas un match."""
    t = re.sub(r"\s*[\(\[].*?[\)\]]\s*", " ", title or "").strip()
    parts = [p for p in re.split(r"\s*[:|]\s+", t) if _TEAM_SEP.search(p)]
    if not parts:
        return None
    teams = [x.strip(" .-–—") for x in _TEAM_SEP.split(parts[-1])]
    if len(teams) != 2 or any(not (2 <= len(x) <= 40) or x.isdigit() for x in teams):
        return None
    return teams


def now_events(chans, epg, country):
    now = time.time()
    events, nowmap = [], {}
    for g in chans:
        progs = epg.get(g["k"]) or []
        cur = next((p for p in progs if p["start"] <= now < p["end"]), None)
        if not cur:
            continue
        nxt = next((p for p in progs if p["start"] >= cur["end"] - 60), None)
        tag, score = classify(g, cur, country, g.get("pr", 999))
        nowmap[g["k"]] = {"t": cur["title"], "s": cur["start"], "e": cur["end"]}
        if score <= 0 and tag != "Programme":
            continue
        events.append({"key": g["k"], "ch": g["t"], "logo": g.get("p") or "", "title": cur["title"],
                       "desc": (cur.get("desc") or "")[:400], "start": cur["start"], "end": cur["end"], "tag": tag,
                       "score": score, "next": {"title": nxt["title"], "start": nxt["start"]} if nxt else None, "img": ""})
    events.sort(key=lambda e: -e["score"])
    return events, nowmap


def evening_window(now=None):
    now = now or time.time()
    lt = time.localtime(now)
    day = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    if lt.tm_hour >= 23:
        day += 86400
    return day + 20 * 3600 + 30 * 60, day + 23 * 3600, day


def tonight(chans, epg, country, lookup_movie, lookup_tv, has_key=True):
    start_w, end_w, day = evening_window()
    picks = []
    for g in chans:
        rank = g.get("pr", 999)
        for p in epg.get(g["k"]) or []:
            if not (start_w - 1800 <= p["start"] <= end_w):
                continue
            dur = (p["end"] - p["start"]) / 60
            if dur < 35:
                continue
            tag, score = classify(g, p, country, rank)
            if score <= 0 or tag in ("Info", "Téléfilm"):
                continue
            if tag == "Programme" and not (dur >= 85 and rank < 15):
                continue
            item = {"key": g["k"], "ch": g["t"], "logo": g.get("p") or "", "title": p["title"],
                    "desc": (p.get("desc") or "")[:400], "start": p["start"], "end": p["end"], "tag": tag,
                    "score": score, "poster": "", "img": "", "vote": None, "year": None}
            if tag == "Film" or (tag == "Programme" and dur >= 85 and rank < 15):
                m = lookup_movie(p["title"], p.get("desc") or "")
                if m:
                    item.update(tag="Film", poster=m.get("p") or "", img=m.get("b") or "", vote=m.get("v"), year=m.get("y"))
                    item["score"] += 15 + (m.get("v") or 0) * 3 + min(15, (m.get("pop") or 0) / 5)
                elif has_key or tag != "Film" or rank >= 8:
                    continue                           # film inconnu de TMDB : pas assez connu pour être mis en avant
            elif tag == "Série":
                m = lookup_tv(p["title"])
                if m:
                    item.update(poster=m.get("p") or "", img=m.get("b") or "", vote=m.get("v"))
                    item["score"] += 15 + (m.get("v") or 0) * 2
                elif has_key or rank >= 6:
                    continue
            if 20.6 <= time.localtime(p["start"]).tm_hour + time.localtime(p["start"]).tm_min / 60 <= 21.4:
                item["score"] += 10                    # vrai début de soirée
            picks.append(item)
    # un même programme sur plusieurs chaînes : on garde la meilleure chaîne
    best = {}
    for it in picks:
        k = _norm(it["title"])
        if k not in best or it["score"] > best[k]["score"]:
            best[k] = it
    out = sorted(best.values(), key=lambda x: -x["score"])
    return out[:18], day


def guide(chans, epg, country, hours_before=1, hours_after=6):
    now = time.time()
    t0 = now - hours_before * 3600
    t1 = now + hours_after * 3600
    rows = []
    for g in chans:
        progs = [p for p in (epg.get(g["k"]) or []) if p["end"] > t0 and p["start"] < t1]
        rows.append({"key": g["k"], "ch": g["t"], "logo": g.get("p") or "",
                     "progs": [{"title": p["title"], "desc": (p.get("desc") or "")[:300], "start": p["start"],
                                "end": p["end"], "tag": classify(g, p, country, 999)[0]} for p in progs]})
    return {"t0": int(t0), "t1": int(t1), "rows": rows}
