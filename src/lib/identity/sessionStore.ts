import type { RoomDatabase } from '../whiteboard/db';
import {
  type AccountState,
  type AuditContext,
  listOwnedRooms,
  recordAuthorizationAudit,
  resolveAccountForSubject,
} from './identityStore';

export const SESSION_COOKIE_NAME = '__Host-teacher-session';
// Fixed local policy: 30-minute inactivity, 12-hour maximum lifetime, and at
// most one persistence touch per five minutes. Rotation never extends 12 hours.
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1_000;
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1_000;
export const DESTRUCTIVE_FRESH_MS = 5 * 60 * 1_000;

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_LENGTH = 43;
const MAX_COOKIE_HEADER_LENGTH = 8_192;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_INSERT_ATTEMPTS = 3;

/** A principal already authenticated by the server's Access verifier. */
export interface VerifiedAccessPrincipal {
  readonly issuer: string;
  readonly subject: string;
}

export interface IssuedSession {
  token: string;
  accountId: string;
  authorizationEpoch: number;
  createdAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface ValidatedSession {
  accountId: string;
  sessionId: string;
  authorizationEpoch: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  createdAt: number;
  confirmedAt: number | null;
  touched: boolean;
}

export interface AuthorizationChange {
  accountId: string;
  authorizationEpoch: number;
  state: AccountState;
  revokedSessions: number;
}

interface SessionAuthorityRow {
  sessionHash: string;
  accountId: string;
  sessionEpoch: number;
  accountEpoch: number;
  state: AccountState;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  revokedAt: number | null;
  confirmedAt: number | null;
}

export class SessionUnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'SessionUnauthorizedError';
  }
}

function isSessionToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length === SESSION_TOKEN_LENGTH &&
    SESSION_TOKEN_PATTERN.test(token)
  );
}

function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function findSessionAuthority(
  db: RoomDatabase,
  sessionHash: string,
): SessionAuthorityRow | null {
  return (
    (db
      .prepare(
        `SELECT
           s.session_hash AS sessionHash,
           s.account_id AS accountId,
           s.authorization_epoch AS sessionEpoch,
           a.authorization_epoch AS accountEpoch,
           a.state,
           s.created_at AS createdAt,
           s.last_seen_at AS lastSeenAt,
           s.idle_expires_at AS idleExpiresAt,
           s.absolute_expires_at AS absoluteExpiresAt,
           s.revoked_at AS revokedAt,
           s.confirmed_at AS confirmedAt
         FROM sessions s
         JOIN accounts a ON a.account_id = s.account_id
         WHERE s.session_hash = ?`,
      )
      .get(sessionHash) as SessionAuthorityRow | undefined) ?? null
  );
}

function toValidatedSession(
  row: SessionAuthorityRow,
  idleExpiresAt: number,
  touched: boolean,
): ValidatedSession {
  return {
    accountId: row.accountId,
    sessionId: row.sessionHash,
    authorizationEpoch: row.accountEpoch,
    idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    touched,
  };
}

export function sessionAllowsDestructiveAction(
  session: ValidatedSession,
  now = Date.now(),
): boolean {
  return (
    now - session.createdAt < DESTRUCTIVE_FRESH_MS
    || (session.confirmedAt !== null && now - session.confirmedAt < DESTRUCTIVE_FRESH_MS)
  );
}

function isActiveAt(row: SessionAuthorityRow, now: number): boolean {
  return (
    row.revokedAt === null &&
    row.state === 'active' &&
    row.sessionEpoch === row.accountEpoch &&
    now >= row.createdAt &&
    now < row.idleExpiresAt &&
    now < row.absoluteExpiresAt
  );
}

function revokeRow(
  db: RoomDatabase,
  row: SessionAuthorityRow,
  now: number,
): void {
  if (row.revokedAt !== null) return;
  db.prepare(
    `UPDATE sessions SET revoked_at = ?
     WHERE session_hash = ? AND revoked_at IS NULL`,
  ).run(Math.max(now, row.createdAt), row.sessionHash);
}

function insertSession(
  db: RoomDatabase,
  sessionHash: string,
  accountId: string,
  authorizationEpoch: number,
  now: number,
  absoluteExpiresAt = now + SESSION_ABSOLUTE_TTL_MS,
): Omit<IssuedSession, 'token'> {
  const idleExpiresAt = Math.min(
    now + SESSION_IDLE_TTL_MS,
    absoluteExpiresAt,
  );
  db.prepare(
    `INSERT INTO sessions (
       session_hash, account_id, authorization_epoch, created_at,
       last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    sessionHash,
    accountId,
    authorizationEpoch,
    now,
    now,
    idleExpiresAt,
    absoluteExpiresAt,
  );
  return {
    accountId,
    authorizationEpoch,
    createdAt: now,
    idleExpiresAt,
    absoluteExpiresAt,
  };
}

function currentAccount(
  db: RoomDatabase,
  accountId: string,
): { state: AccountState; authorizationEpoch: number } | null {
  return (
    (db
      .prepare(
        `SELECT state, authorization_epoch AS authorizationEpoch
         FROM accounts WHERE account_id = ?`,
      )
      .get(accountId) as
      | { state: AccountState; authorizationEpoch: number }
      | undefined) ?? null
  );
}

/** Issues a session only from a server-verified Access issuer/subject pair. */
export async function issueSessionForVerifiedPrincipal(
  db: RoomDatabase,
  principal: VerifiedAccessPrincipal,
  now = Date.now(),
): Promise<IssuedSession> {
  const resolved = resolveAccountForSubject(db, principal);

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
    const token = generateSessionToken();
    const sessionHash = await hashSessionToken(token);
    try {
      const persisted = db.transaction(() => {
        const account = currentAccount(db, resolved.account.accountId);
        if (!account || account.state !== 'active') {
          throw new SessionUnauthorizedError();
        }
        return insertSession(
          db,
          sessionHash,
          resolved.account.accountId,
          account.authorizationEpoch,
          now,
        );
      })();
      return { token, ...persisted };
    } catch (error) {
      if (error instanceof SessionUnauthorizedError) throw error;
      if (attempt === MAX_INSERT_ATTEMPTS - 1) throw error;
    }
  }
  throw new SessionUnauthorizedError();
}

/** Deletes rows whose idle or absolute expiry has already passed. */
export function purgeExpiredSessions(db: RoomDatabase, now = Date.now()): number {
  return db
    .prepare(
      `DELETE FROM sessions
       WHERE idle_expires_at <= ? OR absolute_expires_at <= ?`,
    )
    .run(now, now).changes;
}

export async function validateSession(
  db: RoomDatabase,
  token: unknown,
  now = Date.now(),
): Promise<ValidatedSession | null> {
  if (!isSessionToken(token)) return null;
  const sessionHash = await hashSessionToken(token);

  return db.transaction(() => {
    const row = findSessionAuthority(db, sessionHash);
    if (!row) return null;
    if (!isActiveAt(row, now)) {
      revokeRow(db, row, now);
      return null;
    }

    if (now - row.lastSeenAt < SESSION_TOUCH_INTERVAL_MS) {
      return toValidatedSession(row, row.idleExpiresAt, false);
    }

    const idleExpiresAt = Math.min(
      now + SESSION_IDLE_TTL_MS,
      row.absoluteExpiresAt,
    );
    db.prepare(
      `UPDATE sessions SET last_seen_at = ?, idle_expires_at = ?
       WHERE session_hash = ? AND revoked_at IS NULL`,
    ).run(now, idleExpiresAt, sessionHash);
    return toValidatedSession(row, idleExpiresAt, true);
  })();
}

export async function confirmSession(
  db: RoomDatabase,
  token: unknown,
  now = Date.now(),
): Promise<ValidatedSession | null> {
  const session = await validateSession(db, token, now);
  if (!session) return null;
  db.prepare(
    `UPDATE sessions SET confirmed_at = ?
     WHERE session_hash = ? AND revoked_at IS NULL`,
  ).run(now, session.sessionId);
  return { ...session, confirmedAt: now };
}

/**
 * Validates both halves of the application boundary: the opaque session and
 * the exact Access issuer/subject that owns its local account. This endpoint
 * is called only through the Worker-to-DO binding; callers cannot select an
 * account id or provider email.
 */
export async function authorizeSessionForPrincipal(
  db: RoomDatabase,
  token: unknown,
  principal: VerifiedAccessPrincipal,
  now = Date.now(),
): Promise<ValidatedSession | null> {
  const session = await validateSession(db, token, now);
  if (!session) return null;
  const owner = db
    .prepare(
      `SELECT account_id AS accountId
       FROM access_subjects
       WHERE issuer = ? AND subject = ?`,
    )
    .get(principal.issuer, principal.subject) as { accountId: string } | undefined;
  return owner?.accountId === session.accountId ? session : null;
}

export async function rotateSession(
  db: RoomDatabase,
  token: unknown,
  now = Date.now(),
): Promise<IssuedSession | null> {
  if (!isSessionToken(token)) return null;
  const oldHash = await hashSessionToken(token);

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
    const replacement = generateSessionToken();
    const replacementHash = await hashSessionToken(replacement);
    try {
      const persisted = db.transaction(() => {
        const row = findSessionAuthority(db, oldHash);
        if (!row || !isActiveAt(row, now)) {
          if (row) revokeRow(db, row, now);
          return null;
        }

        revokeRow(db, row, now);
        return insertSession(
          db,
          replacementHash,
          row.accountId,
          row.accountEpoch,
          now,
          row.absoluteExpiresAt,
        );
      })();
      return persisted ? { token: replacement, ...persisted } : null;
    } catch (error) {
      if (attempt === MAX_INSERT_ATTEMPTS - 1) throw error;
    }
  }
  return null;
}

export interface AccountDataExport {
  accountId: string;
  createdAt: number;
  updatedAt: number;
  sessions: Array<{
    sessionHash: string;
    createdAt: number;
  }>;
  accessSubjects: Array<{
    issuer: string;
    subject: string;
    createdAt: number;
  }>;
}

/**
 * Portable dump of the account that owns a valid session. The caller is
 * identified only by the opaque token; another account's rows never appear,
 * and session tokens themselves are never included.
 */
export async function exportOwnAccountData(
  db: RoomDatabase,
  token: unknown,
  now = Date.now(),
): Promise<AccountDataExport | null> {
  const session = await validateSession(db, token, now);
  if (!session) return null;

  const account = db
    .prepare(
      `SELECT
         account_id AS accountId,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM accounts WHERE account_id = ?`,
    )
    .get(session.accountId) as
    | { accountId: string; createdAt: number; updatedAt: number }
    | undefined;
  if (!account) return null;

  const sessions = db
    .prepare(
      `SELECT session_hash AS sessionHash, created_at AS createdAt
       FROM sessions WHERE account_id = ?
       ORDER BY created_at ASC, session_hash ASC`,
    )
    .all(session.accountId) as Array<{ sessionHash: string; createdAt: number }>;

  const accessSubjects = db
    .prepare(
      `SELECT issuer, subject, created_at AS createdAt
       FROM access_subjects WHERE account_id = ?
       ORDER BY created_at ASC, issuer ASC, subject ASC`,
    )
    .all(session.accountId) as Array<{
    issuer: string;
    subject: string;
    createdAt: number;
  }>;

  return {
    accountId: account.accountId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    sessions,
    accessSubjects,
  };
}

async function erasurePseudonym(accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`erasure:${accountId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `erased:${hex.slice(0, 32)}`;
}

function tableExists(db: RoomDatabase, name: string): boolean {
  return (
    (
      db
        .prepare(
          `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .get(name) as { present: number } | undefined
    )?.present === 1
  );
}

/**
 * Verified self-erasure: the caller is identified only by a valid session
 * token. Sessions are revoked, Access subject bindings are dropped, the
 * account is disabled, and remaining audit identifiers are replaced with a
 * stable pseudonym.
 */
export async function eraseOwnAccount(
  db: RoomDatabase,
  token: unknown,
  now = Date.now(),
): Promise<(AuthorizationChange & { roomIds: string[] }) | null> {
  const session = await validateSession(db, token, now);
  if (!session) return null;
  const accountId = session.accountId;
  const pseudonym = await erasurePseudonym(accountId);

  return db.transaction(() => {
    const roomIds = listOwnedRooms(db, accountId).map((room) => room.roomId);
    db.prepare(`DELETE FROM account_rooms WHERE account_id = ?`).run(accountId);

    const disabled = disableAccount(
      db,
      accountId,
      { actor: pseudonym, reason: 'account erasure' },
      now,
    );
    if (!disabled) return null;

    db.prepare(`DELETE FROM access_subjects WHERE account_id = ?`).run(accountId);

    if (tableExists(db, 'authorization_audit')) {
      db.prepare(
        `UPDATE authorization_audit
         SET account_id = ?, actor = ?
         WHERE account_id = ?`,
      ).run(pseudonym, pseudonym, accountId);
    }

    return { ...disabled, roomIds };
  })();
}

export async function logoutSession(
  db: RoomDatabase,
  token: unknown,
  now = Date.now(),
): Promise<boolean> {
  if (!isSessionToken(token)) return false;
  const sessionHash = await hashSessionToken(token);
  return db.transaction(() => {
    const row = findSessionAuthority(db, sessionHash);
    if (!row || row.revokedAt !== null) return false;
    revokeRow(db, row, now);
    return true;
  })();
}

function changeAccountAuthorization(
  db: RoomDatabase,
  accountId: string,
  state: AccountState | null,
  advanceEpoch: boolean,
  now: number,
  audit: AuditContext & { action: 'revoke-all' | 'disable' | 'enable' },
): AuthorizationChange | null {
  return db.transaction(() => {
    const account = currentAccount(db, accountId);
    if (!account) return null;
    const nextEpoch = account.authorizationEpoch + (advanceEpoch ? 1 : 0);
    const nextState = state ?? account.state;
    db.prepare(
      `UPDATE accounts
       SET state = ?, authorization_epoch = ?, updated_at = ?
       WHERE account_id = ?`,
    ).run(nextState, nextEpoch, now, accountId);
    const revokedSessions = db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
         WHERE account_id = ? AND revoked_at IS NULL`,
      )
      .run(now, accountId).changes;

    // Written inside the same transaction: an authorization change is never
    // visible without the record of who made it and why.
    recordAuthorizationAudit(db, {
      accountId,
      action: audit.action,
      actor: audit.actor,
      reason: audit.reason,
      previousState: account.state,
      nextState,
      previousEpoch: account.authorizationEpoch,
      nextEpoch,
      revokedSessions,
      createdAt: now,
    });

    return {
      accountId,
      authorizationEpoch: nextEpoch,
      state: nextState,
      revokedSessions,
    };
  })();
}

export function revokeAllSessions(
  db: RoomDatabase,
  accountId: string,
  audit: AuditContext,
  now = Date.now(),
): AuthorizationChange | null {
  return changeAccountAuthorization(db, accountId, null, true, now, {
    ...audit,
    action: 'revoke-all',
  });
}

export function disableAccount(
  db: RoomDatabase,
  accountId: string,
  audit: AuditContext,
  now = Date.now(),
): AuthorizationChange | null {
  return changeAccountAuthorization(db, accountId, 'disabled', true, now, {
    ...audit,
    action: 'disable',
  });
}

export function enableAccount(
  db: RoomDatabase,
  accountId: string,
  audit: AuditContext,
  now = Date.now(),
): AuthorizationChange | null {
  return changeAccountAuthorization(db, accountId, 'active', false, now, {
    ...audit,
    action: 'enable',
  });
}

export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader || cookieHeader.length > MAX_COOKIE_HEADER_LENGTH) return null;
  const values: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values.length === 1 && isSessionToken(values[0]) ? values[0] : null;
}

export function sessionCookie(session: IssuedSession): string {
  const maxAge = Math.max(
    0,
    Math.floor((session.absoluteExpiresAt - session.createdAt) / 1_000),
  );
  return `${SESSION_COOKIE_NAME}=${session.token}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
