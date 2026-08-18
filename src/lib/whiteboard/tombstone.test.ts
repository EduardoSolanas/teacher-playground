import { describe, it, expect } from 'vitest';
import {
  createTombstoneStore,
  assertNotTombstoned,
} from './tombstone';

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
});
