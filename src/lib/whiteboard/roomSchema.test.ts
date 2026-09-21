import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from './roomSchema';
import type { RoomDatabase } from './db';

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((row) => row.name);
}

describe('applySchema', () => {
  it('drops the retired document tables left in an existing room database', () => {
    const db = new Database(':memory:');
    applySchema(db as unknown as RoomDatabase);
    db.exec(`CREATE TABLE IF NOT EXISTS room_documents (document_id TEXT PRIMARY KEY, room_id TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS room_document_jobs (job_id TEXT PRIMARY KEY, room_id TEXT NOT NULL)`);

    applySchema(db as unknown as RoomDatabase);

    expect(tableNames(db)).not.toContain('room_documents');
    expect(tableNames(db)).not.toContain('room_document_jobs');
  });
});
