/*
 * Teacher Playground service worker — the offline shell (OFF-01).
 *
 * Scope is deliberately narrow because service-worker staleness is the known
 * hazard of this feature: a worker that serves yesterday's HTML or board data
 * is worse than no worker. The rules, enforced by
 * src/components/serviceWorkerContract.test.ts:
 *
 *   1. Cache ONE thing: /_next/static/ responses. Those URLs are
 *      content-hashed by the build, so an entry can never go stale — a new
 *      build ships new URLs and the old entries are simply orphaned until a
 *      cache-version bump cleans them out on activation.
 *   2. Navigations are network-first, always. The worker never stores an HTML
 *      response. Only when the network itself fails does the user get the
 *      self-contained offline fallback page below — never a cached copy of a
 *      room, session page or marketing page. A 4xx/5xx answer from the server
 *      is a real answer and passes through untouched.
 *   3. Everything else — the API routes, the signaling endpoint, documents,
 *      board data, the Excalidraw CDN assets — is not intercepted at all.
 *      Board writes stay online-only by design; the room UI's existing
 *      sync-degraded banner is the one that covers a degraded connection.
 *
 * Versioning discipline: bump STATIC_CACHE / OFFLINE_CACHE to -v2 (etc.) when
 * the fallback page or the caching rules change. Activation deletes every
 * cache it does not recognise, so an old version cannot outlive its code.
 */

const STATIC_CACHE = 'static-v1';
const OFFLINE_CACHE = 'offline-v1';
const CURRENT_CACHES = [STATIC_CACHE, OFFLINE_CACHE];

/*
 * Synthetic URL: the fallback page exists only inside the offline cache,
 * built here at install time. Choosing an inline page over a real route
 * keeps the fallback reachable with the network fully gone — a route would
 * have to be fetched once online first, and this way the install step needs
 * no network at all. Colours are the brand.css tokens by hand (an offline
 * page cannot load stylesheets).
 */
const OFFLINE_URL = '/offline-fallback';

const OFFLINE_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Teacher Playground — offline</title>',
  '<style>',
  'body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;',
  'background:#faf7f0;color:#26241f;font-family:Georgia,\'Iowan Old Style\',\'Times New Roman\',serif;}',
  '.card{max-width:26rem;padding:2rem;text-align:center;}',
  'h1{font-weight:400;font-size:1.6rem;margin:0 0 .75rem;}',
  'h1 span{border-bottom:3px solid #c0392b;}',
  'p{font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;',
  'font-size:.95rem;line-height:1.6;color:#4b4740;margin:0 0 1rem;}',
  'a{color:#2a5db0;}',
  '</style>',
  '</head>',
  '<body>',
  '<main class="card">',
  '<h1><span>You are offline</span></h1>',
  '<p>The connection to Teacher Playground dropped, so this page cannot be',
  'loaded right now. Anything already on your boards is saved on the server',
  'and will be waiting when the connection returns.</p>',
  '<p>Reconnect, then reload this page.</p>',
  '</main>',
  '</body>',
  '</html>',
].join('\n');

// Path prefix of content-hashed, immutable build assets — the one thing this
// worker is allowed to cache.
const STATIC_PREFIX = '/_next/static/';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.put(OFFLINE_URL, new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Take over immediately rather than waiting for the next reload, but only
    // from the activation step — never mid-install.
    self.skipWaiting();
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => !CURRENT_CACHES.includes(name))
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

/*
 * Network-only by omission: anything that is not a GET, not same-origin,
 * not a navigation and not under /_next/static/ falls through without
 * touching the cache, so API calls, the signaling websocket handshake and
 * board data can never be answered from storage.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (url.pathname.startsWith(STATIC_PREFIX)) {
    event.respondWith(serveStaticAsset(request));
  }
});

async function handleNavigation(request) {
  try {
    return await fetch(request);
  } catch (error) {
    // Network failure only. A response from the server — even an error
    // status — is authoritative and must reach the page unchanged.
    const cache = await caches.open(OFFLINE_CACHE);
    const fallback = await cache.match(OFFLINE_URL);
    if (!fallback) throw error;
    return fallback;
  }
}

async function serveStaticAsset(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}
