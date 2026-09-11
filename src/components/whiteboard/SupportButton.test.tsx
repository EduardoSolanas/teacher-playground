import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import SupportButton from './SupportButton';

/*
 * A reserved domain on purpose. The repository's own scan refuses a real
 * address in any tracked file, tests included -- which is also why the address
 * is configuration rather than a constant in the component.
 */
const ADDRESS = 'support@example.com';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', ADDRESS);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SupportButton', () => {
  it('is a question mark until it is pressed', () => {
    render(<SupportButton />);
    expect(screen.getByTestId('whiteboard-support-btn')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-support-panel')).toBeNull();
  });

  it('offers a way to write to somebody', () => {
    render(<SupportButton />);
    fireEvent.click(screen.getByTestId('whiteboard-support-btn'));

    const link = screen.getByTestId('whiteboard-support-email') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`mailto:${ADDRESS}`);
    expect(link.textContent).toBe(ADDRESS);
  });

  it('closes again', () => {
    render(<SupportButton />);
    fireEvent.click(screen.getByTestId('whiteboard-support-btn'));
    expect(screen.getByTestId('whiteboard-support-panel')).toBeTruthy();

    fireEvent.click(screen.getByTestId('whiteboard-support-close'));
    expect(screen.queryByTestId('whiteboard-support-panel')).toBeNull();
  });

  it('moves focus into the popover and gives it back to the trigger on Escape (UX-A19)', async () => {
    const user = userEvent.setup();
    render(<SupportButton />);
    const trigger = screen.getByTestId('whiteboard-support-btn');

    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByTestId('whiteboard-support-close'));

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('whiteboard-support-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger when the close button closes the popover (UX-A19)', async () => {
    const user = userEvent.setup();
    render(<SupportButton />);
    const trigger = screen.getByTestId('whiteboard-support-btn');

    await user.click(trigger);
    await user.click(screen.getByTestId('whiteboard-support-close'));

    expect(screen.queryByTestId('whiteboard-support-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the room is clicked away from', () => {
    render(<SupportButton />);
    fireEvent.click(screen.getByTestId('whiteboard-support-btn'));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('whiteboard-support-panel')).toBeNull();
  });

  it('says who it is for, not what the keys do', () => {
    // It replaced a shortcuts sheet. Somebody pressing "?" mid-lesson wants a
    // person, and this is the only route to one the room offers.
    render(<SupportButton />);
    fireEvent.click(screen.getByTestId('whiteboard-support-btn'));
    expect(screen.getByTestId('whiteboard-support-panel').textContent).toMatch(/help|support/i);
  });

  it('draws its icons instead of printing glyphs (UX-B1)', () => {
    render(<SupportButton />);
    const trigger = screen.getByTestId('whiteboard-support-btn');
    expect(trigger.querySelector('svg')).toBeTruthy();
    expect(trigger.textContent).toBe('');

    fireEvent.click(trigger);
    const close = screen.getByTestId('whiteboard-support-close');
    expect(close.querySelector('svg')).toBeTruthy();
    expect(close.textContent).toBe('');
  });

  it('offers nothing at all when no address is configured', () => {
    // A "?" that opens a panel with nowhere to write is worse than no "?".
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '');
    render(<SupportButton />);
    expect(screen.queryByTestId('whiteboard-support-btn')).toBeNull();
  });

  it('sits below presence and modal sheets with a controlled z-index', () => {
    render(<SupportButton />);
    const container = screen.getByTestId('whiteboard-support-container');
    expect(container.className).toContain('z-[1050]');
  });

  it('clears the call rail instead of sitting under it (UX-C9)', () => {
    const { rerender } = render(<SupportButton />);
    expect(screen.getByTestId('whiteboard-support-container').style.right).toBe('');

    rerender(<SupportButton callRailOpen />);
    const container = screen.getByTestId('whiteboard-support-container');
    expect(container.className).toContain('max-sm:hidden');
    // jsdom re-serializes calc()/clamp(); the rail width token is the stable part.
    expect(container.style.right).toContain('calc(');
    expect(container.style.right).toContain('18vw');
  });

  it('hides on mobile when roster is expanded and shifts left on desktop', () => {
    const { rerender } = render(<SupportButton rosterExpanded={false} />);
    let container = screen.getByTestId('whiteboard-support-container');
    expect(container.className).toContain('right-[max(0.75rem,env(safe-area-inset-right))]');
    expect(container.className).not.toContain('max-sm:hidden');

    rerender(<SupportButton rosterExpanded={true} />);
    container = screen.getByTestId('whiteboard-support-container');
    expect(container.className).toContain('max-sm:hidden');
    expect(container.className).toContain('sm:right-[calc(13.75rem+max(0.75rem,env(safe-area-inset-right)))]');
  });
});

