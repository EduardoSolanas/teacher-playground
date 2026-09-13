import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import { RoomDO } from './RoomDO';
import { applyIdentitySchema, recordOwnedRoom } from '../lib/identity/identityStore';
import { getFileBytesTotal } from '../lib/whiteboard/roomSchema';
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

function archiveStateUrl(accountId: string, roomId: string): string {
  return `https://identity/accounts/rooms/archive-state?accountId=${encodeURIComponent(accountId)}&roomId=${encodeURIComponent(roomId)}`;
}

async function seedPaidPlan(accountId: string): Promise<void> {
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
          processorCustomerId: null,
          processorSubscriptionId: `sub-archive-${accountId}`,
        },
        now: Date.now(),
      },
      {
        kind: 'operator',
        id: `archive-seed-${crypto.randomUUID()}`,
        actor: 'test-operator',
        reason: 'seed paid state',
      },
    );
  });
}

async function downgradePlan(accountId: string): Promise<void> {
  await runInDurableObject(identityStub(), (instance: IdentityDO) => {
    writeEntitlement(
      instance.db,
      {
        accountId,
        source: 'personal',
        state: {
          planId: 'tutor_pro_monthly',
          status: 'canceled',
          graceUntil: null,
          collectionPaused: false,
          companyId: null,
          currentPeriodEnd: null,
          processorCustomerId: null,
          processorSubscriptionId: `sub-archive-${accountId}`,
        },
        now: Date.now(),
      },
      {
        kind: 'processor_event',
        id: `archive-downgrade-${crypto.randomUUID()}`,
        actor: 'stripe',
        reason: 'customer.subscription.deleted',
      },
    );
  });
}

async function seedOwnedRoom(
  accountId: string,
  roomId: string,
  updatedAt: number,
): Promise<void> {
  await runInDurableObject(identityStub(), (instance: IdentityDO) => {
    recordOwnedRoom(instance.db, { accountId, roomId, now: updatedAt });
  });
}

async function createRoomDirectly(roomId: string, accountId: string): Promise<Response> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  return stub.fetch(new Request(
    `https://room/room?roomId=${encodeURIComponent(roomId)}&accountId=${encodeURIComponent(accountId)}&guest=0`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [] }),
    },
  ));
}

function writeScene(
  roomId: string,
  who: LocalAuthSession,
  elements: unknown[],
): Promise<Response> {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements }),
  });
}

function readRoom(roomId: string, who: LocalAuthSession): Promise<Response> {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who);
}

function fileAction(
  roomId: string,
  accountId: string,
  action: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<Response> {
  const query = new URLSearchParams({ roomId, accountId });
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(
    `https://room/room/files/${action}?${query.toString()}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

function fileBytesTotal(roomId: string): Promise<number> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  return runInDurableObject(stub, (instance: RoomDO) => getFileBytesTotal(instance.db, roomId));
}

async function joinPresence(
  who: LocalAuthSession,
  roomId: string,
  peerId: string,
): Promise<{ response: Response; peerId: string }> {
  const response = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peerId, userName: peerId, color: '#3498db' }),
  });
  let resolvedPeerId = peerId;
  try {
    const data = await response.clone().json() as { peerId?: string };
    if (typeof data.peerId === 'string') resolvedPeerId = data.peerId;
  } catch {
    // Non-JSON error bodies still expose the status to the caller.
  }
  return { response, peerId: resolvedPeerId };
}

function approvePeer(
  roomId: string,
  owner: LocalAuthSession,
  peerId: string,
): Promise<Response> {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peerId, action: 'approve' }),
  });
}

interface OverQuotaFixture {
  owner: LocalAuthSession;
  archivedRoomId: string;
  activeRoomId: string;
}

/**
 * A paid owner with two owned rooms who then downgrades to Free.
 *
 * Only the first room can be created through the Worker: the owned-room
 * reservation still enforces the Free cap, so the second room's row is created
 * through the real RoomDO route directly and indexed with the real
 * `recordOwnedRoom`. The older room is pinned first so which room the quota
 * archives is deterministic.
 */
async function seedDowngradedOwner(): Promise<OverQuotaFixture> {
  const owner = await bootstrapLocalSession(`archive-owner-${crypto.randomUUID()}`);
  const archivedRoomId = `archive-old-${crypto.randomUUID()}`;
  const activeRoomId = `archive-new-${crypto.randomUUID()}`;

  await seedPaidPlan(owner.accountId);

  const created = await authenticatedFetch(`/api/whiteboard/room/${archivedRoomId}`, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      elements: [{ id: 'before-downgrade', type: 'rectangle' }],
    }),
  });
  expect(created.status).toBe(200);

  const base = Date.now();
  await seedOwnedRoom(owner.accountId, archivedRoomId, base);

  const direct = await createRoomDirectly(activeRoomId, owner.accountId);
  expect(direct.status).toBe(200);
  await seedOwnedRoom(owner.accountId, activeRoomId, base + 1_000);

  await downgradePlan(owner.accountId);
  return { owner, archivedRoomId, activeRoomId };
}

describe('an over-quota room after a plan downgrade', () => {
  it('is readable and refuses scene writes, preserved, and writable again after re-upgrade', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    const refused = await writeScene(archivedRoomId, owner, [
      { id: 'after-downgrade', type: 'rectangle' },
    ]);
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });

    const readable = await readRoom(archivedRoomId, owner);
    expect(readable.status).toBe(200);
    const body = await readable.json() as { elements: Array<{ id: string }> };
    expect(body.elements.map((element) => element.id)).toEqual(['before-downgrade']);

    await seedPaidPlan(owner.accountId);

    const restored = await writeScene(archivedRoomId, owner, [
      { id: 'after-upgrade', type: 'rectangle' },
    ]);
    expect(restored.status).toBe(200);
    const afterRestore = await readRoom(archivedRoomId, owner);
    const restoredBody = await afterRestore.json() as { elements: Array<{ id: string }> };
    expect(restoredBody.elements.map((element) => element.id)).toEqual(['after-upgrade']);
  });

  it('refuses to admit a new peer and admits one again after re-upgrade', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();
    const student = await bootstrapLocalSession(`archive-student-${crypto.randomUUID()}`);

    const joined = await joinPresence(student, archivedRoomId, 'archive-peer');
    expect(joined.response.status).toBe(200);

    const refused = await approvePeer(archivedRoomId, owner, joined.peerId);
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });
    expect((await readRoom(archivedRoomId, student)).status).toBe(403);

    await seedPaidPlan(owner.accountId);

    const admitted = await approvePeer(archivedRoomId, owner, joined.peerId);
    expect(admitted.status).toBe(200);
    expect((await readRoom(archivedRoomId, student)).status).toBe(200);
  });

  it('keeps the most recently used owned room active and archives the older one', async () => {
    const { owner, archivedRoomId, activeRoomId } = await seedDowngradedOwner();

    const activeWrite = await writeScene(activeRoomId, owner, [
      { id: 'active-write', type: 'rectangle' },
    ]);
    expect(activeWrite.status).toBe(200);

    const archivedWrite = await writeScene(archivedRoomId, owner, [
      { id: 'archived-write', type: 'rectangle' },
    ]);
    expect(archivedWrite.status).toBe(PLAN_LIMIT_STATUS);
  });

  it('refuses an owner clearing an archived room board', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    const cleared = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/clear`,
      owner,
      { method: 'POST' },
    );
    expect(cleared.status).toBe(PLAN_LIMIT_STATUS);
    expect(await cleared.json()).toEqual({ error: PLAN_LIMIT_ERROR });
  });

  it('refuses an owner saving settings on an archived room and saves again after re-upgrade', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    const refused = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/settings`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'archived-settings' }),
      },
    );
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });

    const readable = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/settings`,
      owner,
    );
    expect(readable.status).toBe(200);

    await seedPaidPlan(owner.accountId);

    const saved = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/settings`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'restored-settings' }),
      },
    );
    expect(saved.status).toBe(200);

    const afterRestore = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/settings`,
      owner,
    );
    expect((await afterRestore.json() as { name: string }).name).toBe('restored-settings');
  });

  it('refuses an owner saving the library on an archived room and saves again after re-upgrade', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    const refused = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/library`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ id: 'archived-shape', elements: [] }] }),
      },
    );
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });

    const readable = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/library`,
      owner,
    );
    expect(readable.status).toBe(200);

    await seedPaidPlan(owner.accountId);

    const saved = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/library`,
      owner,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ id: 'restored-shape', elements: [] }] }),
      },
    );
    expect(saved.status).toBe(200);

    const afterRestore = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/library`,
      owner,
    );
    const items = (await afterRestore.json() as { items: Array<{ id: string }> }).items;
    expect(items.map((item) => item.id)).toEqual(['restored-shape']);
  });

  it('refuses a file reservation on an archived room and reserves again after re-upgrade', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    const refused = await fileAction(archivedRoomId, owner.accountId, 'reserve', 'POST', {
      bytes: 1024,
    });
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });
    expect(await fileBytesTotal(archivedRoomId)).toBe(0);

    await seedPaidPlan(owner.accountId);

    const reserved = await fileAction(archivedRoomId, owner.accountId, 'reserve', 'POST', {
      bytes: 1024,
    });
    expect(reserved.status).toBe(200);
    expect(await fileBytesTotal(archivedRoomId)).toBe(1024);
  });

  it('refuses a file settlement on an archived room and settles again after re-upgrade', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    const refused = await fileAction(archivedRoomId, owner.accountId, 'settle', 'POST', {
      reserved: 0,
      actual: 1024,
    });
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });
    expect(await fileBytesTotal(archivedRoomId)).toBe(0);

    await seedPaidPlan(owner.accountId);

    const settled = await fileAction(archivedRoomId, owner.accountId, 'settle', 'POST', {
      reserved: 0,
      actual: 1024,
    });
    expect(settled.status).toBe(200);
    expect(await fileBytesTotal(archivedRoomId)).toBe(1024);
  });

  it('refuses a file write authorization on an archived room while the read stays open', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    const refused = await fileAction(archivedRoomId, owner.accountId, 'authorize-write', 'GET');
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });

    const readable = await fileAction(archivedRoomId, owner.accountId, 'authorize-read', 'GET');
    expect(readable.status).toBe(200);

    await seedPaidPlan(owner.accountId);

    const authorized = await fileAction(archivedRoomId, owner.accountId, 'authorize-write', 'GET');
    expect(authorized.status).toBe(200);
  });

  it('refuses a PATCH settings write on an archived room and saves again after re-upgrade', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    const refused = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/settings`,
      owner,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'patched-settings' }),
      },
    );
    expect(refused.status).toBe(PLAN_LIMIT_STATUS);
    expect(await refused.json()).toEqual({ error: PLAN_LIMIT_ERROR });

    await seedPaidPlan(owner.accountId);

    const saved = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/settings`,
      owner,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'patched-settings' }),
      },
    );
    expect(saved.status).toBe(200);

    const afterRestore = await authenticatedFetch(
      `/api/whiteboard/room/${archivedRoomId}/settings`,
      owner,
    );
    expect((await afterRestore.json() as { name: string }).name).toBe('patched-settings');
  });

  it('fails closed on writes when the archive-state read fails', async () => {
    const { archivedRoomId } = await seedDowngradedOwner();
    const roomStub = env.ROOMS.get(env.ROOMS.idFromName(archivedRoomId));
    const refusableOwnerId = 'o'.repeat(129);
    await runInDurableObject(roomStub, (instance: RoomDO) => {
      instance.db.prepare(
        `UPDATE room_members SET account_id = ? WHERE room_id = ? AND role = 'owner'`,
      ).run(refusableOwnerId, archivedRoomId);
    });

    const refused = await roomStub.fetch(new Request(
      `https://room/room?roomId=${encodeURIComponent(archivedRoomId)}&accountId=${refusableOwnerId}&guest=0`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      },
    ));
    expect(refused.status).toBe(403);
  });

  it('fails closed on writes when the archive-state entitlements read throws', async () => {
    const { owner, archivedRoomId } = await seedDowngradedOwner();

    await runInDurableObject(identityStub(), (instance: IdentityDO) => {
      instance.db.exec('DROP TABLE entitlements');
    });

    /*
     * The dropped table makes the identity object throw while the room object
     * is failing the write closed, so workerd reports that expected fault as
     * an unhandled rejection. Vitest skips reporting an unhandled error when
     * user code listens for it, so this keeps the deliberate fault from
     * failing the run while the 403 assertion below still proves the guard.
     */
    const swallowExpectedFault = () => {};
    process.on('unhandledRejection', swallowExpectedFault);
    try {
      const refused = await writeScene(archivedRoomId, owner, [
        { id: 'after-entitlements-fault', type: 'rectangle' },
      ]);
      expect(refused.status).toBe(403);
    } finally {
      // Worker-test storage is shared per file; re-apply the schema the DO
      // applies at startup so later tests can still seed entitlements.
      await runInDurableObject(identityStub(), (instance: IdentityDO) => {
        applyIdentitySchema(instance.db);
      });
      process.off('unhandledRejection', swallowExpectedFault);
    }
  });

  it('rejects malformed archive-state requests', async () => {
    const owner = await bootstrapLocalSession(`archive-bad-request-${crypto.randomUUID()}`);
    const roomId = `archive-bad-${crypto.randomUUID()}`;
    await seedOwnedRoom(owner.accountId, roomId, 1_000);

    const [longAccount, badRoom, post] = await Promise.all([
      identityStub().fetch(archiveStateUrl('a'.repeat(129), roomId)),
      identityStub().fetch(archiveStateUrl(owner.accountId, 'not a room id')),
      identityStub().fetch(
        archiveStateUrl(owner.accountId, roomId),
        { method: 'POST' },
      ),
    ]);

    expect(longAccount.status).toBe(400);
    expect(badRoom.status).toBe(400);
    expect(post.status).toBe(405);
  });

  it('breaks equal last-used timestamps deterministically by room id', async () => {
    const owner = await bootstrapLocalSession(`archive-tie-${crypto.randomUUID()}`);
    const roomIds = [
      `archive-tie-b-${crypto.randomUUID()}`,
      `archive-tie-a-${crypto.randomUUID()}`,
    ].sort();
    // The higher id lands first, so insertion order alone would pick it.
    await seedOwnedRoom(owner.accountId, roomIds[1], 5_000);
    await seedOwnedRoom(owner.accountId, roomIds[0], 5_000);

    const higherId = await identityStub().fetch(
      archiveStateUrl(owner.accountId, roomIds[1]),
    );
    const lowerId = await identityStub().fetch(
      archiveStateUrl(owner.accountId, roomIds[0]),
    );
    expect(await higherId.json()).toEqual({ archived: true });
    expect(await lowerId.json()).toEqual({ archived: false });
  });

  it('answers the archive-state read from the effective plan and owned count', async () => {
    const owner = await bootstrapLocalSession(`archive-state-${crypto.randomUUID()}`);
    const olderRoomId = `archive-state-old-${crypto.randomUUID()}`;
    const newerRoomId = `archive-state-new-${crypto.randomUUID()}`;
    await seedOwnedRoom(owner.accountId, olderRoomId, 1_000);
    await seedOwnedRoom(owner.accountId, newerRoomId, 2_000);

    const overQuota = await identityStub().fetch(
      archiveStateUrl(owner.accountId, olderRoomId),
    );
    expect(overQuota.status).toBe(200);
    expect(await overQuota.json()).toEqual({ archived: true });

    await seedPaidPlan(owner.accountId);

    const covered = await identityStub().fetch(
      archiveStateUrl(owner.accountId, olderRoomId),
    );
    expect(covered.status).toBe(200);
    expect(await covered.json()).toEqual({ archived: false });
  });
});
