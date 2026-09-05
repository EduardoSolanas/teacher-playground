import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import ConnectionLostNotice from './ConnectionLostNotice';

describe('ConnectionLostNotice', () => {
  it('expresses truthful uncertainty about unsaved changes', () => {
    // We have no durable-save receipt, so we cannot claim work is saved.
    // Instead, acknowledge the uncertainty.
    render(<ConnectionLostNotice />);
    const notice = screen.getByTestId('whiteboard-connection-lost');
    expect(notice.textContent).toContain('Recent changes may not be saved');
    expect(notice.textContent).not.toContain('Your work is saved in the room');
  });

  it('says the work is safe, not only that something broke', () => {
    // The board lives in the room, not the tab. Somebody mid-lesson needs to
    // know that before they are told to reload anything.
    render(<ConnectionLostNotice />);
    expect(screen.getByTestId('whiteboard-connection-lost').textContent).toContain('saved');
  });

  it('offers the one thing that actually helps', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });

    render(<ConnectionLostNotice />);
    fireEvent.click(screen.getByTestId('whiteboard-connection-lost-reload'));
    expect(reload).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('announces itself to a screen reader', () => {
    render(<ConnectionLostNotice />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
