'use client';

import { useState, useEffect, Suspense } from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useCollaboration } from '@/hooks/useCollaboration';
import { usePersistence } from '@/hooks/usePersistence';
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

function RoomContent() {
  const params = useParams();
  const roomId = params?.roomId as string;

  const [userName, setUserName] = useState<string | null>(null);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [activeTool, setActiveTool] = useState('select');
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

  useEffect(() => { cleanupStaleRooms(); }, []);

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
    (window as any).__whiteboardCollab = { provider, status, isConnected, isSynced, localPeerId, isWaiting, waitingPeers, cursors };
    return () => {
      delete (window as any).__whiteboardStore;
      delete (window as any).__whiteboardCollab;
    };
  }, [provider, status, isConnected, isSynced, localPeerId, isWaiting, waitingPeers, cursors]);

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

  if (status !== 'synced' && status !== 'connected' && status !== 'connecting') {
    return <LoadingScreen error={error} />;
  }

  return (
    <div
      className="w-screen h-screen overflow-hidden relative bg-slate-50"
      onPointerMove={(event) => setCursor(event.clientX, event.clientY)}
    >
      <ToolSidebar
        activeTool={activeTool}
        onToolChange={setActiveTool}
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
          onToolChange={setActiveTool}
          onViewportChange={() => {}}
          onElementsChange={setElements}
        />
        {elements.length === 0 && activeTool === 'select' && <EmptyState />}
      </div>
      <RemoteCursorOverlay cursors={cursors} />
      <PresencePanel users={users} waitingPeers={waitingPeers} localPeerId={localPeerId} isLocalHost={isLocalHost} collapsed={presenceCollapsed} onToggle={() => setPresenceCollapsed((collapsed) => !collapsed)} onApprove={approvePeer} onReject={rejectPeer} onKick={kickPeer} onSuspend={sendToWaitingRoom} />
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
      <ClearBoardModal isOpen={clearModalOpen} onConfirm={() => { setClearModalOpen(false); store.setElements([]); store.deselectAll(); clearState(); }} onCancel={() => setClearModalOpen(false)} />
    </div>
  );
}

export default function WhiteboardRoomPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <RoomContent />
    </Suspense>
  );
}
