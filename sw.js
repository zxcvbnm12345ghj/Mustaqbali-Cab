// Mustaqbali Cab — Service Worker
// Scope: customer app shell only (index.html + its static assets).
// Deliberately does NOT cache Supabase, map tiles, or geocoding requests —
// trip data must always be live/network, never served stale from cache.

const CACHE_NAME = 'mustaqbali-shell-v2';
// Flat repo layout: style.css, app.css, app.js, config.js, and the icon
// PNGs all live in the project root — no css/, js/, or icons/ subfolders.
const SHELL_ASSETS = [
  '/index.html',
  '/style.css',
  '/app.css',
  '/config.js',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests for the app shell.
  // Everything else (Supabase, OpenStreetMap/CARTO tiles, Nominatim, Google
  // Fonts, jsDelivr) passes straight through to the network untouched.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Network-first, cache-fallback. This is the actual fix: the previous
  // "cache-first" strategy (`return cached || network`) served a stale
  // cached copy of app.css/app.js immediately whenever one existed —
  // which is exactly what breaks the UI right after every deploy for any
  // returning visitor, since their browser already has an old shell
  // cached and the old CSS/JS no longer matches the new HTML. Preferring
  // the network response (when available) means every visit picks up the
  // latest deployed files; the cache is now purely an offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
