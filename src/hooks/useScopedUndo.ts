import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { createScopedUndo, type ScopedUndo } from '@/lib/whiteboard/scopedUndo';

/**
 * Binds the room's Yjs history to React without putting remote transactions
 * into the local undo stack.
 */
export function useScopedUndo(elementsArray: Y.Array<Y.Map<unknown>> | null) {
  const managerRef = useRef<ScopedUndo | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const manager = elementsArray
      ? createScopedUndo(elementsArray, { trackedOrigin: 'local' })
      : null;
    managerRef.current = manager;
    setRevision((value) => value + 1);

    if (!manager) return undefined;
    const unsubscribe = manager.onChange(() => setRevision((value) => value + 1));
    return () => {
      unsubscribe();
      manager.destroy();
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, [elementsArray]);

  const undo = useCallback(() => {
    managerRef.current?.undo();
    setRevision((value) => value + 1);
  }, []);

  const redo = useCallback(() => {
    managerRef.current?.redo();
    setRevision((value) => value + 1);
  }, []);

  // `revision` makes React re-read the manager after Yjs emits a stack event.
  void revision;
  return {
    undo,
    redo,
    canUndo: managerRef.current?.canUndo() ?? false,
    canRedo: managerRef.current?.canRedo() ?? false,
  };
}
