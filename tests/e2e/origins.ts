/** Shared E2E origins and Access-cookie domain. Teacher host is app.localhost. */

export function playwrightBaseURL(): string {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL;
  if (!baseURL) throw new Error('PLAYWRIGHT_BASE_URL is missing; use npm run test:e2e');
  return baseURL;
}

export function accessCookieDomain(): string {
  return new URL(playwrightBaseURL()).hostname;
}

export function guestOrigin(): string {
  const origin = process.env.E2E_GUEST_ORIGIN;
  if (!origin) throw new Error('E2E_GUEST_ORIGIN is missing; use npm run test:e2e');
  return origin;
}

export function cfAuthorizationCookie(token: string) {
  return {
    name: 'CF_Authorization',
    value: token,
    domain: accessCookieDomain(),
    path: '/',
    expires: Math.floor(Date.now() / 1000) + 3_600,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
  };
}
