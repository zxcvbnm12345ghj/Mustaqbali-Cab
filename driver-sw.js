// Yammak — driver-sw.js
// Scope: driver.html only. Does NOT touch or replace sw.js (the
// customer app's service worker) — completely separate registration,
// separate scope, zero interaction with the customer PWA's caching.

self.addEventListener('push', (event) => {
  let data = { title: 'يمّك', body: '', url: '/driver.html' };
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
      // If driver.html is already open in a tab, navigate that tab to
      // the fresh targetUrl (which carries the current token/state)
      // before focusing it, instead of just focusing whatever it was
      // last showing. Without this, a tab left on an old/invalid state
      // (e.g. opened earlier without a valid ?driver_token=) gets
      // matched by the substring check below and is only ever
      // re-focused — never reloaded — so it can keep showing "رابط غير
      // صالح" forever regardless of how many valid notifications
      // arrive afterward. FIX: navigate first, then focus; fall back
      // to focus() alone if navigate() isn't available, and to
      // openWindow() if no matching tab exists at all.
      for (const client of clients) {
        if (client.url.includes('driver.html') && 'focus' in client) {
          if ('navigate' in client) {
            return client.navigate(targetUrl).then((navigatedClient) =>
              (navigatedClient || client).focus()
            );
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
