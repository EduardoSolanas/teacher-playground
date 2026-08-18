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
      allow_first_user_host INTEGER NOT NULL DEFAULT 0,
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
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'allow_first_user_host')) {
    // Existing rooms migrate to the secure default: the fallback stays off
    // unless a creator turns it on.
    db.exec(`ALTER TABLE rooms ADD COLUMN allow_first_user_host INTEGER NOT NULL DEFAULT 0`);
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'grant_version')) {
    db.exec(`ALTER TABLE rooms ADD COLUMN grant_version INTEGER NOT NULL DEFAULT 0`);
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
    CREATE TABLE IF NOT EXISTS room_tombstones (
      room_id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    )
  `);

  migrateRoomMembers(db);

  db.exec(`DROP TABLE IF EXISTS room_access`);
  db.exec(`DROP TABLE IF EXISTS access_requests`);

  for (const table of ['room_presence', 'waiting_peers']) {
    const peerColumns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!peerColumns.some((column) => column.name === 'account_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT`);
    }
  }
}

const MEMBERSHIP_DDL = `
  CREATE TABLE room_members (
    room_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer','pending','banned')),
    display_name TEXT,
    email TEXT,
    requested_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (room_id, account_id)
  )
`;

function migrateRoomMembers(db: RoomDatabase): void {
  const existing = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_members'`)
    .get() as { name: string } | undefined;

  if (!existing) {
    db.exec(MEMBERSHIP_DDL);
    return;
  }

  const memberColumns = db
    .prepare(`PRAGMA table_info(room_members)`)
    .all() as Array<{ name: string }>;
  if (memberColumns.some((column) => column.name === 'display_name')) return;

  db.exec(MEMBERSHIP_DDL.replace('CREATE TABLE room_members', 'CREATE TABLE room_members_v2'));
  db.exec(`
    INSERT INTO room_members_v2 (
      room_id, account_id, role, display_name, email,
      requested_at, created_at, updated_at, expires_at
    )
    SELECT room_id, account_id,
           CASE role WHEN 'member' THEN 'editor' ELSE role END,
           NULL, NULL, NULL, created_at, created_at, NULL
    FROM room_members
  `);
  db.exec(`DROP TABLE room_members`);
  db.exec(`ALTER TABLE room_members_v2 RENAME TO room_members`);
}

export function roomExists(db: RoomDatabase, roomId: string): boolean {
  return db.prepare(`SELECT 1 FROM rooms WHERE room_id = ?`).get(roomId) !== undefined;
}

/** Every table that stores a `room_id`. */
export const ROOM_SCOPED_TABLES = [
  'room_presence',
  'waiting_peers',
  'kicked_peers',
  'room_members',
  'rooms',
] as const;

/** Deletes every room-scoped row in one SQLite transaction. */
export function deleteRoomScopedData(db: RoomDatabase, roomId: string): void {
  db.transaction(() => {
    for (const table of ROOM_SCOPED_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(roomId);
    }
  })();
}

/**
 * Whether this room lets the earliest present peer act as host when no host is
 * recorded. Off unless a creator opts in: with it on, whoever happens to be
 * first in the room gains moderation power, so it is a deliberate per-room
 * choice rather than a default.
 */
export function getRoomAllowFirstUserHost(
  db: RoomDatabase,
  roomId: string,
): boolean {
  const row = db
    .prepare(`SELECT allow_first_user_host FROM rooms WHERE room_id = ?`)
    .get(roomId) as { allow_first_user_host: number | null } | undefined;
  return row?.allow_first_user_host === 1;
}

export function setRoomAllowFirstUserHost(
  db: RoomDatabase,
  roomId: string,
  allow: boolean,
): void {
  db.prepare(`UPDATE rooms SET allow_first_user_host = ? WHERE room_id = ?`)
    .run(allow ? 1 : 0, roomId);
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

/** Monotonic room grant epoch; bumped on kick so stale sockets cannot publish. */
export function getGrantVersion(db: RoomDatabase, roomId: string): number {
  const row = db
    .prepare(`SELECT grant_version FROM rooms WHERE room_id = ?`)
    .get(roomId) as { grant_version: number } | undefined;
  return row?.grant_version ?? 0;
}

export function incrementGrantVersion(db: RoomDatabase, roomId: string): number {
  db.prepare(`UPDATE rooms SET grant_version = grant_version + 1 WHERE room_id = ?`).run(roomId);
  return getGrantVersion(db, roomId);
}
