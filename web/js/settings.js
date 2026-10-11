'use strict';
/* ShippoTV — réglages (page entière, utilisable à la télécommande) */

PAGES.settings = function (v, token, params) {
  const c = S.cfg;
  const first = !c.configured || params.first;
  const acc = S.cat && S.cat.account;
  const exp = acc && acc.exp ? new Date(acc.exp * 1000).toLocaleDateString('fr', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const upd = c.catalog_ts ? new Date(c.catalog_ts * 1000).toLocaleString('fr', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null;
  const countries = (c.countries || []).map(x => `<option value="${x.code}">${x.flag} ${esc(x.name)}</option>`).join('');
  const detected = (c.countries || []).find(x => x.code === c.country);
  const page = el('div', 'page top settings-page');
  page.innerHTML = `<form class="form" autocomplete="off">
    <h1>${first ? 'Bienvenue sur ShippoTV' : 'Réglages'}</h1>
    <p class="lead">${first ? 'Entrez les identifiants Xtream fournis par votre abonnement. Ils restent enregistrés uniquement sur cet appareil.' : 'Vos identifiants restent enregistrés uniquement sur cet appareil.'}</p>
    ${params.error ? `<div class="err">${esc(params.error)}</div>` : ''}
    ${first ? '<section class="set quick-set" hidden></section>' : ''}

    <section class="set"><h2>${ico('user')}Abonnement</h2>
      ${exp ? `<div class="ok-msg">Abonnement actif jusqu'au ${exp}${acc.max ? ` · ${acc.max} connexion${acc.max > 1 ? 's' : ''} simultanée${acc.max > 1 ? 's' : ''}` : ''}</div>` : ''}
      <div class="field"><label>Adresse du serveur</label><input type="text" name="server" placeholder="http://exemple.com:8080" value="${esc(c.server)}">
        <div class="hint">Vous pouvez aussi coller votre lien M3U complet (…/get.php?username=…), les identifiants seront remplis tout seuls.</div></div>
      <div class="two">
        <div class="field"><label>Identifiant</label><input type="text" name="username" value="${esc(c.username)}"></div>
        <div class="field"><label>Mot de passe</label><input type="password" name="password" placeholder="${c.has_password ? '•••••••• (inchangé)' : ''}"></div>
      </div>
    </section>

    <section class="set"><h2>${ico('film')}Contenus</h2>
      ${c.builtin_tmdb && !c.own_tmdb ? `<div class="player-state"><span class="led" style="background:var(--good)"></span><span>Jaquettes, résumés et tendances fournis par TMDB (clé intégrée). <button class="link" type="button" id="own-tmdb">Utiliser ma propre clé</button></span></div>` : ''}
      <div class="field" id="tmdb-field" ${c.builtin_tmdb && !c.own_tmdb ? 'hidden' : ''}><label>Clé TMDB${c.builtin_tmdb ? ' personnelle' : ''} (jaquettes, résumés, tendances, vérification des films)</label><input type="password" name="tmdb_key" placeholder="${c.own_tmdb || (c.has_tmdb && !c.builtin_tmdb) ? '•••••••• (enregistrée)' : 'Clé API ou jeton de lecture'}">
        <div class="hint">Gratuite : créez un compte sur <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a>, puis copiez la « Clé d'API » ou le « Jeton d'accès en lecture ».${c.builtin_tmdb && c.own_tmdb ? ' <button class="link" type="button" id="builtin-tmdb">Revenir à la clé intégrée</button>' : ''}</div></div>
      <div class="two">
        <div class="field"><label>Pays (chaînes, programme TV, sport mis en avant)</label><select name="country"><option value="AUTO">Automatique${detected ? ` (${detected.flag} ${esc(detected.name)})` : ''}</option>${countries}</select></div>
        <div class="field pt"><label class="check"><input type="checkbox" name="show_unavailable" ${c.show_unavailable !== false ? 'checked' : ''}> Montrer les titres pas encore disponibles dans les sélections</label></div>
      </div>
    </section>

    ${first ? '' : `
    <section class="set"><h2>${ico('refresh')}Catalogue</h2>
      <div class="row-line"><span>${upd ? `Dernière mise à jour : <b>${esc(upd)}</b>` : 'Pas encore mis à jour'}<br><span class="dim">Le catalogue se met à jour tout seul toutes les 24 h, en arrière-plan.</span></span>
      <button class="btn btn-ghost" type="button" id="refresh">${ico('refresh')}${c.refreshing ? 'Mise à jour en cours…' : 'Actualiser maintenant'}</button></div>
    </section>

    <section class="set" data-pc><h2>${ico('play')}Lecture</h2>
      <div class="field"><label>Lecteur vidéo</label><select name="player_mode">
          <option value="auto">Automatique (recommandé)</option><option value="vlc">VLC intégré pour tout</option>
          <option value="web">Lecteur rapide pour tout</option><option value="external">Lecteur externe (mpv ou VLC installé)</option></select>
        <div class="hint">Automatique : films et séries dans VLC intégré (lit tous les formats), direct dans le lecteur rapide ; une chaîne qu'il ne sait pas lire bascule toute seule sur VLC.</div></div>
      <div class="player-state"><span class="led" style="background:${c.vlc ? 'var(--good)' : 'var(--bad)'}"></span>
        <span>${c.vlc ? `Lecteur VLC intégré prêt <span class="dim">(libVLC ${esc((c.vlc_version || '').split(' ')[0])} · ${esc(c.vlc_where)})</span>` : `Lecteur VLC intégré indisponible : le dossier « vlc » est introuvable à côté de Cineflux.exe. Relancez creer_exe.bat, ou installez VLC 64 bits.${c.vlc_error ? `<br><span class="dim">${esc(c.vlc_error)}</span>` : ''}`}</span></div>
      <div class="two">
        <div class="field"><label>Chemin du lecteur externe (facultatif)</label><input type="text" name="player_path" placeholder="C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" value="${esc(c.player_path || '')}"></div>
        <div class="field"><label>Format des chaînes (lecteurs externes)</label><select name="live_format"><option value="ts">MPEG-TS (.ts)</option><option value="m3u8">HLS (.m3u8)</option></select></div>
      </div>
      <label class="check"><input type="checkbox" name="fullscreen" ${c.fullscreen ? 'checked' : ''}> Lire les films et séries en plein écran</label>
    </section>

    <section class="set" data-pc><h2>${ico('down')}Téléchargements</h2>
      <div class="field"><label>Dossier</label><input type="text" name="dl_dir" value="${esc(c.dl_dir || '')}"></div>
      <label class="check"><input type="checkbox" name="dl_pause_play" ${c.dl_pause_play !== false ? 'checked' : ''}> Mettre les téléchargements en pause pendant que je regarde quelque chose (conseillé si votre abonnement n'autorise qu'une connexion)</label>
    </section>

    <section class="set" data-pc><h2>${ico('tv')}Affichage</h2>
      <label class="check"><input type="checkbox" name="tv_mode" ${c.tv_mode ? 'checked' : ''}> Mode TV : textes plus grands, navigation à la télécommande ou aux flèches du clavier</label>
    </section>

    <section class="set" id="sync-set"><h2>${ico('sync')}Synchronisation entre appareils</h2><div class="sync-body"><span class="spin"></span></div></section>

    <section class="set" id="about-set"><h2>${ico('info')}À propos</h2><div class="about-body"></div></section>`}

    <div class="row-btns">
      <button class="btn btn-accent" type="submit">${first ? 'Se connecter' : 'Enregistrer'}</button>
      ${first ? '' : '<button class="btn btn-ghost" type="button" data-a="cancel">Annuler</button>'}
    </div>
  </form>`;
  v.append(page);
  const form = page.querySelector('form');
  if (first) quickSetup(page.querySelector('.quick-set'));
  form.country.value = (c.country_setting || 'AUTO').toUpperCase();
  if (!first) {
    form.live_format.value = c.live_format || 'ts';
    form.player_mode.value = c.player_mode || 'auto';
    page.querySelector('[data-a="cancel"]').onclick = () => back();
    renderSync(page.querySelector('#sync-set .sync-body'));
    renderAbout(page.querySelector('#about-set .about-body'));
    page.querySelector('#refresh').onclick = async e => {
      e.target.disabled = true;
      e.target.innerHTML = ico('refresh') + 'Mise à jour en cours…';
      await api('/api/refresh', {});
      toast('Mise à jour du catalogue lancée en arrière-plan', 'info', 2500);
    };
  }
  const own = page.querySelector('#own-tmdb');
  if (own) own.onclick = () => { own.closest('.player-state').remove(); page.querySelector('#tmdb-field').hidden = false; form.tmdb_key.focus(); };
  const bt = page.querySelector('#builtin-tmdb');
  if (bt) bt.onclick = async () => {
    S.cfg = await api('/api/config', { tmdb_key: '' });
    S.disc = { movie: null, series: null };
    toast('Clé intégrée rétablie');
    go('settings', {}, { replace: true });
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Connexion…';
    const data = { server: form.server.value, username: form.username.value, country: form.country.value,
      show_unavailable: form.show_unavailable.checked };
    if (!first) Object.assign(data, {
      player_path: form.player_path.value, live_format: form.live_format.value, fullscreen: form.fullscreen.checked,
      player_mode: form.player_mode.value, dl_dir: form.dl_dir.value, dl_pause_play: form.dl_pause_play.checked,
      tv_mode: form.tv_mode.checked,
    });
    if (form.password.value) data.password = form.password.value;
    if (form.tmdb_key.value) data.tmdb_key = form.tmdb_key.value;
    if (!data.username && /username=/.test(data.server)) delete data.username;
    const credsChanged = data.server !== c.server || data.username !== c.username || !!data.password;
    const contentChanged = !!data.tmdb_key || data.country !== (c.country_setting || 'AUTO') || data.show_unavailable !== (c.show_unavailable !== false);
    try {
      S.cfg = await api('/api/config', data);
      S.favs = new Set(S.cfg.favs);
      applyUiMode();
      if (credsChanged || !S.cat) { S.stack = []; await loadCatalog(false); }
      else {
        if (contentChanged) { S.disc = { movie: null, series: null }; S.now = null; S.tonight = null; await reloadCatalog(); }
        back();
      }
      toast('Réglages enregistrés');
    } catch (err) {
      S.cfg = await api('/api/config').catch(() => S.cfg);
      go('settings', { first, error: err.message }, { replace: true });
    }
  };
};

/* ------------------------------------------------------------ synchronisation */
const ago = ts => {
  const s = Math.round(Date.now() / 1000 - ts);
  return s < 60 ? 'à l\'instant' : s < 3600 ? `il y a ${Math.round(s / 60)} min` : new Date(ts * 1000).toLocaleString('fr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const dayLabel = d => {
  if (!d) return '';
  const t = new Date().toISOString().slice(0, 10);
  if (d === t) return 'actif aujourd\'hui';
  return 'vu le ' + new Date(d + 'T12:00').toLocaleDateString('fr', { day: 'numeric', month: 'long' });
};

async function renderSync(box, st) {
  if (!box || !box.isConnected) return;
  try { st = st || await api('/api/sync'); } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const run = async (body, okMsg) => {
    box.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      const r = await api('/api/sync', body);
      if (r.error && body.action !== 'now') toast(r.error, 'error', 6000);
      else if (okMsg) toast(okMsg);
      renderSync(box, r);
      return r;
    } catch (e) { toast(e.message, 'error'); renderSync(box); }
  };
  const adv = `<details class="adv"><summary>Serveur de synchronisation (avancé)</summary>
      <div class="field"><label>Adresse du projet Supabase</label><input type="text" name="sync_url" placeholder="https://xxxx.supabase.co" value="${esc(st.custom_url || '')}"></div>
      <div class="field"><label>Clé publique (anon / publishable)</label><input type="password" name="sync_key" placeholder="${st.custom_url ? '•••••••• (enregistrée)' : ''}">
        <div class="hint">À laisser vide pour utiliser le serveur fourni avec ShippoTV${st.builtin ? '' : ' (aucun dans ce package)'}. Voir GUIDE_DISTRIBUTION.txt.</div></div>
      <button class="btn btn-ghost" type="button" data-s="server">Enregistrer le serveur</button></details>`;
  if (!st.crypto) { box.innerHTML = '<div class="err">Module de chiffrement absent : relancez creer_exe.bat.</div>'; return; }
  if (!st.configured) {
    box.innerHTML = `<p class="dim para">La synchronisation n'est pas activée dans ce package.</p>${adv}`;
  } else if (!st.in_group) {
    box.innerHTML = `<p class="para">Retrouvez vos profils, votre liste, vos reprises de lecture et vos alertes sur tous vos ordinateurs.
      Aucun compte à créer, et rien n'est lié à votre abonnement : les appareils sont associés par un code, et tout est chiffré avant d'être envoyé.</p>
      <div class="sync-choices">
        <div class="sync-choice"><h3>Premier appareil</h3><p class="dim">Créez le groupe sur cet ordinateur, puis associez les autres avec un code.</p>
          <button class="btn btn-accent" type="button" data-s="create">${ico('plus')}Créer un groupe</button></div>
        <div class="sync-choice"><h3>J'ai un code</h3><p class="dim">Affiché sur un appareil déjà synchronisé (Réglages › Associer un appareil).</p>
          <div class="code-line"><input type="text" name="pair_code" class="code-input" placeholder="ABC 123" autocomplete="off" spellcheck="false">
          <button class="btn btn-accent" type="button" data-s="join">Associer</button></div></div>
      </div>${adv}`;
  } else {
    const devs = (st.devices || []).map(d => `<li>${ico(d.me ? 'check' : 'tv')}<b>${esc(d.name || 'Appareil')}</b>${d.me ? '<span class="tag">cet appareil</span>' : ''}<span class="dim">${d.me ? '' : esc(dayLabel(d.seen))}</span></li>`).join('');
    box.innerHTML = `<div class="player-state"><span class="led" style="background:${st.error ? 'var(--bad)' : 'var(--good)'}"></span>
        <span>${st.error ? esc(st.error) : st.last_ok ? `Synchronisé ${esc(ago(st.last_ok))}` : 'Synchronisation en cours…'}</span></div>
      <ul class="dev-list">${devs || '<li class="dim">Aucun autre appareil pour l\'instant</li>'}</ul>
      <div class="row-btns wrap">
        <button class="btn btn-accent" type="button" data-s="code">${ico('plus')}Associer un appareil</button>
        <button class="btn btn-ghost btn-sm" type="button" data-s="rename">${ico('edit')}Renommer cet appareil</button>
        <button class="btn btn-ghost btn-sm" type="button" data-s="now">${ico('refresh')}Synchroniser maintenant</button>
        <button class="btn btn-ghost btn-sm" type="button" data-s="rotate">${ico('shield')}Changer la clé</button>
        <button class="btn btn-ghost btn-sm" type="button" data-s="leave">${ico('close')}Quitter le groupe</button>
      </div>${adv}`;
  }
  const on = (a, fn) => { const b = box.querySelector(`[data-s="${a}"]`); if (b) b.onclick = fn; };
  on('create', () => run({ action: 'create', name: 'ShippoTV' }, 'Groupe créé : associez maintenant vos autres appareils'));
  on('join', () => {
    const code = box.querySelector('[name=pair_code]').value;
    run({ action: 'join', code }, 'Appareil associé : vos données arrivent…').then(async r => {
      if (r && r.creds) { S.cfg = await api('/api/config'); S.stack = []; loadCatalog(false); }
    });
  });
  const ci = box.querySelector('[name=pair_code]');
  if (ci) {
    codeField(ci);
    ci.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); box.querySelector('[data-s="join"]').click(); } };
  }
  on('now', async () => { await run({ action: 'now' }); setTimeout(() => renderSync(box), 4000); });
  on('code', () => pairDialog(box));
  on('rename', () => {
    const me = (st.devices || []).find(d => d.me);
    const b = openModal(`<form class="dialog form-lite"><h2>Nom de cet appareil</h2><div class="field"><input type="text" name="n" maxlength="40" value="${esc(st.name || (me && me.name) || '')}" autofocus></div>
      <div class="actions"><button class="btn btn-accent" type="submit">Enregistrer</button><button class="btn btn-ghost" type="button" data-close>Annuler</button></div></form>`, 'small');
    b.querySelector('form').onsubmit = e => { e.preventDefault(); const n = e.target.n.value; closeModal(); run({ action: 'rename', name: n }).then(() => setTimeout(() => renderSync(box), 4000)); };
  });
  on('leave', () => confirmDialog('Quitter le groupe ? Cet ordinateur garde ses données mais ne se synchronise plus avec les autres.', 'Quitter', () => run({ action: 'leave' }, 'Synchronisation désactivée sur cet appareil')));
  on('rotate', () => confirmDialog('Changer la clé du groupe ? Les autres appareils seront déconnectés : il faudra les associer à nouveau avec un code. Utile si un appareil a été perdu ou donné.', 'Changer la clé', () => run({ action: 'rotate' }, 'Nouvelle clé créée : associez à nouveau vos appareils')));
  on('server', () => {
    const url = box.querySelector('[name=sync_url]').value.trim(), key = box.querySelector('[name=sync_key]').value.trim();
    if (url && !key && !st.custom_url) return toast('Indiquez aussi la clé publique', 'error');
    run({ action: 'server', url, key: key || (url ? undefined : '') }, 'Serveur enregistré');
  });
}

async function pairDialog(syncBox) {
  const b = openModal(`<div class="dialog pair"><h2>Associer un appareil</h2><div class="pair-body">
      <p>Un code à 6 caractères va s'afficher. Saisissez-le sur l'autre appareil (PC, télé ou iPad) dans
      Réglages › Synchronisation › <b>J'ai un code</b>, ou directement sur l'écran d'accueil d'une télé neuve.</p>
      <label class="check"><input type="checkbox" name="creds" checked> Transmettre aussi mes identifiants IPTV et la clé TMDB
        (l'autre appareil est configuré tout seul)</label>
      <div class="actions"><button class="btn btn-accent" data-a="go" autofocus>Afficher le code</button></div></div>
    <div class="actions"><button class="btn btn-ghost" data-close>Fermer</button></div></div>`, 'small');
  b.querySelector('[data-a="go"]').onclick = () => showPairCode(b, syncBox, b.querySelector('[name=creds]').checked);
}

async function showPairCode(b, syncBox, creds) {
  const body = b.querySelector('.pair-body');
  body.innerHTML = '<span class="spin"></span> Création du code…';
  let r;
  try { r = await api('/api/sync', { action: 'code', creds }); } catch (e) { r = { error: e.message }; }
  if (!body.isConnected) return;
  if (r.error || !r.pair) { body.innerHTML = `<div class="err">${esc(r.error || 'Code indisponible')}</div>`; return; }
  body.innerHTML = `<p>Sur l'autre appareil, saisissez :</p>
    <div class="pair-code">${esc(r.pair.code)}</div><p class="dim center pair-left"></p>
    <p class="hint">Le code ne sert qu'une fois. Il donne accès à vos profils et à votre liste${creds ? ' ainsi qu\'à vos identifiants IPTV' : ''} :
    ne le donnez qu'à vos propres appareils.</p>`;
  const left = body.querySelector('.pair-left');
  const tick = () => {
    if (!left.isConnected) return clearInterval(t);
    const sec = r.pair.expires - Math.floor(Date.now() / 1000);
    if (sec <= 0) { left.textContent = 'Code expiré : fermez et recommencez.'; body.querySelector('.pair-code').classList.add('expired'); clearInterval(t); return; }
    left.textContent = `Valable encore ${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} s`;
  };
  const t = setInterval(tick, 1000); tick();
  setTimeout(() => renderSync(syncBox), 30000);
}

/* Champ de code « ABC 123 ». Pas de longueur maximale imposée au champ : le clavier de la télé Samsung
   la confond avec la place restante (« la zone est saturée »). Le texte n'est remis en forme
   qu'en dehors de la saisie en cours du clavier. */
function codeField(ci) {
  const fmt = () => {
    const v = ci.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const out = v.length > 3 ? v.slice(0, 3) + ' ' + v.slice(3) : v;
    if (out !== ci.value) ci.value = out;
  };
  let composing = false;
  ci.addEventListener('compositionstart', () => { composing = true; });
  ci.addEventListener('compositionend', () => { composing = false; fmt(); });
  ci.addEventListener('input', e => { if (!composing && !e.isComposing && !document.body.classList.contains('tv')) fmt(); });
  ci.addEventListener('change', fmt);
  ci.addEventListener('blur', fmt);
  ci.addEventListener('keydown', e => { if (e.key === 'Enter') fmt(); }, true);
}

/* Configuration rapide d'un nouvel appareil avec un code affiché par un autre (PC ou télé) */
async function quickSetup(box) {
  let st;
  try { st = await api('/api/sync'); } catch { return; }
  if (!box.isConnected || !st.configured || !st.crypto) return;
  box.hidden = false;
  box.innerHTML = `<h2>${ico('sync')}Configuration rapide</h2>
    <p class="para">Vous utilisez déjà ShippoTV sur un PC ? Sur le PC, ouvrez Réglages › Synchronisation › <b>Associer un appareil</b>,
    puis saisissez ici le code affiché : abonnement, profils, liste et reprises arrivent tout seuls.</p>
    <div class="code-line"><input type="text" name="quick_code" class="code-input" placeholder="ABC 123" autocomplete="off" spellcheck="false">
      <button class="btn btn-accent" type="button" data-q="join">Valider</button></div>
    <p class="dim small-note">Sinon, entrez vos identifiants ci-dessous.</p>`;
  const ci = box.querySelector('[name=quick_code]');
  codeField(ci);
  const submit = async () => {
    const btn = box.querySelector('[data-q="join"]');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    let r;
    try { r = await api('/api/sync', { action: 'join', code: ci.value }); } catch (e) { r = { error: e.message }; }
    btn.disabled = false; btn.textContent = 'Valider';
    if (r.error) return toast(r.error, 'error', 6000);
    S.cfg = await api('/api/config');
    S.favs = new Set(S.cfg.favs);
    if (S.cfg.configured) {
      toast('Appareil configuré !', 'info', 3000);
      S.stack = [];
      if (S.cfg.profiles.length > 1) return go('profiles', {}, { replace: true });
      return loadCatalog(false);
    }
    toast('Synchronisé : il reste à saisir vos identifiants IPTV', 'info', 5000);
  };
  box.querySelector('[data-q="join"]').onclick = submit;
  ci.addEventListener('keydown', e => { if (e.key === 'Enter' && !ci.readOnly) { e.preventDefault(); submit(); } });
}

/* ------------------------------------------------------------ à propos / mises à jour */
async function renderAbout(box, st) {
  if (!box || !box.isConnected) return;
  try { st = st || await api('/api/update'); } catch { st = { current: S.cfg.version, enabled: false }; }
  const av = st.available;
  box.innerHTML = `<div class="row-line"><span><b>ShippoTV ${esc(st.current || S.cfg.version || '')}</b><br>
      <span class="dim">${S.cfg.platform === 'ios' ? (av ? `Nouvelle version disponible : <b>${esc(av.version)}</b>. Elle s'installe avec AltStore (ou TestFlight), voir GUIDE_IPAD.txt.` : 'ShippoTV est à jour. L\'appli vérifie les nouvelles versions toute seule.') : S.cfg.platform === 'tv' ? (av ? `Nouvelle version disponible : <b>${esc(av.version)}</b>. Sur votre PC : creer_appli_tv.bat, puis installez le fichier avec Apps2Samsung (vos réglages sont conservés).` : 'ShippoTV est à jour. La télé vérifie les nouvelles versions toute seule.') : st.state === 'downloading' ? `Téléchargement de la mise à jour… ${st.progress || 0} %`
        : av ? `Nouvelle version disponible : <b>${esc(av.version)}</b>` : st.enabled ? 'Les mises à jour sont vérifiées et proposées automatiquement.' : 'Mises à jour automatiques non configurées dans ce package.'}</span>
      ${st.error ? `<br><span class="bad-txt">${esc(st.error)}</span>` : ''}</span>
      <span class="row-btns">${av && S.cfg.platform !== 'tv' && S.cfg.platform !== 'ios' ? `<button class="btn btn-accent" type="button" data-u="install" ${st.state === 'downloading' ? 'disabled' : ''}>${ico('down')}Installer</button>` : ''}
      ${st.enabled ? `<button class="btn btn-ghost" type="button" data-u="check">${ico('refresh')}Vérifier</button>` : ''}</span></div>
    ${av && av.notes ? `<details class="adv"><summary>Nouveautés de la version ${esc(av.version)}</summary><pre class="notes">${esc(av.notes)}</pre></details>` : ''}
    <div class="tmdb-credit"><svg viewBox="0 0 64 24" class="tmdb-logo" aria-label="TMDB"><rect width="64" height="24" rx="6" fill="#0d253f"/><text x="32" y="16.5" text-anchor="middle" font-size="12" font-weight="700" font-family="Arial" fill="#01b4e4">TMDB</text></svg>
      <span>Jaquettes, résumés et informations : <a href="https://www.themoviedb.org" target="_blank">The Movie Database</a>.<br>
      <span class="dim">This product uses the TMDB API but is not endorsed or certified by TMDB.</span></span></div>
    <p class="dim small-note">ShippoTV ne fournit aucun contenu : il lit uniquement l'abonnement que vous renseignez.</p>`;
  const u = a => box.querySelector(`[data-u="${a}"]`);
  if (u('check')) u('check').onclick = async e => {
    e.target.disabled = true;
    const r = await api('/api/update', { action: 'check' }).catch(err => ({ error: err.message }));
    if (!r.error && !r.available) toast('ShippoTV est à jour');
    renderAbout(box, r);
  };
  if (u('install')) u('install').onclick = () => installUpdate(box);
  if (st.state === 'downloading') setTimeout(() => renderAbout(box), 1000);
}

async function installUpdate(box) {
  const r = await api('/api/update', { action: 'install' }).catch(e => ({ error: e.message }));
  if (r.error) return toast(r.error, 'error');
  toast('Téléchargement de la mise à jour…', 'info', 3000);
  if (box) renderAbout(box, r);
}

function applyUiMode() {
  document.body.classList.toggle('tv', !!S.cfg.tv_mode && S.cfg.platform !== 'ios');
}
