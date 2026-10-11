'use strict';
/* ShippoTV — démarrage et évènements venus du moteur */

function splash(msg) { $('#splash').classList.remove('gone'); $('#splash-msg').textContent = msg; }
function unsplash() { $('#splash').classList.add('gone'); }

async function loadCatalog(force) {
  splash(force ? 'Actualisation du catalogue…' : 'Chargement du catalogue…');
  const slow = setTimeout(() => $('#splash-msg').textContent = 'Premier chargement : le catalogue complet est téléchargé, cela peut prendre une minute…', 4000);
  try {
    const d = await api('/api/catalog' + (force ? '?refresh=1' : ''));
    setCatalog(d);
    S.now = null; S.tonight = null;
    await loadDownloads();
    unsplash();
    go('home', {}, { replace: true });
    loadNow(); loadTonight(); loadUpNext();
    if (S.cfg.has_tmdb) { loadDiscover('movie'); loadDiscover('series'); }
  } catch (e) {
    unsplash();
    go('settings', { first: !S.cat, error: e.message }, { replace: true });
  } finally { clearTimeout(slow); }
}

/* Nouveau catalogue reçu en arrière-plan : on le recharge sans interrompre l'utilisateur */
async function reloadCatalog() {
  try {
    const d = await api('/api/catalog');
    setCatalog(d);
    S.cfg = { ...S.cfg, ...(await api('/api/config')) };
    softRefresh();
    if (S.cfg.has_tmdb) { loadDiscover('movie').then(() => S.route.page === 'home' && softRefresh()); loadDiscover('series'); }
  } catch { /* hors ligne */ }
}

async function pollEvents() {
  if (!S.cfg) return;
  if (P.o && document.body.classList.contains('tv') && (S._pe = (S._pe || 0) + 1) % 4) return;   // lecture sur la télé : moins souvent
  try {
    const ev = await api('/api/events?since=' + S.evId);
    for (const e of ev) {
      S.evId = Math.max(S.evId, e.id);
      switch (e.kind) {
        case 'closed': {
          const c = await api('/api/config').catch(() => null);
          if (c) { S.cfg.progress = c.progress; S.cfg.history = c.history; S.cfg.follow = c.follow; }
          S.forYou = null;
          softRefresh();
          loadUpNext();
          break;
        }
        case 'remote_stop':
          if (P.o) P.close(true);
          toast(e.msg, 'info', 8000);
          break;
        case 'update_tv':
          toast(e.msg, 'info', 20000);
          break;
        case 'refreshing':
          S.cfg.refreshing = !!(e.data || {}).on;
          updateOfflineBanner();
          break;
        case 'catalog':
          S.cfg.refreshing = false; updateOfflineBanner();
          if (e.msg) toast(e.msg, 'info', 6000);
          S.cfg.catalog_ts = (e.data || {}).ts || S.cfg.catalog_ts;
          reloadCatalog();
          break;
        case 'verify': {
          const changed = e.data || {};
          Object.assign(S.verify, changed);
          const vids = new Set(Object.keys(changed));
          for (const it of S.cat ? S.cat.movies : []) if (it.v.some(v => vids.has(String(v.id)))) refreshCards('movie', it.k);
          break;
        }
        case 'avail': {
          const d = e.data || {};
          if (d.profile && d.profile !== S.profile) break;
          const it = d.key && S.idx[d.kind] && S.idx[d.kind][d.key];
          toast(e.msg, 'info', 15000, it ? { label: 'Voir', run: () => openDetail(d.kind, it) } : null);
          S.cfg.notify = (S.cfg.notify || []).filter(n => !(it && S.meta[mkey(d.kind, it)] && Number(n.id) === Number(S.meta[mkey(d.kind, it)].id)));
          break;
        }
        case 'download':
          toast(e.msg, 'info', 6000, { label: 'Voir', run: () => go('downloads') });
          loadDownloads().then(() => S.route.page !== 'downloads' && softRefresh());
          break;
        case 'sync': {
          const c = await api('/api/config').catch(() => null);
          if (c) {
            S.cfg = { ...S.cfg, ...c };
            S.favs = new Set(c.favs);
            if (!c.profiles.some(p => p.id === S.profile)) S.profile = c.profile;
            updateNavProfile();
            if (S.route.page !== 'settings') softRefresh();
            loadUpNext();
          }
          break;
        }
        case 'newep': {
          const d = e.data || {};
          if (d.profile && d.profile !== S.profile) break;
          const it = d.key && S.idx.series && S.idx.series[d.key];
          const c = await api('/api/config').catch(() => null);
          if (c) S.cfg.follow = c.follow;
          toast(e.msg, 'info', 15000, it ? { label: 'Voir', run: () => openDetail('series', it) } : null);
          if (it) refreshCards('series', it.k);
          loadUpNext();
          break;
        }
        case 'update': {
          const d = e.data || {};
          toast(e.msg, 'info', 20000, { label: 'Installer', run: () => installUpdate() });
          break;
        }
        case 'update_go':
          splash(e.msg);
          break;
        default:
          if (e.msg) toast(e.msg, e.level);
      }
    }
  } catch {
    if (S.cfg.online !== false) { S.cfg.online = false; updateOfflineBanner(); }
    return;
  }
  if (S.cfg.online === false) {
    const c = await api('/api/config').catch(() => null);
    if (c && c.online) { S.cfg.online = true; updateOfflineBanner(); }
  }
}
setInterval(pollEvents, 1500);
setInterval(async () => {          // état de la connexion au fournisseur
  if (!S.cfg || !S.cat) return;
  const c = await api('/api/config').catch(() => null);
  if (c) { S.cfg.online = c.online; S.cfg.refreshing = c.refreshing; updateOfflineBanner(); }
}, 30000);

async function boot() {
  try {
    try { S.profile = sessionStorage.getItem('cineflux_profile'); } catch { S.profile = null; }
    S.cfg = await api('/api/config');
  } catch (e) {
    $('#splash-msg').textContent = 'Erreur de démarrage : ' + e.message;
    return;
  }
  if (!S.profile) S.profile = S.cfg.profile;
  S.favs = new Set(S.cfg.favs);
  applyUiMode();
  setupNav();
  initPlayer();
  if (!S.cfg.configured) { unsplash(); go('settings', { first: true }, { replace: true }); return; }
  if (S.cfg.profiles.length > 1 && !sessionStorageHas()) {
    unsplash();
    go('profiles', {}, { replace: true });
    return;
  }
  loadCatalog(false);
}
function sessionStorageHas() {
  try { return !!sessionStorage.getItem('cineflux_profile'); } catch { return false; }
}

boot();
