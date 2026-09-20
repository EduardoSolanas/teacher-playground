'use client';

import { useEffect } from 'react';

/*
 * The offline shell's registration point (OFF-01): rendered from the root
 * layout so every app page — rooms list and room, teacher and guest host —
 * offers the same offline behaviour.
 *
 * Production only. A worker cached during development would serve stale dev
 * assets across restarts, which is precisely the staleness foot-gun this
 * feature is pinned to avoid; the static export the Worker serves is always
 * a production build, so real users always qualify.
 *
 * Every failure is swallowed by contract: a refused or failed registration
 * must never surface to a teacher mid-lesson. Worst case the user has no
 * offline fallback, which is the pre-OFF-01 status quo.
 */

/** Production-only decision, lifted out so the unit suite can pin it. */
export function shouldRegisterServiceWorker(env: { NODE_ENV?: string }): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Registers /sw.js, answering false instead of throwing for every failure
 * mode: unsupported browsers (the property is absent), insecure contexts,
 * refused permissions and network errors. The boolean is for callers that
 * want to know; the component ignores it.
 */
export async function registerServiceWorker(): Promise<boolean> {
  try {
    if (
      typeof navigator === 'undefined'
      || typeof navigator.serviceWorker === 'undefined'
    ) {
      return false;
    }
    await navigator.serviceWorker.register('/sw.js');
    return true;
  } catch {
    return false;
  }
}

/** Renders nothing; the mount-time registration is the point. */
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    /*
     * Read NODE_ENV as a member expression, not by passing `process.env`
     * itself: the bundler replaces `process.env.NODE_ENV` with a literal at
     * build time, while a bare `process.env` survives to the browser as the
     * empty process shim — where the production check would silently never
     * pass and the worker would never register.
     */
    if (shouldRegisterServiceWorker({ NODE_ENV: process.env.NODE_ENV })) {
      void registerServiceWorker();
    }
  }, []);

  return null;
}
