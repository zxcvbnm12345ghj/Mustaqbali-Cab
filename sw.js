// Yammak — Service Worker
// Scope: customer app shell only (index.html + its static assets).
// Deliberately does NOT cache Supabase, map tiles, or geocoding requests —
// trip data must always be live/network, never served stale from cache.

// v5: رفع الرقم يجعل المتصفح يثبّت هذا الـ SW كنسخة جديدة، ويحذف activate كل
// الكاشات القديمة (yammak-shell-v4 وما قبله). v5 = إصلاح notificationclick
// (التركيز على نافذة يمّك المفتوحة بدل فتح نافذة ثانية).
const CACHE_NAME = 'yammak-shell-v5';
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
    // cache:'reload' = لا تُملأ الكاش المسبق من كاش HTTP الخاص بالمتصفح (قد يحمل نسخة قديمة).
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => {})
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

  // الرابط المطلوب من الإشعار (الافتراضي: الصفحة الرئيسية للتطبيق).
  const rawUrl = (event.notification.data && event.notification.data.url) || '/index.html';
  let target;
  try {
    target = new URL(rawUrl, self.location.origin);
  } catch (_) {
    target = new URL('/index.html', self.location.origin);
  }

  // سبب فتح نافذة ثانية سابقًا: التطبيق المثبّت يُفتح على "/" (start_url في
  // manifest) فلا يحتوي رابطه على index.html فكان الفحص القديم يفشل دائمًا.
  // الآن نعتبر أي نافذة من نفس الأصل مسارها "/" أو ينتهي بـ index.html نافذة
  // يمّك (ولا نلمس نوافذ driver.html/admin.html إن كانت مفتوحة).
  const isCustomerApp = (c) => {
    try {
      const u = new URL(c.url);
      return u.origin === self.location.origin &&
        (u.pathname === '/' || u.pathname.endsWith('/index.html'));
    } catch (_) {
      return false;
    }
  };

  // رابط الإشعار الافتراضي = "افتح التطبيق فقط": نركّز النافذة ولا نعيد
  // تحميلها كي لا يضيع ما يكتبه الزبون في طلب قيد التعبئة. أي رابط مخصص
  // مختلف (مسار/استعلام/hash) نوجّه إليه النافذة الموجودة.
  const isDefaultTarget =
    target.origin === self.location.origin &&
    (target.pathname === '/' || target.pathname.endsWith('/index.html')) &&
    !target.search && !target.hash;

  event.waitUntil((async () => {
    // رابط خارجي (أصل مختلف): لا يمكن توجيه نافذة يمّك إليه، نفتحه كما كان.
    if (target.origin !== self.location.origin) {
      return self.clients.openWindow(target.href);
    }

    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const candidates = all.filter(isCustomerApp);
    // الأفضل: النافذة الظاهرة/المركَّز عليها حاليًا.
    const score = (c) => (c.focused ? 2 : 0) + (c.visibilityState === 'visible' ? 1 : 0);
    candidates.sort((a, b) => score(b) - score(a));

    const existing = candidates[0];
    if (existing) {
      try {
        const focused = await existing.focus();
        if (!isDefaultTarget && focused && 'navigate' in focused) {
          try { await focused.navigate(target.href); } catch (_) { /* نبقى على النافذة المركّزة */ }
        }
        return focused;
      } catch (_) {
        // فشل التركيز (مثلاً نافذة أُغلقت للتو) → نكمل ونفتح نافذة.
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
