import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { applySchema, listRoomErrors, recordRoomError, ERROR_RING_CAP } from './roomSchema';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('the room error ring', () => {
  it('creates the error_ring table additively and idempotently', () => {
    applySchema(db);
    const columns = db.prepare(`PRAGMA table_info(error_ring)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(['id', 'at', 'scope', 'message']);
  });

  it('lists recorded errors newest first with at, scope, and message', () => {
    recordRoomError(db, { at: 1000, scope: 'flushProjection', message: 'boom-1' });
    recordRoomError(db, { at: 2000, scope: 'stageSyncUpdate', message: 'boom-2' });

    expect(listRoomErrors(db)).toEqual([
      { at: 2000, scope: 'stageSyncUpdate', message: 'boom-2' },
      { at: 1000, scope: 'flushProjection', message: 'boom-1' },
    ]);
  });

  it(`trims the oldest row at the ${ERROR_RING_CAP}-row cap: the 101st insert drops the first`, () => {
    for (let index = 1; index <= ERROR_RING_CAP + 1; index += 1) {
      recordRoomError(db, {
        at: index,
        scope: `op-${index}`,
        message: `error-${index}`,
      });
    }

    const rows = listRoomErrors(db);
    expect(rows).toHaveLength(ERROR_RING_CAP);
    // Newest first: the 101st insert is present, the oldest (op-1) is gone.
    expect(rows[0]).toMatchObject({ scope: `op-${ERROR_RING_CAP + 1}` });
    expect(rows[ERROR_RING_CAP - 1]).toMatchObject({ scope: `op-2` });
    expect(rows.some((row) => row.scope === 'op-1')).toBe(false);
    // The table itself holds no more than the cap.
    const count = (
      db.prepare(`SELECT COUNT(*) AS count FROM error_ring`).get() as { count: number }
    ).count;
    expect(count).toBe(ERROR_RING_CAP);
  });
});
