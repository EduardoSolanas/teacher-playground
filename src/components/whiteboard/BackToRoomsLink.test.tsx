import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import BackToRoomsLink from './BackToRoomsLink';

describe('BackToRoomsLink', () => {
  it('is a top-left link back to the room list', () => {
    render(<BackToRoomsLink />);

    const link = screen.getByTestId('whiteboard-back-to-rooms');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/whiteboard');
    expect(link.textContent).toMatch(/back to rooms/i);
  });

  it('lets the host leave before navigating when onNavigate is provided', () => {
    const onNavigate = vi.fn();
    render(<BackToRoomsLink onNavigate={onNavigate} />);

    fireEvent.click(screen.getByTestId('whiteboard-back-to-rooms'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
