const cacheName = 'nine-page-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/model/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    if (url.pathname.includes('/ort-')) {
      const hit = await cache.match(event.request);
      if (hit) return hit;
    }
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      throw error;
    }
  })());
});
