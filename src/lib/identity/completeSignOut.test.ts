import { describe, expect, it, vi } from 'vitest';

import { completeSignOut } from './completeSignOut';

import { accessLogoutUrl } from '@/lib/access/accessLogoutUrl';

describe('completeSignOut', () => {
  it('clears the app session then sends the user through same-origin Access logout', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();

    await completeSignOut({ logout, navigate });

    expect(logout).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(accessLogoutUrl('/'));
    expect(String(navigate.mock.calls[0][0])).not.toContain('cloudflareaccess.com');
  });

  it('still goes to Access logout if app logout fails', async () => {
    const navigate = vi.fn();
    await completeSignOut({
      logout: vi.fn().mockRejectedValue(new Error('network')),
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith(accessLogoutUrl('/'));
  });
});
