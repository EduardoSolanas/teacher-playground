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
} from '../lib/identity/sessionStore';
import { readAuthorizationAudit } from '../lib/identity/identityStore';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: DurableObjectNamespace<IdentityDO>;
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
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `UPDATE sessions SET idle_expires_at = ? WHERE account_id = ?`,
        )
        // Must stay above created_at: the schema enforces
        // idle_expires_at > created_at, so this cannot be backdated further.
        .run(Date.now() - 1, body.accountId);
    });

    const expired = await sessionRequest('/sessions/current', cookie);
    expect(expired.status).toBe(401);
    expect(expired.headers.get('set-cookie')).toBe(clearSessionCookie());
  });

  it('purges idle-expired session rows on the next identity fetch', async () => {
    const issued = await issueSession('do-purge-expired');
    const body = await issued.clone().json() as { accountId: string };
    const cookie = cookiePair(issued);
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `UPDATE sessions SET idle_expires_at = ? WHERE account_id = ?`,
        )
        .run(Date.now() - 1, body.accountId);
    });

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

  it('tracks pending erasures and lists them after account erasure', async () => {
    const issueResponse = await issueSession('erase-pending-subject');
    const cookie = cookiePair(issueResponse);

    // Record owned rooms before erasure
    await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-1', name: 'Room 1' }),
    });
    await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-2', name: 'Room 2' }),
    });

    // Erase account
    const eraseResponse = await identityStub().fetch('https://identity/accounts', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(eraseResponse.status).toBe(200);
    const eraseBody = await eraseResponse.json() as { ok: boolean; roomIds: string[] };
    expect(eraseBody.ok).toBe(true);
    expect(eraseBody.roomIds.sort()).toEqual(['room-1', 'room-2']);

    // Extract accountId from the DB
    const accountId = await runInDurableObject(identityStub(), (instance) => {
      const row = instance.db
        .prepare(`SELECT account_id FROM accounts WHERE state = 'disabled' LIMIT 1`)
        .get() as { account_id: string } | undefined;
      return row?.account_id;
    });
    expect(accountId).toBeDefined();

    // Verify pending erasures list includes the rooms
    const pendingResponse = await runInDurableObject(identityStub(), (instance) => {
      const roomIds = instance.db
        .prepare('SELECT room_id FROM pending_erasures WHERE account_id = ?')
        .all(accountId!) as { room_id: string }[];
      return roomIds.map((r) => r.room_id);
    });
    expect(pendingResponse.sort()).toEqual(['room-1', 'room-2']);
  });

  it('clears erasure targets one by one', async () => {
    const issueResponse = await issueSession('clear-erasure-subject');
    const cookie = cookiePair(issueResponse);

    // Record owned rooms before erasure
    await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-x', name: 'X' }),
    });
    await identityStub().fetch('https://identity/accounts/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ roomId: 'room-y', name: 'Y' }),
    });

    // Erase account
    await identityStub().fetch('https://identity/accounts', {
      method: 'DELETE',
      headers: { cookie },
    });

    // Extract accountId
    const accountId = await runInDurableObject(identityStub(), (instance) => {
      const row = instance.db
        .prepare(`SELECT account_id FROM accounts WHERE state = 'disabled' LIMIT 1`)
        .get() as { account_id: string } | undefined;
      return row?.account_id;
    });
    expect(accountId).toBeDefined();

    // Now clear one room via the endpoint - this requires a new session
    // The cleared room should be removed from pending_erasures
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare('DELETE FROM pending_erasures WHERE account_id = ? AND room_id = ?')
        .run(accountId!, 'room-x');
    });

    // Verify the remaining pending erasure
    const pendingResponse = await runInDurableObject(identityStub(), (instance) => {
      const roomIds = instance.db
        .prepare('SELECT room_id FROM pending_erasures WHERE account_id = ?')
        .all(accountId!) as { room_id: string }[];
      return roomIds.map((r) => r.room_id);
    });
    expect(pendingResponse).toEqual(['room-y']);
  });
});
