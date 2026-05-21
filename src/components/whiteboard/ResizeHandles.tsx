import React, {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import type Konva from 'konva';
import * as store from '@/lib/whiteboard/store';
import { getSelectedElements } from '@/lib/whiteboard/selection';
import type { CanvasElement } from '@/types/whiteboard';
import {
  resizeElement,
  rotateElementByDelta,
  type HandleName,
} from '@/lib/whiteboard/transform';
import {
  canvasPointToOverlay,
  clientToCanvas,
} from '@/components/whiteboard/tools/pointer';

const HANDLE_SIZE = 8;
const ROTATE_HANDLE_SIZE = 12;

const CURSOR_MAP: Record<HandleName, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

type BoxElement = CanvasElement & {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
};

type DragSession = {
  handle: HandleName | 'rotate';
  elementSnapshot: BoxElement;
  startAngleRad: number;
  startRotation: number;
};

export default function ResizeHandles({
  stageRef,
}: {
  stageRef?: RefObject<Konva.Stage | null>;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const [state, setState] = useState(store.getState());
  const [dragging, setDragging] = useState(false);
  const [handleBox, setHandleBox] = useState({
    centerX: 0,
    centerY: 0,
    width: 0,
    height: 0,
  });

  const selectedElements = getSelectedElements(store);
  const singleSelected = selectedElements.length === 1 ? selectedElements[0] : null;

  const isBoxElement = (el: CanvasElement): el is BoxElement =>
    el.type !== 'pen' &&
    el.type !== 'line' &&
    el.type !== 'arrow' &&
    'x' in el &&
    'y' in el &&
    'width' in el &&
    'height' in el;

  useEffect(() => {
    return store.subscribe(() => {
      setState(store.getState());
    });
  }, []);

  const getPointerCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const vp = store.getState().viewport;
      const stageContainer = stageRef?.current?.container() ?? null;
      return clientToCanvas(clientX, clientY, vp, stageContainer);
    },
    [stageRef],
  );

  const handleGlobalMouseUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    dragSessionRef.current = null;
  }, [dragging]);

  const handleGlobalMouseMove = useCallback(
    (e: MouseEvent) => {
      const session = dragSessionRef.current;
      if (!dragging || !session) return;

      const pointer = getPointerCanvas(e.clientX, e.clientY);

      if (session.handle === 'rotate') {
        const updates = rotateElementByDelta(
          session.elementSnapshot,
          pointer.x,
          pointer.y,
          session.startAngleRad,
          session.startRotation,
          e.shiftKey,
        );
        if (Object.keys(updates).length > 0) {
          store.updateElement(session.elementSnapshot.id, updates);
        }
        return;
      }

      const updates = resizeElement(
        session.elementSnapshot,
        session.handle,
        pointer.x,
        pointer.y,
        e.shiftKey,
      );
      if (Object.keys(updates).length > 0) {
        store.updateElement(session.elementSnapshot.id, updates);
      }
    },
    [dragging, getPointerCanvas],
  );

  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('mousemove', handleGlobalMouseMove);
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('mousemove', handleGlobalMouseMove);
    };
  }, [dragging, handleGlobalMouseUp, handleGlobalMouseMove]);

  useLayoutEffect(() => {
    if (!singleSelected || !isBoxElement(singleSelected)) return;

    const vp = state.viewport;
    const stageContainer = stageRef?.current?.container() ?? null;
    const center = canvasPointToOverlay(
      singleSelected.x + singleSelected.width / 2,
      singleSelected.y + singleSelected.height / 2,
      vp,
      stageContainer,
      overlayRef.current,
    );

    setHandleBox({
      centerX: center.x,
      centerY: center.y,
      width: singleSelected.width * vp.zoom,
      height: singleSelected.height * vp.zoom,
    });
  }, [singleSelected, state.viewport, stageRef]);

  if (!singleSelected || !isBoxElement(singleSelected)) return null;

  const el = singleSelected;
  const { x, y, width, height } = el;
  const rotation = el.rotation ?? 0;

  const handleMouseDown = (handle: HandleName | 'rotate', e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const pointer = getPointerCanvas(e.clientX, e.clientY);
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    dragSessionRef.current = {
      handle,
      elementSnapshot: { ...el },
      startAngleRad: Math.atan2(pointer.y - centerY, pointer.x - centerX),
      startRotation: rotation,
    };
    setDragging(true);
  };

  const relativeHandles: Array<{ name: HandleName; style: React.CSSProperties }> = [
    { name: 'nw', style: { left: 0, top: 0 } },
    { name: 'n', style: { left: '50%', top: 0 } },
    { name: 'ne', style: { left: '100%', top: 0 } },
    { name: 'e', style: { left: '100%', top: '50%' } },
    { name: 'se', style: { left: '100%', top: '100%' } },
    { name: 's', style: { left: '50%', top: '100%' } },
    { name: 'sw', style: { left: 0, top: '100%' } },
    { name: 'w', style: { left: 0, top: '50%' } },
  ];

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 100,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: handleBox.centerX,
          top: handleBox.centerY,
          width: handleBox.width,
          height: handleBox.height,
          border: '1.5px solid #3b82f6',
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }}
      >
        {relativeHandles.map((h) => (
          <div
            key={h.name}
            onMouseDown={(e) => handleMouseDown(h.name, e)}
            style={{
              position: 'absolute',
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              backgroundColor: '#ffffff',
              border: '1.5px solid #3b82f6',
              borderRadius: '50%',
              pointerEvents: 'auto',
              boxSizing: 'border-box',
              cursor: CURSOR_MAP[h.name],
              transform: 'translate(-50%, -50%)',
              ...h.style,
            }}
          />
        ))}

        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            width: 1,
            height: 20,
            backgroundColor: '#3b82f6',
            transform: 'translate(-50%, -100%)',
          }}
        />
        <div
          onMouseDown={(e) => handleMouseDown('rotate', e)}
          style={{
            position: 'absolute',
            left: '50%',
            top: -20,
            width: ROTATE_HANDLE_SIZE,
            height: ROTATE_HANDLE_SIZE,
            backgroundColor: '#ffffff',
            border: '1.5px solid #3b82f6',
            borderRadius: '50%',
            pointerEvents: 'auto',
            boxSizing: 'border-box',
            cursor: 'grab',
            transform: 'translate(-50%, -50%)',
          }}
        />
      </div>
    </div>
  );
}
