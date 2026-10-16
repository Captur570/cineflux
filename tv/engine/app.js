/* ShippoTV TV — moteur embarqué.
   Sur PC, l'interface parle à un petit serveur Python (/api/...). Sur la télé, ce fichier fournit
   exactement les mêmes routes, exécutées directement dans l'appli (window.ENGINE.call).
   Logique portée fidèlement depuis cineflux.py (connexion Xtream, catalogue, TMDB, vérification,
   guide TV, profils, reprise, « À suivre », replay, recommandations, synchronisation). */
(function (G) {
  'use strict';
  const SH = G.SH;
  const C = SH.catalog, TV = SH.tvguide, V = SH.verify;
  const DEF = G.SHIPPO_DEFAULTS || {};
  const VERSION = DEF.version || '5.1.0';
  const TMDB_API = DEF.tmdb_api || 'https://api.themoviedb.org/3';
  const CATALOG_MAX_AGE = 24 * 3600;
  const PROFILE_COLORS = ['#ff6a3d', '#3d8bff', '#2fbf71', '#b45cff', '#ffb347', '#ff4f8b', '#27c2c2'];
  const now = () => Date.now() / 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = C.norm, toInt = C.toInt, toFloat = C.toFloat;

  /* ------------------------------------------------------------------ utilitaires */
  class XtreamError extends Error { constructor(m) { super(m); this.name = 'XtreamError'; } }
  class HttpError extends Error { constructor(code) { super('HTTP ' + code); this.code = code; } }
  class NetError extends Error { constructor(m) { super(m); this.name = 'NetError'; } }

  async function fetchJson(url, opt = {}) {
    let r;
    try {
      r = await SH.http(url, { headers: opt.headers || {}, timeout: opt.timeout || 60 });
    } catch (e) {
      throw new NetError((e && e.message) || 'réseau');
    }
    if (r.status === 0) throw new NetError('réseau');
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status);
    const txt = r.text;
    if (!txt.trim()) return null;
    try { return JSON.parse(txt); } catch { const e = new Error('JSON'); e.parse = true; throw e; }
  }

  function b64decodeUtf8(v) {
    try {
      const bin = atob(v);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch { return v || ''; }
  }

  function decodeKey(obf) {
    if (!obf) return '';
    try {
      const bin = atob(obf);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ 0x5A;
      return new TextDecoder().decode(bytes);
    } catch { return ''; }
  }
  const BUILTIN_TMDB = decodeKey(DEF.tmdb_key_obf) || DEF.tmdb_key || '';

  async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    });
    await Promise.all(workers);
    return out;
  }

  /* ------------------------------------------------------------------ stockage */
  const CONFIG = new SH.Store('config', {
    server: '', username: '', password: '', tmdb_key: '', fullscreen: true, live_format: 'ts',
    country: 'auto', show_unavailable: true, tv_mode: true, profiles: [], pdata: {}, fixes: {},
    sync_url: '', sync_key: '', server_tz: '',
  });
  const TMDB_CACHE = new SH.Store('tmdb_cache', {});
  const VERIFY_CACHE = new SH.Store('verifications', {});
  const SYNC_STORE = new SH.Store('synchro', {});

  function migrateProfiles() {
    const c = CONFIG.data;
    if (!c.profiles || !c.profiles.length) {
      c.profiles = [{ id: 'p1', name: 'Moi', color: PROFILE_COLORS[0], kids: false }];
      c.pdata = { p1: { favs: [], history: [], progress: {}, notify: [], reminders: [], follow: {} } };
      CONFIG.save();
    }
  }

  function pdata(pid) {
    const c = CONFIG.data;
    if (!(pid in c.pdata)) pid = c.profiles[0].id;
    const d = c.pdata[pid] = c.pdata[pid] || {};
    for (const [k, v] of [['favs', []], ['history', []], ['progress', {}], ['notify', []], ['reminders', []], ['follow', {}]]) {
      if (d[k] === undefined) d[k] = Array.isArray(v) ? [] : {};
    }
    return d;
  }

  const tmdbKey = () => (CONFIG.data.tmdb_key || '').trim() || BUILTIN_TMDB.trim();
  const userCountry = () => {
    const cc = (CONFIG.data.country || 'auto').toUpperCase();
    return (cc === '' || cc === 'AUTO') ? TV.detectCountry() : cc;
  };

  async function tmdbGet(path, params = {}) {
    const key = tmdbKey();
    if (!key) throw new Error('Pas de clé TMDB');
    const headers = {};
    const p = Object.assign({}, params);
    if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; else p.api_key = key;
    if (p.language === undefined) p.language = 'fr-FR';
    const qs = Object.entries(p).filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    return fetchJson(TMDB_API + path + '?' + qs, { headers, timeout: 15 });
  }

  /* ------------------------------------------------------------------ Xtream */
  function parseServerInput(server, username = '', password = '') {
    let s = (server || '').trim().replace(/^"+|"+$/g, '').trim();
    if (s && !/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
    let u;
    try { u = new URL(s); } catch { return [s.replace(/\/+$/, ''), username, password]; }
    username = username || u.searchParams.get('username') || '';
    password = password || u.searchParams.get('password') || '';
    let path = u.pathname.replace(/\/+$/, '').replace(/\/(player_api|get|panel_api|xmltv)\.php$/, '');
    path = path.replace(/\/(c|stalker_portal(\/c)?|portal)$/, '');
    return [(u.protocol.toLowerCase() + '//' + u.host + path).replace(/\/+$/, ''), username, password];
  }

  const RETRY_CODES = [400, 401, 403, 404, 405, 406, 444, 451, 500, 502, 503, 512, 520, 521];
  const COMMON_PORTS = [8080, 80, 8000, 25461, 2095, 2082, 2086, 8880, 8888, 8443, 443, 2052, 25463, 8081, 8090, 1935];

  class Xtream {
    constructor(server, username, password) {
      this.raw = [server, username, password].join('\u0001');
      const r = parseServerInput(server, (username || '').trim(), (password || '').trim());
      this.server = r[0]; this.username = r[1]; this.password = r[2];
      this.output_formats = ['ts', 'm3u8'];
    }
    qs(params) {
      return Object.entries(params).filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    }
    async _get(base, params, timeout) {
      return fetchJson(`${base}/player_api.php?${this.qs(params)}`, { timeout });
    }
    async api(action, params = {}, timeout = 120) {
      const q = Object.assign({ username: this.username, password: this.password }, action ? { action } : {}, params);
      try {
        return await this._get(this.server, q, timeout);
      } catch (e) {
        if (e instanceof HttpError) throw new XtreamError(`Le serveur a répondu ${e.code}`);
        if (e instanceof NetError) throw new XtreamError(`Serveur injoignable (${e.message})`);
        if (e.parse) throw new XtreamError('Réponse illisible du serveur (identifiants ou adresse incorrects ?)');
        throw e;
      }
    }
    _bases() {
      const out = [this.server];
      try {
        const u = new URL(this.server);
        const other = u.protocol === 'http:' ? 'https:' : 'http:';
        if (u.pathname && u.pathname !== '/') out.push(u.protocol + '//' + u.host);
        out.push((other + '//' + u.host + u.pathname).replace(/\/+$/, ''));
      } catch { /* adresse invalide */ }
      return [...new Set(out)];
    }
    async login() {
      if (!this.server || !this.username) throw new XtreamError('Adresse du serveur et identifiant requis');
      const params = { username: this.username, password: this.password };
      const tried = [];
      let last = null;
      for (const base of this._bases()) {
        let info;
        try {
          info = await this._get(base, params, 20);
        } catch (e) {
          if (e instanceof HttpError) { last = `code ${e.code}`; tried.push(`${base} → ${e.code}`); continue; }
          if (e instanceof NetError) { last = `injoignable (${e.message})`; tried.push(`${base} → injoignable`); continue; }
          last = 'réponse illisible'; tried.push(`${base} → réponse non JSON`); continue;
        }
        const ui = info && typeof info === 'object' ? info.user_info : null;
        if (!ui) { last = 'réponse inattendue'; continue; }
        if (String(ui.auth ?? 1) === '0') throw new XtreamError('Identifiants refusés par le serveur');
        if (ui.status && !['active', 'actif'].includes(String(ui.status).toLowerCase())) throw new XtreamError(`Compte ${ui.status}`);
        this.server = base;
        if (ui.allowed_output_formats && ui.allowed_output_formats.length) this.output_formats = ui.allowed_output_formats;
        return info;
      }
      const found = await this._probePorts(params);
      if (found) {
        const [base, info] = found;
        const ui = info.user_info;
        if (String(ui.auth ?? 1) === '0') throw new XtreamError('Identifiants refusés par le serveur');
        this.server = base;
        CONFIG.data.server = base;
        CONFIG.save();
        this.raw = [CONFIG.data.server, CONFIG.data.username, CONFIG.data.password].join('\u0001');
        if (ui.allowed_output_formats && ui.allowed_output_formats.length) this.output_formats = ui.allowed_output_formats;
        return info;
      }
      let detail = [...new Set(tried)].join('; ').slice(0, 300);
      if (this._probeLog && this._probeLog.length) detail += '. Ports testés : ' + this._probeLog.join(', ');
      let hint = '';
      try { if (!new URL(this.server).port) hint = ' Vérifiez le port dans votre autre appli (ex. http://serveur:8080) ou collez votre lien M3U complet.'; } catch { /* rien */ }
      throw new XtreamError(`Connexion impossible (${last}). Adresses essayées : ${detail}.${hint}`);
    }
    async _probePorts(params) {
      this._probeLog = [];
      let u;
      try { u = new URL(this.server); } catch { return null; }
      if (u.port || !u.hostname) return null;
      const cands = COMMON_PORTS.map(p => `${[443, 8443].includes(p) ? 'https' : 'http'}://${u.hostname}:${p}${u.pathname.replace(/\/+$/, '')}`);
      let hit = null;
      await mapLimit(cands, 8, async base => {
        if (hit) return;
        try {
          const info = await this._get(base, params, 6);
          if (info && info.user_info) { hit = hit || [base, info]; return; }
          this._probeLog.push(`${new URL(base).port} → réponse inattendue`);
        } catch (e) {
          this._probeLog.push(`${new URL(base).port} → ${e instanceof HttpError ? e.code : 'injoignable'}`);
        }
      });
      return hit;
    }
    streamUrl(kind, sid, ext, liveFmt) {
      const u = encodeURIComponent(this.username), p = encodeURIComponent(this.password);
      if (kind === 'live') {
        let fmt = liveFmt || CONFIG.data.live_format || 'ts';
        if (!this.output_formats.includes(fmt) && this.output_formats.length) fmt = this.output_formats.includes('ts') ? 'ts' : this.output_formats[0];
        return `${this.server}/live/${u}/${p}/${sid}.${fmt}`;
      }
      const folder = kind === 'movie' ? 'movie' : 'series';
      return `${this.server}/${folder}/${u}/${p}/${sid}.${ext || 'mkv'}`;
    }
    timeshiftUrl(sid, start, minutes) {
      const u = encodeURIComponent(this.username), p = encodeURIComponent(this.password);
      let parts;
      try {
        const f = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.data.server_tz || 'Europe/Paris', year: 'numeric', month: '2-digit',
          day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        parts = Object.fromEntries(f.formatToParts(new Date(start * 1000)).map(x => [x.type, x.value]));
      } catch {
        const d = new Date(start * 1000), z = n => String(n).padStart(2, '0');
        parts = { year: d.getFullYear(), month: z(d.getMonth() + 1), day: z(d.getDate()), hour: z(d.getHours()), minute: z(d.getMinutes()) };
      }
      const stamp = `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
      return `${this.server}/timeshift/${u}/${p}/${Math.max(1, Math.trunc(minutes))}/${stamp}/${sid}.ts`;
    }
  }

  /* ------------------------------------------------------------------ application */
  const A = {
    catalog: null, catalog_ts: 0, movie_idx: {}, series_idx: {}, live_idx: {},
    xt: null, account: {}, online: null, events: [], event_id: 0, playing: false,
    play_title: '', play_since: 0, remote_play: {}, stop_cmds: {}, remote_cmds: {},
    disc_cache: {}, disc_busy: {}, now_cache: null, now_busy: null, tv_cache: {}, matchers: {},
    sinfo_cache: {}, rec_cache: {}, refreshing: false, vqueue: [], vqueued: new Set(), catalog_busy: null,
    sync: null,
  };

  function event(msg, level = 'info', kind = 'toast', data = null) {
    A.event_id += 1;
    A.events.push({ id: A.event_id, msg, level, kind, data });
    if (A.events.length > 80) A.events.splice(0, A.events.length - 80);
  }

  function client() {
    const c = CONFIG.data;
    const raw = [c.server, c.username, c.password].join('\u0001');
    if (!A.xt || A.xt.raw !== raw) A.xt = new Xtream(c.server, c.username, c.password);
    return A.xt;
  }

  async function connect() {
    let info;
    try { info = await client().login(); } catch (e) {
      if (/injoignable|Connexion impossible/.test(String(e.message))) A.online = false;
      throw e;
    }
    A.online = true;
    const ui = info.user_info || {};
    const tz = ((info.server_info || {}).timezone || '').trim();
    if (tz && CONFIG.data.server_tz !== tz) { CONFIG.data.server_tz = tz; CONFIG.save(); }
    A.account = { exp: toInt(ui.exp_date) || null, max: ui.max_connections, active: ui.active_cons, status: ui.status };
    return A.account;
  }

  const fp = () => norm(CONFIG.data.server + CONFIG.data.username);

  async function cachedRaw() {
    const raw = await SH.kv.get('catalogue_brut');
    return raw && raw._fp === fp() ? raw : null;
  }

  async function fetchRaw() {
    const xt = client();
    const actions = ['get_vod_categories', 'get_vod_streams', 'get_series_categories', 'get_series', 'get_live_categories', 'get_live_streams'];
    const res = await Promise.all(actions.map(async a => {
      try { const r = await xt.api(a); return Array.isArray(r) ? r : []; } catch { return []; }
    }));
    const r = Object.fromEntries(actions.map((a, i) => [a, res[i]]));
    const raw = {
      _fp: fp(), _ts: now(), vod_categories: r.get_vod_categories, vod_streams: r.get_vod_streams,
      series_categories: r.get_series_categories, series: r.get_series, live_categories: r.get_live_categories,
      live_streams: r.get_live_streams,
    };
    if (!['vod_streams', 'series', 'live_streams'].some(k => raw[k].length)) throw new XtreamError("Le serveur n'a renvoyé aucun contenu");
    return raw;      // seul le catalogue préparé est enregistré sur la télé (place et rapidité)
  }

  function setCatalog(cat, ts) {
    A.catalog = cat;
    A.catalog_ts = ts;
    A.movie_idx = Object.fromEntries(cat.movies.map(g => [g.k, g]));
    A.series_idx = Object.fromEntries(cat.series.map(g => [g.k, g]));
    A.live_idx = Object.fromEntries(cat.live.map(g => [g.k, g]));
    A.disc_cache = {}; A.matchers = {};
  }

  /* Préparation du catalogue dans un fil séparé (Web Worker) ; à défaut, sur place */
  function buildCatalogAsync(raw) {
    if (typeof G.Worker === 'undefined' || G.SHIPPO_NO_WORKER) return Promise.resolve(C.buildCatalog(raw, TMDB_CACHE.data));
    return new Promise(resolve => {
      let w, done = false;
      const local = () => { if (done) return; done = true; try { w && w.terminate(); } catch { /* rien */ } resolve(C.buildCatalog(raw, TMDB_CACHE.data)); };
      const timer = setTimeout(local, 180000);
      try {
        w = new G.Worker('engine/catalog-worker.js');
        w.onmessage = e => {
          clearTimeout(timer);
          if (done) return;
          if (e.data && e.data.ok) { done = true; w.terminate(); resolve(e.data.cat); } else local();
        };
        w.onerror = () => { clearTimeout(timer); local(); };
        w.postMessage({ raw, tmdb: TMDB_CACHE.data });
      } catch { clearTimeout(timer); local(); }
    });
  }

  /* Catalogue déjà préparé (prêt à afficher), enregistré à part : démarrage sans recalcul */
  const BUILT_VER = 1;
  async function cachedBuilt() {
    const b = await SH.kv.get('catalogue');
    return b && b._fp === fp() && b._v === BUILT_VER && b.cat ? b : null;
  }
  function saveBuilt(cat, ts) {
    setTimeout(async () => {
      try { if (await SH.kv.set('catalogue', { _fp: fp(), _v: BUILT_VER, _ts: ts, cat })) SH.kv.del('catalogue_brut'); } catch { /* plein */ }
    }, 4000);
  }

  async function getCatalog(force = false) {
    if (A.catalog && !force) return A.catalog;
    if (A.catalog_busy) return A.catalog_busy;
    A.catalog_busy = (async () => {
      if (!force) {
        const b = await cachedBuilt();
        if (b) { setCatalog(b.cat, b._ts || now()); return A.catalog; }
      }
      let raw = force ? null : await cachedRaw();
      if (!raw) {
        if (!A.account || !A.account.status) await connect();
        raw = await fetchRaw();
      }
      const ts = raw._ts || now();
      setCatalog(await buildCatalogAsync(raw), ts);
      saveBuilt(A.catalog, ts);
      return A.catalog;
    })();
    try { return await A.catalog_busy; } finally { A.catalog_busy = null; }
  }

  async function refreshCatalog(manual = false) {
    if (A.refreshing) return;
    A.refreshing = true;
    event('', 'info', 'refreshing', { on: true });
    try {
      if (!A.account || !A.account.status) await connect();
      const raw = await fetchRaw();
      const nw = await buildCatalogAsync(raw);
      const old = A.catalog || { movies: [], series: [], live: [] };
      const om = new Set(old.movies.map(g => g.k)), os = new Set(old.series.map(g => g.k));
      const newM = nw.movies.filter(g => !om.has(g.k)).map(g => g.k);
      const newS = nw.series.filter(g => !os.has(g.k)).map(g => g.k);
      setCatalog(nw, raw._ts);
      saveBuilt(nw, raw._ts);
      let msg = '';
      if (newM.length || newS.length) {
        const parts = [];
        if (newM.length) parts.push(`${newM.length} nouveau${newM.length > 1 ? 'x' : ''} film${newM.length > 1 ? 's' : ''}`);
        if (newS.length) parts.push(`${newS.length} nouvelle${newS.length > 1 ? 's' : ''} série${newS.length > 1 ? 's' : ''}`);
        msg = 'Catalogue mis à jour : ' + parts.join(' et ');
      } else if (manual) msg = 'Catalogue à jour';
      event(msg, 'info', 'catalog', { ts: Math.trunc(raw._ts) });
      if (old.movies.length) queueVerify(newM.slice(0, 400));
      checkNotify();
      checkNewEpisodes().catch(() => {});
    } catch (e) {
      if (manual) event(`Mise à jour impossible : ${e.message}`, 'error');
    } finally {
      A.refreshing = false;
      event('', 'info', 'refreshing', { on: false });
    }
  }

  let lastNotify = 0;
  async function background() {
    if (A.playing) return;                 // rien de lourd pendant un film (la télé est moins puissante qu'un PC)
    try {
      const c = CONFIG.data;
      if (c.server && c.username) {
        if (!A.account || !A.account.status) { try { await connect(); } catch { /* hors ligne */ } }
        if (A.catalog && A.online && now() - A.catalog_ts > CATALOG_MAX_AGE) await refreshCatalog();
        if (A.catalog && now() - lastNotify > 1800) { lastNotify = now(); checkNotify(); }
      }
    } catch { /* on réessaie plus tard */ }
  }

  function liveRanked() {
    const country = userCountry();
    for (const g of A.catalog.live) {
      g.pr = TV.priority(g.k, g.cc ?? null, country);
      g.loc = (g.cc === country || ((g.cc === null || g.cc === undefined) && g.pr < 500)) ? 1 : 0;
    }
    const live = A.catalog.live.slice().sort((a, b) => (b.loc - a.loc) || (a.pr - b.pr) || (a.num - b.num));
    return [live, country];
  }

  async function catalogPayload(force) {
    if (force) await refreshCatalog(true);
    const cat = await getCatalog();
    const [live, country] = liveRanked();
    const meta = {};
    for (const [pre, items] of [['m:', cat.movies], ['t:', cat.series]]) {
      for (const it of items) {
        const m = TMDB_CACHE.data[pre + it.k];
        if (m && m.id) meta[pre + it.k] = C.lightMeta(m);
      }
    }
    const locCats = [];
    for (const g of live) if (g.loc && !locCats.includes(g.c)) locCats.push(g.c);
    const order = cat.cats.order.live || [];
    const cats = Object.assign({}, cat.cats, { order: Object.assign({}, cat.cats.order, { live: locCats.concat(order.filter(c => !locCats.includes(c))) }) });
    return { movies: cat.movies, series: cat.series, live, cats, meta, account: A.account, verify: verifyMap(),
      ts: Math.trunc(A.catalog_ts), country };
  }

  /* ------------------------------------------------------------------ TMDB */
  async function enrich(items) {
    const hasKey = !!tmdbKey();
    const out = {}, todo = [];
    const week = 7 * 86400;
    for (const it of items.slice(0, 60)) {
      const kind = it.kind === 'movie' ? 'movie' : 'tv';
      const mk = (kind === 'movie' ? 'm:' : 't:') + String(it.key);
      const c = TMDB_CACHE.data[mk];
      if (c && (c.id || now() - (c.ts || 0) < week)) out[mk] = c.id ? c : null;
      else if (hasKey) todo.push([mk, kind, it]);
      else out[mk] = null;
    }
    await mapLimit(todo, 6, async ([mk, kind, it]) => {
      let res;
      try { res = await C.tmdbResolve(tmdbGet, kind, it.title || '', toInt(it.year) || null, it.tmdb, TMDB_CACHE.data); }
      catch { out[mk] = null; return; }
      TMDB_CACHE.data[mk] = res || { none: true, ts: Math.trunc(now()) };
      out[mk] = res;
    });
    if (todo.length) TMDB_CACHE.save();
    return out;
  }

  async function tmdbSearch(kind, query) {
    kind = kind === 'movie' ? 'movie' : 'tv';
    await C.tmdbGenres(tmdbGet, TMDB_CACHE.data, kind);
    const res = await tmdbGet(`/search/${kind}`, { query });
    return ((res || {}).results || []).slice(0, 12).map(r => C.tmdbPack(kind, r, TMDB_CACHE.data));
  }

  async function tmdbOverride(kind, key, tmId) {
    kind = kind === 'movie' ? 'movie' : 'tv';
    const m = await C.tmdbPackAsync(tmdbGet, TMDB_CACHE.data, kind, await tmdbGet(`/${kind}/${Math.trunc(tmId)}`));
    const mk = (kind === 'movie' ? 'm:' : 't:') + key;
    TMDB_CACHE.data[mk] = m;
    TMDB_CACHE.save();
    CONFIG.data.fixes = CONFIG.data.fixes || {};
    CONFIG.data.fixes[mk] = Math.trunc(tmId);
    CONFIG.save();
    if (kind === 'movie') {
      for (const v of (A.movie_idx[key] || {}).v || []) delete VERIFY_CACHE.data[String(v.id)];
      queueVerify([key], true);
    }
    return m;
  }

  async function tmdbDetails(kind, tid) {
    const tkind = kind === 'movie' ? 'movie' : 'tv';
    const ck = `md:${tkind}:${tid}`;
    const c = TMDB_CACHE.data[ck];
    if (c && now() - (c.ts || 0) < 7 * 86400) return c;
    const extra = tkind === 'movie' ? 'release_dates,videos,credits' : 'videos,credits,content_ratings';
    const d = (await tmdbGet(`/${tkind}/${Math.trunc(tid)}`, { append_to_response: extra, include_video_language: 'fr,en,null' })) || {};
    let rel = null, dig = null;
    for (const country of ((d.release_dates || {}).results || [])) {
      for (const r of country.release_dates || []) {
        const ts = C.isoTs(r.release_date);
        if (!ts) continue;
        if ([2, 3].includes(r.type)) rel = Math.min(rel || ts, ts);
        else if ([4, 5].includes(r.type)) dig = Math.min(dig || ts, ts);
      }
    }
    if (!rel) rel = C.isoTs(d.release_date || d.first_air_date);
    const vids = ((d.videos || {}).results || []).filter(v => v.site === 'YouTube');
    const keyf = v => [v.type !== 'Trailer' ? 1 : 0, v.iso_639_1 !== 'fr' ? 1 : 0, !v.official ? 1 : 0];
    vids.sort((a, b) => { const x = keyf(a), y = keyf(b); return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); });
    const cast = (((d.credits || {}).cast) || []).slice(0, 6).map(p => p.name);
    let crew = (((d.credits || {}).crew) || []).filter(p => p.job === 'Director').map(p => p.name).slice(0, 2);
    if (tkind === 'tv') crew = (d.created_by || []).map(p => p.name).slice(0, 2);
    const packed = (await C.tmdbPackAsync(tmdbGet, TMDB_CACHE.data, tkind, d)) || {};
    const rt = d.runtime || ((d.episode_run_time || [])[0]) || null;
    const res = Object.assign({}, packed, { rt, rel, dig, yt: vids.length ? vids[0].key : null, cast, dir: crew,
      seasons: d.number_of_seasons ?? null, ts: Math.trunc(now()) });
    TMDB_CACHE.data[ck] = res;
    return res;
  }

  async function tmdbInfo(kind, tid) {
    const d = Object.assign({}, await tmdbDetails(kind, tid));
    d.status = C.ghostStatus(d.rel, d.dig);
    TMDB_CACHE.save();
    return d;
  }

  async function trailer(kind, tid) {
    const d = await tmdbDetails(kind, tid);
    TMDB_CACHE.save();
    return { key: d.yt };
  }

  async function matcher(kind) {
    if (!A.matchers[kind]) {
      const cat = await getCatalog();
      A.matchers[kind] = new C.Matcher(kind === 'movie' ? cat.movies : cat.series, kind === 'movie' ? 'm:' : 't:', TMDB_CACHE.data);
    }
    return A.matchers[kind];
  }

  async function similar(kind, tid) {
    const tkind = kind === 'movie' ? 'movie' : 'tv';
    const prefix = kind === 'movie' ? 'm:' : 't:';
    const m = await matcher(kind);
    await C.tmdbGenres(tmdbGet, TMDB_CACHE.data, tkind);
    const keys = [], meta = {};
    for (const path of [`/${tkind}/${Math.trunc(tid)}/recommendations`, `/${tkind}/${Math.trunc(tid)}/similar`]) {
      let res;
      try { res = (await tmdbGet(path)) || {}; } catch { continue; }
      for (const r of res.results || []) {
        for (const k of m.find(r).slice(0, 1)) {
          if (keys.includes(k)) continue;
          keys.push(k);
          let c = TMDB_CACHE.data[prefix + k];
          if (!(c && c.id)) TMDB_CACHE.data[prefix + k] = c = C.tmdbPack(tkind, r, TMDB_CACHE.data);
          meta[prefix + k] = C.lightMeta(c);
        }
      }
      if (keys.length >= 12) break;
    }
    TMDB_CACHE.save();
    return { keys: keys.slice(0, 24), meta };
  }

  async function recs(kind, tid) {
    const tkind = kind === 'movie' ? 'movie' : 'tv';
    const ck = `${tkind}:${tid}`;
    const c = A.rec_cache[ck];
    if (c && now() - c[0] < 12 * 3600) return c[1];
    let out = [];
    for (const path of [`/${tkind}/${Math.trunc(tid)}/recommendations`, `/${tkind}/${Math.trunc(tid)}/similar`]) {
      try { out = out.concat(((await tmdbGet(path)) || {}).results || []); } catch { continue; }
      if (out.length >= 30) break;
    }
    A.rec_cache[ck] = [now(), out];
    return out;
  }

  async function forYou(prof) {
    if (!tmdbKey()) return { rows: [], meta: {} };
    const d = pdata(prof);
    const seeds = [], seen = new Set();
    for (const h of d.history || []) {
      const kind = h.kind;
      if (kind !== 'movie' && kind !== 'series') continue;
      seen.add(kind + '|' + h.key);
      const pre = kind === 'movie' ? 'm:' : 't:';
      const m = TMDB_CACHE.data[pre + (h.key || '')] || {};
      const g = (kind === 'movie' ? A.movie_idx : A.series_idx)[h.key];
      const tid = m.id || (g || {}).tm;
      if (tid && g && seeds.length < 5) seeds.push([kind, h.key, Math.trunc(tid), m.title || g.t]);
    }
    for (const f of d.favs || []) {
      const i = f.indexOf(':');
      const kind = f.slice(0, i), key = f.slice(i + 1);
      if (kind === 'movie' || kind === 'series') seen.add(kind + '|' + key);
    }
    await C.tmdbGenres(tmdbGet, TMDB_CACHE.data, 'movie').catch(() => {});
    await C.tmdbGenres(tmdbGet, TMDB_CACHE.data, 'tv').catch(() => {});
    const results = await mapLimit(seeds, 5, async sd => { try { return await recs(sd[0], sd[2]); } catch { return []; } });
    const rows = [], meta = {}, used = new Set(), score = new Map();
    for (let si = 0; si < seeds.length; si++) {
      const [kind, key, , title] = seeds[si];
      const m = await matcher(kind);
      const pre = kind === 'movie' ? 'm:' : 't:';
      const tkind = kind === 'movie' ? 'movie' : 'tv';
      const keys = [];
      (results[si] || []).forEach((r, rank) => {
        for (const k of m.find(r).slice(0, 1)) {
          if (k === key || seen.has(kind + '|' + k)) continue;
          let c = TMDB_CACHE.data[pre + k];
          if (!(c && c.id)) TMDB_CACHE.data[pre + k] = c = C.tmdbPack(tkind, r, TMDB_CACHE.data);
          meta[pre + k] = C.lightMeta(c);
          const sk = kind + '|' + k;
          score.set(sk, (score.get(sk) || 0) + 1 + (30 - Math.min(rank, 30)) / 30);
          if (!used.has(sk) && !keys.includes(k)) keys.push(k);
        }
      });
      const fresh = keys.filter(k => !used.has(kind + '|' + k));
      if (fresh.length >= 4 && rows.length < 3) {
        fresh.slice(0, 20).forEach(k => used.add(kind + '|' + k));
        rows.push({ title: `Parce que vous avez regardé « ${title} »`, kind, keys: fresh.slice(0, 20) });
      }
    }
    const top = [...score.entries()].sort((a, b) => b[1] - a[1]);
    const mix = top.filter(([, sc]) => sc > 1.6).slice(0, 20).map(([sk]) => { const i = sk.indexOf('|'); return { kind: sk.slice(0, i), key: sk.slice(i + 1) }; });
    if (mix.length >= 5) rows.unshift({ title: 'Nos suggestions pour vous', mixed: mix });
    TMDB_CACHE.save();
    return { rows, meta };
  }

  async function personSearch(q) {
    q = (q || '').trim();
    if (q.length < 3 || !tmdbKey()) return { people: [], meta: {} };
    const ck = 'person:' + norm(q);
    const c = A.rec_cache[ck];
    if (c && now() - c[0] < 86400) return c[1];
    const res = (await tmdbGet('/search/person', { query: q })) || {};
    const people = [], meta = {};
    const nq = norm(q);
    const cands = (res.results || []).slice(0, 6).filter(p => (p.popularity || 0) > 1 || norm(p.name || '') === nq);
    cands.sort((a, b) => ((norm(a.name || '') !== nq) - (norm(b.name || '') !== nq)) || ((b.popularity || 0) - (a.popularity || 0)));
    await C.tmdbGenres(tmdbGet, TMDB_CACHE.data, 'movie').catch(() => {});
    await C.tmdbGenres(tmdbGet, TMDB_CACHE.data, 'tv').catch(() => {});
    for (const p of cands.slice(0, 2)) {
      let cr;
      try { cr = (await tmdbGet(`/person/${Math.trunc(p.id)}/combined_credits`)) || {}; } catch { continue; }
      const dept = p.known_for_department || '';
      const pool = (cr.cast || []).concat((cr.crew || []).filter(x => ['Director', 'Creator', 'Screenplay', 'Writer'].includes(x.job)));
      pool.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      const got = { movie: [], series: [] };
      for (const r of pool) {
        const kind = r.media_type === 'movie' ? 'movie' : r.media_type === 'tv' ? 'series' : null;
        if (!kind || /^(self|lui-même|elle-même|himself|herself)/.test((r.character || '').toLowerCase())) continue;
        const pre = kind === 'movie' ? 'm:' : 't:';
        for (const k of (await matcher(kind)).find(r).slice(0, 1)) {
          if (got[kind].includes(k)) continue;
          got[kind].push(k);
          let cc = TMDB_CACHE.data[pre + k];
          if (!(cc && cc.id)) TMDB_CACHE.data[pre + k] = cc = C.tmdbPack(kind === 'movie' ? 'movie' : 'tv', r, TMDB_CACHE.data);
          meta[pre + k] = C.lightMeta(cc);
        }
      }
      if (got.movie.length || got.series.length) {
        const roles = { Acting: p.gender !== 1 ? 'Acteur' : 'Actrice', Directing: 'Réalisation', Writing: 'Scénario' };
        people.push({ id: p.id, name: p.name, img: p.profile_path || '', role: roles[dept] || dept,
          movies: got.movie.slice(0, 40), series: got.series.slice(0, 20) });
      }
    }
    TMDB_CACHE.save();
    const out = { people, meta };
    A.rec_cache[ck] = [now(), out];
    return out;
  }

  async function discover(kind, force) {
    kind = kind === 'movie' ? 'movie' : 'series';
    if (!tmdbKey()) return { rows: [], meta: {}, no_key: true };
    const c = A.disc_cache[kind];
    if (c && !force && now() - c.ts < 6 * 3600) return c;
    if (A.disc_busy[kind]) return A.disc_busy[kind];
    A.disc_busy[kind] = (async () => {
      await getCatalog();
      await matcher(kind);
      const res = await C.buildDiscover({ tmdbGet, tmdbCache: TMDB_CACHE.data, matcher: k => A.matchers[k],
        catalog: A.catalog, saveTmdbCache: () => TMDB_CACHE.save(), concurrency: 6 }, kind);
      A.disc_cache[kind] = res;
      if (kind === 'movie') {
        const keys = [];
        for (const r of res.rows) for (const k of r.keys || []) if (!keys.includes(k)) keys.push(k);
        queueVerify(keys);
      }
      return res;
    })();
    try { return await A.disc_busy[kind]; } finally { A.disc_busy[kind] = null; }
  }

  /* ------------------------------------------------------------------ vérification des versions */
  function verifyMap() {
    const out = {};
    for (const [vid, r] of Object.entries(VERIFY_CACHE.data)) out[vid] = [r.st, r.why || '', r.ed || '', r.dur ?? null, r.warn || ''];
    return out;
  }

  function queueVerify(keys, front) {
    if (!tmdbKey()) return;
    for (const k of keys) {
      if (A.vqueued.has(k)) continue;
      A.vqueued.add(k);
      if (front) A.vqueue.unshift(k); else A.vqueue.push(k);
    }
    runVerify();
  }

  let verifying = false;
  async function runVerify() {
    if (verifying) return;
    verifying = true;
    try {
      while (A.vqueue.length) {
        if (A.playing) { await sleep(5000); continue; }        // la lecture passe avant (télé moins puissante)
        const key = A.vqueue.shift();
        try {
          const changed = await verifyGroup(key);
          if (changed && Object.keys(changed).length) event('', 'info', 'verify', changed);
        } catch { /* on passe au suivant */ } finally { A.vqueued.delete(key); }
        await sleep(250);
      }
    } finally { verifying = false; }
  }

  async function vodTech(vid) {
    const info = (await client().api('get_vod_info', { vod_id: vid }, 20)) || {};
    let i = info.info || {};
    if (Array.isArray(i)) i = {};
    const video = i.video && typeof i.video === 'object' && !Array.isArray(i.video) ? i.video : {};
    const md = info.movie_data || {};
    return { dur: V.parseDuration(i.duration_secs) || V.parseDuration(i.duration) || V.parseDuration(i.episode_run_time),
      h: toInt(video.height) || null, kbps: toInt(i.bitrate) || null, tmdb: toInt(i.tmdb_id || i.tmdb) || null,
      ext: md.container_extension };
  }

  async function verifyGroup(key) {
    const g = A.movie_idx[key];
    if (!g) return {};
    let m = TMDB_CACHE.data['m:' + key];
    if (!(m && m.id)) {
      try { m = await C.tmdbResolve(tmdbGet, 'movie', g.t, g.y, g.tm, TMDB_CACHE.data); } catch { return {}; }
      TMDB_CACHE.data['m:' + key] = m || { none: true, ts: Math.trunc(now()) };
    }
    if (!(m && m.id)) return {};
    const md = await tmdbDetails('movie', m.id);
    const tm = { id: m.id, y: md.y || m.y, rt: md.rt, rel: md.rel, dig: md.dig };
    const changed = {};
    for (const v of g.v) {
      const sv = String(v.id);
      const c = VERIFY_CACHE.data[sv];
      const fresh = c && c.tm === tm.id && now() - (c.ts || 0) < 30 * 86400;
      const recent = tm.rel && now() - tm.rel < 150 * 86400;
      if (fresh && !(recent && now() - (c.ts || 0) > 3 * 86400)) continue;
      let info;
      try { info = await vodTech(v.id); } catch { info = {}; }
      const q = (v.q || '').split(' · ').find(t => t in C.QUALITY_RANK) || null;
      const r = V.verifyVersion(v.n || '', q, tm, info);
      r.tm = tm.id; r.ts = Math.trunc(now());
      VERIFY_CACHE.data[sv] = r;
      changed[sv] = [r.st, r.why || '', r.ed || '', r.dur ?? null, r.warn || ''];
    }
    if (Object.keys(changed).length) { VERIFY_CACHE.save(); TMDB_CACHE.save(); }
    return changed;
  }

  function groupAvailable(kind, key) {
    if (kind === 'movie') {
      const g = A.movie_idx[key];
      if (!g) return false;
      return g.v.some(v => (VERIFY_CACHE.data[String(v.id)] || {}).st !== 'bad');
    }
    return key in A.series_idx;
  }

  function checkNotify() {
    if (!A.catalog) return;
    const byTm = { movie: {}, tv: {} };
    for (const [pre, kind, items] of [['m:', 'movie', A.catalog.movies], ['t:', 'tv', A.catalog.series]]) {
      for (const it of items) {
        const m = TMDB_CACHE.data[pre + it.k] || {};
        for (const tid of new Set([m.id, it.tm])) if (tid) byTm[kind][Math.trunc(tid)] = it.k;
      }
    }
    let dirty = false;
    for (const [pid, d] of Object.entries(CONFIG.data.pdata)) {
      const keep = [];
      for (const n of d.notify || []) {
        const kind = n.kind === 'movie' ? 'movie' : 'tv';
        const key = byTm[kind][toInt(n.id)];
        if (key && groupAvailable(kind === 'movie' ? 'movie' : 'series', key)) {
          event(`« ${n.title} » est maintenant disponible !`, 'info', 'avail', { profile: pid, kind: kind === 'movie' ? 'movie' : 'series', key });
          dirty = true;
        } else keep.push(n);
      }
      d.notify = keep;
    }
    if (dirty) CONFIG.save();
  }

  /* ------------------------------------------------------------------ télévision */
  async function epg(sid, limit = 4) {
    const res = (await client().api('get_short_epg', { stream_id: sid, limit }, 15)) || {};
    return (res.epg_listings || []).map(e => ({ title: b64decodeUtf8(e.title).trim(), desc: b64decodeUtf8(e.description).trim(),
      start: toInt(e.start_timestamp), end: toInt(e.stop_timestamp) }));
  }
  const epgc = new TV.EpgCache((sid, limit) => epg(sid, limit), 900);

  async function localEpg(n = 45) {
    await getCatalog();
    const [live, country] = liveRanked();
    const chans = TV.localChannels(live, country, n);
    return [chans, await TV.channelEpg(epgc, chans, 16), country];
  }

  async function liveNow(force) {
    const c = A.now_cache;
    if (c && !force && now() - c.ts < 240) return c;
    if (A.now_busy) return A.now_busy;
    A.now_busy = (async () => {
      const [chans, ep, country] = await localEpg();
      const [events, nowmap] = TV.nowEvents(chans, ep, country);
      if (tmdbKey()) {
        for (const e of events.filter(x => x.tag === 'Film').slice(0, 5)) {
          const m = await lookupMovie(e.title, e.desc || '');
          if (m && m.b) e.img = m.b;
        }
      }
      if (tmdbKey()) {
        for (const e of events.slice(0, 30).filter(x => (x.tag === 'Série' || x.tag === 'Émission') && !x.img).slice(0, 6)) {
          const m = await lookupTv(e.title);
          if (m && m.b) e.img = m.b;
        }
      }
      await addTeamBadges(events.slice(0, 30)).catch(() => {});
      A.now_cache = { events: events.slice(0, 30), now: nowmap, ts: Math.trunc(now()), country };
      return A.now_cache;
    })();
    try { return await A.now_busy; } finally { A.now_busy = null; }
  }

  async function tonight(force) {
    const c = A.tv_cache.tonight;
    if (c && !force && now() - c.ts < 1200) return c;
    const [chans, ep, country] = await localEpg();
    const hasKey = !!tmdbKey();
    const [items, day] = await TV.tonight(chans, ep, country, hasKey ? lookupMovie : async () => null,
      hasKey ? lookupTv : async () => null, hasKey);
    await addTeamBadges(items).catch(() => {});
    TMDB_CACHE.save();
    const out = { items, day: Math.trunc(day), ts: Math.trunc(now()), country };
    A.tv_cache.tonight = out;
    return out;
  }

  async function guide() {
    const [chans, ep, country] = await localEpg(40);
    return TV.guide(chans, ep, country);
  }

  /* Écussons des équipes pour les matchs sans image (TheSportsDB, gratuit), en cache 30 jours */
  const SPORTSDB = (G.SHIPPO_SPORTSDB || 'https://www.thesportsdb.com/api/v1/json/3');
  async function teamBadge(name) {
    const ck = 'sdb:' + norm(name);
    const c = TMDB_CACHE.data[ck];
    if (c && now() - (c.ts || 0) < (c.b ? 30 : 7) * 86400) return c.b || null;
    let d;
    try {
      const r = await SH.http(SPORTSDB + '/searchteams.php?t=' + encodeURIComponent(name), { timeout: 8 });
      if (r.status !== 200) return null;
      d = JSON.parse(r.text || '{}');
    } catch { return null; }
    const t = ((d && d.teams) || [])[0] || {};
    const b = t.strBadge || t.strTeamBadge || null;
    TMDB_CACHE.data[ck] = { b, ts: Math.trunc(now()) };
    return b;
  }
  async function addTeamBadges(events, limit = 12) {
    const jobs = [];
    for (const e of events) {
      if (e.tag !== 'Sport' || e.img) continue;
      const tm = TV.splitTeams(e.title);
      if (tm) jobs.push([e, tm]);
    }
    const sel = jobs.slice(0, limit);
    const names = [...new Set(sel.flatMap(([, tm]) => tm))];
    if (!names.length) return;
    const found = Object.fromEntries(await Promise.all(names.map(async n => [n, await teamBadge(n)])));
    for (const [e, tm] of sel) e.teams = tm.map(n => ({ n, b: found[n] || null }));
    TMDB_CACHE.save();
  }

  async function lookupMovie(title, desc = '') {
    const t = (title || '').replace(/\s*[([].*?[)\]]\s*$/, '').trim();
    const ck = 'epgm:' + norm(t);
    const c = TMDB_CACHE.data[ck];
    if (c !== undefined && c !== null && now() - (c.ts || 0) < 30 * 86400) return c.id ? c : null;
    const ym = /(?<![\p{L}\p{N}_])(19|20)\d{2}(?![\p{L}\p{N}_])/u.exec(desc || '');
    const year = ym ? parseInt(ym[0], 10) : null;
    let res = null;
    try {
      await C.tmdbGenres(tmdbGet, TMDB_CACHE.data, 'movie');
      const r = (((await tmdbGet('/search/movie', Object.assign({ query: t }, year ? { year } : {}))) || {}).results) || [];
      if (r.length) {
        const best = r[0];
        const names = [best.title || '', best.original_title || ''];
        if (Math.max(...names.map(x => C.py.seqRatio(norm(t), norm(x)))) > 0.82) {
          res = C.tmdbPack('movie', best, TMDB_CACHE.data);
          res.pop = toFloat(best.popularity);
          if (toInt(best.vote_count) < 150) res.v = 0;
        }
      }
    } catch { return null; }
    TMDB_CACHE.data[ck] = res || { none: true, ts: Math.trunc(now()) };
    return res;
  }

  async function lookupTv(title) {
    let t = (title || '').replace(/\s*[([].*?[)\]]\s*$/, '').trim();
    t = t.split(/\s+[-:]\s+|\s+S\d+/)[0];
    const ck = 'epgt:' + norm(t);
    const c = TMDB_CACHE.data[ck];
    if (c !== undefined && c !== null && now() - (c.ts || 0) < 30 * 86400) return c.id ? c : null;
    let res = null;
    try {
      await C.tmdbGenres(tmdbGet, TMDB_CACHE.data, 'tv');
      const r = (((await tmdbGet('/search/tv', { query: t })) || {}).results) || [];
      if (r.length && toInt(r[0].vote_count) >= 80 && C.py.seqRatio(norm(t), norm(r[0].name || '')) > 0.85) {
        res = C.tmdbPack('tv', r[0], TMDB_CACHE.data);
      }
    } catch { return null; }
    TMDB_CACHE.data[ck] = res || { none: true, ts: Math.trunc(now()) };
    return res;
  }

  /* ------------------------------------------------------------------ séries / films (fournisseur) */
  async function seriesInfo(sid) {
    const info = (await client().api('get_series_info', { series_id: sid })) || {};
    const meta = (info.info && !Array.isArray(info.info)) ? info.info : {};
    const show = C.cleanTitle(meta.name || '')[0];
    let epsRaw = info.episodes || {};
    if (Array.isArray(epsRaw)) epsRaw = Object.fromEntries(epsRaw.map((v, i) => [String(i + 1), v]));
    const seasons = {};
    for (const [snum, eps] of Object.entries(epsRaw)) {
      const lst = [];
      for (const e of eps || []) {
        let ei = e.info || {};
        if (Array.isArray(ei)) ei = {};
        let t = e.title || '';
        const m = /S\d+\s*E\d+\s*[-:.]?\s*(.*)$/i.exec(t);
        t = (m ? m[1] : t).replace(/^[ \-:]+|[ \-:]+$/g, '');
        if (show && norm(t) === norm(show)) t = '';
        const num = toInt(e.episode_num, lst.length + 1);
        lst.push({ id: e.id, n: num, t: t || `Épisode ${num}`, ext: e.container_extension || 'mkv',
          img: ei.movie_image || ei.cover_big || '', plot: ei.plot || ei.overview || '', dur: ei.duration || '' });
      }
      lst.sort((a, b) => a.n - b.n);
      const sk = String(toInt(snum, null) ?? snum);
      seasons[sk] = lst;
    }
    const key = s => { const n = toInt(s, 999); return [n === 0 ? 1 : 0, n]; };
    const order = Object.keys(seasons).sort((a, b) => { const x = key(a), y = key(b); return (x[0] - y[0]) || (x[1] - y[1]); });
    const bd = meta.backdrop_path;
    return { seasons: order, episodes: seasons, info: { plot: meta.plot || '', cast: meta.cast || '', genre: meta.genre || '',
      director: meta.director || '', rating: meta.rating || '', backdrop: Array.isArray(bd) && bd.length ? bd[0] : '' } };
  }

  async function seriesCached(sid, maxAge = 1800) {
    const c = A.sinfo_cache[String(sid)];
    if (c && now() - c[0] < maxAge) return c[1];
    const d = await seriesInfo(sid);
    A.sinfo_cache[String(sid)] = [now(), d];
    return d;
  }

  const flat = d => d.seasons.filter(sn => sn !== '0').flatMap(sn => d.episodes[sn].map(e => [sn, e]));
  const epLabel = (sn, e) => {
    const z = n => String(Math.trunc(n)).padStart(2, '0');
    const lbl = /^\d+$/.test(String(sn)) ? `S${z(sn)}E${z(e.n)}` : `E${e.n}`;
    return lbl + (e.t && !/^Épisode \d+$/.test(e.t) ? ` – ${e.t}` : '');
  };

  async function seriesFor(g, ep) {
    const srcs = (g.s || []).map(x => x.id);
    if (ep && srcs.includes(ep.sid)) { srcs.splice(srcs.indexOf(ep.sid), 1); srcs.unshift(ep.sid); }
    for (const sid of srcs.slice(0, 4)) {
      let d;
      try { d = await seriesCached(sid); } catch { continue; }
      const f = flat(d);
      if (!ep || !ep.id || f.some(([, e]) => String(e.id) === String(ep.id))) return [sid, f];
    }
    return [null, []];
  }

  async function replay(key) {
    const g = A.live_idx[key];
    if (!g || !g.arc) return { available: false };
    const src = g.s.reduce((a, b) => ((b.arc || 0) > (a.arc || 0) ? b : a), g.s[0]);
    const res = (await client().api('get_simple_data_table', { stream_id: src.id }, 30)) || {};
    const t = now();
    const floor = t - (src.arc || 0) * 86400;
    const rows = (res && !Array.isArray(res) && res.epg_listings) || [];
    const flagged = rows.some(e => 'has_archive' in e);
    const out = [], seen = new Set();
    for (const e of rows) {
      const st = toInt(e.start_timestamp), en = toInt(e.stop_timestamp);
      if (!st || st >= t || st < floor || seen.has(st)) continue;
      if (en <= t && flagged && String(e.has_archive || '0') === '0') continue;
      seen.add(st);
      out.push({ title: b64decodeUtf8(e.title).trim(), desc: b64decodeUtf8(e.description).trim(), start: st, end: en, live: en > t });
    }
    out.sort((a, b) => a.start - b.start);
    return { available: true, days: src.arc || 0, sid: src.id, progs: out };
  }

  async function upNext(prof) {
    const d = pdata(prof);
    const last = {};
    for (const p of Object.values(d.progress || {})) {
      if (p.kind !== 'series' || !p.key || !p.ep) continue;
      if (!(p.key in last) || (p.ts || 0) > (last[p.key].ts || 0)) last[p.key] = p;
    }
    const cands = Object.values(last).filter(p => p.done && now() - (p.ts || 0) < 200 * 86400)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 12);
    const prog = d.progress || {};
    const one = async p => {
      const g = A.series_idx[p.key];
      if (!g) return null;
      const [sid, f] = await seriesFor(g, p.ep);
      if (!f.length) return null;
      d.follow = d.follow || {};
      const fo = d.follow[p.key] = d.follow[p.key] || {};
      Object.assign(fo, { cnt: f.length, sid, a: g.a || 0 });
      let i = f.findIndex(([, e]) => String(e.id) === String(p.ep.id));
      if (i < 0) return null;
      i += 1;
      while (i < f.length && (prog[`e:${f[i][1].id}`] || {}).done) i += 1;
      if (i >= f.length) { fo.caught_up = true; return null; }
      fo.caught_up = false;
      const mk = (sn, e) => ({ sub: epLabel(sn, e), pid: `e:${e.id}`, ep: { id: e.id, ext: e.ext, sid },
        streams: [{ type: 'episode', id: e.id, ext: e.ext, label: 'Épisode' }] });
      const [sn, e] = f[i];
      const started = prog[`e:${e.id}`];
      return Object.assign({ kind: 'series', key: p.key, next: true, ts: p.ts, img: e.img || '', label: epLabel(sn, e),
        new: !!fo.new, pos: (started || {}).pos || 0, dur: (started || {}).dur || 0 }, mk(sn, e),
      { queue: f.slice(i + 1, i + 30).map(x => mk(x[0], x[1])) });
    };
    const out = (await mapLimit(cands, 4, async p => { try { return await one(p); } catch { return null; } })).filter(Boolean);
    CONFIG.save();
    return out;
  }

  async function checkNewEpisodes() {
    let changed = false;
    for (const prof of CONFIG.data.profiles) {
      const d = pdata(prof.id);
      for (const [key, f] of Object.entries(d.follow || {})) {
        const g = A.series_idx[key];
        if (!g || !f.cnt || now() - (f.ts || 0) > 200 * 86400) continue;
        if ((g.a || 0) <= (f.a || 0)) continue;
        f.a = g.a || 0;
        changed = true;
        let fl;
        try {
          delete A.sinfo_cache[String(f.sid)];
          fl = (await seriesFor(g, f.sid ? { sid: f.sid } : null))[1];
        } catch { continue; }
        if (fl.length > f.cnt) {
          const n = fl.length - f.cnt;
          f.new = (f.new || 0) + n;
          f.cnt = fl.length;
          const [sn, e] = fl[fl.length - 1];
          event(`${n === 1 ? 'Nouvel épisode' : `${n} nouveaux épisodes`} de « ${g.t || ''} » : ${epLabel(sn, e)}`, 'info', 'newep',
            { key, profile: prof.id });
        }
      }
    }
    if (changed) CONFIG.save();
  }

  async function movieInfo(vid) {
    const info = (await client().api('get_vod_info', { vod_id: vid })) || {};
    let i = info.info || {};
    if (Array.isArray(i)) i = {};
    const bd = i.backdrop_path;
    return { plot: i.plot || i.description || '', cast: i.cast || i.actors || '', director: i.director || '', genre: i.genre || '',
      duration: i.duration || '', rating: i.rating || '', backdrop: Array.isArray(bd) && bd.length ? bd[0] : '',
      tmdb: toInt(i.tmdb_id || i.tmdb) || null };
  }

  /* ------------------------------------------------------------------ lecture */
  function setPlaying(on, title) {
    const was = A.playing;
    A.playing = on;
    if (on) { if (title) A.play_title = title; if (!was) A.play_since = Math.trunc(now()); }
    else { A.play_title = ''; A.play_since = 0; }
    if (!!was !== !!on && A.sync && A.sync.group) A.sync.poke();
  }
  function othersPlaying() {
    const me = A.sync && A.sync.store.device;
    if (A.sync && A.sync.group && Object.keys(A.stop_cmds).length) A.sync.poke();
    const out = [];
    for (const [dev, v] of Object.entries(A.remote_play)) {
      if (dev === me || !v || now() - (v.hb || 0) > 12 * 60) continue;
      out.push({ id: dev, name: v.n || 'Un autre appareil', title: v.t || '' });
    }
    return { others: out, max: toInt(A.account && A.account.max) || 1 };
  }
  function remoteStop(dev) {
    A.stop_cmds[dev] = Math.trunc(now());
    if (A.sync && A.sync.group) A.sync.poke();
    return { ok: true };
  }
  function stream(s) {
    setPlaying(true, s.title);
    const xt = client();
    const kind = s.type;
    if (kind === 'replay') return { url: xt.timeshiftUrl(s.id, s.start, s.dur || 60), mode: 'native', live: false };
    if (kind === 'live') {
      const fmt = CONFIG.data.live_format === 'm3u8' && xt.output_formats.includes('m3u8') ? 'm3u8' : 'ts';
      return { url: xt.streamUrl('live', s.id, null, fmt), mode: 'native', live: true };
    }
    return { url: xt.streamUrl(kind, s.id, s.ext), mode: 'native', ext: (s.ext || '').toLowerCase() };
  }

  /* ------------------------------------------------------------------ profils, reprise, historique */
  function pushHistory(kind, key, prof) {
    const d = pdata(prof);
    const h = d.history.filter(x => !(x.kind === kind && x.key === key));
    h.unshift({ kind, key, ts: Math.trunc(now()) });
    d.history = h.slice(0, 30);
  }

  function saveProgress(body, prof) {
    const d = pdata(prof);
    const prog = d.progress;
    const pid = String(body.id);
    const prev = prog[pid] || {};
    if (body.clear) {
      if (body.forget) delete prog[pid];
      else {
        const e = {};
        for (const k of ['kind', 'key', 'label', 'ep', 'dur', 'vid']) e[k] = body[k] !== undefined && body[k] !== null ? body[k] : (prev[k] ?? null);
        e.pos = e.dur || prev.dur || 0; e.done = true; e.ts = Math.trunc(now());
        prog[pid] = e;
      }
    } else {
      const e = {};
      for (const k of ['kind', 'key', 'label', 'ep', 'pos', 'dur', 'vid']) e[k] = body[k] ?? null;
      e.ts = Math.trunc(now());
      prog[pid] = e;
    }
    const keys = Object.keys(prog);
    if (keys.length > 400) keys.sort((a, b) => (prog[a].ts || 0) - (prog[b].ts || 0)).slice(0, keys.length - 400).forEach(k => delete prog[k]);
    if (body.kind && body.key) {
      if (!body.forget) pushHistory(body.kind, body.key, prof);
      if (body.kind === 'series') {
        d.follow = d.follow || {};
        const f = d.follow[body.key] = d.follow[body.key] || {};
        f.new = 0; f.ts = Math.trunc(now());
      }
    }
    CONFIG.save();
  }

  function publicConfig(prof) {
    const c = CONFIG.data;
    const d = pdata(prof);
    const pid = prof in c.pdata ? prof : c.profiles[0].id;
    return {
      phone_setup: !!(syncSettings()[0] && syncSettings()[1] && G.crypto && G.crypto.subtle),
      configured: !!(c.server && c.username), server: c.server, username: c.username, has_password: !!c.password,
      has_tmdb: !!tmdbKey(), own_tmdb: !!(c.tmdb_key || '').trim(), builtin_tmdb: !!BUILTIN_TMDB, version: VERSION,
      player: '', player_kind: null, player_path: '', fullscreen: true, live_format: c.live_format || 'ts', player_mode: 'web',
      native: false, vlc: false, vlc_where: '', vlc_version: '', vlc_error: '', platform: G.SHIPPO_PLATFORM || 'tv',
      profiles: c.profiles, profile: pid, favs: d.favs, history: d.history, progress: d.progress, notify: d.notify,
      reminders: d.reminders,
      follow: Object.fromEntries(Object.entries(d.follow || {}).filter(([, v]) => v.new).map(([k, v]) => [k, { new: v.new }])),
      country_setting: (c.country || 'auto').toUpperCase(), country: userCountry(),
      countries: Object.entries(TV.COUNTRIES).map(([code, v]) => Object.assign({ code }, v)),
      dl_dir: '', dl_pause_play: false, show_unavailable: c.show_unavailable !== false, tv_mode: true,
      online: A.online, catalog_ts: Math.trunc(A.catalog_ts || 0), refreshing: A.refreshing,
    };
  }

  /* ------------------------------------------------------------------ synchronisation */
  const PROF_KEYS = ['favs', 'history', 'progress', 'notify', 'reminders'];
  function syncExport() {
    const c = CONFIG.data, out = {};
    c.profiles.forEach((p, i) => { out[`prof/${p.id}`] = { name: p.name, color: p.color, kids: !!p.kids, o: i }; });
    const ids = new Set(c.profiles.map(p => p.id));
    const t = now();
    for (const [pid, d] of Object.entries(c.pdata)) {
      if (!ids.has(pid)) continue;
      for (const f of d.favs || []) out[`p/${pid}/fav/${f}`] = 1;
      for (const [k, v] of Object.entries(d.progress || {})) out[`p/${pid}/prog/${k}`] = v;
      for (const h of d.history || []) out[`p/${pid}/hist/${h.kind}:${h.key}`] = { ts: h.ts };
      for (const n of d.notify || []) out[`p/${pid}/notify/${n.kind}:${n.id}`] = n;
      for (const r of d.reminders || []) if ((r.end || 0) > t) out[`p/${pid}/rem/${r.key}@${r.start}`] = r;
    }
    for (const [mk, tid] of Object.entries(c.fixes || {})) out[`fix/${mk}`] = tid;
    // clé TMDB partagée dans le groupe (chiffrée comme le reste) : les appareils qui n'en ont pas la reçoivent
    if (tmdbKey()) out['cfg/tmdb'] = tmdbKey();
    // présence de lecture et demandes d'arrêt (éléments passagers)
    const st = A.sync && A.sync.store;
    if (st && A.playing && A.play_since) out[`play/${st.device}`] = { t: A.play_title, n: st.name, since: A.play_since, hb: Math.floor(t / 300) * 300 };
    for (const [dev, ts] of Object.entries(A.stop_cmds)) {
      if (t - ts > 180) delete A.stop_cmds[dev];
      else out[`cmd/stop/${dev}`] = { from: st ? st.name : '', ts };
    }
    // éléments passagers reçus des autres appareils : renvoyés tels quels (sinon la synchro les effacerait)
    const me = st && st.device;
    for (const [dev, v] of Object.entries(A.remote_play)) {
      if (dev !== me && v && t - (v.hb || 0) < 12 * 60 && !(`play/${dev}` in out)) out[`play/${dev}`] = v;
    }
    for (const [k, v] of Object.entries(A.remote_cmds)) {
      if (t - (v.ts || 0) < 180) { if (!(k in out)) out[k] = v; } else delete A.remote_cmds[k];
    }
    return out;
  }

  async function syncApply(changes) {
    const c = CONFIG.data;
    const fixes = [];
    const me = A.sync && A.sync.store.device;
    changes = changes.filter(([k, v]) => {
      if (k.startsWith('play/')) { if (v === null) delete A.remote_play[k.slice(5)]; else A.remote_play[k.slice(5)] = v; return false; }
      if (k.startsWith('cmd/stop/')) {
        if (v === null) delete A.remote_cmds[k]; else A.remote_cmds[k] = v;
        if (v && k.slice(9) === me && A.playing && (v.ts || 0) >= A.play_since - 5 && now() - (v.ts || 0) < 180) {
          setPlaying(false);
          try { if (typeof P !== 'undefined' && P.o) P.close(true); } catch { /* interface absente */ }   // libère tout de suite la connexion
          event(`Lecture arrêtée à la demande de « ${v.from || 'un autre appareil'} »`, 'info', 'remote_stop', { from: v.from });
        }
        return false;
      }
      return true;
    });
    if (!changes.length) return;
    changes = changes.slice().sort((a, b) => (!a[0].startsWith('prof/')) - (!b[0].startsWith('prof/')));
    for (const [k, v] of changes) {
      const parts = k.split('/');
      if (k === 'cfg/tmdb') {
        if (typeof v === 'string' && v.trim() && !tmdbKey()) { c.tmdb_key = v.trim(); A.disc_cache = {}; event('Clé TMDB reçue de vos autres appareils : les affiches arrivent', 'info', 'tmdb_key'); }
        continue;
      }
      if (parts[0] === 'prof') {
        const pid = parts[1];
        let cur = c.profiles.find(p => p.id === pid);
        if (v === null) {
          if (cur && c.profiles.length > 1) { c.profiles.splice(c.profiles.indexOf(cur), 1); delete c.pdata[pid]; }
          continue;
        }
        if (!cur) { cur = { id: pid }; c.profiles.push(cur); c.pdata[pid] = c.pdata[pid] || {}; }
        Object.assign(cur, { name: v.name || 'Profil', color: v.color || PROFILE_COLORS[0], kids: !!v.kids, _o: v.o ?? 99 });
      } else if (parts[0] === 'p' && parts.length >= 4) {
        const pid = parts[1], typ = parts[2], item = parts.slice(3).join('/');
        const d = c.pdata[pid] = c.pdata[pid] || {};
        for (const kk of PROF_KEYS) if (d[kk] === undefined) d[kk] = kk === 'progress' ? {} : [];
        if (typ === 'fav') {
          d.favs = d.favs.filter(f => f !== item);
          if (v !== null) d.favs.unshift(item);
        } else if (typ === 'prog') {
          if (v === null) delete d.progress[item]; else d.progress[item] = v;
        } else if (typ === 'hist') {
          const i = item.indexOf(':');
          const h = d.history.filter(x => `${x.kind}:${x.key}` !== item);
          if (v !== null) h.push({ kind: item.slice(0, i), key: item.slice(i + 1), ts: v.ts || 0 });
          d.history = h.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 30);
        } else if (typ === 'notify') {
          const n = d.notify.filter(x => `${x.kind}:${x.id}` !== item);
          if (v !== null) n.unshift(v);
          d.notify = n;
        } else if (typ === 'rem') {
          const r = d.reminders.filter(x => `${x.key}@${x.start}` !== item);
          if (v !== null) r.push(v);
          d.reminders = r;
        }
      } else if (parts[0] === 'fix') {
        const mk = k.slice(4);
        c.fixes = c.fixes || {};
        if (v === null) delete c.fixes[mk];
        else if (c.fixes[mk] !== v) { c.fixes[mk] = v; fixes.push([mk, v]); }
      }
    }
    if (c.profiles.some(p => p._o !== undefined)) {
      c.profiles.sort((a, b) => (a._o ?? 99) - (b._o ?? 99));
      c.profiles.forEach(p => { delete p._o; });
    }
    CONFIG.save();
    for (const [mk, tid] of fixes) {
      try { await tmdbOverride(mk.startsWith('m:') ? 'movie' : 'series', mk.slice(2), tid); } catch { /* plus tard */ }
    }
  }

  function syncSettings() {
    const c = CONFIG.data;
    return [(c.sync_url || DEF.supabase_url || '').trim(), (c.sync_key || DEF.supabase_key || '').trim()];
  }

  async function makeSync() {
    const [url, key] = syncSettings();
    if (A.sync) { try { A.sync.running = false; } catch { /* rien */ } }
    const s = new SH.SyncClient(url, key, SYNC_STORE.data, () => SYNC_STORE.save(),
      { export: syncExport, apply: syncApply, event }, 15);
    A.sync = s;
    try { await s.init(); } catch { /* chiffrement indisponible */ }
    s.start();
    return s;
  }

  /* ------------------------------------------------------------------ routes (mêmes que la version PC) */
  async function rConfig(method, body, g, prof) {
    if (method === 'GET') return publicConfig(prof);
    const c = CONFIG.data;
    const old = [c.server, c.username, c.password].join('\u0001');
    for (const k of ['server', 'username', 'tmdb_key', 'live_format', 'country']) {
      if (k in body && body[k] !== null && body[k] !== undefined) c[k] = String(body[k]).trim();
    }
    if (body.password) c.password = String(body.password);
    if (c.server.includes('username=')) {
      const [base, user, pw] = parseServerInput(c.server);
      c.server = base; c.username = user || c.username;
      c.password = body.password ? c.password : (pw || c.password);
    }
    for (const k of ['show_unavailable']) if (k in body) c[k] = !!body[k];
    if ('tmdb_key' in body) A.disc_cache = {};
    if ('country' in body) { A.now_cache = null; A.tv_cache = {}; }
    CONFIG.save();
    if ([c.server, c.username, c.password].join('\u0001') !== old) {
      A.catalog = null; A.account = {}; A.xt = null;
      await connect();
    }
    return publicConfig(prof);
  }

  function rProfiles(method, body) {
    const c = CONFIG.data;
    const act = body.action;
    if (act === 'add') {
      const pid = 'p' + Math.random().toString(16).slice(2, 8);
      c.profiles.push({ id: pid, name: (body.name || 'Profil').trim().slice(0, 20),
        color: body.color || PROFILE_COLORS[c.profiles.length % PROFILE_COLORS.length], kids: !!body.kids });
      c.pdata[pid] = { favs: [], history: [], progress: {}, notify: [], reminders: [], follow: {} };
    } else if (act === 'edit') {
      for (const p of c.profiles) {
        if (p.id !== body.id) continue;
        if (body.name) p.name = body.name.trim().slice(0, 20);
        if (body.color) p.color = body.color;
        if ('kids' in body) p.kids = !!body.kids;
      }
    } else if (act === 'delete' && c.profiles.length > 1) {
      c.profiles = c.profiles.filter(p => p.id !== body.id);
      delete c.pdata[body.id];
    }
    CONFIG.save();
    return { profiles: c.profiles };
  }

  function rFav(method, body, g, prof) {
    const d = pdata(prof);
    const item = `${body.kind}:${body.key}`;
    const favs = d.favs.filter(f => f !== item);
    if (body.on) favs.unshift(item);
    d.favs = favs;
    CONFIG.save();
    return { favs };
  }

  function rNotify(method, body, g, prof) {
    const d = pdata(prof);
    const n = d.notify.filter(x => !(x.kind === body.kind && toInt(x.id) === toInt(body.id)));
    if (body.on) n.unshift({ kind: body.kind, id: toInt(body.id), title: body.title || '', ts: Math.trunc(now()) });
    d.notify = n;
    CONFIG.save();
    checkNotify();
    return { notify: pdata(prof).notify };
  }

  function rReminder(method, body, g, prof) {
    const d = pdata(prof);
    const t = now();
    const r = d.reminders.filter(x => (x.end || 0) > t && !(x.key === body.key && x.start === body.start));
    if (body.on) r.push({ key: body.key, ch: body.ch, title: body.title, start: body.start, end: body.end });
    d.reminders = r;
    CONFIG.save();
    return { reminders: r };
  }

  async function rVerify(method, body, g) {
    const key = g('key') || body.key;
    const changed = await verifyGroup(key);
    const vm = verifyMap();
    return { changed, verify: Object.fromEntries(((A.movie_idx[key] || {}).v || []).map(v => [String(v.id), vm[String(v.id)] ?? null])) };
  }

  /* Configuration depuis un téléphone : la télé affiche un QR code vers une petite page web,
     le téléphone y saisit les identifiants, les chiffre avec le code du QR et les dépose ;
     la télé les récupère, se connecte et renvoie le résultat au téléphone. */
  const QR_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function phonePage() {
    const repo = (DEF.update_repo || 'Captur570/cineflux').split('/');
    return DEF.phone_page || `https://${repo[0].toLowerCase()}.github.io/${repo[1]}/config/`;
  }
  async function rPhone(method, body) {
    const act = method === 'POST' ? body.action : 'poll';
    const [url, key] = syncSettings();
    if (!url || !key || !A.sync || !A.sync.configured) return { error: 'Configuration par téléphone indisponible (synchronisation non configurée)' };
    if (act === 'start') {
      const r = new Uint8Array(16);
      G.crypto.getRandomValues(r);
      const code = Array.from(r, b => QR_ALPHA[b & 31]).join('');
      A.phone = { code, exp: Date.now() + 10 * 60 * 1000 };
      const frag = new URLSearchParams({ c: code, s: url, k: key, n: G.SHIPPO_PLATFORM === 'ios' ? 'iPad' : 'Télé' });
      return { url: phonePage() + '#' + frag.toString(), exp: A.phone.exp };
    }
    if (act === 'cancel') { A.phone = null; return { state: 'none' }; }
    const ph = A.phone;
    if (!ph) return { state: 'none' };
    if (Date.now() > ph.exp) { A.phone = null; return { state: 'expired' }; }
    let data;
    try { data = await A.sync.claimCode(ph.code); } catch (e) { return { state: 'wait', warn: e.message }; }
    if (!data) return { state: 'wait' };
    const x = data.xtream || {};
    const reply = obj => A.sync.dropCode(ph.code + '/r', obj).catch(() => {});
    if (!x.server || !x.username) { await reply({ ok: false, msg: 'Adresse du serveur ou identifiant manquant.' }); return { state: 'wait' }; }
    const c = CONFIG.data;
    const prev = { server: c.server, username: c.username, password: c.password };
    c.server = String(x.server).trim(); c.username = String(x.username).trim(); c.password = String(x.password || '');
    if (data.tmdb) c.tmdb_key = String(data.tmdb).trim();
    if (c.server.includes('username=')) {
      const [base, user, pw] = parseServerInput(c.server);
      c.server = base; c.username = user || c.username; c.password = c.password || pw || '';
    }
    CONFIG.save();
    A.catalog = null; A.account = {}; A.xt = null;
    try {
      await connect();
    } catch (e) {
      Object.assign(c, prev); CONFIG.save();
      A.catalog = null; A.account = {}; A.xt = null;
      await reply({ ok: false, msg: e.message || 'Connexion refusée par le serveur.' });
      return { state: 'wait', tried: true, error: e.message };
    }
    await reply({ ok: true, msg: 'ShippoTV est configuré sur votre ' + (G.SHIPPO_PLATFORM === 'ios' ? 'iPad' : 'télé') + '.' });
    A.phone = null;
    return { state: 'done' };
  }

  async function rSync(method, body) {
    let s = A.sync;
    const act = method === 'POST' ? body.action : null;
    try {
      if (act === 'create') await s.createGroup(body.name || '');
      else if (act === 'code') {
        const c = CONFIG.data;
        const extra = body.creds && c.server && c.username ? { xtream: { server: c.server, username: c.username, password: c.password }, tmdb: tmdbKey() || null } : null;
        return Object.assign(s.status(), { pair: await s.makeCode(extra), builtin: !!DEF.supabase_url });
      } else if (act === 'join') {
        await s.join(body.code || '');
        const x = (s.lastExtra || {}).xtream || {};
        const tk = (s.lastExtra || {}).tmdb;
        if (tk && !tmdbKey()) { CONFIG.data.tmdb_key = tk; CONFIG.save(); }
        if (x.server && x.username) {
          const c = CONFIG.data;
          c.server = x.server; c.username = x.username; c.password = x.password || '';
          CONFIG.save();
          A.catalog = null; A.account = {}; A.xt = null;
          try { await connect(); } catch { /* vérifié au chargement */ }
          return Object.assign(s.status(), { creds: true, builtin: !!DEF.supabase_url, custom_url: CONFIG.data.sync_url || '' });
        }
      }
      else if (act === 'leave') s.leaveGroup();
      else if (act === 'rotate') await s.rotate();
      else if (act === 'rename') s.renameDevice(body.name || '');
      else if (act === 'now') s.poke();
      else if (act === 'server') {
        CONFIG.data.sync_url = (body.url || '').trim();
        if (body.key !== undefined && body.key !== null || !CONFIG.data.sync_url) CONFIG.data.sync_key = (body.key || '').trim();
        CONFIG.save();
        s = await makeSync();
      }
    } catch (e) {
      return Object.assign(s.status(), { error: e.message, builtin: !!DEF.supabase_url, custom_url: CONFIG.data.sync_url || '' });
    }
    return Object.assign(s.status(), { builtin: !!DEF.supabase_url, custom_url: CONFIG.data.sync_url || '' });
  }

  const ROUTES = {
    '/api/config': rConfig,
    '/api/profiles': rProfiles,
    '/api/catalog': (m, b, g) => catalogPayload(g('refresh') === '1'),
    '/api/refresh': () => { refreshCatalog(true); return { ok: true }; },
    '/api/enrich': (m, b) => enrich(b.items || []),
    '/api/tmdb_search': (m, b) => tmdbSearch(b.kind, b.query || ''),
    '/api/tmdb_override': (m, b) => tmdbOverride(b.kind, b.key, b.id),
    '/api/tmdb_info': (m, b, g) => tmdbInfo(g('kind'), g('id')),
    '/api/trailer': (m, b, g) => trailer(g('kind'), g('id')),
    '/api/similar': (m, b, g) => similar(g('kind'), g('id')),
    '/api/series': (m, b, g) => seriesCached(g('id'), 120),
    '/api/up_next': (m, b, g, p) => upNext(p),
    '/api/replay': (m, b, g) => replay(g('key')),
    '/api/for_you': (m, b, g, p) => forYou(p),
    '/api/person': (m, b, g) => personSearch(g('q')),
    '/api/movie': (m, b, g) => movieInfo(g('id')),
    '/api/epg': (m, b, g) => epg(g('id'), 6),
    '/api/discover': (m, b, g) => discover(g('kind'), g('refresh') === '1'),
    '/api/live_now': (m, b, g) => liveNow(g('refresh') === '1'),
    '/api/tonight': (m, b, g) => tonight(g('refresh') === '1'),
    '/api/guide': () => guide(),
    '/api/stream': (m, b) => stream(b),
    '/api/player_closed': () => { setPlaying(false); return { ok: true }; },
    '/api/others': () => othersPlaying(),
    '/api/remote_stop': (m, b) => remoteStop(b.device || ''),
    '/api/progress': (m, b, g, p) => { saveProgress(b, p); return { ok: true }; },
    '/api/fav': rFav,
    '/api/notify': rNotify,
    '/api/reminder': rReminder,
    '/api/verify': rVerify,
    '/api/events': (m, b, g) => { const since = toInt(g('since')); return A.events.filter(e => e.id > since); },
    '/api/sync': rSync,
    '/api/phone_setup': rPhone,
    '/api/downloads': () => ({ items: [], folder: '', free: 0, held: false }),
    '/api/update': async (m, b) => {
      if (m === 'POST' && b.action === 'check') await checkUpdate(true).catch(() => {});
      return { enabled: !!DEF.update_repo, current: VERSION, available: A.update || null, state: 'idle', progress: 0, error: '', installed: true };
    },
    '/api/fullscreen': () => ({ native: false }),
    '/api/play': () => { throw new Error("Pas de lecteur externe sur la télé"); },
    '/api/vlc_play': () => { throw new Error("Pas de VLC sur la télé"); },
    '/api/vlc_stop': () => ({ ok: true }),
  };

  /* ------------------------------------------------------------------ nouvelle version (télé) */
  const vtuple = v => (String(v || '0').match(/\d+/g) || ['0']).slice(0, 4).map(Number);
  const newer = (a, b) => { const x = vtuple(a), y = vtuple(b); for (let i = 0; i < 4; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  async function checkUpdate(manual) {
    if (!DEF.update_repo) return null;
    const r = await SH.http(`https://api.github.com/repos/${DEF.update_repo}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' }, timeout: 20 });
    if (r.status !== 200) return null;
    const rel = JSON.parse(r.text || '{}');
    const tag = String(rel.tag_name || '').replace(/^[vV]/, '');
    if (!tag || !newer(tag, VERSION)) { A.update = null; return null; }
    const first = !A.update || A.update.version !== tag;
    A.update = { version: tag, notes: String(rel.body || '').trim().slice(0, 1500) };
    if (first && !manual) event(G.SHIPPO_PLATFORM === 'ios' ? `ShippoTV ${tag} est disponible pour l'iPad (Réglages > À propos)`
      : `ShippoTV ${tag} est disponible : à installer sur la télé depuis votre PC (Réglages > À propos)`, 'info', 'update_tv', A.update);
    return A.update;
  }

  /* ------------------------------------------------------------------ démarrage */
  let readyP = null;
  function ready() {
    if (!readyP) {
      readyP = (async () => {
        await Promise.all([CONFIG.load(), TMDB_CACHE.load(), VERIFY_CACHE.load(), SYNC_STORE.load()]);
        migrateProfiles();
        const save = CONFIG.save.bind(CONFIG);
        CONFIG.save = () => { save(); if (A.sync && A.sync.group) A.sync.poke(); };
        makeSync().catch(e => console.warn('synchro', e));
        if (CONFIG.data.server && CONFIG.data.username) getCatalog().catch(() => {});   // préchargement
        setTimeout(background, 3000);
        setTimeout(() => checkUpdate(false).catch(() => {}), 40000);
        setInterval(() => { if (!A.playing) checkUpdate(false).catch(() => {}); }, 12 * 3600 * 1000);
        setInterval(background, 60000);
        G.addEventListener && G.addEventListener('pagehide', () => { CONFIG.flush(); TMDB_CACHE.flush(); VERIFY_CACHE.flush(); SYNC_STORE.flush(); });
      })();
    }
    return readyP;
  }

  async function call(path, body, prof) {
    await ready();
    const qi = path.indexOf('?');
    const route = qi < 0 ? path : path.slice(0, qi);
    const params = new URLSearchParams(qi < 0 ? '' : path.slice(qi + 1));
    const g = (k, d = null) => (params.has(k) ? params.get(k) : d);
    const fn = ROUTES[route];
    if (!fn) throw new Error('Route inconnue');
    return fn(body ? 'POST' : 'GET', body || {}, g, prof || g('p'));
  }

  G.ENGINE = { call, ready, version: VERSION, _A: A, _CONFIG: CONFIG, flush: () => Promise.all([CONFIG.flush(), TMDB_CACHE.flush(), VERIFY_CACHE.flush(), SYNC_STORE.flush()]) };
})(typeof window !== 'undefined' ? window : globalThis);
