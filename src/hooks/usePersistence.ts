import { useState, useEffect, useCallback, useRef } from 'react';
import type { CanvasElement, Viewport } from '@/types/whiteboard';
import {
  saveBoardState,
  debouncedSaveBoardState,
  loadBoardState,
  clearBoardState,
  clearOnLeave,
  cancelDebouncedSave,
  cleanupStaleRooms,
} from '@/lib/whiteboard/persistence';

export function usePersistence(roomId: string | null, elements: CanvasElement[], viewport: Viewport) {
  const [loadedState, setLoadedState] = useState<{
    elements: CanvasElement[];
    viewport: Viewport;
  } | null>(null);

  const hasLoadedRef = useRef(false);

  // Load saved state on mount (no-op unless the room opted into offline cache)
  useEffect(() => {
    if (!roomId || hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const state = loadBoardState(roomId);
    if (state) {
      setLoadedState(state);
    }

    cleanupStaleRooms();

    const handleLeave = () => {
      clearOnLeave(roomId);
    };
    window.addEventListener('beforeunload', handleLeave);
    window.addEventListener('pagehide', handleLeave);

    return () => {
      window.removeEventListener('beforeunload', handleLeave);
      window.removeEventListener('pagehide', handleLeave);
      cancelDebouncedSave();
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    debouncedSaveBoardState(roomId, elements, viewport);
  }, [roomId, elements, viewport]);

  const saveState = useCallback(
    (el: CanvasElement[], vp: Viewport) => {
      if (!roomId) return;
      saveBoardState(roomId, el, vp);
    },
    [roomId]
  );

  const loadState = useCallback((): { elements: CanvasElement[]; viewport: Viewport } | null => {
    if (!roomId) return null;
    return loadBoardState(roomId);
  }, [roomId]);

  const clearState = useCallback(() => {
    if (!roomId) return;
    clearBoardState(roomId);
  }, [roomId]);

  const clearSession = useCallback(() => {
    if (!roomId) return;
    clearOnLeave(roomId);
  }, [roomId]);

  return {
    saveState,
    loadState,
    clearState,
    clearSession,
    loadedState,
  };
}
