// Bueno data CDN (2026-11-09): repo data files (data/, live/) are served
// from jsDelivr (GitHub CDN) pinned to the latest main commit, so daily
// data traffic and data-only deploys stop burning Netlify credits.
// Falls back to same-origin (Netlify) whenever anything fails, so the
// site behaves exactly as before in the worst case.
(function () {
  var base = '';
  var ready = fetch('https://api.github.com/repos/Bu3no7/bueno-nhl/commits?per_page=1')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j[0] && j[0].sha) {
        base = 'https://cdn.jsdelivr.net/gh/Bu3no7/bueno-nhl@' + j[0].sha + '/';
      }
    })
    .catch(function () {});
  window.dataFetch = function (p, opts) {
    if (/^https?:\/\//.test(p)) return fetch(p, opts);
    return ready.then(function () {
      if (!base) return fetch(p, opts);
      return fetch(base + p, opts).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r;
      }).catch(function () { return fetch(p, opts); });
    });
  };
})();
