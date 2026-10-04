// Service worker: makes the app installable and lets it keep working
// (fully client-side already, no network calls needed for parsing) even if
// the connection drops. Cache-first for the app shell; this is what fixes
// the old PWA's "iOS wipes it after 7 days" problem in combination with the
// manifest's display:standalone and index.html's navigator.storage.persist()
// call — Safari only exempts installed, persistently-stored PWAs from the
// 7-day Intelligent Tracking Prevention data cap.
const CACHE_NAME = 'ua-schedule-importer-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './js/pdfExtractor.js',
  './js/scheduleParser.js',
  './js/ics.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Cache-first for same-origin app shell files; network-first (fallback to
  // cache) for anything else (e.g. the pdf.js CDN script, so an update there
  // is picked up when online but the app still works offline once cached).
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
