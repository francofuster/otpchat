const CACHE = 'otpchat-static-v3';
const ASSETS = ['/', '/manifest.webmanifest', '/icons/icon.svg'];
const PUSH_DB = 'otpchat-push';
const PUSH_STORE = 'state';
const PUSH_THREADS_KEY = 'threads';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PUSH_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PUSH_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readPendingThreads() {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(PUSH_STORE, 'readonly');
    const request = tx.objectStore(PUSH_STORE).get(PUSH_THREADS_KEY);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => resolve([]);
    tx.oncomplete = () => db.close();
  });
}

async function writePendingThreads(threads) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(PUSH_STORE, 'readwrite');
    tx.objectStore(PUSH_STORE).put(threads, PUSH_THREADS_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

async function addPendingThread(payload) {
  if (!payload?.scope || !payload?.targetId) return;
  const key = `${payload.scope}:${payload.targetId}`;
  const threads = await readPendingThreads();
  if (!threads.includes(key)) await writePendingThreads([...threads, key]);
}

function pushPayload(event) {
  try {
    return event.data?.json() || {};
  } catch {
    return {};
  }
}

async function consumePendingThreads() {
  const threads = await readPendingThreads();
  await writePendingThreads([]);
  return threads;
}

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
  const payload = pushPayload(event);
  event.waitUntil(
    addPendingThread(payload).then(() =>
      self.registration.showNotification('Mensajes nuevos', {
        tag: 'otpchat-messages',
        renotify: false,
        icon: '/icons/icon.svg',
        badge: '/icons/icon.svg'
      })
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    consumePendingThreads().then((threads) => {
      const targetPath = threads.length === 1 ? `/#/?pushOpen=${encodeURIComponent(threads[0])}` : '/#/?pushList=1';
      const target = new URL(targetPath, self.location.origin).href;
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        const existing = clients.find((client) => client.url.includes(self.location.origin));
        if (existing) return existing.navigate(target).then((client) => (client || existing).focus());
        return self.clients.openWindow(target);
      });
    })
  );
});
