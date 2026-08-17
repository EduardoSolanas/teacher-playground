import type { RoomDatabase } from '../db';
import { requireGrant } from '../authz';
import { approveRequest, denyRequest, Role } from '../access';
import { parseBody, requestActionPostSchema } from '../requestSchemas';

// POST /api/whiteboard/room/[roomId]/requests/[requestId] - approve or deny request
export async function handleRequestsIdPost(
  db: RoomDatabase,
  roomId: string,
  requestId: string,
  request: Request,
): Promise<Response> {
  try {
    const grant = requireGrant(db, roomId, request, ['creator']);
    if (!grant) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parseResult = parseBody(requestActionPostSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const { action, role } = parseResult.data;

    if (action === 'approve') {
      const approveRole = (role ?? 'peer') as Role;
      const now = Date.now();
      const expiresAt = approveRole === 'peer'
        ? now + 12 * 60 * 60 * 1000 // 12 hours for peer
        : null; // no expiry for viewer

      const result = approveRequest(db, roomId, requestId, {
        role: approveRole,
        expiresAt,
      });

      if (!result) {
        return Response.json({ error: 'Request not found' }, { status: 404 });
      }

      return Response.json({
        success: true,
        role: result.role,
        expiresAt: result.expiresAt,
      });
    }

    const deleted = denyRequest(db, roomId, requestId);
    if (!deleted) {
      return Response.json({ error: 'Request not found' }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to process request' },
      { status: 500 }
    );
  }
}
