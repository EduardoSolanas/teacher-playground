import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DocumentPager, { PAGER_OBSTACLE_SELECTOR } from './DocumentPager';

/*
 * spec/PAGED_DOCUMENTS_SPEC.md §6.3: owner gets Previous / "Page n of m" /
 * Next, everyone else gets "Page n of m" only. jsdom has no real layout (no
 * viewport, no getBoundingClientRect), so these tests prove the accessible
 * structure and interaction -- content, labels, disabled state, the click ->
 * turnPage wiring -- not on-screen placement, which is proven in the real
 * browser by the e2e suite (AGENTS.md, "Style changes").
 */

const VIEWPORT = { width: 1440, height: 900 };
const DOC_RECT = { x: 400, y: 200, width: 400, height: 300 };
/** Within a 390px-wide viewport, unlike DOC_RECT (which is only ever used against VIEWPORT above). */
const NARROW_DOC_RECT = { x: 20, y: 200, width: 300, height: 300 };

describe('DocumentPager', () => {
  it('shows Previous, the page label and Next for the owner', () => {
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={1}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy();
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
  });

  it('shows only the page label, no buttons, for a non-owner', () => {
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={false}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
  });

  it('disables Previous on the first page and Next on the last, for the owner', () => {
    const { rerender } = render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(false);

    rerender(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={2}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onPrevious and onNext when their buttons are clicked', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={1}
        pageCount={3}
        isOwner={true}
        onPrevious={onPrevious}
        onNext={onNext}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('renders the page label as a polite live region', () => {
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={false}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    const label = screen.getByText('Page 1 of 3');
    expect(label.getAttribute('aria-live')).toBe('polite');
  });

  it('renders nothing when the document rect is null (off screen)', () => {
    const { container } = render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={null}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('DocumentPager owner controls: Move and Remove', () => {
  it('shows a Move grip and a Remove button for the owner', () => {
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    expect(screen.getByRole('button', { name: 'Move document' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove document' })).toBeTruthy();
  });

  it('shows no Move grip or Remove button for a non-owner', () => {
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={false}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Move document' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove document' })).toBeNull();
  });

  it('dragging the grip reports each pointer-move delta converted to scene units by the zoom, and commits once on release', () => {
    const onMoveBy = vi.fn();
    const onMoveEnd = vi.fn();
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={onMoveBy}
        onMoveEnd={onMoveEnd}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={2}
      />,
    );
    const grip = screen.getByRole('button', { name: 'Move document' });
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 110, clientY: 104, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 115, clientY: 110, pointerId: 1 });
    expect(onMoveBy).toHaveBeenNthCalledWith(1, 5, 2);
    expect(onMoveBy).toHaveBeenNthCalledWith(2, 2.5, 3);
    expect(onMoveEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(grip, { clientX: 115, clientY: 110, pointerId: 1 });
    expect(onMoveEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores a pointer move before any pointer down on the grip', () => {
    const onMoveBy = vi.fn();
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={onMoveBy}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    const grip = screen.getByRole('button', { name: 'Move document' });
    fireEvent.pointerMove(grip, { clientX: 999, clientY: 999, pointerId: 1 });
    expect(onMoveBy).not.toHaveBeenCalled();
  });

  it('nudges with the arrow keys on the focused grip, one call per press', () => {
    const onNudge = vi.fn();
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={onNudge}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    const grip = screen.getByRole('button', { name: 'Move document' });
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    fireEvent.keyDown(grip, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grip, { key: 'Enter' });
    expect(onNudge).toHaveBeenNthCalledWith(1, 10, 0);
    expect(onNudge).toHaveBeenNthCalledWith(2, 0, 50);
    expect(onNudge).toHaveBeenCalledTimes(2);
  });

  it('calls onRemove when Remove document is clicked', () => {
    const onRemove = vi.fn();
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={DOC_RECT}
        viewportSize={VIEWPORT}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={onRemove}
        zoom={1}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove document' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('at a narrow viewport, Remove collapses into a More overflow button rather than showing inline', () => {
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={NARROW_DOC_RECT}
        viewportSize={{ width: 390, height: 844 }}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={() => {}}
        zoom={1}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Remove document' })).toBeNull();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
  });

  it('opening the overflow menu at a narrow viewport reveals Remove document, which calls onRemove', () => {
    const onRemove = vi.fn();
    render(
      <DocumentPager
        importId="0123456789abcdef"
        documentRect={NARROW_DOC_RECT}
        viewportSize={{ width: 390, height: 844 }}
        index={0}
        pageCount={3}
        isOwner={true}
        onPrevious={() => {}}
        onNext={() => {}}
        onMoveBy={() => {}}
        onMoveEnd={() => {}}
        onNudge={() => {}}
        onRemove={onRemove}
        zoom={1}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const removeInMenu = screen.getByRole('menuitem', { name: 'Remove document' });
    fireEvent.click(removeInMenu);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('treats the docked presence panel as an obstacle, belt-and-braces alongside the container narrowing that keeps them apart', () => {
    // The board area narrowing (RoomClient's roomCanvasRightClass) is the
    // real fix -- Excalidraw's own toolbar, footer and this pager all lay
    // out inside the remaining width. This selector is the second line of
    // defence: even if a future obstacle escapes the narrowed container, the
    // pager still refuses to sit under the roster.
    expect(PAGER_OBSTACLE_SELECTOR).toContain('[data-testid="whiteboard-presence-panel"]');
  });
});
