export { RoomDO } from './do/RoomDO';
export { IdentityDO } from './do/IdentityDO';
import {
  AccessVerificationError,
  verifyAccessRequest,
  type VerifiedAccessPrincipal,
} from './lib/access/accessVerifier';
import { IdentityDO, getIdentityObject } from './do/IdentityDO';
import {
  parseSessionCookie,
  type ValidatedSession,
} from './lib/identity/sessionStore';
import {
  bodyTooLarge,
  isJsonContentType,
  isValidRoomId,
  withSecurityHeaders,
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
}

// Room ids cannot be enumerated at build time, so the static export contains a
// single placeholder page that stands in for every room.
const ROOM_PAGE = /^\/whiteboard\/[^/]+\/?$/;
const ROOM_PLACEHOLDER = '/whiteboard/_room';

const ROOM_API = /^\/api\/whiteboard\/room\/([^/]+)(\/.*)?$/;
const AV_TOKEN = '/api/av/token';
const SESSION_ISSUE = '/auth/session';
const SESSION_CURRENT = '/auth/session/current';
const SESSION_LOGOUT = '/auth/session/logout';

function unauthorized(): Response {
  return withSecurityHeaders(Response.json(
    { error: 'Unauthorized' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function hasExactOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(request.url).origin;
}

function originGuard(request: Request, pathname: string): Response | null {
  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  const guarded = pathname === '/signaling'
    || (!readOnly && (
      pathname === SESSION_ISSUE
      || pathname === SESSION_LOGOUT
      || pathname.startsWith('/api/')
    ));
  if (!guarded || hasExactOrigin(request)) return null;
  return withSecurityHeaders(Response.json(
    { error: 'Origin required' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  ));
}

function internalJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
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
  if (!parseSessionCookie(cookie)) return { denied: unauthorized() };
  const identity = getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
  const result = await identity.fetch(
    new Request('https://identity/sessions/authorize', {
      ...internalJson(principal),
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
    new Request('https://identity/sessions/issue', internalJson(principal)),
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
      ...internalJson(principal),
      headers: { 'content-type': 'application/json', cookie: request.headers.get('cookie') ?? '' },
    }),
  );
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
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
  return withSecurityHeaders(new Response(result.body, { status: result.status, headers: result.headers }));
}

/** Forwards to the room's Durable Object, preserving the original query. */
function forward(
  env: Env,
  roomId: string,
  path: string,
  request: Request,
  url: URL,
  session: ValidatedSession | null = null,
): Promise<Response> {
  const target = new URL(`https://room${path}`);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  // `set` overwrites, so a client-supplied roomId/accountId/epoch on the
  // original query cannot survive into the internal request.
  target.searchParams.set('roomId', roomId);
  if (session) {
    target.searchParams.set('accountId', session.accountId);
    target.searchParams.set('accountEpoch', String(session.authorizationEpoch));
  } else {
    target.searchParams.delete('accountId');
    target.searchParams.delete('accountEpoch');
  }

  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  return stub.fetch(new Request(target, request)).then((response) => {
    // A 101 Switching Protocols upgrade carries a WebSocket pair that
    // reconstructing the Response would drop, so pass it through untouched.
    if (response.status === 101 && response.webSocket) return response;
    return withSecurityHeaders(response);
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    let principal: VerifiedAccessPrincipal;
    try {
      principal = await verifyAccessRequest(request, ctx.access, env);
    } catch (error) {
      if (error instanceof AccessVerificationError) return unauthorized();
      throw error;
    }

    // Run before local-session authorization and before any Durable Object or
    // body access. Origin is an exact serialized-origin comparison: missing,
    // null, alternate scheme/port/subdomain, and combined values fail closed.
    const originDenied = originGuard(request, url.pathname);
    if (originDenied) return originDenied;

    if (url.pathname === SESSION_ISSUE) {
      return issueSession(env, request, principal);
    }
    if (url.pathname === SESSION_CURRENT) {
      return sessionCurrent(env, request, principal);
    }
    if (url.pathname === SESSION_LOGOUT) {
      return sessionLogout(env, request);
    }

    // Assets may bootstrap the local session. Every mutable/API and signaling
    // path additionally needs that local session so local revocation remains
    // effective while an Access browser session is still alive.
    let session: ValidatedSession | null = null;
    if (url.pathname.startsWith('/api/') || url.pathname === '/signaling') {
      const outcome = await sessionAuthorized(env, request, principal);
      if (outcome.denied) return outcome.denied;
      session = outcome.session;
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
      return forward(env, roomId, '/signaling', request, url, session);
    }

    // Short-lived LiveKit join token. RoomDO enforces admission (owner/member
    // only; waiting peers get 403) and mints the JWT when LIVEKIT_* is set.
    if (url.pathname === AV_TOKEN) {
      if (request.method !== 'POST' && request.method !== 'GET') {
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET, POST' } });
      }
      const roomId = url.searchParams.get('roomId');
      if (!roomId) {
        return Response.json({ error: 'Missing roomId' }, { status: 400 });
      }
      return forward(env, roomId, '/room/av', request, url, session);
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
      }
      // The verified account decides which rooms this caller may touch.
      return forward(env, roomId, `/room${match[2] ?? ''}`, request, url, session);
    }

    // Serve the placeholder room page for any /whiteboard/<roomId> URL. The
    // page reads the real id from the address bar, which is left untouched.
    if (ROOM_PAGE.test(url.pathname) && url.pathname !== ROOM_PLACEHOLDER) {
      const rewritten = new URL(request.url);
      rewritten.pathname = ROOM_PLACEHOLDER;
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(rewritten, request)));
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
