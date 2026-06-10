// Bump CACHE_NAME to invalidate all cached assets after an app update.
const CACHE_NAME = 'cal-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Let the server handle API calls, OAuth flows, and the login page.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname === '/login'
  ) return;

  // Only intercept same-origin assets and the FullCalendar CDN bundle.
  const isSameOrigin = url.origin === self.location.origin;
  const isCDN = url.hostname === 'cdn.jsdelivr.net';
  if (!isSameOrigin && !isCDN) return;

  // Cache-first: serve cached asset immediately, update cache in background.
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(request).then(cached => {
        const networkFetch = fetch(request).then(res => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        }).catch(() => null);
        return cached || networkFetch;
      })
    )
  );
});
