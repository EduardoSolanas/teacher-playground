import type { Viewport } from '@/types/whiteboard';

type KonvaEventLike = {
  evt?: { clientX?: number; clientY?: number };
  target?: {
    getStage?: () => {
      getPointerPosition?: () => { x: number; y: number } | null;
      container?: () => { getBoundingClientRect?: () => DOMRect };
    } | null;
  };
};

export function getCanvasPointer(e: KonvaEventLike, viewport: Viewport) {
  const stage = e.target?.getStage?.();
  const pointer = stage?.getPointerPosition?.();

  if (pointer) {
    return {
      x: (pointer.x - viewport.x) / viewport.zoom,
      y: (pointer.y - viewport.y) / viewport.zoom,
    };
  }

  const rect = stage?.container?.().getBoundingClientRect?.();
  const clientX = e.evt?.clientX ?? 0;
  const clientY = e.evt?.clientY ?? 0;

  return {
    x: (clientX - (rect?.left ?? 0) - viewport.x) / viewport.zoom,
    y: (clientY - (rect?.top ?? 0) - viewport.y) / viewport.zoom,
  };
}

/** Map window/client coordinates to canvas space using the Konva stage container. */
export function clientToCanvas(
  clientX: number,
  clientY: number,
  viewport: Viewport,
  stageContainer?: HTMLElement | null,
) {
  const rect = stageContainer?.getBoundingClientRect();
  const stageX = clientX - (rect?.left ?? 0);
  const stageY = clientY - (rect?.top ?? 0);
  return {
    x: (stageX - viewport.x) / viewport.zoom,
    y: (stageY - viewport.y) / viewport.zoom,
  };
}

/** Map canvas coordinates to pixels inside an overlay div that sits above the stage. */
export function canvasPointToOverlay(
  cx: number,
  cy: number,
  viewport: Viewport,
  stageContainer: HTMLElement | null | undefined,
  overlayElement: HTMLElement | null | undefined,
) {
  const stageRect = stageContainer?.getBoundingClientRect();
  const overlayRect = overlayElement?.getBoundingClientRect();
  const stagePx = cx * viewport.zoom + viewport.x;
  const stagePy = cy * viewport.zoom + viewport.y;

  if (!stageRect || !overlayRect) {
    return { x: stagePx, y: stagePy };
  }

  return {
    x: stagePx + stageRect.left - overlayRect.left,
    y: stagePy + stageRect.top - overlayRect.top,
  };
}
