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
import {
  ensureBillingSubscription,
  upsertDisputeHold,
} from './lib/identity/entitlementWriter';

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

  const OPERATOR_INVOICE_APPROVAL_API = '/api/company/operator/invoice-approval';
  const OPERATOR_DISPUTE_REVIEW_API = '/api/company/operator/disputes/review';

  function operatorPost(
    path: string,
    token: string,
    body: unknown,
  ): Promise<Response> {
    return SELF.fetch(`${TEACHER_BASE}${path}`, {
      method: 'POST',
      headers: {
        Origin: TEACHER_BASE,
        'Cf-Access-Jwt-Assertion': token,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  it('an allowlisted operator approves invoicing; a non-operator is refused with nothing written', async () => {
    const owner = await bootstrapLocalSession('operator-approve-owner');
    const companyId = await createCompanyViaApi(owner, 'Operator API Co', 'op_operator_create');
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(`UPDATE companies SET processor_customer_id = ? WHERE company_id = ?`)
        .run('cus_operator_api', companyId);
    });

    const denied = await operatorPost(
      OPERATOR_INVOICE_APPROVAL_API,
      await localAccessToken('operator-outsider', 'valid', undefined, 'outsider@example.test'),
      { companyId, quantity: 12, operationId: 'op_operator_denied' },
    );
    expect(denied.status).toBe(403);

    const selfServe = await operatorPost(OPERATOR_INVOICE_APPROVAL_API, owner.token, {
      companyId,
      quantity: 12,
      operationId: 'op_operator_selfserve',
    });
    expect(selfServe.status).toBe(403);

    const afterDenied = await runInDurableObject(identityStub(), (instance) => ({
      company: instance.db
        .prepare(`SELECT invoice_approved AS invoiceApproved FROM companies WHERE company_id = ?`)
        .get(companyId),
      operations: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM billing_operations
           WHERE subject_id = ? AND kind = 'invoice-approve'`,
        )
        .get(companyId),
    }));
    expect(afterDenied.company).toEqual({ invoiceApproved: 0 });
    expect(afterDenied.operations).toEqual({ count: 0 });

    const approved = await operatorPost(
      OPERATOR_INVOICE_APPROVAL_API,
      await localAccessToken('operator-approver', 'valid', undefined, 'OPS@Example.Test'),
      { companyId, quantity: 12, operationId: 'op_operator_approved' },
    );
    expect(approved.status).toBe(202);
    expect(await approved.json()).toEqual({
      status: 'pending',
      operationId: 'op_operator_approved',
    });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      company: instance.db
        .prepare(`SELECT invoice_approved AS invoiceApproved FROM companies WHERE company_id = ?`)
        .get(companyId),
      operation: instance.db
        .prepare(
          `SELECT kind, status FROM billing_operations
           WHERE subject_id = ? AND operation_id = 'op_operator_approved'`,
        )
        .get(companyId),
      audit: instance.db
        .prepare(
          `SELECT actor, cause_kind AS causeKind FROM entitlement_audit
           WHERE cause_id = 'op_operator_approved'`,
        )
        .get(),
    }));
    expect(stored.company).toEqual({ invoiceApproved: 1 });
    expect(stored.operation).toEqual({ kind: 'invoice-approve', status: 'pending' });
    expect(stored.audit).toEqual({
      actor: 'operator:ops@example.test',
      causeKind: 'operator',
    });

    for (const base of [GUEST_BASE, MARKETING_BASE]) {
      const response = await SELF.fetch(`${base}${OPERATOR_INVOICE_APPROVAL_API}`, {
        method: 'POST',
      });
      expect(response.status, base).toBe(404);
    }
  });

  it('an allowlisted operator reviews a dispute; a non-operator is refused with the hold unchanged', async () => {
    const owner = await bootstrapLocalSession('operator-dispute-owner');
    const companyId = await createCompanyViaApi(
      owner,
      'Operator Dispute Co',
      'op_operator_dispute_create',
    );
    await seedCompanySubscription(companyId, 3);
    await runInDurableObject(identityStub(), (instance) => {
      ensureBillingSubscription(instance.db, {
        processorSubscriptionId: `sub_${companyId}`,
        subjectKind: 'company',
        subjectId: companyId,
        now: 1,
      });
      upsertDisputeHold(instance.db, {
        disputeId: 'dp_worker_operator',
        processorSubscriptionId: `sub_${companyId}`,
        state: 'review',
        now: 2,
      });
    });

    const denied = await operatorPost(
      OPERATOR_DISPUTE_REVIEW_API,
      await localAccessToken('operator-dispute-outsider', 'valid', undefined, 'outsider@example.test'),
      { disputeId: 'dp_worker_operator', outcome: 'won', operationId: 'op_worker_review_denied' },
    );
    expect(denied.status).toBe(403);
    expect(
      await runInDurableObject(identityStub(), (instance) =>
        instance.db
          .prepare(`SELECT state FROM billing_dispute_holds WHERE dispute_id = 'dp_worker_operator'`)
          .get(),
      ),
    ).toEqual({ state: 'review' });

    const resolved = await operatorPost(
      OPERATOR_DISPUTE_REVIEW_API,
      await localAccessToken('operator-dispute-reviewer', 'valid', undefined, 'ops@example.test'),
      { disputeId: 'dp_worker_operator', outcome: 'won', operationId: 'op_worker_review' },
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({
      outcome: 'resolved',
      disputeId: 'dp_worker_operator',
      state: 'won',
      desiredCollection: 'active',
    });
    expect(
      await runInDurableObject(identityStub(), (instance) =>
        instance.db
          .prepare(
            `SELECT actor FROM entitlement_audit WHERE cause_id = 'op_worker_review'`,
          )
          .get(),
      ),
    ).toEqual({ actor: 'operator:ops@example.test' });
  });
});

describe('Worker /api/company validation and operator error mapping', () => {
  const OPERATOR_EMAIL = 'ops@example.test';
  const INVOICE_APPROVAL = '/api/company/operator/invoice-approval';
  const DISPUTE_REVIEW = '/api/company/operator/disputes/review';

  function operatorPost(
    path: string,
    token: string,
    body: unknown,
    contentType = 'application/json',
  ): Promise<Response> {
    return SELF.fetch(`${TEACHER_BASE}${path}`, {
      method: 'POST',
      headers: {
        Origin: TEACHER_BASE,
        'Cf-Access-Jwt-Assertion': token,
        'content-type': contentType,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  async function createCompanyForApi(
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

  it('answers 405 for company routes reached with the wrong method', async () => {
    const token = await localAccessToken('company-method-boundary');
    const cases: Array<[string, string]> = [
      [COMPANY_INVITE_REDEEM_API, 'POST'],
      [COMPANY_SEATS_API, 'POST'],
      [COMPANY_MEMBER_REVOKE_API, 'POST'],
      [COMPANY_OWNER_API, 'POST'],
      [INVOICE_APPROVAL, 'POST'],
      [DISPUTE_REVIEW, 'POST'],
    ];
    for (const [path, allow] of cases) {
      const response = await SELF.fetch(`${TEACHER_BASE}${path}`, {
        method: 'GET',
        headers: { Origin: TEACHER_BASE, 'Cf-Access-Jwt-Assertion': token },
      });
      expect(response.status, path).toBe(405);
      expect(response.headers.get('allow'), path).toBe(allow);
    }
  });

  it('answers 401 on company mutations without a local session', async () => {
    const token = await localAccessToken('company-session-boundary');
    const cases: Array<[string, unknown]> = [
      [COMPANY_INVITES_API, { role: 'member' }],
      [COMPANY_INVITE_REDEEM_API, { token: 'A'.repeat(43) }],
      [COMPANY_SEATS_API, { quantity: 2, operationId: 'op_no_session_seat' }],
      [COMPANY_MEMBER_REVOKE_API, { accountId: 'acct_no_session' }],
      [COMPANY_OWNER_API, { accountId: 'acct_no_session' }],
    ];
    for (const [path, body] of cases) {
      const response = await SELF.fetch(`${TEACHER_BASE}${path}`, {
        method: 'POST',
        headers: {
          Origin: TEACHER_BASE,
          'Cf-Access-Jwt-Assertion': token,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(401);
      expect(await response.json(), path).toEqual({ error: 'Unauthorized' });
    }
  });

  it('rejects non-JSON company bodies before any identity call', async () => {
    const session = await bootstrapLocalSession('company-non-json-bodies');
    const operatorToken = await localAccessToken(
      'company-non-json-operator',
      'valid',
      undefined,
      OPERATOR_EMAIL,
    );
    const cases: Array<[string, string]> = [
      [COMPANY_API, 'POST'],
      [COMPANY_API, 'PATCH'],
      [COMPANY_INVITES_API, 'POST'],
      [COMPANY_INVITES_API, 'DELETE'],
      [COMPANY_INVITE_REDEEM_API, 'POST'],
      [COMPANY_SEATS_API, 'POST'],
      [COMPANY_MEMBER_REVOKE_API, 'POST'],
      [COMPANY_OWNER_API, 'POST'],
    ];
    for (const [path, method] of cases) {
      const response = await authenticatedFetch(path, session, {
        method,
        headers: { 'content-type': 'text/plain' },
        body: 'not-json',
      });
      expect(response.status, `${method} ${path}`).toBe(415);
    }
    for (const path of [INVOICE_APPROVAL, DISPUTE_REVIEW]) {
      const response = await operatorPost(path, operatorToken, 'not-json', 'text/plain');
      expect(response.status, path).toBe(415);
    }
  });

  it('rejects malformed JSON and out-of-shape company bodies', async () => {
    const session = await bootstrapLocalSession('company-invalid-bodies');
    const operatorToken = await localAccessToken(
      'company-invalid-operator',
      'valid',
      undefined,
      OPERATOR_EMAIL,
    );
    const cases: Array<[string, string, unknown]> = [
      [COMPANY_API, 'POST', []],
      [COMPANY_API, 'POST', {}],
      [COMPANY_API, 'POST', { name: '', operationId: 'op_invalid' }],
      [COMPANY_API, 'POST', { name: 'x', operationId: 'bad id' }],
      [COMPANY_API, 'PATCH', []],
      [COMPANY_API, 'PATCH', { name: 42 }],
      [COMPANY_API, 'PATCH', { name: '  ' }],
      [COMPANY_INVITES_API, 'POST', []],
      [COMPANY_INVITES_API, 'POST', { role: 'owner' }],
      [COMPANY_INVITES_API, 'POST', { role: 'member', extra: 1 }],
      [COMPANY_INVITES_API, 'DELETE', []],
      [COMPANY_INVITES_API, 'DELETE', { inviteHash: 'zz' }],
      [COMPANY_INVITE_REDEEM_API, 'POST', []],
      [COMPANY_INVITE_REDEEM_API, 'POST', { token: '' }],
      [COMPANY_SEATS_API, 'POST', []],
      [COMPANY_SEATS_API, 'POST', { quantity: 0, operationId: 'op_invalid_seat' }],
      [COMPANY_SEATS_API, 'POST', { quantity: 1.5, operationId: 'op_invalid_seat' }],
      [COMPANY_MEMBER_REVOKE_API, 'POST', []],
      [COMPANY_MEMBER_REVOKE_API, 'POST', { accountId: '' }],
      [COMPANY_OWNER_API, 'POST', []],
      [COMPANY_OWNER_API, 'POST', { accountId: '' }],
    ];
    for (const [path, method, body] of cases) {
      const response = await authenticatedFetch(path, session, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
    }

    const invalidJson = await authenticatedFetch(COMPANY_API, session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(invalidJson.status).toBe(400);

    const operatorCases: Array<[string, unknown]> = [
      [INVOICE_APPROVAL, []],
      [INVOICE_APPROVAL, { companyId: 'co_body' }],
      [INVOICE_APPROVAL, { companyId: 'co_body', quantity: 0, operationId: 'op_body' }],
      [DISPUTE_REVIEW, []],
      [DISPUTE_REVIEW, { disputeId: 'd', outcome: 'draw', operationId: 'op_body' }],
      [DISPUTE_REVIEW, { disputeId: 'd', outcome: 'lost', operationId: 'bad id' }],
    ];
    for (const [path, body] of operatorCases) {
      const response = await operatorPost(path, operatorToken, body);
      expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('maps an unknown company and a changed replay through the operator surface', async () => {
    const operatorToken = await localAccessToken(
      'company-operator-errors',
      'valid',
      undefined,
      OPERATOR_EMAIL,
    );

    const missing = await operatorPost(INVOICE_APPROVAL, operatorToken, {
      companyId: 'co_missing_operator',
      quantity: 12,
      operationId: 'op_operator_missing',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not found' });

    const owner = await bootstrapLocalSession('company-operator-conflict-owner');
    const companyId = await createCompanyForApi(
      owner,
      'Operator Conflict Co',
      'op_operator_conflict_create',
    );
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(`UPDATE companies SET processor_customer_id = ? WHERE company_id = ?`)
        .run('cus_operator_conflict', companyId);
    });

    const approved = await operatorPost(INVOICE_APPROVAL, operatorToken, {
      companyId,
      quantity: 12,
      operationId: 'op_operator_conflict',
    });
    expect(approved.status).toBe(202);

    const conflict = await operatorPost(INVOICE_APPROVAL, operatorToken, {
      companyId,
      quantity: 13,
      operationId: 'op_operator_conflict',
    });
    expect(conflict.status).toBe(409);
  });

  it('returns the recorded outcome when a settled approval is replayed', async () => {
    const operatorToken = await localAccessToken(
      'company-operator-settled-replay',
      'valid',
      undefined,
      OPERATOR_EMAIL,
    );
    const owner = await bootstrapLocalSession('company-operator-settled-owner');
    const companyId = await createCompanyForApi(
      owner,
      'Operator Settled Co',
      'op_operator_settled_create',
    );
    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(`UPDATE companies SET processor_customer_id = ? WHERE company_id = ?`)
        .run('cus_operator_settled', companyId);
    });

    const body = { companyId, quantity: 12, operationId: 'op_operator_settled' };
    expect((await operatorPost(INVOICE_APPROVAL, operatorToken, body)).status).toBe(202);

    const settled = await identityStub().fetch('https://identity/operator/invoice-approval/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operatorEmail: OPERATOR_EMAIL,
        companyId,
        operationId: body.operationId,
        quantity: body.quantity,
        outcome: 'success',
        status: 'active',
        processorSubscriptionId: 'sub_operator_settled',
        currentPeriodEnd: 1_700_000_000_000,
      }),
    });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({ status: 'settled' });

    await runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare('DELETE FROM company_subscriptions WHERE company_id = ?')
        .run(companyId);
    });

    const replay = await operatorPost(INVOICE_APPROVAL, operatorToken, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      status: 'created',
      operationId: body.operationId,
      processorSubscriptionId: null,
    });
  });
});
