import * as Y from 'yjs';
import {
  createWhiteboardDoc,
  addElementToArray,
  removeElementFromArray,
  updateElementInArray,
  getElementsFromArray,
} from './yjsDoc';
import {
  createYWebsocketProvider,
  destroyProvider,
  type FollowCallback,
  type PresenceCallback,
} from './yWebsocketProvider';
import type { FollowMessage } from './followMessage';
import { isYjsProviderConnected } from './providerStatus';
import { randomHexId } from '@/lib/crypto/randomId';
import type { CanvasElement, WhiteboardUser, RemoteCursor } from '@/types/whiteboard';

type ChangeCallback = (type: string, data: any) => void;

function isProviderConnected(provider: ReturnType<typeof createYWebsocketProvider>['provider']) {
  return isYjsProviderConnected(provider);
}

function readProviderStatus(provider: ReturnType<typeof createYWebsocketProvider>['provider']) {
  const shouldConnect = (provider as any).shouldConnect !== false;
  const connected = isProviderConnected(provider);
  return {
    status: connected ? 'connected' : shouldConnect ? 'connecting' : 'disconnected',
    connected,
  };
}

export type PresencePayload = {
  users?: Array<{ peerId: string; userName: string; color: string; accountId?: string }>;
  hostPeerId?: string;
  waitingPeers?: Array<{ peerId: string; userName: string; color: string; accountId?: string }>;
};

export function createCollaboration(
  roomId: string,
  peerId?: string,
  onPresence?: PresenceCallback,
  onFollow?: FollowCallback,
) {
  const { doc, elementsArray, viewportMap, cursorsMap } = createWhiteboardDoc(roomId);
  const providerEntry = createYWebsocketProvider(doc, roomId, onPresence, onFollow);
  const { provider, status } = providerEntry;

  let localPeerId = peerId || `user-${randomHexId()}`;
  let localUserName = 'Anonymous';
  let localUserColor = '#3498db';
  let lastCursorX = 0;
  let lastCursorY = 0;
  const changeCallbacks: ChangeCallback[] = [];
  const reconnectInterval = setInterval(() => {
    if ((provider as any).shouldConnect !== false && !isProviderConnected(provider)) {
      provider.connect();
      changeCallbacks.forEach((cb) => cb('status', readProviderStatus(provider)));
    }
  }, 5_000);

  function setLocalCursor(x: number, y: number, button: 'up' | 'down' = 'up') {
    lastCursorX = x;
    lastCursorY = y;
    const cursorData = {
      x,
      y,
      userName: localUserName,
      color: localUserColor,
      peerId: localPeerId,
      button,
    };
    cursorsMap.set(localPeerId, cursorData);
  }

  function setLocalUserName(name: string) {
    localUserName = name;
    const cursorData = cursorsMap.get(localPeerId) as Record<string, unknown> | undefined;
    if (cursorData) {
      (cursorData as any).userName = name;
      cursorsMap.set(localPeerId, cursorData);
    }
  }

  function setLocalUserColor(color: string) {
    localUserColor = color;
    const cursorData = cursorsMap.get(localPeerId) as Record<string, unknown> | undefined;
    if (cursorData) {
      (cursorData as any).color = color;
      cursorsMap.set(localPeerId, cursorData);
    }
  }

  function adoptLocalPeerId(nextPeerId: string) {
    if (!nextPeerId || nextPeerId === localPeerId) return;
    const cursorData = cursorsMap.get(localPeerId) as Record<string, unknown> | undefined;
    cursorsMap.delete(localPeerId);
    localPeerId = nextPeerId;
    if (cursorData) {
      cursorData.peerId = nextPeerId;
      cursorsMap.set(nextPeerId, cursorData);
      return;
    }
    setLocalCursor(lastCursorX, lastCursorY);
  }

  function getUsers(): WhiteboardUser[] {
    const users: WhiteboardUser[] = [];
    cursorsMap.forEach((value, key) => {
      users.push({
        peerId: (value as RemoteCursor).peerId || key,
        userName: (value as RemoteCursor).userName || 'Anonymous',
        color: (value as RemoteCursor).color || '#3498db',
        isHost: false,
      });
    });
    return users;
  }

  function getRemoteCursors(): RemoteCursor[] {
    const cursors: RemoteCursor[] = [];
    cursorsMap.forEach((value, key) => {
      const entry = value as RemoteCursor & {
        cursor?: { pointer?: { x?: number; y?: number }; x?: number; y?: number };
      };
      const pointer = entry.cursor?.pointer ?? entry.cursor;
      cursors.push({
        peerId: entry.peerId || key,
        userName: entry.userName || 'Anonymous',
        color: entry.color || '#3498db',
        x: typeof entry.x === 'number' ? entry.x : typeof pointer?.x === 'number' ? pointer.x : 0,
        y: typeof entry.y === 'number' ? entry.y : typeof pointer?.y === 'number' ? pointer.y : 0,
        button: entry.button === 'down' ? 'down' : 'up',
      });
    });
    return cursors;
  }

  function getElements(): CanvasElement[] {
    return getElementsFromArray(elementsArray);
  }

  function addElement(element: CanvasElement) {
    addElementToArray(elementsArray, element);
  }

  function removeElement(elementId: string) {
    removeElementFromArray(elementsArray, elementId);
  }

  function updateElement(elementId: string, updates: Partial<CanvasElement>) {
    updateElementInArray(elementsArray, elementId, updates);
  }

  function onChange(callback: ChangeCallback) {
    changeCallbacks.push(callback);
    callback('status', readProviderStatus(provider));
  }

  provider.on('status', (event: { status?: string; connected?: boolean }) => {
    const connected = event.status === 'connected' || event.connected === true;
    const shouldConnect = (provider as any).shouldConnect !== false;
    changeCallbacks.forEach((cb) => cb('status', {
      status: connected ? 'connected' : shouldConnect ? 'connecting' : 'disconnected',
      connected,
    }));
  });

  provider.on('synced', (event: boolean | { synced: boolean }) => {
    const synced = typeof event === 'boolean' ? event : event.synced;
    changeCallbacks.forEach((cb) => cb('status', {
      status: synced ? 'synced' : readProviderStatus(provider).status,
      connected: isProviderConnected(provider),
      synced,
    }));
  });

  elementsArray.observeDeep(() => {
    const elements = getElementsFromArray(elementsArray);
    changeCallbacks.forEach((cb) => cb('elements', elements));
  });

  viewportMap.observe(() => {
    const vp = {
      x: Number(viewportMap.get('x') ?? 0),
      y: Number(viewportMap.get('y') ?? 0),
      zoom: Number(viewportMap.get('zoom') ?? 1),
    };
    changeCallbacks.forEach((cb) => cb('viewport', vp));
  });

  cursorsMap.observeDeep(() => {
    changeCallbacks.forEach((cb) => cb('cursors', getRemoteCursors()));
  });

  function destroy() {
    clearInterval(reconnectInterval);
    cursorsMap.delete(localPeerId);
    destroyProvider(roomId);
    doc.destroy();
    changeCallbacks.length = 0;
  }

  return {
    doc,
    elementsArray,
    viewportMap,
    cursorsMap,
    provider,
    status,
    localUserName,
    localUserColor,
    get localPeerId() {
      return localPeerId;
    },
    setLocalCursor,
    setLocalUserName,
    setLocalUserColor,
    adoptLocalPeerId,
    getUsers,
    getElements,
    addElement,
    removeElement,
    updateElement,
    sendFollowMessage: (message: FollowMessage) => providerEntry.sendFollowMessage?.(message) ?? false,
    onChange,
    destroy,
  };
}
