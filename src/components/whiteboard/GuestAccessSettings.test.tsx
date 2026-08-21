import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import GuestAccessSettings from './GuestAccessSettings';

describe('GuestAccessSettings', () => {
  let copied: string[];

  beforeEach(() => {
    copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } },
    });
  });

  // The link is long and the PIN is read off a screen onto a phone: both are
  // there to be handed to a student, so both need copying without selecting
  // text by hand.
  it('copies the join link and the PIN, each from its own button', async () => {
    render(
      <GuestAccessSettings
        roomId="room-alpha"
        guestJoinUrl="https://join.example.com/whiteboard/room-alpha"
        guestAccess
        guestPin="004271"
        guestPinExpiresAt={Date.now() + 12 * 60 * 60 * 1000}
        lockoutUntil={null}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRotate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Copy student join link'));
    await waitFor(() => expect(copied).toEqual(['https://join.example.com/whiteboard/room-alpha']));

    fireEvent.click(screen.getByLabelText('Copy class PIN'));
    await waitFor(() => expect(copied).toHaveLength(2));
    expect(copied[1]).toBe('004271');
  });

  it('shows the guest-host join URL and PIN when guest access is on', () => {
    render(
      <GuestAccessSettings
        roomId="room-alpha"
        guestJoinUrl="https://join.example.com/whiteboard/room-alpha"
        guestAccess
        guestPin="004271"
        guestPinExpiresAt={Date.now() + 12 * 60 * 60 * 1000}
        lockoutUntil={null}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRotate={vi.fn()}
      />,
    );

    expect(screen.getByTestId('guest-join-url').textContent).toBe(
      'https://join.example.com/whiteboard/room-alpha',
    );
    expect(screen.getByTestId('guest-pin').textContent).toBe('004271');
    expect(screen.queryByTestId('guest-lockout')).toBeNull();
  });

  it('surfaces lockout and offers rotate as the remedy', () => {
    const onRotate = vi.fn();
    render(
      <GuestAccessSettings
        roomId="room-alpha"
        guestJoinUrl="https://join.example.com/whiteboard/room-alpha"
        guestAccess
        guestPin="123456"
        guestPinExpiresAt={Date.now() + 60_000}
        lockoutUntil={Date.now() + 15 * 60 * 1000}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRotate={onRotate}
      />,
    );

    const lockout = screen.getByTestId('guest-lockout');
    expect(lockout.textContent).toMatch(/locked/i);
    const rotate = screen.getByTestId('guest-rotate-pin');
    fireEvent.click(rotate);
    expect(onRotate).toHaveBeenCalledTimes(1);
  });

  it('does not surface lockout after lockoutUntil has passed', () => {
    render(
      <GuestAccessSettings
        roomId="room-alpha"
        guestJoinUrl="https://join.example.com/whiteboard/room-alpha"
        guestAccess
        guestPin="123456"
        guestPinExpiresAt={Date.now() + 60_000}
        lockoutUntil={1}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRotate={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('guest-lockout')).toBeNull();
  });

  it('does not render an email field', () => {
    const { container } = render(
      <GuestAccessSettings
        roomId="room-alpha"
        guestJoinUrl="https://join.example.com/whiteboard/room-alpha"
        guestAccess={false}
        guestPin={null}
        guestPinExpiresAt={null}
        lockoutUntil={null}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRotate={vi.fn()}
      />,
    );

    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelector('input[name="email"]')).toBeNull();
    expect(container.textContent).not.toMatch(/email/i);
  });
});
