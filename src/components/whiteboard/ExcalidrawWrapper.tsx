'use client';

import { useCallback, useRef, useEffect, useState } from 'react';
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import * as Y from 'yjs';
import {
  excalidrawElementsEqual,
  serializeExcalidrawElements,
  toExcalidrawToolType,
} from '@/lib/whiteboard/excalidrawSync';

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
  const pendingElementsRef = useRef<any[] | null>(null);
  const hasAcceptedInitialSceneRef = useRef(false);

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
    const restoredElements = restoreElements(
      serializeExcalidrawElements(remoteElements) as any,
      localElements,
      { repairBindings: true },
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

  const handleAPI = useCallback((api: any) => {
    apiRef.current = api;
    if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
      (window as any).__debugExcalidrawApi = api;
    }

    if (pendingElementsRef.current) {
      const queuedElements = pendingElementsRef.current;
      pendingElementsRef.current = null;
      isRemoteUpdateRef.current = true;
      try {
        const restoredElements = restoreElements(
          serializeExcalidrawElements(queuedElements) as any,
          api.getSceneElements?.() ?? [],
          { repairBindings: true },
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
  }, [finishRemoteUpdateSoon]);

  useEffect(() => {
    if (!apiRef.current || !activeTool) return;
    try {
      apiRef.current.setActiveTool({ type: toExcalidrawToolType(activeTool) });
    } catch {
      // ignore
    }
  }, [activeTool]);

  const handleElementsChange = useCallback(
    (el: readonly any[], _appState: any) => {
      if (isRemoteUpdateRef.current) return;
      if (!yElementsArray || !yDoc) return;

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

      yDoc.transact(() => {
        const collab = yElementsArray;
        const len = collab.length;
        if (len > 0) {
          collab.delete(0, len);
        }

        for (const e of serializedElements) {
          const yMap = new Y.Map();
          for (const [key, value] of Object.entries(e)) {
            yMap.set(key, value);
          }
          collab.push([yMap]);
        }
      }, 'local');

      lastSyncedElementsRef.current = serializedElements;
      onElementsChange(serializedElements);
    },
    [yDoc, yElementsArray, onElementsChange],
  );

  const handlePointerUpdate = useCallback(
    (payload: any) => {
      if (!yCursorsMap || !localPeerId) return;
      const pointer = payload?.pointer ?? payload;
      const x = typeof pointer?.x === 'number' ? pointer.x : 0;
      const y = typeof pointer?.y === 'number' ? pointer.y : 0;
      const user = users.find((entry) => entry.peerId === localPeerId);
      yCursorsMap.set(localPeerId, {
        x,
        y,
        cursor: payload,
        userName,
        color: user?.color || '#3498db',
        peerId: localPeerId,
      });
    },
    [userName, localPeerId, users, yCursorsMap],
  );

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
