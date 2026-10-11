/* ShippoTV TV — adaptation à la télé Samsung (Tizen) :
   - lecteur vidéo de la télé (AVPlay) présenté au lecteur de l'interface comme une balise <video> ;
   - touches de la télécommande (Retour, Lecture/Pause, Avance/Retour rapide, Chaîne +/-) ;
   - mise en page TV (plein écran permanent, fonctions PC masquées).
   Chargé après player.js et avant boot.js. */
(function () {
  'use strict';
  const isTizen = typeof window.tizen !== 'undefined';
  const AV = window.webapis && window.webapis.avplay;
  document.body.classList.add('platform-tv', 'tv');

  /* ------------------------------------------------------------ taille de l'interface
     L'interface est pensée pour un écran de 1280 px de large : on l'agrandit à la taille réelle
     de la télé (1920 ou 3840 px selon le modèle), pour qu'elle soit lisible à 3 mètres. */
  function fitScreen() {
    const w = window.innerWidth || screen.width || 1920;
    const z = w / 1280;
    document.documentElement.style.zoom = z > 1.05 ? String(z) : '';
  }
  fitScreen();
  window.addEventListener('resize', fitScreen);

  /* ------------------------------------------------------------ champs de texte
     Sur la télé, donner le focus à un champ ouvre aussitôt le clavier virtuel. On le rend donc
     « en lecture seule » tant qu'on ne fait que passer dessus : OK l'ouvre pour écrire. */
  const isText = t => t && t.tagName === 'INPUT' && /^(text|password|search|email|url|number|)$/i.test(t.type || '');
  document.addEventListener('focusin', e => {
    const t = e.target;
    if (!isText(t)) return;
    if (t._reopen) { t._reopen = false; return; }
    t.readOnly = true;
  }, true);
  document.addEventListener('focusout', e => {
    const t = e.target;
    if (isText(t) && !t._reopen) t.readOnly = true;
  }, true);
  function editField(t) {
    t._reopen = true;
    t.readOnly = false;
    t.blur();
    t.focus();
    try { const n = t.value.length; t.setSelectionRange(n, n); } catch { /* type sans curseur */ }
  }

  /* ------------------------------------------------------------ AVPlay vu comme une balise <video> */
  class AVVideo {
    constructor() {
      this.l = {};
      this._paused = true;
      this._dur = NaN;
      this._cur = 0;
      this._url = null;
      this._want = false;
      this._seek = null;
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
      this.error = null;
      this.uhd = false;
      this.live = false;
    }
    addEventListener(t, fn, opt) { (this.l[t] = this.l[t] || []).push({ fn, once: !!(opt && opt.once) }); }
    removeEventListener(t, fn) { this.l[t] = (this.l[t] || []).filter(x => x.fn !== fn); }
    _emit(t) {
      const ls = this.l[t];
      if (!ls || !ls.length) return;
      this.l[t] = ls.filter(x => !x.once);
      for (const x of ls) { try { x.fn({ type: t, target: this }); } catch (e) { console.error(e); } }
    }
    _state() { try { return AV.getState(); } catch { return 'NONE'; } }
    getAttribute(n) { return n === 'src' ? this._url : null; }
    removeAttribute(n) { if (n === 'src') this._close(); }
    load() { /* rien : AVPlay s'ouvre à l'affectation de src */ }
    get src() { return this._url || ''; }
    set src(url) { this._open(url); }

    _open(url) {
      this._close();
      this._url = url;
      this._dur = NaN; this._cur = 0; this.error = null;
      const self = this;
      try {
        AV.open(url);
        AV.setDisplayRect(0, 0, 1920, 1080);
        try { AV.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch { /* ancien modèle */ }
        if (this.uhd) { try { AV.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch { /* non 4K */ } }
        if (/\.m3u8(\?|$)/i.test(url)) { try { AV.setStreamingProperty('ADAPTIVE_INFO', 'STARTBITRATE=HIGHEST'); } catch { /* rien */ } }
        // réserve plus confortable : moins de micro-coupures sur les films (le direct garde une petite réserve)
        try {
          AV.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', this.live ? 3 : 6);
          AV.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', this.live ? 5 : 12);
        } catch { /* ancien modèle */ }
        try { AV.setTimeoutForBuffering(20); } catch { /* rien */ }
        AV.setListener({
          onbufferingstart() { self._emit('waiting'); },
          onbufferingprogress() { /* rien */ },
          onbufferingcomplete() { self._emit('canplay'); if (!self._paused) self._emit('playing'); },
          oncurrentplaytime(ms) { self._cur = ms / 1000; self._emit('timeupdate'); },
          onstreamcompleted() { self._paused = true; self._emit('pause'); self._emit('ended'); },
          onerror(type) { self.error = { message: String(type) }; self._emit('error'); },
          onerrormsg(type, msg) { self.error = { message: `${type} ${msg || ''}` }; self._emit('error'); },
          onevent() { /* rien */ },
          onsubtitlechange(duration, text) {          // AVPlay fournit le texte : à nous de l'afficher
            const box = document.getElementById('pl-subtext');
            if (!box) return;
            box.textContent = String(text || '').replace(/<[^>]+>/g, '');
            box.hidden = !box.textContent;
            clearTimeout(self._subT);
            self._subT = setTimeout(() => { box.hidden = true; }, Math.max(500, +duration || 3000));
          },
          ondrmevent() { /* rien */ },
        });
      } catch (e) {
        this.error = { message: String(e && e.message || e) };
        setTimeout(() => this._emit('error'), 0);
        return;
      }
      this._emit('waiting');
      const opened = url;
      AV.prepareAsync(() => {
        if (this._url !== opened) return;
        const d = AV.getDuration();
        this._dur = d > 0 ? d / 1000 : Infinity;
        this._emit('loadedmetadata'); this._emit('durationchange'); this._emit('canplay');
        if (this._seek != null) { const s = this._seek; this._seek = null; this.currentTime = s; }
        if (this._want) this._doPlay();
      }, err => {
        if (this._url !== opened) return;
        this.error = { message: String(err && err.name || err) };
        this._emit('error');
      });
    }
    _doPlay() {
      try { AV.play(); this._paused = false; this._emit('play'); this._emit('playing'); } catch (e) { console.warn(e); }
    }
    play() {
      this._want = true;
      const st = this._state();
      if (st === 'READY' || st === 'PAUSED') this._doPlay();
      return Promise.resolve();
    }
    pause() {
      this._want = false;
      if (this._state() === 'PLAYING') { try { AV.pause(); } catch { /* rien */ } }
      this._paused = true;
      this._emit('pause');
    }
    get paused() { return this._paused; }
    get duration() { return this._dur; }
    get currentTime() { return this._cur; }
    set currentTime(t) {
      const st = this._state();
      if (st === 'READY' || st === 'PLAYING' || st === 'PAUSED') {
        this._cur = Math.max(0, t);
        try { AV.seekTo(Math.round(this._cur * 1000), () => this._emit('timeupdate'), () => {}); } catch { /* rien */ }
        this._emit('timeupdate');
      } else this._seek = t;
    }
    _video() {
      try {
        const v = (AV.getCurrentStreamInfo() || []).find(t => t.type === 'VIDEO');
        return v ? JSON.parse(v.extra_info || '{}') : {};
      } catch { return {}; }
    }
    get videoWidth() { return +(this._video().Width || 0); }
    get videoHeight() { return +(this._video().Height || 0); }
    get volume() { try { return tizen.tvaudiocontrol.getVolume() / 100; } catch { return 1; } }
    set volume(v) { try { tizen.tvaudiocontrol.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100)); } catch { /* rien */ } this._emit('volumechange'); }
    get muted() { try { return tizen.tvaudiocontrol.isMute(); } catch { return false; } }
    set muted(m) { try { tizen.tvaudiocontrol.setMute(!!m); } catch { /* rien */ } this._emit('volumechange'); }

    _tracks(type) {
      try {
        return (AV.getTotalTrackInfo() || []).filter(t => t.type === type).map(t => {
          let ex = {};
          try { ex = JSON.parse(t.extra_info || '{}'); } catch { /* rien */ }
          return { index: t.index, name: (ex.language || ex.track_lang || '').toUpperCase() || `Piste ${t.index + 1}` };
        });
      } catch { return []; }
    }
    audioTrackList() { return this._tracks('AUDIO'); }
    audioTrackIndex() {
      try {
        const cur = (AV.getCurrentStreamInfo() || []).find(t => t.type === 'AUDIO');
        const list = this._tracks('AUDIO');
        return Math.max(0, list.findIndex(t => cur && t.index === cur.index));
      } catch { return 0; }
    }
    setAudioTrack(i) {
      const t = this._tracks('AUDIO')[i];
      if (t) { try { AV.setSelectTrack('AUDIO', t.index); } catch (e) { console.warn(e); } }
    }
    textTrackList() { return this._tracks('TEXT'); }
    setTextTrack(i) {
      try {
        if (i < 0) { AV.setSilentSubtitle(true); return; }
        const t = this._tracks('TEXT')[i];
        if (t) { AV.setSilentSubtitle(false); AV.setSelectTrack('TEXT', t.index); }
      } catch (e) { console.warn(e); }
    }

    _close() {
      this._want = false;
      this._paused = true;
      if (this._url) {
        try { AV.stop(); } catch { /* rien */ }
        try { AV.close(); } catch { /* rien */ }
      }
      this._url = null;
    }
  }

  if (AV) {
    const obj = document.createElement('object');
    obj.id = 'av-player';
    obj.type = 'application/avplayer';
    document.body.insertBefore(obj, document.body.firstChild);
    window.TVVIDEO = new AVVideo();
    // sous-titres intégrés au fichier (AVPlay)
    const sub = document.createElement('select');
    sub.id = 'pl-text'; sub.className = 'pl-select'; sub.title = 'Sous-titres'; sub.hidden = true;
    const audio = document.getElementById('pl-audio');
    audio.parentNode.insertBefore(sub, audio);
    const fillSubs = () => {
      const list = window.TVVIDEO.textTrackList();
      sub.hidden = !list.length;
      sub.innerHTML = '<option value="-1">Sans sous-titres</option>' + list.map((t, i) => `<option value="${i}">ST ${esc(t.name)}</option>`).join('');
      window.TVVIDEO.setTextTrack(-1);
    };
    window.TVVIDEO.addEventListener('loadedmetadata', () => setTimeout(() => { fillSubs(); P.renderTracks(); }, 400));
    sub.onchange = () => { window.TVVIDEO.setTextTrack(+sub.value); document.getElementById('pl-subtext').hidden = true; };
    const subtext = document.createElement('div');
    subtext.id = 'pl-subtext'; subtext.hidden = true;
    document.getElementById('player').append(subtext);
    // 4K : AVPlay a besoin d'être prévenu avant la préparation
    const load0 = P.load;
    P.load = function (idx, first, at) {
      const s = this.o && this.o.streams[idx];
      window.TVVIDEO.uhd = !!(s && (/4K|UHD|2160/i.test(s.label || '') || /non précisée/i.test(s.label || '')));
      window.TVVIDEO.live = !!(this.o && this.o.kind === 'live');
      return load0.call(this, idx, first, at);
    };
  }
  document.body.classList.toggle('avplay', !!AV);

  /* ------------------------------------------------------------ télécommande */
  const KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
    'ChannelUp', 'ChannelDown', 'Info', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'];
  const CODE = { Back: 10009, MediaPlayPause: 10252, MediaPlay: 415, MediaPause: 19, MediaStop: 413, MediaFastForward: 417,
    MediaRewind: 412, ChannelUp: 427, ChannelDown: 428, Info: 457, ColorF0Red: 403, ColorF1Green: 404, ColorF2Yellow: 405, ColorF3Blue: 406 };
  if (isTizen && tizen.tvinputdevice) {
    for (const k of KEYS) {
      try {
        tizen.tvinputdevice.registerKey(k);
        const info = tizen.tvinputdevice.getKey(k);
        if (info && info.code) CODE[k] = info.code;
      } catch { /* touche absente de cette télécommande */ }
    }
  }
  const byCode = Object.fromEntries(Object.entries(CODE).map(([k, v]) => [v, k]));

  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch { window.close(); }
  }
  function confirmExit() {
    if (!$('#modal').hidden) return;
    confirmDialog('Quitter ShippoTV ?', 'Quitter', exitApp);
  }

  /* Dans le lecteur : ←/→ avancent ou reculent, OK met en pause, ↑/↓ montrent les commandes
     et permettent de s'y déplacer ; Retour ferme le lecteur. */
  function playerControls() {
    return $$('#player .pl-ctrls button, #player .pl-ctrls select, #player .pl-top button, #player .pl-resume button, #player .pl-msg button, #pl-upnext')
      .filter(e => !e.hidden && !e.closest('[hidden]') && e.getBoundingClientRect().width > 0);
  }
  function inControls() {
    const a = document.activeElement;
    return a && a !== document.body && a.closest && a.closest('#player') && !$('#player').classList.contains('idle');
  }
  function movePlayerFocus(dir) {
    const els = playerControls();
    if (!els.length) return;
    const cur = document.activeElement;
    if (!els.includes(cur)) { ($('#pl-play') && els.includes($('#pl-play')) ? $('#pl-play') : els[0]).focus(); return; }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bd = Infinity;
    for (const e of els) {
      if (e === cur) continue;
      const b = e.getBoundingClientRect();
      const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
      const dx = ex - cx, dy = ey - cy;
      let ok = false, d = 0;
      if (dir === 'left') { ok = dx < -4; d = -dx + Math.abs(dy) * 3; }
      if (dir === 'right') { ok = dx > 4; d = dx + Math.abs(dy) * 3; }
      if (dir === 'up') { ok = dy < -10; d = -dy + Math.abs(dx) * 0.5; }
      if (dir === 'down') { ok = dy > 10; d = dy + Math.abs(dx) * 0.5; }
      if (ok && d < bd) { bd = d; best = e; }
    }
    if (best) best.focus();
  }

  let lastOk = 0;
  window.addEventListener('keydown', e => {
    const name = byCode[e.keyCode] || e.key;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const act = document.activeElement;

    // champ de texte : OK ouvre le clavier ; « Terminé » / « Annuler » du clavier le referment
    if (isText(act)) {
      if (e.keyCode === 65376 || e.keyCode === 65385) { act.readOnly = true; act.dispatchEvent(new Event('change')); return; }
      if (act.readOnly && e.key === 'Enter') { stop(); editField(act); return; }
    }
    if (/^Arrow/.test(e.key)) document.body.classList.add('no-pointer');
    // OK : une seule activation par appui (les appuis répétés ou trop rapprochés sont ignorés)
    if ((e.key === 'Enter' || e.keyCode === 13) && !isText(act)) {
      const t = Date.now();
      if (e.repeat || t - lastOk < 250) { stop(); return; }
      lastOk = t;
    }
    // liste déroulante fermée : les flèches déplacent le focus (OK l'ouvre)
    const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (act && act.tagName === 'SELECT' && ARROWS[e.key] && !P.o) { stop(); spatial(ARROWS[e.key]); return; }

    if (P.o) {
      P.wake();
      if (name === 'Back' || name === 'Escape' || name === 'MediaStop') { stop(); if (name !== 'MediaStop' && inControls()) { document.activeElement.blur(); $('#player').classList.add('idle'); return; } P.close(); return; }
      if (name === 'MediaPlayPause') { stop(); P.toggle(); return; }
      if (name === 'MediaPlay') { stop(); if (P.v.paused) P.toggle(); return; }
      if (name === 'MediaPause') { stop(); if (!P.v.paused) P.toggle(); return; }
      if (name === 'MediaFastForward') { stop(); P.seek(30); return; }
      if (name === 'MediaRewind') { stop(); P.seek(-10); return; }
      if (name === 'ChannelUp') { stop(); P.zap(-1); return; }
      if (name === 'ChannelDown') { stop(); P.zap(1); return; }
      if (name === 'Info') { stop(); return; }
      const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (arrows[e.key]) {
        stop();
        if (inControls()) { movePlayerFocus(arrows[e.key]); return; }
        if (e.key === 'ArrowLeft') { if (P.o.kind === 'live') P.zap(-1); else P.seek(-10); return; }
        if (e.key === 'ArrowRight') { if (P.o.kind === 'live') P.zap(1); else P.seek(30); return; }
        movePlayerFocus(arrows[e.key]);
        return;
      }
      if (e.key === 'Enter' && !inControls()) { stop(); P.toggle(); return; }
      if (e.key === 'Enter' && act && act.tagName !== 'SELECT' && act.click) { stop(); act.click(); return; }
      return;
    }
    if ((e.key === 'Enter' || e.keyCode === 13) && act && act !== document.body && !isText(act) && act.tagName !== 'SELECT' && act.click) {
      stop(); act.click(); return;
    }

    if (name === 'Back') {
      stop();
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') { document.activeElement.blur(); return; }
      if (!$('#modal').hidden) { closeModal(); return; }
      if ($('.menu-pop')) { $('.menu-pop').remove(); return; }
      if (S.route.page === 'profiles' && !S.route.params.manage) { confirmExit(); return; }
      if (!S.stack.length && S.route.page === 'home') { confirmExit(); return; }
      back();
      return;
    }
    if (name === 'MediaPlayPause' || name === 'MediaPlay') {
      const a = document.activeElement;
      if (a && a.classList && a.classList.contains('card')) { stop(); a.click(); }
    }
  }, true);

  /* ------------------------------------------------------------ focus automatique
     Après chaque changement de page, un élément est toujours sélectionné : le premier appui sur OK
     agit tout de suite. Sur une fiche, c'est le bouton Lecture / Reprendre / Épisode suivant. */
  function lost() {
    const a = document.activeElement;
    return !a || a === document.body || !a.isConnected || !visibleEl(a) || (!$('#modal').hidden && !$('#modal').contains(a));
  }
  function autoFocus(force) {
    if (P.o || $('.menu-pop')) return;
    if (!force && !lost()) return;
    const scope = !$('#modal').hidden ? $('#modal') : $('#view');
    if (!scope) return;
    let t = null;
    if (scope.id === 'view' && S.route && S.route.page === 'detail') t = scope.querySelector('[data-a="play"]') || scope.querySelector('[data-a="notify"]');
    if (!t || !visibleEl(t)) {
      t = $$(FOCUSABLE, scope).find(e => !e.closest('#player') && visibleEl(e) && e.getBoundingClientRect().top >= 60
        && !(e.dataset && e.dataset.a === 'back'));
    }
    if (t) t.focus({ preventScroll: true });
  }
  const baseRender = window.render;
  window.render = function () {
    const r = baseRender.apply(this, arguments);
    const page = S.route && S.route.page;
    let n = 0;
    const tries = [30, 250, 700, 1500];
    const next = () => {
      if (!S.route || S.route.page !== page) return;
      // fiche : on vise le bouton Lecture dès qu'il apparaît, même si le focus a été posé ailleurs entre-temps
      const play = page === 'detail' && $('#view [data-a="play"], #view [data-a="notify"]');
      if (play && !play._auto && (lost() || !$('#view').contains(document.activeElement) || document.activeElement.dataset.a === 'back')) {
        play._auto = true; play.focus({ preventScroll: true });
      } else autoFocus(false);
      if (++n < tries.length) setTimeout(next, tries[n] - tries[n - 1]);
    };
    setTimeout(next, tries[0]);
    return r;
  };

  /* pointeur (télécommande à pointeur) : on réactive le survol seulement s'il bouge vraiment */
  document.body.classList.add('no-pointer');
  let lastXY = null;
  document.addEventListener('mousemove', e => {
    const xy = e.screenX + ',' + e.screenY;
    if (lastXY && lastXY !== xy) document.body.classList.remove('no-pointer');
    lastXY = xy;
  }, { passive: true });

  /* ------------------------------------------------------------ bande-annonce : appli YouTube de la télé */
  window.TV_TRAILER = function (key) {
    const fail = () => toast("Impossible d'ouvrir l'appli YouTube sur cette télé", 'warn', 5000);
    if (!isTizen || !tizen.application || !window.tizen.ApplicationControl) return fail();
    const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(key);
    const viaUri = () => {
      try {
        const ac = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url, null, null, null);
        tizen.application.launchAppControl(ac, null, () => {}, fail);
      } catch { fail(); }
    };
    try {
      const data = [new tizen.ApplicationControlData('PAYLOAD', [JSON.stringify({ values: 'v=' + key })])];
      const ac = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', null, null, null, data);
      tizen.application.launchAppControl(ac, '111299001912', () => {}, viaUri);
    } catch { viaUri(); }
  };

  /* L'appli passe en arrière-plan (touche Accueil, autre source) : on arrête proprement la lecture */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && P.o) P.close(true);
    if (document.hidden && window.ENGINE) ENGINE.flush();
  });
})();
