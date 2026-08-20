import { afterEach, describe, expect, it, vi } from 'vitest';
import { isGuestHostname } from './guestHost';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isGuestHostname', () => {
  it('is true when the hostname matches NEXT_PUBLIC_GUEST_HOSTNAME', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.localhost');
    expect(isGuestHostname('join.localhost')).toBe(true);
  });

  it('compares hostnames case-insensitively', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.localhost');
    expect(isGuestHostname('JOIN.LOCALHOST')).toBe(true);
    expect(isGuestHostname('Join.Localhost')).toBe(true);
  });

  it('is false for any other hostname', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.localhost');
    expect(isGuestHostname('app.localhost')).toBe(false);
    expect(isGuestHostname('evil-join.localhost')).toBe(false);
  });

  it('is false when NEXT_PUBLIC_GUEST_HOSTNAME is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');
    expect(isGuestHostname('join.localhost')).toBe(false);
  });
});
