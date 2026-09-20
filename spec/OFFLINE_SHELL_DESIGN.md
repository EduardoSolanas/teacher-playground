# OFF-01 — the offline shell: design note

Status: shipped in the conservative scope pinned by the orchestrator (2026-09-19).
Row: `PROJECT_IMPROVEMENT_TASKS.md` OFF-01.

## What shipped

A service worker (`public/sw.js`, hand-written plain JS, no build step) plus a
web-app manifest (`public/manifest.webmanifest`), registered from the root
layout (`src/app/layout.tsx`) through `src/components/ServiceWorkerRegistration.tsx`.

Deliberately **not** built (pinned out of scope): last-snapshot read caching,
the install prompt UI, offline writes/queueing, and any cache for HTML, API,
signaling, documents or board data. Board writes stay online-only by design;
the existing sync-degraded banner remains the one degraded-sync signal.

## The fallback page: inline, not a route

`install` precaches exactly one thing: a self-contained offline page built as
an inline string inside `sw.js` and stored in the cache under the synthetic
URL `/offline-fallback`. Chosen over a real `/offline` route because:

- the static export has no such route, and adding one would be a new build
  surface for a page that must render with the network fully gone;
- an inline page gives the install step zero network dependency, so the
  offline fallback exists from the very first visit once the worker installs;
- its colours are the brand.css tokens by hand (an offline page cannot load a
  stylesheet).

## The sw.js contract (pinned by `src/components/serviceWorkerContract.test.ts`)

1. Cache-first applies **only** to `/_next/static/` (content-hashed,
   immutable) into cache `static-v1`, populated lazily on first use; only
   `response.ok` responses are stored.
2. Navigations are network-first, always; an HTML response is never stored.
   Only a network *failure* (fetch rejects) serves the inline fallback page.
   A 4xx/5xx from the server is a real answer and passes through untouched.
3. Everything else is not intercepted at all: API, `/signaling`, documents,
   board data, cross-origin CDN assets → network-only, never cached, never
   fallback. The file deliberately contains no literal for those paths.
4. Versioned caches (`static-v1`, `offline-v1`); activate calls the
   take-over calls there and only there (never on install), claims clients,
   and deletes every cache it does not recognise.
5. Only GET, only same-origin. Non-GET (board writes) is never touched.

## Staleness hazards and why HTML/API are never cached

Service-worker staleness is the known foot-gun of this feature: a worker that
serves yesterday's HTML would show a teacher a stale room shell with stale
session state while they believe they are looking at the live board. The
mitigations, in order of importance:

- **HTML is never cached.** A navigation is answered by the network or, on
  network failure, by a page that *says* it is a failure. There is no third
  state in which the user reads an old room as if it were current.
- **The Worker already serves every HTML response with `Cache-Control:
  no-store`** (`withSecurityHeaders`), and serves `/sw.js` the same way, so
  the browser's update check for the worker script always reaches the
  network — a new deploy takes over at the next navigation, not days later.
- **Only immutable assets enter a cache**, so "stale cache entry" is
  structurally impossible for `static-v1`; hashed URLs change with content.
- **Version discipline**: bump `static-v1`/`offline-v1` to `-v2` whenever the
  fallback page or the rules change; activation deletes unrecognised caches,
  so an old version cannot outlive its code.
- **Emergency kill switch** (procedure, no code shipped): deploy a `sw.js`
  whose activate step unregisters itself and deletes both caches; the next
  page load sheds the worker everywhere.

## Enabling changes outside public/ (additive guards, mutation-tested)

- `isRouteAllowedOnHost` (`src/lib/worker/requestGuard.ts`): GET/HEAD
  `/sw.js` and `/manifest.webmanifest` on the teacher and guest hosts. Without
  this the Worker's fail-closed route list 404s both files on every host.
  The marketing host is deliberately not listed — its self-contained pages
  never register a worker.
- `withSecurityHeaders` CSP gains `worker-src 'self'`: a service worker script
  fetch is governed by worker-src (fallback child-src → script-src →
  default-src), and the app's script-src is `'nonce-…' 'strict-dynamic'`,
  which ignores `'self'` — so without the explicit directive the nonce-less
  `/sw.js` fetch is refused as a policy violation. `'self'` is the narrowest
  possible value; service worker scripts must be same-origin by spec anyway.
  The `<link rel="manifest">` needs no policy change (`manifest-src` falls
  back to `default-src 'self'`).

Targeted mutants killed (test → red → revert): the route-allowlist branch
(killed by the "offline-shell assets on both app hosts" test), the
`worker-src 'self'` directive (killed by the "admits same-origin worker
scripts" test), and the production-only registration flag (killed by the
`shouldRegisterServiceWorker` decision tests).

## Known limitations

- **Installability**: `public/logo.svg` is a 360×56 wordmark, not a square or
  maskable icon, so browsers may not offer the install prompt despite the
  manifest. A dedicated 512px+ icon is a follow-up (new asset, new scope).
- **Registration is production-only** (`NODE_ENV === 'production'`), so
  `next dev` never registers; a local `wrangler dev` on a production build
  does.
- **Visual gate**: the offline fallback page is reachable only by taking a
  browser offline; it has no Playwright-driven capture in this slice, so the
  AGENTS.md style gate for it rests with the orchestrator as a
  devtools-free check (recorded here per the task instructions).
- Full unit/workers/e2e suites are orchestrator-owned; this slice ran scoped
  vitest suites, both tsconfigs, and `run-e2e.mjs security-headers` (see the
  task row for the evidence).
