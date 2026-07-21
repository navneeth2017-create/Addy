/**
 * ADDY service worker — push notifications (original behavior, unchanged)
 * plus the PWA layer: installable, and the app shell still opens offline.
 *
 * Caching strategy, deliberately conservative:
 *   - /api/* is NEVER cached — orders, inventory, and billing stay live.
 *   - Navigations: network-first; if offline, fall back to the cached copy
 *     of that page (so the dashboard shell opens in a dead spot).
 *   - Static assets (css/js/icons): network-first with cache fallback —
 *     assets aren't content-hashed, so fresh-first avoids running stale JS
 *     against a newer server after a deploy.
 * Bump VERSION when the shell changes shape; old caches are dropped.
 */
const VERSION = 'addy-v1';
const SHELL = [
  '/login.html',
  '/dashboard-dsd.html',
  '/dashboard-admin.html',
  '/shop.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/pwa.js',
  '/js/shop.js',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll is all-or-nothing; cache what we can, one at a time.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // business data stays live

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/login.html')))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── PUSH NOTIFICATIONS (original behavior) ──────────────────────────────────
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'ADDY DSD Portal';
  const options = {
    body: data.body || 'You have a new notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
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
