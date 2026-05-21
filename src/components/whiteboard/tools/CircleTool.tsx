import { useEffect, useRef } from 'react';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { registerToolHandlers, clearToolHandlers } from '../ToolEvents';
import { uuidv4 } from '@/lib/uuid';
import { getCanvasPointer } from './pointer';

export default function CircleTool() {
  const { addElement, setCurrentElement, palette, viewport, tool } = useWhiteboardStore();
  const isDrawingRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const currentSizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    if (tool !== 'circle') return;

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

      setCurrentElement({
        id: 'preview',
        type: 'circle',
        x: startPosRef.current.x + width / 2,
        y: startPosRef.current.y + height / 2,
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

      addElement({
        id: uuidv4(),
        type: 'circle',
        x: sx.x + w.width / 2,
        y: sx.y + w.height / 2,
        width: Math.abs(w.width),
        height: Math.abs(w.height),
        fill: palette.fill,
        stroke: palette.color,
        strokeWidth: palette.strokeWidth,
      });
    };

    registerToolHandlers({ toolType: 'circle', onMouseDown, onMouseMove, onMouseUp });

    return () => {
      clearToolHandlers();
    };
  }, [tool, palette, viewport, addElement, setCurrentElement]);

  return null;
}
