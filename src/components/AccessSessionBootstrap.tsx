'use client';

import { useEffect, useState } from 'react';
import { ajaxFetch, SESSION_EXPIRED_EVENT } from '@/lib/http/ajaxFetch';

const BOOTSTRAP_TIMEOUT_MS = 10_000;

export function AccessSessionBootstrap({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const expire = () => {
      if (!cancelled) setState('unavailable');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);

    const timer = setTimeout(() => {
      controller.abort();
    }, BOOTSTRAP_TIMEOUT_MS);

    const headers = { Accept: 'application/json' };
    void (async () => {
      try {
        const current = await ajaxFetch('/auth/session/current', {
          headers,
          signal: controller.signal,
        });
        if (current.ok) {
          if (!cancelled) setState('ready');
          return;
        }
        if (current.status !== 401) throw new Error('session check failed');
        const issued = await ajaxFetch('/auth/session', {
          method: 'POST',
          headers,
          signal: controller.signal,
        });
        if (!issued.ok) throw new Error('session bootstrap failed');
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
    };
  }, []);

  if (state === 'loading') {
    return (
      <div role="status" aria-live="polite" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#666',
        fontSize: 16,
      }}>
        Loading secure session…
      </div>
    );
  }
  if (state === 'unavailable') {
    return (
      <div role="alert" style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        minHeight: '100vh',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#333',
        fontSize: 16,
        padding: 24,
        textAlign: 'center',
      }}>
        <p style={{ margin: 0 }}>This secure session is unavailable. Sign in again to continue.</p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '10px 24px',
            border: 'none',
            borderRadius: 8,
            background: '#667eea',
            color: '#fff',
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
        <a
          href="/"
          style={{ color: '#1e4d3a', fontSize: 14 }}
        >
          Sign out and try again
        </a>
      </div>
    );
  }
  return <>{children}</>;
}
