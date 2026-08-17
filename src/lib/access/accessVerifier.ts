/**
 * Verification boundary for requests that arrive through Cloudflare Access.
 *
 * Access protects the hostname, but the Worker remains the trust boundary: it
 * verifies the assertion and binds its subject to the runtime Access identity
 * before any local account or session operation is attempted.
 */

export interface AccessRequestContext {
  readonly aud: string;
  getIdentity(): Promise<Record<string, unknown> | undefined>;
}

export interface AccessEnvironment {
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly ACCESS_JWKS_URL?: string;
  /** Only the dedicated local crypto harness may omit ctx.access. */
  readonly ENVIRONMENT?: string;
}

export interface VerifiedAccessPrincipal {
  readonly issuer: string;
  readonly subject: string;
}

export class AccessVerificationError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'AccessVerificationError';
  }
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  iat?: unknown;
  nbf?: unknown;
  exp?: unknown;
  type?: unknown;
  service_token_id?: unknown;
  token_type?: unknown;
}

interface CachedJwks {
  keys: Map<string, JsonWebKey>;
  expiresAt: number;
}

const cache = new Map<string, CachedJwks>();
const forcedRefreshAt = new Map<string, number>();
const CACHE_MAX_AGE_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_SIGNATURE_BYTES = 1_024;
const MAX_JWKS_BYTES = 256 * 1_024;
const JWKS_FETCH_TIMEOUT_MS = 3_000;
export const JWKS_REFRESH_COOLDOWN_MS = 30_000;

function fail(): never {
  throw new AccessVerificationError();
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) fail();
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    fail();
  }
}

function decodeJson<T>(value: string): T {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail();
    return parsed as T;
  } catch {
    fail();
  }
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fail();
}

function audienceContains(value: unknown, expected: string): boolean {
  return typeof value === 'string'
    ? value === expected
    : Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string') && value.includes(expected);
}

function validateConfiguration(environment: AccessEnvironment): {
  issuer: string;
  audience: string;
  jwksUrl: string;
  local: boolean;
} {
  const issuer = environment.ACCESS_ISSUER;
  const audience = environment.ACCESS_AUDIENCE;
  const jwksUrl = environment.ACCESS_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) fail();
  let issuerUrl: URL;
  let jwks: URL;
  try {
    issuerUrl = new URL(issuer);
    jwks = new URL(jwksUrl);
  } catch {
    fail();
  }
  const local = environment.ENVIRONMENT === 'local-test';
  const localHttpIssuer = local && issuerUrl.protocol === 'http:' && issuerUrl.hostname === '127.0.0.1';
  const localHttpJwks = local && jwks.protocol === 'http:' && jwks.hostname === '127.0.0.1';
  if ((issuerUrl.protocol !== 'https:' && !localHttpIssuer) || (jwks.protocol !== 'https:' && !localHttpJwks)) fail();
  if (issuerUrl.username || issuerUrl.password || jwks.username || jwks.password) fail();
  return {
    issuer,
    audience,
    jwksUrl,
    local: localHttpIssuer && localHttpJwks && issuerUrl.origin === jwks.origin,
  };
}

function parseJwt(request: Request): {
  encodedHeader: string;
  encodedPayload: string;
  signature: Uint8Array;
  header: JwtHeader;
  claims: JwtClaims;
} {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > MAX_TOKEN_LENGTH || token.includes(',')) fail();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) fail();
  const header = decodeJson<JwtHeader>(parts[0]);
  const claims = decodeJson<JwtClaims>(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  if (signature.length === 0 || signature.length > MAX_SIGNATURE_BYTES) fail();
  return { encodedHeader: parts[0], encodedPayload: parts[1], signature, header, claims };
}

function parseMaxAge(value: string | null): number {
  const match = value?.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  if (!match) return CACHE_MAX_AGE_MS;
  return Math.min(CACHE_MAX_AGE_MS, Math.max(1_000, Number(match[1]) * 1_000));
}

function parseJwks(value: unknown): Map<string, JsonWebKey> {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { keys?: unknown }).keys)) fail();
  const result = new Map<string, JsonWebKey>();
  for (const key of (value as { keys: unknown[] }).keys) {
    if (typeof key !== 'object' || key === null) continue;
    const candidate = key as Record<string, unknown>;
    if (
      candidate.kty === 'RSA' &&
      candidate.alg === 'RS256' &&
      (candidate.use === undefined || candidate.use === 'sig') &&
      typeof candidate.kid === 'string' &&
      candidate.kid.length > 0 &&
      candidate.kid.length <= 256 &&
      typeof candidate.n === 'string' &&
      typeof candidate.e === 'string'
    ) {
      result.set(candidate.kid, candidate as unknown as JsonWebKey);
    }
  }
  if (result.size === 0) fail();
  if (result.size !== (value as { keys: unknown[] }).keys.filter((key) =>
    typeof key === 'object' && key !== null &&
    typeof (key as Record<string, unknown>).kid === 'string' &&
    (key as Record<string, unknown>).kty === 'RSA' &&
    (key as Record<string, unknown>).alg === 'RS256',
  ).length) fail();
  return result;
}

async function fetchJwks(
  url: string,
  fetcher: typeof fetch,
  now: number,
  force: boolean,
): Promise<Map<string, JsonWebKey>> {
  const cached = cache.get(url);
  if (!force && cached && cached.expiresAt > now) return cached.keys;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) fail();
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_JWKS_BYTES) fail();
    const reader = response.body?.getReader();
    if (!reader) fail();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JWKS_BYTES) {
        void reader.cancel().catch(() => undefined);
        fail();
      }
      chunks.push(value);
    }
    const bodyBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bodyBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder().decode(bodyBytes);
    const keys = parseJwks(JSON.parse(body) as unknown);
    cache.set(url, { keys, expiresAt: now + parseMaxAge(response.headers.get('cache-control')) });
    return keys;
  } catch (error) {
    if (error instanceof AccessVerificationError) throw error;
    fail();
  } finally {
    clearTimeout(timer);
  }
}

function validateClaims(
  claims: JwtClaims,
  issuer: string,
  audience: string,
  now: number,
): { issuer: string; subject: string } {
  if (claims.iss !== issuer || !audienceContains(claims.aud, audience)) fail();
  if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0 || claims.sub.length > 512) fail();
  if (claims.type !== 'app' || claims.service_token_id !== undefined || claims.token_type !== undefined) fail();
  const current = now / 1_000;
  const iat = asFiniteNumber(claims.iat);
  const exp = asFiniteNumber(claims.exp);
  if (exp <= current || iat > current + CLOCK_SKEW_SECONDS || iat >= exp) fail();
  const nbf = asFiniteNumber(claims.nbf);
  if (nbf > current + CLOCK_SKEW_SECONDS || nbf >= exp) fail();
  return { issuer, subject: claims.sub };
}

/** Clears a process-local cache in tests or during an explicit key-rotation hook. */
export function clearAccessJwksCache(): void {
  cache.clear();
  forcedRefreshAt.clear();
}

export async function verifyAccessRequest(
  request: Request,
  context: AccessRequestContext | undefined,
  environment: AccessEnvironment,
  options: { now?: number; fetch?: typeof fetch } = {},
): Promise<VerifiedAccessPrincipal> {
  const config = validateConfiguration(environment);
  if (!config.local && !context) fail();
  if (context && context.aud !== config.audience) fail();

  const parsed = parseJwt(request);
  if (parsed.header.alg !== 'RS256' || parsed.header.typ !== 'JWT' || typeof parsed.header.kid !== 'string' || parsed.header.kid.length === 0) fail();
  const now = options.now ?? Date.now();
  const fetcher = options.fetch ?? globalThis.fetch;
  let keys = await fetchJwks(config.jwksUrl, fetcher, now, false);
  let jwk = keys.get(parsed.header.kid);
  if (!jwk) {
    const lastForcedRefresh = forcedRefreshAt.get(config.jwksUrl) ?? Number.NEGATIVE_INFINITY;
    if (now - lastForcedRefresh >= JWKS_REFRESH_COOLDOWN_MS) {
      forcedRefreshAt.set(config.jwksUrl, now);
      keys = await fetchJwks(config.jwksUrl, fetcher, now, true);
      jwk = keys.get(parsed.header.kid);
    }
  }
  if (!jwk) fail();

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      publicKey,
      new Uint8Array(parsed.signature),
      new TextEncoder().encode(`${parsed.encodedHeader}.${parsed.encodedPayload}`),
    );
    if (!valid) fail();
  } catch {
    fail();
  }

  const principal = validateClaims(parsed.claims, config.issuer, config.audience, now);
  if (context) {
    let identity: Record<string, unknown> | undefined;
    try {
      identity = await context.getIdentity();
    } catch {
      fail();
    }
    if (
      !identity ||
      identity.user_uuid !== principal.subject ||
      identity.service_token_status === true ||
      (typeof identity.service_token_id === 'string' && identity.service_token_id.length > 0)
    ) fail();
  }
  return principal;
}
