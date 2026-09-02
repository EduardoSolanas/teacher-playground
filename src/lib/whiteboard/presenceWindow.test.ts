import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { applySchema } from './roomDb';
import { ACTIVE_WINDOW_MS, activePeerIds, readActiveUsers } from './presence';

/*
 * The active window, tested directly.
 *
 * `last_seen` is written in exactly two places and read by three, and until
 * now nothing asserted what the reads do with it. A change that stopped the
 * client heartbeat passed the whole suite while every roster in production
 * would have collapsed within ten seconds. These are the tests that would
 * have caught it.
 */

let db: Database.Database;
const ROOM = 'ROOMWNDW';

/** Far enough either side of the boundary that clock drift cannot flip it. */
const MARGIN_MS = 2_000;

function seedPeer(peerId: string, lastSeen: number, firstSeen = lastSeen) {
  db.prepare(
    `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ROOM, peerId, `user-${peerId}`, '#112233', firstSeen, lastSeen, `acc-${peerId}`);
}

function rowCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM room_presence`).get() as { n: number };
  return row.n;
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.prepare(
    `INSERT INTO rooms (room_id, host_peer_id, allow_first_user_host, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ROOM, null, 0, Date.now(), Date.now());
});

describe('the presence active window', () => {
  it('counts a peer that reported inside the window', () => {
    seedPeer('fresh', Date.now() - (ACTIVE_WINDOW_MS - MARGIN_MS));
    expect(activePeerIds(db, ROOM).has('fresh')).toBe(true);
    expect(readActiveUsers(db, ROOM).map((u) => u.peerId)).toContain('fresh');
  });

  it('drops a peer that stopped reporting', () => {
    // The failure this guards: a client that stops posting keeps its socket,
    // looks connected to itself, and quietly ceases to exist for everybody.
    seedPeer('silent', Date.now() - (ACTIVE_WINDOW_MS + MARGIN_MS));
    expect(activePeerIds(db, ROOM).has('silent')).toBe(false);
    expect(readActiveUsers(db, ROOM).map((u) => u.peerId)).not.toContain('silent');
  });

  it('drops only the silent peer, not the room with it', () => {
    seedPeer('here', Date.now() - (ACTIVE_WINDOW_MS - MARGIN_MS));
    seedPeer('gone', Date.now() - (ACTIVE_WINDOW_MS + MARGIN_MS));
    expect(readActiveUsers(db, ROOM).map((u) => u.peerId)).toEqual(['here']);
  });

  it('sweeps the stale row away rather than reading past it for ever', () => {
    seedPeer('gone', Date.now() - (ACTIVE_WINDOW_MS + MARGIN_MS));
    expect(rowCount()).toBe(1);
    readActiveUsers(db, ROOM, { sweep: true });
    expect(rowCount()).toBe(0);
  });

  it('sweeps only the room it was asked about', () => {
    /*
     * The read is per-room; the sweep was not. A room being read had no
     * business deleting the rows of a room nobody had mentioned -- and a peer
     * quietly stale in one room could be swept by traffic in another, which is
     * a coupling nothing here wants and nothing states.
     */
    db.prepare(
      `INSERT INTO rooms (room_id, host_peer_id, allow_first_user_host, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('OTHERRM', null, 0, Date.now(), Date.now());
    const stale = Date.now() - (ACTIVE_WINDOW_MS + MARGIN_MS);
    db.prepare(
      `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('OTHERRM', 'theirs', 'user-theirs', '#112233', stale, stale, 'acc-theirs');
    seedPeer('gone', stale);

    readActiveUsers(db, ROOM, { sweep: true });

    expect(rowCount()).toBe(1);
    const remaining = db.prepare(
      `SELECT room_id AS roomId FROM room_presence`,
    ).all() as Array<{ roomId: string }>;
    expect(remaining.map((r) => r.roomId)).toEqual(['OTHERRM']);
  });

  it('orders the roster by arrival, not by last report', () => {
    // first_seen is what orders the roster and what the first-user host
    // fallback elects on, so a heartbeat must never be allowed to reset it.
    const now = Date.now();
    seedPeer('second', now - 1_000, now - 60_000);
    seedPeer('first', now - 500, now - 120_000);
    expect(readActiveUsers(db, ROOM).map((u) => u.peerId)).toEqual(['first', 'second']);
  });

  it('agrees with itself about who is here', () => {
    // activePeerIds sweeps departed cursors and counts against the room limit,
    // readActiveUsers builds the roster. The two reading the same rows
    // differently is how a cursor outlives its owner, or a seat leaks.
    const now = Date.now();
    seedPeer('a', now - (ACTIVE_WINDOW_MS - MARGIN_MS));
    seedPeer('b', now - (ACTIVE_WINDOW_MS + MARGIN_MS));
    seedPeer('c', now);
    const ids = activePeerIds(db, ROOM);
    const roster = new Set(readActiveUsers(db, ROOM).map((u) => u.peerId));
    expect([...ids].sort()).toEqual([...roster].sort());
  });

  it('leaves the peers of another room alone', () => {
    db.prepare(
      `INSERT INTO rooms (room_id, host_peer_id, allow_first_user_host, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('OTHERRM', null, 0, Date.now(), Date.now());
    seedPeer('mine', Date.now());
    db.prepare(
      `INSERT INTO room_presence (room_id, peer_id, user_name, color, first_seen, last_seen, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('OTHERRM', 'theirs', 'user-theirs', '#112233', Date.now(), Date.now(), 'acc-theirs');

    expect(activePeerIds(db, ROOM)).toEqual(new Set(['mine']));
    expect(activePeerIds(db, 'OTHERRM')).toEqual(new Set(['theirs']));
  });
});
