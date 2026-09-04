import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import ClearBoardModal from './ClearBoardModal';

function ModalWithTrigger() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        data-testid="trigger-btn"
        onClick={() => setIsOpen(true)}
      >
        Clear Board
      </button>
      <ClearBoardModal
        isOpen={isOpen}
        onCancel={() => setIsOpen(false)}
        onConfirm={() => setIsOpen(false)}
      />
    </>
  );
}

describe('ClearBoardModal', () => {
  it('is findable by role with an accessible name', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ClearBoardModal isOpen={true} onCancel={onCancel} onConfirm={onConfirm} />
    );

    const dialog = screen.getByRole('dialog', { name: /clear board/i });
    expect(dialog).toBeTruthy();
  });

  it('focus starts on the Cancel button (safe action)', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ClearBoardModal isOpen={true} onCancel={onCancel} onConfirm={onConfirm} />
    );

    const cancelBtn = screen.getByTestId('whiteboard-clear-cancel-btn');
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('Escape calls onCancel and does not call onConfirm', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    const { container } = render(
      <ClearBoardModal isOpen={true} onCancel={onCancel} onConfirm={onConfirm} />
    );

    const dialog = screen.getByRole('dialog', { name: /clear board/i });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Tab from the last focusable element wraps to the first', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ClearBoardModal isOpen={true} onCancel={onCancel} onConfirm={onConfirm} />
    );

    const clearBoardBtn = screen.getByTestId('whiteboard-clear-confirm-btn');
    clearBoardBtn.focus();

    fireEvent.keyDown(clearBoardBtn, { key: 'Tab' });

    const cancelBtn = screen.getByTestId('whiteboard-clear-cancel-btn');
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('Shift+Tab from the first focusable element wraps to the last', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ClearBoardModal isOpen={true} onCancel={onCancel} onConfirm={onConfirm} />
    );

    const cancelBtn = screen.getByTestId('whiteboard-clear-cancel-btn');
    cancelBtn.focus();

    fireEvent.keyDown(cancelBtn, { key: 'Tab', shiftKey: true });

    const clearBoardBtn = screen.getByTestId('whiteboard-clear-confirm-btn');
    expect(document.activeElement).toBe(clearBoardBtn);
  });

  it('restores focus to the trigger element when the dialog closes', () => {
    const { rerender } = render(<ModalWithTrigger />);

    const triggerBtn = screen.getByTestId('trigger-btn');
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    // Open the modal
    fireEvent.click(triggerBtn);
    rerender(<ModalWithTrigger />);

    // Focus should be on Cancel button
    const cancelBtn = screen.getByTestId('whiteboard-clear-cancel-btn');
    expect(document.activeElement).toBe(cancelBtn);

    // Close the modal by clicking Cancel
    fireEvent.click(cancelBtn);
    rerender(<ModalWithTrigger />);

    // Focus should be restored to trigger button
    expect(document.activeElement).toBe(triggerBtn);
  });
  it('still cancels on Escape after focus leaves the buttons', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ClearBoardModal isOpen onCancel={onCancel} onConfirm={onConfirm} />);

    // Clicking the explanatory text is not a focusable target, so focus falls
    // back to the body. A listener bound to the dialog element never sees the
    // keydown that follows, which silently kills Escape on a destructive
    // confirmation.
    fireEvent.click(screen.getByText(/remove all elements/i));
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it('pulls focus back into the dialog when Tab is pressed from outside it', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ClearBoardModal isOpen onCancel={onCancel} onConfirm={onConfirm} />);

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByTestId('whiteboard-clear-cancel-btn'));
  });
})
