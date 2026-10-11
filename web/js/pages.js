'use strict';
/* ShippoTV — pages : accueil, films, séries, ma liste, recherche, téléchargements, profils, réglages */

/* ------------------------------------------------------------ éléments partagés */
function metaBits(kind, item, i) {
  const bits = [];
  if (i.vote) bits.push(`<span class="star">★ ${Number(i.vote).toFixed(1)}</span>`);
  if (i.year) bits.push(`<span>${i.year}</span>`);
  if (i.runtime) bits.push(`<span>${fmtMin(i.runtime)}</span>`);
  if (i.genres.length) bits.push(`<span>${esc(i.genres.join(', '))}</span>`);
  return bits.join('<i class="dot"></i>') + ' ' + (itemState(kind, item).ok ? qualityBadges(kind, item, 3) : '');
}

function topCats(kind, n) {
  return Object.entries(S.counts[kind]).filter(([id]) => catMap(kind)[id]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}

function continueEntries() {
  const p = S.cfg.progress || {};
  const cur = Object.values(p).filter(x => !x.done && x.dur > 0 && x.pos > 30 && x.pos / x.dur < 0.94 && x.kind !== 'live');
  // « À suivre » : épisode suivant d'une série dont on a fini le dernier épisode vu
  const busy = new Set(cur.filter(x => x.kind === 'series').map(x => x.key));
  const nexts = (S.upNext || []).filter(x => !busy.has(x.key) && !(p[x.pid] && p[x.pid].done));
  return [...cur, ...nexts].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 20);
}

async function toggleFav(kind, key) {
  try {
    const r = await api('/api/fav', { kind, key, on: !S.favs.has(kind + ':' + key) });
    S.favs = new Set(r.favs);
    if (kind === 'live') $$(`.tile[data-k="${CSS.escape(key)}"]`).forEach(c => c.replaceWith(tile(S.idx.live[key])));
    else refreshCards(kind, key);
    toast(S.favs.has(kind + ':' + key) ? 'Ajouté à ma liste' : 'Retiré de ma liste', 'info', 1800);
  } catch (e) { toast(e.message, 'error'); }
}

/* ------------------------------------------------------------ grande affiche */
function pickHero() {
  const pool = [];
  const trend = discRows('movie').find(r => r.id === 'trend');
  for (const it of (trend ? trend.items.filter(x => !x.ghost).slice(0, 10) : [])) { const m = S.meta[mkey('movie', it)]; if (m && m.b && itemState('movie', it).ok) pool.push(['movie', it]); }
  if (!pool.length) {
    for (const it of S.cat.movies.slice(0, 80)) { const m = S.meta[mkey('movie', it)]; if (m && m.b && itemState('movie', it).ok) pool.push(['movie', it]); }
    for (const it of S.cat.series.slice(0, 40)) { const m = S.meta[mkey('series', it)]; if ((m && m.b) || it.bd) pool.push(['series', it]); }
  }
  if (!pool.length) return null;
  if (S.heroPick && pool.some(p => p[1] === S.heroPick[1])) return S.heroPick;
  S.heroPick = pool[Math.floor(Math.random() * Math.min(pool.length, 6))];
  return S.heroPick;
}

function heroEl(pick, kicker) {
  const hero = el('div', 'hero feat');
  S.heroEmpty = !pick;
  if (!pick) {
    hero.classList.add('hero-empty');
    const n = S.cat.movies.length, s = S.cat.series.length, l = S.cat.live.length;
    const p = currentProfile();
    hero.innerHTML = `<div class="hero-info"><div class="kicker">Votre catalogue</div><h1>Bonsoir${p && S.cfg.profiles.length > 1 ? ', ' + esc(p.name) : ''}.</h1>
      <div class="meta"><span>${n.toLocaleString('fr')} films</span><i class="dot"></i><span>${s.toLocaleString('fr')} séries</span><i class="dot"></i><span>${l.toLocaleString('fr')} chaînes</span></div>
      <p>${S.cfg.has_tmdb ? 'Les jaquettes et les sélections arrivent dans un instant.' : 'Ajoutez une clé TMDB dans les réglages pour obtenir les jaquettes, les résumés et les sélections.'}</p></div>`;
    return hero;
  }
  const [kind, item] = pick;
  const i = info(kind, item);
  hero.innerHTML = `<div class="hero-bg" style="background-image:url('${i.backdrop}')"></div>
    <div class="hero-info"><div class="kicker">${kicker || (kind === 'movie' ? 'N° 1 des tendances cette semaine' : 'Série à découvrir')}</div>
    <h1>${esc(i.title)}</h1>
    <div class="meta">${metaBits(kind, item, i)}</div>
    <p class="ov">${esc(i.overview)}</p>
    <div class="actions"><button class="btn btn-play">${ico('play')}Lecture</button><button class="btn btn-ghost">${ico('info')}Plus d'infos</button></div></div>`;
  hero.addEventListener('pointerenter', () => setAmbient(kind, item));
  hero.querySelector('.btn-play').onclick = () => kind === 'movie' ? playMovie(item, 0) : openDetail(kind, item, { autoplay: true });
  hero.querySelector('.btn-ghost').onclick = () => openDetail(kind, item);
  if (!i.overview || !i.genres.length) fullMeta(kind, item).then(m => {
    const ov = hero.querySelector('.ov');
    if (m && m.o && ov) ov.textContent = m.o;
    const mt = hero.querySelector('.meta');
    if (m && mt) mt.innerHTML = metaBits(kind, item, info(kind, item));
  });
  return hero;
}

function upgradeHero() {
  const pick = pickHero();
  const old = $('#view .hero:not(.live-hero)');
  if (pick && old && (S.heroEmpty || !old.querySelector('.hero-bg'))) old.replaceWith(heroEl(pick));
}

/* ------------------------------------------------------------ mise en avant : tuiles « En direct » et « Ce soir » */
function liveTile(ev) {
  const ch = S.idx.live[ev.key];
  const t = el('div', 'stile glass');
  t.tabIndex = 0;
  const tm = ev.teams && ev.teams.length === 2 && ev.teams.every(x => x.b) ? ev.teams : null;
  const mid = tm
    ? `<div class="st-teams">${tm.map(x => `<span class="tm"><img src="${esc(x.b)}" alt="" onerror="this.style.visibility='hidden'"><span>${esc(x.n)}</span></span>`).join('<i>VS</i>')}</div>`
    : `<div>${ev.logo ? `<img class="st-logo" src="${esc(ev.logo)}" alt="" onerror="this.remove()">` : ''}<div class="st-title">${esc(ev.title)}</div><div class="st-sub">${esc(ev.ch)}${ev.next ? ' · Ensuite : ' + esc(ev.next.title) : ''}</div></div>`;
  t.innerHTML = `<div class="st-top"><span class="l"><span class="live-dot"></span>En direct · ${esc(ev.ch)}</span><span class="r">${hm(ev.start)} – ${hm(ev.end)}</span></div>
    ${mid}<div class="st-bar"><i style="width:${pct(ev.start, ev.end)}%"></i></div>`;
  activate(t, () => ch && playLive(ch, 0));
  return t;
}
function tonightTile(ev) {
  const t = el('div', 'stile glass');
  t.tabIndex = 0;
  const draw = () => {
    const rem = hasReminder(ev);
    const started = Date.now() / 1000 >= ev.start;
    t.innerHTML = `<div class="st-top"><span class="l">${started ? '<span class="live-dot"></span>En cours' : 'Ce soir'} · ${esc(ev.ch)}</span><span class="r">${hm(ev.start)}</span></div>
      <div><div class="st-title">${esc(ev.title)}</div><div class="st-sub">${esc([ev.tag, ev.year, ev.vote ? '★ ' + Number(ev.vote).toFixed(1) : ''].filter(Boolean).join(' · '))}</div></div>
      <button class="st-btn ${rem ? 'on' : ''}" tabindex="-1">${ico(rem ? 'bellOn' : 'bell')}${rem ? 'Rappel programmé' : 'Me rappeler'}</button>`;
    t.querySelector('.st-btn').onclick = async e => { e.stopPropagation(); await toggleReminder(ev); draw(); };
  };
  draw();
  activate(t, () => programDialog(ev));
  return t;
}
function fillSide(side) {
  if (!side || !side.isConnected) return;
  const now = Date.now() / 1000;
  const evs = (S.now && S.now.events || []).filter(e => S.idx.live[e.key] && e.end > now);
  const live = evs.find(e => e.teams && e.teams.every(x => x.b)) || evs.find(e => e.tag === 'Sport') || evs[0];
  const tn = (S.tonight && S.tonight.items || []).filter(e => S.idx.live[e.key] && e.end > now && (!live || e.key !== live.key));
  const tonight = tn.find(e => e.start > now) || tn[0];
  side.innerHTML = '';
  if (live) side.append(liveTile(live));
  if (tonight) side.append(tonightTile(tonight));
  side.hidden = !side.children.length;
}

/* ------------------------------------------------------------ accueil */
PAGES.home = function (v, token) {
  const page = el('div', 'page');
  const feature = el('section', 'feature');
  const side = el('div', 'side');
  side.hidden = true;
  feature.append(heroEl(pickHero()), side);
  page.append(feature);
  const rows = el('div', 'rows');
  const add = r => r && rows.append(r);
  add(rail('Continuer à regarder', continueCard, continueEntries()));
  const suggestSlot = el('div'); rows.append(suggestSlot);
  const tonightSlot = el('div'); rows.append(tonightSlot);
  const liveSlot = el('div'); rows.append(liveSlot);
  const discSlot = el('div'); rows.append(discSlot);
  const favVod = [...S.favs].map(f => { const i = f.indexOf(':'); return [f.slice(0, i), f.slice(i + 1)]; })
    .filter(([k]) => k !== 'live').map(([k, key]) => [k, resolve(k, key)]).filter(x => x[1]);
  add(rail('Ma liste', ([k, it]) => posterCard(k, it), favVod.slice(0, 30), () => go('mylist')));
  const dlDone = S.dl.items.filter(d => d.status === 'done');
  const dlItems = [];
  for (const d of dlDone) {
    const kind = d.kind === 'movie' ? 'movie' : 'series';
    const it = resolve(kind, d.key);
    if (it && !dlItems.some(x => x[1] === it)) dlItems.push([kind, it]);
  }
  add(rail('Vos téléchargements', ([k, it]) => posterCard(k, it), dlItems.slice(0, 30), () => go('downloads')));
  const movies = S.cat.movies.filter(it => itemState('movie', it).ok);
  add(rail('Ajoutés récemment chez vous', anyCard('movie'), movies.slice(0, 30), () => { S.filter.movie = 'all'; go('movies'); }));
  add(rail('Séries mises à jour', anyCard('series'), S.cat.series.slice(0, 30), () => { S.filter.series = 'all'; go('series'); }));
  const favLive = [...S.favs].filter(f => f.startsWith('live:')).map(f => S.idx.live[f.slice(5)]).filter(Boolean);
  const chans = [...new Set([...favLive, ...S.cat.live.filter(c => c.loc).slice(0, 24)])].slice(0, 24);
  add(rail(favLive.length ? 'Vos chaînes' : 'Chaînes TV', tile, chans, () => go('live')));
  page.append(rows);
  v.append(page);

  const fillTonight = () => {
    fillSide(side);
    tonightSlot.innerHTML = '';
    const items = (S.tonight && S.tonight.items || []).filter(e => S.idx.live[e.key] && e.end > Date.now() / 1000);
    const r = rail(`${ico('calendar')}Ce soir chez vous`, tonightCard, items, () => { S.liveTab = 'une'; go('live'); }, 'tonight-row');
    if (r) tonightSlot.append(r);
  };
  const fillLive = () => {
    fillSide(side);
    liveSlot.innerHTML = '';
    const ev = (S.now && S.now.events || []).filter(e => S.idx.live[e.key]);
    const r = rail('<span class="live-dot"></span>À la une en direct', eventCard, ev.slice(0, 16), () => go('live'));
    if (r) liveSlot.append(r);
  };
  if (S.tonight) fillTonight(); else loadTonight().then(() => stillHere(token) && fillTonight());
  if (S.now) fillLive(); else { liveSlot.append(placeholderRow('À la une en direct', true)); loadNow().then(() => stillHere(token) && fillLive()); }

  const fillDisc = () => {
    discSlot.innerHTML = '';
    const m = discRows('movie'), s = discRows('series');
    const byId = (arr, id) => arr.find(r => r.id === id);
    const order = [['movie', 'trend'], ['series', 'trend'], ['movie', 'blockbusters'], ['movie', 'top12'], ['series', 'top12'],
      ['movie', 'popular'], ['series', 'popular'], ['movie', 'new'], ['series', 'fr'], ['movie', 'fr'], ['series', 'new'],
      ['movie', 'action'], ['series', 'crime'], ['movie', 'comedy'], ['movie', 'family'], ['series', 'scifi'], ['movie', 'scifi'],
      ['movie', 'thriller'], ['series', 'comedy'], ['movie', 'horror'], ['series', 'anime'], ['movie', 'classics'], ['series', 'classics']];
    for (const [kind, id] of order) {
      const r = byId(kind === 'movie' ? m : s, id);
      if (!r) continue;
      const top = id === 'trend';
      const items = top ? r.items.slice(0, 10) : r.items.slice(0, 30);
      const row = rail(top ? `Top 10 des ${kind === 'movie' ? 'films' : 'séries'} cette semaine` : esc(r.title), anyCard(kind), items,
        () => { S.filter[kind] = 'feat'; go(kind === 'movie' ? 'movies' : 'series'); }, top ? 'ranked' : '');
      if (row) discSlot.append(row);
    }
    if (!discSlot.children.length) {
      for (const id of topCats('movie', 4)) {
        const items = S.cat.movies.filter(it => it.c.includes(id) && itemState('movie', it).ok).slice(0, 30);
        const row = rail(esc(catName('movie', id)), anyCard('movie'), items, () => { S.filter.movie = id; go('movies'); });
        if (row) discSlot.append(row);
      }
    }
    placeBecause();
    upgradeHero();
  };
  /* recommandations personnelles du profil */
  const fyRows = () => (S.forYou && S.forYou.rows || []);
  const placeBecause = () => {
    discSlot.querySelectorAll('.because').forEach(x => x.remove());
    const rowsB = fyRows().filter(r => r.keys).map(r => {
      const items = r.keys.map(k => resolve(r.kind, k)).filter(it => it && itemState(r.kind, it).ok);
      return items.length >= 4 ? rail(esc(r.title), anyCard(r.kind), items, null, 'because') : null;
    }).filter(Boolean);
    rowsB.forEach((row, i) => {
      const ref = discSlot.children[2 + i * 3];
      if (ref) discSlot.insertBefore(row, ref); else discSlot.append(row);
    });
  };
  const fillSuggest = () => {
    suggestSlot.innerHTML = '';
    const mix = fyRows().find(r => r.mixed);
    if (mix) {
      const items = mix.mixed.map(x => [x.kind, resolve(x.kind, x.key)]).filter(x => x[1] && itemState(x[0], x[1]).ok);
      const who = currentProfile().name;
      const r = rail(S.cfg.profiles.length > 1 && !/^moi$/i.test(who) ? `Recommandé pour ${esc(who)}` : 'Recommandé pour vous', ([k, it]) => posterCard(k, it), items);
      if (r && items.length >= 5) suggestSlot.append(r);
    }
    if (discSlot.children.length) placeBecause();
  };
  if (S.forYou) fillSuggest(); else loadForYou().then(() => stillHere(token) && fillSuggest());
  if (!S.cfg.has_tmdb) fillDisc();
  else if (S.disc.movie && S.disc.series) fillDisc();
  else {
    discSlot.append(placeholderRow('Top 10 des films cette semaine'), placeholderRow('Blockbusters des 12 derniers mois'));
    Promise.all([loadDiscover('movie'), loadDiscover('series')]).then(() => stillHere(token) && fillDisc());
  }
  if (S.heroEmpty && S.cfg.has_tmdb) S.cat.movies.slice(0, 16).forEach(it => want('movie', it));
};

/* ------------------------------------------------------------ films / séries */
function sorted(kind, items) {
  const s = S.sort[kind];
  const arr = items.slice();
  if (s === 'az') arr.sort((a, b) => info(kind, a).title.localeCompare(info(kind, b).title, 'fr'));
  else if (s === 'rating') arr.sort((a, b) => (info(kind, b).vote || 0) - (info(kind, a).vote || 0));
  else if (s === 'year') arr.sort((a, b) => (b.y || 0) - (a.y || 0));
  else if (s === 'quality') arr.sort((a, b) => (QRANK[qualities(kind, b).q[0]] || 0) - (QRANK[qualities(kind, a).q[0]] || 0));
  return arr;
}

function catalogPage(kind) {
  return function (v, token) {
    const page = el('div', 'page top');
    const all = list(kind).filter(it => itemState(kind, it).ok);
    const f = S.filter[kind];
    const label = kind === 'movie' ? 'Films' : 'Séries';
    if (f === 'feat') {
      page.append(el('div', 'page-head', `<h1>${label}</h1><span class="count">${all.length.toLocaleString('fr')} titres disponibles</span>`));
      page.append(chipsFor(kind));
      const slot = el('div', 'feat-rows');
      page.append(slot);
      v.append(page);
      const fill = () => {
        slot.innerHTML = '';
        for (const r of discRows(kind)) {
          const top = r.id === 'trend';
          const row = rail(top ? 'Top 10 cette semaine' : esc(r.title), anyCard(kind), r.items.slice(0, top ? 10 : 40), null, top ? 'ranked' : '');
          if (row) slot.append(row);
          if (top) { const more = rail('Autres tendances', anyCard(kind), r.items.slice(10, 40), null); if (more) slot.append(more); }
        }
        const add = r => r && slot.append(r);
        add(rail('Ajoutés récemment chez vous', anyCard(kind), all.slice(0, 30), () => { S.filter[kind] = 'all'; render(); }));
        add(rail('En 4K', anyCard(kind), all.filter(it => qualities(kind, it).q[0] === '4K').slice(0, 30), () => { S.filter[kind] = 'q4k'; render(); }));
        for (const id of topCats(kind, 8)) {
          add(rail(esc(catName(kind, id)), anyCard(kind), all.filter(it => it.c.includes(id)).slice(0, 30), () => { S.filter[kind] = id; render(); window.scrollTo(0, 0); }));
        }
        if (!S.cfg.has_tmdb) slot.prepend(el('div', 'notice', 'Ajoutez une clé TMDB dans les réglages pour voir les tendances, les blockbusters et les mieux notés.'));
      };
      if (!S.cfg.has_tmdb || S.disc[kind]) fill();
      else { slot.append(placeholderRow('Top 10 cette semaine'), placeholderRow('Les mieux notés')); loadDiscover(kind).then(() => stillHere(token) && fill()); }
      return;
    }
    const items = sorted(kind, f === 'all' ? all : f === 'q4k' ? all.filter(it => qualities(kind, it).q[0] === '4K') : all.filter(it => it.c.includes(f)));
    const head = el('div', 'page-head', `<h1>${label}</h1><span class="count">${items.length.toLocaleString('fr')} titres</span>
      <select class="pill sort"><option value="recent">Ajoutés récemment</option><option value="az">Titre A → Z</option><option value="rating">Mieux notés</option><option value="year">Année de sortie</option><option value="quality">Meilleure qualité</option></select>`);
    const sel = head.querySelector('select');
    sel.value = S.sort[kind];
    sel.onchange = () => { S.sort[kind] = sel.value; render(); };
    page.append(head, chipsFor(kind));
    const grid = el('div', 'grid');
    page.append(grid);
    v.append(page);
    if (!items.length) grid.replaceWith(el('div', 'empty', '<strong>Rien ici</strong>Cette catégorie est vide.'));
    else infiniteGrid(grid, items, it => posterCard(kind, it));
  };
}
PAGES.movies = catalogPage('movie');
PAGES.series = catalogPage('series');

function chipsFor(kind, extra) {
  const chips = el('div', 'chips');
  const order = (S.cat.cats.order[kind === 'movie' ? 'movies' : kind] || []).filter(id => catMap(kind)[id]);
  const all = list(kind).filter(it => itemState(kind, it).ok);
  const head = kind === 'live' ? [['all', 'Toutes', all.length]]
    : [['feat', '★ À la une', null], ['all', 'Tout', all.length], ['q4k', '4K', all.filter(it => qualities(kind, it).q[0] === '4K').length]];
  const opts = [...head, ...(extra || []), ...order.map(id => [id, catMap(kind)[id], S.counts[kind][id] || 0])].filter(o => o[2] !== 0);
  for (const [id, name, n] of opts) {
    const b = el('button', 'chip' + (S.filter[kind] === id ? ' on' : ''), `${esc(name)}${n != null ? `<b>${n}</b>` : ''}`);
    b.onclick = () => { S.filter[kind] = id; render(); };
    chips.append(b);
  }
  requestAnimationFrame(() => { const on = chips.querySelector('.on'); if (on) chips.scrollLeft = on.offsetLeft - 60; });
  return chips;
}

/* ------------------------------------------------------------ ma liste */
PAGES.mylist = function (v) {
  const page = el('div', 'page top');
  page.append(el('div', 'page-head', '<h1>Ma liste</h1>'));
  const entries = [...S.favs].map(f => { const i = f.indexOf(':'); return [f.slice(0, i), f.slice(i + 1)]; })
    .map(([k, key]) => [k, resolve(k, key)]).filter(x => x[1]);
  const vod = entries.filter(e => e[0] !== 'live'), chans = entries.filter(e => e[0] === 'live');
  const notify = S.cfg.notify || [];
  if (!entries.length && !notify.length) {
    page.append(el('div', 'empty', '<strong>Votre liste est vide</strong>Ajoutez des films, séries ou chaînes avec le bouton « Ma liste » de leur fiche.'));
  }
  if (vod.length) {
    page.append(el('div', 'section-title', 'Films et séries'));
    const g = el('div', 'grid'); vod.forEach(([k, it]) => g.append(posterCard(k, it))); page.append(g);
  }
  if (notify.length) {
    page.append(el('div', 'section-title', `${ico('bell')} Vous serez prévenu de leur arrivée`));
    const g = el('div', 'grid');
    notify.forEach(n => {
      const c = el('div', 'card poster-card ghost');
      c.innerHTML = `<div class="poster" style="background:${gradient(n.title)}"><div class="ph">${esc(n.title)}</div><div class="banner soon">En attente</div></div>`;
      activate(c, () => go('detail', { ghost: { id: n.id, kind: n.kind === 'movie' ? 'movie' : 'series', t: n.title } }));
      g.append(c);
    });
    page.append(g);
  }
  if (chans.length) {
    page.append(el('div', 'section-title', 'Chaînes'));
    const g = el('div', 'grid tiles'); chans.forEach(([, it]) => g.append(tile(it))); page.append(g);
  }
  v.append(page);
};

/* ------------------------------------------------------------ recherche */
function searchItems(kind, tokens, years, limit) {
  const out = [];
  for (const it of list(kind)) {
    let hay = it._n || (it._n = normTxt(it.t));
    const m = kind !== 'live' && S.meta[mkey(kind, it)];
    if (m && m.t) hay += ' ' + (m._n || (m._n = normTxt(m.t)));
    if (!tokens.every(t => hay.includes(t))) continue;
    if (years.length && it.y && !years.includes(it.y)) continue;
    let score = 0;
    const full = tokens.join(' ');
    if (it._n === full || (m && m._n === full)) score += 100;
    else if (it._n.startsWith(full) || (m && m._n && m._n.startsWith(full))) score += 50;
    if (years.length && years.includes(it.y)) score += 30;
    if (kind === 'live' && it.loc) score += 20;
    if (kind === 'movie' && !itemState(kind, it).ok) score -= 60;
    score -= it._n.length / 20;
    out.push([score, it]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}

PAGES.search = function (v) {
  const q = S.route.params.q || $('#q').value || '';
  const page = el('div', 'page top');
  const raw = normTxt(q).split(' ').filter(Boolean);
  const years = raw.filter(t => /^(19|20)\d\d$/.test(t)).map(Number);
  let tokens = raw.filter(t => !QUAL_WORDS.has(t) && !/^(19|20)\d\d$/.test(t));
  if (!tokens.length) tokens = raw.filter(t => !QUAL_WORDS.has(t));
  page.append(el('div', 'page-head', `<h1>« ${esc(q)} »</h1>`));
  if (!tokens.length) { page.append(el('div', 'empty', 'Tapez un titre ou un nom de chaîne.')); v.append(page); return; }
  const mv = searchItems('movie', tokens, years, 60), sr = searchItems('series', tokens, years, 40), lv = years.length ? [] : searchItems('live', tokens, [], 30);
  const evs = years.length ? [] : (S.now && S.now.events || []).filter(e => tokens.every(t => normTxt(e.title + ' ' + e.ch).includes(t)));
  const peopleSlot = el('div', 'people-slot');
  page.append(peopleSlot);
  let empty = null;
  if (!mv.length && !sr.length && !lv.length && !evs.length) {
    empty = el('div', 'empty', `<strong>Aucun résultat</strong>Essayez avec moins de mots, ou vérifiez l'orthographe.`);
    page.append(empty);
  }
  if (S.cfg.has_tmdb && q.trim().length >= 4 && !years.length) searchPeople(q.trim(), peopleSlot, empty, !!(mv.length || sr.length));
  if (evs.length) {
    page.append(el('div', 'section-title', 'En ce moment à la TV'));
    const g = el('div', 'grid events'); evs.forEach(e => g.append(eventCard(e))); page.append(g);
  }
  for (const [title, kind, arr] of [['Films', 'movie', mv], ['Séries', 'series', sr], ['Chaînes', 'live', lv]]) {
    if (!arr.length) continue;
    page.append(el('div', 'section-title', `${title} <span class="dim">${arr.length}</span>`));
    const g = el('div', kind === 'live' ? 'grid tiles' : 'grid');
    arr.forEach(it => g.append(kind === 'live' ? tile(it) : posterCard(kind, it)));
    page.append(g);
  }
  v.append(page);
};

/* Recherche par acteur, actrice, réalisateur */
const searchPeople = debounce(async (q, slot, empty, hasTitles) => {
  let r;
  try { r = await api('/api/person?q=' + encodeURIComponent(q)); } catch { return; }
  if (!slot.isConnected || !r.people.length) return;
  for (const [k, m] of Object.entries(r.meta || {})) if (!S.meta[k] || !S.meta[k].id) S.meta[k] = m;
  for (const p of r.people) {
    const items = [...p.movies.map(k => ['movie', resolve('movie', k)]), ...p.series.map(k => ['series', resolve('series', k)])]
      .filter(x => x[1] && itemState(x[0], x[1]).ok);
    if (!items.length) continue;
    const head = el('div', 'person-head', `<span class="person-img" style="${p.img ? `background-image:url('${IMG}w185${esc(p.img)}')` : `background:${gradient(p.name)}`}">${p.img ? '' : esc(p.name[0])}</span>
      <span><b>${esc(p.name)}</b><small>${esc(p.role || '')} · ${items.length} titre${items.length > 1 ? 's' : ''} disponible${items.length > 1 ? 's' : ''}</small></span>`);
    const g = el('div', 'grid');
    items.forEach(([k, it]) => g.append(posterCard(k, it)));
    slot.append(head, g);
  }
  if (slot.children.length && empty) empty.remove();
  if (slot.children.length && hasTitles) slot.parentNode.append(slot);   // titres d'abord, puis la filmographie
}, 350);

/* ------------------------------------------------------------ téléchargements */
let dlTimer = null;
PAGES.downloads = function (v, token) {
  const page = el('div', 'page top dl-page');
  v.append(page);
  const draw = () => {
    if (!stillHere(token)) return;
    const d = S.dl;
    const active = d.items.filter(x => ['downloading', 'queued', 'paused', 'error'].includes(x.status));
    const done = d.items.filter(x => x.status === 'done').sort((a, b) => (b.added || 0) - (a.added || 0));
    const used = done.reduce((s, x) => s + (x.size || 0), 0);
    page.innerHTML = `<div class="page-head"><h1>Téléchargements</h1><span class="count">${done.length} disponible${done.length > 1 ? 's' : ''} hors ligne · ${fmtSize(used) || '0 Mo'}</span></div>
      <div class="dl-info">${ico('folder')}<span>${esc(d.folder || '')}</span>${d.free ? `<span class="dim">· ${fmtSize(d.free)} libres</span>` : ''}
      ${d.held ? `<span class="pill-warn">${ico('pause')} En pause pendant la lecture</span>` : ''}</div>`;
    if (!d.items.length) {
      page.append(el('div', 'empty', `<strong>Aucun téléchargement</strong>Dans la fiche d'un film ou d'une série, utilisez le bouton ${ico('down')} pour regarder hors ligne.`));
      return;
    }
    if (active.length) {
      page.append(el('div', 'section-title', 'En cours'));
      const box = el('div', 'dl-list');
      active.forEach(x => box.append(dlRow(x, draw)));
      page.append(box);
    }
    if (done.length) {
      page.append(el('div', 'section-title', 'Prêts à regarder'));
      const box = el('div', 'dl-list');
      done.forEach(x => box.append(dlRow(x, draw)));
      page.append(box);
    }
  };
  draw();
  const tick = async () => { await loadDownloads(); if (stillHere(token)) { draw(); dlTimer = setTimeout(tick, 1500); } };
  dlTimer = setTimeout(tick, 1500);
  S.cleanup.push(() => clearTimeout(dlTimer));
};

function dlRow(x, redraw) {
  const kind = x.kind === 'movie' ? 'movie' : 'series';
  const it = resolve(kind, x.key);
  const i = it ? info(kind, it) : { title: x.title, poster: '' };
  const pc = x.size ? Math.floor(100 * x.done / x.size) : 0;
  const r = el('div', 'dl-row ' + x.status);
  const status = { downloading: `${pc} % · ${fmtSize(x.done)} / ${fmtSize(x.size)}${x.speed ? ' · ' + (x.speed / 1e6).toFixed(1).replace('.', ',') + ' Mo/s' : ''}`,
    queued: 'En attente', paused: `En pause · ${pc} %`, error: 'Erreur : ' + (x.err || ''), done: fmtSize(x.size) }[x.status];
  const img = x.img ? `/img/${x.id}/poster?t=${TOKEN}` : i.poster;
  r.innerHTML = `<div class="dl-img" style="background:${gradient(x.title)}">${img ? `<img src="${esc(img)}" alt="" onerror="this.remove()">` : ''}</div>
    <div class="dl-txt"><b>${esc(i.title || x.title)}</b><span>${esc([x.sub, x.label, x.year].filter(Boolean).join(' · '))}</span>
      <span class="dl-st">${esc(status)}</span>${x.status !== 'done' ? `<div class="progress"><i style="width:${pc}%"></i></div>` : ''}</div>
    <div class="dl-acts"></div>`;
  const acts = r.querySelector('.dl-acts');
  const btn = (icon, title, fn, cls = '') => { const b = el('button', 'rb ' + cls, ico(icon)); b.title = title; b.onclick = fn; acts.append(b); };
  const act = a => async () => { await api('/api/downloads', { id: x.id, action: a }); await loadDownloads(); redraw(); };
  if (x.status === 'done') {
    btn('play', 'Regarder', () => {
      if (x.kind === 'movie' && it) playMovie(it, Math.max(0, it.v.findIndex(v => String(v.id) === String(x.vid))));
      else play({ title: x.title, sub: x.sub, kind: 'series', key: x.key, pid: 'e:' + x.vid, ep: { id: x.vid, ext: x.ext }, streams: [{ type: x.kind === 'movie' ? 'movie' : 'episode', id: x.vid, ext: x.ext, label: 'Hors ligne' }] });
    }, 'rb-play');
    btn('trash', 'Supprimer', () => confirmDialog(`Supprimer « ${x.title}${x.sub ? ' – ' + x.sub : ''} » de cet ordinateur ?`, 'Supprimer', act('delete')));
  } else {
    if (x.status === 'paused' || x.status === 'error') btn('play', 'Reprendre', act('resume'));
    else btn('pause', 'Mettre en pause', act('pause'));
    btn('close', 'Annuler', act('cancel'));
  }
  return r;
}

function confirmDialog(msg, label, fn) {
  const b = openModal(`<div class="dialog"><p>${esc(msg)}</p><div class="actions"><button class="btn btn-accent" autofocus>${esc(label)}</button><button class="btn btn-ghost" data-close>Annuler</button></div></div>`, 'small');
  b.querySelector('.btn-accent').onclick = () => { closeModal(); fn(); };
}

/* ------------------------------------------------------------ profils « Qui regarde ? » */
PAGES.profiles = function (v, token, params) {
  const manage = !!params.manage;
  const page = el('div', 'profiles-page');
  const profs = S.cfg.profiles;
  page.innerHTML = `<div class="brand big"><img class="brand-logo" src="logo.svg" alt=""><b class="bw">Shippo<span class="tv">TV</span></b></div><h1>${manage ? 'Gérer les profils' : 'Qui regarde ?'}</h1><div class="prof-grid"></div>
    <div class="actions center"></div>`;
  const grid = page.querySelector('.prof-grid');
  profs.forEach(p => {
    const b = el('button', 'prof' + (manage ? ' edit' : ''), `${avatar(p, 'xl')}${manage ? `<span class="prof-edit">${ico('edit')}</span>` : ''}<span class="prof-name">${esc(p.name)}</span>`);
    b.onclick = () => manage ? profileDialog(p) : switchProfile(p.id, true);
    grid.append(b);
  });
  if (profs.length < 6) {
    const add = el('button', 'prof add', `<span class="avatar xl add">${ico('plus')}</span><span class="prof-name">Ajouter</span>`);
    add.onclick = () => profileDialog(null);
    grid.append(add);
  }
  const acts = page.querySelector('.actions');
  const done = el('button', manage ? 'btn btn-play' : 'btn btn-outline', manage ? 'Terminé' : 'Gérer les profils');
  done.onclick = () => manage ? (S.cat ? (S.stack.length ? back() : go('home', {}, { replace: true })) : go('profiles', {}, { replace: true })) : go('profiles', { manage: true }, { replace: true });
  acts.append(done);
  v.append(page);
  requestAnimationFrame(() => { const f = grid.querySelector('.prof'); if (f) f.focus(); });
};

function profileDialog(p) {
  const colors = ['#ff6a3d', '#3d8bff', '#2fbf71', '#b45cff', '#ffb347', '#ff4f8b', '#27c2c2'];
  let color = p ? p.color : colors[S.cfg.profiles.length % colors.length];
  const b = openModal(`<form class="dialog form-lite"><h2>${p ? 'Modifier le profil' : 'Nouveau profil'}</h2>
    <div class="prof-preview">${avatar({ name: p ? p.name : '?', color }, 'xl')}</div>
    <div class="field"><label>Nom</label><input type="text" name="name" maxlength="20" value="${esc(p ? p.name : '')}" autofocus></div>
    <div class="field"><label>Couleur</label><div class="swatches">${colors.map(c => `<button type="button" class="sw ${c === color ? 'on' : ''}" style="background:${c}" data-c="${c}"></button>`).join('')}</div></div>
    <div class="actions"><button class="btn btn-accent" type="submit">Enregistrer</button>${p && S.cfg.profiles.length > 1 ? `<button class="btn btn-ghost" type="button" data-a="del">${ico('trash')}Supprimer</button>` : ''}<button class="btn btn-ghost" type="button" data-close>Annuler</button></div></form>`, 'small');
  const f = b.querySelector('form');
  const prev = () => { b.querySelector('.prof-preview').innerHTML = avatar({ name: f.name.value || '?', color }, 'xl'); };
  f.name.oninput = prev;
  b.querySelectorAll('.sw').forEach(s => s.onclick = () => { color = s.dataset.c; b.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === s)); prev(); });
  f.onsubmit = async e => {
    e.preventDefault();
    const name = f.name.value.trim() || 'Profil';
    const r = await api('/api/profiles', p ? { action: 'edit', id: p.id, name, color } : { action: 'add', name, color });
    S.cfg.profiles = r.profiles;
    closeModal();
    updateNavProfile();
    render();
  };
  const del = b.querySelector('[data-a="del"]');
  if (del) del.onclick = () => confirmDialog(`Supprimer le profil « ${p.name} » ? Sa liste et son historique seront effacés.`, 'Supprimer', async () => {
    const r = await api('/api/profiles', { action: 'delete', id: p.id });
    S.cfg.profiles = r.profiles;
    if (S.profile === p.id) S.profile = r.profiles[0].id;
    render();
  });
}

async function switchProfile(pid, fromScreen) {
  S.profile = pid;
  try { sessionStorage.setItem('cineflux_profile', pid); } catch { /* stockage indisponible */ }
  S.cfg = await api('/api/config');
  S.favs = new Set(S.cfg.favs);
  S.upNext = [];
  S.forYou = null;
  updateNavProfile();
  S.stack = [];
  loadUpNext();
  if (!S.cat) return loadCatalog(false);
  go('home', {}, { replace: true });
  if (!fromScreen) toast(`Profil : ${currentProfile().name}`, 'info', 1800);
}
