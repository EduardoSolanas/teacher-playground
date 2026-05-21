import type { CanvasElement, Viewport } from '@/types/whiteboard';
import ZoomControls from './ZoomControls';
import { getElementsBoundingBox } from '@/lib/whiteboard/export';

type ViewportControlsProps = {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToContent: () => void;
  onResetView: () => void;
  elements: CanvasElement[];
};

export default function ViewportControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFitToContent,
  onResetView,
  elements,
}: ViewportControlsProps) {
  return (
    <ZoomControls
      zoom={zoom}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onFitToContent={onFitToContent}
      onResetView={onResetView}
      elements={elements}
    />
  );
}
