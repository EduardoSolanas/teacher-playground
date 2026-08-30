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
  handleRoomStatsGet,
  handleRoomLibraryGet,
  handleRoomLibraryPost,
  handleRoomDelete,
  handleRoomAccountErasure,
} from '../lib/whiteboard/handlers/room';
import {
  handlePresenceGet,
  handlePresencePost,
  handlePresenceDelete,
  presencePayloadForAccount,
} from '../lib/whiteboard/handlers/presence';
import { activePeerIds } from '../lib/whiteboard/presence';
import { orphanKeys, referencedFileIds, type StoredFile } from '../lib/whiteboard/orphanFiles';
import { presenceSignature } from '../lib/whiteboard/presence';
import { encodePresenceMessage } from '../lib/whiteboard/presenceMessage';
import { isRelayableFrame } from '../lib/whiteboard/relayPolicy';
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
import { decideSignalingAction } from '../lib/worker/signalingBudget';
import { createRateLimiter } from '../lib/http/rateLimit';
import { logSocketClose } from '../lib/security/authEvents';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { encodeUpdateFrame, handleSyncFrame } from '../lib/whiteboard/serverSync';
import { replaceSharedElements, getElementsFromArray, pruneTombstonedElements } from '../lib/whiteboard/yjsDoc';
import { snapshotElements } from '../lib/whiteboard/sceneSnapshot';
import { snapshotBudgetState } from '../lib/whiteboard/snapshotBudget';
import { libraryStorageKey } from '../lib/whiteboard/roomLibrary';
import {
  FOLLOW_MESSAGE_TYPE,
  decodeFollowMessagePayload,
  encodeFollowMessage,
  type FollowMessage,
} from '../lib/whiteboard/followMessage';

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

/**
 * One structured line about a board write, in the shape the auth log uses.
 *
 * Room ids are share identifiers rather than secrets, and no board content goes
 * in here — the size and the outcome are the whole point.
 */
function logBoardSnapshot(entry: {
  roomId: string;
  bytes: number;
  outcome: string;
  reason?: string;
}): void {
  try {
    console.warn(JSON.stringify({ event: 'board_snapshot', ...entry }));
  } catch {
    // Logging must never break a flush.
  }
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
  /**
   * Board images. Optional because a deployment without the bucket bound must
   * still serve boards; the sweeps below simply have nothing to reach.
   */
  BOARD_FILES?: R2Bucket;
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
    // Refused frames still count here: telling a burst of drawing apart from a
    // client flooding the room needs to know what it sent, not what got
    // through. Only this limiter opts in — see createRateLimiter.
    countRejected: true,
  });

  /** Injectable hook; defaults to {@link removeLiveKitParticipant}. */
  evictLiveKitParticipant: (
    input: RemoveLiveKitParticipantInput,
  ) => Promise<RemoveLiveKitParticipantResult> = removeLiveKitParticipant;

  /** Populated by tests when {@link evictLiveKitParticipant} is replaced with a spy. */
  liveKitEvictCalls?: { roomId: string; identity: string }[];

  /** Test-only override for the per-room socket cap; production always uses 32. */
  static signalingMaxSocketsPerRoomForTests: number | null = null;

  /** Server-side Yjs documents per room, created lazily. */
  private readonly docs = new Map<string, Y.Doc>();

  /** Ephemeral teacher guide state; never written to Yjs, SQL, or storage. */
  private activeFollow: FollowMessage | null = null;

  /**
   * Rooms whose document has changed since it was last written. Flushed at most
   * once every {@link RoomDO.FLUSH_INTERVAL_MS} while drawing, on the alarm, and
   * on last-socket-close; writing per update would trade the HTTP amplification
   * this replaces for storage amplification.
   */
  private readonly dirtyRooms = new Set<string>();

  /** Rooms whose durable Yjs snapshot still needs to be projected into SQL. */
  private readonly projectionDirtyRooms = new Set<string>();

  /** Last live-account check; earlier board alarms must not multiply identity traffic. */
  private lastRevocationCheckAt = 0;

  /**
   * When each room last had its orphaned files collected.
   *
   * The alarm beats every few seconds while a board is being drawn on, and
   * listing a bucket prefix on each one would spend far more than the storage
   * it reclaims. Orphans are not urgent -- nobody can reach them -- so this
   * runs on its own slow cadence.
   */
  private readonly lastOrphanSweepAt = new Map<string, number>();

  private static readonly ORPHAN_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

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
    // Taken before the mutation so the broadcast below can tell a real change
    // from a heartbeat that only moved a timestamp.
    const signatureBefore = section === 'presence' && method === 'POST'
      ? presenceSignature(this.db, roomId)
      : null;
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
          this.restampRoomSockets(roomId);
        }
      }
      /*
       * Only when something actually changed.
       *
       * This route carries the 2s heartbeat as well as real mutations, and a
       * heartbeat moves nothing but a timestamp. Broadcasting on every one had
       * each peer rebuild a payload for every other peer several times a
       * second — more work for the room than the poll it replaces, and more
       * frames competing with the strokes.
       */
      if (presenceSignature(this.db, roomId) !== signatureBefore) {
        this.broadcastPresence(roomId);
      }
    }

    if (response.ok && section === 'presence' && method === 'DELETE') {
      // Broadcast presence after leaving
      this.broadcastPresence(roomId);
    }

    if (response.ok && section === 'waiting' && method === 'POST') {
      // Broadcast presence after approve/reject
      this.broadcastPresence(roomId);
    }

    if (response.ok && section === 'waiting' && method === 'DELETE') {
      // Broadcast presence after deleting from waiting
      this.broadcastPresence(roomId);
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

    /*
     * Owner-only, and denied to a guest outright, exactly as settings is.
     *
     * This gate is the authorization; the switch below only dispatches. A
     * section with no entry here falls through to the `forbidden()` at the end
     * of this function, which is how the diagnostics route shipped answering
     * 403 to the very owner it was built for -- the handler checked ownership
     * perfectly well and was never reached.
     *
     * Neither is board: the report describes the room, the library is the
     * teacher's own working set, and a student has no business with either.
     */
    if (section === 'stats' || section === 'library') {
      if (guest) return forbidden();
      if (method === 'GET' || method === 'HEAD') return owner ? null : forbidden();
      if (section === 'library' && method === 'POST') return owner ? null : forbidden();
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

    // Board file storage: streaming uploads and downloads for images pasted
    // into whiteboards. Authorization checks come from the Worker as GET requests
    // to /room/files/authorize-write (for PUT) or /room/files/authorize-read (for GET).
    // Both authorization checks are GET requests because the Worker asks RoomDO
    // to verify the ORIGINAL operation (PUT or GET) is authorized.
    if (section === 'files') {
      /*
       * The action is the third segment, read the way every other section here
       * reads its id. Slicing the raw split kept the leading empty string and
       * produced "files/authorize-write", which matched neither branch and fell
       * through to forbidden -- so every upload was refused, including the
       * owner's, and the only test covering it accepted 201 or 403 and passed.
       */
      const action = url.pathname.split('/').filter(Boolean)[2] ?? '';
      if (action === 'authorize-write') return canWriteBoard(role) ? null : forbidden();
      if (action === 'authorize-read') return granted ? null : forbidden();
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
        if (method === 'POST') {
          // Cloned before the handler consumes the body.
          const written = request.clone();
          return handleRoomPost(this.db, roomId, request).then(async (response) => {
            if (response.ok) await this.forgetBoardIfElementsWritten(roomId, written);
            return response;
          });
        }
        if (method === 'DELETE') {
          return handleRoomDelete(this.db, roomId, request).then(async (response) => {
            if (response.ok) {
              await this.deleteBoardState(roomId);
              this.deleteSockets();
            }
            return response;
          });
        }
        break;
      case 'erasure':
        if (method === 'POST') {
          const accountId = url.searchParams.get('accountId');
          if (!accountId) return Promise.resolve(forbidden('Account required'));
          const membership = getMembership(this.db, roomId, accountId);
          return handleRoomAccountErasure(this.db, roomId, accountId).then(async (response) => {
            if (response.ok) {
              if (membership?.role === 'owner') {
                await this.deleteBoardState(roomId);
                this.deleteSockets();
              } else {
                this.closeAccountSockets(accountId, roomId);
              }
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
      case 'library':
        /*
         * The library is the owner's own shapes, held against the room so they
         * are there from whichever machine they teach on. Its own storage key:
         * not the shared document, whose weight is what makes an old room
         * slow, and not the room row, which is read on every open.
         */
        if (method === 'GET') {
          return handleRoomLibraryGet(
            this.db,
            roomId,
            request,
            async () => this.ctx.storage.get(libraryStorageKey(roomId)),
          );
        }
        if (method === 'POST') {
          return handleRoomLibraryPost(
            this.db,
            roomId,
            request,
            async (items) => { await this.ctx.storage.put(libraryStorageKey(roomId), items); },
          );
        }
        break;
      case 'stats':
        if (method === 'GET') {
          return handleRoomStatsGet(
            this.db,
            roomId,
            request,
            async () => this.getRoomDoc(roomId),
          );
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
      case 'files': {
        // Authorization check only; actual R2 operations happen in the Worker.
        // Paths arrive as /room/files/authorize-write or /room/files/authorize-read.
        // Both are GET requests; the authorize() matrix checks the path and verifies
        // the caller can write (for PUT) or read (for GET) the board.
        return Promise.resolve(Response.json({ ok: true }, { status: 200 }));
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

  private broadcastFollow(message: FollowMessage, exclude?: WebSocket): void {
    const frame = encodeFollowMessage(message);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === exclude) continue;
      const identity = peer.deserializeAttachment() as SocketIdentity | null;
      if (!identity?.accountId || !isGrantedRole(getGrantRole(this.db, identity.roomId, identity.accountId))) continue;
      try {
        peer.send(frame);
      } catch {
        try { peer.close(); } catch { /* Already gone. */ }
      }
    }
  }

  private hasOpenSocketForAccount(accountId: string, excluding?: WebSocket): boolean {
    return this.ctx.getWebSockets().some((peer) => {
      if (peer === excluding) return false;
      const identity = peer.deserializeAttachment() as SocketIdentity | null;
      return identity?.accountId === accountId && peer.readyState === WebSocket.OPEN;
    });
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

  // --- y-document persistence ---

  /** Loads or creates the server document for a room. Rehydrates from storage if available. */
  private async getRoomDoc(roomId: string): Promise<Y.Doc> {
    let doc = this.docs.get(roomId);
    if (doc) return doc;

    doc = new Y.Doc();
    const storedSnapshot = await this.ctx.storage.get(`ydoc:${roomId}`) as Uint8Array | undefined;
    if (storedSnapshot) {
      Y.applyUpdate(doc, storedSnapshot);
    } else {
      // Seed from SQL elements if no ydoc snapshot exists. Boards created before
      // this work must not open empty; seeding on read ensures it is impossible to miss.
      const row = this.db.prepare(
        `SELECT elements FROM rooms WHERE room_id = ?`,
      ).get(roomId) as { elements: string } | undefined;

      if (row) {
        try {
          const elements = JSON.parse(row.elements);
          if (Array.isArray(elements) && elements.length > 0) {
            replaceSharedElements(doc, doc.getArray('elements'), elements, 'seed');
          }
        } catch {
          // Malformed JSON is silently ignored; the document stays empty.
        }
      }
    }

    // Register listener *after* applying stored snapshot or seed, so rehydrating does not mark dirty.
    doc.on('update', () => {
      this.dirtyRooms.add(roomId);
    });

    this.docs.set(roomId, doc);
    return doc;
  }

  /**
   * Writes a changed board at most this often while drawing continues.
   *
   * The alarm and last-socket-close both flush, but on their own they leave a
   * board unwritten for a whole revocation interval, which is a long time to
   * lose a lesson's work to a crash. This is the "on idle" beat the plan asks
   * for, done without a timer: a timer would hold the object out of
   * hibernation, and the cost of a write here is bounded by the interval
   * rather than by how fast someone draws.
   */
  private static readonly FLUSH_INTERVAL_MS = 3_000;

  /** When the last flush ran, so drawing cannot turn every frame into a write. */
  private lastFlushAt = 0;

  /** Flushes if the interval has passed since the last write. */
  private async flushIfDue(): Promise<void> {
    if (this.dirtyRooms.size === 0) return;
    const now = Date.now();
    if (now - this.lastFlushAt < RoomDO.FLUSH_INTERVAL_MS) {
      await this.scheduleAlarmNoLaterThan(this.lastFlushAt + RoomDO.FLUSH_INTERVAL_MS);
      return;
    }
    this.lastFlushAt = now;
    await this.flushDirtyDocs();
  }

  /** Sends one frame to every socket this object holds for a room. */
  private broadcastToRoom(roomId: string, frame: Uint8Array): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() as SocketIdentity | null;
        if (attachment?.roomId !== roomId) continue;
        socket.send(frame);
      } catch {
        // One unreachable socket must not stop the others being told.
      }
    }
  }

  /**
   * Removes the cursors of peers the room no longer counts as present.
   *
   * A cursor is written into the document by the peer that owns it and nothing
   * ever removed it, so a departed peer left a pointer sitting on everyone
   * else's canvas for the rest of the lesson. Presence is the authority on who
   * is still here: the closing socket's attachment carries an account, and a
   * peer id can change at an admission boundary, so it cannot be trusted for
   * this.
   */
  private sweepDepartedCursors(roomId: string): void {
    const doc = this.docs.get(roomId);
    if (!doc) return;
    const cursors = doc.getMap('cursors');
    if (cursors.size === 0) return;

    const present = activePeerIds(this.db, roomId);
    const departed = [...cursors.keys()].filter((peerId) => !present.has(peerId));
    if (departed.length === 0) return;

    let sweep: Uint8Array | null = null;
    const capture = (update: Uint8Array, origin: unknown) => {
      if (origin === 'sweep') sweep = update;
    };
    doc.on('update', capture);
    try {
      doc.transact(() => {
        for (const peerId of departed) cursors.delete(peerId);
      }, 'sweep');
    } finally {
      doc.off('update', capture);
    }

    // The peers hold their own copies, so the deletion has to travel; the
    // dirty marker the transaction set takes care of the stored copy.
    if (sweep) this.broadcastToRoom(roomId, encodeUpdateFrame(sweep));
  }

  /**
   * Drops the document after a board is written straight to the row.
   *
   * The scene route still accepts `elements`, so a write can arrive that the
   * document never saw. Letting both stand would be split-brain: the next
   * flush would put the document's version back over the row. Forgetting the
   * document instead makes the next open re-seed from what was just written.
   *
   * An **empty** array is not such a write. Creating a room posts
   * `{elements: [], viewport}` (see `src/app/whiteboard/page.tsx`), so treating
   * that as "the board is now empty" would erase a lesson the moment anyone
   * re-issued the create call. No client empties a board through this route
   * any more — an erase travels over the socket like every other edit.
   */
  private async forgetBoardIfElementsWritten(roomId: string, request: Request): Promise<void> {
    try {
      const body = await request.json() as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return;
      const elements = body.elements;
      if (!Array.isArray(elements) || elements.length === 0) return;
      await this.deleteBoardState(roomId);
    } catch {
      // A body that will not parse was refused by the handler anyway.
    }
  }

  /** Removes every in-memory and durable copy of a room's collaborative board. */
  private async deleteBoardState(roomId: string): Promise<void> {
    this.docs.delete(roomId);
    this.dirtyRooms.delete(roomId);
    this.projectionDirtyRooms.delete(roomId);
    /*
     * The library goes with the room.
     *
     * It is the one piece of room state that is neither document nor row, so
     * it is the one that a delete written for those two would leave behind --
     * and what it holds is elements a teacher drew, which may be a worked
     * example off a child's page. An orphan here would outlive the room it
     * belonged to with nothing left pointing at it.
     */
    await this.ctx.storage.delete([
      `ydoc:${roomId}`,
      `ydoc-projection:${roomId}`,
      libraryStorageKey(roomId),
    ]);
  }

  /** Rehydrates projection retry markers that survived a Durable Object eviction. */
  private async restoreProjectionRetries(): Promise<void> {
    const stored = await this.ctx.storage.list({ prefix: 'ydoc-projection:' });
    for (const key of stored.keys()) {
      this.projectionDirtyRooms.add(key.slice('ydoc-projection:'.length));
    }
  }

  /** Writes every document that has changed since the last flush. */
  private async flushDirtyDocs(): Promise<void> {
    for (const roomId of this.dirtyRooms) {
      if (!roomExists(this.db, roomId)) {
        await this.deleteBoardState(roomId);
        continue;
      }
      const doc = this.docs.get(roomId);
      if (!doc) {
        this.dirtyRooms.delete(roomId);
        continue;
      }

      /*
       * Prune tombstoned elements if the room has no open connections. With no
       * peers holding an old scene, there is no risk a reconnecting peer will
       * republish erased elements as new items. The prune is a normal CRDT delete
       * that propagates correctly to any future peers.
       *
       * The guard is critical: if any peer has a socket open with an old scene,
       * the peer would apply the prune and then republish its own old elements
       * as new items, duplicating every shape on the board.
       */
      const hasOpenSocket = this.ctx.getWebSockets().some((socket) => {
        const attachment = socket.deserializeAttachment() as SocketIdentity | null;
        return attachment?.roomId === roomId && socket.readyState === WebSocket.OPEN;
      });
      if (!hasOpenSocket) {
        pruneTombstonedElements(doc);
      }

      const snapshot = Y.encodeStateAsUpdate(doc);
      const budget = snapshotBudgetState(snapshot.byteLength);
      if (budget !== 'fine') {
        // Said out loud on purpose: an unwritable board is indistinguishable
        // from a safe one from the outside, because the retry below is silent.
        logBoardSnapshot({ roomId, bytes: snapshot.byteLength, outcome: budget });
      }

      try {
        await this.ctx.storage.put({
          [`ydoc:${roomId}`]: snapshot,
          [`ydoc-projection:${roomId}`]: true,
        });
        if (!roomExists(this.db, roomId)) {
          await this.deleteBoardState(roomId);
          continue;
        }
        this.dirtyRooms.delete(roomId);
        this.projectionDirtyRooms.add(roomId);
        this.lastFlushAt = Date.now();
      } catch (error) {
        logBoardSnapshot({
          roomId,
          bytes: snapshot.byteLength,
          outcome: 'write_failed',
          reason: error instanceof Error ? error.name : 'unknown',
        });
        // Still dirty, so the next flush retries it. Nothing is lost meanwhile:
        // the document is in memory and every peer still holds its own copy.
        continue;
      }

    }

    for (const roomId of this.projectionDirtyRooms) {
      if (!roomExists(this.db, roomId)) {
        await this.deleteBoardState(roomId);
        continue;
      }
      const doc = this.docs.get(roomId) ?? await this.getRoomDoc(roomId);

      try {
        /*
         * The stored row is no longer written by any client, and the read path
         * still serves from it — a room whose row froze would hand a stale
         * board to anyone loading over HTTP. Tombstones stay out of it for the
         * reason sceneSnapshot.ts gives.
         */
        const elements = snapshotElements(getElementsFromArray(doc.getArray('elements')));
        this.db.prepare(
          `UPDATE rooms SET elements = ?, updated_at = ? WHERE room_id = ?`,
        ).run(JSON.stringify(elements), Date.now(), roomId);
        await this.ctx.storage.delete(`ydoc-projection:${roomId}`);
        this.projectionDirtyRooms.delete(roomId);
      } catch {
        // The Yjs snapshot above is the durable copy and it is already written;
        // the row is a convenience for the read path, not the record.
      }
    }

    if (this.dirtyRooms.size > 0 || this.projectionDirtyRooms.size > 0) {
      await this.scheduleAlarmNoLaterThan(Date.now() + RoomDO.FLUSH_INTERVAL_MS);
    }
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

  /** Broadcasts presence updates to all connected sockets in this room. */
  private broadcastPresence(roomId: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        // Reading the attachment can throw on a socket that is already gone,
        // and one of those must not end the loop for everybody else.
        const attachment = socket.deserializeAttachment() as SocketIdentity | null;
        if (!attachment?.roomId || attachment.roomId !== roomId) continue;

        /*
         * Redacted per recipient, never once for the room.
         *
         * The payload carries the waiting queue and account ids only for an
         * owner. Building it once and fanning it out would put the names of
         * children waiting to be let in onto every student's connection.
         */
        const payload = presencePayloadForAccount(this.db, roomId, attachment.accountId);
        const frame = encodePresenceMessage(payload);
        socket.send(frame);
      } catch {
        // A presence update is not worth dropping a lesson's connection over:
        // this socket misses one frame and the next one reaches it. The 2s
        // poll is still there as the client's fallback.
      }
    }
  }

  /**
   * Re-stamps the grantVersion on all remaining sockets in a room that still
   * hold a granted role. Called after incrementing the room's grant_version to
   * prevent uninvolved sockets from being marked as stale.
   */
  private restampRoomSockets(roomId: string): void {
    const newGrantVersion = getGrantVersion(this.db, roomId);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() as SocketIdentity | null;
        if (!attachment?.roomId || attachment.roomId !== roomId) continue;

        // Skip sockets whose account no longer holds a granted role.
        if (!attachment.accountId || !isGrantedRole(getGrantRole(this.db, roomId, attachment.accountId))) {
          continue;
        }

        // Re-stamp the socket with the new grant version.
        socket.serializeAttachment({ ...attachment, grantVersion: newGrantVersion });
      } catch {
        // One dead socket cannot stop the others from being re-stamped.
      }
    }
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
    if (this.activeFollow) {
      try { server.send(encodeFollowMessage(this.activeFollow)); } catch { /* Best effort. */ }
    }
    // Awaited, not floating: a storage write racing the returned response
    // shows up as "database is locked: SQLITE_BUSY".
    await this.scheduleRevocationCheck();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Keeps the pending alarm at the earliest durability or revocation deadline. */
  private async scheduleAlarmNoLaterThan(deadline: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > deadline) {
      await this.ctx.storage.setAlarm(deadline);
    }
  }

  /** Keeps a revocation alarm while any socket is open. */
  private async scheduleRevocationCheck(): Promise<void> {
    if (this.lastRevocationCheckAt === 0) this.lastRevocationCheckAt = Date.now();
    await this.scheduleAlarmNoLaterThan(this.lastRevocationCheckAt + this.checkIntervalMs);
  }

  /**
   * Re-checks the accounts behind open sockets. Sessions are authorized once at
   * upgrade time, so without this a revoked participant would keep collaborating
   * for as long as the socket stayed open.
   */
  /**
   * Every stored file for a room, for a room that is going away.
   *
   * Deleting the room's rows leaves the bucket untouched, so this is the only
   * thing that stops an expired board's pictures being kept and billed for
   * after the board itself has been collected.
   */
  private async purgeRoomFiles(roomId: string): Promise<void> {
    const bucket = this.roomEnv.BOARD_FILES;
    if (!bucket) return;
    const prefix = `rooms/${roomId}/files/`;
    let cursor: string | undefined;
    try {
      do {
        const listed = await bucket.list({ prefix, cursor });
        for (const object of listed.objects) await bucket.delete(object.key);
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    } catch {
      // A room is not worth failing an alarm over. The next expiry pass lists
      // the same prefix and deletes whatever is still there.
    }
  }

  /**
   * Files the board no longer mentions, collected on a slow cadence.
   *
   * The reference list comes from the projected `elements` row rather than the
   * document, so an idle room is not paged back into memory to be tidied. That
   * row is also the reason for the guard below: a projection that is missing or
   * unreadable looks exactly like a board with no images on it, and acting on
   * that reading would delete every live file in the room. When the board's
   * contents cannot be established, nothing is collected.
   */
  private async sweepOrphanFiles(roomId: string, now: number): Promise<void> {
    const bucket = this.roomEnv.BOARD_FILES;
    if (!bucket) return;
    const lastSweep = this.lastOrphanSweepAt.get(roomId) ?? 0;
    if (now - lastSweep < RoomDO.ORPHAN_SWEEP_INTERVAL_MS) return;

    const row = this.db.prepare(
      `SELECT elements FROM rooms WHERE room_id = ?`,
    ).get(roomId) as { elements?: unknown } | undefined;
    if (!row || typeof row.elements !== 'string') return;

    let elements: unknown;
    try {
      elements = JSON.parse(row.elements);
    } catch {
      return;
    }
    if (!Array.isArray(elements)) return;

    this.lastOrphanSweepAt.set(roomId, now);
    const referenced = referencedFileIds(elements);

    const prefix = `rooms/${roomId}/files/`;
    let cursor: string | undefined;
    try {
      do {
        const listed = await bucket.list({ prefix, cursor });
        const files: StoredFile[] = listed.objects.map((object) => ({
          key: object.key,
          uploaded: object.uploaded,
        }));
        for (const key of orphanKeys({ files, referenced, now })) {
          await bucket.delete(key);
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    } catch {
      // Same reasoning as the purge: the next sweep sees the same orphans.
    }
  }

  async alarm(): Promise<void> {
    // Workerd may still expose the alarm currently being delivered through
    // getAlarm(). Clear that consumed value before retry scheduling, or a
    // failed projection can leave an already-due alarm and re-enter here.
    //
    // Alarm rescheduling invariant: after consuming the fired deadline, every
    // path that leaves an OPEN socket must arrange the next alarm; no-socket
    // and all-closed returns below are deliberate.
    await this.ctx.storage.deleteAlarm();
    // Before the early return below: the alarm is the only beat that still
    // ticks once every socket has gone, so a board must be written here.
    await this.restoreProjectionRetries();
    await this.flushDirtyDocs();

    const sockets = this.ctx.getWebSockets().filter(
      (socket) => socket.readyState === WebSocket.OPEN,
    );
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
    const purgedRoomIds = purgeExpiredRoomsAndTombstones(this.db, now);
    for (const roomId of purgedRoomIds) {
      await this.deleteBoardState(roomId);
      // The board state is gone; without this its images would outlive it.
      await this.purgeRoomFiles(roomId);
      this.lastOrphanSweepAt.delete(roomId);
    }
    for (const roomId of roomIds) {
      purgeExpiredGrants(this.db, roomId, now);
      purgeExpiredRoomLifecycle(this.db, roomId, now);
      // Presence outlives a socket by its ten-second window, so a peer that
      // dropped mid-lesson was still "present" when its close ran. This is
      // where that cursor finally goes.
      this.sweepDepartedCursors(roomId);
      await this.sweepOrphanFiles(roomId, now);
    }
    if (this.dirtyRooms.size > 0 || this.projectionDirtyRooms.size > 0) {
      await this.scheduleAlarmNoLaterThan(now + RoomDO.FLUSH_INTERVAL_MS);
    }
    if (sockets.length === 0) return;

    const nextRevocationCheckAt = this.lastRevocationCheckAt + this.checkIntervalMs;
    if (this.lastRevocationCheckAt > 0 && now < nextRevocationCheckAt) {
      await this.scheduleAlarmNoLaterThan(nextRevocationCheckAt);
      return;
    }
    this.lastRevocationCheckAt = now;

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
      await this.scheduleAlarmNoLaterThan(Date.now() + this.checkIntervalMs);
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

    if (this.ctx.getWebSockets().some((socket) => socket.readyState === WebSocket.OPEN)) {
      await this.scheduleAlarmNoLaterThan(Date.now() + this.checkIntervalMs);
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

    const rateCheckResult = this.signalingMessageRate.take(attachment.accountId);
    const action = decideSignalingAction({ messagesInWindow: rateCheckResult.messagesInWindow });

    if (action === 'drop') {
      // Drop the frame silently; keep the socket open
      return;
    }

    if (action === 'close') {
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

    // action === 'relay'; continue with normal processing

    // y-websocket sends Yjs updates as binary; relay to other peers, not back to sender.
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const role = getGrantRole(this.db, attachment.roomId, attachment.accountId);
      const bytes = raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

      // Guide frames use a private y-websocket message type and must never be
      // relayed as Yjs updates. The role comes from the socket attachment and
      // database, not from any client-supplied identity.
      try {
        const decoder = decoding.createDecoder(bytes);
        if (decoding.readVarUint(decoder) === FOLLOW_MESSAGE_TYPE) {
          const message = decodeFollowMessagePayload(decoder);
          if (!message || !isOwnerRole(role)) return;
          this.activeFollow = message.active ? message : null;
          this.broadcastFollow(message, ws);
          return;
        }
      } catch {
        return;
      }

      if (!canWriteBoard(role)) {
        try {
          const doc = await this.getRoomDoc(attachment.roomId);
          const replies = handleSyncFrame(doc, bytes, ws, { readOnly: true });
          for (const reply of replies) ws.send(reply);
        } catch {
          // A malformed viewer handshake is ignored like any other bad sync frame.
        }
        return;
      }

      // Only relay frames that belong in the y-protocol: sync (0) and awareness (1).
      // Forged presence frames (100) and unknown types are not relayed to peers.
      if (isRelayableFrame(bytes)) {
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
      }

      // Relaying above is unchanged; this is the added path. The object answers
      // the sender from its own document, so a peer that arrives alone is no
      // longer talking into an empty room.
      try {
        const doc = await this.getRoomDoc(attachment.roomId);

        const replies = handleSyncFrame(doc, bytes, ws);
        for (const reply of replies) {
          try {
            ws.send(reply);
          } catch {
            try {
              ws.close();
            } catch {
              // Already gone.
            }
          }
        }
        await this.flushIfDue();
      } catch {
        // A bug in server sync must not break peer relay; it is the fallback path.
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

  private async handleSocketGone(ws: WebSocket): Promise<void> {
    try {
      const attachment = ws.deserializeAttachment() as SocketIdentity | null;
      if (
        attachment?.accountId
        && this.activeFollow
        && isOwnerRole(getGrantRole(this.db, attachment.roomId, attachment.accountId))
        && !this.hasOpenSocketForAccount(attachment.accountId, ws)
      ) {
        this.activeFollow = null;
        this.broadcastFollow({ active: false }, ws);
      }
      if (attachment?.roomId) this.sweepDepartedCursors(attachment.roomId);
    } catch {
      // A socket with no attachment leaves nothing to sweep by.
    }

    // The closing socket is still in the list, so 1 means this was the last
    // one: the object is about to go quiet and the board must be on disk.
    if (this.ctx.getWebSockets().length <= 1) {
      try {
        await this.flushDirtyDocs();
      } catch {
        // A failed flush must not throw out of handleSocketGone.
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    await this.handleSocketGone(ws);

    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // workerd routes an error close to a different handler than webSocketClose,
    // so cleanup that only lives on the clean path is cleanup that does not run
    // when it matters most. This handler ensures cursor sweeps and board flushes
    // happen on both clean closes and abnormal disconnects (network drops, crashes).
    await this.handleSocketGone(ws);

    try {
      ws.close();
    } catch {
      // Socket already closed.
    }
  }
}
