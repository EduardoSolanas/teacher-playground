import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './do/IdentityDO';
import {
  bootstrapLocalSession,
  authenticatedFetch,
  localAccessToken,
} from './test/workerAuth';
import { createCompany } from './lib/company/membership';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: DurableObjectNamespace<IdentityDO>;
    }
  }
}

const TEACHER_BASE = 'https://example.com';
const GUEST_BASE = 'https://join.example.com';
const MARKETING_BASE = 'https://www.example.com';
const COMPANY_API = '/api/company';
const COMPANY_INVITES_API = '/api/company/invites';
const COMPANY_SEATS_API = '/api/company/seats';
const COMPANY_MEMBER_REVOKE_API = '/api/company/members/revoke';
const COMPANY_OWNER_API = '/api/company/owner';
const COMPANY_INVITE_REDEEM_API = '/api/company/invites/redeem';

function identityStub() {
  return getIdentityObject(env.IDENTITY);
}

describe('Worker /auth/session/current company payload', () => {
  it('carries the caller membership and stays null without one', async () => {
    const member = await bootstrapLocalSession('worker-company-session-member');
    const outsider = await bootstrapLocalSession('worker-company-session-outsider');

    const before = await authenticatedFetch('/auth/session/current', member);
    expect(before.status).toBe(200);
    expect((await before.json()) as { company: unknown }).toMatchObject({
      company: null,
    });

    await runInDurableObject(identityStub(), (instance) => {
      const created = createCompany(instance.db, {
        name: 'Session Co',
        ownerAccountId: member.accountId,
        now: Date.now(),
      });
      expect(created.outcome).toBe('created');
    });

    const after = await authenticatedFetch('/auth/session/current', member);
    expect(after.status).toBe(200);
    const payload = (await after.json()) as {
      company: { id: string; name: string; role: string } | null;
    };
    expect(payload.company).toMatchObject({
      name: 'Session Co',
      role: 'owner',
    });
    expect(typeof payload.company?.id).toBe('string');

    const stillNull = await authenticatedFetch('/auth/session/current', outsider);
    expect((await stillNull.json()) as { company: unknown }).toMatchObject({
      company: null,
    });
  });
});

describe('Worker /api/company routes', () => {
  it('routes company only on the teacher host with a session and exact origin', async () => {
    for (const base of [GUEST_BASE, MARKETING_BASE]) {
      const response = await SELF.fetch(`${base}${COMPANY_API}`, { method: 'GET' });
      expect(response.status, base).toBe(404);
    }

    const token = await localAccessToken('company-api-no-session');
    const noSession = await SELF.fetch(`${TEACHER_BASE}${COMPANY_API}`, {
      method: 'GET',
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(noSession.status).toBe(401);

    const session = await bootstrapLocalSession('company-api-no-origin');
    const noOrigin = await SELF.fetch(`${TEACHER_BASE}${COMPANY_API}`, {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': session.token,
        Cookie: session.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'No Origin Co', operationId: 'op_no_origin' }),
    });
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: 'Origin required' });

    const wrongMethod = await authenticatedFetch(COMPANY_API, session, { method: 'PUT' });
    expect(wrongMethod.status).toBe(405);

    const suffix = await authenticatedFetch(`${COMPANY_API}/extra`, session);
    expect(suffix.status).toBe(404);
  });

  it('create returns the company with billing pending, replays by operationId, and feeds the summary', async () => {
    const session = await bootstrapLocalSession('company-api-create');
    const body = { name: 'API Co', operationId: 'op_api_create' };

    const first = await authenticatedFetch(COMPANY_API, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      company: { id: string; name: string; role: string; processorCustomerId: string | null };
      membership: { role: string; state: string };
      customerReady: boolean;
    };
    expect(firstBody.company).toMatchObject({ name: 'API Co', role: 'owner' });
    expect(firstBody.company.processorCustomerId).toBeNull();
    expect(firstBody.membership).toMatchObject({ role: 'owner', state: 'active' });
    expect(firstBody.customerReady).toBe(false);

    const replay = await authenticatedFetch(COMPANY_API, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { company: { id: string } };
    expect(replayBody.company.id).toBe(firstBody.company.id);

    const conflict = await authenticatedFetch(COMPANY_API, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Changed Co', operationId: 'op_api_create' }),
    });
    expect(conflict.status).toBe(409);

    const summary = await authenticatedFetch(COMPANY_API, session);
    expect(summary.status).toBe(200);
    const summaryBody = (await summary.json()) as {
      company: { id: string; name: string; role: string };
      members: Array<{ accountId: string; role: string }>;
      subscription: unknown;
    };
    expect(summaryBody.company).toMatchObject({
      id: firstBody.company.id,
      name: 'API Co',
      role: 'owner',
    });
    expect(summaryBody.members).toEqual([
      expect.objectContaining({ accountId: session.accountId, role: 'owner' }),
    ]);
    expect(summaryBody.subscription).toBeNull();

    const sessionPayload = await authenticatedFetch('/auth/session/current', session);
    const sessionBody = (await sessionPayload.json()) as {
      company: { id: string; name: string; role: string } | null;
    };
    expect(sessionBody.company).toMatchObject({
      id: firstBody.company.id,
      name: 'API Co',
      role: 'owner',
    });
  });

  async function createCompanyViaApi(
    session: Awaited<ReturnType<typeof bootstrapLocalSession>>,
    name: string,
    operationId: string,
  ): Promise<string> {
    const response = await authenticatedFetch(COMPANY_API, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, operationId }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { company: { id: string } }).company.id;
  }

  function seedCompanySubscription(
    companyId: string,
    quantity: number,
  ): Promise<void> {
    return runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(
          `INSERT INTO company_subscriptions (
             company_id, processor_subscription_id, quantity, status,
             collection_method, updated_at
           ) VALUES (?, ?, ?, 'active', 'charge_automatically', 1)`,
        )
        .run(companyId, `sub_${companyId}`, quantity);
    });
  }

  it('mints, revokes, and redeems invites through the teacher API', async () => {
    const owner = await bootstrapLocalSession('company-api-invite-owner');
    const member = await bootstrapLocalSession('company-api-invite-member');
    const companyId = await createCompanyViaApi(owner, 'Invite API Co', 'op_api_invite');
    await seedCompanySubscription(companyId, 3);

    const minted = await authenticatedFetch(COMPANY_INVITES_API, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(minted.status).toBe(201);
    const invite = (await minted.json()) as { token: string; inviteHash: string };

    const redeemed = await authenticatedFetch(COMPANY_INVITE_REDEEM_API, member, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ companyId, role: 'member' });

    const memberSession = await authenticatedFetch('/auth/session/current', member);
    const memberBody = (await memberSession.json()) as {
      company: { id: string; name: string; role: string } | null;
    };
    expect(memberBody.company).toMatchObject({
      id: companyId,
      name: 'Invite API Co',
      role: 'member',
    });

    const memberMint = await authenticatedFetch(COMPANY_INVITES_API, member, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(memberMint.status).toBe(403);

    const secondMint = await authenticatedFetch(COMPANY_INVITES_API, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    const secondInvite = (await secondMint.json()) as { token: string; inviteHash: string };

    const revoked = await authenticatedFetch(COMPANY_INVITES_API, owner, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteHash: secondInvite.inviteHash }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ outcome: 'revoked' });

    const revokedRedeem = await authenticatedFetch(COMPANY_INVITE_REDEEM_API, member, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: secondInvite.token }),
    });
    expect(revokedRedeem.status).toBe(404);

    const wrongMethod = await authenticatedFetch(COMPANY_INVITES_API, owner);
    expect(wrongMethod.status).toBe(405);
  });

  it('renames and disables the company through the teacher API', async () => {
    const owner = await bootstrapLocalSession('company-api-lifecycle-owner');
    const member = await bootstrapLocalSession('company-api-lifecycle-member');
    const companyId = await createCompanyViaApi(owner, 'Lifecycle Co', 'op_api_lifecycle');
    await seedCompanySubscription(companyId, 3);

    const invite = await authenticatedFetch(COMPANY_INVITES_API, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    const token = ((await invite.json()) as { token: string }).token;
    await authenticatedFetch(COMPANY_INVITE_REDEEM_API, member, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    const memberRename = await authenticatedFetch(COMPANY_API, member, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Member Rename' }),
    });
    expect(memberRename.status).toBe(403);

    const renamed = await authenticatedFetch(COMPANY_API, owner, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Co' }),
    });
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as {
      company: { id: string; name: string; role: string };
    };
    expect(renamedBody.company).toMatchObject({
      id: companyId,
      name: 'Renamed Co',
      role: 'owner',
    });

    const disabled = await authenticatedFetch(COMPANY_API, owner, { method: 'DELETE' });
    expect(disabled.status).toBe(200);
    const disabledBody = (await disabled.json()) as { outcome: string };
    expect(disabledBody.outcome).toBe('disabled');

    const afterDisable = await authenticatedFetch('/auth/session/current', owner);
    expect((await afterDisable.json()) as { company: unknown }).toMatchObject({
      company: null,
    });

    const again = await authenticatedFetch(COMPANY_API, owner, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('reserves a seat change and returns 202 while Stripe is unreachable', async () => {
    const owner = await bootstrapLocalSession('company-api-seat-owner');
    const companyId = await createCompanyViaApi(owner, 'Seat API Co', 'op_api_seat_create');
    await seedCompanySubscription(companyId, 2);

    const reserved = await authenticatedFetch(COMPANY_SEATS_API, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 4, operationId: 'op_api_seat_increase' }),
    });
    expect(reserved.status).toBe(202);
    expect(await reserved.json()).toEqual({
      status: 'pending',
      operationId: 'op_api_seat_increase',
    });

    const stored = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity,
                  pending_operation_id AS pendingOperationId
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
    );
    expect(stored).toEqual({
      quantity: 2,
      pendingQuantity: 4,
      pendingOperationId: 'op_api_seat_increase',
    });

    const second = await authenticatedFetch(COMPANY_SEATS_API, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 3, operationId: 'op_api_seat_second' }),
    });
    expect(second.status).toBe(409);
  });

  it('revokes a member and transfers ownership through the teacher API', async () => {
    const owner = await bootstrapLocalSession('company-api-revoke-owner');
    const admin = await bootstrapLocalSession('company-api-revoke-admin');
    const member = await bootstrapLocalSession('company-api-revoke-member');
    const companyId = await createCompanyViaApi(owner, 'Reassign Co', 'op_api_reassign');
    await seedCompanySubscription(companyId, 3);

    for (const [session, role] of [
      [admin, 'admin'],
      [member, 'member'],
    ] as const) {
      const mint = await authenticatedFetch(COMPANY_INVITES_API, owner, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const token = ((await mint.json()) as { token: string }).token;
      const redeem = await authenticatedFetch(COMPANY_INVITE_REDEEM_API, session, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(redeem.status).toBe(200);
    }

    const memberAttempt = await authenticatedFetch(COMPANY_MEMBER_REVOKE_API, member, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: admin.accountId }),
    });
    expect(memberAttempt.status).toBe(403);

    const revoked = await authenticatedFetch(COMPANY_MEMBER_REVOKE_API, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: member.accountId }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      outcome: 'revoked',
      accountId: member.accountId,
    });

    const transferred = await authenticatedFetch(COMPANY_OWNER_API, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: admin.accountId }),
    });
    expect(transferred.status).toBe(200);
    expect(await transferred.json()).toEqual({
      outcome: 'transferred',
      accountId: admin.accountId,
    });

    const ownerSession = await authenticatedFetch('/auth/session/current', owner);
    const ownerBody = (await ownerSession.json()) as { company: { role: string } | null };
    expect(ownerBody.company?.role).toBe('admin');

    const adminSession = await authenticatedFetch('/auth/session/current', admin);
    const adminBody = (await adminSession.json()) as { company: { role: string } | null };
    expect(adminBody.company?.role).toBe('owner');
  });

  it('enforces the §6.3 company rate limits per subject', async () => {
    const createSession = await bootstrapLocalSession('company-rate-create');
    for (let index = 0; index < 5; index += 1) {
      const response = await authenticatedFetch(COMPANY_API, createSession, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `Rate Co ${index}`, operationId: `op_rate_create_${index}` }),
      });
      expect(response.status, `create ${index}`).toBe(index === 0 ? 201 : 409);
    }
    const createLimited = await authenticatedFetch(COMPANY_API, createSession, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rate Co Over', operationId: 'op_rate_create_over' }),
    });
    expect(createLimited.status).toBe(429);
    expect(createLimited.headers.get('retry-after')).not.toBeNull();
    expect(await createLimited.json()).toEqual({ error: 'Too many requests' });

    const seatOwner = await bootstrapLocalSession('company-rate-seats');
    const seatCompany = await createCompanyViaApi(seatOwner, 'Rate Seats Co', 'op_rate_seats');
    await seedCompanySubscription(seatCompany, 2);
    for (let index = 0; index < 5; index += 1) {
      const response = await authenticatedFetch(COMPANY_SEATS_API, seatOwner, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quantity: 4, operationId: `op_rate_seat_${index}` }),
      });
      expect(response.status, `seat ${index}`).toBe(index === 0 ? 202 : 409);
    }
    const seatLimited = await authenticatedFetch(COMPANY_SEATS_API, seatOwner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 4, operationId: 'op_rate_seat_over' }),
    });
    expect(seatLimited.status).toBe(429);

    const inviteOwner = await bootstrapLocalSession('company-rate-invites');
    await createCompanyViaApi(inviteOwner, 'Rate Invites Co', 'op_rate_invites');
    for (let index = 0; index < 20; index += 1) {
      const response = await authenticatedFetch(COMPANY_INVITES_API, inviteOwner, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member' }),
      });
      expect(response.status, `invite ${index}`).toBe(201);
    }
    const inviteLimited = await authenticatedFetch(COMPANY_INVITES_API, inviteOwner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(inviteLimited.status).toBe(429);

    const redeemSession = await bootstrapLocalSession('company-rate-redeem');
    for (let index = 0; index < 10; index += 1) {
      const response = await authenticatedFetch(COMPANY_INVITE_REDEEM_API, redeemSession, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'A'.repeat(43) }),
      });
      expect(response.status, `redeem ${index}`).toBe(404);
    }
    const redeemLimited = await authenticatedFetch(COMPANY_INVITE_REDEEM_API, redeemSession, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'A'.repeat(43) }),
    });
    expect(redeemLimited.status).toBe(429);

    const transferOwner = await bootstrapLocalSession('company-rate-transfer');
    const outsider = await bootstrapLocalSession('company-rate-transfer-target');
    await createCompanyViaApi(transferOwner, 'Rate Transfer Co', 'op_rate_transfer');
    for (let index = 0; index < 20; index += 1) {
      const response = await authenticatedFetch(COMPANY_OWNER_API, transferOwner, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: outsider.accountId }),
      });
      expect(response.status, `transfer ${index}`).toBe(409);
    }
    const transferLimited = await authenticatedFetch(COMPANY_OWNER_API, transferOwner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: outsider.accountId }),
    });
    expect(transferLimited.status).toBe(429);
  }, 30_000);
});
