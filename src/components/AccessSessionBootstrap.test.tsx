import { describe, expect, it, vi, beforeEach } from 'vitest';
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

describe('AccessSessionBootstrap', () => {
  beforeEach(() => {
    ajaxFetch.mockReset();
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
});
