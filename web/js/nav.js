'use strict';
/* ShippoTV — navigation : pages, historique, boîtes de dialogue, télécommande (flèches) */

const PAGES = {};   // nom -> fonction de rendu (remplies par les autres modules)

function go(page, params = {}, opts = {}) {
  Preview.hide();
  if (!opts.replace && S.route && S.route.page !== 'profiles') {
    S.stack.push({ ...S.route, scroll: scrollY, focus: document.activeElement && document.activeElement.dataset && document.activeElement.dataset.k });
    if (S.stack.length > 40) S.stack.shift();
  }
  if (page !== 'search') { S.q = ''; const q = $('#q'); if (q) q.value = ''; }
  S.route = { page, params };
  render();
  window.scrollTo(0, 0);
}

function back() {
  if (!$('#modal').hidden) return closeModal();
  const prev = S.stack.pop();
  if (!prev) { if (S.route.page !== 'home') go('home', {}, { replace: true }); return; }
  S.route = { page: prev.page, params: prev.params };
  render();
  requestAnimationFrame(() => {
    window.scrollTo(0, prev.scroll || 0);
    if (prev.focus) { const c = $(`.card[data-k="${CSS.escape(prev.focus)}"]`); if (c) c.focus({ preventScroll: true }); }
  });
}

function render() {
  S.cleanup.forEach(f => f());
  S.cleanup = [];
  S.pendingRender = false;
  const page = S.route.page;
  document.body.dataset.page = page;
  if (page !== 'detail' && typeof resetAmbient === 'function') resetAmbient();
  $$('.links a').forEach(a => a.classList.toggle('on', a.dataset.go === page || (page === 'detail' && a.dataset.go === S.route.params.from)));
  const v = $('#view');
  v.innerHTML = '';
  $('#nav').hidden = page === 'profiles';
  if (!S.cat && !['settings', 'profiles'].includes(page)) return;
  const token = S.renderToken = Symbol();
  (PAGES[page] || PAGES.home)(v, token, S.route.params);
  updateOfflineBanner();
}
const stillHere = token => S.renderToken === token;

/* Rendu différé : si le catalogue change pendant qu'on regarde une fiche, on attend */
function softRefresh() {
  if (S.route.page === 'detail' || !$('#modal').hidden || P.o) S.pendingRender = true;
  else { const y = scrollY; render(); window.scrollTo(0, y); }
}

/* ------------------------------------------------------------ boîte de dialogue */
function openModal(html, cls = '') {
  const m = $('#modal');
  $('#modal-body').innerHTML = html;
  $('.modal-card').className = 'modal-card ' + cls;
  m.hidden = false;
  document.body.classList.add('modal-open');
  m.scrollTop = 0;
  requestAnimationFrame(() => { const f = $('#modal-body [autofocus]') || $('#modal-body button, #modal-body [tabindex="0"], #modal-body input'); if (f) f.focus(); });
  return $('#modal-body');
}
function closeModal() {
  const m = $('#modal');
  if (m.hidden) return;
  m.hidden = true;
  $('#modal-body').innerHTML = '';
  document.body.classList.remove('modal-open');
  S.modalToken = null;
  if (S.pendingRender) softRefresh();
}
document.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });

/* ------------------------------------------------------------ télécommande : déplacement aux flèches */
const FOCUSABLE = '.card, button:not([tabindex="-1"]), a[href], input, select, [tabindex="0"]';
function visibleEl(e) {
  if (e.disabled || e.closest('[hidden]')) return false;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function spatial(dir) {
  const scope = !$('#modal').hidden ? $('#modal') : document;
  const els = $$(FOCUSABLE, scope).filter(e => !e.closest('#player') && visibleEl(e));
  const cur = document.activeElement;
  if (!cur || cur === document.body || !els.includes(cur)) {
    const first = els.find(e => { const r = e.getBoundingClientRect(); return r.top >= 60 && r.top < innerHeight; }) || els[0];
    if (first) focusEl(first);
    return;
  }
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bd = Infinity;
  for (const e of els) {
    if (e === cur || e.contains(cur) || cur.contains(e)) continue;
    const b = e.getBoundingClientRect();
    const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
    let ok, d;
    if (dir === 'right') { ok = b.left >= r.right - 8 && Math.abs(ey - cy) < Math.max(r.height, b.height); d = (b.left - r.right) + Math.abs(ey - cy) * 4; }
    else if (dir === 'left') { ok = b.right <= r.left + 8 && Math.abs(ey - cy) < Math.max(r.height, b.height); d = (r.left - b.right) + Math.abs(ey - cy) * 4; }
    else if (dir === 'down') { ok = b.top >= r.bottom - 8; d = (b.top - r.bottom) * 1.4 + Math.abs(ex - cx) * 0.6; }
    else { ok = b.bottom <= r.top + 8; d = (r.top - b.bottom) * 1.4 + Math.abs(ex - cx) * 0.6; }
    if (ok && d < bd) { bd = d; best = e; }
  }
  if (best) focusEl(best);
  else if (dir === 'up') window.scrollTo({ top: 0, behavior: document.body.classList.contains('tv') ? 'auto' : 'smooth' });
}
function focusEl(e) {
  const behavior = document.body.classList.contains('tv') ? 'auto' : 'smooth';   // télé : déplacement immédiat, plus fluide
  e.focus({ preventScroll: true });
  e.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
  const r = e.getBoundingClientRect();
  if (r.top < 80) window.scrollBy({ top: r.top - 110, behavior });
}

document.addEventListener('keydown', e => {
  if (P.o) return;                                         // le lecteur gère ses touches
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = (tag === 'INPUT' && !document.activeElement.readOnly) || tag === 'TEXTAREA' || tag === 'SELECT';
  const map = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
  if (map[e.key] && !(typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || tag === 'SELECT'))) {
    e.preventDefault();
    if (typing) document.activeElement.blur();
    spatial(map[e.key]);
    return;
  }
  if (e.key === 'Escape' || (e.key === 'Backspace' && !typing) || e.key === 'BrowserBack' || e.keyCode === 10009) {
    if (typing && e.key === 'Escape' && document.activeElement === $('#q')) {
      $('#q').value = ''; $('#q').dispatchEvent(new Event('input')); $('#q').blur(); return;
    }
    if (typing && e.key === 'Backspace') return;
    e.preventDefault();
    if (!$('#modal').hidden) { if ($('.modal-x') && $('.modal-x').style.display !== 'none') closeModal(); return; }
    if ($('.menu-pop')) { $('.menu-pop').remove(); return; }
    back();
    return;
  }
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
});

/* ------------------------------------------------------------ barre du haut */
function avatar(p, size = '') {
  return `<span class="avatar ${size}" style="background:${p.color}">${esc((p.name || '?').slice(0, 1).toUpperCase())}</span>`;
}
function currentProfile() {
  return (S.cfg.profiles || []).find(p => p.id === S.profile) || (S.cfg.profiles || [])[0];
}
function setupNav() {
  $$('[data-go]').forEach(a => {
    a.addEventListener('click', () => { if (S.cat) { S.stack = []; go(a.dataset.go); } });
    a.addEventListener('keydown', e => { if (e.key === 'Enter') a.click(); });
  });
  $('#btn-profile').onclick = e => { e.stopPropagation(); profileMenu(); };
  $('#q').addEventListener('input', debounce(e => {
    const val = $('#q').value.trim();
    if (val) {
      if (S.route.page !== 'search') go('search', { q: val });
      else { S.route.params.q = val; render(); }
    } else if (S.route.page === 'search') back();
  }, 200));
  window.addEventListener('scroll', () => $('#nav').classList.toggle('solid', scrollY > 30), { passive: true });
  document.addEventListener('click', e => { const m = $('.menu-pop'); if (m && !m.contains(e.target)) m.remove(); });
  updateNavProfile();
}
function updateNavProfile() {
  const p = currentProfile();
  if (p) $('#btn-profile').innerHTML = avatar(p, 'sm') + ico('chevDown', 'small');
}
function profileMenu() {
  const old = $('.menu-pop');
  if (old) return old.remove();
  const m = el('div', 'menu-pop');
  const profs = S.cfg.profiles.filter(p => p.id !== S.profile);
  m.innerHTML = profs.map(p => `<button data-p="${p.id}">${avatar(p, 'xs')}<span>${esc(p.name)}</span></button>`).join('')
    + `<button data-a="manage">${ico('edit')}<span>Gérer les profils</span></button>`
    + `<div class="sep"></div><button data-a="settings">${ico('settings')}<span>Réglages</span></button>`;
  const r = $('#btn-profile').getBoundingClientRect();
  m.style.top = (r.bottom + 10) + 'px';
  m.style.right = (innerWidth - r.right) + 'px';
  document.body.append(m);
  m.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { m.remove(); switchProfile(b.dataset.p); });
  m.querySelector('[data-a="manage"]').onclick = () => { m.remove(); go('profiles', { manage: true }); };
  m.querySelector('[data-a="settings"]').onclick = () => { m.remove(); go('settings'); };
  const f = m.querySelector('button'); if (f) f.focus();
}

function updateOfflineBanner() {
  const b = $('#offline');
  if (!b) return;
  b.hidden = S.cfg.online !== false;
  const u = $('#updating');
  if (u) u.hidden = !(S.cfg.refreshing && S.cat);
}
