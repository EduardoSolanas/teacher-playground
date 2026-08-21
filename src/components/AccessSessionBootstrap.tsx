'use client';

import { useEffect, useState } from 'react';
import { ajaxFetch, SESSION_EXPIRED_EVENT } from '@/lib/http/ajaxFetch';
import { accessLogoutUrl } from '@/lib/access/accessLogoutUrl';
import { isGuestHostname } from '@/lib/guest/guestHost';

const ATTEMPT_TIMEOUT_MS = 15_000;
const ISSUE_ATTEMPTS = 3;

export function AccessSessionBootstrap({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    if (isGuestHostname(window.location.hostname)) {
      setState('ready');
      return;
    }

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const expire = () => {
      if (!cancelled) setState('unavailable');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);

    const abortAfter = (ms: number): AbortSignal => {
      const controller = new AbortController();
      timers.push(setTimeout(() => controller.abort(), ms));
      return controller.signal;
    };

    const headers = { Accept: 'application/json' };
    void (async () => {
      try {
        const current = await ajaxFetch('/auth/session/current', {
          headers,
          signal: abortAfter(ATTEMPT_TIMEOUT_MS),
        });
        if (current.ok) {
          if (!cancelled) setState('ready');
          return;
        }
        if (current.status !== 401) throw new Error('session check failed');
        let issued: Response | null = null;
        for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt += 1) {
          try {
            const response = await ajaxFetch('/auth/session', {
              method: 'POST',
              headers,
              signal: abortAfter(ATTEMPT_TIMEOUT_MS),
            });
            if (response.ok) {
              issued = response;
              break;
            }
          } catch {
            if (attempt === ISSUE_ATTEMPTS - 1) throw new Error('session bootstrap failed');
          }
        }
        if (!issued?.ok) throw new Error('session bootstrap failed');
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
    };
  }, []);

  if (state === 'loading') {
    return (
      <div role="status" aria-live="polite" className="session-screen">
        Loading secure sessionâ€¦
      </div>
    );
  }
  if (state === 'unavailable') {
    return (
      <div role="alert" className="session-screen">
        <div className="session-card">
          <p className="session-title">Session unavailable</p>
          <p className="session-text">
            This secure session is unavailable. Sign in again to continue.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="btn btn-block"
          >
            Retry
          </button>
          <a
            href={accessLogoutUrl('/')}
            className="link-aside"
          >
            Sign out and try again
          </a>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}