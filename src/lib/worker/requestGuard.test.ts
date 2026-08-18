import { describe, it, expect } from 'vitest';
import {
  isValidRoomId,
  bodyTooLarge,
  isJsonContentType,
  withSecurityHeaders,
  MAX_BODY_BYTES,
  isPublicPath,
  MARKETING_PAGES,
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

    it('marks HTML responses noindex and announces a report-only CSP', () => {
      const wrapped = withSecurityHeaders(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      );
      expect(wrapped.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(wrapped.headers.get('Content-Security-Policy-Report-Only')).toContain("frame-ancestors 'none'");
    });

    it('marks non-HTML responses no-store', () => {
      const wrapped = withSecurityHeaders(
        new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
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
      expect(wrapped.headers.get('Content-Security-Policy-Report-Only')).toContain("frame-ancestors 'none'");
      expect(wrapped.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('still marks HTML noindex by default (indexable option omitted)', () => {
      const wrapped = withSecurityHeaders(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      );
      expect(wrapped.headers.get('X-Robots-Tag')).toBe('noindex');
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
