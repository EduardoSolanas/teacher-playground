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

  // Durable room membership, keyed by the verified local account rather than a
  // client-supplied peer id. room_presence is a liveness view that is pruned on
  // a short timer, so it cannot answer "may this account open this board".
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','member')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, account_id)
    )
  `);

  // The account behind a peer, so an approval can promote the right account.
  for (const table of ['room_presence', 'waiting_peers']) {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'account_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT`);
    }
  }
}

export type RoomRole = 'owner' | 'member';

/** Records a room membership. An existing owner is never demoted. */
export function addRoomMember(
  db: RoomDatabase,
  roomId: string,
  accountId: string,
  role: RoomRole,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO room_members (room_id, account_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id, account_id) DO UPDATE SET
       role = CASE WHEN room_members.role = 'owner' THEN 'owner' ELSE excluded.role END`,
  ).run(roomId, accountId, role, now);
}

export function getRoomRole(
  db: RoomDatabase,
  roomId: string,
  accountId: string | null,
): RoomRole | null {
  if (!accountId) return null;
  const row = db
    .prepare(`SELECT role FROM room_members WHERE room_id = ? AND account_id = ?`)
    .get(roomId, accountId) as { role: RoomRole } | undefined;
  return row?.role ?? null;
}

export function roomExists(db: RoomDatabase, roomId: string): boolean {
  return db.prepare(`SELECT 1 FROM rooms WHERE room_id = ?`).get(roomId) !== undefined;
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
