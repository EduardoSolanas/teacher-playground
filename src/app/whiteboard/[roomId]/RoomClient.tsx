'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useCollaboration } from '@/hooks/useCollaboration';
import { usePersistence } from '@/hooks/usePersistence';
import { useAvSession } from '@/hooks/useAvSession';
import UserNamePrompt from '@/components/whiteboard/UserNamePrompt';
import LoadingScreen from '@/components/whiteboard/LoadingScreen';
import WaitingRoom from '@/components/whiteboard/WaitingRoom';
import PresencePanel from '@/components/whiteboard/PresencePanel';
import RemoteCursorOverlay from '@/components/whiteboard/RemoteCursorOverlay';
import EmptyState from '@/components/whiteboard/EmptyState';
import ClearBoardModal from '@/components/whiteboard/ClearBoardModal';
import ToolSidebar from '@/components/whiteboard/ToolSidebar';
import { LibraryPanel } from '@/components/whiteboard/LibraryPanel';
import { ShortcutsHelp } from '@/components/whiteboard/ShortcutsHelp';
import { UndoRedoBar } from '@/components/whiteboard/UndoRedoBar';
import AvSessionPanel from '@/components/av/AvSessionPanel';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import * as store from '@/lib/whiteboard/store';
import { cleanupStaleRooms } from '@/lib/whiteboard/persistence';

const ExcalidrawWrapper = dynamic(
  () => import('@/components/whiteboard/ExcalidrawWrapper'),
  {
    ssr: false,
    loading: () => <div className="w-full h-full min-h-[400px]" />,
  },
);

function RoomContent({ roomId }: { roomId: string }) {
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
    approvePeer,
    rejectPeer,
    leaveWaitingRoom,
    kickPeer,
    sendToWaitingRoom,
    reloadPresence,
    setCursor,
    setUserName: syncUserName,
    yDoc,
    yElementsArray,
    yCursorsMap,
    setElements,
  } = useCollaboration(roomId);

  const { clearState } = usePersistence(roomId, elements, { x: 0, y: 0, zoom: 1 } as any);

  // Voice only after admission. Waiting / kicked peers never fetch a token.
  const avEnabled = Boolean(userName) && !isWaiting && !wasKicked;
  const av = useAvSession({
    roomId,
    identity: localPeerId,
    displayName: userName ?? 'Anonymous',
    enabled: avEnabled,
  });

  useEffect(() => { cleanupStaleRooms(); }, []);

  useEffect(() => {
    if (status === 'connected' || status === 'synced') setBoardEverShown(true);
  }, [status]);

  useEffect(() => {
    if (userName || typeof window === 'undefined') return;
    const storedName = window.localStorage.getItem('whiteboard_username');
    if (!storedName) return;
    setUserName(storedName);
    syncUserName(storedName);
  }, [syncUserName, userName]);

  useEffect(() => {
    if (!wasKicked || typeof window === 'undefined') return;
    window.localStorage.removeItem('whiteboard_username');
    setUserName(null);
  }, [wasKicked]);

  useEffect(() => {
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

  // Calculate this user's position in the waiting queue
  const waitingPosition = isWaiting
    ? waitingPeers.findIndex((p) => p.peerId === localPeerId) + 1
    : 0;
  const localUser = users.find((user) => user.peerId === localPeerId);
  const isLocalHost = Boolean(isHost || localUser?.isHost || users[0]?.peerId === localPeerId);

  if (!userName) return <UserNamePrompt onJoin={handleJoin} roomId={roomId} />;

  if (isWaiting) {
    return (
      <WaitingRoom
        userName={userName}
        roomCode={roomId}
        waitingPosition={waitingPosition || waitingPeers.length + 1}
        onWait={reloadPresence}
        onLeave={leaveWaitingRoom}
      />
    );
  }

  // Only before the board has ever appeared. Replacing a working board with a
  // loading screen the moment the link drops throws away a canvas the user can
  // still draw on, unmounts the collaboration listeners, and means a
  // reconnecting peer has nowhere to apply the state it catches up on.
  if (!boardEverShown && status !== 'synced' && status !== 'connected' && status !== 'connecting') {
    return <LoadingScreen error={error} />;
  }

  return (
    <div
      className="w-screen h-screen overflow-hidden relative bg-slate-50"
      onPointerMove={(event) => setCursor(event.clientX, event.clientY)}
    >
      <ToolSidebar
        activeTool={activeTool}
        onToolChange={handleToolChange}
        onOpenLibrary={() => setLibraryOpen(true)}
        onOpenHelp={() => setShowShortcutsHelp(true)}
        showHostTools={isLocalHost}
      />
      <div className="absolute left-14 top-12 overflow-hidden rounded-tl-2xl bg-slate-50" data-testid="whiteboard-canvas-area" style={{ width: 'calc(100vw - 276px)', height: 'calc(100vh - 48px)' }}>
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
      <RemoteCursorOverlay cursors={cursors} />
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
      {avEnabled && (
        <AvSessionPanel av={av} localIdentity={localPeerId} isLocalHost={isLocalHost} />
      )}
      {!isSynced && <LoadingScreen />}
      <LibraryPanel visible={isLocalHost && libraryOpen} onClose={() => setLibraryOpen(false)} />
      <ShortcutsHelp
        visible={isLocalHost && showShortcutsHelp}
        shortcuts={activeShortcuts}
        onClose={() => setShowShortcutsHelp(false)}
      />
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 z-[200] rounded-xl border border-slate-700/80 bg-slate-900 p-1 shadow-xl shadow-slate-900/20" data-testid="whiteboard-bottom-controls">
        <UndoRedoBar canUndo={store.canUndo()} canRedo={store.canRedo()} onUndo={() => store.undo()} onRedo={() => store.redo()} />
        <button
          data-testid="whiteboard-clear-btn"
          onClick={() => setClearModalOpen(true)}
          className="flex h-7 cursor-pointer items-center justify-center rounded-lg border border-slate-700 px-2 text-[11px] font-medium text-slate-300 transition-colors duration-150 hover:bg-slate-700 hover:text-red-400"
          title="Clear board"
        >
          Clear
        </button>
      </div>
      <ClearBoardModal
        isOpen={clearModalOpen}
        onConfirm={() => {
          setClearModalOpen(false);
          // The Yjs array is the shared source of truth: emptying only the
          // local store left the drawing on every other peer's board.
          if (yDoc && yElementsArray) {
            yDoc.transact(() => {
              yElementsArray.delete(0, yElementsArray.length);
            });
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
    const segments = window.location.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    setRoomId(last ? decodeURIComponent(last) : null);
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
