/*
 * Guide TV de ShippoTV (portage de tvguide.py) : chaînes de votre pays, programme du moment,
 * grille horaire et « Ce soir chez vous » (films, séries, sport populaire, grandes émissions).
 *
 * Les heures sont des timestamps Unix en SECONDES, comme côté Python.
 * Les regex Python (\b, \w, \s, \d, « . » Unicode) sont transposées pour garder la même sémantique.
 */
(function (G) {
  'use strict';
  const SH = G.SH = G.SH || {};

  // ------------------------------------------------------------------ compatibilité Python
  const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  // dict.get(k, def) ; une valeur undefined compte comme None
  function get(o, k, def) {
    if (o instanceof Map) return o.has(k) ? nz(o.get(k)) : def;
    return hasOwn(o, k) ? nz(o[k]) : def;
  }
  const nz = (v) => (v === undefined ? null : v);
  // vérité au sens Python ([] et {} sont faux, NaN est vrai)
  function truthy(v) {
    if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }
  const or = (a, b) => (truthy(a) ? a : b);
  const pyMax = (a, b) => (b > a ? b : a);
  const pyMin = (a, b) => (b < a ? b : a);
  // s[:n] en points de code
  function cpSlice(s, n) {
    if (s.length <= n) return s;
    return Array.from(s).slice(0, n).join('');
  }
  // égalité ==  de Python sur des données JSON
  function pyEq(a, b) {
    if (a === b) return true;
    const ta = typeof a, tb = typeof b;
    if ((ta === 'number' || ta === 'boolean') && (tb === 'number' || tb === 'boolean')) return Number(a) === Number(b);
    if (a === null || b === null || ta !== 'object' || tb !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && pyEq(a[k], b[k]));
  }

  // Transpose une regex Python (str, Unicode) en RegExp JS équivalente (drapeau u)
  const W = '\\p{L}\\p{N}_';
  const SP = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const BOUND = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
  function pyRe(src, flags) {
    let out = '', cls = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[++i];
        if (cls) out += n === 'w' ? W : n === 's' ? SP : n === 'd' ? '\\p{Nd}' : '\\' + n;
        else if (n === 'b') out += BOUND;
        else if (n === 'w') out += `[${W}]`;
        else if (n === 'W') out += `[^${W}]`;
        else if (n === 's') out += `[${SP}]`;
        else if (n === 'S') out += `[^${SP}]`;
        else if (n === 'd') out += '\\p{Nd}';
        else if (n === 'D') out += '\\P{Nd}';
        else out += '\\' + n;
      } else if (cls) {
        if (c === ']') cls = false;
        out += c;
      } else if (c === '[') {
        cls = true;
        out += c;
        if (src[i + 1] === '^') { out += '^'; i++; }
        if (src[i + 1] === ']') { out += '\\]'; i++; }
      } else if (c === '.') out += '[^\\n]';
      else out += c;
    }
    return new RegExp(out, 'u' + (flags || ''));
  }
  // re.I de Python assimile İ et ı à i (pas JS) : on les ramène à i avant le test
  const ci = (s) => s.replace(/[İı]/g, 'i');
  const search = (rx, s) => rx.test(rx.ignoreCase ? ci(s) : s);

  function norm(s) {
    s = (s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    return s.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  }

  // Horloge (secondes) ; Date.now est remplaçable pour les tests
  const nowSec = () => Date.now() / 1000;
  const localtime = (sec) => new Date(sec * 1000);

  // ------------------------------------------------------------------ pays
  const COUNTRIES = {
    FR: { name: 'France', flag: '🇫🇷' }, BE: { name: 'Belgique', flag: '🇧🇪' },
    CH: { name: 'Suisse', flag: '🇨🇭' }, CA: { name: 'Canada', flag: '🇨🇦' },
    PT: { name: 'Portugal', flag: '🇵🇹' }, BR: { name: 'Brésil', flag: '🇧🇷' },
    ES: { name: 'Espagne', flag: '🇪🇸' }, IT: { name: 'Italie', flag: '🇮🇹' },
    DE: { name: 'Allemagne', flag: '🇩🇪' }, UK: { name: 'Royaume-Uni', flag: '🇬🇧' },
    US: { name: 'États-Unis', flag: '🇺🇸' }, NL: { name: 'Pays-Bas', flag: '🇳🇱' },
    MA: { name: 'Maroc', flag: '🇲🇦' }, DZ: { name: 'Algérie', flag: '🇩🇿' },
    TN: { name: 'Tunisie', flag: '🇹🇳' },
  };

  const PREFIX_MAP = {
    FR: 'FR', FRA: 'FR', FRANCE: 'FR', FRENCH: 'FR', BE: 'BE', BEL: 'BE', CH: 'CH', SUI: 'CH',
    SWISS: 'CH', CA: 'CA', CAN: 'CA', QC: 'CA', PT: 'PT', POR: 'PT', PRT: 'PT', BR: 'BR',
    BRA: 'BR', ES: 'ES', ESP: 'ES', SP: 'ES', IT: 'IT', ITA: 'IT', DE: 'DE', GER: 'DE',
    DEU: 'DE', UK: 'UK', GB: 'UK', ENG: 'UK', US: 'US', USA: 'US', NL: 'NL', NED: 'NL',
    MA: 'MA', DZ: 'DZ', ALG: 'DZ', TN: 'TN',
  };
  const COUNTRY_WORDS_SRC = [
    ['\\bfran[cç]e|fran[cç]ais|french|\\btnt\\b', 'FR'],
    ['belgi', 'BE'], ['suisse|switzerland|schweiz', 'CH'],
    ['qu[ée]bec|canada', 'CA'], ['portugal|portugu[eê]s', 'PT'],
    ['bra[sz]il|br[ée]sil', 'BR'], ['espa[ñn]a|spain|espagne|spanish', 'ES'],
    ['itali', 'IT'], ['deutsch|german|allemagne', 'DE'],
    ['united kingdom|\\buk\\b|england|british', 'UK'], ['\\busa\\b|united states', 'US'],
    ['nederland|netherlands|dutch', 'NL'], ['maroc|morocco', 'MA'],
    ['alg[ée]rie|algeria', 'DZ'], ['tunisi', 'TN'],
  ];
  const COUNTRY_WORDS = COUNTRY_WORDS_SRC.map(([rx, cc]) => [pyRe(rx, 'i'), cc]);
  const PREFIX_SRC = '^\\W*([A-Za-z]{2,7})\\s*(?:[:|\\-»>]|\\s\\|)';
  const PREFIX_RE = pyRe(PREFIX_SRC);

  // Grandes chaînes par pays, par ordre d'importance (clés normalisées)
  const MAJORS = {
    FR: ['tf1', 'france2', 'france3', 'canal', 'france5', 'm6', 'arte', 'c8', 'w9', 'tmc', 'tfx', 'nrj12', 'lcp',
      'france4', 'bfmtv', 'cnews', 'lci', 'franceinfo', 'cstar', 'gulli', 'tf1seriesfilms', 'lequipe', '6ter',
      'rmcstory', 'rmcdecouverte', 'cherie25', 't18', 'novo19', 'canalsport', 'canalfoot', 'canalsport360',
      'beinsports1', 'beinsports2', 'beinsports3', 'rmcsport1', 'rmcsport2', 'eurosport1', 'eurosport2',
      'dazn1', 'ligue1', 'ligue1plus', 'primevideoligue1', 'lequipelive1', 'canalcinemas', 'cineplusfrisson',
      'cinepluspremier', 'cineplusemotion', 'cineplusclassic', 'ocs', 'ocsmax', 'paramountchannel',
      'tcmcinema', 'canalseries', 'seriesclub', 'warnertv', '13emerue', 'syfy'],
    BE: ['laune', 'rtltvi', 'tipik', 'latrois', 'clubrtl', 'plugrtl', 'ab3', 'een', 'vtm', 'canvas', 'play4',
      'vtm2', 'vier', 'vijf', 'tf1', 'france2', 'm6', 'eleven1', 'elevenpro1', 'playsports1'],
    CH: ['rtsun', 'rts1', 'rtsdeux', 'rts2', 'srf1', 'srfzwei', 'rsila1', 'tf1', 'france2', 'm6', 'blue sport1'],
    CA: ['tva', 'iciradiocanadatele', 'radiocanada', 'noovo', 'telequebec', 'rds', 'rds2', 'tvasports', 'lcn', 'rdi',
      'cbc', 'ctv', 'global', 'tsn', 'sportsnet'],
    PT: ['rtp1', 'rtp2', 'sic', 'tvi', 'cmtv', 'rtp3', 'sicnoticias', 'cnnportugal', 'sporttv1', 'sporttv2',
      'sporttv3', 'sporttv4', 'sporttv5', 'benficatv', 'portocanal', 'elevensports1', 'dazn1', 'tvicinema',
      'hollywood', 'axn', 'fox', 'sicmulher', 'tvireality'],
    BR: ['globo', 'tvglobo', 'redeglobo', 'sbt', 'record', 'recordtv', 'band', 'redetv', 'tvcultura', 'sportv',
      'sportv2', 'sportv3', 'premiere', 'premiereclubes', 'espn', 'espn2', 'espn4', 'bandsports', 'globonews',
      'multishow', 'gnt', 'telecineaction', 'telecinepremium', 'hbo', 'megapix', 'warner', 'tnt', 'space'],
    ES: ['la1', 'antena3', 'telecinco', 'lasexta', 'cuatro', 'la2', 'movistarlaliga', 'movistarplus',
      'movistarligadecampeones', 'dazn1', 'laligatv', 'gol', 'teledeporte', 'neox', 'fdf', '24h'],
    IT: ['rai1', 'canale5', 'rai2', 'italia1', 'rai3', 'rete4', 'la7', 'tv8', 'nove', 'skysportuno',
      'skysportcalcio', 'skysport24', 'dazn1', 'raisport', 'skycinemauno', '20mediaset', 'iris', 'cielo'],
    DE: ['daserste', 'ard', 'zdf', 'rtl', 'sat1', 'prosieben', 'vox', 'kabeleins', 'kabel1', 'rtlzwei', 'sport1',
      'skysportbundesliga1', 'skysportbundesliga', 'skysporttopevent', 'dazn1', 'eurosport1', 'ntv', 'welt'],
    UK: ['bbcone', 'itv1', 'itv', 'bbctwo', 'channel4', 'channel5', 'skyone', 'skyshowcase',
      'skysportsmainevent', 'skysportspremierleague', 'skysportsfootball', 'tntsports1', 'tntsports2',
      'skysportsf1', 'skysportscricket', 'skycinemapremiere', 'bbcnews', 'skynews', 'e4', 'dave'],
    US: ['abc', 'cbs', 'nbc', 'fox', 'espn', 'espn2', 'tnt', 'tbs', 'hbo', 'foxnews', 'cnn', 'nflnetwork',
      'nbatv', 'amc', 'fx', 'usa', 'foxsports1', 'fs1', 'cw'],
    NL: ['npo1', 'npo2', 'npo3', 'rtl4', 'rtl5', 'sbs6', 'rtl7', 'veronica', 'ziggosport', 'espn1'],
    MA: ['almaghribia', '2m', 'arryadia', 'medi1tv', 'beinsports1', 'beinsports2'],
    DZ: ['entv', 'canalalgerie', 'echorouk', 'ennahar', 'beinsports1'],
    TN: ['watania1', 'elhiwar', 'attessia', 'nessma', 'beinsports1'],
  };
  // rang par clé (Map : pas de collision avec les propriétés d'Object)
  const MAJOR_RANK = new Map();
  for (const cc of Object.keys(MAJORS)) {
    const m = new Map();
    MAJORS[cc].forEach((k, i) => m.set(k, i));
    MAJOR_RANK.set(cc, m);
  }

  // Sport réellement populaire par pays (seul ce qui correspond est mis en avant)
  const SPORT_POP = {
    FR: "ligue ?1|ligue des champions|champions league|europa league|conference league|coupe de france|" +
      "troph[ée]e des champions|[ée]quipe de france|les bleus|bleues|psg|paris sg|paris saint|\\bom\\b|marseille|" +
      "\\bol\\b|lyon|lens|lille|monaco|nice|rennes|nantes|strasbourg|real madrid|barcelone|bar[cç]a|bayern|" +
      "liverpool|manchester|arsenal|chelsea|coupe du monde|\\beuro\\b|top ?14|six nations|tournoi des 6|" +
      "xv de france|champions cup|coupe du monde de rugby|toulouse|la rochelle|stade fran[cç]ais|racing 92|" +
      "roland|wimbledon|us open|open d'australie|masters|coupe davis|tour de france|paris-roubaix|giro|vuelta|" +
      "grand prix|formule ?1|\\bf1\\b|motogp|jeux olympiques|\\bjo\\b|handball.*france|basket.*france|elitesserien",
    BE: "jupiler|pro league|anderlecht|club brugge|bruges|standard|genk|gand|diables rouges|red devils|" +
      "ligue des champions|champions league|europa|coupe du monde|\\beuro\\b|tour de france|ronde van vlaanderen|" +
      "tour des flandres|paris-roubaix|li[eè]ge-bastogne|grand prix|formule ?1|\\bf1\\b|roland|wimbledon",
    CH: "super league|young boys|b[aâ]le|basel|servette|lugano|nati|suisse|ski|lauberhorn|hockey|national league|" +
      "ligue des champions|champions league|roland|wimbledon|grand prix|formule ?1",
    CA: "\\bnhl\\b|lnh|canadiens|maple leafs|hockey|\\bnba\\b|raptors|\\bnfl\\b|\\bcfl\\b|mls|cf montr[ée]al|grand prix|" +
      "formule ?1|coupe du monde",
    PT: "liga portugal|primeira liga|liga betclic|benfica|\\bporto\\b|sporting|braga|vit[oó]ria|ta[çc]a de portugal|" +
      "ta[çc]a da liga|liga dos campe[õo]es|champions league|liga europa|europa league|sele[çc][ãa]o|" +
      "portugal|mundial|\\beuro\\b|futsal|motogp|f[óo]rmula ?1|ronaldo",
    BR: "brasileir[ãa]o|s[ée]rie a|libertadores|copa do brasil|sul-americana|flamengo|corinthians|palmeiras|" +
      "s[ãa]o paulo|santos|vasco|gr[êe]mio|internacional|atl[ée]tico-mg|cruzeiro|botafogo|fluminense|" +
      "bahia|fortaleza|sele[çc][ãa]o|copa do mundo|f[óo]rmula ?1|\\bf1\\b|v[ôo]lei|\\bufc\\b|\\bnba\\b|champions league",
    ES: "laliga|la liga|real madrid|bar[cç]a|barcelona|atl[ée]tico|sevilla|betis|valencia|athletic|" +
      "champions league|liga de campeones|copa del rey|selecci[óo]n|mundial|\\beuro\\b|f[óo]rmula ?1|\\bf1\\b|" +
      "motogp|alcaraz|nadal|roland|wimbledon|acb|euroliga|vuelta",
    IT: "serie a|juventus|\\binter\\b|milan|napoli|roma|lazio|atalanta|fiorentina|champions league|coppa italia|" +
      "azzurri|nazionale|mondiali|\\beuro\\b|formula ?1|\\bf1\\b|ferrari|motogp|giro d'italia|sinner|tennis|" +
      "sei nazioni",
    DE: "bundesliga|dfb-pokal|bayern|dortmund|leverkusen|leipzig|champions league|nationalmannschaft|\\bdfb\\b|" +
      "\\bwm\\b|\\bem\\b|formel ?1|\\bf1\\b|handball|biathlon|ski|skispringen|nfl|darts",
    UK: "premier league|\\bfa cup\\b|carabao|champions league|arsenal|chelsea|liverpool|manchester|tottenham|" +
      "newcastle|england|six nations|wimbledon|the open|ryder cup|formula ?1|\\bf1\\b|cricket|ashes|darts|" +
      "snooker|grand national|rugby league",
    US: "\\bnfl\\b|super bowl|\\bnba\\b|\\bmlb\\b|world series|\\bnhl\\b|stanley cup|college football|march madness|" +
      "ncaa|\\bmls\\b|\\bufc\\b|nascar|masters",
    NL: "eredivisie|ajax|psv|feyenoord|oranje|champions league|formule ?1|verstappen|schaatsen",
    MA: "botola|raja|wydad|lions de l'atlas|maroc|champions league|ligue des champions|can\\b|coupe d'afrique",
    DZ: "ligue ?1 mobilis|mca|usma|jsk|fennecs|alg[ée]rie|can\\b|coupe d'afrique|champions league",
    TN: "ligue ?1|esp[ée]rance|club africain|[ée]toile du sahel|aigles de carthage|tunisie|can\\b|champions league",
  };
  const SPORT_POP_RE = new Map(Object.keys(SPORT_POP).map((cc) => [cc, pyRe(SPORT_POP[cc], 'i')]));

  // Grandes émissions par pays
  const SHOWS = {
    FR: "koh-?lanta|the voice|star academy|les enfoir[ée]s|fort boyard|danse avec les stars|zone interdite|" +
      "envoy[ée] sp[ée]cial|cash investigation|capital|quotidien|p[ée]kin express|top chef|meilleur p[âa]tissier|" +
      "mask singer|qui veut gagner des millions|l'amour est dans le pr[ée]|les tra[iî]tres|la france a un incroyable|" +
      "complément d'enquête|compl[ée]ment d'enqu[êe]te|c dans l'air|la grande librairie|des racines et des ailes|" +
      "le grand concours|secrets d'histoire|carnets de julie|nouvelle star|loto|euromillions|l'[ée]mission politique|" +
      "d[ée]bat pr[ée]sidentiel|victoires de la musique|c[ée]sar|festival de cannes|eurovision",
    BE: "the voice|top chef|la boite à|on n'est pas des pigeons|questions à la une|eurovision|koh-?lanta",
    CH: "temps pr[ée]sent|mise au point|a bon entendeur|eurovision|the voice",
    CA: "occupation double|tout le monde en parle|star acad[ée]mie|la voix|big brother|survivor",
    PT: "big brother|casa dos segredos|the voice portugal|got talent|masterchef|a quinta|ídolos|idolos|" +
      "festival da can[çc][ãa]o|eurovis[ãa]o|alta defini[çc][ãa]o|jornal da noite|telejornal",
    BR: "big brother brasil|\\bbbb\\b|a fazenda|the voice brasil|masterchef|fant[áa]stico|jornal nacional|" +
      "novela|domingo legal|programa do ratinho|altas horas|caldeir[ãa]o|est[ãa]o loucos|show da virada",
    ES: "operaci[óo]n triunfo|masterchef|la isla de las tentaciones|supervivientes|el hormiguero|pasapalabra|" +
      "la voz|got talent|gran hermano|benidorm fest|eurovisi[óo]n",
    IT: "festival di sanremo|sanremo|x factor|grande fratello|amici|ballando con le stelle|isola dei famosi|" +
      "striscia|le iene|porta a porta|che tempo che fa|eurovision",
    DE: "tatort|wetten,? dass|let's dance|germany's next topmodel|deutschland sucht den superstar|" +
      "wer wird million[äa]r|the masked singer|eurovision|sportschau",
    UK: "strictly|i'm a celebrity|britain's got talent|the great british bake off|eastenders|coronation street|" +
      "love island|the traitors|doctor who|match of the day|question time|eurovision",
    US: "saturday night live|\\bsnl\\b|the voice|american idol|survivor|dancing with the stars|60 minutes|" +
      "jeopardy|wheel of fortune|the oscars|academy awards|golden globes|grammys|super bowl halftime",
  };
  const SHOWS_RE = new Map(Object.keys(SHOWS).map((cc) => [cc, pyRe(SHOWS[cc], 'i')]));

  const SRC = {
    SPORT: "\\b(match|football|foot|futebol|f[úu]tbol|calcio|fu[ßs]ball|soccer|ligue|liga|league|coupe|copa|cup|ta[çc]a|" +
      "rugby|tennis|t[ée]nis|grand prix|formul|f1|motogp|nba|nfl|nhl|mlb|basket|handball|cyclisme|ciclismo|tour de|" +
      "ufc|boxe|boxing|mma|olymp|mondial|mundial|biathlon|ski|golf|volley|v[ôo]lei|athl[ée]tisme|snooker|darts|" +
      "fl[ée]chettes|cricket|hockey|nascar|curling|p[ée]tanque|bowling|surf|natation|swimming|halt[ée]rophilie|" +
      "multiplex|en direct du stade)\\b",
    VS: "\\S.{1,40}\\s(?:-|–|vs\\.?|v\\.?|x|/)\\s.{1,40}\\S",
    LIVE: "\\b(en direct|direct|live|ao vivo|en vivo|in diretta)\\b",
    REPLAY: "\\b(magazine|r[ée]sum[ée]|replay|rediffusion|avant-match|apr[èe]s-match|talk|club|" +
      "d[ée]brief|highlights|les buts|goals|reprise|meilleurs moments|plateau|journal du)\\b",
    BIG: "\\b(finale|final|classico|cl[áa]sico|cl[àa]ssico|derby|d[ée]rbi|cl[áa]ssico)\\b",
    NEWS: "\\b(journal|jt|info|infos|m[ée]t[ée]o|actualit[ée]s?|matinale|le 20h|19/20|12/13|t[ée]l[ée]matin|" +
      "flash|[ée]dition|d[ée]bat|bourse|telejornal|jornal|noticias|notici[áa]rio|tg1|tagesschau|news)\\b",
    FILM: "(^|\\b)(film|long[- ]m[ée]trage|t[ée]l[ée]film|r[ée]alis[ée] par|filme|pel[íi]cula|movie|" +
      "de \\w+ \\w+, \\d{4}|\\(\\d{4}\\))\\b",
    SERIE: "\\b(s[ée]rie|saison \\d+|season \\d+|temporada \\d+|[ée]pisode \\d+|epis[óo]dio \\d+|s\\d+\\s?e\\d+|novela)\\b",
    CINE_CH: "cin[ée]|ocs|paramount|tcm|action|frisson|emotion|premier|famiz|classic|telecine|megapix|" +
      "hollywood|movies|cinema|film|sky cinema",
    SPORT_CH: "sport|foot|bein|rmc ?sport|eurosport|dazn|ligue ?1|equipe|golf|tennis|automoto|espn|" +
      "sportv|premiere|eleven|tnt sports|teledeporte|gol|laliga|bt sport",
  };
  const SPORT_RE = pyRe(SRC.SPORT, 'i');
  const VS_RE = pyRe(SRC.VS);
  const LIVE_RE = pyRe(SRC.LIVE, 'i');
  const REPLAY_RE = pyRe(SRC.REPLAY, 'i');
  const BIG_RE = pyRe(SRC.BIG, 'i');
  const NEWS_RE = pyRe(SRC.NEWS, 'i');
  const FILM_RE = pyRe(SRC.FILM, 'i');
  const SERIE_RE = pyRe(SRC.SERIE, 'i');
  const CINE_CH_RE = pyRe(SRC.CINE_CH, 'i');
  const SPORT_CH_RE = pyRe(SRC.SPORT_CH, 'i');
  const TELEFILM_RE = pyRe('t[ée]l[ée]film', 'i');

  // ------------------------------------------------------------------ détection du pays
  // Pas d'API Windows : on prend la région de la langue du navigateur (« fr-FR » -> FR)
  function regionOf(v) {
    if (!v || typeof v !== 'string') return null;
    const parts = v.split('.')[0].split('@')[0].split(/[-_]/);
    if (parts.length < 2) return null;
    const part = parts[parts.length - 1].toUpperCase();
    if (!/^[A-Z]{2}$/.test(part)) return null;
    return part === 'GB' ? 'UK' : part;
  }
  function detectCountry() {
    const cands = [];
    const nav = G.navigator;
    if (nav) {
      if (Array.isArray(nav.languages)) cands.push(...nav.languages);
      cands.push(nav.language);
    }
    const env = G.process && G.process.env;
    if (env) cands.push(env.LC_ALL, env.LANG);
    try { cands.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch (e) { /* ignoré */ }
    for (const v of cands) {
      const cc = regionOf(v);
      if (cc) return cc;
    }
    return 'FR';
  }

  function channelCountry(rawNames, catName, key) {
    const votes = new Map();
    for (const txt of [...(rawNames || []), catName || '']) {
      const m = PREFIX_RE.exec(txt || '');
      if (m) {
        const p = m[1].toUpperCase();
        const cc = hasOwn(PREFIX_MAP, p) ? PREFIX_MAP[p] : null;
        if (cc) votes.set(cc, (votes.get(cc) || 0) + 2);
      }
    }
    for (const [rx, cc] of COUNTRY_WORDS) {
      if (search(rx, catName || '')) votes.set(cc, (votes.get(cc) || 0) + 1);
    }
    if (votes.size) {
      let best = null, bv = -Infinity;
      for (const [cc, v] of votes) if (v > bv) { best = cc; bv = v; }
      return best;
    }
    for (const [cc, ranks] of MAJOR_RANK) if (ranks.has(key)) return cc;
    return null;
  }

  function priority(key, cc, country) {
    if (truthy(cc) && cc !== country) return 999;
    const ranks = MAJOR_RANK.get(country);
    return ranks && ranks.has(key) ? ranks.get(key) : 500;
  }

  function popularSport(text, country) {
    const rx = SPORT_POP_RE.get(country);
    return !!(rx && search(rx, text));
  }

  // ------------------------------------------------------------------ programmes
  // Exécute fn sur chaque élément avec au plus `n` appels simultanés ; résultats dans l'ordre
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    const ws = [];
    for (let i = 0; i < Math.min(n, items.length); i++) ws.push(worker());
    await Promise.all(ws);
    return out;
  }

  class EpgCache {
    // fetch(sid, limit) -> Promise<liste de programmes>
    constructor(fetch, ttl = 900) {
      this.fetch = fetch;
      this.ttl = ttl;
      this.data = new Map();      // sid -> [horodatage, programmes]
    }

    async getMany(sids, limit = 16) {
      const now = nowSec();
      const todo = sids.filter((s) => !(this.data.has(s) && now - this.data.get(s)[0] < this.ttl));
      if (todo.length) {
        const res = await pool(todo, 6, async (sid) => {
          try { return await this.fetch(sid, limit); } catch (e) { return []; }
        });
        todo.forEach((sid, i) => this.data.set(sid, [nowSec(), res[i]]));
      }
      const out = Object.create(null);
      for (const s of sids) out[s] = this.data.has(s) ? this.data.get(s)[1] : [];
      return out;
    }
  }

  // epg peut être un objet ou une Map
  const epgOf = (epg, k) => or(get(epg, k, null), []);

  function localChannels(live, country, n = 45) {
    // Grandes chaînes du pays présentes chez le fournisseur, puis autres chaînes locales sport / cinéma
    const cc = (g) => get(g, 'cc', null);
    const pr = (g) => get(g, 'pr', 999);
    const loc = live.filter((g) => (cc(g) === country || cc(g) === null) && pr(g) < 500);
    loc.sort((a, b) => (a.pr < b.pr ? -1 : b.pr < a.pr ? 1 : 0));
    const extra = live.filter((g) => cc(g) === country && pr(g) >= 500 &&
      (search(SPORT_CH_RE, g.t) || search(CINE_CH_RE, g.t)));
    let sel = loc.slice(0, n).concat(extra.slice(0, 12));
    if (sel.length < 10) {
      const more = live.filter((g) => cc(g) === country && !sel.some((x) => pyEq(x, g)));
      sel = sel.concat(more.slice(0, 20));
    }
    return sel;
  }

  async function channelEpg(epgc, chans, limit = 16) {
    let sids = [];
    for (const g of chans) sids = sids.concat(g.s.slice(0, 2).map((s) => s.id));
    const data = await epgc.getMany(sids, limit);
    const out = {};
    for (const g of chans) {
      for (const s of g.s.slice(0, 2)) {
        if (truthy(get(data, s.id, null))) {
          out[g.k] = data[s.id];
          break;
        }
      }
    }
    return out;
  }

  // -> [tag, score] ; score <= 0 : à ne pas mettre en avant
  function classify(ch, prog, country, rank) {
    const title = or(get(prog, 'title', null), ''), desc = or(get(prog, 'desc', null), '');
    const text = `${title} ${desc}`;
    const dur = pyMax(1, Math.floor((prog.end - prog.start) / 60));
    const lt = localtime(prog.start);
    const hour = lt.getHours() + lt.getMinutes() / 60;
    const base = rank < 500 ? pyMax(0, 40 - rank) : 0;
    const isSportCh = search(SPORT_CH_RE, ch.t);
    if (search(NEWS_RE, title) && !search(SPORT_RE, title)) return ['Info', base - 30];
    if (search(SPORT_RE, text) || (isSportCh && search(VS_RE, title))) {
      if (search(REPLAY_RE, text)) return ['Sport', base - 20];
      if (!popularSport(text, country)) return ['Sport', -1];   // sport peu suivi dans votre pays : ignoré
      let score = base + 55 + (search(VS_RE, title) ? 25 : 0) + (search(LIVE_RE, text) ? 15 : 0);
      score += search(BIG_RE, text) ? 25 : 0;
      return ['Sport', score];
    }
    const showRx = SHOWS_RE.get(country);
    if (showRx && search(showRx, title)) return ['Émission', base + 45 + (hour >= 20.4 && hour <= 22 ? 10 : 0)];
    if (search(TELEFILM_RE, `${title} ${cpSlice(desc, 60)}`)) return ['Téléfilm', base];
    if (search(FILM_RE, cpSlice(desc, 120)) || search(FILM_RE, title) || (search(CINE_CH_RE, ch.t) && dur >= 80)) {
      return ['Film', base + 30];
    }
    if (search(SERIE_RE, text)) return ['Série', base + 15];
    if (dur < 15) return ['Programme', base - 20];
    return ['Programme', base + (hour >= 20.4 && hour <= 22.5 ? 10 : 0)];
  }

  const byScoreDesc = (a, b) => (b.score < a.score ? -1 : a.score < b.score ? 1 : 0);

  function nowEvents(chans, epg, country) {
    const now = nowSec();
    const events = [], nowmap = {};
    for (const g of chans) {
      const progs = epgOf(epg, g.k);
      const cur = progs.find((p) => p.start <= now && now < p.end);
      if (!cur) continue;
      const nxt = progs.find((p) => p.start >= cur.end - 60);
      const [tag, score] = classify(g, cur, country, get(g, 'pr', 999));
      nowmap[g.k] = { t: nz(cur.title), s: cur.start, e: cur.end };
      if (score <= 0 && tag !== 'Programme') continue;
      events.push({
        key: g.k, ch: g.t, logo: or(get(g, 'p', null), ''), title: nz(cur.title),
        desc: cpSlice(or(get(cur, 'desc', null), ''), 400), start: cur.start, end: cur.end, tag,
        score, next: nxt ? { title: nz(nxt.title), start: nxt.start } : null, img: '',
      });
    }
    events.sort(byScoreDesc);
    return [events, nowmap];
  }

  function eveningWindow(now) {
    now = truthy(now) ? now : nowSec();
    const lt = localtime(now);
    let day = new Date(lt.getFullYear(), lt.getMonth(), lt.getDate(), 0, 0, 0).getTime() / 1000;
    if (lt.getHours() >= 23) day += 86400;
    return [day + 20 * 3600 + 30 * 60, day + 23 * 3600, day];
  }

  async function tonight(chans, epg, country, lookupMovie, lookupTv, hasKey = true) {
    const [startW, endW, day] = eveningWindow();
    // 1) candidats (même filtrage que Python) ; les recherches TMDB partent en parallèle (6 max)
    const cands = [];
    for (const g of chans) {
      const rank = get(g, 'pr', 999);
      for (const p of epgOf(epg, g.k)) {
        if (!(startW - 1800 <= p.start && p.start <= endW)) continue;
        const dur = (p.end - p.start) / 60;
        if (dur < 35) continue;
        const [tag, score] = classify(g, p, country, rank);
        if (score <= 0 || tag === 'Info' || tag === 'Téléfilm') continue;
        if (tag === 'Programme' && !(dur >= 85 && rank < 15)) continue;
        let kind = null;
        if (tag === 'Film' || (tag === 'Programme' && dur >= 85 && rank < 15)) kind = 'movie';
        else if (tag === 'Série') kind = 'tv';
        cands.push({ g, p, rank, tag, score, kind });
      }
    }
    const found = await pool(cands, 6, (c) => {
      if (c.kind === 'movie') return lookupMovie(c.p.title, or(get(c.p, 'desc', null), ''));
      if (c.kind === 'tv') return lookupTv(c.p.title);
      return null;
    });
    // 2) application des résultats dans l'ordre
    const picks = [];
    cands.forEach((c, i) => {
      const { g, p, rank, tag } = c;
      const item = {
        key: g.k, ch: g.t, logo: or(get(g, 'p', null), ''), title: nz(p.title),
        desc: cpSlice(or(get(p, 'desc', null), ''), 400), start: p.start, end: p.end, tag,
        score: c.score, poster: '', img: '', vote: null, year: null,
      };
      const m = found[i];
      if (c.kind === 'movie') {
        if (truthy(m)) {
          Object.assign(item, {
            tag: 'Film', poster: or(get(m, 'p', null), ''), img: or(get(m, 'b', null), ''),
            vote: get(m, 'v', null), year: get(m, 'y', null),
          });
          item.score += 15 + or(get(m, 'v', null), 0) * 3 + pyMin(15, or(get(m, 'pop', null), 0) / 5);
        } else if (truthy(hasKey) || tag !== 'Film' || rank >= 8) {
          return;                       // film inconnu de TMDB : pas assez connu pour être mis en avant
        }
      } else if (c.kind === 'tv') {
        if (truthy(m)) {
          Object.assign(item, { poster: or(get(m, 'p', null), ''), img: or(get(m, 'b', null), ''), vote: get(m, 'v', null) });
          item.score += 15 + or(get(m, 'v', null), 0) * 2;
        } else if (truthy(hasKey) || rank >= 6) {
          return;
        }
      }
      const lt = localtime(p.start);
      const h = lt.getHours() + lt.getMinutes() / 60;
      if (h >= 20.6 && h <= 21.4) item.score += 10;     // vrai début de soirée
      picks.push(item);
    });
    // un même programme sur plusieurs chaînes : on garde la meilleure chaîne
    const best = new Map();
    for (const it of picks) {
      const k = norm(it.title);
      if (!best.has(k) || it.score > best.get(k).score) best.set(k, it);
    }
    const out = [...best.values()].sort(byScoreDesc);
    return [out.slice(0, 18), day];
  }

  function guide(chans, epg, country, hoursBefore = 1, hoursAfter = 6) {
    const now = nowSec();
    const t0 = now - hoursBefore * 3600;
    const t1 = now + hoursAfter * 3600;
    const rows = [];
    for (const g of chans) {
      const progs = epgOf(epg, g.k).filter((p) => p.end > t0 && p.start < t1);
      rows.push({
        key: g.k, ch: g.t, logo: or(get(g, 'p', null), ''),
        progs: progs.map((p) => ({
          title: nz(p.title), desc: cpSlice(or(get(p, 'desc', null), ''), 300), start: p.start,
          end: p.end, tag: classify(g, p, country, 999)[0],
        })),
      });
    }
    return { t0: Math.trunc(t0), t1: Math.trunc(t1), rows };
  }

  const TEAM_SEP = /\s+(?:-|–|—|\/|vs\.?|v\.?|contre|x)\s+/i;
  /* « Ligue 1 : PSG - Marseille (direct) » -> ['PSG', 'Marseille'] ; null si ce n'est pas un match */
  function splitTeams(title) {
    const t = String(title || '').replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
    const parts = t.split(/\s*[:|]\s+/).filter(p => TEAM_SEP.test(p));
    if (!parts.length) return null;
    const teams = parts[parts.length - 1].split(new RegExp(TEAM_SEP.source, 'i')).map(x => x.replace(/^[ .\-–—]+|[ .\-–—]+$/g, ''));
    if (teams.length !== 2 || teams.some(x => x.length < 2 || x.length > 40 || /^\d+$/.test(x))) return null;
    return teams;
  }

  SH.tvguide = {
    splitTeams,
    COUNTRIES, MAJORS, PREFIX_MAP, SPORT_POP, SHOWS,
    norm, detectCountry, channelCountry, priority, popularSport,
    EpgCache, localChannels, channelEpg, classify, nowEvents, eveningWindow, tonight, guide,
    // sources des regex (contrôle de fidélité par les tests)
    _src: Object.assign({ PREFIX: PREFIX_SRC, COUNTRY_WORDS: COUNTRY_WORDS_SRC }, SRC),
  };
})(typeof window !== 'undefined' ? window : globalThis);
