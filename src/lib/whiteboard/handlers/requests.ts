import type { RoomDatabase } from '../db';
import { getBearerToken, requireGrant } from '../authz';
import { findGrant, createRequest, listRequests, hashToken } from '../access';
import { parseBody, requestsPostSchema } from '../requestSchemas';
import { randomUUID } from 'node:crypto';

// POST /api/whiteboard/room/[roomId]/requests - create access request
export async function handleRequestsPost(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return Response.json({ error: 'Bearer token required' }, { status: 401 });
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

    // Check if token already has a valid grant
    const grant = findGrant(db, roomId, token);
    if (grant) {
      return Response.json({
        status: 'approved',
        role: grant.role,
      });
    }

    // Check if token already has a pending request
    const tokenHash = hashToken(token);
    const existingRequest = db.prepare(`
      SELECT request_id FROM access_requests
      WHERE room_id = ? AND token_hash = ?
      LIMIT 1
    `).get(roomId, tokenHash) as { request_id: string } | undefined;

    if (existingRequest) {
      return Response.json(
        {
          status: 'pending',
          requestId: existingRequest.request_id,
        },
        { status: 201 }
      );
    }

    // Create new request
    const requestId = randomUUID();
    createRequest(db, {
      roomId,
      requestId,
      token,
      userName: userName.trim(),
      email,
    });

    return Response.json(
      {
        status: 'pending',
        requestId,
      },
      { status: 201 }
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to create request' },
      { status: 500 }
    );
  }
}

// GET /api/whiteboard/room/[roomId]/requests - list access requests (creator only)
export async function handleRequestsGet(
  db: RoomDatabase,
  roomId: string,
  request: Request,
): Promise<Response> {
  try {
    const token = getBearerToken(request);

    if (!token) {
      return Response.json({ error: 'Bearer token required' }, { status: 401 });
    }

    const grant = requireGrant(db, roomId, request, ['creator']);
    if (!grant) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const requests = listRequests(db, roomId);
    return Response.json({ requests });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to list requests' },
      { status: 500 }
    );
  }
}
