import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './do/IdentityDO';
import type { RoomDO } from './do/RoomDO';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  localAccessToken,
  type LocalAuthSession,
} from './test/workerAuth';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: DurableObjectNamespace<IdentityDO>;
      ADMIN_EMAILS?: string;
    }
  }
}

const TEACHER_BASE = 'https://example.com';
const GUEST_BASE = 'https://join.example.com';
const MARKETING_BASE = 'https://www.example.com';
const ADMIN_USERS_API = '/api/admin/users';
const ADMIN_ERRORS_API = '/api/admin/errors';
const ADMIN_EMAIL = 'admin@example.test';

function identityStub() {
  return getIdentityObject(env.IDENTITY);
}

function configuredAdminEmails(): string | undefined {
  return (env as unknown as { ADMIN_EMAILS?: string }).ADMIN_EMAILS;
}

/**
 * The admin allowlist is checked against the Access-verified principal email,
 * so the session under test must be bootstrapped from a token minted with that
 * email claim — the same way the operator tests reach the operator surface.
 */
async function bootstrapSessionWithEmail(
  subject: string,
  email: string,
): Promise<LocalAuthSession> {
  const token = await localAccessToken(subject, 'valid', undefined, email);
  const response = await SELF.fetch(`${TEACHER_BASE}/auth/session`, {
    method: 'POST',
    headers: { Origin: TEACHER_BASE, 'Cf-Access-Jwt-Assertion': token },
  });
  if (response.status !== 201) {
    throw new Error(`admin session bootstrap failed: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('admin session bootstrap did not set a cookie');
  const body = (await response.json()) as { accountId: string };
  return { subject, token, cookie: setCookie.split(';', 1)[0], accountId: body.accountId };
}

interface AdminAccountRow {
  accountId: string;
  state: string;
  provenance: string;
  displayName: string | null;
  organisation: string | null;
  plan: string | null;
  planStatus: string | null;
  rooms: number;
  createdAt: number;
  updatedAt: number;
}

interface AdminUsersPayload {
  accounts: AdminAccountRow[];
  total: number;
  nextCursor?: { createdAt: number; accountId: string } | null;
}

describe('Worker GET /api/admin/errors', () => {
  it('answers 401 to an Access-verified caller with no local session', async () => {
    const token = await localAccessToken('admin-errors-anon', 'valid', undefined, ADMIN_EMAIL);
    const response = await SELF.fetch(`${TEACHER_BASE}${ADMIN_ERRORS_API}`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 403 to a valid session whose verified email is not allowlisted', async () => {
    const outsider = await bootstrapLocalSession('admin-errors-outsider');
    const response = await authenticatedFetch(ADMIN_ERRORS_API, outsider);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });

    const wrongEmail = await bootstrapSessionWithEmail(
      'admin-errors-wrong-email',
      'outsider@example.test',
    );
    const denied = await authenticatedFetch(ADMIN_ERRORS_API, wrongEmail);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Forbidden' });
  });

  it('hides the surface entirely when ADMIN_EMAILS is unset', async () => {
    const admin = await bootstrapSessionWithEmail('admin-errors-disabled', ADMIN_EMAIL);
    const original = configuredAdminEmails();
    (env as unknown as { ADMIN_EMAILS?: string }).ADMIN_EMAILS = undefined;
    try {
      const response = await authenticatedFetch(ADMIN_ERRORS_API, admin);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found' });
    } finally {
      (env as unknown as { ADMIN_EMAILS?: string }).ADMIN_EMAILS = original;
    }
  });

  it('answers 405 to a non-GET method', async () => {
    const admin = await bootstrapSessionWithEmail('admin-errors-method', ADMIN_EMAIL);
    const response = await authenticatedFetch(ADMIN_ERRORS_API, admin, { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('returns identity errors with source identity, newest first, and no-store', async () => {
    const admin = await bootstrapSessionWithEmail('admin-errors-shape', ADMIN_EMAIL);
    await runInDurableObject(identityStub(), (instance) => {
      instance.db.prepare(`DELETE FROM identity_error_ring`).run();
      instance.db
        .prepare(`INSERT INTO identity_error_ring (at, scope, message) VALUES (?, ?, ?)`)
        .run(1000, 'billing:apply', 'older identity failure');
      instance.db
        .prepare(`INSERT INTO identity_error_ring (at, scope, message) VALUES (?, ?, ?)`)
        .run(2000, 'billing:reconcile', 'newer identity failure');
    });

    const response = await authenticatedFetch(ADMIN_ERRORS_API, admin);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      errors: {
        at: number;
        scope: string;
        message: string;
        source: string;
        roomId?: string;
      }[];
    };
    expect(body.errors).toEqual([
      {
        at: 2000,
        scope: 'billing:reconcile',
        message: 'newer identity failure',
        source: 'identity',
      },
      {
        at: 1000,
        scope: 'billing:apply',
        message: 'older identity failure',
        source: 'identity',
      },
    ]);
  });

  it('merges one room’s ring when roomId is given, room rows carrying their room id', async () => {
    const admin = await bootstrapSessionWithEmail('admin-errors-room', ADMIN_EMAIL);
    const roomId = 'admin-errors-ring-room';
    // Worker test storage is shared per file: clear both rings so the exact
    // merged shape below has no leftovers from the other tests in this file.
    await runInDurableObject(identityStub(), (instance) => {
      instance.db.prepare(`DELETE FROM identity_error_ring`).run();
    });
    await runInDurableObject(
      env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomDO>,
      (instance) => {
        instance.db.prepare(`DELETE FROM error_ring`).run();
        instance.db
          .prepare(`INSERT INTO error_ring (at, scope, message) VALUES (?, ?, ?)`)
          .run(3000, 'flushProjection', 'room failure');
      },
    );
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(`INSERT INTO identity_error_ring (at, scope, message) VALUES (?, ?, ?)`)
        .run(1000, 'billing:apply', 'identity failure');
    });

    const response = await authenticatedFetch(
      `${ADMIN_ERRORS_API}?roomId=${encodeURIComponent(roomId)}`,
      admin,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      errors: {
        at: number;
        scope: string;
        message: string;
        source: string;
        roomId?: string;
      }[];
    };
    expect(body.errors).toEqual([
      {
        at: 3000,
        scope: 'flushProjection',
        message: 'room failure',
        source: 'room',
        roomId,
      },
      {
        at: 1000,
        scope: 'billing:apply',
        message: 'identity failure',
        source: 'identity',
      },
    ]);
  });

  it('refuses an invalid roomId with 400 before any DO is touched', async () => {
    const admin = await bootstrapSessionWithEmail('admin-errors-bad-room', ADMIN_EMAIL);
    const response = await authenticatedFetch(
      `${ADMIN_ERRORS_API}?roomId=${encodeURIComponent('../etc/passwd')}`,
      admin,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid roomId' });
  });

  it('answers an unknown roomId with identity errors only, not an error', async () => {
    const admin = await bootstrapSessionWithEmail('admin-errors-empty-room', ADMIN_EMAIL);
    const response = await authenticatedFetch(
      `${ADMIN_ERRORS_API}?roomId=${encodeURIComponent('never-created-ring-room')}`,
      admin,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      errors: { source: string }[];
    };
    for (const row of body.errors) {
      expect(row.source).toBe('identity');
    }
  });
});

describe('Worker GET /api/admin/users', () => {
  it('answers 401 to an Access-verified caller with no local session', async () => {
    // The guard runs before the session check, so the Access principal must
    // carry the allowlisted email for the missing session to be what is
    // observed. The same issuer flow as accessFetch, with the email claim.
    const token = await localAccessToken('admin-users-anon', 'valid', undefined, ADMIN_EMAIL);
    const response = await SELF.fetch(`${TEACHER_BASE}${ADMIN_USERS_API}`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 403 to a valid session whose verified email is not allowlisted', async () => {
    // No email claim on this token: the verified principal has no email at all,
    // which must never satisfy the allowlist.
    const outsider = await bootstrapLocalSession('admin-users-outsider');
    const response = await authenticatedFetch(ADMIN_USERS_API, outsider);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });

    const wrongEmail = await bootstrapSessionWithEmail(
      'admin-users-wrong-email',
      'outsider@example.test',
    );
    const denied = await authenticatedFetch(ADMIN_USERS_API, wrongEmail);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Forbidden' });
  });

  it('hides the surface entirely when ADMIN_EMAILS is unset', async () => {
    const admin = await bootstrapSessionWithEmail('admin-users-disabled', ADMIN_EMAIL);
    const original = configuredAdminEmails();
    (env as unknown as { ADMIN_EMAILS?: string }).ADMIN_EMAILS = undefined;
    try {
      const response = await authenticatedFetch(ADMIN_USERS_API, admin);
      expect(response.status).toBe(404);
      // The exact body matters: a generic hostNotFound 404 has no JSON body.
      expect(await response.json()).toEqual({ error: 'Not found' });
    } finally {
      (env as unknown as { ADMIN_EMAILS?: string }).ADMIN_EMAILS = original;
    }
  });

  it('lists accounts for an allowlisted admin in the pinned contract shape', async () => {
    const admin = await bootstrapSessionWithEmail('admin-users-allowlisted', ADMIN_EMAIL);
    const response = await authenticatedFetch(ADMIN_USERS_API, admin);
    expect(response.status).toBe(200);

    const body = (await response.json()) as AdminUsersPayload;
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBeGreaterThanOrEqual(1);

    const row = body.accounts.find((entry) => entry.accountId === admin.accountId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      state: 'active',
      provenance: 'access',
      displayName: null,
    });
    for (const entry of body.accounts.slice(0, 200)) {
      expect(Object.keys(entry).sort()).toEqual([
        'accountId',
        'createdAt',
        'displayName',
        'organisation',
        'plan',
        'planStatus',
        'provenance',
        'rooms',
        'state',
        'updatedAt',
      ]);
    }
  });

  it('lists two seeded accounts with the newest first', async () => {
    const admin = await bootstrapSessionWithEmail('admin-users-ordering-admin', ADMIN_EMAIL);
    const second = await bootstrapLocalSession('admin-users-ordering-second');

    // Both bootstraps can land in the same millisecond; push the admin's row
    // back so "createdAt descending" has an unambiguous answer on the real table.
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(`UPDATE accounts SET created_at = created_at - 5000 WHERE account_id = ?`)
        .run(admin.accountId);
    });

    const response = await authenticatedFetch(ADMIN_USERS_API, admin);
    expect(response.status).toBe(200);
    const body = (await response.json()) as AdminUsersPayload;
    const ids = body.accounts.map((entry) => entry.accountId);
    expect(ids).toContain(admin.accountId);
    expect(ids).toContain(second.accountId);
    expect(ids.indexOf(second.accountId)).toBeLessThan(ids.indexOf(admin.accountId));
  });
});

describe('Worker GET /api/admin/users pagination and search', () => {
  async function seedAccounts(count: number, prefix: string, nameOf?: (index: number) => string | null) {
    const base = Date.now() + 60_000;
    await runInDurableObject(identityStub(), (instance) => {
      const insert = instance.db.prepare(
        `INSERT INTO accounts (account_id, state, authorization_epoch, created_at, updated_at, provenance, preferred_display_name)
         VALUES (?, 'active', 0, ?, ?, 'access', ?)`,
      );
      for (let index = 0; index < count; index += 1) {
        insert.run(
          `${prefix}-${String(index).padStart(4, '0')}`,
          base + index,
          base + index,
          nameOf ? nameOf(index) : null,
        );
      }
    });
  }

  function cursorParam(cursor: { createdAt: number; accountId: string }): string {
    return encodeURIComponent(JSON.stringify(cursor));
  }

  it('walks 250 seeded accounts as a 200-row page plus a 50-row page', async () => {
    const admin = await bootstrapSessionWithEmail('admin-page-walk', ADMIN_EMAIL);
    await seedAccounts(250, 'walk-seed');

    const page1 = await authenticatedFetch(ADMIN_USERS_API, admin);
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as AdminUsersPayload;
    expect(body1.total).toBeGreaterThanOrEqual(250);
    expect(body1.accounts).toHaveLength(200);
    expect(body1.nextCursor).toEqual({
      createdAt: body1.accounts[199].createdAt,
      accountId: body1.accounts[199].accountId,
    });
    expect(body1.accounts.every((row) => row.accountId.startsWith('walk-seed-'))).toBe(true);

    const page2 = await authenticatedFetch(
      `${ADMIN_USERS_API}?cursor=${cursorParam(body1.nextCursor!)}`,
      admin,
    );
    expect(page2.status).toBe(200);
    const body2 = (await page2.json()) as AdminUsersPayload;
    expect(body2.total).toBe(body1.total);
    const page1Ids = new Set(body1.accounts.map((row) => row.accountId));
    for (const row of body2.accounts) {
      expect(page1Ids.has(row.accountId)).toBe(false);
    }
    const seededPage2 = body2.accounts.filter((row) => row.accountId.startsWith('walk-seed-'));
    expect(seededPage2).toHaveLength(50);
    expect(body2.nextCursor).toBeNull();
  });

  it('answers 400 to a cursor that is not a well-formed JSON object', async () => {
    const admin = await bootstrapSessionWithEmail('admin-page-bad-cursor', ADMIN_EMAIL);
    for (const cursor of ['not-json', encodeURIComponent('["x"]'), encodeURIComponent('{"createdAt":"soon","accountId":"a"}')]) {
      const response = await authenticatedFetch(`${ADMIN_USERS_API}?cursor=${cursor}`, admin);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid cursor' });
    }
  });

  it('searches display names case-insensitively through the route and misses on no match', async () => {
    const admin = await bootstrapSessionWithEmail('admin-page-search', ADMIN_EMAIL);
    await seedAccounts(3, 'search-seed', (index) =>
      index === 0 ? 'Ada Lovelace' : index === 1 ? 'ada grant' : 'Grace Hopper');

    const hit = await authenticatedFetch(`${ADMIN_USERS_API}?search=ada`, admin);
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as AdminUsersPayload;
    const adaRows = hitBody.accounts.filter((row) => row.displayName !== null
      && row.displayName.toLowerCase().includes('ada'));
    expect(adaRows.map((row) => row.displayName).sort()).toEqual(['Ada Lovelace', 'ada grant']);
    // The total counts the whole matching set, not the page.
    expect(hitBody.total).toBe(2);

    const miss = await authenticatedFetch(
      `${ADMIN_USERS_API}?search=${encodeURIComponent('nobody-by-this-name')}`,
      admin,
    );
    expect(miss.status).toBe(200);
    const missBody = (await miss.json()) as AdminUsersPayload;
    expect(missBody.accounts).toHaveLength(0);
    expect(missBody.total).toBe(0);
    expect(missBody.nextCursor).toBeNull();
  });

  it('escapes LIKE wildcards in a route search', async () => {
    const admin = await bootstrapSessionWithEmail('admin-page-escape', ADMIN_EMAIL);
    await seedAccounts(3, 'escape-seed', (index) =>
      index === 0 ? '100%_done' : index === 1 ? '100Xdone' : null);

    const hit = await authenticatedFetch(
      `${ADMIN_USERS_API}?search=${encodeURIComponent('100%')}`,
      admin,
    );
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as AdminUsersPayload;
    const named = body.accounts.filter((row) => row.displayName !== null);
    expect(named.map((row) => row.displayName)).toEqual(['100%_done']);
    expect(body.total).toBe(1);

    // A bare % must match the literal percent sign only, never everything.
    const bare = await authenticatedFetch(
      `${ADMIN_USERS_API}?search=${encodeURIComponent('%')}`,
      admin,
    );
    const bareBody = (await bare.json()) as AdminUsersPayload;
    expect(bareBody.total).toBe(1);
    expect(bareBody.accounts.map((row) => row.displayName)).toEqual(['100%_done']);
  });
});
