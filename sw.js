/* sw.js — COOP/COEP header injection for static hosts that cannot set
   response headers (e.g. GitHub Pages). Enables crossOriginIsolated so
   SharedArrayBuffer / multi-threaded WASM works.
   Deliberately does NOT cache anything (no cache-poisoning surface). */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only our own files need the headers. Cross-origin requests (CDN libraries,
  // PeerJS) are CORS requests that already satisfy COEP, so leave them to the
  // browser: a CDN outage then shows up as a normal network error instead of a
  // rejected FetchEvent ("Failed to fetch") thrown from this worker.
  if (new URL(req.url).origin !== self.location.origin) return;
  // Chrome quirk: don't touch only-if-cached requests from other scopes.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith((async () => {
    let res;
    try { res = await fetch(req); }
    catch { return Response.error(); }             // offline: same result as no SW

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

