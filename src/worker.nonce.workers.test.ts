import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { accessFetch, authenticatedFetch, bootstrapLocalSession } from './test/workerAuth';

const BASE = 'https://example.com';

function extractScriptSrcDirective(csp: string | null): string {
  if (!csp) return '';
  return csp.split(';').find((d) => d.includes('script-src'))?.trim() ?? '';
}

function extractNonceFromCsp(csp: string | null): string | null {
  const match = /nonce-([a-f0-9]+)/.exec(csp ?? '');
  return match ? match[1] : null;
}

describe('CSP nonce wiring through the real Worker (SEC-CSP)', () => {
  it('stamps /whiteboard HTML with a CSP nonce and nonce attributes on every script tag', async () => {
    const session = await bootstrapLocalSession('nonce-whiteboard');
    const response = await authenticatedFetch('/whiteboard', session);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = extractNonceFromCsp(csp);
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("'strict-dynamic'");
    expect(extractScriptSrcDirective(csp)).not.toContain("'unsafe-inline'");

    const body = await response.text();
    const scripts = body.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it('stamps /whiteboard/<roomId> HTML with a CSP nonce', async () => {
    const session = await bootstrapLocalSession('nonce-room-page');
    const response = await authenticatedFetch('/whiteboard/test-room-abc', session);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const nonce = extractNonceFromCsp(response.headers.get('content-security-policy'));
    expect(nonce).toBeTruthy();

    const body = await response.text();
    const scripts = body.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it('generates a unique nonce per request', async () => {
    const session = await bootstrapLocalSession('nonce-unique');
    const r1 = await authenticatedFetch('/whiteboard', session);
    const r2 = await authenticatedFetch('/whiteboard', session);
    const n1 = extractNonceFromCsp(r1.headers.get('content-security-policy'));
    const n2 = extractNonceFromCsp(r2.headers.get('content-security-policy'));
    expect(n1).toBeTruthy();
    expect(n2).toBeTruthy();
    expect(n1).not.toBe(n2);
  });

  it('stamps public marketing HTML pages with a nonce', async () => {
    const response = await SELF.fetch(`${BASE}/`);
    expect(response.status).toBe(200);

    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = extractNonceFromCsp(csp);
    if (response.headers.get('content-type')?.includes('text/html')) {
      expect(nonce).toBeTruthy();
      expect(csp).toContain("'strict-dynamic'");
    }
  });

  it('does not put a nonce on non-HTML API responses', async () => {
    const session = await bootstrapLocalSession('nonce-api-check');
    const response = await authenticatedFetch('/auth/session/current', session);
    expect(response.headers.get('content-type')).toContain('application/json');
    const nonce = extractNonceFromCsp(response.headers.get('content-security-policy'));
    expect(nonce).toBeNull();
  });

  it('sets Cache-Control no-store on every HTML response', async () => {
    const session = await bootstrapLocalSession('nonce-cache');
    const response = await authenticatedFetch('/whiteboard', session);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('matches the CSP nonce with nonce attributes in the HTML body', async () => {
    const session = await bootstrapLocalSession('nonce-match');
    const response = await authenticatedFetch('/whiteboard', session);

    const cspNonce = extractNonceFromCsp(response.headers.get('content-security-policy'));
    expect(cspNonce).toBeTruthy();

    const body = await response.text();
    const bodyNonces = [...body.matchAll(/nonce="([a-f0-9]+)"/g)].map((m) => m[1]);
    expect(bodyNonces.length).toBeGreaterThan(0);
    for (const n of bodyNonces) {
      expect(n).toBe(cspNonce);
    }
  });

  it('preserves all original inline and external script tags after nonce stamping', async () => {
    const session = await bootstrapLocalSession('nonce-preserve');
    const response = await authenticatedFetch('/whiteboard', session);
    const body = await response.text();

    expect(body).toContain('self.__next_f');
    expect(body).toContain('/_next/static/chunks/webpack');
    expect(body).toContain('/_next/static/chunks/main-app');
  });

  it('does not double-stamp scripts that already have a nonce attribute', async () => {
    const session = await bootstrapLocalSession('nonce-no-double');
    const response = await authenticatedFetch('/whiteboard', session);
    const body = await response.text();
    const scripts = body.match(/<script[^>]*>/g) ?? [];
    for (const tag of scripts) {
      const nonceMatches = tag.match(/nonce="/g) ?? [];
      expect(nonceMatches.length).toBe(1);
    }
  });
});
