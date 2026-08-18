import type { RoomDatabase } from '../db';
import { readActiveUsers } from '../presence';
import { parseBody, waitingPostSchema } from '../requestSchemas';
import { verifiedAccountId } from '../authz';
import {
  approveAccount,
  banAccount,
  clearAccountPeers,
  dropPending,
  getGrantRole,
  isOwnerRole,
  listPending,
  peerAccountId,
  resolveModerationTarget,
} from '../membership';
import { internalErrorResponse } from '../../http/safeError';

export async function handleWaitingGet(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    const accountId = verifiedAccountId(request);
    if (!accountId) {
      return Response.json({ error: 'Account required' }, { status: 401 });
    }
    if (!isOwnerRole(getGrantRole(db, roomId, accountId))) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const pending = listPending(db, roomId);
    const peerRows = db.prepare(
      `SELECT account_id AS accountId, peer_id AS peerId, user_name AS userName,
              color, requested_at AS requestedAt
       FROM waiting_peers
       WHERE room_id = ?`,
    ).all(roomId) as Array<{
      accountId: string | null;
      peerId: string;
      userName: string;
      color: string;
      requestedAt: number;
    }>;

    const peersByAccount = new Map<string, typeof peerRows[number]>();
    for (const row of peerRows) {
      if (row.accountId && !peersByAccount.has(row.accountId)) {
        peersByAccount.set(row.accountId, row);
      }
    }

    return Response.json({
      waitingPeers: pending.map((item) => {
        const peer = peersByAccount.get(item.requestId);
        return {
          peerId: peer?.peerId ?? item.requestId,
          accountId: item.requestId,
          userName: peer?.userName || item.userName,
          color: peer?.color ?? '#3498db',
          requestedAt: peer?.requestedAt ?? item.requestedAt,
        };
      }),
    });
  } catch (e) {
    return internalErrorResponse(e, 'handleWaitingGet');
  }
}

function admitAccount(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
  now: number,
): void {
  const rows = db.prepare(
    `SELECT peer_id AS peerId, user_name AS userName, color
     FROM waiting_peers WHERE room_id = ? AND account_id = ?`,
  ).all(roomId, accountId) as Array<{ peerId: string; userName: string; color: string }>;

  for (const row of rows) {
    db.prepare(
      `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, peer_id) DO UPDATE SET
        user_name = excluded.user_name,
        color = excluded.color,
        last_seen = excluded.last_seen,
        account_id = excluded.account_id`,
    ).run(roomId, row.peerId, row.userName, row.color, now, now, accountId);
  }

  db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND account_id = ?`).run(roomId, accountId);
  for (const row of rows) {
    db.prepare(`DELETE FROM kicked_peers WHERE room_id = ? AND peer_id = ?`).run(roomId, row.peerId);
  }
}

export async function handleWaitingPost(
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

    const parseResult = parseBody(waitingPostSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const caller = verifiedAccountId(request);
    if (!caller) {
      return Response.json({ error: 'Account required' }, { status: 401 });
    }
    if (!isOwnerRole(getGrantRole(db, roomId, caller))) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { peerId, accountId: bodyAccountId, action } = parseResult.data;
    const target = resolveModerationTarget(db, roomId, {
      accountId: bodyAccountId,
      peerId,
    });
    if (!target.ok) {
      return Response.json({ error: target.error }, { status: target.status });
    }

    if (action === 'approve') {
      const now = Date.now();
      try {
        db.transaction(() => {
          const granted = approveAccount(db, roomId, target.accountId, { role: 'editor', now });
          if (!granted) {
            throw new Error('NOT_PENDING');
          }
          admitAccount(db, roomId, target.accountId, now);
        })();
      } catch (e) {
        if (e instanceof Error && e.message === 'NOT_PENDING') {
          return Response.json({ error: 'Peer not found in waiting list' }, { status: 404 });
        }
        throw e;
      }

      const activeUsers = readActiveUsers(db, roomId);
      return Response.json({
        users: activeUsers,
        success: true,
      });
    }

    if (action === 'reject') {
      db.transaction(() => {
        banAccount(db, roomId, target.accountId);
        clearAccountPeers(db, roomId, target.accountId);
      })();

      return Response.json({ success: true });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    return internalErrorResponse(e, 'handleWaitingPost');
  }
}

export async function handleWaitingDelete(
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

    const bound = peerAccountId(db, roomId, peerId);
    if (!bound) {
      return Response.json({ error: 'Peer not bound to an account' }, { status: 404 });
    }

    const owner = isOwnerRole(getGrantRole(db, roomId, caller));
    if (bound !== caller && !owner) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    db.transaction(() => {
      dropPending(db, roomId, bound);
      db.prepare(
        `DELETE FROM waiting_peers WHERE room_id = ? AND account_id = ?`,
      ).run(roomId, bound);
    })();

    return Response.json({ success: true });
  } catch (e) {
    return internalErrorResponse(e, 'handleWaitingDelete');
  }
}
