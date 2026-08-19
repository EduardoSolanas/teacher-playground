'use client';

import { useCallback, useRef, useEffect, useState } from 'react';
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import * as Y from 'yjs';
import {
  excalidrawElementsEqual,
  serializeExcalidrawElements,
  toExcalidrawToolType,
  uniqueElementsById,
} from '@/lib/whiteboard/excalidrawSync';
import { replaceSharedElements } from '@/lib/whiteboard/yjsDoc';
import { cursorPublishDelay } from '@/lib/whiteboard/cursorPublishRate';

type ExcalidrawWrapperProps = {
  roomId: string;
  userName: string;
  localPeerId: string;
  yDoc: Y.Doc | null;
  yElementsArray: Y.Array<Y.Map<any>> | null;
  yCursorsMap: Y.Map<any> | null;
  users: any[];
  activeTool: string;
  isLocalHost: boolean;
  onToolChange: (tool: string) => void;
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
  onElementsChange: (elements: any[]) => void;
};

export default function ExcalidrawWrapper({
  roomId,
  userName,
  localPeerId,
  yDoc,
  yElementsArray,
  yCursorsMap,
  users,
  activeTool,
  isLocalHost,
  onToolChange,
  onViewportChange,
  onElementsChange,
}: ExcalidrawWrapperProps) {
  const apiRef = useRef<any>(null);
  const [isClient, setIsClient] = useState(false);
  const isRemoteUpdateRef = useRef(false);
  const isPointerDownRef = useRef(false);
  const activeToolRef = useRef(activeTool);
  const remoteUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedElementsRef = useRef<any[]>([]);
  const lastPublishedIdsRef = useRef<string[]>([]);
  const pendingElementsRef = useRef<any[] | null>(null);
  const hasAcceptedInitialSceneRef = useRef(false);
  const localPeerIdRef = useRef(localPeerId);
  localPeerIdRef.current = localPeerId;

  const finishRemoteUpdateSoon = useCallback(() => {
    if (remoteUpdateTimeoutRef.current) {
      clearTimeout(remoteUpdateTimeoutRef.current);
    }
    remoteUpdateTimeoutRef.current = setTimeout(() => {
      isRemoteUpdateRef.current = false;
      remoteUpdateTimeoutRef.current = null;
    }, 100);
  }, []);

  const applyRemoteElements = useCallback((remoteElements: any[]) => {
    const localElements = apiRef.current?.getSceneElements?.() ?? [];
    const restoredElements = uniqueElementsById(
      restoreElements(
        serializeExcalidrawElements(remoteElements) as any,
        localElements,
        { repairBindings: true },
      ) as Array<{ id?: unknown }>,
    );

    onElementsChange(restoredElements);

    if (apiRef.current) {
      isRemoteUpdateRef.current = true;
      try {
        apiRef.current.updateScene({
          elements: restoredElements,
        });
      } catch {
        // ignore
      }
      finishRemoteUpdateSoon();
    } else {
      pendingElementsRef.current = restoredElements;
      isRemoteUpdateRef.current = false;
    }

    hasAcceptedInitialSceneRef.current = true;
  }, [finishRemoteUpdateSoon, onElementsChange]);

  useEffect(() => {
    setIsClient(true);
    return () => {
      if (remoteUpdateTimeoutRef.current) {
        clearTimeout(remoteUpdateTimeoutRef.current);
      }
      if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
        if ((window as any).__debugExcalidrawApi === apiRef.current) {
          delete (window as any).__debugExcalidrawApi;
        }
      }
    };
  }, []);

  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  useEffect(() => {
    if (!yDoc || !yElementsArray || !yCursorsMap) return;

    const elementsArray = yElementsArray;

    // Listen only for element changes. Cursor/awareness updates must not rewrite
    // the Excalidraw scene.
    const handler = (_events: Y.YEvent<any>[], transaction: Y.Transaction) => {
      if (transaction.origin === 'local') return;

      const elements = elementsArray.toArray();
      const remoteElements: any[] = [];

      for (const yMap of elements) {
        const el: Record<string, unknown> = {};
        (yMap as Y.Map<unknown>).forEach((value: unknown, key: string) => {
          el[key] = value;
        });
        remoteElements.push(el);
      }

      const same = excalidrawElementsEqual(remoteElements, lastSyncedElementsRef.current);
      if (same) return;
      lastSyncedElementsRef.current = remoteElements;

      applyRemoteElements(remoteElements);
    };

    elementsArray.observeDeep(handler);

    return () => {
      elementsArray.unobserveDeep(handler);
    };
  }, [yDoc, yElementsArray, yCursorsMap, roomId, applyRemoteElements]);

  /** Snapshot of the shared document as plain Excalidraw elements. */
  const readSharedElements = useCallback((): Record<string, unknown>[] => {
    if (!yElementsArray) return [];
    return yElementsArray.toArray().map((yMap) => {
      const element: Record<string, unknown> = {};
      (yMap as Y.Map<unknown>).forEach((value: unknown, key: string) => {
        element[key] = value;
      });
      return element;
    });
  }, [yElementsArray]);

  const handleAPI = useCallback((api: any) => {
    apiRef.current = api;

    // The document may already hold the room's contents — restored from the
    // API after a reload, or synced before the board mounted. Read it directly
    // rather than relying on anything queued earlier, since whether that
    // arrived before or after this callback is a race.
    //
    // Deferred, not applied inline: Excalidraw is still finishing its own
    // initialisation when this callback fires and would overwrite a scene
    // written synchronously here. The tool handling below defers for the same
    // reason.
    setTimeout(() => {
      if (apiRef.current !== api) return;
      const shared = readSharedElements();
      if (shared.length === 0) return;
      if (excalidrawElementsEqual(shared, lastSyncedElementsRef.current)) return;
      lastSyncedElementsRef.current = shared;
      isRemoteUpdateRef.current = true;
      try {
        api.updateScene({ elements: serializeExcalidrawElements(shared) as any });
      } catch {
        // A malformed stored scene must not stop the board from opening.
      }
      finishRemoteUpdateSoon();
    }, 100);

    // E2E runs against a production build, so the handle is also exposed when
    // the build is explicitly flagged for testing. Real deploys leave it off.
    const exposeDebugApi =
      process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_E2E === '1';
    if (exposeDebugApi && typeof window !== 'undefined') {
      (window as any).__debugExcalidrawApi = api;
    }

    if (pendingElementsRef.current) {
      const queuedElements = pendingElementsRef.current;
      pendingElementsRef.current = null;
      isRemoteUpdateRef.current = true;
      try {
        const restoredElements = uniqueElementsById(
          restoreElements(
            serializeExcalidrawElements(queuedElements) as any,
            api.getSceneElements?.() ?? [],
            { repairBindings: true },
          ) as Array<{ id?: unknown }>,
        );
        api.updateScene({
          elements: restoredElements,
        });
      } catch {
        // ignore
      }
      finishRemoteUpdateSoon();
    }

    setTimeout(() => {
      if (apiRef.current && activeToolRef.current) {
        try {
          apiRef.current.setActiveTool({ type: toExcalidrawToolType(activeToolRef.current) });
        } catch {
          // ignore
        }
      }
    }, 100);
  }, [finishRemoteUpdateSoon, readSharedElements]);

  useEffect(() => {
    if (!apiRef.current || !activeTool) return;
    try {
      apiRef.current.setActiveTool({ type: toExcalidrawToolType(activeTool) });
    } catch {
      // ignore
    }
  }, [activeTool]);

  const cursorSentAtRef = useRef<number | null>(null);
  const cursorPendingRef = useRef<any>(null);
  const cursorTimerRef = useRef<number | null>(null);

  const handleElementsChange = useCallback(
    (el: readonly any[], _appState: any) => {
      if (isRemoteUpdateRef.current) return;

      if (!hasAcceptedInitialSceneRef.current && el.length === 0) {
        return;
      }

      if (el.length === 0 && lastSyncedElementsRef.current.length > 0 && !isPointerDownRef.current) {
        return;
      }

      hasAcceptedInitialSceneRef.current = true;
      const serializedElements = serializeExcalidrawElements(el);
      const same = excalidrawElementsEqual(serializedElements, lastSyncedElementsRef.current);
      if (same) return;

      const previousIds = lastPublishedIdsRef.current;
      lastSyncedElementsRef.current = serializedElements;
      lastPublishedIdsRef.current = serializedElements
        .map((element) => element.id)
        .filter((id): id is string => typeof id === 'string');
      onElementsChange(serializedElements);

      if (yDoc && yElementsArray) {
        try {
          replaceSharedElements(yDoc, yElementsArray, serializedElements, 'local', {
            previousIds,
          });
        } catch {
          // HTTP persist already ran; a Yjs write must not roll that back.
        }
      }
    },
    [yDoc, yElementsArray, onElementsChange],
  );

  const publishPointer = useCallback(
    (payload: any) => {
      const peerId = localPeerIdRef.current;
      if (!yCursorsMap || !peerId) return;
      const pointer = payload?.pointer ?? payload;
      const x = typeof pointer?.x === 'number' ? pointer.x : 0;
      const y = typeof pointer?.y === 'number' ? pointer.y : 0;
      const user = users.find((entry) => entry.peerId === peerId);
      cursorSentAtRef.current = Date.now();
      yCursorsMap.set(peerId, {
        x,
        y,
        cursor: payload,
        userName,
        color: user?.color || '#3498db',
        peerId,
      });
    },
    [userName, users, yCursorsMap],
  );

  /**
   * Excalidraw reports pointer updates at pointer rate and each one is a Yjs
   * write, so publishing every update pushed past the Worker's 60 msg/sec
   * signaling cap and had the socket closed mid-drag. The latest payload is
   * kept and flushed when the window opens.
   */
  const handlePointerUpdate = useCallback(
    (payload: any) => {
      const delay = cursorPublishDelay(cursorSentAtRef.current, Date.now());
      if (delay === 0) {
        cursorPendingRef.current = null;
        publishPointer(payload);
        return;
      }

      cursorPendingRef.current = payload;
      if (cursorTimerRef.current !== null) return;
      cursorTimerRef.current = window.setTimeout(() => {
        cursorTimerRef.current = null;
        const pending = cursorPendingRef.current;
        cursorPendingRef.current = null;
        if (pending) publishPointer(pending);
      }, delay);
    },
    [publishPointer],
  );

  useEffect(() => () => {
    if (cursorTimerRef.current !== null) window.clearTimeout(cursorTimerRef.current);
  }, []);

  const handlePointerDown = useCallback(() => {
    isPointerDownRef.current = true;
  }, []);

  const handlePointerUp = useCallback(() => {
    isPointerDownRef.current = false;
  }, []);

  if (!isClient) {
    return <div className="w-full h-full min-h-[400px]" />;
  }

  return (
    <div
      className="w-full h-full min-h-[400px]"
      data-whiteboard-role={isLocalHost ? 'host' : 'peer'}
    >
      <Excalidraw
        excalidrawAPI={handleAPI}
        onChange={handleElementsChange}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerUpdate={handlePointerUpdate}
        UIOptions={{
          canvasActions: {
            export: false,
            saveToActiveFile: false,
            loadScene: false,
            clearCanvas: false,
          },
        }}
        viewModeEnabled={false}
        zenModeEnabled={false}
        gridModeEnabled={false}
        isCollaborating={true}
      />
    </div>
  );
}
