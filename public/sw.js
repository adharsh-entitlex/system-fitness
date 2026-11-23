'use strict';

/* App-shell cache so the tracker opens with no network.
   Navigations go to the network first (so a new release shows up) and fall
   back to the cached shell; static files are cache-first. API calls are
   never cached — sync must fail loudly rather than serve stale records. */

const CACHE = 'system-v6';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './foods.js',
  './nutrition.js',
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
