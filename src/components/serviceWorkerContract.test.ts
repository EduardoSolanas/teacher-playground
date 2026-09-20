import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/*
 * Source-level contract for public/sw.js — the security-sensitive surface of
 * the offline shell (OFF-01). The service worker is hand-written plain JS with
 * no build step, so nothing typechecks it and no bundler reviews it. The one
 * staleness bug this file must never grow is caching HTML or API responses:
 * a teacher who reloads a room would then see yesterday's board shell and
 * stale session state while believing they are looking at the live room.
 *
 * The contract pinned here:
 *   - cache-first applies ONLY to `/_next/static/` (content-hashed, immutable);
 *   - navigations are network-first and never cached; a network failure gets
 *     the self-contained offline fallback page and nothing else;
 *   - every other request (API, signaling, documents, board data) is not
 *     intercepted at all — network-only, never cached, never fallback;
 *   - install precaches nothing but the inline fallback page;
 *   - caches are versioned, activate claims clients, cleans old caches and
 *     calls skipWaiting (there, not on install, so a waiting worker never
 *     activates mid-session while a lesson is running).
 *
 * Reading the file as text and asserting on its structure is the real test
 * available in the unit layer: the fetch handler only runs inside a browser.
 */

const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', '..', 'public');

// Module-level read on purpose: when public/sw.js is missing the whole file
// fails with the ENOENT naming the exact missing artifact.
const swSource = readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');

const installStart = swSource.indexOf("self.addEventListener('install'");
const activateStart = swSource.indexOf("self.addEventListener('activate'");
const fetchStart = swSource.indexOf("self.addEventListener('fetch'");
const installSlice = swSource.slice(installStart, activateStart);
const activateSlice = swSource.slice(activateStart, fetchStart);
const fetchSlice = swSource.slice(fetchStart);

describe('public/sw.js contract (OFF-01 offline shell)', () => {
  it('exists and defines the two versioned caches', () => {
    expect(installStart).toBeGreaterThanOrEqual(0);
    expect(activateStart).toBeGreaterThan(installStart);
    expect(fetchStart).toBeGreaterThan(activateStart);
    expect(swSource).toContain("const STATIC_CACHE = 'static-v1';");
    expect(swSource).toContain("const OFFLINE_CACHE = 'offline-v1';");
  });

  it('never intercepts, fetches or caches API, signaling or board routes', () => {
    // The contract for these paths is that the worker does not even mention
    // them: anything outside /_next/static/ and navigations falls through to
    // the browser default, which is network-only. A literal here would mean a
    // special case, and a special case is where staleness bugs are born.
    expect(swSource).not.toContain("'/api");
    expect(swSource).not.toContain("'/signaling");
    expect(swSource).not.toContain("'/whiteboard");
    expect(swSource).not.toContain("'wss:");
  });

  it('fetches nothing but the requests it is given (no precache list, no telemetry)', () => {
    // No fetch call may carry a hardcoded URL: install precaches via
    // cache.put of the inline fallback, and every other fetch passes the
    // original request through. A hardcoded URL here would be precache or
    // background traffic the pinned scope forbids.
    expect(swSource).not.toMatch(/fetch\(\s*['"]/);
    expect(swSource).not.toContain('importScripts');
    expect(swSource).not.toContain('eval(');
    expect(swSource).not.toContain('new Function');
  });

  it('listens only for install, activate and fetch', () => {
    const listeners = swSource.match(/addEventListener\('([a-z]+)'/g) ?? [];
    expect(listeners).toEqual([
      "addEventListener('install'",
      "addEventListener('activate'",
      "addEventListener('fetch'",
    ]);
  });

  it('install precaches nothing but the inline offline fallback page', () => {
    const puts = installSlice.match(/cache\.put\(/g) ?? [];
    expect(puts.length).toBe(1);
    expect(installSlice).toContain('cache.put(OFFLINE_URL');
    expect(installSlice).toContain('text/html');
    expect(installSlice).not.toContain('cache.add(');
    // Static assets are lazily populated on first use, never precached.
    expect(installSlice).not.toContain('STATIC_CACHE');
    expect(installSlice).not.toContain('STATIC_PREFIX');
  });

  it('activate runs skipWaiting there (never on install), claims clients and cleans old caches', () => {
    // Exactly one skipWaiting in the whole file, inside activate: a pending
    // worker must not replace a live one in the middle of a lesson.
    expect((swSource.match(/skipWaiting/g) ?? []).length).toBe(1);
    expect(activateSlice).toContain('skipWaiting');
    expect(activateSlice).toContain('clients.claim');
    expect(activateSlice).toContain('caches.keys()');
    expect(activateSlice).toContain('caches.delete(');
    expect(installSlice).not.toContain('skipWaiting');
  });

  it('handles only GET same-origin navigations and /_next/static/ assets', () => {
    const responses = fetchSlice.match(/respondWith/g) ?? [];
    expect(responses.length).toBe(2);
    expect(fetchSlice).toContain("request.method !== 'GET'");
    expect(fetchSlice).toContain('url.origin !== self.location.origin');
    expect(fetchSlice).toContain("request.mode === 'navigate'");
    expect(fetchSlice).toContain('startsWith(STATIC_PREFIX)');
  });

  it('navigations are network-first and fall back only on network failure', () => {
    expect(fetchSlice).toContain('async function handleNavigation');
    expect(fetchSlice.indexOf('await fetch(request)')).toBeGreaterThan(-1);
    expect(fetchSlice).toContain('catch');
    // The fallback comes from the offline cache, never from a cached HTML
    // response of the app itself.
    expect(fetchSlice).toContain('cache.match(OFFLINE_URL)');
  });

  it('caches exactly one thing lazily: ok /_next/static/ responses', () => {
    const puts = fetchSlice.match(/cache\.put\(/g) ?? [];
    expect(puts.length).toBe(1);
    expect(fetchSlice).toContain('if (response.ok)');
    // The single cache.put must sit behind the ok guard, never before it:
    // error and redirect responses must not enter the immutable-asset cache.
    expect(fetchSlice.indexOf('cache.put(')).toBeGreaterThan(
      fetchSlice.indexOf('if (response.ok)'),
    );
  });
});

describe('public/manifest.webmanifest contract (OFF-01)', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'),
  ) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    theme_color?: string;
    background_color?: string;
    icons?: Array<{ src?: string; type?: string; sizes?: string }>;
  };

  const brandCss = readFileSync(path.join(PUBLIC_DIR, 'brand.css'), 'utf8');

  it('names the app and installs as a standalone display', () => {
    expect(manifest.name).toBe('Teacher Playground');
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('reuses an icon that actually ships in public/', () => {
    expect(manifest.icons?.length).toBeGreaterThan(0);
    for (const icon of manifest.icons ?? []) {
      expect(icon.src).toMatch(/^\//);
      const iconPath = path.join(PUBLIC_DIR, icon.src ?? '');
      expect(() => readFileSync(iconPath)).not.toThrow();
      expect(icon.type).toBe('image/svg+xml');
      expect(icon.sizes).toBe('any');
    }
  });

  it('derives theme and background colours from brand.css tokens', () => {
    // The manifest cannot read custom properties, so the hexes are kept in
    // sync with public/brand.css by hand — this assertion fails when one
    // side changes without the other.
    for (const colour of [manifest.theme_color, manifest.background_color]) {
      expect(colour).toBeTruthy();
      expect(brandCss).toContain(colour ?? '');
    }
  });
});
