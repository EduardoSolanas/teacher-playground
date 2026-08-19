import { randomHexId } from '../../crypto/randomId';
import type { RoomDatabase } from '../db';
import { verifiedAccountId } from '../authz';
import {
  banAccount,
  clearAccountPeers,
  getGrantRole,
  isGrantedRole,
  isOwnerRole,
  enqueueWaitingPeer,
  requestAccess,
  resolveModerationTarget,
  suspendAccount,
} from '../membership';
import { readActiveUsers, readWaitingPeers } from '../presence';
import { getRoomHostPeerId } from '../roomSchema';
import { parseBody, presencePostSchema } from '../requestSchemas';
import { internalErrorResponse } from '../../http/safeError';
import { logAuthEvent } from '../../security/authEvents';

type AuthEventWriter = (line: string) => void;
const defaultAuthEventWriter: AuthEventWriter = (line) => console.info(line);

function callerSeesWaitingQueue(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): boolean {
  const accountId = verifiedAccountId(request);
  if (!accountId) return false;
  return getGrantRole(db, roomId, accountId) === 'owner';
}

function withoutAccountId<T extends { accountId?: unknown }>(rows: T[]) {
  return rows.map((row) => {
    const { accountId: _accountId, ...rest } = row;
    return rest;
  });
}

function presencePayload(
  db: RoomDatabase,
  roomId: string,
  request: Request,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const ownerView = callerSeesWaitingQueue(db, roomId, request);
  const users = readActiveUsers(db, roomId);
  const payload: Record<string, unknown> = {
    users: ownerView ? users : withoutAccountId(users),
    hostPeerId: getRoomHostPeerId(db, roomId),
    ...extra,
  };
  if (ownerView) {
    payload.waitingPeers = readWaitingPeers(db, roomId);
  }
  return payload;
}

export async function handlePresenceGet(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    return Response.json(presencePayload(db, roomId, request));
  } catch (e) {
    return internalErrorResponse(e, 'handlePresenceGet');
  }
}

export async function handlePresencePost(
  db: RoomDatabase,
  roomId: string,
  request: Request,
  write: AuthEventWriter = defaultAuthEventWriter,
): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parseResult = parseBody(presencePostSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const { action, peerId, accountId: bodyAccountId, userName, color } = parseResult.data;
    const caller = verifiedAccountId(request);
    if (!caller) {
      return Response.json({ error: 'Account required' }, { status: 401 });
    }

    if (action === 'raise-hand' || action === 'lower-hand') {
      const grantRole = getGrantRole(db, roomId, caller);
      if (!isGrantedRole(grantRole)) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      const result = db.prepare(
        `UPDATE room_presence SET hand_raised = ? WHERE room_id = ? AND account_id = ?`,
      ).run(action === 'raise-hand' ? 1 : 0, roomId, caller);
      if (result.changes === 0) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      return Response.json(presencePayload(db, roomId, request));
    }

    if (action === 'kick' || action === 'suspend') {
      if (!isOwnerRole(getGrantRole(db, roomId, caller))) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }

      const target = resolveModerationTarget(db, roomId, {
        accountId: bodyAccountId,
        peerId,
      });
      if (!target.ok) {
        return Response.json({ error: target.error }, { status: target.status });
      }
      if (target.accountId === caller || isOwnerRole(getGrantRole(db, roomId, target.accountId))) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }

      const label = target.peerId
        ?? (db.prepare(
          `SELECT peer_id AS peerId, user_name AS userName FROM room_presence
           WHERE room_id = ? AND account_id = ?
           UNION
           SELECT peer_id AS peerId, user_name AS userName FROM waiting_peers
           WHERE room_id = ? AND account_id = ?`,
        ).get(roomId, target.accountId, roomId, target.accountId) as
          | { peerId: string; userName: string }
          | undefined)?.peerId;

      if (action === 'kick') {
        db.transaction(() => {
          banAccount(db, roomId, target.accountId);
          clearAccountPeers(db, roomId, target.accountId);
        })();

        logAuthEvent({
          type: 'revocation',
          accountId: target.accountId,
          roomId,
          outcome: 'kicked',
        }, write);

        return Response.json(presencePayload(db, roomId, request, {
          kickedPeer: { peerId: label ?? target.accountId, accountId: target.accountId },
        }));
      }

      const now = Date.now();
      const presenceRows = db.prepare(
        `SELECT peer_id AS peerId, user_name AS userName, color
         FROM room_presence WHERE room_id = ? AND account_id = ?`,
      ).all(roomId, target.accountId) as Array<{ peerId: string; userName: string; color: string }>;

      db.transaction(() => {
        suspendAccount(db, roomId, target.accountId, now);
        for (const row of presenceRows) {
          db.prepare(
            `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(room_id, peer_id) DO UPDATE SET
              user_name = excluded.user_name,
              color = excluded.color,
              account_id = excluded.account_id`,
          ).run(roomId, row.peerId, row.userName, row.color, now, target.accountId);
        }
        db.prepare(`DELETE FROM room_presence WHERE room_id = ? AND account_id = ?`).run(
          roomId,
          target.accountId,
        );
      })();

      logAuthEvent({
        type: 'revocation',
        accountId: target.accountId,
        roomId,
        outcome: 'suspended',
      }, write);

      return Response.json(presencePayload(db, roomId, request, {
        suspendedPeer: {
          peerId: presenceRows[0]?.peerId ?? label ?? target.accountId,
          accountId: target.accountId,
          userName: presenceRows[0]?.userName,
        },
      }));
    }

    const pId = peerIdForAccount(db, roomId, caller);
    const uName = String(userName || 'Anonymous');
    const c = String(color || '#3498db');
    const grantRole = getGrantRole(db, roomId, caller);

    if (grantRole === 'banned') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const now = Date.now();

    if (isGrantedRole(grantRole)) {
      upsertPresence(db, roomId, pId, uName, c, now, caller);
      db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND account_id = ?`).run(roomId, caller);
      return Response.json(presencePayload(db, roomId, request, { isWaiting: false, peerId: pId }));
    }

    const requested = requestAccess(db, {
      roomId,
      accountId: caller,
      userName: uName,
    });
    if (!requested.ok) {
      if (requested.reason === 'queue_full') {
        return Response.json({ error: 'Waiting queue is full' }, { status: 429 });
      }
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    const queued = enqueueWaitingPeer(db, {
      roomId,
      peerId: pId,
      userName: uName,
      color: c,
      accountId: caller,
      now,
    });
    if (!queued.ok) {
      return Response.json({ error: 'Waiting queue is full' }, { status: 429 });
    }
    return Response.json(presencePayload(db, roomId, request, { isWaiting: true, peerId: pId }));
  } catch (e) {
    return internalErrorResponse(e, 'handlePresencePost');
  }
}

export async function handlePresenceDelete(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const peerId = url.searchParams.get('peerId');
    if (!peerId) {
      return Response.json({ error: 'peerId is required' }, { status: 400 });
    }

    const caller = verifiedAccountId(request);
    if (!caller) {
      return Response.json({ error: 'Account required' }, { status: 401 });
    }

    db.prepare(
      `DELETE FROM room_presence WHERE room_id = ? AND peer_id = ? AND account_id = ?`,
    ).run(roomId, peerId, caller);
    db.prepare(
      `DELETE FROM waiting_peers WHERE room_id = ? AND peer_id = ? AND account_id = ?`,
    ).run(roomId, peerId, caller);
    return Response.json(presencePayload(db, roomId, request));
  } catch (e) {
    return internalErrorResponse(e, 'handlePresenceDelete');
  }
}

function peerIdForAccount(db: RoomDatabase, roomId: string, accountId: string): string {
  const existing = db.prepare(
    `SELECT peer_id AS peerId FROM room_presence WHERE room_id = ? AND account_id = ?
     UNION
     SELECT peer_id AS peerId FROM waiting_peers WHERE room_id = ? AND account_id = ?`,
  ).get(roomId, accountId, roomId, accountId) as { peerId: string } | undefined;
  if (existing?.peerId) return existing.peerId;
  return `user-${randomHexId()}`;
}

function upsertPresence(
  db: RoomDatabase,
  roomId: string,
  peerId: string,
  userName: string,
  color: string,
  now: number,
  accountId: string,
): void {
  db.prepare(
    `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id, hand_raised)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(room_id, peer_id) DO UPDATE SET
      user_name = excluded.user_name,
      color = excluded.color,
      last_seen = excluded.last_seen,
      account_id = excluded.account_id`,
  ).run(roomId, peerId, userName, color, now, now, accountId);
}

