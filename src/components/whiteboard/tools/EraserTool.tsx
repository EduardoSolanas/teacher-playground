import { useEffect, useRef, useState } from 'react';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { registerToolHandlers, clearToolHandlers } from '../ToolEvents';
import type { CanvasElement } from '@/types/whiteboard';
import { getCanvasPointer } from './pointer';

const ERASER_RADIUS = 15;

export default function EraserTool() {
  const { elements, removeElement, viewport, tool } = useWhiteboardStore();
  const isErasingRef = useRef(false);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (tool !== 'eraser') return;

    const onMouseDown = (e: any) => {
      isErasingRef.current = true;
      const pos = getCanvasPointer(e, viewport);
      setCursorPos(pos);
    };

    const onMouseMove = (e: any) => {
      if (!isErasingRef.current) return;
      const pos = getCanvasPointer(e, viewport);
      setCursorPos(pos);

      const allElements = elements || [];
      for (const el of allElements) {
        if (elementInRadius(el, pos)) {
          removeElement(el.id);
        }
      }
    };

    const onMouseUp = () => {
      isErasingRef.current = false;
    };

    registerToolHandlers({ toolType: 'eraser', onMouseDown, onMouseMove, onMouseUp });

    return () => {
      clearToolHandlers();
    };
  }, [tool, viewport, elements, removeElement]);

  if (tool !== 'eraser') return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: cursorPos.x * viewport.zoom + viewport.x - ERASER_RADIUS,
        top: cursorPos.y * viewport.zoom + viewport.y - ERASER_RADIUS,
        width: ERASER_RADIUS * 2,
        height: ERASER_RADIUS * 2,
        border: '2px solid #e74c3c',
        borderRadius: '50%',
        pointerEvents: 'none',
        zIndex: 999,
      }}
    />
  );
}

function distToSegment(p: { x: number; y: number }, v: { x: number; y: number }, w: { x: number; y: number }) {
  const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  if (l2 === 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt((p.x - (v.x + t * (w.x - v.x))) ** 2 + (p.y - (v.y + t * (w.y - v.y))) ** 2);
}

function elementInRadius(el: CanvasElement, pos: { x: number; y: number }): boolean {
  // 1. Point-based shapes (pen, line, arrow)
  if ('points' in el && Array.isArray(el.points) && el.points.length > 0) {
    for (let i = 0; i < el.points.length - 1; i++) {
      const d = distToSegment(pos, el.points[i], el.points[i + 1]);
      if (d <= ERASER_RADIUS) return true;
    }
    // Handle single point pen stroke just in case
    if (el.points.length === 1) {
      const dx = pos.x - el.points[0].x;
      const dy = pos.y - el.points[0].y;
      if (Math.sqrt(dx * dx + dy * dy) <= ERASER_RADIUS) return true;
    }
    return false;
  }

  // 2. Center-based shapes (circle)
  const boxedElement = el as Partial<CanvasElement & { x: number; y: number; width: number; height: number }>;
  const x = boxedElement.x ?? 0;
  const y = boxedElement.y ?? 0;
  const w = boxedElement.width ?? 0;
  const h = boxedElement.height ?? 0;

  if (el.type === 'circle') {
    const rx = w / 2;
    const ry = h / 2;
    const dx = pos.x - x;
    const dy = pos.y - y;
    const normalizedDist = (dx / (rx + ERASER_RADIUS)) ** 2 + (dy / (ry + ERASER_RADIUS)) ** 2;
    return normalizedDist <= 1;
  }

  // 3. Bounding-box based shapes (rectangle, text, stickyNote)
  const dx = Math.max(x - pos.x, 0, pos.x - (x + w));
  const dy = Math.max(y - pos.y, 0, pos.y - (y + h));
  return Math.sqrt(dx * dx + dy * dy) <= ERASER_RADIUS;
}
