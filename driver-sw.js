// Mustaqbali Cab — driver-sw.js
// Scope: driver.html only. Does NOT touch or replace sw.js (the
// customer app's service worker) — completely separate registration,
// separate scope, zero interaction with the customer PWA's caching.

self.addEventListener('push', (event) => {
  let data = { title: 'مستقبلي كاب', body: '', url: '/driver.html' };
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
  const targetUrl = event.notification.data?.url || '/driver.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // If driver.html is already open in a tab, focus it instead of
      // opening a duplicate.
      for (const client of clients) {
        if (client.url.includes('driver.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
