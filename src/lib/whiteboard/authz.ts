import type { RoomDatabase } from './db';
import { findGrant, Grant, Role } from './access';

export function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  if (!token) {
    return null;
  }

  return token;
}

export function requireGrant(
  db: RoomDatabase,
  roomId: string,
  request: Request,
  roles?: Role[],
  now?: number,
): Grant | null {
  const token = getBearerToken(request);
  if (!token) {
    return null;
  }

  const grant = findGrant(db, roomId, token, now);
  if (!grant) {
    return null;
  }

  if (roles && !roles.includes(grant.role)) {
    return null;
  }

  return grant;
}
