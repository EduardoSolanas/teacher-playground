'use client';

import { useCallback, useRef, useEffect, useMemo, useState, type ReactNode } from 'react';
import { diffScene, shouldPublish, elementsToPublish } from '@/lib/whiteboard/scenePublish';
import { livePointCount, strokeCommitIntervalMs } from '@/lib/whiteboard/strokeCadence';
// MUST stay above the Excalidraw import: it sets EXCALIDRAW_ASSET_PATH, and ES
// module imports are evaluated in order, before this module's own body runs.
import '@/lib/whiteboard/excalidrawAssetPath';
import { CaptureUpdateAction, Excalidraw, Footer } from '@teacher-playground/excalidraw';
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
  isMappedAppTool,
} from '@/lib/whiteboard/excalidrawSync';
import { reconcileRemoteElements } from '@/lib/whiteboard/excalidrawReconcile';
import { getElementsFromArray, replaceSharedElements } from '@/lib/whiteboard/yjsDoc';
import { snapshotElements } from '@/lib/whiteboard/sceneSnapshot';
import { libraryFileIds } from '@/lib/whiteboard/roomLibrary';
import { collaboratorsFromPresence } from '@/lib/whiteboard/collaborators';
import type { CanvasElement, RemoteCursor, WhiteboardUser } from '@/types/whiteboard';
import type { FollowMessage } from '@/lib/whiteboard/followMessage';
import type { BoardFileEntry } from '@/lib/whiteboard/boardExport';
import {
  isWhiteboardLatencyProbeEnabled,
  recordWhiteboardLatencyEvent,
} from '@/lib/whiteboard/latencyProbe';
import { bytesToDataURL, dataURLToBytes, filesToUpload, isAllowedMimeType } from '@/lib/whiteboard/boardFiles';
import { ajaxFetch } from '@/lib/http/ajaxFetch';

type SharedSceneElement = Record<string, unknown>;
/** What `elementsToPublish` hands back: the delta, or the whole scene. */
type PublishCandidate = { elements: readonly unknown[]; wholeScene: boolean };
type ExcalidrawOnChange = NonNullable<ExcalidrawProps['onChange']>;
type ExcalidrawPointerUpdate = NonNullable<ExcalidrawProps['onPointerUpdate']>;
type ExcalidrawChangeElements = Parameters<ExcalidrawOnChange>[0];
type ExcalidrawChangeAppState = Parameters<ExcalidrawOnChange>[1];
type ExcalidrawChangeFiles = Parameters<ExcalidrawOnChange>[2];
type ExcalidrawPointerPayload = Parameters<ExcalidrawPointerUpdate>[0];
type ExcalidrawTool = Parameters<ExcalidrawImperativeAPI['setActiveTool']>[0]['type'];
type ExcalidrawStandardTool = Exclude<ExcalidrawTool, 'custom'>;

/**
 * The handful of board actions the room's own title menu drives.
 *
 * A small object rather than the editor itself, so nothing above has to import
 * from `@teacher-playground/excalidraw`: this component sits behind
 * `dynamic()` precisely to keep that package out of the room's first chunk,
 * and a type import from the caller would quietly undo it.
 */
export interface BoardActions {
  /** The scene as it stands, for the room to write to a file. */
  readScene: () => { elements: readonly unknown[]; files: readonly BoardFileEntry[] };
  /** Opens Excalidraw's library, which used to have a button floating on the canvas. */
  openLibrary: () => void;
}
type ExcalidrawSubscriptionsAPI = ExcalidrawImperativeAPI & {
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
  /**
   * Room controls to sit in Excalidraw's own footer, beside the zoom.
   *
   * Passed in rather than built here, because they belong to the room and not
   * to the canvas -- this component only knows where the footer is. Excalidraw
   * puts it bottom left, which is where a hand already goes for the zoom.
   */
  footer?: ReactNode;
  /** Receives the board actions once the editor exists, and null when it goes. */
  onBoardActions?: (actions: BoardActions | null) => void;
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
  footer,
  onBoardActions,
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
  /** Files this room answered 404 for: asked once, not on every change. */
  const missingFileIdsRef = useRef<Set<string>>(new Set());

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

  /** Latest onBoardActions, so the unmount release needs no dependency on it. */
  const onBoardActionsRef = useRef(onBoardActions);
  useEffect(() => { onBoardActionsRef.current = onBoardActions; }, [onBoardActions]);

  /** Remote scenes coalesce into one React update rather than ~20 a second. */
  const REMOTE_STATE_FLUSH_MS = 200;
  const pendingRemoteStateRef = useRef<SharedSceneElement[] | null>(null);
  const remoteStateTimerRef = useRef<number | null>(null);
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
   *
   * The editor hands over WebP already: the fork converts an inserted image at
   * ingest, so what arrives here is what belongs in the bucket. This used to
   * convert as well, and re-encoding a WebP into a WebP only spends quality.
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
      /*
       * A picture the room does not have is not a picture that is late.
       *
       * This runs on every scene change, so without remembering the answer a
       * 404 is asked again, and again, for as long as the board is open: an
       * element referencing a file this room never held -- a scene brought in
       * from somewhere else, whose bytes stayed behind -- produced a request
       * per change and filled a teacher's console with hundreds of identical
       * failures.
       *
       * Only a 404 is remembered. It is the one answer that says the file is
       * not here rather than that the asking went wrong: a network failure or
       * a 5xx is worth another go on the next change, and a 403 means the
       * grant is not in place yet and may be a moment later.
       */
      if (missingFileIdsRef.current.has(fileId)) return;
      fetchingFileIdsRef.current.add(fileId);
      try {
        const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/files/${fileId}`);
        if (response.status === 404) {
          missingFileIdsRef.current.add(fileId);
          return;
        }
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
      const pendingRemote = pendingRemoteStateRef.current;
      pendingRemoteStateRef.current = null;
      if (pendingRemote) onElementsChangeRef.current(toCanvasElements(pendingRemote));

      if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
        if (window.__debugExcalidrawApi === apiRef.current) {
          delete window.__debugExcalidrawApi;
        }
      }

      // The menu above outlives this component, so it has to be told the board
      // has gone rather than left holding actions against a dead editor.
      onBoardActionsRef.current?.(null);
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

    onBoardActionsRef.current?.({
      readScene: () => ({
        elements: api.getSceneElements() as readonly unknown[],
        // Excalidraw keys its files by id; the exporter takes a list.
        files: Object.values(api.getFiles() ?? {}) as readonly BoardFileEntry[],
      }),
      /*
       * The library is a tab of the default sidebar, not a sidebar of its own.
       * Asking for one called "library" is not an error -- nothing opens, and
       * nothing says why.
       */
      openLibrary: () => api.toggleSidebar({ name: 'default', tab: 'library' }),
    });

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
      /*
       * The first scene arrives without its tombstones.
       *
       * An erased element stays in the document as a deleted element, and on
       * every later update that is exactly what it is for: it tells a peer
       * holding the stroke to stop drawing it. At first load there is nothing
       * to tell -- the scene is empty -- so each one is an element the editor
       * carries, indexes and walks for the rest of the session in order to
       * draw nothing. On a board used for a term that is most of the scene:
       * measured at six hundred elements of which four hundred and eighty were
       * invisible.
       *
       * The document is untouched, so nothing is resurrected: this client
       * simply never learns about strokes that were erased before it arrived,
       * which is the same thing it would see if it had never been away.
       */
      const shared = snapshotElements(readSharedElements());
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
    /*
     * Do not push back a tool this application cannot name.
     *
     * Excalidraw's toolbar is the room's only one now, and it carries tools
     * this app has no word for. Those arrive here as themselves, map to
     * `selection` on the way out, and were sent straight back -- so picking
     * diamond, image, a frame or the laser flipped to the arrow a moment
     * later. Silence is the correct answer: the editor already holds the tool
     * it just told us about.
     */
    if (!isMappedAppTool(activeTool)) return;
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
   * While the pointer is down the work is throttled, with a trailing call so
   * the last sample is never dropped, and pointer up flushes. 50ms is ~20
   * publishes a second: remote strokes still look continuous, and cursors
   * travel on their own faster channel.
   *
   * The interval is not fixed. Each publish resends the whole point array, so
   * a stroke drawn without lifting the pen costs its length times the number
   * of publishes -- 238KB measured for ten seconds of one continuous stroke,
   * on the teacher's uplink, shared with the traffic that makes the board feel
   * live. `strokeCadence` widens the interval once a stroke is long and leaves
   * every ordinary one alone.
   */
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
      const interval = strokeCommitIntervalMs(livePointCount(el));
      if (since >= interval) {
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
        }, interval - since);
      }
    },
    [commitElements, uploadBoardFile],
  );

  useEffect(() => {
    if (!apiReady || !apiRef.current) return;

    const api = apiRef.current as ExcalidrawSubscriptionsAPI;
    toolUnsubscribeRef.current?.();
    toolUnsubscribeRef.current = api.onToolChange?.((tool) => {
      /*
       * Ignore the editor telling us what we just told it.
       *
       * Several app tools share one Excalidraw tool -- a sticky note is drawn
       * with the rectangle tool -- so the mapping only survives in one
       * direction. Choosing Sticky Note set the store to stickyNote, pushed
       * `rectangle` into the editor, and took the echo back as a tool change
       * to rectangle, which overwrote the store a moment later: the sidebar
       * fell back to Rectangle on its own and the next shape drawn was a plain
       * rectangle. It looked intermittent because it is a race with whatever
       * reads the store next, not because it sometimes worked.
       *
       * An echo is a report of the tool we already hold, so there is nothing
       * to apply. A change made inside the editor's own UI names a tool that
       * does not map back to what we hold, and still comes through.
       */
      const current = activeToolRef.current;
      if (current && toExcalidrawToolType(current) === tool.type) return;
      onToolChange(toAppToolType(tool.type));
    }) ?? null;

    return () => {
      toolUnsubscribeRef.current?.();
      toolUnsubscribeRef.current = null;
    };
  }, [apiReady, onToolChange]);

  useEffect(() => () => {
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

  /** Whether the stored library has answered; nothing is saved before it has. */
  const libraryLoadedRef = useRef(false);
  const librarySaveTimerRef = useRef<number | null>(null);

  /*
   * The room's shape library.
   *
   * Loaded after mount rather than through `initialData`, which is read once
   * while the editor is starting and would need this fetch to have finished
   * first -- holding the board closed on a request that has nothing to do with
   * drawing. `updateLibrary` can arrive whenever it arrives.
   *
   * Host only. The library is the teacher's own working set, students never
   * saw it, and asking for it as a peer would be a request the room refuses.
   */
  useEffect(() => {
    if (!apiReady || !isLocalHost) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/library`);
        if (!response.ok || cancelled) return;
        const body = await response.json() as { items?: unknown };
        const items = Array.isArray(body.items) ? body.items : [];
        if (cancelled || items.length === 0) return;
        libraryLoadedRef.current = true;
        apiRef.current?.updateLibrary({ libraryItems: items as never, merge: false });

        /*
         * The pictures a saved shape draws with.
         *
         * The library panel renders its previews from the editor's file map,
         * and a shape saved from a picture that has since left the board has
         * nothing in it -- the bytes are in the room's bucket, not in this
         * editor. Without this the shape is in the library and draws as an
         * empty box, which looks exactly like the feature not working.
         *
         * fetchBoardFile is the same path a peer uses for an image it was
         * never sent, including its memory of a 404, so a library referring to
         * something long gone asks once rather than on every change.
         */
        for (const fileId of libraryFileIds(items)) {
          void fetchBoardFile(fileId);
        }
      } catch {
        // A library that will not load must not stop the board opening.
      } finally {
        if (!cancelled) libraryLoadedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [apiReady, isLocalHost, roomId, fetchBoardFile]);

  /*
   * Saved on change, and not before the load has answered.
   *
   * Excalidraw announces its library on mount as well as on edit, so without
   * that guard the first thing a fresh editor would do is write its empty
   * library over the one being fetched -- and a teacher's shapes would vanish
   * the moment they opened the room on a second machine.
   *
   * Debounced because dragging a shape in fires this more than once, and each
   * one replaces the whole library.
   */
  const handleLibraryChange = useCallback((items: readonly unknown[]) => {
    if (!isLocalHost || !libraryLoadedRef.current) return;
    const snapshot = [...items];
    if (librarySaveTimerRef.current !== null) window.clearTimeout(librarySaveTimerRef.current);
    librarySaveTimerRef.current = window.setTimeout(() => {
      librarySaveTimerRef.current = null;
      void ajaxFetch(`/api/whiteboard/room/${roomId}/library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: snapshot }),
      }).catch(() => {
        // Nothing to retry against: the next change writes the whole library
        // again, so a lost save costs nothing a later one does not repair.
      });
    }, 1000);
  }, [isLocalHost, roomId]);

  useEffect(() => () => {
    if (librarySaveTimerRef.current !== null) window.clearTimeout(librarySaveTimerRef.current);
  }, []);

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
        onLibraryChange={handleLibraryChange}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        UIOptions={{
          canvasActions: {
            /*
             * The host may take the board away with them; nobody else may.
             *
             * These four were switched off together when Excalidraw replaced
             * the old canvas, and three of them have to stay off: loading a
             * scene and clearing the canvas both replace everything at once,
             * which fights the shared document rather than travelling through
             * it, and saving to an active file wants a handle to a file the
             * board was never opened from.
             *
             * Export is not like them. It reads the scene and writes a file,
             * touches nothing shared, and is the only way a lesson leaves this
             * application at all -- the platform's own point-in-time recovery
             * is the whole of the backup story, and a room that is deleted
             * takes the work with it.
             *
             * Host only, because a board is usually a child's work. A guest
             * admitted for one lesson should not be able to walk off with a
             * copy of everything anybody has drawn on it.
             */
            export: isLocalHost ? { saveFileToDisk: true } : false,
            saveToActiveFile: false,
            loadScene: false,
            clearCanvas: false,
          },
        }}
        viewModeEnabled={false}
        zenModeEnabled={false}
        gridModeEnabled={false}
        isCollaborating={true}
      >
        {/*
          * The room's own controls, in Excalidraw's footer beside its zoom.
          *
          * Its main menu is not listed here any more: everything this room
          * wanted from it -- saving a copy, the library -- is behind the room
          * title now, and what remained was a hamburger offering Excalidraw's
          * own defaults, which end in links out to its GitHub and its Discord.
          * That is a reasonable menu for a drawing tool somebody arrived at on
          * its own site, and the wrong one on a board used by children. The
          * trigger is hidden in globals.css, since not passing a menu makes
          * Excalidraw render exactly those defaults.
          */}
        {footer && <Footer>{footer}</Footer>}
      </Excalidraw>
    </div>
  );
}
