import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  clearSessionCookie,
  disableAccount,
  enableAccount,
  confirmSession,
  DESTRUCTIVE_FRESH_MS,
  eraseOwnAccount,
  exportOwnAccountData,
  issueSessionForVerifiedPrincipal,
  logoutSession,
  parseSessionCookie,
  purgeExpiredSessions,
  revokeAllSessions,
  rotateSession,
  sessionAllowsDestructiveAction,
  sessionCookie,
  validateSession,
} from './sessionStore';
import {
  IdentityInputError,
  applyIdentitySchema,
  listOwnedRooms,
  readAuthorizationAudit,
  recordOwnedRoom,
  validateAuditContext,
} from './identityStore';

const PRINCIPAL = {
  issuer: 'https://access.example.com',
  subject: 'access-subject-1',
} as const;
const T0 = 1_800_000_000_000;

const AUDIT = { actor: 'operator@example.com', reason: 'security test' };

describe('opaque application session store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('issues unique 256-bit opaque tokens while persisting only SHA-256 hashes', async () => {
    const first = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const second = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 1);

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);
    expect(first.accountId).toBe(second.accountId);
    expect(first.authorizationEpoch).toBe(0);
    expect(first.idleExpiresAt).toBe(T0 + SESSION_IDLE_TTL_MS);
    expect(first.absoluteExpiresAt).toBe(T0 + SESSION_ABSOLUTE_TTL_MS);

    const rows = db
      .prepare(
        `SELECT session_hash AS sessionHash, account_id AS accountId,
                authorization_epoch AS authorizationEpoch
         FROM sessions ORDER BY created_at`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1].sessionHash).toMatch(/^[0-9a-f]{64}$/);
    const expectedFirstHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(first.token),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    expect(rows[0].sessionHash).toBe(expectedFirstHash);
    expect(JSON.stringify(rows)).not.toContain(first.token);
    expect(JSON.stringify(rows)).not.toContain(second.token);
  });

  it('validates active state and epoch and bounds idle touches by interval and absolute expiry', async () => {
    const issued = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);

    const beforeTouch = await validateSession(
      db,
      issued.token,
      T0 + SESSION_TOUCH_INTERVAL_MS - 1,
    );
    expect(beforeTouch).toMatchObject({
      accountId: issued.accountId,
      authorizationEpoch: 0,
      touched: false,
    });
    expect(beforeTouch?.sessionId).toMatch(/^[0-9a-f]{64}$/);
    const expectedHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(issued.token),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    expect(beforeTouch?.sessionId).toBe(expectedHash);
    expect(JSON.stringify(beforeTouch)).not.toContain(issued.token);

    const touchedAt = T0 + SESSION_TOUCH_INTERVAL_MS;
    const afterTouch = await validateSession(db, issued.token, touchedAt);
    expect(afterTouch).toMatchObject({
      accountId: issued.accountId,
      authorizationEpoch: 0,
      touched: true,
      idleExpiresAt: touchedAt + SESSION_IDLE_TTL_MS,
      absoluteExpiresAt: T0 + SESSION_ABSOLUTE_TTL_MS,
    });

    const nearAbsolute = T0 + SESSION_ABSOLUTE_TTL_MS - 1;
    db.prepare(
      `UPDATE sessions
       SET last_seen_at = ?, idle_expires_at = ?
       WHERE account_id = ?`,
    ).run(
      nearAbsolute - SESSION_TOUCH_INTERVAL_MS,
      nearAbsolute + 1,
      issued.accountId,
    );
    const bounded = await validateSession(db, issued.token, nearAbsolute);
    expect(bounded?.idleExpiresAt).toBe(T0 + SESSION_ABSOLUTE_TTL_MS);
  });

  it('fails closed and revokes idle-expired, absolute-expired, stale-epoch, and disabled sessions', async () => {
    for (const [subject, mutate, now] of [
      [
        'idle',
        `UPDATE sessions SET idle_expires_at = ${T0 + 10}`,
        T0 + 10,
      ],
      [
        'absolute',
        `UPDATE sessions SET idle_expires_at = ${T0 + 20}, absolute_expires_at = ${T0 + 20}`,
        T0 + 20,
      ],
      [
        'epoch',
        `UPDATE accounts SET authorization_epoch = authorization_epoch + 1, updated_at = ${T0 + 30}`,
        T0 + 30,
      ],
      [
        'disabled',
        `UPDATE accounts SET state = 'disabled', updated_at = ${T0 + 40}`,
        T0 + 40,
      ],
    ] as const) {
      const issued = await issueSessionForVerifiedPrincipal(
        db,
        { ...PRINCIPAL, subject },
        T0,
      );
      db.exec(mutate);
      expect(await validateSession(db, issued.token, now)).toBeNull();
      expect(
        db
          .prepare(
            `SELECT revoked_at AS revokedAt FROM sessions WHERE account_id = ?`,
          )
          .get(issued.accountId),
      ).toEqual({ revokedAt: now });
    }
  });

  it('rotates atomically, invalidates the old token, and logs out the replacement', async () => {
    const issued = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const rotated = await rotateSession(db, issued.token, T0 + 1_000);

    expect(rotated?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated?.token).not.toBe(issued.token);
    expect(await validateSession(db, issued.token, T0 + 1_001)).toBeNull();
    expect(await validateSession(db, rotated!.token, T0 + 1_001)).not.toBeNull();
    expect(await logoutSession(db, rotated!.token, T0 + 2_000)).toBe(true);
    expect(await validateSession(db, rotated!.token, T0 + 2_001)).toBeNull();
    expect(await logoutSession(db, rotated!.token, T0 + 2_002)).toBe(false);
  });

  it('rotation preserves the original absolute deadline and cookie lifetime', async () => {
    const issued = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const rotateAt = issued.absoluteExpiresAt - 60_000;
    db.prepare(
      `UPDATE sessions SET last_seen_at = ?, idle_expires_at = ?
       WHERE account_id = ?`,
    ).run(rotateAt - 1, issued.absoluteExpiresAt, issued.accountId);

    const rotated = await rotateSession(db, issued.token, rotateAt);
    expect(rotated?.absoluteExpiresAt).toBe(issued.absoluteExpiresAt);
    expect(rotated?.idleExpiresAt).toBe(issued.absoluteExpiresAt);
    expect(sessionCookie(rotated!)).toContain('Max-Age=60');
    expect(
      await validateSession(db, rotated!.token, issued.absoluteExpiresAt),
    ).toBeNull();
  });

  it('revoke-all and disable atomically advance the epoch and invalidate every session', async () => {
    const one = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const two = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 1);

    expect(revokeAllSessions(db, one.accountId, AUDIT, T0 + 100)).toEqual({
      accountId: one.accountId,
      authorizationEpoch: 1,
      state: 'active',
      revokedSessions: 2,
    });
    expect(await validateSession(db, one.token, T0 + 101)).toBeNull();
    expect(await validateSession(db, two.token, T0 + 101)).toBeNull();

    const three = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 200);
    expect(three.authorizationEpoch).toBe(1);
    expect(disableAccount(db, one.accountId, AUDIT, T0 + 300)).toEqual({
      accountId: one.accountId,
      authorizationEpoch: 2,
      state: 'disabled',
      revokedSessions: 1,
    });
    expect(await validateSession(db, three.token, T0 + 301)).toBeNull();
    await expect(
      issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 302),
    ).rejects.toThrow('Unauthorized');

    expect(enableAccount(db, one.accountId, AUDIT, T0 + 400)).toEqual({
      accountId: one.accountId,
      authorizationEpoch: 2,
      state: 'active',
      revokedSessions: 0,
    });
    expect(await validateSession(db, three.token, T0 + 401)).toBeNull();
    const four = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 500);
    expect(four.authorizationEpoch).toBe(2);
  });

  it('uses an exact hardened __Host- cookie and clears it with the same protections', async () => {
    const issued = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(sessionCookie(issued)).toBe(
      `${SESSION_COOKIE_NAME}=${issued.token}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`,
    );
    expect(sessionCookie(issued)).not.toContain('Domain=');
    expect(clearSessionCookie()).toBe(
      `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
  });

  it('rejects malformed, unbounded, and duplicate cookie/token input without hashing it', async () => {
    for (const token of [
      '',
      'short',
      'a'.repeat(42),
      'a'.repeat(44),
      'a'.repeat(10_000),
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}!`,
    ]) {
      expect(await validateSession(db, token, T0)).toBeNull();
      expect(await rotateSession(db, token, T0)).toBeNull();
      expect(await logoutSession(db, token, T0)).toBe(false);
    }

    const valid = 'a'.repeat(43);
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=${valid}`)).toBe(valid);
    expect(
      parseSessionCookie(`other=x; ${SESSION_COOKIE_NAME}=${valid}; final=y`),
    ).toBe(valid);
    expect(
      parseSessionCookie(
        `${SESSION_COOKIE_NAME}=${valid}; ${SESSION_COOKIE_NAME}=${'b'.repeat(43)}`,
      ),
    ).toBeNull();
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=short`)).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });

  it('exposes session createdAt on validation and records confirm timestamps', async () => {
    const issued = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const current = await validateSession(db, issued.token, T0);
    expect(current).toMatchObject({
      createdAt: T0,
      confirmedAt: null,
    });

    const confirmed = await confirmSession(
      db,
      issued.token,
      T0 + DESTRUCTIVE_FRESH_MS + 1,
    );
    expect(confirmed).toMatchObject({
      createdAt: T0,
      confirmedAt: T0 + DESTRUCTIVE_FRESH_MS + 1,
    });
  });

  it('exports only the caller account and session hashes, never raw tokens or another account', async () => {
    const mine = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const other = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: 'https://access.example.com', subject: 'other-subject' },
      T0 + 1,
    );
    const expectedHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(mine.token),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');

    expect(await exportOwnAccountData(db, 'a'.repeat(43), T0)).toBeNull();
    const exported = await exportOwnAccountData(db, mine.token, T0);
    const accountRow = db
      .prepare(
        `SELECT created_at AS createdAt FROM accounts WHERE account_id = ?`,
      )
      .get(mine.accountId) as { createdAt: number };
    const subjectRow = db
      .prepare(
        `SELECT created_at AS createdAt FROM access_subjects WHERE account_id = ?`,
      )
      .get(mine.accountId) as { createdAt: number };
    expect(exported).toMatchObject({
      accountId: mine.accountId,
      createdAt: accountRow.createdAt,
    });
    expect(exported?.accessSubjects).toEqual([
      {
        issuer: PRINCIPAL.issuer,
        subject: PRINCIPAL.subject,
        createdAt: subjectRow.createdAt,
      },
    ]);
    expect(exported?.sessions).toEqual([
      expect.objectContaining({
        sessionHash: expectedHash,
        createdAt: T0,
      }),
    ]);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(mine.token);
    expect(serialized).not.toContain(other.token);
    expect(serialized).not.toContain(other.accountId);
    expect(exported?.accessSubjects.some((row) => row.subject === 'other-subject')).toBe(
      false,
    );
  });

  it('erases the caller account from a session token and leaves other accounts intact', async () => {
    const mine = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const secondMine = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 1);
    const other = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'other-erase-subject' },
      T0 + 2,
    );
    disableAccount(db, mine.accountId, AUDIT, T0 + 3);
    enableAccount(db, mine.accountId, AUDIT, T0 + 4);
    const current = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 5);

    expect(await eraseOwnAccount(db, 'a'.repeat(43), T0 + 6)).toBeNull();

    const erased = await eraseOwnAccount(db, current.token, T0 + 6);
    expect(erased).toMatchObject({
      accountId: mine.accountId,
      state: 'disabled',
    });

    expect(await validateSession(db, mine.token, T0 + 6)).toBeNull();
    expect(await validateSession(db, secondMine.token, T0 + 6)).toBeNull();
    expect(await validateSession(db, current.token, T0 + 6)).toBeNull();
    expect(await validateSession(db, other.token, T0 + 6)).not.toBeNull();

    const mineSubjects = db
      .prepare(`SELECT COUNT(*) AS count FROM access_subjects WHERE account_id = ?`)
      .get(mine.accountId) as { count: number };
    const otherSubjects = db
      .prepare(`SELECT COUNT(*) AS count FROM access_subjects WHERE account_id = ?`)
      .get(other.accountId) as { count: number };
    expect(mineSubjects.count).toBe(0);
    expect(otherSubjects.count).toBe(1);

    const account = db
      .prepare(`SELECT state FROM accounts WHERE account_id = ?`)
      .get(mine.accountId) as { state: string };
    expect(account.state).toBe('disabled');

    const remainingAudit = readAuthorizationAudit(db, mine.accountId);
    expect(remainingAudit).toHaveLength(0);
    const auditRows = db
      .prepare(
        `SELECT account_id AS accountId, actor FROM authorization_audit`,
      )
      .all() as Array<{ accountId: string; actor: string }>;
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows.every((row) => row.accountId.startsWith('erased:'))).toBe(true);
    expect(auditRows.every((row) => row.actor.startsWith('erased:'))).toBe(true);
    expect(auditRows.some((row) => row.accountId === mine.accountId)).toBe(false);
    expect(JSON.stringify(auditRows)).not.toContain(AUDIT.actor);
    expect(JSON.stringify(auditRows)).not.toContain(other.accountId);
  });

  it('returns owned room ids and drops account_rooms without touching another account', async () => {
    const mine = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const other = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'other-rooms-erase' },
      T0 + 1,
    );
    recordOwnedRoom(db, {
      accountId: mine.accountId,
      roomId: 'owned-a',
      name: 'A',
      now: T0,
    });
    recordOwnedRoom(db, {
      accountId: mine.accountId,
      roomId: 'owned-b',
      name: 'B',
      now: T0 + 1,
    });
    recordOwnedRoom(db, {
      accountId: other.accountId,
      roomId: 'other-owned',
      name: 'Keep',
      now: T0 + 2,
    });

    const erased = await eraseOwnAccount(db, mine.token, T0 + 3);
    expect(erased?.roomIds.sort()).toEqual(['owned-a', 'owned-b']);
    expect(listOwnedRooms(db, mine.accountId)).toEqual([]);
    expect(listOwnedRooms(db, other.accountId)).toEqual([
      expect.objectContaining({ roomId: 'other-owned' }),
    ]);
  });

  it('deletes idle-expired sessions and leaves the caller and other accounts intact', async () => {
    const expired = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const stillValid = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 1);
    const other = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'other-purge-subject' },
      T0 + 2,
    );

    db.prepare(
      `UPDATE sessions SET idle_expires_at = ? WHERE account_id = ? AND created_at = ?`,
    ).run(T0 + 10, expired.accountId, T0);

    const now = T0 + 10;
    expect(purgeExpiredSessions(db, now)).toBe(1);

    const remaining = db
      .prepare(
        `SELECT created_at AS createdAt FROM sessions ORDER BY created_at`,
      )
      .all() as Array<{ createdAt: number }>;
    expect(remaining.map((row) => row.createdAt)).toEqual([T0 + 1, T0 + 2]);
    expect(await validateSession(db, expired.token, now)).toBeNull();
    expect(await validateSession(db, stillValid.token, now)).not.toBeNull();
    expect(await validateSession(db, other.token, now)).not.toBeNull();
  });

  it('allows destructive actions only while the session or step-up is fresh', async () => {
    const issued = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const fresh = await validateSession(db, issued.token, T0);
    expect(sessionAllowsDestructiveAction(fresh!, T0 + DESTRUCTIVE_FRESH_MS - 1)).toBe(true);
    expect(sessionAllowsDestructiveAction(fresh!, T0 + DESTRUCTIVE_FRESH_MS)).toBe(false);

    const aged = T0 + DESTRUCTIVE_FRESH_MS + 60_000;
    expect(sessionAllowsDestructiveAction(
      { ...fresh!, createdAt: T0, confirmedAt: null },
      aged,
    )).toBe(false);

    const stepped = await confirmSession(db, issued.token, aged);
    expect(sessionAllowsDestructiveAction(stepped!, aged)).toBe(true);
    expect(sessionAllowsDestructiveAction(stepped!, aged + DESTRUCTIVE_FRESH_MS)).toBe(false);
  });
});

describe('authorization audit trail', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  async function account() {
    return (await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0)).accountId;
  }

  it('records who acted, why, and what changed for every operation', async () => {
    const accountId = await account();

    revokeAllSessions(db, accountId, { actor: 'ops@example.com', reason: 'lost device' }, T0 + 10);
    disableAccount(db, accountId, { actor: 'ops@example.com', reason: 'offboarded' }, T0 + 20);
    enableAccount(db, accountId, { actor: 'admin@example.com', reason: 'returned' }, T0 + 30);

    const audit = readAuthorizationAudit(db, accountId);
    expect(audit).toHaveLength(3);
    expect(audit[0]).toMatchObject({
      action: 'revoke-all',
      actor: 'ops@example.com',
      reason: 'lost device',
      previousState: 'active',
      nextState: 'active',
      previousEpoch: 0,
      nextEpoch: 1,
      revokedSessions: 1,
      createdAt: T0 + 10,
    });
    expect(audit[1]).toMatchObject({
      action: 'disable',
      reason: 'offboarded',
      previousEpoch: 1,
      nextEpoch: 2,
      nextState: 'disabled',
    });
    expect(audit[2]).toMatchObject({
      action: 'enable',
      actor: 'admin@example.com',
      previousState: 'disabled',
      nextState: 'active',
      previousEpoch: 2,
      nextEpoch: 2,
    });
  });

  it('writes no audit row when the account does not exist', () => {
    expect(revokeAllSessions(db, 'no-such-account', AUDIT, T0)).toBeNull();
    expect(readAuthorizationAudit(db, 'no-such-account')).toEqual([]);
  });

  it('keeps the audit row and the authorization change in one transaction', async () => {
    const accountId = await account();
    revokeAllSessions(db, accountId, AUDIT, T0 + 10);

    const epoch = (db
      .prepare(`SELECT authorization_epoch AS epoch FROM accounts WHERE account_id = ?`)
      .get(accountId) as { epoch: number }).epoch;

    // The epoch moved and exactly one record explains it.
    expect(epoch).toBe(1);
    const audit = readAuthorizationAudit(db, accountId);
    expect(audit).toHaveLength(1);
    expect(audit[0].nextEpoch).toBe(epoch);
  });

  it('refuses to store a blank or oversized actor or reason', () => {
    for (const context of [
      { actor: '', reason: 'ok' },
      { actor: '   ', reason: 'ok' },
      { actor: 'ops', reason: '' },
      { actor: 'a'.repeat(257), reason: 'ok' },
      { actor: 'ops', reason: 'r'.repeat(1025) },
    ]) {
      expect(() => validateAuditContext(context)).toThrow(IdentityInputError);
    }

    expect(validateAuditContext({ actor: ' ops ', reason: ' why ' }))
      .toEqual({ actor: 'ops', reason: 'why' });
  });

  it('survives account deletion so the record outlives the account', async () => {
    const accountId = await account();
    revokeAllSessions(db, accountId, AUDIT, T0 + 10);

    db.prepare(`DELETE FROM accounts WHERE account_id = ?`).run(accountId);

    expect(readAuthorizationAudit(db, accountId)).toHaveLength(1);
  });
});
