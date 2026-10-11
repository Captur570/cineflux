'use strict';
/* ShippoTV — fiche plein écran d'un film, d'une série ou d'un titre pas encore disponible */

function openDetail(kind, item, opts = {}) {
  if (kind === 'live') return openChannel(item);
  S.dtab = 'main';
  go('detail', { kind, key: item.k, autoplay: !!opts.autoplay, from: S.route.page });
}

PAGES.detail = async function (v, token, params) {
  if (params.ghost) return renderGhost(v, token, params.ghost);
  const kind = params.kind;
  let item = resolve(kind, params.key);
  if (!item) { v.append(el('div', 'page top', '<div class="empty"><strong>Titre introuvable</strong>Il a peut-être été retiré du catalogue.</div>')); return; }
  const page = el('div', 'dpage');
  v.append(page);
  const draw = () => {
    item = resolve(kind, params.key) || item;
    const i = info(kind, item);
    const st = itemState(kind, item);
    setAmbient(kind, item);
    const fav = S.favs.has(kind + ':' + item.k);
    const pr = kind === 'movie' ? (S.cfg.progress || {})['m:' + item.k] : null;
    const resume = pr && pr.pos > 30 && pr.pos / pr.dur < 0.94;
    page.innerHTML = `
      <section class="dhero">
        <div class="dhero-bg" style="${i.backdrop ? `background-image:url('${i.backdrop}')` : `background:${gradient(item.t)}`}"></div>
        <button class="back-btn" data-a="back">${ico('back')}Retour</button>
        <div class="dhero-in">
          <div class="kicker">${kind === 'movie' ? 'Film' : 'Série'}${catName(kind, item.c) ? ' · ' + esc(catName(kind, item.c)) : ''}</div>
          <h1>${esc(i.title)}</h1>
          <div class="meta">${metaBits(kind, item, i)}</div>
          ${st.ok ? '' : `<div class="status-pill bad">${ico('warn')}Indisponible : ${esc(st.why)}</div>`}
          <p class="ov">${esc(i.overview) || '<span class="dim">Résumé en cours de chargement…</span>'}</p>
          ${resume ? `<div class="resume-bar"><div class="progress"><i style="width:${Math.round(100 * pr.pos / pr.dur)}%"></i></div><span>Reste ${fmtMin((pr.dur - pr.pos) / 60)}</span></div>` : ''}
          <div class="actions">
            ${st.ok ? `<button class="btn btn-play" data-a="play">${ico('play')}${resume ? 'Reprendre' : 'Lecture'}</button>` : ''}
            ${i.tmdb ? `<button class="btn btn-ghost" data-a="trailer">${ico('film')}Bande-annonce</button>` : ''}
            <button class="rb big" data-a="fav" title="${fav ? 'Retirer de ma liste' : 'Ajouter à ma liste'}">${ico(fav ? 'check' : 'plus')}</button>
            ${kind === 'movie' && st.ok ? `<button class="rb big" data-a="dl" title="Télécharger">${ico(isDownloaded(kind, item) ? 'downloaded' : 'down')}</button>` : ''}
            ${S.cfg.has_tmdb ? `<button class="rb big" data-a="fix" title="Corriger la jaquette">${ico('img')}</button>` : ''}
          </div>
        </div>
      </section>
      <section class="dbody tabbed" data-tab="${S.dtab || 'main'}">
        <nav class="seg" role="tablist">
          <button type="button" data-t="main">${kind === 'movie' ? 'Versions' : 'Épisodes'}</button>
          <button type="button" data-t="info">Infos et distribution</button>
          <button type="button" data-t="sim">Dans le même esprit</button>
        </nav>
        <div id="d-main" data-panel="main"></div>
        <div class="d-side xinfo" data-panel="info"></div>
        <div id="d-similar" data-panel="sim"></div>
      </section>`;
    const body = page.querySelector('.dbody');
    const setTab = t => {
      S.dtab = t;
      body.dataset.tab = t;
      body.querySelectorAll('.seg button').forEach(b => { b.classList.toggle('on', b.dataset.t === t); b.setAttribute('aria-selected', b.dataset.t === t); });
    };
    body.querySelectorAll('.seg button').forEach(b => b.onclick = () => setTab(b.dataset.t));
    setTab(body.dataset.tab);
    const A = a => page.querySelector(`[data-a="${a}"]`);
    A('back').onclick = () => back();
    if (A('play')) A('play').onclick = () => {
      if (kind === 'movie') playMovie(item, Math.max(0, item.v.findIndex(x => pr && String(x.id) === String(pr.vid) && goodVersions(item).includes(x))));
      else { const ep = page.querySelector('.ep.resume') || page.querySelector('.ep'); if (ep) ep.click(); }
    };
    if (A('trailer')) A('trailer').onclick = () => trailer(kind, i.tmdb);
    A('fav').onclick = async () => { await toggleFav(kind, item.k); draw(); };
    if (A('dl')) A('dl').onclick = () => downloadDialog(item);
    if (A('fix')) A('fix').onclick = () => openFix(kind, item);
    const side = page.querySelector('.xinfo');
    if (kind === 'movie') {
      renderVersions(page.querySelector('#d-main'), item);
      api('/api/movie?id=' + encodeURIComponent(item.v[0].id)).then(x => {
        if (!stillHere(token)) return;
        const ov = page.querySelector('.ov');
        if (!info(kind, item).overview && ov) ov.textContent = x.plot || 'Pas de résumé disponible.';
        side.innerHTML = sideInfo([['Réalisation', x.director], ['Avec', (x.cast || '').split(',').slice(0, 6).join(', ')],
          ['Genres', i.genres.join(', ') || x.genre], ['Durée', i.runtime ? fmtMin(i.runtime) : x.duration], ['Catégorie', catName(kind, item.c)]]);
      }).catch(() => { const ov = page.querySelector('.ov'); if (!i.overview && ov) ov.textContent = 'Pas de résumé disponible.'; });
      // vérification à la demande (lit la durée dans le fichier si besoin)
      if (S.cfg.has_tmdb && item.v.some(x => !vstat(x.id) || vstat(x.id)[0] === 'unk')) {
        api('/api/verify?probe=1&key=' + encodeURIComponent(item.k)).then(r => {
          let changed = false;
          for (const [vid, val] of Object.entries(r.verify || {})) if (val && JSON.stringify(S.verify[vid]) !== JSON.stringify(val)) { S.verify[vid] = val; changed = true; }
          if (changed && stillHere(token)) draw();
        }).catch(() => {});
      }
    } else {
      renderSeries(page.querySelector('#d-main'), item, i, token, page, side);
    }
    if (i.tmdb) loadSimilar(page.querySelector('#d-similar'), kind, i.tmdb, token);
    else page.querySelector('#d-similar').append(el('div', 'empty slim', 'Pas de suggestions pour ce titre.'));
  };
  draw();
  const m = await fullMeta(kind, item);
  if (m && stillHere(token) && m.o) draw();
  if (params.autoplay && stillHere(token)) { params.autoplay = false; const b = page.querySelector('[data-a="play"]'); if (b && kind === 'movie') b.click(); }
};

function sideInfo(rows) {
  return rows.filter(r => r[1]).map(([k, val]) => `<div><b>${esc(k)}</b><span>${esc(val)}</span></div>`).join('');
}

async function loadSimilar(box, kind, tid, token) {
  try {
    const r = await api(`/api/similar?kind=${kind}&id=${tid}`);
    if (!stillHere(token)) return;
    for (const [k, m] of Object.entries(r.meta || {})) if (!S.meta[k] || !S.meta[k].id) S.meta[k] = m;
    const items = r.keys.map(k => resolve(kind, k)).filter(it => it && itemState(kind, it).ok);
    const row = rail('Titres similaires disponibles', anyCard(kind), items, null);
    if (row) box.append(row);
    else box.append(el('div', 'empty slim', 'Pas de titre similaire disponible chez votre fournisseur pour le moment.'));
  } catch { box.append(el('div', 'empty slim', 'Suggestions indisponibles pour le moment.')); }
}

/* ------------------------------------------------------------ versions d'un film */
function versionTitle(v) {
  const tags = (v.q || '').split(' · ').filter(Boolean);
  const q = tags.find(t => QRANK[t]);
  return [q ? QLONG[q] : 'Qualité non précisée', tags.includes('DV') ? 'Dolby Vision' : tags.includes('HDR') ? 'HDR' : '',
    tags.filter(t => !QRANK[t] && t !== 'DV' && t !== 'HDR').join(', ')].filter(Boolean).join(' · ');
}
function versionBadges(q) {
  return (q || '').split(' · ').filter(Boolean).map(t => `<span class="badge ${t === '4K' ? 'hot' : QRANK[t] ? '' : 'dark'}">${QLABEL[t] || t}</span>`).join('');
}

function renderVersions(box, item, showBad) {
  const good = goodVersions(item), bad = badVersions(item);
  box.innerHTML = `<h3>${good.length > 1 ? `Versions disponibles <span class="badge">${good.length}</span>` : good.length ? 'Version disponible' : 'Aucune version conforme'}</h3>`;
  const wrap = el('div', 'versions');
  const row = (v, isBad) => {
    const st = vstat(v.id) || [];
    const d = dlState(v.id);
    const b = el('div', 'version' + (isBad ? ' bad' : ''));
    const check = st[0] === 'ok' ? `<span class="vchk ok" title="Durée et informations vérifiées">${ico('shield')}Vérifié</span>`
      : isBad ? `<span class="vchk bad">${ico('warn')}Écartée</span>` : '';
    b.innerHTML = `<button class="pl" title="Lire">${ico('play')}</button>
      <span class="vmain"><div class="vt">${esc(versionTitle(v))}${st[2] ? ` <span class="ed">${esc(st[2])}</span>` : ''}</div>
        <div class="vs">${st[3] ? fmtMin(st[3]) + ' · ' : ''}${esc(v.n)} · ${esc((v.ext || '').toUpperCase())}</div>
        ${isBad ? `<div class="vwhy">${esc(st[1] || '')}</div>` : st[4] ? `<div class="vwarn">${esc(st[4])}</div>` : ''}</span>
      <span class="tag">${check}${versionBadges(v.q)}</span>
      ${isBad ? '' : `<button class="rb small vdl" title="${d ? (d.status === 'done' ? 'Téléchargé' : 'Téléchargement en cours') : 'Télécharger cette version'}">${ico(d && d.status === 'done' ? 'downloaded' : 'down')}</button>`}`;
    const idx = item.v.indexOf(v);
    b.querySelector('.pl').onclick = () => {
      if (isBad) confirmDialog(`Cette version a été écartée : ${st[1] || ''}. La lire quand même ?`, 'Lire quand même', () => playMovie(item, idx, true));
      else playMovie(item, idx);
    };
    const dlb = b.querySelector('.vdl');
    if (dlb) dlb.onclick = () => { if (!d) queueDownloads([movieDl(item, v)]).then(() => renderVersions(box, item, showBad)); else go('downloads'); };
    return b;
  };
  good.forEach(v => wrap.append(row(v, false)));
  box.append(wrap);
  if (bad.length) {
    const t = el('button', 'link-btn', `${ico(showBad ? 'chevDown' : 'chevRight')}${showBad ? 'Masquer' : 'Voir'} les versions écartées (${bad.length})`);
    t.onclick = () => renderVersions(box, item, !showBad);
    box.append(t);
    if (showBad) {
      const w2 = el('div', 'versions bad-list');
      bad.forEach(v => w2.append(row(v, true)));
      box.append(w2);
    }
  }
}

/* ------------------------------------------------------------ épisodes d'une série */
async function renderSeries(box, item, i, token, page, side) {
  let srcIdx = 0, season = null;
  const load = async () => {
    box.innerHTML = '<h3>Épisodes <span class="spin"></span></h3>';
    let d;
    try { d = await api('/api/series?id=' + encodeURIComponent(item.s[srcIdx].id)); }
    catch (e) { box.innerHTML = `<h3>Épisodes</h3><div class="empty slim">${esc(e.message)}</div>`; return; }
    if (!stillHere(token)) return;
    const ov = page.querySelector('.ov');
    if (!info('series', item).overview && ov) ov.textContent = d.info.plot || 'Pas de résumé disponible.';
    side.innerHTML = sideInfo([['Création', d.info.director], ['Avec', (d.info.cast || '').split(',').slice(0, 6).join(', ')],
      ['Genres', i.genres.join(', ') || d.info.genre], ['Saisons', String(d.seasons.length)], ['Catégorie', catName('series', item.c)]]);
    if (!d.seasons.length) { box.innerHTML = '<h3>Épisodes</h3><div class="empty slim">Aucun épisode disponible sur cette source.</div>'; return; }
    const prog = S.cfg.progress || {};
    let resume = null;
    for (const s of d.seasons) for (const e of d.episodes[s]) {
      const p = prog['e:' + e.id];
      if (p && (!resume || p.ts > resume.p.ts)) resume = { s, e, p };
    }
    const flat = [];
    d.seasons.forEach(s => d.episodes[s].forEach(e => flat.push([s, e])));
    let nextLabel = false;
    if (resume && resume.p.done) {        // dernier épisode vu terminé : on propose le suivant
      let k = flat.findIndex(x => x[1] === resume.e) + 1;
      while (k > 0 && k < flat.length && (prog['e:' + flat[k][1].id] || {}).done) k++;
      if (k > 0 && k < flat.length) { resume = { s: flat[k][0], e: flat[k][1], p: prog['e:' + flat[k][1].id] || {} }; nextLabel = true; }
      else resume = null;
    }
    const epTitle = (s, e) => `S${String(s).padStart(2, '0')}E${String(e.n).padStart(2, '0')}${e.t && !/^Épisode \d+$/.test(e.t) ? ' – ' + e.t : ''}`;
    const sid = item.s[srcIdx].id;
    const mk = ([ss, ee]) => ({ title: i.title, sub: epTitle(ss, ee), pid: 'e:' + ee.id, ep: { id: ee.id, ext: ee.ext, sid },
      streams: [{ type: 'episode', id: ee.id, ext: ee.ext, label: 'Épisode' }] });
    const playEp = idx => play({ ...mk(flat[idx]), kind: 'series', key: item.k, queue: flat.slice(idx + 1, idx + 40).map(mk),
      next: idx + 1 < flat.length ? () => playEp(idx + 1) : null, nextLabel: idx + 1 < flat.length ? epTitle(...flat[idx + 1]) : '' });
    const epDl = ([s, e]) => ({ kind: 'episode', key: item.k, vid: e.id, ext: e.ext, title: i.title, sub: epTitle(s, e), pid: 'e:' + e.id, ep: { id: e.id, ext: e.ext, sid } });
    const pb = page.querySelector('[data-a="play"]');
    if (pb && resume) pb.innerHTML = ico('play') + (nextLabel ? 'Épisode suivant · ' : 'Reprendre ') + epTitle(resume.s, resume.e).split(' – ')[0];
    season = season || (resume ? resume.s : d.seasons[0]);
    box.innerHTML = '';
    const head = el('div', 'ep-head', '<h3>Épisodes</h3>');
    const seasons = el('div', 'chips inline');
    d.seasons.forEach(s => {
      const c = el('button', 'chip' + (s === season ? ' on' : ''), s === '0' ? 'Bonus' : 'Saison ' + s);
      c.onclick = () => { season = s; seasons.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c)); show(); };
      seasons.append(c);
    });
    head.append(seasons);
    const dlSeason = el('button', 'btn btn-ghost btn-sm dl-season', ico('down') + 'Télécharger la saison');
    dlSeason.onclick = () => queueDownloads(flat.filter(([s]) => s === season).map(epDl)).then(show);
    head.append(dlSeason);
    if (item.s.length > 1) {
      const src = el('select', 'pill');
      item.s.forEach((s, k) => src.append(new Option(`Source ${k + 1}${s.q ? ' · ' + s.q : ''}`, k)));
      src.value = srcIdx;
      src.onchange = () => { srcIdx = +src.value; season = null; load(); };
      head.append(src);
    }
    box.append(head);
    const eps = el('div', 'episodes');
    box.append(eps);
    const show = () => {
      eps.innerHTML = '';
      for (const e of d.episodes[season]) {
        const p = prog['e:' + e.id];
        const dls = dlState(e.id);
        const idx = flat.findIndex(x => x[1] === e);
        const r = el('div', 'ep' + (resume && resume.e === e ? ' resume' : ''));
        r.innerHTML = `<div class="num">${e.n}</div><div class="eimg" style="${e.img ? `background-image:url('${esc(e.img)}')` : `background:${gradient(item.t + e.n)}`}"><span class="eplay">${ico('play')}</span>${p ? `<div class="tbar"><i style="width:${p.done ? 100 : Math.round(100 * p.pos / Math.max(1, p.dur))}%"></i></div>` : ''}${p && p.done ? `<span class="seen">${ico('check')}Vu</span>` : ''}</div>
          <div class="etxt"><div class="et">${esc(e.t)}<span>${esc(e.dur || '')}</span></div><div class="ed">${esc(e.plot)}</div></div>
          <button class="rb small edl" title="${dls ? (dls.status === 'done' ? 'Téléchargé' : 'En cours') : 'Télécharger'}">${ico(dls && dls.status === 'done' ? 'downloaded' : 'down')}</button>`;
        activate(r, () => playEp(idx));
        const db = r.querySelector('.edl');
        db.tabIndex = -1;
        db.onclick = ev => { ev.stopPropagation(); if (!dls) queueDownloads([epDl(flat[idx])]).then(show); else go('downloads'); };
        eps.append(r);
      }
    };
    show();
  };
  load();
}

/* ------------------------------------------------------------ titre pas encore disponible */
async function renderGhost(v, token, g) {
  const kind = g.kind === 'series' || g.kind === 'tv' ? 'series' : 'movie';
  const page = el('div', 'dpage');
  v.append(page);
  const draw = d => {
    const notified = (S.cfg.notify || []).some(n => Number(n.id) === Number(g.id));
    const status = d.status || g.status || 'Indisponible';
    const reason = status === 'Au cinéma' ? 'Le film est encore au cinéma : il apparaîtra ici dès qu\'une version complète et de bonne qualité arrivera chez votre fournisseur.'
      : status === 'Prochainement' ? `Sortie prévue le ${d.rel ? new Date(d.rel * 1000).toLocaleDateString('fr', { day: 'numeric', month: 'long', year: 'numeric' }) : 'prochainement'}.`
      : 'Ce titre n\'est pas (encore) proposé par votre fournisseur, ou seulement dans une version non conforme.';
    page.innerHTML = `<section class="dhero">
        <div class="dhero-bg ghosted" style="${d.b ? `background-image:url('${IMG}w1280${d.b}')` : `background:${gradient(d.t || g.t)}`}"></div>
        <button class="back-btn" data-a="back">${ico('back')}Retour</button>
        <div class="dhero-in">
          <div class="kicker">${kind === 'movie' ? 'Film' : 'Série'}</div>
          <h1>${esc(d.t || g.t)}</h1>
          <div class="meta">${[d.v ? `<span class="star">★ ${Number(d.v).toFixed(1)}</span>` : '', d.y ? `<span>${d.y}</span>` : '', d.rt ? `<span>${fmtMin(d.rt)}</span>` : '', (d.g || []).length ? `<span>${esc(d.g.join(', '))}</span>` : ''].filter(Boolean).join('<i class="dot"></i>')}</div>
          <div class="status-pill ${status === 'Au cinéma' ? 'cine' : ''}">${ico(status === 'Au cinéma' ? 'film' : 'calendar')}${esc(status)}</div>
          <p class="ov">${esc(d.o || '')}</p>
          <p class="dim small">${esc(reason)}</p>
          <div class="actions">
            <button class="btn ${notified ? 'btn-ghost' : 'btn-play'}" data-a="notify">${ico(notified ? 'bellOn' : 'bell')}${notified ? 'Vous serez prévenu' : 'Me prévenir'}</button>
            ${d.yt ? `<button class="btn btn-ghost" data-a="trailer">${ico('film')}Bande-annonce</button>` : ''}
          </div>
        </div></section>
      <section class="dbody"><div></div><div class="d-side">${sideInfo([['Réalisation', (d.dir || []).join(', ')], ['Avec', (d.cast || []).join(', ')]])}</div><div id="d-similar"></div></section>`;
    page.querySelector('[data-a="back"]').onclick = () => back();
    page.querySelector('[data-a="notify"]').onclick = async () => {
      const r = await api('/api/notify', { kind, id: g.id, title: d.t || g.t, on: !notified });
      S.cfg.notify = r.notify;
      toast(!notified ? 'Vous serez prévenu dès qu\'il sera disponible' : 'Alerte supprimée', 'info', 2500);
      draw(d);
    };
    const tb = page.querySelector('[data-a="trailer"]');
    if (tb) tb.onclick = () => trailer(kind, g.id);
    loadSimilar(page.querySelector('#d-similar'), kind, g.id, token);
  };
  draw(g);
  try {
    const d = await api(`/api/tmdb_info?kind=${kind}&id=${g.id}`);
    if (stillHere(token)) draw({ ...g, ...d });
  } catch { /* hors ligne */ }
}

/* ------------------------------------------------------------ bande-annonce */
async function trailer(kind, tid) {
  try {
    const r = await api(`/api/trailer?kind=${kind}&id=${tid}`);
    if (!r.key) return toast('Pas de bande-annonce disponible', 'warn');
    if (window.TV_TRAILER) return window.TV_TRAILER(r.key);        // télé : ouverte dans l'appli YouTube
    openModal(`<div class="trailer"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(r.key)}?autoplay=1&rel=0&modestbranding=1&hl=fr" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe></div>`, 'wide dark');
  } catch (e) { toast(e.message, 'error'); }
}

/* ------------------------------------------------------------ téléchargements */
function movieDl(item, v) {
  const i = info('movie', item);
  const st = vstat(v.id) || [];
  return { kind: 'movie', key: item.k, vid: v.id, ext: v.ext, title: i.title, year: i.year,
    label: [(v.q || '').split(' · ').find(t => QRANK[t]), st[2]].filter(Boolean).join(' '), pid: 'm:' + item.k };
}
async function queueDownloads(entries) {
  try {
    const r = await api('/api/downloads', { items: entries });
    setDownloads(r);
    const n = entries.length;
    toast(n > 1 ? `${n} épisodes ajoutés aux téléchargements` : 'Ajouté aux téléchargements', 'info', 3000, { label: 'Voir', run: () => go('downloads') });
  } catch (e) { toast(e.message, 'error'); }
}
function downloadDialog(item) {
  const good = goodVersions(item);
  if (good.length === 1) return queueDownloads([movieDl(item, good[0])]);
  const b = openModal(`<div class="dialog"><h2>Télécharger « ${esc(info('movie', item).title)} »</h2><p class="dim">Choisissez la version. Les fichiers 4K sont très lourds (souvent 15 à 60 Go).</p><div class="versions"></div></div>`, 'small');
  const box = b.querySelector('.versions');
  good.forEach(v => {
    const st = vstat(v.id) || [];
    const d = dlState(v.id);
    const r = el('button', 'version', `<span class="pl">${ico(d ? 'downloaded' : 'down')}</span><span class="vmain"><div class="vt">${esc(versionTitle(v))}${st[2] ? ` <span class="ed">${esc(st[2])}</span>` : ''}</div><div class="vs">${st[3] ? fmtMin(st[3]) + ' · ' : ''}${esc(v.n)}</div></span><span class="tag">${versionBadges(v.q)}</span>`);
    r.onclick = () => { closeModal(); if (!d) queueDownloads([movieDl(item, v)]); else go('downloads'); };
    box.append(r);
  });
}

/* ------------------------------------------------------------ correction de jaquette */
function openFix(kind, item) {
  const i = info(kind, item);
  const body = openModal(`<div class="dialog"><h2>Corriger la jaquette</h2><p class="lead">Nom d'origine : <b>${esc(kind === 'movie' ? item.v[0].n : item.s[0].n)}</b></p>
    <div class="field inline"><input type="text" id="fixq" value="${esc(i.title)}"><button class="btn btn-accent">Chercher</button></div>
    <div class="fix-list"></div></div>`);
  const q = body.querySelector('#fixq'), out = body.querySelector('.fix-list');
  const search = async () => {
    out.innerHTML = '<div class="spin"></div>';
    try {
      const res = await api('/api/tmdb_search', { kind, query: q.value });
      out.innerHTML = res.length ? '' : '<div class="dim">Aucun résultat.</div>';
      res.forEach(r => {
        const b = el('button', 'fix-item', `${r.p ? `<img src="${IMG}w185${r.p}" alt="">` : `<div class="fix-ph" style="background:${gradient(r.t)}"></div>`}<span>${esc(r.t)}</span><small>${r.y || ''}</small>`);
        b.onclick = async () => {
          try {
            S.meta[mkey(kind, item)] = await api('/api/tmdb_override', { kind, key: item.k, id: r.id });
            closeModal();
            refreshCards(kind, item.k);
            render();
          } catch (e) { toast(e.message, 'error'); }
        };
        out.append(b);
      });
    } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  body.querySelector('.btn-accent').onclick = search;
  q.onkeydown = e => { if (e.key === 'Enter') search(); };
  search();
}
