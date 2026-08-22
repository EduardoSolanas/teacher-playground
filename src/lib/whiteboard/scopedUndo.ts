import * as Y from 'yjs';

export type ScopedUndo = {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Subscribe to availability changes; returns an unsubscribe. */
  onChange(listener: () => void): () => void;
  destroy(): void;
};

export function createScopedUndo(
  elementsArray: Y.Array<Y.Map<unknown>>,
  options?: { trackedOrigin?: unknown; captureTimeoutMs?: number },
): ScopedUndo {
  const trackedOrigin = options?.trackedOrigin ?? 'local';
  // 300ms is a reasonable default: a typical freehand stroke takes 200-400ms,
  // and grouping rapid edits (like successive point samples in a batch update)
  // into one undo step provides the expected behavior of "undo the stroke."
  const captureTimeoutMs = options?.captureTimeoutMs ?? 300;

  const manager = new Y.UndoManager(elementsArray, {
    trackedOrigins: new Set([trackedOrigin]),
    captureTimeout: captureTimeoutMs,
  });

  const listeners = new Set<() => void>();
  let isDestroyed = false;

  // Notify listeners when undo/redo state changes
  const notifyListeners = () => {
    listeners.forEach((listener) => listener());
  };

  // Y.UndoManager emits 'stack-item-added' and 'stack-item-popped' events
  manager.on('stack-item-added', notifyListeners);
  manager.on('stack-item-popped', notifyListeners);

  return {
    undo() {
      if (!isDestroyed) {
        manager.undo();
      }
    },
    redo() {
      if (!isDestroyed) {
        manager.redo();
      }
    },
    canUndo() {
      return isDestroyed ? false : manager.canUndo();
    },
    canRedo() {
      return isDestroyed ? false : manager.canRedo();
    },
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      isDestroyed = true;
      manager.off('stack-item-added', notifyListeners);
      manager.off('stack-item-popped', notifyListeners);
      manager.destroy();
      listeners.clear();
    },
  };
}
