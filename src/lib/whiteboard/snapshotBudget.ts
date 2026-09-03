/**
 * What a room's stored board is allowed to weigh.
 *
 * `RoomDO` is declared in `new_sqlite_classes` (wrangler.toml), so it is a
 * SQLite-backed Durable Object: one stored key and its value may total 2 MB,
 * with 10 GB per object.
 *
 * The board no longer occupies one value -- `snapshotChunks.ts` splits it --
 * so this is no longer a cliff the next byte falls off. It stayed because the
 * number is still worth knowing: a board at this weight has grown far past the
 * ~44 KB a measured one occupies, and the excess is edit history rather than
 * anything a teacher drew. Treat a warning here as a question about why the
 * document is growing, not as an imminent write failure.
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
