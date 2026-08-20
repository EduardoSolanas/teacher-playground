import { DurableObject } from 'cloudflare:workers';
import { DODatabase } from '../lib/whiteboard/doDatabase';
import { applySchema, getGrantVersion, incrementGrantVersion, purgeExpiredRoomsAndTombstones, roomExists } from '../lib/whiteboard/roomSchema';
import {
  assertNotTombstoned,
  createSqlTombstoneStore,
  tombstonedJsonResponse,
} from '../lib/whiteboard/tombstone';
import { verifyGuestPin } from '../lib/whiteboard/guestPin';
import {
  bindPeerAccount,
  canWriteBoard,
  getGrantRole,
  getMembership,
  isGrantedRole,
  isOwnerRole,
  peerAccountId,
  purgeExpiredGrants,
  purgeExpiredRoomLifecycle,
} from '../lib/whiteboard/membership';
import type { RoomDatabase } from '../lib/whiteboard/db';
import { GLOBAL_IDENTITY_OBJECT_NAME } from './IdentityDO';
import {
  handleRoomGet,
  handleRoomPost,
  handleRoomSettings,
  handleRoomSettingsGet,
  handleRoomDelete,
  handleRoomAccountErasure,
} from '../lib/whiteboard/handlers/room';
import {
  handlePresenceGet,
  handlePresencePost,
  handlePresenceDelete,
} from '../lib/whiteboard/handlers/presence';
import {
  handleWaitingGet,
  handleWaitingPost,
  handleWaitingDelete,
} from '../lib/whiteboard/handlers/waiting';
import { handleAccessGet } from '../lib/whiteboard/handlers/access';
import {
  handleRequestsGet,
  handleRequestsPost,
} from '../lib/whiteboard/handlers/requests';
import { handleRequestsIdPost } from '../lib/whiteboard/handlers/requestsId';
import { issueAvTokenResponse } from '../lib/av/handleAvToken';
import {
  removeLiveKitParticipant,
  type RemoveLiveKitParticipantInput,
  type RemoveLiveKitParticipantResult,
} from '../lib/av/livekitRoomService';
import {
  MAX_BODY_BYTES,
  SIGNALING_MAX_MESSAGES_PER_WINDOW,
  SIGNALING_MAX_SOCKETS_PER_ACCOUNT,
  SIGNALING_MAX_SOCKETS_PER_ROOM,
  SIGNALING_RATE_WINDOW_MS,
} from '../lib/worker/requestGuard';
import { SIGNALING_ALLOWED_TOPIC } from '../lib/worker/signalingPolicy';
import { createRateLimiter } from '../lib/http/rateLimit';
import { logSocketClose } from '../lib/security/authEvents';

/**
 * How often live sockets are re-checked against the identity store. This is the
 * documented revocation bound: after a session is revoked or an account is
 * disabled, an already-established socket is closed within this window.
 */
export const REVOCATION_CHECK_INTERVAL_MS = 30_000;

/**
 * Lower bound so a misconfigured binding cannot turn the check into a busy
 * loop against the identity object, and cannot silently disable it either.
 */
const MIN_REVOCATION_CHECK_INTERVAL_MS = 50;

/** Close code sent to a socket whose account is no longer authorized. */
export const SOCKET_REVOKED_CLOSE_CODE = 4401;

/** Close code sent when the room itself is deleted. */
export const SOCKET_ROOM_DELETED_CLOSE_CODE = 4404;

/** Reads the override, ignoring anything unparseable or below the floor. */
function resolveCheckInterval(env: RoomEnv): number {
  const configured = Number(env.REVOCATION_CHECK_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured < MIN_REVOCATION_CHECK_INTERVAL_MS) {
    return REVOCATION_CHECK_INTERVAL_MS;
  }
  return configured;
}

function forbidden(message = 'Forbidden'): Response {
  return Response.json(
    { error: message },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  );
}

function unauthorized(message = 'Unauthorized'): Response {
  return Response.json(
    { error: message },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Parses a JSON object body, or null when it is absent or not an object. */
function parseJsonObject(bodyText: string | null): Record<string, unknown> | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown> | null, field: string): string | null {
  const value = body?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface SocketIdentity {
  accountId: string;
  sessionId: string;
  authorizationEpoch: number;
  roomId: string;
  grantVersion: number;
}

export interface RoomEnv {
  IDENTITY: DurableObjectNamespace;
  /** Test-only override; production uses REVOCATION_CHECK_INTERVAL_MS. */
  REVOCATION_CHECK_INTERVAL_MS?: string;
  /** LiveKit SFU — optional; A/V token route returns 503 when unset. */
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
}

/**
 * One Durable Object per whiteboard room. Owns both the room's SQLite state
 * and its y-webrtc signaling sockets, so a room is always a single instance.
 */
export class RoomDO extends DurableObject {
  readonly db: RoomDatabase;
  private readonly roomEnv: RoomEnv;
  private readonly checkIntervalMs: number;
  private readonly signalingMessageRate = createRateLimiter({
    windowMs: SIGNALING_RATE_WINDOW_MS,
    max: SIGNALING_MAX_MESSAGES_PER_WINDOW,
  });

  /** Injectable hook; defaults to {@link removeLiveKitParticipant}. */
  evictLiveKitParticipant: (
    input: RemoveLiveKitParticipantInput,
  ) => Promise<RemoveLiveKitParticipantResult> = removeLiveKitParticipant;

  /** Populated by tests when {@link evictLiveKitParticipant} is replaced with a spy. */
  liveKitEvictCalls?: { roomId: string; identity: string }[];

  /** Test-only override for the per-room socket cap; production always uses 32. */
  static signalingMaxSocketsPerRoomForTests: number | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.roomEnv = env as RoomEnv;
    this.checkIntervalMs = resolveCheckInterval(this.roomEnv);
    this.db = new DODatabase(ctx.storage.sql, ctx.storage);
    applySchema(this.db);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/signaling') {
      return this.handleSignalingUpgrade(request, url);
    }

    const roomId = url.searchParams.get('roomId');
    if (!roomId) {
      return Response.json({ error: 'Missing roomId' }, { status: 400 });
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const section = segments[1] ?? '';
    const method = request.method;

    // Guest-verify is the one route that runs without accountId (early branch before auth checks)
    if (section === 'guest-verify' && method === 'POST') {
      // Tombstone check for guest-verify: return generic 403 instead of 410
      // to avoid room-enumeration oracle on unauthenticated path
      if (!assertNotTombstoned(createSqlTombstoneStore(this.db), roomId).ok) {
        return forbidden();
      }

      const bodyText = await request.text();
      const body = parseJsonObject(bodyText);
      const pin = stringField(body, 'pin');

      if (!pin) {
        // Missing PIN is a failure - return generic 403
        return forbidden();
      }

      const result = verifyGuestPin(this.db, roomId, pin, Date.now());

      if (result.ok) {
        return Response.json({ ok: true }, { status: 200 });
      }

      // All failures (wrong PIN, guest-disabled, expired, locked out, missing room, tombstoned) return identical 403
      return forbidden();
    }

    // For all other sections: accountId check FIRST (before tombstone check)
    const accountId = url.searchParams.get('accountId');
    if (!accountId) return unauthorized('Account required');

    // Then tombstone check for authenticated requests
    if (!assertNotTombstoned(createSqlTombstoneStore(this.db), roomId).ok) {
      return tombstonedJsonResponse();
    }

    // Subroutes must not persist into a room that was never created. POST on
    // the room root is the create path and is allowed to insert the rooms row.
    // GET /access on a missing room must still return `{ status: 'none' }` so
    // the Worker can apply create quotas without enumerating rooms.
    if (
      section !== ''
      && !(section === 'access' && (method === 'GET' || method === 'HEAD'))
      && !roomExists(this.db, roomId)
    ) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Guest flag from Worker stamp (Task 8)
    const guest = url.searchParams.get('guest') === '1';

    // Grant role only — no board, queue, or request PII. Discriminators that
    // share a route (kick vs heartbeat) are read from a bounded JSON object
    // after this identity is known. Scene and settings are separate paths.
    const role = getGrantRole(this.db, roomId, accountId);
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const bodyText = hasBody ? await request.text() : null;
    const body = parseJsonObject(bodyText);

    const denied = this.authorize(url, roomId, section, method, body, accountId, role, guest);
    if (denied) return denied;

    if (section !== 'erasure') {
      const now = Date.now();
      purgeExpiredGrants(this.db, roomId, now);
      purgeExpiredRoomLifecycle(this.db, roomId, now);
    }

    const joiningPeerId = section === 'presence' && method === 'POST' && stringField(body, 'action') == null
      ? stringField(body, 'peerId')
      : null;

    // Handlers read the body themselves, so hand them one that still has it.
    const forwarded = new Request(request.url, {
      method,
      headers: request.headers,
      body: bodyText,
    });
    const response = await this.route(forwarded, url, roomId);

    if (response.ok && accountId && joiningPeerId) {
      bindPeerAccount(this.db, roomId, joiningPeerId, accountId);
    }

    if (response.ok && section === 'presence' && method === 'POST') {
      const action = stringField(body, 'action');
      if (action === 'kick' || action === 'suspend') {
        const payload = await response.clone().json() as {
          kickedPeer?: { accountId?: string };
          suspendedPeer?: { accountId?: string };
        };
        const targetAccountId = payload.kickedPeer?.accountId ?? payload.suspendedPeer?.accountId;
        if (targetAccountId) {
          incrementGrantVersion(this.db, roomId);
          this.closeAccountSockets(targetAccountId, roomId);
        }
      }
    }

    return response;
  }

  /**
   * HTTP authorization matrix. Grant state comes only from room_members keyed
   * by the Worker-stamped account id. Bearer tokens, emails, and client peer
   * ids are ignored.
   *
   *   Authenticated (teacher/owner):
 *   GET    /room                     granted (viewer/editor/owner)
 *   POST   /room (create)            any authenticated
 *   POST   /room (scene)             editor/owner
 *   GET    /settings                  owner
 *   POST|PATCH /settings             owner
 *   DELETE /room                     owner
   *   POST   /erasure                  stamped member or owner row
 *   GET    /presence                 granted (payload redacted for non-owners)
   *   POST   /presence kick|suspend    owner
   *   POST   /presence heartbeat/join  not banned; self only
   *   DELETE /presence                 granted; self only
   *   GET    /waiting                  owner
   *   POST   /waiting                  owner
   *   DELETE /waiting                  owner, or self withdrawing a request
   *   GET    /access                   any authenticated
   *   POST   /requests                 any authenticated except banned
   *   GET    /requests                 owner
   *   POST   /requests/:id             owner
   *   POST   /av                       granted (viewer/editor/owner)
   *
   *   Guest account denials (guest=1):
   *   POST   /room (create)           403 (non-existent room)
   *   DELETE /room                    403
   *   GET/POST/PATCH /settings        403
   *   GET    /waiting                 403
   *   GET    /requests                403
   *   POST   /requests/:id            403 (approve)
   *   POST   /presence kick|suspend   403
   *
   *   Guest permissions (guest=1):
   *   POST   /room (scene)            allowed once granted editor
   *   GET    /room                    allowed once granted
   *   POST   /requests                allowed (queued as pending)
   *   GET    /access                  allowed
   *   POST   /presence heartbeat/join allowed as self
   *   DELETE /waiting                 allowed for own peerId
   */
  private authorize(
    url: URL,
    roomId: string,
    section: string,
    method: string,
    body: Record<string, unknown> | null,
    accountId: string,
    role: ReturnType<typeof getGrantRole>,
    guest: boolean = false,
  ): Response | null {
    const owner = isOwnerRole(role);
    const granted = isGrantedRole(role);

    if (section === 'erasure') {
      if (method !== 'POST') return forbidden();
      return getMembership(this.db, roomId, accountId) ? null : forbidden();
    }

    if (section === '') {
      if (method === 'DELETE') {
        if (guest) return forbidden();
        return owner ? null : forbidden();
      }
      if (method === 'POST') {
        // Guest denial for create path (non-existent room)
        if (guest && !roomExists(this.db, roomId)) return forbidden();
        if (!roomExists(this.db, roomId)) return null;
        return canWriteBoard(role) ? null : forbidden();
      }
      if (method === 'GET' || method === 'HEAD') return granted ? null : forbidden();
      return forbidden();
    }

    if (section === 'settings') {
      if (guest) return forbidden();
      if (method === 'GET' || method === 'HEAD') return owner ? null : forbidden();
      if (method === 'POST' || method === 'PATCH') return owner ? null : forbidden();
      return forbidden();
    }

    if (section === 'waiting') {
      if (method === 'DELETE') {
        const peerId = url.searchParams.get('peerId');
        if (!peerId) return forbidden();
        if (owner) return null;
        const bound = peerAccountId(this.db, roomId, peerId);
        if (bound === accountId) return null;
        return forbidden();
      }
      if (method === 'GET' || method === 'POST') {
        if (guest) return forbidden();
        return owner ? null : forbidden();
      }
      return forbidden();
    }

    if (section === 'presence') {
      if (method === 'GET' || method === 'HEAD') return granted ? null : forbidden();
      if (method === 'POST') {
        const action = stringField(body, 'action');
        if (action === 'kick' || action === 'suspend') {
          if (guest) return forbidden();
          return owner ? null : forbidden();
        }
        if (role === 'banned') return forbidden();
        const peerId = stringField(body, 'peerId');
        if (peerId) {
          const bound = peerAccountId(this.db, roomId, peerId);
          if (bound && bound !== accountId) return forbidden();
        }
        return null;
      }
      if (method === 'DELETE') {
        if (!granted) return forbidden();
        const peerId = url.searchParams.get('peerId');
        if (!peerId) return forbidden();
        const bound = peerAccountId(this.db, roomId, peerId);
        if (bound !== accountId) return forbidden();
        return null;
      }
      return forbidden();
    }

    if (section === 'access') {
      return method === 'GET' || method === 'HEAD' ? null : forbidden();
    }

    // A/V tokens: granted participants only. Pending, banned, and outsiders
    // get 403 so this route cannot probe room existence.
    if (section === 'av') {
      if (method !== 'POST') return forbidden();
      return isGrantedRole(role) ? null : forbidden();
    }

    if (section === 'requests') {
      const requestId = url.pathname.split('/').filter(Boolean)[2];
      if (method === 'GET' || method === 'HEAD' || (method === 'POST' && requestId)) {
        if (guest) return forbidden();
        return owner ? null : forbidden();
      }
      if (method === 'POST') return role === 'banned' ? forbidden() : null;
      return forbidden();
    }

    return forbidden();
  }

  private route(request: Request, url: URL, roomId: string): Promise<Response> {
    const segments = url.pathname.split('/').filter(Boolean);
    // Paths arrive as /room, /room/presence, /room/requests/<requestId>, ...
    const section = segments[1] ?? '';
    const method = request.method;

    switch (section) {
      case '':
        if (method === 'GET') return handleRoomGet(this.db, roomId, request);
        if (method === 'POST') return handleRoomPost(this.db, roomId, request);
        if (method === 'DELETE') {
          return handleRoomDelete(this.db, roomId, request).then((response) => {
            if (response.ok) this.deleteSockets();
            return response;
          });
        }
        break;
      case 'erasure':
        if (method === 'POST') {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) return Promise.resolve(forbidden('Account required'));
          const membership = getMembership(this.db, roomId, accountId);
          return handleRoomAccountErasure(this.db, roomId, accountId).then((response) => {
            if (response.ok) {
              if (membership?.role === 'owner') this.deleteSockets();
              else this.closeAccountSockets(accountId, roomId);
            }
            return response;
          });
        }
        break;
      case 'settings':
        if (method === 'GET' || method === 'HEAD') {
          return handleRoomSettingsGet(this.db, roomId, request).then((response) => {
            if (method === 'HEAD') {
              return new Response(null, { status: response.status, headers: response.headers });
            }
            return response;
          });
        }
        if (method === 'POST' || method === 'PATCH') {
          return handleRoomSettings(this.db, roomId, request);
        }
        break;
      case 'presence':
        if (method === 'GET') return handlePresenceGet(this.db, roomId, request);
        if (method === 'POST') return handlePresencePost(this.db, roomId, request);
        if (method === 'DELETE') return handlePresenceDelete(this.db, roomId, request);
        break;
      case 'waiting':
        if (method === 'GET') return handleWaitingGet(this.db, roomId, request);
        if (method === 'POST') return handleWaitingPost(this.db, roomId, request);
        if (method === 'DELETE') return handleWaitingDelete(this.db, roomId, request);
        break;
      case 'access':
        if (method === 'GET') return handleAccessGet(this.db, roomId, request);
        break;
      case 'av': {
        if (method !== 'POST') break;
        const accountId = url.searchParams.get('accountId');
        if (!accountId) {
          return Promise.resolve(forbidden('Account required'));
        }
        // Identity is always the verified account. A client-chosen identity
        // would let one admitted participant join as another and bump that
        // participant's live session off the call (LiveKit enforces one
        // session per identity by disconnecting the earlier one).
        const name = url.searchParams.get('name') ?? undefined;
        return issueAvTokenResponse({
          db: this.db,
          env: this.roomEnv,
          roomId,
          accountId,
          name,
        });
      }
      case 'requests': {
        const requestId = segments[2];
        if (requestId) {
          if (method === 'POST') {
            return handleRequestsIdPost(this.db, roomId, requestId, request);
          }
          break;
        }
        if (method === 'GET') return handleRequestsGet(this.db, roomId, request);
        if (method === 'POST') return handleRequestsPost(this.db, roomId, request);
        break;
      }
    }

    return Promise.resolve(
      Response.json({ error: 'Not found' }, { status: 404 }),
    );
  }

  /** Drops every signaling socket for this object after a successful delete. */
  private deleteSockets(): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(SOCKET_ROOM_DELETED_CLOSE_CODE, 'Room deleted');
      } catch {
        // Already gone.
      }
    }
  }

  /** Closes live signaling sockets for one account (kick/suspend/revoke). */
  private closeAccountSockets(accountId: string, roomId: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketIdentity | null;
      if (attachment?.accountId === accountId) {
        this.closeRevoked(socket, attachment);
      }
    }
    this.scheduleLiveKitEviction(accountId, roomId);
  }

  /** Drops the account from LiveKit without blocking the caller on HTTP errors. */
  private scheduleLiveKitEviction(accountId: string, roomId: string): void {
    const promise = this.evictLiveKitParticipant({
      env: this.roomEnv,
      roomId,
      identity: accountId,
    });
    this.ctx.waitUntil(promise);
  }

  // --- y-webrtc signaling ---
  //
  // Replaces the previous in-process signaling topic map. Because this object
  // is the room, every socket held here is subscribed to the same topic, so a
  // publish fans out to the other sockets on this object.

  /** Counts open signaling sockets for one account on this object. */
  private countAccountSockets(accountId: string): number {
    let count = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketIdentity | null;
      if (attachment?.accountId === accountId) count += 1;
    }
    return count;
  }

  private async handleSignalingUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    // The Worker overwrites these on the internal request after verifying the
    // session, so they cannot be supplied by the client.
    const accountId = url.searchParams.get('accountId');
    const sessionId = url.searchParams.get('sessionId');
    const epoch = Number(url.searchParams.get('accountEpoch'));
    if (!accountId || !sessionId || !Number.isInteger(epoch) || epoch < 0) {
      return new Response('Unauthorized', { status: 401 });
    }

    const roomId = url.searchParams.get('roomId');
    if (!roomId) {
      return new Response('Missing or invalid room', { status: 400 });
    }

    if (!assertNotTombstoned(createSqlTombstoneStore(this.db), roomId).ok) {
      return tombstonedJsonResponse();
    }

    if (!roomExists(this.db, roomId)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const role = getGrantRole(this.db, roomId, accountId);
    if (!isGrantedRole(role)) {
      return forbidden();
    }

    const maxSocketsPerRoom =
      RoomDO.signalingMaxSocketsPerRoomForTests ?? SIGNALING_MAX_SOCKETS_PER_ROOM;
    if (this.ctx.getWebSockets().length >= maxSocketsPerRoom) {
      return forbidden('Too many connections');
    }

    if (this.countAccountSockets(accountId) >= SIGNALING_MAX_SOCKETS_PER_ACCOUNT) {
      return forbidden('Too many connections');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    const identity: SocketIdentity = {
      accountId,
      sessionId,
      authorizationEpoch: epoch,
      roomId,
      grantVersion: getGrantVersion(this.db, roomId),
    };
    server.serializeAttachment(identity);
    // Awaited, not floating: a storage write racing the returned response
    // shows up as "database is locked: SQLITE_BUSY".
    await this.scheduleRevocationCheck();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Keeps exactly one pending alarm while any socket is open. */
  private async scheduleRevocationCheck(): Promise<void> {
    if (await this.ctx.storage.getAlarm() !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + this.checkIntervalMs);
  }

  /**
   * Re-checks the accounts behind open sockets. Sessions are authorized once at
   * upgrade time, so without this a revoked participant would keep collaborating
   * for as long as the socket stayed open.
   */
  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const now = Date.now();
    const roomIds = new Set<string>();
    for (const row of this.db.prepare(
      `SELECT room_id AS roomId FROM rooms`,
    ).all() as Array<{ roomId: string }>) {
      roomIds.add(row.roomId);
    }
    for (const socket of sockets) {
      try {
        const attachment = socket.deserializeAttachment() as SocketIdentity | null;
        if (attachment?.roomId) roomIds.add(attachment.roomId);
      } catch {
        // Attachment may be missing; room ids still come from the rooms table.
      }
    }
    purgeExpiredRoomsAndTombstones(this.db, now);
    for (const roomId of roomIds) {
      purgeExpiredGrants(this.db, roomId, now);
      purgeExpiredRoomLifecycle(this.db, roomId, now);
    }
    if (sockets.length === 0) return;

    const identities = new Map<WebSocket, SocketIdentity>();
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as SocketIdentity | null;
      // A socket with no identity predates this check or lost its attachment;
      // fail closed rather than treat it as authorized.
      if (!attachment?.accountId) {
        this.closeRevoked(socket);
        continue;
      }
      identities.set(socket, attachment);
    }
    if (identities.size === 0) return;

    const accountIds = [...new Set([...identities.values()].map((i) => i.accountId))];
    let statuses: Record<string, { state: string; authorizationEpoch: number }>;
    try {
      const identity = this.roomEnv.IDENTITY.get(
        this.roomEnv.IDENTITY.idFromName(GLOBAL_IDENTITY_OBJECT_NAME),
      );
      const response = await identity.fetch(
        new Request('https://identity/accounts/authorizations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountIds }),
        }),
      );
      if (!response.ok) throw new Error(`identity check failed: ${response.status}`);
      ({ accounts: statuses } = (await response.json()) as {
        accounts: Record<string, { state: string; authorizationEpoch: number }>;
      });
    } catch {
      // Leave sockets open and retry: a transient identity failure must not
      // disconnect an entire classroom.
      await this.ctx.storage.setAlarm(Date.now() + this.checkIntervalMs);
      return;
    }

    const evictedLiveKitAccounts = new Set<string>();
    for (const [socket, identity] of identities) {
      const status = statuses[identity.accountId];
      const revoked = !status
        || status.state !== 'active'
        || status.authorizationEpoch !== identity.authorizationEpoch;
      if (revoked) {
        this.closeRevoked(socket, identity);
        if (!evictedLiveKitAccounts.has(identity.accountId)) {
          evictedLiveKitAccounts.add(identity.accountId);
          this.scheduleLiveKitEviction(identity.accountId, identity.roomId);
        }
      }
    }

    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + this.checkIntervalMs);
    }
  }

  private closeRevoked(socket: WebSocket, identity?: SocketIdentity | null): void {
    let attachment = identity;
    if (attachment === undefined) {
      try {
        attachment = socket.deserializeAttachment() as SocketIdentity | null;
      } catch {
        attachment = null;
      }
    }
    try {
      logSocketClose({
        code: SOCKET_REVOKED_CLOSE_CODE,
        accountId: attachment?.accountId,
        roomId: attachment?.roomId,
      });
    } catch {
      // Logging must not block the close.
    }
    try {
      socket.close(SOCKET_REVOKED_CLOSE_CODE, 'Session revoked');
    } catch {
      // Already gone.
    }
  }

  private isStaleGrant(attachment: SocketIdentity | null): boolean {
    if (!attachment?.roomId) return true;
    if (typeof attachment.grantVersion !== 'number') return true;
    return getGrantVersion(this.db, attachment.roomId) !== attachment.grantVersion;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketIdentity | null;
    if (
      !attachment?.accountId
      || !attachment.roomId
      || this.isStaleGrant(attachment)
      || !isGrantedRole(getGrantRole(this.db, attachment.roomId, attachment.accountId))
    ) {
      this.closeRevoked(ws, attachment);
      return;
    }

    const payloadBytes = typeof raw === 'string'
      ? new TextEncoder().encode(raw).byteLength
      : raw.byteLength;
    if (payloadBytes > MAX_BODY_BYTES) {
      try {
        logSocketClose({
          code: 1009,
          accountId: attachment.accountId,
          roomId: attachment.roomId,
        });
      } catch {
        // Logging must not block the close.
      }
      try {
        ws.close(1009);
      } catch {
        // Already closed.
      }
      return;
    }

    if (!this.signalingMessageRate.take(attachment.accountId).ok) {
      try {
        logSocketClose({
          code: 1008,
          accountId: attachment.accountId,
          roomId: attachment.roomId,
        });
      } catch {
        // Logging must not block the close.
      }
      try {
        ws.close(1008);
      } catch {
        // Already closed.
      }
      return;
    }

    // y-websocket sends Yjs updates as binary; relay to other peers, not back to sender.
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const role = getGrantRole(this.db, attachment.roomId, attachment.accountId);
      if (!canWriteBoard(role)) return;

      const bytes = raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      for (const peer of this.ctx.getWebSockets()) {
        if (peer === ws) continue;
        try {
          peer.send(bytes);
        } catch {
          try {
            peer.close();
          } catch {
            // Already gone.
          }
        }
      }
      return;
    }

    if (typeof raw !== 'string') return;

    let msg: { type?: string; topics?: unknown; topic?: unknown; clients?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      return;
    }

    switch (msg.type) {
      case 'subscribe':
      case 'unsubscribe':
        // This object represents exactly one room, so membership is implied by
        // the connection itself. Accepted for protocol compatibility.
        break;

      case 'publish': {
        if (typeof msg.topic !== 'string') return;
        if (msg.topic !== SIGNALING_ALLOWED_TOPIC) return;
        const role = getGrantRole(this.db, attachment.roomId, attachment.accountId);
        if (!canWriteBoard(role)) return;

        const peers = this.ctx.getWebSockets();
        const payload = JSON.stringify({ ...msg, clients: peers.length });
        for (const peer of peers) {
          const peerAttachment = peer.deserializeAttachment() as SocketIdentity | null;
          if (!peerAttachment?.accountId) continue;
          const peerRole = getGrantRole(this.db, attachment.roomId, peerAttachment.accountId);
          if (!canWriteBoard(peerRole)) continue;
          try {
            peer.send(payload);
          } catch {
            try {
              peer.close();
            } catch {
              // Already gone.
            }
          }
        }
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        return;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
