import { describe, expect, it } from 'vitest';

import { isLocalRoomHost, isRoomOwner } from './localHost';

describe('isLocalRoomHost', () => {
  it('treats a creator grant as host even when the cursor id does not match the presence row', () => {
    expect(
      isLocalRoomHost('creator', [{ peerId: 'user-server', isHost: true }], 'user-client'),
    ).toBe(true);
  });

  it('does not treat an editor as host from grant alone', () => {
    expect(
      isLocalRoomHost('peer', [{ peerId: 'user-server', isHost: true }], 'user-client'),
    ).toBe(false);
  });

  it('finds the local host anywhere in the roster, not only in the first row', () => {
    expect(
      isLocalRoomHost(
        'peer',
        [
          { peerId: 'other', isHost: true },
          { peerId: 'self', isHost: true },
        ],
        'self',
      ),
    ).toBe(true);
  });

  it('does not treat a non-host local row as host', () => {
    expect(isLocalRoomHost('peer', [{ peerId: 'self' }], 'self')).toBe(false);
  });
});

describe('isRoomOwner', () => {
  it('is the creator grant and nothing else', () => {
    expect(isRoomOwner('creator')).toBe(true);
    expect(isRoomOwner('peer')).toBe(false);
    expect(isRoomOwner('viewer')).toBe(false);
    expect(isRoomOwner(null)).toBe(false);
  });

  it('does not follow the first-user host fallback', () => {
    /*
     * The stand-in host the roster flags when the owner is away is a host for
     * the room's purposes and nothing at all for the server's. Gating an
     * owner-only control on being host would show it to this peer and then
     * refuse them, which is worse than not offering it.
     */
    const users = [{ peerId: 'stand-in', isHost: true }];
    expect(isLocalRoomHost('peer', users, 'stand-in')).toBe(true);
    expect(isRoomOwner('peer')).toBe(false);
  });
});
