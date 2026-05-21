import { useState, useEffect, useCallback, useRef } from 'react';
import type { CanvasElement, Viewport } from '@/types/whiteboard';
import {
  saveBoardState,
  debouncedSaveBoardState,
  loadBoardState,
  clearBoardState,
  cleanupStaleRooms,
} from '@/lib/whiteboard/persistence';

export function usePersistence(roomId: string | null, elements: CanvasElement[], viewport: Viewport) {
  const [loadedState, setLoadedState] = useState<{
    elements: CanvasElement[];
    viewport: Viewport;
  } | null>(null);

  const hasLoadedRef = useRef(false);

  // Load saved state on mount
  useEffect(() => {
    if (!roomId || hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const state = loadBoardState(roomId);
    if (state) {
      setLoadedState(state);
    }

    // Cleanup stale rooms
    cleanupStaleRooms();

    // Save on beforeunload
    const handleBeforeUnload = () => {
      saveBoardState(roomId, elements, viewport);
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [roomId, elements, viewport]);

  // Auto-save on state changes (debounced)
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

  return {
    saveState,
    loadState,
    clearState,
    loadedState,
  };
}
