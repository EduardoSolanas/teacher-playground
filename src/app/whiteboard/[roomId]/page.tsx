'use client';

import { useState, useEffect, Suspense } from 'react';
import { useParams } from 'next/navigation';
import { useCollaboration } from '@/hooks/useCollaboration';
import { usePersistence } from '@/hooks/usePersistence';
import UserNamePrompt from '@/components/whiteboard/UserNamePrompt';
import LoadingScreen from '@/components/whiteboard/LoadingScreen';
import PresencePanel from '@/components/whiteboard/PresencePanel';
import EmptyState from '@/components/whiteboard/EmptyState';
import ClearBoardModal from '@/components/whiteboard/ClearBoardModal';
import ToolSidebar from '@/components/whiteboard/ToolSidebar';
import { UndoRedoBar } from '@/components/whiteboard/UndoRedoBar';
import ExcalidrawWrapper from '@/components/whiteboard/ExcalidrawWrapper';
import * as store from '@/lib/whiteboard/store';
import { cleanupStaleRooms } from '@/lib/whiteboard/persistence';

function RoomContent() {
  const params = useParams();
  const roomId = params?.roomId as string;

  const [userName, setUserName] = useState<string | null>(null);
  const [clearModalOpen, setClearModalOpen] = useState(false);

  const {
    isConnected,
    isSynced,
    users,
    error,
    status,
    maxUsers,
    elements,
    localPeerId,
    provider,
    waitingPeers,
    approvePeer,
    rejectPeer,
    setUserName: syncUserName,
  } = useCollaboration(roomId);

  const { clearState } = usePersistence(roomId, elements, { x: 0, y: 0, zoom: 1 } as any);

  useEffect(() => { cleanupStaleRooms(); }, []);

  useEffect(() => {
    (window as any).__whiteboardStore = store;
    (window as any).__whiteboardCollab = { provider, status, isConnected, isSynced, localPeerId };
    return () => {
      delete (window as any).__whiteboardStore;
      delete (window as any).__whiteboardCollab;
    };
  }, [provider, status, isConnected, isSynced, localPeerId]);

  const handleJoin = (name: string) => {
    setUserName(name);
    syncUserName(name);
  };

  if (!userName) return <UserNamePrompt onJoin={handleJoin} roomId={roomId} />;

  if (status !== 'synced' && status !== 'connected' && status !== 'connecting') {
    return <LoadingScreen error={error} />;
  }

  return (
    <div className="w-screen h-screen overflow-hidden relative bg-slate-50">
      <ToolSidebar />
      <div className="absolute left-14 top-12 overflow-hidden rounded-tl-2xl bg-slate-50" data-testid="whiteboard-canvas-area" style={{ width: 'calc(100vw - 276px)', height: 'calc(100vh - 48px)' }}>
        <ExcalidrawWrapper key={roomId} elements={elements} viewport={{ x: 0, y: 0, zoom: 1 }} onElementsChange={() => {}} onViewportChange={() => {}} userName={userName} />
        {elements.length === 0 && <EmptyState />}
      </div>
      <PresencePanel users={users} waitingPeers={waitingPeers} localPeerId={localPeerId} collapsed={false} onToggle={() => {}} onApprove={approvePeer} onReject={rejectPeer} />
      {!isSynced && <LoadingScreen />}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 z-[200] rounded-xl border border-slate-700/80 bg-slate-900 p-1 shadow-xl shadow-slate-900/20" data-testid="whiteboard-bottom-controls">
        <UndoRedoBar canUndo={store.canUndo()} canRedo={store.canRedo()} onUndo={() => store.undo()} onRedo={() => store.redo()} />
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