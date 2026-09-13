import { afterEach, describe, expect, it, vi } from 'vitest';

import { ajaxFetch, SESSION_EXPIRED_EVENT } from './ajaxFetch';

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function trackFetch(status: number, body: unknown = null) {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

describe('ajaxFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a cross-origin target without calling fetch', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, { status: 200 });
    });

    await expect(ajaxFetch('https://evil.example/api/company')).rejects.toThrow(
      'Cross-origin AJAX request rejected',
    );
    expect(calls).toEqual([]);
  });

  it('uses a string target and adds the AJAX header when no headers are given', async () => {
    const calls = trackFetch(204);

    const response = await ajaxFetch('/api/company');

    expect(response.status).toBe(204);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
    expect(calls[0].init?.credentials).toBe('same-origin');
  });

  it('keeps Request headers, merges init headers, and cannot be told to drop the AJAX header', async () => {
    const calls = trackFetch(200, { ok: true });

    const request = new Request('http://localhost:3000/api/company', {
      headers: { 'X-Custom': 'from-request' },
    });
    await ajaxFetch(request, {
      method: 'POST',
      headers: { 'X-Custom': 'from-init', 'X-Requested-With': 'forged' },
    });

    const headers = new Headers(calls[0].init?.headers);
    expect(calls[0].input).toBe(request);
    expect(calls[0].init?.method).toBe('POST');
    expect(headers.get('x-custom')).toBe('from-init');
    expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('dispatches the session-expired event for a 401 on an API route', async () => {
    trackFetch(401, { error: 'expired' });
    const heard: Event[] = [];
    const listener = (event: Event) => heard.push(event);
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    try {
      const response = await ajaxFetch('/api/company');
      expect(response.status).toBe(401);
      expect(heard).toHaveLength(1);
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    }
  });

  it('does not dispatch the event for a 401 outside the API routes', async () => {
    trackFetch(401, { error: 'expired' });
    const heard: Event[] = [];
    const listener = (event: Event) => heard.push(event);
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    try {
      const response = await ajaxFetch('/auth/session/current');
      expect(response.status).toBe(401);
      expect(heard).toEqual([]);
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    }
  });

  it('does not dispatch the event for non-401 responses', async () => {
    trackFetch(200, { ok: true });
    const heard: Event[] = [];
    const listener = (event: Event) => heard.push(event);
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    try {
      await ajaxFetch('/api/company');
      expect(heard).toEqual([]);
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    }
  });
});
