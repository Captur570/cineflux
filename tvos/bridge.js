/* ShippoTV Apple TV — pont entre JavaScriptCore et l'appli native.
 *
 * Sur Apple TV il n'y a pas de navigateur : le moteur ShippoTV (le même que sur la télé Samsung et
 * l'iPad) tourne dans JavaScriptCore, qui ne fournit que le langage. Ce fichier recrée la petite partie
 * du navigateur dont le moteur a besoin, en s'appuyant sur des fonctions natives fournies par Swift :
 *   __log(niveau, texte)          journal
 *   __timer(id, ms)               rappelle __fire(id) après ms millisecondes
 *   __native(json, cb)            réseau (cmd 'http') et stockage (cmd 'kv'), cb(erreur, résultat)
 *   __crypto(op, json) -> base64  empreintes, HMAC, PBKDF2, AES-GCM (CryptoKit / CommonCrypto)
 *   __random(n) -> base64         octets aléatoires
 *   __env                          { lang, langs }
 */
(function (G) {
  'use strict';
  G.window = G;
  G.self = G;
  G.SHIPPO_IOS = true;            // store.js : stockage et réseau natifs
  G.SHIPPO_NO_WORKER = true;

  // ------------------------------------------------------------------ journal
  const fmt = a => Array.prototype.map.call(a, x => {
    if (x instanceof Error) return x.message + (x.stack ? '\n' + x.stack : '');
    if (typeof x === 'object') { try { return JSON.stringify(x); } catch (e) { return String(x); } }
    return String(x);
  }).join(' ');
  G.console = {
    log() { __log('log', fmt(arguments)); },
    info() { __log('log', fmt(arguments)); },
    debug() {},
    warn() { __log('warn', fmt(arguments)); },
    error() { __log('error', fmt(arguments)); },
  };

  // ------------------------------------------------------------------ minuteurs
  const timers = new Map();
  let nextId = 1;
  G.__fire = function (id) {
    const t = timers.get(id);
    if (!t) return;
    if (t.every) __timer(id, t.ms); else timers.delete(id);
    try { t.fn.apply(G, t.args); } catch (e) { console.error('minuteur', e); }
  };
  G.setTimeout = function (fn, ms, ...args) {
    const id = nextId++;
    timers.set(id, { fn: typeof fn === 'function' ? fn : () => {}, args, ms: Math.max(0, +ms || 0), every: false });
    __timer(id, Math.max(0, +ms || 0));
    return id;
  };
  G.setInterval = function (fn, ms, ...args) {
    const id = nextId++;
    const d = Math.max(10, +ms || 0);
    timers.set(id, { fn, args, ms: d, every: true });
    __timer(id, d);
    return id;
  };
  G.clearTimeout = G.clearInterval = function (id) { timers.delete(id); };
  G.queueMicrotask = G.queueMicrotask || (fn => Promise.resolve().then(fn));

  // ------------------------------------------------------------------ base64
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64I = {};
  for (let i = 0; i < 64; i++) B64I[B64[i]] = i;
  function bytesToB64(u) {
    let s = '';
    let i = 0;
    for (; i + 2 < u.length; i += 3) {
      const n = (u[i] << 16) | (u[i + 1] << 8) | u[i + 2];
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i < u.length) {
      const n = (u[i] << 16) | ((i + 1 < u.length ? u[i + 1] : 0) << 8);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u.length ? B64[(n >> 6) & 63] : '=') + '=';
    }
    return s;
  }
  function b64ToBytes(s) {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor(s.length * 3 / 4));
    let o = 0;
    for (let i = 0; i < s.length; i += 4) {
      const a = B64I[s[i]], b = B64I[s[i + 1]], c = B64I[s[i + 2]], d = B64I[s[i + 3]];
      const n = (a << 18) | (b << 12) | ((c || 0) << 6) | (d || 0);
      if (o < out.length) out[o++] = (n >> 16) & 255;
      if (s[i + 2] !== undefined && o < out.length) out[o++] = (n >> 8) & 255;
      if (s[i + 3] !== undefined && o < out.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  }
  G.btoa = function (bin) {
    bin = String(bin);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      const c = bin.charCodeAt(i);
      if (c > 255) throw new Error('btoa : caractère hors Latin-1');
      u[i] = c;
    }
    return bytesToB64(u);
  };
  G.atob = function (s) {
    const u = b64ToBytes(s);
    let out = '';
    for (let i = 0; i < u.length; i += 0x8000) out += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return out;
  };

  // ------------------------------------------------------------------ UTF-8
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(str) {
      str = String(str === undefined ? '' : str);
      const out = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
          const d = str.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd;
        } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  }
  class TextDecoder {
    constructor(label) { this.label = label || 'utf-8'; }
    get encoding() { return 'utf-8'; }
    decode(buf) {
      if (!buf) return '';
      const u = buf instanceof Uint8Array ? buf : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
      let s = '';
      const chunk = [];
      const push = cp => {
        if (cp > 0xffff) { cp -= 0x10000; chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); } else chunk.push(cp);
        if (chunk.length > 8000) { s += String.fromCharCode.apply(null, chunk); chunk.length = 0; }
      };
      for (let i = 0; i < u.length;) {
        const a = u[i];
        if (a < 0x80) { push(a); i++; continue; }
        let n = 0, cp = 0;
        if (a >= 0xc2 && a <= 0xdf) { n = 1; cp = a & 31; } else if (a >= 0xe0 && a <= 0xef) { n = 2; cp = a & 15; } else if (a >= 0xf0 && a <= 0xf4) { n = 3; cp = a & 7; } else { push(0xfffd); i++; continue; }
        if (i + n > u.length - 1) { push(0xfffd); break; }
        let ok = true;
        for (let k = 1; k <= n; k++) {
          const b = u[i + k];
          if (b === undefined || (b & 0xc0) !== 0x80) { ok = false; break; }
          cp = (cp << 6) | (b & 63);
        }
        if (!ok) { push(0xfffd); i++; continue; }
        push(cp);
        i += n + 1;
      }
      if (chunk.length) s += String.fromCharCode.apply(null, chunk);
      return s;
    }
  }
  G.TextEncoder = G.TextEncoder || TextEncoder;
  G.TextDecoder = G.TextDecoder || TextDecoder;

  // ------------------------------------------------------------------ URLSearchParams / URL
  const enc = s => encodeURIComponent(s).replace(/%20/g, '+');
  const dec = s => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); } };
  class URLSearchParams {
    constructor(init) {
      this._l = [];
      if (init instanceof URLSearchParams) this._l = init._l.map(x => x.slice());
      else if (typeof init === 'string') {
        const s = init.charAt(0) === '?' ? init.slice(1) : init;
        if (s) for (const part of s.split('&')) {
          if (!part) continue;
          const i = part.indexOf('=');
          this._l.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
        }
      } else if (init && typeof init === 'object') {
        for (const k of Object.keys(init)) this._l.push([k, String(init[k])]);
      }
      this._u = null;
    }
    _touch() { if (this._u) this._u._search = this._l.length ? '?' + this.toString() : ''; }
    get(k) { const e = this._l.find(x => x[0] === k); return e ? e[1] : null; }
    getAll(k) { return this._l.filter(x => x[0] === k).map(x => x[1]); }
    has(k) { return this._l.some(x => x[0] === k); }
    set(k, v) {
      const i = this._l.findIndex(x => x[0] === k);
      if (i < 0) this._l.push([k, String(v)]);
      else { this._l[i][1] = String(v); this._l = this._l.filter((x, j) => j <= i || x[0] !== k); }
      this._touch();
    }
    append(k, v) { this._l.push([k, String(v)]); this._touch(); }
    delete(k) { this._l = this._l.filter(x => x[0] !== k); this._touch(); }
    forEach(fn, t) { for (const [k, v] of this._l) fn.call(t, v, k, this); }
    keys() { return this._l.map(x => x[0])[Symbol.iterator](); }
    values() { return this._l.map(x => x[1])[Symbol.iterator](); }
    entries() { return this._l.map(x => [x[0], x[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this._l.map(([k, v]) => enc(k) + '=' + enc(v)).join('&'); }
  }
  const DEFPORT = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
  class URL {
    constructor(url, base) {
      url = String(url).trim();
      let m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(.*)$/.exec(url);
      if (!m && base !== undefined) {
        const b = new URL(base);
        if (url.startsWith('//')) m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(.*)$/.exec(b.protocol + url);
        else if (url.startsWith('/')) m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(.*)$/.exec(b.origin + url);
        else if (url.startsWith('?')) m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(.*)$/.exec(b.origin + b.pathname + url);
        else m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(.*)$/.exec(b.origin + b.pathname.replace(/[^/]*$/, '') + url);
      }
      if (!m) throw new TypeError('URL invalide : ' + url);
      this.protocol = m[1].toLowerCase();
      let rest = m[2];
      this.hash = '';
      const hi = rest.indexOf('#');
      if (hi >= 0) { this.hash = rest.slice(hi) === '#' ? '' : rest.slice(hi); rest = rest.slice(0, hi); }
      let search = '';
      const qi = rest.indexOf('?');
      if (qi >= 0) { search = rest.slice(qi); rest = rest.slice(0, qi); }
      this.username = ''; this.password = ''; this.hostname = ''; this.port = '';
      if (rest.startsWith('//')) {
        rest = rest.slice(2);
        const si = rest.search(/[/\\]/);
        let auth = si < 0 ? rest : rest.slice(0, si);
        rest = si < 0 ? '' : rest.slice(si).replace(/\\/g, '/');
        const at = auth.lastIndexOf('@');
        if (at >= 0) {
          const cred = auth.slice(0, at);
          auth = auth.slice(at + 1);
          const ci = cred.indexOf(':');
          this.username = ci < 0 ? cred : cred.slice(0, ci);
          this.password = ci < 0 ? '' : cred.slice(ci + 1);
        }
        const pm = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(auth);
        if (!pm || !pm[1]) throw new TypeError('URL invalide : ' + url);
        this.hostname = pm[1].toLowerCase();
        this.port = pm[2] || '';
        if (this.port && DEFPORT[this.protocol] === String(+this.port)) this.port = '';
        if (this.port && !/^\d+$/.test(this.port)) throw new TypeError('URL invalide : ' + url);
        this.pathname = rest || '/';
      } else {
        this.pathname = rest;
      }
      this._search = search === '?' ? '' : search;
      this._sp = null;
    }
    get host() { return this.hostname + (this.port ? ':' + this.port : ''); }
    get origin() { return this.hostname ? this.protocol + '//' + this.host : 'null'; }
    get search() { return this._search; }
    set search(v) { v = String(v); this._search = v && v !== '?' ? (v[0] === '?' ? v : '?' + v) : ''; this._sp = null; }
    get searchParams() {
      if (!this._sp) { this._sp = new URLSearchParams(this._search); this._sp._u = this; }
      return this._sp;
    }
    get href() {
      const cred = this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '';
      return this.protocol + (this.hostname ? '//' + cred + this.host : '') + this.pathname + this._search + this.hash;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  G.URLSearchParams = G.URLSearchParams || URLSearchParams;
  G.URL = G.URL || URL;

  // ------------------------------------------------------------------ AbortController (non utilisé en natif, présent par sécurité)
  if (!G.AbortController) {
    G.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } };
  }

  // ------------------------------------------------------------------ navigateur (langue)
  const env = G.__env || {};
  G.navigator = { language: env.lang || 'fr-FR', languages: env.langs || [env.lang || 'fr-FR'], userAgent: 'ShippoTV AppleTV' };

  // ------------------------------------------------------------------ réseau et stockage natifs (même protocole que l'iPad)
  G.webkit = {
    messageHandlers: {
      native: {
        postMessage(msg) {
          return new Promise((resolve, reject) => {
            __native(JSON.stringify(msg), (err, res) => { if (err) reject(new Error(String(err))); else resolve(res); });
          });
        },
      },
    },
  };

  // ------------------------------------------------------------------ cryptographie (sous-ensemble de WebCrypto utilisé par sync.js)
  const u8 = d => {
    if (d instanceof Uint8Array) return d;
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    throw new TypeError('données binaires attendues');
  };
  const algName = a => String(typeof a === 'string' ? a : a && a.name).toUpperCase();
  const hashName = h => String(typeof h === 'string' ? h : h && h.name || 'SHA-256').toUpperCase();
  const call = (op, args) => {
    const r = __crypto(op, JSON.stringify(args));
    if (typeof r !== 'string') throw new Error('cryptographie : échec (' + op + ')');
    const b = b64ToBytes(r);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const run = fn => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e instanceof Error ? e : new Error(String(e))); } };
  const subtle = {
    importKey(format, keyData, alg, extractable, usages) {
      return run(() => {
        if (format !== 'raw') throw new Error('format de clé non pris en charge');
        const raw = u8(keyData).slice();
        return { type: 'secret', algorithm: { name: algName(alg), hash: alg && alg.hash ? hashName(alg.hash) : undefined }, usages: usages || [], _raw: raw };
      });
    },
    digest(alg, data) {
      return run(() => call('digest', { alg: hashName(alg), data: bytesToB64(u8(data)) }));
    },
    sign(alg, key, data) {
      return run(() => {
        if (algName(alg) !== 'HMAC') throw new Error('signature non prise en charge');
        return call('hmac', { hash: key.algorithm.hash || 'SHA-256', key: bytesToB64(key._raw), data: bytesToB64(u8(data)) });
      });
    },
    deriveBits(alg, key, length) {
      return run(() => {
        if (algName(alg) !== 'PBKDF2') throw new Error('dérivation non prise en charge');
        return call('pbkdf2', { hash: hashName(alg.hash), salt: bytesToB64(u8(alg.salt)), iterations: alg.iterations | 0, bits: length | 0, key: bytesToB64(key._raw) });
      });
    },
    encrypt(alg, key, data) {
      return run(() => {
        if (algName(alg) !== 'AES-GCM') throw new Error('chiffrement non pris en charge');
        return call('aesgcm_seal', { key: bytesToB64(key._raw), iv: bytesToB64(u8(alg.iv)), aad: alg.additionalData ? bytesToB64(u8(alg.additionalData)) : '', data: bytesToB64(u8(data)) });
      });
    },
    decrypt(alg, key, data) {
      return run(() => {
        if (algName(alg) !== 'AES-GCM') throw new Error('déchiffrement non pris en charge');
        return call('aesgcm_open', { key: bytesToB64(key._raw), iv: bytesToB64(u8(alg.iv)), aad: alg.additionalData ? bytesToB64(u8(alg.additionalData)) : '', data: bytesToB64(u8(data)) });
      });
    },
  };
  G.crypto = {
    subtle,
    getRandomValues(arr) {
      const b = b64ToBytes(__random(arr.byteLength));
      new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(b.subarray(0, arr.byteLength));
      return arr;
    },
  };

  // ------------------------------------------------------------------ appel du moteur depuis Swift
  // __call(chemin, corpsJSON|null, profil, cb) -> cb(erreur, résultatJSON)
  G.__call = function (path, bodyJson, prof, cb) {
    let body = null;
    try { body = bodyJson ? JSON.parse(bodyJson) : null; } catch (e) { cb('corps invalide', null); return; }
    G.ENGINE.call(path, body, prof || '').then(
      r => { let s; try { s = JSON.stringify(r === undefined ? null : r); } catch (e) { cb('réponse illisible', null); return; } cb(null, s); },
      e => cb(String((e && e.message) || e || 'Erreur'), null));
  };
})(globalThis);
