export interface TombstoneStore {
  add(roomId: string): void;
  has(roomId: string): boolean;
}

export function createTombstoneStore(): TombstoneStore {
  const tombstones = new Map<string, true>();

  return {
    add(roomId: string): void {
      tombstones.set(roomId, true);
    },
    has(roomId: string): boolean {
      return tombstones.has(roomId);
    },
  };
}

export function assertNotTombstoned(
  store: TombstoneStore,
  roomId: string,
): { ok: true } | { ok: false; reason: 'tombstoned' } {
  if (store.has(roomId)) {
    return { ok: false, reason: 'tombstoned' };
  }
  return { ok: true };
}
