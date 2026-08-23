'use client';

import { useCallback, useRef, useEffect, useState } from 'react';
import { diffScene, shouldPublish, elementsToPublish } from '@/lib/whiteboard/scenePublish';
import { viewportFromAppState, type CanvasViewport } from '@/lib/whiteboard/cursorViewport';
// MUST stay above the Excalidraw import: it sets EXCALIDRAW_ASSET_PATH, and ES
// module imports are evaluated in order, before this module's own body runs.
import '@/lib/whiteboard/excalidrawAssetPath';
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import * as Y from 'yjs';
import {
  excalidrawElementsEqual,
  serializeExcalidrawElements,
  toExcalidrawToolType,
  uniqueElementsById,
} from '@/lib/whiteboard/excalidrawSync';
import { getElementsFromArray, replaceSharedElements } from '@/lib/whiteboard/yjsDoc';
import {
  isWhiteboardLatencyProbeEnabled,
  recordWhiteboardLatencyEvent,
} from '@/lib/whiteboard/latencyProbe';


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
  onViewportChange: (viewport: CanvasViewport) => void;
  /** The room's stored view, applied once when the board opens. */
  initialViewport: { x: number; y: number; zoom: number } | null;
  /** Local pointer, in scene coordinates. */
  onCursorMove: (sceneX: number, sceneY: number) => void;
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
  initialViewport,
  onCursorMove,
  onElementsChange,
}: ExcalidrawWrapperProps) {
  const apiRef = useRef<any>(null);
  const [isClient, setIsClient] = useState(false);
  const isPointerDownRef = useRef(false);
  const activeToolRef = useRef(activeTool);
  const lastSyncedElementsRef = useRef<any[]>([]);
  const lastPublishedIdsRef = useRef<string[]>([]);
  /** id -> Excalidraw `version` at the last publish, for O(changed) diffing. */
  const publishedVersionsRef = useRef<Map<string, number>>(new Map());

  /**
   * Adopt a scene that arrived from a peer as the publish baseline.
   *
   * Without this the version map still describes the pre-remote scene, so the
   * next local commit would see every remote element as "changed" and publish
   * it straight back — peers echoing each other's work.
   */
  const adoptVersionBaseline = useCallback((
    elements: readonly any[],
    remoteIds?: ReadonlySet<string>,
  ) => {
    const versions = new Map<string, number>();
    for (const element of elements) {
      const id = (element as { id?: unknown })?.id;
      if (typeof id !== 'string' || id.length === 0) continue;

      /*
       * An element the remote scene did not contain is ours and unsent.
       *
       * restoreElements merges the local scene into the remote one, so the
       * result includes anything drawn here that has not round-tripped yet.
       * Recording those as published claimed they had been sent when they had
       * not, and they were never published at all — one peer's shape simply
       * never arrived, intermittently, depending on what was in flight.
       */
      if (remoteIds && !remoteIds.has(id)) {
        const previous = publishedVersionsRef.current.get(id);
        if (previous !== undefined) versions.set(id, previous);
        continue;
      }

      const version = (element as { version?: unknown }).version;
      versions.set(id, typeof version === 'number' ? version : 0);
    }
    publishedVersionsRef.current = versions;
  }, []);
  /** Latest onElementsChange, so the unmount flush needs no dependency on it. */
  const onElementsChangeRef = useRef(onElementsChange);
  useEffect(() => { onElementsChangeRef.current = onElementsChange; }, [onElementsChange]);

  /** Remote scenes coalesce into one React update rather than ~20 a second. */
  const REMOTE_STATE_FLUSH_MS = 200;
  const pendingRemoteStateRef = useRef<any[] | null>(null);
  const remoteStateTimerRef = useRef<number | null>(null);
  /** Every element id the room has ever shown this peer. */
  const seenRemoteIdsRef = useRef<Set<string>>(new Set());
  const pendingElementsRef = useRef<any[] | null>(null);
  /** Scene captured mid-stroke, flushed to React state on pointer up. */
  const deferredElementsRef = useRef<any[] | null>(null);
  const hasAcceptedInitialSceneRef = useRef(false);
  const localPeerIdRef = useRef(localPeerId);
  localPeerIdRef.current = localPeerId;


  const applyRemoteElements = useCallback((remoteElements: any[]) => {
    const shouldRecordRemoteRender =
      isWhiteboardLatencyProbeEnabled() && hasAcceptedInitialSceneRef.current;
    const remoteIds = new Set<string>();
    for (const element of remoteElements) {
      const id = (element as { id?: unknown })?.id;
      if (typeof id === 'string' && id.length > 0) {
        remoteIds.add(id);
        seenRemoteIdsRef.current.add(id);
      }
    }

    const localElements = apiRef.current?.getSceneElements?.() ?? [];
    const restoredElements = uniqueElementsById(
      restoreElements(
        serializeExcalidrawElements(remoteElements) as any,
        localElements,
        { repairBindings: true },
      ) as Array<{ id?: unknown }>,
    );

    /*
     * Keep work this peer has drawn but not yet published.
     *
     * restoreElements does not union the local scene into the remote one — it
     * takes localElements only to preserve version numbers — so applying a
     * remote scene replaces what is on this canvas. Anything drawn here in the
     * gap before it round-trips is erased by the next update that arrives, and
     * while another peer draws one arrives every ~50ms. That is why a student
     * could not get a shape to stay on their own board while the teacher drew.
     *
     * Only elements the room has never known about come back: an id missing
     * from the remote scene that this peer has also never seen arrive and
     * never published. Anything the room has held before and dropped was
     * deleted by somebody and must stay deleted.
     *
     * Bounded to a drag in progress. On pointer-up the stroke is written to
     * the document synchronously, so after that the room knows about it and
     * nothing here needs to defend it. Leaving the rule unbounded let a board
     * clear be undone by whatever happened to still be on the canvas.
     *
     * Neither the version baseline nor the last-published ids can answer this.
     * The baseline is rebuilt from whatever arrives, so a board clear empties
     * it and every element looks brand new; and a peer never publishes the
     * elements it merely received, so those look new to it as well. Either way
     * a clear would undo itself, which is what both of them did.
     */
    const unpublishedLocal = isPointerDownRef.current
      ? (localElements as Array<{ id?: unknown }>).filter((element) => {
        const id = element?.id;
        return typeof id === 'string'
          && !remoteIds.has(id)
          && !seenRemoteIdsRef.current.has(id)
          && !lastPublishedIdsRef.current.includes(id);
      })
      : [];
    const sceneToApply = unpublishedLocal.length > 0
      ? [...restoredElements, ...unpublishedLocal]
      : restoredElements;

    /*
     * The canvas is updated below immediately — that is what the user watches.
     * What is deferred is the React hop.
     *
     * onElementsChange re-renders the room subtree and feeds the local
     * empty-board state, and a drawing peer sends ~20 updates a second. Doing
     * that per update made the receiving side crawl while the sender, which
     * already defers its own state hop mid-stroke, stayed fast — so whoever was
     * watching fell behind whoever was drawing.
     *
     * Nothing downstream of it needs 20 updates a second: it only drives the
     * is-the-board-empty check and the deferred React state hop.
     */
    pendingRemoteStateRef.current = sceneToApply;
    if (remoteStateTimerRef.current === null) {
      remoteStateTimerRef.current = window.setTimeout(() => {
        remoteStateTimerRef.current = null;
        const pending = pendingRemoteStateRef.current;
        pendingRemoteStateRef.current = null;
        if (pending) onElementsChange(pending);
      }, REMOTE_STATE_FLUSH_MS);
    }

    /*
     * Adopt what actually lands in the scene, not what arrived on the wire.
     * restoreElements can renumber versions, and a baseline taken from the raw
     * remote scene would then read every restored element as locally changed
     * and publish it straight back.
     */
    adoptVersionBaseline(restoredElements, remoteIds);

    if (apiRef.current) {
      try {
        apiRef.current.updateScene({
          elements: sceneToApply,
        });

        if (shouldRecordRemoteRender) {
          window.requestAnimationFrame(() => {
            for (const element of remoteElements) {
              const elementId = (element as { id?: unknown })?.id;
              const version = (element as { version?: unknown })?.version;
              if (typeof elementId !== 'string' || elementId.length === 0 || typeof version !== 'number') continue;
              recordWhiteboardLatencyEvent({
                kind: 'stroke-render',
                elementId,
                version,
              });
            }
          });
        }
      } catch {
        // ignore
      }
    } else {
      pendingElementsRef.current = sceneToApply;
    }

    hasAcceptedInitialSceneRef.current = true;
  }, [adoptVersionBaseline, onElementsChange]);

  useEffect(() => {
    setIsClient(true);
    return () => {
      // Flush any coalesced remote scene, so leaving a room cannot drop the
      // last change from the empty-board check or the deferred React state hop.
      if (remoteStateTimerRef.current !== null) {
        window.clearTimeout(remoteStateTimerRef.current);
        remoteStateTimerRef.current = null;
      }
      const pendingRemote = pendingRemoteStateRef.current;
      pendingRemoteStateRef.current = null;
      if (pendingRemote) onElementsChangeRef.current(pendingRemote);

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

      /*
       * The one reader, not a second copy of it.
       *
       * This loop used to lift values straight out of the Yjs map, which
       * silently stopped working the day `points` began arriving encoded: the
       * canvas was handed a Uint8Array it cannot draw, and a peer's strokes
       * simply never appeared. getElementsFromArray decodes every stored form.
       */
      const remoteElements: any[] = getElementsFromArray(elementsArray);

      const same = excalidrawElementsEqual(remoteElements, lastSyncedElementsRef.current);
      if (same) return;
      lastSyncedElementsRef.current = remoteElements;
      adoptVersionBaseline(remoteElements);

      applyRemoteElements(remoteElements);
    };

    elementsArray.observeDeep(handler);

    return () => {
      elementsArray.unobserveDeep(handler);
    };
  }, [yDoc, yElementsArray, yCursorsMap, roomId, applyRemoteElements, adoptVersionBaseline]);

  /** Snapshot of the shared document as plain Excalidraw elements. */
  const readSharedElements = useCallback((): Record<string, unknown>[] => {
    if (!yElementsArray) return [];
    // Through the shared reader, never by copying the map directly: `points`
    // is stored encoded and has to be decoded before it reaches the canvas.
    return getElementsFromArray(yElementsArray) as unknown as Record<string, unknown>[];
  }, [yElementsArray]);

  /*
   * Applied once, never on later changes.
   *
   * The stored view arrives with the room load, and the API poll can bring it
   * round again while a lesson is running. Re-applying it then would drag the
   * canvas out from under whoever is drawing, so the first one wins.
   */
  const appliedStoredViewRef = useRef(false);
  const [apiReady, setApiReady] = useState(false);
  useEffect(() => {
    if (appliedStoredViewRef.current || !apiReady) return;
    const api = apiRef.current;
    if (!api || !initialViewport) return;
    const { x, y, zoom } = initialViewport;
    if (x === 0 && y === 0 && zoom === 1) return;
    appliedStoredViewRef.current = true;
    try {
      api.updateScene({ appState: { scrollX: x, scrollY: y, zoom: { value: zoom } } });
    } catch {
      // A stored view must never stop the board from opening.
    }
  }, [initialViewport, apiReady]);

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
      // Excalidraw has settled, so the stored view can be applied now.
      setApiReady(true);
      const shared = readSharedElements();
      if (shared.length === 0) return;
      if (excalidrawElementsEqual(shared, lastSyncedElementsRef.current)) return;
      lastSyncedElementsRef.current = shared;
      adoptVersionBaseline(shared);
      try {
        api.updateScene({ elements: serializeExcalidrawElements(shared) as any });
      } catch {
        // A malformed stored scene must not stop the board from opening.
      }
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
  }, [adoptVersionBaseline, readSharedElements]);

  useEffect(() => {
    if (!apiRef.current || !activeTool) return;
    try {
      apiRef.current.setActiveTool({ type: toExcalidrawToolType(activeTool) });
    } catch {
      // ignore
    }
  }, [activeTool]);


  /**
   * Publishing a stroke while it is being drawn.
   *
   * Excalidraw fires onChange for every pointer sample. Each commit below
   * serializes the whole scene, deep-compares it, and walks every element and
   * every key to write Yjs — for a freedraw element that includes its entire
   * point array. Doing all of that per sample is O(board size) tens of times a
   * second, so the lag grew with how much had been drawn.
   *
   * While the pointer is down the work is throttled to this interval, with a
   * trailing call so the last sample is never dropped, and pointer up flushes.
   * 50ms is ~20 publishes a second: remote strokes still look continuous, and
   * cursors travel on their own faster channel.
   */
  const STROKE_COMMIT_INTERVAL_MS = 50;
  const strokeCommitAtRef = useRef(0);
  const strokeTrailingTimerRef = useRef<number | null>(null);

  const commitElements = useCallback(
    (el: readonly any[], force = false) => {
      hasAcceptedInitialSceneRef.current = true;

      // Excalidraw stamps every element with a monotonic `version`, so what
      // changed can be found by comparing numbers on the RAW elements. The old
      // check serialized the whole scene and JSON.stringify'd it twice — on a
      // board of any size that dominated the drawing path.
      const diff = diffScene(publishedVersionsRef.current, el);
      if (!shouldPublish(diff, force)) return;

      const serializedElements = serializeExcalidrawElements(el);

      const previousIds = lastPublishedIdsRef.current;
      lastSyncedElementsRef.current = serializedElements;
      lastPublishedIdsRef.current = serializedElements
        .map((element) => element.id)
        .filter((id): id is string => typeof id === 'string');
      publishedVersionsRef.current = diff.nextVersions;

      // Excalidraw fires onChange for every pointer sample, so this runs tens of
      // times per second while drawing. Handing the whole scene to React state
      // on each one re-rendered the entire board subtree mid-stroke, and the
      // cost grew with the size of the board — the drawing lag users reported,
      // reproducible with the host alone.
      //
      // Nothing in that state is needed until the stroke ends: it drives an
      // is-the-board-empty check and the deferred React state hop. The Yjs
      // write below is NOT deferred, so remote peers still see the stroke live.
      if (isPointerDownRef.current) {
        deferredElementsRef.current = serializedElements;
      } else {
        deferredElementsRef.current = null;
        onElementsChange(serializedElements);
      }

      if (yDoc && yElementsArray) {
        const shouldRecordLatency = isWhiteboardLatencyProbeEnabled();
        try {
          const { elements: payload, wholeScene } = elementsToPublish(
            serializedElements,
            diff,
          );
          if (wholeScene) {
            // An element disappeared, so the stale sweep has to run and needs
            // the whole scene to know what survived.
            replaceSharedElements(yDoc, yElementsArray, serializedElements, 'local', {
              previousIds,
            });
          } else if (payload.length > 0) {
            replaceSharedElements(yDoc, yElementsArray, payload, 'local', {
              deleteMissing: false,
            });
          }

          if (shouldRecordLatency) {
            const publishedElements = serializedElements.filter((element) => {
              const elementId = (element as { id?: unknown })?.id;
              return typeof elementId === 'string' && diff.changedIds.has(elementId);
            });
            for (const element of publishedElements) {
              const elementId = (element as { id?: unknown })?.id;
              const version = (element as { version?: unknown })?.version;
              if (typeof elementId !== 'string' || elementId.length === 0 || typeof version !== 'number') continue;
              recordWhiteboardLatencyEvent({
                kind: 'stroke-publish',
                elementId,
                version,
              });
            }
          }
        } catch {
          // A Yjs write must not roll back the local canvas state.
        }
      }
    },
    [yDoc, yElementsArray, onElementsChange],
  );

  const handleElementsChange = useCallback(
    (el: readonly any[], _appState: any) => {
      /*
       * No remote-update flag here.
       *
       * Applying a remote scene used to set one and clear it 100ms later, and
       * every local change in between was discarded. A drawing peer commits
       * every 50ms, so while one person drew the other's window never closed
       * and their own strokes were dropped for as long as it lasted — the host
       * drew fine and the student could not draw at all.
       *
       * Echoes are already prevented exactly, per element, by the version
       * baseline adopted in applyRemoteElements: a scene that only contains
       * what a peer just sent produces no changed ids and publishes nothing.
       * That needs no window, and it does not starve anyone.
       */
      if (!hasAcceptedInitialSceneRef.current && el.length === 0) {
        return;
      }

      if (el.length === 0 && lastSyncedElementsRef.current.length > 0 && !isPointerDownRef.current) {
        return;
      }

      if (!isPointerDownRef.current) {
        if (strokeTrailingTimerRef.current !== null) {
          window.clearTimeout(strokeTrailingTimerRef.current);
          strokeTrailingTimerRef.current = null;
        }
        commitElements(el);
        return;
      }

      const now = Date.now();
      const since = now - strokeCommitAtRef.current;
      if (since >= STROKE_COMMIT_INTERVAL_MS) {
        strokeCommitAtRef.current = now;
        commitElements(el);
        return;
      }

      // Too soon: let the trailing timer read the live scene when it fires, so
      // the newest sample wins rather than this stale one.
      if (strokeTrailingTimerRef.current === null) {
        strokeTrailingTimerRef.current = window.setTimeout(() => {
          strokeTrailingTimerRef.current = null;
          strokeCommitAtRef.current = Date.now();
          const api = apiRef.current;
          if (api) commitElements(api.getSceneElements());
        }, STROKE_COMMIT_INTERVAL_MS - since);
      }
    },
    [commitElements],
  );

  /*
   * No cursor publishing here.
   *
   * RoomClient already writes the local cursor from its root onPointerMove, in
   * viewport pixels — the units RemoteCursorOverlay positions with. This
   * component used to publish Excalidraw's scene coordinates to the same Yjs
   * key, on its own separate throttle, so while a pointer moved over the canvas
   * the two writers interleaved and every other update put the peer's cursor
   * somewhere else entirely. On the receiving board that read as the pointer
   * flickering between two positions, worst while drawing, when both handlers
   * fire continuously.
   */

  useEffect(() => () => {
    if (strokeTrailingTimerRef.current !== null) window.clearTimeout(strokeTrailingTimerRef.current);
  }, []);

  /*
   * The one place a cursor is published, and it publishes scene coordinates.
   *
   * Excalidraw hands us the pointer already in scene space, the only frame two
   * peers share. RoomClient used to publish its own viewport pixels from a root
   * onPointerMove; two writers on one key made the pointer flicker, and
   * viewport pixels land in the wrong place on any screen that is not the same
   * size, scroll and zoom as the sender's.
   */
  const handlePointerUpdate = useCallback((payload: any) => {
    const pointer = payload?.pointer ?? payload;
    const x = typeof pointer?.x === 'number' ? pointer.x : null;
    const y = typeof pointer?.y === 'number' ? pointer.y : null;
    if (x === null || y === null) return;
    onCursorMove(x, y);
  }, [onCursorMove]);

  /**
   * Report this peer's transform, but only when it actually moves.
   *
   * This runs on every Excalidraw change — tens of times a second while
   * drawing. Handing out a fresh object each time made every one of those a
   * React state change in the room, re-rendering the whole subtree: the same
   * storm that starved the receiving peer, reintroduced through the viewport.
   * A pan or a zoom is rare; a pointer sample is not.
   */
  const lastViewportRef = useRef<CanvasViewport | null>(null);
  const publishViewport = useCallback(() => {
    const api = apiRef.current;
    if (!api?.getAppState) return;
    try {
      const next = viewportFromAppState(api.getAppState());
      const previous = lastViewportRef.current;
      if (
        previous
        && previous.scrollX === next.scrollX
        && previous.scrollY === next.scrollY
        && previous.zoom === next.zoom
        && previous.offsetLeft === next.offsetLeft
        && previous.offsetTop === next.offsetTop
      ) {
        return;
      }
      lastViewportRef.current = next;
      onViewportChange(next);
    } catch {
      // A viewport read must never interrupt drawing.
    }
  }, [onViewportChange]);

  const handlePointerDown = useCallback(() => {
    isPointerDownRef.current = true;
  }, []);

  const handlePointerUp = useCallback(() => {
    isPointerDownRef.current = false;
    // Cancel any pending trailing commit and publish the finished stroke now,
    // so the last sample is never left sitting behind the throttle.
    if (strokeTrailingTimerRef.current !== null) {
      window.clearTimeout(strokeTrailingTimerRef.current);
      strokeTrailingTimerRef.current = null;
    }
    strokeCommitAtRef.current = 0;
    const api = apiRef.current;
    if (api) {
      try {
        const finalElements = api.getSceneElements();
        // Same guard handleElementsChange applies: Excalidraw reports a
        // transient empty scene in places, and publishing that would wipe a
        // board that still has content. A real clear goes through its own path.
        const wouldWipe = finalElements.length === 0
          && lastSyncedElementsRef.current.length > 0;
        if (!wouldWipe) commitElements(finalElements, true);
      } catch {
        // A failed final publish must not wedge the pointer state.
      }
    }
    // Flush the scene the stroke produced, so the empty-board check and the
    // deferred React state hop see the finished result exactly once.
    const deferred = deferredElementsRef.current;
    if (deferred) {
      deferredElementsRef.current = null;
      onElementsChange(deferred);
    }
  }, [commitElements, onElementsChange]);

  if (!isClient) {
    return <div className="w-full h-full min-h-[25rem]" />;
  }

  return (
    <div
      className="w-full h-full min-h-[25rem]"
      data-whiteboard-role={isLocalHost ? 'host' : 'peer'}
    >
      <Excalidraw
        excalidrawAPI={handleAPI}
        onChange={(el: any, appState: any) => { handleElementsChange(el, appState); publishViewport(); }}
        onPointerUpdate={handlePointerUpdate}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
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
