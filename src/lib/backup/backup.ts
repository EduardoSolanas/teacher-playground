import type { RoomDatabase } from '../whiteboard/db';
import { ROOM_IDLE_TTL_MS, ROOM_SCOPED_TABLES } from '../whiteboard/roomSchema';

/**
 * Application-managed export of Durable Object SQLite state (BAK-01).
 *
 * workerd's `SqlStorage` has no native dump/export API, so a backup is a
 * row-wise serialization over a known table list. `serializeBackup` produces a
 * JSON-shaped dump that `restoreBackup` can replay into any schema-compatible
 * database — the restore rehearsal in src/backup.workers.test.ts proves row
 * parity for every covered table.
 */

export const BACKUP_VERSION = 1;

/** How long a target stays out of the due list after a successful backup. */
export const BACKUP_CADENCE_MS = 24 * 60 * 60 * 1000;

/**
 * Marker prefix for binary (BLOB) column values. A value SQLite returned as a
 * blob is serialized as `"<prefix><base64>"` and decoded back to bytes on
 * restore. Encoding fires only for actual runtime blob values, and decoding
 * only for columns whose declared type is BLOB, so a plain TEXT value can
 * never be mistaken for the marker. Every column in the tables this slice
 * backs up is TEXT or INTEGER, so the marker is a documented safety net for
 * future BLOB columns rather than a path the room dump ever takes.
 */
export const BACKUP_BLOB_PREFIX = 'base64:';

export type BackupCellValue = string | number | null;

export interface BackupTableDump {
  name: string;
  rows: Array<Record<string, BackupCellValue>>;
}

export interface BackupDump {
  version: typeof BACKUP_VERSION;
  createdAt: number;
  tables: BackupTableDump[];
}

/**
 * Tables the RoomDO export route covers: the pinned BAK-01 list, `rooms` first
 * followed by the room-scoped tables in schema order (with `rooms` deduplicated
 * — it is both the head of the list and a member of ROOM_SCOPED_TABLES).
 */
export const ROOM_BACKUP_TABLES: readonly string[] = [
  'rooms',
  ...ROOM_SCOPED_TABLES.filter((table) => table !== 'rooms'),
];

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export class BackupRestoreError extends BackupError {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRestoreError';
  }
}

interface ColumnInfo {
  name: string;
  type: string;
  pk: number;
}

/** Doubles an embedded quote so the identifier is safe inside SQL quotes. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** PRAGMA table_info rows, as both better-sqlite3 and workerd report them. */
function tableColumns(db: RoomDatabase, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColumnInfo[];
}

/**
 * Deterministic row order: every PRIMARY KEY column in key order, falling back
 * to rowid for a table without one. Tables listed in ROOM_BACKUP_TABLES all
 * declare primary keys, so the fallback documents intent rather than carrying
 * weight — a dump of the same data is byte-identical across runs.
 */
function orderByClause(columns: ColumnInfo[]): string {
  const pkColumns = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => quoteIdentifier(column.name));
  if (pkColumns.length > 0) return ` ORDER BY ${pkColumns.join(', ')} ASC`;
  // Stryker disable next-line StringLiteral -- rowid order equals an unordered scan of a rowid table, so no observation distinguishes this fallback; it is unreachable for the backed-up tables, which all declare primary keys.
  return ' ORDER BY rowid ASC';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  // Stryker disable next-line EqualityOperator -- a `<=` mutant only adds one empty-slice iteration whose output is '' : an equivalent mutant.
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  // Stryker disable next-line EqualityOperator -- a `<=` mutant writes past a Uint8Array's length, which is a silent no-op : an equivalent mutant.
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeValue(value: unknown): BackupCellValue {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return value as string;
  if (type === 'number') return value as number;
  // Stryker disable next-line ConditionalExpression,StringLiteral,BlockStatement -- no driver here returns BigInt cells (INTEGER columns hold in-range timestamps and counters), so this defensive branch is unreachable with real objects.
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  // Stryker disable next-line ConditionalExpression,StringLiteral -- SQLite storage never returns boolean cells (SQL booleans are INTEGER).
  if (type === 'boolean') return value ? 1 : 0;
  // Stryker disable next-line ConditionalExpression -- a non-view object cell value never occurs in either driver, so the `true` mutant is unreachable; the blob round-trip test kills `false`.
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return BACKUP_BLOB_PREFIX + toBase64(bytes);
  }
  throw new BackupError(`unsupported backup value of type ${type}`);
}

/**
 * Whether a column's declared type is BLOB. SQLite canonicalizes declared
 * type names in PRAGMA table_info (verified against better-sqlite3: `blob`,
 * `Blob` and `  BLOB  ` all report "BLOB"), so a plain comparison is exact.
 */
function isBlobColumn(declaredType: string): boolean {
  return declaredType === 'BLOB';
}

function decodeValue(declaredType: string, value: BackupCellValue): unknown {
  if (
    typeof value === 'string' &&
    value.startsWith(BACKUP_BLOB_PREFIX) &&
    isBlobColumn(declaredType)
  ) {
    return fromBase64(value.slice(BACKUP_BLOB_PREFIX.length));
  }
  return value;
}

/**
 * Serializes the given tables, in list order, with rows ordered by primary
 * key. Values are limited to what SQLite storage returns (null, numbers,
 * strings, blobs) so the dump round-trips without information loss.
 */
export function serializeBackup(
  db: RoomDatabase,
  tables: readonly string[],
): BackupDump {
  return {
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    tables: tables.map((table) => {
      const columns = tableColumns(db, table);
      if (columns.length === 0) {
        throw new BackupError(`cannot back up unknown table ${quoteIdentifier(table)}`);
      }
      const rows = (
        db.prepare(`SELECT * FROM ${quoteIdentifier(table)}${orderByClause(columns)}`).all() as
          Array<Record<string, unknown>>
      ).map((row) => {
        const encoded: Record<string, BackupCellValue> = {};
        for (const column of columns) {
          encoded[column.name] = encodeValue(row[column.name]);
        }
        return encoded;
      });
      return { name: table, rows };
    }),
  };
}

/**
 * Replays a dump into a database whose schema is already applied: each table's
 * existing rows are deleted and the dump's rows inserted, all inside one
 * transaction. On workerd, `RoomDatabase.transaction` wraps the Durable
 * Object's `storage.transactionSync` (an atomic BEGIN/COMMIT with rollback on
 * throw), which is the safest primitive the runtime offers — a failure partway
 * through leaves the previous contents untouched.
 */
export function restoreBackup(db: RoomDatabase, dump: BackupDump): void {
  if (dump === null || typeof dump !== 'object' || Array.isArray(dump)) {
    throw new BackupRestoreError('malformed backup: not an object');
  }
  if (dump.version !== BACKUP_VERSION) {
    throw new BackupRestoreError(`unsupported backup version ${String(dump.version)}`);
  }
  if (!Array.isArray(dump.tables)) {
    throw new BackupRestoreError('malformed backup: tables must be an array');
  }

  db.transaction(() => {
    for (const table of dump.tables) {
      // Optional chaining subsumes the null and non-object checks: any entry
      // without a string name is malformed, whatever its runtime type.
      if (typeof table?.name !== 'string') {
        throw new BackupRestoreError('malformed backup: table without a name');
      }
      if (!Array.isArray(table.rows)) {
        throw new BackupRestoreError(`malformed backup: rows of ${table.name} must be an array`);
      }
      const columns = tableColumns(db, table.name);
      if (columns.length === 0) {
        throw new BackupRestoreError(`cannot restore unknown table ${quoteIdentifier(table.name)}`);
      }
      const byName = new Map(columns.map((column) => [column.name, column]));
      db.prepare(`DELETE FROM ${quoteIdentifier(table.name)}`).run();
      for (const row of table.rows) {
        if (row === null || typeof row !== 'object') {
          throw new BackupRestoreError(`malformed backup: row in ${table.name} is not an object`);
        }
        const keys = Object.keys(row);
        for (const key of keys) {
          if (!byName.has(key)) {
            throw new BackupRestoreError(
              `cannot restore unknown column ${quoteIdentifier(key)} in ${table.name}`,
            );
          }
        }
        if (keys.length === 0) continue;
        const values = keys.map((key) => decodeValue(byName.get(key)!.type, row[key]));
        db.prepare(
          `INSERT INTO ${quoteIdentifier(table.name)} (${keys.map(quoteIdentifier).join(', ')}) ` +
            `VALUES (${keys.map(() => '?').join(', ')})`,
        ).run(...values);
      }
    }
  })();
}

/**
 * Whether a registered target needs a backup right now.
 *
 * Both windows mirror the lifecycle the data already has: the activity window
 * is the room-idle retention (ROOM_IDLE_TTL_MS by default — a room the retention
 * sweep is about to drop is not worth backing up), and the cadence boundary is
 * inclusive (`now - lastBackupAt >= windowMs`) so a 24h-cadence target is due
 * at exactly 24h. `lastBackupAt === null` means never backed up, hence due.
 */
export function isBackupDue(
  lastBackupAt: number | null,
  lastActivityAt: number,
  now: number,
  options: { windowMs?: number; activityWindowMs?: number } = {},
): boolean {
  const windowMs = options.windowMs ?? BACKUP_CADENCE_MS;
  const activityWindowMs = options.activityWindowMs ?? ROOM_IDLE_TTL_MS;
  if (now - lastActivityAt >= activityWindowMs) return false;
  if (lastBackupAt === null) return true;
  return now - lastBackupAt >= windowMs;
}

/**
 * R2 object key for one backup. Private bucket, no public URL: the layout is
 * `backups/{doClass}/{doId}/{ISO timestamp}.json` so a prefix list under
 * `backups/rooms/{roomId}/` enumerates a room's export history newest-last.
 */
export function backupObjectKey(
  doClass: 'rooms' | 'identity',
  doId: string,
  createdAt: number,
): string {
  return `backups/${doClass}/${doId}/${new Date(createdAt).toISOString()}.json`;
}

/**
 * Whether the backup cycle may run.
 *
 * Unset, empty, 'on'/'true'/'1' enable; 'off'/'false'/'0' is the kill switch;
 * anything else enables. Fail-open is deliberate and unlike
 * documentsFlag's fail-closed: a mistyped value here costs R2 storage for
 * objects nobody restores, while failing closed would silently leave every
 * classroom's only application-managed export uncollected with nothing on the
 * page to say so. The explicit switches exist for the operator who wants the
 * cost back.
 */
export function parseBackupsEnabled(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'false' || normalized === '0') return false;
  return true;
}
