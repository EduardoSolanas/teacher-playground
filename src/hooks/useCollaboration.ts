import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  WhiteboardUser,
  CanvasElement,
  Viewport,
  RemoteCursor,
} from '@/types/whiteboard';
import { createCollaboration, type PresencePayload } from '@/lib/whiteboard/collaboration';
import {
  shouldStartCollaboration,
  type GrantedPublicRole,
  type RoomAccessStatus,
} from '@/lib/whiteboard/collaborationGate';
import { getStablePeerId, peerIdWhenJoined, rememberIssuedPeerId } from '@/lib/whiteboard/peerId';
import { randomHexId } from '@/lib/crypto/randomId';
import * as store from '@/lib/whiteboard/store';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { mergeApiSnapshotElements, uniqueElementsById } from '@/lib/whiteboard/excalidrawSync';
import { isLocalRoomHost } from '@/lib/whiteboard/localHost';
import { admissionFromPresenceStatus } from '@/lib/whiteboard/presenceAdmission';
import { mergeCursorPresence } from '@/lib/whiteboard/mergeCursorPresence';
import { shouldPollRoomApiFallback } from '@/lib/whiteboard/providerStatus';
import { replaceSharedElements } from '@/lib/whiteboard/yjsDoc';
import { VIEWPORT_SAVE_DEBOUNCE_MS, shouldStoreViewport } from '@/lib/whiteboard/viewportPersist';
import { shouldPollPresence } from '@/lib/whiteboard/presencePolling';
import { cursorPublishDelay } from '@/lib/whiteboard/cursorPublishRate';
import { moderationTargetBody } from '@/lib/whiteboard/moderationTarget';
import { DEFAULT_MAX_USERS } from '@/lib/plan/limits';
import {
  isWhiteboardLatencyProbeEnabled,
  recordWhiteboardLatencyEvent,
} from '@/lib/whiteboard/latencyProbe';

function elementsEqual(a: CanvasElement[], b: CanvasElement[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyHostFromApi(
  hostPeerIdRef: { current: string | null },
  hostPeerId: unknown,
  setHostPeerId?: (peerId: string) => void,
) {
  if (hostPeerId != null && String(hostPeerId).length > 0) {
    const nextHostPeerId = String(hostPeerId);
    hostPeerIdRef.current = nextHostPeerId;
    setHostPeerId?.(nextHostPeerId);
  }
}

export function useCollaboration(roomId: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [roomLoaded, setRoomLoaded] = useState(false);
  const [isSynced, setIsSynced] = useState(false);
  const [users, setUsers] = useState<WhiteboardUser[]>([]);
  const [cursors, setCursors] = useState<RemoteCursor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('connecting');
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [maxUsers, setMaxUsers] = useState(DEFAULT_MAX_USERS);
  const [waitingPeers, setWaitingPeers] = useState<WhiteboardUser[]>([]);
  const [isWaiting, setIsWaiting] = useState(false);
  // Bumped when the room must be re-read, e.g. after the host admits this peer.
  const [roomReloadKey, setRoomReloadKey] = useState(0);
  const wasWaitingRef = useRef(false);
  const [wasKicked, setWasKicked] = useState(false);
  const [wasRejected, setWasRejected] = useState(false);
  const [wasSuspended, setWasSuspended] = useState(false);
  const admittedRef = useRef(false);
  const [roomGranted, setRoomGranted] = useState(false);
  const [accessStatus, setAccessStatus] = useState<RoomAccessStatus | null>(null);
  const [grantRole, setGrantRole] = useState<GrantedPublicRole | null>(null);
  const [collaborationEpoch, setCollaborationEpoch] = useState(0);
  const [moderationError, setModerationError] = useState<string | null>(null);
  const elementsRef = useRef<CanvasElement[]>([]);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const lastRoomUpdatedAtRef = useRef(0);
  const localPeerIdRef = useRef(`user-${randomHexId()}`);
  /*
   * The presence applier, reachable from a callback created before it exists.
   *
   * ensureCollaboration hands a presence handler to the provider while
   * applyPresencePayload is still further down the hook. Closing over it
   * directly happens to work — the closure resolves when the frame arrives,
   * long after declaration — but it reads as use-before-declare and lint
   * refuses it. A ref makes the ordering explicit instead of incidental.
   */
  const applyPresenceRef = useRef<(data: unknown) => void>(() => {});
  const [localPeerId, setLocalPeerId] = useState(localPeerIdRef.current);
  /** First user to join the room (from presence API), not "this browser". */
  const hostPeerIdRef = useRef<string | null>(null);
  const [hostPeerId, setHostPeerId] = useState<string | null>(null);
  const [localUserName, setLocalUserName] = useState('Anonymous');
  const localUserNameRef = useRef('Anonymous');
  const [hasJoined, setHasJoined] = useState(false);
  const hasJoinedRef = useRef(false);
  const collaborationRef = useRef<ReturnType<typeof createCollaboration> | null>(null);
  /** Host-ness as of the last roster change, read inside the debounced view save. */
  const isHostRef = useRef(false);
  const lastStoredViewportRef = useRef<Viewport | null>(null);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const viewportSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUserNameRef = useRef(localUserName);
  const localUserColorRef = useRef('#3498db');
  const isRemoteUpdateRef = useRef(false);

  const ensureCollaboration = useCallback(() => {
    if (!collaborationRef.current) {
      const peerId = peerIdWhenJoined(hasJoinedRef.current, roomId);
      if (!peerId) return null;
      localPeerIdRef.current = peerId;
      setLocalPeerId(peerId);

      // Create callback to handle presence messages from the WebSocket push channel
      const handlePresence = (payload: unknown) => {
        applyPresenceRef.current(payload);
      };

      collaborationRef.current = createCollaboration(roomId, peerId, handlePresence);
      if (pendingUserNameRef.current) {
        collaborationRef.current.setLocalUserName(pendingUserNameRef.current);
      }
      if (localUserColorRef.current) {
        collaborationRef.current.setLocalUserColor(localUserColorRef.current);
      }
      if (hasJoinedRef.current) {
        collaborationRef.current.setLocalCursor(0, 0);
      }
      setCollaborationEpoch((epoch) => epoch + 1);
    }
    return collaborationRef.current;
  }, [roomId]);

  const destroyCollaboration = useCallback(() => {
    if (!collaborationRef.current) return;
    collaborationRef.current.destroy();
    collaborationRef.current = null;
    setCollaborationEpoch((epoch) => epoch + 1);
  }, []);

  const mayStartCollaboration =
    shouldStartCollaboration({
      roomGranted,
      accessStatus,
      grantRole,
      isWaiting,
      wasKicked,
    }) && hasJoined;

  const applyElements = useCallback((nextElements: CanvasElement[]) => {
    if (isRemoteUpdateRef.current) return;
    isRemoteUpdateRef.current = true;
    const unique = uniqueElementsById(nextElements);
    if (!elementsEqual(elementsRef.current, unique)) {
      elementsRef.current = unique;
      setElements(unique);
      store.setElements(unique);
    }
    isRemoteUpdateRef.current = false;
  }, []);

  /**
   * Upserts an HTTP snapshot into the shared document. Pass `previousIds: []`
   * so a partial persist cannot delete a peer's live Yjs elements.
   */
  const publishToSharedDoc = useCallback((nextElements: CanvasElement[]) => {
    const collaboration = collaborationRef.current;
    const doc = collaboration?.doc;
    const elementsArray = collaboration?.elementsArray;
    if (!doc || !elementsArray) return;

    replaceSharedElements(
      doc,
      elementsArray,
      nextElements as unknown as Record<string, unknown>[],
      'api-fallback',
      { previousIds: [] },
    );
  }, []);

  /** Elements loaded from the room that still need publishing to the document. */
  const pendingPublishRef = useRef<CanvasElement[] | null>(null);

  // A queued peer is not yet a member, so its first read of the room is
  // refused. Re-read once the host admits it, otherwise it sits on an empty
  // board while everyone else sees the existing drawing.
  useEffect(() => {
    if (wasWaitingRef.current && !isWaiting) setRoomReloadKey((key) => key + 1);
    wasWaitingRef.current = isWaiting;
  }, [isWaiting]);

  const applyViewport = useCallback((nextViewport: Viewport) => {
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
    store.setViewport(nextViewport);
  }, []);

  // Load room state from API on mount
  useEffect(() => {
    let cancelled = false;
    setRoomLoaded(false);
    setRoomGranted(false);

    async function loadRoom() {
      try {
        const [res, accessRes] = await Promise.all([
          ajaxFetch(`/api/whiteboard/room/${roomId}`),
          ajaxFetch(`/api/whiteboard/room/${roomId}/access`),
        ]);
        if (cancelled) return;

        if (accessRes.ok) {
          const access = await accessRes.json();
          setAccessStatus(access.status ?? null);
          setGrantRole(access.role ?? null);
          if (access.status === 'rejected') {
            setWasRejected(true);
          }
        }

        setRoomGranted(res.ok);

        if (res.ok) {
          const data = await res.json();
          const loadedElements = data.elements || [];
          const loadedViewport = data.viewport || { x: 0, y: 0, zoom: 1 };
          // Already the stored view: opening a room should not write it back.
          lastStoredViewportRef.current = loadedViewport;
          lastRoomUpdatedAtRef.current = data.updated_at || Date.now();
          setMaxUsers(data.maxUsers || DEFAULT_MAX_USERS);
          applyHostFromApi(hostPeerIdRef, data.hostPeerId, setHostPeerId);
          applyElements(loadedElements);
          // Also publish what the room already contains, so a board reopened
          // after a reload shows it. The scene is driven by the shared
          // document, so state that only reaches React never reaches the
          // canvas. Retried because collaboration may still be starting up.
          pendingPublishRef.current = loadedElements;
          applyViewport(loadedViewport);
          setStatus('connected');
          setIsConnected(true);
          setIsSynced(true);
        } else if (res.status === 404) {
          // New room -- create it
          setStatus('connected');
          setIsConnected(true);
          setIsSynced(true);
        } else {
          // Server error -- still allow the whiteboard to work
          setStatus('connected');
          setIsConnected(true);
          setIsSynced(true);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load room');
        setStatus('connected');
        setIsConnected(true);
        setIsSynced(true);
      } finally {
        if (!cancelled) setRoomLoaded(true);
      }
    }

    loadRoom();
    return () => { cancelled = true; };
  }, [roomId, roomReloadKey, applyElements, publishToSharedDoc, applyViewport]);

  // Set up collaboration only after admission; tear down on kick or waiting.
  useEffect(() => {
    if (!mayStartCollaboration) {
      destroyCollaboration();
      return;
    }

    const collaboration = ensureCollaboration();
    if (!collaboration) {
      destroyCollaboration();
      return;
    }

    collaboration.onChange((type, data) => {
      if (type === 'status') {
        const nextStatus = String(data?.status || 'connecting');
        setStatus(nextStatus);
        setIsConnected(Boolean(data?.connected));
        setIsSynced(Boolean(data?.synced) || nextStatus === 'synced' || nextStatus === 'connected');
      }
      if (type === 'elements') {
        applyElements(data as CanvasElement[]);
      }
      if (type === 'viewport') {
        applyViewport(data as Viewport);
      }
      if (type === 'cursors') {
        const all = data as RemoteCursor[];
        const selfId = localPeerIdRef.current;
        setCursors(all.filter((c) => c.peerId !== selfId));
        setUsers((prev) => mergeCursorPresence(prev, all));
      }
    });

    return () => {
      destroyCollaboration();
    };
  }, [mayStartCollaboration, ensureCollaboration, destroyCollaboration, applyElements, applyViewport]);

  // Excalidraw is the source of truth for elements — no store-to-Yjs sync needed
  // Yjs sync is handled entirely by ExcalidrawWrapper via onChange/onPointerUpdate

  useEffect(() => {
    // Not gated on isConnected: that goes false exactly when the link has
    // dropped, which is when this fallback is needed.
    let cancelled = false;

    async function pollRoomState() {
      // Skip polling when WebRTC is synced — it's the source of truth.
      // Note: y-webrtc leaves `connected` set after disconnect(), so this also
      // suppresses the catch-up fallback. See the fixme'd
      // "disconnected peer catches up from API fallback" e2e test.
      const entry = collaborationRef.current;
      if (!shouldPollRoomApiFallback(entry?.provider)) return;

      try {
        const res = await ajaxFetch(`/api/whiteboard/room/${roomId}`);
        if (cancelled || !res.ok) return;

        const data = await res.json();
        const updatedAt = data.updated_at || 0;
        if (updatedAt <= lastRoomUpdatedAtRef.current) return;

        const remoteElements = data.elements || [];
        const remoteViewport = data.viewport || { x: 0, y: 0, zoom: 1 };
        lastRoomUpdatedAtRef.current = updatedAt;
        // Reconcile rather than overwrite: the snapshot is written on a
        // debounce, so it can be older than what the user just drew. Merging
        // per element keeps unsaved local work while still catching up.
        const merged = mergeApiSnapshotElements(
          elementsRef.current,
          remoteElements,
        ) as unknown as CanvasElement[];
        applyElements(merged);
        publishToSharedDoc(merged);
        applyViewport(remoteViewport);
      } catch {
        // WebRTC/Yjs and local edits can continue when polling is unavailable.
      }
    }

    // Drain the initial load once the shared document exists.
    function publishPending() {
      const pending = pendingPublishRef.current;
      if (!pending || pending.length === 0) return;
      if (!collaborationRef.current?.elementsArray) return;
      pendingPublishRef.current = null;
      publishToSharedDoc(
        mergeApiSnapshotElements(pending, []) as unknown as CanvasElement[],
      );
    }

    const publishTimer = window.setInterval(publishPending, 250);
    const interval = window.setInterval(pollRoomState, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearInterval(publishTimer);
    };
  }, [roomId, applyElements, applyViewport, publishToSharedDoc]);

  // Broadcast local cursor
  const cursorSentAtRef = useRef<number | null>(null);
  const cursorPendingRef = useRef<{ x: number; y: number; button: 'up' | 'down' } | null>(null);
  const cursorTimerRef = useRef<number | null>(null);

  const publishCursor = useCallback((x: number, y: number, button: 'up' | 'down' = 'up') => {
    const collaboration = collaborationRef.current;
    if (!collaboration) return;
    collaboration.setLocalCursor(x, y, button);
    cursorSentAtRef.current = Date.now();
    if (isWhiteboardLatencyProbeEnabled()) {
      recordWhiteboardLatencyEvent({
        kind: 'cursor-publish',
        peerId: localPeerIdRef.current,
        x,
        y,
      });
    }
  }, []);

  /**
   * Every cursor write is one signaling message, so publishing per pointermove
   * exceeded the Worker's 60/sec cap and had it close the socket — a moving
   * pointer sat in a reconnect loop showing "Connecting to room…". The newest
   * position is kept and flushed when the window opens, so the cursor still
   * ends up where the pointer stopped.
   */
  const setCursor = useCallback(
    (x: number, y: number, button: 'up' | 'down' = 'up') => {
      if (!hasJoinedRef.current) return;

      const delay = cursorPublishDelay(cursorSentAtRef.current, Date.now());
      if (delay === 0) {
        cursorPendingRef.current = null;
        publishCursor(x, y, button);
        return;
      }

      cursorPendingRef.current = { x, y, button };
      if (cursorTimerRef.current !== null) return;
      cursorTimerRef.current = window.setTimeout(() => {
        cursorTimerRef.current = null;
        const pending = cursorPendingRef.current;
        cursorPendingRef.current = null;
        if (!pending || !hasJoinedRef.current) return;
        publishCursor(pending.x, pending.y, pending.button);
      }, delay);
    },
    [publishCursor]
  );

  useEffect(() => () => {
    if (cursorTimerRef.current !== null) window.clearTimeout(cursorTimerRef.current);
  }, []);

  const setUserName = useCallback((name: string) => {
    const peerId = getStablePeerId(roomId);
    localPeerIdRef.current = peerId;
    setLocalPeerId(peerId);
    localUserNameRef.current = name;
    pendingUserNameRef.current = name;
    hasJoinedRef.current = true;
    setHasJoined(true);
    setWasKicked(false);
    setWasRejected(false);
    setWasSuspended(false);
    setLocalUserName(name);
    collaborationRef.current?.setLocalUserName(name);
    collaborationRef.current?.setLocalCursor(0, 0);
  }, [roomId]);

  /**
   * Applies presence payload to update users, waiting peers, host peer id, and admission status.
   * Used by both HTTP polling and WebSocket push.
   */
  const applyPresencePayload = useCallback((data: PresencePayload & {
    isKicked?: boolean;
    isWaiting?: boolean;
    peerId?: string;
  }) => {
    if (data.hostPeerId != null) {
      applyHostFromApi(hostPeerIdRef, data.hostPeerId, setHostPeerId);
    }
    if (Array.isArray(data.users) && data.users.length > 0) {
      setUsers(data.users as WhiteboardUser[]);
    }
    if (Array.isArray(data.waitingPeers)) {
      setWaitingPeers(
        data.waitingPeers.map((p: any) => ({
          peerId: p.peerId,
          accountId: p.accountId,
          userName: p.userName,
          color: p.color,
          isHost: false,
          isWaiting: true,
        })),
      );
    }
    if (data.isKicked) {
      hasJoinedRef.current = false;
      setHasJoined(false);
      setIsWaiting(false);
      setWasKicked(true);
      setUsers([]);
      setWaitingPeers([]);
      return;
    }
    if (typeof data.isWaiting === 'boolean') {
      if (!data.isWaiting) admittedRef.current = true;
      else if (admittedRef.current) setWasSuspended(true);
      setIsWaiting(data.isWaiting);
    }
    // A heartbeat still in flight when the user leaves must not re-seed
    // the session keys that leaving just cleared.
    if (typeof data.peerId === 'string' && data.peerId.length > 0 && hasJoinedRef.current) {
      rememberIssuedPeerId(roomId, data.peerId);
      // Only when the label actually changes. Re-seeding the cursor on
      // every heartbeat published a Yjs update every 2s per client.
      if (data.peerId !== localPeerIdRef.current) {
        localPeerIdRef.current = data.peerId;
        setLocalPeerId(data.peerId);
        const collab = collaborationRef.current;
        collab?.adoptLocalPeerId(data.peerId);
        if (collab) {
          const entry = collab.cursorsMap.get(data.peerId) as { x?: number; y?: number } | undefined;
          collab.setLocalCursor(
            typeof entry?.x === 'number' ? entry.x : 0,
            typeof entry?.y === 'number' ? entry.y : 0,
          );
        }
      }
    }
  }, [roomId]);

  useEffect(() => {
    applyPresenceRef.current = applyPresencePayload as (data: unknown) => void;
  }, [applyPresencePayload]);

  useEffect(() => {
    isHostRef.current = isLocalRoomHost(grantRole, users, localPeerId);
  }, [grantRole, users, localPeerId]);

  /*
   * Store where the host left the board.
   *
   * The room keeps one view and the host's is the one worth reopening at. This
   * is the only scene write a client still makes: the board itself reaches
   * storage through the room object now, and a view is a few dozen bytes.
   */
  const storeViewport = useCallback(
    (next: Viewport) => {
      pendingViewportRef.current = next;
      if (viewportSaveTimeoutRef.current) clearTimeout(viewportSaveTimeoutRef.current);
      viewportSaveTimeoutRef.current = setTimeout(async () => {
        const view = pendingViewportRef.current;
        if (!view) return;
        if (!shouldStoreViewport({
          isHost: isHostRef.current,
          next: view,
          lastStored: lastStoredViewportRef.current,
        })) {
          return;
        }
        lastStoredViewportRef.current = view;
        try {
          await ajaxFetch(`/api/whiteboard/room/${roomId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewport: view }),
          });
        } catch {
          // The next pan tries again; a lost view is not worth a retry loop.
          lastStoredViewportRef.current = null;
        }
      }, VIEWPORT_SAVE_DEBOUNCE_MS);
    },
    [roomId],
  );

  useEffect(() => {
    if (!roomLoaded || !hasJoined) return;

    let cancelled = false;

    async function updatePresence() {
      try {
        const res = hasJoined
          ? await ajaxFetch(`/api/whiteboard/room/${roomId}/presence`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                peerId: localPeerIdRef.current,
                userName: pendingUserNameRef.current,
                color: localUserColorRef.current,
              }),
            })
          : await ajaxFetch(`/api/whiteboard/room/${roomId}/presence`);

        const presenceAdmission = admissionFromPresenceStatus(res.status);
        if (!cancelled && presenceAdmission === 'rejected') {
          const rejectedFromQueue = !admittedRef.current;
          hasJoinedRef.current = false;
          setHasJoined(false);
          setIsWaiting(false);
          if (rejectedFromQueue) setWasRejected(true);
          else setWasKicked(true);
          setUsers([]);
          setWaitingPeers([]);
          return;
        }

        if (!cancelled && presenceAdmission === 'waiting') {
          setIsWaiting(true);
          return;
        }

        if (!cancelled && presenceAdmission === 'ok') {
          const data = await res.json();
          applyPresencePayload(data);
        }
      } catch {
        // WebRTC/Yjs can still provide presence when the API heartbeat is unavailable.
      }
    }

    updatePresence();

    // Polling management: stop when socket is connected, restart when disconnected.
    // A peer in WAITING room has no socket, so keep polling for them.
    let pollInterval: number | null = null;

    const startPolling = () => {
      if (pollInterval === null) {
        pollInterval = window.setInterval(updatePresence, 2_000);
      }
    };

    const stopPolling = () => {
      if (pollInterval !== null) {
        window.clearInterval(pollInterval);
        pollInterval = null;
      }
    };

    const onConnectionChange = () => {
      const collab = collaborationRef.current;
      const socketConnected = Boolean(collab?.provider)
        && (collab!.provider as any).connected === true;
      if (shouldPollPresence({ isWaiting, socketConnected })) startPolling();
      else stopPolling();
    };

    /*
     * Decide once up front, not only when the socket next changes state.
     *
     * This used to start the interval solely from a 'status' event, so a peer
     * whose collaboration had not been created yet — or whose socket never
     * connected and never announced it — attached no listener and started no
     * poll. They fetched presence once and then heard nothing again: no push,
     * no poll, a room that silently stops updating.
     */
    onConnectionChange();

    if (collaborationRef.current) {
      (collaborationRef.current.provider as any).on?.('status', onConnectionChange);
    }

    // Browsers throttle background-tab timers to roughly once a minute, so a
    // student who switches away (or whose phone locks) can sit on the waiting
    // screen for up to 60s after the teacher has already let them in. There is
    // no push channel to fall back on: /signaling only opens once admitted.
    // Refreshing the moment the tab is visible again closes that gap.
    const onVisible = () => {
      if (document.visibilityState === 'visible') updatePresence();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      stopPolling();
      if (collaborationRef.current) {
        (collaborationRef.current.provider as any).off?.('status', onConnectionChange);
      }
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [roomLoaded, hasJoined, roomId, localUserName, isWaiting, applyPresencePayload]);

  /**
   * Releases the presence row only when this room is actually left. Doing it in
   * the heartbeat effect's cleanup dropped the row every time a dependency
   * changed — admission and a rename both re-run it — and because presence
   * mints a fresh peer id whenever an account has no row, the peer silently
   * came back under a new id. Every id the host was already holding (roster
   * rows, moderation targets, cursors) then pointed at nothing.
   */
  useEffect(() => {
    return () => {
      if (!hasJoinedRef.current) return;
      const url = `/api/whiteboard/room/${roomId}/presence?peerId=${encodeURIComponent(localPeerIdRef.current)}`;
      ajaxFetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
  }, [roomId]);

  // Fallback presence while the collaboration provider is still initializing.
  useEffect(() => {
    if (roomLoaded && hasJoined && users.length === 0) {
      setUsers([
        {
          peerId: localPeerIdRef.current,
          userName: localUserName,
          color: '#3498db',
          isHost: false,
        },
      ]);
      setCursors([]);
    }
  }, [roomLoaded, hasJoined, localUserName, users.length]);

  const reloadPresence = useCallback(async () => {
    try {
      const res = await ajaxFetch(`/api/whiteboard/room/${roomId}/presence`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.users)) {
        setUsers(data.users as WhiteboardUser[]);
      }
      if (Array.isArray(data.waitingPeers)) {
        setWaitingPeers(
          data.waitingPeers.map((p: WhiteboardUser & { accountId?: string }) => ({
            peerId: p.peerId,
            accountId: p.accountId,
            userName: p.userName,
            color: p.color,
            isHost: false,
            isWaiting: true,
          })),
        );
      }
      if (typeof data.isWaiting === 'boolean') {
        if (!data.isWaiting) admittedRef.current = true;
        else if (admittedRef.current) setWasSuspended(true);
        setIsWaiting(data.isWaiting);
      }
    } catch {
      // silently fail
    }
  }, [roomId]);

  const approvePeer = useCallback(async (peerId: string, accountId?: string | null) => {
    try {
      await ajaxFetch(`/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId,
          ...(accountId ? { accountId } : {}),
          action: 'approve',
        }),
      });
      await reloadPresence();
    } catch {
      // silently fail
    }
  }, [roomId, reloadPresence]);

  const rejectPeer = useCallback(async (peerId: string, accountId?: string | null) => {
    try {
      await ajaxFetch(`/api/whiteboard/room/${roomId}/waiting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId,
          ...(accountId ? { accountId } : {}),
          action: 'reject',
        }),
      });
      await reloadPresence();
    } catch {
      // silently fail
    }
  }, [roomId, reloadPresence]);

  const leaveWaitingRoom = useCallback(async () => {
    hasJoinedRef.current = false;
    setHasJoined(false);
    setIsWaiting(false);
    try {
      await ajaxFetch(
        `/api/whiteboard/room/${roomId}/waiting?peerId=${encodeURIComponent(localPeerIdRef.current)}`,
        { method: 'DELETE' }
      );
    } catch {
      // still drop local waiting/join so the prompt can return
    }
  }, [roomId]);

  const leaveRoom = useCallback(async () => {
    destroyCollaboration();
    hasJoinedRef.current = false;
    setHasJoined(false);
    try {
      await ajaxFetch(
        `/api/whiteboard/room/${roomId}/presence?peerId=${encodeURIComponent(localPeerIdRef.current)}`,
        { method: 'DELETE' },
      );
    } catch {
      // still drop local join state so the prompt can return
    }
  }, [roomId, destroyCollaboration]);

  const kickPeer = useCallback(async (peerId: string, accountId?: string | null) => {
    try {
      const res = await ajaxFetch(`/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(moderationTargetBody('kick', peerId, accountId)),
      });
      // ajaxFetch resolves for 403/404/409, so without this a rejected kick
      // looked exactly like a successful one.
      setModerationError(res.ok ? null : 'Could not remove that person. Please try again.');
      await reloadPresence();
      return res.ok;
    } catch {
      setModerationError('Could not remove that person. Please try again.');
      return false;
    }
  }, [roomId, reloadPresence]);

  const setHandRaised = useCallback(async (raised: boolean) => {
    try {
      const res = await ajaxFetch(`/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: raised ? 'raise-hand' : 'lower-hand' }),
      });
      if (res.ok) await reloadPresence();
      return res.ok;
    } catch {
      return false;
    }
  }, [roomId, reloadPresence]);

  const sendToWaitingRoom = useCallback(async (peerId: string, accountId?: string | null) => {
    try {
      const res = await ajaxFetch(`/api/whiteboard/room/${roomId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(moderationTargetBody('suspend', peerId, accountId)),
      });
      setModerationError(res.ok ? null : 'Could not move that person to the waiting room.');
      await reloadPresence();
      return res.ok;
    } catch {
      setModerationError('Could not move that person to the waiting room.');
      return false;
    }
  }, [roomId, reloadPresence]);

  return {
    isConnected,
    isSynced,
    users,
    cursors,
    error,
    setCursor,
    setUserName,
    localPeerId,
    isHost: isLocalRoomHost(grantRole, users, localPeerId),
    provider: collaborationEpoch >= 0 ? collaborationRef.current?.provider ?? null : null,
    elementsArray: elements,
    status,
    maxUsers,
    elements,
    yDoc: collaborationEpoch >= 0 ? collaborationRef.current?.doc ?? null : null,
    yElementsArray: collaborationEpoch >= 0 ? collaborationRef.current?.elementsArray ?? null : null,
    yCursorsMap: collaborationEpoch >= 0 ? collaborationRef.current?.cursorsMap ?? null : null,
    setElements: (newElements: CanvasElement[]) => {
      const unique = uniqueElementsById(newElements);
      elementsRef.current = unique;
      setElements(unique);
      store.setElements(unique);
    },
    viewport,
    setViewport: (newViewport: Viewport) => {
      viewportRef.current = newViewport;
      setViewport(newViewport);
      store.setViewport(newViewport);
    },
    storeViewport,
    collaboration: collaborationEpoch >= 0 ? collaborationRef.current : null,
    waitingPeers,
    isWaiting,
    wasKicked,
    wasRejected,
    wasSuspended,
    approvePeer,
    rejectPeer,
    leaveWaitingRoom,
    leaveRoom,
    kickPeer,
    sendToWaitingRoom,
    setHandRaised,
    moderationError,
    reloadPresence,
  };
}
