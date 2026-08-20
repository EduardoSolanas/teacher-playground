import type { RoomDatabase } from './db';
import { createSqlTombstoneStore } from './tombstone';

export const ROOM_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const TOMBSTONE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function applySchema(db: RoomDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      elements TEXT NOT NULL DEFAULT '[]',
      viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
      max_users INTEGER NOT NULL DEFAULT 2,
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
  if (!columns.some((column) => column.name === 'guest_access')) {
    // Existing rooms migrate to the secure default: guests are off unless the
    // owner opts in.
    db.exec(`ALTER TABLE rooms ADD COLUMN guest_access INTEGER NOT NULL DEFAULT 0`);
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'guest_pin')) {
    // PIN is stored in plaintext; see security rationale in the implementation
    // (stored and readable at the start of a session). Online guessing is
    // defeated by lockout, not by encryption or hashing.
    db.exec(`ALTER TABLE rooms ADD COLUMN guest_pin TEXT`);
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'guest_pin_expires_at')) {
    // PIN expires 12 hours after issue.
    db.exec(`ALTER TABLE rooms ADD COLUMN guest_pin_expires_at INTEGER`);
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'guest_failed_count')) {
    // Sliding window counter for failed PIN attempts across all sources.
    db.exec(`ALTER TABLE rooms ADD COLUMN guest_failed_count INTEGER NOT NULL DEFAULT 0`);
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'guest_failed_window_at')) {
    // Start of the current 10-minute lockout window.
    db.exec(`ALTER TABLE rooms ADD COLUMN guest_failed_window_at INTEGER`);
    columns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  }
  if (!columns.some((column) => column.name === 'guest_lockout_until')) {
    // Non-NULL while the room is locked out (50 failures in 10 minutes).
    // Lockout lasts 15 minutes.
    db.exec(`ALTER TABLE rooms ADD COLUMN guest_lockout_until INTEGER`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS room_presence (
      room_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      color TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      hand_raised INTEGER NOT NULL DEFAULT 0,
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
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS room_members_one_owner
     ON room_members(room_id) WHERE role = 'owner'`,
  );

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

  const presenceColumns = db
    .prepare(`PRAGMA table_info(room_presence)`)
    .all() as Array<{ name: string }>;
  if (!presenceColumns.some((column) => column.name === 'hand_raised')) {
    db.exec(`ALTER TABLE room_presence ADD COLUMN hand_raised INTEGER NOT NULL DEFAULT 0`);
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
 * Drop idle rooms into tombstones and expire old tombstones.
 * Does not call Durable Object `storage.deleteAll`.
 */
export function purgeExpiredRoomsAndTombstones(
  db: RoomDatabase,
  now = Date.now(),
): void {
  const idleCutoff = now - ROOM_IDLE_TTL_MS;
  const staleRooms = db
    .prepare(`SELECT room_id AS roomId FROM rooms WHERE updated_at <= ?`)
    .all(idleCutoff) as Array<{ roomId: string }>;
  const store = createSqlTombstoneStore(db);
  for (const { roomId } of staleRooms) {
    deleteRoomScopedData(db, roomId);
    if (!store.has(roomId)) {
      store.add(roomId);
    }
  }
  db.prepare(`DELETE FROM room_tombstones WHERE deleted_at <= ?`).run(
    now - TOMBSTONE_TTL_MS,
  );
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
