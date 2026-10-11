/* ShippoTV TV — préparation du catalogue dans un fil séparé : la mise à jour quotidienne
   ne fige plus l'interface ni la lecture. */
importScripts('tvguide.js', 'catalog.js');
self.onmessage = function (e) {
  try {
    const cat = self.SH.catalog.buildCatalog(e.data.raw, e.data.tmdb || {});
    self.postMessage({ ok: true, cat: cat });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
