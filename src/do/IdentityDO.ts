import { DurableObject } from 'cloudflare:workers';
import { isValidRoomId } from '../lib/worker/requestGuard';
import { DODatabase } from '../lib/whiteboard/doDatabase';
import type { RoomDatabase } from '../lib/whiteboard/db';
import {
  IdentityInputError,
  MAX_AUTHORIZATION_BATCH,
  applyIdentitySchema,
  listOwnedRooms,
  readAccountAuthorizations,
  recordOwnedRoom,
  removeOwnedRoom,
  ownedRoomExists,
  resolveAccountForSubject,
} from '../lib/identity/identityStore';
import {
  SessionUnauthorizedError,
  authorizeSessionForPrincipal,
  clearSessionCookie,
  confirmSession,
  disableAccount,
  enableAccount,
  eraseOwnAccount,
  exportOwnAccountData,
  issueSessionForVerifiedPrincipal,
  logoutSession,
  parseSessionCookie,
  purgeExpiredSessions,
  revokeAllSessions,
  rotateSession,
  sessionAllowsDestructiveAction,
  sessionCookie,
  validateSession,
} from '../lib/identity/sessionStore';
import {
  PLAN_LIMIT_ERROR,
  PLAN_LIMIT_STATUS,
  canAddOwnedRoom,
} from '../lib/plan/limits';

const RESOLVE_PATH = '/subjects/resolve';
const ISSUE_SESSION_PATH = '/sessions/issue';
const CURRENT_SESSION_PATH = '/sessions/current';
const AUTHORIZE_SESSION_PATH = '/sessions/authorize';
const CONFIRM_SESSION_PATH = '/sessions/confirm';
const ROTATE_SESSION_PATH = '/sessions/rotate';
const LOGOUT_SESSION_PATH = '/sessions/logout';
const AUTHORIZATIONS_PATH = '/accounts/authorizations';
const EXPORT_ACCOUNT_PATH = '/accounts/export';
const ERASE_ACCOUNT_PATH = '/accounts';
const ACCOUNT_ROOMS_PATH = '/accounts/rooms';
const REVOKE_ALL_PATH = '/accounts/revoke-all';
const DISABLE_ACCOUNT_PATH = '/accounts/disable';
const ENABLE_ACCOUNT_PATH = '/accounts/enable';
export const GLOBAL_IDENTITY_OBJECT_NAME = 'global';

function isSubjectBody(value: unknown): value is {
  issuer: string;
  subject: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.issuer === 'string' &&
    typeof body.subject === 'string'
  );
}

function isAuthorizationsBody(value: unknown): value is { accountIds: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Array.isArray(body.accountIds)) {
    return false;
  }
  if (body.accountIds.length > MAX_AUTHORIZATION_BATCH) return false;
  return body.accountIds.every(
    (id) => typeof id === 'string' && id.length >= 1 && id.length <= 128,
  );
}

// Actor and reason are mandatory so no authorization change can be made
// without a durable record of who made it and why.
function isAccountBody(value: unknown): value is {
  accountId: string;
  actor: string;
  reason: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 3 &&
    typeof body.actor === 'string' &&
    body.actor.trim().length > 0 &&
    body.actor.length <= 256 &&
    typeof body.reason === 'string' &&
    body.reason.trim().length > 0 &&
    body.reason.length <= 1024 &&
    typeof body.accountId === 'string' &&
    body.accountId.length >= 1 &&
    body.accountId.length <= 128
  );
}

function isOwnedRoomBody(value: unknown): value is {
  roomId: string;
  name?: string | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  if (typeof body.roomId !== 'string' || !isValidRoomId(body.roomId)) {
    return false;
  }
  if ('name' in body && body.name !== null && typeof body.name !== 'string') {
    return false;
  }
  return true;
}

function mediaType(request: Request): string | null {
  return (
    request.headers
      .get('content-type')
      ?.split(';', 1)[0]
      .trim()
      .toLowerCase() ?? null
  );
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: 'Method not allowed' },
    { status: 405, headers: { Allow: allow } },
  );
}

function unauthorized(clearCookie = false): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (clearCookie) headers.set('Set-Cookie', clearSessionCookie());
  return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
}

function noStore(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set('Cache-Control', 'no-store');
  return result;
}

async function readExactJson<T>(
  request: Request,
  guard: (value: unknown) => value is T,
): Promise<{ body: T } | { response: Response }> {
  if (mediaType(request) !== 'application/json') {
    return {
      response: Response.json(
        { error: 'Content-Type must be application/json' },
        { status: 415 },
      ),
    };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }),
    };
  }
  return guard(body)
    ? { body }
    : { response: Response.json({ error: 'Invalid body' }, { status: 400 }) };
}

/** Singleton Durable Object containing global account and session authority. */
export class IdentityDO extends DurableObject {
  readonly db: RoomDatabase;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.db = new DODatabase(ctx.storage.sql, ctx.storage);
    applyIdentitySchema(this.db);
  }

  async fetch(request: Request): Promise<Response> {
    purgeExpiredSessions(this.db);
    const url = new URL(request.url);
    if (url.pathname === RESOLVE_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isSubjectBody);
      if ('response' in parsed) return parsed.response;
      try {
        const resolved = resolveAccountForSubject(this.db, parsed.body);
        return Response.json(resolved, { status: resolved.created ? 201 : 200 });
      } catch (error) {
        if (error instanceof IdentityInputError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    if (url.pathname === ISSUE_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isSubjectBody);
      if ('response' in parsed) return parsed.response;
      try {
        const issued = await issueSessionForVerifiedPrincipal(
          this.db,
          parsed.body,
        );
        const { token: _token, createdAt: _createdAt, ...publicSession } = issued;
        return Response.json(publicSession, {
          status: 201,
          headers: noStore({ 'Set-Cookie': sessionCookie(issued) }),
        });
      } catch (error) {
        if (
          error instanceof IdentityInputError ||
          error instanceof SessionUnauthorizedError
        ) {
          return unauthorized();
        }
        throw error;
      }
    }

    if (url.pathname === CURRENT_SESSION_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const current = token
        ? await validateSession(this.db, token)
        : null;
      return current
        ? Response.json(current, { headers: noStore() })
        : unauthorized(true);
    }

    if (url.pathname === AUTHORIZE_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isSubjectBody);
      if ('response' in parsed) return parsed.response;
      const token = parseSessionCookie(request.headers.get('cookie'));
      const current = token
        ? await authorizeSessionForPrincipal(this.db, token, parsed.body)
        : null;
      return current ? Response.json(current, { headers: noStore() }) : unauthorized(true);
    }

    if (url.pathname === CONFIRM_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isSubjectBody);
      if ('response' in parsed) return parsed.response;
      const token = parseSessionCookie(request.headers.get('cookie'));
      const current = token
        ? await authorizeSessionForPrincipal(this.db, token, parsed.body)
        : null;
      if (!current) return unauthorized(true);
      const confirmed = token ? await confirmSession(this.db, token) : null;
      return confirmed
        ? Response.json(confirmed, { headers: noStore() })
        : unauthorized(true);
    }

    if (url.pathname === ROTATE_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (request.body !== null) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const token = parseSessionCookie(request.headers.get('cookie'));
      const rotated = token
        ? await rotateSession(this.db, token)
        : null;
      if (!rotated) return unauthorized(true);
      const { token: _token, createdAt: _createdAt, ...publicSession } = rotated;
      return Response.json(publicSession, {
        headers: noStore({ 'Set-Cookie': sessionCookie(rotated) }),
      });
    }

    if (url.pathname === LOGOUT_SESSION_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      if (request.body !== null) {
        return Response.json({ error: 'Invalid body' }, { status: 400 });
      }
      const token = parseSessionCookie(request.headers.get('cookie'));
      if (token) await logoutSession(this.db, token);
      return new Response(null, {
        status: 204,
        headers: noStore({ 'Set-Cookie': clearSessionCookie() }),
      });
    }

    if (url.pathname === EXPORT_ACCOUNT_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const exported = token
        ? await exportOwnAccountData(this.db, token)
        : null;
      return exported
        ? Response.json(exported, { headers: noStore() })
        : unauthorized(true);
    }

    if (url.pathname === ERASE_ACCOUNT_PATH) {
      if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);
      if (!sessionAllowsDestructiveAction(session)) {
        return Response.json(
          { error: 'Reauthentication required' },
          { status: 403, headers: noStore() },
        );
      }
      const roomIds = listOwnedRooms(this.db, session.accountId).map((room) => room.roomId);
      const erased = token ? await eraseOwnAccount(this.db, token) : null;
      if (!erased) return unauthorized(true);
      return Response.json(
        { ok: true, roomIds },
        { headers: noStore({ 'Set-Cookie': clearSessionCookie() }) },
      );
    }

    if (url.pathname === ACCOUNT_ROOMS_PATH) {
      const token = parseSessionCookie(request.headers.get('cookie'));
      const session = token ? await validateSession(this.db, token) : null;
      if (!session) return unauthorized(true);

      if (request.method === 'GET') {
        return Response.json(
          { rooms: listOwnedRooms(this.db, session.accountId) },
          { headers: noStore() },
        );
      }

      if (request.method === 'POST') {
        const parsed = await readExactJson(request, isOwnedRoomBody);
        if ('response' in parsed) return parsed.response;
        try {
          if (
            !canAddOwnedRoom(
              listOwnedRooms(this.db, session.accountId).length,
              ownedRoomExists(this.db, session.accountId, parsed.body.roomId),
            )
          ) {
            return Response.json(
              { error: PLAN_LIMIT_ERROR },
              { status: PLAN_LIMIT_STATUS, headers: noStore() },
            );
          }
          const room = recordOwnedRoom(this.db, {
            accountId: session.accountId,
            roomId: parsed.body.roomId,
            name: parsed.body.name,
            now: Date.now(),
          });
          return Response.json(room, { headers: noStore() });
        } catch (error) {
          if (error instanceof IdentityInputError) {
            return Response.json({ error: error.message }, { status: 400 });
          }
          throw error;
        }
      }

      if (request.method === 'DELETE') {
        const parsed = await readExactJson(request, isOwnedRoomBody);
        if ('response' in parsed) return parsed.response;
        removeOwnedRoom(this.db, session.accountId, parsed.body.roomId);
        return new Response(null, { status: 204, headers: noStore() });
      }

      return methodNotAllowed('GET, POST, DELETE');
    }

    // Lets a room re-check the accounts behind its already-open sockets.
    // Read-only, and it never accepts or returns a session token.
    if (url.pathname === AUTHORIZATIONS_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isAuthorizationsBody);
      if ('response' in parsed) return parsed.response;
      const statuses = readAccountAuthorizations(this.db, parsed.body.accountIds);
      return Response.json(
        { accounts: Object.fromEntries(statuses) },
        { headers: noStore() },
      );
    }

    const accountOperation =
      url.pathname === REVOKE_ALL_PATH
        ? revokeAllSessions
        : url.pathname === DISABLE_ACCOUNT_PATH
          ? disableAccount
          : url.pathname === ENABLE_ACCOUNT_PATH
            ? enableAccount
            : null;
    if (accountOperation) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const parsed = await readExactJson(request, isAccountBody);
      if ('response' in parsed) return parsed.response;
      const result = accountOperation(this.db, parsed.body.accountId, {
        actor: parsed.body.actor,
        reason: parsed.body.reason,
      });
      return result
        ? Response.json(result)
        : Response.json({ error: 'Not found' }, { status: 404 });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}

/** Returns the one global identity authority; callers do not choose its name. */
export function getIdentityObject(
  namespace: DurableObjectNamespace<IdentityDO>,
): DurableObjectStub<IdentityDO> {
  return namespace.get(namespace.idFromName(GLOBAL_IDENTITY_OBJECT_NAME));
}
