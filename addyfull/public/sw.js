self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'ADDY DSD Portal';
  const options = {
    body: data.body || 'You have a new notification',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: data.tag || 'addy-notification',
    data: { url: data.url || '/dashboard-admin.html' },
    actions: data.actions || []
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/dashboard-admin.html';
  event.waitUntil(clients.openWindow(url));
});
