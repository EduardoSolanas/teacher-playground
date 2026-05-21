import { useEffect, useRef } from 'react';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { registerToolHandlers, clearToolHandlers } from '../ToolEvents';
import { uuidv4 } from '@/lib/uuid';
import { getCanvasPointer } from './pointer';

export default function RectangleTool() {
  const { addElement, setCurrentElement, palette, viewport, tool } = useWhiteboardStore();
  const isDrawingRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const currentSizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    if (tool !== 'rectangle') return;

    const onMouseDown = (e: any) => {
      const pos = getCanvasPointer(e, viewport);
      isDrawingRef.current = true;
      startPosRef.current = pos;
      currentSizeRef.current = { width: 0, height: 0 };
    };

    const onMouseMove = (e: any) => {
      if (!isDrawingRef.current) return;
      const pos = getCanvasPointer(e, viewport);
      const width = pos.x - startPosRef.current.x;
      const height = pos.y - startPosRef.current.y;
      currentSizeRef.current = { width, height };

      const x = width < 0 ? startPosRef.current.x + width : startPosRef.current.x;
      const y = height < 0 ? startPosRef.current.y + height : startPosRef.current.y;

      setCurrentElement({
        id: 'preview',
        type: 'rectangle',
        x,
        y,
        width: Math.abs(width),
        height: Math.abs(height),
        fill: palette.fill,
        stroke: palette.color,
        strokeWidth: palette.strokeWidth,
      });
    };

    const onMouseUp = () => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      setCurrentElement(null);

      if (Math.abs(currentSizeRef.current.width) < 5 && Math.abs(currentSizeRef.current.height) < 5) return;

      const w = currentSizeRef.current;
      const sx = startPosRef.current;
      const x = w.width < 0 ? sx.x + w.width : sx.x;
      const y = w.height < 0 ? sx.y + w.height : sx.y;

      addElement({
        id: uuidv4(),
        type: 'rectangle',
        x, y,
        width: Math.abs(w.width),
        height: Math.abs(w.height),
        fill: palette.fill,
        stroke: palette.color,
        strokeWidth: palette.strokeWidth,
      });
    };

    registerToolHandlers({ toolType: 'rectangle', onMouseDown, onMouseMove, onMouseUp });

    return () => {
      clearToolHandlers();
    };
  }, [tool, palette, viewport, addElement, setCurrentElement]);

  return null;
}
