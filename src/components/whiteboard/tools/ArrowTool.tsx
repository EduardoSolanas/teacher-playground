import { useEffect, useRef } from 'react';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { registerToolHandlers, clearToolHandlers } from '../ToolEvents';
import { uuidv4 } from '@/lib/uuid';
import { getCanvasPointer } from './pointer';

export default function ArrowTool() {
  const { addElement, setCurrentElement, palette, viewport, tool } = useWhiteboardStore();
  const isDrawingRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const currentPosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (tool !== 'arrow') return;

    const onMouseDown = (e: any) => {
      const pos = getCanvasPointer(e, viewport);
      isDrawingRef.current = true;
      startPosRef.current = pos;
      currentPosRef.current = pos;
    };

    const onMouseMove = (e: any) => {
      if (!isDrawingRef.current) return;
      const pos = getCanvasPointer(e, viewport);
      currentPosRef.current = pos;

      setCurrentElement({
        id: 'preview',
        type: 'arrow',
        points: [startPosRef.current, pos],
        stroke: palette.color,
        strokeWidth: palette.strokeWidth,
      });
    };

    const onMouseUp = (e: any) => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      setCurrentElement(null);

      let endPos = currentPosRef.current;
      if (e && e.evt && typeof e.evt.clientX === 'number' && typeof e.evt.clientY === 'number') {
        endPos = getCanvasPointer(e, viewport);
      }

      const dx = endPos.x - startPosRef.current.x;
      const dy = endPos.y - startPosRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) < 5) return;

      addElement({
        id: uuidv4(),
        type: 'arrow',
        points: [startPosRef.current, endPos],
        stroke: palette.color,
        strokeWidth: palette.strokeWidth,
      });
    };

    registerToolHandlers({ toolType: 'arrow', onMouseDown, onMouseMove, onMouseUp });

    return () => {
      clearToolHandlers();
    };
  }, [tool, palette, viewport, addElement, setCurrentElement]);

  return null;
}
