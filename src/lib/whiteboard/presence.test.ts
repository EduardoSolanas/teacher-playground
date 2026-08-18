import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from './roomDb';
import { readActiveUsers } from './presence';
import { getRoomAllowFirstUserHost, setRoomAllowFirstUserHost } from './roomSchema';
import { insertOwner } from './membership';

let db: Database.Database;

const ROOM = 'ROOM1234';

function seedRoom(hostPeerId: string | null, allowFirstUserHost = 0) {
  db.prepare(
    `INSERT INTO rooms (room_id, host_peer_id, allow_first_user_host, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ROOM, hostPeerId, allowFirstUserHost, Date.now(), Date.now());
}

function seedPeer(peerId: string, firstSeen: number, accountId?: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ROOM, peerId, `user-${peerId}`, '#112233', firstSeen, now, accountId ?? null);
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('first-user host fallback is an opt-in room setting', () => {
  it('defaults to disabled so no one silently becomes host', () => {
    seedRoom(null);

    expect(getRoomAllowFirstUserHost(db, ROOM)).toBe(false);
  });

  it('grants no host when the room has no recorded host and the setting is off', () => {
    seedRoom(null);
    seedPeer('alice', 1);
    seedPeer('bob', 2);

    const users = readActiveUsers(db, ROOM);

    expect(users.map((user) => user.isHost)).toEqual([false, false]);
  });

  it('grants host to the earliest peer when the setting is on', () => {
    seedRoom(null, 1);
    seedPeer('alice', 1);
    seedPeer('bob', 2);

    const users = readActiveUsers(db, ROOM);

    expect(users.map((user) => [user.peerId, user.isHost])).toEqual([
      ['alice', true],
      ['bob', false],
    ]);
  });

  it('never lets the fallback override an owner grant', () => {
    seedRoom(null, 1);
    insertOwner(db, ROOM, 'acc-bob', 1);
    seedPeer('alice', 1);
    seedPeer('bob', 2, 'acc-bob');

    const users = readActiveUsers(db, ROOM);

    expect(users.map((user) => [user.peerId, user.isHost])).toEqual([
      ['alice', false],
      ['bob', true],
    ]);
  });

  it('does not treat host_peer_id as creator rights', () => {
    seedRoom('alice', 0);
    seedPeer('alice', 1);
    seedPeer('bob', 2);

    const users = readActiveUsers(db, ROOM);

    expect(users.map((user) => user.isHost)).toEqual([false, false]);
  });

  it('round-trips the setting through the store', () => {
    seedRoom(null);

    setRoomAllowFirstUserHost(db, ROOM, true);
    expect(getRoomAllowFirstUserHost(db, ROOM)).toBe(true);

    setRoomAllowFirstUserHost(db, ROOM, false);
    expect(getRoomAllowFirstUserHost(db, ROOM)).toBe(false);
  });

  it('defaults the column to off when a row omits it entirely', () => {
    db.prepare(
      `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
    ).run(ROOM, Date.now(), Date.now());

    expect(getRoomAllowFirstUserHost(db, ROOM)).toBe(false);
  });

  it('reports disabled for a room that does not exist', () => {
    expect(getRoomAllowFirstUserHost(db, 'NOSUCH')).toBe(false);
  });

  it('migrates an existing rooms table to the new column, defaulting to off', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE rooms (
        room_id TEXT PRIMARY KEY,
        elements TEXT NOT NULL DEFAULT '[]',
        viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    legacy.prepare(
      `INSERT INTO rooms (room_id, created_at, updated_at) VALUES (?, ?, ?)`,
    ).run(ROOM, Date.now(), Date.now());

    applySchema(legacy);

    expect(getRoomAllowFirstUserHost(legacy, ROOM)).toBe(false);
  });
});
