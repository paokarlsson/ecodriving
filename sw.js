// Service worker: appens egna filer cachas så att den startar utan täckning.
// API-anrop (rutt, höjd, Overpass) går alltid direkt mot nätet.
const VERSION = 'bromsfri-v35';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/api.js', 'js/audio.js', 'js/calibration.js', 'js/demo.js', 'js/drive.js',
  'js/geo.js', 'js/mapview.js', 'js/osm.js', 'js/physics.js', 'js/route.js', 'js/sensors.js',
  'js/sim.js', 'js/store.js', 'js/lateral.js', 'js/logbook.js', 'js/coastlearn.js', 'js/rawstore.js', 'js/speedgraph.js',
];

self.addEventListener('install', e => {
  // Förbi webbläsarens HTTP-cache, annars kan en blandning av gamla och nya filer hamna i cachen
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Nätet först för egna filer (så uppdateringar syns direkt), cache som reserv.
// GitHub Pages låter webbläsaren spara filer i 10 minuter. Utan 'no-cache'
// kan sidan då få ny index.html men gammal app.css eller app.js. Med
// 'no-cache' frågas servern varje gång (oförändrade filer ger bara 304).
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))),
  );
});
