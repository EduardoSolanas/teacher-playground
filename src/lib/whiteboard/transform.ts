import type { CanvasElement } from '@/types/whiteboard';

export const HANDLE_NAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type HandleName = (typeof HANDLE_NAMES)[number];

export function getResizeHandle(
  element: CanvasElement,
  mouseX: number,
  mouseY: number,
): HandleName | null {
  const threshold = 8;

  if (element.type === 'pen' || element.type === 'line' || element.type === 'arrow') {
    return null;
  }

  const el = element as CanvasElement & { x: number; y: number; width: number; height: number };
  const { x, y, width, height } = el;

  const handles: Array<{ name: HandleName; hx: number; hy: number }> = [
    { name: 'nw', hx: x, hy: y },
    { name: 'n', hx: x + width / 2, hy: y },
    { name: 'ne', hx: x + width, hy: y },
    { name: 'e', hx: x + width, hy: y + height / 2 },
    { name: 'se', hx: x + width, hy: y + height },
    { name: 's', hx: x + width / 2, hy: y + height },
    { name: 'sw', hx: x, hy: y + height },
    { name: 'w', hx: x, hy: y + height / 2 },
  ];

  for (const h of handles) {
    if (
      Math.abs(mouseX - h.hx) <= threshold &&
      Math.abs(mouseY - h.hy) <= threshold
    ) {
      return h.name;
    }
  }

  return null;
}

export function resizeElement(
  element: CanvasElement,
  handle: HandleName,
  mouseX: number,
  mouseY: number,
  shiftKey: boolean,
): Partial<CanvasElement> {
  if (element.type === 'pen' || element.type === 'line' || element.type === 'arrow') {
    return {};
  }

  const el = element as CanvasElement & { x: number; y: number; width: number; height: number };
  let { x, y, width, height } = el;

  const originalWidth = width;
  const originalHeight = height;
  const aspectRatio = originalWidth / (originalHeight || 1);

  let newX = x;
  let newY = y;
  let newWidth = width;
  let newHeight = height;

  switch (handle) {
    case 'se':
      newWidth = mouseX - x;
      newHeight = mouseY - y;
      break;
    case 's':
      newHeight = mouseY - y;
      break;
    case 'e':
      newWidth = mouseX - x;
      break;
    case 'sw':
      newWidth = x + width - mouseX;
      newHeight = mouseY - y;
      newX = mouseX;
      break;
    case 'nw':
      newWidth = x + width - mouseX;
      newHeight = y + height - mouseY;
      newX = mouseX;
      newY = mouseY;
      break;
    case 'n':
      newHeight = y + height - mouseY;
      newY = mouseY;
      break;
    case 'ne':
      newWidth = mouseX - x;
      newHeight = y + height - mouseY;
      newY = mouseY;
      break;
    case 'w':
      newWidth = x + width - mouseX;
      newX = mouseX;
      break;
  }

  if (shiftKey && originalWidth && originalHeight) {
    if (Math.abs(newWidth) > Math.abs(newHeight)) {
      newHeight = newWidth / aspectRatio;
      if (handle === 'n' || handle === 'nw' || handle === 'ne') {
        newY = y + height - newHeight;
      }
    } else {
      newWidth = newHeight * aspectRatio;
      if (handle === 'w' || handle === 'nw' || handle === 'sw') {
        newX = x + width - newWidth;
      }
    }
  }

  if (newWidth < 1) {
    newWidth = 1;
  }
  if (newHeight < 1) {
    newHeight = 1;
  }

  return { x: newX, y: newY, width: newWidth, height: newHeight };
}

function getElementCenter(element: CanvasElement): { x: number; y: number } | null {
  if (element.type === 'pen' || element.type === 'line' || element.type === 'arrow') {
    const pts = (element as CanvasElement & { points: { x: number; y: number }[] }).points;
    if (pts.length < 2) return null;
    return { x: pts[0].x, y: pts[0].y };
  }
  const el = element as CanvasElement & { x: number; y: number; width: number; height: number };
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

/** Rotate so the shape keeps its angle at drag start and follows pointer delta. */
export function rotateElementByDelta(
  element: CanvasElement,
  mouseX: number,
  mouseY: number,
  startAngleRad: number,
  startRotationDeg: number,
  shiftKey: boolean,
): Partial<CanvasElement> {
  const center = getElementCenter(element);
  if (!center) return {};

  const angleRad = Math.atan2(mouseY - center.y, mouseX - center.x);
  let degrees = startRotationDeg + ((angleRad - startAngleRad) * 180) / Math.PI;

  if (shiftKey) {
    degrees = Math.round(degrees / 15) * 15;
  }

  return { rotation: degrees } as Partial<CanvasElement>;
}

export function rotateElement(
  element: CanvasElement,
  mouseX: number,
  mouseY: number,
  shiftKey: boolean,
): Partial<CanvasElement> {
  const center = getElementCenter(element);
  if (!center) return {};

  const startRotation =
    'rotation' in element && typeof element.rotation === 'number' ? element.rotation : 0;
  const startAngleRad = Math.atan2(mouseY - center.y, mouseX - center.x);

  return rotateElementByDelta(
    element,
    mouseX,
    mouseY,
    startAngleRad,
    startRotation,
    shiftKey,
  );
}
