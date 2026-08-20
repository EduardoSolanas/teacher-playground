/**
 * Request-boundary hardening (SEC-005 / SEC-012).
 *
 * Pure, environment-agnostic helpers so the Worker boundary logic stays
 * unit-testable without the workerd harness.
 */

import { randomHexId } from '../crypto/randomId';

export type HostKind = 'teacher' | 'guest' | 'unknown';

/**
 * Determines the host kind from hostname and configured teacher/guest hostnames.
 * Hostname comparison is case-insensitive and exact (not suffix matching).
 *
 * FAIL-CLOSED: if guestHost is undefined, must NEVER return 'guest'.
 * An unconfigured deployment has no guest surface at all.
 */
export function routeHostKind(
  hostname: string,
  teacherHost: string | undefined,
  guestHost: string | undefined,
): HostKind {
  // Empty hostname is unknown
  if (!hostname) {
    return 'unknown';
  }

  const lowerHostname = hostname.toLowerCase();

  // Check for exact teacher host match (case-insensitive)
  if (teacherHost && lowerHostname === teacherHost.toLowerCase()) {
    return 'teacher';
  }

  // Check for exact guest host match (case-insensitive)
  // FAIL-CLOSED: only return 'guest' if guestHost is defined AND matches exactly
  if (guestHost && lowerHostname === guestHost.toLowerCase()) {
    return 'guest';
  }

  // Any other hostname is unknown
  return 'unknown';
}

/**
 * Determines if a route is allowed on a given host kind.
 * Encodes §6.1 of guest_implementation.md exactly.
 *
 * FAIL-CLOSED: returns false for unknown host kinds and any path containing '..'.
 */
export function isRouteAllowedOnHost(
  pathname: string,
  method: string,
  hostKind: HostKind,
): boolean {
  // FAIL-CLOSED: unknown host kind always denies
  if (hostKind === 'unknown') {
    return false;
  }

  // FAIL-CLOSED: path traversal always denies
  if (pathname.includes('..')) {
    return false;
  }

  // Teacher-only paths: allow on teacher host, deny on guest host
  const isTeacherOnlyPath =
    pathname === '/' ||
    pathname === '/pricing' ||
    pathname === '/terms' ||
    pathname === '/privacy' ||
    pathname === '/whiteboard' ||
    pathname === '/auth/session' ||
    pathname.startsWith('/auth/session/') ||
    pathname === '/auth/account' ||
    pathname.startsWith('/auth/account/') ||
    pathname === '/api/whiteboard/rooms';

  if (isTeacherOnlyPath) {
    return hostKind === 'teacher';
  }

  // /api/whiteboard/room/:id/settings is guest-host-denied
  if (pathname.startsWith('/api/whiteboard/room/') && pathname.includes('/settings')) {
    return hostKind === 'teacher';
  }

  // Guest-only: POST /auth/guest
  if (pathname === '/auth/guest') {
    return hostKind === 'guest' && method === 'POST';
  }

  // GET/HEAD /whiteboard/<roomId> (32 lowercase hex chars) on both hosts
  const whiteboardRoomMatch = /^\/whiteboard\/([a-f0-9]{32})$/.exec(pathname);
  if (whiteboardRoomMatch) {
    return method === 'GET' || method === 'HEAD';
  }

  // Any other /whiteboard/* path (non-matching room id format) is denied
  if (pathname.startsWith('/whiteboard/')) {
    return false;
  }

  // LiveKit join tokens: both hosts; Worker still enforces POST + session + grant.
  if (pathname === '/api/av/token') {
    return true;
  }

  // GET/HEAD /_next/* on both hosts
  if (pathname.startsWith('/_next/')) {
    return method === 'GET' || method === 'HEAD';
  }

  // GET/HEAD /excalidraw-assets/* on both hosts
  if (pathname.startsWith('/excalidraw-assets/')) {
    return method === 'GET' || method === 'HEAD';
  }

  // GET/HEAD /favicon.ico on both hosts
  if (pathname === '/favicon.ico') {
    return method === 'GET' || method === 'HEAD';
  }

  // /api/whiteboard/room/:id and subpaths (except /settings which is already handled above)
  if (pathname.startsWith('/api/whiteboard/room/')) {
    return true;
  }

  // /signaling on both hosts, any method
  if (pathname === '/signaling') {
    return true;
  }

  // Anything else is denied
  return false;
}

/** Room identifiers are short alphanumeric codes plus `_`/`-`. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Cap for request bodies (1 MiB) so `request.json()` never reads unbounded data. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Max concurrent signaling sockets per account on one room object. */
export const SIGNALING_MAX_SOCKETS_PER_ACCOUNT = 4;

/** Max concurrent signaling sockets per room object. */
export const SIGNALING_MAX_SOCKETS_PER_ROOM = 32;

/** Max signaling messages per account within {@link SIGNALING_RATE_WINDOW_MS}. */
export const SIGNALING_MAX_MESSAGES_PER_WINDOW = 60;

/** Sliding window for per-account signaling message rate limits. */
export const SIGNALING_RATE_WINDOW_MS = 1000;

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_RE.test(roomId);
}

/** Inbound identity/credential headers that must not reach RoomDO. */
const FORWARDED_IDENTITY_HEADERS = [
  'cookie',
  'authorization',
  'cf-access-jwt-assertion',
  'cf-access-authenticated-user-email',
  'x-account-id',
  'x-user-id',
  'x-forwarded-user',
] as const;

/**
 * Returns a copy of `headers` without caller-supplied identity. WebSocket
 * upgrade headers (`Upgrade`, `Connection`, `Sec-WebSocket-*`) and `Origin`
 * are left in place. Session identity must travel only via Worker-stamped
 * query params (`accountId`, `accountEpoch`, `sessionId`).
 */
export function stripForwardedIdentityHeaders(headers: Headers): Headers {
  const stripped = new Headers(headers);
  for (const name of FORWARDED_IDENTITY_HEADERS) {
    stripped.delete(name);
  }
  return stripped;
}

/** A Content-Length header that exceeds the body cap means we can reject before reading. */
export function bodyTooLarge(contentLength: string | null): boolean {
  if (contentLength === null) return false;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > MAX_BODY_BYTES;
}

export type BoundedJsonBody =
  | { ok: false; tooLarge: true }
  | { ok: true; buffer: ArrayBuffer };

/**
 * Reads the request body and rejects when the actual byte length exceeds
 * {@link MAX_BODY_BYTES}, including when Content-Length is omitted.
 * Does not log the body.
 */
export async function readBoundedJsonBody(request: Request): Promise<BoundedJsonBody> {
  if (bodyTooLarge(request.headers.get('content-length'))) {
    return { ok: false, tooLarge: true };
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }
  return { ok: true, buffer };
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
 * Same-origin HTTP and WebSocket only. Never a wildcard `wss:` scheme.
 */
export function connectSrcForPageOrigin(pageOrigin: string): string {
  const url = new URL(pageOrigin);
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `connect-src 'self' ${url.origin} ${wsProtocol}//${url.host}`;
}

export function applyCspNonceToHtml(html: string, nonce: string): string {
  return html.replace(/<script\b([^>]*)>/gi, (full, attrs: string) => {
    if (/\bnonce\s*=/i.test(attrs)) return full;
    return `<script nonce="${nonce}"${attrs}>`;
  });
}

/**
 * Applies the shared security-header baseline to every outbound response
 * (SEC-012). HTML responses get an enforced CSP plus noindex; everything
 * else gets `Cache-Control: no-store` so sensitive data is never cached.
 * Pass `indexable: true` (SEC-015 marketing pages) to keep the CSP and every
 * other header but omit `X-Robots-Tag` so search engines may index the page.
 */
export function withSecurityHeaders(
  response: Response,
  options?: { indexable?: boolean; scriptNonce?: string; connectSrc?: string },
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

  headers.set('Cache-Control', 'no-store');

  if (isHtml) {
    if (!options?.indexable) headers.set('X-Robots-Tag', 'noindex');
    headers.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        options?.connectSrc ?? "connect-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        options?.scriptNonce
          ? `script-src 'self' 'nonce-${options.scriptNonce}' 'strict-dynamic'`
          : "script-src 'self'",
      ].join('; '),
    );
  } else {
    const existingVary = headers.get('Vary');
    headers.set('Vary', existingVary ? `${existingVary}, Cookie, Origin` : 'Cookie, Origin');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * HTML pages from Next's static export include inline bootstraps. Stamp every
 * script with a per-response nonce and put that nonce in CSP so `script-src
 * 'self'` does not freeze the SPA on "Loading secure session…".
 */
export async function withNonceHtmlSecurityHeaders(
  response: Response,
  options?: { indexable?: boolean; connectSrc?: string },
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    return withSecurityHeaders(response, options);
  }
  const nonce = randomHexId();
  const html = applyCspNonceToHtml(await response.text(), nonce);
  const headers = new Headers(response.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8');
  }
  return withSecurityHeaders(
    new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    { ...options, scriptNonce: nonce },
  );
}
