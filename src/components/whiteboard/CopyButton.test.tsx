import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import CopyButton from './CopyButton';

function stubClipboard(impl: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: impl },
  });
}

describe('CopyButton', () => {
  let copied: string[];

  beforeEach(() => {
    copied = [];
    stubClipboard((text) => { copied.push(text); return Promise.resolve(); });
  });

  it('copies the value it was given', async () => {
    render(<CopyButton value="https://join.example.com/whiteboard/room-alpha" label="join link" />);

    fireEvent.click(screen.getByTestId('whiteboard-copy-btn'));

    await waitFor(() => expect(copied).toEqual(['https://join.example.com/whiteboard/room-alpha']));
  });

  it('confirms the copy so the teacher knows it worked', async () => {
    render(<CopyButton value="123456" label="class PIN" />);

    fireEvent.click(screen.getByTestId('whiteboard-copy-btn'));

    await waitFor(() => expect(screen.getByTestId('whiteboard-copy-btn').textContent).toContain('Copied'));
  });

  it('names what it copies, so two of them are told apart', () => {
    // Two copy buttons sit in the same panel, one for the link and one for the
    // PIN. A bare "Copy" gives a screen reader no way to tell which is which.
    render(<CopyButton value="123456" label="class PIN" />);

    expect(screen.getByTestId('whiteboard-copy-btn').getAttribute('aria-label')).toBe('Copy class PIN');
  });

  it('says so when the clipboard refuses rather than looking like it worked', async () => {
    // Clipboard writes fail on an insecure origin and when the document is not
    // focused. Swallowing that leaves the teacher pasting a stale value.
    stubClipboard(() => Promise.reject(new Error('denied')));
    render(<CopyButton value="123456" label="class PIN" />);

    fireEvent.click(screen.getByTestId('whiteboard-copy-btn'));

    await waitFor(() => {
      const error = screen.getByTestId('whiteboard-copy-error');
      expect(error.getAttribute('role')).toBe('alert');
      expect(error.textContent).toMatch(/could not copy/i);
    });
    expect(screen.getByTestId('whiteboard-copy-btn').textContent).not.toContain('Copied');
  });

  it('renders nothing without a value to copy', () => {
    render(<CopyButton value="" label="class PIN" />);

    expect(screen.queryByTestId('whiteboard-copy-btn')).toBeNull();
  });
});
