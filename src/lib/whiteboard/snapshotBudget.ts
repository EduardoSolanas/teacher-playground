/**
 * What a room's stored board is allowed to weigh.
 *
 * `RoomDO` is declared in `new_sqlite_classes` (wrangler.toml), so it is a
 * SQLite-backed Durable Object: one stored key and its value may total 2 MB,
 * with 10 GB per object. The older 128 KiB figure belongs to the key-value
 * backend and does not apply here.
 *
 * A board that outgrew the ceiling would not fail loudly — the write throws,
 * the room stays dirty, and it retries on every flush forever, so a board that
 * has silently stopped being saved looks exactly like one that is safe. A
 * measured board is ~44 KB, so the warning is there to make the approach
 * visible long before the cliff, not because the cliff is close.
 */
export const DO_VALUE_LIMIT_BYTES = 2_000_000;

/** Three quarters of the ceiling: room to notice and act before a write fails. */
export const SNAPSHOT_WARN_BYTES = 1_500_000;

export type SnapshotBudgetState = 'fine' | 'approaching' | 'over';

export function snapshotBudgetState(bytes: number): SnapshotBudgetState {
  if (bytes >= DO_VALUE_LIMIT_BYTES) return 'over';
  if (bytes >= SNAPSHOT_WARN_BYTES) return 'approaching';
  return 'fine';
}
