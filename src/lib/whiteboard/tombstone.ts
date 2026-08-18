import type { RoomDatabase } from './db';

export interface TombstoneStore {
  add(roomId: string): void;
  has(roomId: string): boolean;
}

export function createTombstoneStore(): TombstoneStore {
  const tombstones = new Map<string, true>();

  return {
    add(roomId: string): void {
      tombstones.set(roomId, true);
    },
    has(roomId: string): boolean {
      return tombstones.has(roomId);
    },
  };
}

export function assertNotTombstoned(
  store: TombstoneStore,
  roomId: string,
): { ok: true } | { ok: false; reason: 'tombstoned' } {
  if (store.has(roomId)) {
    return { ok: false, reason: 'tombstoned' };
  }
  return { ok: true };
}

export function createSqlTombstoneStore(db: RoomDatabase): TombstoneStore {
  return {
    add(roomId: string): void {
      db.prepare(
        `INSERT OR REPLACE INTO room_tombstones (room_id, deleted_at) VALUES (?, ?)`,
      ).run(roomId, Date.now());
    },
    has(roomId: string): boolean {
      return db.prepare(
        `SELECT 1 FROM room_tombstones WHERE room_id = ?`,
      ).get(roomId) !== undefined;
    },
  };
}

export function tombstonedJsonResponse(message = 'Room deleted'): Response {
  return Response.json(
    { error: message },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  );
}
