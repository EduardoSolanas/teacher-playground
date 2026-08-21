import { describe, it, expect } from 'vitest';
import {
  isValidRoomId,
  bodyTooLarge,
  isJsonContentType,
  withSecurityHeaders,
  withNonceHtmlSecurityHeaders,
  connectSrcForPageOrigin,
  MAX_BODY_BYTES,
  applyCspNonceToHtml,
  isPublicPath,
  MARKETING_PAGES,
  stripForwardedIdentityHeaders,
  readBoundedJsonBody,
  routeHostKind,
  isRouteAllowedOnHost,
} from './requestGuard';

describe('requestGuard hardening (SEC-005 / SEC-012)', () => {
  describe('routeHostKind', () => {
    // Fail-closed test: guestHost undefined means never return 'guest'
    it('never returns guest when guestHost is undefined, even for the guest hostname literal', () => {
      const result = routeHostKind('join.example.com', 'app.example.com', undefined);
      expect(result).not.toBe('guest');
      expect(result).toBe('unknown');
    });

    it('returns teacher for exact teacher host match', () => {
      expect(routeHostKind('app.example.com', 'app.example.com', 'join.example.com')).toBe('teacher');
    });

    it('returns teacher for case-insensitive teacher host match', () => {
      expect(routeHostKind('APP.EXAMPLE.COM', 'app.example.com', 'join.example.com')).toBe('teacher');
      expect(routeHostKind('App.Example.Com', 'app.example.com', 'join.example.com')).toBe('teacher');
    });

    it('returns guest for exact guest host match', () => {
      expect(routeHostKind('join.example.com', 'app.example.com', 'join.example.com')).toBe('guest');
    });

    it('returns guest for case-insensitive guest host match', () => {
      expect(routeHostKind('JOIN.EXAMPLE.COM', 'app.example.com', 'join.example.com')).toBe('guest');
      expect(routeHostKind('Join.Example.Com', 'app.example.com', 'join.example.com')).toBe('guest');
    });

    it('returns unknown for empty hostname', () => {
      expect(routeHostKind('', 'app.example.com', 'join.example.com')).toBe('unknown');
    });

    it('returns unknown for third-party hostname', () => {
      expect(routeHostKind('evil.example.com', 'app.example.com', 'join.example.com')).toBe('unknown');
    });

    it('rejects suffix matching (evil-join.example.com should not match join.example.com)', () => {
      expect(routeHostKind('evil-join.example.com', 'app.example.com', 'join.example.com')).toBe('unknown');
    });

    it('rejects prefix+suffix matching (join.example.com.evil.com should not match join.example.com)', () => {
      expect(routeHostKind('join.example.com.evil.com', 'app.example.com', 'join.example.com')).toBe('unknown');
    });
  });

  describe('isRouteAllowedOnHost', () => {
    // Teacher-only paths — true on teacher, false on guest
    it('/ is teacher-only', () => {
      expect(isRouteAllowedOnHost('/', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/', 'HEAD', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/', 'GET', 'guest')).toBe(false);
      expect(isRouteAllowedOnHost('/', 'POST', 'teacher')).toBe(true);
    });

    it('/pricing is teacher-only', () => {
      expect(isRouteAllowedOnHost('/pricing', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/pricing', 'GET', 'guest')).toBe(false);
    });

    it('/terms is teacher-only', () => {
      expect(isRouteAllowedOnHost('/terms', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/terms', 'GET', 'guest')).toBe(false);
    });

    it('/privacy is teacher-only', () => {
      expect(isRouteAllowedOnHost('/privacy', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/privacy', 'GET', 'guest')).toBe(false);
    });

    it('/whiteboard (list page, no id) is teacher-only', () => {
      expect(isRouteAllowedOnHost('/whiteboard', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/whiteboard', 'GET', 'guest')).toBe(false);
    });

    it('/auth/session paths are teacher-only', () => {
      expect(isRouteAllowedOnHost('/auth/session', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/auth/session/current', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/auth/session/confirm', 'POST', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/auth/session/logout', 'POST', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/auth/session', 'GET', 'guest')).toBe(false);
      expect(isRouteAllowedOnHost('/auth/session/current', 'GET', 'guest')).toBe(false);
    });

    it('/auth/account paths are teacher-only', () => {
      expect(isRouteAllowedOnHost('/auth/account', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/auth/account/export', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/auth/account/profile', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/auth/account', 'GET', 'guest')).toBe(false);
      expect(isRouteAllowedOnHost('/auth/account/export', 'GET', 'guest')).toBe(false);
    });

    it('/api/whiteboard/rooms (owned room list) is teacher-only', () => {
      expect(isRouteAllowedOnHost('/api/whiteboard/rooms', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/whiteboard/rooms', 'GET', 'guest')).toBe(false);
    });

    // Guest-only paths
    it('POST /auth/guest is guest-only', () => {
      expect(isRouteAllowedOnHost('/auth/guest', 'POST', 'guest')).toBe(true);
      expect(isRouteAllowedOnHost('/auth/guest', 'POST', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/auth/guest', 'GET', 'guest')).toBe(false);
    });

    it('POST /api/av/token is allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/api/av/token', 'POST', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/av/token', 'POST', 'guest')).toBe(true);
      expect(isRouteAllowedOnHost('/api/av/token', 'GET', 'teacher')).toBe(true);
    });

    // Dual paths - method matters
    it('GET/HEAD /whiteboard/<roomId> (32 hex) is allowed on both hosts', () => {
      const roomId = 'a'.repeat(32); // 32 lowercase hex chars
      expect(isRouteAllowedOnHost(`/whiteboard/${roomId}`, 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost(`/whiteboard/${roomId}`, 'GET', 'guest')).toBe(true);
      expect(isRouteAllowedOnHost(`/whiteboard/${roomId}`, 'HEAD', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost(`/whiteboard/${roomId}`, 'HEAD', 'guest')).toBe(true);
    });

    it('GET /whiteboard/_room is denied (placeholder is Worker-internal)', () => {
      expect(isRouteAllowedOnHost('/whiteboard/_room', 'GET', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/whiteboard/_room', 'GET', 'guest')).toBe(false);
    });

    it('POST /whiteboard/<roomId> is not allowed', () => {
      const roomId = 'a'.repeat(32);
      expect(isRouteAllowedOnHost(`/whiteboard/${roomId}`, 'POST', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost(`/whiteboard/${roomId}`, 'POST', 'guest')).toBe(false);
    });

    it('GET/HEAD /_next/* is allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/_next/static/chunk.js', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/_next/static/chunk.js', 'GET', 'guest')).toBe(true);
      expect(isRouteAllowedOnHost('/_next/static/chunk.css', 'HEAD', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/_next/static/chunk.css', 'HEAD', 'guest')).toBe(true);
    });

    it('POST /_next/* is not allowed', () => {
      expect(isRouteAllowedOnHost('/_next/static/chunk.js', 'POST', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/_next/static/chunk.js', 'POST', 'guest')).toBe(false);
    });

    it('GET/HEAD Excalidraw runtime assets are allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/fonts/Xiaolai/Xiaolai-Regular.woff2', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/fonts/Xiaolai/Xiaolai-Regular.woff2', 'GET', 'guest')).toBe(true);
      expect(isRouteAllowedOnHost('/data/image-GAAHSSAO.js', 'HEAD', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/data/image-GAAHSSAO.js', 'HEAD', 'guest')).toBe(true);
    });

    it('POST to Excalidraw runtime assets is not allowed', () => {
      expect(isRouteAllowedOnHost('/fonts/Xiaolai/Xiaolai-Regular.woff2', 'POST', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/fonts/Xiaolai/Xiaolai-Regular.woff2', 'POST', 'guest')).toBe(false);
    });

    it('GET/HEAD /favicon.ico is allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/favicon.ico', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/favicon.ico', 'GET', 'guest')).toBe(true);
      expect(isRouteAllowedOnHost('/favicon.ico', 'HEAD', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/favicon.ico', 'HEAD', 'guest')).toBe(true);
    });

    it('POST /favicon.ico is not allowed', () => {
      expect(isRouteAllowedOnHost('/favicon.ico', 'POST', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/favicon.ico', 'POST', 'guest')).toBe(false);
    });

    // /api/whiteboard/room/:id paths (except /settings)
    it('GET /api/whiteboard/room/:id is allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456', 'GET', 'guest')).toBe(true);
    });

    it('POST /api/whiteboard/room/:id is allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456', 'POST', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456', 'POST', 'guest')).toBe(true);
    });

    it('DELETE /api/whiteboard/room/:id is allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456', 'DELETE', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456', 'DELETE', 'guest')).toBe(true);
    });

    it('GET /api/whiteboard/room/:id/access is allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456/access', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456/access', 'GET', 'guest')).toBe(true);
    });

    it('POST /api/whiteboard/room/:id/presence is allowed on both hosts', () => {
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456/presence', 'POST', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456/presence', 'POST', 'guest')).toBe(true);
    });

    it('/api/whiteboard/room/:id/settings is false on guest host, true on teacher host', () => {
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456/settings', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456/settings', 'GET', 'guest')).toBe(false);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456/settings', 'POST', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/abc123def456/settings', 'POST', 'guest')).toBe(false);
    });

    // /signaling
    it('/signaling is allowed on both hosts with any method', () => {
      expect(isRouteAllowedOnHost('/signaling', 'GET', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/signaling', 'GET', 'guest')).toBe(true);
      expect(isRouteAllowedOnHost('/signaling', 'POST', 'teacher')).toBe(true);
      expect(isRouteAllowedOnHost('/signaling', 'POST', 'guest')).toBe(true);
    });

    // Path traversal and malformed paths
    it('any path with .. is false', () => {
      expect(isRouteAllowedOnHost('/whiteboard/../etc', 'GET', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/whiteboard/../etc', 'GET', 'guest')).toBe(false);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/id/../../settings', 'GET', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/api/whiteboard/room/id/../../settings', 'GET', 'guest')).toBe(false);
    });

    it('unknown host kind always returns false', () => {
      expect(isRouteAllowedOnHost('/', 'GET', 'unknown')).toBe(false);
      expect(isRouteAllowedOnHost('/favicon.ico', 'GET', 'unknown')).toBe(false);
      expect(isRouteAllowedOnHost('/whiteboard/roomid', 'GET', 'unknown')).toBe(false);
      expect(isRouteAllowedOnHost('/pricing', 'GET', 'unknown')).toBe(false);
    });

    it('double-slash and trailing-dot variants are false', () => {
      expect(isRouteAllowedOnHost('//whiteboard', 'GET', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/whiteboard/', 'GET', 'teacher')).toBe(false);
      expect(isRouteAllowedOnHost('/whiteboard.', 'GET', 'teacher')).toBe(false);
    });
  });

  describe('isValidRoomId', () => {
    it('accepts room codes', () => {
      expect(isValidRoomId('ABCDEFG1')).toBe(true);
      expect(isValidRoomId('room_a-b')).toBe(true);
    });

    it('rejects out-of-grammar identifiers', () => {
      expect(isValidRoomId('../etc/passwd')).toBe(false);
      expect(isValidRoomId('has spaces')).toBe(false);
      expect(isValidRoomId('')).toBe(false);
      expect(isValidRoomId('a'.repeat(65))).toBe(false);
    });
  });

  describe('bodyTooLarge', () => {
    it('rejects declared bodies over the cap', () => {
      expect(bodyTooLarge(String(MAX_BODY_BYTES + 1))).toBe(true);
    });

    it('accepts bodies at or under the cap', () => {
      expect(bodyTooLarge(String(MAX_BODY_BYTES))).toBe(false);
      expect(bodyTooLarge('123')).toBe(false);
    });

    it('ignores absent or unparseable content lengths', () => {
      expect(bodyTooLarge(null)).toBe(false);
      expect(bodyTooLarge('not-a-number')).toBe(false);
    });
  });

  describe('readBoundedJsonBody', () => {
    function postWithoutContentLength(body: string): Request {
      const bytes = new TextEncoder().encode(body);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const request = new Request('https://example.com/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit);
      expect(request.headers.get('content-length')).toBeNull();
      return request;
    }

    it('rejects a missing Content-Length when the actual body exceeds the cap', async () => {
      const oversized = 'x'.repeat(MAX_BODY_BYTES + 1);
      const result = await readBoundedJsonBody(postWithoutContentLength(oversized));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.tooLarge).toBe(true);
    });

    it('accepts a missing Content-Length when the JSON body is under the cap and leaves the body readable', async () => {
      const result = await readBoundedJsonBody(postWithoutContentLength('{"ok":true}'));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected a bounded body');
      expect(JSON.parse(new TextDecoder().decode(result.buffer))).toEqual({ ok: true });
    });

    it('still treats a declared Content-Length over the cap as too large via bodyTooLarge', () => {
      expect(bodyTooLarge(String(MAX_BODY_BYTES + 1))).toBe(true);
    });
  });

  describe('isJsonContentType', () => {
    it('accepts application/json', () => {
      expect(isJsonContentType('application/json')).toBe(true);
      expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    });

    it('rejects other content types', () => {
      expect(isJsonContentType('text/plain')).toBe(false);
      expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
      expect(isJsonContentType(null)).toBe(false);
    });
  });

  describe('withSecurityHeaders', () => {
    it('adds the baseline headers to every response', () => {
      const wrapped = withSecurityHeaders(new Response('ok', { status: 200 }));
      expect(wrapped.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(wrapped.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(wrapped.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('marks HTML responses noindex and sends an enforced CSP', () => {
      const wrapped = withSecurityHeaders(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      );
      expect(wrapped.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(wrapped.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    });

    it('enforces Content-Security-Policy on HTML and does not rely only on Report-Only', () => {
      const wrapped = withSecurityHeaders(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      );
      const csp = wrapped.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain('wss:');
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("script-src 'self'");
      expect(wrapped.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
    });

    it('restricts connect-src to the page origin and matching websocket origin', () => {
      expect(connectSrcForPageOrigin('https://app.example:8443')).toBe(
        "connect-src 'self' https://app.example:8443 wss://app.example:8443",
      );
      const wrapped = withSecurityHeaders(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
        { connectSrc: connectSrcForPageOrigin('https://app.example') },
      );
      const csp = wrapped.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("connect-src 'self' https://app.example wss://app.example");
      expect(csp).not.toMatch(/connect-src[^;]*wss:(;|$)/);
    });

    it('stamps HTML script tags with a CSP nonce so Next inline bootstraps can run', async () => {
      const html = [
        '<html><head>',
        '<script>self.__next_f.push([])</script>',
        '<script src="/_next/static/chunks/app.js"></script>',
        '</head></html>',
      ].join('');
      const wrapped = await withNonceHtmlSecurityHeaders(
        new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      );
      const csp = wrapped.headers.get('Content-Security-Policy') ?? '';
      const nonce = /script-src 'self' 'nonce-([a-f0-9]+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("'strict-dynamic'");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      const body = await wrapped.text();
      expect(body).toContain(`<script nonce="${nonce}">self.__next_f.push([])</script>`);
      expect(body).toContain(`<script nonce="${nonce}" src="/_next/static/chunks/app.js">`);
    });

    it('drops validators so a 304 cannot pair a stale body with a fresh nonce', async () => {
      // The nonce is minted per response and written into the body, so a
      // conditional request that returns 304 would reuse the cached body (old
      // nonce) against a fresh CSP header and block every script on the page.
      const wrapped = await withNonceHtmlSecurityHeaders(
        new Response('<html><head><script src="/a.js"></script></head></html>', {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            etag: '"cafebabe"',
            'last-modified': 'Wed, 20 Aug 2026 00:00:00 GMT',
          },
        }),
      );
      expect(wrapped.headers.get('etag')).toBeNull();
      expect(wrapped.headers.get('last-modified')).toBeNull();
    });

    it('allows Excalidraw blob: fonts so board text renders', async () => {
      const wrapped = await withNonceHtmlSecurityHeaders(
        new Response('<html><head></head></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );
      const csp = wrapped.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("font-src 'self' data: blob:");
    });

    it('marks non-HTML responses no-store', () => {
      const wrapped = withSecurityHeaders(
        new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      );
      expect(wrapped.headers.get('Cache-Control')).toBe('no-store');
    });

    it('marks HTML responses no-store so CDN cannot cache a stale nonce', async () => {
      const wrapped = await withNonceHtmlSecurityHeaders(
        new Response('<html><script>boot()</script></html>', {
          headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=0' },
        }),
      );
      expect(wrapped.headers.get('Cache-Control')).toBe('no-store');
    });

    it('sends a minimal Permissions Policy that denies unused capabilities', () => {
      const wrapped = withSecurityHeaders(new Response('ok'));
      const policy = wrapped.headers.get('Permissions-Policy') ?? '';
      for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
        expect(policy).toContain(`${feature}=()`);
      }
    });

    it('varies cached non-HTML responses on the credentials that select them', () => {
      const wrapped = withSecurityHeaders(
        new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      );
      const vary = wrapped.headers.get('Vary') ?? '';
      expect(vary).toContain('Cookie');
      expect(vary).toContain('Origin');
    });

    it('preserves an existing Vary rather than dropping it', () => {
      const wrapped = withSecurityHeaders(
        new Response('{"ok":true}', {
          headers: { 'content-type': 'application/json', vary: 'Accept-Encoding' },
        }),
      );
      const vary = wrapped.headers.get('Vary') ?? '';
      expect(vary).toContain('Accept-Encoding');
      expect(vary).toContain('Cookie');
    });

    it('preserves the original status and body', async () => {
      const original = new Response('hello', { status: 404 });
      const wrapped = withSecurityHeaders(original);
      expect(wrapped.status).toBe(404);
      expect(await wrapped.text()).toBe('hello');
    });

    it('drops X-Robots-Tag for indexable HTML but keeps CSP and nosniff', () => {
      const wrapped = withSecurityHeaders(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
        { indexable: true },
      );
      expect(wrapped.headers.get('X-Robots-Tag')).toBeNull();
      expect(wrapped.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(wrapped.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
      expect(wrapped.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('still marks HTML noindex by default (indexable option omitted)', () => {
      const wrapped = withSecurityHeaders(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      );
      expect(wrapped.headers.get('X-Robots-Tag')).toBe('noindex');
    });
  });

  describe('stripForwardedIdentityHeaders (SEC-004)', () => {
    it('removes cookies, Authorization, Access assertion, and client identity headers', () => {
      const incoming = new Headers({
        Cookie: '__Host-teacher-session=session-secret',
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
        'Cf-Access-Jwt-Assertion': 'access-jwt-value',
        'Cf-Access-Authenticated-User-Email': 'teacher@example.com',
        'X-Account-Id': 'acct-forged',
        'X-User-Id': 'user-forged',
        'X-Forwarded-User': 'forwarded-forged',
        'Content-Type': 'application/json',
      });

      const stripped = stripForwardedIdentityHeaders(incoming);

      expect(stripped.get('Cookie')).toBeNull();
      expect(stripped.get('Authorization')).toBeNull();
      expect(stripped.get('Cf-Access-Jwt-Assertion')).toBeNull();
      expect(stripped.get('Cf-Access-Authenticated-User-Email')).toBeNull();
      expect(stripped.get('X-Account-Id')).toBeNull();
      expect(stripped.get('X-User-Id')).toBeNull();
      expect(stripped.get('X-Forwarded-User')).toBeNull();
      expect(stripped.get('Content-Type')).toBe('application/json');
      expect(incoming.get('Cookie')).toBe('__Host-teacher-session=session-secret');
    });

    it('keeps WebSocket upgrade headers and Origin', () => {
      const incoming = new Headers({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Protocol': 'y-webrtc',
        Origin: 'https://example.com',
        Cookie: '__Host-teacher-session=session-secret',
      });

      const stripped = stripForwardedIdentityHeaders(incoming);

      expect(stripped.get('Upgrade')).toBe('websocket');
      expect(stripped.get('Connection')).toBe('Upgrade');
      expect(stripped.get('Sec-WebSocket-Key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
      expect(stripped.get('Sec-WebSocket-Version')).toBe('13');
      expect(stripped.get('Sec-WebSocket-Protocol')).toBe('y-webrtc');
      expect(stripped.get('Origin')).toBe('https://example.com');
      expect(stripped.get('Cookie')).toBeNull();
    });
  });

  describe('applyCspNonceToHtml covers script preloads', () => {
    /*
     * `strict-dynamic` disables host allowlisting, so `'self'` no longer
     * admits anything: an element without the nonce is refused. Next emits a
     * <link rel="preload" as="script"> for its webpack runtime, and a preload
     * is governed by script-src-elem falling back to script-src — so an
     * un-nonced one was blocked on every page load.
     */
    it('nonces a script preload link', () => {
      const html = '<link rel="preload" as="script" fetchPriority="low" href="/_next/x.js"/>';
      expect(applyCspNonceToHtml(html, 'abc')).toContain('nonce="abc"');
    });

    it('nonces a modulepreload link', () => {
      const html = '<link rel="modulepreload" href="/_next/x.js"/>';
      expect(applyCspNonceToHtml(html, 'abc')).toContain('nonce="abc"');
    });

    it('leaves a stylesheet link alone: style-src has no strict-dynamic', () => {
      const html = '<link rel="stylesheet" href="/a.css"/>';
      expect(applyCspNonceToHtml(html, 'abc')).toBe(html);
    });

    it('leaves a non-script preload alone', () => {
      const html = '<link rel="preload" as="font" href="/f.woff2"/>';
      expect(applyCspNonceToHtml(html, 'abc')).toBe(html);
    });

    it('does not double-nonce a link that already has one', () => {
      const html = '<link rel="preload" as="script" nonce="old" href="/x.js"/>';
      const out = applyCspNonceToHtml(html, 'abc');
      expect(out).toBe(html);
      expect(out.match(/nonce=/g)).toHaveLength(1);
    });

    it('still nonces script tags', () => {
      expect(applyCspNonceToHtml('<script src="/a.js"></script>', 'abc'))
        .toContain('<script nonce="abc" src="/a.js">');
    });
  });

  describe('font assets are readable without an Access credential', () => {
    /*
     * A browser fetches @font-face sources anonymously — no cookies, by spec.
     * Behind Access that is a 401, and Excalidraw answers a failed font by
     * falling back to a hardcoded https://esm.sh/... URL baked into its bundle,
     * which CSP then blocks. The visible result was 230 console violations per
     * room and Excalidraw's own typefaces never rendering.
     *
     * These are static font and font-metadata files shipped in the bundle.
     * They carry nothing about a room, an account or a session.
     */
    it('serves fonts and font data with no credential', () => {
      expect(isPublicPath('/fonts/Xiaolai/Xiaolai-Regular-1b61.woff2')).toBe(true);
      expect(isPublicPath('/data/Xiaolai.json')).toBe(true);
    });

    it('keeps everything else behind Access', () => {
      expect(isPublicPath('/fonts')).toBe(false);
      expect(isPublicPath('/data')).toBe(false);
      expect(isPublicPath('/fontsecret')).toBe(false);
      expect(isPublicPath('/database/dump.sql')).toBe(false);
      expect(isPublicPath('/api/whiteboard/rooms')).toBe(false);
    });

    it('refuses traversal out of the font directory', () => {
      expect(isPublicPath('/fonts/../api/whiteboard/rooms')).toBe(false);
      expect(isPublicPath('/data/../../etc/passwd')).toBe(false);
    });
  });

  describe('isPublicPath (SEC-015 marketing exemption)', () => {
    it('accepts exactly the marketing pages', () => {
      for (const page of MARKETING_PAGES) {
        expect(isPublicPath(page)).toBe(true);
      }
      expect(MARKETING_PAGES).toEqual(['/', '/pricing', '/terms', '/privacy']);
    });

    it('accepts the favicon but not app bundle assets', () => {
      // The marketing pages are self-contained static HTML, so nothing under
      // /_next/ needs to be public; app bundles stay behind Access.
      expect(isPublicPath('/favicon.ico')).toBe(true);
      expect(isPublicPath('/_next/static/chunk.js')).toBe(false);
    });

    it('rejects sensitive path families', () => {
      expect(isPublicPath('/api/anything')).toBe(false);
      expect(isPublicPath('/auth/anything')).toBe(false);
      expect(isPublicPath('/whiteboard/x')).toBe(false);
      expect(isPublicPath('/whiteboard')).toBe(false);
      expect(isPublicPath('/signaling')).toBe(false);
      expect(isPublicPath('/index.html')).toBe(false);
    });

    it('rejects path traversal shapes', () => {
      expect(isPublicPath('/_next/../api/x')).toBe(false);
    });

    it('rejects suffixed marketing paths', () => {
      expect(isPublicPath('/pricing/extra')).toBe(false);
    });
  });
});
