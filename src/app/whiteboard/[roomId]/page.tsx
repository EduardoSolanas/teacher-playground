'use client';

import { useState, useEffect, Suspense, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useCollaboration } from '@/hooks/useCollaboration';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { usePersistence } from '@/hooks/usePersistence';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import UserNamePrompt from '@/components/whiteboard/UserNamePrompt';
import LoadingScreen from '@/components/whiteboard/LoadingScreen';
import RemoteCursors from '@/components/whiteboard/RemoteCursors';
import PresencePanel from '@/components/whiteboard/PresencePanel';
import SharePanel from '@/components/whiteboard/SharePanel';
import EmptyState from '@/components/whiteboard/EmptyState';
import ExportButton from '@/components/whiteboard/ExportButton';
import ClearBoardModal from '@/components/whiteboard/ClearBoardModal';
import ViewportControls from '@/components/whiteboard/ViewportControls';
import ToolSidebar from '@/components/whiteboard/ToolSidebar';
import PaletteBar from '@/components/whiteboard/PaletteBar';
import { UndoRedoBar } from '@/components/whiteboard/UndoRedoBar';
import ContextMenu from '@/components/whiteboard/ContextMenu';
import ResizeHandles from '@/components/whiteboard/ResizeHandles';
import { ShortcutsHelp } from '@/components/whiteboard/ShortcutsHelp';
import WhiteboardCanvas from '@/components/whiteboard/WhiteboardCanvas';
import PenTool from '@/components/whiteboard/tools/PenTool';
import EraserTool from '@/components/whiteboard/tools/EraserTool';
import TextTool from '@/components/whiteboard/tools/TextTool';
import RectangleTool from '@/components/whiteboard/tools/RectangleTool';
import CircleTool from '@/components/whiteboard/tools/CircleTool';
import LineTool from '@/components/whiteboard/tools/LineTool';
import ArrowTool from '@/components/whiteboard/tools/ArrowTool';
import StickyNoteTool from '@/components/whiteboard/tools/StickyNoteTool';
import type { CanvasElement } from '@/types/whiteboard';
import * as store from '@/lib/whiteboard/store';
import { cleanupStaleRooms } from '@/lib/whiteboard/persistence';
import { exportCanvasToPNG, exportCanvasToSVG, downloadBlob } from '@/lib/whiteboard/export';
import Konva from 'konva';

function RoomContent() {
  const params = useParams();
  const router = useRouter();
  const roomId = params?.roomId as string;

  const [userName, setUserName] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const stageRef = useRef<Konva.Stage | null>(null);

  useEffect(() => {
    cleanupStaleRooms();
  }, []);

  const {
    isConnected,
    isSynced,
    users,
    cursors,
    error,
    setCursor,
    setUserName: syncUserName,
    localPeerId,
    provider,
    elementsArray,
    status,
    maxUsers,
    elements,
    setElements,
    viewport,
    setViewport,
  } = useCollaboration(roomId);

  const {
    tool,
    selectElement,
    selectMultiple,
    deselectAll,
    moveElement,
  } = useWhiteboardStore();

  const { clearState } = usePersistence(roomId, elements, viewport);

  // Sync store changes to API
  const saveRef = useRef(setElements);
  saveRef.current = setElements;

  // Expose store and collaboration on window for E2E testing
  useEffect(() => {
    // @ts-ignore
    window.__whiteboardStore = store;
    // @ts-ignore
    window.__whiteboardCollab = {
      provider: provider,
      status: status,
      isConnected: isConnected,
      isSynced: isSynced,
      localPeerId: localPeerId,
    };
    return () => {
      // @ts-ignore
      delete window.__whiteboardStore;
      // @ts-ignore
      delete window.__whiteboardCollab;
    };
  }, [provider, status, isConnected, isSynced, localPeerId]);

  const prevElementsRef = useRef<CanvasElement[]>([]);
  useEffect(() => {
    return store.subscribe(() => {
      const state = store.getState();
      if (state.elements !== prevElementsRef.current) {
        prevElementsRef.current = state.elements;
        saveRef.current(state.elements);
      }
    });
  }, []);

  const handleJoin = (name: string) => {
    const currentUserAlreadyPresent = users.some((user) => user.peerId === localPeerId);
    if (users.length >= maxUsers && !currentUserAlreadyPresent) {
      return;
    }
    setUserName(name);
    syncUserName(name);
  };

  useEffect(() => {
    if (userName) {
      syncUserName(userName);
    }
  }, [userName, syncUserName]);

  const handleRetry = () => {
    setRetryKey((k) => k + 1);
  };

  const handleClearBoard = useCallback(() => {
    store.setElements([]);
    store.deselectAll();
    setViewport({ x: 0, y: 0, zoom: 1 });
    clearState();
    setClearModalOpen(false);
  }, [clearState, setViewport, setElements]);

  const handleCancelClear = useCallback(() => {
    setClearModalOpen(false);
  }, []);

  const handleCanvasMouseDown = useCallback(
    (e: any) => {
      if (tool === 'select') {
        const clickedOnEmpty = e.target === e.target.getStage();
        if (clickedOnEmpty) {
          deselectAll();
        }
      }
    },
    [tool, deselectAll]
  );

  const handleCanvasContextMenu = useCallback(
    (e: any) => {
      e.evt.preventDefault();
      setContextMenu({ x: e.evt.clientX, y: e.evt.clientY });
    },
    []
  );

  const handleExportPNG = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage) return;
    setExporting(true);
    try {
      const blob = await exportCanvasToPNG(stage, { scale: 2, quality: 0.92 });
      downloadBlob(blob, `whiteboard-${roomId}.png`);
    } catch {
      // export failed
    } finally {
      setExporting(false);
    }
  }, [roomId]);

  const handleExportSVG = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage) return;
    setExporting(true);
    try {
      const svgString = await exportCanvasToSVG(stage);
      const blob = new Blob([svgString], { type: 'image/svg+xml' });
      downloadBlob(blob, `whiteboard-${roomId}.svg`);
    } catch {
      // export failed
    } finally {
      setExporting(false);
    }
  }, [roomId]);

  const { showShortcutsHelp, activeShortcuts } = useKeyboardShortcuts();

  const handleFitToContent = useCallback(() => {
    if (elements.length === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
      if ('x' in el && 'y' in el && 'width' in el && 'height' in el) {
        const e = el as { x: number; y: number; width: number; height: number };
        minX = Math.min(minX, e.x);
        minY = Math.min(minY, e.y);
        maxX = Math.max(maxX, e.x + e.width);
        maxY = Math.max(maxY, e.y + e.height);
      }
      if ('points' in el) {
        const pts = (el as { points: { x: number; y: number }[] }).points;
        for (const p of pts) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      }
    }
    const padding = 100;
    const w = maxX - minX + padding * 2;
    const h = maxY - minY + padding * 2;
    const stageW = window.innerWidth - 56;
    const stageH = window.innerHeight - 48;
    const zoom = Math.min(stageW / w, stageH / h, 1);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewport({
      x: stageW / 2 - cx * zoom,
      y: stageH / 2 - cy * zoom,
      zoom: Math.max(0.1, Math.min(5.0, zoom)),
    });
  }, [elements, setViewport]);

  if (!userName) {
    return <UserNamePrompt onJoin={handleJoin} roomId={roomId} />;
  }

  if (status !== 'synced' && status !== 'connected' && status !== 'connecting') {
    return <LoadingScreen error={error} onRetry={handleRetry} />;
  }

  const userCount = users.length;

  const isCurrentUserPresent = users.some((user) => user.peerId === localPeerId);

  if (userCount >= maxUsers && !isCurrentUserPresent) {
    return (
      <div
        className="fixed inset-0 flex items-center justify-center bg-slate-50"
      >
        <div className="text-center">
          <h2 className="text-2xl text-slate-700 mb-2">
            Room is full
          </h2>
          <p className="text-sm text-slate-500 mb-4">
            This room has reached the maximum of {maxUsers} users.
          </p>
          <button
            onClick={() => router.push('/whiteboard')}
            className="px-6 py-2.5 rounded-lg border-none bg-blue-500 text-white text-sm cursor-pointer"
          >
            Back to Rooms
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-screen h-screen overflow-hidden relative bg-slate-50"
    >
      <ToolSidebar />
      <PaletteBar />
      <div
        className="absolute left-14 top-12 overflow-hidden rounded-tl-2xl bg-slate-50"
        data-testid="whiteboard-canvas-area"
        style={{
          width: 'calc(100vw - 276px)',
          height: 'calc(100vh - 48px)',
        }}
      >
        <WhiteboardCanvas
          stageRef={stageRef}
          onCanvasMouseDown={handleCanvasMouseDown}
          onCanvasContextMenu={handleCanvasContextMenu}
          setCursor={setCursor}
          userName={userName}
        />
        <PenTool />
        <EraserTool />
        <TextTool />
        <RectangleTool />
        <CircleTool />
        <LineTool />
        <ArrowTool />
        <StickyNoteTool />
        <ResizeHandles stageRef={stageRef} />
        <RemoteCursors
          cursors={cursors}
          localPeerId={localPeerId}
          stageRef={stageRef}
        />
        {elements.length === 0 && <EmptyState />}
      </div>
      <PresencePanel
        users={users}
        localPeerId={localPeerId}
        collapsed={panelCollapsed}
        onToggle={() => setPanelCollapsed((c) => !c)}
      />
      <SharePanel roomId={roomId} />
      {!isSynced && <LoadingScreen />}

      {/* Top toolbar */}
      <div
        data-testid="whiteboard-top-toolbar"
        className="fixed top-3 right-[236px] flex items-center gap-2 z-[200]"
      >
        <ExportButton
          stageRef={stageRef}
          onExportPNG={handleExportPNG}
          onExportSVG={handleExportSVG}
          exporting={exporting}
        />
        <button
          data-testid="whiteboard-clear-btn"
          onClick={() => setClearModalOpen(true)}
          title="Clear board"
          className="flex items-center gap-1.5 px-3 py-2 border border-slate-700/80 rounded-lg bg-slate-900 text-slate-200 cursor-pointer text-[13px] font-medium shadow-lg shadow-slate-900/15 transition-colors hover:bg-slate-800"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          Clear
        </button>
      </div>

      {/* Bottom controls */}
      <div
        className="fixed bottom-4 left-[calc(50%_-_110px)] -translate-x-1/2 flex items-center gap-2 z-[200] rounded-xl border border-slate-700/80 bg-slate-900 p-1 shadow-xl shadow-slate-900/20"
        data-testid="whiteboard-bottom-controls"
      >
        <UndoRedoBar
          canUndo={store.canUndo()}
          canRedo={store.canRedo()}
          onUndo={() => store.undo()}
          onRedo={() => store.redo()}
        />
        <ViewportControls
          zoom={viewport.zoom}
          onZoomIn={() => setViewport({ ...viewport, zoom: Math.min(viewport.zoom + 0.1, 5.0) })}
          onZoomOut={() => setViewport({ ...viewport, zoom: Math.max(viewport.zoom - 0.1, 0.1) })}
          onFitToContent={handleFitToContent}
          onResetView={() => setViewport({ x: 0, y: 0, zoom: 1 })}
          elements={elements}
        />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          visible={!!contextMenu}
          x={contextMenu?.x ?? 0}
          y={contextMenu?.y ?? 0}
        />
      )}

      <ClearBoardModal
        isOpen={clearModalOpen}
        onConfirm={handleClearBoard}
        onCancel={handleCancelClear}
      />

      <ShortcutsHelp
        visible={showShortcutsHelp}
        shortcuts={activeShortcuts}
        onClose={() => {}}
      />
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
