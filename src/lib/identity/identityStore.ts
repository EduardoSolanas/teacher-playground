import type { RoomDatabase } from '../whiteboard/db';
import { isValidRoomId } from '../worker/requestGuard';
import { MAX_NAME_LENGTH, stripAsciiControls } from '../whiteboard/requestSchemas';

const MAX_SUBJECT_KEY_LENGTH = 2048;

export type AccountState = 'active' | 'disabled';

export interface AccountRecord {
  accountId: string;
  state: AccountState;
  authorizationEpoch: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubjectKey {
  issuer: string;
  subject: string;
}

export interface ResolvedAccount {
  account: AccountRecord;
  created: boolean;
}

export class IdentityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityInputError';
  }
}

/** Creates the global identity schema. This schema must not be applied per room. */
export function applyIdentitySchema(db: RoomDatabase): void {
  db.exec(`PRAGMA foreign_keys = ON`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY
        CHECK (length(account_id) BETWEEN 1 AND 128),
      state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'disabled')),
      authorization_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (authorization_epoch >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
        CHECK (updated_at >= created_at)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS access_subjects (
      issuer TEXT NOT NULL
        CHECK (length(trim(issuer)) > 0 AND length(issuer) <= 2048),
      subject TEXT NOT NULL
        CHECK (length(trim(subject)) > 0 AND length(subject) <= 2048),
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (issuer, subject),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_subjects_account
      ON access_subjects(account_id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_hash TEXT PRIMARY KEY
        CHECK (
          length(session_hash) = 64 AND
          session_hash NOT GLOB '*[^0-9a-f]*'
        ),
      account_id TEXT NOT NULL,
      authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= created_at),
      idle_expires_at INTEGER NOT NULL CHECK (idle_expires_at > created_at),
      absolute_expires_at INTEGER NOT NULL
        CHECK (
          absolute_expires_at > created_at AND
          absolute_expires_at >= idle_expires_at
        ),
      revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
      confirmed_at INTEGER CHECK (confirmed_at IS NULL OR confirmed_at >= created_at),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry
      ON sessions(idle_expires_at, absolute_expires_at)
  `);

  const sessionColumns = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === 'confirmed_at')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN confirmed_at INTEGER`);
  }

  // Append-only record of operator actions that change what an account may do.
  // Epoch changes revoke sessions and disconnect live rooms, so they must not
  // be possible without leaving a durable trace of who acted and why.
  // Deliberately not ON DELETE CASCADE: the record outlives the account.
  db.exec(`
    CREATE TABLE IF NOT EXISTS authorization_audit (
      audit_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL
        CHECK (length(account_id) BETWEEN 1 AND 128),
      action TEXT NOT NULL
        CHECK (action IN ('revoke-all', 'disable', 'enable')),
      actor TEXT NOT NULL
        CHECK (length(trim(actor)) > 0 AND length(actor) <= 256),
      reason TEXT NOT NULL
        CHECK (length(trim(reason)) > 0 AND length(reason) <= 1024),
      previous_state TEXT NOT NULL CHECK (previous_state IN ('active','disabled')),
      next_state TEXT NOT NULL CHECK (next_state IN ('active','disabled')),
      previous_epoch INTEGER NOT NULL CHECK (previous_epoch >= 0),
      next_epoch INTEGER NOT NULL CHECK (next_epoch >= previous_epoch),
      revoked_sessions INTEGER NOT NULL CHECK (revoked_sessions >= 0),
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_authorization_audit_account
      ON authorization_audit(account_id, created_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS account_rooms (
      account_id TEXT NOT NULL,
      room_id TEXT NOT NULL
        CHECK (length(room_id) BETWEEN 1 AND 64),
      role TEXT NOT NULL DEFAULT 'owner'
        CHECK (role IN ('owner')),
      name TEXT CHECK (name IS NULL OR length(name) <= 100),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, room_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_account_rooms_account_updated
      ON account_rooms(account_id, updated_at DESC)
  `);

  const accountColumns = db
    .prepare(`PRAGMA table_info(accounts)`)
    .all() as Array<{ name: string }>;
  if (!accountColumns.some((column) => column.name === 'preferred_display_name')) {
    db.exec(
      `ALTER TABLE accounts ADD COLUMN preferred_display_name TEXT
         CHECK (
           preferred_display_name IS NULL OR (
             length(preferred_display_name) BETWEEN 1 AND 100
           )
         )`,
    );
  }
}

export interface AuditContext {
  actor: string;
  reason: string;
}

export interface AuditRecord extends AuditContext {
  auditId: string;
  accountId: string;
  action: 'revoke-all' | 'disable' | 'enable';
  previousState: AccountState;
  nextState: AccountState;
  previousEpoch: number;
  nextEpoch: number;
  revokedSessions: number;
  createdAt: number;
}

const MAX_ACTOR_LENGTH = 256;
const MAX_REASON_LENGTH = 1024;

/** Actor and reason are mandatory: an audit row without them proves nothing. */
export function validateAuditContext(context: unknown): AuditContext {
  const value = context as Partial<AuditContext> | null | undefined;
  const actor = typeof value?.actor === 'string' ? value.actor.trim() : '';
  const reason = typeof value?.reason === 'string' ? value.reason.trim() : '';
  if (!actor || actor.length > MAX_ACTOR_LENGTH) {
    throw new IdentityInputError('actor is required');
  }
  if (!reason || reason.length > MAX_REASON_LENGTH) {
    throw new IdentityInputError('reason is required');
  }
  return { actor, reason };
}

export function recordAuthorizationAudit(
  db: RoomDatabase,
  record: Omit<AuditRecord, 'auditId'>,
): void {
  db.prepare(
    `INSERT INTO authorization_audit (
       audit_id, account_id, action, actor, reason,
       previous_state, next_state, previous_epoch, next_epoch,
       revoked_sessions, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    record.accountId,
    record.action,
    record.actor,
    record.reason,
    record.previousState,
    record.nextState,
    record.previousEpoch,
    record.nextEpoch,
    record.revokedSessions,
    record.createdAt,
  );
}

export function readAuthorizationAudit(
  db: RoomDatabase,
  accountId: string,
): AuditRecord[] {
  return db
    .prepare(
      `SELECT audit_id AS auditId, account_id AS accountId, action, actor, reason,
              previous_state AS previousState, next_state AS nextState,
              previous_epoch AS previousEpoch, next_epoch AS nextEpoch,
              revoked_sessions AS revokedSessions, created_at AS createdAt
       FROM authorization_audit
       WHERE account_id = ?
       ORDER BY created_at ASC, audit_id ASC`,
    )
    .all(accountId) as AuditRecord[];
}

function validateSubjectKey(input: SubjectKey): void {
  for (const [name, value] of [
    ['issuer', input.issuer],
    ['subject', input.subject],
  ] as const) {
    if (
      typeof value !== 'string' ||
      value.trim().length === 0 ||
      value.length > MAX_SUBJECT_KEY_LENGTH
    ) {
      throw new IdentityInputError(
        `${name} must be a non-empty string of at most ${MAX_SUBJECT_KEY_LENGTH} characters`,
      );
    }
  }
}

function findBySubject(
  db: RoomDatabase,
  input: SubjectKey,
): AccountRecord | null {
  const row = db
    .prepare(
      `SELECT
         a.account_id AS accountId,
         a.state,
         a.authorization_epoch AS authorizationEpoch,
         a.created_at AS createdAt,
         a.updated_at AS updatedAt
       FROM access_subjects s
       JOIN accounts a ON a.account_id = s.account_id
       WHERE s.issuer = ? AND s.subject = ?`,
    )
    .get(input.issuer, input.subject) as AccountRecord | undefined;
  return row ?? null;
}

/**
 * Resolves an exact Access issuer/subject pair atomically. Account ids are
 * random and opaque; email and provider labels intentionally never participate.
 */
export function resolveAccountForSubject(
  db: RoomDatabase,
  input: SubjectKey,
): ResolvedAccount {
  validateSubjectKey(input);

  const existing = findBySubject(db, input);
  if (existing) return { account: existing, created: false };

  try {
    return db.transaction(() => {
      const foundInsideTransaction = findBySubject(db, input);
      if (foundInsideTransaction) {
        return { account: foundInsideTransaction, created: false };
      }

      const now = Date.now();
      const account: AccountRecord = {
        accountId: crypto.randomUUID(),
        state: 'active',
        authorizationEpoch: 0,
        createdAt: now,
        updatedAt: now,
      };

      db.prepare(
        `INSERT INTO accounts (
           account_id, state, authorization_epoch, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        account.accountId,
        account.state,
        account.authorizationEpoch,
        account.createdAt,
        account.updatedAt,
      );
      db.prepare(
        `INSERT INTO access_subjects (issuer, subject, account_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(input.issuer, input.subject, account.accountId, now);

      return { account, created: true };
    })();
  } catch (error) {
    // A competing resolver can win the composite-key insert. The transaction
    // rolls our account insert back, so resolving the winner cannot orphan it.
    const winner = findBySubject(db, input);
    if (winner) return { account: winner, created: false };
    throw error;
  }
}

export interface AccountAuthorization {
  state: AccountState;
  authorizationEpoch: number;
}

/** Upper bound so a batch can never build an unbounded SQL statement. */
export const MAX_AUTHORIZATION_BATCH = 500;

/**
 * Reads the current state and authorization epoch for a set of accounts.
 *
 * Used to re-check accounts behind already-established connections, which are
 * otherwise only authorized once at connect time. Unknown accounts are omitted
 * rather than defaulted, so a caller cannot read a missing row as authorized.
 */
export function readAccountAuthorizations(
  db: RoomDatabase,
  accountIds: readonly string[],
): Map<string, AccountAuthorization> {
  if (accountIds.length > MAX_AUTHORIZATION_BATCH) {
    throw new IdentityInputError(
      `at most ${MAX_AUTHORIZATION_BATCH} accounts may be checked at once`,
    );
  }

  const unique = [...new Set(accountIds)];
  const statuses = new Map<string, AccountAuthorization>();
  if (unique.length === 0) return statuses;

  const rows = db
    .prepare(
      `SELECT account_id AS accountId, state, authorization_epoch AS authorizationEpoch
       FROM accounts
       WHERE account_id IN (${unique.map(() => '?').join(', ')})`,
    )
    .all(...unique) as Array<{
      accountId: string;
      state: AccountState;
      authorizationEpoch: number;
    }>;

  for (const row of rows) {
    statuses.set(row.accountId, {
      state: row.state,
      authorizationEpoch: Number(row.authorizationEpoch),
    });
  }

  return statuses;
}

const MAX_OWNED_ROOM_NAME_LENGTH = 100;

export type OwnedRoomRole = 'owner';

export interface OwnedRoomRecord {
  roomId: string;
  name: string | null;
  role: OwnedRoomRole;
  createdAt: number;
  updatedAt: number;
}

export interface RecordOwnedRoomInput {
  accountId: string;
  roomId: string;
  name?: string | null;
  now: number;
}

function normalizeOwnedRoomName(name: string | null | undefined): string | null {
  if (name == null) return null;
  if (typeof name !== 'string' || name.length > MAX_OWNED_ROOM_NAME_LENGTH) {
    throw new IdentityInputError(
      `name must be at most ${MAX_OWNED_ROOM_NAME_LENGTH} characters`,
    );
  }
  return name;
}

function requireValidRoomId(roomId: string): string {
  if (!isValidRoomId(roomId)) {
    throw new IdentityInputError('invalid roomId');
  }
  return roomId;
}

/** Upserts an owned-room index row. created_at is kept on conflict. */
export function recordOwnedRoom(
  db: RoomDatabase,
  input: RecordOwnedRoomInput,
): OwnedRoomRecord {
  const roomId = requireValidRoomId(input.roomId);
  const name = normalizeOwnedRoomName(input.name);
  const now = input.now;

  db.prepare(
    `INSERT INTO account_rooms (
       account_id, room_id, role, name, created_at, updated_at
     ) VALUES (?, ?, 'owner', ?, ?, ?)
     ON CONFLICT(account_id, room_id) DO UPDATE SET
       name = excluded.name,
       updated_at = excluded.updated_at`,
  ).run(input.accountId, roomId, name, now, now);

  const row = db
    .prepare(
      `SELECT room_id AS roomId, name, role,
              created_at AS createdAt, updated_at AS updatedAt
       FROM account_rooms
       WHERE account_id = ? AND room_id = ?`,
    )
    .get(input.accountId, roomId) as OwnedRoomRecord | undefined;
  if (!row) {
    throw new IdentityInputError('failed to record owned room');
  }
  return {
    roomId: row.roomId,
    name: row.name,
    role: row.role,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function listOwnedRooms(
  db: RoomDatabase,
  accountId: string,
): OwnedRoomRecord[] {
  return (
    db
      .prepare(
        `SELECT room_id AS roomId, name, role,
                created_at AS createdAt, updated_at AS updatedAt
         FROM account_rooms
         WHERE account_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(accountId) as OwnedRoomRecord[]
  ).map((row) => ({
    roomId: row.roomId,
    name: row.name,
    role: row.role,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  }));
}

export function ownedRoomExists(
  db: RoomDatabase,
  accountId: string,
  roomId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present FROM account_rooms WHERE account_id = ? AND room_id = ?`,
    )
    .get(accountId, requireValidRoomId(roomId)) as { present: number } | undefined;
  return row !== undefined;
}

export function removeOwnedRoom(
  db: RoomDatabase,
  accountId: string,
  roomId: string,
): void {
  requireValidRoomId(roomId);
  db.prepare(
    `DELETE FROM account_rooms WHERE account_id = ? AND room_id = ?`,
  ).run(accountId, roomId);
}

export function readPreferredDisplayName(
  db: RoomDatabase,
  accountId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT preferred_display_name AS preferredDisplayName
       FROM accounts WHERE account_id = ?`,
    )
    .get(accountId) as { preferredDisplayName: string | null } | undefined;
  return row?.preferredDisplayName ?? null;
}

export function setPreferredDisplayName(
  db: RoomDatabase,
  accountId: string,
  displayName: string,
  now = Date.now(),
): string {
  const cleaned = stripAsciiControls(displayName);
  if (!cleaned || cleaned.length > MAX_NAME_LENGTH) {
    throw new IdentityInputError(
      `displayName must be between 1 and ${MAX_NAME_LENGTH} characters`,
    );
  }
  const updated = db
    .prepare(
      `UPDATE accounts
       SET preferred_display_name = ?, updated_at = ?
       WHERE account_id = ?`,
    )
    .run(cleaned, now, accountId).changes;
  if (updated !== 1) throw new IdentityInputError('account not found');
  return cleaned;
}
