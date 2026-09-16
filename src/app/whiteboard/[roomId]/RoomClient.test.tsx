import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

import type { WhiteboardUser } from '@/types/whiteboard';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';
import { CALL_RAIL_WIDTH } from '@/lib/av/callRail';

import WhiteboardRoomPage, {
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
  shouldShowSyncDegradedNotice,
  shouldBroadcastCallStart,
  shouldAnnounceCallEnded,
  resolveWaitingPosition,
  evictionNoticeCopy,
  submitBoardClear,
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
    // The value itself is pinned in callRail.test.ts; here the contract is
    // that the canvas reads the same single-source constant.
    expect(open['--call-rail-w']).toBe(CALL_RAIL_WIDTH);
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

  it('carries whether each participant may share their screen (Phase 10)', () => {
    const states = mapAvPeerStateByPeerId(
      [
        { identity: 'acct-allowed', micMuted: false, micPresent: true, camOn: true, isSpeaking: false, canScreenShare: true },
        { identity: 'acct-refused', micMuted: false, micPresent: true, camOn: true, isSpeaking: false, canScreenShare: false },
      ],
      [
        makeUser({ peerId: 'peer-allowed', accountId: 'acct-allowed' }),
        makeUser({ peerId: 'peer-refused', accountId: 'acct-refused' }),
      ],
      'peer-owner',
    );
    expect(states.get('peer-allowed')?.canScreenShare).toBe(true);
    expect(states.get('peer-refused')?.canScreenShare).toBe(false);
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

type NetworkHandler = (url: string, init?: RequestInit) => Response | undefined;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubNetwork(handler: NetworkHandler): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = handler(String(input), init);
    return response ?? new Response(null, { status: 404 });
  });
}

function collaborationNetwork(options: {
  access?: unknown;
  presence?: unknown;
  presenceStatus?: number;
  room?: unknown;
} = {}): NetworkHandler {
  return (url) => {
    if (url === '/auth/session/current') return respond(200, {});
    if (url.endsWith('/access')) {
      return respond(200, options.access ?? { status: 'granted', role: 'creator' });
    }
    if (url.endsWith('/presence') || url.endsWith('/waiting')) {
      if (options.presenceStatus !== undefined && options.presenceStatus >= 400) {
        return new Response(null, { status: options.presenceStatus });
      }
      return respond(200, options.presence ?? { users: [], waitingPeers: [], isWaiting: false });
    }
    if (/\/api\/whiteboard\/room\/[^/]+$/.test(url)) {
      return respond(200, options.room ?? {
        elements: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        name: 'Algebra',
        maxUsers: 2,
        hostPeerId: 'peer-host',
        updated_at: 1,
      });
    }
    return undefined;
  };
}

function storeUserName(name = 'Alice'): void {
  window.localStorage.setItem('whiteboard_username', name);
}

async function renderRoom(handler: NetworkHandler = collaborationNetwork()): Promise<void> {
  stubNetwork(handler);
  render(<RoomContent roomId="room-alpha" />);
  await screen.findByTestId('whiteboard-canvas-area');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe('RoomContent main room', () => {
  it('draws the owner board shell with the room title and footer controls', async () => {
    storeUserName();
    await renderRoom();

    await waitFor(() => {
      expect(screen.getByTestId('room-name').textContent).toBe('Algebra');
    });
    expect(screen.getByTestId('room-title-trigger')).toBeTruthy();
    expect(screen.getByTestId('av-start-call').getAttribute('aria-label')).toBe('Start call');
    expect(screen.getByTestId('whiteboard-people-button')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-canvas-area').className)
      .toContain(roomCanvasTopClass(false));
  });

  it('a refused board clear reports false and names the board it asked about', async () => {
    const refused: AjaxFetch = async (input, init) => {
      expect(String(input).endsWith('/clear')).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({ boardId: 'board-1' });
      return new Response(null, { status: 403 });
    };
    expect(await submitBoardClear(refused, 'room-alpha', 'board-1')).toBe(false);

    const broken: AjaxFetch = async () => {
      throw new Error('socket gone');
    };
    expect(await submitBoardClear(broken, 'room-alpha', 'board-1')).toBe(false);

    const posts: Array<{ url: string; body: unknown }> = [];
    const allowed: AjaxFetch = async (input, init) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true });
    };
    expect(await submitBoardClear(allowed, 'room-alpha', 'board-1')).toBe(true);
    expect(posts).toEqual([
      { url: '/api/whiteboard/room/room-alpha/clear', body: { boardId: 'board-1' } },
    ]);
  });

  it('gives an editor the board without the owner controls', async () => {
    storeUserName();
    stubNetwork(collaborationNetwork({ access: { status: 'granted', role: 'editor' } }));
    render(<RoomContent roomId="room-alpha" />);
    await screen.findByTestId('whiteboard-canvas-area');

    expect(screen.getByTestId('room-name')).toBeTruthy();
    expect(screen.queryByTestId('room-title-trigger')).toBeNull();
    expect(screen.queryByTestId('av-start-call')).toBeNull();
  });

  it('starts the presence roster collapsed on a phone viewport', async () => {
    storeUserName();
    const wide = window.innerWidth;
    window.innerWidth = 400;
    try {
      await renderRoom();
      expect(screen.queryByTestId('whiteboard-presence-panel')).toBeNull();
    } finally {
      window.innerWidth = wide;
    }
  });

  it('opens the roster for the host when a student starts waiting', async () => {
    storeUserName();
    await renderRoom((url, init) => {
      if (url.endsWith('/presence')) {
        return respond(200, {
          users: [],
          waitingPeers: [{ peerId: 'peer-wait', accountId: null, userName: 'Bob', color: '#123456' }],
          isWaiting: false,
        });
      }
      return collaborationNetwork()(url, init);
    });

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-presence-panel')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-waiting-section')).toBeTruthy();
  });

  it('shows the degraded sync notice when the presence heartbeat fails', async () => {
    storeUserName();
    await renderRoom(collaborationNetwork({ presenceStatus: 500 }));

    expect(await screen.findByTestId('whiteboard-sync-degraded')).toBeTruthy();
  });

  it('stops trusting the fallbacks and says the connection is lost', async () => {
    storeUserName();
    let heartbeats = 0;
    stubNetwork((url, init) => {
      if (url.endsWith('/presence') && init?.method === 'POST') heartbeats += 1;
      return collaborationNetwork({ presenceStatus: 500 })(url, init);
    });
    render(<RoomContent roomId="room-alpha" />);

    expect(await screen.findByTestId('whiteboard-sync-degraded')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId('whiteboard-connection-lost')).toBeTruthy();
    }, { timeout: 15_000 });
    expect(heartbeats).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('keeps the debug handles off the window in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WHITEBOARD_DEBUG', '');
    vi.stubEnv('NEXT_PUBLIC_E2E', '');
    storeUserName();
    await renderRoom();

    expect((window as { __whiteboardCollab?: unknown }).__whiteboardCollab).toBeUndefined();
  });

  it('opens the device check instead of joining when start is pressed', async () => {
    storeUserName();
    await renderRoom((url, init) => {
      if (url.startsWith('/api/av/token')) return new Response(null, { status: 500 });
      return collaborationNetwork()(url, init);
    });

    fireEvent.click(await screen.findByTestId('av-start-call'));

    expect(await screen.findByTestId('av-pre-join')).toBeTruthy();
    expect(screen.queryByTestId('av-session-panel')).toBeNull();
  });

  it('joins the call once the device check is confirmed', async () => {
    storeUserName();
    await renderRoom((url, init) => {
      if (url.startsWith('/api/av/token')) return new Response(null, { status: 500 });
      return collaborationNetwork()(url, init);
    });

    fireEvent.click(await screen.findByTestId('av-start-call'));
    fireEvent.click(await screen.findByTestId('av-pre-join-confirm'));

    expect(await screen.findByTestId('av-session-panel')).toBeTruthy();
    expect(screen.queryByTestId('av-pre-join')).toBeNull();
  });

  it('keeps the call off when the device check is cancelled', async () => {
    storeUserName();
    await renderRoom((url, init) => {
      if (url.startsWith('/api/av/token')) return new Response(null, { status: 500 });
      return collaborationNetwork()(url, init);
    });

    fireEvent.click(await screen.findByTestId('av-start-call'));
    fireEvent.click(await screen.findByTestId('av-pre-join-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('av-pre-join')).toBeNull();
    });
    expect(screen.queryByTestId('av-session-panel')).toBeNull();
    // The explicit control stays available for somebody who cancelled.
    expect(screen.getByTestId('av-start-call')).toBeTruthy();
  });

  it('asks again when start is pressed after a cancel', async () => {
    storeUserName();
    await renderRoom((url, init) => {
      if (url.startsWith('/api/av/token')) return new Response(null, { status: 500 });
      return collaborationNetwork()(url, init);
    });

    fireEvent.click(await screen.findByTestId('av-start-call'));
    fireEvent.click(await screen.findByTestId('av-pre-join-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('av-pre-join')).toBeNull();
    });

    // Explicit intent always opens the check, even right after a refusal.
    fireEvent.click(screen.getByTestId('av-start-call'));

    expect(await screen.findByTestId('av-pre-join')).toBeTruthy();
  });

  it('surfaces a refused kick as a moderation error', async () => {
    const kicked: string[] = [];
    storeUserName();
    await renderRoom((url, init) => {
      if (url.endsWith('/presence') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.action === 'kick') {
          kicked.push(body.peerId ?? body.accountId);
          return new Response(null, { status: 403 });
        }
        return respond(200, {
          users: [
            { peerId: 'peer-self', accountId: null, userName: 'Alice', color: '#111111', isHost: true },
            { peerId: 'peer-student', accountId: null, userName: 'Bob', color: '#222222', isHost: false },
          ],
          waitingPeers: [],
          isWaiting: false,
        });
      }
      return collaborationNetwork()(url, init);
    });

    fireEvent.click(await screen.findByTestId('whiteboard-people-button'));
    fireEvent.click(await screen.findByTestId('whiteboard-roster-open-peer-student'));
    fireEvent.click(screen.getByTestId('whiteboard-context-kick'));

    expect(await screen.findByTestId('whiteboard-moderation-error')).toBeTruthy();
    expect(kicked).toEqual(['peer-student']);
  });
});

describe('RoomContent room title', () => {
  it('renames the room from the title menu and posts the new name', async () => {
    const posts: { url: string; body: unknown }[] = [];
    storeUserName();
    await renderRoom((url, init) => {
      if (url === '/api/whiteboard/room/room-alpha/settings' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return respond(200, {});
      }
      return collaborationNetwork()(url, init);
    });

    fireEvent.click(await screen.findByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-rename'));
    const input = screen.getByTestId('room-name-input');
    fireEvent.change(input, { target: { value: 'Geometry' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0].body).toEqual({ name: 'Geometry' });
    expect(screen.getByTestId('room-name').textContent).toBe('Geometry');
  });

  it('leaves Save as and the library to the editor when no board actions exist', async () => {
    storeUserName();
    await renderRoom();

    const trigger = await screen.findByTestId('room-title-trigger');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('room-menu-save'));
    expect(screen.queryByTestId('room-title-menu')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('room-menu-library'));
    expect(screen.queryByTestId('room-title-menu')).toBeNull();
  });

  it('leaves for the rooms list and clears the host call state', async () => {
    const requests: { url: string; method: string | undefined }[] = [];
    storeUserName();
    await renderRoom((url, init) => {
      if (init?.method === 'DELETE') requests.push({ url, method: init.method });
      return collaborationNetwork()(url, init);
    });

    fireEvent.click(await screen.findByTestId('whiteboard-back-to-rooms'));

    await waitFor(() => {
      expect(requests.some((entry) => (
        entry.url.startsWith('/api/whiteboard/room/room-alpha/presence')
        && entry.method === 'DELETE'
      ))).toBe(true);
    });
    expect(window.localStorage.getItem('whiteboard_username')).toBeNull();
  });
});

describe('RoomContent admission states', () => {
  it('waits in the queue with the position the room reports', async () => {
    storeUserName();
    const requests: string[] = [];
    stubNetwork((url, init) => {
      if (init?.method === 'DELETE') requests.push(url);
      if (url.endsWith('/presence')) {
        return respond(200, {
          users: [],
          waitingPeers: [{ peerId: 'peer-other', accountId: null, userName: 'Bob', color: '#123456' }],
          isWaiting: true,
        });
      }
      return collaborationNetwork()(url, init);
    });
    render(<RoomContent roomId="room-alpha" />);

    expect(await screen.findByText(/You are number 2 in line/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('whiteboard-back-to-rooms'));

    await waitFor(() => {
      expect(requests.some((url) => url.startsWith('/api/whiteboard/room/room-alpha/waiting')))
        .toBe(true);
    });
  });

  it('shows a full waiting list without inventing a position', async () => {
    storeUserName();
    stubNetwork(collaborationNetwork({ presenceStatus: 409 }));
    render(<RoomContent roomId="room-alpha" />);

    expect(await screen.findByText('Waiting List is Full')).toBeTruthy();
    expect(screen.queryByText(/in line/)).toBeNull();
  });

  it('returns a refused student to the prompt with the reason', async () => {
    storeUserName();
    stubNetwork(collaborationNetwork({ presenceStatus: 403 }));
    render(<RoomContent roomId="room-alpha" />);

    const notice = await screen.findByTestId('whiteboard-eviction-notice');
    expect(notice.textContent).toBe("Your teacher didn't let you in.");
    expect(screen.getByTestId('whiteboard-username-input')).toBeTruthy();
  });

  it('joins a guest host through the guest prompt without reading the session', async () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'localhost');
    const requested: string[] = [];
    stubNetwork(collaborationNetwork());
    render(
      <RoomContent
        roomId="room-alpha"
        request={async (input) => {
          requested.push(String(input));
          return respond(200, {});
        }}
      />,
    );

    expect(await screen.findByTestId('guest-join-prompt')).toBeTruthy();
    // The guest prompt must come up without reading the teacher session.
    // The room's own GET and access read are the room flow, not the session.
    expect(requested).not.toContain('/auth/session/current');
  });
});

describe('RoomContent session parsing', () => {
  it('shows no plan for a session whose plan cannot be trusted', async () => {
    const sessions: unknown[] = [
      null,
      'alice',
      {},
      { plan: 'pro' },
      { plan: { planId: 42, status: 'active' } },
      { plan: { planId: 'bogus', status: 'active' } },
      { plan: { planId: 'free', status: 7 } },
      { plan: { planId: 'free', status: 'bogus' } },
    ];

    for (const session of sessions) {
      stubNetwork(collaborationNetwork());
      const view = render(
        <RoomContent roomId="room-alpha" request={async () => respond(200, session)} />,
      );
      fireEvent.click(await screen.findByTestId('whiteboard-profile-btn'));
      expect(screen.queryByTestId('whiteboard-profile-plan')).toBeNull();
      view.unmount();
    }
  });

  it('shows no company for a company record that cannot be trusted', async () => {
    const sessions: unknown[] = [
      { company: 42 },
      { company: { name: 'Acme', role: 'owner' } },
      { company: { id: 'acme', role: 'owner' } },
      { company: { id: 'acme', name: 'Acme', role: 'guest' } },
    ];

    for (const session of sessions) {
      stubNetwork(collaborationNetwork());
      const view = render(
        <RoomContent roomId="room-alpha" request={async () => respond(200, session)} />,
      );
      fireEvent.click(await screen.findByTestId('whiteboard-profile-btn'));
      expect(screen.queryByTestId('whiteboard-profile-company')).toBeNull();
      view.unmount();
    }
  });

  it('shows the company role the session names', async () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      stubNetwork(collaborationNetwork());
      const view = render(
        <RoomContent
          roomId="room-alpha"
          request={async () => respond(200, {
            plan: { planId: 'free', status: 'active' },
            company: { id: 'acme', name: 'Acme Tutoring', role },
          })}
        />,
      );
      fireEvent.click(await screen.findByTestId('whiteboard-profile-btn'));
      expect(screen.getByTestId('whiteboard-profile-company').textContent)
        .toContain(`Acme Tutoring · ${role}`);
      view.unmount();
    }
  });

  it('shows a past-due grace date and a billing hold', async () => {
    stubNetwork(collaborationNetwork());
    render(
      <RoomContent
        roomId="room-alpha"
        request={async () => respond(200, {
          plan: {
            planId: 'tutor_pro_monthly',
            status: 'past_due',
            graceUntil: 1_735_689_600_000,
            collectionPaused: true,
          },
        })}
      />,
    );

    fireEvent.click(await screen.findByTestId('whiteboard-profile-btn'));

    expect(screen.getByTestId('whiteboard-profile-plan-grace').textContent)
      .toContain('payment overdue');
    expect(screen.getByTestId('whiteboard-profile-plan-hold').textContent)
      .toBe('billing on hold');
  });

  it('takes the display name from the session when nothing is stored', async () => {
    stubNetwork(collaborationNetwork());
    render(
      <RoomContent
        roomId="room-alpha"
        request={async () => respond(200, { displayName: 'Ms Ada' })}
      />,
    );

    expect(await screen.findByTestId('whiteboard-canvas-area')).toBeTruthy();
    expect(window.localStorage.getItem('whiteboard_username')).toBe('Ms Ada');
  });

  it('ignores a session response that lands after the prompt unmounts', async () => {
    let finish: ((response: Response) => void) | undefined;
    stubNetwork(collaborationNetwork());
    const view = render(
      <RoomContent
        roomId="room-alpha"
        request={async () => new Promise<Response>((resolve) => { finish = resolve; })}
      />,
    );
    await screen.findByTestId('whiteboard-profile-btn');
    view.unmount();

    finish?.(respond(200, { displayName: 'Alice' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(window.localStorage.getItem('whiteboard_username')).toBeNull();
  });

  it('ignores a refused session response that lands after the prompt unmounts', async () => {
    let finish: ((response: Response) => void) | undefined;
    stubNetwork(collaborationNetwork());
    const view = render(
      <RoomContent
        roomId="room-alpha"
        request={async () => new Promise<Response>((resolve) => { finish = resolve; })}
      />,
    );
    await screen.findByTestId('whiteboard-profile-btn');
    view.unmount();

    finish?.(new Response(null, { status: 500 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(window.localStorage.getItem('whiteboard_username')).toBeNull();
  });
});

describe('WhiteboardRoomPage', () => {
  it('shows the loading screen while the path names no room', () => {
    window.history.pushState({}, '', '/');
    render(<WhiteboardRoomPage />);

    expect(screen.getByText('Connecting to room…')).toBeTruthy();
  });

  it('reads the room id from the address bar', async () => {
    window.history.pushState({}, '', '/whiteboard/room-alpha');
    storeUserName();
    stubNetwork(collaborationNetwork());
    render(<WhiteboardRoomPage />);

    expect(    await screen.findByTestId('whiteboard-canvas-area')).toBeTruthy();
  });
});

describe('room board tabs', () => {
  it('renders one tab per board with the main board first', async () => {
    storeUserName();
    await renderRoom();

    expect(screen.getByTestId('board-tabs')).toBeTruthy();
    expect(screen.getByTestId('board-tab-main').textContent).toBe('Board 1');
    expect(screen.getByTestId('board-tab-main').getAttribute('aria-pressed')).toBe('true');
  });

  it('switches the active board when a tab is clicked and passes it to the wrapper', async () => {
    /*
     * The active board is the room's state: the tab strip reports the click
     * and the editor takes the same value as a prop (its board-scoped
     * behaviour is ExcalidrawWrapper.test.tsx's to prove -- the dynamic
     * wrapper never mounts inside this suite). What this file can see is the
     * round trip: add, land on the new board, and back to main.
     */
    storeUserName();
    await renderRoom();

    fireEvent.click(screen.getByTestId('board-tabs-add'));
    await waitFor(() => {
      expect(screen.getAllByTestId(/^board-tab-/)).toHaveLength(2);
    });
    const tabs = screen.getAllByTestId(/^board-tab-/);
    expect(tabs[1].getAttribute('aria-pressed')).toBe('true');
    expect(tabs[0].getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByTestId('board-tab-main'));
    expect(screen.getByTestId('board-tab-main').getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the per-board delete control from a non-owner', async () => {
    storeUserName();
    stubNetwork(collaborationNetwork({ access: { status: 'granted', role: 'editor' } }));
    render(<RoomContent roomId="room-alpha" />);
    await screen.findByTestId('whiteboard-canvas-area');

    expect(screen.getByTestId('board-tabs')).toBeTruthy();
    expect(screen.getByTestId('board-tabs-add')).toBeTruthy();
    expect(screen.queryByTestId('board-tabs-delete')).toBeNull();
    expect(screen.queryByTestId('board-tabs-clear')).toBeNull();
  });
});

describe('room seats from the title menu', () => {
  it('saves the new seat count through the settings route and raises the capacity', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const request: AjaxFetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/auth/session/current') {
        return jsonResponse({ displayName: 'Alice' });
      }
      if (method === 'POST' && url.endsWith('/settings')) {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ success: true, maxUsers: 5 });
      }
      if (url === '/api/whiteboard/room/room-alpha') {
        return jsonResponse({ elements: [], viewport: { x: 0, y: 0, zoom: 1 }, maxUsers: 2, updated_at: 1 });
      }
      if (url === '/api/whiteboard/room/room-alpha/access') {
        return jsonResponse({ status: 'granted', role: 'creator' });
      }
      if (url.endsWith('/presence') && method === 'POST') {
        return jsonResponse({ users: [], waitingPeers: [], hostPeerId: null, isWaiting: false, peerId: 'peer-1' });
      }
      return jsonResponse({});
    };

    render(<RoomContent roomId="room-alpha" request={request} />);

    fireEvent.click(await screen.findByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-seats'));
    expect(screen.getByTestId('room-seats-value').textContent).toBe('2');

    // Free-plan rooms start at two seats; raise to five and save.
    fireEvent.click(screen.getByTestId('room-seats-up'));
    fireEvent.click(screen.getByTestId('room-seats-up'));
    fireEvent.click(screen.getByTestId('room-seats-up'));
    fireEvent.click(screen.getByTestId('room-seats-save'));

    await waitFor(() => {
      expect(posts).toEqual([
        { url: '/api/whiteboard/room/room-alpha/settings', body: { maxUsers: 5 } },
      ]);
    });
    // The capacity shown beside the board is the accepted one, not the stale one.
    await waitFor(() => {
      expect(screen.getByLabelText(/of 5/)).toBeTruthy();
    });
  });
});

