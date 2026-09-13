import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import { SESSION_EXPIRED_EVENT } from '@/lib/http/ajaxFetch';
import { AccessSessionBootstrap } from './AccessSessionBootstrap';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderBootstrap() {
  return render(<AccessSessionBootstrap>ready</AccessSessionBootstrap>);
}

describe('AccessSessionBootstrap', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_GUEST_HOSTNAME;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_GUEST_HOSTNAME;
  });

  it('uses an existing session without issuing a new one', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, { status: 'active' });
    });

    renderBootstrap();

    await screen.findByText('ready');
    expect(calls).toEqual(['/auth/session/current']);
  });

  it('issues a session after a 401 and retries a refused attempt', async () => {
    const calls: string[] = [];
    let posts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === '/auth/session/current') return jsonResponse(401, { error: 'no session' });
      posts += 1;
      return posts === 1
        ? jsonResponse(500, { error: 'boom' })
        : jsonResponse(200, { status: 'issued' });
    });

    renderBootstrap();

    await screen.findByText('ready');
    expect(calls).toEqual(['/auth/session/current', '/auth/session', '/auth/session']);
  });

  it('reports unavailable when the session check fails outright', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(500, { error: 'boom' });
    });

    renderBootstrap();

    await screen.findByRole('alert');
    expect(screen.getByText(/secure session is unavailable/i)).toBeTruthy();
    expect(calls).toEqual(['/auth/session/current']);
  });

  it('reports unavailable when every issue attempt is refused', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) === '/auth/session/current') return jsonResponse(401);
      posts += 1;
      return jsonResponse(503, { error: 'later' });
    });

    renderBootstrap();

    await screen.findByRole('alert');
    expect(posts).toBe(3);
  });

  it('reports unavailable when every issue attempt throws', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) === '/auth/session/current') return jsonResponse(401);
      posts += 1;
      throw new Error('network down');
    });

    renderBootstrap();

    await screen.findByRole('alert');
    expect(posts).toBe(3);
  });

  it('switches to unavailable when the session-expired event fires', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(200, { status: 'active' }));

    renderBootstrap();

    await screen.findByText('ready');
    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });

    await screen.findByRole('alert');
    expect(screen.getByText(/secure session is unavailable/i)).toBeTruthy();
  });

  it('renders the loading copy with a real ellipsis character while the check is in flight', () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));

    renderBootstrap();

    expect(screen.getByRole('status').textContent).toBe('Loading secure session…');
  });

  it('does not update state after unmount when the session check resolves late', async () => {
    let resolveCurrent: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          resolveCurrent = resolve;
        }),
    );

    const view = renderBootstrap();
    expect(screen.getByRole('status')).toBeTruthy();

    view.unmount();
    await act(async () => {
      resolveCurrent(jsonResponse(200));
      await Promise.resolve();
    });

    expect(view.container.innerHTML).toBe('');
  });

  it('does not update state after unmount when the session check fails late', async () => {
    let rejectCurrent: (error: Error) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectCurrent = reject;
        }),
    );

    const view = renderBootstrap();
    view.unmount();
    await act(async () => {
      rejectCurrent(new Error('aborted'));
      await Promise.resolve();
    });

    expect(view.container.innerHTML).toBe('');
  });

  it('does not mark itself ready after unmount when the issue response lands late', async () => {
    let posts = 0;
    let resolveIssue: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      if (String(input) === '/auth/session/current') return Promise.resolve(jsonResponse(401));
      posts += 1;
      return new Promise<Response>((resolve) => {
        resolveIssue = resolve;
      });
    });

    const view = renderBootstrap();
    await waitFor(() => expect(posts).toBe(1));

    view.unmount();
    await act(async () => {
      resolveIssue(jsonResponse(200, { status: 'issued' }));
      await Promise.resolve();
    });

    expect(view.container.innerHTML).toBe('');
  });

  it('renders children on the guest hostname without calling teacher session routes', async () => {
    process.env.NEXT_PUBLIC_GUEST_HOSTNAME = 'localhost';
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200);
    });

    renderBootstrap();

    await screen.findByText('ready');
    expect(calls).toEqual([]);
  });

  it('ignores session-expired events on the guest hostname', async () => {
    process.env.NEXT_PUBLIC_GUEST_HOSTNAME = 'localhost';

    renderBootstrap();

    await screen.findByText('ready');
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    expect(screen.getByText('ready')).toBeTruthy();
    expect(screen.queryByText(/secure session is unavailable/i)).toBeNull();
  });
});
