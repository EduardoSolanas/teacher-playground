import { describe, expect, it } from 'vitest';

import type { WhiteboardUser } from '@/types/whiteboard';

import {
  ROOM_CANVAS_CLASS,
  roomCanvasRightClass,
  roomCanvasRailStyle,
  mapAvPeerIds,
  mapAvPeerStateByPeerId,
  resolveAvTargetAccountId,
  roomCanvasTopClass,
  shouldShowStartCall,
  shouldPeerEnterCall,
  shouldShowSyncDegradedNotice,
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
  it('still spans the window for the furniture that floats over it', () => {
    /*
     * The roster and the notices are `fixed` and float over the board. Making
     * room for those cost a teacher a strip of drawing surface down each side
     * that nothing was ever painted into, because they overlaid it anyway.
     */
    expect(ROOM_CANVAS_CLASS).toContain('inset-x-0');
    expect(ROOM_CANVAS_CLASS).not.toContain('sm:left-14');
    expect(ROOM_CANVAS_CLASS).not.toContain('100vw');
  });

  it('ends where the call rail begins, and only while the rail is there', () => {
    /*
     * The call rail is the exception, and it is a different case from the
     * roster: it is opaque, flush to the edge and full height, so a board that
     * carried on underneath it would hide whatever was drawn there with no way
     * to reach it. Lessonspace ends the board at the rail for the same reason.
     * Pencil Spaces keeps the board full width instead -- and keeps its tiles
     * visibly inset so they read as floating. Flush *and* overlapping, which is
     * what this had briefly, is the one combination that misleads.
     *
     * Only on `sm:` and up. The rail is a bottom strip on a phone, where
     * reserving its height would leave almost no board.
     *
     * The width arrives through the --call-rail-w variable rather than an
     * interpolated arbitrary value. A class built by string interpolation
     * survives Tailwind's scan only by accident -- it did, for a while, purely
     * because this test file spelled the resolved literal out. The variable is
     * set inline on the canvas, so the class is static and cannot be purged.
     */
    expect(roomCanvasRightClass(true)).toBe('sm:right-[var(--call-rail-w)]');
  });

  it('sets the rail width variable on the canvas only while the rail is there', () => {
    const open = roomCanvasRailStyle(true) as Record<string, string>;
    expect(open['--call-rail-w']).toBe('clamp(11rem,18vw,15rem)');
    expect(roomCanvasRailStyle(false)).toEqual({});
  });

  it('gives the width back when the rail is hidden or there is no call', () => {
    expect(roomCanvasRightClass(false)).toBe('');
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
  it('returns true when the room call is active and av is allowed', () => {
    expect(shouldPeerEnterCall({ callActive: true, avAllowed: true })).toBe(true);
  });

  it('returns false when the room call is not active', () => {
    expect(shouldPeerEnterCall({ callActive: false, avAllowed: true })).toBe(false);
  });

  it('returns false when av is not allowed for the peer', () => {
    expect(shouldPeerEnterCall({ callActive: true, avAllowed: false })).toBe(false);
  });

  it('keeps peers in the call when no host is present', () => {
    /*
     * The host refreshing the page, dropping off wifi or closing the tab must
     * not hang up on everyone else -- the peers are talking to each other, and
     * the call belongs to the room. This used to be gated on a host being
     * present, which ended the call for the whole room the moment the host's
     * presence row went away.
     */
    const usersWithoutHost = [
      makeUser({ peerId: 'p1', isHost: false }),
      makeUser({ peerId: 'p3', isHost: false }),
    ];
    expect(usersWithoutHost.some((u) => u.isHost)).toBe(false);
    expect(shouldPeerEnterCall({ callActive: true, avAllowed: true })).toBe(true);
  });
});


describe('shouldShowSyncDegradedNotice', () => {
  it('returns true when sync is degraded and connection is not lost', () => {
    expect(shouldShowSyncDegradedNotice({ syncDegraded: true, connectionLost: false })).toBe(true);
  });

  it('returns false when connection is lost even if sync is degraded (connection lost notice takes precedence)', () => {
    expect(shouldShowSyncDegradedNotice({ syncDegraded: true, connectionLost: true })).toBe(false);
  });

  it('returns false when sync is healthy', () => {
    expect(shouldShowSyncDegradedNotice({ syncDegraded: false, connectionLost: false })).toBe(false);
  });
});

