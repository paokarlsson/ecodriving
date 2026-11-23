// Service worker: appens egna filer cachas så att den startar utan täckning.
// API-anrop (rutt, höjd, Overpass) går alltid direkt mot nätet.
const VERSION = 'bromsfri-v24';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/app.js', 'js/api.js', 'js/audio.js', 'js/calibration.js', 'js/demo.js', 'js/drive.js',
  'js/geo.js', 'js/mapview.js', 'js/osm.js', 'js/physics.js', 'js/route.js', 'js/sensors.js',
  'js/sim.js', 'js/store.js', 'js/trailer.js', 'js/lateral.js', 'js/logbook.js', 'js/coastlearn.js', 'js/demoroutes.js', 'js/rawstore.js', 'demo/ost-brunflo.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Nätet först för egna filer (så uppdateringar syns direkt), cache som reserv.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))),
  );
});
