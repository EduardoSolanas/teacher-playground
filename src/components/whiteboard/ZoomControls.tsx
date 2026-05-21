import type { CanvasElement } from '@/types/whiteboard';

type ZoomControlsProps = {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToContent: () => void;
  onResetView: () => void;
  elements: CanvasElement[];
};

export default function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFitToContent,
  onResetView,
  elements,
}: ZoomControlsProps) {
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="flex items-center gap-1">
      <button
        data-testid="whiteboard-zoom-out-btn"
        onClick={onZoomOut}
        title="Zoom out"
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border-none text-[16px] font-semibold text-slate-200 transition-colors duration-150 hover:bg-slate-700"
      >
        -
      </button>
      <span className="min-w-[52px] select-none text-center text-xs text-slate-400">
        {zoomPercent}%
      </span>
      <button
        data-testid="whiteboard-zoom-in-btn"
        onClick={onZoomIn}
        title="Zoom in"
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border-none text-[16px] font-semibold text-slate-200 transition-colors duration-150 hover:bg-slate-700"
      >
        +
      </button>
      <div className="mx-1 h-5 w-px bg-slate-700" />
      <button
        data-testid="whiteboard-fit-btn"
        onClick={onFitToContent}
        title="Fit to content"
        disabled={elements.length === 0}
        className="flex h-8 cursor-pointer items-center justify-center rounded-lg border-none px-2 text-[11px] font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-700"
        style={{
          opacity: elements.length === 0 ? 0.4 : 1,
          cursor: elements.length === 0 ? 'not-allowed' : 'pointer',
        }}
      >
        Fit
      </button>
      <button
        data-testid="whiteboard-reset-view-btn"
        onClick={onResetView}
        title="Reset view"
        className="flex h-8 cursor-pointer items-center justify-center rounded-lg border-none px-2 text-[11px] font-medium text-slate-200 transition-colors duration-150 hover:bg-slate-700"
      >
        Reset
      </button>
    </div>
  );
}
