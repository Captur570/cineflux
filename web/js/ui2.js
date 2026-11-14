'use strict';
/* ShippoTV — interface 5.4 (inspirée de l'Apple TV et de Netflix) :
   - menu latéral avec icônes, qui s'ouvre quand on y va ;
   - à la télécommande : la rangée sélectionnée reste toujours à la même hauteur, et le haut de l'écran
     présente ce qui est sélectionné (image, titre, infos, résumé) ;
   - panneaux latéraux pour choisir une version de film ou la source d'une chaîne ;
   - choix de la source d'une chaîne : la plus sûre présélectionnée, la 4K « événements » jamais par défaut,
     et « Toujours utiliser ce choix » pour ne plus être interrogé.
   Chargé après player.js et avant les adaptations propres à chaque appareil. */

/* ------------------------------------------------------------ icônes supplémentaires */
Object.assign(ICONS, {
  layers: '<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  films: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
  series: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M6 5h12M8.5 2h7"/>',
  bcast: '<circle class="f" cx="12" cy="12" r="2.2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/>',
  bookmark: '<path d="M6 3.5h12v17l-6-4-6 4z"/>',
  dl2: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
});

/* ------------------------------------------------------------ menu latéral */
(function buildRail() {
  const nav = $('#nav');
  if (!nav) return;
  document.body.classList.add('ui2');
  const icons = { home: 'home', movies: 'films', series: 'series', live: 'bcast', mylist: 'bookmark', downloads: 'dl2' };
  $$('.links a', nav).forEach(a => {
    const label = a.textContent.trim();
    a.innerHTML = `${ico(icons[a.dataset.go] || 'list')}<span class="lb">${esc(label)}</span>`;
    a.title = label;
  });
  const links = $('.links', nav);
  const set = el('a', '', `${ico('settings')}<span class="lb">Réglages</span>`);
  set.dataset.go = 'settings'; set.tabIndex = 0; set.title = 'Réglages';
  links.append(set);
  // la recherche en tête du menu
  const search = $('.search', nav);
  if (search) { search.classList.add('rail-search'); links.before(search); }
  nav.classList.add('rail-nav');
})();

/* ------------------------------------------------------------ haut de l'écran qui suit la sélection (télécommande) */
const FH = { el: null, key: null, t: null };
function focusHeroEl() {
  if (FH.el) return FH.el;
  FH.el = el('div', 'focus-hero');
  FH.el.innerHTML = `<div class="fh-bg"></div><div class="fh-shade"></div>
    <div class="fh-in"><div class="fh-kicker"></div><h1 class="fh-title"></h1><div class="fh-meta"></div><p class="fh-ov"></p></div>`;
  document.body.append(FH.el);
  return FH.el;
}
function heroDataFor(card) {
  const kind = card.dataset.kind, k = card.dataset.k;
  const row = card.closest('.row');
  const kicker = row ? (row.querySelector('.row-head h2') || {}).textContent || '' : '';
  if ((kind === 'movie' || kind === 'series') && k) {
    const it = resolve(kind, k);
    if (it) {
      const i = info(kind, it);
      const bits = [i.year, kind === 'series' ? 'Série' : (i.runtime ? fmtMin(i.runtime) : ''), i.vote ? '★ ' + Number(i.vote).toFixed(1).replace('.', ',') : '', i.genres.slice(0, 2).join(', ')].filter(Boolean);
      return { key: kind + ':' + k, kicker, title: i.title, meta: bits.join('  ·  '), badges: qualityBadges(kind, it), ov: i.overview, bg: i.backdrop || i.poster, grad: gradient(it.t) };
    }
  }
  if (kind === 'live' && k) {
    const it = S.idx.live[k];
    const n = it && S.now && S.now.now[k];
    return { key: 'live:' + k, kicker: kicker || 'En direct', title: n ? n.t : (it ? it.t : ''), meta: it ? it.t + (n ? '  ·  ' + hm(n.s) + ' – ' + hm(n.e) : '') : '',
      badges: '<span class="badge hot">DIRECT</span>', ov: n && n.d ? n.d : '', bg: '', grad: gradient(it ? it.t : k) };
  }
  // programmes du soir, reprises… : on lit ce que la carte affiche
  const name = card.querySelector('.name, .ev-big, .ph');
  const sub = card.querySelector('.sub');
  const img = card.querySelector('img.main.ok');
  const thumb = card.querySelector('.ev-thumb, .cont-thumb, .thumb');
  const bgImg = thumb && thumb.style.backgroundImage && /url\(/.test(thumb.style.backgroundImage) ? thumb.style.backgroundImage.match(/url\(["']?([^"')]+)/)[1] : '';
  return { key: 'c:' + (name ? name.textContent : ''), kicker, title: name ? name.textContent : '', meta: sub ? sub.textContent : '', badges: '', ov: '',
    bg: bgImg || (img ? img.src : ''), grad: gradient(name ? name.textContent : 'x') };
}
function showFocusHero(card) {
  const d = heroDataFor(card);
  const h = focusHeroEl();
  if (FH.key === d.key) return;
  FH.key = d.key;
  h.querySelector('.fh-kicker').textContent = d.kicker.trim();
  h.querySelector('.fh-title').textContent = d.title;
  h.querySelector('.fh-meta').innerHTML = esc(d.meta) + (d.badges ? ' ' + d.badges : '');
  h.querySelector('.fh-ov').textContent = d.ov || '';
  const bg = h.querySelector('.fh-bg');
  clearTimeout(FH.t);
  // petit délai : on ne charge pas une grande image à chaque appui quand on fait défiler vite
  FH.t = setTimeout(() => { bg.style.backgroundImage = d.bg ? `url('${d.bg}'), ${d.grad}` : d.grad; }, d.bg ? 140 : 0);
}

const isRemote = () => document.body.classList.contains('tv');
const BROWSE_PAGES = new Set(['home', 'movies', 'series', 'live', 'mylist']);
function browseCard(e) {
  return isRemote() && e && e.classList && e.classList.contains('card') && e.closest('#view .row') && BROWSE_PAGES.has(S.route.page);
}
function setBrowsing(on) {
  document.body.classList.toggle('browsing', !!on);
  if (!on) { FH.key = null; }
}

/* déplacement : rangée sélectionnée toujours à la même hauteur, carte sélectionnée vers la gauche */
const _focusEl = focusEl;
focusEl = function (e) {
  if (!browseCard(e)) {
    if (document.body.classList.contains('browsing') && !(e.closest && (e.closest('#modal') || e.closest('#nav')))) {
      setBrowsing(false);
      e.focus({ preventScroll: true });
      const r = e.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) window.scrollTo({ top: Math.max(0, scrollY + r.top - innerHeight * 0.35) });
      return;
    }
    _focusEl(e);
    // jamais coupé en bas ni en haut (versions d'un film, listes…)
    const r = e.getBoundingClientRect();
    if (r.bottom > innerHeight - 24) window.scrollBy({ top: r.bottom - innerHeight + 60 });
    else if (r.top < 90 && !e.closest('#nav')) window.scrollBy({ top: r.top - 120 });
    return;
  }
  setBrowsing(true);
  e.focus({ preventScroll: true });
  const row = e.closest('.row');
  const rail = e.closest('.rail');
  // horizontal : la carte reste dans les trois premières places, puis c'est la rangée qui défile
  if (rail) {
    const cards = [...rail.children].filter(c => c.classList.contains('card'));
    const i = cards.indexOf(e);
    const pad = parseFloat(getComputedStyle(rail).paddingLeft) || 0;
    const anchor = cards[Math.max(0, i - 2)];
    rail.scrollLeft = i <= 2 ? 0 : Math.max(0, anchor.offsetLeft - pad - (anchor.offsetLeft - cards[0].offsetLeft > 0 ? 0 : 0));
  }
  // vertical : le haut de la rangée à 52 % de l'écran
  const top = row.getBoundingClientRect().top + scrollY;
  window.scrollTo({ top: Math.max(0, top - innerHeight * 0.52) });
  showFocusHero(e);
};
// changement de page : on repart d'en haut
const _render = render;
render = function () { setBrowsing(false); return _render.apply(this, arguments); };

/* ------------------------------------------------------------ panneau latéral */
function sidePanel(title, sub, rows, extra) {
  const html = `<div class="sp-head"><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div><div class="sp-rows"></div>
    <div class="sp-foot">${isRemote() ? 'Haut / bas pour choisir · OK pour valider · Retour pour fermer' : ''}</div>`;
  const body = openModal(html, 'side-panel');
  const box = body.querySelector('.sp-rows');
  let first = null;
  rows.forEach(r => {
    const b = el('button', 'sp-row' + (r.checked ? ' on' : '') + (r.off ? ' off' : '') + (r.toggle ? ' toggle' : ''));
    b.type = 'button';
    b.innerHTML = `<span class="sp-check">${r.toggle ? ico(r.checked ? 'check' : 'plus') : r.checked ? ico('check') : ''}</span>
      <span class="sp-main"><span class="sp-label">${esc(r.label)}${r.tag ? ` <span class="sp-tag${r.off ? ' grey' : ''}">${esc(r.tag)}</span>` : ''}</span>
      ${r.det ? `<span class="sp-det">${esc(r.det)}</span>` : ''}</span>`;
    b.onclick = () => r.pick(b);
    box.append(b);
    if (r.focus && !first) first = b;
  });
  requestAnimationFrame(() => (first || box.querySelector('.sp-row')).focus());
  if (extra) extra(body);
  return body;
}

/* ------------------------------------------------------------ versions d'un film */
function versionsPanel(item) {
  const good = bestFirst(goodVersions(item).length ? goodVersions(item) : item.v);
  sidePanel('Choisir la version', `${info('movie', item).title} · ${good.length} version${good.length > 1 ? 's' : ''}. La première est celle que ShippoTV choisit d'office.`,
    good.map((v, n) => {
      const st = vstat(v.id) || [];
      return {
        label: versionTitle(v) + (st[2] ? ' · ' + st[2] : ''), tag: n === 0 ? 'Recommandée' : '', focus: n === 0,
        det: [st[3] ? fmtMin(st[3]) : '', v.n, (v.ext || '').toUpperCase()].filter(Boolean).join(' · '),
        pick: () => { closeModal(); playMovie(item, item.v.indexOf(v)); },
      };
    }));
}

/* ------------------------------------------------------------ source d'une chaîne */
const SPORTY = /sport|match|ligue|league|coupe|cup|foot|rugby|tennis|basket|nba|formule|f1|moto ?gp|grand prix|jeux olymp|tour de france|ufc|boxe/i;
function srcPrefs() { return S.cfg.src_pick || {}; }
function bigEventNow(item) {
  const n = S.now && S.now.now[item.k];
  return !!(n && (SPORTY.test(n.t || '') || SPORTY.test(n.g || '') || n.tag === 'Sport'));
}
/** Source proposée d'office : celle choisie la dernière fois, sinon la meilleure… sauf la 4K, réservée
 *  le plus souvent aux grands événements (rien à l'antenne le reste du temps) : elle n'est prise d'office
 *  que si un match ou un grand événement est en cours. */
function defaultSource(item) {
  const p = srcPrefs()[item.k];
  if (p && item.s[p.i]) return p.i;
  if (bigEventNow(item)) return 0;
  const i = item.s.findIndex(s => s.q !== '4K');
  return i < 0 ? 0 : i;
}
function saveSrcPick(item, i, always) {
  const all = { ...srcPrefs(), [item.k]: { i, always: !!always } };
  S.cfg.src_pick = all;
  api('/api/config', { src_pick: all }).catch(() => {});
}
function sourceLabel(s, k) { return `${s.q ? (QLONG[s.q] || s.q) : 'Source ' + (k + 1)}`; }

const _playLive = playLive;
playLive = function (item, idx, only) {
  if (only || !item || !item.s || item.s.length < 2) return _playLive(item, idx, only);
  const def = defaultSource(item);
  const p = srcPrefs()[item.k];
  // en pleine lecture (zapping) ou choix « toujours » : pas de question
  if (P.o || document.body.classList.contains('playing') || (p && p.always) || window.__zapping || window.SHIPPO_NO_SOURCE_PANEL) return _playLive(item, def, def > 0);
  sourcePanel(item, def);
};
function sourcePanel(item, def) {
  const n = S.now && S.now.now[item.k];
  const has4k = item.s.some(s => s.q === '4K');
  const ev = bigEventNow(item);
  let always = !!(srcPrefs()[item.k] && srcPrefs()[item.k].always);
  const note = has4k ? (ev ? ' Un grand événement est en cours : la 4K est proposée.' : ` La 4K de ${item.t} ne diffuse souvent que les grands événements : elle n'est pas choisie d'office.`) : '';
  const rows = item.s.map((s, k) => ({
    label: sourceLabel(s, k), checked: k === def, focus: k === def,
    tag: k === def ? 'Recommandée' : (s.q === '4K' && !ev ? 'Événements' : ''), off: s.q === '4K' && !ev,
    det: s.n || '',
    pick: () => { saveSrcPick(item, k, always); closeModal(); _playLive(item, k, true); },
  }));
  rows.push({ label: `Toujours utiliser ce choix pour ${item.t}`, det: 'Ne plus demander : la lecture démarre directement la prochaine fois', toggle: true, checked: always,
    pick: b => { always = !always; b.querySelector('.sp-check').innerHTML = ico(always ? 'check' : 'plus'); b.classList.toggle('on', always); } });
  sidePanel(`${item.t}${n ? ' · ' + n.t : ''}`, 'Choisissez la source.' + note, rows);
}

/* ------------------------------------------------------------ bouton « Versions » dans la fiche d'un film */
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-a="versions"]');
  if (!b) return;
  const it = resolve('movie', b.dataset.k);
  if (it) versionsPanel(it);
});

/* ------------------------------------------------------------ télécommande : le menu ne « vole » pas le focus
   Haut / bas restent dans le contenu (ou dans le menu quand on y est) ; on entre dans le menu par la gauche,
   on en ressort par la droite, sur la carte qu'on avait quittée. */
let lastContent = null;
document.addEventListener('focusin', e => { if (e.target && e.target.closest && e.target.closest('#view')) lastContent = e.target; });
const _visibleEl = visibleEl;
let noNav = false;
visibleEl = function (e) { return !(noNav && e.closest && e.closest('#nav')) && _visibleEl(e); };
const _spatial = spatial;
spatial = function (dir) {
  const cur = document.activeElement;
  const modal = !$('#modal').hidden;
  const inNav = !modal && cur && cur.closest && cur.closest('#nav');
  const navItems = () => $$('#nav input, #nav .links a, #nav .profile-btn').filter(_visibleEl);
  if (!modal && (!cur || cur === document.body || !(cur.closest && (cur.closest('#view') || cur.closest('#nav'))))) {
    const first = $$(FOCUSABLE, $('#view')).find(e => { if (!_visibleEl(e)) return false; const r = e.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
    if (first) { focusEl(first); return; }
  }
  if (inNav && (dir === 'up' || dir === 'down')) {
    const items = navItems(); const n = items[items.indexOf(cur) + (dir === 'down' ? 1 : -1)];
    if (n) n.focus();
    return;
  }
  if (inNav && dir === 'right') {
    if (lastContent && lastContent.isConnected && _visibleEl(lastContent)) { focusEl(lastContent); return; }
    noNav = true; try { cur.blur(); _spatial('down'); } finally { noNav = false; }
    return;
  }
  if (!inNav && !modal && (dir === 'up' || dir === 'down')) { noNav = true; try { _spatial(dir); } finally { noNav = false; } return; }
  _spatial(dir);
  // entrée dans le menu par la gauche : sur la section en cours, pas sur l'élément le plus proche
  const now = document.activeElement;
  if (!inNav && !modal && now && now.closest && now.closest('#nav')) { const on = $('#nav .links a.on') || $('#nav .links a'); if (on) on.focus(); }
};
/* choix d'une section dans le menu, à la télécommande : le focus descend dans la page */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !isRemote()) return;
  const a = e.target && e.target.closest && e.target.closest('#nav .links a');
  if (!a) return;
  setTimeout(() => {
    if (!document.activeElement || !document.activeElement.closest('#nav')) return;
    const first = $$(FOCUSABLE, $('#view')).find(x => { if (!_visibleEl(x)) return false; const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
    if (first) _focusEl(first);
  }, 450);
});
