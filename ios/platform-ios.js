/* ShippoTV iPad — adaptation de l'interface à l'appli iOS :
   - lecture confiée au lecteur natif (VLC), qui lit tous les formats ;
   - bandes-annonces dans l'appli YouTube ;
   - interface tactile (pas de survol, pas de téléchargements).
   Chargé après player.js et avant boot.js. */
(function () {
  'use strict';
  const NATIVE = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
  const native = msg => (NATIVE ? NATIVE.postMessage(msg) : Promise.reject(new Error('natif absent')));
  document.body.classList.add('platform-ios', 'touch');

  /* ------------------------------------------------------------ mode test (fabrication GitHub) */
  const T = window.SHIPPO_TEST;
  if (T && window.ENGINE) {
    const call0 = ENGINE.call;
    let ready = false;
    ENGINE.call = async function (path, body, prof) {
      if (!ready) {
        ready = true;
        await ENGINE.ready();
        const c = ENGINE._CONFIG.data;
        if (!c.server) Object.assign(c, { server: T.server, username: T.user, password: T.pass, country: T.country || 'FR', tmdb_key: T.tmdb || c.tmdb_key || '' });
        ENGINE._CONFIG.save();
      }
      return call0.call(this, path, body, prof);
    };
    const go2 = () => {
      if (!window.S || !S.cat) return setTimeout(go2, 500);
      setTimeout(() => {
        if (T.route === 'detail') openDetail('movie', S.cat.movies.find(m => /dune/i.test(m.t)) || S.cat.movies[0]);
        else if (T.route === 'live') go('live');
        else if (T.route === 'settings') go('settings');
        else if (T.route === 'player') playMovie(S.cat.movies.find(m => /dune/i.test(m.t)) || S.cat.movies[0]);
      }, 4000);
    };
    if (T.route && T.route !== 'home') setTimeout(go2, 1000);
  }

  /* ------------------------------------------------------------ bande-annonce : appli YouTube */
  window.TV_TRAILER = key => native({ cmd: 'openURL', url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(key) })
    .catch(() => toast("Impossible d'ouvrir YouTube", 'warn'));

  /* ------------------------------------------------------------ lecture : lecteur natif */
  let cur = null;          // { o, streams }
  const resumeOf = o => {
    if (o.kind === 'live' || !o.pid) return 0;
    const p = (S.cfg.progress || {})[o.pid];
    return p && p.pos > 30 && p.dur && p.pos / p.dur < 0.94 ? p.pos : 0;
  };
  // eslint-disable-next-line no-global-assign
  play = async function (o) {
    if (!(await freeToPlay())) return;
    const title = o.title + (o.sub && o.kind !== 'movie' ? ' · ' + o.sub : '');
    const streams = [];
    for (const s of o.streams) {
      try {
        const st = await api('/api/stream', { ...s, title });
        streams.push({ url: st.url, label: s.label || '', id: s.id });
      } catch { /* source ignorée */ }
    }
    if (!streams.length) { toast('Aucune source ne répond pour le moment', 'error', 5000); return; }
    cur = { o, streams };
    P.o = o;                        // l'interface sait qu'une lecture est en cours
    closeModal();
    Preview.hide();
    native({ cmd: 'play', title: o.title, sub: o.sub || '', live: o.kind === 'live', streams, start: resumeOf(o),
      next: !!o.next, nextLabel: o.nextLabel || '', logo: o.logo || '' }).catch(e => toast(e.message, 'error'));
  };

  function saveProgress(pos, dur, idx, final) {
    const o = cur && cur.o;
    if (!o || o.kind === 'live' || !o.pid || !(dur > 0)) return;
    if (pos < 5 && !final) return;
    const done = pos / dur > 0.94;
    const st = cur.streams[idx] || cur.streams[0];
    const entry = { id: o.pid, kind: o.kind, key: o.key, label: o.sub, ep: o.ep || null, pos, dur, vid: st && st.id };
    S.cfg.progress = S.cfg.progress || {};
    S.cfg.progress[o.pid] = done ? { ...entry, pos: dur, done: true, ts: Date.now() / 1000 } : { ...entry, ts: Date.now() / 1000 };
    api('/api/progress', done ? { ...entry, clear: true } : entry).catch(() => {});
  }
  function zap(d) {
    const o = cur && cur.o;
    if (!o || o.kind !== 'live') return;
    const arr = S.cat.live;
    let i = arr.findIndex(c => c.k === o.key);
    if (i < 0) return;
    playLive(arr[(i + d + arr.length) % arr.length], 0);
  }

  /* évènements envoyés par le lecteur natif */
  window.IOS_PLAYER = function (ev) {
    if (!ev) return;
    if (ev.type === 'progress') saveProgress(ev.pos, ev.dur, ev.idx || 0, false);
    else if (ev.type === 'zap') zap(ev.d || 1);
    else if (ev.type === 'next') { const o = cur && cur.o; saveProgress(ev.pos || 0, ev.dur || 0, ev.idx || 0, true); if (o && o.next) o.next(); }
    else if (ev.type === 'ended') {
      const o = cur && cur.o;
      saveProgress(ev.dur || 0, ev.dur || 0, ev.idx || 0, true);
      if (o && o.next) { toast('Épisode suivant…'); o.next(); } else native({ cmd: 'stop' }).catch(() => {});
    } else if (ev.type === 'closed') {
      saveProgress(ev.pos || 0, ev.dur || 0, ev.idx || 0, true);
      cur = null;
      P.o = null;
      api('/api/player_closed', {}).catch(() => {});
      softRefresh();
      loadUpNext();
    }
  };

  /* fermeture demandée par l'interface (arrêt à distance depuis un autre appareil, etc.) */
  const close0 = P.close.bind(P);
  P.close = function (silent) {
    if (cur) {
      native({ cmd: 'stop' }).catch(() => {});
      cur = null;
      this.o = null;
      api('/api/player_closed', {}).catch(() => {});
      if (!silent) softRefresh();
      return;
    }
    return close0(silent);
  };
})();
