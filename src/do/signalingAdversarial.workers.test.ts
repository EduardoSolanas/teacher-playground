import { describe, expect, it } from 'vitest';
import {
  authenticatedFetch,
  bootstrapLocalSession,
  type LocalAuthSession,
} from '../test/workerAuth';

async function writeRoom(roomId: string, who: LocalAuthSession, body: Record<string, unknown> = { elements: [] }) {
  return authenticatedFetch(`/api/whiteboard/room/${roomId}`, who, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function grantViewer(owner: LocalAuthSession, viewer: LocalAuthSession, roomId: string) {
  expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/requests`, viewer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: 'Viewer' }),
  })).status).toBe(201);
  expect((await authenticatedFetch(
    `/api/whiteboard/room/${roomId}/requests/${viewer.accountId}`,
    owner,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', role: 'viewer' }),
    },
  )).status).toBe(200);
}

async function signalingUpgrade(
  who: LocalAuthSession,
  roomId: string,
  origin?: string,
) {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (origin !== undefined) headers.Origin = origin;
  return authenticatedFetch(`/signaling?room=${roomId}`, who, { headers });
}

async function connectGranted(who: LocalAuthSession, roomId: string): Promise<WebSocket> {
  const res = await signalingUpgrade(who, roomId);
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket on response');
  ws.accept();
  return ws;
}

function assertNoBoardBytes(payload: unknown, marker: string) {
  const text = JSON.stringify(payload);
  expect(payload).not.toHaveProperty('elements');
  expect(text).not.toMatch(/"elements"/);
  expect(text).not.toContain(marker);
}

describe('raw-client adversarial: pending/outsider GET must not leak board bytes', () => {
  it('returns 403 without elements for an outsider and a pending waiter', async () => {
    const owner = await bootstrapLocalSession('adv-get-owner');
    const outsider = await bootstrapLocalSession('adv-get-outsider');
    const roomId = 'adv-pending-get-room';
    const marker = 'secret-board-dot';

    expect((await writeRoom(roomId, owner, {
      elements: [{ id: marker }],
    })).status).toBe(200);

    const outsiderGet = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider);
    expect(outsiderGet.status).toBe(403);
    assertNoBoardBytes(await outsiderGet.json(), marker);

    expect((await authenticatedFetch(`/api/whiteboard/room/${roomId}/presence`, outsider, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId: 'pending-peer', userName: 'Guest', color: '#3498db' }),
    })).status).toBe(200);

    const pendingGet = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, outsider);
    expect(pendingGet.status).toBe(403);
    assertNoBoardBytes(await pendingGet.json(), marker);
  });
});

describe('raw-client adversarial: viewer cannot POST scene', () => {
  it('returns 403 and leaves stored scene unchanged', async () => {
    const owner = await bootstrapLocalSession('adv-scene-owner');
    const viewer = await bootstrapLocalSession('adv-scene-viewer');
    const roomId = 'adv-viewer-scene-room';
    const original = [{ id: 'keep-dot' }];

    expect((await writeRoom(roomId, owner, { elements: original })).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const before = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(before.status).toBe(200);
    const beforeBody = await before.json() as { elements: unknown };
    expect(beforeBody.elements).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'keep-dot' })]));

    const hijack = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, viewer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements: [{ id: 'stolen-dot' }] }),
    });
    expect(hijack.status).toBe(403);

    const after = await authenticatedFetch(`/api/whiteboard/room/${roomId}`, owner);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      elements: [expect.objectContaining({ id: 'keep-dot' })],
    });
  });
});

describe('raw-client adversarial: signaling Origin', () => {
  it('does not upgrade when Origin is wrong', async () => {
    const owner = await bootstrapLocalSession('adv-origin-owner');
    const roomId = 'adv-signaling-origin-room';
    expect((await writeRoom(roomId, owner)).status).toBe(200);

    const rejected = await signalingUpgrade(owner, roomId, 'https://attacker.example');
    expect(rejected.status).not.toBe(101);
    expect([401, 403]).toContain(rejected.status);
    expect(rejected.webSocket).toBeNull();
  });
});

describe('raw-client adversarial: viewer JSON publish does not fan out', () => {
  it('does not change the owner socket received frames', async () => {
    const owner = await bootstrapLocalSession('adv-publish-owner');
    const viewer = await bootstrapLocalSession('adv-publish-viewer');
    const roomId = 'adv-viewer-publish-room';

    expect((await writeRoom(roomId, owner)).status).toBe(200);
    await grantViewer(owner, viewer, roomId);

    const ownerSocket = await connectGranted(owner, roomId);
    const viewerSocket = await connectGranted(viewer, roomId);

    let received = false;
    ownerSocket.addEventListener('message', () => { received = true; }, { once: true });

    viewerSocket.send(JSON.stringify({ type: 'publish', topic: 'room', data: 'hello' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);
  });
});
