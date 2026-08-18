import type { RoomDatabase } from '../db';
import { verifiedAccountId } from '../authz';
import { approveAccount, approveRoleFromPayload, banAccount, getGrantRole, isOwnerRole, toPublicRole } from '../membership';
import { parseBody, requestActionPostSchema } from '../requestSchemas';
import { internalErrorResponse } from '../../http/safeError';

export async function handleRequestsIdPost(
  db: RoomDatabase,
  roomId: string,
  requestId: string,
  request: Request,
): Promise<Response> {
  try {
    const caller = verifiedAccountId(request);
    if (!caller) {
      return Response.json({ error: 'Account required' }, { status: 401 });
    }
    if (!isOwnerRole(getGrantRole(db, roomId, caller))) {
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
    // The path names the waiting account. Body.accountId, if sent, is ignored.
    const targetAccountId = requestId;

    if (action === 'approve') {
      const grantRole = approveRoleFromPayload(role);
      const result = db.transaction(() =>
        approveAccount(db, roomId, targetAccountId, { role: grantRole }),
      )();

      if (!result) {
        return Response.json({ error: 'Request not found' }, { status: 404 });
      }

      return Response.json({
        success: true,
        role: toPublicRole(result.role),
        expiresAt: result.expiresAt,
      });
    }

    let denied = false;
    db.transaction(() => {
      const pending = db
        .prepare(
          `SELECT 1 FROM room_members WHERE room_id = ? AND account_id = ? AND role = 'pending'`,
        )
        .get(roomId, targetAccountId);
      if (!pending) return;
      banAccount(db, roomId, targetAccountId);
      db.prepare(`DELETE FROM waiting_peers WHERE room_id = ? AND account_id = ?`)
        .run(roomId, targetAccountId);
      denied = true;
    })();

    if (!denied) {
      return Response.json({ error: 'Request not found' }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (e) {
    return internalErrorResponse(e, 'handleRequestsIdPost');
  }
}
