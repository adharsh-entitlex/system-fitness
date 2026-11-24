'use strict';

/* App-shell cache so the tracker opens with no network.
   Navigations go to the network first (so a new release shows up) and fall
   back to the cached shell; static files are cache-first. API calls are
   never cached — sync must fail loudly rather than serve stale records.

   The one exception is a write that failed while offline: the page hands the
   newest snapshot to the worker, it is stored in IndexedDB and replayed when
   the connection (or Background Sync) returns. Nothing is served from it, it
   is only ever sent up. */

const CACHE = 'system-v8';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './merge.js',
  './foods.js',
  './nutrition.js',
  './training.js',
  './coach.js',
  './sync.js',
  './auth.js',
  './ai.js',
  './push.js',
  './install.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => replayOutbox())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Network first, cache as the offline fallback. Cache-first here would keep
  // serving an old app.js/auth.js after a release, which breaks sign-in and
  // sync fixes until the cache name changes again.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

/* ---------------- offline outbox ----------------
   PUT /api/state is a whole-record snapshot, so only the newest queued copy
   matters: storing one record also stops a long offline stretch from
   replaying dozens of superseded writes on reconnect. */

const OUTBOX_DB = 'system-outbox';
const OUTBOX_STORE = 'queue';
const OUTBOX_KEY = 'latest';

function outboxDb() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = self.indexedDB.open(OUTBOX_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

async function outboxPut(body) {
  const db = await outboxDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).put({ body, at: Date.now() }, OUTBOX_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function outboxGet() {
  const db = await outboxDb();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, 'readonly');
    const req = tx.objectStore(OUTBOX_STORE).get(OUTBOX_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

async function outboxClear() {
  const db = await outboxDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).delete(OUTBOX_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function tellClients(type, detail) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach((client) => client.postMessage({ type, ...(detail || {}) }));
}

/* Replays the queued snapshot. A 409 is not retried: the server holds a newer
   copy, and the page merges the two on its next load, which loses nothing. */
async function replayOutbox() {
  let queued;
  try {
    queued = await outboxGet();
  } catch (err) {
    return false;
  }
  if (!queued || !queued.body) return false;
  try {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: queued.body,
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (res.ok || res.status === 409) {
      await outboxClear();
      tellClients('outbox-flushed', { status: res.status });
      return true;
    }
    // 401: signed out; 5xx: try again later. Keep the snapshot either way.
    return false;
  } catch (err) {
    return false;
  }
}

self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (data.type === 'outbox-put' && data.body) {
    e.waitUntil(outboxPut(data.body).catch(() => {}));
  } else if (data.type === 'outbox-clear') {
    e.waitUntil(outboxClear().catch(() => {}));
  } else if (data.type === 'outbox-flush') {
    e.waitUntil(replayOutbox());
  }
});

self.addEventListener('sync', (e) => {
  if (e.tag === 'system-outbox') e.waitUntil(replayOutbox());
});

/* ---------------- device notifications ---------------- */

self.addEventListener('push', (e) => {
  let payload = { title: 'THE SYSTEM', body: 'You have a new directive.', url: '/' };
  try {
    if (e.data) payload = { ...payload, ...e.data.json() };
  } catch {
    if (e.data) payload.body = e.data.text();
  }
  e.waitUntil(
    self.registration.showNotification(payload.title || 'THE SYSTEM', {
      body: payload.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: payload.tag || 'system',
      renotify: true,
      data: { url: payload.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
