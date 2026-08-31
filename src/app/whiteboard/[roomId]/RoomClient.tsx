'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
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
import ToolSidebar from '@/components/whiteboard/ToolSidebar';
import RoomTopNav from '@/components/whiteboard/RoomTopNav';
import { LibraryPanel } from '@/components/whiteboard/LibraryPanel';
import { ShortcutsHelp } from '@/components/whiteboard/ShortcutsHelp';
import { UndoRedoBar } from '@/components/whiteboard/UndoRedoBar';
import AvSessionPanel from '@/components/av/AvSessionPanel';
import StartCallButton from '@/components/av/StartCallButton';
import ConnectionLostNotice from '@/components/whiteboard/ConnectionLostNotice';
import RoomNameField from '@/components/whiteboard/RoomNameField';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useScopedUndo } from '@/hooks/useScopedUndo';
import * as store from '@/lib/whiteboard/store';
import { cleanupStaleRooms } from '@/lib/whiteboard/persistence';
import { isWhiteboardDebugEnabled } from '@/lib/whiteboard/ywebrtcProvider';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { resolveJoinDisplayName } from '@/lib/access/accessDisplayName';
import { roomIdFromWhiteboardPath } from '@/lib/whiteboard/roomPath';
import { shouldClearUsernameOnEviction } from '@/lib/whiteboard/evictionUi';

const ExcalidrawWrapper = dynamic(
  () => import('@/components/whiteboard/ExcalidrawWrapper'),
  {
    ssr: false,
    loading: () => <div className="w-full h-full min-h-[25rem]" />,
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
  'absolute inset-x-0 bottom-0 overflow-hidden bg-slate-50';

export function roomCanvasTopClass(guestHost: boolean): string {
  return guestHost ? 'top-0 sm:top-12' : 'top-[calc(3rem+env(safe-area-inset-top))] sm:top-12';
}

function RoomContent({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);
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
  const [presenceCollapsed, setPresenceCollapsed] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [isGuiding, setIsGuiding] = useState(false);
  const {
    isConnected,
    isSynced,
    users,
    cursors,
    error,
    status,
    connectionLost,
    roomName,
    setRoomName,
    maxUsers,
    elements,
    localPeerId,
    isHost,
    provider,
    waitingPeers,
    isWaiting,
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
    sendFollowMessage,
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

  const scopedUndo = useScopedUndo(yElementsArray);
  /*
   * The shortcuts are gated with the buttons, not left behind them.
   *
   * Hiding a control and leaving its accelerator live is a gate that only
   * looks like one: Ctrl+Z would still walk the board back for anybody who
   * knew to press it, and nothing on screen would explain why.
   */
  const noHostAction = useCallback(() => undefined, []);
  const { activeShortcuts, showShortcutsHelp, setShowShortcutsHelp } = useKeyboardShortcuts({
    undo: isLocalHost ? scopedUndo.undo : noHostAction,
    redo: isLocalHost ? scopedUndo.redo : noHostAction,
  });

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
          const response = await ajaxFetch('/auth/session/current');
          if (response.ok) {
            const session: unknown = await response.json();
            const displayName = session && typeof session === 'object'
              ? (session as { displayName?: unknown }).displayName
              : undefined;
            accessDisplayName = typeof displayName === 'string' ? displayName : null;
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
  }, [syncUserName, userName, wasKicked, wasRejected]);

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
  const boardFooter = !isLocalHost ? null : (
    <div className="flex items-center gap-1">
      <UndoRedoBar
        canUndo={scopedUndo.canUndo}
        canRedo={scopedUndo.canRedo}
        onUndo={scopedUndo.undo}
        onRedo={scopedUndo.redo}
      />
      <button
        data-testid="whiteboard-clear-btn"
        onClick={() => setClearModalOpen(true)}
        className="flex h-9 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-[0.8125rem] font-medium text-slate-600 transition-colors duration-150 hover:border-red-300 hover:text-red-500 sm:h-9 sm:px-2 sm:text-[0.6875rem]"
        title="Clear board"
      >
        Clear
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
    if (isWaiting) {
      void leaveWaitingRoom();
    } else if (userName) {
      void leaveRoom();
    }
    router.push('/whiteboard');
  }, [av, clearSession, isWaiting, leaveRoom, leaveWaitingRoom, router, userName]);

  // Calculate this user's position in the waiting queue
  const waitingPosition = isWaiting
    ? waitingPeers.findIndex((p) => p.peerId === localPeerId) + 1
    : 0;

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
    if (guestHost) {
      return (
        <>
          <RoomTopNav
            displayName={userName}
            onDisplayNameChange={handleJoin}
            onNavigate={handleBackToRooms}
            rosterExpanded={false}
          />
          <GuestJoinPrompt
            roomId={roomId}
            onJoined={(name) => {
              handleJoin(name);
              void reloadPresence();
            }}
          />
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
        />
        <UserNamePrompt onJoin={handleJoin} roomId={roomId} />
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
        />
        <WaitingRoom
          userName={userName}
          roomCode={roomId}
          waitingPosition={waitingPosition || waitingPeers.length + 1}
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
        center={
          <RoomNameField
            name={roomName}
            canRename={isLocalHost}
            onRename={handleRenameRoom}
          />
        }
      />
      <ToolSidebar
        activeTool={activeTool}
        onToolChange={handleToolChange}
        onOpenLibrary={() => setLibraryOpen(true)}
        onOpenHelp={() => setShowShortcutsHelp(true)}
        showHostTools={isLocalHost}
        isGuiding={isGuiding}
        onToggleGuide={handleToggleGuide}
      />
      <div className={`${ROOM_CANVAS_CLASS} ${roomCanvasTopClass(guestHost)}`} data-testid="whiteboard-canvas-area">
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
        />
      </div>
      {connectionLost && <ConnectionLostNotice />}
      <RaisedHandCue users={users} localPeerId={localPeerId} isLocalHost={isLocalHost} />
      <PresencePanel
        users={users}
        waitingPeers={waitingPeers}
        localPeerId={localPeerId}
        isLocalHost={isLocalHost}
        collapsed={presenceCollapsed}
        onToggle={() => setPresenceCollapsed((collapsed) => !collapsed)}
        onApprove={approvePeer}
        onReject={rejectPeer}
        onKick={kickPeer}
        onSuspend={sendToWaitingRoom}
        onRaiseHand={setHandRaised}
        maxUsers={maxUsers}
        mutedPeerIds={new Set(
          av.participants.filter((p) => p.micMuted).map((p) => (p.identity === '__local__' ? localPeerId : p.identity)),
        )}
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
      {avAllowed && (avEnabled ? (
        <AvSessionPanel
          av={av}
          localIdentity={localPeerId}
          isLocalHost={isLocalHost}
          onEndCall={() => setCallWanted(false)}
        />
      ) : (
        <StartCallButton onStart={() => setCallWanted(true)} />
      ))}
      {shouldOverlayConnectingScreen({ boardEverShown, isSynced }) && <LoadingScreen />}
      <LibraryPanel visible={isLocalHost && libraryOpen} onClose={() => setLibraryOpen(false)} />
      <ShortcutsHelp
        visible={isLocalHost && showShortcutsHelp}
        shortcuts={activeShortcuts}
        onClose={() => setShowShortcutsHelp(false)}
      />
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
