'use strict';
/* ShippoTV — cartes, rangées et aperçu au survol */

function loadImg(card, src) {
  const img = card.querySelector('img.main');
  if (!img || !src) return;
  img.onload = () => img.classList.add('ok');
  img.onerror = () => { img.classList.remove('ok'); img.removeAttribute('src'); };
  img.src = src;
}

function activate(c, fn) {
  c.tabIndex = 0;
  c.onclick = fn;
  c.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } };
}

/* Affiche de film ou de série */
function posterCard(kind, item) {
  const i = info(kind, item);
  const st = itemState(kind, item);
  const c = el('div', 'card poster-card' + (st.ok ? '' : ' unavailable'));
  c.dataset.kind = kind;
  c.dataset.k = item.k;
  const pr = progressFor(kind, item);
  c.innerHTML = `<div class="poster" style="background:${gradient(item.t)}">${i.poster ? '<img class="main" alt="" loading="lazy" decoding="async">' : ''}`
    + `<div class="ph">${esc(i.title)}${i.year ? `<small>${i.year}</small>` : ''}</div>`
    + (st.ok ? '' : `<div class="banner">Indisponible</div>`)
    + (pr ? `<div class="tbar"><i style="width:${pr}%"></i></div>` : '')
    + (kind === 'series' && S.cfg.follow && S.cfg.follow[item.k] ? `<span class="new-ep">${S.cfg.follow[item.k].new > 1 ? S.cfg.follow[item.k].new + ' nouveaux épisodes' : 'Nouvel épisode'}</span>` : '')
    + `</div>`
    + `<span class="quals">${st.ok ? qualityBadges(kind, item) : ''}</span>`
    + (isDownloaded(kind, item) ? `<span class="dl-badge" title="Téléchargé">${ico('downloaded')}</span>` : '')
    + (S.favs.has(kind + ':' + item.k) ? '<i class="fav-dot" title="Dans ma liste"></i>' : '');
  loadImg(c, i.poster);
  activate(c, () => openDetail(kind, item));
  c.addEventListener('mouseenter', () => Preview.arm(c, kind, item));
  if (S.cfg.has_tmdb && S.meta[mkey(kind, item)] === undefined) io.observe(c);
  return c;
}

/* Titre absent chez le fournisseur (sélections TMDB) */
function ghostCard(g) {
  const c = el('div', 'card poster-card ghost');
  c.dataset.ghost = g.id;
  const cls = g.status === 'Au cinéma' ? 'cine' : g.status === 'Prochainement' ? 'soon' : '';
  c.innerHTML = `<div class="poster" style="background:${gradient(g.t)}">${g.p ? '<img class="main" alt="" loading="lazy">' : ''}`
    + `<div class="ph">${esc(g.t)}${g.y ? `<small>${g.y}</small>` : ''}</div><div class="banner ${cls}">${esc(g.status || 'Indisponible')}</div></div>`;
  loadImg(c, g.p ? IMG + 'w342' + g.p : '');
  activate(c, () => go('detail', { ghost: g }));
  return c;
}

const anyCard = kind => it => it.ghost ? ghostCard(it.ghost) : posterCard(kind, it);

function progressFor(kind, item) {
  const prog = S.cfg.progress || {};
  if (kind === 'movie') {
    const p = prog['m:' + item.k];
    return p && p.dur ? Math.round(100 * p.pos / p.dur) : 0;
  }
  return 0;
}

/* Chaîne */
function tile(item) {
  const c = el('div', 'card tile');
  c.dataset.kind = 'live';
  c.dataset.k = item.k;
  const n = S.now && S.now.now[item.k];
  c.innerHTML = `<div class="thumb" style="background:${gradient(item.t)}"><span class="live-pill">DIRECT</span>`
    + (item.p ? '<img class="main" alt="" loading="lazy" decoding="async">' : '')
    + `<div class="ph">${esc(item.t)}</div>`
    + (item.s.length > 1 ? `<span class="srcs">${item.s.length} sources</span>` : '')
    + (S.favs.has('live:' + item.k) ? '<i class="fav-dot"></i>' : '')
    + `<div class="tbar"><i style="width:${n ? pct(n.s, n.e) : 0}%"></i></div>`
    + `</div><div class="name">${esc(item.t)}</div><div class="sub ${n ? 'onair' : ''}">${esc(n ? n.t : catName('live', item.c))}</div>`;
  loadImg(c, item.p);
  activate(c, () => openChannel(item));
  return c;
}

const TAGCLS = { Sport: 'sport', Film: 'film', 'Série': 'serie', Info: 'info', 'Émission': 'show' };

/* Programme sans image : écussons des deux équipes pour un match, sinon grand logo de la chaîne */
function evVisual(ev) {
  if (ev.img) return { chip: true, html: '', cls: '' };
  const tm = ev.teams && ev.teams.length === 2 && ev.teams.every(t => t.b) ? ev.teams : null;
  if (tm) {
    return { chip: true, cls: ' fb fb-' + (TAGCLS[ev.tag] || 'other'), html: `<div class="ev-teams">${tm.map(t =>
      `<span class="tm"><img src="${esc(t.b)}" alt="" onerror="this.style.visibility='hidden'"><b>${esc(t.n)}</b></span>`).join('<i>VS</i>')}</div>` };
  }
  if (ev.logo) {
    return { chip: false, cls: ' fb fb-' + (TAGCLS[ev.tag] || 'other'),
      html: `<div class="ev-chl"><img src="${esc(ev.logo)}" alt="" onerror="this.parentNode.remove()"></div><div class="ev-big sm">${esc(ev.title)}</div>` };
  }
  return { chip: true, cls: '', html: `<div class="ev-big">${esc(ev.title)}</div>` };
}
function evBg(ev, vis) {
  const bg = ev.img ? `url('${IMG}w780${ev.img}'),${gradient(ev.title + ev.ch)}` : vis.cls ? '' : gradient(ev.title + ev.ch);
  return bg ? ` style="background-image:${bg}"` : '';
}

/* Programme en cours (« À la une en direct ») */
function eventCard(ev) {
  const ch = S.idx.live[ev.key];
  const c = el('div', 'card event');
  const vis = evVisual(ev);
  c.innerHTML = `<div class="ev-thumb${vis.cls}"${evBg(ev, vis)}>
      ${vis.chip ? logoChip(ev) : ''}
      <span class="ev-tag ${TAGCLS[ev.tag] || ''}">${esc(ev.tag)}</span>
      ${vis.html}
      <span class="ev-play">${ico('play')}</span>
      <div class="tbar"><i style="width:${pct(ev.start, ev.end)}%"></i></div>
    </div>
    <div class="name">${esc(ev.img ? ev.title : ev.ch)}</div><div class="sub">${ev.img ? esc(ev.ch) + ' · ' : ''}${hm(ev.start)} – ${hm(ev.end)}${!ev.img && ev.next ? ' · Ensuite : ' + esc(ev.next.title) : ''}</div>`;
  activate(c, () => ch && playLive(ch, 0));
  return c;
}

function logoChip(ev) {
  return ev.logo ? `<span class="ev-logo"><img alt="" src="${esc(ev.logo)}" onerror="this.parentNode.classList.add('txt');this.parentNode.textContent=${esc(JSON.stringify(ev.ch))}"></span>`
    : `<span class="ev-logo txt">${esc(ev.ch)}</span>`;
}

/* « Ce soir chez vous » */
function tonightCard(ev) {
  const c = el('div', 'card tonight');
  const started = Date.now() / 1000 >= ev.start;
  const rem = hasReminder(ev);
  const vis = evVisual(ev);
  c.innerHTML = `<div class="ev-thumb${vis.cls}"${evBg(ev, vis)}>
      ${vis.chip ? logoChip(ev) : ''}
      <span class="ev-tag ${TAGCLS[ev.tag] || ''}">${esc(ev.tag)}</span>
      <div class="tn-time${vis.chip ? '' : ' top'}">${started ? '<span class="live-dot"></span>En cours' : hm(ev.start)}</div>
      ${vis.html}
      <button class="tn-bell ${rem ? 'on' : ''}" title="${rem ? 'Rappel programmé' : 'Me rappeler'}">${ico(rem ? 'bellOn' : 'bell')}</button>
    </div>
    <div class="name">${esc(ev.title)}${ev.vote ? ` <span class="star">★ ${Number(ev.vote).toFixed(1)}</span>` : ''}</div>
    <div class="sub">${esc(ev.ch)} · ${hm(ev.start)} – ${hm(ev.end)}${ev.year ? ' · ' + ev.year : ''}</div>`;
  const bell = c.querySelector('.tn-bell');
  bell.onclick = e => { e.stopPropagation(); toggleReminder(ev).then(() => c.replaceWith(tonightCard(ev))); };
  bell.tabIndex = -1;
  activate(c, () => programDialog(ev));
  return c;
}

/* « Reprendre la lecture » */
function continueCard(p) {
  const kind = p.kind === 'movie' ? 'movie' : 'series';
  const item = resolve(kind, p.key);
  if (!item) return null;
  const i = info(kind, item);
  const c = el('div', 'card wide cont');
  c.dataset.kind = kind; c.dataset.k = item.k;
  const img = i.backdropSm || i.poster;
  const frac = p.dur ? Math.round(100 * p.pos / Math.max(1, p.dur)) : 0;
  c.innerHTML = `<div class="poster" style="background:${gradient(item.t)}">${img ? '<img class="main" alt="" loading="lazy">' : ''}<div class="ph">${esc(i.title)}</div>
      ${p.next ? `<span class="next-tag${p.new ? ' new' : ''}">${p.new ? 'Nouvel épisode' : 'Épisode suivant'}</span>` : ''}
      <div class="cont-play">${ico('play')}</div>${!p.next || frac ? `<div class="tbar big"><i style="width:${frac}%"></i></div>` : ''}</div>
    <div class="name">${esc(i.title)}</div><div class="sub">${esc(p.label && kind === 'series' ? p.label : 'Reste ' + fmtMin((p.dur - p.pos) / 60))}</div>`;
  loadImg(c, img);
  activate(c, () => {
    if (p.next) play({ title: i.title, sub: p.sub, kind: 'series', key: item.k, pid: p.pid, ep: p.ep, streams: p.streams,
      queue: (p.queue || []).map(q => ({ ...q, title: i.title })) });
    else if (kind === 'movie') { const idx = Math.max(0, item.v.findIndex(v => String(v.id) === String(p.vid))); playMovie(item, idx); }
    else if (p.ep) play({ title: i.title, sub: p.label, kind: 'series', key: item.k, pid: 'e:' + p.ep.id, ep: p.ep, streams: [{ type: 'episode', id: p.ep.id, ext: p.ep.ext, label: 'Épisode' }] });
    else openDetail(kind, item);
  });
  return c;
}

/* Rangée horizontale */
function rail(title, make, items, onMore, extraCls) {
  if (!items.length) return null;
  const row = el('section', 'row' + (extraCls ? ' ' + extraCls : ''));
  row.innerHTML = `<div class="row-head"><h2>${title}</h2>${onMore ? `<button class="more" tabindex="-1">Tout voir ${ico('chevRight')}</button>` : ''}</div>`;
  const wrap = el('div', 'rail-wrap');
  const r = el('div', 'rail');
  items.forEach(it => { const c = make(it); if (c) r.append(c); });
  if (!r.children.length) return null;
  const l = el('button', 'arrow l', ico('chevLeft')), rt = el('button', 'arrow r', ico('chevRight'));
  l.tabIndex = rt.tabIndex = -1;
  l.onclick = () => r.scrollBy({ left: -r.clientWidth * 0.85 });
  rt.onclick = () => r.scrollBy({ left: r.clientWidth * 0.85 });
  wrap.append(l, r, rt);
  row.append(wrap);
  if (onMore) row.querySelector('.more').onclick = onMore;
  return row;
}

function placeholderRow(title, wide) {
  const row = el('section', 'row');
  row.innerHTML = `<div class="row-head"><h2>${esc(title)}</h2><span class="spin"></span></div><div class="rail">${`<div class="card skel ${wide ? 'wide' : ''}"><div class="poster"></div></div>`.repeat(8)}</div>`;
  return row;
}

function infiniteGrid(container, items, make, step = 60) {
  let i = 0;
  const sentinel = el('div', 'sentinel');
  const add = () => {
    const frag = document.createDocumentFragment();
    items.slice(i, i + step).forEach(it => { const c = make(it); if (c) frag.append(c); });
    i += step;
    container.append(frag);
    if (i >= items.length) { obs.disconnect(); sentinel.remove(); }
  };
  const obs = new IntersectionObserver(e => { if (e[0].isIntersecting) add(); }, { rootMargin: '900px' });
  container.after(sentinel);
  add();
  if (i < items.length) obs.observe(sentinel);
  S.cleanup.push(() => obs.disconnect());
}

/* ------------------------------------------------------------ aperçu au survol (souris uniquement) */
const Preview = {
  timer: null, pop: null, card: null,
  arm(card, kind, item) {
    if (document.body.classList.contains('tv') || matchMedia('(hover: none)').matches) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(card, kind, item), 520);
    card.addEventListener('mouseleave', () => { clearTimeout(this.timer); setTimeout(() => this.maybeHide(), 80); }, { once: true });
  },
  maybeHide() {
    if (this.pop && !this.pop.matches(':hover')) this.hide();
  },
  hide() {
    if (this.pop) { const p = this.pop; p.classList.add('out'); setTimeout(() => p.remove(), 160); }
    this.pop = null;
  },
  show(card, kind, item) {
    if (!card.isConnected || !card.matches(':hover')) return;
    this.hide();
    const i = info(kind, item);
    const st = itemState(kind, item);
    const r = card.getBoundingClientRect();
    const w = Math.max(320, r.width * 1.9);
    const p = el('div', 'pop');
    const img = i.backdropSm || i.poster;
    const fav = S.favs.has(kind + ':' + item.k);
    p.innerHTML = `<div class="pop-img" style="background:${gradient(item.t)}">${img ? `<img src="${esc(img)}" alt="">` : ''}<div class="pop-title">${esc(i.title)}</div></div>
      <div class="pop-body">
        <div class="pop-btns">
          <button class="rb rb-play" title="Lecture">${ico('play')}</button>
          <button class="rb" data-a="fav" title="${fav ? 'Retirer de ma liste' : 'Ajouter à ma liste'}">${ico(fav ? 'check' : 'plus')}</button>
          ${kind === 'movie' && st.ok ? `<button class="rb" data-a="dl" title="Télécharger">${ico(isDownloaded(kind, item) ? 'downloaded' : 'down')}</button>` : ''}
          <button class="rb push" data-a="info" title="Plus d'infos">${ico('chevDown')}</button>
        </div>
        <div class="pop-meta">${i.vote ? `<span class="star">★ ${Number(i.vote).toFixed(1)}</span>` : ''}${i.year ? `<span>${i.year}</span>` : ''}${i.runtime ? `<span>${fmtMin(i.runtime)}</span>` : ''}${st.ok ? qualityBadges(kind, item, 3) : '<span class="bad-txt">Indisponible</span>'}</div>
        <div class="pop-genres">${esc(i.genres.join(' • ') || (kind === 'series' ? 'Série' : catName(kind, item.c)))}</div>
      </div>`;
    document.body.append(p);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), innerWidth - w - 12);
    const top = Math.max(76, r.top + r.height / 2 - 150);
    Object.assign(p.style, { left: left + 'px', top: (top + scrollY) + 'px', width: w + 'px' });
    p.querySelector('.rb-play').onclick = e => { e.stopPropagation(); this.hide(); kind === 'movie' ? (st.ok ? playMovie(item, 0) : openDetail(kind, item)) : openDetail(kind, item, { autoplay: true }); };
    p.querySelector('[data-a="fav"]').onclick = async e => { e.stopPropagation(); await toggleFav(kind, item.k); this.hide(); };
    const dl = p.querySelector('[data-a="dl"]');
    if (dl) dl.onclick = e => { e.stopPropagation(); this.hide(); downloadDialog(item); };
    p.querySelector('[data-a="info"]').onclick = e => { e.stopPropagation(); this.hide(); openDetail(kind, item); };
    p.querySelector('.pop-img').onclick = () => { this.hide(); openDetail(kind, item); };
    p.addEventListener('mouseleave', () => this.hide());
    this.pop = p;
    if (!i.overview && S.cfg.has_tmdb) fullMeta(kind, item);
  },
};
window.addEventListener('scroll', () => Preview.hide(), { passive: true });

/* ------------------------------------------------------------ ambiance (PC)
   Le fond prend doucement la couleur de l'affiche survolée. La couleur est lue sur une petite copie
   de l'image ; si le serveur d'images ne le permet pas, on la déduit du titre. */
const AMB = { cache: {}, cur: null, t: null };
function ambientColors(rgb) {
  const [r, g, b] = rgb.map(x => x / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0;
  if (mx !== mn) {
    const d = mx - mn;
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(h * 60 + 360) % 360;
  }
  const s = mx === mn ? 0 : Math.min(85, Math.round(100 * (mx - mn) / (1 - Math.abs(mx + mn - 1)) + 20));
  return [`hsl(${h} ${s}% 26%)`, `hsl(${(h + 20) % 360} ${Math.max(20, s - 10)}% 14%)`];
}
function applyAmbient(c) {
  const root = document.documentElement.style;
  root.setProperty('--amb1', c[0]);
  root.setProperty('--amb2', c[1]);
}
function setAmbient(kind, item) {
  if (document.body.classList.contains('tv') || !item) return;
  const id = kind + ':' + item.k;
  if (AMB.cur === id) return;
  AMB.cur = id;
  clearTimeout(AMB.t);
  AMB.t = setTimeout(() => {
    if (AMB.cache[id]) return applyAmbient(AMB.cache[id]);
    const fallback = () => { const h = hue(item.t); return [`hsl(${h} 55% 24%)`, `hsl(${(h + 30) % 360} 45% 12%)`]; };
    const i = info(kind, item);
    const src = (i.backdropSm || i.poster || '').replace('/w780/', '/w92/').replace('/w342/', '/w92/').replace('/w500/', '/w92/');
    if (!src) { AMB.cache[id] = fallback(); return applyAmbient(AMB.cache[id]); }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const cv = document.createElement('canvas'); cv.width = cv.height = 10;
        const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, 10, 10);
        const d = cx.getImageData(0, 0, 10, 10).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = 0; k < d.length; k += 4) {
          const sat = Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]);
          const w = 1 + sat / 40;                     // les couleurs vives comptent plus que les gris
          r += d[k] * w; g += d[k + 1] * w; b += d[k + 2] * w; n += w;
        }
        AMB.cache[id] = ambientColors([r / n, g / n, b / n]);
      } catch { AMB.cache[id] = fallback(); }
      if (AMB.cur === id) applyAmbient(AMB.cache[id]);
    };
    img.onerror = () => { AMB.cache[id] = fallback(); if (AMB.cur === id) applyAmbient(AMB.cache[id]); };
    img.src = src;
  }, 120);
}
function resetAmbient() {
  AMB.cur = null;
  clearTimeout(AMB.t);
  applyAmbient(['#6e1430', '#3a0a1c']);
}
function ambientFrom(e) {
  const c = e.target && e.target.closest && e.target.closest('.card[data-kind][data-k]');
  if (!c || c.dataset.kind === 'live') return;
  const it = S.idx[c.dataset.kind] && S.idx[c.dataset.kind][c.dataset.k];
  if (it) setAmbient(c.dataset.kind, it);
}
document.addEventListener('pointerover', ambientFrom, { passive: true });
document.addEventListener('focusin', ambientFrom);
