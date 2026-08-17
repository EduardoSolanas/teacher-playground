import type { RoomDatabase } from './db';

export function applySchema(db: RoomDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      elements TEXT NOT NULL DEFAULT '[]',
      viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
      max_users INTEGER NOT NULL DEFAULT 3,
      host_peer_id TEXT,
      name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  let columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'max_users')) {
    db.exec(`ALTER TABLE rooms ADD COLUMN max_users INTEGER NOT NULL DEFAULT 3`);
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'host_peer_id')) {
    db.exec(`ALTER TABLE rooms ADD COLUMN host_peer_id TEXT`);
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'name')) {
    db.exec(`ALTER TABLE rooms ADD COLUMN name TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS room_presence (
      room_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      color TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (room_id, peer_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS waiting_peers (
      room_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      color TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, peer_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS kicked_peers (
      room_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      kicked_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, peer_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS room_access (
      room_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('creator','peer','viewer')),
      user_name TEXT NOT NULL,
      email TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (room_id, token_hash)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS access_requests (
      room_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      user_name TEXT NOT NULL,
      email TEXT,
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, request_id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_room_access_room ON room_access(room_id)
  `);
}

export function getRoomHostPeerId(
  db: RoomDatabase,
  roomId: string,
): string | null {
  const row = db
    .prepare(`SELECT host_peer_id FROM rooms WHERE room_id = ?`)
    .get(roomId) as { host_peer_id: string | null } | undefined;
  return row?.host_peer_id ?? null;
}
