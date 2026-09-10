import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import * as Y from 'yjs';
import { getIdentityObject, type IdentityDO } from './IdentityDO';
import { RoomDO, SOCKET_REVOKED_CLOSE_CODE } from './RoomDO';
import { banAccount } from '../lib/whiteboard/membership';
import { encodeUpdateFrame } from '../lib/whiteboard/serverSync';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

const SOCKET_CLOSE_DEADLINE_MS = 5_000;

function roomStub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function identityStub() {
  return getIdentityObject(env.IDENTITY as DurableObjectNamespace<IdentityDO>);
}

async function writeRoom(roomId: string, who: LocalAuthSession): Promise<Response> {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [] }),
  });
}

async function openSocket(who: LocalAuthSession, roomId: string): Promise<WebSocket> {
  const res = await authenticatedFetch(`/signaling?room=${roomId}`, who, {
    headers: { Upgrade: 'websocket' },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket on response');
  ws.accept();
  return ws;
}

function closeSignal(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('socket was not closed by the revocation alarm')),
      SOCKET_CLOSE_DEADLINE_MS,
    );
    ws.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event.code);
    }, { once: true });
  });
}

async function forceRevocationDeadline(roomId: string): Promise<void> {
  await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
    const internal = instance as unknown as {
      checkIntervalMs: number;
      lastRevocationCheckAt: number;
    };
    internal.lastRevocationCheckAt = Date.now() - internal.checkIntervalMs;
  });
}

async function requestAndApprove(
  owner: LocalAuthSession,
  member: LocalAuthSession,
  roomId: string,
  role: 'peer' | 'viewer' = 'peer',
): Promise<void> {
  expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, member, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: 'Member' }),
  })).status).toBe(201);
  expect((await authenticatedFetch(
    `/api/whiteboard/room/${roomId}/requests/${member.accountId}`,
    owner,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', role }),
    },
  )).status).toBe(200);
}

describe('session revocation closes live signaling sockets', () => {
  it('closes a socket when its exact session is logged out', async () => {
    const roomId = 'session-revocation-logout-room';
    const subject = await bootstrapLocalSession('session-revocation-logout');
    expect((await writeRoom(roomId, subject)).status).toBe(200);
    const ws = await openSocket(subject, roomId);
    const closed = closeSignal(ws);

    const logout = await identityStub().fetch('https://identity/sessions/logout', {
      method: 'POST',
      headers: { cookie: subject.cookie },
      body: null,
    });
    expect(logout.status).toBe(204);

    await forceRevocationDeadline(roomId);
    await runDurableObjectAlarm(roomStub(roomId));

    expect(await closed).toBe(SOCKET_REVOKED_CLOSE_CODE);
  });
});

describe('moderation revocation closes live signaling sockets', () => {
  it('closes a granted account socket when the owner rejects it from the waiting queue', async () => {
    const roomId = 'waiting-reject-close-room';
    const owner = await bootstrapLocalSession('waiting-reject-close-owner');
    const member = await bootstrapLocalSession('waiting-reject-close-member');
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await requestAndApprove(owner, member, roomId);

    const ws = await openSocket(member, roomId);
    const closed = closeSignal(ws);

    const reject = await authenticatedFetch(`/api/whiteboard/room/${roomId}/waiting`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', accountId: member.accountId }),
    });
    expect(reject.status).toBe(200);

    // The close has to land from the owner's own request; waiting for the alarm
    // is exactly the 30-second window this rejects.
    expect(await closed).toBe(SOCKET_REVOKED_CLOSE_CODE);
  });

  it('closes a socket whose editor grant has expired when the alarm runs', async () => {
    const roomId = 'expired-grant-close-room';
    const owner = await bootstrapLocalSession('expired-grant-close-owner');
    const member = await bootstrapLocalSession('expired-grant-close-member');
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await requestAndApprove(owner, member, roomId);

    const ws = await openSocket(member, roomId);
    const closed = closeSignal(ws);

    // Expiry is only reachable by moving the real grant row's clock back; the
    // alarm's purge then removes it, and authorization already reads it absent.
    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      instance.db.prepare(
        `UPDATE room_members SET expires_at = ? WHERE room_id = ? AND account_id = ?`,
      ).run(Date.now() - 1, roomId, member.accountId);
    });

    await forceRevocationDeadline(roomId);
    await runDurableObjectAlarm(roomStub(roomId));

    expect(await closed).toBe(SOCKET_REVOKED_CLOSE_CODE);
  });
});

describe('socket accounting ignores sockets that are no longer open', () => {
  it('does not count a closing socket against the account cap', async () => {
    const roomId = 'closing-socket-count-room';
    const owner = await bootstrapLocalSession('closing-socket-count-owner');
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    const ws = await openSocket(owner, roomId);

    const counts = await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx;
      const server = ctx.getWebSockets()[0];
      const count = (accountId: string) =>
        (instance as unknown as {
          countAccountSockets(id: string): number;
        }).countAccountSockets(accountId);
      const before = count(owner.accountId);
      server.close(SOCKET_REVOKED_CLOSE_CODE, 'cap test');
      return {
        before,
        after: count(owner.accountId),
        listed: ctx.getWebSockets().length,
      };
    });

    expect(counts.before).toBe(1);
    // The closed socket is still listed in this turn, so "listed" alone is not
    // the count; only OPEN sockets are.
    expect(counts.listed).toBe(1);
    expect(counts.after).toBe(0);
    ws.close();
  });

  it('does not count a closing socket against the per-room upgrade cap', async () => {
    const roomId = 'closing-socket-room-cap-room';
    const owner = await bootstrapLocalSession('closing-socket-room-cap-owner');
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    const ws = await openSocket(owner, roomId);

    const status = await runInDurableObject(roomStub(roomId), async (instance: RoomDO) => {
      const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx;
      const server = ctx.getWebSockets()[0];
      server.close(SOCKET_REVOKED_CLOSE_CODE, 'cap test');
      RoomDO.signalingMaxSocketsPerRoomForTests = 1;
      try {
        const url = new URL(
          `https://room/signaling?roomId=${roomId}`
          + `&accountId=${owner.accountId}`
          + `&sessionId=${'a'.repeat(64)}`
          + '&accountEpoch=0&guest=0',
        );
        const response = await (instance as unknown as {
          handleSignalingUpgrade(request: Request, url: URL): Promise<Response>;
        }).handleSignalingUpgrade(
          new Request(url, { headers: { Upgrade: 'websocket' } }),
          url,
        );
        return response.status;
      } finally {
        RoomDO.signalingMaxSocketsPerRoomForTests = null;
      }
    });

    // The cap check runs synchronously before the upgrade's first await, while
    // the closed socket is still listed -- the exact old behavior this filters.
    expect(status).toBe(101);
    ws.close();
  });
});

describe('banned sockets stop receiving room broadcasts', () => {
  /**
   * Bans on the real membership row without running the kick path, so the
   * socket is still open when the next broadcast is attempted. That is the
   * state the recipient filters exist for: a ban that has not yet been
   * noticed, or a grant that lapsed between checks.
   */
  async function banDirectly(roomId: string, accountId: string): Promise<void> {
    await runInDurableObject(roomStub(roomId), (instance: RoomDO) => {
      banAccount(instance.db, roomId, accountId);
    });
  }

  function collectFrames(ws: WebSocket, sink: ArrayBuffer[]): void {
    ws.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) sink.push(event.data);
    });
  }

  async function waitForFrame(sink: ArrayBuffer[]): Promise<void> {
    await vi.waitFor(() => {
      expect(sink.length).toBeGreaterThan(0);
    }, { timeout: SOCKET_CLOSE_DEADLINE_MS, interval: 20 });
  }

  it('does not deliver a writer sync frame to a banned account socket', async () => {
    const roomId = 'banned-relay-sync-room';
    const owner = await bootstrapLocalSession('banned-relay-sync-owner');
    const witness = await bootstrapLocalSession('banned-relay-sync-witness');
    const banned = await bootstrapLocalSession('banned-relay-sync-banned');
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await requestAndApprove(owner, witness, roomId);
    await requestAndApprove(owner, banned, roomId);

    const ownerSocket = await openSocket(owner, roomId);
    const witnessSocket = await openSocket(witness, roomId);
    const bannedSocket = await openSocket(banned, roomId);
    await banDirectly(roomId, banned.accountId);

    const witnessFrames: ArrayBuffer[] = [];
    const bannedFrames: ArrayBuffer[] = [];
    collectFrames(witnessSocket, witnessFrames);
    collectFrames(bannedSocket, bannedFrames);

    const seed = new Y.Doc();
    seed.getMap('cursors').set('banned-relay-cursor', { x: 1, y: 2 });
    ownerSocket.send(encodeUpdateFrame(Y.encodeStateAsUpdate(seed)).buffer as ArrayBuffer);

    // The witness proves the relay happened; only then is "the banned socket
    // got nothing" a real assertion rather than a race that passed.
    await waitForFrame(witnessFrames);
    expect(bannedFrames).toHaveLength(0);

    ownerSocket.close();
    witnessSocket.close();
    bannedSocket.close();
  });

  it('does not deliver an awareness frame to a banned account socket', async () => {
    const roomId = 'banned-relay-awareness-room';
    const owner = await bootstrapLocalSession('banned-relay-awareness-owner');
    const witness = await bootstrapLocalSession('banned-relay-awareness-witness');
    const banned = await bootstrapLocalSession('banned-relay-awareness-banned');
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await requestAndApprove(owner, witness, roomId);
    await requestAndApprove(owner, banned, roomId);

    const ownerSocket = await openSocket(owner, roomId);
    const witnessSocket = await openSocket(witness, roomId);
    const bannedSocket = await openSocket(banned, roomId);
    await banDirectly(roomId, banned.accountId);

    const witnessFrames: ArrayBuffer[] = [];
    const bannedFrames: ArrayBuffer[] = [];
    collectFrames(witnessSocket, witnessFrames);
    collectFrames(bannedSocket, bannedFrames);

    // Type 1 is an awareness frame: relayed raw, which is the second relay
    // loop the granted-recipient filter has to cover.
    ownerSocket.send(new Uint8Array([1, 0]).buffer as ArrayBuffer);

    await waitForFrame(witnessFrames);
    expect(bannedFrames).toHaveLength(0);

    ownerSocket.close();
    witnessSocket.close();
    bannedSocket.close();
  });

  it('does not broadcast presence to a banned account socket', async () => {
    const roomId = 'banned-presence-room';
    const owner = await bootstrapLocalSession('banned-presence-owner');
    const banned = await bootstrapLocalSession('banned-presence-banned');
    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await requestAndApprove(owner, banned, roomId);

    const ownerSocket = await openSocket(owner, roomId);
    const bannedSocket = await openSocket(banned, roomId);
    await banDirectly(roomId, banned.accountId);

    const ownerFrames: ArrayBuffer[] = [];
    const bannedFrames: ArrayBuffer[] = [];
    collectFrames(ownerSocket, ownerFrames);
    collectFrames(bannedSocket, bannedFrames);

    const joiner = await bootstrapLocalSession('banned-presence-joiner');
    const join = await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, joiner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'joiner-peer', userName: 'Joiner', color: '#123456' }),
    });
    expect(join.status).toBe(200);

    await waitForFrame(ownerFrames);
    expect(bannedFrames).toHaveLength(0);

    ownerSocket.close();
    bannedSocket.close();
  });

  it('does not send the clear-board frame to a banned account socket', async () => {
    const roomId = 'banned-clear-room';
    const owner = await bootstrapLocalSession('banned-clear-owner');
    const viewer = await bootstrapLocalSession('banned-clear-viewer');
    const banned = await bootstrapLocalSession('banned-clear-banned');
    // A seeded element is what makes the clear produce an update at all.
    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'clear-dot' }] }),
    })).status).toBe(200);
    await requestAndApprove(owner, viewer, roomId, 'viewer');
    await requestAndApprove(owner, banned, roomId);

    const viewerSocket = await openSocket(viewer, roomId);
    const bannedSocket = await openSocket(banned, roomId);
    await banDirectly(roomId, banned.accountId);

    const viewerFrames: ArrayBuffer[] = [];
    const bannedFrames: ArrayBuffer[] = [];
    collectFrames(viewerSocket, viewerFrames);
    collectFrames(bannedSocket, bannedFrames);

    const clear = await authenticatedFetch(`/api/whiteboard/room/${roomId}/clear`, owner, {
      method: 'POST',
    });
    expect(clear.status).toBe(200);

    // Viewers are granted and must keep receiving; the banned socket must not
    // learn that the board was emptied.
    await waitForFrame(viewerFrames);
    expect(bannedFrames).toHaveLength(0);

    viewerSocket.close();
    bannedSocket.close();
  });
});
