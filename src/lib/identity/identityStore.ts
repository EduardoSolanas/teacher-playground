import type { RoomDatabase } from '../whiteboard/db';

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
