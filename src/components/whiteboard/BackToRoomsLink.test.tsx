import { afterEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is hidden on the guest hostname: students have no room list', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', window.location.hostname);

    render(<BackToRoomsLink />);

    expect(screen.queryByTestId('whiteboard-back-to-rooms')).toBeNull();
  });

  it('is shown when the guest hostname is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');

    render(<BackToRoomsLink />);

    expect(screen.getByTestId('whiteboard-back-to-rooms')).toBeTruthy();
  });

  it('is shown on a hostname that is not the guest hostname', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join-playground.example.com');

    render(<BackToRoomsLink />);

    expect(screen.getByTestId('whiteboard-back-to-rooms')).toBeTruthy();
  });
});
