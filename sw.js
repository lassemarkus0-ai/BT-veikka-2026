/* sw.js — kevyt PWA-välimuisti.
   App shell (HTML/CSS/JS/logo) cache-first, jotta sivu latautuu heti
   toisella kerralla. data.json/season-bets.json network-first +
   cache-fallback: aina tuorein data kun yhteys toimii, mutta viimeisin
   onnistuneesti haettu versio näkyy jos yhteys pätkii (esim. hallilla).
   Liiga.fi:n suoria live-API-kutsuja EI siepata -- live-data ei saa
   koskaan tulla vanhentuneesta välimuistista, ja liiga-live.js:n oma
   try/catch-degradaatio hoitaa nekin epäonnistumiset jo valmiiksi. */

var CACHE_NAME = "bt-veikkaus-v1";

var APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./scoring.js",
  "./liiga-live.js",
  "./app.js",
  "./logo.png",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

var DATA_FILES = ["data.json", "season-bets.json"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(APP_SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(
          names.filter(function (n) { return n !== CACHE_NAME; })
               .map(function (n) { return caches.delete(n); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

function isDataFile(pathname) {
  return DATA_FILES.some(function (f) { return pathname.slice(-f.length) === f; });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  var url = new URL(req.url);

  // Vain oman originin GET-pyynnöt -- liiga.fi:n suorat API-kutsut jätetään
  // täysin rauhaan.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (isDataFile(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(function (resp) {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
          return resp;
        })
        .catch(function () { return caches.match(req); })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) { return cached || fetch(req); })
  );
});
