/*
 * Vérification des versions de films (portage de verify.py) : est-ce bien le bon film,
 * dans une version complète ?
 *
 * Indices bloquants : durée incompatible avec toutes les versions connues du film,
 * année incompatible, identifiant TMDB du fournisseur différent, mention de copie
 * cinéma (CAM, TS…) dans le nom.
 * Indice d'alerte seulement : sortie numérique pas encore passée, qui déclenche un
 * contrôle de la qualité réelle (définition, débit).
 * Horodatages en secondes Unix, durées de fichier en secondes.
 */
(function (G) {
  'use strict';
  const SH = G.SH = G.SH || {};

  // ------------------------------------------------------------------ compatibilité Python
  const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const nz = (v) => (v === undefined ? null : v);
  const get = (o, k) => (hasOwn(o, k) ? nz(o[k]) : null);
  function truthy(v) {
    if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }
  const pyMax = (a, b) => (b > a ? b : a);
  // round() de Python : arrondi au pair le plus proche
  function pyRound(x) {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
  }
  // espaces au sens de str.isspace()
  const SP = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const STRIP_RE = new RegExp(`^[${SP}]+|[${SP}]+$`, 'gu');
  const pyStrip = (s) => s.replace(STRIP_RE, '');
  // valeur d'un chiffre décimal Unicode (\d de Python) : les plages Nd vont de 0 à 9
  const ND = /\p{Nd}/u;
  function digitVal(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 48 && cp <= 57) return cp - 48;
    let s = cp;
    while (s > 0 && ND.test(String.fromCodePoint(s - 1))) s--;
    return (cp - s) % 10;
  }
  function digitsInt(s) {
    let n = 0;
    for (const ch of s) n = n * 10 + digitVal(ch);
    return n;
  }
  // int() de Python sur nombre, booléen ou chaîne
  function pyInt(v) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('int() : valeur non finie');
      return Math.trunc(v);
    }
    const s = pyStrip(String(v));
    const m = /^([+-]?)(\p{Nd}+(?:_\p{Nd}+)*)$/u.exec(s);
    if (!m) throw new Error(`int() : littéral invalide ${JSON.stringify(s)}`);
    const n = digitsInt(m[2].replace(/_/g, ''));
    return m[1] === '-' ? -n : n;
  }

  const W = '\\p{L}\\p{N}_';
  function pyRe(src, flags) {
    let out = '', cls = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[++i];
        if (cls) out += n === 'w' ? W : n === 's' ? SP : n === 'd' ? '\\p{Nd}' : '\\' + n;
        else if (n === 'b') out += `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
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
  const ci = (s) => s.replace(/[İı]/g, 'i');   // re.I de Python : İ / ı ~ i
  const search = (rx, s) => rx.test(rx.ignoreCase ? ci(s) : s);

  // ------------------------------------------------------------------ données
  // Versions connues (identifiant TMDB -> [[durée en minutes, libellé]]), en plus de la durée cinéma TMDB
  const EDITIONS = {
    120: [[178, 'Version cinéma'], [208, 'Version longue'], [228, 'Version longue (avec génériques)']],
    121: [[179, 'Version cinéma'], [223, 'Version longue'], [235, 'Version longue (avec génériques)']],
    122: [[201, 'Version cinéma'], [251, 'Version longue'], [263, 'Version longue (avec génériques)']],
    49051: [[169, 'Version cinéma'], [182, 'Version longue']],
    57158: [[161, 'Version cinéma'], [186, 'Version longue']],
    122917: [[144, 'Version cinéma'], [164, 'Version longue']],
    1495: [[144, 'Version cinéma'], [190, "Director's Cut"], [194, "Director's Cut"]],
    209112: [[151, 'Version cinéma'], [182, 'Ultimate Edition']],
    13183: [[162, 'Version cinéma'], [186, "Director's Cut"], [215, 'Ultimate Cut']],
    28: [[147, 'Version cinéma'], [196, 'Redux'], [202, 'Redux'], [183, 'Final Cut']],
    679: [[137, 'Version cinéma'], [154, 'Version longue']],
    19995: [[162, 'Version cinéma'], [171, 'Édition spéciale'], [178, 'Version longue']],
    280: [[137, 'Version cinéma'], [153, 'Édition spéciale'], [156, 'Version longue']],
    2756: [[140, 'Version cinéma'], [171, 'Édition spéciale']],
    78: [[117, 'Version cinéma'], [117, 'Final Cut']],
    581: [[181, 'Version cinéma'], [236, 'Version longue']],
    387: [[149, 'Version cinéma'], [208, "Director's Cut"], [293, 'Version intégrale']],
    311: [[229, 'Version cinéma'], [251, 'Version longue']],
    279: [[160, 'Version cinéma'], [180, "Director's Cut"]],
  };

  const EDITION_TAG_SRC = [
    ["director'?s?\\s*cut|version\\s+du\\s+r[ée]alisateur", "Director's Cut"],
    ['ultimate|uncut|unrated|non\\s+censur', 'Version intégrale'],
    ['extended|version\\s+longue|longue|[ée]dition\\s+longue', 'Version longue'],
    ['redux|final\\s*cut', 'Version remontée'],
    ['sp[ée]cial\\s+edition|[ée]dition\\s+sp[ée]ciale', 'Édition spéciale'],
  ];
  const EDITION_TAG = EDITION_TAG_SRC.map(([rx, lbl]) => [pyRe(rx, 'i'), lbl]);
  const CAM_SRC = '(?<![a-z0-9])(cam|hd-?cam|camrip|telesync|hd-?ts|ts-?rip|telecine|hd-?tc|' +
    'pdvd|pre-?dvd|dvd-?scr|screener)(?![a-z0-9])';
  const CAM_WORDS_RE = pyRe(CAM_SRC, 'i');
  const TS_RE = pyRe('(?<![a-z0-9])(TS|TC)(?![a-z0-9])');
  const YEAR_SRC = '(?<![0-9])((?:19|20)\\d{2})(?![0-9])';
  const YEAR_RE = pyRe(YEAR_SRC, 'g');
  const CLAIM_H = { '4K': 2000, '1080p': 1000, '720p': 690 };

  const DUR_HMS = pyRe('^(\\d{1,2}):(\\d{2}):(\\d{2})$');
  const DUR_MS = pyRe('^(\\d{1,3}):(\\d{2})$');
  const DUR_MIN = pyRe('^(\\d+)\\s*(min|mn|m)?$', 'i');
  const DUR_H = pyRe('^(\\d+)\\s*h\\s*(\\d+)?', 'i');

  // '02:22:00', '142 min', '8520', 8520 -> secondes
  function parseDuration(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' || typeof v === 'boolean') {
      const n = Number(v);
      return n > 0 ? Math.trunc(n) : null;
    }
    const s = pyStrip(String(v));
    let m = DUR_HMS.exec(s);
    if (m) return digitsInt(m[1]) * 3600 + digitsInt(m[2]) * 60 + digitsInt(m[3]);
    m = DUR_MS.exec(s);
    if (m) return digitsInt(m[1]) * 60 + digitsInt(m[2]);
    m = DUR_MIN.exec(ci(s));
    if (m) {
      const n = digitsInt(m[1]);
      return (m[2] || n < 400) ? n * 60 : n;
    }
    m = DUR_H.exec(ci(s));
    if (m) return digitsInt(m[1]) * 3600 + (m[2] ? digitsInt(m[2]) : 0) * 60;
    return null;
  }

  function fmtMin(m) {
    m = pyRound(m);
    if (m >= 60) {
      const r = ((m % 60) + 60) % 60;
      return `${Math.floor(m / 60)} h ${String(r).padStart(2, '0')}`;
    }
    return `${m} min`;
  }

  function editionFromName(name) {
    for (const [rx, label] of EDITION_TAG) if (search(rx, name || '')) return label;
    return null;
  }

  // durée de fichier d compatible avec une version de e minutes (accélération PAL, génériques)
  const within = (d, e) => 0.93 * e - 3 <= d && d <= e + pyMax(7, 0.07 * e);

  /*
   * name     : nom brut chez le fournisseur
   * claimedQ : '4K' / '1080p' / '720p' / 'SD' / null
   * tm       : {id, y, rt, dig, rel} (TMDB ; dig/rel = timestamps)
   * info     : {dur, h, kbps, tmdb, year} (fournisseur ou sonde)
   * -> {st: 'ok'|'bad'|'unk', why, ed, dur, h, warn}
   */
  function verifyVersion(name, claimedQ, tm, info, now) {
    now = truthy(now) ? now : Date.now() / 1000;
    tm = tm || {};
    info = info || {};
    const res = { st: 'unk', why: '', ed: null, dur: null, h: get(info, 'h'), warn: null };
    if (search(CAM_WORDS_RE, name || '') || TS_RE.test(name || '')) {
      Object.assign(res, { st: 'bad', why: "Copie filmée au cinéma (CAM / TS) d'après son nom" });
      return res;
    }
    // identifiant TMDB annoncé par le fournisseur
    if (truthy(get(info, 'tmdb')) && truthy(get(tm, 'id')) && pyInt(info.tmdb) !== pyInt(tm.id)) {
      Object.assign(res, { st: 'bad', why: 'Le fournisseur rattache ce fichier à un autre film' });
      return res;
    }
    // année dans le nom
    const ty = get(tm, 'y');
    const maxY = new Date().getFullYear() + 1;
    const years = [];
    YEAR_RE.lastIndex = 0;
    for (const m of (name || '').matchAll(YEAR_RE)) {
      const y = digitsInt(m[1]);
      if (y >= 1900 && y <= maxY) years.push(y);
    }
    if (truthy(ty) && years.length && years.every((y) => Math.abs(y - ty) > 1)) {
      Object.assign(res, { st: 'bad', why: `Fichier daté de ${years[years.length - 1]}, le film est de ${ty}` });
      return res;
    }
    // durée
    const durS = get(info, 'dur');
    const rt = get(tm, 'rt');
    const edTag = editionFromName(name);
    if (truthy(durS)) {
      const d = durS / 60;
      res.dur = pyRound(d);
      if (truthy(rt)) {
        const tid = pyInt(truthy(get(tm, 'id')) ? tm.id : 0);
        const eds = hasOwn(EDITIONS, tid) ? EDITIONS[tid] : [];
        const cands = [[rt, 'Version cinéma'], ...eds];
        const hit = cands.find(([e]) => within(d, e));
        let match = hit ? hit[1] : null;
        if (!match && edTag && 0.93 * rt - 3 <= d && d <= 1.6 * rt) match = edTag;
        if (match) {
          res.st = 'ok';
          const hasEds = hasOwn(EDITIONS, tid) || !!edTag;
          res.ed = (hasEds || match !== 'Version cinéma') ? match : null;
        } else {
          const alts = [...new Set(cands.map(([e]) => e))].sort((a, b) => a - b);
          const ref = alts.slice(0, 3).map(fmtMin).join(' ou ');
          Object.assign(res, { st: 'bad', why: `Durée ${fmtMin(d)} au lieu de ${ref}` });
          return res;
        }
      } else if (d < 40) {
        Object.assign(res, { st: 'bad', why: `Durée de ${fmtMin(d)} : fichier incomplet ou bande-annonce` });
        return res;
      }
    }
    // sortie récente : contrôle de la qualité réelle
    const rel = get(tm, 'rel'), dig = get(tm, 'dig');
    const recent = truthy(rel) && now - rel < 150 * 86400 && (!truthy(dig) || dig > now);
    if (recent) {
      const h = get(info, 'h'), kbps = get(info, 'kbps');
      const claim = hasOwn(CLAIM_H, claimedQ || '') ? CLAIM_H[claimedQ || ''] : null;
      const lowRes = truthy(h) && truthy(claim) && h < claim * 0.9;
      const lowRate = truthy(kbps) && truthy(durS) && kbps < ((truthy(h) ? h : 0) >= 1000 ? 1300 : 700);
      if (lowRes || lowRate) {
        Object.assign(res, { st: 'bad', why: 'Film encore au cinéma et qualité très faible : copie cinéma probable' });
        return res;
      }
      res.warn = 'Sortie récente : qualité non garantie';
    }
    return res;
  }

  SH.verify = {
    EDITIONS, CLAIM_H, parseDuration, fmtMin, editionFromName, verifyVersion,
    _src: { EDITION_TAG: EDITION_TAG_SRC, CAM: CAM_SRC, YEAR: YEAR_SRC },
  };
})(typeof window !== 'undefined' ? window : globalThis);
