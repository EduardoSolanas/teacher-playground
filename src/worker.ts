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
import {
  IDENTITY_OUTCOME_HEADER,
  IdentityDO,
  TUTOR_CAP_REACHED_OUTCOME,
  getIdentityObject,
} from './do/IdentityDO';
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
  isOriginGuardedPath,
  readBoundedJsonBody,
  isPublicPath,
  isValidRoomId,
  MARKETING_PAGES,
  BILLING_WEBHOOK_PATH,
  BILLING_WEBHOOK_MAX_BODY_BYTES,
  BILLING_CHECKOUT_PATH,
  BILLING_PORTAL_PATH,
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
import { applyPlanMaxUsersParam } from './lib/whiteboard/planMaxUsers';
import { PLAN_CATALOG, type PlanId } from './lib/plan/catalog';
import { readBillingEnv, type BillingEnv } from './lib/billing/stripeConfig';
import { verifyStripeSignature } from './lib/billing/stripeSignature';
import {
  checkoutSessionRequest,
  eventsFetchMapRequest,
  portalSessionRequest,
} from './lib/billing/stripeRequest';
import { executeStripeRequest } from './lib/billing/stripeClient';
import { parseCollectionSubject, runCollectionExecutor } from './lib/billing/executor';

export interface Env {
  ROOMS: DurableObjectNamespace;
  IDENTITY: DurableObjectNamespace;
  ASSETS: Fetcher;
  BOARD_FILES: R2Bucket;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_JWKS_URL?: string;
  /** Cloudflare Access free-plan seat budget for brand-new tutor accounts. */
  TUTOR_ACCOUNT_CAP?: string;
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
  STRIPE_API_BASE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

// Room ids cannot be enumerated at build time, so the static export contains a
// single placeholder page that stands in for every room.
const ROOM_PAGE = /^\/whiteboard\/[^/]+\/?$/;
const ROOM_PLACEHOLDER = '/whiteboard/_room';

/**
 * Exact shapes the marketing host hands to the teacher host.
 *
 * The grammar is `isValidRoomId`/`ROOM_ID_RE` -- the same one the route gate,
 * the room page and the join links use -- so the redirect cannot be stricter
 * than the product and 404 a room that exists. Kept to an exact path with one
 * segment: no suffix, query or traversal surface may become a redirect, and
 * the target host comes from env, never from the request. `_room` is the
 * static-export placeholder, never a room a caller names.
 */
function isMarketingRoomRedirectPath(pathname: string): boolean {
  if (pathname === '/whiteboard') return true;
  if (pathname === ROOM_PLACEHOLDER) return false;
  const match = /^\/whiteboard\/([^/]+)$/.exec(pathname);
  return match !== null && isValidRoomId(match[1]);
}

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
const COMPANY_API = '/api/company';
const COMPANY_INVITES_API = '/api/company/invites';
const COMPANY_INVITE_REDEEM_API = '/api/company/invites/redeem';
const COMPANY_SEATS_API = '/api/company/seats';
const COMPANY_MEMBER_REVOKE_API = '/api/company/members/revoke';
const COMPANY_OWNER_API = '/api/company/owner';
const AUTH_GUEST = '/auth/guest';
const IDENTITY_ACCOUNT_ROOMS = 'https://identity/accounts/rooms';
const IDENTITY_GUESTS_PURGE = 'https://identity/guests/purge';
const IDENTITY_ACCOUNT_PLAN = 'https://identity/accounts/plan';
const IDENTITY_COMPANIES = 'https://identity/companies';
const IDENTITY_COMPANY_MEMBERSHIP = 'https://identity/companies/membership';
const IDENTITY_COMPANY_CUSTOMER = 'https://identity/companies/customer';
const IDENTITY_COMPANY_SEATS = 'https://identity/companies/seats';
const IDENTITY_COMPANY_SEAT_SETTLE = 'https://identity/companies/seats/settle';
const IDENTITY_COMPANY_MEMBERS_REVOKE = 'https://identity/companies/members/revoke';
const IDENTITY_COMPANY_OWNER = 'https://identity/companies/owner';
const IDENTITY_COMPANY_INVITES = 'https://identity/companies/invites';
const IDENTITY_COMPANY_INVITE_REDEEM = 'https://identity/companies/invites/redeem';
const IDENTITY_BILLING_OPERATIONS = 'https://identity/billing/operations';
const IDENTITY_BILLING_RATE_LIMIT = 'https://identity/billing/rate-limit';
const IDENTITY_BILLING_CUSTOMER = 'https://identity/billing/customer';

const PERSONAL_PAID_PLANS: ReadonlySet<string> = new Set([
  'tutor_pro_monthly',
  'tutor_pro_annual',
]);
const BILLING_OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BILLING_REFERRAL_CODE_RE = /^[A-Za-z0-9-]{6,32}$/;

/**
 * Served when the identity store refuses a brand-new tutor account at the
 * configured cap. Static: the refused browser has no session and no app
 * assets are needed to read it.
 */
const TUTOR_CAP_PAUSED_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tutor sign-ups are paused</title>
  </head>
  <body>
    <main>
      <h1>Tutor sign-ups are paused</h1>
      <p>New tutor sign-ups are paused while the account limit is reviewed.
      Existing tutors can still sign in.</p>
    </main>
  </body>
</html>`;

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
 * Presence POSTs (join/heartbeat and kick/suspend) and DELETEs (leave) per
 * account per minute (SEC-017, SEC-A14). Kick shares this cap so the Worker
 * can limit without cloning/parsing JSON.
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
  if (!isOriginGuardedPath(pathname, request.method) || hasExactOrigin(request)) return null;
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
  if (result.headers.get(IDENTITY_OUTCOME_HEADER) === TUTOR_CAP_REACHED_OUTCOME) {
    // The DO outcome marker is routing information for this Worker only: the
    // browser gets a fresh page carrying no marker, no DO credentials and no
    // cookie from the refused mint.
    return withSecurityHeaders(new Response(TUTOR_CAP_PAUSED_HTML, {
      status: 403,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }));
  }
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
}

async function resolveSessionPlan(env: Env, accountId: string): Promise<unknown | null> {
  try {
    const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
    const response = await identity.fetch(new Request(
      `${IDENTITY_ACCOUNT_PLAN}?accountId=${encodeURIComponent(accountId)}`,
    ));
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return body !== null && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

async function resolveSessionCompany(env: Env, request: Request): Promise<unknown | null> {
  try {
    const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
    const response = await identity.fetch(new Request('https://identity/companies/membership', {
      headers: { cookie: request.headers.get('cookie') ?? '' },
    }));
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object') return null;
    return (body as { company?: unknown }).company ?? null;
  } catch {
    return null;
  }
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
  const plan = await resolveSessionPlan(env, session.accountId);
  const company = await resolveSessionCompany(env, request);
  const payload = { ...publicSession, plan, company };
  return withSecurityHeaders(Response.json(
    displayName ? { ...payload, displayName } : payload,
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

function isCompanyCreateApiBody(value: unknown): value is {
  name: string;
  operationId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.name === 'string' &&
    body.name.trim().length >= 1 &&
    body.name.length <= 100 &&
    typeof body.operationId === 'string' &&
    BILLING_OPERATION_ID_RE.test(body.operationId)
  );
}

async function identityCompanyFetch(
  env: Env,
  request: Request,
  path: string,
  init: { method: string; body?: string },
): Promise<Response> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  return identity.fetch(new Request(`https://identity${path}`, {
    method: init.method,
    headers: {
      'content-type': 'application/json',
      cookie: request.headers.get('cookie') ?? '',
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  }));
}

async function companyProxyResponse(env: Env, result: Response): Promise<Response> {
  if (result.status === 429) {
    let retryAfterMs = 0;
    try {
      const body = (await result.clone().json()) as { retryAfterMs?: unknown };
      if (typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)) {
        retryAfterMs = body.retryAfterMs;
      }
    } catch {
      retryAfterMs = 0;
    }
    return rateLimited(env, retryAfterMs);
  }
  return withSecurityHeaders(new Response(result.body, {
    status: result.status,
    headers: result.headers,
  }));
}

interface CompanyApiRecord {
  id: string;
  name: string;
  role: string;
  processorCustomerId: string | null;
}

async function createCompanyCustomer(
  env: Env,
  accountId: string,
  cookie: string,
  company: CompanyApiRecord,
  operationId: string,
): Promise<{ customerReady: boolean; company: CompanyApiRecord }> {
  const billing = billingEnvFor(env);
  if (!billing.apiBaseAllowed || billing.secretKey === null) {
    return { customerReady: false, company };
  }
  const params = new URLSearchParams();
  params.append('name', company.name);
  params.append('metadata[company_id]', company.id);
  params.append('metadata[account_id]', accountId);
  const stripeRequest = new Request(`${billing.apiBaseUrl}/v1/customers`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `op:company:${company.id}:${operationId}`,
    },
    body: params.toString(),
  });
  let result;
  try {
    result = await executeStripeRequest(stripeRequest, billing.secretKey);
  } catch {
    return { customerReady: false, company };
  }
  if (!result.ok) return { customerReady: false, company };
  const customerId = recordOf(result.json)?.id;
  if (typeof customerId !== 'string' || !customerId.startsWith('cus_')) {
    return { customerReady: false, company };
  }
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const writeback = await identity.fetch(new Request(IDENTITY_COMPANY_CUSTOMER, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      companyId: company.id,
      operationId,
      processorCustomerId: customerId,
    }),
  }));
  if (!writeback.ok) return { customerReady: false, company };
  const updated = (await writeback.json()) as { company?: CompanyApiRecord };
  return { customerReady: true, company: updated.company ?? company };
}

function isCompanyNameApiBody(value: unknown): value is { name: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.name === 'string' &&
    body.name.trim().length >= 1 &&
    body.name.length <= 100
  );
}

async function companyRoute(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (
    request.method !== 'GET' &&
    request.method !== 'POST' &&
    request.method !== 'PATCH' &&
    request.method !== 'DELETE'
  ) {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET, POST, PATCH, DELETE' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;

  if (request.method === 'GET') {
    return companyProxyResponse(env, await identityCompanyFetch(
      env,
      request,
      '/companies',
      { method: 'GET' },
    ));
  }

  if (request.method === 'DELETE') {
    return companyProxyResponse(env, await identityCompanyFetch(
      env,
      request,
      '/companies',
      { method: 'DELETE' },
    ));
  }

  const read = await readBillingJsonBody(request);
  if (!read.ok) return read.response;

  if (request.method === 'PATCH') {
    if (!isCompanyNameApiBody(read.body)) {
      return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
    }
    return companyProxyResponse(env, await identityCompanyFetch(
      env,
      request,
      '/companies',
      { method: 'PATCH', body: JSON.stringify({ name: read.body.name }) },
    ));
  }

  if (!isCompanyCreateApiBody(read.body)) {
    return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
  }
  const canonicalBody = JSON.stringify({
    name: read.body.name,
    operationId: read.body.operationId,
  });
  const result = await identityCompanyFetch(env, request, '/companies', {
    method: 'POST',
    body: canonicalBody,
  });
  if (!result.ok) return companyProxyResponse(env, result);
  const created = (await result.json()) as {
    company: CompanyApiRecord;
    membership: unknown;
    operation: { id: string; status: string } | null;
  };
  let company = created.company;
  let customerReady = company?.processorCustomerId !== null;
  if (!customerReady && created.operation?.status === 'pending') {
    const attempt = await createCompanyCustomer(
      env,
      outcome.session.accountId,
      request.headers.get('cookie') ?? '',
      company,
      created.operation.id,
    );
    customerReady = attempt.customerReady;
    company = attempt.company;
  }
  return withSecurityHeaders(Response.json(
    { company, membership: created.membership, customerReady },
    { status: result.status, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function isCompanyInviteApiBody(value: unknown): value is { role: 'admin' | 'member' } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    (body.role === 'admin' || body.role === 'member')
  );
}

function isCompanyInviteRevokeApiBody(value: unknown): value is { inviteHash: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.inviteHash === 'string' &&
    /^[0-9a-f]{64}$/.test(body.inviteHash)
  );
}

function isCompanyInviteRedeemApiBody(value: unknown): value is { token: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.token === 'string' &&
    body.token.length >= 1 &&
    body.token.length <= 512
  );
}

async function companyInvitesRoute(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST, DELETE' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const read = await readBillingJsonBody(request);
  if (!read.ok) return read.response;

  let canonicalBody: string;
  if (request.method === 'POST') {
    if (!isCompanyInviteApiBody(read.body)) {
      return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
    }
    canonicalBody = JSON.stringify({ role: read.body.role });
  } else {
    if (!isCompanyInviteRevokeApiBody(read.body)) {
      return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
    }
    canonicalBody = JSON.stringify({ inviteHash: read.body.inviteHash });
  }

  return companyProxyResponse(env, await identityCompanyFetch(
    env,
    request,
    '/companies/invites',
    { method: request.method, body: canonicalBody },
  ));
}

async function companyInviteRedeemRoute(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const read = await readBillingJsonBody(request);
  if (!read.ok) return read.response;
  if (!isCompanyInviteRedeemApiBody(read.body)) {
    return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
  }
  return companyProxyResponse(env, await identityCompanyFetch(
    env,
    request,
    '/companies/invites/redeem',
    { method: 'POST', body: JSON.stringify({ token: read.body.token }) },
  ));
}

function isCompanySeatApiBody(value: unknown): value is {
  quantity: number;
  operationId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.quantity === 'number' &&
    Number.isInteger(body.quantity) &&
    body.quantity >= 1 &&
    body.quantity <= 10_000 &&
    typeof body.operationId === 'string' &&
    BILLING_OPERATION_ID_RE.test(body.operationId)
  );
}

function stripeSubscriptionItemId(json: unknown): string | null {
  const items = recordOf(json)?.items;
  if (!Array.isArray(items)) return null;
  const first = items[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return null;
  const id = (first as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function settleSeatChangeViaDo(
  env: Env,
  cookie: string,
  operationId: string,
  outcome: 'success' | 'failure' | 'unknown',
): Promise<void> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  await identity.fetch(new Request(IDENTITY_COMPANY_SEAT_SETTLE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ operationId, outcome }),
  }));
}

function seatPending(operationId: string): Response {
  return withSecurityHeaders(Response.json(
    { status: 'pending', operationId },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function seatSettled(): Response {
  return withSecurityHeaders(Response.json(
    { status: 'settled' },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  ));
}

async function applySeatChange(
  env: Env,
  cookie: string,
  reservation: {
    companyId: string;
    operationId: string;
    targetQuantity: number;
    prorationBehavior: string;
    processorSubscriptionId: string;
  },
): Promise<Response> {
  const billing = billingEnvFor(env);
  if (!billing.apiBaseAllowed || billing.secretKey === null) {
    await settleSeatChangeViaDo(env, cookie, reservation.operationId, 'failure');
    return billingUnavailable();
  }

  let subscriptionResult;
  try {
    subscriptionResult = await executeStripeRequest(
      new Request(`${billing.apiBaseUrl}/v1/subscriptions/${reservation.processorSubscriptionId}`, {
        method: 'GET',
      }),
      billing.secretKey,
    );
  } catch {
    subscriptionResult = null;
  }
  if (!subscriptionResult || !subscriptionResult.ok) {
    await settleSeatChangeViaDo(env, cookie, reservation.operationId, 'unknown');
    return seatPending(reservation.operationId);
  }
  const itemId = stripeSubscriptionItemId(subscriptionResult.json);
  if (itemId === null) {
    await settleSeatChangeViaDo(env, cookie, reservation.operationId, 'failure');
    return stripeRequestFailed();
  }

  const params = new URLSearchParams();
  params.append('items[0][id]', itemId);
  params.append('items[0][quantity]', String(reservation.targetQuantity));
  params.append('proration_behavior', reservation.prorationBehavior);
  let updateResult;
  try {
    updateResult = await executeStripeRequest(
      new Request(`${billing.apiBaseUrl}/v1/subscriptions/${reservation.processorSubscriptionId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': `op:company:${reservation.companyId}:${reservation.operationId}`,
        },
        body: params.toString(),
      }),
      billing.secretKey,
    );
  } catch {
    updateResult = null;
  }
  if (!updateResult) {
    await settleSeatChangeViaDo(env, cookie, reservation.operationId, 'unknown');
    return seatPending(reservation.operationId);
  }
  if (updateResult.ok) {
    await settleSeatChangeViaDo(env, cookie, reservation.operationId, 'success');
    return seatSettled();
  }
  if (updateResult.status >= 400 && updateResult.status < 500) {
    await settleSeatChangeViaDo(env, cookie, reservation.operationId, 'failure');
    return stripeRequestFailed();
  }
  await settleSeatChangeViaDo(env, cookie, reservation.operationId, 'unknown');
  return seatPending(reservation.operationId);
}

async function companySeatsRoute(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const read = await readBillingJsonBody(request);
  if (!read.ok) return read.response;
  if (!isCompanySeatApiBody(read.body)) {
    return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
  }
  const cookie = request.headers.get('cookie') ?? '';
  const canonicalBody = JSON.stringify({
    quantity: read.body.quantity,
    operationId: read.body.operationId,
  });
  const result = await identityCompanyFetch(env, request, '/companies/seats', {
    method: 'POST',
    body: canonicalBody,
  });
  if (!result.ok) return companyProxyResponse(env, result);
  const reservation = (await result.json()) as {
    status: string;
    companyId: string;
    operationId: string;
    targetQuantity: number;
    direction: string;
    prorationBehavior: string;
    processorSubscriptionId: string;
  };
  return applySeatChange(env, cookie, reservation);
}

function isCompanyMemberApiBody(value: unknown): value is { accountId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.accountId === 'string' &&
    body.accountId.length >= 1 &&
    body.accountId.length <= 128
  );
}

async function companyMemberRevokeRoute(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const read = await readBillingJsonBody(request);
  if (!read.ok) return read.response;
  if (!isCompanyMemberApiBody(read.body)) {
    return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
  }
  return companyProxyResponse(env, await identityCompanyFetch(
    env,
    request,
    '/companies/members/revoke',
    { method: 'POST', body: JSON.stringify({ accountId: read.body.accountId }) },
  ));
}

async function companyOwnerRoute(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const read = await readBillingJsonBody(request);
  if (!read.ok) return read.response;
  if (!isCompanyMemberApiBody(read.body)) {
    return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
  }
  return companyProxyResponse(env, await identityCompanyFetch(
    env,
    request,
    '/companies/owner',
    { method: 'POST', body: JSON.stringify({ accountId: read.body.accountId }) },
  ));
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
  const cookie = request.headers.get('cookie') ?? '';
  const results = await Promise.allSettled(
    roomIds.map(async (roomId) => {
      if (!isValidRoomId(roomId)) throw new Error('Invalid room id');
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
      // Cleanup succeeded, remove from pending_erasures
      await identity.fetch(new Request('https://identity/accounts/clear-erasure', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        body: JSON.stringify({ roomId }),
      }));
    }),
  );

  // Log any failures but don't fail the overall erasure
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      /*
       * Constant format string, room id passed as an argument.
       *
       * A room id reaches this from the request, so interpolating it into the
       * first argument lets a crafted id carry format specifiers and forge the
       * shape of the log line around it.
       */
      console.error(
        'Failed to erase room',
        roomIds[i],
        (results[i] as PromiseRejectedResult).reason,
      );
    }
  }

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

async function resolvePlanMaxUsers(env: Env, accountId: string): Promise<number | null> {
  try {
    const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
    const response = await identity.fetch(new Request(
      `${IDENTITY_ACCOUNT_PLAN}?accountId=${encodeURIComponent(accountId)}`,
    ));
    if (!response.ok) return null;
    const body = await response.json() as { limits?: { maxUsersPerRoom?: unknown } };
    const cap = body.limits?.maxUsersPerRoom;
    return typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : null;
  } catch {
    return null;
  }
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
  name: string | null = null,
): Promise<Response> {
  return syncOwnedRoom(env, cookie, 'POST', { roomId, name });
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
  planMaxUsers: number | null = null,
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
  applyPlanMaxUsersParam(target, planMaxUsers);

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

/**
 * Releases a room's file-byte reservation after an upload that stored nothing
 * (missing object, or bytes that did not match the declared size). The room's
 * settle endpoint keeps its cap check for positive adjustments, so the
 * response is returned rather than ignored.
 */
function settleReservedFileBytes(
  env: Env,
  roomId: string,
  url: URL,
  session: ValidatedSession | null,
  guest: boolean,
  reserved: number,
  actual: number,
): Promise<Response> {
  return forward(
    env,
    roomId,
    '/room/files/settle',
    new Request('https://room/room/files/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reserved, actual }),
    }),
    url,
    session,
    guest,
  );
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

interface StripeWebhookEvent {
  id: string;
  type: string;
  livemode: boolean;
  created: number;
  objectId: string;
}

function parseStripeEvent(value: unknown): StripeWebhookEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  if (typeof record.type !== 'string' || record.type.length === 0) return null;
  if (typeof record.livemode !== 'boolean') return null;
  if (typeof record.created !== 'number' || !Number.isFinite(record.created)) return null;
  const data = record.data;
  const object = typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>).object
    : undefined;
  const objectId = typeof object === 'object' && object !== null
    ? (object as Record<string, unknown>).id
    : undefined;
  if (typeof objectId !== 'string' || objectId.length === 0) return null;
  return {
    id: record.id,
    type: record.type,
    livemode: record.livemode,
    created: record.created * 1000,
    objectId,
  };
}

function webhookApplyBody(
  event: StripeWebhookEvent,
  payloadHash: string,
  objects?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    signatureVerified: true,
    payloadHash,
    event: {
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      created: event.created,
    },
  };
  if (objects !== undefined) body.objects = objects;
  return body;
}

async function forwardWebhookEvent(
  env: Env,
  event: StripeWebhookEvent,
  payloadHash: string,
  objects?: Record<string, unknown>,
): Promise<Response> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const verdict = await identity.fetch(new Request(
    'https://identity/billing/events/apply',
    internalJson(webhookApplyBody(event, payloadHash, objects)),
  ));
  return withSecurityHeaders(verdict);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function idValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  const record = recordOf(value);
  if (record === null) return null;
  const id = record.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function secondsToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null;
}

function normalizeSubscription(value: unknown): Record<string, unknown> | null {
  const record = recordOf(value);
  if (record === null) return null;
  const id = idValue(record.id);
  if (id === null) return null;
  const items = recordOf(record.items);
  const firstItem = Array.isArray(items?.data) ? recordOf(items.data[0]) : null;
  const pauseCollection = recordOf(record.pause_collection);
  return {
    id,
    customer: idValue(record.customer),
    status: typeof record.status === 'string' ? record.status : 'unknown',
    canceledAt: secondsToMs(record.canceled_at),
    currentPeriodEnd: secondsToMs(firstItem?.current_period_end ?? record.current_period_end),
    pauseCollection: pauseCollection === null
      ? null
      : {
          behavior: typeof pauseCollection.behavior === 'string'
            ? pauseCollection.behavior
            : 'void',
        },
  };
}

function normalizeInvoicePayment(value: unknown): { id: string; amount: number } | null {
  const record = recordOf(value);
  if (record === null) return null;
  const payment = recordOf(record.payment);
  const id = idValue(payment?.charge)
    ?? idValue(record.charge)
    ?? idValue(payment?.payment_intent)
    ?? idValue(record.payment_intent)
    ?? idValue(record.id);
  if (id === null) return null;
  return { id, amount: typeof record.amount === 'number' ? record.amount : 0 };
}

function normalizeInvoice(value: unknown): Record<string, unknown> | null {
  const record = recordOf(value);
  if (record === null) return null;
  const id = idValue(record.id);
  if (id === null) return null;
  const parent = recordOf(record.parent);
  const subscriptionDetails = recordOf(parent?.subscription_details);
  const paymentsList = recordOf(record.payments);
  const paymentEntries = Array.isArray(paymentsList?.data) ? paymentsList.data : [];
  const payments = paymentEntries
    .map(normalizeInvoicePayment)
    .filter((payment): payment is { id: string; amount: number } => payment !== null);
  const firstPayment = recordOf(paymentEntries[0]);
  const firstPaymentDetails = recordOf(firstPayment?.payment);
  return {
    id,
    customer: idValue(record.customer),
    status: typeof record.status === 'string' ? record.status : undefined,
    amountPaid: typeof record.amount_paid === 'number' ? record.amount_paid : 0,
    currency: typeof record.currency === 'string' ? record.currency : undefined,
    paymentIntent: idValue(record.payment_intent)
      ?? idValue(firstPaymentDetails?.payment_intent),
    subscription: idValue(subscriptionDetails?.subscription)
      ?? idValue(record.subscription),
    payments,
  };
}

function normalizeDispute(
  disputeValue: unknown,
  chargeValue: unknown,
): Record<string, unknown> | null {
  const dispute = recordOf(disputeValue);
  if (dispute === null) return null;
  const id = idValue(dispute.id);
  if (id === null) return null;
  const charge = recordOf(chargeValue) ?? recordOf(dispute.charge);
  const chargeId = idValue(dispute.charge) ?? idValue(chargeValue);
  return {
    id,
    status: typeof dispute.status === 'string' ? dispute.status : undefined,
    charge: chargeId === null
      ? undefined
      : { id: chargeId, customer: idValue(charge?.customer) },
  };
}

type WebhookFetchResult = { ok: true; json: unknown } | { ok: false };

async function executeWebhookFetch(
  billing: BillingEnv,
  request: Request,
): Promise<WebhookFetchResult> {
  if (billing.secretKey === null) return { ok: false };
  try {
    const result = await executeStripeRequest(request, billing.secretKey);
    return result.ok ? { ok: true, json: result.json } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function fetchWebhookObjects(
  billing: BillingEnv,
  event: StripeWebhookEvent,
): Promise<Record<string, unknown> | null> {
  if (!billing.apiBaseAllowed) return null;
  const request = eventsFetchMapRequest(
    billing.apiBaseUrl,
    billing.secretKey ?? '',
    event.type,
    event.objectId,
  );
  if (request === null) return {};

  const fetched = await executeWebhookFetch(billing, request);
  if (!fetched.ok) return null;
  const json = fetched.json;

  if (event.type.startsWith('customer.subscription.')) {
    const subscription = normalizeSubscription(json);
    return subscription === null ? null : { subscription };
  }

  if (event.type.startsWith('invoice.')) {
    const invoice = normalizeInvoice(json);
    if (invoice === null) return null;
    const objects: Record<string, unknown> = { invoice };
    const record = recordOf(json);
    const parent = recordOf(record?.parent);
    const subscriptionDetails = recordOf(parent?.subscription_details);
    const subscription = normalizeSubscription(subscriptionDetails?.subscription);
    if (subscription !== null) objects.subscription = subscription;
    return objects;
  }

  if (event.type === 'charge.refunded') {
    const id = idValue(recordOf(json)?.id);
    return id === null ? null : { charge: { id } };
  }

  if (event.type.startsWith('charge.dispute.')) {
    const disputeRecord = recordOf(json);
    const disputeId = idValue(disputeRecord?.id);
    if (disputeId === null) return null;
    let chargeValue = disputeRecord?.charge;
    if (recordOf(chargeValue) === null) {
      const chargeId = idValue(chargeValue);
      if (chargeId === null) return null;
      const chargeRequest = eventsFetchMapRequest(
        billing.apiBaseUrl,
        billing.secretKey ?? '',
        'charge.refunded',
        chargeId,
      );
      if (chargeRequest === null) return null;
      const fetchedCharge = await executeWebhookFetch(billing, chargeRequest);
      if (!fetchedCharge.ok) return null;
      chargeValue = fetchedCharge.json;
    }
    const dispute = normalizeDispute(json, chargeValue);
    return dispute === null ? null : { dispute };
  }

  if (event.type.startsWith('checkout.session.')) {
    const subscriptionRef = recordOf(json)?.subscription;
    if (recordOf(subscriptionRef) !== null) {
      const subscription = normalizeSubscription(subscriptionRef);
      return subscription === null ? null : { subscription };
    }
    const subscriptionId = idValue(subscriptionRef);
    if (subscriptionId === null) return {};
    const subscriptionRequest = eventsFetchMapRequest(
      billing.apiBaseUrl,
      billing.secretKey ?? '',
      'customer.subscription.updated',
      subscriptionId,
    );
    if (subscriptionRequest === null) return null;
    const fetchedSubscription = await executeWebhookFetch(billing, subscriptionRequest);
    if (!fetchedSubscription.ok) return null;
    const subscription = normalizeSubscription(fetchedSubscription.json);
    return subscription === null ? null : { subscription };
  }

  return {};
}

async function handleStripeWebhook(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > BILLING_WEBHOOK_MAX_BODY_BYTES) {
    return withSecurityHeaders(new Response('Body too large', { status: 413 }));
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > BILLING_WEBHOOK_MAX_BODY_BYTES) {
    return withSecurityHeaders(new Response('Body too large', { status: 413 }));
  }

  const billing = readBillingEnv({
    STRIPE_API_BASE: env.STRIPE_API_BASE,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
  });
  const verification = await verifyStripeSignature(
    rawBody,
    request.headers.get('stripe-signature'),
    billing.webhookSecret === null ? [] : [billing.webhookSecret],
    Date.now(),
  );
  if (!verification.valid) {
    return withSecurityHeaders(new Response(null, { status: 400 }));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return withSecurityHeaders(new Response(null, { status: 400 }));
  }
  const event = parseStripeEvent(parsed);
  if (event === null) {
    return withSecurityHeaders(new Response(null, { status: 400 }));
  }

  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const existing = await identity.fetch(
    `https://identity/billing/events/status?id=${encodeURIComponent(event.id)}`,
  );
  if (existing.ok) {
    return withSecurityHeaders(existing);
  }
  if (existing.status !== 404) {
    return withSecurityHeaders(new Response(null, { status: 500 }));
  }

  if (!event.livemode) {
    return forwardWebhookEvent(env, event, verification.payloadHash);
  }

  const objects = await fetchWebhookObjects(billing, event);
  if (objects === null) {
    return withSecurityHeaders(new Response(null, { status: 500 }));
  }
  const verdict = await forwardWebhookEvent(
    env,
    event,
    verification.payloadHash,
    Object.keys(objects).length > 0 ? objects : undefined,
  );
  const verdictBody = await verdict.clone().json().catch(() => null);
  scheduleCollectionExecutor(env, ctx, verdictBody, billing);
  return verdict;
}

/**
 * D-6 step 1: an applied event whose ordering row is still missing its
 * collection state comes back naming the subject to run. Claim, Stripe, and
 * settle then run after the webhook response (`waitUntil`, spec §7.5); a
 * missed schedule only defers convergence to R-1. The executor re-checks the
 * claim inside the IdentityDO, so a stale handoff sends nothing.
 */
function scheduleCollectionExecutor(
  env: Env,
  ctx: ExecutionContext,
  verdictBody: unknown,
  billing: BillingEnv,
): void {
  if (!billing.apiBaseAllowed || billing.secretKey === null) return;
  const subject = parseCollectionSubject(verdictBody);
  if (subject === null) return;
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  ctx.waitUntil(
    runCollectionExecutor(
      { identityFetch: (request) => identity.fetch(request), billing },
      subject,
    ).catch((error) => {
      console.error(
        '[billing:executor]',
        JSON.stringify({
          subjectKind: subject.subjectKind,
          subjectId: subject.subjectId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }),
  );
}

function billingEnvFor(env: Env): BillingEnv {
  return readBillingEnv({
    STRIPE_API_BASE: env.STRIPE_API_BASE,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
  });
}

function billingPriceId(env: Env, planId: PlanId): string | null {
  const priceEnv = PLAN_CATALOG[planId].priceEnv;
  if (priceEnv === null) return null;
  const value = (env as unknown as Record<string, unknown>)[priceEnv];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isBillingCheckoutBody(value: unknown): value is {
  planId: PlanId;
  operationId: string;
  referralCode?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.planId !== 'string' || !PERSONAL_PAID_PLANS.has(body.planId)) return false;
  if (typeof body.operationId !== 'string' || !BILLING_OPERATION_ID_RE.test(body.operationId)) {
    return false;
  }
  if (body.referralCode !== undefined) {
    if (
      typeof body.referralCode !== 'string'
      || !BILLING_REFERRAL_CODE_RE.test(body.referralCode)
    ) {
      return false;
    }
  }
  return true;
}

function isBillingPortalBody(value: unknown): value is { operationId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return typeof body.operationId === 'string' && BILLING_OPERATION_ID_RE.test(body.operationId);
}

async function readBillingJsonBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (bodyTooLarge(request.headers.get('content-length'))) {
    return {
      ok: false,
      response: withSecurityHeaders(new Response('Body too large', { status: 413 })),
    };
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return {
      ok: false,
      response: withSecurityHeaders(
        new Response('Content type must be application/json', { status: 415 }),
      ),
    };
  }
  const bounded = await readBoundedJsonBody(request);
  if (!bounded.ok) {
    return {
      ok: false,
      response: withSecurityHeaders(new Response('Body too large', { status: 413 })),
    };
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bounded.buffer)) };
  } catch {
    return {
      ok: false,
      response: withSecurityHeaders(Response.json({ error: 'Invalid JSON body' }, { status: 400 })),
    };
  }
}

function billingUnavailable(): Response {
  return withSecurityHeaders(Response.json(
    { error: 'Billing unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function stripeRequestFailed(): Response {
  return withSecurityHeaders(Response.json(
    { error: 'Stripe request failed' },
    { status: 502, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function billingNoSubscription(): Response {
  return withSecurityHeaders(Response.json(
    { error: 'No subscription' },
    { status: 409, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function billingConflict(): Response {
  return withSecurityHeaders(Response.json(
    { error: 'Conflict' },
    { status: 409, headers: { 'Cache-Control': 'no-store' } },
  ));
}

async function billingRateLimit(env: Env, request: Request): Promise<Response | null> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(new Request(IDENTITY_BILLING_RATE_LIMIT, {
    method: 'POST',
    headers: { cookie: request.headers.get('cookie') ?? '' },
  }));
  if (!result.ok) {
    return withSecurityHeaders(new Response(result.body, {
      status: result.status,
      headers: result.headers,
    }));
  }
  const body = (await result.json()) as { allowed?: unknown; retryAfterMs?: unknown };
  if (body.allowed === true) return null;
  const retryAfterMs = typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)
    ? body.retryAfterMs
    : 0;
  return rateLimited(env, retryAfterMs);
}

async function recordBillingOperation(
  env: Env,
  session: ValidatedSession,
  operationId: string,
  kind: 'checkout' | 'portal',
  details?: {
    planId?: PlanId;
    referralCode?: string;
    successUrl?: string;
    cancelUrl?: string;
    returnUrl?: string;
  },
): Promise<Response | null> {
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(new Request(IDENTITY_BILLING_OPERATIONS, internalJson({
    subjectKind: 'account',
    subjectId: session.accountId,
    operationId,
    kind,
    ...details,
  })));
  if (result.status === 409) return billingConflict();
  if (!result.ok) {
    return withSecurityHeaders(new Response(result.body, {
      status: result.status,
      headers: result.headers,
    }));
  }
  return null;
}

function stripeSessionUrl(json: unknown): string | null {
  const record = recordOf(json);
  const url = record?.url;
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

async function executeBillingSession(
  billing: BillingEnv,
  request: Request,
): Promise<Response> {
  const secretKey = billing.secretKey;
  if (secretKey === null) return billingUnavailable();
  let result;
  try {
    result = await executeStripeRequest(request, secretKey);
  } catch {
    return stripeRequestFailed();
  }
  if (!result.ok) return stripeRequestFailed();
  const url = stripeSessionUrl(result.json);
  if (url === null) return stripeRequestFailed();
  return withSecurityHeaders(Response.json(
    { url },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  ));
}

async function billingCheckout(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const limited = await billingRateLimit(env, request);
  if (limited) return limited;
  const read = await readBillingJsonBody(request);
  if (!read.ok) return read.response;
  if (!isBillingCheckoutBody(read.body)) {
    return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
  }
  const { planId, operationId, referralCode } = read.body;
  const billing = billingEnvFor(env);
  const priceId = billingPriceId(env, planId);
  if (!billing.apiBaseAllowed || billing.secretKey === null || priceId === null) {
    return billingUnavailable();
  }
  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/whiteboard?billing=success`;
  const cancelUrl = `${origin}/pricing?billing=cancelled`;
  const recorded = await recordBillingOperation(env, outcome.session, operationId, 'checkout', {
    planId,
    referralCode,
    successUrl,
    cancelUrl,
  });
  if (recorded) return recorded;

  const stripeRequest = checkoutSessionRequest(billing.apiBaseUrl, billing.secretKey, {
    accountId: outcome.session.accountId,
    planId,
    priceId,
    operationId,
    successUrl,
    cancelUrl,
    referralCode,
  });
  return executeBillingSession(billing, stripeRequest);
}

async function billingPortal(
  env: Env,
  request: Request,
  principal: VerifiedAccessPrincipal,
): Promise<Response> {
  if (request.method !== 'POST') {
    return withSecurityHeaders(Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    ));
  }
  const outcome = await sessionAuthorized(env, request, principal);
  if (outcome.denied) return outcome.denied;
  const limited = await billingRateLimit(env, request);
  if (limited) return limited;
  const read = await readBillingJsonBody(request);
  if (!read.ok) return read.response;
  if (!isBillingPortalBody(read.body)) {
    return withSecurityHeaders(Response.json({ error: 'Invalid body' }, { status: 400 }));
  }
  const { operationId } = read.body;
  const billing = billingEnvFor(env);
  if (!billing.apiBaseAllowed || billing.secretKey === null) {
    return billingUnavailable();
  }

  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const customerResponse = await identity.fetch(new Request(IDENTITY_BILLING_CUSTOMER, {
    method: 'GET',
    headers: { cookie: request.headers.get('cookie') ?? '' },
  }));
  if (!customerResponse.ok) {
    return withSecurityHeaders(new Response(customerResponse.body, {
      status: customerResponse.status,
      headers: customerResponse.headers,
    }));
  }
  const customer = (await customerResponse.json()) as { processorCustomerId?: unknown };
  const processorCustomerId = customer.processorCustomerId;
  if (typeof processorCustomerId !== 'string' || processorCustomerId.length === 0) {
    return billingNoSubscription();
  }

  const origin = new URL(request.url).origin;
  const returnUrl = `${origin}/whiteboard?billing=portal`;
  const recorded = await recordBillingOperation(env, outcome.session, operationId, 'portal', {
    returnUrl,
  });
  if (recorded) return recorded;

  const stripeRequest = portalSessionRequest(billing.apiBaseUrl, billing.secretKey, {
    accountId: outcome.session.accountId,
    processorCustomerId,
    operationId,
    returnUrl,
  });
  return executeBillingSession(billing, stripeRequest);
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
      // only the exact shapes `isMarketingRoomRedirectPath` accepts redirect,
      // so this cannot be turned into an open redirect.
      const signInPath = isMarketingRoomRedirectPath(url.pathname);
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
    if (
      hostKind === 'teacher'
      && url.pathname === BILLING_WEBHOOK_PATH
      && request.method !== 'POST'
    ) {
      return withSecurityHeaders(Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'POST' } },
      ));
    }
    if (!isRouteAllowedOnHost(url.pathname, request.method, hostKind)) return hostNotFound();
    const isGuestHost = hostKind === 'guest';

    if (hostKind === 'teacher' && url.pathname === BILLING_WEBHOOK_PATH) {
      return handleStripeWebhook(env, request, ctx);
    }

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
      if (url.pathname === COMPANY_API) {
        return companyRoute(env, request, principal);
      }
      if (url.pathname === COMPANY_INVITES_API) {
        return companyInvitesRoute(env, request, principal);
      }
      if (url.pathname === COMPANY_INVITE_REDEEM_API) {
        return companyInviteRedeemRoute(env, request, principal);
      }
      if (url.pathname === COMPANY_SEATS_API) {
        return companySeatsRoute(env, request, principal);
      }
      if (url.pathname === COMPANY_MEMBER_REVOKE_API) {
        return companyMemberRevokeRoute(env, request, principal);
      }
      if (url.pathname === COMPANY_OWNER_API) {
        return companyOwnerRoute(env, request, principal);
      }
      if (url.pathname === BILLING_CHECKOUT_PATH) {
        return billingCheckout(env, request, principal);
      }
      if (url.pathname === BILLING_PORTAL_PATH) {
        return billingPortal(env, request, principal);
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

        /*
         * A key that already holds bytes is immutable by size.
         *
         * The room used to credit an overwrite for the stored object before
         * the new one was measured, and the credit came from this Worker-side
         * head: eight concurrent PUTs of the same key each read the same
         * stored size and each subtracted it, while R2 freed it once. Refusing
         * the different size removes the race by construction, and a same-size
         * re-PUT is free because the net storage change is zero.
         */
        const key = buildR2ObjectKey(roomId, fileId);
        const existing = await env.BOARD_FILES.head(key);
        if (existing) {
          if (existing.size !== declaredSize) {
            return withSecurityHeaders(new Response(
              'File id already stored with a different size',
              { status: 409 },
            ));
          }
          const stored = await env.BOARD_FILES.put(key, request.body, {
            httpMetadata: {
              contentType: mimeType!,
            },
          });
          if (!stored || stored.size !== existing.size) {
            if (stored) await env.BOARD_FILES.delete(key);
            return withSecurityHeaders(new Response('File too large', { status: 413 }));
          }
          return withSecurityHeaders(Response.json({ ok: true }, { status: 201 }));
        }

        /*
         * Reserve the declared size before touching R2.
         *
         * The old flow checked the quota, wrote the object, and then counted
         * the bytes -- a read, a network write, and a write with no
         * serialization between them, so two uploads could each pass a check
         * taken against the same total. The room commits the reservation in
         * one synchronous SQL turn, so the next request sees the reduced
         * headroom.
         */
        const reservation = await forward(
          env,
          roomId,
          '/room/files/reserve',
          new Request('https://room/room/files/reserve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bytes: declaredSize }),
          }),
          url,
          session,
          guestCaller,
        );
        if (!reservation.ok) return reservation;

        // Streamed, not buffered: an image is megabytes and reading it into
        // memory first would put the whole file in the isolate's heap.
        const stored = await env.BOARD_FILES.put(key, request.body, {
          httpMetadata: {
            contentType: mimeType!,
          },
        });

        /*
         * Checked against what actually arrived.
         *
         * Content-Length is the client's word about its own request. A peer
         * that declares a small body and then streams a large one would
         * otherwise write it in full, and the bucket -- and the bill -- would
         * grow to whatever anyone with a grant felt like sending. The bytes
         * are already spent by the time this runs, so this bounds storage
         * rather than bandwidth; it is the difference between one oversized
         * request and an unbounded store. A mismatch is also where the
         * reservation is released.
         */
        if (!stored || stored.size !== declaredSize) {
          if (stored) await env.BOARD_FILES.delete(key);
          await settleReservedFileBytes(env, roomId, url, session, guestCaller, declaredSize, 0);
          return withSecurityHeaders(stored
            ? new Response('File too large', { status: 413 })
            : new Response('Upload failed', { status: 500 }));
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
      // ROOM_API captures the raw remainder into the subpath. Collapse empty
      // segments once so every exact comparison below -- the destructive-action
      // gate, the limiters, the settings clone, the owned-room bookkeeping and
      // the internal-route refusals -- sees `/x/`, `//x` and `/a//b/` as `/x`
      // and `/a/b`. Stripping only trailing slashes read `//files/reserve` as
      // a different path and forwarded it to the room.
      const rawSubpath = match[2] ?? '';
      const subpathParts = rawSubpath.split('/').filter(Boolean);
      const subpath = subpathParts.length > 0 ? `/${subpathParts.join('/')}` : '';
      // Board bytes are consumed by BOARD_FILE_API, which matches exactly
      // /files/<fileId> with no trailing slash. Every other /files path names
      // an action the Worker issues to the room itself (authorize-write,
      // authorize-read, reserve, settle); a session cookie alone must not
      // reach them, so the public API refuses the whole subtree.
      if (subpath === '/files' || subpath.startsWith('/files/')) {
        return withSecurityHeaders(new Response(null, { status: 404 }));
      }
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
      if (
        (request.method === 'POST' || request.method === 'DELETE')
        && subpath === '/presence'
        && session
        && shouldRateLimitRoomCreate(env, request)
      ) {
        const limit = presencePostLimiterFor(env).take(session.accountId);
        if (!limit.ok) return rateLimited(env, limit.retryAfterMs);
      }
      // The verified account decides which rooms this caller may touch.
      const settingsClone = session
        && subpath === '/settings'
        && (request.method === 'POST' || request.method === 'PATCH')
        ? request.clone()
        : null;
      let planMaxUsers: number | null = null;
      if (
        session
        && (
          (request.method === 'POST' && subpath === '')
          || ((request.method === 'POST' || request.method === 'PATCH') && subpath === '/settings')
        )
      ) {
        planMaxUsers = await resolvePlanMaxUsers(env, session.accountId);
      }
      const response = await forward(
        env,
        roomId,
        `/room${subpath}`,
        request,
        url,
        session,
        guestCaller,
        planMaxUsers,
      );
      if (session && subpath === '') {
        const cookie = request.headers.get('cookie') ?? '';
        if (request.method === 'POST' && response.ok) {
          let hasCreatorGrant = false;
          // Creation carries the owner settings, so the name the teacher
          // typed is already in this response. The owned-room index is what
          // the list reads, so the name has to travel with the reservation.
          let roomName: string | null = null;
          try {
            const payload = await response.clone().json() as {
              hasCreatorGrant?: unknown;
              name?: unknown;
            };
            hasCreatorGrant = payload.hasCreatorGrant === true;
            roomName = typeof payload.name === 'string' ? payload.name : null;
          } catch {
            hasCreatorGrant = false;
          }
          if (hasCreatorGrant) {
            const recorded = await reserveOwnedRoomSlot(env, cookie, roomId, roomName);
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
