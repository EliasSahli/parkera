// Service worker: cachar bara appens egna filer så att den startar snabbt.
// All data (adresser, parkeringar, karta) hämtas alltid färskt från nätet.
const CACHE = 'parkera-v0.10.1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'sources.js', 'rules.js', 'config.js', 'geometry.js', 'tiles.js', 'nobil.js', 'map.js', 'mapstyle.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // Nätet först, cache som reserv – så nya versioner syns direkt
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
