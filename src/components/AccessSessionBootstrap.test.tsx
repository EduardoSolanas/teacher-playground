import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const ajaxFetch = vi.fn();

vi.mock('@/lib/http/ajaxFetch', () => ({
  ajaxFetch: (...args: unknown[]) => ajaxFetch(...args),
  SESSION_EXPIRED_EVENT: 'teacher-session-expired',
}));

import { AccessSessionBootstrap } from './AccessSessionBootstrap';

function jsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as Response;
}

function stubGuestHost() {
  vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.localhost');
  vi.stubGlobal('location', {
    hostname: 'join.localhost',
    href: 'http://join.localhost/',
    origin: 'http://join.localhost',
    reload: vi.fn(),
  });
}

describe('AccessSessionBootstrap', () => {
  beforeEach(() => {
    ajaxFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('retries session issue after a failed first POST', async () => {
    ajaxFetch
      .mockResolvedValueOnce(jsonResponse(401))
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
      .mockResolvedValueOnce(jsonResponse(200));

    render(<AccessSessionBootstrap>ready</AccessSessionBootstrap>);

    await waitFor(() => {
      expect(screen.getByText('ready')).toBeTruthy();
    });
    expect(ajaxFetch).toHaveBeenCalledTimes(3);
    expect(ajaxFetch.mock.calls[1][0]).toBe('/auth/session');
    expect(ajaxFetch.mock.calls[2][0]).toBe('/auth/session');
  });

  it('renders children on the guest hostname without calling teacher session routes', async () => {
    stubGuestHost();

    render(<AccessSessionBootstrap>ready</AccessSessionBootstrap>);

    await waitFor(() => {
      expect(screen.getByText('ready')).toBeTruthy();
    });
    expect(ajaxFetch).not.toHaveBeenCalled();
  });

  it('does not show unavailable after a session-expired event on the guest hostname', async () => {
    stubGuestHost();

    render(<AccessSessionBootstrap>ready</AccessSessionBootstrap>);

    await waitFor(() => {
      expect(screen.getByText('ready')).toBeTruthy();
    });
    window.dispatchEvent(new Event('teacher-session-expired'));
    expect(screen.getByText('ready')).toBeTruthy();
    expect(screen.queryByText(/secure session is unavailable/i)).toBeNull();
  });
});
