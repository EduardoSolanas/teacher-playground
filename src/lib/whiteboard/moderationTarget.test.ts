import { describe, expect, it } from 'vitest';

import { moderationTargetBody } from './moderationTarget';

describe('moderationTargetBody', () => {
  it('targets the account when it is known, because peer ids are re-minted on admission', () => {
    expect(moderationTargetBody('kick', 'user-stale', 'account-1')).toEqual({
      action: 'kick',
      accountId: 'account-1',
    });
    expect(moderationTargetBody('suspend', 'user-stale', 'account-1')).toEqual({
      action: 'suspend',
      accountId: 'account-1',
    });
  });

  it('falls back to the peer id when no account is known', () => {
    expect(moderationTargetBody('kick', 'user-a', null)).toEqual({
      action: 'kick',
      peerId: 'user-a',
    });
    expect(moderationTargetBody('suspend', 'user-a', undefined)).toEqual({
      action: 'suspend',
      peerId: 'user-a',
    });
  });

  it('treats an empty account id as unknown rather than sending a blank target', () => {
    expect(moderationTargetBody('kick', 'user-a', '')).toEqual({
      action: 'kick',
      peerId: 'user-a',
    });
  });

  it('never sends both ids, so a stale peer id cannot 404 a valid account target', () => {
    const body = moderationTargetBody('kick', 'user-stale', 'account-1');
    expect('peerId' in body).toBe(false);
  });
});
