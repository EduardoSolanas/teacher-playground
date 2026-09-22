import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { applySchema } from '../whiteboard/roomSchema';
import {
  approveAccount,
  banAccount,
  insertOwner,
  requestAccess,
} from '../whiteboard/membership';
import type { RoomDatabase } from '../whiteboard/db';
import { issueAvTokenResponse } from './handleAvToken';
import { verifyLiveKitToken } from './livekitToken';

function memoryDb(): RoomDatabase {
  const db = new Database(':memory:');
  applySchema(db as unknown as RoomDatabase);
  return db as unknown as RoomDatabase;
}

const LIVEKIT_ENV = {
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'key_abc',
  LIVEKIT_API_SECRET: 'secret_xyz',
};

describe('issueAvTokenResponse', () => {
  it('returns 503 when LiveKit is unconfigured', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    const res = await issueAvTokenResponse({
      db,
      env: {},
      roomId: 'room-1',
      accountId: 'acct-owner',
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      error: 'LiveKit is not configured',
      reason: 'unconfigured',
    });
  });

  it('returns 403 for a non-member', async () => {
    const db = memoryDb();
    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'stranger',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ error: 'Forbidden', reason: 'not-a-member' });
  });

  it('returns 403 for a waiting participant', async () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('room-1', 'peer-w', 'Waiter', '#fff', Date.now(), 'acct-wait');

    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-wait',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      error: 'A/V available after admission',
      reason: 'waiting',
    });
  });

  it('returns 403 for a banned account', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    requestAccess(db, { roomId: 'room-1', accountId: 'acct-banned', userName: 'Peer' });
    approveAccount(db, 'room-1', 'acct-banned', { role: 'editor' });
    banAccount(db, 'room-1', 'acct-banned');

    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-banned',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'not-a-member' });
  });

  it('returns 403 for a banned account even when still in waiting_peers', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    requestAccess(db, { roomId: 'room-1', accountId: 'acct-banned', userName: 'Peer' });
    approveAccount(db, 'room-1', 'acct-banned', { role: 'editor' });
    banAccount(db, 'room-1', 'acct-banned');
    db.prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('room-1', 'peer-b', 'Peer', '#fff', Date.now(), 'acct-banned');

    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-banned',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(['not-a-member', 'banned']).toContain(body.reason);
    expect(body.reason).not.toBe('waiting');
  });

  it('returns 403 when a member is back in the waiting queue', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    requestAccess(db, { roomId: 'room-1', accountId: 'acct-member', userName: 'Peer' });
    approveAccount(db, 'room-1', 'acct-member', { role: 'editor' });
    db.prepare(
      `INSERT INTO waiting_peers (room_id, peer_id, user_name, color, requested_at, account_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('room-1', 'peer-m', 'Member', '#fff', Date.now(), 'acct-member');

    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-member',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'waiting' });
  });

  it('binds an opaque server-derived identity, never a chosen label or the raw accountId', async () => {
    // LiveKit disconnects the existing holder of an identity when a second
    // session joins with it, so a client-chosen identity would let one
    // admitted participant bump another off the call: the identity is always
    // derived by the server from the verified account. It must also not BE
    // the account id (audit M4): LiveKit shows every participant every other
    // participant's identity, and the HTTP layer deliberately redacts
    // accountIds from non-owner presence.
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-owner',
      name: 'Host',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      url: string;
      room: string;
      identity: string;
    };
    expect(body.url).toBe(LIVEKIT_ENV.LIVEKIT_URL);
    expect(body.room).toBe('room-1');
    expect(body.identity).not.toBe('acct-owner');
    const verified = await verifyLiveKitToken(body.token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    expect(verified.payload.sub).toBe(body.identity);
    expect(verified.payload.sub).not.toBe('acct-owner');
    expect((verified.payload.video as { room: string }).room).toBe('room-1');
  });

  it('embeds the server-provided presence peerId as token metadata, and none when it is absent', async () => {
    // The roster joins LiveKit participants to presence rows by peerId, which
    // rides the JWT `metadata` claim. The peerId reaching this mint is looked
    // up by the server from presence state, never taken from the client, and
    // the accountId must never appear in the claim (M4): LiveKit shows every
    // participant every other participant's metadata.
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');

    const withPeer = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-owner',
      peerId: 'peer-owner-1',
    });
    expect(withPeer.status).toBe(200);
    const withPeerBody = (await withPeer.json()) as { token: string };
    const withPeerPayload = (
      await verifyLiveKitToken(withPeerBody.token, LIVEKIT_ENV.LIVEKIT_API_SECRET)
    ).payload;
    expect(withPeerPayload.metadata).toBe(JSON.stringify({ peerId: 'peer-owner-1' }));
    expect(withPeerPayload.metadata).not.toContain('acct-owner');

    const withoutPeer = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-owner',
    });
    expect(withoutPeer.status).toBe(200);
    const withoutPeerBody = (await withoutPeer.json()) as { token: string };
    const withoutPeerPayload = (
      await verifyLiveKitToken(withoutPeerBody.token, LIVEKIT_ENV.LIVEKIT_API_SECRET)
    ).payload;
    expect(withoutPeerPayload).not.toHaveProperty('metadata');
  });

  it('derives the same identity for the same account and room across two mints', async () => {
    // The Room Service API targets participants (kick eviction, mute, the
    // screen-share widen) by recomputing the identity later, so a second
    // mint for one account in one room must land on the same value.
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    const mint = async () => {
      const res = await issueAvTokenResponse({
        db,
        env: LIVEKIT_ENV,
        roomId: 'room-1',
        accountId: 'acct-owner',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { identity: string };
      return body.identity;
    };
    expect(await mint()).toBe(await mint());
  });

  it('derives a different identity for the same account in a different room', async () => {
    // A global pseudonym would let anyone with both rosters link one person
    // across rooms, which is the same privacy leak one level up.
    const db = memoryDb();
    insertOwner(db, 'room-a', 'acct-owner');
    insertOwner(db, 'room-b', 'acct-owner');
    const mint = async (roomId: string) => {
      const res = await issueAvTokenResponse({
        db,
        env: LIVEKIT_ENV,
        roomId,
        accountId: 'acct-owner',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { identity: string };
      return body.identity;
    };
    expect(await mint('room-a')).not.toBe(await mint('room-b'));
  });

  it('issues a token for an admitted member', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    requestAccess(db, { roomId: 'room-1', accountId: 'acct-member', userName: 'Peer' });
    approveAccount(db, 'room-1', 'acct-member', { role: 'editor' });
    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-member',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { identity: string };
    expect(body.identity).not.toBe('acct-member');
  });

  it('viewer token has canPublish false and canPublishData false', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    requestAccess(db, { roomId: 'room-1', accountId: 'acct-viewer', userName: 'Viewer' });
    approveAccount(db, 'room-1', 'acct-viewer', { role: 'viewer' });
    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-viewer',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; identity: string };
    expect(body.identity).not.toBe('acct-viewer');

    const verified = await verifyLiveKitToken(body.token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    const video = verified.payload.video as Record<string, unknown>;
    expect(video.canPublish).toBe(false);
    expect(video.canPublishData).toBe(false);
    expect(video.canSubscribe).toBe(true);
    expect(video.roomJoin).toBe(true);
  });

  it('editor token has canPublish true', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    requestAccess(db, { roomId: 'room-1', accountId: 'acct-editor', userName: 'Editor' });
    approveAccount(db, 'room-1', 'acct-editor', { role: 'editor' });
    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-editor',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const verified = await verifyLiveKitToken(body.token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    const video = verified.payload.video as Record<string, unknown>;
    expect(video.canPublish).toBe(true);
    expect(video.canPublishData).toBe(true);
    expect(video.canSubscribe).toBe(true);
    expect(video.roomJoin).toBe(true);
  });

  it('owner token has canPublish true', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-owner',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const verified = await verifyLiveKitToken(body.token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    const video = verified.payload.video as Record<string, unknown>;
    expect(video.canPublish).toBe(true);
    expect(video.canPublishData).toBe(true);
    expect(video.canSubscribe).toBe(true);
    expect(video.roomJoin).toBe(true);
  });


  it('keeps screen share to the owner: every other token publishes camera and microphone only', async () => {
    // Host-controlled sharing is the classroom default (Phase 10). The owner's
    // token names no allowlist; a participant gets screen share only when the
    // owner grants it for the live call, never from the token.
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    requestAccess(db, { roomId: 'room-1', accountId: 'acct-editor', userName: 'Editor' });
    approveAccount(db, 'room-1', 'acct-editor', { role: 'editor' });

    const videoFor = async (accountId: string) => {
      const res = await issueAvTokenResponse({ db, env: LIVEKIT_ENV, roomId: 'room-1', accountId });
      expect(res.status).toBe(200);
      const { token } = (await res.json()) as { token: string };
      return (await verifyLiveKitToken(token, LIVEKIT_ENV.LIVEKIT_API_SECRET)).payload.video as Record<string, unknown>;
    };

    const ownerVideo = await videoFor('acct-owner');
    expect(Object.prototype.hasOwnProperty.call(ownerVideo, 'canPublishSources')).toBe(false);
    expect(ownerVideo.canPublish).toBe(true);

    const editorVideo = await videoFor('acct-editor');
    expect(editorVideo.canPublishSources).toEqual(['camera', 'microphone']);
    expect(editorVideo.canPublish).toBe(true);
  });

  it('token identity and room are verified server values', async () => {
    const db = memoryDb();
    insertOwner(db, 'room-1', 'acct-owner');
    const res = await issueAvTokenResponse({
      db,
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-owner',
      name: 'Owner Display Name',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; identity: string; room: string };
    expect(body.identity).not.toBe('acct-owner');
    expect(body.room).toBe('room-1');
    const verified = await verifyLiveKitToken(body.token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    expect(verified.payload.sub).toBe(body.identity);
    expect(verified.payload.sub).not.toBe('acct-owner');
    const video = verified.payload.video as Record<string, unknown>;
    expect(video.room).toBe('room-1');
  });
});
