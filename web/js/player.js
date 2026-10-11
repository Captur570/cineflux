'use strict';
/* ShippoTV — lecture : lecteur rapide intégré, VLC embarqué, lecteur externe */

/* ============================================================ lecture */
/* Choix du lecteur :
   auto     -> VOD dans VLC embarqué, direct dans le lecteur web (bascule sur VLC si besoin)
   vlc      -> tout dans VLC embarqué
   web      -> tout dans le lecteur web
   external -> mpv / VLC installé, dans sa propre fenêtre */
/* Abonnement à une seule connexion : si un autre appareil du groupe lit déjà, on le dit clairement
   et on propose de l'arrêter à distance. */
async function freeToPlay() {
  let r;
  try { r = await api('/api/others'); } catch { return true; }
  const others = (r && r.others) || [];
  const max = Number((S.cat && S.cat.account && S.cat.account.max) || r.max || 1) || 1;
  if (!others.length || others.length < max) return true;
  const o = others[0];
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const b = openModal(`<div class="dialog busy-dlg"><h2>Déjà en lecture sur « ${esc(o.name)} »</h2>
      <p>${o.title ? `« ${esc(o.title)} » est en cours de lecture sur cet appareil. ` : ''}Votre abonnement ne permet ${max > 1 ? `que ${max} lectures` : 'qu’une lecture'} à la fois.</p>
      <div class="actions"><button class="btn btn-play" data-b="stop" autofocus>${ico('stop')}Arrêter sur « ${esc(o.name)} » et lire ici</button>
      <button class="btn btn-ghost" data-b="force">Lire quand même</button><button class="btn btn-ghost" data-b="no">Annuler</button></div>
      <p class="dim small busy-wait" hidden></p></div>`, 'small');
    const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); finish(false); } });
    obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
    b.querySelector('[data-b="no"]').onclick = () => { obs.disconnect(); closeModal(); finish(false); };
    b.querySelector('[data-b="force"]').onclick = () => { obs.disconnect(); closeModal(); finish(true); };
    b.querySelector('[data-b="stop"]').onclick = async e => {
      e.currentTarget.disabled = true;
      const w = b.querySelector('.busy-wait');
      w.hidden = false;
      w.innerHTML = `<span class="spin"></span> Arrêt demandé à « ${esc(o.name)} »… (quelques secondes)`;
      try { await api('/api/remote_stop', { device: o.id }); } catch { /* on lit quand même */ }
      const t0 = Date.now();
      while (Date.now() - t0 < 45000 && !done) {
        await new Promise(r2 => setTimeout(r2, 2500));
        const x = await api('/api/others').catch(() => null);
        if (x && !(x.others || []).some(d => d.id === o.id)) break;
      }
      await new Promise(r2 => setTimeout(r2, 3000));       // le temps que le fournisseur libère la connexion
      obs.disconnect(); closeModal(); finish(true);
    };
  });
}
async function play(o) {
  if (!(await freeToPlay())) return;
  const mode = S.cfg.player_mode || 'auto';
  if (mode === 'external') return playExternal(o);
  const useVlc = S.cfg.vlc && (mode === 'vlc' || (mode === 'auto' && o.kind !== 'live'));
  if (useVlc) return playVlc(o);
  P.open(o);
}
async function playVlc(o, fromIdx = 0) {
  try {
    P.close(true);
    const streams = [...o.streams.slice(fromIdx), ...o.streams.slice(0, fromIdx)];
    await api('/api/vlc_play', {
      title: o.title, sub: o.sub, kind: o.kind, key: o.key, pid: o.pid, ep: o.ep || null, streams,
      queue: (o.queue || []).map(q => ({ title: q.title, sub: q.sub, pid: q.pid, ep: q.ep, streams: q.streams })),
    });
    toast(o.kind === 'live' ? `${o.title} dans le lecteur VLC` : o.kind === 'replay' ? `Replay : ${o.sub}` : `Lecture de « ${o.title} »`, 'info', 2500);
  } catch (e) {
    toast(e.message, 'error', 6000);
    if (o.kind !== 'live' || !P.o) P.open(o);
  }
}
async function playExternal(o) {
  if (!S.cfg.player) {
    toast('Aucun lecteur externe trouvé : installez mpv ou VLC, ou utilisez le lecteur intégré (Réglages)', 'error', 6000);
    return;
  }
  try {
    await api('/api/play', { title: o.title + (o.sub ? ' – ' + o.sub : ''), streams: o.streams, kind: o.kind, key: o.key });
  } catch (e) { toast(e.message, 'error', 6000); }
}
/* Meilleure version d'abord : 4K HDR > 4K > 1080p > 720p. Sur la télé (Samsung ne gère pas le Dolby Vision),
   une version « DV » passe après une 4K HDR10 équivalente. */
function bestFirst(pool) {
  if (!document.body.classList.contains('tv') && !document.body.classList.contains('platform-ios')) return pool;
  const score = v => {
    const t = (v.q || '').split(' · ');
    const q = QRANK[t.find(x => QRANK[x])] || 0;
    return q * 10 + (t.includes('HDR') ? 2 : 0) + (t.includes('DV') ? -1 : 0);
  };
  return pool.map((v, k) => [v, k]).sort((a, b) => (score(b[0]) - score(a[0])) || (a[1] - b[1])).map(x => x[0]);
}
function playMovie(item, idx = 0, force = false) {
  const i = info('movie', item);
  const pool = bestFirst(force ? item.v : (goodVersions(item).length ? goodVersions(item) : item.v));
  const chosen = idx > 0 || force;                               // version choisie à la main dans la fiche
  const first = chosen && item.v[idx] && (force || pool.includes(item.v[idx])) ? item.v[idx] : pool[0];
  const order = [first, ...pool.filter(v => v !== first)];
  const st = vstat(first.id) || [];
  play({
    title: i.title, sub: [i.year, versionTitle(first), st[2]].filter(Boolean).join(' · '),
    kind: 'movie', key: item.k, pid: 'm:' + item.k,
    streams: order.map(v => ({ type: 'movie', id: v.id, ext: v.ext, label: versionTitle(v) + ((vstat(v.id) || [])[2] ? ' · ' + vstat(v.id)[2] : '') })),
  });
}
function playLive(item, idx, only) {
  const order = only ? [item.s[idx], ...item.s.filter((_, k) => k !== idx)] : item.s;
  const n = S.now && S.now.now[item.k];
  play({
    title: item.t, sub: n ? n.t : '', kind: 'live', key: item.k, logo: item.p,
    streams: order.map((s, k) => ({ type: 'live', id: s.id, label: `Source ${item.s.indexOf(s) + 1}${s.q ? ' · ' + (QLABEL[s.q] || s.q) : ''}` })),
  });
}

/* ------------------------------------------------------------ lecteur intégré */
const P = {
  o: null, idx: 0, hls: null, ts: null, saveTimer: null, idleTimer: null, fs: false, audioCheck: null,
  get v() { return window.TVVIDEO || $('#pv'); },

  open(o) {
    this.close(true);
    closeModal();
    Preview.hide();
    this.o = o;
    this.idx = 0;
    this._handedOff = false;
    this._retries = 0;
    this._started = false;
    this._lastPos = 0;
    this._ui = {};
    const root = $('#player');
    root.hidden = false;
    root.classList.toggle('is-live', o.kind === 'live');
    document.body.classList.add('playing');
    $('#pl-title').textContent = o.title;
    $('#pl-sub').textContent = o.sub || '';
    $('#pl-logo').innerHTML = o.logo ? `<img src="${esc(o.logo)}" alt="" onerror="this.remove()">` : '';
    $('#pl-ext').hidden = !(S.cfg.vlc || S.cfg.player);
    $('#pl-ext').title = S.cfg.vlc ? 'Ouvrir dans le lecteur VLC intégré' : 'Ouvrir dans le lecteur externe';
    $('#pl-next').hidden = !o.next;
    if (o.next) $('#pl-next').title = 'Épisode suivant : ' + (o.nextLabel || '');
    this.renderSources();
    this.wake();
    this.load(0, true);
  },

  renderSources() {
    const sel = $('#pl-src');
    sel.innerHTML = '';
    if (this.o.streams.length < 2) { sel.hidden = true; return; }
    sel.hidden = false;
    this.o.streams.forEach((s, k) => sel.append(new Option(s.label || 'Source ' + (k + 1), k)));
    sel.value = this.idx;
  },

  /* at : position de reprise (relance de la même source après une coupure) */
  async load(idx, first, at) {
    const o = this.o;
    if (idx !== this.idx) { this._retries = 0; this._started = false; }
    this.idx = idx;
    $('#pl-res').hidden = true;
    $('#pl-src').value = idx;
    this.teardown();
    this.msg(null);
    this.spin(true);
    const v = this.v;
    let st;
    try { st = await api('/api/stream', { ...o.streams[idx], title: o.title + (o.sub && o.kind !== 'movie' ? ' · ' + o.sub : '') }); }
    catch (e) { return this.fail(e.message); }
    if (this.o !== o) return;
    v.muted = false;
    const resumeAt = at > 0 ? at : (() => {
      if (!first || o.kind === 'live' || !o.pid) return 0;
      const p = (S.cfg.progress || {})[o.pid];
      return p && p.pos > 30 && p.pos / p.dur < 0.94 ? p.pos : 0;
    })();
    if (st.mode === 'hls' && window.Hls && Hls.isSupported()) {
      const hls = this.hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, maxBufferLength: 40, startPosition: resumeAt || -1,
        manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4 });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !this._recovered) { this._recovered = true; hls.recoverMediaError(); return; }
        this.fail('Flux indisponible');
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => {}); this.renderTracks(); });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this.renderTracks());
      hls.loadSource(st.url);
      hls.attachMedia(v);
    } else if (st.mode === 'ts' && window.mpegts && mpegts.isSupported()) {
      const p = this.ts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: st.url },
        { enableWorker: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 6, lazyLoad: false });
      p.on(mpegts.Events.ERROR, () => this.fail('Flux indisponible'));
      p.attachMediaElement(v);
      p.load();
      v.play().catch(() => {});
    } else {
      v.src = st.url;
      if (resumeAt) {
        v.addEventListener('loadedmetadata', () => { v.currentTime = resumeAt; }, { once: true });
        if (!at) this.resumeNote(resumeAt);
      }
      v.play().catch(() => {});
    }
    this._recovered = false;
    this.renderTracks();
    if (o.kind !== 'live') {
      clearInterval(this.saveTimer);
      this.saveTimer = setInterval(() => this.saveProgress(), 10000);
    }
  },

  resumeNote(at) {
    const n = $('#pl-resume');
    n.innerHTML = `Reprise à ${clock(at)} <button>Reprendre du début</button>`;
    n.hidden = false;
    n.querySelector('button').onclick = () => { this.v.currentTime = 0; n.hidden = true; };
    clearTimeout(this._rn);
    this._rn = setTimeout(() => { n.hidden = true; }, 9000);
  },

  fail(reason) {
    if (!this.o) return;
    // coupure en cours de lecture : on relance la même source là où on en était (jusqu'à 3 fois),
    // sans jamais passer en silence sur une autre version (qualité qui change en plein film)
    if (this._started && reason !== 'audio' && (this._retries || 0) < 3) {
      this._retries = (this._retries || 0) + 1;
      const at = this.o.kind === 'live' ? 0 : Math.max(0, (this._lastPos || this.v.currentTime || 0) - 2);
      this._retryAt = at;
      toast('Coupure du flux, reprise…', 'info', 2000);
      const o = this.o, idx = this.idx;
      clearTimeout(this._retryT);
      this._retryT = setTimeout(() => { if (this.o === o) this.load(idx, false, at); }, 600 * this._retries);
      return;
    }
    if (this._started && this.o.kind !== 'live' && reason !== 'audio') {
      this.spin(false);
      const others = this.o.streams.length > 1;
      this.msg(`<strong>La lecture s'est interrompue</strong>
        <p>Le serveur ne répond plus pour cette version. Vous pouvez réessayer${others ? ' ou choisir une autre version (la qualité peut être différente)' : ''}.</p>
        <div class="actions"><button class="btn btn-play" data-act="again">Réessayer</button>
        ${others ? '<button class="btn btn-ghost" data-act="other">Autre version</button>' : ''}</div>`);
      return;
    }
    if (S.cfg.vlc && this.o.kind === 'live' && !this._handedOff) {
      // format ou son non pris en charge par le lecteur web : VLC prend le relais sur la même source
      this._handedOff = true;
      const o = this.o, idx = this.idx;
      toast(reason === 'audio' ? 'Son non pris en charge ici : passage sur VLC…' : 'Passage sur le lecteur VLC…', 'warn', 2500);
      this.close(true);
      return playVlc(o, idx);
    }
    const next = this.idx + 1;
    if (next < this.o.streams.length) {
      toast(`${this.o.streams[this.idx].label || 'Source ' + (this.idx + 1)} indisponible, essai de la suivante…`, 'warn');
      return this.load(next);
    }
    this.spin(false);
    const isAudio = reason === 'audio';
    this.msg(`<strong>${isAudio ? 'Pas de son ?' : 'Lecture impossible'}</strong>
      <p>${isAudio ? 'Ce fichier utilise sans doute un format audio (AC3, E-AC3, DTS…) que le lecteur intégré ne sait pas décoder.'
        : `${esc(reason || '')}. ${this.o.kind === 'live' ? 'La chaîne ne répond pas pour le moment.' : 'Le format de ce fichier n\'est peut-être pas pris en charge par le lecteur intégré.'}`}</p>
      <div class="actions">${S.cfg.vlc || S.cfg.player ? `<button class="btn btn-play" data-act="ext">${ico('ext')}Ouvrir dans ${S.cfg.vlc || S.cfg.player_kind === 'vlc' ? 'VLC' : 'mpv'}</button>` : ''}
      ${this.o.streams.length > 1 ? '<button class="btn btn-ghost" data-act="retry">Réessayer la 1re source</button>' : '<button class="btn btn-ghost" data-act="retry1">Réessayer</button>'}
      ${isAudio ? '<button class="btn btn-ghost" data-act="dismiss">Continuer sans le son</button>' : ''}</div>
      ${!S.cfg.player && !S.cfg.vlc ? '<p class="small">Astuce : le lecteur VLC intégré lit tous les formats (voir LISEZMOI).</p>' : ''}`, isAudio);
  },

  msg(html, soft) {
    const m = $('#pl-msg');
    if (!html) { m.hidden = true; return; }
    m.innerHTML = html;
    m.hidden = false;
    m.classList.toggle('soft', !!soft);
    m.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'ext') this.external();
      else if (a === 'again') { this._retries = 0; this.load(this.idx, false, Math.max(0, (this._lastPos || 0) - 2)); }
      else if (a === 'other') { const at = Math.max(0, (this._lastPos || 0) - 2); this.load((this.idx + 1) % this.o.streams.length, false, at); }
      else if (a === 'retry') this.load(0);
      else if (a === 'retry1') this.load(this.idx);
      else m.hidden = true;
    });
  },

  spin(on) { $('#pl-spin').hidden = !on; },

  renderTracks() {
    const sel = $('#pl-audio');
    const v = this.v;
    const tracks = this.hls ? this.hls.audioTracks : (v.audioTrackList ? v.audioTrackList() : []);
    if (!tracks || tracks.length < 2) { sel.hidden = true; return; }
    sel.hidden = false;
    sel.innerHTML = '';
    tracks.forEach((t, k) => sel.append(new Option((t.name || t.lang || 'Piste ' + (k + 1)).toUpperCase(), k)));
    sel.value = this.hls ? this.hls.audioTrack : v.audioTrackIndex();
  },

  saveProgress(final) {
    const o = this.o, v = this.v;
    if (!o || o.kind === 'live' || !o.pid || !isFinite(v.duration) || !v.duration) return;
    const pos = v.currentTime, dur = v.duration;
    if (pos < 5 && !final) return;
    const done = pos / dur > 0.94;
    const entry = { id: o.pid, kind: o.kind, key: o.key, label: o.sub, ep: o.ep || null, pos, dur, vid: o.streams[this.idx].id };
    S.cfg.progress = S.cfg.progress || {};
    S.cfg.progress[o.pid] = done ? { ...entry, pos: dur, done: true, ts: Date.now() / 1000 } : { ...entry, ts: Date.now() / 1000 };
    api('/api/progress', done ? { ...entry, clear: true } : entry).catch(() => {});
  },

  teardown() {
    clearTimeout(this.audioCheck);
    clearTimeout(this._retryT);
    if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = null; }
    if (this.ts) { try { this.ts.destroy(); } catch {} this.ts = null; }
    const v = this.v;
    v.pause();
    v.removeAttribute('src');
    try { v.load(); } catch {}
  },

  close(silent) {
    if (!this.o) return;
    this.saveProgress(true);
    clearInterval(this.saveTimer);
    this.teardown();
    this.o = null;
    $('#player').hidden = true;
    document.body.classList.remove('playing');
    if (this.fs) this.toggleFS();
    api('/api/player_closed', {}).catch(() => {});
    if (!silent) softRefresh();
  },

  external() {
    const o = this.o;
    if (!o) return;
    const idx = this.idx;
    this.close(true);
    if (S.cfg.vlc) return playVlc(o, idx);
    playExternal({ ...o, streams: [o.streams[idx], ...o.streams.filter((_, k) => k !== idx)] });
  },

  toggle() { const v = this.v; if (v.paused) v.play().catch(() => {}); else v.pause(); },
  seek(d) { const v = this.v; if (this.o && this.o.kind !== 'live' && isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration - 1, v.currentTime + d)); },
  volume(d) { const v = this.v; v.volume = Math.max(0, Math.min(1, v.volume + d)); v.muted = false; this.sync(); toast('Volume ' + Math.round(v.volume * 100) + ' %', 'info', 900); },

  async toggleFS() {
    if (S.cfg.platform === 'tv') return;          // l'appli TV est toujours en plein écran
    if (S.cfg.native) {
      try { await api('/api/fullscreen', {}); this.fs = !this.fs; } catch {}
    } else if (document.fullscreenElement) { document.exitFullscreen(); this.fs = false; }
    else { $('#player').requestFullscreen().catch(() => {}); this.fs = true; }
  },

  zap(d) {
    const o = this.o;
    if (!o || o.kind !== 'live') return;
    const arr = S.cat.live;
    let i = arr.findIndex(c => c.k === o.key);
    if (i < 0) return;
    i = (i + d + arr.length) % arr.length;
    playLive(arr[i], 0);
  },

  wake() {
    const root = $('#player');
    const was = root.classList.contains('idle');
    root.classList.remove('idle');
    if (was) this.sync(true);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.v.paused) root.classList.add('idle'); }, 3200);
  },

  /* Mise à jour des commandes : seulement ce qui a changé, et rien tant qu'elles sont cachées
     (la télé gagne beaucoup à ne pas redessiner l'interface pendant le film). */
  sync(force) {
    const v = this.v;
    if (v.currentTime > 0) this._lastPos = v.currentTime;
    if (!this._started && this.o && v.currentTime > 1 && !v.paused) { this._started = true; this._retries = 0; this.showRes(); }
    if (this._retries && v.currentTime - (this._retryAt || 0) > 90) this._retries = 0;      // relance réussie
    const ui = this._ui || (this._ui = {});
    const set = (key, val, fn) => { if (force || ui[key] !== val) { ui[key] = val; fn(val); } };
    set('pp', v.paused, p => { $('#pl-play').innerHTML = p ? ico('play') : ico('pause'); });
    // fin d'épisode : carte « Épisode suivant » avec compte à rebours
    const o = this.o, rem = isFinite(v.duration) && v.duration > 60 ? v.duration - v.currentTime : Infinity;
    const up = o && o.next && o.kind !== 'live' && rem > 0 && rem < 25 ? Math.ceil(rem) : -1;
    set('up', up, n => {
      const b = $('#pl-upnext');
      b.hidden = n < 0;
      if (n >= 0) b.innerHTML = `<span class="u-img" style="background:${gradient((o.title || '') + (o.nextLabel || ''))}"></span><span class="u-t"><small>Épisode suivant</small><b>${esc(o.nextLabel || '')}</b><span>Dans ${n} s</span></span><span class="u-ring" style="--p:${Math.round(100 * (25 - n) / 25)}%"><i>${ico('play')}</i></span>`;
    });
    if ($('#player').classList.contains('idle') && !force) return;
    set('mute', v.muted || v.volume === 0, m => { $('#pl-mute').innerHTML = m ? ico('mute') : ico('vol'); });
    set('vol', v.muted ? 0 : v.volume, x => { $('#pl-vol').value = x; });
    const live = this.o && this.o.kind === 'live';
    const dur = v.duration;
    if (!live && isFinite(dur) && dur > 0) {
      set('time', `${clock(v.currentTime)} / ${clock(dur)}`, t => { $('#pl-time').textContent = t; });
      set('cur', (100 * v.currentTime / dur).toFixed(2), w => { $('#pl-cur').style.width = w + '%'; });
      let buf = 0;
      for (let k = 0; k < v.buffered.length; k++) if (v.buffered.start(k) <= v.currentTime) buf = Math.max(buf, v.buffered.end(k));
      set('buf', (100 * buf / dur).toFixed(1), w => { $('#pl-buf').style.width = w + '%'; });
    } else if (live) {
      const n = S.now && this.o && S.now.now[this.o.key];
      set('time', n ? `<span class="live-dot"></span>DIRECT · ${hm(n.s)} – ${hm(n.e)}` : '<span class="live-dot"></span>DIRECT', h => { $('#pl-time').innerHTML = h; });
      set('cur', n ? pct(n.s, n.e) : 100, w => { $('#pl-cur').style.width = w + '%'; });
      set('buf', 0, () => { $('#pl-buf').style.width = '0'; });
    }
  },

  /* Résolution réellement reçue (et non celle annoncée par le nom du fichier) */
  showRes() {
    const v = this.v;
    const tag = () => {
      const w = v.videoWidth || 0, h = v.videoHeight || 0;
      if (!w || !h) return '';
      const p = Math.min(w * 9 / 16, h);
      const res = w >= 3200 || p >= 1800 ? '4K' : p >= 1000 ? '1080p' : p >= 700 ? '720p' : Math.round(p) + 'p';
      return res + (v.hdr ? ' · ' + v.hdr : '');
    };
    const show = () => {
      if (!this.o) return;
      const t = tag();
      const b = $('#pl-res');
      b.hidden = !t;
      b.textContent = t;
      b.classList.toggle('uhd', t.startsWith('4K'));
    };
    show();
    clearTimeout(this._resT);
    this._resT = setTimeout(show, 4000);
  },
};

function initPlayer() {
  const v = P.v, root = $('#player');
  $('#pl-back').innerHTML = ico('back');
  $('#pl-rew').innerHTML = ico('rew');
  $('#pl-fwd').innerHTML = ico('fwd');
  $('#pl-fs').innerHTML = ico('fs');
  $('#pl-ext').innerHTML = ico('ext');
  $('#pl-prev').innerHTML = ico('chevLeft');
  $('#pl-nextch').innerHTML = ico('chevRight');
  $('#pl-next').innerHTML = ico('chevRight') + '<span>Épisode suivant</span>';
  $('#pl-back').onclick = () => P.close();
  $('#pl-play').onclick = () => P.toggle();
  $('#pl-rew').onclick = () => P.seek(-10);
  $('#pl-fwd').onclick = () => P.seek(30);
  $('#pl-fs').onclick = () => P.toggleFS();
  $('#pl-ext').onclick = () => P.external();
  $('#pl-prev').onclick = () => P.zap(-1);
  $('#pl-nextch').onclick = () => P.zap(1);
  $('#pl-next').onclick = () => { const n = P.o && P.o.next; if (n) { P.saveProgress(true); n(); } };
  $('#pl-upnext').onclick = () => $('#pl-next').click();
  $('#pl-mute').onclick = () => { v.muted = !v.muted; P.sync(); };
  $('#pl-vol').oninput = e => { v.volume = +e.target.value; v.muted = v.volume === 0; P.sync(); };
  $('#pl-src').onchange = e => P.load(+e.target.value);
  $('#pl-audio').onchange = e => { if (P.hls) P.hls.audioTrack = +e.target.value; else if (P.v.setAudioTrack) P.v.setAudioTrack(+e.target.value); };
  const bar = $('#pl-bar');
  const seekTo = e => {
    if (!P.o || P.o.kind === 'live' || !isFinite(v.duration)) return;
    const r = bar.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.duration;
  };
  bar.addEventListener('mousedown', e => { seekTo(e); const mv = ev => seekTo(ev); document.addEventListener('mousemove', mv); document.addEventListener('mouseup', () => document.removeEventListener('mousemove', mv), { once: true }); });
  bar.addEventListener('mousemove', e => {
    if (!P.o || P.o.kind === 'live' || !isFinite(v.duration)) return;
    const r = bar.getBoundingClientRect(), x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const tip = $('#pl-tip'); tip.textContent = clock(x * v.duration); tip.style.left = (x * 100) + '%';
  });
  root.addEventListener('mousemove', () => P.wake());
  v.addEventListener('click', () => { P.toggle(); P.wake(); });
  v.addEventListener('dblclick', () => P.toggleFS());
  for (const ev of ['play', 'pause', 'timeupdate', 'volumechange', 'durationchange', 'progress']) v.addEventListener(ev, () => P.sync());
  v.addEventListener('waiting', () => P.spin(true));
  v.addEventListener('playing', () => {
    P.spin(false);
    P.wake();
    clearTimeout(P.audioCheck);
    if (P.o) {
      P.audioCheck = setTimeout(() => {
        if (P.o && !v.paused && !v.muted && v.currentTime > 2 && 'webkitAudioDecodedByteCount' in v && v.webkitAudioDecodedByteCount === 0) {
          P.msg(null); P.fail('audio');
        }
      }, 5000);
    }
  });
  v.addEventListener('canplay', () => P.spin(false));
  v.addEventListener('error', () => { if (P.o && !P.hls && !P.ts && v.getAttribute('src')) P.fail('Format non pris en charge'); });
  v.addEventListener('ended', () => {
    P.saveProgress(true);
    if (P.o && P.o.next) { toast('Épisode suivant…'); setTimeout(() => P.o && P.o.next && P.o.next(), 1200); }
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !S.cfg.native) P.fs = false; });
}

document.addEventListener('keydown', e => {
  if (!P.o) return;
  if (['INPUT', 'SELECT'].includes(document.activeElement.tagName) && e.key !== 'Escape') return;
  const k = e.key;
  const handled = true;
  if (k === ' ' || k === 'k' || k === 'K') P.toggle();
  else if (k === 'ArrowLeft') P.seek(-10);
  else if (k === 'ArrowRight') P.seek(30);
  else if (k === 'ArrowUp') P.volume(0.1);
  else if (k === 'ArrowDown') P.volume(-0.1);
  else if (k === 'm' || k === 'M') { P.v.muted = !P.v.muted; P.sync(); }
  else if (k === 'f' || k === 'F') P.toggleFS();
  else if (k === 'PageUp' || k === 'p' || k === 'P') P.zap(-1);
  else if (k === 'PageDown' || k === 'n' || k === 'N') { if (P.o.kind === 'live') P.zap(1); else if (P.o.next) $('#pl-next').click(); }
  else if (k === 'Escape') { if (P.fs) P.toggleFS(); else P.close(); }
  else return;
  if (handled) { e.preventDefault(); e.stopImmediatePropagation(); P.wake(); }
}, true);

