import { describe, it, expect } from 'vitest';
import {
  isValidRoomId,
  bodyTooLarge,
  isJsonContentType,
  withSecurityHeaders,
  withNonceHtmlSecurityHeaders,
  MAX_BODY_BYTES,
  isPublicPath,
  MARKETING_PAGES,
  stripForwardedIdentityHeaders,
  readBoundedJsonBody,
} from './requestGuard';

describe('requestGuard hardening (SEC-005 / SEC-012)', () => {
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
      expect(csp).toContain("connect-src 'self' wss:");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("script-src 'self'");
      expect(wrapped.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
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
