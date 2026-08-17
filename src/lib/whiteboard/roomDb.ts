import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { RoomDatabase } from './db';
import { applySchema } from './roomSchema';

const DATA_DIR = path.join(process.cwd(), '.data');

// Overridable so tests can use an in-memory database instead of contending
// over the real one across parallel workers.
const DB_PATH = process.env.WHITEBOARD_DB_PATH || path.join(DATA_DIR, 'whiteboard.db');
const IS_IN_MEMORY = DB_PATH === ':memory:';

export { applySchema, getRoomHostPeerId } from './roomSchema';

let connection: RoomDatabase | null = null;

/**
 * One connection per process. Opening a fresh `better-sqlite3` handle per call
 * never closed the previous one, which exhausts file handles and surfaces as
 * intermittent "disk I/O error" under load.
 */
export function getRoomDb(): RoomDatabase {
  if (connection) {
    return connection;
  }

  if (!IS_IN_MEMORY && !fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  if (!IS_IN_MEMORY) {
    db.pragma('journal_mode = WAL');
  }
  applySchema(db);

  connection = db;
  return connection;
}
