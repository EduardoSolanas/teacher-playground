import { describe, expect, it, vi } from 'vitest';

import { completeSignOut } from './completeSignOut';

describe('completeSignOut', () => {
  it('clears the app session then sends the user to the marketing landing, not Access team logout', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();

    await completeSignOut({ logout, navigate });

    expect(logout).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/');
    expect(String(navigate.mock.calls[0][0])).not.toContain('cloudflareaccess.com');
  });

  it('still goes to the landing if app logout fails', async () => {
    const navigate = vi.fn();
    await completeSignOut({
      logout: vi.fn().mockRejectedValue(new Error('network')),
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
