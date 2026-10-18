// Simule JavaScriptCore : contexte vide (langage seul) + fonctions natives comme celles de Swift.
const vm = require('vm'), fs = require('fs'), nodeCrypto = require('crypto');
const R = require('path').resolve(__dirname, '..', '..') + '/';
const KV = new Map();
function makeCtx(tag) {
  const ctx = vm.createContext({});
  const log = (lvl, msg) => { if (lvl !== 'log' || process.env.V) console.log(`[${tag} ${lvl}] ${msg}`.slice(0, 400)); };
  ctx.__log = log;
  ctx.__timer = (id, ms) => { setTimeout(() => ctx.__fire(id), ms); };
  ctx.__env = { lang: 'fr-FR', langs: ['fr-FR', 'en-US'] };
  ctx.__random = n => nodeCrypto.randomBytes(n).toString('base64');
  ctx.__native = (json, cb) => {
    const m = JSON.parse(json);
    if (m.cmd === 'kv') {
      const k = tag + ':' + m.key;
      setTimeout(() => {
        if (m.op === 'get') cb(null, KV.has(k) ? KV.get(k) : null);
        else if (m.op === 'set') { KV.set(k, m.value); cb(null, true); }
        else { KV.delete(k); cb(null, true); }
      }, 1);
      return;
    }
    if (m.cmd === 'http') {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), (m.timeout || 60) * 1000);
      fetch(m.url, { method: m.method, headers: m.headers, body: m.body == null ? undefined : m.body, signal: ctl.signal })
        .then(async r => cb(null, { status: r.status, text: await r.text() }))
        .catch(e => cb(ctl.signal.aborted ? 'délai dépassé' : 'réseau', null)).finally(() => clearTimeout(t));
      return;
    }
    setTimeout(() => cb('commande inconnue', null), 0);
  };
  ctx.__crypto = (op, json) => {
    const a = JSON.parse(json), B = s => Buffer.from(s || '', 'base64');
    const h = x => ({ 'SHA-256': 'sha256', 'SHA-1': 'sha1', 'SHA-384': 'sha384', 'SHA-512': 'sha512' })[x];
    if (op === 'digest') return nodeCrypto.createHash(h(a.alg)).update(B(a.data)).digest('base64');
    if (op === 'hmac') return nodeCrypto.createHmac(h(a.hash), B(a.key)).update(B(a.data)).digest('base64');
    if (op === 'pbkdf2') return nodeCrypto.pbkdf2Sync(B(a.key), B(a.salt), a.iterations, a.bits / 8, h(a.hash)).toString('base64');
    if (op === 'aesgcm_seal') {
      const c = nodeCrypto.createCipheriv('aes-' + B(a.key).length * 8 + '-gcm', B(a.key), B(a.iv));
      if (a.aad) c.setAAD(B(a.aad));
      return Buffer.concat([c.update(B(a.data)), c.final(), c.getAuthTag()]).toString('base64');
    }
    if (op === 'aesgcm_open') {
      const d = B(a.data), tagB = d.subarray(d.length - 16), ct = d.subarray(0, d.length - 16);
      const c = nodeCrypto.createDecipheriv('aes-' + B(a.key).length * 8 + '-gcm', B(a.key), B(a.iv));
      if (a.aad) c.setAAD(B(a.aad));
      c.setAuthTag(tagB);
      try { return Buffer.concat([c.update(ct), c.final()]).toString('base64'); } catch (e) { return null; }   // Swift : null = échec
    }
    throw new Error('op ' + op);
  };
  return ctx;
}
function load(ctx, defaults) {
  vm.runInContext(fs.readFileSync(R + 'tvos/bridge.js', 'utf8'), ctx, { filename: 'bridge.js' });
  vm.runInContext('window.SHIPPO_DEFAULTS = ' + JSON.stringify(defaults) + "; window.SHIPPO_PLATFORM='atv';", ctx);
  for (const f of ['store.js', 'tvguide.js', 'verify.js', 'catalog.js', 'sync.js', 'app.js'])
    vm.runInContext(fs.readFileSync(R + 'tv/engine/' + f, 'utf8'), ctx, { filename: f });
}
const call = (ctx, path, body, prof) => new Promise((res, rej) => ctx.__call(path, body ? JSON.stringify(body) : null, prof || '', (e, s) => e ? rej(new Error(e)) : res(JSON.parse(s))));
module.exports = { makeCtx, load, call, KV };
