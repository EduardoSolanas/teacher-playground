'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { pagerPlacement, type Rect } from '@/lib/documents/pagerPlacement';

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
  /** Owner: Previous, "Page n of m", Next. Everyone else: "Page n of m" only. */
  isOwner: boolean;
  onPrevious: () => void;
  onNext: () => void;
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
}: DocumentPagerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Rect | null>(null);

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
  }, [documentRect, viewportSize, index, pageCount, isOwner]);

  if (!documentRect) return null;

  const hidden = placement === null;

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
    </div>
  );
}
