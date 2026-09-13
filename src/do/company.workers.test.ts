import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import {
  ensureBillingSubscription,
  readEntitlementsForAccount,
  recomputeDesiredCollection,
  upsertDisputeHold,
  writeEntitlement,
} from '../lib/identity/entitlementWriter';
import { recordOwnedRoom, setPreferredDisplayName } from '../lib/identity/identityStore';
import { PAST_DUE_GRACE_MS } from '../lib/plan/catalog';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: DurableObjectNamespace<IdentityDO>;
      OPERATOR_EMAILS?: string;
    }
  }
}

function identityStub() {
  return getIdentityObject(env.IDENTITY);
}

interface LocalSession {
  accountId: string;
  subject: string;
  cookie: string;
}

async function accessSession(subject: string): Promise<LocalSession> {
  const issuer = 'https://access.example.com';
  const issued = await identityStub().fetch('https://identity/sessions/issue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ issuer, subject }),
  });
  expect(issued.status).toBe(201);
  const body = (await issued.json()) as { accountId: string };
  const setCookie = issued.headers.get('set-cookie');
  expect(setCookie).toContain('session=');
  return {
    accountId: body.accountId,
    subject,
    cookie: setCookie!.split(';', 1)[0],
  };
}

function companyFetch(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<Response> {
  return identityStub().fetch(`https://identity${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      cookie,
      ...(init.headers ?? {}),
    },
  });
}

function systemSettle(body: unknown): Promise<Response> {
  return identityStub().fetch('https://identity/billing/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface CompanyBody {
  company: {
    id: string;
    name: string;
    role: string;
    state: string;
    processorCustomerId: string | null;
    invoiceApproved: boolean;
    createdAt: number;
  } | null;
  membership: { role: string; state: string } | null;
  operation: { id: string; status: string } | null;
}

describe('IdentityDO company routes (spec §6.2)', () => {
  it('create inserts company and owner atomically; founder already in a company gets 409', async () => {
    const session = await accessSession('company-c1-founder');

    const created = await companyFetch('/companies', session.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada Tutoring', operationId: 'op_c1_first' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as CompanyBody;
    expect(body.company?.name).toBe('Ada Tutoring');
    expect(body.company?.role).toBe('owner');
    expect(body.company?.state).toBe('active');
    expect(body.company?.processorCustomerId).toBeNull();
    expect(body.company?.invoiceApproved).toBe(false);
    expect(body.membership).toMatchObject({ role: 'owner', state: 'active' });
    expect(body.operation).toEqual({ id: 'op_c1_first', status: 'pending' });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      companies: instance.db
        .prepare(`SELECT COUNT(*) AS count FROM companies`)
        .get(),
      owner: instance.db
        .prepare(
          `SELECT role, state FROM company_members WHERE account_id = ?`,
        )
        .get(session.accountId),
    }));
    expect(stored.companies).toEqual({ count: 1 });
    expect(stored.owner).toEqual({ role: 'owner', state: 'active' });

    const second = await companyFetch('/companies', session.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Second Co', operationId: 'op_c1_second' }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'Conflict' });
  });

  it('customer creation failure keeps the company and replays by operationId', async () => {
    const session = await accessSession('company-c2-owner');
    const createBody = JSON.stringify({ name: 'C2 Co', operationId: 'op_c2_create' });

    const first = await companyFetch('/companies', session.cookie, {
      method: 'POST',
      body: createBody,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as CompanyBody;
    const companyId = firstBody.company!.id;
    expect(firstBody.company?.processorCustomerId).toBeNull();
    expect(firstBody.operation).toEqual({ id: 'op_c2_create', status: 'pending' });

    const stored = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT processor_customer_id AS processorCustomerId
           FROM companies WHERE company_id = ?`,
        )
        .get(companyId),
    );
    expect(stored).toEqual({ processorCustomerId: null });

    const replay = await companyFetch('/companies', session.cookie, {
      method: 'POST',
      body: createBody,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as CompanyBody;
    expect(replayBody.company?.id).toBe(companyId);
    expect(replayBody.operation).toEqual({ id: 'op_c2_create', status: 'pending' });

    const changed = await companyFetch('/companies', session.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'C2 Co Renamed', operationId: 'op_c2_create' }),
    });
    expect(changed.status).toBe(409);

    const writeback = await companyFetch('/companies/customer', session.cookie, {
      method: 'POST',
      body: JSON.stringify({
        companyId,
        operationId: 'op_c2_create',
        processorCustomerId: 'cus_c2_worker',
      }),
    });
    expect(writeback.status).toBe(200);
    const written = (await writeback.json()) as CompanyBody;
    expect(written.company?.processorCustomerId).toBe('cus_c2_worker');
    expect(written.operation).toEqual({ id: 'op_c2_create', status: 'succeeded' });

    const finalReplay = await companyFetch('/companies', session.cookie, {
      method: 'POST',
      body: createBody,
    });
    expect(finalReplay.status).toBe(200);
    const finalBody = (await finalReplay.json()) as CompanyBody;
    expect(finalBody.company?.processorCustomerId).toBe('cus_c2_worker');
    expect(finalBody.operation).toEqual({ id: 'op_c2_create', status: 'succeeded' });
  });

  it('refuses a customer writeback for a company the caller does not own', async () => {
    const owner = await accessSession('company-c2-owner-a');
    const other = await accessSession('company-c2-owner-b');
    const created = await companyFetch('/companies', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Owned By A', operationId: 'op_c2_guard_a' }),
    });
    const createdBody = (await created.json()) as CompanyBody;
    const companyId = createdBody.company!.id;
    await companyFetch('/companies', other.cookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'Owned By B', operationId: 'op_c2_guard_b' }),
    });

    const hostile = await companyFetch('/companies/customer', other.cookie, {
      method: 'POST',
      body: JSON.stringify({
        companyId,
        operationId: 'op_c2_guard_b',
        processorCustomerId: 'cus_hostile',
      }),
    });
    expect(hostile.status).toBe(403);

    const stored = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT processor_customer_id AS processorCustomerId
           FROM companies WHERE company_id = ?`,
        )
        .get(companyId),
    );
    expect(stored).toEqual({ processorCustomerId: null });
  });

  async function createCompanyFor(
    session: LocalSession,
    name: string,
  ): Promise<string> {
    const created = await companyFetch('/companies', session.cookie, {
      method: 'POST',
      body: JSON.stringify({ name, operationId: `op_${name.replaceAll(' ', '_')}` }),
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as CompanyBody).company!.id;
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

  it('revoked invite cannot be redeemed', async () => {
    const owner = await accessSession('company-c6-owner');
    const member = await accessSession('company-c6-member');
    const companyId = await createCompanyFor(owner, 'Invite Co');
    await seedCompanySubscription(companyId, 3);

    const minted = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    expect(minted.status).toBe(201);
    const invite = (await minted.json()) as {
      token: string;
      inviteHash: string;
      expiresAt: number;
    };
    expect(invite.token.length).toBeGreaterThan(20);
    expect(invite.inviteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.expiresAt).toBeGreaterThan(Date.now());

    const revoked = await companyFetch('/companies/invites', owner.cookie, {
      method: 'DELETE',
      body: JSON.stringify({ inviteHash: invite.inviteHash }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ outcome: 'revoked' });

    const refused = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: invite.token }),
    });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'Not found' });
  });

  it('replayed token returns 404', async () => {
    const owner = await accessSession('company-c7-replay-owner');
    const member = await accessSession('company-c7-replay-member');
    const companyId = await createCompanyFor(owner, 'Replay Co');
    await seedCompanySubscription(companyId, 3);

    const minted = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const token = ((await minted.json()) as { token: string }).token;

    const redeemed = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ companyId, role: 'member' });

    const replayed = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(replayed.status).toBe(404);
  });

  it('redemption over capacity returns 402', async () => {
    const owner = await accessSession('company-c7-owner');
    const member = await accessSession('company-c7-member');
    const companyId = await createCompanyFor(owner, 'Capacity Co');

    const minted = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const invite = (await minted.json()) as { token: string };

    const refused = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: invite.token }),
    });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: 'Plan limit reached' });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      members: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM company_members WHERE company_id = ?`,
        )
        .get(companyId),
      invite: instance.db
        .prepare(
          `SELECT redeemed_at AS redeemedAt FROM company_invites WHERE company_id = ?`,
        )
        .get(companyId),
    }));
    expect(stored.members).toEqual({ count: 1 });
    expect(stored.invite).toEqual({ redeemedAt: null });

    await seedCompanySubscription(companyId, 2);
    const admitted = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: invite.token }),
    });
    expect(admitted.status).toBe(200);
  });

  it('pending increase grants no capacity until settled', async () => {
    const owner = await accessSession('company-c8-owner');
    const member = await accessSession('company-c8-member');
    const companyId = await createCompanyFor(owner, 'Seat Increase Co');
    await seedCompanySubscription(companyId, 1);

    const minted = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const invite = (await minted.json()) as { token: string };

    const reserved = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 3, operationId: 'op_c8_increase' }),
    });
    expect(reserved.status).toBe(200);
    const reservation = (await reserved.json()) as {
      status: string;
      direction: string;
      targetQuantity: number;
      processorSubscriptionId: string;
    };
    expect(reservation).toMatchObject({
      status: 'reserved',
      direction: 'increase',
      targetQuantity: 3,
    });
    expect(reservation.processorSubscriptionId).toBe(`sub_${companyId}`);

    const refused = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: invite.token }),
    });
    expect(refused.status).toBe(402);

    const settled = await companyFetch('/companies/seats/settle', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'op_c8_increase', outcome: 'success' }),
    });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({ status: 'settled' });

    const admitted = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: invite.token }),
    });
    expect(admitted.status).toBe(200);

    const memberAttempt = await companyFetch('/companies/seats', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 4, operationId: 'op_c8_member' }),
    });
    expect(memberAttempt.status).toBe(403);

    const quantity = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
    );
    expect(quantity).toEqual({ quantity: 3, pendingQuantity: null });
  });

  it('redemption during a pending decrease is refused above the target', async () => {
    const owner = await accessSession('company-c9-owner');
    const firstMember = await accessSession('company-c9-member-a');
    const secondMember = await accessSession('company-c9-member-b');
    const companyId = await createCompanyFor(owner, 'Seat Decrease Co');
    await seedCompanySubscription(companyId, 3);

    const firstInvite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const firstToken = ((await firstInvite.json()) as { token: string }).token;
    const admitted = await companyFetch('/companies/invites/redeem', firstMember.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: firstToken }),
    });
    expect(admitted.status).toBe(200);

    const secondInvite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const secondToken = ((await secondInvite.json()) as { token: string }).token;

    const reserved = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 2, operationId: 'op_c9_decrease' }),
    });
    expect(reserved.status).toBe(200);
    const reservation = (await reserved.json()) as {
      status: string;
      direction: string;
      targetQuantity: number;
    };
    expect(reservation).toMatchObject({
      status: 'reserved',
      direction: 'decrease',
      targetQuantity: 2,
    });

    const refused = await companyFetch('/companies/invites/redeem', secondMember.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: secondToken }),
    });
    expect(refused.status).toBe(402);

    const settled = await companyFetch('/companies/seats/settle', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'op_c9_decrease', outcome: 'success' }),
    });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({ status: 'settled' });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      subscription: instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
      members: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM company_members
           WHERE company_id = ? AND state = 'active'`,
        )
        .get(companyId),
    }));
    expect(stored.subscription).toEqual({ quantity: 2, pendingQuantity: null });
    expect(stored.members).toEqual({ count: 2 });
  });

  it('Stripe failure releases the reservation; unknown outcome stays pending until reconcile settles it', async () => {
    const owner = await accessSession('company-c10-owner');
    const companyId = await createCompanyFor(owner, 'Seat Failure Co');
    await seedCompanySubscription(companyId, 2);

    const firstReserve = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 4, operationId: 'op_c10_failed' }),
    });
    expect(firstReserve.status).toBe(200);

    const released = await companyFetch('/companies/seats/settle', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'op_c10_failed', outcome: 'failure' }),
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ status: 'released' });

    const afterRelease = await runInDurableObject(identityStub(), (instance) => ({
      subscription: instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
      operation: instance.db
        .prepare(
          `SELECT status FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?
             AND operation_id = 'op_c10_failed' AND kind = 'seat-change'`,
        )
        .get(companyId),
    }));
    expect(afterRelease.subscription).toEqual({ quantity: 2, pendingQuantity: null });
    expect(afterRelease.operation).toEqual({ status: 'failed' });

    const secondReserve = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 4, operationId: 'op_c10_unknown' }),
    });
    expect(secondReserve.status).toBe(200);

    const pending = await companyFetch('/companies/seats/settle', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'op_c10_unknown', outcome: 'unknown' }),
    });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ status: 'pending' });

    const afterUnknown = await runInDurableObject(identityStub(), (instance) => ({
      subscription: instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity,
                  pending_operation_id AS pendingOperationId
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
      operation: instance.db
        .prepare(
          `SELECT status FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?
             AND operation_id = 'op_c10_unknown' AND kind = 'seat-change'`,
        )
        .get(companyId),
    }));
    expect(afterUnknown.subscription).toEqual({
      quantity: 2,
      pendingQuantity: 4,
      pendingOperationId: 'op_c10_unknown',
    });
    expect(afterUnknown.operation).toEqual({ status: 'pending' });

    const recovered = await companyFetch('/companies/seats/settle', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'op_c10_unknown', outcome: 'success' }),
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ status: 'settled' });

    const finalRow = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
    );
    expect(finalRow).toEqual({ quantity: 4, pendingQuantity: null });
  });

  it('system settle releases a pending seat change without a session and clears the marker', async () => {
    const owner = await accessSession('company-system-settle-owner');
    const companyId = await createCompanyFor(owner, 'System Settle Co');
    await seedCompanySubscription(companyId, 2);

    const reserved = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 4, operationId: 'op_system_settle' }),
    });
    expect(reserved.status).toBe(200);

    const released = await systemSettle({
      kind: 'seat-change',
      companyId,
      operationId: 'op_system_settle',
      outcome: 'failure',
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ status: 'released' });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      subscription: instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
      operation: instance.db
        .prepare(
          `SELECT status, updated_at AS updatedAt FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?
             AND operation_id = 'op_system_settle' AND kind = 'seat-change'`,
        )
        .get(companyId),
    }));
    expect(stored.subscription).toEqual({ quantity: 2, pendingQuantity: null });
    expect(stored.operation).toMatchObject({ status: 'failed' });
  });

  it('system settle never applies a seat change a newer reservation superseded', async () => {
    const owner = await accessSession('company-system-superseded-owner');
    const companyId = await createCompanyFor(owner, 'System Superseded Co');
    await seedCompanySubscription(companyId, 2);

    const firstReserve = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 4, operationId: 'op_system_old' }),
    });
    expect(firstReserve.status).toBe(200);
    const released = await systemSettle({
      kind: 'seat-change',
      companyId,
      operationId: 'op_system_old',
      outcome: 'failure',
    });
    expect(released.status).toBe(200);

    const secondReserve = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 5, operationId: 'op_system_new' }),
    });
    expect(secondReserve.status).toBe(200);

    const stale = await systemSettle({
      kind: 'seat-change',
      companyId,
      operationId: 'op_system_old',
      outcome: 'success',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'Conflict', reason: 'superseded' });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      subscription: instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity,
                  pending_operation_id AS pendingOperationId
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
      staleOperation: instance.db
        .prepare(
          `SELECT status FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?
             AND operation_id = 'op_system_old' AND kind = 'seat-change'`,
        )
        .get(companyId),
    }));
    expect(stored.subscription).toEqual({
      quantity: 2,
      pendingQuantity: 5,
      pendingOperationId: 'op_system_new',
    });
    expect(stored.staleOperation).toEqual({ status: 'failed' });
  });

  it('system settle keeps the reservation pending on an unknown Stripe outcome', async () => {
    const owner = await accessSession('company-system-unknown-owner');
    const companyId = await createCompanyFor(owner, 'System Unknown Co');
    await seedCompanySubscription(companyId, 2);

    const reserved = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 4, operationId: 'op_system_unknown' }),
    });
    expect(reserved.status).toBe(200);

    const pending = await systemSettle({
      kind: 'seat-change',
      companyId,
      operationId: 'op_system_unknown',
      outcome: 'unknown',
    });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ status: 'pending' });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      subscription: instance.db
        .prepare(
          `SELECT quantity, pending_quantity AS pendingQuantity,
                  pending_operation_id AS pendingOperationId
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
      operation: instance.db
        .prepare(
          `SELECT status FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?
             AND operation_id = 'op_system_unknown' AND kind = 'seat-change'`,
        )
        .get(companyId),
    }));
    expect(stored.subscription).toEqual({
      quantity: 2,
      pendingQuantity: 4,
      pendingOperationId: 'op_system_unknown',
    });
    expect(stored.operation).toEqual({ status: 'pending' });
  });

  it('system customer writeback records the customer without a session and never overwrites it', async () => {
    const owner = await accessSession('company-system-customer-owner');
    const companyId = await createCompanyFor(owner, 'System Customer Co');

    const written = await systemSettle({
      kind: 'company-create',
      companyId,
      operationId: 'op_System_Customer_Co',
      processorCustomerId: 'cus_system_1',
    });
    expect(written.status).toBe(200);
    const writtenBody = (await written.json()) as {
      company: { processorCustomerId: string | null };
      operation: { id: string; status: string };
    };
    expect(writtenBody.company.processorCustomerId).toBe('cus_system_1');
    expect(writtenBody.operation).toEqual({
      id: 'op_System_Customer_Co',
      status: 'succeeded',
    });

    const replay = await systemSettle({
      kind: 'company-create',
      companyId,
      operationId: 'op_System_Customer_Co',
      processorCustomerId: 'cus_system_1',
    });
    expect(replay.status).toBe(200);

    const overwrite = await systemSettle({
      kind: 'company-create',
      companyId,
      operationId: 'op_System_Customer_Co',
      processorCustomerId: 'cus_system_2',
    });
    expect(overwrite.status).toBe(409);

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      company: instance.db
        .prepare(
          `SELECT processor_customer_id AS processorCustomerId
           FROM companies WHERE company_id = ?`,
        )
        .get(companyId),
      operation: instance.db
        .prepare(
          `SELECT status FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?
             AND operation_id = 'op_System_Customer_Co' AND kind = 'company-create'`,
        )
        .get(companyId),
    }));
    expect(stored.company).toEqual({ processorCustomerId: 'cus_system_1' });
    expect(stored.operation).toEqual({ status: 'succeeded' });
  });

  it('reconcile enumerates a pending seat change for the worker to retry', async () => {
    const owner = await accessSession('company-reconcile-seat-owner');
    const companyId = await createCompanyFor(owner, 'Reconcile Seat Co');
    await seedCompanySubscription(companyId, 2);

    const reserved = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 5, operationId: 'op_reconcile_seat' }),
    });
    expect(reserved.status).toBe(200);

    const attemptedAt = await runInDurableObject(identityStub(), (instance) => {
      const row = instance.db
        .prepare(
          `SELECT created_at AS attemptedAt FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ?
             AND operation_id = 'op_reconcile_seat' AND kind = 'seat-change'`,
        )
        .get(companyId) as { attemptedAt: number };
      return row.attemptedAt;
    });

    const response = await identityStub().fetch('https://identity/billing/reconcile');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outboundOperations: unknown[] };
    const seatOperations = body.outboundOperations.filter(
      (operation) =>
        (operation as { kind?: string; companyId?: string }).kind === 'seat-change' &&
        (operation as { companyId?: string }).companyId === companyId,
    );
    expect(seatOperations).toEqual([
      {
        kind: 'seat-change',
        companyId,
        operationId: 'op_reconcile_seat',
        processorSubscriptionId: `sub_${companyId}`,
        previousQuantity: 2,
        targetQuantity: 5,
        prorationBehavior: 'create_prorations',
        attemptedAt,
      },
    ]);
  });

  it('reconcile enumerates a pending company-create with its owner and drops it once settled', async () => {
    const owner = await accessSession('company-reconcile-create-owner');
    const companyId = await createCompanyFor(owner, 'Reconcile Create Co');

    const first = await identityStub().fetch('https://identity/billing/reconcile');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      outboundOperations: Array<{ companyId?: string }>;
    };
    const creates = firstBody.outboundOperations.filter(
      (operation) => operation.companyId === companyId,
    );
    expect(creates).toEqual([
      {
        kind: 'company-create',
        companyId,
        operationId: 'op_Reconcile_Create_Co',
        name: 'Reconcile Create Co',
        ownerAccountId: owner.accountId,
      },
    ]);

    const written = await systemSettle({
      kind: 'company-create',
      companyId,
      operationId: 'op_Reconcile_Create_Co',
      processorCustomerId: 'cus_reconcile_create',
    });
    expect(written.status).toBe(200);

    const second = await identityStub().fetch('https://identity/billing/reconcile');
    const secondBody = (await second.json()) as {
      outboundOperations: Array<{ companyId?: string }>;
    };
    expect(
      secondBody.outboundOperations.filter(
        (operation) => operation.companyId === companyId,
      ),
    ).toEqual([]);
  });

  function seedMemberCompanyEntitlement(
    accountId: string,
    companyId: string,
    id: string,
  ): Promise<void> {
    return runInDurableObject(identityStub(), (instance) => {
      writeEntitlement(
        instance.db,
        {
          accountId,
          source: 'company',
          state: {
            planId: 'corporate_seat',
            status: 'active',
            graceUntil: null,
            collectionPaused: false,
            companyId,
            currentPeriodEnd: null,
            processorCustomerId: null,
            processorSubscriptionId: `sub_${companyId}`,
          },
          now: Date.now(),
        },
        { kind: 'membership', id, actor: 'test-operator', reason: 'seed member seat' },
      );
    });
  }

  it('revoking the owner returns 409 and leaves one owner', async () => {
    const owner = await accessSession('company-c11-owner');
    const companyId = await createCompanyFor(owner, 'Revoke Co');

    const refused = await companyFetch('/companies/members/revoke', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: owner.accountId }),
    });
    expect(refused.status).toBe(409);

    const stored = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT role, state FROM company_members
           WHERE company_id = ? AND account_id = ?`,
        )
        .get(companyId, owner.accountId),
    );
    expect(stored).toEqual({ role: 'owner', state: 'active' });
  });

  it('revoking a member deletes their company entitlement row and keeps personal rows', async () => {
    const owner = await accessSession('company-c11-member-owner');
    const admin = await accessSession('company-c11-admin');
    const member = await accessSession('company-c11-member');
    const companyId = await createCompanyFor(owner, 'Revoke Member Co');
    await seedCompanySubscription(companyId, 3);

    const adminInvite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    const adminToken = ((await adminInvite.json()) as { token: string }).token;
    const admittedAdmin = await companyFetch('/companies/invites/redeem', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: adminToken }),
    });
    expect(admittedAdmin.status).toBe(200);

    const memberInvite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const memberToken = ((await memberInvite.json()) as { token: string }).token;
    const admittedMember = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: memberToken }),
    });
    expect(admittedMember.status).toBe(200);

    await seedMemberCompanyEntitlement(member.accountId, companyId, 'seed-c11-member');

    const memberAttempt = await companyFetch('/companies/members/revoke', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: admin.accountId }),
    });
    expect(memberAttempt.status).toBe(403);

    const revoked = await companyFetch('/companies/members/revoke', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: member.accountId }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      outcome: 'revoked',
      accountId: member.accountId,
    });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      membership: instance.db
        .prepare(
          `SELECT state, revoked_at AS revokedAt FROM company_members
           WHERE company_id = ? AND account_id = ?`,
        )
        .get(companyId, member.accountId),
      entitlements: readEntitlementsForAccount(instance.db, member.accountId),
    }));
    expect(stored.membership).toMatchObject({ state: 'revoked' });
    expect((stored.membership as { revokedAt: number | null }).revokedAt).not.toBeNull();
    expect(stored.entitlements).toEqual([]);
  });

  it('a transaction that would leave the company ownerless rolls back', async () => {
    const owner = await accessSession('company-c12-owner');
    const member = await accessSession('company-c12-member');
    const outsider = await accessSession('company-c12-outsider');
    const companyId = await createCompanyFor(owner, 'Transfer Co');
    await seedCompanySubscription(companyId, 3);

    const invite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const token = ((await invite.json()) as { token: string }).token;
    const admitted = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(admitted.status).toBe(200);

    const ownerless = await companyFetch('/companies/owner', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: outsider.accountId }),
    });
    expect(ownerless.status).toBe(409);

    const afterRollback = await runInDurableObject(identityStub(), (instance) => ({
      owner: instance.db
        .prepare(
          `SELECT role, state FROM company_members
           WHERE company_id = ? AND account_id = ?`,
        )
        .get(companyId, owner.accountId),
      outsider: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM company_members
           WHERE company_id = ? AND account_id = ?`,
        )
        .get(companyId, outsider.accountId),
      owners: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM company_members
           WHERE company_id = ? AND role = 'owner' AND state = 'active'`,
        )
        .get(companyId),
    }));
    expect(afterRollback.owner).toEqual({ role: 'owner', state: 'active' });
    expect(afterRollback.outsider).toEqual({ count: 0 });
    expect(afterRollback.owners).toEqual({ count: 1 });

    const transferred = await companyFetch('/companies/owner', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: member.accountId }),
    });
    expect(transferred.status).toBe(200);
    expect(await transferred.json()).toEqual({
      outcome: 'transferred',
      accountId: member.accountId,
    });

    const afterTransfer = await runInDurableObject(identityStub(), (instance) => ({
      previousOwner: instance.db
        .prepare(
          `SELECT role FROM company_members WHERE company_id = ? AND account_id = ?`,
        )
        .get(companyId, owner.accountId),
      newOwner: instance.db
        .prepare(
          `SELECT role FROM company_members WHERE company_id = ? AND account_id = ?`,
        )
        .get(companyId, member.accountId),
    }));
    expect(afterTransfer.previousOwner).toEqual({ role: 'admin' });
    expect(afterTransfer.newOwner).toEqual({ role: 'owner' });
  });

  it('disable revokes every seat and sets desired collection to canceled; rooms untouched', async () => {
    const owner = await accessSession('company-c13-owner');
    const member = await accessSession('company-c13-member');
    const companyId = await createCompanyFor(owner, 'Disable Co');
    await seedCompanySubscription(companyId, 3);
    await runInDurableObject(identityStub(), (instance) => {
      ensureBillingSubscription(instance.db, {
        processorSubscriptionId: `sub_${companyId}`,
        subjectKind: 'company',
        subjectId: companyId,
        now: 1,
      });
      recordOwnedRoom(instance.db, {
        accountId: owner.accountId,
        roomId: 'c13-kept-room',
        name: 'Kept Room',
        now: 2,
      });
    });

    const invite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const token = ((await invite.json()) as { token: string }).token;
    const admitted = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(admitted.status).toBe(200);
    await seedMemberCompanyEntitlement(member.accountId, companyId, 'seed-c13-member');
    await seedMemberCompanyEntitlement(owner.accountId, companyId, 'seed-c13-owner');

    const disabled = await companyFetch('/companies', owner.cookie, {
      method: 'DELETE',
    });
    expect(disabled.status).toBe(200);
    const disabledBody = (await disabled.json()) as {
      outcome: string;
      revokedAccountIds: string[];
    };
    expect(disabledBody.outcome).toBe('disabled');
    expect([...disabledBody.revokedAccountIds].sort()).toEqual(
      [owner.accountId, member.accountId].sort(),
    );

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      company: instance.db
        .prepare(`SELECT state FROM companies WHERE company_id = ?`)
        .get(companyId),
      activeMembers: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM company_members
           WHERE company_id = ? AND state = 'active'`,
        )
        .get(companyId),
      ordering: instance.db
        .prepare(
          `SELECT desired_collection AS desiredCollection,
                  desired_version AS desiredVersion,
                  applied_version AS appliedVersion
           FROM billing_subscriptions WHERE processor_subscription_id = ?`,
        )
        .get(`sub_${companyId}`),
      ownerEntitlements: readEntitlementsForAccount(instance.db, owner.accountId),
      memberEntitlements: readEntitlementsForAccount(instance.db, member.accountId),
      room: instance.db
        .prepare(
          `SELECT name FROM account_rooms WHERE account_id = ? AND room_id = ?`,
        )
        .get(owner.accountId, 'c13-kept-room'),
    }));
    expect(stored.company).toEqual({ state: 'disabled' });
    expect(stored.activeMembers).toEqual({ count: 0 });
    expect(stored.ordering).toEqual({
      desiredCollection: 'canceled',
      desiredVersion: 1,
      appliedVersion: 1,
    });
    expect(stored.ownerEntitlements).toEqual([]);
    expect(stored.memberEntitlements).toEqual([]);
    expect(stored.room).toEqual({ name: 'Kept Room' });

    const again = await companyFetch('/companies', owner.cookie, {
      method: 'DELETE',
    });
    expect(again.status).toBe(404);
  });

  it('membership reads the caller company from the session and ignores a client-supplied id', async () => {
    const ownerA = await accessSession('company-membership-a');
    const ownerB = await accessSession('company-membership-b');
    const companyA = await createCompanyFor(ownerA, 'Membership A');
    const companyB = await createCompanyFor(ownerB, 'Membership B');

    const own = await companyFetch('/companies/membership', ownerA.cookie);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({
      company: { id: companyA, name: 'Membership A', role: 'owner' },
    });

    const spoofed = await companyFetch(
      `/companies/membership?accountId=${encodeURIComponent(ownerB.accountId)}`,
      ownerA.cookie,
    );
    expect(spoofed.status).toBe(200);
    expect(await spoofed.json()).toEqual({
      company: { id: companyA, name: 'Membership A', role: 'owner' },
    });

    const other = await companyFetch('/companies/membership', ownerB.cookie);
    expect(await other.json()).toEqual({
      company: { id: companyB, name: 'Membership B', role: 'owner' },
    });

    const anonymous = await identityStub().fetch('https://identity/companies/membership');
    expect(anonymous.status).toBe(401);
  });

  it('summary returns the caller company with its members and subscription', async () => {
    const owner = await accessSession('company-summary-owner');
    const member = await accessSession('company-summary-member');
    const companyId = await createCompanyFor(owner, 'Summary Co');
    await seedCompanySubscription(companyId, 3);

    const invite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const token = ((await invite.json()) as { token: string }).token;
    await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    const response = await companyFetch('/companies', owner.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      company: { id: string; name: string; role: string };
      members: Array<{ accountId: string; role: string; state: string }>;
      subscription: { quantity: number; status: string } | null;
    };
    expect(body.company).toMatchObject({
      id: companyId,
      name: 'Summary Co',
      role: 'owner',
    });
    expect(body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: owner.accountId, role: 'owner' }),
        expect.objectContaining({ accountId: member.accountId, role: 'member' }),
      ]),
    );
    expect(body.subscription).toMatchObject({ quantity: 3, status: 'active' });

    const memberView = await companyFetch('/companies', member.cookie);
    const memberBody = (await memberView.json()) as {
      company: { role: string };
    };
    expect(memberBody.company.role).toBe('member');

    const unaffiliated = await accessSession('company-summary-outsider');
    const empty = await companyFetch('/companies', unaffiliated.cookie);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      company: null,
      members: [],
      subscription: null,
    });
  });

  it('summary exposes the pending seat operation so the admin page can settle it', async () => {
    const owner = await accessSession('company-summary-pending-owner');
    const companyId = await createCompanyFor(owner, 'Pending Summary Co');
    await seedCompanySubscription(companyId, 3);

    const reserved = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ quantity: 5, operationId: 'op_summary_pending' }),
    });
    expect(reserved.status).toBe(200);

    const summary = await companyFetch('/companies', owner.cookie);
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as {
      subscription: {
        quantity: number;
        pendingQuantity: number | null;
        pendingOperationId: string | null;
      } | null;
    };
    expect(body.subscription).toMatchObject({
      quantity: 3,
      pendingQuantity: 5,
      pendingOperationId: 'op_summary_pending',
    });
  });

  it('rename is owner/admin only and refuses a plain member', async () => {
    const owner = await accessSession('company-rename-owner');
    const admin = await accessSession('company-rename-admin');
    const member = await accessSession('company-rename-member');
    const companyId = await createCompanyFor(owner, 'Before Rename');
    await seedCompanySubscription(companyId, 3);

    const adminInvite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    const adminToken = ((await adminInvite.json()) as { token: string }).token;
    await companyFetch('/companies/invites/redeem', admin.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: adminToken }),
    });
    const memberInvite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const memberToken = ((await memberInvite.json()) as { token: string }).token;
    await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: memberToken }),
    });

    const refused = await companyFetch('/companies', member.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Member Rename' }),
    });
    expect(refused.status).toBe(403);

    const renamed = await companyFetch('/companies', admin.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'After Rename' }),
    });
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as {
      company: { name: string; role: string };
    };
    expect(renamedBody.company).toMatchObject({
      name: 'After Rename',
      role: 'admin',
    });

    const stored = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(`SELECT name FROM companies WHERE company_id = ?`)
        .get(companyId),
    );
    expect(stored).toEqual({ name: 'After Rename' });
  });

  it('forbids a plain member from minting or revoking invites', async () => {
    const owner = await accessSession('company-c6-role-owner');
    const member = await accessSession('company-c6-role-member');
    const companyId = await createCompanyFor(owner, 'Role Invite Co');
    await seedCompanySubscription(companyId, 3);

    const minted = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    const invite = (await minted.json()) as { token: string; inviteHash: string };

    const opened = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token: invite.token }),
    });
    expect(opened.status).toBe(200);

    const memberMint = await companyFetch('/companies/invites', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    expect(memberMint.status).toBe(403);

    const memberRevoke = await companyFetch('/companies/invites', member.cookie, {
      method: 'DELETE',
      body: JSON.stringify({ inviteHash: invite.inviteHash }),
    });
    expect(memberRevoke.status).toBe(403);

    const stored = await runInDurableObject(identityStub(), (instance) =>
      instance.db
        .prepare(
          `SELECT revoked_at AS revokedAt FROM company_invites WHERE invite_hash = ?`,
        )
        .get(invite.inviteHash),
    );
    expect(stored).toEqual({ revokedAt: null });
  });

  function applyBody(
    event: { id: string; type: string; created: number },
    objects: Record<string, unknown>,
  ): string {
    return JSON.stringify({
      signatureVerified: true,
      payloadHash: '7d'.repeat(32),
      event: { ...event, livemode: true },
      objects,
    });
  }

  function postApply(raw: string): Promise<Response> {
    return identityStub().fetch('https://identity/billing/events/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
  }

  function invoiceBody(
    id: string,
    opts: { customer?: string | null; amountPaid?: number; subscription?: string | null } = {},
  ): Record<string, unknown> {
    return {
      id,
      customer: opts.customer ?? null,
      status: 'paid',
      amountPaid: opts.amountPaid ?? 0,
      currency: 'gbp',
      paymentIntent: null,
      subscription: opts.subscription ?? null,
      payments: [],
    };
  }

  function subscriptionBody(
    id: string,
    status: string,
    opts: Partial<{
      customer: string | null;
      currentPeriodEnd: number | null;
      pauseCollection: { behavior: string } | null;
    }> = {},
  ): Record<string, unknown> {
    return {
      id,
      customer: opts.customer ?? null,
      status,
      canceledAt: null,
      currentPeriodEnd: opts.currentPeriodEnd ?? null,
      pauseCollection: opts.pauseCollection ?? null,
    };
  }

  async function admitMember(
    owner: LocalSession,
    member: LocalSession,
    companyId: string,
  ): Promise<void> {
    const minted = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    expect(minted.status).toBe(201);
    const token = ((await minted.json()) as { token: string }).token;
    const redeemed = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(redeemed.status).toBe(200);
    expect(((await redeemed.json()) as { companyId: string }).companyId).toBe(companyId);
  }

  it('first invoice.paid materializes every active member with one audit row each', async () => {
    const owner = await accessSession('company-c4-owner');
    const member = await accessSession('company-c4-member');
    const companyId = await createCompanyFor(owner, 'First Paid Co');
    await seedCompanySubscription(companyId, 3);
    await admitMember(owner, member, companyId);

    const response = await postApply(
      applyBody(
        { id: 'evt_c4_paid', type: 'invoice.paid', created: 500 },
        {
          invoice: invoiceBody('in_c4_paid', {
            customer: 'cus_c4',
            amountPaid: 4_500,
            subscription: `sub_${companyId}`,
          }),
        },
      ),
    );
    expect(response.status).toBe(200);

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      firstPaidAt: instance.db
        .prepare(
          `SELECT first_paid_at AS firstPaidAt FROM company_subscriptions
           WHERE company_id = ?`,
        )
        .get(companyId),
      owner: readEntitlementsForAccount(instance.db, owner.accountId),
      member: readEntitlementsForAccount(instance.db, member.accountId),
      audit: instance.db
        .prepare(
          `SELECT subject_id AS accountId FROM entitlement_audit
           WHERE cause_kind = 'processor_event' AND cause_id = 'evt_c4_paid'
           ORDER BY subject_id`,
        )
        .all(),
    }));

    expect(stored.firstPaidAt).toEqual({ firstPaidAt: 500 });
    for (const [accountId, rows] of [
      [owner.accountId, stored.owner],
      [member.accountId, stored.member],
    ] as const) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        accountId,
        source: 'company',
        planId: 'corporate_seat',
        status: 'active',
        graceUntil: null,
        collectionPaused: false,
        companyId,
        processorSubscriptionId: `sub_${companyId}`,
      });
    }
    expect(stored.audit).toEqual(
      [owner.accountId, member.accountId]
        .sort()
        .map((accountId) => ({ accountId })),
    );
  });

  it('company past_due fans out grace_until to every member row', async () => {
    const owner = await accessSession('company-c5-owner');
    const member = await accessSession('company-c5-member');
    const companyId = await createCompanyFor(owner, 'Grace Co');
    await seedCompanySubscription(companyId, 3);
    await admitMember(owner, member, companyId);

    const paid = await postApply(
      applyBody(
        { id: 'evt_c5_paid', type: 'invoice.paid', created: 500 },
        {
          invoice: invoiceBody('in_c5_paid', {
            customer: 'cus_c5',
            amountPaid: 4_500,
            subscription: `sub_${companyId}`,
          }),
        },
      ),
    );
    expect(paid.status).toBe(200);

    const pastDueAt = 700;
    const pastDue = await postApply(
      applyBody(
        { id: 'evt_c5_past_due', type: 'customer.subscription.updated', created: pastDueAt },
        {
          subscription: subscriptionBody(`sub_${companyId}`, 'past_due', {
            customer: 'cus_c5',
            currentPeriodEnd: 1_000,
            pauseCollection: { behavior: 'void' },
          }),
        },
      ),
    );
    expect(pastDue.status).toBe(200);

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      subscription: instance.db
        .prepare(
          `SELECT status, grace_until AS graceUntil,
                  collection_paused AS collectionPaused,
                  current_period_end AS currentPeriodEnd
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
      owner: readEntitlementsForAccount(instance.db, owner.accountId),
      member: readEntitlementsForAccount(instance.db, member.accountId),
      audit: instance.db
        .prepare(
          `SELECT subject_id AS accountId FROM entitlement_audit
           WHERE cause_kind = 'processor_event' AND cause_id = 'evt_c5_past_due'
           ORDER BY subject_id`,
        )
        .all(),
    }));

    expect(stored.subscription).toEqual({
      status: 'past_due',
      graceUntil: pastDueAt + PAST_DUE_GRACE_MS,
      collectionPaused: 1,
      currentPeriodEnd: 1_000,
    });
    for (const [accountId, rows] of [
      [owner.accountId, stored.owner],
      [member.accountId, stored.member],
    ] as const) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        accountId,
        source: 'company',
        status: 'past_due',
        graceUntil: pastDueAt + PAST_DUE_GRACE_MS,
        collectionPaused: true,
        currentPeriodEnd: 1_000,
      });
    }
    expect(stored.audit).toEqual(
      [owner.accountId, member.accountId]
        .sort()
        .map((accountId) => ({ accountId })),
    );
  });

  const OPERATOR_EMAIL =
    (env as unknown as { OPERATOR_EMAILS?: string }).OPERATOR_EMAILS
      ?.split(',', 1)[0]
      .trim() ?? 'ops@example.test';

  function operatorFetch(path: string, body: unknown): Promise<Response> {
    return identityStub().fetch(`https://identity${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function setCompanyCustomer(companyId: string, customerId: string): Promise<void> {
    return runInDurableObject(identityStub(), (instance) => {
      instance.db
        .prepare(`UPDATE companies SET processor_customer_id = ? WHERE company_id = ?`)
        .run(customerId, companyId);
    });
  }

  function seedDisputeHold(
    subscriptionId: string,
    disputeId: string,
    state: 'open' | 'review',
  ): Promise<void> {
    return runInDurableObject(identityStub(), (instance) => {
      upsertDisputeHold(instance.db, {
        disputeId,
        processorSubscriptionId: subscriptionId,
        state,
        now: 2_000,
      });
    });
  }

  it('summary carries each active member preferred display name and never another company’s', async () => {
    const owner = await accessSession('company-display-owner');
    const member = await accessSession('company-display-member');
    const outsider = await accessSession('company-display-outsider');
    const companyId = await createCompanyFor(owner, 'Display Co');
    await createCompanyFor(outsider, 'Other Display Co');
    await seedCompanySubscription(companyId, 3);
    await admitMember(owner, member, companyId);

    await runInDurableObject(identityStub(), (instance) => {
      setPreferredDisplayName(instance.db, owner.accountId, 'Owner Name');
      setPreferredDisplayName(instance.db, outsider.accountId, 'Other Owner Name');
    });

    const response = await companyFetch('/companies', owner.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      members: Array<{ accountId: string; preferredDisplayName: string | null }>;
    };
    const ownerRow = body.members.find((entry) => entry.accountId === owner.accountId);
    const memberRow = body.members.find((entry) => entry.accountId === member.accountId);
    expect(ownerRow).toMatchObject({ preferredDisplayName: 'Owner Name' });
    expect(memberRow).toMatchObject({ preferredDisplayName: null });
    expect(body.members.map((entry) => entry.preferredDisplayName)).not.toContain(
      'Other Owner Name',
    );
  });

  it('self-serve caller cannot approve invoicing; an allowlisted operator records the decision, operation, and audit', async () => {
    const owner = await accessSession('company-o1-owner');
    const companyId = await createCompanyFor(owner, 'Invoice Approval Co');
    await setCompanyCustomer(companyId, 'cus_o1_do');

    const denied = await operatorFetch('/operator/invoice-approval', {
      operatorEmail: 'outsider@example.test',
      companyId,
      quantity: 12,
      operationId: 'op_o1_denied',
    });
    expect(denied.status).toBe(403);
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
      audits: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM entitlement_audit
           WHERE cause_kind = 'operator' AND cause_id = 'op_o1_denied'`,
        )
        .get(),
    }));
    expect(afterDenied.company).toEqual({ invoiceApproved: 0 });
    expect(afterDenied.operations).toEqual({ count: 0 });
    expect(afterDenied.audits).toEqual({ count: 0 });

    const approved = await operatorFetch('/operator/invoice-approval', {
      operatorEmail: OPERATOR_EMAIL,
      companyId,
      quantity: 12,
      operationId: 'op_o1_approved',
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      status: 'pending',
      companyId,
      operationId: 'op_o1_approved',
      quantity: 12,
      processorCustomerId: 'cus_o1_do',
    });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      company: instance.db
        .prepare(`SELECT invoice_approved AS invoiceApproved FROM companies WHERE company_id = ?`)
        .get(companyId),
      operation: instance.db
        .prepare(
          `SELECT kind, status FROM billing_operations
           WHERE subject_kind = 'company' AND subject_id = ? AND operation_id = 'op_o1_approved'`,
        )
        .get(companyId),
      audit: instance.db
        .prepare(
          `SELECT subject_kind AS subjectKind, actor, cause_kind AS causeKind,
                  cause_id AS causeId
           FROM entitlement_audit
           WHERE cause_kind = 'operator' AND cause_id = 'op_o1_approved'`,
        )
        .get(),
    }));
    expect(stored.company).toEqual({ invoiceApproved: 1 });
    expect(stored.operation).toEqual({ kind: 'invoice-approve', status: 'pending' });
    expect(stored.audit).toEqual({
      subjectKind: 'company',
      actor: `operator:${OPERATOR_EMAIL}`,
      causeKind: 'operator',
      causeId: 'op_o1_approved',
    });
  });

  it('operator invoice approval refuses under ten seats and an already subscribed company', async () => {
    const owner = await accessSession('company-o1-limits-owner');
    const companyId = await createCompanyFor(owner, 'Invoice Limits Co');

    const belowMinimum = await operatorFetch('/operator/invoice-approval', {
      operatorEmail: OPERATOR_EMAIL,
      companyId,
      quantity: 9,
      operationId: 'op_o1_below',
    });
    expect(belowMinimum.status).toBe(409);
    expect(await belowMinimum.json()).toEqual({ error: 'Conflict', reason: 'below_minimum' });

    await seedCompanySubscription(companyId, 3);
    const subscribed = await operatorFetch('/operator/invoice-approval', {
      operatorEmail: OPERATOR_EMAIL,
      companyId,
      quantity: 12,
      operationId: 'op_o1_subscribed',
    });
    expect(subscribed.status).toBe(409);
    expect(await subscribed.json()).toEqual({
      error: 'Conflict',
      reason: 'already_subscribed',
    });
  });

  it('a settled invoice approval attaches a send_invoice subscription that entitles nobody', async () => {
    const owner = await accessSession('company-o1-settle-owner');
    const companyId = await createCompanyFor(owner, 'Invoice Settle Co');
    await setCompanyCustomer(companyId, 'cus_o1_settle');

    const approved = await operatorFetch('/operator/invoice-approval', {
      operatorEmail: OPERATOR_EMAIL,
      companyId,
      quantity: 12,
      operationId: 'op_o1_settle',
    });
    expect(approved.status).toBe(200);

    const settled = await operatorFetch('/operator/invoice-approval/settle', {
      operatorEmail: OPERATOR_EMAIL,
      companyId,
      operationId: 'op_o1_settle',
      quantity: 12,
      outcome: 'success',
      processorSubscriptionId: 'sub_o1_settle',
      status: 'active',
      hostedInvoiceUrl: 'https://invoice.stripe.test/in_o1_settle',
    });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({ status: 'settled' });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      subscription: instance.db
        .prepare(
          `SELECT processor_subscription_id AS processorSubscriptionId,
                  quantity, collection_method AS collectionMethod,
                  first_paid_at AS firstPaidAt,
                  hosted_invoice_url AS hostedInvoiceUrl
           FROM company_subscriptions WHERE company_id = ?`,
        )
        .get(companyId),
      operation: instance.db
        .prepare(
          `SELECT status, stripe_object_id AS stripeObjectId FROM billing_operations
           WHERE subject_id = ? AND operation_id = 'op_o1_settle'`,
        )
        .get(companyId),
      entitlements: readEntitlementsForAccount(instance.db, owner.accountId),
    }));
    expect(stored.subscription).toEqual({
      processorSubscriptionId: 'sub_o1_settle',
      quantity: 12,
      collectionMethod: 'send_invoice',
      firstPaidAt: null,
      hostedInvoiceUrl: 'https://invoice.stripe.test/in_o1_settle',
    });
    expect(stored.operation).toEqual({ status: 'succeeded', stripeObjectId: 'sub_o1_settle' });
    expect(stored.entitlements).toEqual([]);

    const summary = await companyFetch('/companies', owner.cookie);
    const summaryBody = (await summary.json()) as {
      subscription: {
        collectionMethod: string;
        firstPaidAt: number | null;
        hostedInvoiceUrl: string | null;
      } | null;
    };
    expect(summaryBody.subscription).toMatchObject({
      collectionMethod: 'send_invoice',
      firstPaidAt: null,
      hostedInvoiceUrl: 'https://invoice.stripe.test/in_o1_settle',
    });
  });

  it('operator dispute review resolves a review hold, audits the actor, and a non-operator cannot', async () => {
    const owner = await accessSession('company-o2-owner');
    const companyId = await createCompanyFor(owner, 'Dispute Review Co');
    await seedCompanySubscription(companyId, 3);
    await runInDurableObject(identityStub(), (instance) => {
      ensureBillingSubscription(instance.db, {
        processorSubscriptionId: `sub_${companyId}`,
        subjectKind: 'company',
        subjectId: companyId,
        now: 1,
      });
    });
    await seedDisputeHold(`sub_${companyId}`, 'dp_o2_review', 'review');

    const denied = await operatorFetch('/operator/disputes/review', {
      operatorEmail: 'outsider@example.test',
      disputeId: 'dp_o2_review',
      outcome: 'won',
      operationId: 'op_o2_denied',
    });
    expect(denied.status).toBe(403);

    const unresolved = await runInDurableObject(identityStub(), (instance) => ({
      hold: instance.db
        .prepare(`SELECT state FROM billing_dispute_holds WHERE dispute_id = 'dp_o2_review'`)
        .get(),
      audits: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM entitlement_audit
           WHERE cause_kind = 'operator' AND cause_id = 'op_o2_denied'`,
        )
        .get(),
    }));
    expect(unresolved.hold).toEqual({ state: 'review' });
    expect(unresolved.audits).toEqual({ count: 0 });

    const resolved = await operatorFetch('/operator/disputes/review', {
      operatorEmail: OPERATOR_EMAIL,
      disputeId: 'dp_o2_review',
      outcome: 'won',
      operationId: 'op_o2_won',
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({
      outcome: 'resolved',
      disputeId: 'dp_o2_review',
      state: 'won',
      desiredCollection: 'active',
    });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      hold: instance.db
        .prepare(`SELECT state FROM billing_dispute_holds WHERE dispute_id = 'dp_o2_review'`)
        .get(),
      audit: instance.db
        .prepare(
          `SELECT subject_kind AS subjectKind, subject_id AS subjectId, actor, cause_id AS causeId
           FROM entitlement_audit
           WHERE cause_kind = 'operator' AND cause_id = 'op_o2_won'`,
        )
        .get(),
      entitlements: readEntitlementsForAccount(instance.db, owner.accountId),
    }));
    expect(stored.hold).toEqual({ state: 'won' });
    expect(stored.audit).toEqual({
      subjectKind: 'company',
      subjectId: companyId,
      actor: `operator:${OPERATOR_EMAIL}`,
      causeId: 'op_o2_won',
    });
    expect(stored.entitlements).toEqual([]);
  });

  it('operator dispute review never releases collection while another dispute still holds', async () => {
    const owner = await accessSession('company-o2-holds-owner');
    const companyId = await createCompanyFor(owner, 'Dispute Holds Co');
    await seedCompanySubscription(companyId, 3);
    await runInDurableObject(identityStub(), (instance) => {
      ensureBillingSubscription(instance.db, {
        processorSubscriptionId: `sub_${companyId}`,
        subjectKind: 'company',
        subjectId: companyId,
        now: 1,
      });
      upsertDisputeHold(instance.db, {
        disputeId: 'dp_o2_other_open',
        processorSubscriptionId: `sub_${companyId}`,
        state: 'open',
        now: 2,
      });
      recomputeDesiredCollection(instance.db, {
        processorSubscriptionId: `sub_${companyId}`,
        cause: { kind: 'processor_event', id: 'evt_o2_pause', actor: 'stripe', reason: 'seed' },
        now: 2,
      });
    });
    await seedDisputeHold(`sub_${companyId}`, 'dp_o2_review_holds', 'review');
    await runInDurableObject(identityStub(), (instance) => {
      recomputeDesiredCollection(instance.db, {
        processorSubscriptionId: `sub_${companyId}`,
        cause: { kind: 'processor_event', id: 'evt_o2_pause_two', actor: 'stripe', reason: 'seed' },
        now: 3,
      });
    });

    const resolved = await operatorFetch('/operator/disputes/review', {
      operatorEmail: OPERATOR_EMAIL,
      disputeId: 'dp_o2_review_holds',
      outcome: 'won',
      operationId: 'op_o2_holds',
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      outcome: 'resolved',
      state: 'won',
      desiredCollection: 'paused',
    });

    const stored = await runInDurableObject(identityStub(), (instance) => ({
      ordering: instance.db
        .prepare(
          `SELECT desired_collection AS desiredCollection FROM billing_subscriptions
           WHERE processor_subscription_id = ?`,
        )
        .get(`sub_${companyId}`),
      openHolds: instance.db
        .prepare(
          `SELECT COUNT(*) AS count FROM billing_dispute_holds
           WHERE processor_subscription_id = ? AND state IN ('open','review')`,
        )
        .get(`sub_${companyId}`),
    }));
    expect(stored.ordering).toEqual({ desiredCollection: 'paused' });
    expect(stored.openHolds).toEqual({ count: 1 });
  });

  it('refuses cross-company and malformed company route requests', async () => {
    const owner = await accessSession('company-neg-owner');
    const member = await accessSession('company-neg-member');
    const outsider = await accessSession('company-neg-outsider');
    const companyId = await createCompanyFor(owner, 'Negative Co');
    await seedCompanySubscription(companyId, 3);
    await admitMember(owner, member, companyId);

    const notAMemberPatch = await companyFetch('/companies', outsider.cookie, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(notAMemberPatch.status).toBe(404);

    const badPatch = await companyFetch('/companies', owner.cookie, {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect(badPatch.status).toBe(400);

    const memberDelete = await companyFetch('/companies', member.cookie, {
      method: 'DELETE',
    });
    expect(memberDelete.status).toBe(403);

    const badCreate = await companyFetch('/companies', outsider.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(badCreate.status).toBe(400);

    const badCustomer = await companyFetch('/companies/customer', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(badCustomer.status).toBe(400);

    const unknownCustomerOperation = await companyFetch('/companies/customer', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({
        companyId,
        operationId: 'op_negative_missing',
        processorCustomerId: 'cus_negative',
      }),
    });
    expect(unknownCustomerOperation.status).toBe(409);
    expect(await unknownCustomerOperation.json()).toEqual({ error: 'Conflict' });

    const outsiderInvites = await companyFetch('/companies/invites', outsider.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    expect(outsiderInvites.status).toBe(404);

    const badInvite = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(badInvite.status).toBe(400);

    const badRevoke = await companyFetch('/companies/invites', owner.cookie, {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    expect(badRevoke.status).toBe(400);

    const unknownRevoke = await companyFetch('/companies/invites', owner.cookie, {
      method: 'DELETE',
      body: JSON.stringify({ inviteHash: 'b'.repeat(64) }),
    });
    expect(unknownRevoke.status).toBe(404);

    const badRedeem = await companyFetch('/companies/invites/redeem', outsider.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(badRedeem.status).toBe(400);

    const outsiderSeats = await companyFetch('/companies/seats', outsider.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(outsiderSeats.status).toBe(404);

    const badSeats = await companyFetch('/companies/seats', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(badSeats.status).toBe(400);

    const outsiderSettle = await companyFetch('/companies/seats/settle', outsider.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(outsiderSettle.status).toBe(404);

    const settleUnknown = await companyFetch('/companies/seats/settle', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'op_negative_unknown', outcome: 'success' }),
    });
    expect(settleUnknown.status).toBe(409);

    const releaseUnknown = await companyFetch('/companies/seats/settle', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'op_negative_unknown', outcome: 'failure' }),
    });
    expect(releaseUnknown.status).toBe(409);

    const outsiderRevoke = await companyFetch('/companies/members/revoke', outsider.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: member.accountId }),
    });
    expect(outsiderRevoke.status).toBe(404);

    const badMemberRevoke = await companyFetch('/companies/members/revoke', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(badMemberRevoke.status).toBe(400);

    const outsiderTransfer = await companyFetch('/companies/owner', outsider.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: member.accountId }),
    });
    expect(outsiderTransfer.status).toBe(404);

    const badTransfer = await companyFetch('/companies/owner', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(badTransfer.status).toBe(400);
  });

  it('system settle refuses an unknown company-create and a stale seat release', async () => {
    const missing = await systemSettle({
      kind: 'company-create',
      companyId: 'company-that-does-not-exist',
      operationId: 'op_settle_missing',
      processorCustomerId: 'cus_missing',
    });
    expect(missing.status).toBe(409);

    const owner = await accessSession('company-neg-settle-owner');
    const companyId = await createCompanyFor(owner, 'Settle Negative Co');

    const created = await systemSettle({
      kind: 'company-create',
      companyId,
      operationId: 'op_Settle_Negative_Co',
      processorCustomerId: 'cus_negative',
    });
    expect(created.status).toBe(200);

    const mismatch = await systemSettle({
      kind: 'company-create',
      companyId,
      operationId: 'op_Settle_Negative_Co',
      processorCustomerId: 'cus_other',
    });
    expect(mismatch.status).toBe(409);

    const released = await systemSettle({
      kind: 'seat-change',
      companyId,
      operationId: 'op_settle_no_seat',
      outcome: 'failure',
    });
    expect(released.status).toBe(409);
  });

  it('rejects non-object and unparseable bodies with a real session', async () => {
    const owner = await accessSession('company-neg-shapes-owner');
    await createCompanyFor(owner, 'Shapes Co');

    const shapeRoutes: Array<[string, string]> = [
      ['/companies', 'PATCH'],
      ['/companies/customer', 'POST'],
      ['/companies/invites', 'POST'],
      ['/companies/invites', 'DELETE'],
      ['/companies/invites/redeem', 'POST'],
      ['/companies/seats', 'POST'],
      ['/companies/seats/settle', 'POST'],
      ['/companies/members/revoke', 'POST'],
      ['/companies/owner', 'POST'],
    ];
    for (const [path, method] of shapeRoutes) {
      const response = await companyFetch(path, owner.cookie, {
        method,
        body: JSON.stringify([1, 2]),
      });
      expect(response.status, `${method} ${path}`).toBe(400);
    }

    const unparseable: Array<[string, string]> = [
      ['/companies', 'not-json'],
      ['/companies/seats', 'not-json'],
      ['/companies/seats/settle', 'not-json'],
    ];
    for (const [path, body] of unparseable) {
      const response = await companyFetch(path, owner.cookie, { method: 'POST', body });
      expect(response.status, `${path} ${body}`).toBe(400);
    }
  });

  it('operator invoice settle reports failure and pending on an approved operation', async () => {
    const owner = await accessSession('company-neg-invoice-owner');
    const companyId = await createCompanyFor(owner, 'Invoice Negative Co');
    await setCompanyCustomer(companyId, 'cus_negative_invoice');

    const approved = await operatorFetch('/operator/invoice-approval', {
      operatorEmail: OPERATOR_EMAIL,
      companyId,
      quantity: 10,
      operationId: 'op_negative_invoice',
    });
    expect(approved.status).toBe(200);

    const foreign = await operatorFetch('/operator/invoice-approval/settle', {
      operatorEmail: 'intruder@example.test',
      companyId,
      operationId: 'op_negative_invoice',
      quantity: 10,
      outcome: 'failure',
    });
    expect(foreign.status).toBe(403);

    const pending = await operatorFetch('/operator/invoice-approval/settle', {
      operatorEmail: OPERATOR_EMAIL,
      companyId,
      operationId: 'op_negative_invoice',
      quantity: 10,
      outcome: 'unknown',
    });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: 'pending' });

    const failed = await operatorFetch('/operator/invoice-approval/settle', {
      operatorEmail: OPERATOR_EMAIL,
      companyId,
      operationId: 'op_negative_invoice',
      quantity: 10,
      outcome: 'failure',
    });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ status: 'failed' });
  });

  it('system settle compares the processor customer on a pending company-create', async () => {
    const owner = await accessSession('company-neg-pending-owner');
    const companyId = await createCompanyFor(owner, 'Pending Customer Co');
    await setCompanyCustomer(companyId, 'cus_pending_seeded');

    const mismatch = await systemSettle({
      kind: 'company-create',
      companyId,
      operationId: 'op_Pending_Customer_Co',
      processorCustomerId: 'cus_pending_other',
    });
    expect(mismatch.status).toBe(409);

    const match = await systemSettle({
      kind: 'company-create',
      companyId,
      operationId: 'op_Pending_Customer_Co',
      processorCustomerId: 'cus_pending_seeded',
    });
    expect(match.status).toBe(200);
  });

  it('refuses a member invite while already a member and transfers ownership', async () => {
    const owner = await accessSession('company-neg-transfer-owner');
    const member = await accessSession('company-neg-transfer-member');
    const companyId = await createCompanyFor(owner, 'Transfer Negative Co');
    await seedCompanySubscription(companyId, 4);
    await admitMember(owner, member, companyId);

    const mine = await companyFetch('/companies/invites', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    expect(mine.status).toBe(201);
    const token = ((await mine.json()) as { token: string }).token;
    const again = await companyFetch('/companies/invites/redeem', member.cookie, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(again.status).toBe(409);

    const transfer = await companyFetch('/companies/owner', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: member.accountId }),
    });
    expect(transfer.status).toBe(200);
    expect(await transfer.json()).toEqual({ outcome: 'transferred', accountId: member.accountId });

    const forbidden = await companyFetch('/companies/owner', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: member.accountId }),
    });
    expect(forbidden.status).toBe(403);
  });

  it('rate-limits member revocation per company', async () => {
    const owner = await accessSession('company-neg-rate-owner');
    await createCompanyFor(owner, 'Rate Negative Co');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await companyFetch('/companies/members/revoke', owner.cookie, {
        method: 'POST',
        body: JSON.stringify({ accountId: 'not-a-member' }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 404));
    expect(statuses.at(-1)).toBe(429);
    const limited = await companyFetch('/companies/members/revoke', owner.cookie, {
      method: 'POST',
      body: JSON.stringify({ accountId: 'not-a-member' }),
    });
    expect(await limited.json()).toMatchObject({ error: 'Too many requests' });
  });

  it('operator dispute review refuses a hold that is not under review', async () => {
    const owner = await accessSession('company-neg-dispute-owner');
    const companyId = await createCompanyFor(owner, 'Dispute Negative Co');
    await seedCompanySubscription(companyId, 3);
    await runInDurableObject(identityStub(), (instance) => {
      ensureBillingSubscription(instance.db, {
        processorSubscriptionId: `sub_${companyId}`,
        subjectKind: 'company',
        subjectId: companyId,
        now: 1,
      });
      upsertDisputeHold(instance.db, {
        disputeId: 'dp_negative_won',
        processorSubscriptionId: `sub_${companyId}`,
        state: 'won',
        now: 2,
      });
    });

    const response = await operatorFetch('/operator/disputes/review', {
      operatorEmail: OPERATOR_EMAIL,
      disputeId: 'dp_negative_won',
      outcome: 'won',
      operationId: 'op_negative_dispute',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Conflict', reason: 'not_review' });
  });
});
