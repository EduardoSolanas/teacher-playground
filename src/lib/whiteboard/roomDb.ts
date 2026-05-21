import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), '.data');
const DB_PATH = path.join(DATA_DIR, 'whiteboard.db');

export function getRoomDb(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      elements TEXT NOT NULL DEFAULT '[]',
      viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
      max_users INTEGER NOT NULL DEFAULT 3,
      host_peer_id TEXT,
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

  return db;
}

export function getRoomHostPeerId(
  db: Database.Database,
  roomId: string,
): string | null {
  const row = db
    .prepare(`SELECT host_peer_id FROM rooms WHERE room_id = ?`)
    .get(roomId) as { host_peer_id: string | null } | undefined;
  return row?.host_peer_id ?? null;
}
