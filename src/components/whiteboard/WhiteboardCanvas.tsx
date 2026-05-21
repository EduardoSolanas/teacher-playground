import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { Stage, Layer, Line, Rect, Text, Ellipse, Arrow, Group } from 'react-konva';
import {
  boxToKonvaEllipseProps,
  boxToKonvaRectProps,
  konvaEllipseNodeToBox,
  konvaRectNodeToBox,
} from '@/lib/whiteboard/geometry';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import type { CanvasElement } from '@/types/whiteboard';
import {
  moveSelectedElements,
  toggleElementSelection,
} from '@/lib/whiteboard/selection';
import * as boardStore from '@/lib/whiteboard/store';
import { toolHandlers } from './ToolEvents';
import { getCanvasPointer } from './tools/pointer';

type ElementInteractionProps = {
  draggable: boolean;
  onClick: (e: { cancelBubble: boolean; evt: MouseEvent; target: { id: () => string; x: () => number; y: () => number; position: (pos: { x: number; y: number }) => void } }) => void;
  onDragStart: (e: { cancelBubble: boolean; target: { id: () => string } }) => void;
  onDragEnd: (e: { target: { id: () => string; x: () => number; y: () => number; position: (pos: { x: number; y: number }) => void } }) => void;
};

interface WhiteboardCanvasProps {
  stageRef?: React.MutableRefObject<{ current: any }>;
  onCanvasMouseDown?: (e: any) => void;
  onCanvasMouseMove?: (e: any) => void;
  onCanvasMouseUp?: () => void;
  onCanvasClick?: (e: any) => void;
  onCanvasDoubleClick?: (e: any) => void;
  onCanvasContextMenu?: (e: any) => void;
  onWheel?: (e: any) => void;
  setCursor?: (x: number, y: number) => void;
  userName?: string;
}

function DotGridBackground({
  viewport,
  width,
  height,
}: {
  viewport: { x: number; y: number; zoom: number };
  width: number;
  height: number;
}) {
  const spacing = 20;
  const adjustedSpacing = spacing * viewport.zoom;
  const offsetX = viewport.x * viewport.zoom;
  const offsetY = viewport.y * viewport.zoom;

  const startX = Math.floor(-offsetX / adjustedSpacing) * adjustedSpacing;
  const startY = Math.floor(-offsetY / adjustedSpacing) * adjustedSpacing;

  const dots: { cx: number; cy: number }[] = [];
  for (let x = startX; x < width + adjustedSpacing; x += adjustedSpacing) {
    for (let y = startY; y < height + adjustedSpacing; y += adjustedSpacing) {
      dots.push({ cx: x, cy: y });
    }
  }

  return (
    <Layer>
      {dots.map((dot, i) => (
        <Rect
          key={i}
          x={dot.cx - 1}
          y={dot.cy - 1}
          width={2}
          height={2}
          fill="#d1d5db"
          listening={false}
        />
      ))}
    </Layer>
  );
}

function renderElement(
  el: CanvasElement,
  isSelected: boolean,
  interaction: ElementInteractionProps,
) {
  const commonProps = {
    id: el.id,
    ...interaction,
  };

  const selectionProps = isSelected
    ? {
        shadowColor: '#3498db',
        shadowBlur: 0,
        shadowOffset: { x: 0, y: 0 },
        strokeWidth: 0,
      }
    : {};

  switch (el.type) {
    case 'pen': {
      return (
        <Line
          key={el.id}
          {...commonProps}
          {...selectionProps}
          points={el.points.flatMap((p) => [p.x, p.y])}
          stroke={el.color}
          strokeWidth={el.strokeWidth}
          tension={0.5}
          lineCap="round"
          lineJoin="round"
        />
      );
    }
    case 'text': {
      return (
        <Text
          key={el.id}
          {...commonProps}
          {...selectionProps}
          {...boxToKonvaRectProps(el)}
          text={el.text}
          fontSize={el.fontSize}
          fontFamily={el.fontFamily}
          fill={el.color}
          fontStyle={
            el.bold && el.italic
              ? 'bold italic'
              : el.bold
                ? 'bold'
                : el.italic
                  ? 'italic'
                  : 'normal'
          }
          underline={el.underline}
        />
      );
    }
    case 'rectangle': {
      return (
        <Rect
          key={el.id}
          {...commonProps}
          {...selectionProps}
          {...boxToKonvaRectProps(el)}
          fill={el.fill}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
        />
      );
    }
    case 'circle': {
      return (
        <Ellipse
          key={el.id}
          {...commonProps}
          {...selectionProps}
          {...boxToKonvaEllipseProps(el)}
          fill={el.fill}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
        />
      );
    }
    case 'line': {
      return (
        <Line
          key={el.id}
          {...commonProps}
          {...selectionProps}
          points={el.points.flatMap((p) => [p.x, p.y])}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
          lineCap="round"
        />
      );
    }
    case 'arrow': {
      const pts = el.points.flatMap((p) => [p.x, p.y]);
      return (
        <Arrow
          key={el.id}
          {...commonProps}
          {...selectionProps}
          points={pts}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
          pointerLength={12}
          pointerWidth={12}
          lineCap="round"
        />
      );
    }
    case 'stickyNote': {
      const box = boxToKonvaRectProps(el);
      return (
        <Group key={el.id} {...commonProps} {...box}>
          <Rect
            x={0}
            y={0}
            width={el.width}
            height={el.height}
            fill={el.backgroundColor}
            stroke={isSelected ? '#3498db' : el.borderColor}
            strokeWidth={isSelected ? 3 : 2}
            cornerRadius={el.borderRadius}
            listening={false}
          />
          <Text
            x={8}
            y={8}
            text={el.content}
            fontSize={14}
            fill="#333"
            wrapping="width"
            width={el.width - 16}
            listening={false}
          />
        </Group>
      );
    }
    default:
      return null;
  }
}

export default function WhiteboardCanvas({
  stageRef: externalStageRef,
  onCanvasMouseDown,
  onCanvasMouseMove,
  onCanvasMouseUp,
  onCanvasClick,
  onCanvasDoubleClick,
  onCanvasContextMenu,
  onWheel: externalOnWheel,
  setCursor,
}: WhiteboardCanvasProps) {
  const stageRef = useRef<any>(null);
  const internalRef = externalStageRef || stageRef;
  const lastCursorBroadcast = useRef(0);

  useEffect(() => {
    if (externalStageRef) {
      externalStageRef.current = stageRef.current;
    }
  }, [stageRef.current, externalStageRef]);

  const {
    elements,
    selectedIds,
    viewport,
    tool,
    setViewport,
    selectElement,
    deselectAll,
    updateElement,
    selectionRect,
    currentElement,
  } = useWhiteboardStore();

  const elementInteraction = useMemo((): ElementInteractionProps => {
    const canSelectAndDrag = tool === 'select';

    const handleElementClick = (e: Parameters<ElementInteractionProps['onClick']>[0]) => {
      if (!canSelectAndDrag) return;
      e.cancelBubble = true;
      const id = e.target.id();
      if (e.evt.ctrlKey || e.evt.metaKey) {
        toggleElementSelection(boardStore, id);
      } else {
        selectElement(id);
      }
    };

    const handleDragStart = (e: Parameters<ElementInteractionProps['onDragStart']>[0]) => {
      if (!canSelectAndDrag) return;
      e.cancelBubble = true;
      const id = e.target.id();
      if (!selectedIds.includes(id)) {
        selectElement(id);
      }
    };

    const handleDragEnd = (e: Parameters<ElementInteractionProps['onDragEnd']>[0]) => {
      if (!canSelectAndDrag) return;
      const node = e.target;
      const id = node.id();
      const el = boardStore.getState().elements.find((item) => item.id === id);
      if (!el) return;

      const dragMany =
        selectedIds.length > 1 && selectedIds.includes(id);

      if ('points' in el) {
        const dx = node.x();
        const dy = node.y();
        if (dx === 0 && dy === 0) return;
        if (dragMany) {
          moveSelectedElements(boardStore, dx, dy);
        } else {
          const newPoints = el.points.map((p) => ({
            x: p.x + dx,
            y: p.y + dy,
          }));
          updateElement(id, { points: newPoints });
        }
        node.position({ x: 0, y: 0 });
        return;
      }

      if (!('x' in el) || !('y' in el) || !('width' in el) || !('height' in el)) return;

      const box =
        el.type === 'circle'
          ? konvaEllipseNodeToBox(
              node as {
                x: () => number;
                y: () => number;
                radiusX: () => number;
                radiusY: () => number;
              },
            )
          : konvaRectNodeToBox(
              node as {
                x: () => number;
                y: () => number;
                offsetX: () => number;
                offsetY: () => number;
              },
            );

      const dx = box.x - el.x;
      const dy = box.y - el.y;
      if (dx === 0 && dy === 0) return;

      if (dragMany) {
        moveSelectedElements(boardStore, dx, dy);
      } else {
        updateElement(id, box);
      }
    };

    return {
      draggable: canSelectAndDrag,
      onClick: handleElementClick,
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd,
    };
  }, [tool, selectedIds, selectElement, updateElement]);

  const stageWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const stageHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;

  const zoomedViewport = useMemo(() => {
    return {
      x: viewport.x,
      y: viewport.y,
      zoom: viewport.zoom,
    };
  }, [viewport]);

  const handleWheel = useCallback(
    (e: any) => {
      if (externalOnWheel) {
        externalOnWheel(e);
        return;
      }
      e.evt.preventDefault();
      const scaleBy = 1.1;
      const stage = stageRef.current;
      if (!stage) return;

      const oldScale = viewport.zoom;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      const mousePointTo = {
        x: (pointer.x - viewport.x) / oldScale,
        y: (pointer.y - viewport.y) / oldScale,
      };

      const direction = e.evt.deltaY < 0 ? -1 : 1;
      const newScale = direction > 0 ? oldScale / scaleBy : oldScale * scaleBy;

      const clampedZoom = Math.max(0.1, Math.min(5.0, newScale));

      const newX = pointer.x - mousePointTo.x * clampedZoom;
      const newY = pointer.y - mousePointTo.y * clampedZoom;

      setViewport({ x: newX, y: newY, zoom: clampedZoom });
    },
    [viewport, setViewport, externalOnWheel]
  );

  const [touchStartDist, setTouchStartDist] = useState(0);
  const [touchStartCenter, setTouchStartCenter] = useState({ x: 0, y: 0 });

  const handleTouchStart = useCallback((e: any) => {
    if (e.evt.touches.length === 2) {
      const t1 = e.evt.touches[0];
      const t2 = e.evt.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const cx = (t1.clientX + t2.clientX) / 2;
      const cy = (t1.clientY + t2.clientY) / 2;
      setTouchStartDist(dist);
      setTouchStartCenter({ x: cx, y: cy });
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: any) => {
      if (e.evt.touches.length === 2) {
        e.evt.preventDefault();
        const t1 = e.evt.touches[0];
        const t2 = e.evt.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const cx = (t1.clientX + t2.clientX) / 2;
        const cy = (t1.clientY + t2.clientY) / 2;
        const scaleBy = dist / touchStartDist;
        const newZoom = Math.max(0.1, Math.min(5.0, viewport.zoom * scaleBy));
        const dx = cx - touchStartCenter.x;
        const dy = cy - touchStartCenter.y;
        setViewport({
          x: viewport.x + dx,
          y: viewport.y + dy,
          zoom: newZoom,
        });
        setTouchStartDist(dist);
        setTouchStartCenter({ x: cx, y: cy });
      }
    },
    [viewport, touchStartDist, touchStartCenter, setViewport],
  );

  const handleTouchEnd = useCallback(() => {
    setTouchStartDist(0);
    setTouchStartCenter({ x: 0, y: 0 });
  }, []);

  const [isPanning, setIsPanning] = React.useState(false);
  const [panStart, setPanStart] = React.useState({ x: 0, y: 0 });

  const handleStageMouseDown = useCallback(
    (e: any) => {
      if (e.evt.button === 1 || (e.evt.button === 0 && e.evt.code === 'Space')) {
        setIsPanning(true);
        setPanStart({ x: e.evt.clientX, y: e.evt.clientY });
        return;
      }
      if (toolHandlers.current.toolType && toolHandlers.current.onMouseDown) {
        toolHandlers.current.onMouseDown(e);
      }
      if (onCanvasMouseDown) {
        onCanvasMouseDown(e);
      }
    },
    [onCanvasMouseDown]
  );

  const handleStageMouseMove = useCallback(
    (e: any) => {
      if (isPanning) {
        const dx = e.evt.clientX - panStart.x;
        const dy = e.evt.clientY - panStart.y;
        setViewport({ x: viewport.x + dx, y: viewport.y + dy });
        setPanStart({ x: e.evt.clientX, y: e.evt.clientY });
        return;
      }
      if (toolHandlers.current.toolType && toolHandlers.current.onMouseMove) {
        toolHandlers.current.onMouseMove(e);
      }
      if (onCanvasMouseMove) {
        onCanvasMouseMove(e);
      }
      if (setCursor) {
        const now = Date.now();
        if (now - lastCursorBroadcast.current >= 50) {
          lastCursorBroadcast.current = now;
          const pos = getCanvasPointer(e, viewport);
          setCursor(pos.x, pos.y);
        }
      }
    },
    [isPanning, panStart, viewport, setViewport, onCanvasMouseMove, setCursor]
  );

  const handleStageMouseUp = useCallback(
    (e: any) => {
      setIsPanning(false);
      if (toolHandlers.current.toolType && toolHandlers.current.onMouseUp) {
        toolHandlers.current.onMouseUp(e);
      }
      if (onCanvasMouseUp) {
        onCanvasMouseUp();
      }
    },
    [onCanvasMouseUp]
  );

  const handleClick = useCallback(
    (e: any) => {
      if (toolHandlers.current.toolType && toolHandlers.current.onClick) {
        toolHandlers.current.onClick(e);
        return;
      }
      if (tool === 'select') {
        const clickedOnEmpty = e.target === e.target.getStage();
        if (clickedOnEmpty) {
          deselectAll();
        }
      }
      if (onCanvasClick) {
        onCanvasClick(e);
      }
    },
    [tool, deselectAll, onCanvasClick]
  );

  const handleDoubleClick = useCallback(
    (e: any) => {
      if (onCanvasDoubleClick) {
        onCanvasDoubleClick(e);
      }
    },
    [onCanvasDoubleClick]
  );

  const handleContextMenu = useCallback(
    (e: any) => {
      if (onCanvasContextMenu) {
        onCanvasContextMenu(e);
      }
    },
    [onCanvasContextMenu]
  );

  return (
    <Stage
      ref={stageRef}
      width={stageWidth}
      height={stageHeight}
      onMouseDown={handleStageMouseDown}
      onMouseMove={handleStageMouseMove}
      onMouseUp={handleStageMouseUp}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={handleClick}
      onDblClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      x={viewport.x}
      y={viewport.y}
      scaleX={viewport.zoom}
      scaleY={viewport.zoom}
    >
      <DotGridBackground
        viewport={zoomedViewport}
        width={stageWidth}
        height={stageHeight}
      />
      <Layer>
        {elements.map((el) =>
          renderElement(el, selectedIds.includes(el.id), elementInteraction),
        )}
        {currentElement &&
          renderElement(currentElement, false, {
            ...elementInteraction,
            draggable: false,
          })}
        {selectionRect && (
          <Rect
            x={Math.min(selectionRect.x1, selectionRect.x2)}
            y={Math.min(selectionRect.y1, selectionRect.y2)}
            width={Math.abs(selectionRect.x2 - selectionRect.x1)}
            height={Math.abs(selectionRect.y2 - selectionRect.y1)}
            fill="rgba(59, 130, 246, 0.15)"
            stroke="#3b82f6"
            strokeWidth={1}
            dash={[4, 4]}
            listening={false}
          />
        )}
      </Layer>
    </Stage>
  );
}
