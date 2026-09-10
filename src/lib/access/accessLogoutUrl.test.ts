import { describe, expect, it } from 'vitest';

import {
  ACCESS_LOGOUT_PATH,
  accessLogoutUrl,
  clearCfAuthorizationSetCookie,
  safeRedirectPath,
} from './accessLogoutUrl';

describe('accessLogoutUrl', () => {
  it('builds a same-origin Access logout URL with a safe redirect', () => {
    expect(accessLogoutUrl('/')).toBe(`${ACCESS_LOGOUT_PATH}?redirect=%2F`);
    expect(accessLogoutUrl('/pricing')).toBe(`${ACCESS_LOGOUT_PATH}?redirect=%2Fpricing`);
    expect(accessLogoutUrl('https://evil.example/steal')).toBe(`${ACCESS_LOGOUT_PATH}?redirect=%2F`);
  });

  it('rejects open redirects and traversal', () => {
    expect(safeRedirectPath('//evil.example')).toBe('/');
    expect(safeRedirectPath('/whiteboard/../etc')).toBe('/');
    expect(safeRedirectPath('whiteboard')).toBe('/');
  });

  it('rejects backslashes and control characters browsers fold into an open redirect', () => {
    // Browsers normalize `\` to `/` in Location: `/\evil.example` becomes
    // `//evil.example`. A tab does the same after URL parsing.
    expect(safeRedirectPath('/\\evil.example')).toBe('/');
    expect(safeRedirectPath('/\t/evil.example')).toBe('/');
  });

  it('clears CF_Authorization with Max-Age=0', () => {
    expect(clearCfAuthorizationSetCookie()).toContain('CF_Authorization=');
    expect(clearCfAuthorizationSetCookie()).toContain('Max-Age=0');
  });
});
