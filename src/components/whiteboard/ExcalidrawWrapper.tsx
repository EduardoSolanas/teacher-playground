'use client';

import { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { diffScene, shouldPublish, elementsToPublish } from '@/lib/whiteboard/scenePublish';
// MUST stay above the Excalidraw import: it sets EXCALIDRAW_ASSET_PATH, and ES
// module imports are evaluated in order, before this module's own body runs.
import '@/lib/whiteboard/excalidrawAssetPath';
import { CaptureUpdateAction, Excalidraw } from '@teacher-playground/excalidraw';
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  NormalizedZoomValue,
  SocketId,
} from '@teacher-playground/excalidraw/types';
import type { ExcalidrawElement } from '@teacher-playground/excalidraw/element/types';
import '@teacher-playground/excalidraw/index.css';
import * as Y from 'yjs';
import {
  excalidrawElementsEqual,
  serializeExcalidrawElements,
  toExcalidrawToolType,
} from '@/lib/whiteboard/excalidrawSync';
import { reconcileRemoteElements } from '@/lib/whiteboard/excalidrawReconcile';
import { getElementsFromArray, replaceSharedElements } from '@/lib/whiteboard/yjsDoc';
import { collaboratorsFromPresence } from '@/lib/whiteboard/collaborators';
import type { CanvasElement, RemoteCursor, WhiteboardUser } from '@/types/whiteboard';
import type { FollowMessage } from '@/lib/whiteboard/followMessage';
import {
  isWhiteboardLatencyProbeEnabled,
  isWhiteboardIncrementComparisonEnabled,
  isWhiteboardIncrementSyncEnabled,
  recordWhiteboardLatencyEvent,
} from '@/lib/whiteboard/latencyProbe';
import {
  formatIncrementComparisonWarning,
  incrementSceneChange,
  isRemoteIncrement,
  publishCandidatesEqual,
  updateVersionBaselineFromIncrement,
} from '@/lib/whiteboard/incrementSync';
import type {
  PublishCandidate,
  StoreIncrementEventLike,
} from '@/lib/whiteboard/incrementSync';
import { bytesToDataURL, dataURLToBytes, filesToUpload, isAllowedMimeType } from '@/lib/whiteboard/boardFiles';
import { ajaxFetch } from '@/lib/http/ajaxFetch';

type SharedSceneElement = Record<string, unknown>;
type ExcalidrawOnChange = NonNullable<ExcalidrawProps['onChange']>;
type ExcalidrawPointerUpdate = NonNullable<ExcalidrawProps['onPointerUpdate']>;
type ExcalidrawChangeElements = Parameters<ExcalidrawOnChange>[0];
type ExcalidrawChangeAppState = Parameters<ExcalidrawOnChange>[1];
type ExcalidrawChangeFiles = Parameters<ExcalidrawOnChange>[2];
type ExcalidrawPointerPayload = Parameters<ExcalidrawPointerUpdate>[0];
type ExcalidrawTool = Parameters<ExcalidrawImperativeAPI['setActiveTool']>[0]['type'];
type ExcalidrawStandardTool = Exclude<ExcalidrawTool, 'custom'>;
type ExcalidrawSubscriptionsAPI = ExcalidrawImperativeAPI & {
  onIncrement?: (callback: (event: StoreIncrementEventLike) => void) => () => void;
  onToolChange?: (callback: (tool: { type: string }) => void) => () => void;
};

function toExcalidrawElements(
  elements: readonly SharedSceneElement[],
): readonly ExcalidrawElement[] {
  return elements as unknown as readonly ExcalidrawElement[];
}

function toCanvasElements(elements: readonly SharedSceneElement[]): CanvasElement[] {
  return elements as unknown as CanvasElement[];
}

function toSharedSceneElements(elements: readonly unknown[]): SharedSceneElement[] {
  return elements as SharedSceneElement[];
}

function toExcalidrawActiveTool(tool: string): { type: ExcalidrawStandardTool } {
  return { type: toExcalidrawToolType(tool) as ExcalidrawStandardTool };
}

const APP_TOOL_BY_EXCALIDRAW_TOOL: Record<string, string> = {
  selection: 'select',
  rectangle: 'rectangle',
  diamond: 'diamond',
  ellipse: 'circle',
  arrow: 'arrow',
  line: 'line',
  freedraw: 'pen',
  text: 'text',
  image: 'image',
  eraser: 'eraser',
  hand: 'hand',
  frame: 'frame',
  magicframe: 'magicframe',
  embeddable: 'embeddable',
  laser: 'laser',
};

function toAppToolType(tool: string): string {
  return APP_TOOL_BY_EXCALIDRAW_TOOL[tool] ?? tool;
}

declare global {
  interface Window {
    __debugExcalidrawApi?: ExcalidrawImperativeAPI;
  }
}

type ExcalidrawWrapperProps = {
  roomId: string;
  userName: string;
  localPeerId: string;
  yDoc: Y.Doc | null;
  yElementsArray: Y.Array<Y.Map<unknown>> | null;
  users: WhiteboardUser[];
  cursors: RemoteCursor[];
  activeTool: string;
  isLocalHost: boolean;
  onToolChange: (tool: string) => void;
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
  /** The room's stored view, applied once when the board opens. */
  initialViewport: { x: number; y: number; zoom: number } | null;
  /** Local pointer, in scene coordinates. */
  onCursorMove: (sceneX: number, sceneY: number, button?: 'up' | 'down') => void;
  onElementsChange: (elements: CanvasElement[]) => void;
  hostPeerId: string | null;
  guideMessage: FollowMessage | null;
  isGuiding: boolean;
  onGuideViewport: (viewport: { x: number; y: number; zoom: number }) => void;
};

export default function ExcalidrawWrapper({
  roomId,
  userName,
  localPeerId,
  yDoc,
  yElementsArray,
  users,
  cursors,
  activeTool,
  isLocalHost,
  onToolChange,
  onViewportChange,
  initialViewport,
  onCursorMove,
  onElementsChange,
  hostPeerId,
  guideMessage,
  isGuiding,
  onGuideViewport,
}: ExcalidrawWrapperProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const isPointerDownRef = useRef(false);
  const activeToolRef = useRef(activeTool);
  const lastSyncedElementsRef = useRef<SharedSceneElement[]>([]);
  const lastPublishedIdsRef = useRef<string[]>([]);
  /** id -> Excalidraw `version` at the last publish, for O(changed) diffing. */
  const publishedVersionsRef = useRef<Map<string, number>>(new Map());
  const latestViewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  const guideSendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guideActiveRef = useRef(false);
  const followOptedOutRef = useRef(false);
  const applyingGuideRef = useRef(false);
  const previousIsGuidingRef = useRef(false);
  const followUnsubscribeRef = useRef<(() => void) | null>(null);
  const incrementUnsubscribeRef = useRef<(() => void) | null>(null);
  const toolUnsubscribeRef = useRef<(() => void) | null>(null);
  const commitElementsRef = useRef<
    ((elements: readonly ExcalidrawElement[], force?: boolean) => void) | null
  >(null);
  /*
   * Image bytes do not travel in the document -- an element carries only a
   * fileId and the bytes go to the room's store -- so each side of that is
   * tracked here. Marked before the request rather than after, because
   * onChange fires about twenty times a second while drawing and would
   * otherwise send the same picture on every one of them.
   */
  const uploadedFileIdsRef = useRef<Set<string>>(new Set());
  const fetchingFileIdsRef = useRef<Set<string>>(new Set());

  /**
   * Adopt a scene that arrived from a peer as the publish baseline.
   *
   * Without this the version map still describes the pre-remote scene, so the
   * next local commit would see every remote element as "changed" and publish
   * it straight back — peers echoing each other's work.
   */
  const adoptVersionBaseline = useCallback((
    elements: readonly SharedSceneElement[],
    remoteElements?: readonly SharedSceneElement[],
  ) => {
    const remoteById = new Map<string, SharedSceneElement>();
    const remoteVersions = new Map<string, number>();
    if (remoteElements) {
      for (const remoteElement of remoteElements) {
        const id = (remoteElement as { id?: unknown })?.id;
        if (typeof id !== 'string' || id.length === 0) continue;
        remoteById.set(id, remoteElement);
        const version = (remoteElement as { version?: unknown }).version;
        remoteVersions.set(id, typeof version === 'number' ? version : 0);
      }
    }

    const versions = new Map<string, number>();
    for (const element of elements) {
      const id = (element as { id?: unknown })?.id;
      if (typeof id !== 'string' || id.length === 0) continue;

      /*
       * An element the remote scene did not contain is ours and unsent.
       *
       * Reconciliation keeps a pointer-down local-only element in the scene,
       * so the result can include anything drawn here that has not
       * round-tripped yet. Recording those as published would claim they had
       * been sent when they had not, and a peer's shape could disappear while
       * it was still in flight.
       */
      if (remoteElements && !remoteVersions.has(id)) {
        const previous = publishedVersionsRef.current.get(id);
        if (previous !== undefined) versions.set(id, previous);
        continue;
      }

      const sceneVersion = (element as { version?: unknown }).version;
      const remoteElement = remoteById.get(id);
      const remoteVersion = remoteVersions.get(id);
      const sameVersionDifferentPayload = remoteElements
        && remoteElement
        && typeof sceneVersion === 'number'
        && sceneVersion === remoteVersion
        && JSON.stringify(serializeExcalidrawElements([element]))
          !== JSON.stringify(serializeExcalidrawElements([remoteElement]));
      const version = sameVersionDifferentPayload
        ? sceneVersion - 1
        : (remoteElements ? remoteVersion : sceneVersion);
      versions.set(id, typeof version === 'number' ? version : 0);
    }
    publishedVersionsRef.current = versions;
  }, []);
  /** Latest onElementsChange, so the unmount flush needs no dependency on it. */
  const onElementsChangeRef = useRef(onElementsChange);
  useEffect(() => { onElementsChangeRef.current = onElementsChange; }, [onElementsChange]);

  /** Remote scenes coalesce into one React update rather than ~20 a second. */
  const REMOTE_STATE_FLUSH_MS = 200;
  const REMOTE_REPUBLISH_DEBOUNCE_MS = 50;
  const pendingRemoteStateRef = useRef<SharedSceneElement[] | null>(null);
  const remoteStateTimerRef = useRef<number | null>(null);
  const remoteRepublishEpochRef = useRef(0);
  const remoteRepublishTimerRef = useRef<number | null>(null);
  /** Every element id the room has ever shown this peer. */
  const seenRemoteIdsRef = useRef<Set<string>>(new Set());
  const pendingElementsRef = useRef<SharedSceneElement[] | null>(null);
  /** Scene captured mid-stroke, flushed to React state on pointer up. */
  const deferredElementsRef = useRef<SharedSceneElement[] | null>(null);
  const hasAcceptedInitialSceneRef = useRef(false);
  const localPeerIdRef = useRef(localPeerId);
  localPeerIdRef.current = localPeerId;

  const collaborators = useMemo(
    () => collaboratorsFromPresence(users, cursors, localPeerId),
    [users, cursors, localPeerId],
  );

  useEffect(() => {
    const api = apiRef.current;
    if (!apiReady || !api) return;

    try {
      api.updateScene({
        collaborators,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (isWhiteboardLatencyProbeEnabled()) {
        window.requestAnimationFrame(() => {
          for (const cursor of cursors) {
            recordWhiteboardLatencyEvent({
              kind: 'cursor-render',
              peerId: cursor.peerId,
              x: cursor.x,
              y: cursor.y,
            });
          }
        });
      }
    } catch {
      // A presence render must never interrupt drawing.
    }
  }, [apiReady, collaborators, cursors]);


  /**
   * Sends one image to the room's store.
   *
   * Fire and forget: a slow or failed upload must never hold up a stroke. The
   * id is marked before the request so a burst of onChange calls sends the
   * picture once, and un-marked on failure -- leaving the mark in place would
   * strand the image for good and every peer would show a broken picture for
   * the rest of the lesson.
   */
  const uploadBoardFile = useCallback(
    async (fileId: string, dataUrl: string) => {
      try {
        const converted = dataURLToBytes(dataUrl);
        if (!converted || !isAllowedMimeType(converted.mimeType)) return;
        const response = await ajaxFetch(
          `/api/whiteboard/room/${roomId}/files/${fileId}`,
          {
            method: 'PUT',
            body: converted.bytes as unknown as BodyInit,
            headers: { 'content-type': converted.mimeType },
          },
        );
        if (!response.ok) uploadedFileIdsRef.current.delete(fileId);
      } catch {
        uploadedFileIdsRef.current.delete(fileId);
      }
    },
    [roomId],
  );

  /**
   * Fetches an image this peer was never sent.
   *
   * A peer that joins after a picture was added receives the element over the
   * document but not the bytes, so it has to notice the fileId it does not hold
   * and ask for it. Lazy on purpose: a slow image must not stall drawing.
   */
  const fetchBoardFile = useCallback(
    async (fileId: string) => {
      if (fetchingFileIdsRef.current.has(fileId)) return;
      fetchingFileIdsRef.current.add(fileId);
      try {
        const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/files/${fileId}`);
        if (!response.ok) return;
        const mimeType = response.headers.get('content-type');
        if (!mimeType || !isAllowedMimeType(mimeType)) return;
        const bytes = new Uint8Array(await response.arrayBuffer());
        apiRef.current?.addFiles([{
          id: fileId,
          dataURL: bytesToDataURL(bytes, mimeType),
          mimeType,
          created: Date.now(),
        }] as never);
      } catch {
        // The next scene carrying this element asks again.
      } finally {
        fetchingFileIdsRef.current.delete(fileId);
      }
    },
    [roomId],
  );

  /** Asks for any image referenced by the scene that this peer does not hold. */
  const fetchMissingBoardFiles = useCallback((elements: readonly unknown[]) => {
    const api = apiRef.current;
    if (!api) return;
    const held = api.getFiles?.() ?? {};
    for (const element of elements) {
      const fileId = (element as { fileId?: unknown } | null)?.fileId;
      if (typeof fileId !== 'string' || fileId.length === 0) continue;
      if (held[fileId] || fetchingFileIdsRef.current.has(fileId)) continue;
      void fetchBoardFile(fileId);
    }
  }, [fetchBoardFile]);

  const applyRemoteElements = useCallback((remoteElements: SharedSceneElement[]) => {
    remoteRepublishEpochRef.current += 1;
    const republishEpoch = remoteRepublishEpochRef.current;
    if (remoteRepublishTimerRef.current !== null) {
      window.clearTimeout(remoteRepublishTimerRef.current);
      remoteRepublishTimerRef.current = null;
    }

    // The elements arrive over the document; the bytes never do.
    fetchMissingBoardFiles(remoteElements);
    const shouldRecordRemoteRender =
      isWhiteboardLatencyProbeEnabled() && hasAcceptedInitialSceneRef.current;
    for (const element of remoteElements) {
      const id = (element as { id?: unknown })?.id;
      if (typeof id === 'string' && id.length > 0) {
        seenRemoteIdsRef.current.add(id);
      }
    }

    const localElements = apiRef.current?.getSceneElements?.() ?? [];

    /*
     * Reconcile through Excalidraw's own multiplayer merge. Known local ids
     * are included so a newer in-progress edit wins over a stale remote frame.
     * Local-only ids are included only while a pointer is down and only when
     * they have never reached the shared document; this keeps a remote clear
     * authoritative while still protecting a stroke that is in flight.
     */
    const sceneToApply = reconcileRemoteElements(
      localElements,
      remoteElements,
      apiRef.current?.getAppState?.() ?? {},
      {
        isPointerDown: isPointerDownRef.current,
        seenRemoteIds: seenRemoteIdsRef.current,
        lastPublishedIds: lastPublishedIdsRef.current,
      },
    );
    const remoteById = new Map<string, SharedSceneElement>();
    for (const element of remoteElements) {
      const id = (element as { id?: unknown })?.id;
      if (typeof id !== 'string' || id.length === 0) continue;
      remoteById.set(id, element);
    }
    let republishDelayMs: number | null = null;
    if (isWhiteboardIncrementSyncEnabled()) {
      for (const element of sceneToApply) {
        const id = (element as { id?: unknown })?.id;
        if (typeof id !== 'string' || id.length === 0) continue;
        const remoteElement = remoteById.get(id);
        if (!remoteElement) continue;
        const sceneVersion = (element as { version?: unknown }).version;
        const remoteVersion = (remoteElement as { version?: unknown }).version;
        const payloadChanged =
          JSON.stringify(serializeExcalidrawElements([element]))
          !== JSON.stringify(serializeExcalidrawElements([remoteElement]));
        if (!payloadChanged) continue;
        republishDelayMs =
          typeof sceneVersion === 'number'
          && typeof remoteVersion === 'number'
          && remoteVersion < sceneVersion
            ? 0
            : REMOTE_REPUBLISH_DEBOUNCE_MS;
        break;
      }
    }

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
        if (pending) onElementsChange(toCanvasElements(pending));
      }, REMOTE_STATE_FLUSH_MS);
    }

    /*
     * Adopt what actually lands in the scene, not what arrived on the wire.
     * Reconciliation can renumber versions, and a baseline taken from the raw
     * remote scene would then read every reconciled element as locally changed
     * and publish it straight back.
     */
    adoptVersionBaseline(sceneToApply, remoteElements);

    if (apiRef.current) {
      try {
        apiRef.current.updateScene({
          elements: toExcalidrawElements(sceneToApply),
          captureUpdate: CaptureUpdateAction.NEVER,
          source: 'remote',
        });
        // Reconciliation can retain a newer local element over a stale remote
        // frame. With increment sync enabled, that remote update emits no
        // increment, so publish the reconciled winner through the legacy diff
        // only after the current remote turn settles, and cancel it if a newer
        // remote scene arrives first.
        if (republishDelayMs !== null) {
          remoteRepublishTimerRef.current = window.setTimeout(() => {
            remoteRepublishTimerRef.current = null;
            if (republishEpoch !== remoteRepublishEpochRef.current) return;
            commitElementsRef.current?.(toExcalidrawElements(sceneToApply));
          }, republishDelayMs);
        }

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
  }, [adoptVersionBaseline, onElementsChange, fetchMissingBoardFiles]);

  useEffect(() => {
    setIsClient(true);
    return () => {
      // Flush any coalesced remote scene, so leaving a room cannot drop the
      // last change from the empty-board check or the deferred React state hop.
      if (remoteStateTimerRef.current !== null) {
        window.clearTimeout(remoteStateTimerRef.current);
        remoteStateTimerRef.current = null;
      }
      if (remoteRepublishTimerRef.current !== null) {
        window.clearTimeout(remoteRepublishTimerRef.current);
        remoteRepublishTimerRef.current = null;
      }
      const pendingRemote = pendingRemoteStateRef.current;
      pendingRemoteStateRef.current = null;
      if (pendingRemote) onElementsChangeRef.current(toCanvasElements(pendingRemote));

      if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
        if (window.__debugExcalidrawApi === apiRef.current) {
          delete window.__debugExcalidrawApi;
        }
      }
    };
  }, []);

  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  useEffect(() => {
    if (!yDoc || !yElementsArray) return;

    const elementsArray = yElementsArray;

    // Listen only for element changes. Cursor/awareness updates must not rewrite
    // the Excalidraw scene.
    const handler = (_events: Y.YEvent<Y.Map<unknown>>[], transaction: Y.Transaction) => {
      if (transaction.origin === 'local') return;

      /*
       * The one reader, not a second copy of it.
       *
       * This loop used to lift values straight out of the Yjs map, which
       * silently stopped working the day `points` began arriving encoded: the
       * canvas was handed a Uint8Array it cannot draw, and a peer's strokes
       * simply never appeared. getElementsFromArray decodes every stored form.
       */
      const remoteElements = toSharedSceneElements(getElementsFromArray(elementsArray));

      const same = excalidrawElementsEqual(remoteElements, lastSyncedElementsRef.current);
      if (same) return;
      lastSyncedElementsRef.current = remoteElements;
      applyRemoteElements(remoteElements);
    };

    elementsArray.observeDeep(handler);

    return () => {
      elementsArray.unobserveDeep(handler);
    };
  }, [yDoc, yElementsArray, roomId, applyRemoteElements, adoptVersionBaseline]);

  /** Snapshot of the shared document as plain Excalidraw elements. */
  const readSharedElements = useCallback((): SharedSceneElement[] => {
    if (!yElementsArray) return [];
    // Through the shared reader, never by copying the map directly: `points`
    // is stored encoded and has to be decoded before it reaches the canvas.
    return toSharedSceneElements(getElementsFromArray(yElementsArray));
  }, [yElementsArray]);

  /*
   * Applied once, never on later changes.
   *
   * The stored view arrives with the room load, and the API poll can bring it
   * round again while a lesson is running. Re-applying it then would drag the
   * canvas out from under whoever is drawing, so the first one wins.
   */
  const appliedStoredViewRef = useRef(false);
  useEffect(() => {
    if (appliedStoredViewRef.current || !apiReady) return;
    const api = apiRef.current;
    if (!api || !initialViewport) return;
    const { x, y, zoom } = initialViewport;
    latestViewportRef.current = { x, y, zoom };
    if (x === 0 && y === 0 && zoom === 1) return;
    appliedStoredViewRef.current = true;
    try {
      api.updateScene({
        appState: {
          scrollX: x,
          scrollY: y,
          zoom: { value: zoom as NormalizedZoomValue },
        },
      });
    } catch {
      // A stored view must never stop the board from opening.
    }
  }, [initialViewport, apiReady]);

  const handleAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    followUnsubscribeRef.current?.();
    followUnsubscribeRef.current = null;
    apiRef.current = api;

    if (typeof api.onUserFollow === 'function') {
      followUnsubscribeRef.current = api.onUserFollow((payload) => {
        if (payload?.action === 'UNFOLLOW' && !applyingGuideRef.current) {
          followOptedOutRef.current = true;
        }
      });
    }

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
        api.updateScene({
          elements: toExcalidrawElements(serializeExcalidrawElements(shared)),
          captureUpdate: CaptureUpdateAction.NEVER,
          source: 'remote',
        });
      } catch {
        // A malformed stored scene must not stop the board from opening.
      }
    }, 100);

    // E2E runs against a production build, so the handle is also exposed when
    // the build is explicitly flagged for testing. Real deploys leave it off.
    const exposeDebugApi =
      process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_E2E === '1';
    if (exposeDebugApi && typeof window !== 'undefined') {
      window.__debugExcalidrawApi = api;
    }

    if (pendingElementsRef.current) {
      const queuedElements = pendingElementsRef.current;
      pendingElementsRef.current = null;
      try {
        api.updateScene({
          elements: toExcalidrawElements(queuedElements),
          captureUpdate: CaptureUpdateAction.NEVER,
          source: 'remote',
        });
      } catch {
        // ignore
      }
    }

    setTimeout(() => {
      if (apiRef.current && activeToolRef.current) {
        try {
          apiRef.current.setActiveTool(toExcalidrawActiveTool(activeToolRef.current));
        } catch {
          // ignore
        }
      }
    }, 100);
  }, [adoptVersionBaseline, readSharedElements]);

  useEffect(() => {
    if (!apiRef.current || !activeTool) return;
    try {
      apiRef.current.setActiveTool(toExcalidrawActiveTool(activeTool));
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

  const publishScene = useCallback(
    (scene: readonly unknown[], candidate: PublishCandidate) => {
      const serializedElements = serializeExcalidrawElements(scene);
      const payload = serializeExcalidrawElements(candidate.elements);
      const previousIds = lastPublishedIdsRef.current;

      lastSyncedElementsRef.current = serializedElements;
      lastPublishedIdsRef.current = serializedElements
        .map((element) => element.id)
        .filter((id): id is string => typeof id === 'string');

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
        onElementsChange(toCanvasElements(serializedElements));
      }

      if (!yDoc || !yElementsArray) return;

      const shouldRecordLatency = isWhiteboardLatencyProbeEnabled();
      try {
        if (candidate.wholeScene) {
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
          for (const element of payload) {
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
    },
    [yDoc, yElementsArray, onElementsChange],
  );

  const commitElements = useCallback(
    (el: readonly ExcalidrawElement[], force = false) => {
      hasAcceptedInitialSceneRef.current = true;

      // Excalidraw stamps every element with a monotonic `version`, so what
      // changed can be found by comparing numbers on the RAW elements. The old
      // check serialized the whole scene and JSON.stringify'd it twice — on a
      // board of any size that dominated the drawing path.
      const diff = diffScene(publishedVersionsRef.current, el);
      if (!shouldPublish(diff, force)) return;

      const serializedElements = serializeExcalidrawElements(el);
      publishedVersionsRef.current = diff.nextVersions;
      publishScene(serializedElements, elementsToPublish(serializedElements, diff));
    },
    [publishScene],
  );
  commitElementsRef.current = commitElements;

  const commitIncrement = useCallback(
    (event: StoreIncrementEventLike) => {
      if (isRemoteIncrement(event)) return;

      // Store emits while updateScene is still committing. Waiting one
      // microtask lets the editor replace its scene before we read it, so an
      // added element is not mistaken for an empty increment.
      queueMicrotask(() => {
        const api = apiRef.current;
        if (!api) return;

        const scene = api.getSceneElements();
        const incrementCandidate = incrementSceneChange(event, scene);
        let legacyCandidate: PublishCandidate | null = null;

        if (isWhiteboardIncrementComparisonEnabled()) {
          const legacyDiff = diffScene(publishedVersionsRef.current, scene);
          legacyCandidate = elementsToPublish(scene, legacyDiff);
          if (!publishCandidatesEqual(legacyCandidate, incrementCandidate)) {
            console.warn(formatIncrementComparisonWarning(legacyCandidate, incrementCandidate));
          }
        }

        if (!isWhiteboardIncrementSyncEnabled()) return;
        if (!incrementCandidate.wholeScene && incrementCandidate.elements.length === 0) return;

        const serializedScene = serializeExcalidrawElements(scene);
        publishedVersionsRef.current = updateVersionBaselineFromIncrement(
          publishedVersionsRef.current,
          event,
          serializedScene,
        );
        publishScene(
          serializedScene,
          incrementCandidate.wholeScene
            ? { elements: serializedScene, wholeScene: true }
            : {
                elements: serializeExcalidrawElements(incrementCandidate.elements),
                wholeScene: false,
              },
        );
      });
    },
    [publishScene],
  );

  const handleElementsChange = useCallback(
    (el: ExcalidrawChangeElements, _appState: ExcalidrawChangeAppState, files?: ExcalidrawChangeFiles) => {
      // The bytes are Excalidraw's to hand over and nobody else's: this is the
      // only place a pasted image is seen before it would be lost on reload.
      if (files) {
        for (const fileId of filesToUpload(files, uploadedFileIdsRef.current)) {
          const file = files[fileId];
          if (!file) continue;
          uploadedFileIdsRef.current.add(fileId);
          void uploadBoardFile(fileId, file.dataURL as unknown as string);
        }
      }

      // Store increments cover committed changes. Keep the existing onChange
      // path only while a pointer is down, because the fork's history store
      // may deliberately omit the ephemeral partial stroke from its snapshot.
      if (isWhiteboardIncrementSyncEnabled() && !isPointerDownRef.current) return;

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
    [commitElements, uploadBoardFile],
  );

  useEffect(() => {
    if (!apiReady || !apiRef.current) return;

    const api = apiRef.current as ExcalidrawSubscriptionsAPI;
    incrementUnsubscribeRef.current?.();
    toolUnsubscribeRef.current?.();
    incrementUnsubscribeRef.current = api.onIncrement?.(commitIncrement) ?? null;
    toolUnsubscribeRef.current = api.onToolChange?.((tool) => {
      onToolChange(toAppToolType(tool.type));
    }) ?? null;

    return () => {
      incrementUnsubscribeRef.current?.();
      incrementUnsubscribeRef.current = null;
      toolUnsubscribeRef.current?.();
      toolUnsubscribeRef.current = null;
    };
  }, [apiReady, commitIncrement, onToolChange]);

  useEffect(() => () => {
    incrementUnsubscribeRef.current?.();
    toolUnsubscribeRef.current?.();
    if (strokeTrailingTimerRef.current !== null) window.clearTimeout(strokeTrailingTimerRef.current);
  }, []);

  /*
   * Excalidraw hands us the pointer already in scene space, the only frame two
   * peers share. Forward its button state to the collaboration transport.
   */
  const handlePointerUpdate = useCallback((payload: ExcalidrawPointerPayload) => {
    const { pointer } = payload;
    const x = typeof pointer.x === 'number' ? pointer.x : null;
    const y = typeof pointer.y === 'number' ? pointer.y : null;
    if (x === null || y === null) return;
    onCursorMove(x, y, payload?.button === 'down' ? 'down' : 'up');
  }, [onCursorMove]);

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
      onElementsChange(toCanvasElements(deferred));
    }
  }, [commitElements, onElementsChange]);

  useEffect(() => () => {
    followUnsubscribeRef.current?.();
    if (guideSendTimeoutRef.current) clearTimeout(guideSendTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!apiReady || !apiRef.current) return;
    if (isGuiding && !previousIsGuidingRef.current) {
      const state = apiRef.current.getAppState?.();
      const viewport = state
        ? { x: state.scrollX, y: state.scrollY, zoom: state.zoom.value }
        : latestViewportRef.current;
      latestViewportRef.current = viewport;
      onGuideViewport(viewport);
    }
    if (!isGuiding && previousIsGuidingRef.current) {
      guideActiveRef.current = false;
    }
    previousIsGuidingRef.current = isGuiding;
  }, [apiReady, isGuiding, onGuideViewport]);

  useEffect(() => {
    const api = apiRef.current;
    const host = users.find((user) => user.isHost);
    const followPeerId = host?.peerId ?? hostPeerId;
    if (!api || !guideMessage || !followPeerId || followPeerId === localPeerId) return;
    if (!guideMessage.active) {
      guideActiveRef.current = false;
      followOptedOutRef.current = false;
      applyingGuideRef.current = true;
      api.updateScene({
        appState: { userToFollow: null },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setTimeout(() => { applyingGuideRef.current = false; }, 0);
      return;
    }
    if (!guideActiveRef.current) {
      guideActiveRef.current = true;
      followOptedOutRef.current = false;
    }
    if (followOptedOutRef.current) return;
    applyingGuideRef.current = true;
    const currentUserToFollow = api.getAppState?.().userToFollow;
    const userToFollow = currentUserToFollow?.socketId === followPeerId
      ? currentUserToFollow
      : {
          socketId: followPeerId as SocketId,
          username: host?.userName ?? 'Teacher',
        };
    api.updateScene({
      appState: {
        userToFollow,
        scrollX: guideMessage.viewport.x,
        scrollY: guideMessage.viewport.y,
        zoom: { value: guideMessage.viewport.zoom as NormalizedZoomValue },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setTimeout(() => { applyingGuideRef.current = false; }, 0);
  }, [apiReady, guideMessage, hostPeerId, localPeerId, users]);

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
        onChange={(el, appState, files) => { handleElementsChange(el, appState, files); }}
        onPointerUpdate={handlePointerUpdate}
        onScrollChange={(scrollX, scrollY, zoom) => {
          const viewport = { x: scrollX, y: scrollY, zoom: zoom.value };
          latestViewportRef.current = viewport;
          onViewportChange(viewport);
          if (isGuiding) {
            if (guideSendTimeoutRef.current) clearTimeout(guideSendTimeoutRef.current);
            guideSendTimeoutRef.current = setTimeout(() => {
              guideSendTimeoutRef.current = null;
              onGuideViewport(latestViewportRef.current);
            }, 50);
          }
        }}
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
