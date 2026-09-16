import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './do/IdentityDO';
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
  createdAt: number;
  updatedAt: number;
}

interface AdminUsersPayload {
  accounts: AdminAccountRow[];
  total: number;
}

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
        'provenance',
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
