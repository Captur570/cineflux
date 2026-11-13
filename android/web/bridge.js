/* ShippoTV Android — pont entre la page et l'appli native, avec le même protocole que l'iPad
   (window.webkit.messageHandlers.native.postMessage → Promise) : le moteur et l'interface
   n'ont rien à changer. Chargé en tout premier. */
(function () {
  'use strict';
  var A = window.ShippoAndroid;
  if (!A) return;
  var pending = {}, seq = 0;
  window.__nr = function (id, err, res) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (err) p.reject(new Error(err)); else p.resolve(res);
  };
  window.webkit = { messageHandlers: { native: { postMessage: function (msg) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      try { A.post(id, JSON.stringify(msg)); } catch (e) { delete pending[id]; reject(e); }
    });
  } } } };
  window.SHIPPO_IOS = true;                 // stockage et réseau natifs (sans restriction CORS)
  try { var t = A.testConfig(); if (t) window.SHIPPO_TEST = JSON.parse(t); } catch (e) { /* pas de mode test */ }
})();
