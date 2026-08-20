import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from './roomSchema';
import type { RoomDatabase } from './db';
import {
  issueGuestPin,
  rotateGuestPin,
  revokeGuestAccess,
  readGuestPin,
  verifyGuestPin,
  GUEST_PIN_LENGTH,
  GUEST_PIN_FAILURE_THRESHOLD,
  GUEST_PIN_FAILURE_WINDOW_MS,
  GUEST_PIN_LOCKOUT_DURATION_MS,
  GUEST_PIN_VALIDITY_DURATION_MS,
  isGuestJoinLockedOut,
} from './guestPin';

describe('isGuestJoinLockedOut', () => {
  it('is true only while lockoutUntil is in the future', () => {
    expect(isGuestJoinLockedOut(100, 50)).toBe(true);
    expect(isGuestJoinLockedOut(100, 100)).toBe(false);
    expect(isGuestJoinLockedOut(100, 101)).toBe(false);
    expect(isGuestJoinLockedOut(null, 50)).toBe(false);
  });
});

let db: RoomDatabase;
const testRoomId = 'test-room-123';
const anotherRoomId = 'test-room-456';

beforeEach(() => {
  const database = new Database(':memory:');
  applySchema(database);
  db = database;

  // Create test rooms
  const now = Date.now();
  db.prepare(
    `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, name, allow_first_user_host, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(testRoomId, '[]', '{}', 3, null, 'Test Room', 0, now, now);

  db.prepare(
    `INSERT INTO rooms (room_id, elements, viewport, max_users, host_peer_id, name, allow_first_user_host, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(anotherRoomId, '[]', '{}', 3, null, 'Another Room', 0, now, now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('guestPin module', () => {
  describe('constants', () => {
    it('exports the correct PIN length', () => {
      expect(GUEST_PIN_LENGTH).toBe(6);
    });

    it('exports the correct failure threshold', () => {
      expect(GUEST_PIN_FAILURE_THRESHOLD).toBe(50);
    });

    it('exports the correct failure window duration', () => {
      expect(GUEST_PIN_FAILURE_WINDOW_MS).toBe(10 * 60 * 1000);
    });

    it('exports the correct lockout duration', () => {
      expect(GUEST_PIN_LOCKOUT_DURATION_MS).toBe(15 * 60 * 1000);
    });

    it('exports the correct PIN validity duration', () => {
      expect(GUEST_PIN_VALIDITY_DURATION_MS).toBe(12 * 60 * 60 * 1000);
    });
  });

  describe('issueGuestPin', () => {
    it('sets guest_access to 1', () => {
      const now = Date.now();
      issueGuestPin(db, testRoomId, now);

      const row = db.prepare(`SELECT guest_access FROM rooms WHERE room_id = ?`).get(testRoomId) as
        | { guest_access: number }
        | undefined;

      expect(row?.guest_access).toBe(1);
    });

    it('returns a 6-digit zero-padded string', () => {
      const now = Date.now();
      const pin = issueGuestPin(db, testRoomId, now);

      expect(pin).toMatch(/^\d{6}$/);
      expect(pin.length).toBe(6);
    });

    it('stores the PIN in plaintext', () => {
      const now = Date.now();
      const pin = issueGuestPin(db, testRoomId, now);

      const row = db.prepare(`SELECT guest_pin FROM rooms WHERE room_id = ?`).get(testRoomId) as
        | { guest_pin: string }
        | undefined;

      expect(row?.guest_pin).toBe(pin);
    });

    it('sets guest_pin_expires_at to now + 12 hours', () => {
      const now = Date.now();
      issueGuestPin(db, testRoomId, now);

      const row = db.prepare(`SELECT guest_pin_expires_at FROM rooms WHERE room_id = ?`).get(
        testRoomId
      ) as { guest_pin_expires_at: number } | undefined;

      const expectedExpiry = now + GUEST_PIN_VALIDITY_DURATION_MS;
      expect(row?.guest_pin_expires_at).toBe(expectedExpiry);
    });

    it('clears failure counters', () => {
      const now = Date.now();
      // Simulate some failed attempts first
      db.prepare(`UPDATE rooms SET guest_failed_count = 5 WHERE room_id = ?`).run(testRoomId);
      db.prepare(`UPDATE rooms SET guest_failed_window_at = ? WHERE room_id = ?`).run(
        now - 1000,
        testRoomId
      );

      issueGuestPin(db, testRoomId, now);

      const row = db.prepare(
        `SELECT guest_failed_count, guest_failed_window_at, guest_lockout_until FROM rooms WHERE room_id = ?`
      ).get(testRoomId) as
        | {
            guest_failed_count: number;
            guest_failed_window_at: number | null;
            guest_lockout_until: number | null;
          }
        | undefined;

      expect(row?.guest_failed_count).toBe(0);
      expect(row?.guest_failed_window_at).toBeNull();
      expect(row?.guest_lockout_until).toBeNull();
    });

    it('generates different PINs on successive calls', () => {
      const now = Date.now();
      const pin1 = issueGuestPin(db, testRoomId, now);
      const pin2 = issueGuestPin(db, testRoomId, now + 1);

      expect(pin1).not.toBe(pin2);
    });

    it('does not use Math.random; CSPRNG is load-bearing', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const now = Date.now();
      const pins = Array.from({ length: 8 }, (_, i) => issueGuestPin(db, testRoomId, now + i * 1000));

      // All should be 6-digit strings
      for (const pin of pins) {
        expect(pin).toMatch(/^\d{6}$/);
      }

      // All should be distinct (prove CSPRNG is actually being used)
      const uniquePins = new Set(pins);
      expect(uniquePins.size).toBe(pins.length);
    });

    it('rejects biased values via rejection sampling: rejects value >= 16,000,000', () => {
      const now = Date.now();
      const getRandomValuesSpy = vi.spyOn(crypto, 'getRandomValues');

      // First call returns a value in the rejection zone (16,500,000 = 0xFBC520)
      // Second call returns a valid value (1,000,000 = 0x0F4240)
      let callCount = 0;
      getRandomValuesSpy.mockImplementation((buffer: any) => {
        const bytes = buffer as Uint8Array;
        callCount++;
        if (callCount === 1) {
          // 16,500,000 = 0xFBC520 -> bytes[0]=0xFB, bytes[1]=0xC5, bytes[2]=0x20
          bytes[0] = 0xfb;
          bytes[1] = 0xc5;
          bytes[2] = 0x20;
        } else {
          // 1,000,000 = 0x0F4240 -> bytes[0]=0x0F, bytes[1]=0x42, bytes[2]=0x40
          bytes[0] = 0x0f;
          bytes[1] = 0x42;
          bytes[2] = 0x40;
        }
        return buffer;
      });

      const pin = issueGuestPin(db, testRoomId, now);

      // crypto.getRandomValues should have been called twice (first rejected, second accepted)
      expect(getRandomValuesSpy).toHaveBeenCalledTimes(2);

      // The returned PIN should correspond to the second draw (1,000,000 % 1,000,000 = 0)
      // which becomes '000000'
      expect(pin).toBe('000000');
    });

    it('rejection sampling boundary: 16,000,000 is rejected, 15,999,999 is accepted', () => {
      const now = Date.now();

      // Test that exactly 16,000,000 is in the rejection zone
      {
        const getRandomValuesSpy = vi.spyOn(crypto, 'getRandomValues');
        let callCount = 0;
        getRandomValuesSpy.mockImplementation((buffer: any) => {
          const bytes = buffer as Uint8Array;
          callCount++;
          if (callCount === 1) {
            // First call: 16,000,000 = 0xF42400 -> should be rejected
            bytes[0] = 0xf4;
            bytes[1] = 0x24;
            bytes[2] = 0x00;
          } else {
            // Subsequent calls: return a valid value (1000 = 0x0003E8)
            bytes[0] = 0x00;
            bytes[1] = 0x03;
            bytes[2] = 0xe8;
          }
          return buffer;
        });

        issueGuestPin(db, testRoomId, now);

        // Should have been called multiple times (rejected at 16,000,000, retried)
        const callCount2 = getRandomValuesSpy.mock.calls.length;
        expect(callCount2).toBeGreaterThan(1);

        vi.restoreAllMocks();
      }

      // Now test 15,999,999 which should be accepted
      {
        const getRandomValuesSpy = vi.spyOn(crypto, 'getRandomValues');
        getRandomValuesSpy.mockImplementation((buffer: any) => {
          const bytes = buffer as Uint8Array;
          // 15,999,999 = 0xF423FF -> bytes[0]=0xF4, bytes[1]=0x23, bytes[2]=0xFF
          bytes[0] = 0xf4;
          bytes[1] = 0x23;
          bytes[2] = 0xff;
          return buffer;
        });

        issueGuestPin(db, testRoomId, now + 1000);

        // Should have been called once (accepted immediately)
        expect(getRandomValuesSpy).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('rotateGuestPin', () => {
    it('generates a new PIN different from the old one', () => {
      const now = Date.now();
      const oldPin = issueGuestPin(db, testRoomId, now);
      const newPin = rotateGuestPin(db, testRoomId, now + 1000);

      expect(newPin).not.toBe(oldPin);
    });

    it('updates guest_pin_expires_at', () => {
      const now = Date.now();
      issueGuestPin(db, testRoomId, now);
      const laterTime = now + 5 * 60 * 1000;
      rotateGuestPin(db, testRoomId, laterTime);

      const row = db.prepare(`SELECT guest_pin_expires_at FROM rooms WHERE room_id = ?`).get(
        testRoomId
      ) as { guest_pin_expires_at: number } | undefined;

      const expectedExpiry = laterTime + GUEST_PIN_VALIDITY_DURATION_MS;
      expect(row?.guest_pin_expires_at).toBe(expectedExpiry);
    });

    it('invalidates the previous PIN', () => {
      const now = Date.now();
      const oldPin = issueGuestPin(db, testRoomId, now);
      rotateGuestPin(db, testRoomId, now + 1000);

      const result = verifyGuestPin(db, testRoomId, oldPin, now + 1000) as { ok: false; reason: 'invalid' };
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('invalid');
    });

    it('returns a 6-digit zero-padded string', () => {
      const now = Date.now();
      issueGuestPin(db, testRoomId, now);
      const newPin = rotateGuestPin(db, testRoomId, now + 1000);

      expect(newPin).toMatch(/^\d{6}$/);
      expect(newPin.length).toBe(6);
    });
  });

  describe('revokeGuestAccess', () => {
    it('sets guest_access to 0', () => {
      const now = Date.now();
      issueGuestPin(db, testRoomId, now);
      revokeGuestAccess(db, testRoomId);

      const row = db.prepare(`SELECT guest_access FROM rooms WHERE room_id = ?`).get(testRoomId) as
        | { guest_access: number }
        | undefined;

      expect(row?.guest_access).toBe(0);
    });

    it('nulls the PIN', () => {
      const now = Date.now();
      issueGuestPin(db, testRoomId, now);
      revokeGuestAccess(db, testRoomId);

      const row = db.prepare(`SELECT guest_pin FROM rooms WHERE room_id = ?`).get(testRoomId) as
        | { guest_pin: string | null }
        | undefined;

      expect(row?.guest_pin).toBeNull();
    });
  });

  describe('readGuestPin', () => {
    it('returns the PIN for an enabled room', () => {
      const now = Date.now();
      const issuedPin = issueGuestPin(db, testRoomId, now);
      const readPin = readGuestPin(db, testRoomId);

      expect(readPin).toBe(issuedPin);
    });

    it('returns null when no PIN is set', () => {
      const pin = readGuestPin(db, testRoomId);
      expect(pin).toBeNull();
    });

    it('returns null after revokeGuestAccess', () => {
      const now = Date.now();
      issueGuestPin(db, testRoomId, now);
      revokeGuestAccess(db, testRoomId);
      const pin = readGuestPin(db, testRoomId);

      expect(pin).toBeNull();
    });
  });

  describe('verifyGuestPin', () => {
    describe('positive case', () => {
      it('correct PIN on enabled, unexpired, unlocked room returns ok: true', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        const result = verifyGuestPin(db, testRoomId, pin, now);

        expect(result).toEqual({ ok: true });
      });

      it('correct PIN works within expiry window', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);
        const laterTime = now + 6 * 60 * 60 * 1000; // 6 hours later, still valid

        const result = verifyGuestPin(db, testRoomId, pin, laterTime);

        expect(result).toEqual({ ok: true });
      });
    });

    describe('negative cases - all must return identical reason', () => {
      it('wrong PIN returns generic failure', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        const result = verifyGuestPin(db, testRoomId, '000000', now);

        expect(result).toEqual({ ok: false, reason: 'invalid' });
      });

      it('guest_access = 0 returns generic failure', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);
        revokeGuestAccess(db, testRoomId);

        const result = verifyGuestPin(db, testRoomId, pin, now);

        expect(result).toEqual({ ok: false, reason: 'invalid' });
      });

      it('expired PIN returns generic failure', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);
        const expiredTime = now + GUEST_PIN_VALIDITY_DURATION_MS + 1000; // 1s after expiry

        const result = verifyGuestPin(db, testRoomId, pin, expiredTime);

        expect(result).toEqual({ ok: false, reason: 'invalid' });
      });

      it('non-existent room returns generic failure', () => {
        const now = Date.now();
        const result = verifyGuestPin(db, 'non-existent-room', '123456', now);

        expect(result).toEqual({ ok: false, reason: 'invalid' });
      });

      it('PIN belonging to a different room returns generic failure', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        const result = verifyGuestPin(db, anotherRoomId, pin, now);

        expect(result).toEqual({ ok: false, reason: 'invalid' });
      });

      it('all six failure cases return identical reason', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        const wrongPin = verifyGuestPin(db, testRoomId, '000000', now);
        const disabledRoom = (() => {
          revokeGuestAccess(db, testRoomId);
          return verifyGuestPin(db, testRoomId, pin, now);
        })();
        const expiredPin = (() => {
          const freshPin = issueGuestPin(db, anotherRoomId, now);
          return verifyGuestPin(db, anotherRoomId, freshPin, now + GUEST_PIN_VALIDITY_DURATION_MS + 1000);
        })();
        const nonExistentRoom = verifyGuestPin(db, 'non-existent', '123456', now);
        const wrongRoom = (() => {
          const anotherPin = issueGuestPin(db, testRoomId, now + 10000);
          return verifyGuestPin(db, anotherRoomId, anotherPin, now);
        })();
        const lockedOut = (() => {
          const freshPin = issueGuestPin(db, testRoomId, now);
          // Simulate locked out state
          db.prepare(`UPDATE rooms SET guest_lockout_until = ? WHERE room_id = ?`).run(
            now + 1000,
            testRoomId
          );
          return verifyGuestPin(db, testRoomId, freshPin, now);
        })();

        // Assert all are failures
        expect(wrongPin.ok).toBe(false);
        expect(disabledRoom.ok).toBe(false);
        expect(expiredPin.ok).toBe(false);
        expect(nonExistentRoom.ok).toBe(false);
        expect(wrongRoom.ok).toBe(false);
        expect(lockedOut.ok).toBe(false);

        // Assert all reasons match
        const failWrongPin = wrongPin as { ok: false; reason: 'invalid' };
        const failDisabled = disabledRoom as { ok: false; reason: 'invalid' };
        const failExpired = expiredPin as { ok: false; reason: 'invalid' };
        const failNonExistent = nonExistentRoom as { ok: false; reason: 'invalid' };
        const failWrongRoom = wrongRoom as { ok: false; reason: 'invalid' };
        const failLockedOut = lockedOut as { ok: false; reason: 'invalid' };

        expect(failWrongPin.reason).toBe('invalid');
        expect(failDisabled.reason).toBe('invalid');
        expect(failExpired.reason).toBe('invalid');
        expect(failNonExistent.reason).toBe('invalid');
        expect(failWrongRoom.reason).toBe('invalid');
        expect(failLockedOut.reason).toBe('invalid');

        // All should be identical
        expect(wrongPin).toEqual(disabledRoom);
        expect(disabledRoom).toEqual(expiredPin);
        expect(expiredPin).toEqual(nonExistentRoom);
        expect(nonExistentRoom).toEqual(wrongRoom);
        expect(wrongRoom).toEqual(lockedOut);
      });
    });

    describe('malformed input rejection without lockout increment', () => {
      it('empty string is rejected without incrementing counter', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        verifyGuestPin(db, testRoomId, '', now);

        const row = db.prepare(`SELECT guest_failed_count FROM rooms WHERE room_id = ?`).get(testRoomId) as
          | { guest_failed_count: number }
          | undefined;

        expect(row?.guest_failed_count).toBe(0);
      });

      it('whitespace string is rejected without incrementing counter', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        verifyGuestPin(db, testRoomId, '   ', now);

        const row = db.prepare(`SELECT guest_failed_count FROM rooms WHERE room_id = ?`).get(testRoomId) as
          | { guest_failed_count: number }
          | undefined;

        expect(row?.guest_failed_count).toBe(0);
      });

      it('5-digit string is rejected without incrementing counter', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        verifyGuestPin(db, testRoomId, '12345', now);

        const row = db.prepare(`SELECT guest_failed_count FROM rooms WHERE room_id = ?`).get(testRoomId) as
          | { guest_failed_count: number }
          | undefined;

        expect(row?.guest_failed_count).toBe(0);
      });

      it('7-digit string is rejected without incrementing counter', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        verifyGuestPin(db, testRoomId, '1234567', now);

        const row = db.prepare(`SELECT guest_failed_count FROM rooms WHERE room_id = ?`).get(testRoomId) as
          | { guest_failed_count: number }
          | undefined;

        expect(row?.guest_failed_count).toBe(0);
      });

      it('non-digit characters are rejected without incrementing counter', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        verifyGuestPin(db, testRoomId, 'abcdef', now);

        const row = db.prepare(`SELECT guest_failed_count FROM rooms WHERE room_id = ?`).get(testRoomId) as
          | { guest_failed_count: number }
          | undefined;

        expect(row?.guest_failed_count).toBe(0);
      });

      it('leading whitespace with valid digits is rejected without incrementing counter', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        verifyGuestPin(db, testRoomId, ' 123456', now);

        const row = db.prepare(`SELECT guest_failed_count FROM rooms WHERE room_id = ?`).get(testRoomId) as
          | { guest_failed_count: number }
          | undefined;

        expect(row?.guest_failed_count).toBe(0);
      });
    });

    describe('lockout - sliding window', () => {
      it('accepts attempts with counter < threshold', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        // 49 failures is below threshold
        for (let i = 0; i < 49; i++) {
          verifyGuestPin(db, testRoomId, '000000', now);
        }

        const row = db.prepare(
          `SELECT guest_failed_count, guest_lockout_until FROM rooms WHERE room_id = ?`
        ).get(testRoomId) as
          | { guest_failed_count: number; guest_lockout_until: number | null }
          | undefined;

        expect(row?.guest_failed_count).toBe(49);
        expect(row?.guest_lockout_until).toBeNull();

        // Correct PIN should work
        const result = verifyGuestPin(db, testRoomId, pin, now);
        expect(result.ok).toBe(true);
      });

      it('the 50th failure sets lockout_until', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        // 50 failures
        for (let i = 0; i < 50; i++) {
          verifyGuestPin(db, testRoomId, '000000', now);
        }

        const row = db.prepare(
          `SELECT guest_failed_count, guest_lockout_until FROM rooms WHERE room_id = ?`
        ).get(testRoomId) as
          | { guest_failed_count: number; guest_lockout_until: number }
          | undefined;

        expect(row?.guest_failed_count).toBe(50);
        expect(row?.guest_lockout_until).toBe(now + GUEST_PIN_LOCKOUT_DURATION_MS);
      });

      it('even the correct PIN is rejected while locked out', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        // Trigger lockout
        for (let i = 0; i < 50; i++) {
          verifyGuestPin(db, testRoomId, '000000', now);
        }

        // Even correct PIN is rejected
        const result = verifyGuestPin(db, testRoomId, pin, now);

        expect(result).toEqual({ ok: false, reason: 'invalid' });
      });

      it('after lockout expires, correct PIN works again', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        // Trigger lockout
        for (let i = 0; i < 50; i++) {
          verifyGuestPin(db, testRoomId, '000000', now);
        }

        // Time passes, lockout expires
        const afterLockout = now + GUEST_PIN_LOCKOUT_DURATION_MS + 1;

        const result = verifyGuestPin(db, testRoomId, pin, afterLockout);

        expect(result).toEqual({ ok: true });
      });

      it('failures during an active lockout do not extend it', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        // Trip the lockout at `now`: the room locks until now + 15 min.
        for (let i = 0; i < 50; i++) {
          verifyGuestPin(db, testRoomId, '000000', now);
        }

        // An attacker keeps guessing during the lockout, within the per-IP
        // rate limit. Those attempts must not re-arm the lock — otherwise a
        // single IP at 5 req/min can lock the room out indefinitely.
        const duringLockout = now + 5 * 60 * 1000;
        for (let i = 0; i < 10; i++) {
          verifyGuestPin(db, testRoomId, '000000', duringLockout);
        }

        const row = db.prepare(
          `SELECT guest_lockout_until FROM rooms WHERE room_id = ?`
        ).get(testRoomId) as { guest_lockout_until: number } | undefined;
        expect(row?.guest_lockout_until).toBe(now + GUEST_PIN_LOCKOUT_DURATION_MS);

        // The correct PIN works again once the ORIGINAL expiry has passed.
        const afterOriginalExpiry = now + GUEST_PIN_LOCKOUT_DURATION_MS + 1;
        const result = verifyGuestPin(db, testRoomId, pin, afterOriginalExpiry);
        expect(result).toEqual({ ok: true });
      });

      it('counter resets after lockout expires', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        // Trigger lockout
        for (let i = 0; i < 50; i++) {
          verifyGuestPin(db, testRoomId, '000000', now);
        }

        // Time passes, lockout expires
        const afterLockout = now + GUEST_PIN_LOCKOUT_DURATION_MS + 1;

        // Use correct PIN
        verifyGuestPin(db, testRoomId, pin, afterLockout);

        const row = db.prepare(
          `SELECT guest_failed_count, guest_lockout_until FROM rooms WHERE room_id = ?`
        ).get(testRoomId) as
          | { guest_failed_count: number; guest_lockout_until: number | null }
          | undefined;

        expect(row?.guest_failed_count).toBe(0);
        expect(row?.guest_lockout_until).toBeNull();
      });

      it('sliding window: 40 failures, 11 min gap, 40 more does not trigger lockout', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        // 40 failures in first window
        for (let i = 0; i < 40; i++) {
          verifyGuestPin(db, testRoomId, '000000', now);
        }

        // 11 minutes pass (window expires after 10 minutes)
        const gapTime = now + 11 * 60 * 1000 + 1;

        // 40 more failures in new window
        for (let i = 0; i < 40; i++) {
          verifyGuestPin(db, testRoomId, '000000', gapTime);
        }

        const row = db.prepare(
          `SELECT guest_failed_count, guest_lockout_until FROM rooms WHERE room_id = ?`
        ).get(testRoomId) as
          | { guest_failed_count: number; guest_lockout_until: number | null }
          | undefined;

        // Should NOT be locked out - window slid
        expect(row?.guest_lockout_until).toBeNull();

        // Correct PIN should work
        const result = verifyGuestPin(db, testRoomId, pin, gapTime);
        expect(result.ok).toBe(true);
      });

      it('sliding window: 40 failures, 9 min gap, 20 more does trigger lockout at 50 total', () => {
        const now = Date.now();
        issueGuestPin(db, testRoomId, now);

        // 40 failures in first window
        for (let i = 0; i < 40; i++) {
          verifyGuestPin(db, testRoomId, '000000', now);
        }

        // 9 minutes pass (within the 10-minute window)
        const laterTime = now + 9 * 60 * 1000;

        // 10 more failures (40 + 10 = 50 total within effective window)
        for (let i = 0; i < 10; i++) {
          verifyGuestPin(db, testRoomId, '000000', laterTime);
        }

        const row = db.prepare(
          `SELECT guest_failed_count, guest_lockout_until FROM rooms WHERE room_id = ?`
        ).get(testRoomId) as
          | { guest_failed_count: number; guest_lockout_until: number }
          | undefined;

        expect(row?.guest_lockout_until).toBe(laterTime + GUEST_PIN_LOCKOUT_DURATION_MS);
      });
    });

    describe('constant-time shape', () => {
      it('compares all characters regardless of position of mismatch', () => {
        const now = Date.now();
        const pin = issueGuestPin(db, testRoomId, now);

        // Wrong first character - flip a different digit
        const wrongFirst =
          pin.charCodeAt(0) === '0'.charCodeAt(0) ? '1' : '0';
        verifyGuestPin(db, testRoomId, wrongFirst + pin.slice(1), now);

        // Wrong last character - flip a different digit
        const wrongLast =
          pin.charCodeAt(5) === '0'.charCodeAt(0) ? '1' : '0';
        verifyGuestPin(db, testRoomId, pin.slice(0, 5) + wrongLast, now);

        // Both should increment the counter equally
        const row = db.prepare(`SELECT guest_failed_count FROM rooms WHERE room_id = ?`).get(testRoomId) as
          | { guest_failed_count: number }
          | undefined;

        expect(row?.guest_failed_count).toBe(2);
      });
    });
  });
});
