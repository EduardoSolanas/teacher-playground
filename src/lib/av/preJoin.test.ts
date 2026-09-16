import { describe, expect, it } from 'vitest';

import { peerCallEntryAction, shouldResetPreJoinAnswered } from './preJoin';

describe('peerCallEntryAction', () => {
  it('sends the peer back to leave-call when no call is active', () => {
    expect(
      peerCallEntryAction({
        callActive: false,
        avAllowed: true,
        answeredPreJoin: false,
      }),
    ).toBe('leave-call');
  });

  it('prefers leave-call over the pre-join prompt when the call is over', () => {
    expect(
      peerCallEntryAction({
        callActive: false,
        avAllowed: true,
        answeredPreJoin: true,
      }),
    ).toBe('leave-call');
  });

  it('keeps a peer who declined out of the call instead of re-opening pre-join', () => {
    expect(
      peerCallEntryAction({
        callActive: true,
        avAllowed: true,
        answeredPreJoin: true,
      }),
    ).toBe('stay-out');
  });

  it('stays out even when the call is active but devices are unavailable', () => {
    expect(
      peerCallEntryAction({
        callActive: true,
        avAllowed: false,
        answeredPreJoin: true,
      }),
    ).toBe('stay-out');
  });

  it('opens pre-join for an allowed peer who has not answered yet', () => {
    expect(
      peerCallEntryAction({
        callActive: true,
        avAllowed: true,
        answeredPreJoin: false,
      }),
    ).toBe('open-pre-join');
  });

  it('does nothing for a peer who is not allowed while a call is active', () => {
    expect(
      peerCallEntryAction({
        callActive: true,
        avAllowed: false,
        answeredPreJoin: false,
      }),
    ).toBe('none');
  });
});

describe('shouldResetPreJoinAnswered', () => {
  it('resets the answered flag when a call ends', () => {
    expect(shouldResetPreJoinAnswered(true, false)).toBe(true);
  });

  it('keeps the answered flag on the initial false-to-false mount', () => {
    expect(shouldResetPreJoinAnswered(false, false)).toBe(false);
  });

  it('does not reset when a call starts', () => {
    expect(shouldResetPreJoinAnswered(false, true)).toBe(false);
  });

  it('does not reset while the call stays active', () => {
    expect(shouldResetPreJoinAnswered(true, true)).toBe(false);
  });
});
