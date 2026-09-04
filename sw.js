// Yammak — Service Worker
// Scope: customer app shell only (index.html + its static assets).
// Deliberately does NOT cache Supabase, map tiles, or geocoding requests —
// trip data must always be live/network, never served stale from cache.

const CACHE_NAME = 'yammak-shell-v3';
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

  // Network-first, cache-fallback. `cache: 'no-store'` on the fetch itself
  // is the actual fix here: without it, this request can still be quietly
  // satisfied by the browser's own HTTP cache (not this Service Worker's
  // Cache Storage) whenever a same-URL response is still considered fresh
  // by ordinary HTTP caching rules — which is exactly what kept serving a
  // stale admin.js after redeploys even though this handler "looks" like
  // it always goes to the network. Forcing no-store means every request
  // this handler makes truly reaches the server. The Cache Storage fallback
  // below is unaffected and still works for offline use.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
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

/* ============================================================
   Push notifications — additive only, added for the customer ads
   feature ("Push إعلاني للزبائن"). Does not touch install/activate/
   fetch above, and is fully independent of driver-sw.js/admin-sw.js
   (separate registrations/scopes) — this only ever shows ad
   notifications for the customer app itself.
   ============================================================ */
self.addEventListener('push', (event) => {
  let data = { title: 'يمّك', body: '', url: '/index.html' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) { /* ignore malformed payloads */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('index.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
