import type { RoomDatabase } from '../db';
import { verifiedAccountId } from '../authz';
import {
  banAccount,
  clearAccountPeers,
  getGrantRole,
  isGrantedRole,
  isOwnerRole,
  requestAccess,
  resolveModerationTarget,
  suspendAccount,
} from '../membership';
import { readActiveUsers, readWaitingPeers } from '../presence';
import { getRoomHostPeerId } from '../roomSchema';
import { parseBody, presencePostSchema } from '../requestSchemas';
import { internalErrorResponse } from '../../http/safeError';

function callerSeesWaitingQueue(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): boolean {
  const accountId = verifiedAccountId(request);
  if (!accountId) return false;
  return getGrantRole(db, roomId, accountId) === 'owner';
}

function presencePayload(
  db: RoomDatabase,
  roomId: string,
  request: Request,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    users: readActiveUsers(db, roomId),
    hostPeerId: getRoomHostPeerId(db, roomId),
    ...extra,
  };
  if (callerSeesWaitingQueue(db, roomId, request)) {
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

      return Response.json(presencePayload(db, roomId, request, {
        suspendedPeer: {
          peerId: presenceRows[0]?.peerId ?? label ?? target.accountId,
          accountId: target.accountId,
          userName: presenceRows[0]?.userName,
        },
      }));
    }

    const pId = String(peerId || '');
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
      return Response.json(presencePayload(db, roomId, request, { isWaiting: false }));
    }

    const requested = requestAccess(db, {
      roomId,
      accountId: caller,
      userName: uName,
    });
    if (!requested.ok) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    enqueueWaiting(db, roomId, pId, uName, c, now, caller);
    return Response.json(presencePayload(db, roomId, request, { isWaiting: true }));
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
    `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id, peer_id) DO UPDATE SET
      user_name = excluded.user_name,
      color = excluded.color,
      last_seen = excluded.last_seen,
      account_id = excluded.account_id`,
  ).run(roomId, peerId, userName, color, now, now, accountId);
}

function enqueueWaiting(
  db: RoomDatabase,
  roomId: string,
  peerId: string,
  userName: string,
  color: string,
  now: number,
  accountId: string,
): void {
  db.prepare(
    `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id, peer_id) DO UPDATE SET
      user_name = excluded.user_name,
      color = excluded.color,
      account_id = excluded.account_id`,
  ).run(roomId, peerId, userName, color, now, accountId);
}
