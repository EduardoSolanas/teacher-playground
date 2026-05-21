import * as Y from 'yjs';
import {
  createWhiteboardDoc,
  addElementToArray,
  removeElementFromArray,
  updateElementInArray,
  getElementsFromArray,
} from './yjsDoc';
import { createYWebRTCProvider, destroyProvider } from './ywebrtcProvider';
import type { CanvasElement, WhiteboardUser, RemoteCursor } from '@/types/whiteboard';

type ChangeCallback = (type: string, data: any) => void;

export function createCollaboration(roomId: string, peerId?: string) {
  const { doc, elementsArray, viewportMap, cursorsMap } = createWhiteboardDoc(roomId);
  const { provider, status } = createYWebRTCProvider(doc, roomId);

  const localPeerId = peerId || `user-${Math.random().toString(36).substring(2, 9)}`;
  let localUserName = 'Anonymous';
  let localUserColor = '#3498db';
  const changeCallbacks: ChangeCallback[] = [];

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
      const entry = value as RemoteCursor;
      cursors.push({
        peerId: entry.peerId || key,
        userName: entry.userName || 'Anonymous',
        color: entry.color || '#3498db',
        x: typeof entry.x === 'number' ? entry.x : 0,
        y: typeof entry.y === 'number' ? entry.y : 0,
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
  }

  doc.on('update', () => {
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
