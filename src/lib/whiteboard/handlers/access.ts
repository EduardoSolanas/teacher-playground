import type { RoomDatabase } from '../db';
import { getBearerToken } from '../authz';
import { findGrant, hashToken } from '../access';

// GET /api/whiteboard/room/[roomId]/access - check own access status
export async function handleAccessGet(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return Response.json({ error: 'Bearer token required' }, { status: 401 });
    }

    // Check if token has a valid grant
    const grant = findGrant(db, roomId, token);
    if (grant) {
      return Response.json({
        status: 'approved',
        role: grant.role,
        expiresAt: grant.expiresAt,
      });
    }

    // Check if token has a pending request
    const tokenHash = hashToken(token);
    const pendingRequest = db.prepare(`
      SELECT request_id FROM access_requests
      WHERE room_id = ? AND token_hash = ?
      LIMIT 1
    `).get(roomId, tokenHash) as { request_id: string } | undefined;

    if (pendingRequest) {
      return Response.json({ status: 'pending' });
    }

    // No grant or request
    return Response.json({ status: 'none' });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to check access' },
      { status: 500 }
    );
  }
}
