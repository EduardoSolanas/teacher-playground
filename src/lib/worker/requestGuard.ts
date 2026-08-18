/**
 * Request-boundary hardening (SEC-005 / SEC-012).
 *
 * Pure, environment-agnostic helpers so the Worker boundary logic stays
 * unit-testable without the workerd harness.
 */

/** Room identifiers are short alphanumeric codes plus `_`/`-`. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Cap for request bodies (1 MiB) so `request.json()` never reads unbounded data. */
export const MAX_BODY_BYTES = 1024 * 1024;

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_RE.test(roomId);
}

/** A Content-Length header that exceeds the body cap means we can reject before reading. */
export function bodyTooLarge(contentLength: string | null): boolean {
  if (contentLength === null) return false;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > MAX_BODY_BYTES;
}

/** JSON API mutations must declare a JSON content type. */
export function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const normalized = contentType.toLowerCase();
  return normalized === 'application/json'
    || normalized.startsWith('application/json;');
}

/**
 * Public marketing pages (SEC-015). Exact-match only, GET/HEAD only — see
 * `isPublicPath`. Reviewed like a firewall rule: nothing is added here
 * without deciding it is safe to serve with no Access credential.
 */
export const MARKETING_PAGES = ['/', '/pricing', '/terms', '/privacy'] as const;

/**
 * True only for the exact marketing pages, `/_next/*` build assets, and
 * `/favicon.ico`. Everything else — including anything under `/api/`,
 * `/auth/`, `/whiteboard/`, `/signaling`, and suffixed or traversal variants
 * of the marketing paths — must return false so it stays behind Access.
 */
export function isPublicPath(pathname: string): boolean {
  if (pathname.includes('..')) return false;
  if ((MARKETING_PAGES as readonly string[]).includes(pathname)) return true;
  if (pathname === '/favicon.ico') return true;
  // Deliberately NOT /_next/: the marketing pages are self-contained static
  // HTML, so the app's JS/CSS bundles never need to be public.
  return false;
}

/**
 * Applies the shared security-header baseline to every outbound response
 * (SEC-012). HTML responses get a report-only CSP plus noindex; everything
 * else gets `Cache-Control: no-store` so sensitive data is never cached.
 * Pass `indexable: true` (SEC-015 marketing pages) to keep the CSP and every
 * other header but omit `X-Robots-Tag` so search engines may index the page.
 */
export function withSecurityHeaders(
  response: Response,
  options?: { indexable?: boolean },
): Response {
  const headers = new Headers(response.headers);
  const contentType = response.headers.get('content-type') ?? '';
  const isHtml = contentType.toLowerCase().includes('text/html');

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  // Nothing in a whiteboard needs these, so deny them outright rather than
  // leaving them to whatever the browser defaults to.
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), serial=()',
  );

  if (isHtml) {
    if (!options?.indexable) headers.set('X-Robots-Tag', 'noindex');
    // Report-only first (SEC-012): enforced CSP must not break Excalidraw, so
    // the policy is announced before it is ever enforced.
    headers.set(
      'Content-Security-Policy-Report-Only',
      [
        "default-src 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "connect-src 'self' wss:",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
      ].join('; '),
    );
  } else {
    headers.set('Cache-Control', 'no-store');
    // These responses are selected by the session cookie and the origin check,
    // so any cache between here and the browser must key on both. `no-store`
    // should already prevent caching; `Vary` is the backstop if a proxy
    // ignores it.
    const existingVary = headers.get('Vary');
    headers.set('Vary', existingVary ? `${existingVary}, Cookie, Origin` : 'Cookie, Origin');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
