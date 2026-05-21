import type { CanvasElement } from '@/types/whiteboard';

export type StoreActions = {
  selectElement: (id: string) => void;
  selectMultiple: (ids: string[]) => void;
  deselectAll: () => void;
  addElement: (element: CanvasElement) => void;
  removeElement: (id: string) => void;
  updateElement: (id: string, updates: Partial<CanvasElement>) => void;
  getState: () => {
    elements: CanvasElement[];
    selectedIds: string[];
    viewport: { x: number; y: number; zoom: number };
  };
};

export function selectElement(st: StoreActions, id: string) {
  st.selectElement(id);
}

export function toggleElementSelection(st: StoreActions, id: string) {
  const selected = st.getState().selectedIds;
  if (selected.includes(id)) {
    const next = selected.filter((sid) => sid !== id);
    if (next.length === 0) {
      st.deselectAll();
    } else {
      st.selectMultiple(next);
    }
  } else {
    st.selectMultiple([...selected, id]);
  }
}

export function selectRectangle(
  st: StoreActions,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const { elements, viewport } = st.getState();
  const sx1 = Math.min(x1, x2);
  const sy1 = Math.min(y1, y2);
  const sx2 = Math.max(x1, x2);
  const sy2 = Math.max(y1, y2);

  const canvasX1 = (sx1 - viewport.x) / viewport.zoom;
  const canvasY1 = (sy1 - viewport.y) / viewport.zoom;
  const canvasX2 = (sx2 - viewport.x) / viewport.zoom;
  const canvasY2 = (sy2 - viewport.y) / viewport.zoom;

  const rectX1 = Math.min(canvasX1, canvasX2);
  const rectY1 = Math.min(canvasY1, canvasY2);
  const rectX2 = Math.max(canvasX1, canvasX2);
  const rectY2 = Math.max(canvasY1, canvasY2);

  const matchingIds = elements
    .filter((el) => {
      if (el.type === 'pen' || el.type === 'line' || el.type === 'arrow') {
        return (el as CanvasElement & { points: { x: number; y: number }[] }).points.some(
          (p) => p.x >= rectX1 && p.x <= rectX2 && p.y >= rectY1 && p.y <= rectY2,
        );
      }
      const elX = 'x' in el ? (el as CanvasElement & { x: number }).x : 0;
      const elY = 'y' in el ? (el as CanvasElement & { y: number }).y : 0;
      const elW = 'width' in el ? (el as CanvasElement & { width: number }).width : 0;
      const elH = 'height' in el ? (el as CanvasElement & { height: number }).height : 0;

      return (
        elX + elW >= rectX1 &&
        elX <= rectX2 &&
        elY + elH >= rectY1 &&
        elY <= rectY2
      );
    })
    .map((el) => el.id);

  st.selectMultiple(matchingIds);
}

export function deselectAll(st: StoreActions) {
  st.deselectAll();
}

export function getSelectedElements(st: StoreActions): CanvasElement[] {
  const selectedIds = st.getState().selectedIds;
  const elements = st.getState().elements;
  return elements.filter((el) => selectedIds.includes(el.id));
}

export function moveSelectedElements(
  st: StoreActions,
  dx: number,
  dy: number,
) {
  const selectedIds = st.getState().selectedIds;
  for (const id of selectedIds) {
    const el = st.getState().elements.find((e) => e.id === id);
    if (!el) continue;

    const updates: Partial<CanvasElement> = {};

    if ('x' in el && 'y' in el) {
      (updates as Partial<CanvasElement & { x: number; y: number }>).x = el.x + dx;
      (updates as Partial<CanvasElement & { x: number; y: number }>).y = el.y + dy;
    }

    if ('points' in el) {
      const newPoints = (el as CanvasElement & { points: { x: number; y: number }[] }).points.map(
        (p: { x: number; y: number }) => ({
          x: p.x + dx,
          y: p.y + dy,
        }),
      );
      (updates as Partial<CanvasElement & { points: { x: number; y: number }[] }>).points = newPoints;
    }

    st.updateElement(id, updates);
  }
}

export function deleteSelectedElements(st: StoreActions) {
  const selectedIds = st.getState().selectedIds;
  for (const id of selectedIds) {
    st.removeElement(id);
  }
  st.deselectAll();
}

export function duplicateSelectedElements(st: StoreActions) {
  const selectedElements = getSelectedElements(st);
  const newIds: string[] = [];

  for (const el of selectedElements) {
    const newElement: CanvasElement = {
      ...el,
      id: crypto.randomUUID?.() || Math.random().toString(36).slice(2),
    };

    if ('x' in el && 'y' in el) {
      (newElement as any).x = (el as any).x + 20;
      (newElement as any).y = (el as any).y + 20;
    }

    if ('points' in el) {
      (newElement as any).points = (el as any).points.map(
        (p: { x: number; y: number }) => ({
          x: p.x + 20,
          y: p.y + 20,
        }),
      );
    }

    st.addElement(newElement);
    newIds.push(newElement.id);
  }

  if (newIds.length > 0) {
    st.selectMultiple(newIds);
  }
}
