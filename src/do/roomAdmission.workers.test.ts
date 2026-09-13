import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import { RoomDO } from './RoomDO';
import { writeEntitlement } from '../lib/identity/entitlementWriter';
import { PLAN_LIMIT_ERROR, PLAN_LIMIT_STATUS } from '../lib/plan/limits';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

function identityStub() {
  return getIdentityObject(env.IDENTITY);
}

async function seedActivePlan(
  accountId: string,
  planId: 'tutor_pro_monthly' | 'tutor_pro_annual',
): Promise<void> {
  await runInDurableObject(identityStub(), (instance: IdentityDO) => {
    writeEntitlement(
      instance.db,
      {
        accountId,
        source: 'personal',
        state: {
          planId,
          status: 'active',
          graceUntil: null,
          collectionPaused: false,
          companyId: null,
          currentPeriodEnd: null,
          processorCustomerId: null,
          processorSubscriptionId: `sub-${planId}-${accountId}`,
        },
        now: Date.now(),
      },
      {
        kind: 'operator',
        id: `room-admission-seed-${accountId}`,
        actor: 'test-operator',
        reason: 'seed paid state',
      },
    );
  });
}

async function joinPresence(who: LocalAuthSession, roomId: string, peerId: string) {
  const res = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peerId, userName: peerId, color: '#3498db' }),
  });
  let resolvedPeerId = peerId;
  try {
    const data = await res.clone().json() as { peerId?: string };
    if (typeof data.peerId === 'string') resolvedPeerId = data.peerId;
  } catch {
    resolvedPeerId = peerId;
  }
  return { res, peerId: resolvedPeerId };
}

describe('room admission against the owner plan', () => {
  let owner: LocalAuthSession;
  let roomId: string;

  beforeEach(async () => {
    owner = await bootstrapLocalSession(`plan-admission-owner-${crypto.randomUUID()}`);
    roomId = `plan-admission-${crypto.randomUUID()}`;
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    })).status).toBe(200);
  });

  async function approveStudent(who: LocalAuthSession, peerId: string): Promise<Response> {
    const joined = await joinPresence(who, roomId, peerId);
    expect(joined.res.status).toBe(200);
    return authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: joined.peerId, action: 'approve' }),
    });
  }

  async function approveByAccountId(who: LocalAuthSession, peerId: string): Promise<Response> {
    const joined = await joinPresence(who, roomId, peerId);
    expect(joined.res.status).toBe(200);
    return authenticatedFetch(
      `/api/whiteboard/room/${roomId}/requests/${encodeURIComponent(who.accountId)}`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    );
  }

  it('caps a free room at the owner plus one student', async () => {
    const first = await bootstrapLocalSession(`plan-free-first-${crypto.randomUUID()}`);
    const second = await bootstrapLocalSession(`plan-free-second-${crypto.randomUUID()}`);

    expect((await approveStudent(first, 'first-peer')).status).toBe(200);

    const refused = await approveStudent(second, 'second-peer');
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, second)).status).toBe(403);
  });

  it('admits a paid owner up to 10 held seats and refuses the 11th with the existing 402', async () => {
    const students: LocalAuthSession[] = [];
    for (let index = 0; index < 10; index += 1) {
      students.push(await bootstrapLocalSession(`plan-paid-student-${index}-${crypto.randomUUID()}`));
    }

    expect((await approveStudent(students[0], 'paid-peer-0')).status).toBe(200);

    await seedActivePlan(owner.accountId, 'tutor_pro_monthly');

    for (let index = 1; index < 9; index += 1) {
      expect((await approveStudent(students[index], `paid-peer-${index}`)).status).toBe(200);
    }

    const refused = await approveStudent(students[9], 'paid-peer-9');
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, students[9])).status).toBe(403);
  });

  it('counts a granted student that has left as still holding a seat', async () => {
    const first = await bootstrapLocalSession(`plan-held-first-${crypto.randomUUID()}`);
    const second = await bootstrapLocalSession(`plan-held-second-${crypto.randomUUID()}`);

    const joined = await joinPresence(first, roomId, 'held-peer');
    expect(joined.res.status).toBe(200);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: joined.peerId, action: 'approve' }),
    })).status).toBe(200);

    expect((await authenticatedFetch(
      `/api/whiteboard/room/${roomId}/presence?peerId=${encodeURIComponent(joined.peerId)}`,
      first,
      { method: 'DELETE' },
    )).status).toBe(200);

    const refused = await approveStudent(second, 'held-second-peer');
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, second)).status).toBe(403);
  });

  it('fails closed when the owner plan read errors', async () => {
    const student = await bootstrapLocalSession(`plan-failclosed-${crypto.randomUUID()}`);
    const joined = await joinPresence(student, roomId, 'failclosed-peer');
    expect(joined.res.status).toBe(200);

    const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    const refusableOwnerId = 'o'.repeat(129);
    await runInDurableObject(roomStub, (instance: RoomDO) => {
      instance.db.prepare(
        `UPDATE room_members SET account_id = ? WHERE room_id = ? AND role = 'owner'`,
      ).run(refusableOwnerId, roomId);
    });

    const refused = await roomStub.fetch(new Request(
      `https://room/room/waiting?roomId=${roomId}&accountId=${refusableOwnerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peerId: joined.peerId, action: 'approve' }),
      },
    ));
    expect(refused.status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, student)).status).toBe(403);
  });

  it('caps a free room through the direct approve route too', async () => {
    const first = await bootstrapLocalSession(`plan-direct-first-${crypto.randomUUID()}`);
    const second = await bootstrapLocalSession(`plan-direct-second-${crypto.randomUUID()}`);

    expect((await approveByAccountId(first, 'direct-first-peer')).status).toBe(200);

    const refused = await approveByAccountId(second, 'direct-second-peer');
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, second)).status).toBe(403);
  });

  it('admits a paid owner up to 10 held seats through the direct approve route and refuses the 11th', async () => {
    await seedActivePlan(owner.accountId, 'tutor_pro_monthly');
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/settings`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxUsers: 10 }),
    })).status).toBe(200);

    const students: LocalAuthSession[] = [];
    for (let index = 0; index < 10; index += 1) {
      students.push(await bootstrapLocalSession(`plan-direct-paid-${index}-${crypto.randomUUID()}`));
    }

    for (let index = 0; index < 9; index += 1) {
      expect((await approveByAccountId(students[index], `direct-paid-peer-${index}`)).status).toBe(200);
    }

    const refused = await approveByAccountId(students[9], 'direct-paid-peer-9');
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, students[9])).status).toBe(403);
  });

  it('fails closed when the direct approve plan read errors', async () => {
    const student = await bootstrapLocalSession(`plan-direct-failclosed-${crypto.randomUUID()}`);
    const joined = await joinPresence(student, roomId, 'direct-failclosed-peer');
    expect(joined.res.status).toBe(200);

    const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    const refusableOwnerId = 'o'.repeat(129);
    await runInDurableObject(roomStub, (instance: RoomDO) => {
      instance.db.prepare(
        `UPDATE room_members SET account_id = ? WHERE room_id = ? AND role = 'owner'`,
      ).run(refusableOwnerId, roomId);
    });

    const refused = await roomStub.fetch(new Request(
      `https://room/room/requests/${encodeURIComponent(student.accountId)}?roomId=${roomId}&accountId=${refusableOwnerId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', role: 'peer' }),
      },
    ));
    expect(refused.status).toBe(403);
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, student)).status).toBe(403);
  });
});
