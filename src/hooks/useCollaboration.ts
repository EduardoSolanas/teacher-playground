import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  WhiteboardUser,
  CanvasElement,
  Viewport,
  RemoteCursor,
} from '@/types/whiteboard';
import { createCollaboration } from '@/lib/whiteboard/collaboration';
import { getStablePeerId } from '@/lib/whiteboard/peerId';
import * as store from '@/lib/whiteboard/store';

const DEFAULT_MAX_USERS = 3;

function elementsEqual(a: CanvasElement[], b: CanvasElement[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyHostFromApi(
  hostPeerIdRef: { current: string | null },
  hostPeerId: unknown,
) {
  if (hostPeerId != null && String(hostPeerId).length > 0) {
    hostPeerIdRef.current = String(hostPeerId);
  }
}

export function useCollaboration(roomId: string) {
  const [isConnected, setIsConnected] = useState(false);
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
  const elementsRef = useRef<CanvasElement[]>([]);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const lastRoomUpdatedAtRef = useRef(0);
  const localPeerIdRef = useRef(getStablePeerId(roomId));
  const [localPeerId, setLocalPeerId] = useState(localPeerIdRef.current);
  /** First user to join the room (from presence API), not "this browser". */
  const hostPeerIdRef = useRef<string | null>(null);
  const [localUserName, setLocalUserName] = useState('Anonymous');
  const localUserNameRef = useRef('Anonymous');
  const [hasJoined, setHasJoined] = useState(false);
  const hasJoinedRef = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collaborationRef = useRef<ReturnType<typeof createCollaboration> | null>(null);
  const pendingUserNameRef = useRef(localUserName);
  const localUserColorRef = useRef('#3498db');
  const isRemoteUpdateRef = useRef(false);

  function ensureCollaboration() {
    if (!collaborationRef.current) {
      const peerId = getStablePeerId(roomId);
      localPeerIdRef.current = peerId;
      setLocalPeerId(peerId);
      collaborationRef.current = createCollaboration(roomId, peerId);
    }
    return collaborationRef.current;
  }

  ensureCollaboration();

  const applyElements = useCallback((nextElements: CanvasElement[]) => {
    if (isRemoteUpdateRef.current) return;
    isRemoteUpdateRef.current = true;
    if (!elementsEqual(elementsRef.current, nextElements)) {
      elementsRef.current = nextElements;
      setElements(nextElements);
      store.setElements(nextElements);
    }
    isRemoteUpdateRef.current = false;
  }, []);

  const applyViewport = useCallback((nextViewport: Viewport) => {
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
    store.setViewport(nextViewport);
  }, []);

  // Load room state from API on mount
  useEffect(() => {
    let cancelled = false;

    async function loadRoom() {
      try {
        const res = await fetch(`/api/whiteboard/room/${roomId}`);
        if (cancelled) return;

        if (res.ok) {
          const data = await res.json();
          const loadedElements = data.elements || [];
          const loadedViewport = data.viewport || { x: 0, y: 0, zoom: 1 };
          lastRoomUpdatedAtRef.current = data.updated_at || Date.now();
          setMaxUsers(data.maxUsers || DEFAULT_MAX_USERS);
          applyHostFromApi(hostPeerIdRef, data.hostPeerId);
          applyElements(loadedElements);
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
      }
    }

    loadRoom();
    return () => { cancelled = true; };
  }, [roomId, applyElements, applyViewport]);

  // Set up collaboration event listeners
  useEffect(() => {
    const collaboration = ensureCollaboration();

    collaboration.onChange((type, data) => {
      if (type === 'elements') {
        applyElements(data as CanvasElement[]);
      }
      if (type === 'viewport') {
        applyViewport(data as Viewport);
      }
      if (type === 'cursors') {
        const all = data as RemoteCursor[];
        const selfId = localPeerIdRef.current;
        const hostId = hostPeerIdRef.current;
        setCursors(all.filter((c) => c.peerId !== selfId));
        setUsers((prev) => {
          const merged = new Map(prev.map((u) => [u.peerId, { ...u }]));
          for (const c of all) {
            merged.set(c.peerId, {
              peerId: c.peerId,
              userName: c.userName,
              color: c.color,
              isHost: hostId != null && c.peerId === hostId,
            });
          }
          if (hostId) {
            for (const u of merged.values()) {
              u.isHost = u.peerId === hostId;
            }
          }
          return Array.from(merged.values());
        });
      }
    });

    return () => {
      collaboration.destroy();
      collaborationRef.current = null;
    };
  }, [roomId]);

  // Sync store changes to Yjs (local edits → broadcast)
  const prevElementsSnapshotRef = useRef<string>('');
  const prevElementsRefForSync = useRef<CanvasElement[]>([]);

  useEffect(() => {
    return store.subscribe(() => {
      const collab = collaborationRef.current;
      if (!collab) return;
      if (isRemoteUpdateRef.current) return;

      const state = store.getState();
      const localElements = state.elements;
      const localViewport = state.viewport;

      if (localElements === prevElementsRefForSync.current) return;
      prevElementsRefForSync.current = localElements;

      const snapshot = JSON.stringify(localElements);
      if (snapshot === prevElementsSnapshotRef.current) return;
      prevElementsSnapshotRef.current = snapshot;

      isRemoteUpdateRef.current = true;
      try {
        collab.doc.transact(() => {
          const collabArr = collab.elementsArray;
          const collabMap = new Map<string, number>();
          for (let i = 0; i < collabArr.length; i++) {
            const id = collabArr.get(i)?.get?.('id') as string | undefined;
            if (id) collabMap.set(id, i);
          }

          const localIds = new Set(localElements.map((e: CanvasElement) => e.id));

          // Remove deleted elements (iterate backward to keep indices stable)
          const toDelete: number[] = [];
          for (const [id, idx] of collabMap) {
            if (!localIds.has(id)) toDelete.push(idx);
          }
          toDelete.sort((a, b) => b - a);
          for (const idx of toDelete) {
            collabArr.delete(idx, 1);
          }

          // Rebuild the collabMap after deletions
          const afterDeleteMap = new Map<string, number>();
          for (let i = 0; i < collabArr.length; i++) {
            const id = collabArr.get(i)?.get?.('id') as string | undefined;
            if (id) afterDeleteMap.set(id, i);
          }

          // Add new elements, update only changed ones
          for (const el of localElements) {
            const idx = afterDeleteMap.get(el.id);
            if (idx === undefined) {
              collab.addElement(el);
            } else {
              const yMap = collabArr.get(idx);
              if (!yMap) continue;
              for (const [key, value] of Object.entries(el)) {
                const stored = yMap.get(key);
                if (key === 'points') {
                  const serialized = JSON.stringify(value || []);
                  if (stored !== serialized) yMap.set(key, serialized);
                } else {
                  if (stored !== value) yMap.set(key, value);
                }
              }
            }
          }
        });

        // Sync viewport
        const vp = collab.viewportMap;
        const cx = Number(vp.get('x') ?? 0);
        const cy = Number(vp.get('y') ?? 0);
        const cz = Number(vp.get('zoom') ?? 1);
        if (cx !== localViewport.x || cy !== localViewport.y || cz !== localViewport.zoom) {
          collab.doc.transact(() => {
            vp.set('x', localViewport.x);
            vp.set('y', localViewport.y);
            vp.set('zoom', localViewport.zoom);
          });
        }
      } finally {
        isRemoteUpdateRef.current = false;
      }
    });
  }, []);

  // Debounced save to API
  const saveState = useCallback(
    (newElements: CanvasElement[], newViewport: Viewport) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/whiteboard/room/${roomId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              room_id: roomId,
              elements: newElements,
              viewport: newViewport,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            lastRoomUpdatedAtRef.current = data.updated_at || Date.now();
          }
        } catch {
          // Silently fail -- data is still in memory
        }
      }, 3000);
    },
    [roomId]
  );

  useEffect(() => {
    if (!isConnected) return;

    let cancelled = false;

    async function pollRoomState() {
      // Skip polling when WebRTC is synced — it's the source of truth
      const entry = collaborationRef.current;
      if (entry?.provider?.connected) return;

      try {
        const res = await fetch(`/api/whiteboard/room/${roomId}`);
        if (cancelled || !res.ok) return;

        const data = await res.json();
        const updatedAt = data.updated_at || 0;
        if (updatedAt <= lastRoomUpdatedAtRef.current) return;

        const remoteElements = data.elements || [];
        const remoteViewport = data.viewport || { x: 0, y: 0, zoom: 1 };
        lastRoomUpdatedAtRef.current = updatedAt;
        applyElements(remoteElements);
        applyViewport(remoteViewport);
      } catch {
        // WebRTC/Yjs and local edits can continue when polling is unavailable.
      }
    }

    const interval = window.setInterval(pollRoomState, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isConnected, roomId, applyElements, applyViewport]);

  // Broadcast local cursor
  const setCursor = useCallback(
    (x: number, y: number) => {
      if (!hasJoinedRef.current) return;
      collaborationRef.current?.setLocalCursor(x, y);
    },
    []
  );

  const setUserName = useCallback((name: string) => {
    localUserNameRef.current = name;
    pendingUserNameRef.current = name;
    hasJoinedRef.current = true;
    setHasJoined(true);
    setLocalUserName(name);
    collaborationRef.current?.setLocalUserName(name);
    collaborationRef.current?.setLocalCursor(0, 0);
  }, []);

  useEffect(() => {
    if (!isConnected || !hasJoined) return;

    let cancelled = false;

    async function updatePresence() {
      try {
        const res = hasJoined
          ? await fetch(`/api/whiteboard/room/${roomId}/presence`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                peerId: localPeerIdRef.current,
                userName: pendingUserNameRef.current,
                color: localUserColorRef.current,
              }),
            })
          : await fetch(`/api/whiteboard/room/${roomId}/presence`);

        if (!cancelled && res.ok) {
          const data = await res.json();
          if (data.hostPeerId != null) {
            applyHostFromApi(hostPeerIdRef, data.hostPeerId);
          }
          if (Array.isArray(data.users) && data.users.length > 0) {
            const apiUsers = data.users as WhiteboardUser[];
            const hostId = hostPeerIdRef.current;
            setUsers(
              apiUsers.map((u) => ({
                ...u,
                isHost: hostId != null ? u.peerId === hostId : u.isHost,
              })),
            );
          }
          if (Array.isArray(data.waitingPeers)) {
            const hostId = hostPeerIdRef.current;
            setWaitingPeers(
              data.waitingPeers.map((p: any) => ({
                peerId: p.peerId,
                userName: p.userName,
                color: p.color,
                isHost: false,
                isWaiting: true,
              })),
            );
          }
          if (data.isWaiting) {
            setIsWaiting(true);
          }
        }
      } catch {
        // WebRTC/Yjs can still provide presence when the API heartbeat is unavailable.
      }
    }

    updatePresence();
    const interval = window.setInterval(updatePresence, 2_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (hasJoined) {
        const url = `/api/whiteboard/room/${roomId}/presence?peerId=${encodeURIComponent(localPeerIdRef.current)}`;
        fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
      }
    };
  }, [isConnected, hasJoined, roomId, localUserName]);

  // Fallback presence while the collaboration provider is still initializing.
  useEffect(() => {
    if (isConnected && hasJoined && users.length === 0) {
      setUsers([
        {
          peerId: localPeerIdRef.current,
          userName: localUserName,
          color: '#3498db',
          isHost: true,
        },
      ]);
      setCursors([]);
    }
  }, [isConnected, hasJoined, localUserName, users.length]);

  return {
    isConnected,
    isSynced,
    users,
    cursors,
    error,
    setCursor,
    setUserName,
    localPeerId,
    provider: collaborationRef.current?.provider ?? null,
    elementsArray: elements,
    status,
    maxUsers,
    elements,
    setElements: (newElements: CanvasElement[]) => {
      const sameElements = elementsEqual(elementsRef.current, newElements);
      elementsRef.current = newElements;
      setElements(newElements);
      if (!sameElements) {
        saveState(newElements, viewportRef.current);
      }
    },
    viewport,
    setViewport: (newViewport: Viewport) => {
      viewportRef.current = newViewport;
      setViewport(newViewport);
      store.setViewport(newViewport);
      saveState(elementsRef.current, newViewport);
    },
    collaboration: collaborationRef.current,
  };
}
