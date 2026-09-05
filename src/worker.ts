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
  ACCESS_REQUEST_RATE_MAX,
  PRESENCE_POST_RATE_MAX,
  RATE_WINDOW_MS,
  ROOM_CREATE_RATE_MAX,
  SCENE_WRITE_RATE_MAX,
} from './lib/worker/rateLimits';
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
import {
  MAX_BOARD_FILE_BYTES,
  MAX_ROOM_FILE_BYTES_TOTAL,
  isValidFileId,
  isAllowedMimeType,
  buildR2ObjectKey,
} from './lib/whiteboard/boardFileRoutes';

export interface Env {
  ROOMS: DurableObjectNamespace;
  IDENTITY: DurableObjectNamespace;
  ASSETS: Fetcher;
  BOARD_FILES: R2Bucket;
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
  /**
   * Exact public landing hostname. No Access application may cover it: the
   * Access JWT arrives only on paths an Access app protects, so marketing
   * pages cannot be public on the app hostname. Unset disables the surface.
   */
  MARKETING_HOSTNAME?: string;
}

// Room ids cannot be enumerated at build time, so the static export contains a
// single placeholder page that stands in for every room.
const ROOM_PAGE = /^\/whiteboard\/[^/]+\/?$/;
const ROOM_PLACEHOLDER = '/whiteboard/_room';

const ROOM_API = /^\/api\/whiteboard\/room\/([^/]+)(\/.*)?$/;
const BOARD_FILE_API = /^\/api\/whiteboard\/room\/([^/]+)\/files\/([^/]+)$/;
const AV_TOKEN = '/api/av/token';
const AV_MUTE = '/api/av/mute';
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
const ROOM_CREATE_RATE_WINDOW_MS = RATE_WINDOW_MS;
const productionRoomCreateLimiter = createRateLimiter({
  windowMs: ROOM_CREATE_RATE_WINDOW_MS,
  max: ROOM_CREATE_RATE_MAX,
});
const strictLocalTestRoomCreateLimiter = createRateLimiter({
  windowMs: ROOM_CREATE_RATE_WINDOW_MS,
  max: ROOM_CREATE_RATE_MAX,
});

/** Access-request POSTs per verified account within a one-minute window (SEC-005). */
const ACCESS_REQUEST_RATE_WINDOW_MS = RATE_WINDOW_MS;
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
const PRESENCE_POST_RATE_WINDOW_MS = RATE_WINDOW_MS;
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
const SCENE_WRITE_RATE_WINDOW_MS = RATE_WINDOW_MS;
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

  // Reuse an existing guest session for this room instead of minting a second
  // identity. Without this, re-entering the PIN (after a reload, or because the
  // prompt reappeared) creates a NEW guest account: the one the teacher
  // admitted stays behind, the browser now carries an unapproved account, and
  // the student is thrown back into the waiting room. The old account also owns
  // the live Yjs socket, so the board stops syncing for everyone watching.
  const existing = await guestSessionAuthorized(env, request, roomId);
  if (!existing.denied) {
    return withSecurityHeaders(Response.json(
      { ok: true },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    ));
  }

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
  // Ends the APPLICATION session only. CF_Authorization is deliberately left
  // alone: full sign-out is completeSignOut(), which calls this and THEN
  // navigates to /auth/access/logout, where the Access cookie is cleared.
  // Clearing it here too broke re-bootstrap — a user who ended their app
  // session could not mint a new one without re-authenticating with Access,
  // even though their Access session was still valid.
  const headers = new Headers(result.headers);
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
    roomIds.map(async (roomId) => {
      if (!isValidRoomId(roomId)) return;
      await forward(
        env,
        roomId,
        '/room/erasure',
        new Request('https://room/room/erasure', { method: 'POST' }),
        new URL(request.url),
        stamp,
      );
      /*
       * Awaited here rather than left to the room object, which has no R2
       * binding and so cannot erase what it does not hold. An erasure that
       * cleared the board rows and left the uploaded pictures in the bucket
       * would answer "ok" while the images of children's work it was asked to
       * destroy stayed exactly where they were.
       */
      await purgeBoardFiles(env, roomId);
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

async function purgeBoardFiles(env: Env, roomId: string): Promise<void> {
  try {
    const prefix = `rooms/${roomId}/files/`;
    // List all objects with the room's file prefix, then delete them.
    // R2 list is paginated; handle cursors for continuation.
    let cursor: string | undefined;
    for (;;) {
      const list = await env.BOARD_FILES.list({ prefix, cursor });
      for (const object of list.objects) {
        await env.BOARD_FILES.delete(object.key);
      }
      if (!list.truncated) break;
      cursor = list.cursor;
    }
  } catch {
    console.error('board files purge failed');
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
  if (env.ENVIRONMENT === 'local-test') {
    // No Access edge here, so the app clears the cookie itself.
    headers.append('Set-Cookie', clearCfAuthorizationSetCookie());
    headers.set('Location', target);
    return withSecurityHeaders(new Response(null, { status: 302, headers }));
  }
  // Clear the Access cookie and land the user on the public site.
  //
  // The alternative — handing off to Cloudflare's /cdn-cgi/access/logout —
  // strands the user on a Cloudflare-branded page showing the Zero Trust team
  // domain, because Cloudflare documents no parameter for redirecting after
  // logout. Clearing the cookie here ends the browser's Access session (the
  // cookie is the credential) and keeps the user on our own site.
  //
  // Trade-off, recorded deliberately: Cloudflare's server-side session record
  // is not revoked, so signing back in may not re-prompt for Google until it
  // expires. The application session IS revoked separately by
  // POST /auth/session/logout, so no room or board access survives this.
  headers.append('Set-Cookie', clearCfAuthorizationSetCookie());
  headers.set(
    'Location',
    env.MARKETING_HOSTNAME ? `https://${env.MARKETING_HOSTNAME}/` : target,
  );
  return withSecurityHeaders(new Response(null, { status: 302, headers }));
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Hostname decides the caller kind before Access, marketing exemptions, or
    // any session work. Unset teacher/guest hostnames fail closed: every
    // request is teacher-host and the guest surface does not exist.
    const hostKind = (!env.TEACHER_HOSTNAME || !env.GUEST_HOSTNAME)
      ? 'teacher'
      : routeHostKind(
        url.hostname,
        env.TEACHER_HOSTNAME,
        env.GUEST_HOSTNAME,
        env.MARKETING_HOSTNAME,
      );
    if (hostKind === 'unknown') return hostNotFound();

    // The landing surface is static and entirely public. It never verifies
    // Access, never issues a session, and never reaches a Durable Object, so it
    // is served and returned before any of that machinery runs.
    if (hostKind === 'marketing') {
      // The landing page links to /whiteboard with relative hrefs so the HTML
      // stays host-agnostic. Send those to the teacher hostname rather than
      // 404ing them. The target comes from env, never from the request, and
      // only these two exact shapes redirect, so this cannot be turned into an
      // open redirect.
      const signInPath = url.pathname === '/whiteboard'
        || /^\/whiteboard\/[a-f0-9]{32}$/.test(url.pathname);
      if (
        signInPath
        && env.TEACHER_HOSTNAME
        && (request.method === 'GET' || request.method === 'HEAD')
      ) {
        return withSecurityHeaders(Response.redirect(
          `https://${env.TEACHER_HOSTNAME}${url.pathname}`,
          302,
        ));
      }
      if (!isRouteAllowedOnHost(url.pathname, request.method, hostKind)) {
        return hostNotFound();
      }
      const asset = await env.ASSETS.fetch(request);
      return withNonceHtmlSecurityHeaders(asset, {
        indexable: (MARKETING_PAGES as readonly string[]).includes(url.pathname),
        connectSrc: connectSrcForPageOrigin(url.origin, env.LIVEKIT_URL),
      });
    }
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
        connectSrc: connectSrcForPageOrigin(url.origin, env.LIVEKIT_URL),
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
        // A guest session is bound to one room, so the room has to be known
        // before the session is validated. Most routes name it in the path;
        // signaling and the A/V token carry it on the query string instead.
        const guestRoomId = url.pathname === '/signaling'
          ? url.searchParams.get('room')
          : url.pathname === AV_TOKEN || url.pathname === AV_MUTE
            ? url.searchParams.get('roomId')
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

    // A/V mute action: owner only. RoomDO enforces authorization.
    if (url.pathname === AV_MUTE) {
      if (request.method !== 'POST') {
        return withSecurityHeaders(Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } }));
      }
      const roomId = url.searchParams.get('roomId');
      if (!roomId || !isValidRoomId(roomId)) {
        return withSecurityHeaders(Response.json({ error: 'Missing or invalid roomId' }, { status: 400 }));
      }
      return forward(env, roomId, '/room/av', request, url, session, guestCaller);
    }

    // Whiteboard board file upload and download. Handled before ROOM_API so
    // binary payloads bypass the JSON body-reading logic and can exceed 4MB.
    const fileMatch = url.pathname.match(BOARD_FILE_API);
    if (fileMatch) {
      const roomId = decodeURIComponent(fileMatch[1]);
      const fileId = decodeURIComponent(fileMatch[2]);
      if (!isValidRoomId(roomId) || !isValidFileId(fileId)) {
        return withSecurityHeaders(new Response('Invalid request', { status: 400 }));
      }

      if (request.method === 'PUT') {
        const contentLength = request.headers.get('content-length');
        if (!contentLength || isNaN(Number(contentLength))) {
          return withSecurityHeaders(new Response('Content-Length required', { status: 411 }));
        }
        const declaredSize = Number(contentLength);
        if (declaredSize > MAX_BOARD_FILE_BYTES) {
          return withSecurityHeaders(new Response('File too large', { status: 413 }));
        }

        const mimeType = request.headers.get('content-type');
        if (!isAllowedMimeType(mimeType)) {
          return withSecurityHeaders(new Response('Unsupported media type', { status: 415 }));
        }

        // Ask RoomDO for write authorization before streaming to R2.
        const authCheck = await forward(
          env,
          roomId,
          '/room/files/authorize-write',
          new Request('https://room/room/files/authorize-write', { method: 'GET' }),
          url,
          session,
          guestCaller,
        );
        if (!authCheck.ok) return authCheck;

        // Check aggregate file quota: get current total and ensure upload won't exceed 250 MB.
        const quotaCheck = await forward(
          env,
          roomId,
          '/room/files/check-quota',
          new Request('https://room/room/files/check-quota', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ incomingSize: declaredSize }),
          }),
          url,
          session,
          guestCaller,
        );
        if (!quotaCheck.ok) return quotaCheck;

        // Streamed, not buffered: an image is megabytes and reading it into
        // memory first would put the whole file in the isolate's heap.
        const key = buildR2ObjectKey(roomId, fileId);
        const stored = await env.BOARD_FILES.put(key, request.body, {
          httpMetadata: {
            contentType: mimeType!,
          },
        });

        /*
         * Checked again against what actually arrived.
         *
         * The cap above tests content-length, which is the client's word about
         * its own request. A peer that declares a small body and then streams a
         * large one would otherwise write it in full, and the bucket -- and the
         * bill -- would grow to whatever anyone with a grant felt like sending.
         * The bytes are already spent by the time this runs, so this bounds
         * storage rather than bandwidth; it is the difference between one
         * oversized request and an unbounded store.
         */
        if (stored && stored.size > MAX_BOARD_FILE_BYTES) {
          await env.BOARD_FILES.delete(key);
          return withSecurityHeaders(new Response('File too large', { status: 413 }));
        }

        // Update the aggregate file bytes counter after successful upload.
        if (stored) {
          const updateResult = await forward(
            env,
            roomId,
            '/room/files/add-bytes',
            new Request('https://room/room/files/add-bytes', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ bytes: stored.size }),
            }),
            url,
            session,
            guestCaller,
          );
          if (!updateResult.ok) {
            // Log the error but don't fail the request - file is already in R2
            console.error('Failed to update file bytes counter', updateResult.status);
          }
        }

        return withSecurityHeaders(Response.json({ ok: true }, { status: 201 }));
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        // Ask RoomDO for read authorization.
        const authCheck = await forward(
          env,
          roomId,
          '/room/files/authorize-read',
          new Request('https://room/room/files/authorize-read', { method: 'GET' }),
          url,
          session,
          guestCaller,
        );
        if (!authCheck.ok) return authCheck;

        // Fetch from R2 and return with cache headers.
        const key = buildR2ObjectKey(roomId, fileId);
        const object = await env.BOARD_FILES.get(key);
        if (!object) {
          return withSecurityHeaders(new Response('Not found', { status: 404 }));
        }

        const headers = new Headers();
        if (object.httpMetadata?.contentType) {
          headers.set('Content-Type', object.httpMetadata.contentType);
        }
        // File IDs are content-addressed by Excalidraw, so the bytes never
        // change. Cache indefinitely.
        headers.set('Cache-Control', 'private, max-age=31536000, immutable');

        if (request.method === 'HEAD') {
          return withSecurityHeaders(new Response(null, { status: 200, headers }));
        }
        return withSecurityHeaders(new Response(object.body, { status: 200, headers }));
      }

      return withSecurityHeaders(Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, HEAD, PUT' } },
      ));
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
          ctx.waitUntil(purgeBoardFiles(env, roomId));
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
        connectSrc: connectSrcForPageOrigin(url.origin, env.LIVEKIT_URL),
      });
    }

    return withNonceHtmlSecurityHeaders(await env.ASSETS.fetch(request), {
      connectSrc: connectSrcForPageOrigin(url.origin, env.LIVEKIT_URL),
    });
  },
};

export default worker;
