import type { RoomDatabase } from './db';

/**
 * Guest PIN constants (see §3 of guest_implementation.md for threat model)
 */
export const GUEST_PIN_LENGTH = 6;
export const GUEST_PIN_FAILURE_THRESHOLD = 50;
export const GUEST_PIN_FAILURE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const GUEST_PIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
export const GUEST_PIN_VALIDITY_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * The PIN is stored in plaintext, not hashed. This is a deliberate decision:
 *
 * 1. The teacher must read the PIN back at the start of every session. A hash
 *    cannot be displayed, so hashing it would break the primary use case.
 * 2. The threat model is online guessing, which the lockout addresses, not
 *    offline cracking. A 20-bit secret falls to an offline attack in
 *    milliseconds regardless of the KDF chosen, so a KDF buys nothing real.
 * 3. If Durable Object storage is compromised, the attacker already holds the
 *    board contents and the member list. The PIN is not the crown jewel.
 *
 * Comparison must still be constant-time to deny a timing oracle.
 *
 * The lockout is what defeats distributed attacks. See §3.
 */

/**
 * Generate a 6-digit zero-padded PIN from crypto.getRandomValues.
 * Never Math.random.
 *
 * Uses rejection sampling to avoid modulo bias:
 * 3 bytes give 2^24 = 16,777,216 possible values.
 * The largest multiple of 1,000,000 that fits is 16,000,000.
 * Values >= 16,000,000 are rejected and redrawn.
 * This is unbiased — each of the 1,000,000 PINs has equal probability.
 * Rejection probability is ~4.6%, so retries terminate promptly.
 */
function generatePin(): string {
  const bytes = new Uint8Array(3);
  const maxRetries = 100;

  for (let i = 0; i < maxRetries; i++) {
    crypto.getRandomValues(bytes);
    const value = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];

    // Reject values in the bias zone (>= 16,000,000)
    if (value < 16000000) {
      const pinNumber = value % 1000000;
      return pinNumber.toString().padStart(6, '0');
    }
  }

  // Should not reach here under normal conditions (probability of 100 rejections
  // in a row is astronomical). Fail hard if it does to detect implementation
  // errors rather than silently returning a biased result.
  throw new Error('Failed to generate unbiased PIN after 100 attempts');
}

/**
 * Validates that input is exactly 6 digits (no whitespace, correct length).
 * Returns true if valid, false if malformed.
 * Malformed input should NOT increment failure counters.
 */
function validatePinFormat(pin: string): boolean {
  if (pin.length !== GUEST_PIN_LENGTH) return false;
  if (!/^\d{6}$/.test(pin)) return false;
  return true;
}

/**
 * Constant-time comparison of two strings.
 * Compares all characters and accumulates differences with bitwise OR.
 * Never early-return on first mismatch.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

/**
 * Issue a guest PIN for a room.
 * Sets guest_access = 1, stores the PIN, sets expiry to now + 12h.
 * Clears failure counters and lockout.
 * Returns the 6-digit PIN string.
 */
export function issueGuestPin(db: RoomDatabase, roomId: string, now: number): string {
  const pin = generatePin();
  const expiresAt = now + GUEST_PIN_VALIDITY_DURATION_MS;

  db.prepare(
    `UPDATE rooms
     SET guest_access = 1,
         guest_pin = ?,
         guest_pin_expires_at = ?,
         guest_failed_count = 0,
         guest_failed_window_at = NULL,
         guest_lockout_until = NULL
     WHERE room_id = ?`
  ).run(pin, expiresAt, roomId);

  return pin;
}

/**
 * Rotate the PIN for a room.
 * Generates a new PIN and updates expiry.
 * Returns the new 6-digit PIN string.
 */
export function rotateGuestPin(db: RoomDatabase, roomId: string, now: number): string {
  const pin = generatePin();
  const expiresAt = now + GUEST_PIN_VALIDITY_DURATION_MS;

  db.prepare(
    `UPDATE rooms
     SET guest_pin = ?,
         guest_pin_expires_at = ?
     WHERE room_id = ?`
  ).run(pin, expiresAt, roomId);

  return pin;
}

/**
 * Revoke guest access to a room.
 * Sets guest_access = 0 and nulls the PIN.
 */
export function revokeGuestAccess(db: RoomDatabase, roomId: string): void {
  db.prepare(
    `UPDATE rooms
     SET guest_access = 0,
         guest_pin = NULL
     WHERE room_id = ?`
  ).run(roomId);
}

/**
 * Read the plaintext PIN for an owner to display.
 * Returns the PIN string or null if not set.
 */
export function readGuestPin(db: RoomDatabase, roomId: string): string | null {
  const row = db
    .prepare(`SELECT guest_pin FROM rooms WHERE room_id = ?`)
    .get(roomId) as { guest_pin: string | null } | undefined;

  return row?.guest_pin ?? null;
}

/**
 * Verify a guest-supplied PIN against a room's stored PIN.
 *
 * Returns { ok: true } if the PIN is correct.
 * Returns { ok: false, reason: 'invalid' } for any of:
 * - wrong PIN
 * - guest_access = 0
 * - expired PIN
 * - non-existent room
 * - PIN belongs to a different room
 * - room is locked out
 *
 * This generic failure prevents room enumeration: an attacker cannot distinguish
 * between a wrong PIN, a disabled room, or a non-existent room.
 *
 * Malformed input (empty, wrong length, non-digits, whitespace) is rejected
 * WITHOUT incrementing the failure counter.
 *
 * The lockout is a sliding window: if 50+ failures occur within 10 minutes,
 * the room is locked for 15 minutes. Even the correct PIN is rejected during
 * lockout. After lockout expires, the counter resets.
 */
export function verifyGuestPin(
  db: RoomDatabase,
  roomId: string,
  pin: string,
  now: number,
): { ok: true } | { ok: false; reason: 'invalid' } {
  // Reject malformed input without touching the counter
  if (!validatePinFormat(pin)) {
    return { ok: false, reason: 'invalid' };
  }

  // Fetch the room row
  const row = db
    .prepare(
      `SELECT guest_access, guest_pin, guest_pin_expires_at,
              guest_failed_count, guest_failed_window_at, guest_lockout_until
       FROM rooms
       WHERE room_id = ?`
    )
    .get(roomId) as
    | {
        guest_access: number;
        guest_pin: string | null;
        guest_pin_expires_at: number | null;
        guest_failed_count: number;
        guest_failed_window_at: number | null;
        guest_lockout_until: number | null;
      }
    | undefined;

  // Room does not exist: return generic failure without incrementing
  if (row === undefined) {
    return { ok: false, reason: 'invalid' };
  }

  // Check if room is currently locked out
  if (row.guest_lockout_until !== null && row.guest_lockout_until > now) {
    // Still in lockout, increment counter but reject
    incrementFailureCounter(db, roomId, now);
    return { ok: false, reason: 'invalid' };
  }

  // If lockout has expired, reset the counters
  if (row.guest_lockout_until !== null && row.guest_lockout_until <= now) {
    db.prepare(
      `UPDATE rooms
       SET guest_failed_count = 0,
           guest_failed_window_at = NULL,
           guest_lockout_until = NULL
       WHERE room_id = ?`
    ).run(roomId);
    // Refresh the row after reset
    const refreshedRow = db
      .prepare(
        `SELECT guest_access, guest_pin, guest_pin_expires_at,
                guest_failed_count, guest_failed_window_at, guest_lockout_until
         FROM rooms
         WHERE room_id = ?`
      )
      .get(roomId) as {
        guest_access: number;
        guest_pin: string | null;
        guest_pin_expires_at: number | null;
        guest_failed_count: number;
        guest_failed_window_at: number | null;
        guest_lockout_until: number | null;
      };

    // Now use the refreshed row for the verification
    return verifyGuestPinInternal(db, roomId, pin, now, refreshedRow);
  }

  // Not locked out, proceed with verification
  return verifyGuestPinInternal(db, roomId, pin, now, row);
}

/**
 * Internal verification logic, separated to avoid recursion issues.
 */
function verifyGuestPinInternal(
  db: RoomDatabase,
  roomId: string,
  pin: string,
  now: number,
  row: {
    guest_access: number;
    guest_pin: string | null;
    guest_pin_expires_at: number | null;
    guest_failed_count: number;
    guest_failed_window_at: number | null;
    guest_lockout_until: number | null;
  },
): { ok: true } | { ok: false; reason: 'invalid' } {
  // Guest access is disabled
  if (row.guest_access !== 1) {
    incrementFailureCounter(db, roomId, now);
    return { ok: false, reason: 'invalid' };
  }

  // PIN is not set
  if (row.guest_pin === null) {
    incrementFailureCounter(db, roomId, now);
    return { ok: false, reason: 'invalid' };
  }

  // PIN has expired
  if (row.guest_pin_expires_at === null || row.guest_pin_expires_at <= now) {
    incrementFailureCounter(db, roomId, now);
    return { ok: false, reason: 'invalid' };
  }

  // Compare PINs with constant-time comparison
  const isCorrect = constantTimeEquals(pin, row.guest_pin);

  if (!isCorrect) {
    incrementFailureCounter(db, roomId, now);
    return { ok: false, reason: 'invalid' };
  }

  // PIN is correct
  return { ok: true };
}

/**
 * Increment the failure counter with sliding window logic.
 * If 50+ failures occur within 10 minutes, lock the room for 15 minutes.
 */
function incrementFailureCounter(db: RoomDatabase, roomId: string, now: number): void {
  const row = db
    .prepare(
      `SELECT guest_failed_count, guest_failed_window_at, guest_lockout_until
       FROM rooms
       WHERE room_id = ?`
    )
    .get(roomId) as
    | {
        guest_failed_count: number;
        guest_failed_window_at: number | null;
        guest_lockout_until: number | null;
      }
    | undefined;

  if (row === undefined) {
    return;
  }

  let newCount = row.guest_failed_count + 1;
  let newWindowAt = row.guest_failed_window_at;

  // If window has expired or is not set, start a new window
  if (newWindowAt === null || newWindowAt + GUEST_PIN_FAILURE_WINDOW_MS <= now) {
    newCount = 1;
    newWindowAt = now;
  }

  // Check if we've reached the threshold
  let newLockoutUntil = row.guest_lockout_until;
  if (newCount >= GUEST_PIN_FAILURE_THRESHOLD) {
    newLockoutUntil = now + GUEST_PIN_LOCKOUT_DURATION_MS;
  }

  db.prepare(
    `UPDATE rooms
     SET guest_failed_count = ?,
         guest_failed_window_at = ?,
         guest_lockout_until = ?
     WHERE room_id = ?`
  ).run(newCount, newWindowAt, newLockoutUntil, roomId);
}
