import { DurableObject } from 'cloudflare:workers';
import { DODatabase } from '../lib/whiteboard/doDatabase';
import {
  addRoomMember,
  applySchema,
  getRoomRole,
  roomExists,
} from '../lib/whiteboard/roomSchema';
import type { RoomDatabase } from '../lib/whiteboard/db';
import { GLOBAL_IDENTITY_OBJECT_NAME } from './IdentityDO';
import {
  handleRoomGet,
  handleRoomPost,
  handleRoomDelete,
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
import { isAdmittedRole } from '../lib/av/avAuthorization';

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
  authorizationEpoch: number;
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

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.roomEnv = env as RoomEnv;
    this.checkIntervalMs = resolveCheckInterval(this.roomEnv);
    this.db = new DODatabase(ctx.storage.sql, ctx.storage);
    applySchema(this.db);

    // Answer y-webrtc keepalives without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'pong' }),
      ),
    );
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

    // Read the body exactly once, up front. Authorization and membership both
    // need to inspect it, and cloning a request whose body is never fully
    // consumed leaves a dangling stream across the Durable Object boundary
    // ("can't read from request stream after response has been sent").
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const bodyText = hasBody ? await request.text() : null;
    const body = parseJsonObject(bodyText);

    const denied = this.authorize(request, url, roomId, section, body);
    if (denied) return denied;

    const accountId = url.searchParams.get('accountId');
    // Approving deletes the queue row naming the account, so read it first.
    const promoting = section === 'waiting' && method === 'POST'
      ? this.accountAwaitingApproval(roomId, body)
      : null;
    // Only a plain join/heartbeat binds the peer to the caller's account. A
    // host's kick/suspend POST names a *different* peer as its target, and
    // must not rebind that peer's ownership to the host's own account.
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

    if (response.ok && accountId) {
      this.recordMembership(roomId, accountId, promoting, joiningPeerId);
    }

    return response;
  }

  /**
   * Decides whether the verified account may perform this room operation.
   *
   * Enforced here rather than inside each handler so there is a single place
   * that answers "may this account touch this room", and so handler signatures
   * (and their tests) stay independent of the identity layer.
   *
   * - creating a room: any authenticated account, which becomes the owner
   * - reading or writing an existing board: members only
   * - deleting a room, or moderating peers: the owner only
   * - joining, leaving, and reading presence: any authenticated account, since
   *   that is how a peer asks to be let in and follows its place in the queue
   */
  private authorize(
    request: Request,
    url: URL,
    roomId: string,
    section: string,
    body: Record<string, unknown> | null,
  ): Response | null {
    const accountId = url.searchParams.get('accountId');
    if (!accountId) return forbidden('Account required');

    const role = getRoomRole(this.db, roomId, accountId);
    const isOwner = role === 'owner';
    const isMember = role !== null;
    const method = request.method;

    if (section === '') {
      if (method === 'DELETE') return isOwner ? null : forbidden();
      if (method === 'POST') {
        // First writer of a new room becomes its owner.
        if (!roomExists(this.db, roomId)) {
          addRoomMember(this.db, roomId, accountId, 'owner');
          return null;
        }
        return isMember ? null : forbidden();
      }
      if (method === 'GET') return isMember ? null : forbidden();
      return null;
    }

    if (section === 'waiting') {
      // Leaving the queue is self-service; moderating it is not.
      if (method === 'DELETE') return null;
      return isOwner ? null : forbidden();
    }

    if (section === 'presence' && method === 'POST') {
      const action = stringField(body, 'action');
      if (action === 'kick' || action === 'suspend') {
        return isOwner ? null : forbidden();
      }

      // Joining/heartbeat: a caller may not claim a peerId another account
      // already bound to itself, or it could hijack that peer's identity.
      const peerId = stringField(body, 'peerId');
      if (peerId) {
        const owner = this.peerAccountId(roomId, peerId);
        if (owner && owner !== accountId) return forbidden();
      }
      return null;
    }

    if (section === 'presence' && method === 'DELETE') {
      // Leaving/heartbeat-timeout is self-service; a caller may only remove a
      // peer bound to its own account. A peer with no recorded owner (or that
      // doesn't exist) is harmless to remove, so let that through unchanged.
      const peerId = url.searchParams.get('peerId');
      if (peerId) {
        const owner = this.peerAccountId(roomId, peerId);
        if (owner && owner !== accountId) return forbidden();
      }
      return null;
    }

    // A/V tokens are only for admitted participants (owner/member). Waiting
    // peers and outsiders get the same 403 shape so room membership cannot be
    // probed through this route.
    if (section === 'av') {
      return isAdmittedRole(role) ? null : forbidden();
    }
    return null;
  }

  /** The account bound to a peer row in presence or the waiting queue, if any. */
  private peerAccountId(roomId: string, peerId: string): string | null {
    for (const table of ['room_presence', 'waiting_peers']) {
      const row = this.db
        .prepare(`SELECT account_id AS accountId FROM ${table} WHERE room_id = ? AND peer_id = ?`)
        .get(roomId, peerId) as { accountId: string | null } | undefined;
      if (row?.accountId) return row.accountId;
    }
    return null;
  }

  /** The account queued behind the peer an approve request names, if any. */
  private accountAwaitingApproval(
    roomId: string,
    body: Record<string, unknown> | null,
  ): string | null {
    const peerId = stringField(body, 'peerId');
    if (stringField(body, 'action') !== 'approve' || !peerId) return null;

    const row = this.db
      .prepare(
        `SELECT account_id AS accountId FROM waiting_peers
         WHERE room_id = ? AND peer_id = ?`,
      )
      .get(roomId, peerId) as { accountId: string | null } | undefined;
    return row?.accountId ?? null;
  }

  /**
   * Binds the verified account to the peer row the request just created, and
   * grants membership once that account is actually in the room. Membership is
   * what later authorizes reading the board, so it is derived from admission
   * rather than from anything the client asserts.
   */
  private recordMembership(
    roomId: string,
    accountId: string,
    promoting: string | null,
    peerId: string | null,
  ): void {
    if (promoting) {
      addRoomMember(this.db, roomId, promoting, 'member');
    }

    if (!peerId) return;

    for (const table of ['room_presence', 'waiting_peers']) {
      this.db
        .prepare(`UPDATE ${table} SET account_id = ? WHERE room_id = ? AND peer_id = ?`)
        .run(accountId, roomId, peerId);
    }

    const admitted = this.db
      .prepare(`SELECT 1 FROM room_presence WHERE room_id = ? AND peer_id = ?`)
      .get(roomId, peerId);
    if (admitted) addRoomMember(this.db, roomId, accountId, 'member');
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
        if (method === 'DELETE') return handleRoomDelete(this.db, roomId, request);
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

  // --- y-webrtc signaling ---
  //
  // Replaces the previous in-process signaling topic map. Because this object
  // is the room, every socket held here is subscribed to the same topic, so a
  // publish fans out to the other sockets on this object.

  private async handleSignalingUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    // The Worker overwrites these on the internal request after verifying the
    // session, so they cannot be supplied by the client.
    const accountId = url.searchParams.get('accountId');
    const epoch = Number(url.searchParams.get('accountEpoch'));
    if (!accountId || !Number.isInteger(epoch) || epoch < 0) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    const identity: SocketIdentity = { accountId, authorizationEpoch: epoch };
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

    for (const [socket, identity] of identities) {
      const status = statuses[identity.accountId];
      const revoked = !status
        || status.state !== 'active'
        || status.authorizationEpoch !== identity.authorizationEpoch;
      if (revoked) this.closeRevoked(socket);
    }

    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + this.checkIntervalMs);
    }
  }

  private closeRevoked(socket: WebSocket): void {
    try {
      socket.close(SOCKET_REVOKED_CLOSE_CODE, 'Session revoked');
    } catch {
      // Already gone.
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;

    let msg: { type?: string; topics?: unknown; topic?: unknown; clients?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg?.type) return;

    switch (msg.type) {
      case 'subscribe':
      case 'unsubscribe':
        // This object represents exactly one room, so membership is implied by
        // the connection itself. Accepted for protocol compatibility.
        break;

      case 'publish': {
        if (typeof msg.topic !== 'string') return;
        const peers = this.ctx.getWebSockets();
        // The publisher receives its own message too.
        // y-webrtc filters by peer id, and changing this breaks peer discovery.
        const payload = JSON.stringify({ ...msg, clients: peers.length });
        for (const peer of peers) {
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
