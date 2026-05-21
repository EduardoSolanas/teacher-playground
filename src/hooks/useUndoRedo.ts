import { useState, useEffect, useCallback, useRef } from 'react';
import * as store from '@/lib/whiteboard/store';
import { HistoryManager } from '@/lib/whiteboard/history';
import type { CanvasElement } from '@/types/whiteboard';

let historyManager: HistoryManager | null = null;

function getHistory(): HistoryManager {
  if (!historyManager) {
    historyManager = new HistoryManager();
  }
  return historyManager;
}

export function useUndoRedo() {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [elements, setElements] = useState<CanvasElement[]>([]);

  const history = useRef(getHistory());

  useEffect(() => {
    function update() {
      const s = store.getState();
      setElements(s.elements);
      setCanUndo(history.current.canUndo());
      setCanRedo(history.current.canRedo());
    }
    update();
    return store.subscribe(update);
  }, []);

  const undo = useCallback(() => {
    const prev = history.current.undo();
    if (prev !== null) {
      store.setElements(prev);
      setCanUndo(history.current.canUndo());
      setCanRedo(history.current.canRedo());
    }
  }, []);

  const redo = useCallback(() => {
    const next = history.current.redo();
    if (next !== null) {
      store.setElements(next);
      setCanUndo(history.current.canUndo());
      setCanRedo(history.current.canRedo());
    }
  }, []);

  return {
    undo,
    redo,
    canUndo,
    canRedo,
    elements,
  };
}

export function pushHistory() {
  const s = store.getState();
  getHistory().push(s.elements);
}
