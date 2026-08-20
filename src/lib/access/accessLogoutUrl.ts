/** App-controlled logout route (works under wrangler dev; not intercepted like /cdn-cgi/*). */
export const ACCESS_LOGOUT_PATH = '/auth/access/logout';

/** Cloudflare Access edge logout; used for production hand-off after {@link ACCESS_LOGOUT_PATH}. */
export const CF_ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';

/** Only allow same-origin relative paths after Access logout. */
export function safeRedirectPath(path: string | null | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return '/';
  if (path.includes('..')) return '/';
  return path;
}

/** Same-origin Cloudflare Access logout. Never returns a team-domain URL. */
export function accessLogoutUrl(afterPath: string): string {
  const redirect = safeRedirectPath(afterPath);
  return `${ACCESS_LOGOUT_PATH}?redirect=${encodeURIComponent(redirect)}`;
}

export function clearCfAuthorizationSetCookie(): string {
  return 'CF_Authorization=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax';
}
