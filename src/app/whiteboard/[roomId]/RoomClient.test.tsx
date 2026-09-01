import { describe, expect, it } from 'vitest';

import type { WhiteboardUser } from '@/types/whiteboard';

import {
  ROOM_CANVAS_CLASS,
  mapAvPeerIds,
  mapAvPeerStateByPeerId,
  resolveAvTargetAccountId,
  roomCanvasTopClass,
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
          { identity: '__local__', micMuted: false, camOn: true, isSpeaking: true },
          { identity: 'peer-2', micMuted: true, camOn: false, isSpeaking: false },
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
          { identity: 'acct-student', micMuted: true, camOn: false, isSpeaking: true },
          { identity: 'acct-stale', micMuted: false, camOn: true, isSpeaking: true },
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
          { identity: '__local__', micMuted: false, camOn: true, isSpeaking: true },
          { identity: 'peer-2', micMuted: true, camOn: false, isSpeaking: false },
        ],
        [
          makeUser({ peerId: 'peer-local' }),
          makeUser({ peerId: 'peer-2', accountId: 'peer-2' }),
        ],
        'peer-local',
      ),
    ).toEqual(new Map([
      ['peer-local', { micMuted: false, camOn: true }],
      ['peer-2', { micMuted: true, camOn: false }],
    ]));
  });

  it('maps remote av account identities onto roster peer ids and drops unmatched state', () => {
    expect(
      mapAvPeerStateByPeerId(
        [
          { identity: 'acct-student', micMuted: true, camOn: false, isSpeaking: true },
          { identity: 'acct-stale', micMuted: false, camOn: true, isSpeaking: false },
        ],
        [
          makeUser({ peerId: 'peer-owner', accountId: 'acct-owner', userName: 'Teacher', isHost: true }),
          makeUser({ peerId: 'peer-student', accountId: 'acct-student', userName: 'Student' }),
        ],
        'peer-owner',
      ),
    ).toEqual(new Map([
      ['peer-student', { micMuted: true, camOn: false }],
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
