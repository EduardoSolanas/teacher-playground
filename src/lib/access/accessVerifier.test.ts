import { createServer, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AccessRequestContext,
  AccessVerificationError,
  clearAccessJwksCache,
  JWKS_REFRESH_COOLDOWN_MS,
  verifyAccessRequest,
} from './accessVerifier';

const ISSUER = 'https://local-access.example.test';
const AUDIENCE = 'local-access-audience';

function base64Url(value: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function json(value: unknown): string {
  return base64Url(JSON.stringify(value));
}

async function signToken(
  key: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const encoded = `${json({ alg: 'RS256', kid: 'key-1', typ: 'JWT', ...header })}.${json(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(encoded),
  );
  return `${encoded}.${base64Url(signature)}`;
}

function context(subject = 'human-1', audience = AUDIENCE): AccessRequestContext {
  return {
    aud: audience,
    async getIdentity() {
      return { user_uuid: subject, email: 'human@example.test' };
    },
  };
}

describe('Cloudflare Access request verification', () => {
  let privateKey: CryptoKey;
  let publicJwk: JsonWebKey;
  let jwksKid = 'key-1';
  let server: Server;
  let jwksUrl: string;
  let jwksRequests = 0;
  let jwksResponse: 'normal' | 'malformed' | 'duplicate' | 'oversize' | 'stalled' = 'normal';
  let stalledResponse: ServerResponse | undefined;
  let stalledTimer: ReturnType<typeof setTimeout> | undefined;
  const now = 1_800_000_000_000;

  beforeEach(async () => {
    jwksKid = 'key-1';
    jwksResponse = 'normal';
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    server = createServer((_request, response) => {
      jwksRequests += 1;
      response.setHeader('content-type', 'application/json');
      if (jwksResponse === 'malformed') {
        response.end('{malformed');
        return;
      }
      const key = { ...publicJwk, kid: jwksKid, alg: 'RS256', use: 'sig' };
      if (jwksResponse === 'duplicate') {
        response.end(JSON.stringify({ keys: [key, key] }));
        return;
      }
      if (jwksResponse === 'oversize') {
        response.end(JSON.stringify({ keys: [key], padding: 'x'.repeat(256 * 1_024) }));
        return;
      }
      if (jwksResponse === 'stalled') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"keys":');
        stalledResponse = response;
        stalledTimer = setTimeout(() => response.end('[]'), 10_000);
        return;
      }
      response.end(JSON.stringify({ keys: [key] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
  });

  afterEach(async () => {
    if (stalledTimer) clearTimeout(stalledTimer);
    stalledResponse?.destroy();
    stalledTimer = undefined;
    stalledResponse = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      iss: ISSUER,
      aud: [AUDIENCE],
      sub: 'human-1',
      iat: Math.floor(now / 1_000) - 30,
      nbf: Math.floor(now / 1_000) - 30,
      exp: Math.floor(now / 1_000) + 300,
      type: 'app',
      ...overrides,
    };
  }

  it('accepts a signed human assertion only with matching runtime Access context', async () => {
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(
      new Request('https://app.example.test/api/data', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
  });

  it.each([
    ['missing assertion', undefined, {}],
    ['wrong issuer', null, { iss: 'https://evil.example.test' }],
    ['wrong audience', null, { aud: ['other'] }],
    ['empty subject', null, { sub: '' }],
    ['expired', null, { exp: Math.floor(now / 1_000) - 1 }],
    ['missing nbf', null, { nbf: undefined }],
    ['malformed nbf', null, { nbf: 'not-a-number' }],
    ['malformed iat', null, { iat: 'not-a-number' }],
    ['malformed exp', null, { exp: 'not-a-number' }],
    ['missing iat', null, { iat: undefined }],
    ['missing exp', null, { exp: undefined }],
    ['wrong Access token type', null, { type: 'service' }],
    ['wrong algorithm', { alg: 'HS256' }, {}],
    ['wrong token type', { typ: 'access+jwt' }, {}],
    ['missing key id', { kid: '' }, {}],
    ['service token claim', null, { service_token_id: 'service-1' }],
  ] as Array<[string, Record<string, unknown> | undefined | null, Record<string, unknown>]>)('rejects %s', async (_name, header, override) => {
    const token = header === undefined ? undefined : await signToken(privateKey, claims(override), header ?? undefined);
    const request = new Request('https://app.example.test/api/data', token ? { headers: { 'Cf-Access-Jwt-Assertion': token } } : undefined);
    await expect(verifyAccessRequest(
      request,
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it.each(['null', 'array', 'primitive'] as const)('rejects a %s JWT header shape without leaking a parser error', async (shape) => {
    const malformedHeader = shape === 'null' ? null : shape === 'array' ? [] : 1;
    const token = `${json(malformedHeader)}.${json(claims())}.AA`;
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it.each(['null', 'array', 'primitive'] as const)('rejects a %s JWT claims shape without leaking a parser error', async (shape) => {
    const malformedClaims = shape === 'null' ? null : shape === 'array' ? [] : 1;
    const token = `${json({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })}.${json(malformedClaims)}.AA`;
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects a forged runtime identity and an audience mismatch', async () => {
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      context('different-subject'),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      context('human-1', 'wrong-runtime-audience'),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects service-token runtime identity and refreshes once for a rotated key', async () => {
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      {
        aud: AUDIENCE,
        async getIdentity() {
          return { user_uuid: 'human-1', service_token_status: true };
        },
      },
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('bounds forced JWKS refreshes for repeated unknown key ids', async () => {
    clearAccessJwksCache();
    const before = jwksRequests;
    const first = await signToken(privateKey, claims(), { kid: 'unknown-key' });
    const request = () => verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': first } }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    );
    await expect(request()).rejects.toBeInstanceOf(AccessVerificationError);
    await expect(request()).rejects.toBeInstanceOf(AccessVerificationError);
    await expect(request()).rejects.toBeInstanceOf(AccessVerificationError);
    expect(jwksRequests - before).toBe(2);
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': first } }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now: now + JWKS_REFRESH_COOLDOWN_MS, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
    expect(jwksRequests - before).toBe(3);
  });

  it('accepts a rotated signing key after a forced refresh', async () => {
    clearAccessJwksCache();
    const first = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': first } }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
    const rotated = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    publicJwk = await crypto.subtle.exportKey('jwk', rotated.publicKey);
    jwksKid = 'key-2';
    const rotatedToken = await signToken(rotated.privateKey, claims(), { kid: 'key-2' });
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': rotatedToken } }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now: now + 1, fetch: globalThis.fetch },
    )).resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
  });

  it.each(['malformed', 'duplicate', 'oversize'] as const)('fails closed for %s JWKS responses', async (responseKind) => {
    clearAccessJwksCache();
    jwksResponse = responseKind;
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('fails closed within the JWKS deadline when the response body stalls after headers', async () => {
    clearAccessJwksCache();
    jwksResponse = 'stalled';
    const token = await signToken(privateKey, claims());
    const started = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('JWKS body exceeded deadline')), 4_250);
        verifyAccessRequest(
          new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
          context(),
          { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
          { now, fetch: globalThis.fetch },
        ).then(resolve, reject);
      })).rejects.toBeInstanceOf(AccessVerificationError);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    expect(Date.now() - started).toBeLessThan(4_250);
  });

  it('verifies a token from the real ephemeral local issuer process', async () => {
    const portServer = createServer();
    await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to allocate local issuer port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
    const child: ChildProcess = spawn(process.execPath, [resolve(process.cwd(), 'scripts/local-access-issuer.mjs')], {
      env: { ...process.env, LOCAL_ACCESS_PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      let token: string | undefined;
      for (let attempt = 0; attempt < 30 && !token; attempt += 1) {
        try {
          const health = await fetch(`http://127.0.0.1:${port}/health`);
          if (health.ok) {
            token = ((await (await fetch(`http://127.0.0.1:${port}/token?sub=process-human`)).json()) as { token: string }).token;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!token) throw new Error('local issuer did not start');
      await expect(verifyAccessRequest(
        new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
        undefined,
        { ENVIRONMENT: 'local-test', ACCESS_ISSUER: `http://127.0.0.1:${port}`, ACCESS_AUDIENCE: 'teacher-playground-local', ACCESS_JWKS_URL: `http://127.0.0.1:${port}/jwks` },
      )).resolves.toEqual({ issuer: `http://127.0.0.1:${port}`, subject: 'process-human' });
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      });
    }
  });

  it.each([
    ['https issuer with local HTTP JWKS', 'https-local-jwks'],
    ['localhost issuer', 'localhost'],
    ['mixed loopback ports', 'different-port'],
    ['HTTPS JWKS', 'https-jwks'],
  ] as const)('requires runtime Access context for %s even in local-test', async (_name, variant) => {
    const port = new URL(jwksUrl).port;
    const issuer = variant === 'localhost' ? `http://localhost:${port}`
      : variant === 'different-port' ? `http://127.0.0.1:${Number(port) + 1}`
        : ISSUER;
    const jwks = variant === 'https-jwks' ? 'https://local-access.example.test/jwks' : jwksUrl;
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      undefined,
      { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwks, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('does not allow context omission outside the dedicated same-origin loopback issuer', async () => {
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      undefined,
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });
});
