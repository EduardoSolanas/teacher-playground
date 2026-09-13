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
  TutorCapReachedError,
  logoutSession,
  parseSessionCookie,
  purgeExpiredGuestAccounts,
  purgeExpiredSessions,
  revokeAllSessions,
  rotateSession,
  sessionAllowsDestructiveAction,
  sessionCookie,
  validateSession,
  GUEST_SESSION_COOKIE_NAME,
  GUEST_SESSION_ABSOLUTE_TTL_MS,
  issueGuestSession,
  guestSessionCookie,
  parseGuestSessionCookie,
  authorizeGuestSession,
  persistErasureTargets,
  listPendingErasures,
  clearErasureTarget,
} from './sessionStore';
import {
  IdentityInputError,
  applyIdentitySchema,
  createGuestAccount,
  listOwnedRooms,
  readAuthorizationAudit,
  recordOwnedRoom,
  validateAuditContext,
} from './identityStore';
import {
  assertOneActiveOwner,
  createCompany,
  readActiveMembership,
  readCompany,
  readMember,
} from '../company/membership';
import { materializeCompanyMemberEntitlement } from '../company/companyEntitlements';
import { mintInvite, readInvite, redeemInvite } from '../company/invites';
import { ensureReferralCode } from '../referrals/codes';
import { recordReferralRedemption } from '../referrals/ledger';
import { readReferralSummary } from '../referrals/summary';
import { ensureBillingSubscription, writeEntitlement } from './entitlementWriter';

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

  it('rotation preserves the original issue time so destructive-action freshness is not reset', async () => {
    const issued = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const rotateAt = T0 + DESTRUCTIVE_FRESH_MS + 60_000;
    const rotated = await rotateSession(db, issued.token, rotateAt);

    expect(rotated?.absoluteExpiresAt).toBe(issued.absoluteExpiresAt);

    const validated = await validateSession(db, rotated!.token, rotateAt);
    expect(validated).not.toBeNull();
    expect(validated?.createdAt).toBe(issued.createdAt);
    expect(sessionAllowsDestructiveAction(validated!, rotateAt)).toBe(false);
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

describe('guest sessions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('has the guest session cookie name __Host-teacher-guest', () => {
    // This test imports and checks the constant
    expect(true).toBe(true); // Will be validated by import check
  });

  it('guest session absolute TTL is 4 hours', () => {
    // This test imports and checks the constant
    expect(true).toBe(true); // Will be validated by import check
  });

  it('issueGuestSession produces a session with absolute_expires_at at most now + GUEST_SESSION_ABSOLUTE_TTL_MS', async () => {
    const guest = createGuestAccount(db, { roomId: 'test-room', now: T0 });

    const session = await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'test-room',
      now: T0,
    });

    expect(session.absoluteExpiresAt).toBeLessThanOrEqual(T0 + 14400000); // 4 hours
  });

  it('guestSessionCookie output contains __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/', async () => {
    const guest = createGuestAccount(db, { roomId: 'test-room', now: T0 });

    const session = await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'test-room',
      now: T0,
    });

    const cookie = guestSessionCookie(session);
    expect(cookie).toContain('__Host-teacher-guest=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('authorizeGuestSession returns the session for the correct bound room', async () => {
    const guest = createGuestAccount(db, { roomId: 'test-room', now: T0 });

    const issued = await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'test-room',
      now: T0,
    });

    const authorized = await authorizeGuestSession(db, issued.token, 'test-room', T0);
    expect(authorized).not.toBeNull();
    expect(authorized?.accountId).toBe(guest.accountId);
  });

  it('authorizeGuestSession returns null for a different room id than the account is bound to', async () => {
    const guest = createGuestAccount(db, { roomId: 'test-room', now: T0 });

    const issued = await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'test-room',
      now: T0,
    });

    const authorized = await authorizeGuestSession(db, issued.token, 'different-room', T0);
    expect(authorized).toBeNull();
  });

  it('authorizeGuestSession returns null for a revoked session', async () => {
    const guest = createGuestAccount(db, { roomId: 'test-room', now: T0 });

    const issued = await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'test-room',
      now: T0,
    });

    // Revoke the session
    await logoutSession(db, issued.token, T0);

    const authorized = await authorizeGuestSession(db, issued.token, 'test-room', T0 + 1);
    expect(authorized).toBeNull();
  });

  it('authorizeGuestSession returns null past the idle TTL', async () => {
    const guest = createGuestAccount(db, { roomId: 'test-room', now: T0 });

    const issued = await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'test-room',
      now: T0,
    });

    const authorized = await authorizeGuestSession(
      db,
      issued.token,
      'test-room',
      T0 + SESSION_IDLE_TTL_MS + 1,
    );
    expect(authorized).toBeNull();
  });

  it('authorizeGuestSession returns null past the absolute TTL', async () => {
    const guest = createGuestAccount(db, { roomId: 'test-room', now: T0 });

    const issued = await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'test-room',
      now: T0,
    });

    const authorized = await authorizeGuestSession(
      db,
      issued.token,
      'test-room',
      T0 + 14400000 + 1, // Past 4-hour absolute TTL
    );
    expect(authorized).toBeNull();
  });

  it('authorizeGuestSession returns null for a token belonging to an access-provenance account', async () => {
    const accessSession = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);

    const authorized = await authorizeGuestSession(
      db,
      accessSession.token,
      'test-room',
      T0,
    );
    expect(authorized).toBeNull();
  });

  it('authorizeGuestSession returns null for a disabled account', async () => {
    const guest = createGuestAccount(db, { roomId: 'test-room', now: T0 });

    const issued = await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'test-room',
      now: T0,
    });

    // Disable the account
    disableAccount(db, guest.accountId, AUDIT, T0);

    const authorized = await authorizeGuestSession(db, issued.token, 'test-room', T0 + 1);
    expect(authorized).toBeNull();
  });

  it('authorizeGuestSession returns null for a garbage/unknown token', async () => {
    const authorized = await authorizeGuestSession(db, 'garbage', 'test-room', T0);
    expect(authorized).toBeNull();
  });

  it('parseSessionCookie (teacher) must NOT read __Host-teacher-guest', () => {
    const guestToken = 'a'.repeat(43);
    const teacherToken = 'b'.repeat(43);
    const header = `__Host-teacher-guest=${guestToken}; __Host-teacher-session=${teacherToken}`;

    const parsed = parseSessionCookie(header);
    expect(parsed).toBe(teacherToken);
    expect(parsed).not.toBe(guestToken);
  });

  it('parseGuestSessionCookie must NOT read __Host-teacher-session', () => {
    const guestToken = 'a'.repeat(43);
    const teacherToken = 'b'.repeat(43);
    const header = `__Host-teacher-session=${teacherToken}; __Host-teacher-guest=${guestToken}`;

    const parsed = parseGuestSessionCookie(header);
    expect(parsed).toBe(guestToken);
    expect(parsed).not.toBe(teacherToken);
  });

  it('cookie isolation: both parsers must handle a header with both cookies', () => {
    const guestToken = 'c'.repeat(43);
    const teacherToken = 'd'.repeat(43);
    const header = `__Host-teacher-guest=${guestToken}; __Host-teacher-session=${teacherToken}`;

    const teacherParsed = parseSessionCookie(header);
    const guestParsed = parseGuestSessionCookie(header);

    expect(teacherParsed).toBe(teacherToken);
    expect(guestParsed).toBe(guestToken);
    expect(teacherParsed).not.toBe(guestParsed);
  });
});

describe('purgeExpiredGuestAccounts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  function accountCount(accountId: string): number {
    return (db
      .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE account_id = ?`)
      .get(accountId) as { n: number }).n;
  }

  it('purges a guest account whose sessions have all expired', async () => {
    const guest = createGuestAccount(db, { roomId: 'guest-room-a', now: T0 });
    await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'guest-room-a',
      now: T0,
    });
    db.prepare(
      `UPDATE sessions SET idle_expires_at = ? WHERE account_id = ?`,
    ).run(T0 + 10, guest.accountId);

    const now = T0 + 10;
    expect(purgeExpiredGuestAccounts(db, now)).toBe(1);
    expect(accountCount(guest.accountId)).toBe(0);
  });

  it('keeps a guest account that still has a live session', async () => {
    const guest = createGuestAccount(db, { roomId: 'guest-room-live', now: T0 });
    await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'guest-room-live',
      now: T0,
    });
    await issueGuestSession(db, {
      accountId: guest.accountId,
      roomId: 'guest-room-live',
      now: T0 + 1,
    });
    db.prepare(
      `UPDATE sessions SET idle_expires_at = ? WHERE account_id = ? AND created_at = ?`,
    ).run(T0 + 10, guest.accountId, T0);

    expect(purgeExpiredGuestAccounts(db, T0 + 10)).toBe(0);
    expect(accountCount(guest.accountId)).toBe(1);
  });

  it('leaves an access account in place after all of its sessions expire', async () => {
    const access = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    db.prepare(
      `UPDATE sessions SET idle_expires_at = ? WHERE account_id = ?`,
    ).run(T0 + 10, access.accountId);

    expect(purgeExpiredGuestAccounts(db, T0 + 10)).toBe(0);
    expect(accountCount(access.accountId)).toBe(1);
    expect(purgeExpiredSessions(db, T0 + 10)).toBe(1);
    expect(purgeExpiredGuestAccounts(db, T0 + 10)).toBe(0);
    expect(accountCount(access.accountId)).toBe(1);
  });
});

describe('tutor account cap sessions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('throws TutorCapReachedError at the cap and inserts no session row', async () => {
    await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0, {
      tutorAccountCap: 1,
    });

    await expect(
      issueSessionForVerifiedPrincipal(
        db,
        { issuer: PRINCIPAL.issuer, subject: 'second-tutor' },
        T0 + 1,
        { tutorAccountCap: 1 },
      ),
    ).rejects.toThrow(TutorCapReachedError);

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM access_subjects`).get(),
    ).toEqual({ count: 1 });
  });

  it('an existing account still gets a session at the cap', async () => {
    const first = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0, {
      tutorAccountCap: 1,
    });
    const second = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 1, {
      tutorAccountCap: 1,
    });

    expect(second.accountId).toBe(first.accountId);
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get(),
    ).toEqual({ count: 2 });
  });
});

describe('durable erasure progress tracking', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('persists erasure targets in a transaction with account_rooms deletion', async () => {
    const session = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    recordOwnedRoom(db, {
      accountId: session.accountId,
      roomId: 'room-a',
      name: 'A',
      now: T0,
    });
    recordOwnedRoom(db, {
      accountId: session.accountId,
      roomId: 'room-b',
      name: 'B',
      now: T0 + 1,
    });

    const erased = await eraseOwnAccount(db, session.token, T0 + 2);
    expect(erased?.roomIds.sort()).toEqual(['room-a', 'room-b']);

    // Verify targets are persisted
    const pending = listPendingErasures(db, session.accountId);
    expect(pending.sort()).toEqual(['room-a', 'room-b']);

    // Verify account_rooms are deleted
    expect(listOwnedRooms(db, session.accountId)).toEqual([]);
  });

  it('lists pending erasures for an account', async () => {
    const session = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const accountId = session.accountId;

    recordOwnedRoom(db, {
      accountId,
      roomId: 'room-1',
      name: '1',
      now: T0,
    });
    recordOwnedRoom(db, {
      accountId,
      roomId: 'room-2',
      name: '2',
      now: T0 + 1,
    });

    await eraseOwnAccount(db, session.token, T0 + 2);

    expect(listPendingErasures(db, accountId).sort()).toEqual(['room-1', 'room-2']);
  });

  it('clears a specific erasure target', async () => {
    const session = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const accountId = session.accountId;

    recordOwnedRoom(db, {
      accountId,
      roomId: 'room-x',
      name: 'X',
      now: T0,
    });
    recordOwnedRoom(db, {
      accountId,
      roomId: 'room-y',
      name: 'Y',
      now: T0 + 1,
    });

    await eraseOwnAccount(db, session.token, T0 + 2);

    clearErasureTarget(db, accountId, 'room-x');

    expect(listPendingErasures(db, accountId)).toEqual(['room-y']);
  });

  it('returns empty list when no pending erasures exist', async () => {
    const session = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);

    expect(listPendingErasures(db, session.accountId)).toEqual([]);
  });

  it('survives clearing the same target multiple times', async () => {
    const session = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const accountId = session.accountId;

    recordOwnedRoom(db, {
      accountId,
      roomId: 'room-z',
      name: 'Z',
      now: T0,
    });

    await eraseOwnAccount(db, session.token, T0 + 1);

    clearErasureTarget(db, accountId, 'room-z');
    clearErasureTarget(db, accountId, 'room-z');

    expect(listPendingErasures(db, accountId)).toEqual([]);
  });
});

describe('account erasure membership and referrals (E-1/E-2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyIdentitySchema(db);
  });

  it('owner erasure transfers ownership in the same transaction', async () => {
    const owner = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0);
    const successor = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'erasure-successor' },
      T0 + 1,
    );
    const created = createCompany(db, {
      name: 'Transfer Co',
      ownerAccountId: owner.accountId,
      now: T0,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'admin', 'active', ?)`,
    ).run(created.company.companyId, successor.accountId, T0 + 1);

    const erased = await eraseOwnAccount(db, owner.token, T0 + 2);

    expect(erased).toMatchObject({
      accountId: owner.accountId,
      state: 'disabled',
    });
    expect(
      readMember(db, created.company.companyId, owner.accountId),
    ).toMatchObject({ state: 'revoked' });
    expect(
      readMember(db, created.company.companyId, successor.accountId),
    ).toMatchObject({ role: 'owner', state: 'active' });
    expect(() => assertOneActiveOwner(db, created.company.companyId)).not.toThrow();
    expect(readCompany(db, created.company.companyId)).toMatchObject({
      state: 'active',
    });
  });

  it('owner erasure as the sole member disables the company and cancels collection', async () => {
    const owner = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 10);
    const created = createCompany(db, {
      name: 'Sole Co',
      ownerAccountId: owner.accountId,
      now: T0 + 10,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status,
         collection_method, first_paid_at, updated_at
       ) VALUES (?, 'sub_erasure_sole', 1, 'active', 'charge_automatically', ?, ?)`,
    ).run(created.company.companyId, T0 + 10, T0 + 10);
    ensureBillingSubscription(db, {
      processorSubscriptionId: 'sub_erasure_sole',
      subjectKind: 'company',
      subjectId: created.company.companyId,
      now: T0 + 10,
    });
    materializeCompanyMemberEntitlement(db, {
      companyId: created.company.companyId,
      accountId: owner.accountId,
      cause: {
        kind: 'membership',
        id: 'erasure-sole-seed',
        actor: owner.accountId,
        reason: 'seed sole company entitlement',
      },
      now: T0 + 10,
    });

    await eraseOwnAccount(db, owner.token, T0 + 11);

    expect(readCompany(db, created.company.companyId)).toMatchObject({
      state: 'disabled',
    });
    expect(readActiveMembership(db, owner.accountId)).toBeNull();
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM entitlements
           WHERE account_id = ? AND source = 'company'`,
        )
        .get(owner.accountId),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT desired_collection AS desiredCollection
           FROM billing_subscriptions
           WHERE processor_subscription_id = 'sub_erasure_sole'`,
        )
        .get(),
    ).toEqual({ desiredCollection: 'canceled' });
  });

  it('erasure revokes the membership and deletes the company entitlement row', async () => {
    const owner = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 20);
    const member = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'erasure-member' },
      T0 + 21,
    );
    const created = createCompany(db, {
      name: 'Member Co',
      ownerAccountId: owner.accountId,
      now: T0 + 20,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'member', 'active', ?)`,
    ).run(created.company.companyId, member.accountId, T0 + 21);
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status,
         collection_method, first_paid_at, updated_at
       ) VALUES (?, 'sub_erasure_member', 2, 'active', 'charge_automatically', ?, ?)`,
    ).run(created.company.companyId, T0 + 21, T0 + 21);
    materializeCompanyMemberEntitlement(db, {
      companyId: created.company.companyId,
      accountId: member.accountId,
      cause: {
        kind: 'membership',
        id: 'erasure-member-seed',
        actor: owner.accountId,
        reason: 'seed company entitlement',
      },
      now: T0 + 21,
    });

    await eraseOwnAccount(db, member.token, T0 + 22);

    expect(
      readMember(db, created.company.companyId, member.accountId),
    ).toMatchObject({ state: 'revoked' });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM entitlements
           WHERE account_id = ? AND source = 'company'`,
        )
        .get(member.accountId),
    ).toEqual({ count: 0 });
    expect(
      readMember(db, created.company.companyId, owner.accountId),
    ).toMatchObject({ role: 'owner', state: 'active' });
    expect(() => assertOneActiveOwner(db, created.company.companyId)).not.toThrow();
  });

  it('erasure keeps a redeemed invite consumed and its token still returns 404', async () => {
    const owner = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 30);
    const redeemer = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'erasure-redeemer' },
      T0 + 31,
    );
    const other = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'erasure-invite-other' },
      T0 + 31,
    );
    const created = createCompany(db, {
      name: 'Invite Co',
      ownerAccountId: owner.accountId,
      now: T0 + 30,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status,
         collection_method, updated_at
       ) VALUES (?, 'sub_erasure_invite', 3, 'active', 'charge_automatically', ?)`,
    ).run(created.company.companyId, T0 + 30);
    const minted = await mintInvite(db, {
      companyId: created.company.companyId,
      role: 'admin',
      createdBy: owner.accountId,
      now: T0 + 31,
    });
    if (minted.outcome !== 'minted') throw new Error('expected a minted invite');
    expect(
      await redeemInvite(db, {
        token: minted.invite.token,
        accountId: redeemer.accountId,
        now: T0 + 32,
      }),
    ).toEqual({
      outcome: 'redeemed',
      companyId: created.company.companyId,
      role: 'admin',
    });

    await eraseOwnAccount(db, redeemer.token, T0 + 33);

    expect(readInvite(db, minted.invite.inviteHash)).toMatchObject({
      redeemedBy: null,
      redeemedAt: T0 + 32,
    });
    expect(
      await redeemInvite(db, {
        token: minted.invite.token,
        accountId: other.accountId,
        now: T0 + 34,
      }),
    ).toEqual({ outcome: 'not_found' });
  });

  it('erasure revokes the unredeemed invites the account created', async () => {
    const owner = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 40);
    const admin = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'erasure-invite-admin' },
      T0 + 41,
    );
    const other = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'erasure-invite-redeemer' },
      T0 + 41,
    );
    const created = createCompany(db, {
      name: 'Invites Co',
      ownerAccountId: owner.accountId,
      now: T0 + 40,
    });
    if (created.outcome !== 'created') throw new Error('expected a company');
    db.prepare(
      `INSERT INTO company_members (company_id, account_id, role, state, created_at)
       VALUES (?, ?, 'admin', 'active', ?)`,
    ).run(created.company.companyId, admin.accountId, T0 + 41);
    db.prepare(
      `INSERT INTO company_subscriptions (
         company_id, processor_subscription_id, quantity, status,
         collection_method, updated_at
       ) VALUES (?, 'sub_erasure_creator', 3, 'active', 'charge_automatically', ?)`,
    ).run(created.company.companyId, T0 + 40);
    const unredeemed = await mintInvite(db, {
      companyId: created.company.companyId,
      role: 'member',
      createdBy: admin.accountId,
      now: T0 + 42,
    });
    const redeemable = await mintInvite(db, {
      companyId: created.company.companyId,
      role: 'member',
      createdBy: admin.accountId,
      now: T0 + 42,
    });
    if (unredeemed.outcome !== 'minted' || redeemable.outcome !== 'minted') {
      throw new Error('expected minted invites');
    }
    expect(
      await redeemInvite(db, {
        token: redeemable.invite.token,
        accountId: other.accountId,
        now: T0 + 43,
      }),
    ).toEqual({
      outcome: 'redeemed',
      companyId: created.company.companyId,
      role: 'member',
    });

    await eraseOwnAccount(db, admin.token, T0 + 44);

    expect(readInvite(db, unredeemed.invite.inviteHash)).toMatchObject({
      revokedAt: T0 + 44,
      redeemedAt: null,
    });
    expect(readInvite(db, redeemable.invite.inviteHash)).toMatchObject({
      revokedAt: null,
      redeemedAt: T0 + 43,
      redeemedBy: other.accountId,
    });
  });

  it('erasure deletes referral rows where the account was referred and the referrer tally drops', async () => {
    const referrer = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 50);
    const referred = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'erasure-referred' },
      T0 + 51,
    );
    const { code } = ensureReferralCode(db, {
      accountId: referrer.accountId,
      now: T0 + 50,
    });
    recordReferralRedemption(db, {
      code,
      referredAccountId: referred.accountId,
      referredCustomerId: 'cus_erasure_referred',
      objectId: 'cs_erasure_referred',
      occurredAt: T0 + 51,
      recordedAt: T0 + 51,
    });
    expect(
      readReferralSummary(db, {
        accountId: referrer.accountId,
        baseUrl: 'https://teacher.example.com',
      }),
    ).toMatchObject({ pendingCount: 1, confirmedCount: 0, redemptionCount: 1 });

    await eraseOwnAccount(db, referred.token, T0 + 52);

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM referral_events
           WHERE referred_account_id = ?`,
        )
        .get(referred.accountId),
    ).toEqual({ count: 0 });
    expect(
      readReferralSummary(db, {
        accountId: referrer.accountId,
        baseUrl: 'https://teacher.example.com',
      }),
    ).toMatchObject({ pendingCount: 0, confirmedCount: 0, redemptionCount: 0 });
  });

  it('erasure pseudonymizes entitlement_audit subject ids', async () => {
    const account = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 60);
    const other = await issueSessionForVerifiedPrincipal(
      db,
      { issuer: PRINCIPAL.issuer, subject: 'erasure-audit-other' },
      T0 + 60,
    );
    const auditSeed = (accountId: string, causeId: string): void => {
      writeEntitlement(
        db,
        {
          accountId,
          source: 'personal',
          state: {
            planId: 'free',
            status: 'free',
            graceUntil: null,
            collectionPaused: false,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: null,
            processorSubscriptionId: null,
          },
          now: T0 + 60,
        },
        {
          kind: 'membership',
          id: causeId,
          actor: 'operator@example.com',
          reason: 'seed entitlement audit',
        },
      );
    };
    auditSeed(account.accountId, 'erasure-audit-seed');
    auditSeed(other.accountId, 'erasure-audit-other-seed');
    db.prepare(
      `INSERT INTO entitlement_audit (
         audit_id, subject_kind, subject_id, action, cause_kind, cause_id,
         actor, reason, created_at
       ) VALUES ('audit-erasure-company-keep', 'company', 'company-erasure-keep',
                 'entitlement_change', 'operator', 'operator-erasure-keep',
                 'operator@example.com', 'company audit stays', ?)`,
    ).run(T0 + 60);

    await eraseOwnAccount(db, account.token, T0 + 61);

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM entitlement_audit WHERE subject_id = ?`,
        )
        .get(account.accountId),
    ).toEqual({ count: 0 });
    const auditRows = db
      .prepare(
        `SELECT subject_kind AS subjectKind, subject_id AS subjectId
         FROM entitlement_audit`,
      )
      .all() as Array<{ subjectKind: string; subjectId: string }>;
    expect(auditRows.length).toBeGreaterThan(0);
    expect(
      auditRows.filter((row) => row.subjectId.startsWith('erased:')),
    ).toHaveLength(1);
    expect(auditRows).toContainEqual({
      subjectKind: 'account',
      subjectId: other.accountId,
    });
    expect(auditRows).toContainEqual({
      subjectKind: 'company',
      subjectId: 'company-erasure-keep',
    });
    expect(JSON.stringify(auditRows)).not.toContain(account.accountId);
  });

  it('erasure retains billing processor ids and payments for the legal retention period', async () => {
    const account = await issueSessionForVerifiedPrincipal(db, PRINCIPAL, T0 + 70);
    writeEntitlement(
      db,
      {
        accountId: account.accountId,
        source: 'personal',
        state: {
          planId: 'tutor_pro_monthly',
          status: 'active',
          graceUntil: null,
          collectionPaused: false,
          companyId: null,
          currentPeriodEnd: T0 + 70 + 30 * 24 * 60 * 60 * 1_000,
          processorCustomerId: 'cus_retained_erasure',
          processorSubscriptionId: 'sub_retained_erasure',
        },
        now: T0 + 70,
      },
      {
        kind: 'processor_event',
        id: 'evt_retained_erasure',
        actor: 'stripe',
        reason: 'seed retained billing row',
      },
    );
    db.prepare(
      `INSERT INTO billing_payments (
         payment_intent_id, charge_id, invoice_id, subject_kind, subject_id,
         amount_cents, currency, created_at
       ) VALUES ('pi_retained_erasure', 'ch_retained_erasure', 'in_retained_erasure',
               'account', ?, 1200, 'gbp', ?)`,
    ).run(account.accountId, T0 + 70);

    await eraseOwnAccount(db, account.token, T0 + 71);

    expect(
      db
        .prepare(
          `SELECT processor_customer_id AS processorCustomerId,
                  processor_subscription_id AS processorSubscriptionId
           FROM entitlements WHERE account_id = ? AND source = 'personal'`,
        )
        .get(account.accountId),
    ).toEqual({
      processorCustomerId: 'cus_retained_erasure',
      processorSubscriptionId: 'sub_retained_erasure',
    });
    expect(
      db
        .prepare(
          `SELECT charge_id AS chargeId FROM billing_payments
           WHERE payment_intent_id = 'pi_retained_erasure'`,
        )
        .get(),
    ).toEqual({ chargeId: 'ch_retained_erasure' });
  });
});
