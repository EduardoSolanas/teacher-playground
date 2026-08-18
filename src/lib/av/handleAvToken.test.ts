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
  LIVEKIT_API_SECRET: 'secret_xyz_long_enough',
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
    expect(await res.json()).toMatchObject({ reason: 'unconfigured' });
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
    expect(await res.json()).toMatchObject({ reason: 'not-a-member' });
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
    expect(await res.json()).toMatchObject({ reason: 'waiting' });
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

  it('binds the token identity to the verified account, never a chosen label', async () => {
    // LiveKit disconnects the existing holder of an identity when a second
    // session joins with it, so a client-chosen identity would let one
    // admitted participant bump another off the call. The identity is
    // therefore always the server-verified account id.
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
    expect(body.identity).toBe('acct-owner');
    const verified = await verifyLiveKitToken(body.token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    expect(verified.payload.sub).toBe('acct-owner');
    expect((verified.payload.video as { room: string }).room).toBe('room-1');
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
    const body = (await res.json()) as { identity: string };
    expect(body.identity).toBe('acct-member');
  });
});
