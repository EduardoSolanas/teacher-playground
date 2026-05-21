import { v4 as uuidv4 } from 'uuid';
import type { CanvasElement, Viewport } from '@/types/whiteboard';
import { HistoryManager } from './history';

type Palette = {
  color: string;
  strokeWidth: number;
  fill: string;
};

type ToolType =
  | 'select'
  | 'pen'
  | 'text'
  | 'rectangle'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'stickyNote'
  | 'eraser';

type Group = {
  id: string;
  memberIds: string[];
};

const _state: {
  elements: CanvasElement[];
  selectedIds: string[];
  tool: ToolType;
  palette: Palette;
  viewport: Viewport;
  selectionRect: { x1: number; y1: number; x2: number; y2: number } | null;
  groups: Group[];
  currentElement: CanvasElement | null;
} = {
  elements: [],
  selectedIds: [],
  tool: 'select',
  palette: {
    color: '#000000',
    strokeWidth: 2,
    fill: 'transparent',
  },
  viewport: {
    x: 0,
    y: 0,
    zoom: 1,
  },
  selectionRect: null,
  groups: [],
  currentElement: null,
};

const historyManager = new HistoryManager();

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      console.error('[store] listener threw:', e);
    }
  }
}

export function getState() {
  return _state;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function addElement(element: CanvasElement) {
  _state.elements = [..._state.elements, element];
  historyManager.push(_state.elements);
  notify();
}

export function updateElement(id: string, updates: Partial<CanvasElement>) {
  _state.elements = _state.elements.map((el) =>
    el.id === id ? { ...el, ...updates } as CanvasElement : el
  );
  historyManager.push(_state.elements);
  notify();
}

export function removeElement(id: string) {
  _state.elements = _state.elements.filter((el) => el.id !== id);
  _state.selectedIds = _state.selectedIds.filter((sid) => sid !== id);
  historyManager.push(_state.elements);
  notify();
}

export function selectElement(id: string) {
  _state.selectedIds = [id];
  notify();
}

export function selectMultiple(ids: string[]) {
  _state.selectedIds = ids;
  notify();
}

export function deselectAll() {
  _state.selectedIds = [];
  notify();
}

export function setTool(tool: ToolType) {
  _state.tool = tool;
  notify();
}

export function setPalette(palette: Partial<Palette>) {
  _state.palette = { ..._state.palette, ...palette };
  notify();
}

export function setViewport(viewport: Partial<Viewport>) {
  _state.viewport = { ..._state.viewport, ...viewport };
  notify();
}

export function setElements(elements: CanvasElement[]) {
  _state.elements = elements;
  historyManager.push(_state.elements);
  notify();
}

export function setCurrentElement(el: CanvasElement | null) {
  _state.currentElement = el;
  notify();
}

export function moveElement(id: string, updates: Partial<CanvasElement>) {
  return updateElement(id, updates);
}

export function duplicateElement(id: string) {
  const element = _state.elements.find((el) => el.id === id);
  if (!element) return;
  const newElement = {
    ...element,
    id: uuidv4(),
    x: 'x' in element ? (element.x as number) + 20 : 0,
    y: 'y' in element ? (element.y as number) + 20 : 0,
  } as CanvasElement;
  addElement(newElement);
  selectElement(newElement.id);
}

export function bringForward(id: string) {
  const idx = _state.elements.findIndex((el) => el.id === id);
  if (idx < 0 || idx >= _state.elements.length - 1) return;
  const newElements = [..._state.elements];
  [newElements[idx], newElements[idx + 1]] = [newElements[idx + 1], newElements[idx]];
  _state.elements = newElements;
  notify();
}

export function sendBackward(id: string) {
  const idx = _state.elements.findIndex((el) => el.id === id);
  if (idx <= 0) return;
  const newElements = [..._state.elements];
  [newElements[idx], newElements[idx - 1]] = [newElements[idx - 1], newElements[idx]];
  _state.elements = newElements;
  notify();
}

export function bringToFront(id: string) {
  const idx = _state.elements.findIndex((el) => el.id === id);
  if (idx < 0) return;
  const newElements = [..._state.elements];
  const [el] = newElements.splice(idx, 1);
  newElements.push(el);
  _state.elements = newElements;
  notify();
}

export function sendToBack(id: string) {
  const idx = _state.elements.findIndex((el) => el.id === id);
  if (idx < 0) return;
  const newElements = [..._state.elements];
  const [el] = newElements.splice(idx, 1);
  newElements.unshift(el);
  _state.elements = newElements;
  notify();
}

export function undo(): CanvasElement[] | null {
  const prev = historyManager.undo();
  if (prev !== null) {
    _state.elements = prev;
    notify();
  }
  return prev;
}

export function redo(): CanvasElement[] | null {
  const next = historyManager.redo();
  if (next !== null) {
    _state.elements = next;
    notify();
  }
  return next;
}

export function canUndo(): boolean {
  return historyManager.canUndo();
}

export function canRedo(): boolean {
  return historyManager.canRedo();
}

export function pushHistorySnapshot() {
  historyManager.push(_state.elements);
}

export function getHistoryManager() {
  return historyManager;
}

export function groupSelectedElements() {
  const selectedIds = _state.selectedIds.filter((id) =>
    _state.elements.some((el) => el.id === id)
  );
  if (selectedIds.length < 2) return;

  const existingGroupIndex = _state.groups.findIndex((g) =>
    g.memberIds.includes(selectedIds[0])
  );
  if (existingGroupIndex !== -1) {
    const existingGroup = _state.groups[existingGroupIndex];
    const newMemberIds = [...new Set([...existingGroup.memberIds, ...selectedIds])];
    _state.groups = _state.groups.map((g, i) =>
      i === existingGroupIndex ? { ...g, memberIds: newMemberIds } : g
    );
  } else {
    const newGroup: Group = {
      id: uuidv4(),
      memberIds: selectedIds,
    };
    _state.groups = [..._state.groups, newGroup];
  }
  notify();
}

export function ungroup(groupId: string) {
  _state.groups = _state.groups.filter((g) => g.id !== groupId);
  notify();
}

export function getGroupForElement(id: string): Group | undefined {
  return _state.groups.find((g) => g.memberIds.includes(id));
}

export function moveGroup(groupId: string, dx: number, dy: number) {
  const group = _state.groups.find((g) => g.id === groupId);
  if (!group) return;
  for (const memberId of group.memberIds) {
    const el = _state.elements.find((e) => e.id === memberId);
    if (!el) continue;
    const updates: Partial<CanvasElement> = {};
    if ('x' in el && 'y' in el) {
      (updates as Partial<CanvasElement & { x: number; y: number }>).x = (el as any).x + dx;
      (updates as Partial<CanvasElement & { x: number; y: number }>).y = (el as any).y + dy;
    }
    if ('points' in el) {
      const newPoints = (el as any).points.map((p: { x: number; y: number }) => ({
        x: p.x + dx,
        y: p.y + dy,
      }));
      (updates as Partial<CanvasElement & { points: { x: number; y: number }[] }>).points = newPoints;
    }
    updateElement(memberId, updates);
  }
}
