'use client';

import { useCallback, useRef, useEffect, useMemo, useState, type ReactNode } from 'react';
import { withRenderableGeometry } from '@/lib/whiteboard/renderableElements';
import { diffScene, shouldPublish, elementsToPublish } from '@/lib/whiteboard/scenePublish';
import { livePointCount, strokeCommitIntervalMs } from '@/lib/whiteboard/strokeCadence';
import { toolbarPlacement } from '@/lib/whiteboard/toolbarPlacement';
// MUST stay above the Excalidraw import: it sets EXCALIDRAW_ASSET_PATH, and ES
// module imports are evaluated in order, before this module's own body runs.
import '@/lib/whiteboard/excalidrawAssetPath';
import {
  CaptureUpdateAction,
  Excalidraw,
  Footer,
  bumpVersion,
  convertToExcalidrawElements,
  sceneCoordsToViewportCoords,
  useHandleLibrary,
  viewportCoordsToSceneCoords,
} from '@teacher-playground/excalidraw';
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
  mergeApiSnapshotElements,
  serializeExcalidrawElements,
  toExcalidrawToolType,
  isMappedAppTool,
} from '@/lib/whiteboard/excalidrawSync';
import { reconcileRemoteElements } from '@/lib/whiteboard/excalidrawReconcile';
import {
  dedupeSharedElementsById,
  getElementsFromArray,
  replaceSharedElements,
} from '@/lib/whiteboard/yjsDoc';
import { snapshotElements } from '@/lib/whiteboard/sceneSnapshot';
import { shouldRestoreScene } from '@/lib/whiteboard/sceneRestore';
import { libraryFileIds } from '@/lib/whiteboard/roomLibrary';
import { canSaveLibrary, type LibraryLoadState } from '@/lib/whiteboard/libraryGuard';
import { whiteboardRoomHref } from '@/lib/whiteboard/roomPath';
import { collaboratorsFromPresence } from '@/lib/whiteboard/collaborators';
import type { CanvasElement, RemoteCursor, WhiteboardUser } from '@/types/whiteboard';
import type { FollowMessage } from '@/lib/whiteboard/followMessage';
import { stackedPageRect } from '@/lib/documents/pdfImport';
import {
  annotationStampFor,
  elementsToMove,
  elementsToRemove,
  isHidden,
  nextPage,
  previousPage,
  sameStackedDocuments,
  showingIndex,
  stackedDocuments,
  type PageState,
  type SceneElement as PagedSceneElement,
  type StackedDocument,
} from '@/lib/documents/pagedDocuments';
import type { Rect as PagerRect } from '@/lib/documents/pagerPlacement';
import DocumentPager from './DocumentPager';
import { randomHexId } from '@/lib/crypto/randomId';
import type { RenderedPage } from './pdfRenderer';
import { buildBoardPdf, type ExportResult } from './pdfExporter';
import {
  isWhiteboardLatencyProbeEnabled,
  recordWhiteboardLatencyEvent,
} from '@/lib/whiteboard/latencyProbe';
import { bytesToDataURL, dataURLToBytes, filesToUpload, isAllowedMimeType, isRetryableUploadStatus, uploadRetryDelayMs } from '@/lib/whiteboard/boardFiles';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import {
  shouldRetryMissingImage,
  recordMissing,
  type MissingImageEntry,
} from '@/lib/whiteboard/imageRetry';

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

/** Background tries for one board-file PUT, including the initial attempt. */
const MAX_UPLOAD_ATTEMPTS = 5;

/**
 * How long the pre-socket scene waits for the room's first sync before
 * publishing anyway.
 *
 * A document that never receives anything — a fresh board, no peers — has
 * nothing to race, so holding the scene forever would strand work that today
 * reaches the document as soon as the document exists. If a first sync does
 * land after the escape has fired, the duplicate it produces is collapsed by
 * the remote-transaction heal in the document observer.
 */
const PRE_SYNC_FLUSH_ESCAPE_MS = 1000;

/**
 * The handful of board actions the room's own title menu drives.
 *
 * A small object rather than the editor itself, so nothing above has to import
 * from `@teacher-playground/excalidraw`: this component sits behind
 * `dynamic()` precisely to keep that package out of the room's first chunk,
 * and a type import from the caller would quietly undo it.
 */
export interface BoardActions {
  /** Opens Excalidraw's library, which used to have a button floating on the canvas. */
  openLibrary: () => void;
  /**
   * Places rendered PDF pages on the board being shown (spec/PDF_IMPORT_SPEC.md
   * §3): one locked image per page, stacked in order, in a single undoable
   * scene update. The bytes upload through the ordinary image path. When
   * given, `targetCentre` (scene coordinates, see `sceneCoordsFromClient`) is
   * where the first page is centred -- the drop point; without one, the view
   * centre is used, as a paste has no drop point.
   */
  insertPages: (pages: readonly RenderedPage[], targetCentre?: { x: number; y: number }) => void;
  /**
   * Converts a viewport point -- `event.clientX`/`clientY` from a drop -- into
   * the scene coordinates `insertPages` places pages at, using the board's
   * current pan and zoom.
   */
  sceneCoordsFromClient: (clientX: number, clientY: number) => { x: number; y: number };
  /**
   * Builds the board being shown into a PDF (spec/PDF_EXPORT_SPEC.md). Returns
   * the file, or why it could not be made; nothing is written to disk here.
   */
  buildPdf: () => Promise<ExportResult>;
  /**
   * Turns a page of a stacked document (spec §5.1, §6.3): forwards to
   * `onTurnPage`, which owns the owner check, the local `pageState` update
   * and sending the frame. A thin passthrough so the pager (slice B), which
   * lives in this editor's own coordinate space, has one place to call.
   */
  turnPage: (importId: string, index: number) => void;
}
type ExcalidrawSubscriptionsAPI = ExcalidrawImperativeAPI & {
  onToolChange?: (callback: (tool: { type: string }) => void) => () => void;
};

function toExcalidrawElements(
  elements: readonly SharedSceneElement[],
): readonly ExcalidrawElement[] {
  /*
   * Every route into updateScene goes through here -- the reconciled remote
   * scene, the queued elements, the shared snapshot -- which makes it the one
   * place worth checking that a linear element still has points to render.
   * Without them Excalidraw throws mid-scene and the board goes blank for
   * everybody in the room.
   */
  return withRenderableGeometry(elements) as unknown as readonly ExcalidrawElement[];
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
    __debugBoardActions?: BoardActions;
    __debugPageState?: PageState;
  }
}

type ExcalidrawWrapperProps = {
  roomId: string;
  userName: string;
  localPeerId: string;
  yDoc: Y.Doc | null;
  yElementsArray: Y.Array<Y.Map<unknown>> | null;
  /**
   * Which board of the room this editor is showing. Every element this client
   * publishes is stamped with it, every element rendered is filtered to it,
   * and the room's other boards are untouched by anything drawn here.
   */
  activeBoardId?: string;
  users: WhiteboardUser[];
  cursors: RemoteCursor[];
  activeTool: string;
  isLocalHost: boolean;
  onToolChange: (tool: string) => void;
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
  /** The room's stored view, applied once when the board opens. */
  initialViewport: { x: number; y: number; zoom: number } | null;
  /** Local pointer, in scene coordinates. */
  /** `tool` is named only for the laser; absent, the cursor is an ordinary pointer. */
  onCursorMove: (sceneX: number, sceneY: number, button?: 'up' | 'down', tool?: 'pointer' | 'laser') => void;
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
  /**
   * Whether Excalidraw's sidebar is open.
   *
   * It shares the right edge with the room's roster, and the room is the only
   * thing that can decide which of the two gets it.
   */
  onSidebarOpenChange?: (open: boolean) => void;
  /**
   * The server-held page state for stacked documents (spec §3.3, §6.2):
   * importId -> showing index. Drives `isElementHidden` and the `onPage`
   * stamp new annotations receive.
   */
  pageState?: PageState;
  /**
   * Turns a page (spec §5.1, §6.3): owns the owner check, the immediate local
   * `pageState` update and sending the frame. Reached through `BoardActions`
   * so the pager (slice B) has one function to call.
   */
  onTurnPage?: (importId: string, index: number) => void;
  /**
   * Whether this viewer is the room's owner (spec §6.3): drives the pager --
   * Previous/Next buttons plus "Page n of m" for the owner, "Page n of m"
   * only for everyone else. Not the same question as `isLocalHost`: a
   * first-in-list fallback host is not the account the room belongs to, and
   * a pager button that only fails is worse than none.
   */
  isRoomOwner?: boolean;
  /**
   * How many board notices (RoomClient.tsx's `BOARD_NOTICE_CLASS` lines) are
   * showing. They are the canvas's siblings, so nothing here resizes when
   * one appears; the toolbar re-places itself whenever this changes, so its
   * top-of-board fallback never lands on one.
   */
  boardNoticeCount?: number;
  /**
   * A PDF chosen through Excalidraw's own image tool picker
   * (spec/PAGED_DOCUMENTS_SPEC.md §4.1): the fork calls this instead of
   * adding an image element. Handed the same queue a drop or paste PDF goes
   * through, at the view centre -- a picker choice has no drop point.
   */
  onDocumentFile?: (file: File) => void;
};

export default function ExcalidrawWrapper({
  roomId,
  userName,
  localPeerId,
  yDoc,
  yElementsArray,
  activeBoardId = 'main',
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
  onSidebarOpenChange,
  pageState = {},
  onTurnPage,
  isRoomOwner = false,
  boardNoticeCount = 0,
  onDocumentFile,
}: ExcalidrawWrapperProps) {
  /** The toolbar placement's recompute, for effects outside the one that owns it. */
  const recomputeToolbarRef = useRef<(() => void) | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  /** The root of this editor's own DOM, for the toolbar-placement measurement below. */
  const boardRootRef = useRef<HTMLDivElement | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const isPointerDownRef = useRef(false);
  const activeToolRef = useRef(activeTool);
  const lastSyncedElementsRef = useRef<SharedSceneElement[]>([]);
  const lastPublishedIdsRef = useRef<string[]>([]);
  /**
   * The board this editor is showing, readable from the stable publish path.
   *
   * The prop changes when the room switches boards, but publishScene and the
   * remote handler are stable callbacks that would otherwise close over a
   * stale board.
   */
  const activeBoardIdRef = useRef(activeBoardId);
  useEffect(() => {
    activeBoardIdRef.current = activeBoardId;
  }, [activeBoardId]);
  /** id -> Excalidraw `version` at the last publish, for O(changed) diffing. */
  const publishedVersionsRef = useRef<Map<string, number>>(new Map());
  const latestViewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  const guideSendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGuidingRef = useRef(isGuiding);
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
  /** Files this room answered 404 for: retry with bounded backoff. */
  const missingFileIdsRef = useRef<Map<string, MissingImageEntry>>(new Map());
  /**
   * FileIds the room has confirmed holding.
   *
   * An element carries only a fileId while the bytes travel in a separate
   * PUT. Peers that see the reference before the PUT succeeds answer 404 and
   * retry with backoff; when the PUT lands this set (and the shared fileReady
   * map below) tells them to ask again without reloading.
   */
  const confirmedFileIdsRef = useRef<Set<string>>(new Set());
  /** Uploads in flight right now, so a burst of onChange calls sends once. */
  const uploadInFlightRef = useRef<Set<string>>(new Set());
  /** Pending background retries: fileId -> attempts made and timer, if any. */
  const pendingUploadsRef = useRef<Map<string, { dataUrl: string; attempts: number; timer: ReturnType<typeof setTimeout> | null; failed: boolean }>>(new Map());
  /** Image uploads still needing the room store: shown so leaving is a choice. */
  const [pendingUploadCount, setPendingUploadCount] = useState(0);
  /** Uploads that failed permanently: shown with a retry. */
  const [failedUploadIds, setFailedUploadIds] = useState<string[]>([]);

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

  /** Latest onTurnPage, read from BoardActions.turnPage -- built once, at API mount. */
  const onTurnPageRef = useRef(onTurnPage);
  useEffect(() => { onTurnPageRef.current = onTurnPage; }, [onTurnPage]);

  /** Remote scenes coalesce into one React update rather than ~20 a second. */
  const REMOTE_STATE_FLUSH_MS = 200;
  const pendingRemoteStateRef = useRef<SharedSceneElement[] | null>(null);
  const remoteStateTimerRef = useRef<number | null>(null);
  /** Every element id the room has ever shown this peer. */
  const seenRemoteIdsRef = useRef<Set<string>>(new Set());
  const pendingElementsRef = useRef<SharedSceneElement[] | null>(null);
  /** Elements drawn locally before yDoc and yElementsArray were ready. */
  const pendingLocalPublishRef = useRef<readonly Record<string, unknown>[] | null>(null);
  /**
   * The document whose first sync from the room has landed; null while the
   * current document has not synced yet. The pre-socket scene publishes only
   * once this is set — or once the document already holds the room's content,
   * which is the same guarantee read off the array when the sync landed before
   * this observer attached.
   */
  const syncedDocRef = useRef<Y.Doc | null>(null);
  /** Scene captured mid-stroke, flushed to React state on pointer up. */
  const deferredElementsRef = useRef<SharedSceneElement[] | null>(null);
  const hasAcceptedInitialSceneRef = useRef(false);
  const localPeerIdRef = useRef(localPeerId);
  localPeerIdRef.current = localPeerId;

  const collaborators = useMemo(
    () => collaboratorsFromPresence(users, cursors, localPeerId),
    [users, cursors, localPeerId],
  );

  /**
   * The scene's stacked documents (spec §8 `stackedDocuments`), recomputed on
   * every scene change but only ever replaced -- so `isElementHidden` below
   * only ever gets a new identity -- when `sameStackedDocuments` says the set
   * actually differs (spec §6.2).
   */
  const [documents, setDocuments] = useState<ReadonlyMap<string, StackedDocument>>(new Map());
  const updateStackedDocuments = useCallback(
    (elements: readonly PagedSceneElement[]): ReadonlyMap<string, StackedDocument> => {
      const next = stackedDocuments(elements);
      setDocuments((current) => (sameStackedDocuments(current, next) ? current : next));
      return next;
    },
    [],
  );

  /**
   * Passed to the fork's `isElementHidden` (spec §4, §6.2): a stacked page
   * not on the showing index of its own import, or an annotation stamped for
   * a page that is not showing, is hidden from drawing and pointer
   * interaction for everyone -- the elements stay in the scene and still
   * sync and export (spec §3.4).
   */
  const isElementHidden = useMemo(
    () => (element: ExcalidrawElement) => isHidden(element as unknown as PagedSceneElement, documents, pageState),
    [documents, pageState],
  );

  /**
   * Asks the pager layer (below) to recompute its own position. A ref, not a
   * prop the layer reads reactively: the layer holds its own
   * scroll/zoom/size state entirely to itself, so a scroll or a zoom never
   * re-renders this editor -- or, transitively, `<Excalidraw>` -- itself.
   * `onChange`/`onScrollChange` fire from inside Excalidraw's own
   * `updateScene` (the follow-the-guide effect below calls it, and a page
   * turn will too), and driving a state update on *this* component from
   * there was observed to race that in-flight update and lose part of it.
   */
  const pagerRepositionRef = useRef<() => void>(() => {});
  const registerPagerReposition = useCallback((reposition: () => void) => {
    pagerRepositionRef.current = reposition;
  }, []);
  const getPagerAppState = useCallback(() => apiRef.current?.getAppState() ?? null, []);
  const handleTurnPage = useCallback((importId: string, index: number) => {
    onTurnPageRef.current?.(importId, index);
  }, []);

  /**
   * Move (spec §6.3): applies `dxScene`/`dyScene` to every id `elementsToMove`
   * carries for this import -- every page plus every `onPage`-stamped
   * annotation -- with `CaptureUpdateAction.NEVER` while the grip is being
   * dragged, so the document follows the pointer live without creating a
   * history entry for each pointer-move event.
   */
  const handleMoveDocumentBy = useCallback((importId: string, dxScene: number, dyScene: number) => {
    const api = apiRef.current;
    if (!api) return;
    const current = api.getSceneElementsIncludingDeleted();
    const ids = new Set(elementsToMove(current as unknown as PagedSceneElement[], importId));
    if (ids.size === 0) return;
    const moved = current.map((element) => (
      ids.has(element.id) ? { ...element, x: element.x + dxScene, y: element.y + dyScene } : element
    ));
    api.updateScene({ elements: moved, captureUpdate: CaptureUpdateAction.NEVER });
  }, []);

  /**
   * Commits the drag as one undoable step (spec §6.3 Move): the scene is
   * already at its final position from the live-preview updates above --
   * `handleMoveDocumentBy` never bumped `version`, on purpose, so none of
   * those in-drag updates were ever published -- so this only needs to bump
   * `version` on the moved ids once and re-submit with
   * `CaptureUpdateAction.IMMEDIATELY`. `bumpVersion`, not a bare re-submit:
   * `diffScene`/`commitElements` decide what to publish purely from
   * `version` (see the `annotationStampFor` call above), so an unbumped
   * re-submit would create the local undo entry but never reach a peer.
   */
  const handleMoveDocumentEnd = useCallback((importId: string) => {
    const api = apiRef.current;
    if (!api) return;
    const current = api.getSceneElementsIncludingDeleted();
    const ids = new Set(elementsToMove(current as unknown as PagedSceneElement[], importId));
    if (ids.size === 0) return;
    const committed = current.map((element) => (
      ids.has(element.id) ? bumpVersion({ ...element } as ExcalidrawElement) : element
    ));
    api.updateScene({ elements: committed, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, []);

  /** A keyboard nudge (spec §6.3 Move keyboard): one undoable, published step per press. */
  const handleNudgeDocument = useCallback((importId: string, dxScene: number, dyScene: number) => {
    const api = apiRef.current;
    if (!api) return;
    const current = api.getSceneElementsIncludingDeleted();
    const ids = new Set(elementsToMove(current as unknown as PagedSceneElement[], importId));
    if (ids.size === 0) return;
    const moved = current.map((element) => (
      ids.has(element.id)
        ? bumpVersion({ ...element, x: element.x + dxScene, y: element.y + dyScene } as ExcalidrawElement)
        : element
    ));
    api.updateScene({ elements: moved, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, []);

  /** Remove (spec §6.3): marks every page and onPage-stamped annotation of the import isDeleted, in one undoable, published update. */
  const handleRemoveDocument = useCallback((importId: string) => {
    const api = apiRef.current;
    if (!api) return;
    const current = api.getSceneElementsIncludingDeleted();
    const ids = new Set(elementsToRemove(current as unknown as PagedSceneElement[], importId));
    if (ids.size === 0) return;
    const removed = current.map((element) => (
      ids.has(element.id) ? bumpVersion({ ...element, isDeleted: true } as ExcalidrawElement) : element
    ));
    api.updateScene({ elements: removed, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, []);

  // The viewport's own resize (rotating a phone, the room's chrome changing)
  // moves every document's viewport rectangle without Excalidraw sending a
  // scroll -- so the pager needs its own listener too.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => pagerRepositionRef.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /*
   * The constant strip the support button keeps clear at the board's own
   * right edge, whatever is docked (SupportButton.tsx, RoomClient.tsx): the
   * button sits at `right: max(0.75rem, safe-area)` normally, or that same
   * 0.75rem plus exactly the width the canvas itself reserves for the
   * panel/rail (roomCanvasRightClass) while either is docked. Since the
   * canvas's own right edge steps in by that same reserved width, the
   * button's distance from the *board's* right edge -- 0.75rem plus its own
   * ~2.25rem, rounded up for a border -- is the same constant in every one
   * of those states, by construction. Reserving it here as a constant, not
   * a measurement, sidesteps the button living in a different component
   * (RoomClient.tsx, a sibling of this one) and its own CSS transition.
   */
  const SUPPORT_BUTTON_CLEARANCE_PX = 56;

  /**
   * The bottom toolbar's placement (globals.css's `.App-toolbar-container`
   * rule, regression from 90e7a6b): centred on the board, shifted clear of
   * the room's own footer (zoom, undo, and -- for the owner -- Guide class
   * / Clear board) and the support button's reserved strip when centring
   * would overlap either, or moved above the canvas entirely -- Excalidraw's
   * own top-of-board slot, computed the same way -- when nothing on the
   * bottom row clears both at once. See `toolbarPlacement`
   * (src/lib/whiteboard/toolbarPlacement.ts) for the geometry itself; this
   * only measures and applies it, setting `top`/`bottom`/`left` inline every
   * time (which always wins over globals.css's rule, no `!important`
   * needed).
   *
   * Measured DOM, not the --call-rail-w/--presence-w calc the board notice
   * uses (BOARD_NOTICE_CLASS, RoomClient.tsx): the toolbar's own width and
   * the footer's own width (an owner's Guide+Clear widen it; a student's
   * does not) are real rendered geometry, not values a formula can assume.
   *
   * A `ResizeObserver` on this editor's own root re-fires whenever it is
   * resized -- including by the people panel or the call rail docking,
   * since both narrow this element through `roomCanvasRightClass`
   * (RoomClient.tsx) -- and every obstacle rect is re-read live each time,
   * so nothing needs its own separate observer. Excalidraw mounts its own
   * toolbar DOM an instant after this component's first render, so the
   * initial placement is applied on the first animation frame it exists,
   * bounded rather than polled forever.
   */
  useEffect(() => {
    const root = boardRootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return undefined;
    let cancelled = false;

    const recompute = () => {
      const excalidrawRoot = root.querySelector<HTMLElement>('.excalidraw');
      const toolbarEl = root.querySelector<HTMLElement>('.App-toolbar-container');
      if (!excalidrawRoot || !toolbarEl) return;

      // Below Excalidraw's own mobile threshold it owns the bottom edge
      // with its own toolbar (globals.css's UX-V8 comment); this placement
      // does not apply there, and any earlier override has to be undone.
      if (excalidrawRoot.classList.contains('excalidraw--mobile')) {
        toolbarEl.style.removeProperty('left');
        toolbarEl.style.removeProperty('top');
        toolbarEl.style.removeProperty('bottom');
        toolbarEl.style.removeProperty('transform');
        return;
      }

      const boardRect = root.getBoundingClientRect();
      const toolbarRect = toolbarEl.getBoundingClientRect();
      const obstacles: { x: number; width: number }[] = [];

      const footerLeft = root.querySelector<HTMLElement>('.layer-ui__wrapper__footer-left');
      if (footerLeft) {
        const rect = footerLeft.getBoundingClientRect();
        obstacles.push({ x: rect.left, width: rect.width });
      }
      const roomFooter = root.querySelector<HTMLElement>('.tp-board-footer');
      if (roomFooter) {
        const rect = roomFooter.getBoundingClientRect();
        obstacles.push({ x: rect.left, width: rect.width });
      }
      obstacles.push({
        x: boardRect.right - SUPPORT_BUTTON_CLEARANCE_PX,
        width: SUPPORT_BUTTON_CLEARANCE_PX,
      });

      const placement = toolbarPlacement({
        board: { x: boardRect.left, width: boardRect.width },
        toolbarWidth: toolbarRect.width,
        obstacles,
      });

      /*
       * `native` does not mean "let Excalidraw's own stylesheet decide" --
       * tried that first, and in practice Excalidraw's own default still
       * centres the toolbar on this same narrowed container, reproducing
       * the very overlap this mode exists to avoid, rather than reliably
       * moving it to the top the way its class name (`FixedSideContainer_
       * side_top`) suggests. Explicit top-of-board placement, computed the
       * same way the bottom placement is, is the only way to be sure of it.
       *
       * The board's own top edge is not always clear either: the PDF
       * import/export status line, the drop hint and the "couldn't clear"
       * notice (RoomClient.tsx, all `data-board-notice`) sit `top-24` on
       * top of the board, and a toolbar landing where this mode used to put
       * it -- a fixed 16px below the board's own top edge -- could land
       * right on top of one (tests/e2e/pdf-import.spec.ts's 768px status-
       * line test). Queried globally, not through `root`: RoomClient.tsx
       * renders these as the canvas's own siblings, not its descendants.
       */
      if (placement.mode === 'native') {
        let nativeTop = boardRect.top + 16;
        const notice = document.querySelector<HTMLElement>('[data-board-notice]');
        if (notice) {
          const noticeRect = notice.getBoundingClientRect();
          if (noticeRect.width > 0 && noticeRect.height > 0) {
            nativeTop = Math.max(nativeTop, noticeRect.bottom + 12);
          }
        }
        toolbarEl.style.left = `${placement.left}px`;
        toolbarEl.style.top = `${nativeTop}px`;
        toolbarEl.style.bottom = 'auto';
        toolbarEl.style.transform = 'none';
        return;
      }
      toolbarEl.style.left = `${placement.left}px`;
      toolbarEl.style.top = 'auto';
      toolbarEl.style.bottom = '1rem';
      toolbarEl.style.transform = 'none';
    };

    const observer = new ResizeObserver(recompute);
    observer.observe(root);

    // A board notice appearing or going away does not resize `root` (it is
    // the canvas's sibling), so the effect below re-runs this on
    // `boardNoticeCount` instead of watching the whole document.
    recomputeToolbarRef.current = recompute;

    let frame = 0;
    const waitForToolbar = () => {
      if (cancelled) return;
      if (root.querySelector('.App-toolbar-container')) {
        recompute();
        return;
      }
      frame += 1;
      if (frame > 60) return;
      requestAnimationFrame(waitForToolbar);
    };
    waitForToolbar();

    return () => {
      cancelled = true;
      observer.disconnect();
      recomputeToolbarRef.current = null;
    };
    /*
     * Depends on `isClient`, not `[]`: this component renders a ref-less
     * placeholder div until `isClient` flips true (below), so a mount-only
     * effect would run once against that placeholder -- find
     * `boardRootRef.current` null, and never run again once the real
     * editor (and its ref) exists.
     */
  }, [isClient]);

  // Re-place the toolbar when a board notice appears or goes away: the notice
  // is already in the DOM by the time this effect runs, in the same commit.
  useEffect(() => {
    recomputeToolbarRef.current?.();
  }, [boardNoticeCount]);

  /**
   * The page state this editor is rendering with, for the same reason
   * `__debugExcalidrawApi`/`__debugBoardActions` exist: e2e has no other way
   * to see it, and slice B's pager tests will want it too.
   */
  useEffect(() => {
    const exposeDebugApi =
      process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_E2E === '1';
    if (!exposeDebugApi || typeof window === 'undefined') return;
    window.__debugPageState = pageState;
    return () => {
      if (window.__debugPageState === pageState) delete window.__debugPageState;
    };
  }, [pageState]);

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
   * picture once.
   *
   * A failed transient upload is retried in the background as well as on the
   * next scene change: pasting and then leaving the board alone used to strand
   * the image in memory, and every reload showed a placeholder. Permanent
   * failures (a type the room will never store, a body it will never take)
   * are not retried automatically -- they are shown with a retry instead of
   * spamming the room on every stroke.
   *
   * On success the fileId is confirmed and announced over the shared document
   * so peers waiting on a 404 ask again without reloading. The element itself
   * was already published with the paste; only the readiness is new.
   *
   * The editor hands over WebP already: the fork converts an inserted image at
   * ingest, so what arrives here is what belongs in the bucket. This used to
   * convert as well, and re-encoding a WebP into a WebP only spends quality.
   */
  const syncUploadUi = useCallback(() => {
    let pending = 0;
    const failed: string[] = [];
    for (const [fileId, entry] of pendingUploadsRef.current) {
      if (entry.failed) failed.push(fileId);
      else pending += 1;
    }
    setPendingUploadCount(pending);
    setFailedUploadIds(failed);
  }, []);

  /**
   * The uploader, reachable from its own retry timers.
   *
   * A retry timer is scheduled by the upload it belongs to, so the callback
   * cannot close over the function directly without lint reading it as
   * use-before-declare -- and a closure would also pin whatever room and
   * document the function was created for. A ref the effect below keeps
   * current makes the indirection explicit, the way useCollaboration reaches
   * its presence applier.
   */
  const uploadBoardFileRef = useRef<((fileId: string, dataUrl: string) => Promise<void>) | null>(null);

  const uploadBoardFile = useCallback(
    async (fileId: string, dataUrl: string) => {
      if (confirmedFileIdsRef.current.has(fileId)) return;
      if (uploadInFlightRef.current.has(fileId)) return;
      const pending = pendingUploadsRef.current.get(fileId);
      if (pending?.failed) return;
      const attempts = pending?.attempts ?? 0;
      if (attempts >= MAX_UPLOAD_ATTEMPTS) return;
      if (!pending) {
        pendingUploadsRef.current.set(fileId, { dataUrl, attempts: 0, timer: null, failed: false });
        syncUploadUi();
      } else if (pending.dataUrl !== dataUrl) {
        pending.dataUrl = dataUrl;
      }
      uploadInFlightRef.current.add(fileId);
      try {
        const converted = dataURLToBytes(dataUrl);
        if (!converted || !isAllowedMimeType(converted.mimeType)) {
          // Permanent: the bytes will never be storable. Keep the attempted
          // mark so every pointer sample does not re-parse them, and show the
          // failure instead of stranding a placeholder silently.
          const entry = pendingUploadsRef.current.get(fileId);
          if (entry) {
            entry.failed = true;
            if (entry.timer) {
              clearTimeout(entry.timer);
              entry.timer = null;
            }
          } else {
            pendingUploadsRef.current.set(fileId, { dataUrl, attempts: MAX_UPLOAD_ATTEMPTS, timer: null, failed: true });
          }
          syncUploadUi();
          return;
        }
        const response = await ajaxFetch(
          `/api/whiteboard/room/${roomId}/files/${fileId}`,
          {
            method: 'PUT',
            body: converted.bytes as unknown as BodyInit,
            headers: { 'content-type': converted.mimeType },
          },
        );
        if (response.ok) {
          confirmedFileIdsRef.current.add(fileId);
          const entry = pendingUploadsRef.current.get(fileId);
          if (entry?.timer) clearTimeout(entry.timer);
          pendingUploadsRef.current.delete(fileId);
          syncUploadUi();
          try {
            if (yDoc) {
              yDoc.transact(() => {
                yDoc.getMap('fileReady').set(fileId, Date.now());
              }, 'file-ready');
            }
          } catch {
            // Readiness is a hint; the bytes are already stored.
          }
          return;
        }
        const retryable = isRetryableUploadStatus(response.status);
        const entry = pendingUploadsRef.current.get(fileId);
        const nextAttempts = attempts + 1;
        if (entry) entry.attempts = nextAttempts;
        if (!retryable || nextAttempts >= MAX_UPLOAD_ATTEMPTS) {
          // Permanent or exhausted: keep the attempted mark so strokes do not
          // spam the room, and show the failure with a manual retry.
          if (entry) {
            entry.failed = !retryable || nextAttempts >= MAX_UPLOAD_ATTEMPTS;
            if (entry.timer) {
              clearTimeout(entry.timer);
              entry.timer = null;
            }
          }
          syncUploadUi();
          return;
        }
        // Transient: allow the next scene change to retry immediately, and
        // also retry in the background so an idle board still recovers.
        uploadedFileIdsRef.current.delete(fileId);
        if (entry && !entry.timer) {
          entry.timer = setTimeout(() => {
            const current = pendingUploadsRef.current.get(fileId);
            if (current) current.timer = null;
            if (confirmedFileIdsRef.current.has(fileId)) return;
            if (uploadInFlightRef.current.has(fileId)) return;
            const latest = pendingUploadsRef.current.get(fileId);
            if (!latest || latest.failed) return;
            void uploadBoardFileRef.current?.(fileId, latest.dataUrl);
          }, uploadRetryDelayMs(attempts));
        }
        syncUploadUi();
      } catch {
        const entry = pendingUploadsRef.current.get(fileId);
        const nextAttempts = attempts + 1;
        if (entry) entry.attempts = nextAttempts;
        if (nextAttempts >= MAX_UPLOAD_ATTEMPTS) {
          if (entry) {
            entry.failed = true;
            if (entry.timer) {
              clearTimeout(entry.timer);
              entry.timer = null;
            }
          }
          syncUploadUi();
          return;
        }
        uploadedFileIdsRef.current.delete(fileId);
        if (entry && !entry.timer) {
          entry.timer = setTimeout(() => {
            const current = pendingUploadsRef.current.get(fileId);
            if (current) current.timer = null;
            if (confirmedFileIdsRef.current.has(fileId)) return;
            if (uploadInFlightRef.current.has(fileId)) return;
            const latest = pendingUploadsRef.current.get(fileId);
            if (!latest || latest.failed) return;
            void uploadBoardFileRef.current?.(fileId, latest.dataUrl);
          }, uploadRetryDelayMs(attempts));
        }
        syncUploadUi();
      } finally {
        uploadInFlightRef.current.delete(fileId);
      }
    },
    [roomId, yDoc, syncUploadUi],
  );

  useEffect(() => {
    uploadBoardFileRef.current = uploadBoardFile;
  }, [uploadBoardFile]);

  const retryFailedUploads = useCallback(() => {
    /*
     * Entries are replaced, not edited in place: the failed flag and the
     * attempt count live on objects that earlier reads may still be holding,
     * and a stale holder must not see a retry it did not start.
     */
    const failed = [...pendingUploadsRef.current].filter(([, entry]) => entry.failed);
    for (const [fileId, entry] of failed) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      pendingUploadsRef.current.set(fileId, { dataUrl: entry.dataUrl, attempts: 0, timer: null, failed: false });
      uploadedFileIdsRef.current.delete(fileId);
    }
    syncUploadUi();
    for (const [fileId, entry] of failed) {
      void uploadBoardFileRef.current?.(fileId, entry.dataUrl);
    }
  }, [syncUploadUi]);

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
       * A 404 is retried after delay with bounded backoff, in case the upload
       * is still in flight. It is the one answer that says the file is
       * not here rather than that the asking went wrong: a network failure or
       * a 5xx is worth another go on the next change, and a 403 means the
       * grant is not in place yet and may be a moment later.
       */
      const missingEntry = missingFileIdsRef.current.get(fileId);
      if (missingEntry && !shouldRetryMissingImage(missingEntry, Date.now())) return;
      fetchingFileIdsRef.current.add(fileId);
      try {
        const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/files/${fileId}`);
        if (response.status === 404) {
          missingFileIdsRef.current.set(fileId, recordMissing(missingFileIdsRef.current.get(fileId), Date.now()));
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
          delete window.__debugBoardActions;
        }
      }

      // The menu above outlives this component, so it has to be told the board
      // has gone rather than left holding actions against a dead editor.
      onBoardActionsRef.current?.(null);
    };
  }, []);

  /*
   * Per-room upload and fetch memory.
   *
   * FileIds are content-addressed, so the same screenshot pasted in two rooms
   * shares an id while naming two different R2 keys. Carrying attempted,
   * confirmed, in-flight, pending, fetching or backed-off ids from one room
   * into the next would skip the PUT the new room still needs -- or refuse the
   * GET it can already serve -- and leave a placeholder where a picture
   * belongs. Clear the whole set when the room changes (and stop any retry
   * timers for the room left behind); unmount clears through the same path.
   */
  useEffect(() => {
    /*
     * The sets are stable (each ref is created once), so capturing them here
     * is the same memory the cleanup would reach through `.current` -- and it
     * stops the cleanup reading a ref that lint warns may have moved on.
     */
    const pending = pendingUploadsRef.current;
    const uploaded = uploadedFileIdsRef.current;
    const confirmed = confirmedFileIdsRef.current;
    const inFlight = uploadInFlightRef.current;
    const fetching = fetchingFileIdsRef.current;
    const missing = missingFileIdsRef.current;
    return () => {
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      pending.clear();
      uploaded.clear();
      confirmed.clear();
      inFlight.clear();
      fetching.clear();
      missing.clear();
      setPendingUploadCount(0);
      setFailedUploadIds([]);
    };
  }, [roomId]);

  /*
   * Leaving with images still uploading loses the only bytes.
   *
   * The element was already published, so coming back shows a placeholder
   * where a picture belongs. Warn first so staying to let the background
   * retries land is a choice rather than an accident. Exports already read
   * the editor's local files, so a teacher that must leave can still take a
   * copy through the room title menu.
   */
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingUploadsRef.current.size > 0) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  /*
   * A pan that has not been sent yet must not outlive the guiding it belongs to.
   *
   * The viewport is sent 50ms after the board stops moving, so a teacher who
   * stops guiding just after panning leaves a send in flight behind the one
   * that stops it -- and the class, released a moment earlier, is put straight
   * back into follow with nothing on either screen to say so.
   */
  useEffect(() => {
    isGuidingRef.current = isGuiding;
    if (isGuiding) return;
    if (guideSendTimeoutRef.current) {
      clearTimeout(guideSendTimeoutRef.current);
      guideSendTimeoutRef.current = null;
    }
  }, [isGuiding]);

  useEffect(() => {
    if (!yDoc || !yElementsArray) return;

    const elementsArray = yElementsArray;

    // A replacement document has not synced yet, whatever an earlier one did.
    if (syncedDocRef.current !== yDoc) syncedDocRef.current = null;

    const flushPendingLocal = (adoptAsLastSynced: boolean) => {
      const pendingLocal = pendingLocalPublishRef.current;
      if (!pendingLocal || pendingLocal.length === 0) return;
      pendingLocalPublishRef.current = null;
      const existing = getElementsFromArray(elementsArray);
      const merged = mergeApiSnapshotElements(pendingLocal, existing);
      replaceSharedElements(yDoc, elementsArray, merged, 'local', {
        boardId: activeBoardIdRef.current,
      });
      lastPublishedIdsRef.current = merged
        .map((element) => (element as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === 'string');
      if (adoptAsLastSynced) lastSyncedElementsRef.current = merged;
    };

    /*
     * The pre-socket scene waits for the room's first sync.
     *
     * Publishing it into a document the server is still filling races the
     * server's own delivery of the same elements: the publish's by-id snapshot
     * sees an array without them and appends, raw applyUpdate merges by Yjs
     * struct rather than by element id, and both entries survive — on this
     * peer and, propagated, on every other. Once the sync has landed (a
     * non-empty array is the same guarantee when it landed before this
     * observer attached) the flush merges against what arrived instead.
     */
    const escapeTimer = syncedDocRef.current === yDoc || elementsArray.length > 0
      ? null
      : window.setTimeout(() => {
        // A room that never delivers anything has nothing to race.
        flushPendingLocal(true);
      }, PRE_SYNC_FLUSH_ESCAPE_MS);
    if (escapeTimer === null) flushPendingLocal(true);

    // Listen only for element changes. Cursor/awareness updates must not rewrite
    // the Excalidraw scene.
    const handler = (_events: Y.YEvent<Y.Map<unknown>>[], transaction: Y.Transaction) => {
      if (transaction.origin === 'local') return;

      // The room's first sync for this document has landed.
      syncedDocRef.current = yDoc;

      /*
       * A publish that raced the first sync leaves two live entries with one
       * id, because raw applyUpdate merges by Yjs struct and not by element
       * id. Heal it before anything reads the array: the delete runs as its
       * own transaction (Yjs defers observer writes), and this handler runs
       * again for it to apply the collapsed scene.
       */
      dedupeSharedElementsById(yDoc, elementsArray);

      // The gate is open — it just opened, or opened earlier — so the
      // pre-socket scene publishes now, merged with what arrived. lastSynced
      // is left to the read below, so the merged scene still reaches the
      // editor when the room's copy was newer than the queued one.
      flushPendingLocal(false);

      /*
       * The one reader, not a second copy of it.
       *
       * This loop used to lift values straight out of the Yjs map, which
       * silently stopped working the day `points` began arriving encoded: the
       * canvas was handed a Uint8Array it cannot draw, and a peer's strokes
       * simply never appeared. getElementsFromArray decodes every stored form.
       */
      const remoteElements = toSharedSceneElements(getElementsFromArray(elementsArray))
        .filter((element) => {
          const stamp = (element as { boardId?: unknown }).boardId;
          return (typeof stamp === 'string' && stamp.length > 0 ? stamp : 'main') === activeBoardIdRef.current;
        });

      const same = excalidrawElementsEqual(remoteElements, lastSyncedElementsRef.current);
      if (same) return;
      lastSyncedElementsRef.current = remoteElements;
      applyRemoteElements(remoteElements);
    };

    elementsArray.observeDeep(handler);

    // Readiness for images whose reference arrived before their bytes.
    //
    // The uploader publishes the element immediately and the bytes separately.
    // A peer that sees the reference first answers 404 and backs off with a
    // bounded policy; without invalidation a slow upload becomes a permanent
    // placeholder for that mounted editor. When the PUT lands the uploader
    // stamps fileReady, which clears the backoff so the bytes are asked for
    // again without reloading and without a request-per-stroke flood.
    const fileReadyMap = yDoc.getMap('fileReady');
    const fileReadyHandler = () => {
      let cleared = false;
      fileReadyMap.forEach((_value, fileId) => {
        if (typeof fileId !== 'string' || fileId.length === 0) return;
        if (missingFileIdsRef.current.delete(String(fileId))) cleared = true;
      });
      if (!cleared) return;
      const api = apiRef.current;
      if (!api) return;
      try {
        fetchMissingBoardFiles(api.getSceneElements?.() as readonly unknown[] ?? []);
      } catch {
        // A readiness hint must never interrupt drawing.
      }
    };
    fileReadyMap.observe(fileReadyHandler);

    return () => {
      if (escapeTimer !== null) window.clearTimeout(escapeTimer);
      elementsArray.unobserveDeep(handler);
      fileReadyMap.unobserve(fileReadyHandler);
    };
  }, [yDoc, yElementsArray, roomId, applyRemoteElements, adoptVersionBaseline, fetchMissingBoardFiles]);

  // A board swap is a scene swap: the shared document does not change, so the
  // observer above stays quiet and the editor has to be handed the new board's
  // elements explicitly. The publish bookkeeping resets with it, because the
  // ids the old board published mean nothing on the new one.
  //
  // Skipped on mount deliberately: the api-ready restore below loads the
  // active board through the same filtered reader, and queueing an empty
  // scene here would race that restore and wipe the editor before anyone
  // draws.
  const previousBoardRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousBoardRef.current;
    previousBoardRef.current = activeBoardId;
    if (previous === null || previous === activeBoardId) return;
    if (!yElementsArray) return;
    const remoteElements = toSharedSceneElements(getElementsFromArray(yElementsArray))
      .filter((element) => {
        const stamp = (element as { boardId?: unknown }).boardId;
        return (typeof stamp === 'string' && stamp.length > 0 ? stamp : 'main') === activeBoardId;
      });
    lastSyncedElementsRef.current = remoteElements;
    lastPublishedIdsRef.current = remoteElements
      .map((element) => element.id)
      .filter((id): id is string => typeof id === 'string');
    applyRemoteElements(remoteElements);
  }, [activeBoardId, yElementsArray, applyRemoteElements]);

  /** Snapshot of the shared document as plain Excalidraw elements. */
  const readSharedElements = useCallback((): SharedSceneElement[] => {
    if (!yElementsArray) return [];
    // Through the shared reader, never by copying the map directly: `points`
    // is stored encoded and has to be decoded before it reaches the canvas.
    //
    // Scoped to the board this editor is showing: every consumer of this
    // reader — the mount restore, the snapshot, the export — wants the active
    // board, and an element without a stamp belongs to the main one.
    const stamp = (element: { boardId?: unknown }): boolean => {
      const boardId = element.boardId;
      return (typeof boardId === 'string' && boardId.length > 0 ? boardId : 'main') === activeBoardIdRef.current;
    };
    return toSharedSceneElements(getElementsFromArray(yElementsArray))
      .filter((element) => stamp(element as { boardId?: unknown }));
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

  /*
   * The editor as state as well as a ref.
   *
   * `useHandleLibrary` takes the instance rather than a ref, so it has to
   * re-run when the editor appears; the ref beside it stays because everything
   * else here reads it from callbacks that must not re-subscribe.
   */
  const [libraryApi, setLibraryApi] = useState<ExcalidrawImperativeAPI | null>(null);

  /*
   * Computed in the browser, because a static export has no room id at build
   * time -- and the room's own address is the only place a teacher should be
   * returned to after installing a shape set.
   */
  const [libraryReturnUrl, setLibraryReturnUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    setLibraryReturnUrl(`${window.location.origin}${whiteboardRoomHref(roomId)}`);
  }, [roomId]);

  /*
   * Installing a library from Excalidraw's public repository.
   *
   * The repository sends the browser back with the library in the URL, and
   * without this nothing reads it: the trip appeared to work, and not one
   * shape ever arrived. This is the hook that consumes it.
   *
   * No adapter and no initial items on purpose. The room already loads its
   * library from `/library` on mount and saves it back through
   * `onLibraryChange`, so anything installed here is persisted by the path
   * that was already there -- and handing the hook an adapter as well would
   * give the library two owners.
   */
  useHandleLibrary({ excalidrawAPI: libraryApi });

  const handleAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    followUnsubscribeRef.current?.();
    followUnsubscribeRef.current = null;
    apiRef.current = api;
    setLibraryApi(api);

    const boardActions: BoardActions = {
      /*
       * The library is a tab of the default sidebar, not a sidebar of its own.
       * Asking for one called "library" is not an error -- nothing opens, and
       * nothing says why.
       */
      openLibrary: () => api.toggleSidebar({ name: 'default', tab: 'library' }),
      /*
       * Only what this board shows: the scene Excalidraw holds is already the
       * active board's elements, which is the same thing the tabs switch.
       */
      buildPdf: () => buildBoardPdf({
        elements: api.getSceneElements() as unknown as Record<string, unknown>[],
        files: (api.getFiles() ?? {}) as Record<string, unknown>,
      }),
      turnPage: (importId, index) => onTurnPageRef.current?.(importId, index),
      sceneCoordsFromClient: (clientX, clientY) => {
        const appState = api.getAppState();
        return viewportCoordsToSceneCoords(
          { clientX, clientY },
          {
            zoom: appState.zoom,
            offsetLeft: appState.offsetLeft,
            offsetTop: appState.offsetTop,
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
          },
        );
      },
      insertPages: (pages, targetCentre) => {
        if (pages.length === 0) return;
        const created = Date.now();
        api.addFiles(pages.map((page) => ({
          id: page.id as never,
          mimeType: page.mimeType,
          dataURL: page.dataURL as never,
          created,
        })));

        /*
         * The first page is centred on `targetCentre` -- the drop point, in
         * scene coordinates -- when one is given (spec/PDF_IMPORT_SPEC.md
         * §3); a paste has no drop point, so it falls back to the view centre,
         * as every insert did before drop/paste existed. The rest follow
         * below the first page either way.
         */
        const appState = api.getAppState();
        const zoom = appState.zoom.value;
        const centre = targetCentre ?? {
          x: appState.width / 2 / zoom - appState.scrollX,
          y: appState.height / 2 / zoom - appState.scrollY,
        };
        /*
         * Every page of a stacked import shares the first page's rectangle
         * (spec §3.1): the first page is placed and sized at `centre`, and
         * every other page is fitted inside that same rectangle, centred,
         * keeping its own aspect ratio -- never stretched or cropped to match
         * a first page of a different shape.
         */
        const firstPageRect = {
          x: centre.x - pages[0].width / 2,
          y: centre.y - pages[0].height / 2,
          width: pages[0].width,
          height: pages[0].height,
        };
        const placements = pages.map((page) => stackedPageRect(page, firstPageRect));
        /*
         * One id for this import, and the page's own index within it. Download
         * as PDF reads these back (spec/PDF_EXPORT_SPEC.md): they are what say
         * which images are worksheet pages, which import they belong to and in
         * what order, after the board has been moved around for a lesson.
         * `customData` survives both sync paths -- the serializer deep-clones
         * elements and the HTTP scene schema passes unknown keys through.
         */
        const importId = randomHexId(8);
        const pageCount = pages.length;
        const images = convertToExcalidrawElements(placements.map((placement, index) => ({
          type: 'image' as const,
          fileId: pages[index].id as never,
          ...placement,
        })))
          // Locked so writing on a page does not drag it -- a convenience, not
          // an access control: an editor can unlock it like anything else.
          .map((element, index) => ({
            ...element,
            locked: true,
            customData: { pdfPage: { importId, index, pageCount, stacked: true as const } },
          }));

        api.updateScene({
          elements: [...api.getSceneElementsIncludingDeleted(), ...images],
          // One history entry, so a single undo takes the whole import away.
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        api.scrollToContent(images[0], { fitToViewport: true, viewportZoomFactor: 0.9 });
      },
    };
    onBoardActionsRef.current?.(boardActions);

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
      /*
       * A picture already in the document has to be asked for from here.
       *
       * applyRemoteElements asks as elements arrive, but it can only ask once
       * there is an editor to hand the bytes to -- and on a reload the document
       * usually syncs before this callback runs, so that ask was skipped and
       * nothing ever made it again on a board where nothing else changes. The
       * element came back and the image did not.
       */
      fetchMissingBoardFiles(shared);
      /*
       * Decided against the editor's own scene, not against the last document
       * seen on the wire: a scene that synced before this editor existed was
       * only queued, and Excalidraw overwrites a queued scene while it
       * initialises. Comparing against the wire read that board as already
       * restored and left the canvas empty.
       */
      if (!shouldRestoreScene(shared, api.getSceneElements() ?? [])) return;
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
      onElementsChangeRef.current(toCanvasElements(shared));
      // A late joiner's first page state comes with this initial scene, not a
      // later onChange -- computed here so isElementHidden is correct before
      // the first stroke is ever drawn.
      updateStackedDocuments(shared as unknown as readonly PagedSceneElement[]);
    }, 100);

    // E2E runs against a production build, so the handle is also exposed when
    // the build is explicitly flagged for testing. Real deploys leave it off.
    const exposeDebugApi =
      process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_E2E === '1';
    if (exposeDebugApi && typeof window !== 'undefined') {
      window.__debugExcalidrawApi = api;
      // The pager is slice B; until it exists, e2e drives a page turn the
      // same owner-only way it will, through BoardActions.turnPage.
      window.__debugBoardActions = boardActions;
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
  }, [adoptVersionBaseline, readSharedElements, fetchMissingBoardFiles]);

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
    (scene: readonly unknown[], candidate: PublishCandidate): boolean => {
      const serializedElements = serializeExcalidrawElements(scene);
      const payload = serializeExcalidrawElements(candidate.elements);
      const previousIds = lastPublishedIdsRef.current;

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

      if (!yDoc || !yElementsArray) {
        pendingLocalPublishRef.current = serializedElements;
        return true;
      }

      lastSyncedElementsRef.current = serializedElements;
      lastPublishedIdsRef.current = serializedElements
        .map((element) => element.id)
        .filter((id): id is string => typeof id === 'string');

      const shouldRecordLatency = isWhiteboardLatencyProbeEnabled();
      try {
        if (candidate.wholeScene) {
          // An element disappeared, so the stale sweep has to run and needs
          // the whole scene to know what survived. The sweep is scoped to the
          // active board: other boards are never swept by this publish.
          replaceSharedElements(yDoc, yElementsArray, serializedElements, 'local', {
            previousIds,
            boardId: activeBoardIdRef.current,
          });
        } else if (payload.length > 0) {
          replaceSharedElements(yDoc, yElementsArray, payload, 'local', {
            deleteMissing: false,
            boardId: activeBoardIdRef.current,
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
        return true;
      } catch {
        // A Yjs write must not roll back the local canvas state.
        return false;
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
      const success = publishScene(serializedElements, elementsToPublish(serializedElements, diff, force));
      if (success) {
        publishedVersionsRef.current = diff.nextVersions;
      }
    },
    [publishScene],
  );
  commitElementsRef.current = commitElements;


  /*
   * Reported from onChange rather than set once when the menu opens it.
   *
   * The sidebar can be closed from its own X, pinned, or opened again by
   * Excalidraw itself, and a room that folded its roster away only at the
   * moment the menu was used got out of step with all of those -- the roster
   * came back over the top of an open library.
   */
  const sidebarOpenRef = useRef(false);
  const onSidebarOpenChangeRef = useRef(onSidebarOpenChange);
  useEffect(() => { onSidebarOpenChangeRef.current = onSidebarOpenChange; }, [onSidebarOpenChange]);

  /**
   * The id `appState.newElement`/`editingTextElement` named on the previous
   * onChange -- read once, to catch a just-finished element whose own
   * version did not change (only `appState` did). See the stamping block
   * below.
   */
  const previouslyInProgressIdRef = useRef<string | null>(null);

  const handleElementsChange = useCallback(
    (el: ExcalidrawChangeElements, appState: ExcalidrawChangeAppState, files?: ExcalidrawChangeFiles) => {
      const sidebarOpen = Boolean((appState as { openSidebar?: unknown } | null)?.openSidebar);
      if (sidebarOpen !== sidebarOpenRef.current) {
        sidebarOpenRef.current = sidebarOpen;
        onSidebarOpenChangeRef.current?.(sidebarOpen);
      }

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
       * Stamps a finished, genuinely local element overlapping a stacked
       * document with onPage (spec §3.2). A candidate has to clear two
       * independent checks, each guarding a different way this handler is
       * reached for an element it must not touch:
       *
       * - It must be in `diffScene`'s changed set against
       *   `publishedVersionsRef`. A remote or bootstrap scene load (a late
       *   joiner's initial restore, another peer's finished stroke arriving
       *   over the wire) moves that baseline to match what it just applied,
       *   via `adoptVersionBaseline`, *before* that apply's own
       *   `updateScene` call -- so a remote-origin element's version never
       *   shows as changed here, only a locally-authored one's. Without
       *   this, scanning every unstamped element on every change treats
       *   "not yet carrying its onPage stamp" as "needs stamping" -- true
       *   for a fresh local element, but also momentarily true for one
       *   whose stamp is already on the wire and just has not arrived yet
       *   relative to this element's own sync; a late joiner could then
       *   stamp someone else's annotation for whatever page its own
       *   not-yet-replayed pageState (spec §5.2) defaulted to, and publish
       *   that back over the correct value.
       * - It must not be the id `appState.newElement`/`editingTextElement`
       *   names right now -- still being drawn. `diffScene` alone is not
       *   enough here: finishing a shape can leave its own version
       *   unchanged from the moment before (only `appState` moved), so an
       *   in-progress id has to be excluded by name, not inferred from
       *   whether anything about the element itself just changed.
       */
      const currentDocuments = updateStackedDocuments(el as unknown as readonly PagedSceneElement[]);
      const inProgressId = (appState as { newElement?: { id?: unknown } } | null)?.newElement?.id;
      const editingTextId = (appState as { editingTextElement?: { id?: unknown } } | null)
        ?.editingTextElement?.id;
      const justFinishedId = previouslyInProgressIdRef.current;
      previouslyInProgressIdRef.current =
        (typeof inProgressId === 'string' && inProgressId)
        || (typeof editingTextId === 'string' && editingTextId)
        || null;

      if (currentDocuments.size > 0) {
        const stampCandidateDiff = diffScene(publishedVersionsRef.current, el);
        let stampedAny = false;
        const stampedElements = el.map((element) => {
          if (element.id === inProgressId || element.id === editingTextId) return element;
          if (!stampCandidateDiff.changedIds.has(element.id) && element.id !== justFinishedId) {
            return element;
          }
          const stamp = annotationStampFor(
            element as unknown as PagedSceneElement,
            currentDocuments,
            pageState,
          );
          if (!stamp) return element;
          stampedAny = true;
          /*
           * bumpVersion, not a bare spread: `diffScene`/`commitElements`
           * decide what is worth publishing purely from `version`, and a
           * stamp that left it untouched was indistinguishable from no
           * change at all. The unstamped element -- already diff-changed
           * a moment earlier in this same handler -- had by then already
           * been queued for publish at its own version; a stamped copy at
           * that identical version looked, to the very next diff, exactly
           * like nothing had happened, and the stamp was silently dropped
           * before it ever reached the shared document.
           */
          return bumpVersion({
            ...element,
            customData: { ...(element.customData ?? {}), onPage: stamp },
          } as ExcalidrawElement);
        });
        if (stampedAny) {
          apiRef.current?.updateScene({
            elements: stampedElements as unknown as readonly ExcalidrawElement[],
            captureUpdate: CaptureUpdateAction.NEVER,
          });
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
    [commitElements, uploadBoardFile, updateStackedDocuments, pageState],
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
    const button = payload?.button === 'down' ? 'down' : 'up';
    /*
     * The laser leaves nothing on the board, so the cursor is the only way it
     * reaches the room. Dropping the tool here showed the class an arrow
     * wherever the teacher was pointing with the laser.
     */
    if (pointer.tool === 'laser') onCursorMove(x, y, button, 'laser');
    else onCursorMove(x, y, button);
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

  /** State of the stored library load: pending, loaded, or failed. */
  const libraryLoadedRef = useRef<LibraryLoadState>('pending');
  const librarySaveTimerRef = useRef<number | null>(null);
  /** The snapshot waiting behind the debounce, so leaving the room can flush it. */
  const pendingLibrarySaveRef = useRef<readonly unknown[] | null>(null);

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
        if (!response.ok || cancelled) {
          if (!cancelled) libraryLoadedRef.current = 'failed';
          return;
        }
        const body = await response.json() as { items?: unknown };
        const items = Array.isArray(body.items) ? body.items : [];
        if (cancelled) return;

        // Mark as loaded regardless of whether items exist
        libraryLoadedRef.current = 'loaded';

        // Update the library if items exist
        if (items.length > 0) {
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
        }
      } catch {
        // A library that will not load must not stop the board opening.
        if (!cancelled) libraryLoadedRef.current = 'failed';
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
  const saveLibrary = useCallback((items: readonly unknown[], keepalive = false) => {
    void ajaxFetch(`/api/whiteboard/room/${roomId}/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
      ...(keepalive ? { keepalive: true } : {}),
    }).catch(() => {
      // Nothing to retry against: the next change writes the whole library
      // again, so a lost save costs nothing a later one does not repair.
    });
  }, [roomId]);

  const handleLibraryChange = useCallback((items: readonly unknown[]) => {
    if (!isLocalHost || !canSaveLibrary(libraryLoadedRef.current)) return;
    const snapshot = [...items];
    pendingLibrarySaveRef.current = snapshot;
    if (librarySaveTimerRef.current !== null) window.clearTimeout(librarySaveTimerRef.current);
    librarySaveTimerRef.current = window.setTimeout(() => {
      librarySaveTimerRef.current = null;
      pendingLibrarySaveRef.current = null;
      saveLibrary(snapshot);
    }, 1000);
  }, [isLocalHost, saveLibrary]);

  /*
   * Leaving the room must not cost the teacher their last shapes.
   *
   * There are two ways to leave, and both used to lose whatever was still
   * waiting behind the save debounce. Navigating away is a full page load in
   * the built app -- React never unmounts, so the pending snapshot has to go
   * out from pagehide, with keepalive so the request survives the document
   * going away. A true React unmount (the board replaced while the page lives
   * on) flushes through the same snapshot instead. Either way a save whose
   * debounce already fired has cleared the snapshot and is never sent twice,
   * and a library past keepalive's body cap is no worse off than before: the
   * debounce had a second to save it, and the next change rewrites it whole.
   */
  useEffect(() => {
    const flushPendingSave = (keepalive: boolean) => {
      if (librarySaveTimerRef.current !== null) {
        window.clearTimeout(librarySaveTimerRef.current);
        librarySaveTimerRef.current = null;
      }
      const pending = pendingLibrarySaveRef.current;
      pendingLibrarySaveRef.current = null;
      if (pending) saveLibrary(pending, keepalive);
    };
    const onPageHide = () => flushPendingSave(true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      flushPendingSave(false);
    };
  }, [saveLibrary]);

  if (!isClient) {
    return <div className="w-full h-full min-h-0" />;
  }

  return (
    <div
      ref={boardRootRef}
      className="w-full h-full min-h-0"
      data-whiteboard-role={isLocalHost ? 'host' : 'peer'}
    >
      <Excalidraw
        langCode="en"
        excalidrawAPI={handleAPI}
        onChange={(el, appState, files) => {
          handleElementsChange(el, appState, files);
          pagerRepositionRef.current();
        }}
        onPointerUpdate={handlePointerUpdate}
        onScrollChange={(scrollX, scrollY, zoom) => {
          const viewport = { x: scrollX, y: scrollY, zoom: zoom.value };
          latestViewportRef.current = viewport;
          onViewportChange(viewport);
          pagerRepositionRef.current();
          if (isGuiding) {
            if (guideSendTimeoutRef.current) clearTimeout(guideSendTimeoutRef.current);
            guideSendTimeoutRef.current = setTimeout(() => {
              guideSendTimeoutRef.current = null;
              // Read now, not when this was scheduled: guiding may have been
              // stopped in between, and this send would undo the stop.
              if (!isGuidingRef.current) return;
              onGuideViewport(latestViewportRef.current);
            }, 50);
          }
        }}
        onLibraryChange={handleLibraryChange}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        isElementHidden={isElementHidden}
        onDocumentFile={onDocumentFile}
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
        /*
         * Where the public repository returns to. Left unset it guesses from
         * the current URL, and this application is a static export whose room
         * pages are rewritten by the Worker -- so the guess is not reliably
         * the room somebody started from.
         */
        libraryReturnUrl={libraryReturnUrl}
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
      <DocumentPagerLayer
        documents={documents}
        pageState={pageState}
        isOwner={isRoomOwner}
        getAppState={getPagerAppState}
        onTurnPage={handleTurnPage}
        onMoveDocumentBy={handleMoveDocumentBy}
        onMoveDocumentEnd={handleMoveDocumentEnd}
        onNudgeDocument={handleNudgeDocument}
        onRemoveDocument={handleRemoveDocument}
        registerReposition={registerPagerReposition}
      />
      {(pendingUploadCount > 0 || failedUploadIds.length > 0) && (
        <div
          data-testid="board-upload-status"
          className="fixed bottom-4 right-4 z-50 max-w-xs rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-lg"
          role="status"
        >
          {pendingUploadCount > 0 && (
            <div>
              Uploading {pendingUploadCount} image{pendingUploadCount === 1 ? '' : 's'}…
            </div>
          )}
          {failedUploadIds.length > 0 && (
            <div className="mt-1">
              <div>
                {failedUploadIds.length} image{failedUploadIds.length === 1 ? '' : 's'} failed to save.
              </div>
              <button
                type="button"
                className="mt-1 underline"
                onClick={() => retryFailedUploads()}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type PagerViewportGeometry = {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  zoom: { value: NormalizedZoomValue };
  offsetLeft: number;
  offsetTop: number;
};

type DocumentPagerLayerProps = {
  documents: ReadonlyMap<string, StackedDocument>;
  pageState: PageState;
  isOwner: boolean;
  /** Reads the editor's current appState on demand -- never held as a prop, so this layer decides for itself when to re-read it. */
  getAppState: () => PagerViewportGeometry | null;
  onTurnPage: (importId: string, index: number) => void;
  onMoveDocumentBy: (importId: string, dxScene: number, dyScene: number) => void;
  onMoveDocumentEnd: (importId: string) => void;
  onNudgeDocument: (importId: string, dxScene: number, dyScene: number) => void;
  onRemoveDocument: (importId: string) => void;
  /** Called once, with a function the parent can call to ask this layer to recompute its own position. */
  registerReposition: (reposition: () => void) => void;
};

/**
 * Every stacked document's pager (spec §6.3), as one component whose
 * scroll/zoom/size state stays entirely local to it.
 *
 * Kept apart from `ExcalidrawWrapper` on purpose: `<Excalidraw>` lives in
 * that same component, and a state update there -- even one this layer's own
 * position has nothing to do with -- re-renders it too. Driving a page's
 * on-screen position from a state update in the editor's own component was
 * observed to race `updateScene` calls made from inside `onChange`/
 * `onScrollChange` (the follow-the-guide effect is one caller of those) and
 * lose part of the update. A leaf component's own `useState` only re-renders
 * that leaf, so `<Excalidraw>` never sees it.
 */
function DocumentPagerLayer({
  documents,
  pageState,
  isOwner,
  getAppState,
  onTurnPage,
  onMoveDocumentBy,
  onMoveDocumentEnd,
  onNudgeDocument,
  onRemoveDocument,
  registerReposition,
}: DocumentPagerLayerProps) {
  const [viewportGeometry, setViewportGeometry] = useState<PagerViewportGeometry | null>(null);

  const reposition = useCallback(() => {
    const appState = getAppState();
    if (!appState) return;
    setViewportGeometry((current) => {
      if (
        current
        && current.width === appState.width
        && current.height === appState.height
        && current.scrollX === appState.scrollX
        && current.scrollY === appState.scrollY
        && current.zoom.value === appState.zoom.value
        && current.offsetLeft === appState.offsetLeft
        && current.offsetTop === appState.offsetTop
      ) {
        return current;
      }
      return appState;
    });
  }, [getAppState]);

  useEffect(() => {
    registerReposition(reposition);
    reposition();
    return () => registerReposition(() => {});
  }, [registerReposition, reposition]);

  const documentPagerEntries = useMemo(() => {
    if (!viewportGeometry) return [];
    const entries: Array<{ importId: string; documentRect: PagerRect; index: number; pageCount: number }> = [];
    for (const doc of documents.values()) {
      const topLeft = sceneCoordsToViewportCoords({ sceneX: doc.rect.x, sceneY: doc.rect.y }, viewportGeometry);
      const bottomRight = sceneCoordsToViewportCoords(
        { sceneX: doc.rect.x + doc.rect.width, sceneY: doc.rect.y + doc.rect.height },
        viewportGeometry,
      );
      entries.push({
        importId: doc.importId,
        documentRect: {
          x: topLeft.x,
          y: topLeft.y,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y,
        },
        index: showingIndex(doc, pageState),
        pageCount: doc.pageCount,
      });
    }
    return entries;
  }, [documents, pageState, viewportGeometry]);

  return (
    <>
      {documentPagerEntries.map(({ importId, documentRect, index, pageCount }) => (
        <DocumentPager
          key={importId}
          importId={importId}
          documentRect={documentRect}
          viewportSize={{ width: viewportGeometry?.width ?? 0, height: viewportGeometry?.height ?? 0 }}
          index={index}
          pageCount={pageCount}
          isOwner={isOwner}
          onPrevious={() => onTurnPage(importId, previousPage(index))}
          onNext={() => onTurnPage(importId, nextPage(index, pageCount))}
          onMoveBy={(dxScene, dyScene) => onMoveDocumentBy(importId, dxScene, dyScene)}
          onMoveEnd={() => onMoveDocumentEnd(importId)}
          onNudge={(dxScene, dyScene) => onNudgeDocument(importId, dxScene, dyScene)}
          onRemove={() => onRemoveDocument(importId)}
          zoom={viewportGeometry?.zoom.value ?? 1}
        />
      ))}
    </>
  );
}
