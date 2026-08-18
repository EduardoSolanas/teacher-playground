import type { RoomDatabase } from '../db';
import { verifiedAccountId } from '../authz';
import { getGrantRole, isOwnerRole, listPending, requestAccess } from '../membership';
import { parseBody, requestsPostSchema } from '../requestSchemas';
import { internalErrorResponse } from '../../http/safeError';

export async function handleRequestsPost(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    const accountId = verifiedAccountId(request);
    if (!accountId) {
      return Response.json({ error: 'Account required' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parseResult = parseBody(requestsPostSchema, body);
    if (!parseResult.ok) {
      return Response.json({ error: parseResult.error }, { status: 400 });
    }

    const { userName, email } = parseResult.data;
    const result = requestAccess(db, {
      roomId,
      accountId,
      userName: userName.trim(),
      email,
    });

    if (!result.ok) {
      if (result.reason === 'queue_full') {
        return Response.json({ error: 'Waiting queue is full' }, { status: 429 });
      }
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (result.status === 'approved') {
      return Response.json({
        status: 'approved',
        role: result.role,
      });
    }

    return Response.json(
      {
        status: 'pending',
        requestId: result.requestId,
      },
      { status: 201 },
    );
  } catch (e) {
    return internalErrorResponse(e, 'handleRequestsPost');
  }
}

export async function handleRequestsGet(
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

    const requests = listPending(db, roomId);
    return Response.json({ requests });
  } catch (e) {
    return internalErrorResponse(e, 'handleRequestsGet');
  }
}
