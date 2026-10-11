/* ShippoTV TV — stockage persistant (IndexedDB), équivalent des fichiers JSON de la version PC.
   Chaque Store est chargé en mémoire au démarrage et réécrit (en différé) à chaque save(). */
(function (G) {
  'use strict';
  const SH = G.SH = G.SH || {};
  const DB_NAME = 'shippotv';
  let dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!G.indexedDB) return resolve(null);
      const req = G.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.warn('IndexedDB indisponible', req.error); resolve(null); };
    });
    return dbp;
  }

  // iPad / iPhone : l'appli native fournit le stockage (fichiers) et les requêtes réseau (sans restriction CORS)
  const NATIVE = G.SHIPPO_IOS && G.webkit && G.webkit.messageHandlers && G.webkit.messageHandlers.native;
  const native = msg => NATIVE.postMessage(msg);
  const nkv = {
    async get(k) { const s = await native({ cmd: 'kv', op: 'get', key: k }); return s ? JSON.parse(s) : undefined; },
    async set(k, v) { return !!(await native({ cmd: 'kv', op: 'set', key: k, value: JSON.stringify(v) })); },
    async del(k) { return !!(await native({ cmd: 'kv', op: 'del', key: k })); },
  };

  // repli : localStorage (petits volumes seulement)
  const ls = {
    get(k) { try { const v = G.localStorage.getItem('shippotv:' + k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
    set(k, v) { try { G.localStorage.setItem('shippotv:' + k, JSON.stringify(v)); } catch (e) { console.warn('stockage plein', k, e); } },
    del(k) { try { G.localStorage.removeItem('shippotv:' + k); } catch { /* rien */ } },
  };

  const kv = NATIVE ? nkv : {
    async get(k) {
      const d = await db();
      if (!d) return ls.get(k);
      return new Promise(resolve => {
        const tx = d.transaction('kv', 'readonly');
        const r = tx.objectStore('kv').get(k);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      });
    },
    async set(k, v) {
      const d = await db();
      if (!d) return ls.set(k, v);
      return new Promise(resolve => {
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => { console.warn('écriture impossible', k, tx.error); resolve(false); };
      });
    },
    async del(k) {
      const d = await db();
      if (!d) return ls.del(k);
      return new Promise(resolve => {
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(k);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    },
  };

  class Store {
    constructor(name, def) {
      this.name = name;
      this.def = def;
      this.data = JSON.parse(JSON.stringify(def));
      this._t = null;
    }
    async load() {
      const v = await kv.get(this.name);
      if (v && typeof v === 'object') {
        this.data = (this.def && !Array.isArray(this.def)) ? Object.assign(JSON.parse(JSON.stringify(this.def)), v) : v;
      }
      return this;
    }
    save() {                       // écriture regroupée (les sauvegardes rapprochées n'en font qu'une)
      clearTimeout(this._t);
      this._t = setTimeout(() => this.flush(), 400);
    }
    flush() {
      clearTimeout(this._t);
      this._t = null;
      return kv.set(this.name, this.data);
    }
  }

  /* Requête HTTP : XMLHttpRequest sur la télé (méthode prévue par Samsung pour les applis autorisées
     par <access origin="*">), fetch ailleurs. -> {status, text} ; erreur réseau/délai -> exception. */
  function http(url, opt = {}) {
    const method = opt.method || 'GET', headers = opt.headers || {}, timeout = (opt.timeout || 60) * 1000;
    if (NATIVE) {
      return native({ cmd: 'http', url, method, headers, body: opt.body === undefined ? null : String(opt.body), timeout: timeout / 1000 })
        .then(r => ({ status: r.status, text: r.text || '' }), e => { throw new Error((e && e.message) || 'réseau'); });
    }
    if (G.tizen && G.XMLHttpRequest) {
      return new Promise((resolve, reject) => {
        const x = new G.XMLHttpRequest();
        x.open(method, url, true);
        x.timeout = timeout;
        for (const [k, v] of Object.entries(headers)) { try { x.setRequestHeader(k, v); } catch { /* en-tête interdit */ } }
        x.onload = () => resolve({ status: x.status, text: x.responseText || '' });
        x.onerror = () => reject(new Error('réseau'));
        x.ontimeout = () => reject(new Error('délai dépassé'));
        x.send(opt.body === undefined ? null : opt.body);
      });
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    return fetch(url, { method, headers, body: opt.body, signal: ctl.signal, cache: 'no-store' })
      .then(async r => ({ status: r.status, text: await r.text() }))
      .catch(e => { throw new Error(ctl.signal.aborted ? 'délai dépassé' : (e && e.message) || 'réseau'); })
      .finally(() => clearTimeout(t));
  }

  SH.http = http;
  SH.kv = kv;
  SH.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
