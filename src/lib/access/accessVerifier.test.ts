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
  let jwksResponse:
    | 'normal'
    | 'malformed'
    | 'duplicate'
    | 'oversize'
    | 'stalled'
    | 'chunked-oversize'
    | 'server-error'
    | 'empty'
    | 'exact-max' = 'normal';
  let jwksBody: string | null = null;
  let jwksCacheControl: string | null = null;
  let jwksRequiresAccept = false;
  let stalledResponse: ServerResponse | undefined;
  let stalledTimer: ReturnType<typeof setTimeout> | undefined;
  const now = 1_800_000_000_000;

  beforeEach(async () => {
    jwksKid = 'key-1';
    jwksResponse = 'normal';
    jwksBody = null;
    jwksCacheControl = null;
    jwksRequiresAccept = false;
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    server = createServer((request, response) => {
      jwksRequests += 1;
      if (jwksRequiresAccept && request.headers.accept !== 'application/json') {
        response.statusCode = 400;
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      const key = { ...publicJwk, kid: jwksKid, alg: 'RS256', use: 'sig' };
      if (jwksResponse === 'server-error') {
        response.statusCode = 500;
        response.end(JSON.stringify({ keys: [key] }));
        return;
      }
      if (jwksResponse === 'empty') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (jwksResponse === 'malformed') {
        response.end('{malformed');
        return;
      }
      if (jwksBody !== null) {
        response.end(jwksBody);
        return;
      }
      if (jwksCacheControl !== null) {
        response.setHeader('cache-control', jwksCacheControl);
      }
      if (jwksResponse === 'duplicate') {
        response.end(JSON.stringify({ keys: [key, key] }));
        return;
      }
      if (jwksResponse === 'oversize') {
        response.end(JSON.stringify({ keys: [key], padding: 'x'.repeat(256 * 1_024) }));
        return;
      }
      if (jwksResponse === 'chunked-oversize') {
        response.write(JSON.stringify({ keys: [key], padding: 'x'.repeat(300 * 1_024) }));
        response.end();
        return;
      }
      if (jwksResponse === 'exact-max') {
        const body = JSON.stringify({ keys: [key] });
        response.end(body + ' '.repeat(256 * 1_024 - body.length));
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

  function localEnvironment(overrides: Record<string, string | undefined> = {}): {
    ACCESS_ISSUER: string | undefined;
    ACCESS_AUDIENCE: string | undefined;
    ACCESS_JWKS_URL: string | undefined;
    ENVIRONMENT: string | undefined;
  } {
    return {
      ACCESS_ISSUER: ISSUER,
      ACCESS_AUDIENCE: AUDIENCE,
      ACCESS_JWKS_URL: jwksUrl,
      ENVIRONMENT: 'local-test',
      ...overrides,
    };
  }

  function requestFor(token: string | undefined): Request {
    return new Request('https://app.example.test/api/data', token === undefined
      ? undefined
      : { headers: { 'Cf-Access-Jwt-Assertion': token } });
  }

  async function verifyJwksCacheLifetime(cacheControl: string | null, lifetimeMs: number): Promise<void> {
    clearAccessJwksCache();
    jwksCacheControl = cacheControl;
    const token = await signToken(privateKey, claims({ exp: Math.floor(now / 1_000) + 86_400 }));
    const verifyAt = (time: number) => verifyAccessRequest(
      requestFor(token),
      context(),
      localEnvironment(),
      { now: time, fetch: globalThis.fetch },
    );
    await expect(verifyAt(now)).resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
    const fetches = jwksRequests;
    await expect(verifyAt(now + lifetimeMs - 1)).resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
    expect(jwksRequests).toBe(fetches);
    await expect(verifyAt(now + lifetimeMs)).resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
    expect(jwksRequests).toBe(fetches + 1);
  }

  it('exposes the verified IdP full name and email without using email as the display name', async () => {
    const token = await signToken(privateKey, claims({
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    }));
    await expect(verifyAccessRequest(
      new Request('https://app.example.test/api/data', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    )).resolves.toEqual({
      issuer: ISSUER,
      subject: 'human-1',
      displayName: 'Ada Lovelace',
      email: 'ada@example.test',
    });
  });

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
      requestFor(token),
      context('different-subject'),
      localEnvironment(),
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
    await expect(verifyAccessRequest(
      requestFor(token),
      context('human-1', 'wrong-runtime-audience'),
      localEnvironment(),
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
    ['localhost issuer', 'localhost'],
    ['mixed loopback ports', 'different-port'],
    ['HTTPS JWKS', 'https-jwks'],
  ] as const)('rejects %s in local-test (invalid config)', async (_name, variant) => {
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

  it('accepts a valid JWT even when ctx.access is unavailable (old compat date)', async () => {
    const token = await signToken(privateKey, claims());
    const principal = await verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      undefined,
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    );
    expect(principal.subject).toBe('human-1');
  });

  it('accepts a JWT whose header omits the optional typ field (RFC 7519 §5.1)', async () => {
    const token = await signToken(privateKey, claims(), { typ: undefined });
    const principal = await verifyAccessRequest(
      new Request('https://app.example.test', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      context(),
      { ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE, ACCESS_JWKS_URL: jwksUrl, ENVIRONMENT: 'local-test' },
      { now, fetch: globalThis.fetch },
    );
    expect(principal.subject).toBe('human-1');
  });

  it('fails with the generic AccessVerificationError name and message', async () => {
    await expect(verifyAccessRequest(
      requestFor(undefined),
      context(),
      localEnvironment(),
      { now, fetch: globalThis.fetch },
    )).rejects.toMatchObject({ name: 'AccessVerificationError', message: 'Unauthorized' });
  });

  it('rejects configuration that omits any Access binding', async () => {
    const token = await signToken(privateKey, claims());
    for (const environment of [
      localEnvironment({ ACCESS_ISSUER: undefined }),
      localEnvironment({ ACCESS_AUDIENCE: undefined }),
      localEnvironment({ ACCESS_JWKS_URL: undefined }),
    ]) {
      await expect(verifyAccessRequest(requestFor(token), context(), environment, { now, fetch: globalThis.fetch }))
        .rejects.toBeInstanceOf(AccessVerificationError);
    }
  });

  it('rejects Access bindings that are not absolute URLs', async () => {
    const token = await signToken(privateKey, claims());
    for (const environment of [
      localEnvironment({ ACCESS_ISSUER: 'not-a-url' }),
      localEnvironment({ ACCESS_JWKS_URL: 'not-a-url' }),
    ]) {
      await expect(verifyAccessRequest(requestFor(token), context(), environment, { now, fetch: globalThis.fetch }))
        .rejects.toBeInstanceOf(AccessVerificationError);
    }
  });

  it('rejects plaintext loopback bindings outside local-test even with a matching issuer', async () => {
    const port = new URL(jwksUrl).port;
    const issuer = `http://127.0.0.1:${port}`;
    const token = await signToken(privateKey, claims({ iss: issuer }));
    await expect(verifyAccessRequest(
      requestFor(token),
      context(),
      {
        ACCESS_ISSUER: issuer,
        ACCESS_AUDIENCE: AUDIENCE,
        ACCESS_JWKS_URL: jwksUrl,
        ENVIRONMENT: 'production',
      },
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects a local-test issuer whose scheme is neither https nor loopback http even with a matching issuer', async () => {
    const issuer = 'ftp://127.0.0.1:2121';
    const token = await signToken(privateKey, claims({ iss: issuer }));
    await expect(verifyAccessRequest(
      requestFor(token),
      context(),
      localEnvironment({ ACCESS_ISSUER: issuer }),
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects a local-test JWKS URL whose scheme is neither https nor loopback http even with a matching issuer', async () => {
    const issuer = `http://127.0.0.1:${new URL(jwksUrl).port}`;
    const token = await signToken(privateKey, claims({ iss: issuer }));
    await expect(verifyAccessRequest(
      requestFor(token),
      context(),
      localEnvironment({ ACCESS_ISSUER: issuer, ACCESS_JWKS_URL: 'ftp://127.0.0.1:2121/jwks' }),
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects an issuer host that is a loopback alias other than 127.0.0.1 even with a matching issuer', async () => {
    const port = new URL(jwksUrl).port;
    const issuer = `http://localhost:${port}`;
    const token = await signToken(privateKey, claims({ iss: issuer }));
    await expect(verifyAccessRequest(
      requestFor(token),
      context(),
      localEnvironment({ ACCESS_ISSUER: issuer }),
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects embedded credentials in each Access binding URL even with matching claims', async () => {
    const port = new URL(jwksUrl).port;
    const host = `127.0.0.1:${port}`;
    const credentialCases: Array<[string, string, string]> = [
      [`http://user@${host}`, jwksUrl, `http://user@${host}`],
      [`http://:pass@${host}`, jwksUrl, `http://:pass@${host}`],
      [`http://${host}`, `http://user@${host}/jwks`, `http://${host}`],
      [`http://${host}`, `http://:pass@${host}/jwks`, `http://${host}`],
    ];
    for (const [issuer, jwks, tokenIssuer] of credentialCases) {
      const token = await signToken(privateKey, claims({ iss: tokenIssuer }));
      await expect(verifyAccessRequest(
        requestFor(token),
        context(),
        localEnvironment({ ACCESS_ISSUER: issuer, ACCESS_JWKS_URL: jwks }),
        { now, fetch: globalThis.fetch },
      )).rejects.toBeInstanceOf(AccessVerificationError);
    }
  });

  it('requests the JWKS document with a JSON Accept header', async () => {
    clearAccessJwksCache();
    jwksRequiresAccept = true;
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
  });

  it.each([
    ['null body', 'null'],
    ['array body', '[]'],
    ['primitive body', '1'],
    ['missing keys', '{}'],
    ['keys that are not an array', '{"keys":"nope"}'],
    ['empty keys', '{"keys":[]}'],
    ['keys with non-object entries', '{"keys":[null,1,"x"]}'],
    ['keys missing n and e', '{"keys":[{"kty":"RSA","alg":"RS256","kid":"key-1"}]}'],
  ])('fails closed for a JWKS response with %s', async (_name, body) => {
    clearAccessJwksCache();
    jwksBody = body;
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects a JWKS key that is explicitly marked for encryption', async () => {
    clearAccessJwksCache();
    jwksBody = JSON.stringify({ keys: [{ ...publicJwk, kid: jwksKid, alg: 'RS256', use: 'enc' }] });
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects a JWKS key advertised for a different RS256-adjacent algorithm', async () => {
    clearAccessJwksCache();
    jwksBody = JSON.stringify({ keys: [{ ...publicJwk, kid: jwksKid, alg: 'RS512', use: 'sig' }] });
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects a JWKS kid longer than 256 characters', async () => {
    clearAccessJwksCache();
    const longKid = 'k'.repeat(257);
    jwksBody = JSON.stringify({ keys: [{ ...publicJwk, kid: longKid, alg: 'RS256', use: 'sig' }] });
    const token = await signToken(privateKey, claims(), { kid: longKid });
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('accepts a JWKS key that omits use and a kid of exactly 256 characters', async () => {
    clearAccessJwksCache();
    const longKid = 'k'.repeat(256);
    jwksBody = JSON.stringify({ keys: [{ ...publicJwk, kid: longKid, alg: 'RS256' }] });
    const token = await signToken(privateKey, claims(), { kid: longKid });
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
  });

  it('accepts a JWKS body declared at exactly the maximum size', async () => {
    clearAccessJwksCache();
    jwksResponse = 'exact-max';
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
  });

  it('fails closed when a chunked JWKS body exceeds the maximum without a content-length', async () => {
    clearAccessJwksCache();
    jwksResponse = 'chunked-oversize';
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('fails closed when the JWKS endpoint returns an error status even with a parseable body', async () => {
    clearAccessJwksCache();
    jwksResponse = 'server-error';
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('fails closed when a JWKS response has no body stream', async () => {
    clearAccessJwksCache();
    jwksResponse = 'empty';
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it.each([
    ['max-age=60', 60_000],
    ['public, max-age=120', 120_000],
    ['max-age = 60', 60_000],
    ['max-age=0', 1_000],
    ['max-age=999999', 300_000],
    ['x-max-age=60', 300_000],
    ['max-age=abc', 300_000],
    ['no-cache', 300_000],
    [null, 300_000],
  ] as Array<[string | null, number]>)('honors Cache-Control %s with a %i ms JWKS cache lifetime', async (cacheControl, lifetime) => {
    await verifyJwksCacheLifetime(cacheControl, lifetime);
  });

  it('clears both the JWKS cache and the forced-refresh cooldown on demand', async () => {
    clearAccessJwksCache();
    const token = await signToken(privateKey, claims());
    const verifyAt = (time: number) => verifyAccessRequest(
      requestFor(token),
      context(),
      localEnvironment(),
      { now: time, fetch: globalThis.fetch },
    );
    await verifyAt(now);
    const fetches = jwksRequests;
    await verifyAt(now);
    expect(jwksRequests).toBe(fetches);
    clearAccessJwksCache();
    await verifyAt(now);
    expect(jwksRequests).toBe(fetches + 1);

    const unknownKid = await signToken(privateKey, claims(), { kid: 'missing-kid' });
    const verifyUnknown = () => verifyAccessRequest(
      requestFor(unknownKid),
      context(),
      localEnvironment(),
      { now, fetch: globalThis.fetch },
    );
    clearAccessJwksCache();
    await expect(verifyUnknown()).rejects.toBeInstanceOf(AccessVerificationError);
    const afterFirstUnknown = jwksRequests;
    await expect(verifyUnknown()).rejects.toBeInstanceOf(AccessVerificationError);
    expect(jwksRequests).toBe(afterFirstUnknown);
    clearAccessJwksCache();
    await expect(verifyUnknown()).rejects.toBeInstanceOf(AccessVerificationError);
    expect(jwksRequests).toBe(afterFirstUnknown + 2);
  });

  it.each([
    ['', 'empty assertion'],
    ['abc', 'single segment'],
    ['a.b', 'two segments'],
    ['a.b.c.d', 'four segments'],
    ['a..c', 'empty payload segment'],
    ['.b.c', 'empty header segment'],
    ['a.b.', 'empty signature segment'],
  ])('rejects the malformed token %s (%s)', async (token) => {
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects a token with a fourth segment even when the first three verify', async () => {
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(requestFor(`${token}.extra`), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects an invalid subject even when the runtime identity echoes it', async () => {
    const subjects: unknown[] = ['', '   ', 'a'.repeat(513), 42];
    for (const sub of subjects) {
      const token = await signToken(privateKey, claims({ sub }));
      await expect(verifyAccessRequest(
        requestFor(token),
        context(sub as string),
        localEnvironment(),
        { now, fetch: globalThis.fetch },
      )).rejects.toBeInstanceOf(AccessVerificationError);
    }
  });

  it('rejects iat or nbf at exp even inside the clock skew', async () => {
    const current = Math.floor(now / 1_000);
    for (const override of [
      { iat: current + 30, exp: current + 30 },
      { nbf: current + 30, exp: current + 30 },
    ]) {
      const token = await signToken(privateKey, claims(override));
      await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
        .rejects.toBeInstanceOf(AccessVerificationError);
    }
  });

  it('rejects a token whose signature does not cover its header and payload', async () => {
    const token = await signToken(privateKey, claims());
    const [header, payload, signature] = token.split('.');
    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    await expect(verifyAccessRequest(requestFor(`${header}.${payload}.${flipped}`), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
    const otherPayload = json(claims({ sub: 'human-2' }));
    await expect(verifyAccessRequest(requestFor(`${header}.${otherPayload}.${signature}`), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('accepts a token exactly at the maximum length and rejects one character more', async () => {
    clearAccessJwksCache();
    const sample = await signToken(privateKey, claims());
    const signatureLength = sample.split('.')[2].length;
    const tokenOfLength = async (target: number): Promise<string> => {
      const lengthFor = (headerSize: number, pad: number) =>
        headerSize + 2 + json(claims({ pad: 'p'.repeat(pad) })).length + signatureLength;
      for (let headerPad = 0; headerPad < 8; headerPad += 1) {
        const header = { alg: 'RS256', kid: 'key-1', typ: 'JWT', x: 'p'.repeat(headerPad) };
        const headerSize = json(header).length;
        let low = 0;
        let high = 40_000;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const length = lengthFor(headerSize, mid);
          if (length === target) return signToken(privateKey, claims({ pad: 'p'.repeat(mid) }), header);
          if (length < target) low = mid + 1;
          else high = mid - 1;
        }
        for (const pad of [low, low - 1, low - 2, low - 3]) {
          if (pad < 0) continue;
          if (lengthFor(headerSize, pad) === target) {
            return signToken(privateKey, claims({ pad: 'p'.repeat(pad) }), header);
          }
        }
      }
      throw new Error(`could not build a token of length ${target}`);
    };
    const maxToken = await tokenOfLength(16_384);
    expect(maxToken.length).toBe(16_384);
    await expect(verifyAccessRequest(requestFor(maxToken), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
    const overLong = await tokenOfLength(16_385);
    await expect(verifyAccessRequest(requestFor(overLong), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it.each([
    ['missing Access type', null, { type: undefined }],
    ['service token type claim', null, { token_type: 'access' }],
    ['null token type claim', null, { token_type: null }],
    ['whitespace subject', null, { sub: '   ' }],
    ['non-string subject', null, { sub: 42 }],
    ['subject over 512 characters', null, { sub: 'a'.repeat(513) }],
    ['exp equal to now', null, { exp: Math.floor(now / 1_000) }],
    ['iat beyond the clock skew', null, { iat: Math.floor(now / 1_000) + 61 }],
    ['nbf beyond the clock skew', null, { nbf: Math.floor(now / 1_000) + 61 }],
    ['iat at exp', null, { exp: Math.floor(now / 1_000) + 300, iat: Math.floor(now / 1_000) + 300 }],
    ['iat after exp', null, { exp: Math.floor(now / 1_000) + 300, iat: Math.floor(now / 1_000) + 400 }],
    ['nbf at exp', null, { exp: Math.floor(now / 1_000) + 300, nbf: Math.floor(now / 1_000) + 300 }],
    ['array subject', null, { sub: [] }],
    ['boolean iat', null, { iat: true }],
    ['array iat', null, { iat: [] }],
    ['empty audience array', null, { aud: [] }],
    ['audience array with a non-string member', null, { aud: [AUDIENCE, 7] }],
    ['non-string audience', null, { aud: 42 }],
    ['wrong string audience', null, { aud: 'other-audience' }],
  ] as Array<[string, Record<string, unknown> | undefined | null, Record<string, unknown>]>)('rejects %s', async (_name, header, override) => {
    const token = header === undefined ? undefined : await signToken(privateKey, claims(override), header ?? undefined);
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects an empty audience array from an otherwise valid signed token', async () => {
    const token = await signToken(privateKey, claims({ aud: [] }));
    await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('accepts the skew and subject length boundaries just inside the limits', async () => {
    const current = Math.floor(now / 1_000);
    const token = await signToken(privateKey, claims({
      sub: 's'.repeat(512),
      iat: current + 60,
      nbf: current + 60,
      exp: current + 3_600,
    }));
    await expect(verifyAccessRequest(requestFor(token), context('s'.repeat(512)), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 's'.repeat(512) });
  });

  it('accepts a string audience and an audience array holding the expected value', async () => {
    for (const aud of [AUDIENCE, ['other-audience', AUDIENCE]] as unknown[]) {
      const token = await signToken(privateKey, claims({ aud }));
      await expect(verifyAccessRequest(requestFor(token), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
        .resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
    }
  });

  it('bounds the operator email by length without rejecting the token', async () => {
    const maxEmail = 'e'.repeat(512);
    const withMax = await signToken(privateKey, claims({ email: maxEmail }));
    await expect(verifyAccessRequest(requestFor(withMax), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 'human-1', email: maxEmail });
    const tooLong = await signToken(privateKey, claims({ email: 'e'.repeat(513) }));
    await expect(verifyAccessRequest(requestFor(tooLong), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
    const empty = await signToken(privateKey, claims({ email: '' }));
    await expect(verifyAccessRequest(requestFor(empty), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
    const single = await signToken(privateKey, claims({ email: 'e' }));
    await expect(verifyAccessRequest(requestFor(single), context(), localEnvironment(), { now, fetch: globalThis.fetch }))
      .resolves.toEqual({ issuer: ISSUER, subject: 'human-1', email: 'e' });
  });

  it('rejects a missing, throwing, or service-token runtime identity', async () => {
    const token = await signToken(privateKey, claims());
    await expect(verifyAccessRequest(
      requestFor(token),
      { aud: AUDIENCE, async getIdentity() { return undefined; } },
      localEnvironment(),
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
    await expect(verifyAccessRequest(
      requestFor(token),
      { aud: AUDIENCE, async getIdentity() { throw new Error('runtime identity unavailable'); } },
      localEnvironment(),
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
    await expect(verifyAccessRequest(
      requestFor(token),
      { aud: AUDIENCE, async getIdentity() { return { user_uuid: 'human-1', service_token_id: 'service-1' }; } },
      localEnvironment(),
      { now, fetch: globalThis.fetch },
    )).rejects.toBeInstanceOf(AccessVerificationError);
    await expect(verifyAccessRequest(
      requestFor(token),
      { aud: AUDIENCE, async getIdentity() { return { user_uuid: 'human-1', service_token_id: '' }; } },
      localEnvironment(),
      { now, fetch: globalThis.fetch },
    )).resolves.toEqual({ issuer: ISSUER, subject: 'human-1' });
  });
});
