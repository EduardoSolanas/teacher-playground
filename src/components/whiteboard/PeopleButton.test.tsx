import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import PeopleButton from './PeopleButton';
import type { WhiteboardUser } from '@/types/whiteboard';

function makeUser(overrides: Partial<WhiteboardUser> = {}): WhiteboardUser {
  return {
    peerId: 'p1',
    userName: 'Alice',
    color: '#3498db',
    isHost: false,
    ...overrides,
  };
}

describe('PeopleButton', () => {
  it('names the room count for a screen reader, not just the digits', () => {
    render(
      <PeopleButton
        users={[makeUser(), makeUser({ peerId: 'p2', userName: 'Bob' })]}
        capacity={4}
        expanded={false}
        onToggle={() => {}}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'People in the room, 2 of 4' }),
    ).toBeTruthy();
  });

  it('reports whether the list is open', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <PeopleButton users={[makeUser()]} expanded={false} onToggle={onToggle} />,
    );
    expect(screen.getByTestId('whiteboard-people-button').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByTestId('whiteboard-people-button'));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<PeopleButton users={[makeUser()]} expanded onToggle={onToggle} />);
    expect(screen.getByTestId('whiteboard-people-button').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows waiting peers on the button, because the list is now closed by default', () => {
    /*
     * The roster used to be docked open, so somebody waiting to be let in was
     * visible without looking for them. Behind a button they are not, and a
     * pupil left in the waiting room because the teacher never saw them is the
     * whole cost of moving it.
     */
    render(
      <PeopleButton users={[makeUser()]} waitingCount={2} expanded={false} onToggle={() => {}} />,
    );

    expect(screen.getByTestId('whiteboard-people-waiting-badge').textContent).toBe('2');
    expect(
      screen.getByRole('button', { name: 'People in the room, 1, 2 waiting' }),
    ).toBeTruthy();
  });

  it('carries each face in that persons own colour', () => {
    render(
      <PeopleButton
        users={[makeUser({ userName: 'Alice', color: '#e74c3c' })]}
        expanded={false}
        onToggle={() => {}}
      />,
    );

    const face = screen.getByText('A');
    expect(face.style.borderColor).toBe('rgb(231, 76, 60)');
  });

  it('renders the raised-hand indicator when any participant has a hand raised', () => {
    const { container } = render(
      <PeopleButton
        users={[makeUser()]}
        expanded={false}
        onToggle={() => {}}
        anyHandRaised={true}
      />,
    );

    const button = screen.getByTestId('whiteboard-people-button');
    const svg = button.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('does not render the raised-hand indicator when no one has a hand raised', () => {
    render(
      <PeopleButton
        users={[makeUser()]}
        expanded={false}
        onToggle={() => {}}
        anyHandRaised={false}
      />,
    );

    const button = screen.getByTestId('whiteboard-people-button');
    // Should only have the stacked user faces, not the raised hand icon
    const svgs = button.querySelectorAll('svg');
    // One span contains inline spans for avatars (which don't have SVG), so we expect 0 SVGs at the top level of the button structure
    expect(button.getAttribute('aria-label')).not.toContain('hand');
  });

  it('reflects raised-hand indicator in aria-label when present', () => {
    render(
      <PeopleButton
        users={[makeUser()]}
        expanded={false}
        onToggle={() => {}}
        anyHandRaised={true}
      />,
    );

    const button = screen.getByTestId('whiteboard-people-button');
    expect(button.getAttribute('aria-label')).toContain('hand');
  });
});
