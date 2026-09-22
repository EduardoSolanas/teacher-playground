import { describe, expect, it } from 'vitest';

import { deriveLiveKitIdentity } from './participantIdentity';

const SECRET = 'secret_xyz';

describe('deriveLiveKitIdentity', () => {
  it('never returns the accountId itself', async () => {
    const identity = await deriveLiveKitIdentity(SECRET, 'room-1', 'acct-1');
    expect(identity).not.toBe('acct-1');
  });

  it('is deterministic for the same secret, room, and account', async () => {
    const first = await deriveLiveKitIdentity(SECRET, 'room-1', 'acct-1');
    const second = await deriveLiveKitIdentity(SECRET, 'room-1', 'acct-1');
    expect(first).toBe(second);
  });

  it('yields a different identity per room, so rooms cannot be correlated', async () => {
    const inRoomOne = await deriveLiveKitIdentity(SECRET, 'room-1', 'acct-1');
    const inRoomTwo = await deriveLiveKitIdentity(SECRET, 'room-2', 'acct-1');
    expect(inRoomOne).not.toBe(inRoomTwo);
  });

  it('is a fixed-length 32-character lowercase hex string', async () => {
    const identity = await deriveLiveKitIdentity(SECRET, 'room-1', 'acct-1');
    expect(identity).toMatch(/^[0-9a-f]{32}$/);
  });

  it('matches the known HMAC-SHA256 prefix for the documented inputs', async () => {
    // KAT: hex must be zero-padded per byte. A derivation that skips the pad
    // still yields deterministic, distinct, hex-shaped strings, so only an
    // exact expected value pins the encoding.
    const identity = await deriveLiveKitIdentity(SECRET, 'room-1', 'acct-1');
    expect(identity).toBe('2c5a34943f9e7ee30fec601604aae833');
  });
});
