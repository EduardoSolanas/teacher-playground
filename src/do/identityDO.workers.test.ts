import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import {
  GLOBAL_IDENTITY_OBJECT_NAME,
  getIdentityObject,
  type IdentityDO,
} from './IdentityDO';
import {
  SESSION_COOKIE_NAME,
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
    expect(path.status).toBe(404);
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

    expect(response.status).toBe(401);
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
    expect(responses.every((response) => response.status === 401)).toBe(true);
  });
});
