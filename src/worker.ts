export { RoomDO } from './do/RoomDO';
export { IdentityDO } from './do/IdentityDO';
import {
  AccessVerificationError,
  verifyAccessRequest,
  type VerifiedAccessPrincipal,
} from './lib/access/accessVerifier';
import {
  ACCESS_LOGOUT_PATH,
  CF_ACCESS_LOGOUT_PATH,
  clearCfAuthorizationSetCookie,
  safeRedirectPath,
} from './lib/access/accessLogoutUrl';
import { IdentityDO, getIdentityObject } from './do/IdentityDO';
import { createRateLimiter } from './lib/http/rateLimit';
import {
  parseGuestSessionCookie,
  parseSessionCookie,
  sessionAllowsDestructiveAction,
  type ValidatedSession,
} from './lib/identity/sessionStore';
import { logAuthEvent, type AuthEventInput } from './lib/security/authEvents';
import {
  bodyTooLarge,
  isJsonContentType,
  isRouteAllowedOnHost,
  readBoundedJsonBody,
  isPublicPath,
  isValidRoomId,
  MARKETING_PAGES,
  routeHostKind,
  stripForwardedIdentityHeaders,
  connectSrcForPageOrigin,
  withSecurityHeaders,
  withNonceHtmlSecurityHeaders,
} from './lib/worker/requestGuard';

export interface Env {
  ROOMS: DurableObjectNamespace;
  IDENTITY: DurableObjectNamespace;
  ASSETS: Fetcher;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_JWKS_URL?: string;
  ENVIRONMENT?: string;
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  /** Exact teacher hostname. Unset (with GUEST_HOSTNAME) disables the guest surface. */
  TEACHER_HOSTNAME?: string;
  /** Exact guest hostname. Unset disables the guest surface — never default to guest. */
  GUEST_HOSTNAME?: string;
}

// Room ids cannot be enumerated at build time, so the static export contains a
// single placeholder page that stands in for every room.
const ROOM_PAGE = /^\/whiteboard\/[^/]+\/?$/;
const ROOM_PLACEHOLDER = '/whiteboard/_room';

const ROOM_API = /^\/api\/whiteboard\/room\/([^/]+)(\/.*)?$/;
const AV_TOKEN = '/api/av/token';
const SESSION_ISSUE = '/auth/session';
const SESSION_CURRENT = '/auth/session/current';
const SESSION_CONFIRM = '/auth/session/confirm';
const SESSION_LOGOUT = '/auth/session/logout';
const ACCOUNT_EXPORT = '/auth/account/export';
const ACCOUNT_ERASE = '/auth/account';
const ACCOUNT_PROFILE = '/auth/account/profile';
const ACCOUNT_ROOMS = '/api/whiteboard/rooms';
const AUTH_GUEST = '/auth/guest';
const IDENTITY_ACCOUNT_ROOMS = 'https://identity/accounts/rooms';
const IDENTITY_GUESTS_PURGE = 'https://identity/guests/purge';

/** Room-creation POSTs per verified account within a one-minute window (SEC-005). */
const ROOM_CREATE_RATE_WINDOW_MS = 60_000;
const ROOM_CREATE_RATE_MAX = 10;
const productionRoomCreateLimiter = createRateLimiter({
  windowMs: ROOM_CREATE_RATE_WINDOW_MS,
  max: ROOM_CREATE_RATE_MAX,
});
const strictLocalTestRoomCreateLimiter = createRateLimiter({
  windowMs: ROOM_CREATE_RATE_WINDOW_MS,
  max: ROOM_CREATE_RATE_MAX,
});

/** Access-request POSTs per verified account within a one-minute window (SEC-005). */
const ACCESS_REQUEST_RATE_WINDOW_MS = 60_000;
const ACCESS_REQUEST_RATE_MAX = 20;
const productionAccessRequestLimiter = createRateLimiter({
  windowMs: ACCESS_REQUEST_RATE_WINDOW_MS,
  max: ACCESS_REQUEST_RATE_MAX,
});
const strictLocalTestAccessRequestLimiter = createRateLimiter({
  windowMs: ACCESS_REQUEST_RATE_WINDOW_MS,
  max: ACCESS_REQUEST_RATE_MAX,
});

function roomCreateLimiterFor(env: Env) {
  return env.ENVIRONMENT === 'local-test'
    ? strictLocalTestRoomCreateLimiter
    : productionRoomCreateLimiter;
}

function accessRequestLimiterFor(env: Env) {
  return env.ENVIRONMENT === 'local-test'
    ? strictLocalTestAccessRequestLimiter
    : productionAccessRequestLimiter;
}

/**
 * Presence POSTs (join/heartbeat and kick/suspend) per account per minute (SEC-017).
 * Kick shares this cap so the Worker can limit without cloning/parsing JSON.
 */
const PRESENCE_POST_RATE_WINDOW_MS = 60_000;
const PRESENCE_POST_RATE_MAX = 30;
const productionPresencePostLimiter = createRateLimiter({
  windowMs: PRESENCE_POST_RATE_WINDOW_MS,
  max: PRESENCE_POST_RATE_MAX,
});
const strictLocalTestPresencePostLimiter = createRateLimiter({
  windowMs: PRESENCE_POST_RATE_WINDOW_MS,
  max: PRESENCE_POST_RATE_MAX,
});

function presencePostLimiterFor(env: Env) {
  return env.ENVIRONMENT === 'local-test'
    ? strictLocalTestPresencePostLimiter
    : productionPresencePostLimiter;
}

/** Existing-room scene POSTs (POST /room/:id empty subpath) per account per minute (SEC-005). */
const SCENE_WRITE_RATE_WINDOW_MS = 60_000;
const SCENE_WRITE_RATE_MAX = 120;
const productionSceneWriteLimiter = createRateLimiter({
  windowMs: SCENE_WRITE_RATE_WINDOW_MS,
  max: SCENE_WRITE_RATE_MAX,
});
const strictLocalTestSceneWriteLimiter = createRateLimiter({
  windowMs: SCENE_WRITE_RATE_WINDOW_MS,
  max: SCENE_WRITE_RATE_MAX,
});

function sceneWriteLimiterFor(env: Env) {
  return env.ENVIRONMENT === 'local-test'
    ? strictLocalTestSceneWriteLimiter
    : productionSceneWriteLimiter;
}

/** Guest join POSTs per client IP within a one-minute window. */
const GUEST_AUTH_RATE_WINDOW_MS = 60_000;
const GUEST_AUTH_RATE_MAX = 5;
const productionGuestAuthLimiter = createRateLimiter({
  windowMs: GUEST_AUTH_RATE_WINDOW_MS,
  max: GUEST_AUTH_RATE_MAX,
});
const strictLocalTestGuestAuthLimiter = createRateLimiter({
  windowMs: GUEST_AUTH_RATE_WINDOW_MS,
  max: GUEST_AUTH_RATE_MAX,
});

function guestAuthLimiterFor(env: Env) {
  return env.ENVIRONMENT === 'local-test'
    ? strictLocalTestGuestAuthLimiter
    : productionGuestAuthLimiter;
}

function guestAuthRateKey(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP')?.trim();
  return ip && ip.length > 0 ? ip : 'unknown';
}

function shouldRateLimitRoomCreate(env: Env, request: Request): boolean {
  if (env.ENVIRONMENT !== 'local-test') return true;
  return request.headers.get('x-test-strict-rate-limit') === '1';
}

type AuthEventWriter = (line: string) => void;
const defaultAuthEventWriter: AuthEventWriter = (line) => console.info(line);
let authEventWriter: AuthEventWriter = defaultAuthEventWriter;
let authEventWriterInstalledForTests = false;

export function setAuthEventWriterForTests(write: AuthEventWriter): void {
  authEventWriter = write;
  authEventWriterInstalledForTests = true;
}

export function resetAuthEventWriterForTests(): void {
  authEventWriter = defaultAuthEventWriter;
  authEventWriterInstalledForTests = false;
}

function emitAuthEvent(input: AuthEventInput, env: Env): void {
  if (env.ENVIRONMENT === 'local-test' && !authEventWriterInstalledForTests) return;
  logAuthEvent(input, authEventWriter);
}

function unauthorized(env: Env, reason = 'unauthorized'): Response {
  emitAuthEvent({ type: 'auth_failure', outcome: 'denied', reason }, env);
  return withSecurityHeaders(Response.json(
    { error: 'Unauthorized' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function rateLimited(env: Env, retryAfterMs: number): Response {
  emitAuthEvent({ type: 'rate_limit', outcome: 'blocked' }, env);
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return withSecurityHeaders(Response.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSec),
      },
    },
  ));
}

function hasExactOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(request.url).origin;
}

function originGuard(env: Env, request: Request, pathname: string): Response | null {
  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  const guarded = pathname === '/signaling'
    || (!readOnly && (
      pathname === SESSION_ISSUE
      || pathname === SESSION_LOGOUT
      || pathname === SESSION_CONFIRM
      || pathname === ACCOUNT_PROFILE
      || pathname === AUTH_GUEST
      || pathname.startsWith('/api/')
    ));
  if (!guarded || hasExactOrigin(request)) return null;
  emitAuthEvent({ type: 'auth_failure', outcome: 'denied', reason: 'origin' }, env);
  return withSecurityHeaders(Response.json(
    { error: 'Origin required' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function guestJoinDenied(env: Env): Response {
  emitAuthEvent({ type: 'auth_failure', outcome: 'denied', reason: 'guest_join' }, env);
  return withSecurityHeaders(Response.json(
    { error: 'Forbidden' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function isGuestAuthBody(value: unknown): value is {
  roomId: string;
  pin: string;
  displayName: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 3
    && typeof body.roomId === 'string'
    && isValidRoomId(body.roomId)
    && typeof body.pin === 'string'
    && typeof body.displayName === 'string'
    && body.displayName.trim().length > 0
    && body.displayName.length <= 100
  );
}

async function issueGuestAuth(env: Env, request: Request): Promise<Response> {
  if (shouldRateLimitRoomCreate(env, request)) {
    const limit = guestAuthLimiterFor(env).take(guestAuthRateKey(request));
    if (!limit.ok) return rateLimited(env, limit.retryAfterMs);
  }
  if (bodyTooLarge(request.headers.get('content-length'))) {
    return withSecurityHeaders(new Response('Body too large', { status: 413 }));
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return withSecurityHeaders(new Response('Content type must be application/json', { status: 415 }));
  }
  const bounded = await readBoundedJsonBody(request);
  if (!bounded.ok) {
    return withSecurityHeaders(new Response('Body too large', { status: 413 }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bounded.buffer));
  } catch {
    return withSecurityHeaders(Response.json({ error: 'Invalid JSON body' }, { status: 400 }));
  }
  if (!isGuestAuthBody(parsed)) {
    return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
  }
  const { roomId, pin, displayName } = parsed;

  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const verified = await stub.fetch(new Request(
    `https://room/room/guest-verify?roomId=${encodeURIComponent(roomId)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    },
  ));
  if (!verified.ok) return guestJoinDenied(env);

  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const issued = await identity.fetch(new Request(
    'https://identity/guests/issue',
    internalJson({ roomId, displayName }),
  ));
  if (!issued.ok) return guestJoinDenied(env);

  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  const setCookie = issued.headers.get('set-cookie');
  if (setCookie) headers.set('Set-Cookie', setCookie);
  return withSecurityHeaders(Response.json({ ok: true }, { status: 200, headers }));
}

function internalJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function accessAccountKey(principal: VerifiedAccessPrincipal): { issuer: string; subject: string } {
  return { issuer: principal.issuer, subject: principal.subject };
}

type SessionOutcome =
  | { denied: Response }
  | { denied: null; session: ValidatedSession };

async function sessionAuthorized(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<SessionOutcome> {
  const cookie = request.headers.get('cookie');
  if (!parseSessionCookie(cookie)) return { denied: unauthorized(env, 'missing_session') };
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(
    new Request('https://identity/sessions/authorize', {
      ...internalJson(accessAccountKey(principal)),
      headers: {
        'content-type': 'application/json',
        cookie: cookie!,
      },
    }),
  );
  if (result.ok) {
    return { denied: null, session: (await result.json()) as ValidatedSession };
  }
  const headers = new Headers(result.headers);
  headers.set('Cache-Control', 'no-store');
  return { denied: withSecurityHeaders(new Response(result.body, { status: 401, headers })) };
}

async function guestSessionAuthorized(
  env: Env,
  request: Request,
  roomId: string,
): Promise<SessionOutcome> {
  const cookie = request.headers.get('cookie');
  if (!parseGuestSessionCookie(cookie)) return { denied: unauthorized(env, 'missing_session') };
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(
    new Request('https://identity/sessions/authorize-guest', {
      ...internalJson({ roomId }),
      headers: {
        'content-type': 'application/json',
        cookie: cookie!,
      },
    }),
  );
  if (result.ok) {
    return { denied: null, session: (await result.json()) as ValidatedSession };
  }
  return { denied: unauthorized(env, 'guest_session') };
}

async function issueSession(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  // The body is deliberately not parsed or forwarded. Browser fetch can
  // expose an empty POST as a readable stream, so `request.body === null` is
  // not a reliable empty-body check here.
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } }));
  }
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(
    new Request('https://identity/sessions/issue', internalJson(accessAccountKey(principal))),
  );
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
}

async function sessionCurrent(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'GET') return withSecurityHeaders(Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET' } }));
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(
    new Request('https://identity/sessions/authorize', {
      ...internalJson(accessAccountKey(principal)),
      headers: { 'content-type': 'application/json', cookie: request.headers.get('cookie') ?? '' },
    }),
  );
  if (!result.ok) {
    return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
  }
  const session = (await result.json()) as ValidatedSession & {
    preferredDisplayName?: string | null;
  };
  const { preferredDisplayName, ...publicSession } = session;
  const displayName = preferredDisplayName || principal.displayName;
  return withSecurityHeaders(Response.json(
    displayName ? { ...publicSession, displayName } : publicSession,
    { status: 200, headers: result.headers },
  ));
}

async function sessionConfirm(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } }));
  }
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(
    new Request('https://identity/sessions/confirm', {
      ...internalJson(accessAccountKey(principal)),
      headers: {
        'content-type': 'application/json',
        cookie: request.headers.get('cookie') ?? '',
      },
    }),
  );
  const headers = new Headers(result.headers);
  headers.set('Cache-Control', 'no-store');
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers }));
}

async function sessionLogout(env: Env, request: Request): Promise<Response> {
  // See issueSession: an empty browser POST may still have a body stream.
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } }));
  }
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(new Request('https://identity/sessions/logout', {
    method: 'POST',
    headers: { cookie: request.headers.get('cookie') ?? '' },
  }));
  const headers = new Headers(result.headers);
  headers.append('Set-Cookie', clearCfAuthorizationSetCookie());
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers }));
}

async function accountProfile(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'PATCH') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'PATCH' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(new Request('https://identity/accounts/profile', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      cookie: request.headers.get('cookie') ?? '',
    },
    body: request.body,
  }));
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
}

async function accountExport(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'GET') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(new Request('https://identity/accounts/export', {
    method: 'GET',
    headers: { cookie: request.headers.get('cookie') ?? '' },
  }));
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
}

async function accountErase(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'DELETE') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'DELETE' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  if (!sessionAllowsDestructiveAction(outcome.session)) {
    return withSecurityHeaders(Response.json(
      { error: 'Reauthentication required' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    ));
  }
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(new Request('https://identity/accounts', {
    method: 'DELETE',
    headers: { cookie: request.headers.get('cookie') ?? '' },
  }));
  if (!result.ok) {
    return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
  }
  let roomIds: string[] = [];
  try {
    const body = (await result.json()) as { roomIds?: unknown };
    if (Array.isArray(body.roomIds)) {
      roomIds = body.roomIds.filter((id): id is string => typeof id === 'string');
    }
  } catch {
    roomIds = [];
  }
  const stamp = outcome.session;
  await Promise.all(
    roomIds.map((roomId) => {
      if (!isValidRoomId(roomId)) return Promise.resolve();
      return forward(
        env,
        roomId,
        '/room/erasure',
        new Request('https://room/room/erasure', { method: 'POST' }),
        new URL(request.url),
        stamp,
      );
    }),
  );
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  const clearCookie = result.headers.get('set-cookie');
  if (clearCookie) headers.set('Set-Cookie', clearCookie);
  return withSecurityHeaders(Response.json({ ok: true }, { headers }));
}

async function listAccountRooms(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'GET') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(new Request(IDENTITY_ACCOUNT_ROOMS, {
    method: 'GET',
    headers: { cookie: request.headers.get('cookie') ?? '' },
  }));
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
}

function syncOwnedRoom(
  env: Env,
  cookie: string,
  method: 'POST' | 'DELETE',
  body: { roomId: string; name?: string | null },
): Promise<Response> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  return identity.fetch(new Request(IDENTITY_ACCOUNT_ROOMS, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify(body),
  }));
}

async function reserveOwnedRoomSlot(
  env: Env,
  cookie: string,
  roomId: string,
): Promise<Response> {
  return syncOwnedRoom(env, cookie, 'POST', { roomId, name: null });
}

async function releaseOwnedRoomSlot(
  env: Env,
  cookie: string,
  roomId: string,
): Promise<void> {
  try {
    const released = await syncOwnedRoom(env, cookie, 'DELETE', { roomId });
    if (!released.ok && released.status !== 204) {
      console.error('identity account rooms release failed', released.status);
    }
  } catch {
    console.error('identity account rooms release failed');
  }
}

async function purgeRoomGuests(
  env: Env,
  cookie: string,
  roomId: string,
): Promise<void> {
  try {
    const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
    const purged = await identity.fetch(new Request(IDENTITY_GUESTS_PURGE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({ roomId }),
    }));
    if (!purged.ok) {
      console.error('identity guests purge failed', purged.status);
    }
  } catch {
    console.error('identity guests purge failed');
  }
}

async function syncOwnedRoomNameFromSettings(
  env: Env,
  cookie: string,
  roomId: string,
  request: Request,
): Promise<void> {
  try {
    const payload = await request.json() as { name?: unknown };
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (!('name' in payload)) return;
    if (payload.name !== null && typeof payload.name !== 'string') return;
    await syncOwnedRoom(env, cookie, 'POST', { roomId, name: payload.name });
  } catch {
    console.error('identity account rooms settings sync failed');
  }
}

/** Forwards to the room's Durable Object, preserving the original query. */
function forward(
  env: Env,
  roomId: string,
  path: string,
  request: Request,
  url: URL,
  session: ValidatedSession | null = null,
  guest = false,
): Promise<Response> {
  const target = new URL(`https://room${path}`);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  // `set` overwrites, so a client-supplied roomId/accountId/epoch/sessionId/guest
  // on the original query cannot survive into the internal request.
  target.searchParams.set('roomId', roomId);
  if (session) {
    target.searchParams.set('accountId', session.accountId);
    target.searchParams.set('accountEpoch', String(session.authorizationEpoch));
    target.searchParams.set('sessionId', session.sessionId);
  } else {
    target.searchParams.delete('accountId');
    target.searchParams.delete('accountEpoch');
    target.searchParams.delete('sessionId');
  }
  target.searchParams.set('guest', guest ? '1' : '0');

  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const forwarded = new Request(target, request);
  const stripped = stripForwardedIdentityHeaders(forwarded.headers);
  for (const name of [...forwarded.headers.keys()]) {
    if (!stripped.has(name)) forwarded.headers.delete(name);
  }
  return stub.fetch(forwarded).then((response) => {
    // A 101 Switching Protocols upgrade carries a WebSocket pair that
    // reconstructing the Response would drop, so pass it through untouched.
    if (response.status === 101 && response.webSocket) return response;
    return withSecurityHeaders(response);
  });
}

async function probeRoomAccessStatus(
  env: Env,
  roomId: string,
  url: URL,
  session: ValidatedSession,
): Promise<string | null> {
  const response = await forward(
    env,
    roomId,
    '/room/access',
    new Request('https://room/room/access', { method: 'GET' }),
    url,
    session,
  );
  if (!response.ok) return null;
  try {
    const body = (await response.json()) as { status?: string };
    return typeof body.status === 'string' ? body.status : null;
  } catch {
    return null;
  }
}

function hostNotFound(): Response {
  return withSecurityHeaders(new Response(null, { status: 404 }));
}

function accessLogoutResponse(url: URL, env: Env): Response {
  const target = safeRedirectPath(url.searchParams.get('redirect'));
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearCfAuthorizationSetCookie());
  if (env.ENVIRONMENT === 'local-test') {
    headers.set('Location', target);
  } else {
    headers.set(
      'Location',
      `${CF_ACCESS_LOGOUT_PATH}?redirect=${encodeURIComponent(target)}`,
    );
  }
  return withSecurityHeaders(new Response(null, { status: 302, headers }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Hostname decides the caller kind before Access, marketing exemptions, or
    // any session work. Unset teacher/guest hostnames fail closed: every
    // request is teacher-host and the guest surface does not exist.
    const hostKind = (!env.TEACHER_HOSTNAME || !env.GUEST_HOSTNAME)
      ? 'teacher'
      : routeHostKind(url.hostname, env.TEACHER_HOSTNAME, env.GUEST_HOSTNAME);
    if (hostKind === 'unknown') return hostNotFound();
    if (
      hostKind === 'teacher'
      && (url.pathname === ACCESS_LOGOUT_PATH || url.pathname === CF_ACCESS_LOGOUT_PATH)
    ) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return withSecurityHeaders(Response.json(
          { error: 'Method not allowed' },
          { status: 405, headers: { Allow: 'GET, HEAD' } },
        ));
      }
      return accessLogoutResponse(url, env);
    }
    if (hostKind === 'guest' && url.pathname === AUTH_GUEST && request.method !== 'POST') {
      return withSecurityHeaders(Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'POST' } },
      ));
    }
    if (!isRouteAllowedOnHost(url.pathname, request.method, hostKind)) return hostNotFound();
    const isGuestHost = hostKind === 'guest';

    // SEC-015 sales-surface exemption: marketing pages must be reachable and
    // indexable by search engines without a Cf-Access-Jwt-Assertion, or the
    // product has no public sales funnel. `isPublicPath` is a small, explicit
    // allowlist reviewed like a firewall rule — nothing else is exempted from
    // Access, and non-GET/HEAD requests to these paths fall through to the
    // normal Access gate below (public is read-only). Guest-host `/` is
    // teacher-only and already 404'd above.
    if (
      (request.method === 'GET' || request.method === 'HEAD')
      && isPublicPath(url.pathname)
    ) {
      const response = await env.ASSETS.fetch(request);
      return withNonceHtmlSecurityHeaders(response, {
        indexable: (MARKETING_PAGES as readonly string[]).includes(url.pathname),
        connectSrc: connectSrcForPageOrigin(url.origin),
      });
    }

    let principal: VerifiedAccessPrincipal | undefined;
    if (!isGuestHost) {
      try {
        principal = await verifyAccessRequest(request, ctx.access, env);
      } catch (error) {
        if (error instanceof AccessVerificationError) return unauthorized(env, 'access_verification_failed');
        throw error;
      }
    }

    // Run before local-session authorization and before any Durable Object or
    // body access. Origin is an exact serialized-origin comparison: missing,
    // null, alternate scheme/port/subdomain, and combined values fail closed.
    const originDenied = originGuard(env, request, url.pathname);
    if (originDenied) return originDenied;

    if (isGuestHost && url.pathname === AUTH_GUEST) {
      return issueGuestAuth(env, request);
    }

    if (!isGuestHost && principal) {
      if (url.pathname === SESSION_ISSUE) {
        return issueSession(env, request, principal);
      }
      if (url.pathname === SESSION_CURRENT) {
        return sessionCurrent(env, request, principal);
      }
      if (url.pathname === SESSION_CONFIRM) {
        return sessionConfirm(env, request, principal);
      }
      if (url.pathname === SESSION_LOGOUT) {
        return sessionLogout(env, request);
      }
      if (url.pathname === ACCOUNT_PROFILE) {
        return accountProfile(env, request, principal);
      }
      if (url.pathname === ACCOUNT_EXPORT) {
        return accountExport(env, request, principal);
      }
      if (url.pathname === ACCOUNT_ERASE) {
        return accountErase(env, request, principal);
      }
      if (url.pathname === ACCOUNT_ROOMS) {
        return listAccountRooms(env, request, principal);
      }
    }

    // Assets may bootstrap the local session. Every mutable/API and signaling
    // path additionally needs that local session so local revocation remains
    // effective while an Access browser session is still alive.
    let session: ValidatedSession | null = null;
    let guestCaller = false;
    if (url.pathname.startsWith('/api/') || url.pathname === '/signaling') {
      if (isGuestHost) {
        const guestRoomId = url.pathname === '/signaling'
          ? url.searchParams.get('room')
          : (() => {
            const roomMatch = url.pathname.match(ROOM_API);
            return roomMatch ? decodeURIComponent(roomMatch[1]) : null;
          })();
        if (!guestRoomId || !isValidRoomId(guestRoomId)) {
          return url.pathname === '/signaling'
            ? withSecurityHeaders(new Response('Missing or invalid room', { status: 400 }))
            : withSecurityHeaders(new Response('Invalid room id', { status: 400 }));
        }
        const outcome = await guestSessionAuthorized(env, request, guestRoomId);
        if (outcome.denied) return outcome.denied;
        session = outcome.session;
        guestCaller = true;
      } else {
        const outcome = await sessionAuthorized(env, request, principal!);
        if (outcome.denied) return outcome.denied;
        session = outcome.session;
      }
    }

    // y-webrtc signaling. The room is named on the query string so the socket
    // can be routed before any protocol message arrives.
    if (url.pathname === '/signaling') {
      const roomId = url.searchParams.get('room');
      if (!roomId || !isValidRoomId(roomId)) {
        return withSecurityHeaders(new Response('Missing or invalid room', { status: 400 }));
      }
      // The account travels with the upgrade so the room can re-check it for
      // the life of the socket, not just at connect time.
      return forward(env, roomId, '/signaling', request, url, session, guestCaller);
    }

    // Short-lived LiveKit join token. RoomDO enforces admission (granted
    // roles only; waiting peers get 403) and mints the JWT when LIVEKIT_* is set.
    if (url.pathname === AV_TOKEN) {
      // POST-only: SameSite=Lax sends the session cookie on top-level GET
      // navigations and the origin guard deliberately exempts GETs, so a GET
      // that mints a credential would combine both exemptions.
      if (request.method !== 'POST') {
        return withSecurityHeaders(Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } }));
      }
      const roomId = url.searchParams.get('roomId');
      if (!roomId || !isValidRoomId(roomId)) {
        return withSecurityHeaders(Response.json({ error: 'Missing or invalid roomId' }, { status: 400 }));
      }
      return forward(env, roomId, '/room/av', request, url, session, guestCaller);
    }

    const match = url.pathname.match(ROOM_API);
    if (match) {
      const roomId = decodeURIComponent(match[1]);
      if (!isValidRoomId(roomId)) {
        return withSecurityHeaders(new Response('Invalid room id', { status: 400 }));
      }
      // Mutations must be JSON and bounded in size; the body cap also stops
      // unbounded reads before they reach the room Durable Object. A request
      // that declares a body must declare it as JSON; bodyless mutations
      // (e.g. DELETE) need no content type.
      const readOnly = request.method === 'GET' || request.method === 'HEAD';
      if (!readOnly) {
        const contentLength = request.headers.get('content-length');
        if (bodyTooLarge(contentLength)) {
          return withSecurityHeaders(new Response('Body too large', { status: 413 }));
        }
        if (contentLength !== null && contentLength !== '0' && !isJsonContentType(request.headers.get('content-type'))) {
          return withSecurityHeaders(new Response('Content type must be application/json', { status: 415 }));
        }
        const bounded = await readBoundedJsonBody(request);
        if (!bounded.ok) {
          return withSecurityHeaders(new Response('Body too large', { status: 413 }));
        }
        request = new Request(request, { body: bounded.buffer });
      }
      const subpath = match[2] ?? '';
      // Refuse the internal guest-verify route from the public API.
      if (subpath === '/guest-verify' || subpath.startsWith('/guest-verify/')) {
        return withSecurityHeaders(new Response(null, { status: 404 }));
      }
      if (
        request.method === 'DELETE'
        && subpath === ''
        && session
        && !sessionAllowsDestructiveAction(session)
      ) {
        return withSecurityHeaders(Response.json(
          { error: 'Reauthentication required' },
          { status: 403, headers: { 'Cache-Control': 'no-store' } },
        ));
      }
      if (request.method === 'POST' && subpath === '' && session && shouldRateLimitRoomCreate(env, request)) {
        const accessStatus = await probeRoomAccessStatus(env, roomId, url, session);
        if (accessStatus === 'none') {
          const limit = roomCreateLimiterFor(env).take(session.accountId);
          if (!limit.ok) return rateLimited(env, limit.retryAfterMs);
        } else {
          const limit = sceneWriteLimiterFor(env).take(session.accountId);
          if (!limit.ok) return rateLimited(env, limit.retryAfterMs);
        }
      }
      if (request.method === 'POST' && subpath === '/requests' && session && shouldRateLimitRoomCreate(env, request)) {
        const limit = accessRequestLimiterFor(env).take(session.accountId);
        if (!limit.ok) return rateLimited(env, limit.retryAfterMs);
      }
      if (request.method === 'POST' && subpath === '/presence' && session && shouldRateLimitRoomCreate(env, request)) {
        const limit = presencePostLimiterFor(env).take(session.accountId);
        if (!limit.ok) return rateLimited(env, limit.retryAfterMs);
      }
      // The verified account decides which rooms this caller may touch.
      const settingsClone = session
        && subpath === '/settings'
        && (request.method === 'POST' || request.method === 'PATCH')
        ? request.clone()
        : null;
      const response = await forward(env, roomId, `/room${subpath}`, request, url, session, guestCaller);
      if (session && subpath === '') {
        const cookie = request.headers.get('cookie') ?? '';
        if (request.method === 'POST' && response.ok) {
          let hasCreatorGrant = false;
          try {
            const payload = await response.clone().json() as { hasCreatorGrant?: unknown };
            hasCreatorGrant = payload.hasCreatorGrant === true;
          } catch {
            hasCreatorGrant = false;
          }
          if (hasCreatorGrant) {
            const recorded = await reserveOwnedRoomSlot(env, cookie, roomId);
            if (!recorded.ok) {
              await forward(
                env,
                roomId,
                '/room',
                new Request('https://room/room', { method: 'DELETE' }),
                url,
                session,
              );
              return withSecurityHeaders(new Response(recorded.body, {
                status: recorded.status,
                headers: recorded.headers,
              }));
            }
          }
        } else if (request.method === 'DELETE' && response.status === 200) {
          await releaseOwnedRoomSlot(env, cookie, roomId);
          await purgeRoomGuests(env, cookie, roomId);
        }
      }
      if (session && settingsClone && response.ok) {
        ctx.waitUntil(syncOwnedRoomNameFromSettings(
          env,
          request.headers.get('cookie') ?? '',
          roomId,
          settingsClone,
        ));
      }
      return response;
    }

    // Serve the placeholder room page for any /whiteboard/<roomId> URL. The
    // page reads the real id from the address bar, which is left untouched.
    if (ROOM_PAGE.test(url.pathname) && url.pathname !== ROOM_PLACEHOLDER) {
      const rewritten = new URL(request.url);
      rewritten.pathname = ROOM_PLACEHOLDER;
      return withNonceHtmlSecurityHeaders(await env.ASSETS.fetch(new Request(rewritten, request)), {
        connectSrc: connectSrcForPageOrigin(url.origin),
      });
    }

    return withNonceHtmlSecurityHeaders(await env.ASSETS.fetch(request), {
      connectSrc: connectSrcForPageOrigin(url.origin),
    });
  },
};
