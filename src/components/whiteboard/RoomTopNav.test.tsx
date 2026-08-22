import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

import RoomTopNav from './RoomTopNav';

describe('RoomTopNav', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('combines room navigation and a compact accessible profile trigger', () => {
    const onNavigate = vi.fn();

    render(
      <RoomTopNav
        displayName="eduardo"
        onDisplayNameChange={() => undefined}
        onNavigate={onNavigate}
        rosterExpanded={false}
      />,
    );

    expect(screen.getByTestId('whiteboard-room-top-nav')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-back-to-rooms').textContent).toMatch(/back to rooms/i);
    const profile = screen.getByTestId('whiteboard-profile-btn');
    expect(profile.textContent).toBe('E');
    expect(profile.getAttribute('aria-label')).toBe('Open profile for eduardo');

    fireEvent.click(screen.getByTestId('whiteboard-back-to-rooms'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('leaves room for the tool rail and roster rail at sm', () => {
    const { rerender } = render(
      <RoomTopNav displayName="eduardo" onDisplayNameChange={() => undefined} rosterExpanded={false} />,
    );
    const collapsed = screen.getByTestId('whiteboard-room-top-nav').className;
    expect(collapsed).toContain('sm:left-16');
    expect(collapsed).toContain('sm:right-0');

    rerender(
      <RoomTopNav displayName="eduardo" onDisplayNameChange={() => undefined} rosterExpanded />,
    );
    const expanded = screen.getByTestId('whiteboard-room-top-nav').className;
    expect(expanded).toContain('sm:right-[13.75rem]');
  });

  it('is hidden on the guest hostname', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', window.location.hostname);

    render(<RoomTopNav displayName={null} onDisplayNameChange={() => undefined} rosterExpanded={false} />);

    expect(screen.queryByTestId('whiteboard-room-top-nav')).toBeNull();
  });

  it('keeps navigation content clear of device safe-area insets', () => {
    render(<RoomTopNav displayName="eduardo" onDisplayNameChange={() => undefined} rosterExpanded={false} />);

    const nav = screen.getByTestId('whiteboard-room-top-nav');
    expect(nav.className).toContain('h-[calc(3rem+env(safe-area-inset-top))]');
    expect(nav.className).toContain('pt-[env(safe-area-inset-top)]');
    expect(screen.getByTestId('whiteboard-back-to-rooms').className)
      .toContain('pl-[max(0.75rem,env(safe-area-inset-left))]');
    expect(screen.getByTestId('whiteboard-profile-btn').parentElement?.parentElement?.className)
      .toContain('pr-[max(0.5rem,env(safe-area-inset-right))]');
  });
});
