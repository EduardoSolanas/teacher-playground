'use client';

import { useEffect, useState } from 'react';
import { ajaxFetch, SESSION_EXPIRED_EVENT } from '@/lib/http/ajaxFetch';

/**
 * Cloudflare Access adds the assertion to the same-origin request at the edge.
 * This one-shot exchange creates the local opaque session used by API and
 * signaling routes. We intentionally do not retry on 401: local logout or
 * revocation must remain effective until the user performs a fresh login.
 */
export function AccessSessionBootstrap({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let cancelled = false;
    const expire = () => {
      if (!cancelled) setState('unavailable');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    const headers = { Accept: 'application/json' };
    void (async () => {
      try {
        const current = await ajaxFetch('/auth/session/current', {
          headers,
        });
        if (current.ok) {
          if (!cancelled) setState('ready');
          return;
        }
        if (current.status !== 401) throw new Error('session check failed');
        const issued = await ajaxFetch('/auth/session', {
          method: 'POST',
          headers,
        });
        if (!issued.ok) throw new Error('session bootstrap failed');
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
    };
  }, []);

  if (state === 'loading') {
    return <div role="status" aria-live="polite">Loading secure session…</div>;
  }
  if (state === 'unavailable') {
    return <div role="alert">This secure session is unavailable. Sign in again to continue.</div>;
  }
  return <>{children}</>;
}
