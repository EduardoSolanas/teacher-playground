import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import {
  GLOBAL_IDENTITY_OBJECT_NAME,
  getIdentityObject,
  type IdentityDO,
} from './IdentityDO';
import {
  DESTRUCTIVE_FRESH_MS,
  SESSION_COOKIE_NAME,
  GUEST_SESSION_COOKIE_NAME,
  clearSessionCookie,
  persistErasureTargets,
  listPendingErasures,
  clearErasureTarget,
} from '../lib/identity/sessionStore';
import { applyIdentitySchema, readAuthorizationAudit } from '../lib/identity/identityStore';
import { writeEntitlement } from '../lib/identity/entitlementWriter';
import { PLAN_CATALOG } from '../lib/plan/catalog';
import type { EffectivePlan } from '../lib/plan/effectivePlan';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: DurableObjectNamespace<IdentityDO>;
      TUTOR_ACCOUNT_CAP: string;
    }
  }
}

const IDENTITY_URL = 'https://identity/subjects/resolve';

function identityStub() {
  return getIdentityObject(env.IDENTITY);
}

function resolveSubject(issuer: string, subject: string): Promise<Response> {
  return identityStub().fetch(IDENTITY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ issuer, subject }),
  });
}

function issueSession(subject: string): Promise<Response> {
  return identityStub().fetch('https://identity/sessions/issue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      issuer: 'https://access.example.com',
      subject,
    }),
  });
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
  return setCookie!.split(';', 1)[0];
}

function sessionRequest(
  path: string,
  cookie: string,
  method = 'GET',
): Promise<Response> {
  return identityStub().fetch(`https://identity${path}`, {
    method,
    headers: { cookie },
  });
}

/**
 * The room-admission form of the plan route: the account must own the room it
 * names. Seeds that ownership on the real table, the way a room creation would.
 */
async function seedOwnedRoom(accountId: string): Promise<string> {
  const roomId = `plan-proof-${crypto.randomUUID().slice(0, 8)}`;
  await runInDurableObject(identityStub(), (instance: IdentityDO) => {
    const now = Date.now();
    instance.db.prepare(
      `INSERT INTO account_rooms (account_id, room_id, role, name, created_at, updated_at)
       VALUES (?, ?, 'owner', NULL, ?, ?)`,
    ).run(accountId, roomId, now, now);
  });
  return roomId;
}

async function planRequest(accountId: string): Promise<Response> {
  const roomId = await seedOwnedRoom(accountId);
  return identityStub().fetch(
    `https://identity/accounts/plan?accountId=${encodeURIComponent(accountId)}&roomId=${encodeURIComponent(roomId)}`,
  );
}

/**
 * Moves one session's idle expiry into the past, on the real row.
 *
 * The schema requires `idle_expires_at > created_at`, and a session issued in
 * the same millisecond as the test's `Date.now() - 1` trips that check instead
 * of expiring the row -- a flake that only fires on a fast runner. Creating the
 * expiry one tick after `created_at` and waiting that tick out is the only
 * shape that satisfies both the schema and "expired now".
 */
async function expireSessionIdleNow(where: {
  accountId?: string;
  sessionHash?: string;
}): Promise<void> {
  await runInDurableObject(identityStub(), async (instance: IdentityDO) => {
    const column = where.accountId !== undefined ? 'account_id' : 'session_hash';
    const value = where.accountId ?? where.sessionHash;
    if (!value) throw new Error('expireSessionIdleNow needs an account or session');
    const row = instance.db
      .prepare(`SELECT created_at AS createdAt FROM sessions WHERE ${column} = ?`)
      .get(value) as { createdAt: number } | undefined;
    if (!row) throw new Error('session not found');
    while (Date.now() <= row.createdAt) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    instance.db
      .prepare(`UPDATE sessions SET idle_expires_at = ? WHERE ${column} = ?`)
      .run(row.createdAt + 1, value);
  });
}

async function changeAccount(
  path: 'revoke-all' | 'disable' | 'enable',
  accountId: string,
): Promise<Response> {
  return identityStub().fetch(`https://identity/accounts/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, actor: 'test-operator', reason: 'automated test' }),
  });
}

describe('singleton IdentityDO on real Durable Object SQLite', () => {
  it('uses one canonical production object name', () => {
    expect(GLOBAL_IDENTITY_OBJECT_NAME).toBe('global');
    expect(identityStub().id.equals(env.IDENTITY.idFromName('global'))).toBe(true);
  });

  it('persists one account for the same exact subject across stub instances', async () => {
    const first = await resolveSubject('https://access.example.com', 'subject-1');
    const second = await resolveSubject('https://access.example.com', 'subject-1');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstBody = await first.json() as { account: { accountId: string } };
    const secondBody = await second.json() as { account: { accountId: string } };
    expect(secondBody.account.accountId).toBe(firstBody.account.accountId);
  });

  it('atomically resolves concurrent first-login requests without orphans', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        resolveSubject('https://access.example.com', 'concurrent-subject'),
      ),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{
        account: { accountId: string };
      }>),
    );

    expect(new Set(bodies.map((body) => body.account.accountId)).size).toBe(1);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);

    const counts = await runInDurableObject(identityStub(), (instance) => ({
      accountsForSubject: instance.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM accounts a
           JOIN access_subjects s ON s.account_id = a.account_id
           WHERE s.issuer = ? AND s.subject = ?`,
        )
        .get('https://access.example.com', 'concurrent-subject'),
      subjects: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM access_subjects
           WHERE issuer = ? AND subject = ?`,
        )
        .get('https://access.example.com', 'concurrent-subject'),
      orphans: instance.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM accounts a
           LEFT JOIN access_subjects s ON s.account_id = a.account_id
           WHERE s.account_id IS NULL`,
        )
        .get(),
    }));
    expect(counts).toEqual({
      accountsForSubject: { count: 1 },
      subjects: { count: 1 },
      orphans: { count: 0 },
    });
  });

  it('keeps different exact issuer-subject pairs separate', async () => {
    const a = await (
      await resolveSubject('https://one.example.com', 'same-subject')
    ).json() as { account: { accountId: string } };
    const b = await (
      await resolveSubject('https://two.example.com', 'same-subject')
    ).json() as { account: { accountId: string } };

    expect(b.account.accountId).not.toBe(a.account.accountId);
  });

  it('enforces session hash, foreign key, and delete cascade in real DO SQLite', async () => {
    const response = await resolveSubject('issuer', 'schema-parity');
    const body = await response.json() as { account: { accountId: string } };

    const result = await runInDurableObject(identityStub(), (instance) => {
      const insertSession = instance.db.prepare(
        `INSERT INTO sessions (
           session_hash, account_id, authorization_epoch, created_at,
           last_seen_at, idle_expires_at, absolute_expires_at
         ) VALUES (?, ?, 0, 100, 100, 150, 200)`,
      );

      expect(() =>
        insertSession.run('Z'.repeat(64), body.account.accountId),
      ).toThrow(/CHECK constraint/);
      expect(() =>
        insertSession.run('b'.repeat(64), 'missing-account'),
      ).toThrow(/FOREIGN KEY/);

      insertSession.run('c'.repeat(64), body.account.accountId);
      instance.db
        .prepare(`DELETE FROM accounts WHERE account_id = ?`)
        .run(body.account.accountId);

      return {
        subjects: instance.db
          .prepare(
            `SELECT COUNT(*) AS count FROM access_subjects WHERE account_id = ?`,
          )
          .get(body.account.accountId),
        sessions: instance.db
          .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE account_id = ?`)
          .get(body.account.accountId),
      };
    });

    expect(result).toEqual({ subjects: { count: 0 }, sessions: { count: 0 } });
  });

  it('rejects wrong methods, paths, media types, and body shapes', async () => {
    const stub = identityStub();
    const [method, path, mediaType, extraField] = await Promise.all([
      stub.fetch(IDENTITY_URL),
      stub.fetch('https://identity/accounts', { method: 'POST' }),
      stub.fetch(IDENTITY_URL, { method: 'POST', body: '{}' }),
      stub.fetch(IDENTITY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'issuer', subject: 'subject', email: 'x@y.test' }),
      }),
    ]);

    expect(method.status).toBe(405);
    expect(path.status).toBe(405);
    expect(mediaType.status).toBe(415);
    expect(extraField.status).toBe(400);
  });

  it('accepts JSON parameters but rejects JSON-like media types', async () => {
    const stub = identityStub();
    const valid = await stub.fetch(IDENTITY_URL, {
      method: 'POST',
      headers: { 'content-type': ' Application/JSON ; charset=utf-8' },
      body: JSON.stringify({ issuer: 'issuer', subject: 'valid-charset' }),
    });
    const jsonp = await stub.fetch(IDENTITY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/jsonp' },
      body: JSON.stringify({ issuer: 'issuer', subject: 'jsonp' }),
    });
    const malicious = await stub.fetch(IDENTITY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json-malicious' },
      body: JSON.stringify({ issuer: 'issuer', subject: 'malicious' }),
    });

    expect(valid.status).toBe(201);
    expect(jsonp.status).toBe(415);
    expect(malicious.status).toBe(415);
  });

  it('does not expose the identity contract through public Worker routing', async () => {
    const response = await SELF.fetch(
      'https://example.com/api/internal/identity/subjects/resolve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'issuer', subject: 'subject' }),
      },
    );

    expect(response.status).toBe(404);
  });

  it('issues, validates, rotates, and logs out a hash-only session through the singleton DO', async () => {
    const issuedResponse = await issueSession('do-lifecycle');
    expect(issuedResponse.status).toBe(201);
    expect(issuedResponse.headers.get('set-cookie')).toMatch(
      new RegExp(
        `^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200$`,
      ),
    );
    const issuedBody = await issuedResponse.json() as {
      accountId: string;
      authorizationEpoch: number;
    };
    expect(issuedBody.authorizationEpoch).toBe(0);
    const firstCookie = cookiePair(issuedResponse);
    const rawToken = firstCookie.split('=', 2)[1];

    const stored = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT session_hash AS sessionHash, account_id AS accountId
           FROM sessions WHERE account_id = ?`,
        )
        .get(issuedBody.accountId) as { sessionHash: string; accountId: string },
    );
    expect(stored).toEqual({
      sessionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      accountId: issuedBody.accountId,
    });
    expect(JSON.stringify(stored)).not.toContain(rawToken);

    const current = await sessionRequest('/sessions/current', firstCookie);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      accountId: issuedBody.accountId,
      authorizationEpoch: 0,
    });

    const rotated = await sessionRequest('/sessions/rotate', firstCookie, 'POST');
    expect(rotated.status).toBe(200);
    const secondCookie = cookiePair(rotated);
    expect(secondCookie).not.toBe(firstCookie);
    expect((await sessionRequest('/sessions/current', firstCookie)).status).toBe(401);
    expect((await sessionRequest('/sessions/current', secondCookie)).status).toBe(200);

    const logout = await sessionRequest('/sessions/logout', secondCookie, 'POST');
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toBe(clearSessionCookie());
    expect((await sessionRequest('/sessions/current', secondCookie)).status).toBe(401);
  });

  it('preserves the original absolute deadline when rotating in the real DO', async () => {
    const issued = await issueSession('do-absolute-rotation');
    const body = await issued.clone().json() as { accountId: string };
    const cookie = cookiePair(issued);
    const originalDeadline = Date.now() + 120_000;
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `UPDATE sessions
           SET idle_expires_at = ?, absolute_expires_at = ?
           WHERE account_id = ? AND revoked_at IS NULL`,
        )
        .run(originalDeadline, originalDeadline, body.accountId);
    });

    const rotated = await sessionRequest('/sessions/rotate', cookie, 'POST');
    expect(rotated.status).toBe(200);
    const maxAge = Number(
      /Max-Age=(\d+)/.exec(rotated.headers.get('set-cookie') ?? '')?.[1],
    );
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(120);
    const replacementCookie = cookiePair(rotated);
    const activeDeadline = await runInDurableObject(
      identityStub(),
      (instance) =>
        instance.db
          .prepare(
            `SELECT absolute_expires_at AS absoluteExpiresAt
             FROM sessions WHERE account_id = ? AND revoked_at IS NULL`,
          )
          .get(body.accountId),
    );
    expect(activeDeadline).toEqual({ absoluteExpiresAt: originalDeadline });

    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `UPDATE sessions
           SET created_at = 100, last_seen_at = 100,
               idle_expires_at = 150, absolute_expires_at = 150
           WHERE account_id = ? AND revoked_at IS NULL`,
        )
        .run(body.accountId);
    });
    expect(
      (await sessionRequest('/sessions/current', replacementCookie)).status,
    ).toBe(401);
  });

  it('revokes all sessions, disables issuance, and does not resurrect sessions after enablement', async () => {
    const first = await issueSession('do-account-state');
    const firstBody = await first.json() as { accountId: string };
    const firstCookie = cookiePair(first);
    const second = await issueSession('do-account-state');
    const secondCookie = cookiePair(second);

    const revoked = await changeAccount('revoke-all', firstBody.accountId);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      accountId: firstBody.accountId,
      authorizationEpoch: 1,
      state: 'active',
      revokedSessions: 2,
    });
    expect((await sessionRequest('/sessions/current', firstCookie)).status).toBe(401);
    expect((await sessionRequest('/sessions/current', secondCookie)).status).toBe(401);

    const replacement = await issueSession('do-account-state');
    const replacementCookie = cookiePair(replacement);
    const disabled = await changeAccount('disable', firstBody.accountId);
    expect(await disabled.json()).toMatchObject({
      authorizationEpoch: 2,
      state: 'disabled',
      revokedSessions: 1,
    });
    expect((await issueSession('do-account-state')).status).toBe(401);
    expect((await sessionRequest('/sessions/current', replacementCookie)).status).toBe(401);

    const enabled = await changeAccount('enable', firstBody.accountId);
    expect(await enabled.json()).toMatchObject({
      authorizationEpoch: 2,
      state: 'active',
      revokedSessions: 0,
    });
    expect((await sessionRequest('/sessions/current', replacementCookie)).status).toBe(401);
    const fresh = await issueSession('do-account-state');
    expect((await fresh.json() as { authorizationEpoch: number }).authorizationEpoch).toBe(2);
  });

  it('expires persisted sessions and clears the rejected browser cookie', async () => {
    const issued = await issueSession('do-expiry');
    const body = await issued.clone().json() as { accountId: string };
    const cookie = cookiePair(issued);
    await expireSessionIdleNow({ accountId: body.accountId });

    const expired = await sessionRequest('/sessions/current', cookie);
    expect(expired.status).toBe(401);
    expect(expired.headers.get('set-cookie')).toBe(clearSessionCookie());
  });

  it('purges idle-expired session rows on the next identity fetch', async () => {
    const issued = await issueSession('do-purge-expired');
    const body = await issued.clone().json() as { accountId: string };
    const cookie = cookiePair(issued);
    await expireSessionIdleNow({ accountId: body.accountId });

    expect((await sessionRequest('/sessions/current', cookie)).status).toBe(401);

    const remaining = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE account_id = ?`)
        .get(body.accountId),
    );
    expect(remaining).toEqual({ count: 0 });
  });

  it('fails closed when rotate and revoke-all race', async () => {
    const issued = await issueSession('do-rotate-revoke-race');
    const body = await issued.clone().json() as { accountId: string };
    const cookie = cookiePair(issued);

    const [rotation, revocation] = await Promise.all([
      sessionRequest('/sessions/rotate', cookie, 'POST'),
      changeAccount('revoke-all', body.accountId),
    ]);
    expect(revocation.status).toBe(200);
    expect([200, 401]).toContain(rotation.status);
    expect((await sessionRequest('/sessions/current', cookie)).status).toBe(401);
    if (rotation.status === 200) {
      expect(
        (await sessionRequest('/sessions/current', cookiePair(rotation))).status,
      ).toBe(401);
    }
  });

  it('allows only one winner when the same session is rotated concurrently', async () => {
    const issued = await issueSession('do-concurrent-rotation');
    const body = await issued.clone().json() as { accountId: string };
    const cookie = cookiePair(issued);
    const rotations = await Promise.all(
      Array.from({ length: 8 }, () =>
        sessionRequest('/sessions/rotate', cookie, 'POST'),
      ),
    );

    const winners = rotations.filter((response) => response.status === 200);
    expect(winners).toHaveLength(1);
    expect(rotations.filter((response) => response.status === 401)).toHaveLength(7);
    const active = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM sessions
           WHERE account_id = ? AND revoked_at IS NULL`,
        )
        .get(body.accountId),
    );
    expect(active).toEqual({ count: 1 });
    expect(
      (
        await sessionRequest('/sessions/current', cookiePair(winners[0]))
      ).status,
    ).toBe(200);
  });

  it('allows only the exact internal methods, content types, bodies, and unambiguous cookie', async () => {
    const issued = await issueSession('do-input-contract');
    const cookie = cookiePair(issued);
    const duplicate = `${cookie}; ${SESSION_COOKIE_NAME}=${'a'.repeat(43)}`;
    const responses = await Promise.all([
      identityStub().fetch('https://identity/sessions/issue'),
      identityStub().fetch('https://identity/sessions/issue', {
        method: 'POST',
        body: JSON.stringify({ issuer: 'issuer', subject: 'subject' }),
      }),
      identityStub().fetch('https://identity/sessions/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'issuer', subject: 'subject', email: 'x@y.test' }),
      }),
      sessionRequest('/sessions/current', duplicate),
      sessionRequest('/sessions/rotate', cookie, 'GET'),
      identityStub().fetch('https://identity/accounts/disable', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'x', extra: true }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      405, 415, 400, 401, 405, 400,
    ]);
  });

  it('exports the caller account through GET /accounts/export and nobody else', async () => {
    const mine = await issueSession('do-export-mine');
    const mineBody = await mine.json() as { accountId: string };
    const mineCookie = cookiePair(mine);
    const rawToken = mineCookie.split('=', 2)[1];
    const other = await issueSession('do-export-other');
    const otherBody = await other.json() as { accountId: string };

    expect((await identityStub().fetch('https://identity/accounts/export')).status).toBe(401);
    expect((await sessionRequest('/accounts/export', mineCookie, 'POST')).status).toBe(405);

    const exported = await sessionRequest('/accounts/export', mineCookie);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('cache-control')).toBe('no-store');
    const body = await exported.json() as {
      accountId: string;
      createdAt: number;
      sessions: Array<{ sessionHash: string; createdAt: number }>;
      accessSubjects: Array<{ issuer: string; subject: string }>;
    };
    expect(body.accountId).toBe(mineBody.accountId);
    expect(body.sessions).toEqual([
      expect.objectContaining({ sessionHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
    expect(body.accessSubjects).toEqual([
      expect.objectContaining({
        issuer: 'https://access.example.com',
        subject: 'do-export-mine',
      }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain(otherBody.accountId);
    expect(body.accessSubjects.some((row) => row.subject === 'do-export-other')).toBe(false);
  });

  it('saves a preferred display name on PATCH /accounts/profile for the caller only', async () => {
    const mine = await issueSession('do-profile-mine');
    const mineCookie = cookiePair(mine);
    const other = await issueSession('do-profile-other');
    const otherCookie = cookiePair(other);

    expect((await identityStub().fetch('https://identity/accounts/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ada Lovelace' }),
    })).status).toBe(401);

    const saved = await identityStub().fetch('https://identity/accounts/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: mineCookie },
      body: JSON.stringify({ displayName: 'Ada Lovelace' }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ displayName: 'Ada Lovelace' });

    const mineAuth = await identityStub().fetch('https://identity/sessions/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: mineCookie },
      body: JSON.stringify({
        issuer: 'https://access.example.com',
        subject: 'do-profile-mine',
      }),
    });
    expect(mineAuth.status).toBe(200);
    expect(await mineAuth.json()).toMatchObject({ preferredDisplayName: 'Ada Lovelace' });

    const otherAuth = await identityStub().fetch('https://identity/sessions/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({
        issuer: 'https://access.example.com',
        subject: 'do-profile-other',
      }),
    });
    expect(await otherAuth.json()).not.toMatchObject({
      preferredDisplayName: 'Ada Lovelace',
    });

    const extras = await identityStub().fetch('https://identity/accounts/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({ displayName: 'Eve', accountId: 'ignored' }),
    });
    expect(extras.status).toBe(400);
  });

  it('erases the caller through DELETE /accounts only with a fresh session cookie', async () => {
    const mine = await issueSession('do-erase-mine');
    const mineBody = await mine.json() as { accountId: string };
    const mineCookie = cookiePair(mine);
    const other = await issueSession('do-erase-other');
    const otherCookie = cookiePair(other);

    expect((await identityStub().fetch('https://identity/accounts')).status).toBe(405);
    expect((await identityStub().fetch('https://identity/accounts', { method: 'DELETE' })).status).toBe(401);

    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `UPDATE sessions SET created_at = created_at - ?
           WHERE account_id = ? AND revoked_at IS NULL`,
        )
        .run(DESTRUCTIVE_FRESH_MS + 60_000, mineBody.accountId);
    });
    const stale = await sessionRequest('/accounts', mineCookie, 'DELETE');
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'Reauthentication required' });
    expect((await sessionRequest('/sessions/current', mineCookie)).status).toBe(200);

    const confirmed = await identityStub().fetch('https://identity/sessions/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: mineCookie },
      body: JSON.stringify({
        issuer: 'https://access.example.com',
        subject: 'do-erase-mine',
      }),
    });
    expect(confirmed.status).toBe(200);

    const erased = await sessionRequest('/accounts', mineCookie, 'DELETE');
    expect(erased.status).toBe(200);
    expect(erased.headers.get('cache-control')).toBe('no-store');
    expect(erased.headers.get('set-cookie')).toBe(clearSessionCookie());
    expect(await erased.json()).toEqual({ ok: true, roomIds: [] });
    expect((await sessionRequest('/sessions/current', mineCookie)).status).toBe(401);
    expect((await sessionRequest('/sessions/current', otherCookie)).status).toBe(200);

    const leftover = await runInDurableObject(identityStub(), (instance) => ({
      subjects: (
        instance.db
          .prepare(`SELECT COUNT(*) AS count FROM access_subjects WHERE account_id = ?`)
          .get(mineBody.accountId) as { count: number }
      ).count,
      state: (
        instance.db
          .prepare(`SELECT state FROM accounts WHERE account_id = ?`)
          .get(mineBody.accountId) as { state: string }
      ).state,
    }));
    expect(leftover).toEqual({ subjects: 0, state: 'disabled' });
  });

  it('returns owned room ids and clears account_rooms on erase', async () => {
    const mine = await issueSession('do-erase-rooms-mine');
    const mineCookie = cookiePair(mine);
    const mineBody = await mine.json() as { accountId: string };
    const other = await issueSession('do-erase-rooms-other');
    const otherCookie = cookiePair(other);
    const otherBody = await other.json() as { accountId: string };

    expect((await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: mineCookie },
      body: JSON.stringify({ roomId: 'erase-room-a' }),
    })).status).toBe(200);
    expect((await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({ roomId: 'erase-room-other' }),
    })).status).toBe(200);

    const erased = await sessionRequest('/accounts', mineCookie, 'DELETE');
    expect(erased.status).toBe(200);
    const body = await erased.json() as { ok: boolean; roomIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.roomIds.sort()).toEqual(['erase-room-a']);

    expect(await (await sessionRequest('/accounts/rooms', otherCookie)).json()).toEqual({
      rooms: [
        expect.objectContaining({ roomId: 'erase-room-other' }),
      ],
    });

    const counts = await runInDurableObject(identityStub(), (instance) => ({
      mineRooms: (
        instance.db
          .prepare(`SELECT COUNT(*) AS count FROM account_rooms WHERE account_id = ?`)
          .get(mineBody.accountId) as { count: number }
      ).count,
      otherRooms: (
        instance.db
          .prepare(`SELECT room_id AS roomId FROM account_rooms WHERE account_id = ?`)
          .all(otherBody.accountId) as Array<{ roomId: string }>
      ),
    }));
    expect(counts.mineRooms).toBe(0);
    expect(counts.otherRooms).toEqual([{ roomId: 'erase-room-other' }]);
  });

  it('authorizes a local session only for its exact Access issuer and subject', async () => {
    const issued = await issueSession('do-bound-principal');
    const cookie = cookiePair(issued);
    const authorized = await identityStub().fetch('https://identity/sessions/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ issuer: 'https://access.example.com', subject: 'do-bound-principal' }),
    });
    expect(authorized.status).toBe(200);
    const wrongSubject = await identityStub().fetch('https://identity/sessions/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ issuer: 'https://access.example.com', subject: 'different-principal' }),
    });
    expect(wrongSubject.status).toBe(401);
  });


  it('reports account authorization so a room can re-check its live connections', async () => {
    const issued = await issueSession('do-live-authz');
    const { accountId } = await issued.json() as { accountId: string };

    const before = await identityStub().fetch('https://identity/accounts/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountIds: [accountId, 'missing-account'] }),
    });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      accounts: { [accountId]: { state: 'active', authorizationEpoch: 0 } },
    });

    await changeAccount('revoke-all', accountId);

    const after = await identityStub().fetch('https://identity/accounts/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountIds: [accountId] }),
    });
    expect(await after.json()).toEqual({
      accounts: { [accountId]: { state: 'active', authorizationEpoch: 1 } },
    });

    await changeAccount('disable', accountId);

    const disabled = await identityStub().fetch('https://identity/accounts/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountIds: [accountId] }),
    });
    expect(await disabled.json()).toEqual({
      accounts: { [accountId]: { state: 'disabled', authorizationEpoch: 2 } },
    });
  });

  it('reports only the requested session hashes that are still active', async () => {
    // An active session, an idle-expired one, and a logged-out one, checked in
    // one batch so the response must tell them apart.
    const active = await issueSession('do-session-hash-active');
    const activeCookie = cookiePair(active);
    const activeBody = await active.json() as { accountId: string };
    const activeCurrent = await sessionRequest('/sessions/current', activeCookie);
    const { sessionId: activeHash } = await activeCurrent.json() as { sessionId: string };

    const idle = await issueSession('do-session-hash-idle');
    const idleCookie = cookiePair(idle);
    const idleBody = await idle.json() as { accountId: string };
    const idleCurrent = await sessionRequest('/sessions/current', idleCookie);
    const { sessionId: idleHash } = await idleCurrent.json() as { sessionId: string };

    const revoked = await issueSession('do-session-hash-revoked');
    const revokedCookie = cookiePair(revoked);
    const revokedBody = await revoked.json() as { accountId: string };
    const revokedCurrent = await sessionRequest('/sessions/current', revokedCookie);
    const { sessionId: revokedHash } = await revokedCurrent.json() as { sessionId: string };

    // Idle expiry is only reachable by moving the real row's clock back.
    await expireSessionIdleNow({ sessionHash: idleHash });
    expect((await identityStub().fetch('https://identity/sessions/logout', {
      method: 'POST',
      headers: { cookie: revokedCookie },
      body: null,
    })).status).toBe(204);

    const response = await identityStub().fetch('https://identity/accounts/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountIds: [activeBody.accountId, idleBody.accountId, revokedBody.accountId],
        sessions: [
          { accountId: activeBody.accountId, sessionHash: activeHash },
          { accountId: idleBody.accountId, sessionHash: idleHash },
          { accountId: revokedBody.accountId, sessionHash: revokedHash },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: {
        [activeBody.accountId]: { state: 'active', authorizationEpoch: 0 },
        [idleBody.accountId]: { state: 'active', authorizationEpoch: 0 },
        [revokedBody.accountId]: { state: 'active', authorizationEpoch: 0 },
      },
      activeSessionHashes: [activeHash],
    });
  });

  it('rejects malformed or unbounded authorization batches', async () => {
    const cases: unknown[] = [
      { accountIds: 'not-an-array' },
      { accountIds: [1] },
      { accountIds: [''] },
      { accountIds: Array.from({ length: 501 }, (_, i) => `a${i}`) },
      { accountIds: [], extra: true },
    ];

    for (const body of cases) {
      const response = await identityStub().fetch('https://identity/accounts/authorizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }

    const wrongMethod = await identityStub().fetch('https://identity/accounts/authorizations');
    expect(wrongMethod.status).toBe(405);
  });


  it('refuses an authorization change that names no actor or reason', async () => {
    const issued = await issueSession('do-audit-required');
    const { accountId } = await issued.json() as { accountId: string };

    for (const body of [
      { accountId },
      { accountId, actor: 'ops' },
      { accountId, reason: 'why' },
      { accountId, actor: '  ', reason: 'why' },
      { accountId, actor: 'ops', reason: '  ' },
    ]) {
      const response = await identityStub().fetch('https://identity/accounts/revoke-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    // The rejected attempts changed nothing.
    const status = await identityStub().fetch('https://identity/accounts/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountIds: [accountId] }),
    });
    expect(await status.json()).toEqual({
      accounts: { [accountId]: { state: 'active', authorizationEpoch: 0 } },
    });
  });

  it('persists an audit record through the real Durable Object', async () => {
    const issued = await issueSession('do-audit-record');
    const { accountId } = await issued.json() as { accountId: string };

    await identityStub().fetch('https://identity/accounts/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId, actor: 'ops@example.com', reason: 'incident 42' }),
    });

    const audit = await runInDurableObject(identityStub(), (instance) =>
      readAuthorizationAudit(instance.db, accountId));

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      accountId,
      action: 'disable',
      actor: 'ops@example.com',
      reason: 'incident 42',
      previousState: 'active',
      nextState: 'disabled',
      previousEpoch: 0,
      nextEpoch: 1,
    });
  });

  it('lists no owned rooms until the session account records some', async () => {
    const issued = await issueSession('do-rooms-empty');
    const cookie = cookiePair(issued);

    const listed = await sessionRequest('/accounts/rooms', cookie);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(await listed.json()).toEqual({ rooms: [] });
  });

  it('returns 401 for owned-room routes without a session cookie', async () => {
    expect((await identityStub().fetch('https://identity/accounts/rooms')).status).toBe(401);

    const posted = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-one' }),
    });
    expect(posted.status).toBe(401);

    const deleted = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-one' }),
    });
    expect(deleted.status).toBe(401);
  });

  it('records one owned room and upserts its name', async () => {
    const issued = await issueSession('do-rooms-order');
    const cookie = cookiePair(issued);

    const first = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-one', name: 'Older' }),
    });
    expect([200, 204]).toContain(first.status);

    const renamed = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-one', name: 'Newer' }),
    });
    expect([200, 204]).toContain(renamed.status);

    const listed = await sessionRequest('/accounts/rooms', cookie);
    expect(listed.status).toBe(200);
    const body = await listed.json() as {
      rooms: Array<{ roomId: string; name: string | null; role: string }>;
    };
    expect(body.rooms.map((room) => room.roomId)).toEqual(['room-one']);
    expect(body.rooms[0]).toEqual(
      expect.objectContaining({
        roomId: 'room-one',
        name: 'Newer',
        role: 'owner',
      }),
    );
  });

  it('rejects a second owned room with the plan-limit status', async () => {
    const issued = await issueSession('do-rooms-plan-limit');
    const cookie = cookiePair(issued);

    const first = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-free-one' }),
    });
    expect(first.status).toBe(200);

    const second = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-free-two' }),
    });
    expect(second.status).toBe(402);
    expect(await second.json()).toEqual({ error: 'Plan limit reached' });

    const listed = await sessionRequest('/accounts/rooms', cookie);
    const body = await listed.json() as { rooms: Array<{ roomId: string }> };
    expect(body.rooms.map((room) => room.roomId)).toEqual(['room-free-one']);
  });

  it('lets a Tutor Pro owner reserve a second owned room from the effective plan', async () => {
    const issued = await issueSession('do-rooms-tutor-pro');
    const cookie = cookiePair(issued);
    const { accountId } = await issued.json() as { accountId: string };

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      writeEntitlement(
        instance.db,
        {
          accountId,
          source: 'personal',
          state: {
            planId: 'tutor_pro_monthly',
            status: 'active',
            graceUntil: null,
            collectionPaused: false,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: 'cus_rooms',
            processorSubscriptionId: 'sub_rooms',
          },
          now: Date.now(),
        },
        {
          kind: 'operator',
          id: `seed-rooms-${crypto.randomUUID()}`,
          actor: 'test-operator',
          reason: 'seed paid state',
        },
      );
    });

    const first = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-paid-one' }),
    });
    expect(first.status).toBe(200);

    const second = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-paid-two' }),
    });
    expect(second.status).toBe(200);

    const listed = await sessionRequest('/accounts/rooms', cookie);
    const body = await listed.json() as { rooms: Array<{ roomId: string }> };
    expect(body.rooms.map((room) => room.roomId).sort()).toEqual([
      'room-paid-one',
      'room-paid-two',
    ]);
  });

  it('falls back to the Free cap when the entitlements read throws', async () => {
    const issued = await issueSession('do-rooms-entitlement-fault');
    const cookie = cookiePair(issued);
    const { accountId } = await issued.json() as { accountId: string };

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      writeEntitlement(
        instance.db,
        {
          accountId,
          source: 'personal',
          state: {
            planId: 'tutor_pro_monthly',
            status: 'active',
            graceUntil: null,
            collectionPaused: false,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: 'cus_rooms_fault',
            processorSubscriptionId: 'sub_rooms_fault',
          },
          now: Date.now(),
        },
        {
          kind: 'operator',
          id: `seed-rooms-fault-${crypto.randomUUID()}`,
          actor: 'test-operator',
          reason: 'seed paid state',
        },
      );
    });

    const first = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-fault-one' }),
    });
    expect(first.status).toBe(200);

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      instance.db.exec('DROP TABLE entitlements');
    });

    try {
      const second = await identityStub().fetch('https://identity/accounts/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ roomId: 'room-fault-two' }),
      });
      expect(second.status).toBe(402);
      expect(await second.json()).toEqual({ error: 'Plan limit reached' });
    } finally {
      await runInDurableObject(identityStub(), (instance: IdentityDO) => {
        applyIdentitySchema(instance.db);
      });
    }
  });

  it('allows another owned room after the first is deleted', async () => {
    const issued = await issueSession('do-rooms-replace');
    const cookie = cookiePair(issued);

    expect((await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-old' }),
    })).status).toBe(200);

    expect((await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-old' }),
    })).status).toBe(204);

    expect((await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-new' }),
    })).status).toBe(200);

    const listed = await sessionRequest('/accounts/rooms', cookie);
    const body = await listed.json() as { rooms: Array<{ roomId: string }> };
    expect(body.rooms.map((room) => room.roomId)).toEqual(['room-new']);
  });

  it('cannot list another account\'s owned rooms', async () => {
    const mine = await issueSession('do-rooms-mine');
    const mineCookie = cookiePair(mine);
    const other = await issueSession('do-rooms-other');
    const otherCookie = cookiePair(other);

    await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({ roomId: 'secret-room', name: 'Secret', accountId: 'ignored' }),
    });

    const listed = await sessionRequest('/accounts/rooms', mineCookie);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ rooms: [] });

    const otherListed = await sessionRequest('/accounts/rooms', otherCookie);
    const otherBody = await otherListed.json() as { rooms: Array<{ roomId: string }> };
    expect(otherBody.rooms.map((room) => room.roomId)).toEqual(['secret-room']);
  });

  it('rejects an invalid roomId and ignores body accountId on POST', async () => {
    const issued = await issueSession('do-rooms-invalid');
    const cookie = cookiePair(issued);
    const { accountId } = await issued.json() as { accountId: string };

    const invalid = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: '../etc/passwd' }),
    });
    expect(invalid.status).toBe(400);

    const spoof = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'owned-room', accountId: 'someone-else' }),
    });
    expect([200, 204]).toContain(spoof.status);

    const listed = await sessionRequest('/accounts/rooms', cookie);
    const body = await listed.json() as { rooms: Array<{ roomId: string }> };
    expect(body.rooms.map((room) => room.roomId)).toEqual(['owned-room']);
    expect(JSON.stringify(body)).not.toContain('someone-else');
    expect(JSON.stringify(body)).not.toContain(accountId);
  });

  it('deletes an owned room for the session account even when missing', async () => {
    const issued = await issueSession('do-rooms-delete');
    const cookie = cookiePair(issued);

    await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'to-drop' }),
    });

    const missing = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'never-existed' }),
    });
    expect(missing.status).toBe(204);

    const dropped = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'to-drop' }),
    });
    expect(dropped.status).toBe(204);

    expect(await (await sessionRequest('/accounts/rooms', cookie)).json()).toEqual({
      rooms: [],
    });
  });

  it('does not expose any session or account-control path through the public Worker', async () => {
    const paths = [
      '/api/internal/identity/sessions/issue',
      '/api/internal/identity/sessions/current',
      '/api/internal/identity/sessions/rotate',
      '/api/internal/identity/sessions/logout',
      '/api/internal/identity/accounts/revoke-all',
      '/api/internal/identity/accounts/disable',
    ];
    const responses = await Promise.all(
      paths.map((path) =>
        SELF.fetch(`https://example.com${path}`, { method: 'POST' }),
      ),
    );
    expect(responses.every((response) => response.status === 404)).toBe(true);
  });

  // Guest routes tests
  it('issues a guest session via POST /guests/issue with roomId and displayName', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: '12345678901234567890123456789012', displayName: 'Alice' }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain(`${GUEST_SESSION_COOKIE_NAME}=`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body.token).toBeUndefined();
    expect(body.accountId).toBeDefined();
    expect(body.authorizationEpoch).toBe(0);
  });

  it('creates a guest account with provenance=guest and correct guest_room_id', async () => {
    const roomId = 'aaaabbbbccccddddeeeeffffgggghhhh';
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, displayName: 'Bob' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { accountId: string };

    const account = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT provenance, guest_room_id AS guestRoomId
           FROM accounts WHERE account_id = ?`,
        )
        .get(body.accountId) as { provenance: string; guestRoomId: string },
    );
    expect(account.provenance).toBe('guest');
    expect(account.guestRoomId).toBe(roomId);
  });

  it('rejects /guests/issue with missing roomId', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Charlie' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects /guests/issue with blank roomId', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: '', displayName: 'Diana' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects /guests/issue with missing displayName', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: '12345678901234567890123456789012' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects /guests/issue with blank displayName', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: '12345678901234567890123456789012', displayName: '' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects /guests/issue with over-length displayName', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: '12345678901234567890123456789012', displayName: 'a'.repeat(101) }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects /guests/issue with unexpected extra field', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: '12345678901234567890123456789012', displayName: 'Eve', extra: true }),
    });
    expect(response.status).toBe(400);
  });

  it('does not include the session token in /guests/issue response body', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: '12345678901234567890123456789012', displayName: 'Frank' }),
    });
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(body).not.toContain('token');
    expect(body).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it('authorizes a guest session via POST /sessions/authorize-guest with matching roomId', async () => {
    const roomId = 'bbbbccccddddeeeeffffgggghhhhjjjj';
    const issueResponse = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, displayName: 'Grace' }),
    });
    const issuedCookie = issueResponse.headers.get('set-cookie')!.split(';', 1)[0];

    const authResponse = await identityStub().fetch('https://identity/sessions/authorize-guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: issuedCookie },
      body: JSON.stringify({ roomId }),
    });
    expect(authResponse.status).toBe(200);
    const body = await authResponse.json() as Record<string, unknown>;
    expect(body.accountId).toBeDefined();
    expect(body.sessionId).toBeDefined();
  });

  it('rejects /sessions/authorize-guest with teacher cookie', async () => {
    const issueTeacherResponse = await issueSession('teacher-principal');
    const teacherCookie = cookiePair(issueTeacherResponse);

    const authResponse = await identityStub().fetch('https://identity/sessions/authorize-guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: teacherCookie },
      body: JSON.stringify({ roomId: 'ccccddddeeeeffffgggghhhhjjjjkkkk' }),
    });
    expect(authResponse.status).toBe(401);
  });

  it('rejects /sessions/authorize-guest with guest cookie for different roomId', async () => {
    const roomId = 'ddddeeeeffffgggghhhhjjjjkkkkllll';
    const issueResponse = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, displayName: 'Hannah' }),
    });
    const guestCookie = issueResponse.headers.get('set-cookie')!.split(';', 1)[0];

    const authResponse = await identityStub().fetch('https://identity/sessions/authorize-guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: guestCookie },
      body: JSON.stringify({ roomId: 'eeeeffffgggghhhhjjjjkkkkllllmmmm' }),
    });
    expect(authResponse.status).toBe(401);
  });

  it('purges guest accounts bound to a room via POST /guests/purge', async () => {
    const roomId = 'fffgggghhhhiiiijjjjkkkkllllmmmm';
    const issue1 = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, displayName: 'Ivan' }),
    });
    const body1 = await issue1.json() as { accountId: string };

    const issue2 = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, displayName: 'Jane' }),
    });
    const body2 = await issue2.json() as { accountId: string };

    const purgeResponse = await identityStub().fetch('https://identity/guests/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
    expect(purgeResponse.status).toBe(200);

    const remaining = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(`SELECT COUNT(*) AS count FROM accounts WHERE account_id IN (?, ?)`)
        .get(body1.accountId, body2.accountId) as { count: number },
    );
    expect(remaining.count).toBe(0);
  });

  it('leaves other rooms\' guest accounts intact when purging a room', async () => {
    const roomA = 'gggghhhhjjjjkkkkllllmmmmnnnnooo';
    const roomB = 'hhhhjjjjkkkkllllmmmmnnnnoooopp';
    const issueA = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: roomA, displayName: 'Kevin' }),
    });
    const bodyA = await issueA.json() as { accountId: string };

    const issueB = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: roomB, displayName: 'Laura' }),
    });
    const bodyB = await issueB.json() as { accountId: string };

    const purgeResponse = await identityStub().fetch('https://identity/guests/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: roomA }),
    });
    expect(purgeResponse.status).toBe(200);

    const counts = await runInDurableObject(identityStub(), (instance) => ({
      roomA: (instance.db
        .prepare(`SELECT COUNT(*) AS count FROM accounts WHERE account_id = ?`)
        .get(bodyA.accountId) as { count: number }).count,
      roomB: (instance.db
        .prepare(`SELECT COUNT(*) AS count FROM accounts WHERE account_id = ?`)
        .get(bodyB.accountId) as { count: number }).count,
    }));
    expect(counts.roomA).toBe(0);
    expect(counts.roomB).toBe(1);
  });

  it('leaves access accounts untouched when purging guest accounts', async () => {
    const roomId = 'iiijjjjkkkkllllmmmmnnnnoooopppp';
    // Create an access account
    const accessResponse = await resolveSubject('https://access.example.com', 'access-subject-purge');
    const accessBody = await accessResponse.json() as { account: { accountId: string } };

    // Create a guest account for the same room
    const guestResponse = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, displayName: 'Mike' }),
    });
    const guestBody = await guestResponse.json() as { accountId: string };

    // Purge the room
    await identityStub().fetch('https://identity/guests/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });

    const counts = await runInDurableObject(identityStub(), (instance) => ({
      access: (instance.db
        .prepare(`SELECT COUNT(*) AS count FROM accounts WHERE account_id = ?`)
        .get(accessBody.account.accountId) as { count: number }).count,
      guest: (instance.db
        .prepare(`SELECT COUNT(*) AS count FROM accounts WHERE account_id = ?`)
        .get(guestBody.accountId) as { count: number }).count,
    }));
    expect(counts.access).toBe(1);
    expect(counts.guest).toBe(0);
  });

  it('rejects non-POST methods on /guests/issue', async () => {
    const response = await identityStub().fetch('https://identity/guests/issue', {
      method: 'GET',
    });
    expect(response.status).toBe(405);
  });

  it('rejects non-POST methods on /sessions/authorize-guest', async () => {
    const response = await identityStub().fetch('https://identity/sessions/authorize-guest', {
      method: 'GET',
    });
    expect(response.status).toBe(405);
  });

  it('rejects non-POST methods on /guests/purge', async () => {
    const response = await identityStub().fetch('https://identity/guests/purge', {
      method: 'GET',
    });
    expect(response.status).toBe(405);
  });

  it('purges a guest account on fetch once every session has expired', async () => {
    const roomId = 'kkkkllllmmmmnnnnooooppppqqqqrrrr';
    const guestResponse = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, displayName: 'Nina' }),
    });
    const guestBody = await guestResponse.json() as { accountId: string };

    const liveResponse = await identityStub().fetch('https://identity/guests/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'llllmmmmnnnnooooppppqqqqrrrrssss',
        displayName: 'Oscar',
      }),
    });
    const liveBody = await liveResponse.json() as { accountId: string };

    const accessResponse = await resolveSubject(
      'https://access.example.com',
      'access-subject-expired-guest-purge',
    );
    const accessBody = await accessResponse.json() as { account: { accountId: string } };
    await issueSession('access-subject-expired-guest-purge');

    await runInDurableObject(identityStub(), (instance) => {
      const created = Date.now() - 60_000;
      const idle = created + 1;
      instance.db
        .prepare(
          `UPDATE sessions
           SET created_at = ?, last_seen_at = ?, idle_expires_at = ?
           WHERE account_id = ?`,
        )
        .run(created, created, idle, guestBody.accountId);
      instance.db
        .prepare(
          `UPDATE sessions
           SET created_at = ?, last_seen_at = ?, idle_expires_at = ?
           WHERE account_id = ?`,
        )
        .run(created, created, idle, accessBody.account.accountId);
    });

    const trigger = await identityStub().fetch('https://identity/guests/purge', {
      method: 'GET',
    });
    expect(trigger.status).toBe(405);

    const counts = await runInDurableObject(identityStub(), (instance) => ({
      expiredGuest: (instance.db
        .prepare(`SELECT COUNT(*) AS count FROM accounts WHERE account_id = ?`)
        .get(guestBody.accountId) as { count: number }).count,
      liveGuest: (instance.db
        .prepare(`SELECT COUNT(*) AS count FROM accounts WHERE account_id = ?`)
        .get(liveBody.accountId) as { count: number }).count,
      access: (instance.db
        .prepare(`SELECT COUNT(*) AS count FROM accounts WHERE account_id = ?`)
        .get(accessBody.account.accountId) as { count: number }).count,
    }));
    expect(counts.expiredGuest).toBe(0);
    expect(counts.liveGuest).toBe(1);
    expect(counts.access).toBe(1);
  });

  it('records a pending erasure for the room the account owns', async () => {
    const roomId = 'erase-pending-room';
    const issueResponse = await issueSession('erase-pending-subject');
    const cookie = cookiePair(issueResponse);

    /*
     * One room, not two. FREE_MAX_ROOMS is 1, so a second POST here is refused
     * with 402 "Plan limit reached" -- an earlier version of this test recorded
     * two rooms and then asserted on both, and failed for that reason rather
     * than for anything wrong with erasure. Multi-target fan-out is covered
     * below, against the store, where the plan cap does not apply.
     */
    const recorded = await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId, name: 'Room 1' }),
    });
    expect(recorded.status).toBe(200);

    // Resolved from the room this test just created. Reading "any disabled
    // account" instead picks up whatever other tests left in this singleton.
    const accountId = await runInDurableObject(identityStub(), (instance) => (
      (instance.db
        .prepare('SELECT account_id FROM account_rooms WHERE room_id = ?')
        .get(roomId) as { account_id: string } | undefined)?.account_id
    ));
    expect(accountId).toBeDefined();

    const eraseResponse = await identityStub().fetch('https://identity/accounts', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(eraseResponse.status).toBe(200);
    const eraseBody = await eraseResponse.json() as { ok: boolean; roomIds: string[] };
    expect(eraseBody.ok).toBe(true);
    expect(eraseBody.roomIds).toEqual([roomId]);

    const pending = await runInDurableObject(identityStub(), (instance) => (
      listPendingErasures(instance.db, accountId!)
    ));
    expect(pending).toEqual([roomId]);
  });

  it('keeps every erasure target until each one is cleared', async () => {
    const accountId = 'erasure-fanout-account';

    // Driven through the real store functions on the real Durable Object
    // database. The HTTP route cannot reach a two-room account at all while
    // FREE_MAX_ROOMS is 1, but erasure still has to fan out over whatever it
    // is given, and a partial failure must not lose the rest.
    const remaining = await runInDurableObject(identityStub(), (instance) => {
      persistErasureTargets(instance.db, accountId, ['room-x', 'room-y'], Date.now());
      const both = listPendingErasures(instance.db, accountId).sort();

      clearErasureTarget(instance.db, accountId, 'room-x');
      const afterFirst = listPendingErasures(instance.db, accountId);

      clearErasureTarget(instance.db, accountId, 'room-y');
      const afterSecond = listPendingErasures(instance.db, accountId);

      return { both, afterFirst, afterSecond };
    });

    expect(remaining.both).toEqual(['room-x', 'room-y']);
    expect(remaining.afterFirst).toEqual(['room-y']);
    expect(remaining.afterSecond).toEqual([]);
  });

  it('does not re-add an erasure target that was already cleared', async () => {
    const accountId = 'erasure-idempotency-account';

    const finalState = await runInDurableObject(identityStub(), (instance) => {
      persistErasureTargets(instance.db, accountId, ['room-z'], Date.now());
      clearErasureTarget(instance.db, accountId, 'room-z');
      // A retry of the same erasure must not resurrect finished work.
      persistErasureTargets(instance.db, accountId, [], Date.now());
      return listPendingErasures(instance.db, accountId);
    });

    expect(finalState).toEqual([]);
  });

  it('answers GET /accounts/plan with Free for an account without entitlements', async () => {
    const resolved = await resolveSubject('https://access.example.com', 'plan-no-rows');
    const { account } = await resolved.json() as { account: { accountId: string } };

    const known = await planRequest(account.accountId);
    expect(known.status).toBe(200);
    expect(known.headers.get('cache-control')).toBe('no-store');
    expect(await known.json()).toEqual({
      planId: 'free',
      source: null,
      companyId: null,
      status: 'free',
      limits: PLAN_CATALOG.free.limits,
      graceUntil: null,
      collectionPaused: false,
    });

  });

  it('refuses a plan for an account the caller has not proved (SEC-A20)', async () => {
    const owner = await (await resolveSubject('https://access.example.com', 'plan-proof-owner')).json() as {
      account: { accountId: string };
    };
    const other = await (await resolveSubject('https://access.example.com', 'plan-proof-other')).json() as {
      account: { accountId: string };
    };
    const ownerId = owner.account.accountId;
    const otherId = other.account.accountId;
    const plan = (query: string, init?: RequestInit) =>
      identityStub().fetch(`https://identity/accounts/plan${query}`, init);

    // A bare account id proves nothing: the shape a future route forwarding a
    // client-supplied id would take.
    const bare = await plan(`?accountId=${encodeURIComponent(ownerId)}`);
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual({ error: 'Forbidden' });

    // A room the account does not own proves nothing either.
    const roomOfOwner = await seedOwnedRoom(ownerId);
    const ownerForm = await plan(
      `?accountId=${encodeURIComponent(ownerId)}&roomId=${encodeURIComponent(roomOfOwner)}`,
    );
    expect(ownerForm.status).toBe(200);
    const notOwned = await plan(
      `?accountId=${encodeURIComponent(otherId)}&roomId=${encodeURIComponent(roomOfOwner)}`,
    );
    expect(notOwned.status).toBe(403);
    expect(await notOwned.json()).toEqual({ error: 'Forbidden' });

    // A session is proof only of its own account.
    const otherCookie = cookiePair(await issueSession('plan-proof-other'));
    const crossSession = await plan(`?accountId=${encodeURIComponent(ownerId)}`, {
      headers: { cookie: otherCookie },
    });
    expect(crossSession.status).toBe(403);
    expect(await crossSession.json()).toEqual({ error: 'Forbidden' });
  });

  it('serves the session caller its own plan without naming an account (SEC-A20)', async () => {
    const resolved = await (await resolveSubject('https://access.example.com', 'plan-session-own')).json() as {
      account: { accountId: string };
    };
    const cookie = cookiePair(await issueSession('plan-session-own'));

    const own = await identityStub().fetch('https://identity/accounts/plan', { headers: { cookie } });
    expect(own.status).toBe(200);
    expect(own.headers.get('cache-control')).toBe('no-store');
    expect(await own.json()).toMatchObject({ planId: 'free', limits: PLAN_CATALOG.free.limits });

    // Naming the caller's own account with the session is the same answer.
    const named = await identityStub().fetch(
      `https://identity/accounts/plan?accountId=${encodeURIComponent(resolved.account.accountId)}`,
      { headers: { cookie } },
    );
    expect(named.status).toBe(200);

    const noSession = await identityStub().fetch('https://identity/accounts/plan');
    expect(noSession.status).toBe(401);
  });

  it('answers GET /accounts/plan with the seeded personal plan and its limits', async () => {
    const response = await resolveSubject('https://access.example.com', 'plan-active-personal');
    const { account } = await response.json() as { account: { accountId: string } };

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      writeEntitlement(
        instance.db,
        {
          accountId: account.accountId,
          source: 'personal',
          state: {
            planId: 'tutor_pro_monthly',
            status: 'active',
            graceUntil: null,
            collectionPaused: false,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: 'cus_plan',
            processorSubscriptionId: 'sub_plan',
          },
          now: Date.now(),
        },
        {
          kind: 'operator',
          id: 'seed-active-personal',
          actor: 'test-operator',
          reason: 'seed paid state',
        },
      );
    });

    const plan = await planRequest(account.accountId);
    expect(plan.status).toBe(200);
    expect(await plan.json()).toEqual({
      planId: 'tutor_pro_monthly',
      source: 'personal',
      companyId: null,
      status: 'active',
      limits: PLAN_CATALOG.tutor_pro_monthly.limits,
      graceUntil: null,
      collectionPaused: false,
    });
  });

  it('entitles a past_due row only while now is before grace_until', async () => {
    const response = await resolveSubject('https://access.example.com', 'plan-grace');
    const { account } = await response.json() as { account: { accountId: string } };
    const graceUntil = Date.now() + 60_000;

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      writeEntitlement(
        instance.db,
        {
          accountId: account.accountId,
          source: 'personal',
          state: {
            planId: 'tutor_pro_annual',
            status: 'past_due',
            graceUntil,
            collectionPaused: false,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: null,
            processorSubscriptionId: 'sub_grace',
          },
          now: Date.now(),
        },
        {
          kind: 'processor_event',
          id: 'evt-grace-open',
          actor: 'stripe',
          reason: 'invoice.payment_failed',
        },
      );
    });

    const entitled = await (await planRequest(account.accountId)).json() as EffectivePlan;
    expect(entitled.planId).toBe('tutor_pro_annual');
    expect(entitled.graceUntil).toBe(graceUntil);
    expect(entitled.collectionPaused).toBe(false);

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      writeEntitlement(
        instance.db,
        {
          accountId: account.accountId,
          source: 'personal',
          state: {
            planId: 'tutor_pro_annual',
            status: 'past_due',
            graceUntil: Date.now() - 1,
            collectionPaused: false,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: null,
            processorSubscriptionId: 'sub_grace',
          },
          now: Date.now(),
        },
        {
          kind: 'grace_expiry',
          id: 'sub_grace:expired',
          actor: 'system:grace',
          reason: 'grace period ended',
        },
      );
    });

    const expired = await (await planRequest(account.accountId)).json() as EffectivePlan;
    expect(expired.planId).toBe('free');
    expect(expired.status).toBe('free');
    expect(expired.graceUntil).toBeNull();
    expect(expired.collectionPaused).toBe(false);
  });

  it('reports a paused collection on a plan that stopped entitling', async () => {
    const response = await resolveSubject('https://access.example.com', 'plan-paused');
    const { account } = await response.json() as { account: { accountId: string } };

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      writeEntitlement(
        instance.db,
        {
          accountId: account.accountId,
          source: 'personal',
          state: {
            planId: 'tutor_pro_monthly',
            status: 'active',
            graceUntil: null,
            collectionPaused: true,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: null,
            processorSubscriptionId: 'sub_paused',
          },
          now: Date.now(),
        },
        {
          kind: 'processor_event',
          id: 'evt-paused',
          actor: 'stripe',
          reason: 'dispute.created',
        },
      );
    });

    const plan = await planRequest(account.accountId);
    expect(plan.status).toBe(200);
    expect(await plan.json()).toEqual({
      planId: 'free',
      source: null,
      companyId: null,
      status: 'free',
      limits: PLAN_CATALOG.free.limits,
      graceUntil: null,
      collectionPaused: true,
    });
  });

  it('prefers an entitling company row over an entitling personal row', async () => {
    const response = await resolveSubject('https://access.example.com', 'plan-company');
    const { account } = await response.json() as { account: { accountId: string } };

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      instance.db
        .prepare(
          `INSERT INTO companies (company_id, name, created_at, updated_at)
           VALUES (?, ?, 1, 1)`,
        )
        .run('plan-company-row', 'Plan Company');
      writeEntitlement(
        instance.db,
        {
          accountId: account.accountId,
          source: 'personal',
          state: {
            planId: 'tutor_pro_monthly',
            status: 'active',
            graceUntil: null,
            collectionPaused: false,
            companyId: null,
            currentPeriodEnd: null,
            processorCustomerId: 'cus_plan',
            processorSubscriptionId: 'sub_personal',
          },
          now: Date.now(),
        },
        { kind: 'operator', id: 'seed-personal', actor: 'test-operator', reason: 'seed' },
      );
      writeEntitlement(
        instance.db,
        {
          accountId: account.accountId,
          source: 'company',
          state: {
            planId: 'corporate_seat',
            status: 'active',
            graceUntil: null,
            collectionPaused: false,
            companyId: 'plan-company-row',
            currentPeriodEnd: null,
            processorCustomerId: 'cus_company',
            processorSubscriptionId: 'sub_company',
          },
          now: Date.now(),
        },
        { kind: 'seat_operation', id: 'seed-company', actor: 'test-operator', reason: 'seed' },
      );
    });

    const plan = await planRequest(account.accountId);
    expect(plan.status).toBe(200);
    expect(await plan.json()).toEqual({
      planId: 'corporate_seat',
      source: 'company',
      companyId: 'plan-company-row',
      status: 'active',
      limits: PLAN_CATALOG.corporate_seat.limits,
      graceUntil: null,
      collectionPaused: false,
    });
  });

  it('rejects non-GET methods and malformed accountId on /accounts/plan', async () => {
    const [post, blank, oversized, badRoom] = await Promise.all([
      identityStub().fetch('https://identity/accounts/plan?accountId=x', { method: 'POST' }),
      identityStub().fetch('https://identity/accounts/plan?accountId=&roomId=room-a'),
      identityStub().fetch(`https://identity/accounts/plan?accountId=${'a'.repeat(129)}&roomId=room-a`),
      identityStub().fetch(`https://identity/accounts/plan?accountId=x&roomId=${'r'.repeat(65)}`),
    ]);

    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    expect(blank.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(badRoom.status).toBe(400);
  });

  it('refuses a new subject at the configured cap and creates no account', async () => {
    /*
     * The worker test harness raises TUTOR_ACCOUNT_CAP because storage is
     * shared per file; the exact boundary is proven in identityStore unit
     * tests, and this proves the DO reads the configured cap and passes it to
     * subject resolution. Seed the difference, then a brand-new subject is
     * refused and leaves no account or access_subjects row behind.
     */
    const cap = Number(env.TUTOR_ACCOUNT_CAP);
    expect(Number.isInteger(cap) && cap > 0, 'TUTOR_ACCOUNT_CAP must be configured').toBe(true);
    const subject = `tutor-cap-${crypto.randomUUID()}`;
    const prefix = `cap-seed-${crypto.randomUUID()}-`;
    const before = await runInDurableObject(identityStub(), (instance: IdentityDO) => (
      instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM accounts
           WHERE provenance = 'access' AND state = 'active'`,
        )
        .get() as { count: number }
    ).count);
    expect(
      before,
      `identity test file already has ${before} active access accounts; the cap is ${cap}`,
    ).toBeLessThan(cap);
    try {
      await runInDurableObject(identityStub(), (instance: IdentityDO) => {
        instance.db
          .prepare(
            `WITH RECURSIVE seed(n) AS (
               SELECT 1 UNION ALL SELECT n + 1 FROM seed WHERE n < ?
             )
             INSERT INTO accounts (
               account_id, state, authorization_epoch, created_at, updated_at, provenance
             )
             SELECT ? || n, 'active', 0, 1, 1, 'access' FROM seed`,
          )
          .run(cap - before, prefix);
      });

      const response = await resolveSubject('https://access.example.com', subject);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Tutor account cap reached' });
      expect(
        await runInDurableObject(identityStub(), (instance: IdentityDO) => (
          instance.db
            .prepare(`SELECT COUNT(*) AS count FROM access_subjects WHERE subject = ?`)
            .get(subject) as { count: number }
        ).count),
      ).toBe(0);
    } finally {
      await runInDurableObject(identityStub(), (instance: IdentityDO) => {
        instance.db
          .prepare(`DELETE FROM accounts WHERE account_id LIKE ? || '%'`)
          .run(prefix);
      });
    }
  });
});

describe('IdentityDO negative routing contract', () => {
  function identityFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return identityStub().fetch(`https://identity${path}`, init);
  }

  function jsonInit(method: string, body?: string, cookie?: string): RequestInit {
    return {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body }),
    };
  }

  it('rejects non-object JSON bodies on every guarded route', async () => {
    const issued = await issueSession('do-negative-body-shapes');
    const cookie = cookiePair(issued);
    const routes: Array<[string, string]> = [
      ['/subjects/resolve', 'POST'],
      ['/sessions/issue', 'POST'],
      ['/sessions/authorize', 'POST'],
      ['/sessions/confirm', 'POST'],
      ['/sessions/authorize-guest', 'POST'],
      ['/accounts/authorizations', 'POST'],
      ['/accounts/revoke-all', 'POST'],
      ['/accounts/disable', 'POST'],
      ['/accounts/enable', 'POST'],
      ['/accounts/profile', 'PATCH'],
      ['/accounts/rooms', 'POST'],
      ['/accounts/rooms', 'DELETE'],
      ['/accounts/rooms/touch', 'POST'],
      ['/accounts/clear-erasure', 'POST'],
      ['/guests/issue', 'POST'],
      ['/guests/purge', 'POST'],
      ['/billing/events/apply', 'POST'],
      ['/billing/operations', 'POST'],
      ['/billing/operations/settle', 'POST'],
      ['/billing/settle', 'POST'],
      ['/billing/reconcile', 'POST'],
      ['/referrals/validate', 'POST'],
      ['/companies', 'POST'],
      ['/operator/invoice-approval', 'POST'],
      ['/operator/invoice-approval/settle', 'POST'],
      ['/operator/disputes/review', 'POST'],
    ];
    const shapes: unknown[] = [null, [1, 2], 'plain-text'];
    for (const [path, method] of routes) {
      for (const shape of shapes) {
        const response = await identityFetch(
          path,
          jsonInit(method, JSON.stringify(shape), cookie),
        );
        expect(response.status, `${method} ${path} ${JSON.stringify(shape)}`).toBe(400);
      }
    }
  });

  it('requires a session on every anonymous owner-scoped route', async () => {
    const routes: Array<{ path: string; method: string; body?: string }> = [
      { path: '/accounts/pending-erasures', method: 'GET' },
      { path: '/accounts/clear-erasure', method: 'POST', body: '{}' },
      { path: '/billing/rate-limit', method: 'POST' },
      { path: '/billing/customer', method: 'GET' },
      { path: '/referrals/me?baseUrl=https%3A%2F%2Fexample.com', method: 'GET' },
      { path: '/referrals/validate', method: 'POST', body: '{}' },
      { path: '/companies', method: 'GET' },
      { path: '/companies', method: 'PATCH', body: '{}' },
      { path: '/companies', method: 'DELETE' },
      { path: '/companies', method: 'POST', body: '{}' },
      { path: '/companies/customer', method: 'POST', body: '{}' },
      { path: '/companies/invites', method: 'POST', body: '{}' },
      { path: '/companies/invites', method: 'DELETE', body: '{}' },
      { path: '/companies/invites/redeem', method: 'POST', body: '{}' },
      { path: '/companies/seats', method: 'POST', body: '{}' },
      { path: '/companies/seats/settle', method: 'POST', body: '{}' },
      { path: '/companies/members/revoke', method: 'POST', body: '{}' },
      { path: '/companies/owner', method: 'POST', body: '{}' },
      {
        path: '/sessions/authorize-guest',
        method: 'POST',
        body: JSON.stringify({ roomId: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }),
      },
      {
        path: '/sessions/confirm',
        method: 'POST',
        body: JSON.stringify({
          issuer: 'https://access.example.com',
          subject: 'anonymous-confirm',
        }),
      },
      { path: '/sessions/rotate', method: 'POST' },
    ];
    for (const route of routes) {
      const response = await identityFetch(
        route.path,
        jsonInit(route.method, route.body),
      );
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('answers 405 for the wrong method on every routed path', async () => {
    const routes: Array<[string, string]> = [
      ['/subjects/resolve', 'GET'],
      ['/sessions/issue', 'GET'],
      ['/sessions/current', 'POST'],
      ['/sessions/authorize', 'GET'],
      ['/sessions/authorize-guest', 'GET'],
      ['/sessions/confirm', 'GET'],
      ['/sessions/rotate', 'GET'],
      ['/sessions/logout', 'GET'],
      ['/accounts/authorizations', 'GET'],
      ['/accounts/pending-erasures', 'POST'],
      ['/accounts/clear-erasure', 'GET'],
      ['/accounts/profile', 'GET'],
      ['/accounts/rooms/touch', 'GET'],
      ['/accounts/rooms/archive-state', 'POST'],
      ['/accounts/revoke-all', 'GET'],
      ['/accounts/disable', 'GET'],
      ['/accounts/enable', 'GET'],
      ['/billing/events/apply', 'GET'],
      ['/billing/events/status', 'POST'],
      ['/billing/operations', 'GET'],
      ['/billing/operations/settle', 'GET'],
      ['/billing/settle', 'GET'],
      ['/billing/reconcile', 'PUT'],
      ['/billing/rate-limit', 'GET'],
      ['/billing/customer', 'POST'],
      ['/referrals/me', 'POST'],
      ['/referrals/validate', 'GET'],
      ['/companies/membership', 'POST'],
      ['/companies', 'PUT'],
      ['/companies/customer', 'GET'],
      ['/companies/invites', 'GET'],
      ['/companies/invites/redeem', 'GET'],
      ['/companies/seats', 'GET'],
      ['/companies/seats/settle', 'GET'],
      ['/companies/members/revoke', 'GET'],
      ['/companies/owner', 'GET'],
      ['/operator/invoice-approval', 'GET'],
      ['/operator/invoice-approval/settle', 'GET'],
      ['/operator/disputes/review', 'GET'],
    ];
    for (const [path, method] of routes) {
      const response = await identityFetch(path, jsonInit(method));
      expect(response.status, `${method} ${path}`).toBe(405);
    }
  });

  it('refuses malformed session rotation, logout, and confirmation requests', async () => {
    const mine = await issueSession('do-negative-confirm-mine');
    const mineCookie = cookiePair(mine);
    const response = await identityFetch('/sessions/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: mineCookie },
      body: JSON.stringify({
        issuer: 'https://access.example.com',
        subject: 'do-negative-confirm-someone-else',
      }),
    });
    expect(response.status).toBe(401);

    const rotateWithBody = await identityFetch('/sessions/rotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: mineCookie },
      body: '{}',
    });
    expect(rotateWithBody.status).toBe(400);

    const logoutWithBody = await identityFetch('/sessions/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: mineCookie },
      body: '{}',
    });
    expect(logoutWithBody.status).toBe(400);
  });

  it('rejects invalid profile, room, and account-operation bodies', async () => {
    const issued = await issueSession('do-negative-body-fields');
    const cookie = cookiePair(issued);

    const controlName = await identityFetch('/accounts/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ displayName: '\u0001' }),
    });
    expect(controlName.status).toBe(400);

    const longName = await identityFetch('/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'negative-room-name', name: 'n'.repeat(101) }),
    });
    expect(longName.status).toBe(400);

    const typedName = await identityFetch('/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'negative-room-type', name: 5 }),
    });
    expect(typedName.status).toBe(400);

    const missingRoom = await identityFetch('/accounts/rooms', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(missingRoom.status).toBe(400);

    const badTouch = await identityFetch('/accounts/rooms/touch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'missing-account', roomId: '../etc' }),
    });
    expect(badTouch.status).toBe(400);

    const unknownTouch = await identityFetch('/accounts/rooms/touch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'missing-account', roomId: 'touch-missing' }),
    });
    expect(unknownTouch.status).toBe(200);
    expect(await unknownTouch.json()).toEqual({ ok: true, touched: false });

    const badClear = await identityFetch('/accounts/clear-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(badClear.status).toBe(400);

    const missingAccount = await identityFetch('/accounts/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-that-does-not-exist', actor: 'ops', reason: 'test' }),
    });
    expect(missingAccount.status).toBe(404);

    const blankSubject = await identityFetch('/subjects/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer: '   ', subject: 'negative-blank' }),
    });
    expect(blankSubject.status).toBe(400);

    const blankIssue = await identityFetch('/sessions/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer: '   ', subject: 'negative-blank' }),
    });
    expect(blankIssue.status).toBe(401);
  });

  it('validates the session batch of an authorization read', async () => {
    const hash = 'a'.repeat(64);
    const rejected: unknown[] = [
      { accountIds: [], sessions: 'not-an-array' },
      {
        accountIds: [],
        sessions: Array.from({ length: 501 }, (_, index) => ({
          accountId: `account-${index}`,
          sessionHash: hash,
        })),
      },
      { accountIds: [], sessions: [null] },
      { accountIds: [], sessions: [{ accountId: 'account-a', sessionHash: hash, extra: true }] },
    ];
    for (const body of rejected) {
      const response = await identityFetch('/accounts/authorizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }

    const accepted = await identityFetch('/accounts/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountIds: [], sessions: [] }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accounts: {}, activeSessionHashes: [] });
  });

  it('breaks owned-room archive ties by room id', async () => {
    const issued = await issueSession('do-archive-tie-break');
    const { accountId } = await issued.json() as { accountId: string };
    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      for (let index = 0; index < 12; index += 1) {
        instance.db
          .prepare(
            `INSERT INTO account_rooms (
               account_id, room_id, role, name, created_at, updated_at
             ) VALUES (?, ?, 'owner', NULL, 1, 1)`,
          )
          .run(accountId, `archive-tie-${String(index).padStart(2, '0')}`);
      }
    });

    const response = await identityFetch(
      `/accounts/rooms/archive-state?accountId=${encodeURIComponent(accountId)}&roomId=archive-tie-05`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: true });
  });

  it('refuses malformed billing documents', async () => {
    const issued = await issueSession('do-negative-billing');
    const cookie = cookiePair(issued);
    const rejected: Array<[string, string]> = [
      ['/billing/events/apply', ''],
      ['/billing/events/apply', 'not-json'],
      [
        '/billing/events/apply',
        JSON.stringify({ signatureVerified: true, payloadHash: 'a'.repeat(64), event: 5 }),
      ],
      ['/billing/operations', ''],
      ['/billing/operations', 'not-json'],
      [
        '/billing/operations',
        JSON.stringify({ subjectKind: 'other', subjectId: 's', operationId: 'o', kind: 'checkout' }),
      ],
      [
        '/billing/operations',
        JSON.stringify({ subjectKind: 'account', subjectId: '', operationId: 'o', kind: 'checkout' }),
      ],
      [
        '/billing/operations',
        JSON.stringify({ subjectKind: 'account', subjectId: 's', operationId: 'o', kind: 'bogus' }),
      ],
      [
        '/billing/operations',
        JSON.stringify({
          subjectKind: 'account',
          subjectId: 's',
          operationId: 'o',
          kind: 'checkout',
          stripeObjectId: 5,
        }),
      ],
      ['/billing/operations/settle', ''],
      ['/billing/operations/settle', 'not-json'],
      ['/billing/operations/settle', 'null'],
      [
        '/billing/operations/settle',
        JSON.stringify({ subjectKind: 'other', subjectId: 's', operationId: 'o' }),
      ],
      [
        '/billing/operations/settle',
        JSON.stringify({ subjectKind: 'account', subjectId: '', operationId: 'o' }),
      ],
      [
        '/billing/operations/settle',
        JSON.stringify({ subjectKind: 'account', subjectId: 's', operationId: '' }),
      ],
      [
        '/billing/operations/settle',
        JSON.stringify({ subjectKind: 'account', subjectId: 's', operationId: 'o', success: 'yes' }),
      ],
      [
        '/billing/operations/settle',
        JSON.stringify({
          subjectKind: 'account',
          subjectId: 's',
          operationId: 'o',
          actualCollectionState: 'bogus',
        }),
      ],
      [
        '/billing/operations/settle',
        JSON.stringify({
          subjectKind: 'account',
          subjectId: 's',
          operationId: 'o',
          expectedVersion: '1',
        }),
      ],
      ['/billing/settle', ''],
      ['/billing/settle', 'not-json'],
      ['/billing/settle', '[]'],
      [
        '/billing/settle',
        JSON.stringify({ kind: 'seat-change', companyId: 'c', operationId: 'o', outcome: 'bogus' }),
      ],
      [
        '/billing/settle',
        JSON.stringify({
          kind: 'company-create',
          companyId: 'c',
          operationId: 'o',
          processorCustomerId: 'bad',
        }),
      ],
      [
        '/billing/settle',
        JSON.stringify({ kind: 'seat-change', companyId: '', operationId: 'o', outcome: 'success' }),
      ],
      [
        '/billing/settle',
        JSON.stringify({
          kind: 'seat-change',
          companyId: 'c',
          operationId: 'o',
          outcome: 'success',
          extra: 1,
        }),
      ],
      ['/billing/reconcile', ''],
      ['/billing/reconcile', 'not-json'],
      ['/billing/reconcile', JSON.stringify('x')],
      ['/billing/reconcile', JSON.stringify({ runId: 'bad id!' })],
      ['/billing/reconcile', JSON.stringify({ observations: 'x' })],
      ['/billing/reconcile', JSON.stringify({ observations: [{}] })],
      ['/billing/reconcile', JSON.stringify({ disputes: 'x' })],
      ['/billing/reconcile', JSON.stringify({ disputes: [{}] })],
      ['/billing/reconcile', JSON.stringify({ extra: true })],
    ];
    for (const [path, body] of rejected) {
      const response = await identityFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status, `${path} ${body}`).toBe(400);
    }

    const missingId = await identityFetch('/billing/events/status');
    expect(missingId.status).toBe(400);

    const rateLimitWithBody = await identityFetch('/billing/rate-limit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    expect(rateLimitWithBody.status).toBe(400);
  });

  it('answers a subscription-collection operation without a subscription row', async () => {
    const response = await identityFetch('/billing/operations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectKind: 'account',
        subjectId: 'account-without-a-subscription',
        operationId: 'op_without_a_subscription',
        kind: 'subscription-collection',
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      claim: {
        claimed: false,
        inFlightVersion: null,
        inFlightState: null,
        processorSubscriptionId: null,
      },
    });
  });

  it('validates operator invoice, settlement, and dispute bodies', async () => {
    const operator = 'ops@example.test';
    const rejected: Array<[string, unknown]> = [
      ['/operator/invoice-approval', {}],
      [
        '/operator/invoice-approval',
        { operatorEmail: operator, companyId: 'company', quantity: 0, operationId: 'op_a' },
      ],
      [
        '/operator/invoice-approval',
        { operatorEmail: 'ab', companyId: 'company', quantity: 10, operationId: 'op_a' },
      ],
      [
        '/operator/invoice-approval',
        { operatorEmail: operator, companyId: 'company', quantity: 10, operationId: 'op_a', extra: 1 },
      ],
      ['/operator/invoice-approval/settle', {}],
      [
        '/operator/invoice-approval/settle',
        {
          operatorEmail: operator,
          companyId: 'company',
          operationId: 'op_a',
          quantity: 10,
          outcome: 'failure',
          extra: 1,
        },
      ],
      [
        '/operator/invoice-approval/settle',
        { operatorEmail: operator, companyId: 'company', operationId: 'op_a', quantity: 5, outcome: 'failure' },
      ],
      [
        '/operator/invoice-approval/settle',
        { operatorEmail: operator, companyId: 'company', operationId: 'op_a', quantity: 10, outcome: 'bogus' },
      ],
      [
        '/operator/invoice-approval/settle',
        { operatorEmail: operator, companyId: 'company', operationId: 'op_a', quantity: 10, outcome: 'success' },
      ],
      [
        '/operator/invoice-approval/settle',
        {
          operatorEmail: operator,
          companyId: 'company',
          operationId: 'op_a',
          quantity: 10,
          outcome: 'success',
          processorSubscriptionId: 'sub_ok',
          status: 'bogus',
        },
      ],
      [
        '/operator/invoice-approval/settle',
        {
          operatorEmail: operator,
          companyId: 'company',
          operationId: 'op_a',
          quantity: 10,
          outcome: 'failure',
          currentPeriodEnd: 'later',
        },
      ],
      [
        '/operator/invoice-approval/settle',
        {
          operatorEmail: operator,
          companyId: 'company',
          operationId: 'op_a',
          quantity: 10,
          outcome: 'failure',
          hostedInvoiceUrl: 'h'.repeat(2_049),
        },
      ],
      ['/operator/disputes/review', {}],
      [
        '/operator/disputes/review',
        { operatorEmail: operator, disputeId: 'dispute', outcome: 'maybe', operationId: 'op_a' },
      ],
    ];
    for (const [path, body] of rejected) {
      const response = await identityFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }

    const unknownInvoice = await identityFetch('/operator/invoice-approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operatorEmail: operator,
        companyId: 'company-that-does-not-exist',
        quantity: 10,
        operationId: 'op_unknown_company',
      }),
    });
    expect(unknownInvoice.status).toBe(404);

    const unknownDispute = await identityFetch('/operator/disputes/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operatorEmail: operator,
        disputeId: 'dispute-that-does-not-exist',
        outcome: 'won',
        operationId: 'op_unknown_dispute',
      }),
    });
    expect(unknownDispute.status).toBe(404);

    const foreignOperator = await identityFetch('/operator/invoice-approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operatorEmail: 'intruder@example.test',
        companyId: 'company',
        quantity: 10,
        operationId: 'op_foreign',
      }),
    });
    expect(foreignOperator.status).toBe(403);
  });

  it('answers the empty erasure and unknown-route edges', async () => {
    const issued = await issueSession('do-negative-erasure-edges');
    const cookie = cookiePair(issued);

    const pending = await identityFetch('/accounts/pending-erasures', {
      headers: { cookie },
    });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ roomIds: [] });

    const cleared = await identityFetch('/accounts/clear-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'clear-erasure-missing' }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });

    const invalidTarget = await identityFetch('/accounts/clear-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: '../etc' }),
    });
    expect(invalidTarget.status).toBe(400);

    const wrongRoomMethod = await identityFetch('/accounts/rooms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(wrongRoomMethod.status).toBe(405);

    const anonymousLogout = await identityFetch('/sessions/logout', {
      method: 'POST',
    });
    expect(anonymousLogout.status).toBe(204);

    const unknownRoute = await identityFetch('/not-a-real-route');
    expect(unknownRoute.status).toBe(404);
  });
});
