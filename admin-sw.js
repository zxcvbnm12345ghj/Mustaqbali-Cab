// Mustaqbali Cab — admin-sw.js
// Scope: admin.html only. Fully independent of driver-sw.js and sw.js —
// separate file, separate registration, separate scope. A notification
// click here always opens admin.html, never driver.html.

self.addEventListener('push', (event) => {
  let data = { title: 'مستقبلي كاب — الإدارة', body: '', url: '/admin.html' };
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
  const targetUrl = event.notification.data?.url || '/admin.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('admin.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
