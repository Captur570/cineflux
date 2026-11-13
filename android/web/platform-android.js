/* ShippoTV Android (box Android TV, Player Freebox Pop…) — chargé après platform.js (interface TV,
   télécommande) et avant boot.js :
   - lecture confiée à l'appli native (lecteur Android Media3 ou VLC, choisi film par film) ;
   - touches Retour / lecture / chaînes transmises par l'appli ;
   - bandes-annonces dans l'appli YouTube, sortie de l'appli. */
(function () {
  'use strict';
  const NATIVE = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
  const native = msg => (NATIVE ? NATIVE.postMessage(msg) : Promise.reject(new Error('natif absent')));
  document.body.classList.add('platform-android');

  /* ------------------------------------------------------------ mode test (fabrication GitHub, émulateur) */
  const T = window.SHIPPO_TEST;
  if (T && window.ENGINE) {
    const call0 = ENGINE.call;
    let ready = false;
    ENGINE.call = async function (path, body, prof) {
      if (!ready) {
        ready = true;
        await ENGINE.ready();
        const c = ENGINE._CONFIG.data;
        if (!c.server && T.route !== 'setup') Object.assign(c, { server: T.server, username: T.user, password: T.pass, country: 'FR', tmdb_key: T.tmdb || c.tmdb_key || '' });
        ENGINE._CONFIG.save();
      }
      return call0.call(this, path, body, prof);
    };
    const go2 = () => {
      if (typeof S === 'undefined' || !S.cat || !S.cat.movies || !S.cat.movies.length) return setTimeout(go2, 500);
      setTimeout(() => {
        const dune = S.cat.movies.find(m => /dune/i.test(m.t)) || S.cat.movies[0];
        if (T.route === 'detail') openDetail('movie', dune);
        else if (T.route === 'live') go('live');
        else if (T.route === 'series') go('series');
        else if (T.route === 'settings') go('settings');
        else if (T.route === 'player') playMovie(dune);
        else if (T.route === 'live_play') playLive(S.cat.live.find(c => c.k === 'france2') || S.cat.live[0], 0);
        else if (T.route === 'js') { try { (0, eval)(atob(T.js64)); } catch (e) { console.error('[essai] ' + e); } }
        else if (T.route === 'probe') native({ cmd: 'play', title: 'Essai du choix du lecteur', sub: T.probe || '', kind: 'movie', live: false,
          streams: [{ url: 'http://' + T.server + '/' + (T.probe || 'scope.mkv'), label: T.label || '' }], start: 0 });
      }, 4000);
    };
    if (T.route && T.route !== 'home' && T.route !== 'setup') setTimeout(go2, 1000);
  }

  /* ------------------------------------------------------------ sortie, bande-annonce */
  window.close = () => native({ cmd: 'exit' }).catch(() => {});
  window.TV_TRAILER = key => native({ cmd: 'openURL', url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(key) })
    .catch(() => toast("Impossible d'ouvrir YouTube", 'warn'));

  /* ------------------------------------------------------------ touches envoyées par l'appli (Retour, médias, chaînes) */
  window.ANDROID_KEY = function (name) {
    const ev = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(ev);
  };

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
        streams.push({ url: st.url, label: s.label || '', id: s.id, ext: s.ext || st.ext || '' });
      } catch { /* source ignorée */ }
    }
    if (!streams.length) { toast('Aucune source ne répond pour le moment', 'error', 5000); return; }
    cur = { o, streams };
    P.o = o;                        // l'interface sait qu'une lecture est en cours
    closeModal();
    if (typeof Preview !== 'undefined') Preview.hide();
    native({ cmd: 'play', title: o.title, sub: o.sub || '', kind: o.kind, key: o.key || '', live: o.kind === 'live', streams,
      start: resumeOf(o), next: !!o.next, nextLabel: o.nextLabel || '' }).catch(e => toast(e.message, 'error'));
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
  /* zapping : chaîne précédente / suivante dans la catégorie de la chaîne en cours */
  function zap(d) {
    const o = cur && cur.o;
    if (!o || o.kind !== 'live') return;
    const ch = S.idx.live[o.key];
    const arr = ch ? S.cat.live.filter(c => c.c === ch.c) : S.cat.live;
    const list = arr.length > 1 ? arr : S.cat.live;
    const i = list.findIndex(c => c.k === o.key);
    if (i < 0) return;
    playLive(list[(i + d + list.length) % list.length], 0);
  }

  /* évènements envoyés par le lecteur natif (mêmes noms que sur l'iPad) */
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
