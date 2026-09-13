'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import PeopleButton from '@/components/whiteboard/PeopleButton';
import { CALL_RAIL_WIDTH } from '@/lib/av/callRail';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useCollaboration } from '@/hooks/useCollaboration';
import { usePersistence } from '@/hooks/usePersistence';
import { useClearSessionOnEviction } from '@/hooks/useClearSessionOnEviction';
import { useAvSession } from '@/hooks/useAvSession';
import UserNamePrompt from '@/components/whiteboard/UserNamePrompt';
import GuestJoinPrompt from '@/components/whiteboard/GuestJoinPrompt';
import LoadingScreen from '@/components/whiteboard/LoadingScreen';
import WaitingRoom from '@/components/whiteboard/WaitingRoom';
import { isGuestHostname } from '@/lib/guest/guestHost';
import PresencePanel from '@/components/whiteboard/PresencePanel';
import RaisedHandCue from '@/components/whiteboard/RaisedHandCue';
import { shouldCollapsePresenceForViewport } from '@/lib/whiteboard/presenceViewport';
import { shouldOverlayConnectingScreen } from '@/lib/whiteboard/connectingOverlay';
import { shouldExpandForArrival } from '@/lib/whiteboard/waitingArrival';
import ClearBoardModal from '@/components/whiteboard/ClearBoardModal';
import RoomTopNav from '@/components/whiteboard/RoomTopNav';
import AvSessionPanel from '@/components/av/AvSessionPanel';
import StartCallButton from '@/components/av/StartCallButton';
import ConnectionLostNotice from '@/components/whiteboard/ConnectionLostNotice';
import SyncDegradedNotice from '@/components/whiteboard/SyncDegradedNotice';
import RoomTitleMenu from '@/components/whiteboard/RoomTitleMenu';
import { saveBlob } from '@/lib/whiteboard/saveBlob';
import { boardFileName, buildExcalidrawContainer } from '@/lib/whiteboard/boardExport';
import type { BoardActions } from '@/components/whiteboard/ExcalidrawWrapper';
import SupportButton from '@/components/whiteboard/SupportButton';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import * as store from '@/lib/whiteboard/store';
import { cleanupStaleRooms } from '@/lib/whiteboard/persistence';
import { isWhiteboardDebugEnabled } from '@/lib/whiteboard/ywebrtcProvider';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { resolveJoinDisplayName } from '@/lib/access/accessDisplayName';
import { roomIdFromWhiteboardPath } from '@/lib/whiteboard/roomPath';
import { shouldClearUsernameOnEviction } from '@/lib/whiteboard/evictionUi';
import type { ParticipantState } from '@/lib/av/avSession';
import type { WhiteboardUser } from '@/types/whiteboard';
import type { CallState } from '@/lib/whiteboard/callMessage';
import type { UserProfileCompany, UserProfilePlan } from '@/components/whiteboard/UserProfileMenu';
import type { PlanId } from '@/lib/plan/catalog';
import type { EntitlementStatus } from '@/lib/plan/effectivePlan';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

const PLAN_IDS: readonly PlanId[] = [
  'free',
  'tutor_pro_monthly',
  'tutor_pro_annual',
  'corporate_seat',
];
const PLAN_STATUSES: readonly EntitlementStatus[] = [
  'free',
  'trialing',
  'active',
  'past_due',
  'canceled',
];

function readPlan(session: unknown): UserProfilePlan | null {
  if (!session || typeof session !== 'object') return null;
  const plan = (session as { plan?: unknown }).plan;
  if (!plan || typeof plan !== 'object') return null;
  const { planId, status, graceUntil, collectionPaused } = plan as Record<string, unknown>;
  if (typeof planId !== 'string' || !PLAN_IDS.includes(planId as PlanId)) return null;
  if (typeof status !== 'string' || !PLAN_STATUSES.includes(status as EntitlementStatus)) {
    return null;
  }
  return {
    planId: planId as PlanId,
    status: status as EntitlementStatus,
    graceUntil: typeof graceUntil === 'number' ? graceUntil : null,
    collectionPaused: collectionPaused === true,
  };
}

function readCompany(session: unknown): UserProfileCompany | null {
  if (!session || typeof session !== 'object') return null;
  const company = (session as { company?: unknown }).company;
  if (!company || typeof company !== 'object') return null;
  const { id, name, role } = company as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (role !== 'owner' && role !== 'admin' && role !== 'member') return null;
  return { id, name, role };
}

/**
 * The placeholder while the editor chunk loads.
 *
 * `h-full min-h-0`, not a 25rem floor: the room shell already owns a
 * `calc(100dvh - ...)` height and clips its overflow, so a taller placeholder
 * pushed the toolbar, zoom and footer off the bottom on short or landscape
 * viewports before the board had even drawn.
 */
export const EXCALIDRAW_LOADING_CLASS = 'w-full h-full min-h-0';

const ExcalidrawWrapper = dynamic(
  () => import('@/components/whiteboard/ExcalidrawWrapper'),
  {
    ssr: false,
    loading: () => <div className={EXCALIDRAW_LOADING_CLASS} />,
  },
);

/**
 * The board spans the window; everything else floats over it.
 *
 * It used to start after the tool rail and stop before the roster, which cost
 * a teacher a strip of drawing surface down each side that nothing was ever
 * painted into -- both are `fixed`, and were drawing over the board's own
 * layer regardless. Worse, the right-hand strip came and went with the roster,
 * so collapsing it resized the canvas under a lesson in progress.
 */
export const ROOM_CANVAS_CLASS =
  'absolute inset-x-0 bottom-0 overflow-hidden bg-[var(--paper)]';

/**
 * How much of the canvas the call rail takes, if it is showing.
 *
 * The rail is the one piece of furniture the board makes room for. The roster
 * and the notices float over it and the board keeps its full width, because
 * reserving space for something that overlays anyway left dead strips down each
 * side. The rail is different: opaque, flush to the edge and full height, so a
 * board continuing underneath would hide whatever was drawn there with no way
 * to reach it.
 *
 * Only from `sm:` up. On a phone the rail is a strip along the bottom, and
 * reserving its height would leave almost nothing to draw on.
 */
export function roomCanvasRightClass(railVisible: boolean): string {
  /*
   * The width reaches CSS through the --call-rail-w variable, set inline by
   * {@link roomCanvasRailStyle}, rather than through a class assembled by
   * interpolation. An interpolated arbitrary value is invisible to Tailwind's
   * source scan: the generated stylesheet only ever contained this one because
   * the unit test spelled the resolved literal out, and any reshuffle of the
   * test files would have silently deleted the reservation. PresencePanel
   * already carried the variable for the same constant; the canvas now does
   * too, and both read the same static `sm:right-[var(--call-rail-w)]`.
   */
  return railVisible ? 'sm:right-[var(--call-rail-w)]' : '';
}

/**
 * The inline CSS variable the rail-width class reads. Paired with
 * {@link roomCanvasRightClass}: the class reserves the space, this names how
 * much. Absent when the rail is hidden, so nothing is reserved for nothing.
 */
export function roomCanvasRailStyle(railVisible: boolean): React.CSSProperties {
  return railVisible
    ? ({ ['--call-rail-w' as string]: CALL_RAIL_WIDTH } as React.CSSProperties)
    : {};
}

export function roomCanvasTopClass(guestHost: boolean): string {
  return guestHost ? 'top-0 sm:top-12' : 'top-[calc(3rem+env(safe-area-inset-top))] sm:top-12';
}

export function mapAvPeerIds(
  participants: readonly ParticipantState[],
  users: readonly WhiteboardUser[],
  localPeerId: string,
  include: (participant: ParticipantState) => boolean,
): ReadonlySet<string> {
  return new Set(
    participants
      .filter(include)
      .flatMap((participant) => {
        const peerId = participant.identity === '__local__'
          ? localPeerId
          : users.find((user) => user.accountId === participant.identity)?.peerId;
        return peerId ? [peerId] : [];
      }),
  );
}

export function mapAvPeerStateByPeerId(
  participants: readonly ParticipantState[],
  users: readonly WhiteboardUser[],
  localPeerId: string,
): ReadonlyMap<string, { micMuted: boolean; micPresent: boolean; camOn: boolean; quality?: ParticipantState['quality'] }> {
  return new Map(
    participants.flatMap((participant) => {
      const peerId = participant.identity === '__local__'
        ? localPeerId
        : users.find((user) => user.accountId === participant.identity)?.peerId;
      return peerId
        ? [[peerId, {
          micMuted: participant.micMuted,
          micPresent: participant.micPresent,
          camOn: participant.camOn,
          quality: participant.quality,
        }] as const]
        : [];
    }),
  );
}

export function resolveAvTargetAccountId(
  users: readonly WhiteboardUser[],
  localPeerId: string,
  peerId: string,
): string | null {
  if (peerId === localPeerId) return '__local__';
  return users.find((user) => user.peerId === peerId)?.accountId ?? null;
}

/**
 * What the join prompt says when a peer was removed from the room.
 *
 * Kick and reject return to the prompt by clearing the stored name, which
 * used to happen silently -- a student was typing and then simply back at the
 * name field, with no way to tell whether they had been removed or had
 * crashed. The waiting-room branch owns the suspend copy, but the wording
 * lives here too so the three outcomes are described in one place.
 */
export function evictionNoticeCopy(flags: {
  wasKicked: boolean;
  wasRejected: boolean;
  wasSuspended: boolean;
}): string | null {
  if (flags.wasKicked) return 'You were removed from the room.';
  if (flags.wasRejected) return "Your teacher didn't let you in.";
  if (flags.wasSuspended) return 'Moved back to the waiting room.';
  return null;
}

export function shouldShowStartCall({
  isHost,
  avAllowed,
  avEnabled,
  callActive,
}: {
  isHost: boolean;
  avAllowed: boolean;
  avEnabled: boolean;
  /**
   * The room's call is already running. Then the control is a rejoin for
   * anybody admitted, not a start for the host alone -- a student who left a
   * live call has to be able to get back into it.
   */
  callActive: boolean;
}): boolean {
  return avAllowed && !avEnabled && (isHost || callActive);
}

/**
 * When the host's "start" may be announced to the room.
 *
 * Not when the button is pressed: on an unconfigured deployment the token
 * request fails and every peer would be told to open a call that does not
 * exist. The broadcast waits for this caller to be joined, which is the first
 * moment the room knows a call is actually up. `alreadyBroadcast` keeps a
 * reconnect from re-announcing the same call.
 */
export function shouldBroadcastCallStart({
  isHost,
  callWanted,
  callActive,
  avStatus,
  alreadyBroadcast,
}: {
  isHost: boolean;
  callWanted: boolean;
  callActive: boolean;
  avStatus: string;
  alreadyBroadcast: boolean;
}): boolean {
  return isHost && callWanted && !callActive && avStatus === 'joined' && !alreadyBroadcast;
}

/**
 * Whether a peer should be told the room's call has finished.
 *
 * The notice is for the people who were in the call when it ended, not for
 * the host who pressed the button -- they know. `wasActive` is the previous
 * room-call state, so an initial `false` on mount is not an ending.
 */
export function shouldAnnounceCallEnded({
  isLocalHost,
  wasActive,
  isActive,
}: {
  isLocalHost: boolean;
  wasActive: boolean;
  isActive: boolean;
}): boolean {
  return !isLocalHost && wasActive && !isActive;
}

/**
 * The position to show on the waiting screen.
 *
 * A peer whose row has not arrived yet has no position, and `waitingCount + 1`
 * is a reasonable stand-in -- except when the queue is full or the peer was
 * just suspended, where there is no line at all and a fabricated number is a
 * lie the waiting screen has to undo. In those states the real value is 0 and
 * the screen hides it.
 */
export function resolveWaitingPosition(
  position: number,
  waitingCount: number,
  queueFull: boolean,
  suspended: boolean,
): number {
  if (queueFull || suspended) return position;
  return position || waitingCount + 1;
}

/*
 * Deliberately not conditioned on a host being present. The call belongs to the
 * room: if the teacher refreshes, drops off wifi or closes the tab, the peers
 * are still talking to each other and must stay connected. Requiring a host
 * here dropped the whole room the moment the host's presence row went away.
 */
export function shouldPeerEnterCall({
  callActive,
  avAllowed,
}: {
  callActive: boolean;
  avAllowed: boolean;
}): boolean {
  return Boolean(callActive && avAllowed);
}

/**
 * The placement flags for the support pill.
 *
 * The pill sits on the same right edge as the docked call rail, and while the
 * rail is open it has to step left of it. The flag is the rail's own
 * visibility -- `avAllowed && avEnabled && callRailOpen` -- not merely whether
 * a call is switched on: a rail that is hidden gives the edge back to the pill.
 */
export function supportButtonProps({
  presenceCollapsed,
  callRailVisible,
}: {
  presenceCollapsed: boolean;
  callRailVisible: boolean;
}): { rosterExpanded: boolean; callRailOpen: boolean } {
  return { rosterExpanded: !presenceCollapsed, callRailOpen: callRailVisible };
}

export function shouldShowSyncDegradedNotice({
  syncDegraded,
  connectionLost,
}: {
  syncDegraded: boolean;
  connectionLost: boolean;
}): boolean {
  return syncDegraded && !connectionLost;
}

export function RoomContent({ roomId, request = ajaxFetch }: { roomId: string; request?: AjaxFetch }) {
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);
  const [hostPlan, setHostPlan] = useState<UserProfilePlan | null>(null);
  const [hostCompany, setHostCompany] = useState<UserProfileCompany | null>(null);
  const [guestHost, setGuestHost] = useState(false);
  const [guestHostReady, setGuestHostReady] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  // The store is the single source of truth for the active tool: keyboard
  // shortcuts write to it directly, so deriving from it keeps the sidebar
  // highlight and Excalidraw's own tool in step with them.
  /*
   * Whether a call is live, for the presence heartbeat to consult.
   *
   * A ref rather than a value because of the ordering: the call is gated on
   * the admission `useCollaboration` reports, so it cannot exist before that
   * hook runs. The ref is created first and filled in below.
   */
  const callLiveRef = useRef(false);
  const [activeTool, setActiveTool] = useState(() => store.getState().tool);

  useEffect(
    () => store.subscribe(() => setActiveTool(store.getState().tool)),
    [],
  );

  useEffect(() => {
    setGuestHost(isGuestHostname(window.location.hostname));
    setGuestHostReady(true);
  }, []);

  const handleToolChange = useCallback((tool: string) => {
    store.setTool(tool as Parameters<typeof store.setTool>[0]);
  }, []);
  const [boardEverShown, setBoardEverShown] = useState(false);
  /*
   * Closed until asked for. It used to be docked open, which put it on the same
   * edge as the call rail -- two permanent panels, and everybody's mic and
   * camera state drawn twice, once on their tile and once on their row.
   *
   * Lessonspace and Pencil Spaces both keep only the tiles on screen and put
   * the participant list behind a control in the top right. The People button
   * is that control, and it carries a badge so somebody waiting to be let in is
   * still visible without opening it.
   *
   * Deliberately not auto-collapsed when a call starts: that fights whoever
   * just opened it, and a host moderating mid-call would have it shut in their
   * face.
   */
  const [presenceCollapsed, setPresenceCollapsed] = useState(true);
  const [isGuiding, setIsGuiding] = useState(false);
  const {
    isConnected,
    isSynced,
    users,
    cursors,
    error,
    status,
    connectionLost,
    syncDegraded,
    roomName,
    setRoomName,
    maxUsers,
    elements,
    localPeerId,
    isHost,
    isRoomOwner,
    provider,
    waitingPeers,
    isWaiting,
    queueFull,
    wasKicked,
    wasRejected,
    wasSuspended,
    approvePeer,
    rejectPeer,
    leaveWaitingRoom,
    leaveRoom,
    kickPeer,
    sendToWaitingRoom,
    setHandRaised,
    moderationError,
    reloadPresence,
    setCursor,
    setUserName: syncUserName,
    yDoc,
    yElementsArray,
    setElements,
    viewport,
    storeViewport,
    hostPeerId,
    guideMessage,
    remoteCallActive,
    sendFollowMessage,
    sendCallMessage,
  } = useCollaboration(roomId, callLiveRef);

  const handleGuideViewport = useCallback((nextViewport: { x: number; y: number; zoom: number }) => {
    sendFollowMessage({ active: true, viewport: nextViewport });
  }, [sendFollowMessage]);

  const handleToggleGuide = useCallback(() => {
    if (isGuiding) {
      sendFollowMessage({ active: false });
      setIsGuiding(false);
      return;
    }
    setIsGuiding(true);
  }, [isGuiding, sendFollowMessage]);

  const localUser = users.find((user) => user.peerId === localPeerId);
  // Host status comes only from the recorded host. A first-in-list fallback
  // would let whoever happens to be listed first silently become host.
  // Computed here rather than further down because the board controls below
  // are gated on it, keyboard included.
  const isLocalHost = Boolean(isHost || localUser?.isHost);

  useKeyboardShortcuts();

  const { clearState, clearSession } = usePersistence(roomId, elements, { x: 0, y: 0, zoom: 1 } as any);

  useClearSessionOnEviction(clearSession, { wasKicked, wasRejected, wasSuspended });

  // Voice only after admission. Waiting / kicked peers never fetch a token.
  const avAllowed = Boolean(userName) && !isWaiting && !wasKicked;
  /*
   * And only once somebody has asked for it.
   *
   * Opening a room used to take the camera and the microphone whether or not
   * the lesson wanted a call, so the browser's recording indicator came on for
   * someone who had only opened a whiteboard, and a teacher setting a board up
   * an hour early sat live in an empty room.
   */
  const [callWanted, setCallWanted] = useState(false);
  const avEnabled = avAllowed && callWanted;
  const av = useAvSession({
    roomId,
    identity: localPeerId,
    displayName: userName ?? 'Anonymous',
    enabled: avEnabled,
  });
  const avPeerStates = mapAvPeerStateByPeerId(av.participants, users, localPeerId);

  const handleStartCall = useCallback(() => {
    setCallWanted(true);
  }, []);

  /*
   * Announced to the room only once this caller is actually joined, which the
   * effect below does. Pressing the button is a local wish, not news.
   */
  const callStartBroadcastRef = useRef(false);
  useEffect(() => {
    if (!callWanted) {
      callStartBroadcastRef.current = false;
      return;
    }
    if (
      shouldBroadcastCallStart({
        isHost: isLocalHost,
        callWanted,
        callActive: remoteCallActive,
        avStatus: av.status,
        alreadyBroadcast: callStartBroadcastRef.current,
      })
    ) {
      callStartBroadcastRef.current = true;
      sendCallMessage({ active: true, hostAccountId: localUser?.accountId ?? '', startedAt: Date.now() });
    }
  }, [av.status, callWanted, isLocalHost, localUser?.accountId, remoteCallActive, sendCallMessage]);

  /*
   * "End for everyone" unmounts the panel on every peer in the room. Without
   * this the call just vanishes -- the faces, the audio, the header -- with
   * nothing said, and the next thing that happens is a student asking whether
   * their internet broke. Say it, then let the notice go.
   */
  const [callEndedNotice, setCallEndedNotice] = useState(false);
  const previousRemoteCallActiveRef = useRef(remoteCallActive);
  useEffect(() => {
    const previous = previousRemoteCallActiveRef.current;
    previousRemoteCallActiveRef.current = remoteCallActive;
    if (!shouldAnnounceCallEnded({ isLocalHost, wasActive: previous, isActive: remoteCallActive })) {
      return;
    }
    setCallEndedNotice(true);
    const timer = window.setTimeout(() => setCallEndedNotice(false), 6000);
    return () => window.clearTimeout(timer);
  }, [isLocalHost, remoteCallActive]);

  /*
   * Leaving and ending are different things, and only the host can do the
   * second. A teacher stepping away must not hang up on the class -- the same
   * split Pencil Spaces and Google Meet give a host.
   */
  const handleLeaveCall = useCallback(() => {
    setCallWanted(false);
  }, []);

  const handleEndCallForEveryone = useCallback(() => {
    setCallWanted(false);
    sendCallMessage({ active: false });
  }, [sendCallMessage]);

  const [callRailOpen, setCallRailOpen] = useState(false);

  const callRailVisible = avAllowed && avEnabled && callRailOpen;

  const hasHost = users.some((u) => u.isHost);

  // Non-host peers follow the room call state: when host starts a call, all peers enter.
  // When host ends the call or leaves the room, peers exit the call.
  useEffect(() => {
    if (isLocalHost) return;
    setCallWanted(shouldPeerEnterCall({ callActive: remoteCallActive, avAllowed }));
  }, [isLocalHost, remoteCallActive, avAllowed]);

  /*
   * There is deliberately no unmount cleanup ending the call. Sending
   * { active: false } when the host's component unmounts ended the call for the
   * whole room every time the teacher refreshed the page -- a refresh unmounts
   * exactly like leaving does, and the two are indistinguishable from here. The
   * call ends when the host presses end, or when the last socket leaves the
   * room and RoomDO clears it.
   */

  // A hidden tab stops its heartbeat unless somebody in it is on a call.
  useEffect(() => {
    callLiveRef.current = av.status === 'joined';
  }, [av.status]);


  // Losing the right to a call ends any wish for one, so admission does not
  // drop somebody straight back into a call they left before being kicked.
  useEffect(() => {
    if (!avAllowed) setCallWanted(false);
  }, [avAllowed]);

  useEffect(() => { cleanupStaleRooms(); }, []);

  // A 13.75rem roster over a phone screen leaves almost no canvas, so phones start
  // with it collapsed. Set once on mount: after that it is the user's choice.
  useEffect(() => {
    if (shouldCollapsePresenceForViewport(window.innerWidth)) {
      setPresenceCollapsed(true);
    }
  }, []);

  useEffect(() => {
    if (status === 'connected' || status === 'synced' || status === 'connecting') {
      setBoardEverShown(true);
    }
  }, [status]);

  useEffect(() => {
    if (userName || typeof window === 'undefined') return;
    if (wasKicked || wasRejected) return;
    if (isGuestHostname(window.location.hostname)) return;
    let cancelled = false;
    const storedName = window.localStorage.getItem('whiteboard_username');
    void (async () => {
      let accessDisplayName: string | null = null;
      if (!storedName) {
        try {
          const response = await request('/auth/session/current');
          if (response.ok) {
            const session: unknown = await response.json();
            if (cancelled) return;
            const displayName = session && typeof session === 'object'
              ? (session as { displayName?: unknown }).displayName
              : undefined;
            accessDisplayName = typeof displayName === 'string' ? displayName : null;
            setHostPlan(readPlan(session));
            setHostCompany(readCompany(session));
          }
        } catch {
          // Fall through to the join prompt.
        }
      }
      if (cancelled) return;
      const resolved = resolveJoinDisplayName({ storedName, accessDisplayName });
      if (!resolved) return;
      try {
        window.localStorage.setItem('whiteboard_username', resolved);
      } catch {
        // localStorage unavailable
      }
      setUserName(resolved);
      syncUserName(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [request, syncUserName, userName, wasKicked, wasRejected]);

  useEffect(() => {
    if (!shouldClearUsernameOnEviction({ wasKicked, wasRejected, wasSuspended })) return;
    setUserName(null);
  }, [wasKicked, wasRejected, wasSuspended]);

  useEffect(() => {
    if (!isWhiteboardDebugEnabled() || typeof window === 'undefined') return;
    (window as any).__whiteboardStore = store;
    (window as any).__whiteboardCollab = {
      provider,
      status,
      isConnected,
      isSynced,
      localPeerId,
      isWaiting,
      waitingPeers,
      cursors,
      avStatus: av.status,
      avUnavailable: av.unavailableReason,
      avMicMuted: av.local.micMuted,
      avCamOn: av.local.camOn,
    };
    return () => {
      delete (window as any).__whiteboardStore;
      delete (window as any).__whiteboardCollab;
    };
  }, [provider, status, isConnected, isSynced, localPeerId, isWaiting, waitingPeers, cursors, av.status, av.unavailableReason, av.local.micMuted, av.local.camOn]);

  const handleJoin = (name: string) => {
    setUserName(name);
    syncUserName(name);
  };

  /*
   * The room's own controls, for Excalidraw's footer.
   *
   * They used to sit in a bar of their own floating over the middle of the
   * board, which is the one part of it somebody is usually drawing on. The
   * footer is bottom left, beside the zoom, where a hand already goes.
   *
   * The undo here is the room's, not Excalidraw's: it is scoped to `local`
   * origins, so it walks back your own work and never reaches into a peer's.
   * Excalidraw's own pair is hidden in globals.css for that reason -- two
   * undos in one corner, one of which can delete a child's drawing, is not a
   * choice anybody should be asked to make mid-lesson.
   */
  /*
   * Clear sits with Excalidraw's own zoom and undo in the footer, because it
   * is the same kind of control and there is no reason for the board to carry
   * two clusters of them. Excalidraw has no clear of its own -- its canvas
   * action is switched off, because replacing the scene at once fights the
   * shared document instead of travelling through it.
   *
   * Owner, not host. The route refuses anybody who is not the owner, and the
   * first-user fallback makes a stand-in host who is not one -- so gating on
   * host would show this button to a peer and then answer 403 when they
   * pressed it.
   */
  const boardFooter = !isRoomOwner ? null : (
    /*
     * Built out of Excalidraw's own footer parts, not approximations of them.
     *
     * Its zoom and undo clusters are islands: a rounded panel carrying the
     * background and the hairline, with square, borderless buttons flush
     * inside it. Two separately bordered buttons beside that read as belonging
     * to a different application, which is what they were.
     *
     * The classes are Excalidraw's -- `ToolIcon` for the button, an inner
     * `ToolIcon__icon` for the glyph -- rather than the exported `Button`
     * component, because importing from the package here would pull Excalidraw
     * into a chunk that `dynamic()` deliberately keeps it out of.
     */
    <div className="tp-board-footer">
      <button
        type="button"
        data-testid="whiteboard-tool-guide"
        onClick={handleToggleGuide}
        className={`ToolIcon_type_button ToolIcon_size_medium ToolIcon_type_button--show ToolIcon${isGuiding ? ' tp-board-footer__button--active' : ''}`}
        aria-label={isGuiding ? 'Stop guiding' : 'Guide class'}
        title={isGuiding ? 'Stop guiding' : 'Guide class'}
      >
        <div className="ToolIcon__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h18" />
            <path d="M12 3v18" />
            <circle cx="12" cy="12" r="8" />
          </svg>
        </div>
      </button>
      <button
        type="button"
        data-testid="whiteboard-clear-btn"
        onClick={() => setClearModalOpen(true)}
        className="ToolIcon_type_button ToolIcon_size_medium ToolIcon_type_button--show ToolIcon tp-board-footer__button--danger"
        aria-label="Clear board"
        title="Clear board"
      >
        <div className="ToolIcon__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
          </svg>
        </div>
      </button>
    </div>
  );

  /*
   * Takes the new name locally before the server has confirmed it.
   *
   * The bar is what the teacher is looking at while they type, so it has to
   * settle on the words they just entered rather than snap back to the old
   * ones until the next room fetch. A refusal is rare -- the only caller who
   * sees the pencil is the owner, who is the only account allowed to rename --
   * and the next read of the room corrects it if one ever happens.
   */
  /*
   * The board's own actions, handed up by the wrapper once the editor exists.
   * A ref, not state: nothing renders differently for having them, and the
   * menu only reads them when somebody presses an item.
   */
  const boardActionsRef = useRef<BoardActions | null>(null);

  const handleSaveAs = useCallback(() => {
    const scene = boardActionsRef.current?.readScene();
    if (!scene) return;
    const container = buildExcalidrawContainer(scene.elements, scene.files, 'teacher-playground');
    saveBlob(
      new Blob([JSON.stringify(container)], { type: 'application/json' }),
      boardFileName(roomId, roomName, 'excalidraw', Date.now()),
    );
  }, [roomId, roomName]);

  const handleOpenLibrary = useCallback(() => {
    boardActionsRef.current?.openLibrary();
  }, []);

  /*
   * The roster gives up the right edge while Excalidraw's sidebar has it.
   *
   * They both live there, and the sidebar cannot be lifted over the roster:
   * the roster is not inside Excalidraw's stacking context, so no z-index
   * within it reaches. One of the two has to yield, and it is not the one
   * somebody just asked for.
   *
   * Driven by the editor's own state rather than set when the menu is used,
   * because the sidebar can also be closed from its X, pinned, or reopened by
   * Excalidraw -- and folding the roster only at menu time left it coming back
   * over the top of an open library.
   */
  const handleSidebarOpenChange = useCallback((open: boolean) => {
    if (open) setPresenceCollapsed(true);
  }, []);

  const handleRenameRoom = useCallback(
    (next: string) => {
      setRoomName(next);
      void ajaxFetch(`/api/whiteboard/room/${roomId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      }).catch(() => undefined);
    },
    [roomId, setRoomName],
  );

  const handleBackToRooms = useCallback(() => {
    clearSession();
    av.leave();
    if (isLocalHost && yDoc) {
      yDoc.getMap('call').set('active', false);
    }
    if (isWaiting) {
      void leaveWaitingRoom();
    } else if (userName) {
      void leaveRoom();
    }
    router.push('/whiteboard');
  }, [av, clearSession, isLocalHost, isWaiting, leaveRoom, leaveWaitingRoom, router, userName, yDoc]);


  // Calculate this user's position in the waiting queue
  const waitingPosition = isWaiting
    ? waitingPeers.findIndex((p) => p.peerId === localPeerId) + 1
    : 0;
  const displayedWaitingPosition = resolveWaitingPosition(
    waitingPosition,
    waitingPeers.length,
    queueFull,
    wasSuspended,
  );

  // A student knocking is the one event a collapsed roster hides that the
  // teacher has to act on, and the admit button lives inside the panel. Open it
  // for them rather than leaving a badge to be noticed mid-lesson. Only the
  // host can admit, so only the host is interrupted.
  const previousWaitingRef = useRef(0);
  useEffect(() => {
    const previousWaiting = previousWaitingRef.current;
    previousWaitingRef.current = waitingPeers.length;
    if (isLocalHost && shouldExpandForArrival(previousWaiting, waitingPeers.length)) {
      setPresenceCollapsed(false);
    }
  }, [isLocalHost, waitingPeers.length]);

  if (!userName) {
    if (!guestHostReady) {
      return <LoadingScreen />;
    }
    const evictionNotice = evictionNoticeCopy({ wasKicked, wasRejected, wasSuspended });
    /*
     * Rendered after the prompt and at the same documented z-index: the prompt
     * overlay is z-[1600] and full-screen, and a sibling that follows it in
     * the DOM paints above it without reaching past the design system's
     * ceiling. Announced, because a student returned to the name field has no
     * other way to learn why they are there.
     */
    const evictionBanner = evictionNotice ? (
      <p
        role="status"
        data-testid="whiteboard-eviction-notice"
        className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[1600] -translate-x-1/2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[0.8125rem] font-medium text-amber-900 shadow-lg"
      >
        {evictionNotice}
      </p>
    ) : null;
    if (guestHost) {
      return (
        <>
          <RoomTopNav
            displayName={userName}
            onDisplayNameChange={handleJoin}
            onNavigate={handleBackToRooms}
            rosterExpanded={false}
            plan={hostPlan}
            company={hostCompany}
          />
          <GuestJoinPrompt
            roomId={roomId}
            onJoined={(name) => {
              handleJoin(name);
              void reloadPresence();
            }}
          />
          {evictionBanner}
        </>
      );
    }
    return (
      <>
        <RoomTopNav
          displayName={userName}
          onDisplayNameChange={handleJoin}
          onNavigate={handleBackToRooms}
          rosterExpanded={false}
          plan={hostPlan}
          company={hostCompany}
        />
        {/*
          * The prompt names no room id: a thirty-two character hexadecimal
          * string is noise to a child and names a room only in a form no UI
          * accepts. The room is already implicit in the URL they arrived on.
          */}
        <UserNamePrompt onJoin={handleJoin} />
        {evictionBanner}
      </>
    );
  }

  if (isWaiting) {
    return (
      <>
        <RoomTopNav
          displayName={userName}
          onDisplayNameChange={handleJoin}
          onNavigate={handleBackToRooms}
          rosterExpanded={false}
          plan={hostPlan}
          company={hostCompany}
        />
        <WaitingRoom
          userName={userName}
          waitingPosition={displayedWaitingPosition}
          queueFull={queueFull}
          suspended={wasSuspended}
          onWait={reloadPresence}
          onLeave={() => {
            clearSession();
            leaveWaitingRoom();
            setUserName(null);
          }}
        />
      </>
    );
  }

  // Only before the board has ever appeared. Replacing a working board with a
  // loading screen the moment the link drops throws away a canvas the user can
  // still draw on, unmounts the collaboration listeners, and means a
  // reconnecting peer has nowhere to apply the state it catches up on.
  if (!boardEverShown && status !== 'synced' && status !== 'connected' && status !== 'connecting') {
    return (
      <>
        <RoomTopNav
          displayName={userName}
          onDisplayNameChange={handleJoin}
          onNavigate={handleBackToRooms}
          rosterExpanded={false}
          plan={hostPlan}
          company={hostCompany}
        />
        <LoadingScreen error={error} />
      </>
    );
  }

  return (
    <div className="room-shell">
      <RoomTopNav
        displayName={userName}
        onDisplayNameChange={handleJoin}
        onNavigate={handleBackToRooms}
        rosterExpanded={!presenceCollapsed}
        plan={hostPlan}
        company={hostCompany}
        people={
          <PeopleButton
            users={users}
            waitingCount={waitingPeers.length}
            capacity={maxUsers}
            expanded={!presenceCollapsed}
            onToggle={() => setPresenceCollapsed((collapsed) => !collapsed)}
            anyHandRaised={users.some((user) => user.handRaised)}
          />
        }
        center={
          <div className="flex items-center gap-2 min-w-0">
            <RoomTitleMenu
              name={roomName}
              roomId={roomId}
              canManage={isRoomOwner}
              onRename={handleRenameRoom}
              onSaveAs={handleSaveAs}
              onOpenLibrary={handleOpenLibrary}
            />
            {shouldShowStartCall({
              isHost: isLocalHost,
              avAllowed,
              avEnabled,
              callActive: remoteCallActive,
            }) && (
              <StartCallButton
                onStart={handleStartCall}
                label={remoteCallActive ? 'Rejoin call' : 'Start call'}
              />
            )}
          </div>
        }
      />
      <div className={`${ROOM_CANVAS_CLASS} ${roomCanvasTopClass(guestHost)} ${roomCanvasRightClass(callRailVisible)}`} style={roomCanvasRailStyle(callRailVisible)} data-testid="whiteboard-canvas-area">
        <ExcalidrawWrapper
          roomId={roomId}
          userName={userName}
          localPeerId={localPeerId}
          yDoc={yDoc}
          yElementsArray={yElementsArray}
          users={users}
          cursors={cursors}
          activeTool={activeTool}
          isLocalHost={isLocalHost}
          onToolChange={handleToolChange}
          initialViewport={viewport}
          onViewportChange={storeViewport}
          onCursorMove={setCursor}
          onElementsChange={setElements}
          hostPeerId={hostPeerId}
          guideMessage={guideMessage}
          isGuiding={isGuiding}
          onGuideViewport={handleGuideViewport}
          footer={boardFooter}
          onBoardActions={(actions) => { boardActionsRef.current = actions; }}
          onSidebarOpenChange={handleSidebarOpenChange}
        />
      </div>
      {connectionLost && <ConnectionLostNotice />}
      {shouldShowSyncDegradedNotice({ syncDegraded, connectionLost }) && <SyncDegradedNotice />}
      <SupportButton {...supportButtonProps({ presenceCollapsed, callRailVisible })} />
      <RaisedHandCue users={users} localPeerId={localPeerId} isLocalHost={isLocalHost} />
      <PresencePanel
        users={users}
        waitingPeers={waitingPeers}
        localPeerId={localPeerId}
        isLocalHost={isLocalHost}
        collapsed={presenceCollapsed}
        callRailOpen={callRailVisible}
        showCollapsedHandle={guestHost}
        onToggle={() => setPresenceCollapsed((collapsed) => !collapsed)}
        onApprove={approvePeer}
        onReject={rejectPeer}
        onKick={kickPeer}
        onSuspend={sendToWaitingRoom}
        onRaiseHand={setHandRaised}
        maxUsers={maxUsers}
        avPeerStates={avPeerStates}
        onMutePeer={(peerId, kind) => {
          const targetIdentity = resolveAvTargetAccountId(users, localPeerId, peerId);
          if (!targetIdentity) return;
          void av.requestMute(targetIdentity, kind);
        }}
        speakingPeerIds={mapAvPeerIds(av.participants, users, localPeerId, (participant) => participant.isSpeaking)}
      />
      {moderationError && (
        <div
          role="alert"
          data-testid="whiteboard-moderation-error"
          className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[400] -translate-x-1/2 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-[0.8125rem] font-medium text-red-700 shadow-lg"
        >
          {moderationError}
        </div>
      )}
      {avAllowed && avEnabled && (
        <AvSessionPanel
          av={av}
          localIdentity={localPeerId}
          users={users}
          onOpenChange={setCallRailOpen}
          onLeaveCall={handleLeaveCall}
          onEndCallForEveryone={isLocalHost ? handleEndCallForEveryone : undefined}
        />
      )}
      {callEndedNotice && (
        <div
          role="status"
          data-testid="whiteboard-call-ended"
          className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[1400] -translate-x-1/2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[0.8125rem] font-medium text-amber-900 shadow-lg"
        >
          The teacher ended the call.
        </div>
      )}
      {shouldOverlayConnectingScreen({ boardEverShown, isSynced }) && <LoadingScreen />}
      {/* Stacked above the mobile tool bar; centred on its own row from sm: up. */}
      <ClearBoardModal
        isOpen={clearModalOpen}
        onConfirm={() => {
          setClearModalOpen(false);
          /*
           * Ask the room to empty itself; do not empty it from here.
           *
           * This used to write the empty array into the shared document
           * directly, so the deletion travelled as an ordinary edit and the
           * server never had a say -- anybody with a socket could wipe a
           * lesson. The route is owner-only, and the deletion comes back over
           * this peer's own socket like everybody else's.
           */
          void ajaxFetch(`/api/whiteboard/room/${roomId}/clear`, { method: 'POST' })
            .then((response) => {
              if (!response.ok) return;
              /*
               * The document is emptied by the server and the deletion arrives
               * over this peer's socket, but the local caches beside it are
               * not on that path: the legacy store, the React copy and the
               * saved snapshot each hold their own elements. They were reset
               * here before the route existed, and still have to be -- the
               * difference is only that it now happens once the clear has been
               * allowed rather than instead of asking.
               */
              setElements([]);
              store.setElements([]);
              store.deselectAll();
              clearState();
            })
            .catch(() => undefined);
        }}
        onCancel={() => setClearModalOpen(false)}
      />
    </div>
  );
}

/**
 * The static export emits a single placeholder page for this route, which the
 * Worker serves for every /whiteboard/<roomId> URL. The real room therefore
 * comes from the address bar rather than from route params.
 */
function useRoomIdFromPath(): string | null {
  const [roomId, setRoomId] = useState<string | null>(null);

  useEffect(() => {
    setRoomId(roomIdFromWhiteboardPath(window.location.pathname));
  }, []);

  return roomId;
}

/** Stable identity: an inline arrow would be a new prop on every render. */

export default function WhiteboardRoomPage() {
  const roomId = useRoomIdFromPath();

  if (!roomId) return <LoadingScreen />;

  return (
    <Suspense fallback={<LoadingScreen />}>
      <RoomContent roomId={roomId} />
    </Suspense>
  );
}
