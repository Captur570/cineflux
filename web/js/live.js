'use strict';
/* ShippoTV — télévision : à la une, guide des programmes, chaînes, rappels */

function liveHero(ev) {
  const ch = S.idx.live[ev.key];
  const h = el('section', 'hero live-hero');
  const vis = evVisual(ev);
  const teams = !ev.img && vis.html.includes('ev-teams') ? vis.html : '';
  h.innerHTML = `<div class="hero-bg${teams ? ' ev-thumb fb fb-sport' : ''}" style="${ev.img ? `background-image:url('${IMG}w1280${ev.img}')` : teams ? '' : `background:${gradient(ev.title + ev.ch)}`}">${teams ? `<div class="hero-teams">${teams}</div>` : ''}</div>
    <div class="hero-info"><div class="kicker"><span class="live-dot"></span>À la une en direct · ${esc(ev.tag)}</div>
    ${ev.logo ? `<img class="hero-logo" src="${esc(ev.logo)}" alt="" onerror="this.remove()">` : ''}
    <h1>${esc(ev.title)}</h1>
    <div class="meta"><span>${esc(ev.ch)}</span><i class="dot"></i><span>${hm(ev.start)} – ${hm(ev.end)}</span>${ev.next ? `<i class="dot"></i><span>Ensuite : ${esc(ev.next.title)}</span>` : ''}</div>
    <div class="progress hero-prog"><i style="width:${pct(ev.start, ev.end)}%"></i></div>
    <p>${esc(ev.desc)}</p>
    <div class="actions"><button class="btn btn-play">${ico('play')}Regarder</button><button class="btn btn-ghost">${ico('info')}Sources et programme</button></div></div>`;
  h.querySelector('.btn-play').onclick = () => ch && playLive(ch, 0);
  h.querySelector('.btn-ghost').onclick = () => ch && openChannel(ch);
  return h;
}

PAGES.live = function (v, token) {
  const page = el('div', 'page');
  const tab = S.liveTab || 'une';
  const tabs = el('div', 'live-tabs');
  for (const [id, label, icon] of [['une', 'À la une', 'live'], ['guide', 'Guide TV', 'calendar'], ['chaines', 'Toutes les chaînes', 'list']]) {
    const b = el('button', 'ltab' + (tab === id ? ' on' : ''), ico(icon) + label);
    b.onclick = () => { S.liveTab = id; render(); };
    tabs.append(b);
  }
  if (tab === 'une') {
    const top = el('div', 'live-top'); page.append(top);
    page.append(tabs);
    const rows = el('div', 'rows flat'); page.append(rows);
    v.append(page);
    const fill = () => {
      top.innerHTML = ''; rows.innerHTML = '';
      const ev = (S.now && S.now.events || []).filter(e => S.idx.live[e.key]);
      if (ev.length) top.append(liveHero(ev[0]));
      else top.append(el('div', 'pad-head', `<h1>TV en direct</h1>`));
      const add = r => r && rows.append(r);
      add(rail('<span class="live-dot"></span>En ce moment', eventCard, ev.slice(1, 20), null));
      const tn = (S.tonight && S.tonight.items || []).filter(e => S.idx.live[e.key] && e.end > Date.now() / 1000);
      add(rail(`${ico('calendar')}Ce soir chez vous`, tonightCard, tn, null, 'tonight-row'));
      const favs = S.cat.live.filter(it => S.favs.has('live:' + it.k));
      add(rail('Vos chaînes favorites', tile, favs, null));
      const loc = S.cat.live.filter(c => c.loc);
      const flag = ((S.cfg.countries || []).find(x => x.code === S.cfg.country) || {}).flag || '';
      add(rail(`Les grandes chaînes ${flag}`, tile, loc.slice(0, 30), () => { S.liveTab = 'chaines'; S.filter.live = 'loc'; render(); }));
      const order = (S.cat.cats.order.live || []).filter(id => S.counts.live[id]).slice(0, 6);
      for (const id of order) add(rail(esc(catName('live', id)), tile, S.cat.live.filter(c => c.c === id).slice(0, 30), () => { S.liveTab = 'chaines'; S.filter.live = id; render(); }));
      updateLiveBits();
    };
    fill();
    Promise.all([loadNow(), loadTonight()]).then(() => stillHere(token) && fill());
    return;
  }
  page.classList.add('top');
  page.append(el('div', 'page-head', `<h1>TV en direct</h1>`), tabs);
  if (tab === 'guide') {
    const box = el('div', 'guide-wrap', '<div class="empty"><span class="spin"></span> Chargement du programme…</div>');
    page.append(box);
    v.append(page);
    (S.guideData && Date.now() / 1000 - S.guideData.ts < 300 ? Promise.resolve(S.guideData)
      : api('/api/guide').then(d => { d.ts = Date.now() / 1000; S.guideData = d; return d; }))
      .then(d => stillHere(token) && renderGuide(box, d))
      .catch(e => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
    return;
  }
  const favs = S.cat.live.filter(it => S.favs.has('live:' + it.k));
  const f = S.filter.live;
  const items = f === 'all' ? S.cat.live : f === 'fav' ? favs : f === 'loc' ? S.cat.live.filter(it => it.loc) : S.cat.live.filter(it => it.c === f);
  const locN = S.cat.live.filter(it => it.loc).length;
  const country = (S.cfg.countries || []).find(x => x.code === S.cfg.country);
  page.append(chipsFor('live', [...(favs.length ? [['fav', '★ Favoris', favs.length]] : []),
    ...(locN && locN < S.cat.live.length ? [['loc', `${country ? country.flag + ' ' + country.name : 'Mon pays'}`, locN]] : [])]));
  const grid = el('div', 'grid tiles');
  page.append(grid);
  v.append(page);
  if (!items.length) grid.replaceWith(el('div', 'empty', '<strong>Aucune chaîne</strong>Rien dans cette catégorie.'));
  else infiniteGrid(grid, items, tile, 48);
  loadNow().then(() => stillHere(token) && updateLiveBits());
};

function updateLiveBits() {
  $$('.tile[data-k]').forEach(t => {
    const n = S.now && S.now.now[t.dataset.k];
    const sub = t.querySelector('.sub'), bar = t.querySelector('.tbar i');
    if (n && sub) { sub.textContent = n.t; sub.classList.add('onair'); }
    if (n && bar) bar.style.width = pct(n.s, n.e) + '%';
  });
}
setInterval(() => {
  if (!S.cat || !['live', 'home'].includes(S.route.page) || P.o) return;
  loadNow(true).then(() => updateLiveBits());
}, 5 * 60 * 1000);

/* ------------------------------------------------------------ grille horaire */
function renderGuide(box, d) {
  const PX = 5;                          // pixels par minute
  const now = Date.now() / 1000;
  const t0 = Math.floor(d.t0 / 1800) * 1800;
  const width = Math.ceil((d.t1 - t0) / 60) * PX;
  const rows = d.rows.filter(r => r.progs.length && S.idx.live[r.key]);
  if (!rows.length) { box.innerHTML = '<div class="empty"><strong>Pas de programme</strong>Votre fournisseur ne transmet pas le guide des programmes pour ces chaînes.</div>'; return; }
  let head = '';
  for (let t = t0; t < d.t1; t += 1800) head += `<span style="left:${(t - t0) / 60 * PX}px">${hm(t)}</span>`;
  box.innerHTML = `<div class="guide" style="--w:${width}px"><div class="g-corner"></div><div class="g-times">${head}</div>
    <div class="g-now" style="left:calc(var(--chw) + ${(now - t0) / 60 * PX}px)"></div><div class="g-body"></div></div>`;
  const body = box.querySelector('.g-body');
  for (const r of rows) {
    const ch = S.idx.live[r.key];
    const row = el('div', 'g-row');
    const head = el('div', 'g-ch', `${r.logo ? `<img src="${esc(r.logo)}" alt="" onerror="this.remove()">` : ''}<span>${esc(r.ch)}</span>`);
    activate(head, () => playLive(ch, 0));
    row.append(head);
    const lane = el('div', 'g-lane');
    for (const p of r.progs) {
      const s = Math.max(p.start, t0), e = Math.min(p.end, d.t1);
      if (e <= s) continue;
      const on = p.start <= now && now < p.end;
      const b = el('div', `g-prog ${TAGCLS[p.tag] || ''} ${on ? 'on' : ''} ${p.end < now ? 'past' : ''}`,
        `<b>${esc(p.title)}</b><span>${hm(p.start)} – ${hm(p.end)}</span>${hasReminder({ key: r.key, start: p.start }) ? `<i class="g-bell">${ico('bellOn')}</i>` : ''}`);
      b.style.left = ((s - t0) / 60 * PX) + 'px';
      b.style.width = Math.max(24, (e - s) / 60 * PX - 3) + 'px';
      if (p.end < now && canReplay(ch, p)) b.classList.add('replayable');
      activate(b, () => on ? playLive(ch, 0) : programDialog({ ...p, key: r.key, ch: r.ch, logo: r.logo }));
      lane.append(b);
    }
    row.append(lane);
    body.append(row);
  }
  const g = box.querySelector('.guide');
  requestAnimationFrame(() => { g.scrollLeft = Math.max(0, (now - t0) / 60 * PX - 160); });
}

/* ------------------------------------------------------------ rattrapage (replay) */
function canReplay(ch, p) {
  if (!ch || !ch.arc || !p) return false;
  const now = Date.now() / 1000;
  return p.start < now && p.start > now - ch.arc * 86400;
}
function playReplay(ch, p) {
  const src = ch.s.filter(x => x.arc).sort((a, b) => b.arc - a.arc)[0] || ch.s[0];
  const now = Date.now() / 1000;
  const day = new Date(p.start * 1000).toLocaleDateString('fr', { weekday: 'long', day: 'numeric', month: 'long' });
  play({
    title: ch.t, sub: `${p.title} · ${p.end > now ? 'depuis le début' : `${day}, ${hm(p.start)}`}`, kind: 'replay', key: ch.k,
    streams: [{ type: 'replay', id: src.id, start: p.start, dur: Math.ceil((p.end - p.start) / 60), label: 'Replay' }],
  });
}
const dayName = t => {
  const d = new Date(t * 1000), today = new Date();
  const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  return diff === 0 ? "Aujourd'hui" : diff === 1 ? 'Hier' : d.toLocaleDateString('fr', { weekday: 'long', day: 'numeric' });
};
async function renderReplay(box, ch) {
  box.innerHTML = '<div class="spin"></div>';
  let d;
  try { d = await api('/api/replay?key=' + encodeURIComponent(ch.k)); } catch (e) { box.innerHTML = `<div class="dim">${esc(e.message)}</div>`; return; }
  if (!box.isConnected) return;
  const past = (d.progs || []).filter(p => !p.live);
  if (!d.available || !past.length) { box.innerHTML = '<div class="dim">Aucun programme disponible en replay pour le moment.</div>'; return; }
  const days = [...new Set(past.map(p => dayName(p.start)))];
  let cur = days[days.length - 1];
  box.innerHTML = '';
  const chips = el('div', 'chips inline');
  const list = el('div', 'replay-list');
  const show = () => {
    list.innerHTML = '';
    for (const p of past.filter(x => dayName(x.start) === cur).reverse()) {
      const r = el('button', 'epg-item replay', `<div class="when">${hm(p.start)}<br><span class="dim">${fmtMin((p.end - p.start) / 60)}</span></div>
        <div class="what">${esc(p.title)}${p.desc ? `<small>${esc(p.desc.slice(0, 160))}${p.desc.length > 160 ? '…' : ''}</small>` : ''}</div><span class="rb small">${ico('play')}</span>`);
      r.onclick = () => { closeModal(); playReplay(ch, p); };
      list.append(r);
    }
  };
  days.forEach(dn => {
    const c = el('button', 'chip' + (dn === cur ? ' on' : ''), esc(dn));
    c.onclick = () => { cur = dn; chips.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c)); show(); };
    chips.append(c);
  });
  box.append(chips, list);
  show();
}

/* ------------------------------------------------------------ fiche d'un programme */
function programDialog(ev) {
  const ch = S.idx.live[ev.key];
  const now = Date.now() / 1000;
  const started = now >= ev.start && now < ev.end;
  const rem = hasReminder(ev);
  const img = ev.img ? `${IMG}w780${ev.img}` : '';
  const vis = evVisual(ev);
  const b = openModal(`<div class="prog-dlg">
      <div class="prog-img${vis.cls.replace(' fb', ' ev-thumb fb')}" style="${img ? `background-image:url('${img}')` : vis.cls ? '' : `background:${gradient(ev.title + ev.ch)}`}">${vis.chip ? logoChip(ev) : ''}${ev.tag ? `<span class="ev-tag ${TAGCLS[ev.tag] || ''}">${esc(ev.tag)}</span>` : ''}${vis.html.replace(/<div class="ev-big[^]*$/, '')}</div>
      <div class="prog-body"><h2>${esc(ev.title)}</h2>
        <div class="meta"><span>${esc(ev.ch)}</span><i class="dot"></i><span>${new Date(ev.start * 1000).toLocaleDateString('fr', { weekday: 'long' })} ${hm(ev.start)} – ${hm(ev.end)}</span>${ev.vote ? `<i class="dot"></i><span class="star">★ ${Number(ev.vote).toFixed(1)}</span>` : ''}</div>
        ${started ? `<div class="progress"><i style="width:${pct(ev.start, ev.end)}%"></i></div>` : ''}
        <p>${esc(ev.desc || '')}</p>
        <div class="actions">
          <button class="btn btn-play" data-a="watch">${ico('play')}${started ? 'Regarder' : 'Regarder la chaîne'}</button>
          ${canReplay(ch, ev) ? `<button class="btn ${ev.end < now ? 'btn-play' : 'btn-ghost'}" data-a="replay">${ico(ev.end < now ? 'play' : 'rew')}${ev.end < now ? 'Revoir' : 'Depuis le début'}</button>` : ''}
          ${started || ev.end < now ? '' : `<button class="btn btn-ghost" data-a="rem">${ico(rem ? 'bellOn' : 'bell')}${rem ? 'Rappel programmé' : 'Me rappeler'}</button>`}
        </div></div></div>`, 'prog');
  b.querySelector('[data-a="watch"]').onclick = () => { closeModal(); ch && playLive(ch, 0); };
  const rp = b.querySelector('[data-a="replay"]');
  if (rp) rp.onclick = () => { closeModal(); playReplay(ch, ev); };
  if (ev.end < now && canReplay(ch, ev)) b.querySelector('[data-a="watch"]').classList.replace('btn-play', 'btn-ghost');
  const r = b.querySelector('[data-a="rem"]');
  if (r) r.onclick = async () => { await toggleReminder(ev); programDialog(ev); };
}

/* ------------------------------------------------------------ rappels */
function hasReminder(ev) {
  return (S.cfg.reminders || []).some(r => r.key === ev.key && r.start === ev.start);
}
async function toggleReminder(ev) {
  const on = !hasReminder(ev);
  try {
    const r = await api('/api/reminder', { on, key: ev.key, ch: ev.ch, title: ev.title, start: ev.start, end: ev.end });
    S.cfg.reminders = r.reminders;
    toast(on ? `Rappel : ${ev.title}, ${hm(ev.start)} sur ${ev.ch}` : 'Rappel supprimé', 'info', 2500);
  } catch (e) { toast(e.message, 'error'); }
}
const reminded = new Set();
setInterval(() => {
  if (!S.cfg || !S.cat) return;
  const now = Date.now() / 1000;
  for (const r of S.cfg.reminders || []) {
    const id = r.key + r.start;
    if (reminded.has(id) || now < r.start - 60 || now > r.end) continue;
    reminded.add(id);
    const ch = S.idx.live[r.key];
    toast(`Ça commence sur ${r.ch} : ${r.title}`, 'info', 15000, ch ? { label: 'Regarder', run: () => playLive(ch, 0) } : null);
  }
}, 20000);

/* ------------------------------------------------------------ fiche d'une chaîne */
async function openChannel(item) {
  const token = S.modalToken = Symbol();
  const body = openModal(`
    <div class="m-hero noimg" style="background:${gradient(item.t)}">
      <div>${item.p ? `<img class="ch-logo" src="${esc(item.p)}" alt="" onerror="this.remove()">` : ''}<h2>${esc(item.t)}</h2><div class="actions"></div></div>
    </div>
    <div class="m-body one">
      <div class="m-section"><h3>Au programme</h3><div class="epg"><div class="spin"></div></div></div>
      ${item.arc ? `<div class="m-section"><h3>Revoir <span class="badge">${item.arc} jour${item.arc > 1 ? 's' : ''}</span></h3><div class="replay"></div></div>` : ''}
      <div class="m-section"><h3>Sources <span class="badge">${item.s.length}</span></h3><div class="versions"></div></div>
    </div>`);
  const actions = body.querySelector('.actions');
  const playAll = el('button', 'btn btn-play', ico('play') + 'Regarder');
  playAll.onclick = () => { closeModal(); playLive(item, 0); };
  const fav = el('button', 'btn btn-ghost', ico(S.favs.has('live:' + item.k) ? 'check' : 'plus') + 'Favoris');
  fav.onclick = async () => { await toggleFav('live', item.k); fav.innerHTML = ico(S.favs.has('live:' + item.k) ? 'check' : 'plus') + 'Favoris'; };
  actions.append(playAll, fav);
  if (item.arc) renderReplay(body.querySelector('.replay'), item);
  const vs = body.querySelector('.versions');
  if (item.s.length > 1) {
    const auto = el('button', 'version');
    auto.innerHTML = `<span class="pl">${ico('play')}</span><span><div class="vt">Automatique</div><div class="vs">Essaie la meilleure source, puis passe à la suivante si elle ne répond pas</div></span>`;
    auto.onclick = () => { closeModal(); playLive(item, 0); };
    vs.append(auto);
  }
  item.s.forEach((s, k) => {
    const b = el('button', 'version');
    b.innerHTML = `<span class="pl">${ico('play')}</span><span><div class="vt">Source ${k + 1}${s.q ? ' · ' + esc(QLABEL[s.q] || s.q) : ''}</div><div class="vs">${esc(s.n)}</div></span>`
      + `<span class="tag">${s.q ? `<span class="badge ${s.q === '4K' ? 'hot' : ''}">${esc(QLABEL[s.q] || s.q)}</span>` : ''}</span>`;
    b.onclick = () => { closeModal(); playLive(item, k, true); };
    vs.append(b);
  });
  const box = body.querySelector('.epg');
  let progs = [];
  for (const s of item.s.slice(0, 3)) {
    try { progs = await api('/api/epg?id=' + encodeURIComponent(s.id)); } catch { progs = []; }
    if (progs.length) break;
  }
  if (S.modalToken !== token) return;
  if (!progs.length) { box.innerHTML = '<div class="dim">Pas de guide des programmes pour cette chaîne.</div>'; return; }
  const now = Date.now() / 1000;
  box.innerHTML = '';
  for (const p of progs) {
    const isNow = p.start <= now && now < p.end;
    const ev = { ...p, key: item.k, ch: item.t, logo: item.p };
    const row = el('div', `epg-item ${isNow ? 'now' : ''}`, `<div class="when">${isNow ? 'En ce moment' : hm(p.start)}<br><span class="dim">${hm(p.start)} – ${hm(p.end)}</span></div>
      <div class="what">${esc(p.title)}${p.desc ? `<small>${esc(p.desc.slice(0, 220))}${p.desc.length > 220 ? '…' : ''}</small>` : ''}${isNow ? `<div class="progress"><i style="width:${pct(p.start, p.end)}%"></i></div>` : ''}</div>`);
    if (isNow && item.arc) {
      const rs = el('button', 'btn btn-ghost btn-sm', ico('rew') + 'Depuis le début');
      rs.onclick = () => { closeModal(); playReplay(item, p); };
      row.querySelector('.what').append(rs);
    }
    if (!isNow && p.start > now) {
      const bell = el('button', 'rb small' + (hasReminder(ev) ? ' on' : ''), ico(hasReminder(ev) ? 'bellOn' : 'bell'));
      bell.title = 'Me rappeler';
      bell.onclick = async () => { await toggleReminder(ev); bell.innerHTML = ico(hasReminder(ev) ? 'bellOn' : 'bell'); };
      row.append(bell);
    }
    box.append(row);
  }
}
