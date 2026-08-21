import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the Next router is stubbed, and only because jsdom has no app router
// mounted. Everything under test is the real component.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

import RoomAccountMenu from './RoomAccountMenu';

const noop = () => {};

describe('RoomAccountMenu', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gives the teacher an account control inside the room', () => {
    // Before this existed the only way to sign out was to leave the room, and
    // nothing in a room told you which account you were in.
    render(<RoomAccountMenu displayName="eduardo" onDisplayNameChange={noop} rosterExpanded={true} />);

    expect(screen.getByTestId('whiteboard-room-account')).toBeTruthy();
  });

  it('is hidden on the guest hostname: a student has no account to manage', () => {
    // The menu offers Change name, Sign out and Delete account, all of which
    // act on a teacher account a guest does not have.
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', window.location.hostname);

    render(<RoomAccountMenu displayName="student" onDisplayNameChange={noop} rosterExpanded={true} />);

    expect(screen.queryByTestId('whiteboard-room-account')).toBeNull();
  });

  it('does not need a name to offer a way out', () => {
    // The name prompt and the waiting room both render before a display name
    // exists. Those are exactly the screens someone gets stuck on, so the menu
    // has to stand up without one rather than waiting for it.
    render(<RoomAccountMenu displayName={null} onDisplayNameChange={noop} rosterExpanded={false} />);

    const trigger = screen.getByTestId('whiteboard-room-account');
    expect(trigger.textContent).toContain('Account');
  });

  it('clears the roster rail when one is on screen', () => {
    // The roster is a fixed 13.75rem column on the right edge. Anchoring the menu
    // to the viewport edge would park it underneath.
    const { rerender } = render(
      <RoomAccountMenu displayName="eduardo" onDisplayNameChange={noop} rosterExpanded={true} />,
    );
    const expanded = screen.getByTestId('whiteboard-room-account').className;

    rerender(<RoomAccountMenu displayName="eduardo" onDisplayNameChange={noop} rosterExpanded={false} />);
    const collapsed = screen.getByTestId('whiteboard-room-account').className;

    expect(expanded).not.toBe(collapsed);
    expect(expanded).toContain('sm:right-[14.25rem]');
    expect(collapsed).toContain('sm:right-3');
  });
});
