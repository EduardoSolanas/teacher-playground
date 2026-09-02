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
import {
  clearCursor,
  publishCursor,
  readCursorUsers,
  readLocalCursor,
  readRemoteCursors,
} from './cursorAwareness';
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
  const { doc, elementsArray, viewportMap } = createWhiteboardDoc(roomId);
  const providerEntry = createYWebsocketProvider(doc, roomId, onPresence, onFollow);
  const { provider, status } = providerEntry;
  // Cursors ride awareness, which the provider owns. Absent on the server,
  // where there is no socket and nothing to announce.
  const awareness = provider.awareness ?? null;

  let localPeerId = peerId || `user-${randomHexId()}`;
  let localUserName = 'Anonymous';
  let localUserColor = '#3498db';
  let lastCursorX = 0;
  let lastCursorY = 0;
  // Re-announcing on a rename must not report the pointer as lifted mid-stroke.
  let lastCursorButton: 'up' | 'down' = 'up';
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
    lastCursorButton = button;
    publishCursor(awareness, {
      x,
      y,
      userName: localUserName,
      color: localUserColor,
      peerId: localPeerId,
      button,
    });
  }

  function setLocalUserName(name: string) {
    localUserName = name;
    if (readLocalCursor(awareness)) setLocalCursor(lastCursorX, lastCursorY, lastCursorButton);
  }

  function setLocalUserColor(color: string) {
    localUserColor = color;
    if (readLocalCursor(awareness)) setLocalCursor(lastCursorX, lastCursorY, lastCursorButton);
  }

  function adoptLocalPeerId(nextPeerId: string) {
    if (!nextPeerId || nextPeerId === localPeerId) return;
    localPeerId = nextPeerId;
    // One announcement per peer, keyed by the connection rather than by the
    // peer id, so renaming needs no delete of the old key.
    setLocalCursor(lastCursorX, lastCursorY, lastCursorButton);
  }

  function getUsers(): WhiteboardUser[] {
    return readCursorUsers(awareness);
  }

  function getRemoteCursors(): RemoteCursor[] {
    return readRemoteCursors(awareness);
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

  provider.on('connection-close', (event: unknown) => {
    changeCallbacks.forEach((cb) => cb('connection-close', event));
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

  // Awareness changes are not document changes, so they arrive here rather
  // than through an observer on the doc.
  awareness?.on('change', () => {
    changeCallbacks.forEach((cb) => cb('cursors', getRemoteCursors()));
  });

  function destroy() {
    clearInterval(reconnectInterval);
    clearCursor(awareness);
    destroyProvider(roomId);
    doc.destroy();
    changeCallbacks.length = 0;
  }

  return {
    doc,
    elementsArray,
    viewportMap,
    provider,
    status,
    localUserName,
    localUserColor,
    get localPeerId() {
      return localPeerId;
    },
    getLocalCursor: () => readLocalCursor(awareness),
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
