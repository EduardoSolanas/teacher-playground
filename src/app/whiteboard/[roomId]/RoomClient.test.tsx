import { describe, expect, it } from 'vitest';

import type { WhiteboardUser } from '@/types/whiteboard';

import {
  ROOM_CANVAS_CLASS,
  mapAvPeerIds,
  mapAvPeerStateByPeerId,
  resolveAvTargetAccountId,
  roomCanvasTopClass,
  shouldShowStartCall,
  shouldPeerEnterCall,
} from './RoomClient';

function makeUser(overrides: Partial<WhiteboardUser> = {}): WhiteboardUser {
  return {
    peerId: 'peer-1',
    accountId: null,
    userName: 'Alice',
    color: '#112233',
    isHost: false,
    ...overrides,
  };
}

describe('room canvas responsive top offset', () => {
  it('keeps the guest canvas at the viewport top while retaining the desktop nav offset', () => {
    expect(roomCanvasTopClass(true)).toBe('top-0 sm:top-12');
    expect(roomCanvasTopClass(false)).toBe('top-[calc(3rem+env(safe-area-inset-top))] sm:top-12');
  });
});

describe('room canvas width', () => {
  it('spans the window rather than making room for the furniture', () => {
    /*
     * The rail and the roster are both `fixed` and float over the board, so
     * narrowing the board for them cost a teacher a strip of drawing surface
     * down each side that nothing was ever painted into -- and the right-hand
     * strip appeared and vanished as the roster was collapsed, resizing the
     * canvas under a lesson in progress.
     */
    expect(ROOM_CANVAS_CLASS).toContain('inset-x-0');
    expect(ROOM_CANVAS_CLASS).not.toContain('sm:left-14');
    expect(ROOM_CANVAS_CLASS).not.toContain('100vw');
  });
});

describe('mapAvPeerIds', () => {
  it('maps the local av placeholder onto the room local peer id', () => {
    expect(
      mapAvPeerIds(
        [
          { identity: '__local__', micMuted: false, micPresent: true, camOn: true, isSpeaking: true },
          { identity: 'peer-2', micMuted: true, micPresent: true, camOn: false, isSpeaking: false },
        ],
        [
          makeUser({ peerId: 'peer-local' }),
          makeUser({ peerId: 'peer-2', accountId: 'peer-2' }),
        ],
        'peer-local',
        (participant) => participant.isSpeaking,
      ),
    ).toEqual(new Set(['peer-local']));
  });

  it('maps remote av account identities onto roster peer ids and skips stale identities', () => {
    expect(
      mapAvPeerIds(
        [
          { identity: 'acct-student', micMuted: true, micPresent: true, camOn: false, isSpeaking: true },
          { identity: 'acct-stale', micMuted: false, micPresent: true, camOn: true, isSpeaking: true },
        ],
        [
          makeUser({ peerId: 'peer-owner', accountId: 'acct-owner', userName: 'Teacher', isHost: true }),
          makeUser({ peerId: 'peer-student', accountId: 'acct-student', userName: 'Student' }),
        ],
        'peer-owner',
        (participant) => participant.isSpeaking,
      ),
    ).toEqual(new Set(['peer-student']));
  });
});

describe('mapAvPeerStateByPeerId', () => {
  it('maps the local av placeholder onto the room local peer id', () => {
    expect(
      mapAvPeerStateByPeerId(
        [
          { identity: '__local__', micMuted: false, micPresent: true, camOn: true, isSpeaking: true },
          { identity: 'peer-2', micMuted: true, micPresent: true, camOn: false, isSpeaking: false },
        ],
        [
          makeUser({ peerId: 'peer-local' }),
          makeUser({ peerId: 'peer-2', accountId: 'peer-2' }),
        ],
        'peer-local',
      ),
    ).toEqual(new Map([
      ['peer-local', { micMuted: false, micPresent: true, camOn: true }],
      ['peer-2', { micMuted: true, micPresent: true, camOn: false }],
    ]));
  });

  it('maps remote av account identities onto roster peer ids and drops unmatched state', () => {
    expect(
      mapAvPeerStateByPeerId(
        [
          { identity: 'acct-student', micMuted: true, micPresent: true, camOn: false, isSpeaking: true, quality: 'poor' },
          { identity: 'acct-stale', micMuted: false, micPresent: true, camOn: true, isSpeaking: false, quality: 'good' },
        ],
        [
          makeUser({ peerId: 'peer-owner', accountId: 'acct-owner', userName: 'Teacher', isHost: true }),
          makeUser({ peerId: 'peer-student', accountId: 'acct-student', userName: 'Student' }),
        ],
        'peer-owner',
      ),
    ).toEqual(new Map([
      ['peer-student', { micMuted: true, micPresent: true, camOn: false, quality: 'poor' }],
    ]));
  });

  it('maps poor account-linked av quality onto the roster peer id', () => {
    expect(
      mapAvPeerStateByPeerId(
        [
          { identity: 'acct-student', micMuted: false, micPresent: true, camOn: true, isSpeaking: false, quality: 'poor' },
        ],
        [
          makeUser({ peerId: 'peer-owner', accountId: 'acct-owner', userName: 'Teacher', isHost: true }),
          makeUser({ peerId: 'peer-student', accountId: 'acct-student', userName: 'Student' }),
        ],
        'peer-owner',
      ),
    ).toEqual(new Map([
      ['peer-student', { micMuted: false, micPresent: true, camOn: true, quality: 'poor' }],
    ]));
  });
});

describe('resolveAvTargetAccountId', () => {
  it('maps a roster peer id to the matched account id for remote mute requests', () => {
    expect(
      resolveAvTargetAccountId(
        [
          makeUser({ peerId: 'peer-owner', accountId: 'acct-owner', userName: 'Teacher', isHost: true }),
          makeUser({ peerId: 'peer-student', accountId: 'acct-student', userName: 'Student' }),
        ],
        'peer-owner',
        'peer-student',
      ),
    ).toBe('acct-student');
  });

  it('preserves the local av placeholder mapping for the local peer', () => {
    expect(
      resolveAvTargetAccountId(
        [
          makeUser({ peerId: 'peer-owner', accountId: 'acct-owner', userName: 'Teacher', isHost: true }),
        ],
        'peer-owner',
        'peer-owner',
      ),
    ).toBe('__local__');
  });

  it('returns null when the roster peer does not match a current account', () => {
    expect(
      resolveAvTargetAccountId(
        [
          makeUser({ peerId: 'peer-owner', accountId: 'acct-owner', userName: 'Teacher', isHost: true }),
        ],
        'peer-owner',
        'peer-student',
      ),
    ).toBeNull();
  });
});

describe('shouldShowStartCall', () => {
  it('returns true only for the host when call is allowed and not yet started', () => {
    expect(shouldShowStartCall({ isHost: true, avAllowed: true, avEnabled: false })).toBe(true);
  });

  it('returns false for a non-host peer even if admitted and call is allowed', () => {
    expect(shouldShowStartCall({ isHost: false, avAllowed: true, avEnabled: false })).toBe(false);
  });

  it('returns false when a call is already active', () => {
    expect(shouldShowStartCall({ isHost: true, avAllowed: true, avEnabled: true })).toBe(false);
  });

  it('returns false when av is not allowed', () => {
    expect(shouldShowStartCall({ isHost: true, avAllowed: false, avEnabled: false })).toBe(false);
  });
});

describe('shouldPeerEnterCall', () => {
  it('returns true when room call is active, host is present, and av is allowed', () => {
    expect(shouldPeerEnterCall({ callActive: true, hasHost: true, avAllowed: true })).toBe(true);
  });

  it('returns false when room call is not active', () => {
    expect(shouldPeerEnterCall({ callActive: false, hasHost: true, avAllowed: true })).toBe(false);
  });

  it('returns false when no host is present in the room', () => {
    expect(shouldPeerEnterCall({ callActive: true, hasHost: false, avAllowed: true })).toBe(false);
  });

  it('returns false when av is not allowed for the peer', () => {
    expect(shouldPeerEnterCall({ callActive: true, hasHost: true, avAllowed: false })).toBe(false);
  });

  it('derives hasHost correctly from active users list', () => {
    const usersWithHost = [
      makeUser({ peerId: 'p1', isHost: false }),
      makeUser({ peerId: 'p2', isHost: true }),
    ];
    const usersWithoutHost = [
      makeUser({ peerId: 'p1', isHost: false }),
      makeUser({ peerId: 'p3', isHost: false }),
    ];
    expect(usersWithHost.some((u) => u.isHost)).toBe(true);
    expect(usersWithoutHost.some((u) => u.isHost)).toBe(false);
    expect(shouldPeerEnterCall({ callActive: true, hasHost: usersWithHost.some((u) => u.isHost), avAllowed: true })).toBe(true);
    expect(shouldPeerEnterCall({ callActive: true, hasHost: usersWithoutHost.some((u) => u.isHost), avAllowed: true })).toBe(false);
  });
});

