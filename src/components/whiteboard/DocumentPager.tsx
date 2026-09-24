'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { pagerPlacement, shouldCollapseRemove, type Rect } from '@/lib/documents/pagerPlacement';
import { dragDeltaToScene, nudgeDeltaForKey } from '@/lib/documents/pagedDocuments';

/**
 * The rectangles the pager must never overlap (spec §6.3 "Responsive"): the
 * room's board tabs, Excalidraw's own toolbar, its undo button (part of the
 * bottom bar), its help button and the room's board notices (all `role`d
 * `status`, `RoomClient.tsx`'s `BOARD_NOTICE_CLASS`, plus this editor's own
 * upload-status panel, which carries the same role).
 */
export const PAGER_OBSTACLE_SELECTOR =
  '[data-testid="board-tabs"], .App-toolbar, [data-testid="button-undo"], .help-icon, [role="status"]';

function readObstacles(excludeEl: HTMLElement | null): Rect[] {
  if (typeof document === 'undefined') return [];
  const rects: Rect[] = [];
  document.querySelectorAll(PAGER_OBSTACLE_SELECTOR).forEach((element) => {
    if (excludeEl && excludeEl.contains(element)) return;
    const box = element.getBoundingClientRect();
    rects.push({ x: box.left, y: box.top, width: box.width, height: box.height });
  });
  return rects;
}

export type DocumentPagerProps = {
  importId: string;
  /** The document's rectangle in viewport coordinates, or null when it cannot be placed (not rendered). */
  documentRect: Rect | null;
  viewportSize: { width: number; height: number };
  /** The clamped showing index (spec §3.4). */
  index: number;
  pageCount: number;
  /** Owner: Previous, "Page n of m", Next, Move, Remove. Everyone else: "Page n of m" only. */
  isOwner: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Called with each pointer-move's delta, in scene units, while the grip is being dragged (spec §6.3 Move). */
  onMoveBy: (dxScene: number, dyScene: number) => void;
  /** Called once, on release, to commit the drag as one undoable step. */
  onMoveEnd: () => void;
  /** Called with one nudge's delta, in scene units, for an arrow key pressed on the focused grip. */
  onNudge: (dxScene: number, dyScene: number) => void;
  onRemove: () => void;
  /** The editor's current `appState.zoom.value`, to convert the grip's pointer-pixel delta to scene units. */
  zoom: number;
};

/**
 * A stacked document's pager (spec §6.3): anchored under the document's
 * bottom edge in viewport coordinates, repositioned whenever its inputs
 * change, and hidden while the document is off screen.
 */
export default function DocumentPager({
  importId,
  documentRect,
  viewportSize,
  index,
  pageCount,
  isOwner,
  onPrevious,
  onNext,
  onMoveBy,
  onMoveEnd,
  onNudge,
  onRemove,
  zoom,
}: DocumentPagerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Rect | null>(null);
  /** The grip's own pointer position, while a drag is in progress; null otherwise. */
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  function handleGripPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    // Capture is a convenience -- it keeps later pointermove events routed
    // to the grip even once the pointer strays outside it -- not a
    // requirement for correctness, so a browser that refuses it for this
    // pointer (e.g. a synthetic pointerId in a test) does not block the drag.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Ignored -- see above.
    }
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
  }

  function handleGripPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const last = dragPointerRef.current;
    if (!last) return;
    const pixelDelta = { x: event.clientX - last.x, y: event.clientY - last.y };
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    const scene = dragDeltaToScene(pixelDelta, zoom);
    onMoveBy(scene.x, scene.y);
  }

  function handleGripPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    if (!dragPointerRef.current) return;
    dragPointerRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Ignored -- see handleGripPointerDown.
    }
    onMoveEnd();
  }

  function handleGripKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const delta = nudgeDeltaForKey(event.key, event.shiftKey);
    if (!delta) return;
    event.preventDefault();
    onNudge(delta.x, delta.y);
  }

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !documentRect) {
      setPlacement(null);
      return;
    }
    const pagerSize = { width: el.offsetWidth, height: el.offsetHeight };
    const obstacles = readObstacles(el);
    setPlacement(pagerPlacement({ documentRect, viewport: viewportSize, pagerSize, obstacles }));
    // index/pageCount/isOwner change the pager's own content, and so its
    // measured size, so they belong in the recompute even though they are
    // not read directly here.
  }, [documentRect, viewportSize, index, pageCount, isOwner, overflowOpen]);

  if (!documentRect) return null;

  const hidden = placement === null;
  const collapseRemove = shouldCollapseRemove(viewportSize.width);

  return (
    <div
      ref={rootRef}
      data-testid={`document-pager-${importId}`}
      className="fixed z-[1200] flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800 px-2 py-1 text-[0.8rem] text-slate-100 shadow-xl shadow-slate-950/40"
      style={
        placement
          ? { left: placement.x, top: placement.y }
          : { left: 0, top: 0, visibility: 'hidden', pointerEvents: 'none' }
      }
      aria-hidden={hidden}
    >
      {isOwner && (
        <button
          type="button"
          aria-label="Previous page"
          disabled={index <= 0}
          onClick={onPrevious}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-40"
        >
          ‹
        </button>
      )}
      <span aria-live="polite" className="whitespace-nowrap px-1 tabular-nums">
        {`Page ${index + 1} of ${pageCount}`}
      </span>
      {isOwner && (
        <button
          type="button"
          aria-label="Next page"
          disabled={index >= pageCount - 1}
          onClick={onNext}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-40"
        >
          ›
        </button>
      )}
      {isOwner && (
        <button
          type="button"
          aria-label="Move document"
          onPointerDown={handleGripPointerDown}
          onPointerMove={handleGripPointerMove}
          onPointerUp={handleGripPointerUp}
          onPointerCancel={handleGripPointerUp}
          onKeyDown={handleGripKeyDown}
          style={{ touchAction: 'none' }}
          className="flex min-h-11 min-w-11 cursor-grab items-center justify-center rounded-lg text-lg leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:cursor-grabbing"
        >
          ⠿
        </button>
      )}
      {isOwner && (collapseRemove ? (
        <div className="relative">
          <button
            type="button"
            aria-label="More actions"
            aria-haspopup="true"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((open) => !open)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            ⋯
          </button>
          {overflowOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-10 mt-1 rounded-lg border border-slate-700 bg-slate-800 p-1 shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                aria-label="Remove document"
                onClick={() => {
                  setOverflowOpen(false);
                  onRemove();
                }}
                className="flex min-h-11 min-w-11 w-full items-center justify-center whitespace-nowrap rounded-lg px-2 text-sm leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                Remove document
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          aria-label="Remove document"
          onClick={onRemove}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          ×
        </button>
      ))}
    </div>
  );
}
