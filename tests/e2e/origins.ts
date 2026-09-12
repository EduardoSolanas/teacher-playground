/**
 * Shared E2E origins and Access-cookie domain. The three local hosts mirror
 * production's host kinds: app.localhost (teacher, behind the Access edge),
 * join.localhost (guest), and playground.localhost (marketing). Only the
 * teacher origin carries an Access edge locally.
 */

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

export function marketingOrigin(): string {
  const origin = process.env.E2E_MARKETING_ORIGIN;
  if (!origin) throw new Error('E2E_MARKETING_ORIGIN is missing; use npm run test:e2e');
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
