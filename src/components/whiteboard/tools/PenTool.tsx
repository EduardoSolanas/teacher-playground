import { useEffect, useRef } from 'react';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { registerToolHandlers, clearToolHandlers } from '../ToolEvents';
import { uuidv4 } from '@/lib/uuid';
import { getCanvasPointer } from './pointer';

export default function PenTool() {
  const { addElement, setCurrentElement, palette, viewport, tool } = useWhiteboardStore();
  const isDrawingRef = useRef(false);
  const currentStrokeRef = useRef<{ x: number; y: number }[]>([]);

  useEffect(() => {
    if (tool !== 'pen') return;

    const onMouseDown = (e: any) => {
      const pos = getCanvasPointer(e, viewport);
      isDrawingRef.current = true;
      currentStrokeRef.current = [pos];
      setCurrentElement({
        id: 'preview',
        type: 'pen',
        points: [pos],
        color: palette.color,
        strokeWidth: palette.strokeWidth,
      });
    };

    const onMouseMove = (e: any) => {
      if (!isDrawingRef.current) return;
      const pos = getCanvasPointer(e, viewport);
      currentStrokeRef.current = [...currentStrokeRef.current, pos];
      setCurrentElement({
        id: 'preview',
        type: 'pen',
        points: [...currentStrokeRef.current],
        color: palette.color,
        strokeWidth: palette.strokeWidth,
      });
    };

    const onMouseUp = () => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      setCurrentElement(null);
      if (currentStrokeRef.current.length < 2) return;

      addElement({
        id: uuidv4(),
        type: 'pen',
        points: [...currentStrokeRef.current],
        color: palette.color,
        strokeWidth: palette.strokeWidth,
      });
      currentStrokeRef.current = [];
    };

    registerToolHandlers({ toolType: 'pen', onMouseDown, onMouseMove, onMouseUp });

    return () => {
      clearToolHandlers();
    };
  }, [tool, palette, viewport, addElement, setCurrentElement]);

  return null;
}
