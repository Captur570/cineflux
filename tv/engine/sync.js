/*
 * Synchronisation entre appareils par code de jumelage (portage de sync.py).
 *
 * - Un « groupe » = un secret aléatoire de 32 octets, connu seulement des appareils associés.
 * - Le serveur (Supabase) ne voit qu'un identifiant de groupe dérivé du secret, des noms
 *   d'éléments hachés et des valeurs chiffrées (AES-256-GCM).
 * - Association : code à 6 caractères, valable 10 minutes, à usage unique, qui transporte
 *   le secret chiffré avec une clé dérivée du code (PBKDF2).
 * - Détection des changements par instantanés ; le plus récent l'emporte (horodatage ms).
 *
 * Compatible au bit près avec le client Python (mêmes dérivations, sels et formats).
 * Dépendances : fetch, crypto.subtle, crypto.getRandomValues, TextEncoder/TextDecoder.
 */
(function (G) {
  'use strict';
  const SH = G.SH = G.SH || {};

  // repli quand store.js (SH.http) n'est pas chargé (tests Node)
  async function httpFallback(url, opt) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), (opt.timeout || 20) * 1000) : null;
    try {
      const r = await fetch(url, { method: opt.method, headers: opt.headers, body: opt.body, signal: ctl ? ctl.signal : undefined });
      return { status: r.status, text: await r.text() };
    } finally { if (timer) clearTimeout(timer); }
  }

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sans 0/O ni 1/I
  const PAIR_TTL = 600;
  const PAGE = 1000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const utf8 = (s) => enc.encode(s);
  // ne pas changer ces sels : partagés avec les autres clients
  const PAIR_SALT = utf8('cineflux-pairing-v1');
  const AAD_PAIR = utf8('pair');

  const cryptoObj = G.crypto;
  const subtle = cryptoObj && cryptoObj.subtle;

  class SyncError extends Error {
    constructor(msg) { super(msg); this.name = 'SyncError'; }
  }

  // ------------------------------------------------------------------ utilitaires
  function concat(...arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }

  function b64(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function unb64(s) {
    const bin = atob(String(s));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function hex(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16);
    return s;
  }

  function randomBytes(n) {
    const u = new Uint8Array(n);
    cryptoObj.getRandomValues(u);
    return u;
  }

  async function sha256(bytes) { return new Uint8Array(await subtle.digest('SHA-256', bytes)); }

  // JSON canonique (clés triées), pour l'empreinte locale des valeurs
  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }

  // empreinte locale (comparée uniquement sur le même appareil)
  async function hashValue(v) {
    return hex(await subtle.digest('SHA-1', utf8(canon(v)))).slice(0, 16);
  }

  function today() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  const same = (a, b) => canon(a) === canon(b);

  // ------------------------------------------------------------------ groupe
  class Group {
    // utiliser Group.create (l'import des clés WebCrypto est asynchrone)
    static async create(secret) {
      const g = new Group();
      g.secret = secret;
      g.gid = hex(await sha256(concat(utf8('cineflux-gid:'), secret)));
      g.gidBytes = utf8(g.gid);
      const encRaw = await sha256(concat(utf8('cineflux-enc:'), secret));
      const macRaw = await sha256(concat(utf8('cineflux-mac:'), secret));
      g.aes = await subtle.importKey('raw', encRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      g.mac = await subtle.importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return g;
    }

    async hkey(k) {
      return hex(await subtle.sign('HMAC', this.mac, utf8(k))).slice(0, 40);
    }

    async seal(obj) {
      const n = randomBytes(12);
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: this.gidBytes }, this.aes, utf8(JSON.stringify(obj)));
      return b64(concat(n, new Uint8Array(ct)));
    }

    async open(blob) {
      const raw = unb64(blob);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: this.gidBytes }, this.aes, raw.subarray(12));
      return JSON.parse(dec.decode(pt));
    }
  }

  async function codeKey(code) {
    const base = await subtle.importKey('raw', utf8(code), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: PAIR_SALT, iterations: 200000 }, base, 256);
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function codeHash(code) {
    return hex(await sha256(utf8('cineflux-pair:' + code)));
  }

  async function sealPair(code, obj) {
    const key = await codeKey(code);
    const n = randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: AAD_PAIR }, key, utf8(JSON.stringify(obj)));
    return b64(concat(n, new Uint8Array(ct)));
  }

  async function openPair(code, blob) {
    const raw = unb64(blob);
    const key = await codeKey(code);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: AAD_PAIR }, key, raw.subarray(12));
    return JSON.parse(dec.decode(pt));
  }

  function randomCode() {
    const r = randomBytes(6);
    let s = '';
    for (let i = 0; i < 6; i++) s += ALPHABET[r[i] & 31];   // 256 multiple de 32 : sans biais
    return s;
  }

  // ------------------------------------------------------------------ client
  /*
   * hooks :
   *   export() -> {cle: valeur}            état local actuel, aplati (peut renvoyer une Promise)
   *   apply(changes) -> Promise            changes = [[cle, valeur | null]] venant des autres appareils
   *   event(msg, level, kind, data)
   * store : objet persistant ; save() le fait enregistrer par l'appelant.
   */
  class SyncClient {
    constructor(url, key, store, save, hooks, interval = 15) {
      this.url = String(url || '').trim().replace(/(\/rest\/v1)?\/*$/, '');
      this.key = key || '';
      this.store = store;
      this.save = save || (() => {});
      this.hooks = hooks || {};
      this.interval = interval;
      this.running = false;
      this.last_ok = 0;
      this.last_error = '';
      this.devices = (store.devices || []).slice();
      this.group = null;
      this._lock = Promise.resolve();
      this._gen = 0;            // incrémenté à chaque changement de groupe
      this._timer = null;
      this._due = 0;
      this._busy = false;
      this._woken = false;
      if (!store.device) store.device = hex(randomBytes(8));
      if (!store.name) store.name = 'Télé Samsung';
    }

    // ---------------------------------------------------------------- état
    get configured() {
      return !!(this.url && this.key && subtle);
    }

    status() {
      return {
        configured: this.configured, crypto: !!subtle, in_group: !!this.group,
        last_ok: Math.floor(this.last_ok), error: this.last_error, devices: this.devices,
        device: this.store.device, name: this.store.name, group_name: this.store.group_name || '',
      };
    }

    // exécution exclusive (équivalent du verrou Python)
    _locked(fn) {
      const p = this._lock.then(fn);
      this._lock = p.catch(() => {});
      return p;
    }

    async _load() {
      if (!this.group && this.store.secret && subtle) {
        const gen = this._gen;
        const g = await Group.create(unb64(this.store.secret));
        if (gen === this._gen && !this.group) this.group = g;
      }
    }

    // charge le groupe enregistré (store.secret)
    init() { return this._locked(() => this._load()); }

    // ---------------------------------------------------------------- réseau
    async _rpc(fn, payload, timeout = 20) {
      const headers = { apikey: this.key, 'Content-Type': 'application/json', Accept: 'application/json' };
      if (this.key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + this.key;
      let status, txt;
      try {
        const r = await (G.SH && G.SH.http ? G.SH.http : httpFallback)(`${this.url}/rest/v1/rpc/${fn}`,
          { method: 'POST', headers, body: JSON.stringify(payload), timeout });
        status = r.status;
        txt = r.text;
      } catch (e) {
        throw new SyncError('Serveur de synchronisation injoignable');
      }
      if (!status) throw new SyncError('Serveur de synchronisation injoignable');
      if (status < 200 || status >= 300) {
        let detail = '';
        try { detail = (JSON.parse(txt) || {}).message || ''; } catch (e) { /* ignoré */ }
        if (status === 540 || status === 503 || /paused|pause/i.test(detail + txt.slice(0, 300))) throw new SyncError('Serveur de synchronisation en pause (Supabase gratuit, après une semaine sans activité) : relancez-le sur supabase.com, bouton « Restore » du projet');
        if (status === 404) throw new SyncError('Serveur de synchronisation non préparé (script SQL non exécuté ?)');
        if (status === 401 || status === 403) throw new SyncError('Clé Supabase refusée');
        throw new SyncError(`Erreur du serveur de synchronisation (${status}) ${detail}`.trim());
      }
      return txt ? JSON.parse(txt) : null;
    }

    // ---------------------------------------------------------------- groupe
    async _setGroup(secret, name) {
      const g = await Group.create(secret);
      this._gen++;
      this.group = g;
      Object.assign(this.store, { secret: b64(secret), group_name: name, cursor: null, cursor_k: '', snap: {}, devices: [], dev_day: '' });
      this.devices = [];
      this.save();
    }

    async createGroup(name = '') {
      if (!this.configured) throw new SyncError('Synchronisation non configurée');
      await this._locked(() => this._setGroup(randomBytes(32), name || 'Mon groupe'));
      this.poke();
      return this.status();
    }

    leaveGroup() {
      this._gen++;            // un cycle en cours s'interrompt
      this.group = null;
      for (const k of ['secret', 'cursor', 'cursor_k', 'snap', 'group_name', 'devices', 'dev_day']) delete this.store[k];
      this.devices = [];
      this.save();
      return this.status();
    }

    // nouvelle clé de groupe : les anciens appareils ne reçoivent plus rien
    async rotate() {
      await this.init();
      if (!this.group) throw new SyncError('Aucun groupe');
      const name = this.store.group_name || 'Mon groupe';
      await this._locked(() => this._setGroup(randomBytes(32), name));
      this.poke();
      return this.status();
    }

    // code d'association à 6 caractères, valable 10 minutes, à usage unique
    // extra : réglages transmis avec le code (identifiants IPTV pour configurer un nouvel appareil)
    async makeCode(extra) {
      await this.init();
      if (!this.group) throw new SyncError("Créez d'abord un groupe");
      const code = randomCode();
      const payload = await sealPair(code, Object.assign({ s: this.store.secret, n: this.store.group_name || '' }, extra ? { x: extra } : {}));
      await this._rpc('cf_pair_create', { p_h: await codeHash(code), p_payload: payload });
      return { code: code.slice(0, 3) + ' ' + code.slice(3), expires: Math.floor(Date.now() / 1000) + PAIR_TTL };
    }

    async join(code) {
      if (!this.configured) throw new SyncError('Synchronisation non configurée');
      code = Array.from(String(code || '').toUpperCase()).filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
      if (code.length !== 6) throw new SyncError('Le code doit contenir 6 caractères');
      const blob = await this._rpc('cf_pair_claim', { p_h: await codeHash(code) });
      if (!blob) throw new SyncError('Code inconnu, déjà utilisé ou expiré');
      let data;
      try {
        data = await openPair(code, blob);
      } catch (e) {
        throw new SyncError('Code invalide');
      }
      await this._locked(() => this._setGroup(unb64(data.s), data.n || ''));
      this.lastExtra = data.x || null;
      this.poke();
      return this.status();
    }

    renameDevice(name) {
      this.store.name = String(name || '').trim().slice(0, 40) || this.store.name;
      this.save();
      this.poke();
    }

    // ---------------------------------------------------------------- boucle
    start() {
      if (this.running) return;
      this.running = true;
      this.init().catch(() => {});
      this._schedule(4000);
    }

    async stop() {
      try {
        await this.init();
        if (this.group && this.configured) await this.cycle();
      } catch (e) { /* ignoré */ }
      this.running = false;
      if (this._timer) clearTimeout(this._timer);
      this._timer = null;
    }

    poke() {
      this._woken = true;
      // regroupe les modifications rapprochées : cycle 2 s plus tard
      if (this.running && !this._busy && this._timer && this._due - Date.now() > 2000) this._schedule(2000);
    }

    _schedule(ms) {
      if (this._timer) clearTimeout(this._timer);
      this._due = Date.now() + ms;
      this._timer = setTimeout(() => this._tick(), ms);
    }

    async _tick() {
      this._timer = null;
      if (!this.running) return;
      this._busy = true;
      this._woken = false;
      try {
        await this.init();
        if (this.group && this.configured) {
          await this.cycle();
          this.last_error = '';
          this.last_ok = Date.now() / 1000;
        }
      } catch (e) {
        this.last_error = (e && e.message) || (e && e.name) || String(e);
      }
      this._busy = false;
      if (this.running) this._schedule(this._woken ? 2000 : this.interval * 1000);
    }

    _deviceItem() {
      return ['dev/' + this.store.device, { name: this.store.name, seen: today() }];
    }

    cycle() { return this._locked(() => this._cycle()); }

    async _cycle() {
      await this._load();
      const g = this.group;
      if (!g) return;
      const gen = this._gen;
      const stale = () => gen !== this._gen;   // groupe changé/quitté pendant le cycle
      const store = this.store;
      if (!store.snap) store.snap = {};
      const snap = store.snap;
      // 1) réception d'abord : un appareil qui rejoint un groupe adopte les données existantes
      const changes = [];
      const devices = {};
      for (;;) {
        const rows = (await this._rpc('cf_pull', {
          p_gid: g.gid, p_since: store.cursor || null, p_after_k: store.cursor_k || '',
        }, 40)) || [];
        if (stale()) return;
        for (const r of rows) {
          let item;
          try { item = await g.open(r.v); } catch (e) { continue; }
          if (!item || typeof item !== 'object') continue;
          const k = item.k;
          const v = item.v === undefined ? null : item.v;
          const t = parseInt(r.ts, 10);
          if (!k) continue;
          const deleted = !!r.del || v === null;
          if (k.startsWith('dev/')) {
            if (!deleted) devices[k.slice(4)] = v;
            continue;
          }
          const old = snap[k];
          if (old && old[1] >= t) continue;           // version locale plus récente ou identique
          snap[k] = [deleted ? '-' : await hashValue(v), t];
          changes.push([k, deleted ? null : v]);
        }
        if (stale()) return;
        if (rows.length) {
          store.cursor = rows[rows.length - 1].srv;
          store.cursor_k = rows[rows.length - 1].k;
        }
        if (rows.length < PAGE) break;
      }
      if (changes.length && this.hooks.apply) await this.hooks.apply(changes);
      if (stale()) return;
      // 2) envoi des changements locaux
      const nowMs = Date.now();
      const cur = (this.hooks.export ? await this.hooks.export() : null) || {};
      const [dk, dv] = this._deviceItem();
      let out = [];
      for (const k of Object.keys(cur)) {
        const v = cur[k] === undefined ? null : cur[k];
        const h = await hashValue(v);
        const old = snap[k];
        if (!old || old[0] !== h) {
          const t = !old ? nowMs : Math.max(nowMs, old[1] + 1);
          out.push({ k: await g.hkey(k), v: await g.seal({ k, v }), d: false, t });
          snap[k] = [h, t];
        }
      }
      for (const k of Object.keys(snap).filter((x) => !Object.prototype.hasOwnProperty.call(cur, x))) {
        if (snap[k][0] === '-') continue;
        const t = Math.max(nowMs, snap[k][1] + 1);
        out.push({ k: await g.hkey(k), v: await g.seal({ k, v: null }), d: true, t });
        snap[k] = ['-', t];
      }
      const day = dv.seen + (dv.name || '');
      if (store.dev_day !== day) {
        out.push({ k: await g.hkey(dk), v: await g.seal({ k: dk, v: dv }), d: false, t: nowMs });
        store.dev_day = day;
      }
      if (stale()) return;
      for (let i = 0; i < out.length; i += 400) {
        await this._rpc('cf_push', { p_gid: g.gid, p_items: out.slice(i, i + 400) }, 40);
      }
      if (stale()) return;
      // appareils du groupe
      devices[store.device] = dv;
      const known = {};
      for (const d of this.devices) known[d.id] = d;
      for (const did of Object.keys(devices)) {
        const v = devices[did] || {};
        known[did] = { id: did, name: v.name, seen: v.seen, me: did === store.device };
      }
      this.devices = Object.values(known).sort((a, b) => {
        if (a.me !== b.me) return a.me ? -1 : 1;
        const an = a.name || '', bn = b.name || '';
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      const others = Object.keys(devices).some((d) => d !== store.device);
      if (others || !same(store.devices, this.devices)) {
        store.devices = this.devices;
        if (!out.length) out = [1];
      }
      if (changes.length && this.hooks.event) this.hooks.event('', 'info', 'sync', { n: changes.length });
      if (changes.length || out.length) this.save();
    }
  }

  SH.SyncError = SyncError;
  SH.SyncClient = SyncClient;
  SH.syncCrypto = {
    ALPHABET, PAIR_TTL, Group, SyncError, b64, unb64, hex, canon, hashValue,
    codeKey, codeHash, sealPair, openPair, randomCode,
    makeGroup: (secret) => Group.create(secret instanceof Uint8Array ? secret : unb64(secret)),
  };
})(typeof window !== 'undefined' ? window : globalThis);
