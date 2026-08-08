/* sw.js — COOP/COEP header injection for static hosts that cannot set
   response headers (e.g. GitHub Pages). Enables crossOriginIsolated so
   SharedArrayBuffer / multi-threaded WASM works.
   Deliberately does NOT cache anything (no cache-poisoning surface). */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Chrome quirk: don't touch only-if-cached requests from other scopes.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith((async () => {
    const res = await fetch(req);
    // Opaque responses can't be reconstructed — pass through untouched.
    if (res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;

    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  })());
});

