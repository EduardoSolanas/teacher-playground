import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

import type { WhiteboardUser } from '@/types/whiteboard';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

import {
  ROOM_CANVAS_CLASS,
  EXCALIDRAW_LOADING_CLASS,
  RoomContent,
  roomCanvasRightClass,
  roomCanvasRailStyle,
  mapAvPeerIds,
  mapAvPeerStateByPeerId,
  resolveAvTargetAccountId,
  roomCanvasTopClass,
  shouldShowStartCall,
  shouldPeerEnterCall,
  shouldShowSyncDegradedNotice,
  shouldBroadcastCallStart,
  shouldAnnounceCallEnded,
  resolveWaitingPosition,
  evictionNoticeCopy,
  supportButtonProps,
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RoomContent session profile', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('passes the session plan and company through to the room profile menu', async () => {
    const request: AjaxFetch = async (input) => {
      if (String(input) === '/auth/session/current') {
        return jsonResponse({
          accountId: 'acct-1',
          plan: {
            planId: 'tutor_pro_monthly',
            status: 'active',
            graceUntil: null,
            collectionPaused: false,
          },
          company: { id: 'acme', name: 'Acme Tutoring', role: 'owner' },
        });
      }
      return jsonResponse({});
    };

    render(<RoomContent roomId="room-alpha" request={request} />);

    const profileButton = await screen.findByTestId('whiteboard-profile-btn');
    fireEvent.click(profileButton);

    expect((await screen.findByTestId('whiteboard-profile-plan')).textContent).toBe('Tutor Pro');
    expect(screen.getByTestId('whiteboard-profile-company').textContent).toContain('Acme Tutoring');
  });
});

describe('room canvas responsive top offset', () => {
  it('keeps the guest canvas at the viewport top while retaining the desktop nav offset', () => {
    expect(roomCanvasTopClass(true)).toBe('top-0 sm:top-12');
    expect(roomCanvasTopClass(false)).toBe('top-[calc(3rem+env(safe-area-inset-top))] sm:top-12');
  });

  it('does not floor the board height inside a shell that owns the viewport', () => {
    // A 25rem minimum inside an overflow-hidden 100dvh shell clipped the
    // bottom of the board on short and landscape viewports.
    expect(EXCALIDRAW_LOADING_CLASS).toContain('h-full');
    expect(EXCALIDRAW_LOADING_CLASS).toContain('min-h-0');
    expect(EXCALIDRAW_LOADING_CLASS).not.toContain('min-h-[25rem]');
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

  it('paints the canvas with the paper token rather than slate-50 (UX-B20)', () => {
    // The canvas background is the brand `--paper` token (DESIGN.md §2), so
    // the board sits on the same warm surface as the room shell.
    expect(ROOM_CANVAS_CLASS).toContain('bg-[var(--paper)]');
    expect(ROOM_CANVAS_CLASS).not.toContain('bg-slate-50');
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
    expect(
      shouldShowStartCall({ isHost: true, avAllowed: true, avEnabled: false, callActive: false }),
    ).toBe(true);
  });

  it('returns false for a non-host peer even if admitted and no call is running', () => {
    expect(
      shouldShowStartCall({ isHost: false, avAllowed: true, avEnabled: false, callActive: false }),
    ).toBe(false);
  });

  it('offers an admitted peer a way back into a call that is already running', () => {
    // A student who left a live call could not re-enter it: the peer-follow
    // effect only fires when the room call state changes, and it had not.
    expect(
      shouldShowStartCall({ isHost: false, avAllowed: true, avEnabled: false, callActive: true }),
    ).toBe(true);
  });

  it('returns false when a call is already active', () => {
    expect(
      shouldShowStartCall({ isHost: true, avAllowed: true, avEnabled: true, callActive: true }),
    ).toBe(false);
  });

  it('returns false when av is not allowed', () => {
    expect(
      shouldShowStartCall({ isHost: true, avAllowed: false, avEnabled: false, callActive: false }),
    ).toBe(false);
  });
});

describe('shouldBroadcastCallStart', () => {
  const base = {
    isHost: true,
    callWanted: true,
    callActive: false,
    avStatus: 'joined' as const,
    alreadyBroadcast: false,
  };

  it('broadcasts only once the presser is actually in the call', () => {
    // Starting used to broadcast `{active:true}` before a token had even been
    // requested. On an unconfigured deployment that told every peer to open a
    // call panel that could never join.
    expect(shouldBroadcastCallStart(base)).toBe(true);
    expect(shouldBroadcastCallStart({ ...base, avStatus: 'connecting' })).toBe(false);
    expect(shouldBroadcastCallStart({ ...base, avStatus: 'idle' })).toBe(false);
    expect(shouldBroadcastCallStart({ ...base, avStatus: 'error' })).toBe(false);
  });

  it('never re-broadcasts a call that is already running', () => {
    expect(shouldBroadcastCallStart({ ...base, callActive: true })).toBe(false);
  });

  it('broadcasts once per start', () => {
    expect(shouldBroadcastCallStart({ ...base, alreadyBroadcast: true })).toBe(false);
  });

  it('is host-only', () => {
    expect(shouldBroadcastCallStart({ ...base, isHost: false })).toBe(false);
  });
});

describe('shouldAnnounceCallEnded', () => {
  it('announces when a peer is in a call that stops being active', () => {
    // "End for everyone" leaves the panel gone and the call over with nothing
    // said. The peer learns the lesson call finished from the silence.
    expect(shouldAnnounceCallEnded({ isLocalHost: false, wasActive: true, isActive: false })).toBe(true);
  });

  it('stays quiet for the host ending their own call', () => {
    expect(shouldAnnounceCallEnded({ isLocalHost: true, wasActive: true, isActive: false })).toBe(false);
  });

  it('stays quiet when there was no call to end', () => {
    expect(shouldAnnounceCallEnded({ isLocalHost: false, wasActive: false, isActive: false })).toBe(false);
    expect(shouldAnnounceCallEnded({ isLocalHost: false, wasActive: true, isActive: true })).toBe(false);
  });
});

describe('resolveWaitingPosition', () => {
  it('does not fabricate a position when the queue is full or the peer was suspended', () => {
    // A full queue used to fall through to "waitingPeers.length + 1", which
    // showed "number 4 in line" when the queue is shut and there is no line to
    // be in. The real position is 0 and the waiting screen hides it.
    expect(resolveWaitingPosition(0, 3, true, false)).toBe(0);
    expect(resolveWaitingPosition(0, 3, false, true)).toBe(0);
  });

  it('still fills in a position while a normal queue is settling', () => {
    expect(resolveWaitingPosition(0, 3, false, false)).toBe(4);
    expect(resolveWaitingPosition(2, 3, false, false)).toBe(2);
  });
});

describe('evictionNoticeCopy', () => {
  it('names the outcome instead of silently returning to the name prompt', () => {
    expect(evictionNoticeCopy({ wasKicked: true, wasRejected: false, wasSuspended: false }))
      .toBe('You were removed from the room.');
    expect(evictionNoticeCopy({ wasKicked: false, wasRejected: true, wasSuspended: false }))
      .toBe("Your teacher didn't let you in.");
    expect(evictionNoticeCopy({ wasKicked: false, wasRejected: false, wasSuspended: true }))
      .toBe('Moved back to the waiting room.');
    expect(evictionNoticeCopy({ wasKicked: false, wasRejected: false, wasSuspended: false }))
      .toBeNull();
  });
});

describe('supportButtonProps', () => {
  it('gives the support pill the same call-rail flag the rail itself uses', () => {
    /*
     * The pill sits on the right edge, under the docked call rail when the
     * rail is open. It was never told the rail existed, so the Support "?"
     * was drawn underneath it. The flag has to be the rail's own visibility,
     * not merely whether a call is enabled.
     */
    expect(supportButtonProps({ presenceCollapsed: false, callRailVisible: true }))
      .toEqual({ rosterExpanded: true, callRailOpen: true });
  });

  it('leaves the support pill un-offset while the rail is hidden', () => {
    expect(supportButtonProps({ presenceCollapsed: true, callRailVisible: false }))
      .toEqual({ rosterExpanded: false, callRailOpen: false });
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

