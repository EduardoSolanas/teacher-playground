import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import RaisedHandCue from './RaisedHandCue';
import { RAISED_HAND_CUE_MS } from '@/lib/whiteboard/raisedHandCue';
import type { WhiteboardUser } from '@/types/whiteboard';

function makeUser(overrides: Partial<WhiteboardUser> = {}): WhiteboardUser {
  return {
    peerId: 'peer-1',
    userName: 'Ada',
    color: '#3498db',
    isHost: false,
    ...overrides,
  };
}

describe('RaisedHandCue', () => {
  it('shows a light hand on the host screen when a student raises, then phases out', () => {
    vi.useFakeTimers();
    const host = makeUser({ peerId: 'host', userName: 'Host', isHost: true });
    const student = makeUser({ peerId: 'ada', userName: 'Ada', handRaised: false });
    const { rerender } = render(
      <RaisedHandCue users={[host, student]} localPeerId="host" isLocalHost />,
    );
    expect(screen.queryByTestId('whiteboard-raised-hand-cue')).toBeNull();

    rerender(
      <RaisedHandCue
        users={[host, { ...student, handRaised: true }]}
        localPeerId="host"
        isLocalHost
      />,
    );

    const cue = screen.getByTestId('whiteboard-raised-hand-cue');
    expect(cue.textContent).toMatch(/Ada/i);
    expect(cue.getAttribute('data-phasing')).toBe('out');

    act(() => {
      vi.advanceTimersByTime(RAISED_HAND_CUE_MS);
    });
    expect(screen.queryByTestId('whiteboard-raised-hand-cue')).toBeNull();
    vi.useRealTimers();
  });

  it('keeps a persistent live region and announces a full sentence', () => {
    const host = makeUser({ peerId: 'host', userName: 'Host', isHost: true });
    const student = makeUser({ peerId: 'ada', userName: 'Ada', handRaised: false });
    const { rerender } = render(
      <RaisedHandCue users={[host, student]} localPeerId="host" isLocalHost />,
    );

    const live = screen.getByTestId('whiteboard-raised-hand-live');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.textContent).toBe('');

    rerender(
      <RaisedHandCue
        users={[host, { ...student, handRaised: true }]}
        localPeerId="host"
        isLocalHost
      />,
    );

    expect(screen.getByTestId('whiteboard-raised-hand-live').textContent).toBe('Ada raised their hand');
  });

  it('hides the animated visual from assistive technology', () => {
    const host = makeUser({ peerId: 'host', userName: 'Host', isHost: true });
    const student = makeUser({ peerId: 'ada', userName: 'Ada', handRaised: false });
    const { rerender } = render(
      <RaisedHandCue users={[host, student]} localPeerId="host" isLocalHost />,
    );

    rerender(
      <RaisedHandCue
        users={[host, { ...student, handRaised: true }]}
        localPeerId="host"
        isLocalHost
      />,
    );

    const cue = screen.getByTestId('whiteboard-raised-hand-cue');
    expect(cue.closest('[aria-hidden="true"]')).toBeTruthy();
  });

  it('does not show the cue on a student screen', () => {
    render(
      <RaisedHandCue
        users={[
          makeUser({ peerId: 'host', isHost: true }),
          makeUser({ peerId: 'ada', userName: 'Ada', handRaised: true }),
        ]}
        localPeerId="ada"
        isLocalHost={false}
      />,
    );
    expect(screen.queryByTestId('whiteboard-raised-hand-cue')).toBeNull();
  });

  it('renders a large, screen-centered cue with prominent icon and attendee name', () => {
    const host = makeUser({ peerId: 'host', userName: 'Host', isHost: true });
    const student = makeUser({ peerId: 'ada', userName: 'Ada', handRaised: false });
    const { rerender } = render(
      <RaisedHandCue users={[host, student]} localPeerId="host" isLocalHost />,
    );

    rerender(
      <RaisedHandCue
        users={[host, { ...student, handRaised: true }]}
        localPeerId="host"
        isLocalHost
      />,
    );

    const cue = screen.getByTestId('whiteboard-raised-hand-cue');
    expect(cue.className).toContain('left-1/2');
    expect(cue.className).toContain('top-1/2');
    expect(cue.className).toContain('-translate-x-1/2');
    expect(cue.className).toContain('-translate-y-1/2');

    const icon = cue.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('h-48');
    expect(icon?.getAttribute('class')).toContain('sm:h-64');
  });
});
