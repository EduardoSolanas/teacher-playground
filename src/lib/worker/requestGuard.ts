/**
 * Request-boundary hardening (SEC-005 / SEC-012).
 *
 * Pure, environment-agnostic helpers so the Worker boundary logic stays
 * unit-testable without the workerd harness.
 */

import { randomHexId } from '../crypto/randomId';

export type HostKind = 'teacher' | 'guest' | 'marketing' | 'unknown';

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
  marketingHost?: string | undefined,
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

  // The public landing surface. Access cannot protect this hostname: the Worker
  // reads the Access JWT from the Cf-Access-Jwt-Assertion header, which
  // Cloudflare injects only on paths an Access application covers. A
  // path-scoped application would therefore strip the header from /api/* and
  // /auth/*, so marketing pages cannot be public on the app hostname. They get
  // their own hostname with no Access application instead.
  // FAIL-CLOSED: only return 'marketing' when the hostname is configured.
  if (marketingHost && lowerHostname === marketingHost.toLowerCase()) {
    return 'marketing';
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

  if (pathname === BILLING_WEBHOOK_PATH) {
    return hostKind === 'teacher' && method === 'POST';
  }

  if (pathname === BILLING_CHECKOUT_PATH || pathname === BILLING_PORTAL_PATH) {
    return hostKind === 'teacher' && method === 'POST';
  }

  // Teacher-only paths: allow on teacher host, deny on guest host
  const isTeacherOnlyPath =
    pathname === '/' ||
    pathname === '/pricing' ||
    pathname === '/terms' ||
    pathname === '/privacy' ||
    // The stylesheet the marketing HTML links; the teacher host serves those
    // pages, the guest host does not. `isPublicPath` then lets it through
    // without an Access credential.
    pathname === '/brand.css' ||
    pathname === '/whiteboard' ||
    pathname === '/auth/session' ||
    pathname.startsWith('/auth/session/') ||
    pathname === '/auth/account' ||
    pathname.startsWith('/auth/account/') ||
    pathname === '/api/company' ||
    pathname.startsWith('/api/company/') ||
    pathname === '/api/whiteboard/rooms';

  // The marketing hostname serves the public pages and nothing else. Everything
  // not listed here falls through to the final `return false` for this host.
  if (hostKind === 'marketing') {
    const isPublicMarketingPath =
      pathname === '/'
      || pathname === '/pricing'
      || pathname === '/terms'
      || pathname === '/privacy'
      || pathname === '/favicon.ico'
      // Cloudflare Access fetches this to brand the login page.
      || pathname === '/logo.svg'
      || pathname.startsWith('/_next/')
      || pathname.startsWith('/fonts/')
      || pathname.startsWith('/data/')
      // The shared brand stylesheet the marketing pages link.
      || pathname === '/brand.css'
    if (!isPublicMarketingPath) return false;
    return method === 'GET' || method === 'HEAD';
  }

  if (isTeacherOnlyPath) {
    return hostKind === 'teacher';
  }

  /*
   * The owner-only room surfaces never belong on the guest host.
   *
   * Settings, the diagnostic report and the shape library are all things only
   * the teacher who owns the room may touch, and the guest hostname exists for
   * people who are not that. The durable object refuses them again on its own
   * -- this is the outer of the two, so a mistake in either alone still leaves
   * the surface closed.
   */
  if (pathname.startsWith('/api/whiteboard/room/')
    && (pathname.includes('/settings')
      || pathname.includes('/stats')
      || pathname.includes('/library'))) {
    return hostKind === 'teacher';
  }

  // Guest-only: POST /auth/guest
  if (pathname === '/auth/guest') {
    return hostKind === 'guest' && method === 'POST';
  }

  /*
   * GET/HEAD /whiteboard/<roomId> on both hosts.
   *
   * The grammar is ROOM_ID_RE -- the same one `isValidRoomId` and the client's
   * room-path parser use. The edge gate used to be stricter (32 lowercase hex
   * only), so every room id outside that shape 404'd with no page while the
   * product, the join links and the waiting screen all agreed on the wider
   * shape. `_room` is the static-export placeholder, never a real room.
   */
  const whiteboardRoomMatch = /^\/whiteboard\/([^/]+)$/.exec(pathname);
  if (
    whiteboardRoomMatch
    && whiteboardRoomMatch[1] !== '_room'
    && isValidRoomId(whiteboardRoomMatch[1])
  ) {
    return method === 'GET' || method === 'HEAD';
  }

  // Any other /whiteboard/* path (non-matching room id format) is denied
  if (pathname.startsWith('/whiteboard/')) {
    return false;
  }

  // LiveKit A/V: both hosts; Worker still enforces POST + session + grant/owner.
  if (pathname === '/api/av/token' || pathname === '/api/av/mute') {
    return true;
  }

  // GET/HEAD /_next/* on both hosts
  if (pathname.startsWith('/_next/')) {
    return method === 'GET' || method === 'HEAD';
  }

  // GET/HEAD Excalidraw's runtime assets on both hosts. Excalidraw resolves
  // "./fonts/..." and "./data/..." against EXCALIDRAW_ASSET_PATH, which the
  // root layout sets to "/", so they are served from these two prefixes.
  if (pathname.startsWith('/fonts/') || pathname.startsWith('/data/')) {
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

/**
 * Paths whose state-changing requests must carry an exact same-origin Origin.
 *
 * `/signaling` is guarded on every method because a cross-origin WebSocket
 * handshake is just as dangerous as a cross-origin POST. Everything else is
 * guarded only when it can change state; the read-only GET/HEAD forms stay
 * reachable so navigation and fetches do not need an Origin header.
 *
 * `/auth/account` and its subpaths are included (SEC-A09): a forged
 * cross-origin `DELETE /auth/account` erases the account, and it was missing
 * from the guarded set.
 */
export function isOriginGuardedPath(pathname: string, method: string): boolean {
  if (pathname === '/signaling') return true;
  if (pathname === BILLING_WEBHOOK_PATH) return false;
  if (method === 'GET' || method === 'HEAD') return false;

  return pathname === '/auth/session'
    || pathname === '/auth/session/logout'
    || pathname === '/auth/session/confirm'
    || pathname === '/auth/account'
    || pathname.startsWith('/auth/account/')
    || pathname === '/auth/guest'
    || pathname.startsWith('/api/');
}

/** Room identifiers are short alphanumeric codes plus `_`/`-`. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Cap for request bodies (1 MiB) so `request.json()` never reads unbounded data. */
/**
 * Cap on a JSON request body.
 *
 * A whiteboard scene is one JSON document: every freedraw stroke carries its
 * full point array, so an ordinary lesson board passes 1 MiB quickly and the
 * save then fails with 413 — the teacher loses work with no warning. 4 MiB
 * covers a realistic board while still bounding what one request can push into
 * a Durable Object.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const BILLING_WEBHOOK_PATH = '/api/billing/webhook';

export const BILLING_CHECKOUT_PATH = '/api/billing/checkout';

export const BILLING_PORTAL_PATH = '/api/billing/portal';

export const BILLING_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Max bytes in one signaling WebSocket frame.
 *
 * Separate from {@link MAX_BODY_BYTES}, and it has to be: that one bounds an
 * HTTP body, which is one JSON scene, and the two were shared. A y-protocol
 * sync step 2 is not a scene -- it carries the client's entire document,
 * Yjs encoding, history and tombstones included, and it is sent on every
 * connect. So a room whose document passed 4 MiB was closed with 1009 the
 * moment it tried to sync, reconnected, sent the same frame, and was closed
 * again, for as long as anyone had it open. 509 of those closes were logged in
 * a single production session on one room; the board simply stopped syncing
 * and no amount of reloading fixed it, because reloading is what triggered it.
 *
 * 32 MiB is chosen to sit far above any document a lesson produces while still
 * bounding what one frame can push into a Durable Object. It is a ceiling
 * against abuse, not a working limit: a document approaching it is a bug
 * somewhere else, and the log line that reports the close says how big it was.
 */
export const MAX_WS_FRAME_BYTES = 32 * 1024 * 1024;

/** Max concurrent signaling sockets per account on one room object. */
export const SIGNALING_MAX_SOCKETS_PER_ACCOUNT = 4;

/** Max concurrent signaling sockets per room object. */
export const SIGNALING_MAX_SOCKETS_PER_ROOM = 32;

/**
 * Max signaling messages per account within {@link SIGNALING_RATE_WINDOW_MS}.
 *
 * Steady-state cost of one drawing host:
 * - Stroke commits: ~20/s (strokeCommitIntervalMs)
 * - Cursor publishes: ~20/s (CURSOR_PUBLISH_INTERVAL_MS = 50ms)
 * - Sync replies, follow frames, paste / undo / image bursts: spiky bursts
 *
 * ~40/s steady rate against a 60/s cap left only 20 frames of headroom. 120 messages
 * per 1000ms window provides safe headroom for drawing hosts and multi-peer sync.
 */
export const SIGNALING_MAX_MESSAGES_PER_WINDOW = 120;


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
  /*
   * The one stylesheet the marketing HTML links. It is a static file shipped
   * with the site, says nothing about a room, an account or a session, and the
   * exact match keeps the exemption to that single path — `/api/brand.css`,
   * `/auth/brand.css` and every other suffix stay behind Access.
   */
  if (pathname === '/brand.css') return true;
  /*
   * Excalidraw's typefaces and their metadata.
   *
   * A browser fetches @font-face sources anonymously — no cookies, by spec —
   * so behind Access every one of them is a 401. Excalidraw answers a failed
   * font by falling back to a hardcoded https://esm.sh/... URL compiled into
   * its bundle, which CSP blocks, so a room logged hundreds of violations and
   * rendered none of its own typefaces.
   *
   * These are static files shipped with the bundle. They say nothing about a
   * room, an account or a session, and the trailing slash keeps the exemption
   * to the directories themselves — `/fontsecret` stays behind Access.
   */
  if (pathname.startsWith('/fonts/') || pathname.startsWith('/data/')) return true;
  // Deliberately NOT /_next/: the marketing pages are self-contained static
  // HTML, so the app's JS/CSS bundles never need to be public.
  return false;
}

/** Where Excalidraw's published shape libraries are fetched from. */
const EXCALIDRAW_LIBRARY_HOST = 'libraries.excalidraw.com';

/**
 * Same-origin HTTP and WebSocket only, plus the two hosts the room genuinely
 * reaches: the media server and the shape library. Never a wildcard scheme.
 */
export function connectSrcForPageOrigin(
  pageOrigin: string,
  livekitUrl?: string | null,
): string {
  const url = new URL(pageOrigin);
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const sources = ["'self'", url.origin, `${wsProtocol}//${url.host}`];

  // A/V lives on a third-party host, so the page origin does not cover it and
  // the browser refuses the connection however good the token is. The client
  // reads region settings over https and opens the media session over wss, so
  // both schemes are needed. Nothing is added when LiveKit is unconfigured:
  // the room answers 503 there and no connection is attempted.
  const livekitHost = hostOf(livekitUrl);
  if (livekitHost) {
    sources.push(`https://${livekitHost}`, `wss://${livekitHost}`);
  }

  /*
   * Excalidraw's public shape repository, for the same reason as LiveKit: the
   * page origin does not cover it, so the browser refuses the request whatever
   * the application intends. Installing a library from the room's title menu
   * is a fetch to this host, and without it the room answered "Failed to
   * fetch" with nothing to say about why.
   *
   * https only, and read-only: a library is a JSON file pulled down and handed
   * to the editor. Nothing streams from there, so no websocket, and nothing is
   * ever sent to it.
   */
  sources.push(`https://${EXCALIDRAW_LIBRARY_HOST}`);

  return `connect-src ${sources.join(' ')}`;
}

/** The host of a configured URL, or null when it is absent or unparseable. */
function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Put the response's nonce on every element `script-src` will judge.
 *
 * That is not only `<script>`. `strict-dynamic` disables host allowlisting, so
 * `'self'` admits nothing on its own and anything without the nonce is refused.
 * Next emits `<link rel="preload" as="script">` for its webpack runtime, and a
 * preload is governed by `script-src-elem` falling back to `script-src` — so
 * leaving links alone blocked that preload on every single page load.
 *
 * Only script-ish links qualify. A stylesheet or a font preload answers to
 * `style-src` and `font-src`, neither of which uses a nonce here.
 */
export function applyCspNonceToHtml(html: string, nonce: string): string {
  const withScripts = html.replace(/<script\b([^>]*)>/gi, (full, attrs: string) => {
    if (/\bnonce\s*=/i.test(attrs)) return full;
    return `<script nonce="${nonce}"${attrs}>`;
  });

  return withScripts.replace(/<link\b([^>]*)>/gi, (full, attrs: string) => {
    if (/\bnonce\s*=/i.test(attrs)) return full;
    const isModulePreload = /\brel\s*=\s*["']?modulepreload\b/i.test(attrs);
    const isScriptPreload = /\brel\s*=\s*["']?(?:preload|prefetch)\b/i.test(attrs)
      && /\bas\s*=\s*["']?script\b/i.test(attrs);
    if (!isModulePreload && !isScriptPreload) return full;
    return `<link nonce="${nonce}"${attrs}>`;
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
  options?: { indexable?: boolean; scriptNonce?: string; connectSrc?: string; fontSrc?: string },
): Response {
  const headers = new Headers(response.headers);
  const contentType = response.headers.get('content-type') ?? '';
  const isHtml = contentType.toLowerCase().includes('text/html');

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  // Everything unused is denied outright rather than left to whatever the
  // browser defaults to.
  //
  // `camera` and `microphone` are the exceptions, and they are granted to
  // `self` only. An empty allowlist is not "prompt the user" — it disables the
  // capability for the document, so `getUserMedia` rejects with
  // NotAllowedError before any permission prompt appears and the LiveKit A/V
  // panel can never start. `self` restores the normal browser prompt for this
  // origin while still refusing the capability to any embedder.
  headers.set(
    'Permissions-Policy',
    'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), midi=(), serial=()',
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
        "img-src 'self' data: blob:",
        // Excalidraw registers its bundled fonts through blob: URLs built at
        // runtime, so 'self' and data: alone are not enough — the browser
        // reported the block hundreds of times on a single board.
        options?.fontSrc
          ?? "font-src 'self' data: blob: https://excalidraw-assets.sen-tutor.co.uk",
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
  options?: { indexable?: boolean; connectSrc?: string; fontSrc?: string },
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
  // The CSP nonce is minted per response and rewritten into the body, so body
  // and header must always travel together. A validator lets the browser make a
  // conditional request and get a 304: it then reuses its CACHED body, carrying
  // the OLD nonce, against the fresh CSP header — and every script on the page
  // is blocked. Dropping the validators forces a full response every time.
  headers.delete('etag');
  headers.delete('last-modified');
  return withSecurityHeaders(
    new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    { ...options, scriptNonce: nonce },
  );
}
