'use strict';
/* ShippoTV — noyau de l'interface : état, accès à l'API, utilitaires, données.
   Toute communication avec le moteur passe par api() : pour une autre plateforme (TV),
   il suffit de fournir un moteur qui répond aux mêmes routes. */

const TOKEN = new URLSearchParams(location.search).get('t') || '';
const IMG = 'https://image.tmdb.org/t/p/';
const S = {
  cfg: null, cat: null, meta: {}, idx: { movie: {}, series: {}, live: {} }, counts: {}, tmIdx: { movie: {}, series: {} },
  verify: {}, route: { page: 'home', params: {} }, stack: [], q: '',
  filter: { movie: 'feat', series: 'feat', live: 'all' }, liveTab: 'une',
  sort: { movie: 'recent', series: 'recent' }, favs: new Set(), evId: 0, cleanup: [], heroEmpty: false,
  disc: { movie: null, series: null }, discLoading: {}, now: null, nowLoading: null, tonight: null, tonightLoading: null,
  dl: { items: [] }, dlByVid: {}, dlByKey: {}, profile: null, pendingRender: false,
};
const QUAL_WORDS = new Set(['4k', 'uhd', 'hd', 'fhd', 'sd', 'dv', 'hdr', 'hdr10', 'vf', 'vff', 'vostfr', 'vo', 'multi', '1080p', '720p', '2160p', 'french', 'truefrench']);
const QRANK = { '4K': 4, '1080p': 3, '720p': 2, 'SD': 1 };
const QLABEL = { '4K': '4K', '1080p': 'FHD', '720p': 'HD', 'SD': 'SD' };
const QLONG = { '4K': '4K Ultra HD', '1080p': 'Full HD 1080p', '720p': 'HD 720p', 'SD': 'SD' };

/* ------------------------------------------------------------ utilitaires */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normTxt = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
function hue(str) { let x = 7; for (const c of str || '') x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; }
const gradient = str => { const a = hue(str); return `linear-gradient(150deg,hsl(${a} 42% 27%),hsl(${(a + 55) % 360} 48% 11%))`; };
const hm = t => new Date(t * 1000).toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' });
const clock = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtMin = m => !m ? '' : m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}` : `${Math.round(m)} min`;
const fmtSize = b => !b ? '' : b > 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' Go' : (b / 1e6).toFixed(0) + ' Mo';
const pct = (s, e) => Math.max(0, Math.min(100, Math.round(100 * (Date.now() / 1000 - s) / Math.max(1, e - s))));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* Icônes (trait 2 px, 24×24) */
const ICONS = {
  play: '<path class="f" d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>',
  stop: '<rect class="f" x="6" y="6" width="12" height="12" rx="2"/>',
  pause: '<rect class="f" x="6" y="4.5" width="4" height="15" rx="1"/><rect class="f" x="14" y="4.5" width="4" height="15" rx="1"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  img: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  down: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  downloaded: '<circle cx="12" cy="12" r="9.5"/><path d="m8 12.5 3 3 5-6"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bellOn: '<path class="f" d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>', chevRight: '<path d="m9 6 6 6-6 6"/>', chevLeft: '<path d="m15 6-6 6 6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  star: '<path class="f" d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  wifiOff: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M19 13a10 10 0 0 0-2.4-1.6M2 9.5a15 15 0 0 1 4.5-2.8M22 9.5A15 15 0 0 0 12 5.5"/><circle class="f" cx="12" cy="20" r="1"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  rew: '<path class="f" d="M11 7 5 12l6 5zM19 7l-6 5 6 5z"/>', fwd: '<path class="f" d="m13 7 6 5-6 5zM5 7l6 5-6 5z"/>',
  vol: '<path class="f" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path class="f" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  fs: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  live: '<circle class="f" cx="12" cy="12" r="3"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  home: '<path d="M4 11 12 4l8 7v8.5a1 1 0 0 1-1 1h-4.5V15h-5v5.5H5a1 1 0 0 1-1-1z"/>',
  sync: '<path d="M20 8a8 8 0 0 0-14.5-2.5M4 4v4h4M4 16a8 8 0 0 0 14.5 2.5M20 20v-4h-4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5"/>',
};
const ico = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

async function api(path, body) {
  if (window.ENGINE) {                    // version TV : le moteur tourne dans l'appli elle-même
    try { return await ENGINE.call(path, body, S.profile || ''); }
    catch (e) { throw new Error((e && e.message) || 'Erreur'); }
  }
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Token': TOKEN, 'X-Profile': S.profile || '', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await r.json(); } catch { data = { error: 'Réponse invalide du programme' }; }
  if (!r.ok) throw new Error(data.error || 'Erreur ' + r.status);
  return data;
}

/* Notifications, avec un bouton d'action facultatif */
function toast(msg, level = 'info', ms = 4200, action) {
  if (!msg) return;
  const t = el('div', 'toast ' + level, `<span>${esc(msg)}</span>`);
  if (action) {
    const b = el('button', 'toast-act', esc(action.label));
    b.onclick = () => { action.run(); t.remove(); };
    t.append(b);
    t.classList.add('has-act');
    ms = Math.max(ms, 9000);
  }
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms);
}

/* ------------------------------------------------------------ données du catalogue */
const list = kind => kind === 'movie' ? S.cat.movies : kind === 'series' ? S.cat.series : S.cat.live;
const catMap = kind => S.cat.cats[kind === 'movie' ? 'movies' : kind];
const catName = (kind, id) => catMap(kind)[Array.isArray(id) ? id[0] : id] || '';
const mkey = (kind, item) => (kind === 'movie' ? 'm:' : 't:') + item.k;

function info(kind, item) {
  const m = kind === 'live' ? null : S.meta[mkey(kind, item)];
  return {
    title: (m && m.t) || item.t,
    year: (m && m.y) || item.y || null,
    poster: m && m.p ? IMG + 'w342' + m.p : (item.p || ''),
    backdrop: m && m.b ? IMG + 'w1280' + m.b : (item.bd || ''),
    backdropSm: m && m.b ? IMG + 'w780' + m.b : (item.bd || ''),
    vote: (m && m.v) || (item.r ? Number(item.r) : 0),
    overview: (m && m.o) || item.pl || '',
    genres: (m && m.g && m.g.length) ? m.g : (item.g ? item.g.split(/[,/]/).map(s => s.trim()).filter(Boolean).slice(0, 3) : []),
    runtime: m && m.rt,
    tmdb: m && m.id,
  };
}

/* Vérification des versions : st = ok | unk | bad */
const vstat = vid => S.verify[String(vid)] || null;
function goodVersions(item) { return item.v.filter(v => (vstat(v.id) || [])[0] !== 'bad'); }
function badVersions(item) { return item.v.filter(v => (vstat(v.id) || [])[0] === 'bad'); }
function itemState(kind, item) {
  if (kind !== 'movie') return { ok: true };
  if (goodVersions(item).length) return { ok: true };
  const why = (vstat(item.v[0].id) || [])[1] || 'version non conforme';
  return { ok: false, why };
}

/* Qualités / langues disponibles (versions conformes uniquement) */
function qualities(kind, item) {
  const src = kind === 'movie' ? (goodVersions(item).length ? goodVersions(item) : item.v) : item.s;
  const q = new Set(), h = new Set(), l = new Set();
  for (const x of src) for (const p of (x.q || '').split(' · ')) {
    if (QRANK[p]) q.add(p); else if (p === 'DV' || p === 'HDR') h.add(p); else if (p) l.add(p);
  }
  return { q: [...q].sort((a, b) => QRANK[b] - QRANK[a]), h: [...h], l: [...l] };
}
function qualityBadges(kind, item, max = 3) {
  const { q, h } = qualities(kind, item);
  const out = q.slice(0, max).map(x => `<span class="badge ${x === '4K' ? 'hot' : 'dark'}">${QLABEL[x]}</span>`);
  if (h.length) out.push(`<span class="badge dark">${h.includes('DV') ? 'DV' : 'HDR'}</span>`);
  return out.join('');
}

function setCatalog(d) {
  S.cat = d;
  S.meta = d.meta || {};
  S.verify = d.verify || {};
  S.tmIdx = { movie: {}, series: {} };
  S.idx = { movie: {}, series: {}, live: {} };
  S.counts = { movie: {}, series: {}, live: {} };
  S.disc = { movie: null, series: null };
  for (const [kind, arr] of [['movie', d.movies], ['series', d.series], ['live', d.live]]) {
    for (const it of arr) {
      S.idx[kind][it.k] = it;
      for (const c of (Array.isArray(it.c) ? it.c : [it.c])) S.counts[kind][c] = (S.counts[kind][c] || 0) + 1;
      const m = kind !== 'live' && S.meta[mkey(kind, it)];
      if (m && m.id) S.tmIdx[kind][m.id] = it.k;
    }
  }
}

/* Deux fiches reconnues comme la même œuvre TMDB : on les fusionne */
function registerTmdb(kind, key) {
  const m = S.meta[(kind === 'movie' ? 'm:' : 't:') + key];
  if (!m || !m.id) return false;
  const other = S.tmIdx[kind][m.id];
  if (!other || other === key || !S.idx[kind][other]) { S.tmIdx[kind][m.id] = key; return false; }
  const keep = S.idx[kind][other], dup = S.idx[kind][key];
  if (!dup) return false;
  const vk = kind === 'movie' ? 'v' : 's';
  keep[vk].push(...dup[vk]);
  if (kind === 'movie') keep.v.sort((a, b) => b.rank - a.rank);
  dup.c.forEach(c => { if (!keep.c.includes(c)) keep.c.push(c); });
  const arr = list(kind);
  const i = arr.indexOf(dup);
  if (i >= 0) arr.splice(i, 1);
  delete S.idx[kind][key];
  $$(`.card[data-kind="${kind}"][data-k="${CSS.escape(key)}"]`).forEach(c => c.remove());
  refreshCards(kind, other);
  return true;
}
function resolve(kind, key) {
  const it = S.idx[kind][key];
  if (it) return it;
  const m = S.meta[(kind === 'movie' ? 'm:' : 't:') + key];
  const k2 = m && m.id && S.tmIdx[kind][m.id];
  return k2 ? S.idx[kind][k2] : null;
}

/* Téléchargements */
function setDownloads(d) {
  S.dl = d;
  S.dlByVid = {};
  S.dlByKey = {};
  for (const it of d.items) {
    S.dlByVid[String(it.vid)] = it;
    const k = (it.kind === 'movie' ? 'movie:' : 'series:') + it.key;
    if (!S.dlByKey[k] || it.status === 'done') S.dlByKey[k] = it;
  }
}
const dlState = vid => S.dlByVid[String(vid)] || null;
const isDownloaded = (kind, item) => { const d = S.dlByKey[(kind === 'movie' ? 'movie:' : 'series:') + item.k]; return d && d.status === 'done'; };

/* ------------------------------------------------------------ jaquettes TMDB (à la demande) */
const pending = new Map();
let flushTimer = null, inflight = 0;
function want(kind, item) {
  if (!S.cfg.has_tmdb || kind === 'live') return;
  const k = mkey(kind, item);
  if (S.meta[k] !== undefined || pending.has(k)) return;
  pending.set(k, { kind, key: item.k, title: item.t, year: item.y, tmdb: item.tm, _k: k });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 180);
}
async function flush() {
  if (!pending.size || inflight >= 2) return;
  const batch = [...pending.values()].slice(0, 24);
  batch.forEach(b => { pending.delete(b._k); S.meta[b._k] = S.meta[b._k] === undefined ? false : S.meta[b._k]; });
  inflight++;
  try {
    const res = await api('/api/enrich', { items: batch });
    for (const b of batch) {
      S.meta[b._k] = res[b._k] || null;
      if (res[b._k] && !registerTmdb(b.kind, b.key)) refreshCards(b.kind, b.key);
    }
    if (S.heroEmpty && S.route.page === 'home') upgradeHero();
  } catch (e) {
    batch.forEach(b => { if (S.meta[b._k] === false) delete S.meta[b._k]; });
  } finally {
    inflight--;
    if (pending.size) setTimeout(flush, 60);
  }
}
async function fullMeta(kind, item) {
  const k = mkey(kind, item);
  const m = S.meta[k];
  if (!S.cfg.has_tmdb || (m && 'o' in m) || m === null) return m;
  try {
    const res = await api('/api/enrich', { items: [{ kind, key: item.k, title: item.t, year: item.y, tmdb: item.tm }] });
    S.meta[k] = res[k] || null;
    registerTmdb(kind, item.k);
  } catch { /* hors ligne */ }
  return S.meta[k];
}
function refreshCards(kind, key) {
  const item = S.idx[kind][key];
  if (!item) return;
  $$(`.card.poster-card[data-kind="${kind}"][data-k="${CSS.escape(key)}"]`).forEach(c => c.replaceWith(posterCard(kind, item)));
}
const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    const { kind, k } = e.target.dataset;
    const item = S.idx[kind] && S.idx[kind][k];
    if (item) want(kind, item);
  }
}, { rootMargin: '500px' });

/* ------------------------------------------------------------ chargements différés */
async function loadDiscover(kind) {
  if (!S.cfg.has_tmdb) return null;
  if (S.disc[kind]) return S.disc[kind];
  if (!S.discLoading[kind]) {
    S.discLoading[kind] = api('/api/discover?kind=' + kind).then(d => {
      for (const [k, m] of Object.entries(d.meta || {})) {
        const cur = S.meta[k];
        if (!cur || !cur.id) S.meta[k] = m;
        const key = k.slice(2);
        if (S.idx[kind][key]) registerTmdb(kind, key);
      }
      S.disc[kind] = d;
      return d;
    }).catch(e => { console.warn(e); S.disc[kind] = { rows: [] }; return S.disc[kind]; })
      .finally(() => { S.discLoading[kind] = null; });
  }
  return S.discLoading[kind];
}

/* Rangée TMDB -> éléments affichables : titres du catalogue et titres absents (« fantômes ») */
function discRows(kind) {
  const d = S.disc[kind];
  if (!d) return [];
  const showGhosts = S.cfg.show_unavailable !== false;
  return d.rows.map(r => {
    const seen = new Set(), items = [];
    for (const e of r.items || []) {
      if (e.g) { if (showGhosts) items.push({ ghost: e.g }); continue; }
      const it = resolve(kind, e.k);
      if (!it || seen.has(it.k)) continue;
      seen.add(it.k);
      if (!itemState(kind, it).ok && !showGhosts) continue;
      items.push(it);
    }
    return { ...r, items };
  }).filter(r => r.items.filter(x => !x.ghost).length >= 3 || r.items.length >= 6);
}

async function loadNow(force) {
  if (S.now && !force && Date.now() / 1000 - S.now.ts < 240) return S.now;
  if (!S.nowLoading) {
    S.nowLoading = api('/api/live_now' + (force ? '?refresh=1' : '')).then(d => { S.now = d; return d; })
      .catch(() => { S.now = { events: [], now: {}, ts: Date.now() / 1000 }; return S.now; })
      .finally(() => { S.nowLoading = null; });
  }
  return S.nowLoading;
}
async function loadTonight(force) {
  if (S.tonight && !force && Date.now() / 1000 - S.tonight.ts < 1200) return S.tonight;
  if (!S.tonightLoading) {
    S.tonightLoading = api('/api/tonight' + (force ? '?refresh=1' : '')).then(d => { S.tonight = d; return d; })
      .catch(() => { S.tonight = { items: [], ts: Date.now() / 1000 }; return S.tonight; })
      .finally(() => { S.tonightLoading = null; });
  }
  return S.tonightLoading;
}
async function loadForYou(force) {
  if (!S.cat || !S.cfg.has_tmdb) { S.forYou = { rows: [] }; return S.forYou; }
  if (S.forYou && !force) return S.forYou;
  if (!S.forYouLoading) {
    S.forYouLoading = api('/api/for_you').then(d => {
      for (const [k, m] of Object.entries(d.meta || {})) if (!S.meta[k] || !S.meta[k].id) S.meta[k] = m;
      S.forYou = d;
      return d;
    }).catch(() => (S.forYou = { rows: [] })).finally(() => { S.forYouLoading = null; });
  }
  return S.forYouLoading;
}

async function loadUpNext() {
  if (!S.cat) return;
  try {
    S.upNext = await api('/api/up_next');
    if (S.route.page === 'home' && S.upNext.length) softRefresh();
  } catch { /* hors ligne */ }
}

async function loadDownloads() {
  try { setDownloads(await api('/api/downloads')); } catch { /* ignore */ }
  return S.dl;
}
