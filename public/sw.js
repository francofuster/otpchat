const CACHE = 'otpchat-static-v2';
const ASSETS = ['/', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Mensajes nuevos', {
      tag: 'otpchat-messages',
      renotify: false,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.includes(self.location.origin));
      return existing ? existing.focus() : self.clients.openWindow('/');
    })
  );
});
