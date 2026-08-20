import { describe, expect, it } from 'vitest';

import { newlyRaisedPeerIds } from './raisedHandCue';

describe('newlyRaisedPeerIds', () => {
  it('returns peer ids that just raised, excluding the local host and waiting peers', () => {
    const previous = new Set<string>();
    const users = [
      { peerId: 'host', handRaised: false },
      { peerId: 'ada', handRaised: true },
      { peerId: 'waiting', handRaised: true, isWaiting: true },
    ];
    expect(newlyRaisedPeerIds(previous, users, 'host')).toEqual(['ada']);
  });

  it('does not re-fire while the same hand stays up', () => {
    const previous = new Set(['ada']);
    const users = [{ peerId: 'ada', handRaised: true }];
    expect(newlyRaisedPeerIds(previous, users, 'host')).toEqual([]);
  });

  it('fires again after a hand is lowered and raised', () => {
    const previous = new Set<string>();
    const users = [{ peerId: 'ada', handRaised: true }];
    expect(newlyRaisedPeerIds(previous, users, 'host')).toEqual(['ada']);
  });
});
