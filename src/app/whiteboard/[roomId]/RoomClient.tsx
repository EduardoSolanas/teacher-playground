'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useCollaboration } from '@/hooks/useCollaboration';
import { usePersistence } from '@/hooks/usePersistence';
import { useClearSessionOnEviction } from '@/hooks/useClearSessionOnEviction';
import { useAvSession } from '@/hooks/useAvSession';
import UserNamePrompt from '@/components/whiteboard/UserNamePrompt';
import LoadingScreen from '@/components/whiteboard/LoadingScreen';
import WaitingRoom from '@/components/whiteboard/WaitingRoom';
import PresencePanel from '@/components/whiteboard/PresencePanel';
import { shouldCollapsePresenceForViewport } from '@/lib/whiteboard/presenceViewport';
import { shouldOverlayConnectingScreen } from '@/lib/whiteboard/connectingOverlay';
import RemoteCursorOverlay from '@/components/whiteboard/RemoteCursorOverlay';
import EmptyState from '@/components/whiteboard/EmptyState';
import ClearBoardModal from '@/components/whiteboard/ClearBoardModal';
import ToolSidebar from '@/components/whiteboard/ToolSidebar';
import BackToRoomsLink from '@/components/whiteboard/BackToRoomsLink';
import { LibraryPanel } from '@/components/whiteboard/LibraryPanel';
import { ShortcutsHelp } from '@/components/whiteboard/ShortcutsHelp';
import { UndoRedoBar } from '@/components/whiteboard/UndoRedoBar';
import AvSessionPanel from '@/components/av/AvSessionPanel';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import * as store from '@/lib/whiteboard/store';
import { cleanupStaleRooms } from '@/lib/whiteboard/persistence';
import { isWhiteboardDebugEnabled } from '@/lib/whiteboard/ywebrtcProvider';
import { roomIdFromWhiteboardPath } from '@/lib/whiteboard/roomPath';
import { shouldClearUsernameOnEviction } from '@/lib/whiteboard/evictionUi';
import { replaceSharedElements } from '@/lib/whiteboard/yjsDoc';

const ExcalidrawWrapper = dynamic(
  () => import('@/components/whiteboard/ExcalidrawWrapper'),
  {
    ssr: false,
    loading: () => <div className="w-full h-full min-h-[400px]" />,
  },
);

function RoomContent({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [userName, setUserName] = useState<string | null>(null);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  // The store is the single source of truth for the active tool: keyboard
  // shortcuts write to it directly, so deriving from it keeps the sidebar
  // highlight and Excalidraw's own tool in step with them.
  const [activeTool, setActiveTool] = useState(() => store.getState().tool);

  useEffect(
    () => store.subscribe(() => setActiveTool(store.getState().tool)),
    [],
  );

  const handleToolChange = useCallback((tool: string) => {
    store.setTool(tool as Parameters<typeof store.setTool>[0]);
  }, []);
  const [boardEverShown, setBoardEverShown] = useState(false);
  const [presenceCollapsed, setPresenceCollapsed] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const { activeShortcuts, showShortcutsHelp, setShowShortcutsHelp } = useKeyboardShortcuts();

  const {
    isConnected,
    isSynced,
    users,
    cursors,
    error,
    status,
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
    moderationError,
    reloadPresence,
    setCursor,
    setUserName: syncUserName,
    yDoc,
    yElementsArray,
    yCursorsMap,
    setElements,
  } = useCollaboration(roomId);

  const { clearState, clearSession } = usePersistence(roomId, elements, { x: 0, y: 0, zoom: 1 } as any);

  useClearSessionOnEviction(clearSession, { wasKicked, wasRejected, wasSuspended });

  // Voice only after admission. Waiting / kicked peers never fetch a token.
  const avEnabled = Boolean(userName) && !isWaiting && !wasKicked;
  const av = useAvSession({
    roomId,
    identity: localPeerId,
    displayName: userName ?? 'Anonymous',
    enabled: avEnabled,
  });

  useEffect(() => { cleanupStaleRooms(); }, []);

  // A 220px roster over a phone screen leaves almost no canvas, so phones start
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
    const storedName = window.localStorage.getItem('whiteboard_username');
    if (!storedName) return;
    setUserName(storedName);
    syncUserName(storedName);
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

  const handleLeaveRoom = useCallback(() => {
    clearSession();
    av.leave();
    leaveRoom();
    setUserName(null);
  }, [av, clearSession, leaveRoom]);

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
  const localUser = users.find((user) => user.peerId === localPeerId);
  // Host status comes only from the recorded host. A first-in-list fallback
  // would let whoever happens to be listed first silently become host.
  const isLocalHost = Boolean(isHost || localUser?.isHost);

  if (!userName) {
    return (
      <>
        <BackToRoomsLink onNavigate={handleBackToRooms} />
        <UserNamePrompt onJoin={handleJoin} roomId={roomId} />
      </>
    );
  }

  if (isWaiting) {
    return (
      <>
        <BackToRoomsLink onNavigate={handleBackToRooms} />
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
        <BackToRoomsLink onNavigate={handleBackToRooms} />
        <LoadingScreen error={error} />
      </>
    );
  }

  return (
    <div
      className="w-screen h-screen overflow-hidden relative bg-slate-50"
      onPointerMove={(event) => setCursor(event.clientX, event.clientY)}
    >
      <BackToRoomsLink onNavigate={handleBackToRooms} />
      <ToolSidebar
        activeTool={activeTool}
        onToolChange={handleToolChange}
        onOpenLibrary={() => setLibraryOpen(true)}
        onOpenHelp={() => setShowShortcutsHelp(true)}
        showHostTools={isLocalHost}
      />
      <div className="absolute inset-0 overflow-hidden bg-slate-50 sm:inset-auto sm:left-14 sm:top-12 sm:h-[calc(100vh-48px)] sm:w-[calc(100vw-276px)] sm:rounded-tl-2xl" data-testid="whiteboard-canvas-area">
        <ExcalidrawWrapper
          roomId={roomId}
          userName={userName}
          localPeerId={localPeerId}
          yDoc={yDoc}
          yElementsArray={yElementsArray}
          yCursorsMap={yCursorsMap}
          users={users}
          activeTool={activeTool}
          isLocalHost={isLocalHost}
          onToolChange={handleToolChange}
          onViewportChange={() => {}}
          onElementsChange={setElements}
        />
        {elements.length === 0 && activeTool === 'select' && <EmptyState />}
      </div>
      <RemoteCursorOverlay cursors={cursors} users={users} />
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
        mutedPeerIds={new Set(
          av.participants.filter((p) => p.micMuted).map((p) => (p.identity === '__local__' ? localPeerId : p.identity)),
        )}
      />
      {moderationError && (
        <div
          role="alert"
          data-testid="whiteboard-moderation-error"
          className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[400] -translate-x-1/2 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700 shadow-lg"
        >
          {moderationError}
        </div>
      )}
      {avEnabled && (
        <AvSessionPanel av={av} localIdentity={localPeerId} isLocalHost={isLocalHost} />
      )}
      {shouldOverlayConnectingScreen({ boardEverShown, isSynced }) && <LoadingScreen />}
      <LibraryPanel visible={isLocalHost && libraryOpen} onClose={() => setLibraryOpen(false)} />
      <ShortcutsHelp
        visible={isLocalHost && showShortcutsHelp}
        shortcuts={activeShortcuts}
        onClose={() => setShowShortcutsHelp(false)}
      />
      {/* Stacked above the mobile tool bar; centred on its own row from sm: up. */}
      <div className="fixed bottom-[calc(max(0.5rem,env(safe-area-inset-bottom))+4rem)] left-1/2 -translate-x-1/2 flex items-center gap-2 z-[200] rounded-xl border border-slate-700/80 bg-slate-900 p-1 shadow-xl shadow-slate-900/20 sm:bottom-4" data-testid="whiteboard-bottom-controls">
        <UndoRedoBar canUndo={store.canUndo()} canRedo={store.canRedo()} onUndo={() => store.undo()} onRedo={() => store.redo()} />
        <button
          data-testid="whiteboard-clear-btn"
          onClick={() => setClearModalOpen(true)}
          className="flex h-9 cursor-pointer items-center justify-center rounded-lg border border-slate-700 px-3 text-[13px] font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-700 hover:text-red-400 sm:h-7 sm:px-2 sm:text-[11px]"
          title="Clear board"
        >
          Clear
        </button>
        <button
          data-testid="whiteboard-leave-room-btn"
          onClick={handleLeaveRoom}
          className="flex h-9 cursor-pointer items-center justify-center rounded-lg border border-slate-700 px-3 text-[13px] font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-700 hover:text-slate-100 sm:h-7 sm:px-2 sm:text-[11px]"
          title="Leave room"
        >
          Leave
        </button>
      </div>
      <ClearBoardModal
        isOpen={clearModalOpen}
        onConfirm={() => {
          setClearModalOpen(false);
          // The Yjs array is the shared source of truth: emptying only the
          // local store left the drawing on every other peer's board.
          if (yDoc && yElementsArray) {
            replaceSharedElements(yDoc, yElementsArray, [], 'board-clear');
          }
          setElements([]);
          store.setElements([]);
          store.deselectAll();
          clearState();
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

export default function WhiteboardRoomPage() {
  const roomId = useRoomIdFromPath();

  if (!roomId) return <LoadingScreen />;

  return (
    <Suspense fallback={<LoadingScreen />}>
      <RoomContent roomId={roomId} />
    </Suspense>
  );
}
