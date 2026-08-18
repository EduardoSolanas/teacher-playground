import * as Y from 'yjs';
import {
  createWhiteboardDoc,
  addElementToArray,
  removeElementFromArray,
  updateElementInArray,
  getElementsFromArray,
} from './yjsDoc';
import { createYWebsocketProvider, destroyProvider } from './yWebsocketProvider';
import { randomHexId } from '@/lib/crypto/randomId';
import type { CanvasElement, WhiteboardUser, RemoteCursor } from '@/types/whiteboard';

type ChangeCallback = (type: string, data: any) => void;

function isProviderConnected(provider: ReturnType<typeof createYWebsocketProvider>['provider']) {
  const state = provider as { connected?: boolean; wsconnected?: boolean };
  return Boolean(state.wsconnected ?? state.connected);
}

function readProviderStatus(provider: ReturnType<typeof createYWebsocketProvider>['provider']) {
  const shouldConnect = (provider as any).shouldConnect !== false;
  const connected = isProviderConnected(provider);
  return {
    status: connected ? 'connected' : shouldConnect ? 'connecting' : 'disconnected',
    connected,
  };
}

export function createCollaboration(roomId: string, peerId?: string) {
  const { doc, elementsArray, viewportMap, cursorsMap } = createWhiteboardDoc(roomId);
  const { provider, status } = createYWebsocketProvider(doc, roomId);

  const localPeerId = peerId || `user-${randomHexId()}`;
  let localUserName = 'Anonymous';
  let localUserColor = '#3498db';
  const changeCallbacks: ChangeCallback[] = [];
  const reconnectInterval = setInterval(() => {
    if ((provider as any).shouldConnect !== false && !isProviderConnected(provider)) {
      provider.connect();
      changeCallbacks.forEach((cb) => cb('status', readProviderStatus(provider)));
    }
  }, 5_000);

  function setLocalCursor(x: number, y: number) {
    const cursorData = {
      x,
      y,
      userName: localUserName,
      color: localUserColor,
      peerId: localPeerId,
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

  const observers: Set<string> = new Set();

  cursorsMap.observe(() => {
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
    localPeerId,
    localUserName,
    localUserColor,
    setLocalCursor,
    setLocalUserName,
    setLocalUserColor,
    getUsers,
    getElements,
    addElement,
    removeElement,
    updateElement,
    onChange,
    destroy,
  };
}
