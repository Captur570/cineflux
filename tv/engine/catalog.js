/*
 * Catalogue : nettoyage des noms IPTV, regroupement des doublons, appariement TMDB
 * et rangées « Découvrir » (portage des fonctions pures de cineflux.py).
 *
 * Fidèle au Python : mêmes regex (classes Unicode de `re` émulées), même difflib,
 * mêmes arrondis (round() pair), même ordre d'insertion (Map en interne).
 * Dépendances : SH.tvguide.channelCountry(rawNames, catName, key) (module tvguide.js),
 * appelée seulement par buildCatalog.
 *
 * Le cache TMDB est un objet simple, mêmes clés que TMDB_CACHE.data en Python :
 *   "m:<clé>" / "t:<clé>" -> fiche tmdbPack ou {none:true, ts}, "_genres_movie" / "_genres_tv" -> {id: nom}.
 * tmdbGet(path, params) -> Promise<json> : l'appelant ajoute la clé API, language=fr-FR par défaut,
 *   et ignore les paramètres null/undefined (comme tmdb_get en Python) ; rejette en cas d'erreur.
 */
(function (G) {
  'use strict';
  const SH = G.SH = G.SH || {};

  // ================================================================== émulation Python
  const now = () => Date.now() / 1000;                      // time.time()
  const CURRENT_YEAR = new Date(Date.now()).getFullYear();

  // espaces au sens de str.isspace() / \s de `re` (≠ \s JS : +\x1c-\x1f \x85, -﻿)
  const WSC = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const STRIP_RE = new RegExp('^[' + WSC + ']+|[' + WSC + ']+$', 'gu');
  const pyStrip = (s) => s.replace(STRIP_RE, '');
  // float() / int() n'enlèvent pas \x1c-\x1f (espaces Unicode, mais ASCII non blancs pour le C)
  const NUM_WS = WSC.replace('\\x1c-\\x20', '\\x20');
  const NUM_STRIP_RE = new RegExp('^[' + NUM_WS + ']+|[' + NUM_WS + ']+$', 'gu');

  // unicodedata.combining(c) != 0 (Unicode 15.1, tel que Python 3.13)
  const COMBINING_RE = /[\u0300-\u034e\u0350-\u036f\u0483-\u0487\u0591-\u05bd\u05bf\u05c1-\u05c2\u05c4-\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a\u07eb-\u07f3\u07fd\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0898-\u089f\u08ca-\u08e1\u08e3-\u08ff\u093c\u094d\u0951-\u0954\u09bc\u09cd\u09fe\u0a3c\u0a4d\u0abc\u0acd\u0b3c\u0b4d\u0bcd\u0c3c\u0c4d\u0c55-\u0c56\u0cbc\u0ccd\u0d3b-\u0d3c\u0d4d\u0dca\u0e38-\u0e3a\u0e48-\u0e4b\u0eb8-\u0eba\u0ec8-\u0ecb\u0f18-\u0f19\u0f35\u0f37\u0f39\u0f71-\u0f72\u0f74\u0f7a-\u0f7d\u0f80\u0f82-\u0f84\u0f86-\u0f87\u0fc6\u1037\u1039-\u103a\u108d\u135d-\u135f\u1714-\u1715\u1734\u17d2\u17dd\u18a9\u1939-\u193b\u1a17-\u1a18\u1a60\u1a75-\u1a7c\u1a7f\u1ab0-\u1abd\u1abf-\u1ace\u1b34\u1b44\u1b6b-\u1b73\u1baa-\u1bab\u1be6\u1bf2-\u1bf3\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce0\u1ce2-\u1ce8\u1ced\u1cf4\u1cf8-\u1cf9\u1dc0-\u1dff\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff\u302a-\u302f\u3099-\u309a\ua66f\ua674-\ua67d\ua69e-\ua69f\ua6f0-\ua6f1\ua806\ua82c\ua8c4\ua8e0-\ua8f1\ua92b-\ua92d\ua953\ua9b3\ua9c0\uaab0\uaab2-\uaab4\uaab7-\uaab8\uaabe-\uaabf\uaac1\uaaf6\uabed\ufb1e\ufe20-\ufe2f\u{101fd}\u{102e0}\u{10376}-\u{1037a}\u{10a0d}\u{10a0f}\u{10a38}-\u{10a3a}\u{10a3f}\u{10ae5}-\u{10ae6}\u{10d24}-\u{10d27}\u{10eab}-\u{10eac}\u{10efd}-\u{10eff}\u{10f46}-\u{10f50}\u{10f82}-\u{10f85}\u{11046}\u{11070}\u{1107f}\u{110b9}-\u{110ba}\u{11100}-\u{11102}\u{11133}-\u{11134}\u{11173}\u{111c0}\u{111ca}\u{11235}-\u{11236}\u{112e9}-\u{112ea}\u{1133b}-\u{1133c}\u{1134d}\u{11366}-\u{1136c}\u{11370}-\u{11374}\u{11442}\u{11446}\u{1145e}\u{114c2}-\u{114c3}\u{115bf}-\u{115c0}\u{1163f}\u{116b6}-\u{116b7}\u{1172b}\u{11839}-\u{1183a}\u{1193d}-\u{1193e}\u{11943}\u{119e0}\u{11a34}\u{11a47}\u{11a99}\u{11c3f}\u{11d42}\u{11d44}-\u{11d45}\u{11d97}\u{11f41}-\u{11f42}\u{16af0}-\u{16af4}\u{16b30}-\u{16b36}\u{16ff0}-\u{16ff1}\u{1bc9e}\u{1d165}-\u{1d169}\u{1d16d}-\u{1d172}\u{1d17b}-\u{1d182}\u{1d185}-\u{1d18b}\u{1d1aa}-\u{1d1ad}\u{1d242}-\u{1d244}\u{1e000}-\u{1e006}\u{1e008}-\u{1e018}\u{1e01b}-\u{1e021}\u{1e023}-\u{1e024}\u{1e026}-\u{1e02a}\u{1e08f}\u{1e130}-\u{1e136}\u{1e2ae}\u{1e2ec}-\u{1e2ef}\u{1e4ec}-\u{1e4ef}\u{1e8d0}-\u{1e8d6}\u{1e944}-\u{1e94a}]/gu;

  // zéros des chiffres décimaux Unicode (catégorie Nd) : valeur = cp - zéro
  const ND_ZEROS = [0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66,
    0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
    0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x11066,
    0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50,
    0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140,
    0x1e2f0, 0x1e4f0, 0x1e950, 0x1fbf0];
  function digitVal(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
    for (let i = ND_ZEROS.length - 1; i >= 0; i--) {
      if (ND_ZEROS[i] <= cp) return cp - ND_ZEROS[i] < 10 ? cp - ND_ZEROS[i] : -1;
    }
    return -1;
  }
  const ND_G = /\p{Nd}/gu;
  const asciiDigits = (s) => s.replace(ND_G, (d) => { const v = digitVal(d); return v < 0 ? '?' : String(v); });

  // int() d'une chaîne de chiffres capturée par \d
  const intDigits = (s) => parseInt(asciiDigits(s), 10);

  // tranche s[:n] en points de code
  function cpSlice(s, n) {
    if (!/[\ud800-\udfff]/.test(s)) return s.slice(0, n);
    return Array.from(s).slice(0, n).join('');
  }
  const cpLen = (s) => Array.from(s).length;

  // vérité au sens Python ([] et {} sont faux, NaN est vrai)
  function T(v) {
    if (v === null || v === undefined || v === false || v === '' || v === 0) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }
  const get = (o, k) => (o && o[k] !== undefined ? o[k] : null);   // dict.get(k)
  const or = (...vals) => { for (const v of vals) if (T(v)) return v; return vals[vals.length - 1]; };
  const pyMax = (a, b) => (b > a ? b : a);                          // max(a, b), NaN compris

  // repr() d'un float Python
  function floatRepr(x) {
    if (Number.isNaN(x)) return 'nan';
    if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
    const e = x.toExponential();                       // chiffres minimaux, comme repr
    const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
    const sign = m[1], digits = m[2] + (m[3] || ''), exp = parseInt(m[4], 10);
    if (exp >= -5 && exp < 16) {
      let s;
      if (exp < 0) s = '0.' + '0'.repeat(-exp - 1) + digits;
      else if (digits.length <= exp + 1) s = digits + '0'.repeat(exp + 1 - digits.length) + '.0';
      else s = digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
      return sign + s;
    }
    const mant = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
    return sign + mant + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  }
  // str(v) Python (un nombre JSON entier est traité comme un int Python)
  function pyStr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return Math.abs(v) < 1e21 ? String(v) : BigInt(v).toString();
      return floatRepr(v);
    }
    return pyRepr(v);
  }
  function pyRepr(v) {
    if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).map((k) => pyRepr(k) + ': ' + pyRepr(v[k])).join(', ') + '}';
    return pyStr(v);
  }

  // float(v) : undefined si Python lèverait TypeError / ValueError
  const FLOAT_RE = /^[+-]?(?:(?:[0-9](?:_?[0-9])*)?\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\.?)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;
  function pyFloat(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v !== 'string') return undefined;
    const s = asciiDigits(v.replace(NUM_STRIP_RE, ''));
    if (FLOAT_RE.test(s)) return Number(s.replace(/_/g, ''));
    const m = /^([+-]?)(inf|infinity|nan)$/i.exec(s);
    if (!m) return undefined;
    if (m[2].toLowerCase() === 'nan') return NaN;
    return m[1] === '-' ? -Infinity : Infinity;
  }
  // int(v) strict (lève comme Python)
  function pyInt(v) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('int(): ' + v);
      return Math.trunc(v) || 0;
    }
    if (typeof v === 'string') {
      const s = asciiDigits(v.replace(NUM_STRIP_RE, ''));
      if (/^[+-]?[0-9](?:_?[0-9])*$/.test(s)) return parseInt(s.replace(/_/g, ''), 10) || 0;
    }
    throw new Error('int(): ' + pyStr(v));
  }

  function toInt(v, def = 0) {
    const f = pyFloat(v);
    if (f === undefined || !Number.isFinite(f)) return def;   // NaN -> défaut ; inf : Python lève OverflowError
    return Math.trunc(f) || 0;
  }
  function toFloat(v, def = 0.0) {
    const f = pyFloat(v);
    return f === undefined ? def : f;
  }

  // round(x, 1) Python : arrondi exact, égalités au pair
  function round1(x) {
    if (!Number.isFinite(x)) return x;
    const q = x * 4;
    if (Number.isInteger(q) && q % 2 !== 0) {               // x = k + 0,25 / 0,75 : égalité exacte
      const r = Math.floor(x * 10);
      return (r % 2 === 0 ? r : r + 1) / 10;
    }
    return Number(x.toFixed(1));
  }

  // regex Python -> JS : \s et \d Unicode ; avec re.I, `i` couvre aussi ı et İ (équivalences de sre)
  function pyRx(src, flags = '', ic = false) {
    let out = '', cls = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[++i];
        if (n === 's') out += cls ? WSC : '[' + WSC + ']';
        else if (n === 'd') out += '\\p{Nd}';
        else out += '\\' + n;
        continue;
      }
      if (cls) {
        if (c === ']') cls = false;
        else if (ic && (c === 'i' || c === 'I')) { out += c + '\\u0131\\u0130'; continue; }
        else if (ic && c === 'z' && src[i - 1] === '-') { out += 'z\\u0131\\u0130'; continue; }
        out += c;
        continue;
      }
      if (c === '[') {
        cls = true;
        out += c;
        if (src[i + 1] === '^') { out += '^'; i++; }
        continue;
      }
      if (ic && (c === 'i' || c === 'I')) { out += '[iI\\u0131\\u0130]'; continue; }
      out += c;
    }
    return new RegExp(out, 'u' + (ic ? 'i' : '') + flags);
  }

  // difflib.SequenceMatcher(None, a, b).ratio() (autojunk compris)
  function seqRatio(a, b) {
    a = Array.from(a);
    b = Array.from(b);
    const b2j = new Map();
    b.forEach((e, i) => { let l = b2j.get(e); if (!l) b2j.set(e, l = []); l.push(i); });
    if (b.length >= 200) {
      const ntest = Math.floor(b.length / 100) + 1;
      for (const [e, l] of Array.from(b2j)) if (l.length > ntest) b2j.delete(e);
    }
    const NONE = [];
    function longest(alo, ahi, blo, bhi) {
      let bi = alo, bj = blo, bs = 0, j2len = new Map();
      for (let i = alo; i < ahi; i++) {
        const nj = new Map();
        for (const j of b2j.get(a[i]) || NONE) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) || 0) + 1;
          nj.set(j, k);
          if (k > bs) { bi = i - k + 1; bj = j - k + 1; bs = k; }
        }
        j2len = nj;
      }
      while (bi > alo && bj > blo && a[bi - 1] === b[bj - 1]) { bi--; bj--; bs++; }
      while (bi + bs < ahi && bj + bs < bhi && a[bi + bs] === b[bj + bs]) bs++;
      return [bi, bj, bs];
    }
    let matches = 0;
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = longest(alo, ahi, blo, bhi);
      if (k) {
        matches += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    const len = a.length + b.length;
    return len ? 2.0 * matches / len : 1.0;
  }

  // ================================================================== nettoyage des noms
  function stripAccents(s) {
    return String(s).normalize('NFKD').replace(COMBINING_RE, '');
  }

  function norm(s) {
    s = stripAccents(T(s) ? s : '').toLowerCase().split('&').join(' and ');
    return s.replace(/[^a-z0-9]+/g, '');
  }

  function tok(p) {
    const src = '(?<![a-z0-9])(?:' + p + ')(?![a-z0-9])';
    return [pyRx(src, '', true), pyRx(src, 'g', true)];
  }

  // (motif, catégorie, étiquette) — l'ordre compte
  const TAG_RULES = [
    [tok(String.raw`3840p|2160p|4k|uhd|ultra\s?hd`), 'q', '4K'],
    [tok(String.raw`1080[pi]|fhd|full\s?hd`), 'q', '1080p'],
    [tok(String.raw`720p|hd|hdtv`), 'q', '720p'],
    [tok(String.raw`480p|576p|sd`), 'q', 'SD'],
    [tok(String.raw`dolby\s?vision|dovi|dv`), 'h', 'DV'],
    [tok(String.raw`hdr10\+|hdr10plus|hdr10|hdr`), 'h', 'HDR'],
    [tok(String.raw`vostfr|vost|subfrench|st\s?fr`), 'l', 'VOSTFR'],
    [tok(String.raw`multi`), 'l', 'MULTI'],
    [tok(String.raw`truefrench|vff|vfq|vfi|vf2|vf|french|fr`), 'l', 'VF'],
    [tok(String.raw`vo|eng|english`), 'l', 'VO'],
    [tok(String.raw`x\.?26[45]|h\.?26[45]|hevc|avc|av1|10\s?bits?|atmos|dts(?:-?hd)?|truehd|ddp?\s?5\.1|e?ac3|aac|` +
      String.raw`web-?dl|webrip|web|bluray|blu-ray|bdrip|brrip|hdlight|remux|imax|3d|repack|proper|extended|` +
      String.raw`unrated|director'?s\s?cut|\d{2,3}\s?fps|backup|bkp|alt|raw|cam|hd-?cam|camrip|telesync|hd-?ts|` +
      String.raw`hd-?tc|ts-?rip|pdvd|screener|dvd-?scr|version\s+longue|[ée]dition\s+longue|version\s+int[ée]grale|` +
      String.raw`[ée]dition\s+sp[ée]ciale|special\s+edition|ultimate\s+(?:edition|cut)|uncut|redux|final\s+cut|` +
      String.raw`version\s+du\s+r[ée]alisateur`), 'x', null],
  ];
  const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, 'SD': 1 };
  const qrank = (q, def) => (typeof q === 'string' && Object.prototype.hasOwnProperty.call(QUALITY_RANK, q) ? QUALITY_RANK[q] : def);
  const PREFIX_RE = pyRx(String.raw`^\s*(?:\[[^\]]{1,14}\]|\|[^|]{1,14}\||\((?:[A-Z]{2,4}|4K|VF|VOSTFR|MULTI)\)|` +
    String.raw`(?:[A-Z]{2,4}|4K|UHD|FHD|HD|VOD|MULTI|VF|VOSTFR)(?:\s*[:|»>]+\s*|\s+-+\s+))\s*`);
  const SYMBOLS_RE = /[☀-➿⬀-⯿■-◿←-⇿\u{1F000}-\u{1FAFF}★☆●◉♦◆•]+/gu;
  const YEAR_BR = pyRx(String.raw`[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]`);
  const YEAR_ANY = pyRx(String.raw`(?<![0-9])((?:19|20)\d{2})(?![0-9])`, 'g');
  const EMPTY_BR = pyRx(String.raw`[\(\[]\s*[\)\]]`, 'g');
  const SPACES = pyRx(String.raw`\s+`, 'g');
  const EDGES = pyRx(String.raw`^[\s\-:|.,/]+|[\s\-:|.,/(\[]+$`, 'g');
  const count = (s, ch) => s.split(ch).length - 1;

  /** 'FR - Les évadés 4K DV (1994)' -> ['Les évadés', 1994, {q:'4K', h:'DV', l:null}] */
  function cleanTitle(raw, channel = false) {
    const rs = T(raw) ? String(raw) : '';
    let s = rs.normalize('NFKC');                    // ᴴᴰ -> HD, ³⁸⁴⁰ᴾ -> 3840P
    s = s.replace(SYMBOLS_RE, ' ');
    const tags = { q: null, h: null, l: null };
    for (const [[rx], cat, label] of TAG_RULES) {    // étiquettes lues sur le nom complet
      if (cat in tags && tags[cat] === null && rx.test(s)) tags[cat] = label;
    }
    for (let n = 0; n < 3; n++) {
      const nw = s.replace(PREFIX_RE, '');
      if (nw === s || !pyStrip(nw)) break;
      s = nw;
    }
    let year = null;
    if (!channel) {
      let m = YEAR_BR.exec(s), mv = null;
      if (m) mv = intDigits(m[1]);
      else {
        for (const c of s.matchAll(YEAR_ANY)) {
          if (c.index > 0 && intDigits(c[1]) <= CURRENT_YEAR + 1) { m = c; mv = intDigits(c[1]); }
        }
      }
      if (m && mv >= 1900 && mv <= CURRENT_YEAR + 1) {
        year = mv;
        s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      }
    }
    if (count(s, ' ') < 2 && (count(s, '.') >= 2 || count(s, '_') >= 2)) s = s.replace(/[._]/g, ' ');
    for (const [[, rxg]] of TAG_RULES) s = s.replace(rxg, ' ');
    s = s.split('|').join(' ');
    s = s.replace(EMPTY_BR, ' ');
    s = s.replace(SPACES, ' ');
    s = pyStrip(s.replace(EDGES, ''));
    if (!s) s = pyStrip(rs);
    return [s, year, tags];
  }

  function tagsLabel(tags) {
    return [get(tags, 'q'), get(tags, 'h'), get(tags, 'l')].filter(T).join(' · ');
  }

  // ================================================================== catalogue
  // raw : réponses Xtream {vod_categories, series_categories, live_categories, vod_streams, series, live_streams}
  function buildCatalog(raw, tmdbCache = {}) {
    raw = raw || {};
    const cats = {};
    for (const [kind, key] of [['movies', 'vod_categories'], ['series', 'series_categories'], ['live', 'live_categories']]) {
      const m = new Map();
      for (const c of or(raw[key], [])) {
        if (c && typeof c === 'object' && !Array.isArray(c)) m.set(pyStr(get(c, 'category_id')), pyStrip(String(or(get(c, 'category_name'), ''))));
      }
      cats[kind] = m;
    }
    const isDict = (it) => it && typeof it === 'object' && !Array.isArray(it);

    // ---- films
    const movies = new Map();
    for (const it of or(raw.vod_streams, [])) {
      if (!isDict(it)) continue;
      let [title, year, tags] = cleanTitle(or(get(it, 'name'), ''));
      year = or(year, toInt(get(it, 'year')), null);
      const tm = toInt(or(get(it, 'tmdb'), get(it, 'tmdb_id')));
      const key = tm > 0 ? 'tm' + pyStr(tm) : norm(title) + '_' + (T(year) ? pyStr(year) : '');
      let g = movies.get(key);
      if (!g) {
        g = { k: key, t: title, y: year, p: '', c: [], a: 0, r: 0.0, tm: or(tm, null), v: [] };
        movies.set(key, g);
      }
      const icon = or(get(it, 'stream_icon'), '');
      if (T(icon) && !T(g.p)) g.p = icon;
      const cid = pyStr(get(it, 'category_id'));
      if (!g.c.includes(cid)) g.c.push(cid);
      g.a = pyMax(g.a, toInt(get(it, 'added')));
      g.r = pyMax(g.r, toFloat(get(it, 'rating')));
      g.y = or(g.y, year);
      g.v.push({ id: get(it, 'stream_id'), ext: or(get(it, 'container_extension'), 'mkv'), q: tagsLabel(tags),
        rank: qrank(tags.q, 0), n: get(it, 'name') });
    }
    // ---- séries
    const series = new Map();
    for (const it of or(raw.series, [])) {
      if (!isDict(it)) continue;
      let [title, year, tags] = cleanTitle(or(get(it, 'name'), ''));
      year = or(year, toInt(cpSlice(String(or(get(it, 'releaseDate'), get(it, 'release_date'), '')), 4)), null);
      const tm = toInt(or(get(it, 'tmdb'), get(it, 'tmdb_id')));
      const key = tm > 0 ? 'tm' + pyStr(tm) : norm(title) + '_' + (T(year) ? pyStr(year) : '');
      let g = series.get(key);
      if (!g) {
        g = { k: key, t: title, y: year, p: '', bd: '', c: [], a: 0, r: 0.0, tm: or(tm, null), pl: '', g: '', s: [] };
        series.set(key, g);
      }
      if (T(get(it, 'cover')) && !T(g.p)) g.p = it.cover;
      const bd = get(it, 'backdrop_path');
      if (Array.isArray(bd) && bd.length && !T(g.bd)) g.bd = bd[0];
      g.pl = or(g.pl, or(get(it, 'plot'), ''));
      g.g = or(g.g, or(get(it, 'genre'), ''));
      const cid = pyStr(get(it, 'category_id'));
      if (!g.c.includes(cid)) g.c.push(cid);
      g.a = pyMax(g.a, toInt(get(it, 'last_modified')));
      g.r = pyMax(g.r, toFloat(get(it, 'rating')));
      g.s.push({ id: get(it, 'series_id'), q: tagsLabel(tags), n: get(it, 'name') });
    }
    // ---- chaînes
    const live = new Map();
    const names = new Map();
    for (const it of or(raw.live_streams, [])) {
      if (!isDict(it)) continue;
      const [title, , tags] = cleanTitle(or(get(it, 'name'), ''), true);
      const key = or(norm(title), pyStr(get(it, 'stream_id')));
      let g = live.get(key);
      if (!g) {
        g = { k: key, t: title, p: '', c: pyStr(get(it, 'category_id')), s: [], num: toInt(get(it, 'num'), 99999) };
        live.set(key, g);
        names.set(key, new Map());
      }
      const cnt = names.get(key);
      cnt.set(title, (cnt.get(title) || 0) + 1);
      if (T(get(it, 'stream_icon')) && !T(g.p)) g.p = it.stream_icon;
      const q = tags.q;
      const ta = pyStr(or(get(it, 'tv_archive'), '0'));
      const arc = ta !== '0' && ta !== '' ? toInt(get(it, 'tv_archive_duration')) : 0;
      const src = { id: get(it, 'stream_id'), q: or(q, ''), rank: qrank(q, 2), n: get(it, 'name'), epg: or(get(it, 'epg_channel_id'), '') };
      if (arc > 0) src.arc = arc;
      g.s.push(src);
    }
    const tvg = SH.tvguide;
    for (const [key, g] of live) {
      let best = null, bc = -1;                        // Counter.most_common(1) : premier des ex aequo
      for (const [t, c] of names.get(key)) if (c > bc) { best = t; bc = c; }
      g.t = best;
      g.s.sort((x, y) => y.rank - x.rank);
      g.cc = tvg && tvg.channelCountry
        ? tvg.channelCountry(g.s.map((x) => or(x.n, '')), cats.live.has(g.c) ? cats.live.get(g.c) : '', key)
        : null;
      const arcs = g.s.map((x) => (x.arc !== undefined ? x.arc : 0));
      if (arcs.some(T)) g.arc = arcs.reduce(pyMax);
    }

    mergeGroups(movies, 'v', 'm:', tmdbCache);
    mergeGroups(series, 's', 't:', tmdbCache);

    const used = (kind, items) => {
      const u = new Set();
      for (const i of items) for (const c of Array.isArray(i.c) ? i.c : [i.c]) u.add(c);
      const out = {};
      for (const [k, v] of cats[kind]) if (u.has(k)) out[k] = v;
      return out;
    };
    const mList = Array.from(movies.values()).sort((x, y) => y.a - x.a);
    const sList = Array.from(series.values()).sort((x, y) => y.a - x.a);
    const lList = Array.from(live.values()).sort((x, y) => x.num - y.num);
    const order = {};
    for (const k of Object.keys(cats)) order[k] = Array.from(cats[k].keys());
    return {
      movies: mList, series: sList, live: lList,
      cats: { movies: used('movies', mList), series: used('series', sList), live: used('live', lList), order },
    };
  }

  function absorb(dst, src, vkey) {
    dst[vkey].push(...src[vkey]);
    for (const c of src.c) if (!dst.c.includes(c)) dst.c.push(c);
    dst.a = pyMax(dst.a, src.a);
    dst.r = pyMax(dst.r, src.r);
    dst.y = or(dst.y, src.y);
    dst.tm = or(dst.tm, src.tm);
    for (const k of ['p', 'bd', 'pl', 'g']) {
      if (k in dst && !T(dst[k]) && T(get(src, k))) dst[k] = src[k];
    }
  }

  /** Fusionne : 1) un titre sans année avec l'unique version datée du même titre,
   *  2) les fiches qui pointent vers la même œuvre TMDB (ex. titre anglais / titre français).
   *  groups : Map clé -> fiche (modifiée sur place et renvoyée) ; un objet simple est aussi accepté. */
  function mergeGroups(groups, vkey, prefix, tmdbCache = {}) {
    const isMap = groups instanceof Map;
    const gm = isMap ? groups : new Map(Object.entries(groups));
    const byTitle = new Map();
    for (const [key, g] of gm) {
      const n = norm(g.t);
      if (!byTitle.has(n)) byTitle.set(n, []);
      byTitle.get(n).push(key);
    }
    for (const keys of byTitle.values()) {
      const undated = keys.filter((k) => !T(gm.get(k).y) && !T(gm.get(k).tm));
      const dated = keys.filter((k) => T(gm.get(k).y) || T(gm.get(k).tm));
      if (undated.length && dated.length === 1) {
        for (const k of undated) { const src = gm.get(k); gm.delete(k); absorb(gm.get(dated[0]), src, vkey); }
      }
    }
    const byTm = new Map();
    for (const key of Array.from(gm.keys())) {
      if (!gm.has(key)) continue;
      const m = tmdbCache[prefix + key];
      const tid = or(get(T(m) ? m : {}, 'id'), gm.get(key).tm);
      if (!T(tid)) continue;
      if (byTm.has(tid) && gm.has(byTm.get(tid))) {
        const src = gm.get(key);
        gm.delete(key);
        absorb(gm.get(byTm.get(tid)), src, vkey);
      } else byTm.set(tid, key);
    }
    if (vkey === 'v') for (const g of gm.values()) g.v.sort((x, y) => y.rank - x.rank);
    if (isMap) return gm;
    for (const k of Object.keys(groups)) if (!gm.has(k)) delete groups[k];
    return groups;
  }

  // ================================================================== TMDB
  const genresPending = new WeakMap();
  /** tmdb_genres : charge (une fois) la table des genres dans cache['_genres_'+kind]. */
  async function tmdbGenres(tmdbGet, cache, kind) {
    const ck = '_genres_' + kind;
    if (cache[ck] != null) return cache[ck];
    let per = genresPending.get(cache);
    if (!per) genresPending.set(cache, per = {});
    if (!per[ck]) {
      per[ck] = (async () => {
        let g;
        try {
          const res = await tmdbGet('/genre/' + kind + '/list', {});
          g = {};
          for (const x of res.genres !== undefined ? res.genres : []) {
            if (x.id === undefined || x.name === undefined) throw new Error('KeyError');
            g[pyStr(x.id)] = x.name;
          }
        } catch (e) {
          g = {};
        }
        if (cache[ck] == null) cache[ck] = g;
        delete per[ck];
        return cache[ck];
      })();
    }
    return per[ck];
  }
  const needsGenres = (cache, kind, d) => T(d) && !T(get(d, 'genres')) && cache['_genres_' + kind] == null;

  /** tmdb_pack (synchrone) : les noms de genres viennent de cache['_genres_'+kind] (voir tmdbGenres). */
  function tmdbPack(kind, d, cache = {}) {
    if (!T(d)) return null;
    const date = or(get(d, 'release_date'), get(d, 'first_air_date'), '');
    let genres;
    if (T(get(d, 'genres'))) {
      genres = d.genres.map((x) => get(x, 'name')).filter(T);
    } else {
      const gm = cache['_genres_' + kind] || {};
      const gn = (i) => { const k = pyStr(i); return Object.prototype.hasOwnProperty.call(gm, k) ? gm[k] : null; };
      genres = or(get(d, 'genre_ids'), []).map(gn).filter(T);
    }
    const ert = get(d, 'episode_run_time');
    const rt = or(get(d, 'runtime'), T(ert) ? (ert[0] === undefined ? null : ert[0]) : null);
    return {
      id: get(d, 'id'), t: or(get(d, 'title'), get(d, 'name'), ''), y: or(toInt(cpSlice(String(date), 4)), null),
      p: or(get(d, 'poster_path'), ''), b: or(get(d, 'backdrop_path'), ''), o: or(get(d, 'overview'), ''),
      v: round1(toFloat(get(d, 'vote_average'))), g: genres.slice(0, 3), rt: or(rt, null), ts: Math.floor(now()),
    };
  }
  /** tmdbPack précédé, si besoin, du chargement des genres (équivalent exact de tmdb_pack Python). */
  async function tmdbPackAsync(tmdbGet, cache, kind, d) {
    if (needsGenres(cache, kind, d)) await tmdbGenres(tmdbGet, cache, kind);
    return tmdbPack(kind, d, cache);
  }

  function score(cand, title, year) {
    const n = norm(title);
    const names = [or(get(cand, 'title'), get(cand, 'name'), ''), or(get(cand, 'original_title'), get(cand, 'original_name'), '')];
    let r = Math.max(...names.map((x) => seqRatio(n, norm(x))));
    const cy = toInt(cpSlice(String(or(get(cand, 'release_date'), get(cand, 'first_air_date'), '')), 4));
    if (T(year) && T(cy)) r += cy === year ? 0.25 : (Math.abs(cy - year) === 1 ? 0.1 : -0.25);
    const pop = toFloat(get(cand, 'popularity'));
    r += (100 < pop ? 100 : pop) / 1000;              // min(pop, 100)
    return r;
  }

  /** tmdb_resolve : fiche tmdbPack ou null. kind = 'movie' | 'tv'. Rejette si une recherche échoue. */
  async function tmdbResolve(tmdbGet, kind, title, year, tmId, cache = {}) {
    if (T(tmId)) {
      try {
        return await tmdbPackAsync(tmdbGet, cache, kind, await tmdbGet('/' + kind + '/' + pyInt(tmId), {}));
      } catch (e) { /* on tente la recherche */ }
    }
    const queries = [[title, year]];
    if (T(year)) queries.push([title, null]);
    if (title.includes(':') || title.includes(' - ')) {
      const short = pyStrip(title.split(/:| - /)[0]);
      if (cpLen(short) > 2) queries.push([short, year]);
    }
    const yp = kind === 'movie' ? 'year' : 'first_air_date_year';
    for (const [q, y] of queries) {
      const params = { query: q };
      if (T(y)) params[yp] = y;
      params.include_adult = 'false';
      const res = await tmdbGet('/search/' + kind, params);
      const cands = or(get(T(res) ? res : {}, 'results'), []);
      if (!T(cands)) continue;
      let best = null, bs = -Infinity;
      for (const c of cands.slice(0, 10)) {
        const sc = score(c, title, year);
        if (best === null || sc > bs) { best = c; bs = sc; }
      }
      if (score(best, title, year) >= 0.72) return tmdbPackAsync(tmdbGet, cache, kind, best);
    }
    return null;
  }

  function lightMeta(m) {
    if (!T(m)) return null;
    const out = {};
    for (const k of ['id', 't', 'y', 'p', 'b', 'v']) out[k] = get(m, k);
    return out;
  }

  // ================================================================== dates
  const STRP_RE = /^(\p{Nd}\p{Nd}\p{Nd}\p{Nd})-(1[0-2]|0[1-9]|[1-9])-(3[0-1]|[1-2]\p{Nd}|0[1-9]|[1-9]| [1-9])$/u;
  /** iso_ts : 'AAAA-MM-JJ…' -> timestamp de minuit local, ou null. */
  function isoTs(s) {
    if (!T(s)) return null;
    const m = STRP_RE.exec(cpSlice(String(s), 10));
    if (!m) return null;
    const y = intDigits(m[1]), mo = intDigits(m[2]), d = intDigits(pyStrip(m[3]));
    const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y < 1 || d > dim[mo - 1]) return null;
    const dt = new Date(2000, 0, 1, 0, 0, 0, 0);
    dt.setFullYear(y, mo - 1, d);
    return Math.trunc(dt.getTime() / 1000);
  }

  function ghostStatus(rel, dig) {
    const t = now();
    if (T(rel) && rel > t) return 'Prochainement';
    if (T(rel) && t - rel < 150 * 86400 && !(T(dig) && dig <= t)) return 'Au cinéma';
    return 'Indisponible';
  }

  function ymd(days) {
    const dt = new Date((now() - days * 86400) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }

  // ================================================================== découverte (TMDB × catalogue)
  /** Rangées : [id, titre, chemin TMDB, paramètres, pages max]. */
  function discoverLists(kind) {
    const today = ymd(0), y1 = ymd(365), y5 = ymd(365 * 6);
    if (kind === 'movie') {
      const D = '/discover/movie';
      const recent = () => ({ 'primary_release_date.gte': y1, 'primary_release_date.lte': today });
      return [
        ['trend', 'Tendances de la semaine', '/trending/movie/week', {}, 5],
        ['blockbusters', 'Blockbusters des 12 derniers mois', D, { ...recent(), sort_by: 'revenue.desc', 'vote_count.gte': 40 }, 5],
        ['top12', 'Les mieux notés des 12 derniers mois', D, { ...recent(), sort_by: 'vote_average.desc', 'vote_count.gte': 150 }, 5],
        ['popular', 'Populaires en ce moment', '/movie/popular', {}, 5],
        ['new', 'Sorties récentes', D, { 'primary_release_date.gte': ymd(200), 'primary_release_date.lte': today,
          sort_by: 'popularity.desc', 'vote_count.gte': 20 }, 4],
        ['fr', 'Cinéma français', D, { with_origin_country: 'FR', sort_by: 'popularity.desc',
          'primary_release_date.gte': y5, 'vote_count.gte': 30 }, 4],
        ['action', 'Action et aventure', D, { with_genres: '28|12', sort_by: 'popularity.desc', 'vote_count.gte': 300 }, 3],
        ['comedy', 'Comédies', D, { with_genres: '35', sort_by: 'popularity.desc', 'vote_count.gte': 200 }, 3],
        ['family', 'Animation et famille', D, { with_genres: '16|10751', sort_by: 'popularity.desc', 'vote_count.gte': 200 }, 3],
        ['scifi', 'Science-fiction et fantastique', D, { with_genres: '878|14', sort_by: 'popularity.desc', 'vote_count.gte': 300 }, 3],
        ['thriller', 'Thrillers et policiers', D, { with_genres: '53|80', sort_by: 'popularity.desc', 'vote_count.gte': 300 }, 3],
        ['horror', 'Frissons', D, { with_genres: '27', sort_by: 'popularity.desc', 'vote_count.gte': 200 }, 3],
        ['drama', 'Grands drames', D, { with_genres: '18', sort_by: 'popularity.desc', 'vote_count.gte': 500 }, 3],
        ['classics', 'Les incontournables', '/movie/top_rated', {}, 5],
        ['docs', 'Documentaires', D, { with_genres: '99', sort_by: 'popularity.desc', 'vote_count.gte': 30 }, 2],
      ];
    }
    const D = '/discover/tv';
    return [
      ['trend', 'Séries tendances de la semaine', '/trending/tv/week', {}, 5],
      ['top12', 'Les mieux notées du moment', D, { 'air_date.gte': y1, 'air_date.lte': today, sort_by: 'vote_average.desc',
        'vote_count.gte': 150 }, 5],
      ['popular', 'Séries populaires', '/tv/popular', {}, 5],
      ['new', "Nouvelles séries de l'année", D, { 'first_air_date.gte': y1, 'first_air_date.lte': today,
        sort_by: 'popularity.desc', 'vote_count.gte': 15 }, 4],
      ['fr', 'Séries françaises', D, { with_origin_country: 'FR', sort_by: 'popularity.desc', 'vote_count.gte': 15 }, 4],
      ['crime', 'Crime et suspense', D, { with_genres: '80|9648', sort_by: 'popularity.desc', 'vote_count.gte': 100 }, 3],
      ['scifi', 'Science-fiction et fantastique', D, { with_genres: '10765', sort_by: 'popularity.desc', 'vote_count.gte': 100 }, 3],
      ['comedy', 'Comédies', D, { with_genres: '35', sort_by: 'popularity.desc', 'vote_count.gte': 100 }, 3],
      ['drama', 'Drames', D, { with_genres: '18', sort_by: 'popularity.desc', 'vote_count.gte': 200 }, 3],
      ['anime', 'Animés', D, { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc',
        'vote_count.gte': 50 }, 3],
      ['docs', 'Documentaires et télé-réalité', D, { with_genres: '99|10764', sort_by: 'popularity.desc', 'vote_count.gte': 20 }, 2],
      ['classics', 'Séries cultes', '/tv/top_rated', {}, 5],
    ];
  }

  const ARTICLES = new Set(['le', 'la', 'les', 'l', 'the', 'a', 'an', 'un', 'une', 'des']);
  /** title_keys : clés de titre (avec puis sans article initial). Python renvoie un set : ordre fixé ici. */
  function titleKeys(title) {
    const words = stripAccents(T(title) ? title : '').toLowerCase().split('&').join(' and ').match(/[a-z0-9]+/g) || [];
    const keys = words.length ? [words.join('')] : [];
    if (words.length > 1 && ARTICLES.has(words[0])) {
      const k = words.slice(1).join('');
      if (!keys.includes(k)) keys.push(k);
    }
    return keys;
  }

  /** Index du catalogue (films ou séries) pour retrouver les fiches correspondant à un résultat TMDB. */
  class Matcher {
    constructor(items, prefix, tmdbCache = {}) {
      this.byTitle = new Map();
      this.byTm = new Map();
      for (const it of items) {
        for (const k of titleKeys(it.t)) {
          if (!this.byTitle.has(k)) this.byTitle.set(k, []);
          this.byTitle.get(k).push(it);
        }
        const c = tmdbCache[prefix + it.k];
        const m = T(c) ? c : {};
        const tids = [];
        for (const v of [get(it, 'tm'), get(m, 'id')]) if (!tids.some((x) => x === v)) tids.push(v);
        for (const tid of tids) {
          if (!T(tid)) continue;
          const i = pyInt(tid);
          if (!this.byTm.has(i)) this.byTm.set(i, []);
          this.byTm.get(i).push(it.k);
        }
      }
    }

    /** Clés du catalogue correspondant au résultat TMDB r (id d'abord, puis titre ± 1 an). */
    find(r) {
      if (r.id === undefined) throw new Error('KeyError: id');
      const keys = (this.byTm.get(pyInt(r.id)) || []).slice();
      if (keys.length) return keys;
      const ry = or(toInt(cpSlice(String(or(get(r, 'release_date'), get(r, 'first_air_date'), '')), 4)), null);
      const seen = new Set();
      for (const t of [or(get(r, 'title'), get(r, 'name')), or(get(r, 'original_title'), get(r, 'original_name'))]) {
        for (const k of titleKeys(t)) {
          for (const it of this.byTitle.get(k) || []) {
            if (seen.has(it.k)) continue;
            if (!T(it.y) || !T(ry) || Math.abs(it.y - ry) <= 1) {
              seen.add(it.k);
              keys.push(it.k);
            }
          }
        }
      }
      return keys;
    }
  }

  const GHOST_ROWS = new Set(['trend', 'blockbusters', 'top12', 'new', 'popular']);

  // Promise.all avec au plus `limit` tâches simultanées (ordre des résultats conservé)
  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
    return out;
  }

  /**
   * Rangées TMDB croisées avec le catalogue. Dans les rangées d'actualité, les titres absents
   * chez le fournisseur sont gardés (« fantômes ») pour être affichés avec un bandeau.
   * kind : 'movie' | 'series'.
   * ctx = {
   *   tmdbGet(path, params) -> Promise<json>   (voir en-tête du module)
   *   tmdbCache : objet (TMDB_CACHE.data), lu et complété sur place
   *   matcher(kind) -> Matcher                 (facultatif ; sinon construit depuis ctx.catalog)
   *   catalog : {movies, series}               (résultat de buildCatalog, si pas de ctx.matcher)
   *   saveTmdbCache() -> void | Promise         (facultatif, appelé une fois les rangées chargées)
   *   concurrency : nombre de rangées chargées en parallèle (défaut 6, comme le pool Python)
   * }
   * -> {rows: [{id, title, kind, items: [{k, also} | {g}], keys}], meta: {'m:clé': lightMeta}, ts}
   */
  async function buildDiscover(ctx, kind) {
    const cache = ctx.tmdbCache;
    const tkind = kind === 'movie' ? 'movie' : 'tv';
    const prefix = kind === 'movie' ? 'm:' : 't:';
    const matcher = ctx.matcher ? ctx.matcher(kind)
      : new Matcher(kind === 'movie' ? ctx.catalog.movies : ctx.catalog.series, prefix, cache);
    const hasId = (c) => T(c) && T(get(c, 'id'));

    async function one([rid, title, path, params, pages]) {
      const entries = [], seenIds = new Set();
      let avail = 0, res = {};
      const ghostsOk = GHOST_ROWS.has(rid);
      for (let page = 1; page <= pages; page++) {
        try {
          res = await ctx.tmdbGet(path, { page, ...params });
          if (!T(res)) res = {};
        } catch (e) {
          break;
        }
        for (const r of or(get(res, 'results'), [])) {
          const id = get(r, 'id');
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const found = matcher.find(r);
          if (found.length) {
            // genres chargés hors section critique ; vérification + écriture ensuite sans await
            if (needsGenres(cache, tkind, r) && found.some((k) => !hasId(cache[prefix + k]))) {
              await tmdbGenres(ctx.tmdbGet, cache, tkind);
            }
            let packed = null;
            for (const k of found) {
              if (!hasId(cache[prefix + k])) {
                packed = packed || tmdbPack(tkind, r, cache);
                cache[prefix + k] = packed;
              }
            }
            if (!entries.some((e) => e.k === found[0])) {
              entries.push({ k: found[0], also: found.slice(1) });
              avail += 1;
            }
          } else if (ghostsOk && T(get(r, 'poster_path')) && entries.length < 40) {
            const g = await tmdbPackAsync(ctx.tmdbGet, cache, tkind, r);
            const rel = isoTs(or(get(r, 'release_date'), get(r, 'first_air_date')));
            Object.assign(g, { kind, rel, status: ghostStatus(rel, null) });
            entries.push({ g });
          }
        }
        if (avail >= 30 || entries.length >= 40 || page >= or(get(res, 'total_pages'), 1)) break;
      }
      const keys = [];
      for (const e of entries) {
        if ('k' in e) {
          const add = e.also.filter((k) => !keys.includes(k));
          keys.push(e.k, ...add);
        }
      }
      return { id: rid, title, kind, items: entries.slice(0, 40), keys: keys.slice(0, 60) };
    }

    let rows = await mapLimit(discoverLists(kind), ctx.concurrency || 6, one);
    if (ctx.saveTmdbCache) await ctx.saveTmdbCache();
    rows = rows.filter((r) => r.keys.length >= 4 || (GHOST_ROWS.has(r.id) && r.items.length >= 6));
    const meta = {};
    for (const r of rows) {
      for (const k of r.keys) {
        const m = cache[prefix + k];
        if (hasId(m)) meta[prefix + k] = lightMeta(m);
      }
    }
    return { rows, meta, ts: Math.floor(now()) };
  }

  SH.catalog = {
    stripAccents, norm, cleanTitle, tagsLabel, toInt, toFloat, QUALITY_RANK, CURRENT_YEAR,
    buildCatalog, mergeGroups,
    tmdbGenres, tmdbPack, tmdbPackAsync, score, tmdbResolve, lightMeta,
    isoTs, ghostStatus, discoverLists, titleKeys, Matcher, GHOST_ROWS, buildDiscover,
    // utilitaires Python réutilisables ailleurs
    py: { truthy: T, str: pyStr, int: pyInt, float: pyFloat, round1, strip: pyStrip, seqRatio, mapLimit },
  };
})(typeof window !== 'undefined' ? window : globalThis);
