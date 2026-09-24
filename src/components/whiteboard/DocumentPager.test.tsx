import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DocumentPager from './DocumentPager';

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
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
