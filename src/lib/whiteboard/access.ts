import { createHash } from 'node:crypto';
import type { RoomDatabase } from './db';

export type Role = 'creator' | 'peer' | 'viewer';

export interface Grant {
  roomId: string;
  role: Role;
  userName: string;
  email: string | null;
  createdAt: number;
  expiresAt: number | null;
}

export interface AccessRequest {
  requestId: string;
  roomId: string;
  userName: string;
  email: string | null;
  requestedAt: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function grantAccess(
  db: RoomDatabase,
  params: {
    roomId: string;
    token: string;
    role: Role;
    userName: string;
    email?: string;
    expiresAt?: number | null;
    now?: number;
  },
): Grant {
  const tokenHash = hashToken(params.token);
  const createdAt = params.now ?? Date.now();
  const expiresAt = params.expiresAt ?? null;

  db.prepare(`
    INSERT OR REPLACE INTO room_access
    (room_id, token_hash, role, user_name, email, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.roomId,
    tokenHash,
    params.role,
    params.userName,
    params.email ?? null,
    createdAt,
    expiresAt,
  );

  return {
    roomId: params.roomId,
    role: params.role,
    userName: params.userName,
    email: params.email ?? null,
    createdAt,
    expiresAt,
  };
}

export function findGrant(
  db: RoomDatabase,
  roomId: string,
  token: string,
  now?: number,
): Grant | null {
  const tokenHash = hashToken(token);
  const currentTime = now ?? Date.now();

  const row = db.prepare(`
    SELECT role, user_name, email, created_at, expires_at
    FROM room_access
    WHERE room_id = ? AND token_hash = ?
  `).get(roomId, tokenHash) as {
    role: Role;
    user_name: string;
    email: string | null;
    created_at: number;
    expires_at: number | null;
  } | undefined;

  if (!row) {
    return null;
  }

  if (row.expires_at !== null && row.expires_at <= currentTime) {
    return null;
  }

  return {
    roomId,
    role: row.role,
    userName: row.user_name,
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createRequest(
  db: RoomDatabase,
  params: {
    roomId: string;
    requestId: string;
    token: string;
    userName: string;
    email?: string;
    now?: number;
  },
): AccessRequest {
  const tokenHash = hashToken(params.token);
  const requestedAt = params.now ?? Date.now();

  db.prepare(`
    INSERT INTO access_requests
    (room_id, request_id, token_hash, user_name, email, requested_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.roomId,
    params.requestId,
    tokenHash,
    params.userName,
    params.email ?? null,
    requestedAt,
  );

  return {
    requestId: params.requestId,
    roomId: params.roomId,
    userName: params.userName,
    email: params.email ?? null,
    requestedAt,
  };
}

export function listRequests(db: RoomDatabase, roomId: string): AccessRequest[] {
  const rows = db.prepare(`
    SELECT request_id, user_name, email, requested_at
    FROM access_requests
    WHERE room_id = ?
    ORDER BY requested_at ASC
  `).all(roomId) as Array<{
    request_id: string;
    user_name: string;
    email: string | null;
    requested_at: number;
  }>;

  return rows.map((row) => ({
    requestId: row.request_id,
    roomId,
    userName: row.user_name,
    email: row.email,
    requestedAt: row.requested_at,
  }));
}

export function approveRequest(
  db: RoomDatabase,
  roomId: string,
  requestId: string,
  params: {
    role: Role;
    expiresAt?: number | null;
    now?: number;
  },
): Grant | null {
  const request = db.prepare(`
    SELECT token_hash, user_name, email, requested_at
    FROM access_requests
    WHERE room_id = ? AND request_id = ?
  `).get(roomId, requestId) as {
    token_hash: string;
    user_name: string;
    email: string | null;
    requested_at: number;
  } | undefined;

  if (!request) {
    return null;
  }

  const createdAt = params.now ?? Date.now();
  const expiresAt = params.expiresAt ?? null;

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO room_access
      (room_id, token_hash, role, user_name, email, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      roomId,
      request.token_hash,
      params.role,
      request.user_name,
      request.email,
      createdAt,
      expiresAt,
    );

    db.prepare(`
      DELETE FROM access_requests
      WHERE room_id = ? AND request_id = ?
    `).run(roomId, requestId);
  });

  transaction();

  return {
    roomId,
    role: params.role,
    userName: request.user_name,
    email: request.email,
    createdAt,
    expiresAt,
  };
}

export function denyRequest(db: RoomDatabase, roomId: string, requestId: string): boolean {
  const result = db.prepare(`
    DELETE FROM access_requests
    WHERE room_id = ? AND request_id = ?
  `).run(roomId, requestId);

  return result.changes > 0;
}

export function revokeGrant(db: RoomDatabase, roomId: string, token: string): boolean {
  const tokenHash = hashToken(token);
  const result = db.prepare(`
    DELETE FROM room_access
    WHERE room_id = ? AND token_hash = ?
  `).run(roomId, tokenHash);

  return result.changes > 0;
}

export function purgeExpiredGrants(db: RoomDatabase, now?: number): number {
  const currentTime = now ?? Date.now();
  const result = db.prepare(`
    DELETE FROM room_access
    WHERE expires_at IS NOT NULL AND expires_at <= ?
  `).run(currentTime);

  return result.changes;
}
