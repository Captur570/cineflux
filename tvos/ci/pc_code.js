// Faux « PC » pour les essais GitHub : le vrai moteur ShippoTV (comme sur PC) crée un groupe de synchronisation
// sur le faux serveur, ajoute un profil et des favoris, puis fabrique un code de jumelage AVEC les identifiants
// IPTV (case cochée, comme chez l'utilisateur). Le code est écrit sur la sortie ; le moteur reste ouvert
// (synchronisation) jusqu'à la fin des essais.
const { makeCtx, load, call } = require('./jsc_sim.js');
const base = { version: 'pc', supabase_url: 'http://127.0.0.1:8798', supabase_key: 'test', update_repo: '' };
(async () => {
  const pc = makeCtx('pc'); load(pc, base);
  await call(pc, '/api/config', { server: 'http://127.0.0.1:8799', username: 'demo', password: 'demo' });
  await call(pc, '/api/sync', { action: 'create', name: 'Cinéflux' });
  await call(pc, '/api/sync', { action: 'now' });
  const r = await call(pc, '/api/sync', { action: 'code', creds: process.argv[2] !== 'nocreds' });
  console.log(r.pair.code);
  setTimeout(() => process.exit(0), 15 * 60 * 1000);
})().catch(e => { console.error('PC :', e.message); process.exit(1); });
