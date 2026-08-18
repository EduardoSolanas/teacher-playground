import type { RoomDatabase } from '../db';
import { verifiedAccountId } from '../authz';
import {
  effectiveRole,
  getMembership,
  toPublicRole,
} from '../membership';
import { internalErrorResponse } from '../../http/safeError';

// GET /api/whiteboard/room/[roomId]/access - check own access status
export async function handleAccessGet(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    const accountId = verifiedAccountId(request);
    if (!accountId) {
      return Response.json({ error: 'Account required' }, { status: 401 });
    }

    const membership = getMembership(db, roomId, accountId);
    const role = effectiveRole(membership);
    if (role === 'banned') {
      return Response.json({ status: 'rejected' });
    }
    if (role === 'pending') {
      return Response.json({ status: 'pending' });
    }
    if (membership && (role === 'owner' || role === 'editor' || role === 'viewer')) {
      return Response.json({
        status: 'approved',
        role: toPublicRole(role),
        expiresAt: membership.expiresAt,
      });
    }

    return Response.json({ status: 'none' });
  } catch (e) {
    return internalErrorResponse(e, 'handleAccessGet');
  }
}
