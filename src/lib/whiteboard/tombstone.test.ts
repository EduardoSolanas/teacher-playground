import { describe, it, expect } from 'vitest';
import {
  createTombstoneStore,
  createSqlTombstoneStore,
  assertNotTombstoned,
} from './tombstone';
import { getRoomDb } from './roomDb';
import { deleteRoomScopedData } from './roomSchema';
import { getGrantRole } from './membership';
import { handleRoomDelete, handleRoomPost } from './handlers/room';

describe('tombstone store (SEC-007)', () => {
  it('add then has returns true', () => {
    const store = createTombstoneStore();
    store.add('room-1');
    expect(store.has('room-1')).toBe(true);
  });

  it('unknown roomId returns false', () => {
    const store = createTombstoneStore();
    expect(store.has('never-added')).toBe(false);
  });

  it('assertNotTombstoned allows non-tombstoned room', () => {
    const store = createTombstoneStore();
    expect(assertNotTombstoned(store, 'room-1')).toEqual({ ok: true });
  });

  it('assertNotTombstoned rejects tombstoned room', () => {
    const store = createTombstoneStore();
    store.add('room-1');
    expect(assertNotTombstoned(store, 'room-1')).toEqual({
      ok: false,
      reason: 'tombstoned',
    });
  });

  it('add persists — removing add must fail this test', () => {
    const store = createTombstoneStore();
    store.add('room-1');
    expect(store.has('room-1')).toBe(true);
  });

  it('survives scoped deletes so recreate cannot restore a creator grant', async () => {
    const db = getRoomDb();
    const roomId = `tombstone-recreate-${crypto.randomUUID()}`;
    const owner = `acc-${crypto.randomUUID()}`;
    const url = new URL(`http://localhost/api/whiteboard/room/${roomId}`);
    url.searchParams.set('accountId', owner);
    const scenePost = () =>
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      });

    const created = await handleRoomPost(db, roomId, scenePost());
    expect(created.status).toBe(200);
    expect(getGrantRole(db, roomId, owner)).toBe('owner');

    const deleted = await handleRoomDelete(
      db,
      roomId,
      new Request(`http://localhost/api/whiteboard/room/${roomId}`, { method: 'DELETE' }),
    );
    expect(deleted.status).toBe(200);
    expect(getGrantRole(db, roomId, owner)).toBeNull();

    deleteRoomScopedData(db, roomId);
    const store = createSqlTombstoneStore(db);
    expect(store.has(roomId)).toBe(true);
    expect(assertNotTombstoned(store, roomId)).toEqual({
      ok: false,
      reason: 'tombstoned',
    });

    const recreate = await handleRoomPost(db, roomId, scenePost());
    expect(recreate.status).toBe(410);
    expect(await recreate.json()).toEqual({ error: 'Room deleted' });
    expect(recreate.headers.get('Cache-Control')).toBe('no-store');
    expect(getGrantRole(db, roomId, owner)).toBeNull();
    expect(store.has(roomId)).toBe(true);
  });
});
