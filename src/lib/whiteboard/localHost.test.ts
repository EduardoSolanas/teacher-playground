import { describe, expect, it } from 'vitest';

import { isLocalRoomHost } from './localHost';

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
});
