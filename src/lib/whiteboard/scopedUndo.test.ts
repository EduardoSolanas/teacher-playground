import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { createScopedUndo } from './scopedUndo';
import { createWhiteboardDoc, replaceSharedElements, getElementsFromArray } from './yjsDoc';

/**
 * Connect two docs bidirectionally: every local update is forwarded to the peer.
 * Returns a cleanup function that stops the sync.
 */
function connectDocs(host: Y.Doc, peer: Y.Doc): () => void {
  const hostListener = (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return;
    Y.applyUpdate(peer, update, 'remote');
  };
  const peerListener = (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return;
    Y.applyUpdate(host, update, 'remote');
  };
  host.on('update', hostListener);
  peer.on('update', peerListener);
  return () => {
    host.off('update', hostListener);
    peer.off('update', peerListener);
  };
}

describe('scopedUndo', () => {
  let hostDoc: Y.Doc;
  let peerDoc: Y.Doc;
  let hostElements: Y.Array<Y.Map<unknown>>;
  let peerElements: Y.Array<Y.Map<unknown>>;
  let cleanup: () => void;

  beforeEach(() => {
    const host = createWhiteboardDoc('test-host');
    const peer = createWhiteboardDoc('test-peer');
    hostDoc = host.doc;
    peerDoc = peer.doc;
    hostElements = host.elementsArray;
    peerElements = peer.elementsArray;

    // Initial sync: copy host state to peer
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(hostDoc), 'remote');
    // Then set up bidirectional listeners for future changes
    cleanup = connectDocs(hostDoc, peerDoc);
  });

  afterEach(() => {
    cleanup();
    hostDoc.destroy();
    peerDoc.destroy();
  });

  describe('central test: peer independence', () => {
    it('undo only undoes local changes, leaves remote changes intact', async () => {
      const scopedUndo = createScopedUndo(hostElements);

      // Peer A adds an element locally
      replaceSharedElements(hostDoc, hostElements, [{ id: 'local-1', type: 'freedraw' }], 'local');

      // Wait for sync to peerDoc
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Peer B adds an element (arrives at A as remote)
      // Using deleteMissing: false to preserve existing remote elements
      replaceSharedElements(peerDoc, peerElements, [{ id: 'remote-1', type: 'freedraw' }], 'local', { deleteMissing: false });

      // Wait for sync back to hostDoc
      await new Promise((resolve) => setTimeout(resolve, 10));

      const hostEls = getElementsFromArray(hostElements);
      const peerEls = getElementsFromArray(peerElements);

      expect(hostEls).toHaveLength(2);
      expect(peerEls).toHaveLength(2);

      // A calls undo
      scopedUndo.undo();

      // A's element is gone but B's element is still present
      const hostElements_ = getElementsFromArray(hostElements);
      expect(hostElements_).toHaveLength(1);
      expect(hostElements_[0].id).toBe('remote-1');

      // Both documents converge to the same state
      const peerElements_ = getElementsFromArray(peerElements);
      expect(peerElements_).toHaveLength(1);
      expect(peerElements_[0].id).toBe('remote-1');

      scopedUndo.destroy();
    });
  });

  describe('undo and redo', () => {
    it('redo restores the undone local element', () => {
      const scopedUndo = createScopedUndo(hostElements);

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      expect(getElementsFromArray(hostElements)).toHaveLength(1);

      scopedUndo.undo();
      expect(getElementsFromArray(hostElements)).toHaveLength(0);

      scopedUndo.redo();
      expect(getElementsFromArray(hostElements)).toHaveLength(1);
      expect(getElementsFromArray(hostElements)[0].id).toBe('el-1');

      scopedUndo.destroy();
    });

    it('undo and redo work with multiple local changes', async () => {
      const scopedUndo = createScopedUndo(hostElements, { captureTimeoutMs: 50 });

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      // Wait longer than capture timeout to ensure separate undo steps
      await new Promise((resolve) => setTimeout(resolve, 100));
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }, { id: 'el-2', type: 'freedraw' }], 'local', { deleteMissing: false });

      expect(getElementsFromArray(hostElements)).toHaveLength(2);

      scopedUndo.undo();
      expect(getElementsFromArray(hostElements)).toHaveLength(1);

      scopedUndo.undo();
      expect(getElementsFromArray(hostElements)).toHaveLength(0);

      scopedUndo.redo();
      expect(getElementsFromArray(hostElements)).toHaveLength(1);

      scopedUndo.redo();
      expect(getElementsFromArray(hostElements)).toHaveLength(2);

      scopedUndo.destroy();
    });
  });

  describe('canUndo and canRedo', () => {
    it('canUndo and canRedo start as false', () => {
      const scopedUndo = createScopedUndo(hostElements);
      expect(scopedUndo.canUndo()).toBe(false);
      expect(scopedUndo.canRedo()).toBe(false);
      scopedUndo.destroy();
    });

    it('canUndo is true after a local edit', () => {
      const scopedUndo = createScopedUndo(hostElements);
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      expect(scopedUndo.canUndo()).toBe(true);
      expect(scopedUndo.canRedo()).toBe(false);
      scopedUndo.destroy();
    });

    it('canUndo becomes false after undo, canRedo becomes true', () => {
      const scopedUndo = createScopedUndo(hostElements);
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      scopedUndo.undo();
      expect(scopedUndo.canUndo()).toBe(false);
      expect(scopedUndo.canRedo()).toBe(true);
      scopedUndo.destroy();
    });

    it('canRedo becomes false after redo, canUndo stays true', () => {
      const scopedUndo = createScopedUndo(hostElements);
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      scopedUndo.undo();
      scopedUndo.redo();
      expect(scopedUndo.canUndo()).toBe(true);
      expect(scopedUndo.canRedo()).toBe(false);
      scopedUndo.destroy();
    });

    it('canRedo is cleared after a new local edit', () => {
      const scopedUndo = createScopedUndo(hostElements);
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      scopedUndo.undo();
      expect(scopedUndo.canRedo()).toBe(true);
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-2', type: 'freedraw' }], 'local');
      expect(scopedUndo.canRedo()).toBe(false);
      scopedUndo.destroy();
    });
  });

  describe('remote-origin changes', () => {
    it('canUndo is false after only a remote-origin change', () => {
      const scopedUndo = createScopedUndo(hostElements);
      // Add an element at peer, it arrives as 'remote' at host
      replaceSharedElements(peerDoc, peerElements, [{ id: 'remote-1', type: 'freedraw' }], 'local');
      expect(scopedUndo.canUndo()).toBe(false);
      scopedUndo.destroy();
    });

    it('undo has no effect on remote-origin changes', () => {
      const scopedUndo = createScopedUndo(hostElements);
      replaceSharedElements(peerDoc, peerElements, [{ id: 'remote-1', type: 'freedraw' }], 'local');
      const before = getElementsFromArray(hostElements).length;
      scopedUndo.undo();
      const after = getElementsFromArray(hostElements).length;
      expect(after).toBe(before);
      scopedUndo.destroy();
    });
  });

  describe('capture timeout grouping', () => {
    it('two edits within the capture timeout collapse into a single undo step', async () => {
      const captureTimeoutMs = 100;
      const scopedUndo = createScopedUndo(hostElements, { captureTimeoutMs });

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }, { id: 'el-2', type: 'freedraw' }], 'local', { deleteMissing: false });

      scopedUndo.undo();
      // After one undo, both should be gone (they were grouped)
      expect(getElementsFromArray(hostElements)).toHaveLength(0);

      scopedUndo.destroy();
    });

    it('two edits separated by more than capture timeout are two steps', async () => {
      const captureTimeoutMs = 50;
      const scopedUndo = createScopedUndo(hostElements, { captureTimeoutMs });

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      // Wait longer than the capture timeout
      await new Promise((resolve) => setTimeout(resolve, captureTimeoutMs + 50));
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }, { id: 'el-2', type: 'freedraw' }], 'local', { deleteMissing: false });

      // First undo should only undo the second edit
      scopedUndo.undo();
      expect(getElementsFromArray(hostElements)).toHaveLength(1);

      // Second undo should undo the first edit
      scopedUndo.undo();
      expect(getElementsFromArray(hostElements)).toHaveLength(0);

      scopedUndo.destroy();
    });
  });

  describe('onChange listener', () => {
    it('onChange fires when canUndo changes from false to true', () => {
      const scopedUndo = createScopedUndo(hostElements);
      const listener = vi.fn();
      scopedUndo.onChange(listener);

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      expect(listener).toHaveBeenCalled();

      scopedUndo.destroy();
    });

    it('onChange fires when canRedo changes', () => {
      const scopedUndo = createScopedUndo(hostElements);
      const listener = vi.fn();
      scopedUndo.onChange(listener);
      listener.mockClear();

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      listener.mockClear();

      scopedUndo.undo();
      expect(listener).toHaveBeenCalled();

      scopedUndo.destroy();
    });

    it('returned unsubscribe stops the listener', () => {
      const scopedUndo = createScopedUndo(hostElements);
      const listener = vi.fn();
      const unsubscribe = scopedUndo.onChange(listener);

      unsubscribe();

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      expect(listener).not.toHaveBeenCalled();

      scopedUndo.destroy();
    });

    it('multiple listeners work independently', async () => {
      const scopedUndo = createScopedUndo(hostElements, { captureTimeoutMs: 50 });
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = scopedUndo.onChange(listener1);
      scopedUndo.onChange(listener2);

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();

      listener1.mockClear();
      listener2.mockClear();
      unsub1();

      // Wait longer than capture timeout to ensure separate undo steps
      await new Promise((resolve) => setTimeout(resolve, 100));

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }, { id: 'el-2', type: 'freedraw' }], 'local', { deleteMissing: false });
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();

      scopedUndo.destroy();
    });
  });

  describe('destroy', () => {
    it('destroy removes all listeners', () => {
      const scopedUndo = createScopedUndo(hostElements);
      const listener = vi.fn();
      scopedUndo.onChange(listener);

      scopedUndo.destroy();

      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      expect(listener).not.toHaveBeenCalled();
    });

    it('undo/redo have no effect after destroy', () => {
      const scopedUndo = createScopedUndo(hostElements);
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'local');
      expect(getElementsFromArray(hostElements)).toHaveLength(1);

      scopedUndo.destroy();
      scopedUndo.undo();

      expect(getElementsFromArray(hostElements)).toHaveLength(1);
    });
  });

  describe('custom tracked origin', () => {
    it('respects custom trackedOrigin option', () => {
      const scopedUndo = createScopedUndo(hostElements, { trackedOrigin: 'custom-origin' });

      // Add with custom origin
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }], 'custom-origin');
      expect(scopedUndo.canUndo()).toBe(true);

      // Add with different origin
      replaceSharedElements(hostDoc, hostElements, [{ id: 'el-1', type: 'freedraw' }, { id: 'el-2', type: 'freedraw' }], 'other-origin', { deleteMissing: false });
      expect(scopedUndo.canUndo()).toBe(true);

      // First undo removes el-1 (the custom-origin one)
      scopedUndo.undo();
      const elements = getElementsFromArray(hostElements);
      expect(elements).toHaveLength(1);
      expect(elements[0].id).toBe('el-2');

      scopedUndo.destroy();
    });
  });
});
